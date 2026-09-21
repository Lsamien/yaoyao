// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OpenVikingClient } from '@openviking/sdk'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import { WorkspaceMemorySynthesis } from '../../src/server/workspaceMemorySynthesis'
import { OpenVikingConfigurationManager } from '../../src/server/openVikingConfiguration'
import { OpenVikingService } from '../../src/server/openVikingService'
import { UploadStore } from '../../src/server/uploads'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'
import type { WorkspaceConversation } from '../../src/shared/workspace'

// Starts its own real server and disposable account. Never accepts a production URL/key.
const python = process.env.YAOYAO_OPENVIKING_PYTHON
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
const close = async (server: Server) => {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
}
async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

it.skipIf(!python)('extracts into a new Bot namespace, reads, searches and injects memory with real OpenViking', async () => {
  const home = await mkdtemp(join(tmpdir(), 'yaoyao-openviking-live-'))
  const rootKey = randomUUID(), owner = 'fixture-owner'
  // Deterministic local model endpoints keep this a storage/protocol test with no external calls.
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.endsWith('/embeddings')) {
      const input = Array.isArray(body.input) ? body.input : [body.input]
      res.end(JSON.stringify({ object: 'list', model: 'fixture-embedding', data: input.map((_, index) => ({ object: 'embedding', index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })), usage: { prompt_tokens: 1, total_tokens: 1 } }))
    } else if (req.method === 'GET') res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
    else res.end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: '已确认的 Bot 工作环境。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  let child: ChildProcess | undefined, store: WorkspaceStore | undefined, uploads: UploadStore | undefined
  let runtime: WorkspaceRuntime | undefined, synthesis: WorkspaceMemorySynthesis | undefined, logs = '', startupError = ''
  try {
    const modelPort = await listen(model)
    const reservation = createServer(), port = await listen(reservation); await close(reservation)
    const baseUrl = `http://127.0.0.1:${port}`, apiBase = `http://127.0.0.1:${modelPort}/v1`
    const configPath = join(home, 'ov.conf')
    await writeFile(configPath, JSON.stringify({
      server: { host: '127.0.0.1', port, root_api_key: rootKey, auth_mode: 'api_key', with_bot: false },
      storage: { workspace: join(home, 'viking-data') },
      embedding: { dense: { provider: 'openai', model: 'fixture-embedding', api_key: 'fixture', api_base: apiBase, dimension: 8, input: 'text', encoding_format: 'float' } },
      vlm: { provider: 'openai', model: 'fixture-model', api_key: 'fixture', api_base: apiBase, max_retries: 0 },
    }), { mode: 0o600 })
    child = spawn(python!, ['-m', 'openviking_cli.server_bootstrap', '--config', configPath, '--host', '127.0.0.1', '--port', String(port)], {
      cwd: home, env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: '1', NO_PROXY: '127.0.0.1,localhost' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', chunk => { logs = (logs + String(chunk)).slice(-12000) })
    child.stderr!.on('data', chunk => { logs = (logs + String(chunk)).slice(-12000) })
    child.once('error', error => { startupError = error.message })
    await expect.poll(async () => {
      if (startupError) throw new Error(startupError)
      if (child!.exitCode !== null) throw new Error(logs)
      try { return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).status } catch { return 0 }
    }, { timeout: 45000 }).toBe(200)
    const admin = new OpenVikingClient({ baseUrl, apiKey: rootKey })
    await admin.adminCreateAccount('fixture-bots', 'admin')
    store = new WorkspaceStore(join(home, 'web'))
    uploads = new UploadStore(store.home)
    const manager = new OpenVikingConfigurationManager(store.home)
    await manager.update({ enabled: true, url: baseUrl, accountId: 'fixture-bots', adminKey: rootKey })
    const service = new OpenVikingService(store, manager)
    runtime = new WorkspaceRuntime(store, { requireSource() {} } as unknown as WorkspaceNodes, uploads, undefined, undefined, service)
    vi.spyOn(runtime, 'wake').mockImplementation(() => {})
    synthesis = new WorkspaceMemorySynthesis(runtime)
    const agent = store.createAgent(owner, { name: '环境助手', profile: 'default' })
    const other = store.createAgent(owner, { name: '另一位助手', profile: 'default' })
    const conversation = store.list<WorkspaceConversation>(owner, 'conversation').find(c => c.memberIds.includes(agent.id))!
    const content = 'app 项目在开发机 studio 的 /workspace/app 开发，服务端部署在 server。'
    const run = runtime.send(owner, conversation.id, { requestId: randomUUID(), content })
    store.saveMessage(owner, { id: randomUUID(), conversationId: conversation.id, seq: 0, role: 'assistant', agentId: agent.id, content: '已确认本次项目的环境与分工。', status: 'complete', runId: run.id, tools: [], attachments: [], createdAt: Date.now() })
    run.status = 'complete'; store.saveRun(owner, run)
    synthesis.enqueue(owner, run)
    synthesis.infer = async () => JSON.stringify({ memories: [{ scope: 'agent', tier: 'log', content, sourceMessageId: run.messageId, quote: content }] })
    await synthesis.tick()
    const job = runtime.knowledge.jobs(owner)[0]!
    expect(job, logs).toMatchObject({ status: 'complete', result: { extractedCount: 1, writtenCount: 1 } })
    const own = await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })
    expect(own.map(memory => memory.content)).toEqual([content])
    expect((await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id, search: 'studio' })).map(memory => memory.id)).toEqual(own.map(memory => memory.id))
    expect((await runtime.knowledge.context(owner, agent.id)).text).toContain(content)
    expect((await runtime.knowledge.context(owner, other.id)).text).not.toContain(content)
    await runtime.knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: other.id, content: '另一位 Bot 的私有部署约定。', tier: 'log' })
    expect((await runtime.knowledge.context(owner, agent.id)).text).not.toContain('另一位 Bot 的私有部署约定')
    const remote = await service.userClient(owner, agent.id).find('studio', { targetUri: 'viking://~/memories/yaoyao/agent', tags: ['yaoyao_memory=true'] })
    expect(remote.memories, logs).not.toHaveLength(0)
    const duplicate = await runtime.knowledge.writeMemoryWithResult(owner, { requestId: randomUUID(), scope: 'agent', agentId: agent.id, content, tier: 'log' })
    expect(duplicate.outcome).toBe('duplicate')
    expect(await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })).toHaveLength(1)
    await expect(service.userClient(owner, other.id).read(`viking://user/${service.binding(owner, agent.id)!.userId}/memories/yaoyao/agent/${own[0]!.id}.json`)).rejects.toThrow()
  } finally {
    synthesis?.close(); runtime?.close(); uploads?.close(); store?.close()
    if (child) await stop(child)
    await close(model)
    await rm(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
}, 120000)
