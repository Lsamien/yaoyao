import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { HttpError } from './errors.js'
import { checkedChatFrame, CHAT_MAX_PAYLOAD, GroupFrameValidator } from './realtimeProtocol.js'
import { RealtimeReceipts, type CommandReceipt } from './realtimeReceipts.js'
import { applyWorkingDirectory, type AppliedWorkingDirectory } from './sessionWorkingDirectory.js'

type Frame = Record<string, any>
export interface RealtimeActivity { kind: 'command' | 'event' | 'group' | 'reset'; name: string; sessionId?: string; roomId?: string }
export interface RealtimePrincipal {
  key: string
  upstreamKey: string
  instanceKey?: string
  paired: boolean
  nativeBot?: boolean
  agent?: WebSocket.ClientOptions['agent']
  valid(): boolean
  authorize?(kind: 'chat' | 'groups', method?: string): void
  canResume?(profile: string, sessionId: string): Promise<boolean>
  configuredWorkingDirectory?(profile: string): Promise<string | undefined>
  url(channel: 'chat' | 'groups', anchor?: { epoch: string; cursor: number }): Promise<URL>
  observeCommand?(frame: string): void
  observeEvent?(frame: string): void
}
export interface StreamEntry { id: string; event: 'frame' | 'reset'; data: string; at: number; bytes: number }
export interface RealtimeChannel {
  id: string; kind: 'chat' | 'groups'; principal: RealtimePrincipal
  seq: number; droppedThrough: number; entries: StreamEntry[]; routes: Set<string>
  listeners: Set<(entry: StreamEntry) => void>; touched: number; bytes: number
  group?: { epoch: string; cursor: number }; socket?: WebSocket
}
interface Route { profile: string; stored: string; runtime: string; active: boolean; seq: number; observers: Map<string, RealtimePrincipal>; cwd?: string; workingDirectory?: AppliedWorkingDirectory }
interface Pending { resolve(frame: Frame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Upstream {
  principal: RealtimePrincipal; socket?: WebSocket; connecting?: Promise<void>; ready?: Frame
  pending: Map<string, Pending>; routes: Map<string, Route>; byRuntime: Map<string, Route>
  tails: Map<string, Promise<unknown>>; early: Map<string, Frame[]>; earlyBytes: number
  retry?: ReturnType<typeof setTimeout>; attempts: number; epoch?: string; recovering: boolean
  lastUsed: number; ping?: ReturnType<typeof setInterval>
  deferred: Frame[]
  recovery?: Promise<void>
}

/** Server-owned WS transports. Downstream detach never tears down an active upstream. */
export class RealtimeBroker {
  get idleForUpdate(): boolean {
    return this.commands.size === 0 && [...this.upstreams.values()].every(upstream => upstream.pending.size === 0 && [...upstream.routes.values()].every(route => !route.active))
  }
  protectedSession: (id: string) => boolean = () => false
  onNativeEvent: (owner: string, profile: string, storedId: string, frame: Frame) => void = () => {}
  onNativeGlobalEvent: (owner: string, type: string) => void = () => {}
  onNativeCommand: (owner: string, profile: string, storedId: string, method: string, params: Frame) => void = () => {}
  onNativeRoute: (owner: string, profile: string, storedId: string, runtimeId: string) => void = () => {}
  readonly epoch = randomUUID()
  readonly channels = new Map<string, RealtimeChannel>()
  private upstreams = new Map<string, Upstream>()
  private commands = new Map<string, Promise<CommandReceipt>>()
  private completed = new Map<string, { receipt: CommandReceipt; at: number; bytes: number }>()
  private receipts: RealtimeReceipts
  private timer: ReturnType<typeof setInterval>
  private closed = false
  constructor(home: string, readonly now = Date.now, readonly onActivity: (activity: RealtimeActivity) => void = () => {}) {
    this.receipts = new RealtimeReceipts(home)
    this.timer = setInterval(() => this.sweep(), 5_000)
    this.timer.unref()
  }

  async create(principal: RealtimePrincipal, kind: 'chat' | 'groups', group?: { epoch: string; cursor: number }): Promise<RealtimeChannel> {
    if (String(kind) === 'groups') throw new HttpError(410, '请使用新版聊天事件接口', 'retired_group_stream')
    if (this.closed) throw new HttpError(503, 'Realtime broker is stopping', 'broker_stopping')
    principal.authorize?.(kind)
    if (!principal.valid()) throw new HttpError(401, 'Authentication expired', 'authentication_required')
    // Closed pages leave resumable channels behind. They must not consume the live-stream
    // quota; evict oldest detached handles under pressure, never a running upstream.
    let own = [...this.channels.values()].filter(c => c.principal.key === principal.key)
    while (own.length >= 32) {
      const stale = own.filter(c => !c.listeners.size).sort((a, b) => a.touched - b.touched)[0]
      if (!stale) break
      this.remove(stale); own = own.filter(c => c !== stale)
    }
    if (own.length >= 32 || this.channels.size >= 512) {
      throw new HttpError(429, 'Too many realtime channels', 'channel_limit')
    }
    const c: RealtimeChannel = { id: randomUUID(), kind, principal, seq: 0, droppedThrough: 0,
      entries: [], routes: new Set(), listeners: new Set(), touched: this.now(), bytes: 0, group }
    this.channels.set(c.id, c)
    try {
      {
        const u = this.upstream(principal)
        await this.connect(u)
        this.emit(c, 'frame', u.ready!)
      }
      return c
    } catch (e) { this.remove(c); throw e }
  }

  get(principal: RealtimePrincipal, id: string): RealtimeChannel {
    const c = this.channels.get(id)
    if (!c || c.principal.key !== principal.key) throw new HttpError(404, 'Channel not found', 'channel_not_found')
    if (!principal.valid()) throw new HttpError(401, 'Authentication expired', 'authentication_required')
    c.touched = this.now()
    return c
  }
  detach(principal: RealtimePrincipal, id: string): void { this.remove(this.get(principal, id)) }
  release(c: RealtimeChannel): void { if (this.channels.get(c.id) === c) this.remove(c) }
  private remove(c: RealtimeChannel): void {
    this.channels.delete(c.id)
    c.socket?.close()
    for (const listener of c.listeners) {
      try { listener({ id: '', event: 'reset', data: '{"reason":"channel_closed"}', at: this.now(), bytes: 0 }) } catch { /* a closed consumer must not affect the upstream */ }
    }
    c.listeners.clear()
  }
  subscribe(c: RealtimeChannel, cursor: string | undefined, listener: (entry: StreamEntry) => void): () => void {
    if ([...this.channels.values()].filter(v => v.principal.key === c.principal.key).reduce((n, v) => n + v.listeners.size, 0) >= 8) {
      throw new HttpError(429, 'Too many active event streams', 'stream_limit')
    }
    this.trim(c)
    let seq = 0
    if (cursor) {
      const prefix = `${this.epoch}:`
      if (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length))) {
        throw new HttpError(409, 'Stream epoch changed', 'reset_required')
      }
      seq = Number(cursor.slice(prefix.length))
    }
    if (!Number.isSafeInteger(seq) || seq < c.droppedThrough || seq > c.seq) {
      throw new HttpError(409, 'Replay window expired', 'reset_required')
    }
    c.listeners.add(listener)
    for (const entry of c.entries) if (Number(entry.id.split(':').at(-1)) > seq) listener(entry)
    return () => { c.listeners.delete(listener); c.touched = this.now() }
  }
  receipt(p: RealtimePrincipal, id: string): CommandReceipt {
    if (!p.valid()) throw new HttpError(401, 'Authentication expired', 'authentication_required')
    const receipt = this.completed.get(`${p.key}:${id}`)?.receipt ?? this.receipts.lookup(p.key, id)
    if (!receipt) throw new HttpError(404, 'Receipt not found; do not automatically resubmit an attempted command', 'receipt_not_found')
    return receipt
  }

