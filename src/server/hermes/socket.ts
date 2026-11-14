import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../errors.js'
import type { EmbeddedGateway, GatewayChannel } from './gateway.js'

const OPEN = 1, CLOSED = 3
/** One replay epoch per server process: a restart forces clients to resynchronise from transcripts. */
const EPOCH = randomUUID()

/**
 * WebSocket-shaped adapter over the in-process gateway, so the realtime broker keeps its JSON-RPC
 * framing (`{id, method, params}` → `{id, result|error}`, events as `{method: 'event', params}`)
 * without a network hop. Only the subset of `ws` the broker uses is implemented.
 */
export class EmbeddedSocket extends EventEmitter {
  static readonly OPEN = OPEN
  readyState = OPEN
  readonly bufferedAmount = 0
  private readonly channel: GatewayChannel

  constructor(gateway: EmbeddedGateway) {
    super()
    this.channel = gateway.open(frame => {
      if (this.readyState !== OPEN) return
      const params = frame.type === 'gateway.ready' ? { ...frame, payload: { ...(frame.payload ?? {}), replay_epoch: EPOCH } } : frame
      this.deliver({ jsonrpc: '2.0', method: 'event', params })
    }, () => this.terminate())
  }

  private deliver(value: unknown) {
    const data = Buffer.from(JSON.stringify(value))
    queueMicrotask(() => { if (this.readyState === OPEN) this.emit('message', data, false) })
  }

  send(data: string, callback?: (error?: Error) => void): void {
    if (this.readyState !== OPEN) { callback?.(new Error('socket closed')); return }
    let frame: { id?: unknown; method?: unknown; params?: unknown }
    try { frame = JSON.parse(data) } catch { callback?.(new Error('invalid frame')); return }
    callback?.()
    if (typeof frame.method !== 'string') return
    const id = frame.id
    void this.channel.rpc(frame.method, (frame.params ?? {}) as Record<string, unknown>).then(
      result => { if (id !== undefined) this.deliver({ jsonrpc: '2.0', id, result }) },
      error => {
        if (id === undefined) return
        const code = error instanceof HttpError && error.status === 404 ? 'session_not_found' : -32000
        this.deliver({ jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : 'Hermes 请求失败' } })
      },
    )
  }

  ping(): void { queueMicrotask(() => { if (this.readyState === OPEN) this.emit('pong') }) }

  terminate(): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.channel.close()
    queueMicrotask(() => this.emit('close'))
  }

  close(): void { this.terminate() }
}
