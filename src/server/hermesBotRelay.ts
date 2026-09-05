import type Koa from 'koa'
import { Readable } from 'node:stream'
import type { LocalAuthStore } from './localAuth.js'
import type { CsrfProtection } from './security.js'
import { WorkspaceGateway, type WorkspaceNodes, type WorkspaceNode } from './workspaceGateway.js'
import { HttpError } from './errors.js'

/** Native Hermes transport, scoped to a primary account's paired child node.
 * Never imports a Profile or creates a workspace Agent/group. */
export function hermesBotRelay(nodes: WorkspaceNodes, auth: LocalAuthStore, csrf: CsrfProtection): Koa.Middleware {
  return async (ctx, next) => {
    const native = /^(?:\/api\/app\/hermes-bot\/local|\/node\/([0-9a-f-]{36})\/api\/hermes-bot)(\/api\/.*)$/.exec(ctx.path)
    if (native) {
      const path = native[2]!
      const allowed = path.startsWith('/api/realtime/') || (ctx.method === 'GET' &&
        /^\/api\/(?:profiles(?:\/sessions)?|sessions(?:\/[^/]+(?:\/messages)?)?|files\/download)$/.test(path))
      if (!allowed) throw new HttpError(403, '不支持的原生机器人操作', 'hermes_bot_path_forbidden')
      if (!native[1]) auth.require(ctx)
      ctx.state.hermesBotNative = true
      ctx.path = native[1] ? `/node/${native[1]}${path}` : path
      return next()
    }
    if (ctx.path === '/api/app/hermes-bot/roster' && ctx.method === 'GET') {
      const owner = auth.require(ctx).id
      const nodesList = nodes.store.list<WorkspaceNode>(owner, 'node').filter(n => n.transport === 'paired-web')
      const roster = await Promise.all(nodesList.map(async node => {
        const gateway = new WorkspaceGateway(nodes.target(owner, node.id))
        try {
          await gateway.connect()
          const snapshot = await gateway.rpc('profiles.list', {include_sessions: true})
          return {id: node.id, name: node.name, remoteNodeId: node.remoteNodeId, fingerprint: node.fingerprint, snapshot}
        } catch { return {id: node.id, name: node.name, remoteNodeId: node.remoteNodeId, error: '节点不可用，请检查连接或扫码授权'} }
        finally { gateway.close() }
      }))
      ctx.set('Cache-Control', 'no-store'); ctx.body = {nodes: roster}; return
    }
    const match = /^\/api\/app\/hermes-bot\/nodes\/([0-9a-f-]{36})(\/native)?(\/api\/.*)$/.exec(ctx.path)
    if (!match) return next()
    const owner = auth.require(ctx).id, nodeID = match[1]!, path = match[3]!
    const node = nodes.store.require<WorkspaceNode>(owner, 'node', nodeID)
    if (node.transport !== 'paired-web') throw new HttpError(409, '请重新扫码授权 15300 子节点', 'paired_node_required')
    const realtime = /^\/api\/realtime\/(?:capabilities|channels(?:\/[0-9a-f-]{36}(?:\/(?:commands|events))?)?|commands\/[A-Za-z0-9:_-]{1,200})$/.test(path)
    const read = /^\/api\/(?:profiles(?:\/sessions)?|sessions(?:\/[^/]+(?:\/messages)?)?|files\/download)$/.test(path)
    if (!realtime && !(read && ctx.method === 'GET')) throw new HttpError(403, '不支持的 Hermes Bot 操作', 'hermes_bot_path_forbidden')
    const target = nodes.target(owner, nodeID)
    if (!target.pairedToken) throw new HttpError(409, '请重新扫码授权子节点', 'paired_node_required')
    let body: Buffer | undefined
    if (!['GET', 'HEAD', 'DELETE'].includes(ctx.method)) {
      if (!ctx.is('application/json')) throw new HttpError(415, 'JSON body required', 'invalid_content_type')
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of ctx.req) {
        length += Buffer.byteLength(chunk)
        if (length > 15 * 1024 * 1024) throw new HttpError(413, '请求过大', 'body_too_large')
        chunks.push(Buffer.from(chunk))
      }
      body = Buffer.concat(chunks)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    ctx.res.once('close', () => controller.abort())
    let response: Response
    try {
      response = await target.client.fetchImpl(new URL(`${target.url.href.replace(/\/$/, '')}${match[2] ? '/api/hermes-bot' : ''}${path}${ctx.search}`), {
        method: ctx.method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${target.pairedToken}`, 'Content-Type': 'application/json',
          'Last-Event-ID': ctx.get('last-event-id'), 'Idempotency-Key': ctx.get('idempotency-key') },
        ...(body ? { body: new Uint8Array(body) } : {}),
      })
    } finally { clearTimeout(timeout) }
    ctx.status = response.status
    ctx.set('Cache-Control', 'no-store')
    for (const name of ['content-type', 'content-disposition']) {
      const value = response.headers.get(name); if (value) ctx.set(name, value)
    }
    if (response.headers.get('content-type')?.startsWith('text/event-stream') && response.body) {
      const timer = setInterval(() => {
        try {
          if (auth.require(ctx).id !== owner || nodes.store.get<WorkspaceNode>(owner, 'node', nodeID)?.secret !== node.secret) controller.abort()
        } catch { controller.abort() }
      }, 5_000); timer.unref()
      const stream = Readable.fromWeb(response.body as any)
      const clear = () => clearInterval(timer)
      stream.once('close', clear); stream.once('error', clear); ctx.res.once('close', clear)
      ctx.body = stream
    } else if (path === '/api/realtime/capabilities' && response.ok) {
      ctx.body = { ...await response.json() as object, csrfToken: csrf.issue(ctx) }
    } else if (response.status !== 204) ctx.body = Buffer.from(await response.arrayBuffer())
  }
}