  command(c: RealtimeChannel, requestId: string, input: Frame): Promise<CommandReceipt> {
    if (this.closed) throw new HttpError(503, 'Realtime broker is stopping', 'broker_stopping')
    if (c.kind !== 'chat') throw new HttpError(403, 'Group event channel is read-only', 'read_only')
    const normalized = checkedChatFrame(Buffer.from(JSON.stringify(input)), false, c.principal.paired)
    const frame = JSON.parse(normalized) as Frame
    if (Object.values(frame.params?.preferred_session_ids ?? {}).some(id => typeof id === 'string' && this.protectedSession(id))) {
      throw new HttpError(404, '会话不存在', 'session_not_found')
    }
    c.principal.authorize?.('chat', String(frame.method))
    delete frame.id
    const fingerprint = JSON.stringify(frame)
    if (!this.receipts.lookup(c.principal.key, requestId) && (this.commands.size >= 1024
      || [...this.commands.keys()].filter(k => k.startsWith(`${c.principal.key}:`)).length >= 32)) {
      throw new HttpError(429, 'Too many pending commands', 'command_limit')
    }
    const existing = this.receipts.reserve(c.principal.key, requestId, fingerprint)
    const key = `${c.principal.key}:${requestId}`
    if (existing) return this.commands.get(key) ?? Promise.resolve(this.completed.get(key)?.receipt ?? existing)
    const work = this.perform(c, frame).then(response => {
      const state = response.error ? 'rejected' : 'confirmed'
      this.receipts.finish(c.principal.key, requestId, state, response)
      return { requestId, state, response } as CommandReceipt
    }, (error: unknown) => {
      if (error instanceof HttpError) {
        const response = { error: { code: error.code, message: error.message } }
        this.receipts.finish(c.principal.key, requestId, 'rejected', response)
        return { requestId, state: 'rejected', response } as CommandReceipt
      }
      this.receipts.finish(c.principal.key, requestId, 'unknown')
      return { requestId, state: 'unknown' } as CommandReceipt
    })
    this.commands.set(key, work)
    void work.then(receipt => {
      this.commands.delete(key)
      this.completed.set(key, { receipt, at: this.now(), bytes: Buffer.byteLength(JSON.stringify(receipt)) })
      while (this.completed.size > 10_000 || [...this.completed.values()].reduce((n, x) => n + x.bytes, 0) > 32 * 1024 * 1024) this.completed.delete(this.completed.keys().next().value!)
    })
    return work
  }

