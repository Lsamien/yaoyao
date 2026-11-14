// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type Koa from 'koa'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { LocalAuthStore, type LocalUser } from '../../src/server/localAuth'
import { createEmbeddedHermes } from '../../src/server/hermes/embedded'
import { kernelPaths } from '../../src/server/hermes/paths'
import type { WorkspaceConversation, WorkspaceMessage } from '../../src/shared/workspace'

const kernel = existsSync(kernelPaths().python)
const owner: LocalUser = { id: 'first', username: 'first', role: 'admin', enabled: true, mustChangePassword: false, createdAt: 1, updatedAt: 1 }
class TestAuth extends LocalAuthStore {
  override current() { return owner }
  override require(_ctx: Koa.Context) { return owner }
  override requireAdmin(_ctx: Koa.Context) { return owner }
  override canUseSource() { return true }
  override currentFromCookieHeader() { return owner }
  override isUserActive() { return true }
}

describe.skipIf(!kernel)('Bot turns on the embedded Hermes kernel', () => {
  let home = '', runtime: ApplicationRuntime | undefined, model: Server | undefined
  const requests: any[] = []
  afterEach(() => {
    runtime?.close(); runtime = undefined
    model?.close(); model = undefined
    requests.length = 0
    if (home) rmSync(home, { recursive: true, force: true })
  })

  async function setup(reply: (messages: any[], tools: string[]) => { content?: string; call?: { name: string; arguments: object } }) {
    model = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        let body: any
        try { body = JSON.parse(raw) } catch { body = undefined }
        if (!Array.isArray(body?.messages)) { res.setHeader('content-type', 'application/json'); res.end('{"data":[{"id":"test-model"}]}'); return }
        requests.push(body)
        const step = reply(body.messages, (body.tools ?? []).map((t: any) => t.function.name))
        const delta = step.call
          ? { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.call.name, arguments: JSON.stringify(step.call.arguments) } }] }
          : { role: 'assistant', content: step.content }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: step.call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => model!.listen(0, '127.0.0.1', resolve))
    const port = (model.address() as { port: number }).port
    home = mkdtempSync(join(tmpdir(), 'yaoyao-embedded-workspace-'))
    mkdirSync(join(home, 'hermes'), { recursive: true })
    writeFileSync(join(home, 'hermes', 'config.yaml'), `model:\n  provider: custom\n  default: test-model\n  base_url: http://127.0.0.1:${port}/v1\n  api_key: test-key\nterminal:\n  cwd: .\n`)
    const config = loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_MEDIA_ROOT: join(home, 'media'), HERMES_YAOYAO_ALLOWED_HOSTS: '127.0.0.1,localhost' })
    const hermes = createEmbeddedHermes(home, { env: { ...process.env, YAOVI_HERMES_TEST_OFFLINE: '1' }, defaultCwd: config.mediaRoot, policy: () => ({ approval: 'ask', denyHostTools: false }) })
    runtime = createApplication({ config, auth: new TestAuth(home, false), hermes })
    return runtime
  }

  async function reply(app: ApplicationRuntime, conversation: WorkspaceConversation, content: string): Promise<WorkspaceMessage> {
    app.workspaceRuntime.send('first', conversation.id, { requestId: randomUUID(), content, mentionIds: [], fileIds: [] })
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const messages = app.workspace.messages('first', conversation.id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true) as WorkspaceMessage[]
      const done = messages.filter(m => m.role === 'assistant' && ['complete', 'failed', 'uncertain', 'interrupted'].includes(m.status)).at(-1)
      if (done && messages.indexOf(done) > messages.findLastIndex(m => m.role === 'user')) return done
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('Bot did not reply')
  }

  it('answers a direct Bot conversation through the embedded gateway', async () => {
    const app = await setup(() => ({ content: '我是夭夭的 Bot。' }))
    const agent = app.workspace.createAgent('first', { name: '小夭', profile: 'default' })
    const direct = app.workspace.list<WorkspaceConversation>('first', 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === agent.id)!
    const message = await reply(app, direct, '你好')
    expect(message.status, message.error).toBe('complete')
    expect(message.content).toContain('我是夭夭的 Bot。')
    // The workspace prompt (role, rules, marker) reached the model as this turn's input.
    expect(JSON.stringify(requests[0].messages)).toContain('你好')
    expect(existsSync(join(home, 'bots', agent.id, 'runtime', 'state.db'))).toBe(true)
  }, 180_000)

  it('lets a Bot use its granted workspace tools through the embedded lease', async () => {
    const app = await setup((messages, tools) => {
      if (messages.some(m => m.role === 'tool')) return { content: '已查看成员列表。' }
      const listing = tools.find(name => /list_members|members|agents/i.test(name))
      return listing ? { call: { name: listing, arguments: {} } } : { content: `没有成员工具：${tools.join(',')}` }
    })
    const lead = app.workspace.createAgent('first', { name: '负责人', profile: 'default', canManageTeam: true })
    const direct = app.workspace.list<WorkspaceConversation>('first', 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === lead.id)!
    const message = await reply(app, direct, '看看有哪些成员')
    expect(message.status, message.error).toBe('complete')
    expect(message.content).toContain('已查看成员列表。')
    expect(message.tools.length).toBeGreaterThan(0)
  }, 180_000)
})
