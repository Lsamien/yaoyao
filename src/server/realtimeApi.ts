import type { AgentExportContext } from './workspaceRemoteAgents.js'
import { randomBytes } from 'node:crypto'
import type { Server, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type Koa from 'koa'
import { RealtimeBroker, type RealtimePrincipal, type RealtimeChannel } from './realtimeBroker.js'
import type { ServerConfig } from './config.js'
import { LocalAuthStore, UpstreamServiceSession } from './localAuth.js'
import { NodePairingStore } from './pairing.js'
import { CookieJar, UpstreamClient } from './upstream.js'
import { CsrfProtection, isAllowedHostHeader, isExactOrigin } from './security.js'
import { HttpError } from './errors.js'
import { canonicalEpoch, groupCursor } from './realtimeProtocol.js'
import { CHAT_MAX_PAYLOAD } from './realtimeProtocol.js'
import { ChatPushRelayObserver, type ChatNotificationResolver, type PushEventCoordinator, type ChatPushTransportFactory } from './pushEvents.js'

export class RealtimeAPI {
  readonly broker: RealtimeBroker
  private observers = new Map<string, ChatPushRelayObserver>()
  constructor(readonly config: ServerConfig, readonly auth: LocalAuthStore, readonly csrf: CsrfProtection,
    readonly pairings: NodePairingStore, readonly upstream: UpstreamClient, readonly session: UpstreamServiceSession,
    readonly push?: { coordinator: PushEventCoordinator; resolver: ChatNotificationResolver },
    readonly ownsSession?: (owner: string, profile: string, sessionId: string) => boolean) {
    this.broker = new RealtimeBroker(config.home, Date.now, change => {
      upstream.observeRealtime(change)
      if (change.kind === 'reset') session.invalidateAuthentication()
    })
  }
  private async canResume(profile: string, sessionId: string, _jar?: CookieJar, owner?: string): Promise<boolean> {
    return owner ? this.ownsSession?.(owner, profile, sessionId) ?? false : false
  }
  private principal(ctx: Koa.Context, device?: string): RealtimePrincipal {
    const exported=ctx.state.workspaceAgentExport as AgentExportContext | undefined
    const upstream=exported?.target.client ?? this.upstream
    const endpoint=exported?.target.url ?? this.config.upstream
    let key: string
    let valid: () => boolean
    let authorize: RealtimePrincipal['authorize']
    let jar: CookieJar | undefined
    let owner: string | undefined
    let observer: ChatPushRelayObserver | undefined
    if (device) {
      const bearer = ctx.get('authorization').match(/^Bearer\s+(.+)$/i)?.[1] ?? ''
      jar = new CookieJar(this.pairings.authorize(device, bearer))
      key = `device:${device}${exported ? ':agent:'+exported.id : ''}`
      owner = key
      valid = () => this.pairings.hasDevice(device) && (!exported || exported.valid())
      authorize = (kind, method) => {
        this.pairings.authorize(device, bearer, kind === 'groups' ? 'groups.read'
          : method === 'profiles.list' || method === 'profiles.get_asset' ? 'agents.read' : 'sessions.execute')
      }
    } else {
      const user = this.auth.require(ctx)
      owner = user.id
      const cookie = ctx.get('cookie')
      key = `user:${user.id}:${this.auth.pushAuthorizationVersion(user.id)}`
      valid = () => { try { return this.auth.currentFromCookieHeader(cookie)?.id === user.id } catch { return false } }
      if (this.push) {
        observer = this.observers.get(key)
        if (!observer) {
          observer = new ChatPushRelayObserver(this.push.coordinator, { localUserID: user.id, source: 'web' }, Date.now, this.push.resolver)
          this.observers.set(key, observer)
        }
      }
    }
    const nativeBot = ctx.state.hermesBotNative === true
    if (nativeBot) key = `native:${key}`
    return {
      key, nativeBot, instanceKey: endpoint.href, upstreamKey: `${endpoint.href}:${device ? key : 'service'}`, paired: Boolean(device), valid, authorize,
      canResume: (profile, sessionId) => this.canResume(profile, sessionId, jar, owner),
      agent: upstream.directAgent,
      observeCommand: f => observer?.observeClientFrame(f),
      observeEvent: f => observer?.observeUpstreamFrame(Buffer.from(f), false),
      url: async (kind, anchor) => {
        if (device && !valid()) throw new HttpError(401, 'Device revoked', 'authentication_required')
        // Paired devices retain their delegated identity; never upgrade a device
        // cookie into the local service's loopback authorization.
        let credential: { name: string; value: string }
        if (exported && endpoint.href !== this.config.upstream.href) credential = await exported.target.session.webSocketCredential()
        else if (jar) {
          const response = await this.upstream.request('/api/auth/ws-ticket', jar, { method: 'POST' })
          if (response.status !== 200) throw new HttpError(502, 'Upstream authentication failed', 'upstream_auth_failed')
          const ticket = JSON.parse(response.body.toString()).ticket
          if (typeof ticket !== 'string' || !ticket) throw new HttpError(502, 'Invalid upstream ticket', 'invalid_ticket')
          credential = { name: 'ticket', value: ticket }
        } else credential = await this.session.webSocketCredential()
        const url = new URL(endpoint)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws`
        url.search = ''; url.searchParams.set(credential.name, credential.value)
        if (anchor) { url.searchParams.set('epoch', anchor.epoch); url.searchParams.set('cursor', String(anchor.cursor)) }
        return url
      },
    }
  }
  recoveryTransport: ChatPushTransportFactory = async (job, onFrame, onClose) => {
    const principal: RealtimePrincipal = {
      key: `push:${job.localUserID}:${this.auth.pushAuthorizationVersion(job.localUserID)}`,
      upstreamKey: `${this.config.upstream.href}:service`, paired: false,
      instanceKey: this.config.upstream.href,
      agent: this.upstream.directAgent,
      valid: () => this.auth.isUserActive(job.localUserID),
      url: async () => {
        const credential = await this.session.webSocketCredential()
        const url = new URL(this.config.upstream)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        url.pathname = `${url.pathname.replace(/\/$/, '')}/api/ws`
        url.search = ''; url.searchParams.set(credential.name, credential.value)
        return url
      },
    }
    const channel = await this.broker.create(principal, 'chat')
    let off = () => {}, closed = false
    return {
      start: () => { off = this.broker.subscribe(channel, undefined, entry => { if (entry.event === 'reset') onClose(); else onFrame(entry.data) }) },
      send: raw => {
        const frame = JSON.parse(raw)
        void Promise.resolve().then(() => this.broker.command(channel, randomBytes(24).toString('hex'), frame)).then(receipt => {
          if (!closed) onFrame(JSON.stringify({ id: frame.id, ...(receipt.response ?? { error: { message: 'Submission uncertain' } }) }))
        }).catch(onClose)
      },
      close: () => { closed = true; off(); this.broker.release(channel) },
    }
  }
  ownsPushJob(jobID: string): boolean { return [...this.observers.values()].some(observer => observer.ownsJob(jobID)) }
  private checkMutation(ctx: Koa.Context, paired: boolean): void {
    if (paired || ['GET', 'HEAD'].includes(ctx.method)) return
    if (!isExactOrigin(ctx.get('origin'), ctx.get('host'), ctx.secure || Boolean(this.config.tlsCert), this.config.allowedHosts)
      || !this.csrf.verify(ctx.get('cookie'), ctx.get('x-csrf-token'))) {
      throw new HttpError(403, 'Origin or CSRF token is invalid', 'invalid_csrf')
    }
  }
  private async body(ctx: Koa.Context, limit = 2 * 1024 * 1024): Promise<Record<string, any>> {
    if (!ctx.is('application/json')) throw new HttpError(415, 'JSON body required', 'invalid_content_type')
    let bytes = 0
    const chunks: Buffer[] = []
    const timeout = setTimeout(() => ctx.req.destroy(), 30_000)
    timeout.unref()
    try {
      for await (const chunk of ctx.req) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > limit) throw new HttpError(413, 'Request body too large', 'body_too_large')
        chunks.push(Buffer.from(chunk))
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
      return value as Record<string, any>
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid JSON', 'invalid_json_body') }
    finally { clearTimeout(timeout) }
  }
  middleware(): Koa.Middleware {
    return async (ctx, next) => {
      const match = /^(?:\/node\/([0-9a-f-]{36}))?\/api\/realtime(\/.*)$/.exec(ctx.path)
      if (/^(?:\/node\/[^/]+)?\/api\/(?:auth\/ws-ticket|ws|plugins\/yaoyao\/v1\/events)$/.test(ctx.path)
        || ctx.path === '/api/app/realtime-leases' || /^\/ws\/(?:chat|groups)$/.test(ctx.path)) {
        throw new HttpError(410, 'Legacy realtime endpoints were removed; use HTTP+SSE', 'http_sse_required')
      }
      if (!match) return next()
      const device = match[1]
      const principal = this.principal(ctx, device)
      ctx.set('Cache-Control', 'no-store')
      const path = match![2]!
      if (ctx.method === 'GET' && path === '/capabilities') {
        ctx.body = { protocolVersion: 1, channels: ['chat'], brokerEpoch: this.broker.epoch,
          ...(device ? {} : { csrfToken: this.csrf.issue(ctx) }) }
        return
      }
      this.checkMutation(ctx, Boolean(device))
      if (ctx.method === 'POST' && path === '/channels') {
        const body = await this.body(ctx)
        if (ctx.state.workspaceAgentExport && body.channel !== 'chat') throw new HttpError(403,'Agent 仅支持聊天通道','invalid_channel')
        if (body.channel !== 'chat' && body.channel !== 'groups') throw new HttpError(400, 'Invalid channel', 'invalid_channel')
        const c = await this.broker.create(principal, body.channel, body.channel === 'groups'
          ? { epoch: canonicalEpoch(body.epoch), cursor: groupCursor(body.cursor) } : undefined)
        ctx.status = 201; ctx.body = { id: c.id, brokerEpoch: this.broker.epoch }; return
      }
      const receipt = /^\/commands\/([A-Za-z0-9:_-]{1,200})$/.exec(path)
      if (receipt && ctx.method === 'GET') { ctx.body = this.broker.receipt(principal, receipt[1]!); return }
      const channel = /^\/channels\/([0-9a-f-]{36})(?:\/(commands|events))?$/.exec(path)
      if (!channel) throw new HttpError(404, 'Realtime route not found', 'not_found')
      const c = this.broker.get(principal, channel[1]!)
      if (ctx.method === 'DELETE' && !channel[2]) { this.broker.detach(principal, c.id); ctx.status = 204; return }
      if (ctx.method === 'POST' && channel[2] === 'commands') {
        let body = await this.body(ctx, CHAT_MAX_PAYLOAD)
        const exported=ctx.state.workspaceAgentExport as AgentExportContext | undefined
        if (exported) body=exported.transform(body)
        ctx.body = await this.broker.command(c, ctx.get('idempotency-key'), body)
        return
      }
      if (ctx.method === 'GET' && channel[2] === 'events') { this.stream(ctx, c); return }
      throw new HttpError(405, 'Method not allowed', 'method_not_allowed')
    }
  }
  private stream(ctx: Koa.Context, c: RealtimeChannel): void {
    const res = ctx.res
    const initial: string[] = []
    let started = false
    let closed = false
    let congested: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let off = () => {}
    const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); clearTimeout(congested); off(); if (!res.writableEnded) res.end() }
    const write = (text: string) => {
      if (!started) { initial.push(text); return }
      if (res.destroyed || res.writableEnded) return close()
      if (res.writableLength + Buffer.byteLength(text) > 1024 * 1024) return close()
      if (!res.write(text) && !congested) { congested = setTimeout(close, 15_000); congested.unref() }
    }
    off = this.broker.subscribe(c, ctx.get('last-event-id') || undefined, entry => {
      write(`id: ${entry.id}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`)
      if (entry.event === 'reset' && started) close()
    })
    ctx.respond = false
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
    res.flushHeaders(); started = true
    write(`event: ready\ndata: ${JSON.stringify({ channelId: c.id, brokerEpoch: this.broker.epoch })}\n\n`)
    for (const text of initial) write(text)
    heartbeat = setInterval(() => { if (!c.principal.valid()) close(); else write(': heartbeat\n\n') }, 15_000)
    heartbeat.unref()
    res.on('drain', () => { clearTimeout(congested); congested = undefined })
    res.once('close', close)
    res.once('error', close)
  }

  rejectLegacyUpgrades(server: Server): () => void {
    const upgrade = (request: IncomingMessage, socket: Duplex) => {
      const path = (request.url ?? '/').split('?')[0]!
      if (!this.config.production && !path.startsWith('/api/') && !path.startsWith('/node/') && !path.startsWith('/ws/')) return
      const body = JSON.stringify({ code: 'http_sse_required', error: 'Client WebSockets are no longer supported; use HTTP+SSE' })
      socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body)
    }
    server.on('upgrade', upgrade)
    return () => server.off('upgrade', upgrade)
  }
  close(): void {
    for (const observer of this.observers.values()) observer.disconnected()
    this.observers.clear(); this.broker.close()
  }
}