  private async perform(c: RealtimeChannel, frame: Frame): Promise<Frame> {
    const u = this.upstream(c.principal)
    const p = frame.params as Frame
    if (p.session_id && this.protectedSession(String(p.session_id))) throw new HttpError(404, '会话不存在', 'session_not_found')
    const method = String(frame.method)
    const opening = method === 'session.create' || method === 'session.resume'
    if (opening && (c.routes.size >= 128 || u.routes.size >= 512)) throw new HttpError(429, 'Route capacity reached', 'route_limit')
    let route = p.session_id ? u.byRuntime.get(p.session_id) : undefined
    if (!opening && !method.startsWith('profiles.')) {
      if (!route && (method === 'approval.respond' || method === 'clarify.respond')) {
        // These RPCs use request_id rather than session_id; resolve only a pending interaction seen by this channel.
        const match = [...c.routes].map(k => u.routes.get(k)).find(r => r && this.interactions.get(`${u.principal.upstreamKey}:${p.request_id}`) === r.runtime)
        route = match
      }
      if (!route || !c.routes.has(this.routeKey(route.profile, route.stored))) throw new HttpError(403, 'Session is not subscribed', 'route_forbidden')
      if (['approval.respond', 'clarify.respond'].includes(method)
        && this.interactions.get(`${u.principal.upstreamKey}:${p.request_id}`) !== route.runtime) {
        throw new HttpError(403, 'Interaction does not belong to this session', 'interaction_forbidden')
      }
    }
    const routeKey = opening ? this.routeKey(String(p.profile), String(p.session_id ?? c.id))
      : route ? this.routeKey(route.profile, route.stored) : 'profiles'
    const execute = async () => {
      if (!c.principal.valid()) throw new HttpError(401, 'Authentication expired', 'authentication_required')
      if (method === 'session.resume') {
        let permitted = !c.principal.canResume || await c.principal.canResume(String(p.profile), String(p.session_id))
        if (c.principal.nativeBot) {
          await this.connect(u)
          const roster = await this.rpc(u, 'profiles.list', {include_sessions: false})
          const profiles = roster.result?.profiles
          const bot = Array.isArray(profiles) ? profiles.find((value: Frame) => value.name === p.profile) : undefined
          permitted = !roster.error && typeof p.session_id === 'string' && p.session_id.length > 0 &&
            bot?.ui_meta?.['hermes-bots']?.chat === p.session_id
        }
        if (!permitted) {
          throw new HttpError(403, '此会话属于历史记录，不能继续聊天', 'history_session_read_only')
        }
        const ownerKey = JSON.stringify([c.principal.instanceKey ?? c.principal.upstreamKey, p.profile, p.session_id])
        const owner = this.routeOwners.get(ownerKey)
        if (owner && owner !== c.principal.upstreamKey) throw new HttpError(409, 'Session is attached through another credential scope', 'session_scope_conflict')
        this.routeOwners.set(ownerKey, c.principal.upstreamKey)
      }
      await this.connect(u)
      await u.recovery
      if (!c.principal.valid()) throw new HttpError(401, 'Authentication expired', 'authentication_required')
      if (!c.principal.nativeBot && c.principal.configuredWorkingDirectory) {
        if (method === 'session.create') {
          const cwd = await c.principal.configuredWorkingDirectory(String(p.profile))
          // Client cwd is never authoritative, including paired mobile clients.
          delete p.cwd
          if (cwd) p.cwd = cwd
        } else if (route && !route.active && ['prompt.submit', 'file.attach', 'image.attach_bytes', 'pdf.attach'].includes(method)) {
          const cwd = await c.principal.configuredWorkingDirectory(route.profile)
          if (!c.principal.valid()) throw new HttpError(401, 'Authentication expired', 'authentication_required')
          route.workingDirectory = await applyWorkingDirectory(async (method, params) => {
            const response = await this.rpc(u, method, params)
            if (response.error) throw new HttpError(502, response.error.message || '无法切换到 Agent 工作目录', 'working_directory_rejected')
            return response.result
          }, route.runtime, cwd, route.workingDirectory, route.cwd)
          if (route.workingDirectory) route.cwd = route.workingDirectory.resolved
        }
        if (!c.principal.valid()) throw new HttpError(401, 'Authentication expired', 'authentication_required')
      }
      const previouslyActive = route?.active ?? false
      if (route && (method === 'prompt.submit' || method === 'session.steer')) route.active = true
      const nativeOwner = this.nativeOwner(c.principal)
      if (nativeOwner && route && ['prompt.submit', 'session.steer'].includes(method)) {
        this.onNativeCommand(nativeOwner, route.profile, route.stored, method, p)
      }
      const activity: RealtimeActivity = { kind: 'command', name: method, sessionId: route?.stored }
      this.onActivity(activity)
      const response = await this.rpc(u, method, p, f => c.principal.observeEvent?.(JSON.stringify(f)), f => c.principal.observeCommand?.(JSON.stringify(f)))
        .finally(() => this.onActivity(activity))
      if (response.error && route && (method === 'prompt.submit' || method === 'session.steer')) route.active = previouslyActive
      if (!response.error && route && (method === 'prompt.submit' || method === 'session.steer')) route.active = true
      if ((opening || method === 'session.branch') && response.result) {
        const result = response.result as Frame
        const info = result.info ?? {}
        const runtime = String(result.session_id ?? '')
        const stored = String(result.stored_session_id ?? result.session_key ?? info.stored_session_id ?? p.session_id ?? runtime)
        if (!runtime || !stored) throw new Error('Invalid upstream session identity')
        const profile = String(p.profile ?? route?.profile ?? 'default')
        const key = this.routeKey(profile, stored)
        this.routeOwners.set(JSON.stringify([c.principal.instanceKey ?? c.principal.upstreamKey, profile, stored]), c.principal.upstreamKey)
        const r: Route = u.routes.get(key) ?? { profile, stored, runtime, active: false, seq: 0, observers: new Map() }
        u.byRuntime.delete(r.runtime)
        r.runtime = runtime
        r.active = result.running === true || info.running === true
        // Resume/reconnect may have restored a historical cwd or another runtime.
        r.workingDirectory = undefined
        r.cwd = typeof info.cwd === 'string' ? info.cwd : undefined
        u.routes.set(key, r); u.byRuntime.set(runtime, r); c.routes.add(key)
        r.observers.set(c.principal.key, c.principal)
        if (nativeOwner) this.onNativeRoute(nativeOwner, profile, stored, runtime)
        if (nativeOwner && (method === 'session.create' || method === 'session.branch')) {
          this.onNativeCommand(nativeOwner, profile, stored, method, p)
        }
        for (const pending of [result.pending_approval, result.pending_clarify, result.inflight?.pending_approval, result.inflight?.pending_clarify]) {
          if (pending?.request_id) this.interactions.set(`${u.principal.upstreamKey}:${pending.request_id}`, runtime)
        }
        const early = u.early.get(runtime) ?? []
        u.early.delete(runtime)
        for (const e of early) { u.earlyBytes -= Buffer.byteLength(JSON.stringify(e)); this.event(u, e) }
      }
      if (method === 'session.close' && route && !response.error) {
        u.byRuntime.delete(route.runtime); u.routes.delete(this.routeKey(route.profile, route.stored))
        this.routeOwners.delete(JSON.stringify([c.principal.instanceKey ?? c.principal.upstreamKey, route.profile, route.stored]))
      }
      if (route && response.result && ['file.attach','image.attach_bytes','pdf.attach'].includes(method) && c.principal.key.startsWith('user:')) {
        this.onNativeEvent(c.principal.key.split(':')[1]!, route.profile, route.stored, { type:'attachment.staged', payload:response.result })
      }
      u.lastUsed = this.now()
      return this.withoutProtectedSessions(response) ?? { result: {} }
    }
    if (['session.interrupt', 'approval.respond', 'clarify.respond', 'session.steer'].includes(method)) return execute()
    const work = (u.tails.get(routeKey) ?? Promise.resolve()).catch(() => {}).then(execute)
    u.tails.set(routeKey, work)
    void work.finally(() => { if (u.tails.get(routeKey) === work) u.tails.delete(routeKey) }).catch(() => {})
    return work
  }

