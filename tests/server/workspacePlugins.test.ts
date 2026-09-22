// @vitest-environment node
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type Koa from 'koa'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { LocalAuthStore } from '../../src/server/localAuth'
import { HttpMcp } from '../../src/server/botPlugins/httpMcp'
import { createWorkspaceToolLease } from '../../src/server/workspaceToolLease'

let home: string, runtime: ApplicationRuntime, cookie: string, csrf: string, failedInventory: boolean
let requests: Array<{ url: string; body: any; method: string }>, accounts: any[], sessions: Map<string, string>
const principal = (id: string) => ({ id, username: id, role: id === 'owner' ? 'admin' as const : 'user' as const, enabled: true, mustChangePassword: false, createdAt: 1, updatedAt: 1 })
class TestAuth extends LocalAuthStore {
  override current(ctx: Koa.Context) { return principal(ctx.get('x-test-user') || 'owner') }
  override require(ctx: Koa.Context) { return this.current(ctx) }
  override requireAdmin(ctx: Koa.Context) { const user = this.current(ctx); if (user.role !== 'admin') ctx.throw(403); return user }
  override isUserActive() { return true }
  override isAdminActive(id: string) { return id === 'owner' }
  override canUseSource() { return true }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const mcpFetch: typeof fetch = async (input, init) => {
  const url = String(input), body = JSON.parse(String(init?.body || '{}')), method = init?.method ?? 'GET'
  requests.push({ url, body, method })
  if (url.includes('/tool_router/session') && method === 'POST' && !url.endsWith('/link')) {
    const id = 'trs_' + randomUUID(); sessions.set(id, body.user_id)
    return response({ session_id: id, config: { user_id: body.user_id }, mcp: { url: `https://backend.composio.dev/tool_router/${id}/mcp` } }, 201)
  }
  if (url.endsWith('/link')) {
    const sessionId = /session\/([^/]+)/.exec(url)![1]!, user = sessions.get(sessionId)
    accounts.push({ id: 'ca_' + randomUUID(), user_id: user, toolkit: { slug: body.toolkit }, alias: body.alias, status: 'ACTIVE' })
    return response({ redirect_url: 'https://connect.composio.dev/link/fixture' })
  }
  if (url.includes('/connected_accounts?')) {
    if (failedInventory) return response({ error: 'fixture failure' }, 503)
    return response({ items: accounts.filter(a => a.user_id === new URL(url).searchParams.get('user_ids')) })
  }
  if (url.includes('/connected_accounts/') && method === 'DELETE') { const id = new URL(url).pathname.split('/').at(-1); accounts = accounts.filter(a => a.id !== id); return response({ ok: true }) }
  if (url.includes('/toolkits?')) return response({ items: [{ slug: 'gmail', name: 'Gmail', meta: { description: '邮件' } }] })
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
  const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : body.method === 'tools/list' ? { tools: [{ name: 'fixture_echo', description: 'Echo an explicit value', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: String(body.params?.arguments?.value) }], structuredContent: { value: body.params?.arguments?.value } }
  return response({ jsonrpc: '2.0', id: body.id, result })
}
const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, owner = 'owner') => request(runtime.app.callback())[method]('/api/app/bot-tools' + path)
  .set('Host', '127.0.0.1:15300').set('Origin', 'http://127.0.0.1:15300').set('Cookie', cookie).set('x-csrf-token', csrf).set('x-test-user', owner)
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-plugin-test-')); failedInventory = false; requests = []; accounts = []; sessions = new Map()
  const config = loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_UPSTREAM: 'http://127.0.0.1:19119' })
  runtime = createApplication({ config, auth: new TestAuth(home, false), pluginFetch: mcpFetch, fetchImpl: (async () => response({ ok: true, auth_required: false, profiles: [] })) as typeof fetch })
  const boot = await request(runtime.app.callback()).get('/api/app/bootstrap').set('Host', '127.0.0.1:15300')
  cookie = (boot.headers['set-cookie'] as unknown as string[]).map(s => s.split(';')[0]).join('; ')
  csrf = boot.body.csrfToken
})
afterEach(async () => { runtime.close(); await new Promise(r => setTimeout(r, 20)); rmSync(home, { recursive: true, force: true }) })
async function addPlugin(agentIds: string[] = []) {
  const added = await api('post', '/mcp').send({ name: '测试服务', transport: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer fixture-secret' }, agentIds })
  expect(added.status, JSON.stringify(added.body)).toBe(201)
  return added.body.plugin
}
async function configure(owner = 'owner') {
  const result = await api('put', '/settings', owner).send({ apiKey: 'ak_fixture_not_real', revision: 0 })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
}

describe('Bot-only plugin management', () => {
  it('keeps MCP credentials encrypted and disabled until a successful explicit test', async () => {
    const plugin = await addPlugin()
    expect(plugin).toMatchObject({ enabled: false, headerKeys: ['Authorization'] }); expect(plugin.testedAt).toBeUndefined()
    expect(JSON.stringify(plugin)).not.toContain('fixture-secret')
    expect(JSON.stringify(runtime.workspace.list('owner', 'bot-mcp-plugin'))).not.toContain('fixture-secret')
    expect((await api('patch', '/mcp/' + plugin.id).send({ enabled: true, revision: 1 })).status).toBe(409)
    const tested = await api('post', '/mcp/' + plugin.id + '/test').send({})
    expect(tested.status, JSON.stringify(tested.body)).toBe(200); expect(tested.body.plugin.toolCount).toBe(1)
    const enabled = await api('patch', '/mcp/' + plugin.id).send({ enabled: true, revision: 1 })
    expect(enabled.body.plugin.enabled).toBe(true)
    const updated = await api('put', '/mcp/' + plugin.id).send({ revision: 2, definition: { name: '测试服务', transport: 'http', url: plugin.url, headers: { Authorization: true } } })
    expect(updated.status).toBe(200); expect(updated.body.plugin.enabled).toBe(false); expect(updated.body.plugin.testedAt).toBeUndefined()
    await api('post', '/mcp/' + plugin.id + '/test').send({}).expect(200)
  })
  it('enforces owner, Bot grants, admin-only MCP and CSRF boundaries', async () => {
    const plugin = await addPlugin(), foreign = runtime.workspace.createAgent('member', { name: '其他账号', profile: 'default' })
    await api('get', '/mcp', 'member').expect(200).expect(r => expect(r.body.plugins).toEqual([]))
    await api('post', '/mcp', 'member').send({ name: 'test', transport: 'stdio', command: process.execPath }).expect(403)
    await api('patch', '/mcp/' + plugin.id).send({ agentIds: [foreign.id], revision: 1 }).expect(404)
    await api('delete', '/mcp/' + plugin.id, 'member').expect(403)
    await request(runtime.app.callback()).post('/api/app/bot-tools/mcp').set('Host', '127.0.0.1:15300').set('Origin', 'http://127.0.0.1:15300').send({}).expect(403)
    await api('post', '/mcp').send({ name: 'unsafe', transport: 'http', url: 'file:///etc/passwd' }).expect(400)
    await api('post', '/mcp').send({ name: 'unsafe', transport: 'http', url: 'https://mcp.example.test', headers: { Host: 'internal' } }).expect(400)
    await api('post', '/mcp').send({ name: 'unsafe', transport: 'stdio', command: process.execPath, env: { constructor: true } }).expect(400)
  })
  it('tests a real stdio subprocess without inheriting application secrets', async () => {
    const code = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;const result=r.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}}}:{tools:[{name:'environment_check',description:process.env.HERMES_TEST_SECRET?'leaked':'isolated',inputSchema:{type:'object'}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')})`
    process.env.HERMES_TEST_SECRET = 'do-not-inherit'
    try {
      const added = await api('post', '/mcp').send({ name: 'stdio fixture', transport: 'stdio', command: process.execPath, args: ['-e', code] })
      expect(added.status).toBe(201)
      const tested = await api('post', '/mcp/' + added.body.plugin.id + '/test').send({})
      expect(tested.status, JSON.stringify(tested.body)).toBe(200)
      expect(tested.body.tools[0].description).toBe('isolated')
    } finally { delete process.env.HERMES_TEST_SECRET }
  })
  it('calls an authorized plugin through the native per-turn tool bridge and revokes it immediately', async () => {
    const agent = runtime.workspace.createAgent('owner', { name: '插件 Bot', profile: 'default' })
    const plugin = await addPlugin([agent.id])
    await api('post', '/mcp/' + plugin.id + '/test').send({}).expect(200)
    await api('patch', '/mcp/' + plugin.id).send({ enabled: true, revision: 1 }).expect(200)
    let binding: any
    const target: any = { url: new URL('http://127.0.0.1:19119'), session: { request: async (path: string, options: any) => {
      if (path.endsWith('/bind')) binding = options.body
      return { status: 200, body: Buffer.from(JSON.stringify(path.endsWith('/capabilities') ? { version: 1, ready: true, native_tools: true, in_process: true } : { ok: true, native_tools: true })) }
    } } }
    const controller = new AbortController()
    const tools = await runtime.workspacePlugins.open('owner', agent, target, controller.signal, () => {})
    expect(tools.services()).toEqual([{ name: '测试服务', transport: 'http', toolCount: 1 }])
    const originalToolId = tools.catalog()[0]!.id
    const lease = await createWorkspaceToolLease({ target, profile: 'default', workId: randomUUID(), signal: controller.signal, session: () => ({ runtimeId: 'live-fixture', storedId: 'stored-fixture' }), assertActive() {}, catalog: () => tools.catalog(), call: (id, args) => tools.call(id, args), onFailure() {} })
    try {
      await lease.bind()
      const bridge = async (path: string, body: unknown) => (await fetch(binding.bridge_url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + binding.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
      const catalog: any = await bridge('/tools/list', {})
      expect(catalog.tools).toHaveLength(1)
      expect(JSON.stringify(catalog)).not.toContain('fixture-secret')
      const result: any = await bridge('/tools/call', { toolId: catalog.tools[0].id, arguments: { value: 'native bridge verified' }, callId: randomUUID() })
      expect(result.structuredContent.value).toBe('native bridge verified')
      await api('patch', '/mcp/' + plugin.id).send({ enabled: false, revision: 2 }).expect(200)
      expect(tools.catalog()).toEqual([])
      expect(tools.services()).toEqual([])
      const count = requests.length
      await expect(tools.call(originalToolId, {})).rejects.toMatchObject({ code: 'plugin_grant_revoked' })
      expect(requests).toHaveLength(count)
    } finally { controller.abort(); await tools.dispose(); await lease.dispose() }
    const notGranted = runtime.workspace.createAgent('owner', { name: '未授权 Bot', profile: 'default' })
    expect(runtime.workspacePlugins.selected('owner', notGranted)).toBe(false)
  })
  it('runs a server stdio program through the tool bridge without a client filesystem', async () => {
    const agent = runtime.workspace.createAgent('owner', { name: '远端客户端使用的 Bot', profile: 'default' })
    const script = join(home, 'server-mcp.cjs'), data = join(home, 'server-only.txt')
    writeFileSync(data, '服务器文件内容')
    writeFileSync(script, `const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line); if (!r.id) return;
  const result = r.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
    : r.method === 'tools/list' ? { tools: [{ name: 'read_server_file', inputSchema: { type: 'object' } }] }
    : { content: [{ type: 'text', text: fs.readFileSync(process.argv[2], 'utf8') }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
});`)
    const added = await api('post', '/mcp').send({ name: '服务器程序', transport: 'stdio', command: process.execPath, args: [script, data], agentIds: [agent.id] }).expect(201)
    const id = added.body.plugin.id
    await api('post', '/mcp/' + id + '/test').send({}).expect(200)
    await api('patch', '/mcp/' + id).send({ enabled: true, revision: 1 }).expect(200)
    let binding: any
    const target: any = { url: new URL('http://127.0.0.1:19119'), session: { request: async (path: string, options: any) => {
      if (path.endsWith('/bind')) binding = options.body
      return { status: 200, body: Buffer.from(JSON.stringify(path.endsWith('/capabilities') ? { version: 1, ready: true, native_tools: true, in_process: true } : { ok: true, native_tools: true })) }
    } } }
    const controller = new AbortController()
    const tools = await runtime.workspacePlugins.open('owner', agent, target, controller.signal, () => {})
    expect(tools.services()).toEqual([{ name: '服务器程序', transport: 'stdio', toolCount: 1 }])
    const lease = await createWorkspaceToolLease({ target, profile: 'default', workId: randomUUID(), signal: controller.signal, session: () => ({ runtimeId: 'server-stdio', storedId: 'server-stdio-stored' }), assertActive() {}, catalog: () => tools.catalog(), call: (id, args) => tools.call(id, args), onFailure() {} })
    try {
      await lease.bind()
      const bridge = async (path: string, body: unknown) => (await fetch(binding.bridge_url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + binding.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>
      const catalog = await bridge('/tools/list', {})
      expect(catalog.tools).toHaveLength(1)
      expect(JSON.stringify(catalog)).not.toContain(home)
      const result = await bridge('/tools/call', { toolId: catalog.tools[0].id, arguments: {}, callId: randomUUID() })
      expect(result.content).toEqual([{ type: 'text', text: '服务器文件内容' }])
    } finally { controller.abort(); await tools.dispose(); await lease.dispose() }
  })
  it('removes deleted Bot grants without changing the service or granting a replacement by name', async () => {
    const old = runtime.workspace.createAgent('owner', { name: '小夭', profile: 'default' })
    const other = runtime.workspace.createAgent('owner', { name: '保留的 Bot', profile: 'default' })
    const plugin = await addPlugin([old.id, other.id])
    await api('post', '/mcp/' + plugin.id + '/test').send({}).expect(200)
    await api('patch', '/mcp/' + plugin.id).send({ enabled: true, revision: 1 }).expect(200)
    const unrelated = await api('post', '/mcp').send({ name: '其他服务', transport: 'http', url: 'https://other.example.test/mcp', agentIds: [other.id] }).expect(201)
    const unrelatedBefore = runtime.workspace.require<any>('owner', 'bot-mcp-plugin', unrelated.body.plugin.id)
    const before = runtime.workspace.require<any>('owner', 'bot-mcp-plugin', plugin.id)
    runtime.workspace.updateAgent('owner', old.id, { archived: true })
    runtime.workspace.deleteAgent('owner', old.id)
    const after = runtime.workspace.require<any>('owner', 'bot-mcp-plugin', plugin.id)
    expect(after).toEqual({ ...before, agentIds: [other.id], revision: before.revision + 1 })
    expect(runtime.workspace.require('owner', 'bot-mcp-plugin', unrelated.body.plugin.id)).toEqual(unrelatedBefore)
    const replacement = runtime.workspace.createAgent('owner', { name: '小夭', profile: 'default' })
    expect(runtime.workspacePlugins.selected('owner', replacement)).toBe(false)
    expect(runtime.workspacePlugins.selected('owner', other)).toBe(true)
    await api('patch', '/mcp/' + plugin.id).send({ agentIds: [replacement.id, other.id], revision: after.revision }).expect(200)
    const rebound = runtime.workspace.require<any>('owner', 'bot-mcp-plugin', plugin.id)
    expect(rebound).toMatchObject({ enabled: true, testedAt: before.testedAt, sealed: before.sealed, tools: before.tools })
    expect(runtime.workspacePlugins.selected('owner', replacement)).toBe(true)
  })
})

describe('account-owned connected applications', () => {
  it('supports catalog, OAuth links, multiple accounts, Bot grants and scoped disconnect', async () => {
    await configure(); await configure('member')
    const ownerSettings = runtime.workspace.list('owner', 'bot-plugin-settings')
    expect(JSON.stringify(ownerSettings)).not.toContain('ak_fixture')
    await api('get', '/apps/catalog').expect(200).expect(r => expect(r.body.cards[0].slug).toBe('gmail'))
    await api('post', '/apps/gmail/authorize').send({}).expect(200)
    await api('post', '/apps/gmail/authorize', 'member').send({}).expect(200)
    const first = (await api('get', '/apps')).body.connections[0]
    await api('post', '/apps/gmail/authorize').send({}).expect(409)
    await api('post', '/apps/gmail/authorize').send({ alias: '工作' }).expect(200)
    expect((await api('get', '/apps')).body.connections[0].accounts).toHaveLength(2)
    const foreign = (await api('get', '/apps', 'member')).body.connections[0].accounts[0].id
    await api('delete', '/apps/gmail/accounts/' + foreign).expect(404)
    const agent = runtime.workspace.createAgent('owner', { name: '应用 Bot', profile: 'default' })
    await api('put', '/apps/gmail/agents').send({ revision: 0, agentIds: [agent.id] }).expect(200)
    expect(runtime.workspacePlugins.selected('owner', agent)).toBe(true)
    await api('delete', '/apps/gmail/accounts/' + first.accounts[0].id).expect(200)
    expect((await api('get', '/apps')).body.connections[0].accounts).toHaveLength(1)
    expect((await api('get', '/apps', 'member')).body.connections[0].accounts).toHaveLength(1)
  })
  it('reports failed inventory reads without falsely reporting all apps disconnected', async () => {
    await configure(); await api('post', '/apps/gmail/authorize').send({}).expect(200)
    failedInventory = true
    const result = await api('get', '/apps')
    expect(result.status).toBe(502); expect(result.body.connections).toBeUndefined()
  })
  it('creates per-Bot toolkit-allowlisted sessions and keeps their URLs and headers server-side', async () => {
    await configure()
    const id = randomUUID(), signal = new AbortController().signal
    const one = await runtime.workspacePlugins.apps.sessionFor('owner', id, ['gmail'], signal)
    const two = await runtime.workspacePlugins.apps.sessionFor('owner', id, ['gmail'], signal)
    expect(one.url).toBe(two.url)
    const created = requests.filter(r => r.url.endsWith('/tool_router/session')).at(-1)!.body
    expect(created.toolkits).toEqual({ enable: ['gmail'] })
    expect(created.manage_connections.enable).toBe(false)
    expect(JSON.stringify(runtime.workspace.list('owner', 'bot-app-session'))).not.toContain(one.url)
    await api('put', '/settings').send({ revision: 0, apiKey: 'ak_other' }).expect(409)
  })
})

it('accepts SSE MCP responses, preserves tool results and disables redirect following', async () => {
  const options: any[] = []
  const client = new HttpMcp('https://mcp.example.test/mcp', {}, (async (_url, init) => {
    options.push(init); const frame = JSON.parse(String(init?.body))
    if (!frame.id) return new Response(null, { status: 202 })
    const result = frame.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: 'SSE result' }], structuredContent: { ok: true } }
    return new Response('data: ' + JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n\n', { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-fixture' } })
  }) as typeof fetch)
  await client.init(); expect((await client.callTool('test', {})).structuredContent).toEqual({ ok: true })
  expect(options.every(o => o.redirect === 'error')).toBe(true)
  expect(options.at(-1).headers['Mcp-Session-Id']).toBe('session-fixture')
  client.dispose()
})
