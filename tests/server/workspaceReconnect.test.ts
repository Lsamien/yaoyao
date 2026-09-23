// @vitest-environment node
import {afterEach, beforeEach, expect, it, vi} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WebSocketServer, type WebSocket} from 'ws'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceRuntime} from '../../src/server/workspaceRuntime'
import {type GatewayTarget, type WorkspaceNodes} from '../../src/server/workspaceGateway'
import {type WorkspacePlugins} from '../../src/server/botPlugins/workspacePlugins'
import {UploadStore} from '../../src/server/uploads'

const owner = 'reconnect-user'
let home: string, store: WorkspaceStore, uploads: UploadStore, runtime: WorkspaceRuntime
let server: WebSocketServer, socket: WebSocket, target: GatewayTarget, nodes: WorkspaceNodes
let running: boolean, authorized: boolean, acknowledgePrompt: boolean, holdCredential: (() => Promise<void>) | undefined
let holdBind: (() => Promise<void>) | undefined
let resumedRuntimeId: string, resumedStoredId: string, historyPaths: string[]
let rpc: Array<{method: string; params: any}>, binds: any[], unbinds: any[], history: any[]
let pluginDispose: ReturnType<typeof vi.fn>, pluginCall: ReturnType<typeof vi.fn>
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-workspace-reconnect-'))
  store = new WorkspaceStore(home); uploads = new UploadStore(home)
  running = true; authorized = true; acknowledgePrompt = true; holdCredential = undefined; holdBind = undefined
  resumedRuntimeId = 'runtime'; resumedStoredId = 'stored'; historyPaths = []
  rpc = []; binds = []; unbinds = []; history = []
  server = new WebSocketServer({port: 0, host: '127.0.0.1'})
  await new Promise<void>(resolve => server.once('listening', resolve))
  target = {
    url: new URL(`http://127.0.0.1:${(server.address() as {port: number}).port}`), client: {directAgent: undefined},
    session: {
      webSocketCredential: async () => { await holdCredential?.(); return {name: 'ticket', value: 'fixture'} },
      request: async (path: string, options: any) => {
        if (path.endsWith('/bind')) { binds.push(options.body); await holdBind?.() }
        if (path.endsWith('/unbind')) unbinds.push(options.body)
        if (path.startsWith('/api/sessions/')) historyPaths.push(path)
        const value = path.endsWith('/capabilities') ? {ready: true, native_tools: true, in_process: true}
          : path.startsWith('/api/plugins/yaoyao-bot-bridge/') ? {ok: true, native_tools: true}
          : path === '/api/config' ? {terminal: {}} : {messages: history}
        return {status: 200, body: Buffer.from(JSON.stringify(value)), headers: new Headers()}
      },
    },
  } as unknown as GatewayTarget
  nodes = {requireSource: () => {}, target: () => target} as unknown as WorkspaceNodes
  runtime = new WorkspaceRuntime(store, nodes, uploads, () => authorized)
  pluginDispose = vi.fn(async () => {})
  pluginCall = vi.fn(async () => ({message: '插件仍可使用'}))
  runtime.plugins = {selected: () => true, open: async () => ({services: () => [],
    catalog: () => [{id: 'plugin_fixture', name: 'plugin_fixture', description: '回归测试', inputSchema: {type: 'object'}}],
    call: pluginCall, dispose: pluginDispose,
  })} as unknown as WorkspacePlugins
  server.on('connection', connection => {
    socket = connection
    connection.send(JSON.stringify({method: 'event', params: {type: 'gateway.ready'}}))
    connection.on('message', raw => {
      const frame = JSON.parse(String(raw)); rpc.push(frame)
      const result = frame.method === 'session.create' ? {session_id: 'runtime', stored_session_id: 'stored', running: false, info: {profile_name: 'default'}}
        : frame.method === 'session.resume' ? {session_id: resumedRuntimeId, stored_session_id: resumedStoredId, running, info: {profile_name: 'default'}}
        : {status: 'streaming'}
      if (frame.method !== 'prompt.submit' || acknowledgePrompt) connection.send(JSON.stringify({id: frame.id, result}))
    })
  })
})
afterEach(async () => {
  runtime.close()
  await new Promise(resolve => setTimeout(resolve, 20))
  for (const client of server.clients) client.terminate()
  await new Promise<void>(resolve => server.close(() => resolve()))
  uploads.close(); store.close(); rmSync(home, {recursive: true, force: true})
})
async function start() {
  const agent = store.createAgent(owner, {name: '恢复测试', profile: 'default'})
  const conversation = store.list<any>(owner, 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === agent.id)
  const run = runtime.send(owner, conversation.id, {requestId: randomUUID(), content: '只执行一次'})
  await expect.poll(() => rpc.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
  return {run, conversation, agent}
}
async function callback(path: string, body: unknown) {
  const lease = binds[0]
  return fetch(lease.bridge_url + path, {method: 'POST', headers: {Authorization: `Bearer ${lease.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)})
}
function complete(text = '恢复完成') { socket.send(JSON.stringify({method: 'event', params: {type: 'message.complete', session_id: 'runtime', payload: {text}}})) }

it.each([true, false])('keeps the original tool and plugin grants through running recovery (prompt receipt=%s)', async receipt => {
  acknowledgePrompt = receipt
  const {run, conversation, agent} = await start()
  const first = binds[0]
  socket.terminate()
  await expect.poll(() => binds.length).toBe(2)
  expect(binds[1]).toMatchObject({generation: first.generation, token: first.token, bridge_url: first.bridge_url})
  expect(unbinds).toHaveLength(0)
  expect(pluginDispose).not.toHaveBeenCalled()
  const catalog = await (await callback('/tools/list', {})).json()
  const tool = catalog.tools.find((t: any) => t.name === 'workspace_list_agents')
  const result = await (await callback('/tools/call', {toolId: tool.id, arguments: {}, callId: 'after-reconnect'})).json()
  expect(result.structuredContent.agents).toEqual(expect.arrayContaining([expect.objectContaining({id: agent.id})]))
  const plugin = catalog.tools.find((t: any) => t.name === 'plugin_fixture')
  await callback('/tools/call', {toolId: plugin.id, arguments: {}, callId: 'plugin-after-reconnect'})
  expect(pluginCall).toHaveBeenCalledOnce()
  complete()
  await expect.poll(() => store.require<any>(owner, 'run', run.id).status).toBe('complete')
  expect(store.messages(owner, conversation.id).at(-1)?.content).toBe('恢复完成')
  expect(rpc.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
  await expect.poll(() => unbinds.length).toBe(1)
  expect(pluginDispose).toHaveBeenCalledOnce()
})

it('reconciles completion during a disconnect without renewing or resubmitting the finished turn', async () => {
  const {run, conversation} = await start()
  history = [{role: 'user', content: rpc.find(r => r.method === 'prompt.submit')!.params.text}, {role: 'assistant', content: '断线期间完成'}]
  running = false; socket.terminate()
  await expect.poll(() => store.require<any>(owner, 'run', run.id).status).toBe('complete')
  expect(store.messages(owner, conversation.id).at(-1)?.content).toBe('断线期间完成')
  expect(binds).toHaveLength(1)
  expect(rpc.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
})

it('continues reconnecting if the replacement socket closes while the original grant is renewing', async () => {
  const {run} = await start()
  let release!: () => void
  holdBind = () => new Promise<void>(resolve => { release = resolve })
  socket.terminate()
  await expect.poll(() => binds.length).toBe(2)
  socket.terminate()
  await expect.poll(() => server.clients.size).toBe(0)
  holdBind = undefined; release()
  await expect.poll(() => binds.length, {timeout: 3000}).toBe(3)
  expect(new Set(binds.map(b => b.generation)).size).toBe(1)
  complete()
  await expect.poll(() => store.require<any>(owner, 'run', run.id).status).toBe('complete')
  expect(rpc.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
})

it('follows resumed runtime and compacted stored IDs for tool renewal and subsequent history reconciliation', async () => {
  const {run} = await start()
  resumedRuntimeId = 'runtime-after-resume'; resumedStoredId = 'compacted-tip'
  socket.terminate()
  await expect.poll(() => binds.length).toBe(2)
  expect(binds[1]).toMatchObject({session_id: resumedRuntimeId, stored_session_id: resumedStoredId, generation: binds[0].generation})
  expect(store.list<any>(owner, 'binding')[0]).toMatchObject({runtimeId: resumedRuntimeId, storedId: resumedStoredId, aliases: ['stored', 'compacted-tip']})
  running = false
  history = [{role: 'user', content: rpc.find(r => r.method === 'prompt.submit')!.params.text}, {role: 'assistant', content: '压缩后完成'}]
  socket.terminate()
  await expect.poll(() => store.require<any>(owner, 'run', run.id).status).toBe('complete')
  expect(historyPaths).toEqual(['/api/sessions/compacted-tip/messages'])
  expect(rpc.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
})

it.each(['stop', 'revoke', 'close'] as const)('revokes callbacks and cannot revive a detached turn after %s', async action => {
  const {run} = await start()
  socket.terminate()
  await expect.poll(() => store.require<any>(owner, 'run', run.id).error).toContain('正在恢复原执行')
  if (action === 'stop') await runtime.stop(owner, run.id)
  else if (action === 'revoke') authorized = false
  else runtime.close()
  await expect.poll(() => unbinds.length).toBe(1)
  await expect(callback('/tools/list', {})).rejects.toThrow()
  expect(pluginDispose).toHaveBeenCalledOnce()
  expect(binds).toHaveLength(1)
  expect(rpc.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
  if (action === 'stop') expect(store.require<any>(owner, 'run', run.id).status).toBe('interrupted')
})

it('does not create a late WebSocket when the service closes during reconnect credentials', async () => {
  const {run} = await start()
  let release!: () => void
  const credential = new Promise<void>(resolve => { release = resolve })
  let waiting = false
  holdCredential = () => { waiting = true; return credential }
  socket.terminate()
  await expect.poll(() => waiting).toBe(true)
  runtime.close(); release()
  await expect.poll(() => unbinds.length).toBe(1)
  expect(server.clients.size).toBe(0)
  expect(rpc.filter(r => r.method === 'session.resume')).toHaveLength(0)
  expect(store.require<any>(owner, 'run', run.id).status).toBe('uncertain')
})

it('keeps a running turn uncertain after process restart when its original tools cannot be restored', async () => {
  const {run} = await start()
  runtime.close()
  runtime = new WorkspaceRuntime(store, nodes, uploads, () => authorized)
  runtime.start()
  await expect.poll(() => store.require<any>(owner, 'run', run.id).error).toContain('本轮工具授权已丢失')
  expect(store.require<any>(owner, 'run', run.id).status).toBe('uncertain')
  expect(binds).toHaveLength(1)
  expect(rpc.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
})
