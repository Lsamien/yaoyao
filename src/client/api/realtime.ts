import { publishServerIdentity } from './serverIdentity'
import type { GroupSocketEnvelope, JsonValue, RealtimeConnectionState, RpcEventFrame } from '@shared/types'
import { ApiError } from './client'
import { number, record, string } from '@/utils/normalize'
import { HTTPRealtimeChannel, HTTPRPCError } from './httpRealtime'
import { CHAT_TRANSCRIPT_FEATURE } from '@shared/chatTranscript'

export class RpcError extends Error {
  constructor(message: string, readonly code?: number | string, readonly data?: JsonValue) {
    super(message); this.name = 'RpcError'
  }
}

type StateListener = (state: RealtimeConnectionState, reason?: string) => void
type RpcEventListener = (event: RpcEventFrame['params']) => void

/** Historical facade name retained for store injection; transport is HTTP+SSE only. */
export class ChatRpcSocket {
  private http?: HTTPRealtimeChannel
  private generation = 0
  private openingRequests = 0
  private earlyFrames: string[] = []
  private eventListeners = new Set<RpcEventListener>()
  private stateListeners = new Set<StateListener>()
  state: RealtimeConnectionState = 'idle'
  transcriptSupported = false

  onEvent(listener: RpcEventListener): () => void { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener) }
  onState(listener: StateListener): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener) }
  async connect(): Promise<void> {
    this.close()
    const generation = ++this.generation
    this.publishState('connecting')
    this.transcriptSupported = (await HTTPRealtimeChannel.requireSupport()).includes(CHAT_TRANSCRIPT_FEATURE)
    if(!this.transcriptSupported)throw new ApiError('普通聊天需要新版服务端，请先升级服务端',426,'ordinary_chat_upgrade_required')
    if (generation !== this.generation) return
    this.http = new HTTPRealtimeChannel(frame => this.handleMessage(frame, generation), error => {
      if (generation === this.generation) this.publishState('failed', error.message)
    })
    await this.http.open('chat')
  }
  close(): void {
    this.generation++; this.http?.close(); this.http = undefined
    this.earlyFrames = []; this.openingRequests = 0
    this.publishState('disconnected')
  }
  async request(method: string, params: Record<string, JsonValue> = {}, timeoutMs = 120_000, requestId?: string): Promise<JsonValue> {
    if (!this.http) throw new ApiError('HTTP 事件通道尚未就绪', 0, 'REALTIME_NOT_READY')
    const generation = this.generation
    const opening = ['session.create', 'session.resume', 'session.branch'].includes(method)
    if (opening) this.openingRequests++
    try { return await this.http.request(method, params, timeoutMs, requestId) }
    catch (error) { if (error instanceof HTTPRPCError) throw new RpcError(error.message, error.code, error.data); throw error }
    finally {
      if (opening && generation === this.generation) {
        this.openingRequests--
        window.setTimeout(() => {
          if (generation !== this.generation || this.openingRequests) return
          const frames = this.earlyFrames; this.earlyFrames = []
          for (const frame of frames) void this.handleMessage(frame, generation)
        }, 0)
      }
    }
  }
  private async handleMessage(text: string, generation: number): Promise<void> {
    if (generation !== this.generation) return
    const frame = record(JSON.parse(text))
    if (frame.method !== 'event') return
    const params = record(frame.params), type = string(params.type)
    if (!type) return
    if (this.openingRequests && type !== 'gateway.ready') {
      if (this.earlyFrames.length >= 512) { this.earlyFrames = []; this.publishState('failed', '事件缓存已满，需要重新同步') }
      else this.earlyFrames.push(text)
      return
    }
    if (type === 'server.identity.changed') publishServerIdentity(params.payload)
    if (type === 'gateway.ready') this.publishState('ready')
    const event: RpcEventFrame['params'] = {
      type, session_id: string(params.session_id) || undefined,
      profile: string(params.profile) || undefined, payload: (params.payload ?? null) as JsonValue,
    }
    for (const listener of this.eventListeners) listener(event)
  }
  private publishState(state: RealtimeConnectionState, reason?: string): void {
    this.state = state
    for (const listener of this.stateListeners) listener(state, reason)
  }
}

