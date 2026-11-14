import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmbeddedHermes, type EmbeddedHermes } from '../../src/server/hermes/embedded.js'
import { kernelPaths } from '../../src/server/hermes/paths.js'
import type { GatewayFrame } from '../../src/server/workspaceGateway.js'

const kernel = existsSync(kernelPaths().python)
const env = { ...process.env, YAOVI_HERMES_TEST_OFFLINE: '1' }

type Step = { content?: string; call?: { name: string; arguments: Record<string, unknown> } }

/** Deterministic OpenAI-compatible endpoint: each request answers with the next scripted step. */
function fakeModel(script: (messages: any[]) => Step) {
  const requests: any[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      let body: any
      try { body = JSON.parse(raw) } catch { body = undefined }
      if (req.method !== 'POST' || !Array.isArray(body?.messages)) {
        // Model listing / capability probes.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }))
        return
      }
      requests.push(body)
      const step = script(body.messages)
      const delta = step.call
        ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.call.name, arguments: JSON.stringify(step.call.arguments) } }] }
        : { role: 'assistant', content: step.content ?? '' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const part of [
        { id: 't', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] },
        { id: 't', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: step.call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]) res.write(`data: ${JSON.stringify(part)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  return { server, requests }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

function waitFor(frames: GatewayFrame[], predicate: (frame: GatewayFrame) => boolean, timeout = 90_000): Promise<GatewayFrame> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const found = frames.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - started > timeout) return reject(new Error(`timed out; saw ${frames.map(f => f.type).join(',')}`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

describe.skipIf(!kernel)('embedded Hermes gateway', () => {
  let home = ''
  let hermes: EmbeddedHermes | undefined
  let model: Server | undefined
  afterEach(() => {
    hermes?.close(); hermes = undefined
    model?.close(); model = undefined
    if (home) rmSync(home, { recursive: true, force: true })
  })

  async function setup(script: (messages: any[]) => Step, approval: 'ask' | 'allow' | 'deny' = 'ask') {
    const fake = fakeModel(script)
    model = fake.server
    const port = await listen(fake.server)
    home = mkdtempSync(join(tmpdir(), 'yaoyao-gateway-'))
    mkdirSync(join(home, 'hermes'), { recursive: true })
    writeFileSync(join(home, 'hermes', 'config.yaml'), `model:\n  provider: custom\n  default: test-model\n  base_url: http://127.0.0.1:${port}/v1\n  api_key: test-key\n`)
    const cwd = join(home, 'work')
    hermes = createEmbeddedHermes(home, { env, defaultCwd: cwd, policy: () => ({ approval, denyHostTools: false }) })
    const frames: GatewayFrame[] = []
    const channel = hermes.gateway.open(frame => frames.push(frame))
    return { channel, frames, requests: fake.requests, cwd }
  }

  it('runs a native chat turn and streams gateway events', async () => {
    const { channel, frames, requests } = await setup(() => ({ content: '你好，我是内置内核。' }))
    const created = await channel.rpc('session.create', { profile: 'default', source: 'web' })
    expect(created.session_id).toBe(created.stored_session_id)
    expect(created.info).toMatchObject({ model: 'test-model', provider: 'custom' })
    expect(await channel.rpc('prompt.submit', { session_id: created.session_id, text: '你好' })).toEqual({ status: 'streaming' })
    const done = await waitFor(frames, f => f.type === 'message.complete')
    expect(done.payload).toMatchObject({ status: 'complete', text: '你好，我是内置内核。' })
    expect(frames.some(f => f.type === 'message.delta')).toBe(true)
    expect(requests[0].messages.at(-1).content).toContain('你好')
    // Hermes owns the transcript: the dashboard read path returns the stored messages.
    const page = await hermes!.api.handle({ method: 'GET', path: `/api/sessions/${created.session_id}/messages` })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('你好，我是内置内核。')
    await waitFor(frames, f => f.type === 'session.title')
    // A second turn continues the same Hermes session.
    await channel.rpc('prompt.submit', { session_id: created.session_id, text: '再说一次' })
    await waitFor(frames, f => f.type === 'message.complete' && frames.filter(x => x.type === 'message.complete').length === 2)
    expect(requests.at(-1).messages.some((m: any) => m.role === 'assistant' && String(m.content).includes('内置内核'))).toBe(true)
  }, 180_000)

  it('executes granted application tools in the host and returns their results to the model', async () => {
    const calls: unknown[] = []
    const { channel, frames, requests } = await setup(messages => messages.some(m => m.role === 'tool')
      ? { content: '已读取：' + messages.find(m => m.role === 'tool').content }
      : { call: { name: 'team_lookup', arguments: { name: '小夭' } } })
    const created = await channel.rpc('session.create', { profile: 'default', bot_id: 'bot-1', hidden: true })
    const revoke = hermes!.gateway.grant(created.session_id, {
      catalog: () => [{ id: 'team_lookup', name: '查找成员', description: '按名字查找成员', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }],
      call: async (id, args) => { calls.push([id, args]); return { content: [{ type: 'text', text: '小夭在线' }] } },
    })
    await channel.rpc('prompt.submit', { session_id: created.session_id, text: '查一下小夭' })
    const done = await waitFor(frames, f => f.type === 'message.complete')
    revoke()
    expect(done.payload).toMatchObject({ status: 'complete' })
    expect(String(done.payload!.text)).toContain('小夭在线')
    expect(calls).toEqual([['team_lookup', { name: '小夭' }]])
    expect(requests[0].tools.map((t: any) => t.function.name)).toContain('team_lookup')
    expect(frames.some(f => f.type === 'tool.start' && f.payload?.name === 'team_lookup')).toBe(true)
    // Bot sessions live in the Bot's own runtime home.
    expect(existsSync(join(home, 'bots', 'bot-1', 'runtime', 'state.db'))).toBe(true)
  }, 180_000)

  it('asks for approval before a Host terminal command and honours a denial', async () => {
    const { channel, frames, cwd } = await setup(messages => messages.some(m => m.role === 'tool')
      ? { content: '结果：' + messages.find(m => m.role === 'tool').content.slice(0, 200) }
      : { call: { name: 'terminal', arguments: { command: 'echo embedded > proof.txt' } } })
    const created = await channel.rpc('session.create', { profile: 'default' })
    await channel.rpc('prompt.submit', { session_id: created.session_id, text: '写文件' })
    const request = await waitFor(frames, f => f.type === 'approval.request')
    expect(String(request.payload!.command)).toContain('echo embedded')
    await channel.rpc('approval.respond', { session_id: created.session_id, request_id: request.payload!.request_id, choice: 'deny' })
    const done = await waitFor(frames, f => f.type === 'message.complete')
    expect(done.payload!.status).toBe('complete')
    expect(existsSync(join(cwd, 'proof.txt'))).toBe(false)
  }, 180_000)

  it('runs an approved Host terminal command in the session working directory', async () => {
    const { channel, frames, cwd } = await setup(messages => messages.some(m => m.role === 'tool')
      ? { content: '完成' }
      : { call: { name: 'terminal', arguments: { command: 'echo embedded > proof.txt' } } })
    const created = await channel.rpc('session.create', { profile: 'default' })
    await channel.rpc('prompt.submit', { session_id: created.session_id, text: '写文件' })
    const request = await waitFor(frames, f => f.type === 'approval.request')
    await channel.rpc('approval.respond', { session_id: created.session_id, request_id: request.payload!.request_id, choice: 'once' })
    await waitFor(frames, f => f.type === 'message.complete')
    expect(existsSync(join(cwd, 'proof.txt'))).toBe(true)
  }, 180_000)

  it('interrupts a turn waiting on approval', async () => {
    const { channel, frames } = await setup(() => ({ call: { name: 'terminal', arguments: { command: 'sleep 1' } } }))
    const created = await channel.rpc('session.create', { profile: 'default' })
    await channel.rpc('prompt.submit', { session_id: created.session_id, text: '执行' })
    await waitFor(frames, f => f.type === 'approval.request')
    expect((await channel.rpc('session.active_list', {})).sessions).toEqual([{ id: created.session_id, status: 'running' }])
    await channel.rpc('session.interrupt', { session_id: created.session_id })
    const done = await waitFor(frames, f => f.type === 'message.complete')
    expect(done.payload!.status).toBe('interrupted')
    await waitFor(frames, () => hermes!.gateway.idle, 10_000).catch(() => undefined)
    expect(hermes!.gateway.running(created.session_id)).toBe(false)
  }, 180_000)

  it('admits Profile skills and commits a skill created in a native chat', async () => {
    let step = 0
    const { channel, frames } = await setup(messages => {
      step++
      if (step === 1) return { call: { name: 'skills_list', arguments: {} } }
      if (step === 2) return { call: { name: 'skill_manage', arguments: { action: 'create', name: 'release-notes', content: '---\nname: release-notes\ndescription: Write release notes.\n---\n# Release notes\nList user-visible changes.\n' } } }
      return { content: '技能：' + messages.filter(m => m.role === 'tool').map(m => String(m.content).slice(0, 300)).join(' | ') }
    })
    const skill = join(home, 'hermes', 'skills', 'writing', 'weekly-report')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: weekly-report\ndescription: Draft a weekly report.\n---\nUse the template.\n')
    writeFileSync(join(skill, 'template.md'), '# Week')
    const created = await channel.rpc('session.create', { profile: 'default' })
    await channel.rpc('prompt.submit', { session_id: created.session_id, text: '有哪些技能？再建一个发布说明技能' })
    const done = await waitFor(frames, f => f.type === 'message.complete')
    expect(done.payload!.status).toBe('complete')
    expect(String(done.payload!.text)).toContain('weekly-report')
    expect(frames.some(f => f.type === 'approval.request')).toBe(false)
    const written = join(home, 'hermes', 'skills')
    expect(readdirSync(written, { recursive: true }).some(path => String(path).endsWith('release-notes/SKILL.md'))).toBe(true)
  }, 180_000)
})
