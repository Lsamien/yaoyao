// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { createEmbeddedHermes } from '../../src/server/hermes/embedded'
import { kernelPaths } from '../../src/server/hermes/paths'

const kernel = existsSync(kernelPaths().python)
const host = '127.0.0.1:15300'
type Client = ReturnType<typeof request.agent>

describe.skipIf(!kernel)('multiple accounts on the embedded Hermes kernel', () => {
  let home = '', runtime: ApplicationRuntime | undefined, model: Server | undefined
  const prompts: string[] = []
  afterEach(() => {
    runtime?.close(); runtime = undefined
    model?.close(); model = undefined
    prompts.length = 0
    if (home) rmSync(home, { recursive: true, force: true })
  })

  const call = (client: Client, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, csrf = '') =>
    client[method](path).set('Host', host).set('Origin', `http://${host}`).set('X-CSRF-Token', csrf)

  async function setup() {
    model = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += chunk })
      req.on('end', () => {
        let body: any
        try { body = JSON.parse(raw) } catch { body = undefined }
        if (!Array.isArray(body?.messages)) { res.setHeader('content-type', 'application/json'); res.end('{"data":[]}'); return }
        const last = JSON.stringify(body.messages.at(-1)?.content ?? '')
        prompts.push(last)
        // Echo a marker from the request so each account's reply is distinguishable.
        const marker = /MARK-[A-Z]+/.exec(last)?.[0] ?? 'NONE'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: `回复 ${marker}` }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 't', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => model!.listen(0, '127.0.0.1', resolve))
    const port = (model.address() as { port: number }).port
    home = mkdtempSync(join(tmpdir(), 'yaoyao-multiuser-'))
    const modelConfig = `model:\n  provider: custom\n  default: m\n  base_url: http://127.0.0.1:${port}/v1\n  api_key: k\n`
    for (const dir of ['hermes', 'hermes/profiles/allowed', 'hermes/profiles/private']) {
      mkdirSync(join(home, dir), { recursive: true })
      writeFileSync(join(home, dir, 'config.yaml'), modelConfig)
    }
    const config = loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_MEDIA_ROOT: join(home, 'media') })
    const hermes = createEmbeddedHermes(home, { env: { ...process.env, YAOVI_HERMES_TEST_OFFLINE: '1', YAOYAO_KERNEL_STANDBY: '0' }, defaultCwd: config.mediaRoot, policy: () => ({ approval: 'ask', denyHostTools: false }) })
    runtime = createApplication({ config, hermes })
    const admin = request.agent(runtime.app.callback()), child = request.agent(runtime.app.callback())
    const boot = await call(admin, 'get', '/api/app/bootstrap').expect(200)
    const adminCSRF = (await call(admin, 'post', '/api/app/setup', boot.body.csrfToken).send({ username: 'owner', password: 'owner-password' }).expect(200)).body.csrfToken
    const created = await call(admin, 'post', '/api/app/admin/users', adminCSRF).send({ username: 'child', password: 'temporary-password', assignedProfiles: ['allowed'] }).expect(201)
    const childBoot = await call(child, 'get', '/api/app/bootstrap').expect(200)
    let childCSRF = (await call(child, 'post', '/api/app/login', childBoot.body.csrfToken).send({ username: 'child', password: 'temporary-password' }).expect(200)).body.csrfToken
    childCSRF = (await call(child, 'put', '/api/app/account/credentials', childCSRF).send({ currentPassword: 'temporary-password', newPassword: 'child-password' }).expect(200)).body.csrfToken
    return { runtime, admin, child, adminCSRF, childCSRF, childID: created.body.id as string }
  }

  async function botReply(client: Client, csrf: string, conversationId: string, content: string) {
    await call(client, 'post', `/api/app/conversations/${conversationId}/messages`, csrf).send({ requestId: randomUUID(), content }).expect(202)
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const messages = (await call(client, 'get', `/api/app/conversations/${conversationId}`).expect(200)).body.messages as Array<{ role: string; status: string; content: string; error?: string }>
      const reply = messages.filter(m => m.role === 'assistant' && ['complete', 'failed', 'uncertain'].includes(m.status)).at(-1)
      if (reply) return reply
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('no Bot reply')
  }

  it('isolates Bots, conversations and Hermes homes between an administrator and a sub-account', async () => {
    const { admin, child, adminCSRF, childCSRF } = await setup()

    // Sub-accounts may only build Bots on their assigned Profiles.
    await call(child, 'post', '/api/app/agents', childCSRF).send({ name: '越权', profile: 'private' }).expect(403)
    const childAgent = (await call(child, 'post', '/api/app/agents', childCSRF).send({ name: '子账号助手', profile: 'allowed' }).expect(201)).body.agent
    const adminAgent = (await call(admin, 'post', '/api/app/agents', adminCSRF).send({ name: '管理员助手', profile: 'private' }).expect(201)).body.agent

    const childConversation = (await call(child, 'get', '/api/app/conversations').expect(200)).body.conversations[0]
    const adminConversation = (await call(admin, 'get', '/api/app/conversations').expect(200)).body.conversations[0]
    expect(childConversation.id).not.toBe(adminConversation.id)

    // Both accounts run real turns on the embedded kernel, concurrently.
    const [childReply, adminReply] = await Promise.all([
      botReply(child, childCSRF, childConversation.id, '你好 MARK-CHILD'),
      botReply(admin, adminCSRF, adminConversation.id, '你好 MARK-ADMIN'),
    ])
    expect(childReply.status, childReply.error).toBe('complete')
    expect(adminReply.status, adminReply.error).toBe('complete')
    expect(childReply.content).toContain('MARK-CHILD')
    expect(adminReply.content).toContain('MARK-ADMIN')

    // Each Bot keeps its own Hermes runtime home; neither prompt carried the other account's text.
    expect(existsSync(join(home, 'bots', childAgent.id, 'runtime', 'state.db'))).toBe(true)
    expect(existsSync(join(home, 'bots', adminAgent.id, 'runtime', 'state.db'))).toBe(true)
    expect(prompts.filter(p => p.includes('MARK-CHILD')).every(p => !p.includes('MARK-ADMIN'))).toBe(true)

    // Lists and direct reads are owner-scoped.
    expect((await call(child, 'get', '/api/app/agents').expect(200)).body.agents.map((a: { id: string }) => a.id)).toEqual([childAgent.id])
    expect((await call(admin, 'get', '/api/app/agents').expect(200)).body.agents.map((a: { id: string }) => a.id)).toEqual([adminAgent.id])
    expect((await call(child, 'get', `/api/app/conversations/${adminConversation.id}`)).status).toBe(404)
    expect((await call(admin, 'get', `/api/app/conversations/${childConversation.id}`)).status).toBe(404)
    await call(child, 'post', `/api/app/conversations/${adminConversation.id}/messages`, childCSRF).send({ requestId: randomUUID(), content: '越权' }).expect(404)
  }, 240_000)

  it('serves only Bot mode: native chat surfaces are gone and Hermes data stays out of reach of a sub-account', async () => {
    const { admin, child } = await setup()
    // Ordinary (native Hermes) chat is retired for every account.
    for (const client of [admin, child]) {
      for (const path of ['/api/app/sessions', '/api/app/sessions/abc/messages', '/api/sessions', '/api/sessions/abc/messages']) {
        expect([403, 404], path).toContain((await call(client, 'get', path)).status)
      }
      expect([403, 404]).toContain((await call(client, 'post', '/api/realtime/channels').send({ channel: 'chat' })).status)
    }
    // Hermes data and administration remain denied to the sub-account.
    for (const path of ['/api/config', '/api/model/options', '/api/app/admin/model-services', '/api/app/admin/upstream-connection',
      `/api/files/download?path=${encodeURIComponent(join(home, 'hermes', 'config.yaml'))}`]) expect((await call(child, 'get', path)).status, path).toBe(403)
    // Profile names are not disclosed to sub-accounts; the administrator sees the embedded Profiles.
    expect((await call(child, 'get', '/api/profiles').expect(200)).body.profiles).toEqual([])
    const names = (await call(admin, 'get', '/api/profiles').expect(200)).body.profiles.map((p: { name: string }) => p.name)
    expect(names).toEqual(expect.arrayContaining(['default', 'allowed', 'private']))
    // Unread counts only Bot conversations.
    expect((await call(admin, 'get', '/api/app/unread').expect(200)).body).toMatchObject({ chat: 0 })
  }, 240_000)
})