export interface GroupEventSocketOptions {
  epoch: string
  cursor: number
  onEnvelope(envelope: GroupSocketEnvelope): void
  onState?(state: RealtimeConnectionState, reason?: string): void
  onReset(reason: string): void
}

export class GroupEventSocket {
  private http?: HTTPRealtimeChannel
  private generation = 0
  private epoch = ''
  private cursor = 0
  state: RealtimeConnectionState = 'idle'
  async connect(options: GroupEventSocketOptions): Promise<void> {
    this.close()
    this.epoch = options.epoch; this.cursor = options.cursor
    const generation = ++this.generation
    this.publish(options, 'connecting')
    await HTTPRealtimeChannel.requireSupport()
    if (generation !== this.generation) return
    this.http = new HTTPRealtimeChannel(frame => this.handleMessage(frame, generation, options), error => {
      if (generation === this.generation) this.needsReset(options, error.message)
    })
    await this.http.open('groups', { epoch: this.epoch, cursor: this.cursor })
  }
  close(): void {
    this.generation++; this.http?.close(); this.http = undefined
    this.state = 'disconnected'
  }
  private async handleMessage(data: unknown, generation: number, options: GroupEventSocketOptions): Promise<void> {
    if (generation !== this.generation) return
    let text: string
    if (typeof data === 'string') text = data
    else if (data instanceof Blob) text = await data.text()
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data)
    else return
    let decoded: unknown
    try { decoded = JSON.parse(text) } catch {
      this.needsReset(options, 'malformed_frame')
      return
    }
    const source = record(decoded)
    const envelope: GroupSocketEnvelope = {
      type: string(source.type) as GroupSocketEnvelope['type'],
      epoch: string(source.epoch) || undefined,
      cursor: source.cursor == null ? undefined : number(source.cursor, -1),
      heartbeatSeconds: source.heartbeatSeconds == null && source.heartbeat_seconds == null ? undefined : number(source.heartbeatSeconds ?? source.heartbeat_seconds),
      roomId: string(source.roomId ?? source.room_id) || undefined,
      event: string(source.event) || undefined,
      payload: (source.payload ?? null) as JsonValue,
      reason: string(source.reason) || undefined,
    }
    if (!['group.ready', 'group.event', 'group.heartbeat', 'group.reset_required'].includes(envelope.type)) {
      this.needsReset(options, 'unknown_envelope')
      return
    }
    if (envelope.epoch && envelope.epoch !== this.epoch) {
      this.needsReset(options, 'epoch_mismatch')
      return
    }
    if (envelope.type === 'group.ready') {
      if (envelope.cursor !== this.cursor) return this.needsReset(options, 'ready_cursor_mismatch')
      this.publish(options, 'ready')
      options.onEnvelope(envelope)
      return
    }
    if (envelope.type === 'group.event') {
      if (envelope.cursor == null || envelope.cursor < 0) return this.needsReset(options, 'invalid_cursor')
      if (envelope.cursor <= this.cursor) return
      if (envelope.cursor !== this.cursor + 1) return this.needsReset(options, 'cursor_gap')
      this.cursor = envelope.cursor
      options.onEnvelope(envelope)
      return
    }
    if (envelope.type === 'group.reset_required') {
      this.needsReset(options, envelope.reason || 'server_reset')
      return
    }
    if (envelope.cursor != null && envelope.cursor !== this.cursor) this.needsReset(options, 'heartbeat_cursor_mismatch')
  }

  private needsReset(options: GroupEventSocketOptions, reason: string): void {
    this.http?.close(); this.http = undefined
    this.publish(options, 'needs-reset', reason)
    options.onReset(reason)
  }

  private publish(options: GroupEventSocketOptions, state: RealtimeConnectionState, reason?: string): void {
    this.state = state
    options.onState?.(state, reason)
  }
}