  private interactions = new Map<string, string>()
  private routeOwners = new Map<string, string>()
  private routeKey(profile: string, stored: string): string { return JSON.stringify([profile, stored]) }
  private upstream(p: RealtimePrincipal): Upstream {
    let u = this.upstreams.get(p.upstreamKey)
    if (!u) {
      if (this.upstreams.size >= 64) throw new HttpError(429, 'Upstream capacity reached', 'upstream_limit')
      u = { principal: p, pending: new Map(), routes: new Map(), byRuntime: new Map(), tails: new Map(),
        early: new Map(), earlyBytes: 0, attempts: 0, recovering: false, deferred: [], lastUsed: this.now() }
      this.upstreams.set(p.upstreamKey, u)
    }
    return u
  }
  private connect(u: Upstream): Promise<void> {
    if (u.connecting) return u.connecting
    if (u.socket?.readyState === WebSocket.OPEN && u.ready) return Promise.resolve()
    u.connecting = (async () => {
      const url = await u.principal.url('chat')
      if (this.closed) throw new Error('Broker closed')
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url, { agent: u.principal.agent, headers: { Origin: `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}` }, maxPayload: CHAT_MAX_PAYLOAD, handshakeTimeout: 15_000 })
        u.socket = ws
        const timeout = setTimeout(() => { reject(new Error('Upstream ready timeout')); ws.terminate() }, 20_000)
        let ready = false
        ws.on('message', (data, binary) => {
          if (u.socket !== ws || binary) return
          let f: Frame
          try { f = JSON.parse(data.toString()) } catch { ws.terminate(); return }
          if (f.method === 'event' && f.params?.type === 'gateway.ready') {
            clearTimeout(timeout); ready = true; u.ready = f; u.attempts = 0
            const epoch = f.params.payload?.replay_epoch
            const changed = u.epoch !== undefined && epoch !== u.epoch
            u.epoch = epoch
            if (u.routes.size) u.recovery = this.recover(u, changed).finally(() => { u.recovery = undefined })
            resolve()
          } else if (f.id !== undefined) {
            const pending = u.pending.get(String(f.id))
            if (pending) { clearTimeout(pending.timer); u.pending.delete(String(f.id)); pending.resolve(f) }
          } else if (f.method === 'event') this.event(u, f)
        })
        let alive = true
        ws.on('pong', () => { alive = true })
        u.ping = setInterval(() => { if (!alive) ws.terminate(); else if (ws.readyState === WebSocket.OPEN) { alive = false; ws.ping() } }, 25_000)
        u.ping.unref()
        ws.on('error', () => { if (!ready) reject(new Error('Upstream connection failed')) })
        ws.on('close', () => {
          clearTimeout(timeout); clearInterval(u.ping)
          if (u.socket !== ws) return
          u.socket = undefined; u.ready = undefined
          if (!ready) reject(new Error('Upstream disconnected'))
          for (const pending of u.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Upstream disconnected; result unknown')) }
          u.pending.clear()
          if (!this.closed && this.upstreams.get(u.principal.upstreamKey) === u) {
            u.retry = setTimeout(() => { u.retry = undefined; void this.connect(u).catch(() => {}) }, Math.min(15_000, 500 * 2 ** Math.min(u.attempts++, 5)))
            u.retry.unref()
          }
        })
      })
    })().finally(() => { u.connecting = undefined })
    return u.connecting
  }
  private rpc(u: Upstream, method: string, params: Frame, observed?: (frame: Frame) => void, sent?: (frame: Frame) => void): Promise<Frame> {
    const id = randomUUID()
    if (u.socket?.readyState !== WebSocket.OPEN || u.socket.bufferedAmount > 8 * 1024 * 1024 || u.pending.size >= 128) throw new Error('Upstream unavailable or congested')
    const frame = { jsonrpc: '2.0', id, method, params }
    sent?.(frame)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { u.pending.delete(id); reject(new Error('Upstream command result unknown')) }, 120_000)
      timer.unref()
      u.pending.set(id, { timer, reject, resolve: response => { observed?.(response); resolve(response) } })
      u.socket!.send(JSON.stringify(frame), error => { if (error) { clearTimeout(timer); u.pending.delete(id); reject(error) } })
    })
  }
  private event(u: Upstream, f: Frame, replay = false): void {
    if (this.closed) return
    if (u.recovering && !replay) {
      if (u.deferred.length >= 512 || Buffer.byteLength(JSON.stringify([...u.deferred, f])) > 1024 * 1024) { u.deferred = []; this.reset(u, 'recovery_overflow') }
      else u.deferred.push(f)
      return
    }
    const p = f.params
    if (!p || typeof p.type !== 'string') return
    const sid = String(p.session_id ?? '')
    const r = u.byRuntime.get(sid)
    this.onActivity({ kind: 'event', name: p.type, sessionId: r?.stored })
    if (sid && !r) {
      const size = Buffer.byteLength(JSON.stringify(f))
      if (u.earlyBytes + size > 1024 * 1024) { u.early.clear(); u.earlyBytes = 0; this.reset(u, 'unmapped_event_overflow'); return }
      const list = u.early.get(sid) ?? []; list.push(f); u.early.set(sid, list); u.earlyBytes += size
      return
    }
    if (r) {
      if (Number.isSafeInteger(p.seq)) {
        if (p.seq <= r.seq) return
        if (r.seq > 0 && p.seq > r.seq + 1) this.reset(u, 'upstream_sequence_gap')
        r.seq = p.seq
      }
      if (p.type === 'session.info' && typeof p.payload?.cwd === 'string') {
        r.cwd = p.payload.cwd
        if (r.cwd !== r.workingDirectory?.resolved) r.workingDirectory = undefined
      }
      if (['message.start', 'approval.request', 'clarify.request'].includes(p.type)) r.active = true
      if (p.type === 'message.complete') r.active = false
      if (p.payload?.request_id) this.interactions.set(`${u.principal.upstreamKey}:${p.payload.request_id}`, sid)
      while (this.interactions.size > 10_000) this.interactions.delete(this.interactions.keys().next().value!)
    }
    if (r) for (const principal of r.observers.values()) {
      if (principal.valid()) {
        principal.observeEvent?.(JSON.stringify(f))
        const owner = this.nativeOwner(principal)
        if (owner) this.onNativeEvent(owner, r.profile, r.stored, p)
      }
    }
    if (!r && p.type === 'sessions.changed') {
      const owners = new Set([...this.channels.values()].flatMap(channel => {
        const owner = this.nativeOwner(channel.principal)
        return owner && channel.principal.valid() ? [owner] : []
      }))
      for (const owner of owners) this.onNativeGlobalEvent(owner, p.type)
    }
    for (const c of this.channels.values()) {
      if (c.kind !== 'chat' || c.principal.upstreamKey !== u.principal.upstreamKey || !c.principal.valid()) continue
      if (r && !c.routes.has(this.routeKey(r.profile, r.stored))) continue
      if (!r && !['profiles.changed', 'sessions.changed', 'models.changed', 'pet.changed'].includes(p.type)) continue
      this.emit(c, 'frame', f)
    }
    if (r && (p.type === 'session.title' || p.type === 'session.title.updated')) {
      const owners = new Set([...r.observers.values()].flatMap(principal => {
        const owner = principal.valid() ? this.nativeOwner(principal) : undefined
        return owner ? [owner] : []
      }))
      for (const owner of owners) this.publishOwnerSessionsChanged(owner)
    }
  }
  publishOwnerSessionsChanged(owner: string, reason = 'session.title', profile?: string, sessionID?: string): void {
    if (this.closed) return
    this.onNativeGlobalEvent(owner, 'sessions.changed')
    const frame = {
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'sessions.changed', payload: { reason, profile, session_id: sessionID } },
    }
    for (const channel of this.channels.values()) {
      if (channel.kind !== 'chat' || !channel.principal.valid()
        || this.nativeOwner(channel.principal) !== owner) continue
      this.emit(channel, 'frame', frame)
    }
  }
  private nativeOwner(principal: RealtimePrincipal): string | undefined {
    const device = /^device:[^:]+(?::agent:[^:]+)?$/.test(principal.key)
    if (device) return principal.key
    const match = /^(?:user|push):([^:]+)/.exec(principal.key)
    return match?.[1]
  }
  private async recover(u: Upstream, changed: boolean): Promise<void> {
    if (u.recovering) return
    u.recovering = true
    try {
      for (const r of u.routes.values()) {
        const lastSeen = r.seq
        const resumed = await this.rpc(u, 'session.resume', { session_id: r.stored, profile: r.profile, close_on_disconnect: false, omit_messages: true })
        r.workingDirectory = undefined
        r.cwd = typeof resumed.result?.info?.cwd === 'string' ? resumed.result.info.cwd : undefined
        if (typeof resumed.result?.running === 'boolean') r.active = resumed.result.running
        if (!resumed.result || resumed.result.session_id !== r.runtime || changed) {
          if (resumed.result?.session_id) { u.byRuntime.delete(r.runtime); r.runtime = resumed.result.session_id; u.byRuntime.set(r.runtime, r) }
          r.seq = 0; this.reset(u, 'upstream_reset'); continue
        }
        const replay = await this.rpc(u, 'session.events.since', { session_id: r.runtime, last_seen: lastSeen })
        if (replay.error || replay.result?.truncated || replay.result?.epoch !== u.epoch) this.reset(u, 'upstream_replay_unavailable')
        else for (const p of replay.result?.events ?? []) this.event(u, { jsonrpc: '2.0', method: 'event', params: p }, true)
      }
    } catch { this.reset(u, 'upstream_recovery_failed') }
    finally {
      u.recovering = false
      const deferred = u.deferred; u.deferred = []
      for (const frame of deferred) this.event(u, frame)
    }
  }
  private reset(u: Upstream, reason: string): void {
    this.onActivity({ kind: 'reset', name: reason })
    for (const route of u.routes.values()) {
      for (const principal of route.observers.values()) {
        const owner = this.nativeOwner(principal)
        if (owner && principal.valid()) {
          this.onNativeEvent(owner, route.profile, route.stored, {
            type: 'gateway.reset', payload: { reason }, seq: route.seq,
          })
        }
      }
    }
    for (const c of this.channels.values()) if (c.kind === 'chat' && c.principal.upstreamKey === u.principal.upstreamKey) this.emit(c, 'reset', { reason })
  }
  publishServerIdentity(identity: import('../shared/serverIdentity.js').ServerIdentity, instanceKey: string): void {
    for (const channel of this.channels.values()) {
      if (channel.principal.valid() && channel.principal.instanceKey === instanceKey) {
        this.emit(channel, 'frame', { jsonrpc: '2.0', method: 'event', params: { type: 'server.identity.changed', payload: identity } })
      }
    }
  }
  private emit(c: RealtimeChannel, event: StreamEntry['event'], value: Frame): void {
    const publicValue = this.withoutProtectedSessions(value)
    if (!publicValue) return
    const data = JSON.stringify(publicValue)
    const entry: StreamEntry = { id: `${this.epoch}:${++c.seq}`, event, data, at: this.now(), bytes: Buffer.byteLength(data) }
    c.entries.push(entry); c.bytes += entry.bytes
    this.trim(c)
    for (const listener of [...c.listeners]) {
      try { listener(entry) } catch { c.listeners.delete(listener) }
    }
  }
  private withoutProtectedSessions(value: any): any {
    if (Array.isArray(value)) return value.map(v => this.withoutProtectedSessions(v)).filter(v => v !== undefined)
    if (!value || typeof value !== 'object') return value
    if (value.source === 'yaoyao_workspace' || ['id','session_id','sessionId','stored_session_id','session_key'].some(k => typeof value[k] === 'string' && this.protectedSession(value[k]))) return undefined
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,this.withoutProtectedSessions(v)]).filter(([,v]) => v !== undefined))
  }
  private trim(c: RealtimeChannel): void {
    const own = [...this.channels.values()].filter(v => v.principal.key === c.principal.key)
    while (own.reduce((n, v) => n + v.bytes, 0) > 8 * 1024 * 1024 || own.reduce((n, v) => n + v.entries.length, 0) > 10_000) {
      const oldest = own.filter(v => v.entries.length).sort((a, b) => a.entries[0]!.at - b.entries[0]!.at)[0]
      if (!oldest) break
      this.evict(oldest)
    }
    while (c.entries[0] && c.entries[0].at < this.now() - 600_000) this.evict(c)
    while ([...this.channels.values()].reduce((n, v) => n + v.bytes, 0) > 128 * 1024 * 1024) {
      const oldest = [...this.channels.values()].filter(v => v.entries.length).sort((a, b) => a.entries[0]!.at - b.entries[0]!.at)[0]
      if (!oldest) break
      this.evict(oldest)
    }
  }
  private evict(c: RealtimeChannel): void {
    const entry = c.entries.shift()!
    c.bytes -= entry.bytes; c.droppedThrough = Number(entry.id.split(':').at(-1))
  }
  private sweep(): void {
    for (const [key, item] of this.completed) if (item.at < this.now() - 600_000) this.completed.delete(key)
    for (const c of this.channels.values()) {
      if (!c.principal.valid() || (!c.listeners.size && this.now() - c.touched > 600_000)) this.remove(c)
      else this.trim(c)
    }
    for (const [key, u] of this.upstreams) {
      if (u.pending.size || u.tails.size || [...u.routes.values()].some(r => r.active)) { u.lastUsed = this.now(); continue }
      if ([...this.channels.values()].some(c => c.principal.upstreamKey === key)) { u.lastUsed = this.now(); continue }
      if (this.now() - u.lastUsed > 300_000) {
        this.upstreams.delete(key); clearTimeout(u.retry); clearInterval(u.ping); u.socket?.close()
        for (const [route, owner] of this.routeOwners) if (owner === key) this.routeOwners.delete(route)
      }
    }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer)
    for (const c of [...this.channels.values()]) this.remove(c)
    for (const u of this.upstreams.values()) {
      clearTimeout(u.retry); clearInterval(u.ping)
      for (const p of u.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Broker stopped')) }
      u.pending.clear(); u.socket?.terminate()
    }
    // Pending command continuations may still update their receipts in the next microtask.
    void Promise.allSettled(this.commands.values()).then(() => this.receipts.close())
  }
}
