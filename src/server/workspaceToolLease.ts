import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { isLoopbackHost } from './config.js'
import { parse } from './workspaceStore.js'
import type { GatewayTarget } from './workspaceGateway.js'

const PREFIX = '/api/plugins/yaoyao-bot-bridge'
const TTL = 30 * 60_000
const envelope = z.object({ toolId: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()), callId: z.string().min(1).max(200) }).strict()
type Catalog = Array<{ id: string; name: string; description: string; inputSchema: unknown }>

async function bridgeRequest(target: GatewayTarget, path: string, body: unknown) {
  const response = await target.session.request(PREFIX + path, {
    method: 'POST', body,
  })
  let value: Record<string, unknown> = {}
  try { value = JSON.parse(response.body.toString()) } catch { /* report a bounded, credential-free error */ }
  if (response.status !== 200 || value.ok !== true)
    throw new HttpError(409, 'Hermes 工具桥绑定失败，请确认该 Profile 已启用工具桥，并新建会话后重试。', 'team_tools_bind_failed')
  return value
}

export async function requireTeamToolBridge(target: GatewayTarget, profile: string): Promise<void> {
  if (!target.runner && (target.pairedToken || !isLoopbackHost(target.url.hostname)))
    throw new HttpError(409, '组队发起者的 Hermes 必须与 Web 服务运行在同一台机器，并使用回环地址连接。', 'team_tools_local_required')
  let ready = false
  try {
    const response = await target.session.request(PREFIX + '/capabilities', { search: new URLSearchParams({ profile }), cache: 'reload' })
    const value = JSON.parse(response.body.toString())
    ready = response.status === 200 && value.version === 1 && value.ready === true && value.in_process === true && value.native_tools === true
  } catch { /* Missing or incompatible plugins do not break ordinary Bot conversations. */ }
  if (!ready) throw new HttpError(409, '该基础机器人尚未启用新版 Hermes 工具桥（yaoyao-bot-bridge）。请在对应 Profile 安装或修复并重新加载后，再开启组队权限。', 'team_tools_unavailable')
}

export interface WorkspaceToolLease {
  bind(): Promise<void>
  dispose(): Promise<void>
}

export interface LeaseInput {
  target: GatewayTarget
  profile: string
  workId: string
  session: () => { runtimeId: string; storedId: string }
  signal: AbortSignal
  assertActive(): void
  catalog(): Catalog
  call(toolId: string, args: unknown, callId?:string): Promise<unknown>
  onFailure(error: Error): void
}

/** A private loopback listener; no browser credentials or authority in prompts. */
export async function createWorkspaceToolLease(input: LeaseInput): Promise<WorkspaceToolLease> {
  if(input.target.runner)return input.target.runner.lease(input)
  const token = randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(token).digest()
  const generation = `${input.workId}:${randomUUID()}`
  let expiresAt = Date.now() + TTL, closed = false, url = ''
  let timer: ReturnType<typeof setInterval> | undefined
  let binding: Promise<void> | undefined, cleanup: Promise<void> | undefined
  let boundRuntimeId = ''
  let bound = false
  const calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>()
  // The Hermes registry is shared: IDs must differ between simultaneous grants
  // so each session gets distinct native function names and bound handlers.
  const opaqueId = (id: string) => `team_${createHash('sha256').update(`${token}:${id}`).digest('hex').slice(0,32)}`
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    json(res, error instanceof HttpError ? error.status : 500, {
      error: error instanceof HttpError ? error.message : '团队工具执行失败',
      code: error instanceof HttpError ? error.code : 'team_tool_failed',
    })
  }) })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.maxHeadersCount = 30
  server.keepAliveTimeout = 1000
  server.on('clientError', (_error, socket) => socket.destroy())

  function assertActive() {
    if (closed || input.signal.aborted || Date.now() >= expiresAt)
      throw new HttpError(410, '本轮组队授权已失效', 'team_tools_expired')
    input.assertActive()
  }
  function json(res: ServerResponse, status: number, value: unknown) {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(value))
  }
  async function read(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 256 * 1024) throw new HttpError(413, '团队工具参数过大', 'team_tool_input_limit')
      chunks.push(Buffer.from(chunk))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') }
    catch { throw new HttpError(400, '工具请求必须是有效 JSON', 'invalid_json') }
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!url || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(url).host || req.headers.origin !== undefined)
      throw new HttpError(403, '工具接口只接受本机可信连接', 'team_tools_forbidden')
    const provided = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!req.headers.authorization?.startsWith('Bearer ') || !timingSafeEqual(tokenHash, createHash('sha256').update(provided).digest()))
      throw new HttpError(401, '本轮工具凭据无效', 'team_tools_unauthorized')
    assertActive()
    if (req.method !== 'POST') throw new HttpError(405, '工具接口只接受 POST', 'method_not_allowed')
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
      throw new HttpError(415, '工具接口只接受 JSON', 'invalid_content_type')
    const body = await read(req)
    assertActive()
    if (req.url === '/tools/list') {
      parse(z.object({}).strict(), body)
      json(res, 200, { tools: input.catalog().map(tool => ({ ...tool, id: opaqueId(tool.id) })), warnings: [] })
      return
    }
    if (req.url !== '/tools/call') throw new HttpError(404, '工具接口不存在', 'not_found')
    const call = parse(envelope, body)
    const tool = input.catalog().find(candidate => opaqueId(candidate.id) === call.toolId)
    if (!tool) throw new HttpError(404, '本轮未授权此工具', 'team_tool_not_found')
    const fingerprint = JSON.stringify(canonical([call.toolId, call.arguments]))
    let previous = calls.get(call.callId)
    if (previous && previous.fingerprint !== fingerprint)
      throw new HttpError(409, '同一调用编号不能用于不同操作', 'idempotency_conflict')
    if (!previous) {
      if (calls.size >= 128) throw new HttpError(429, '本轮团队工具调用已达上限，请在后续对话继续。', 'team_tool_call_limit')
      const result = Promise.resolve().then(async () => {
        assertActive()
        try {
          const value = await input.call(tool.id, call.arguments, call.callId)
          if(value&&typeof value==='object'&&Array.isArray((value as any).content))return value
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
        } catch (error) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: error instanceof HttpError ? error.message : '团队操作失败，请检查当前状态后再重试。', code: error instanceof HttpError ? error.code : 'team_tool_failed' }) }], isError: true }
        }
      })
      previous = { fingerprint, result }; calls.set(call.callId, previous)
    }
    const result = await previous.result
    assertActive()
    json(res, 200, result)
  }

  function dispose(): Promise<void> {
    if (cleanup) return cleanup
    closed = true
    clearInterval(timer)
    input.signal.removeEventListener('abort', abort)
    server.closeAllConnections()
    cleanup = (async () => {
      await new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()) })
      await binding?.catch(() => {})
      if (boundRuntimeId) await bridgeRequest(input.target, '/unbind', { session_id: boundRuntimeId, generation }).catch(() => {})
      calls.clear()
    })()
    return cleanup
  }
  const abort = () => { void dispose() }
  async function bind() {
    assertActive()
    if (binding) return binding
    const session = input.session()
    boundRuntimeId = session.runtimeId
    binding = (async () => {
      const bindSession = async () => {
        const current = input.session()
        const result = await bridgeRequest(input.target, '/bind', { native_tools: true, session_id: current.runtimeId,
          stored_session_id: current.storedId, profile: input.profile, generation, bridge_url: url, token, expires_at: expiresAt })
        if (!bound && result.native_tools !== true)
          throw new HttpError(409, 'Hermes 未挂载本轮原生团队工具，请升级或修复工具桥。', 'team_tools_unavailable')
        bound = true
      }
      try { await bindSession() }
      catch (error) {
        if (input.session().storedId === session.storedId || closed) throw error
        await bindSession()
      }
      assertActive()
    })()
    try { await binding }
    finally { binding = undefined }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动团队工具接口')
    url = `http://127.0.0.1:${address.port}`
    input.signal.addEventListener('abort', abort, { once: true })
    assertActive()
    timer = setInterval(() => {
      if (binding) return
      try { assertActive() } catch (error) { void dispose(); input.onFailure(error as Error); return }
      expiresAt = Date.now() + TTL
      void bind().catch(error => { void dispose(); input.onFailure(error as Error) })
    }, 5 * 60_000)
    timer.unref()
    return { bind, dispose }
  } catch (error) { await dispose(); throw error }
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new HttpError(400, '工具参数嵌套过深', 'invalid_workspace_request')
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item, depth + 1)]))
  return value
}
