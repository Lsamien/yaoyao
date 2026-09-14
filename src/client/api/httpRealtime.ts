import type { JsonValue } from '@shared/types'
import { SSEParser } from '@shared/sse'
import { apiRequest, ApiError, setApiCsrfToken } from './client'
import { createId } from '@/utils/id'
import { CHAT_TRANSCRIPT_FEATURE } from '@shared/chatTranscript'

export class HTTPRPCError extends Error {
  constructor(message: string, readonly code?: string | number, readonly data?: JsonValue) { super(message) }
}

export class HTTPRealtimeChannel {
  private id = ''
  private cursor = ''
  private stopped = false
  private abort?: AbortController
  private ready = false
  constructor(readonly onFrame: (frame: string) => Promise<unknown>, readonly onFailure: (error: Error) => void) {}
  static async requireSupport(): Promise<string[]> {
    let value: { protocolVersion: number; csrfToken?: string; features?: string[] }
    try { value = await apiRequest('/api/realtime/capabilities') }
    catch (e) {
      if (e instanceof ApiError && [404, 405, 410].includes(e.status)) throw new ApiError('此服务端不支持 HTTP+SSE，请升级 15300 服务', 409, 'HTTP_SSE_REQUIRED')
      throw e
    }
    if (value.protocolVersion !== 1) throw new ApiError('不支持的实时协议版本', 409, 'UNSUPPORTED_REALTIME_PROTOCOL')
    if (value.csrfToken) setApiCsrfToken(value.csrfToken)
    return value.features ?? []
  }
  async open(channel: 'chat' | 'groups', anchor?: { epoch: string; cursor: number }): Promise<void> {
    const created = await apiRequest<{ id: string }>('/api/realtime/channels', { method: 'POST', body: { channel, ...(channel==='chat'?{chatProtocol:CHAT_TRANSCRIPT_FEATURE}:{}), ...anchor } })
    this.id = created.id
    if (this.stopped) { this.close(); return }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.abort?.abort(); reject(new ApiError('实时事件握手超时', 0, 'REALTIME_READY_TIMEOUT')) }, 20_000)
      void this.readLoop(() => { window.clearTimeout(timer); this.ready = true; resolve() }).catch(error => {
        window.clearTimeout(timer)
        if (!this.ready) reject(error)
        if (!this.stopped) this.onFailure(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }
  private async readLoop(onReady: () => void): Promise<void> {
    let attempt = 0
    while (!this.stopped) {
      this.abort = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let watchdog: number | undefined
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' }
        if (this.cursor) headers['Last-Event-ID'] = this.cursor
        const response = await fetch(`/api/realtime/channels/${this.id}/events`, { credentials: 'same-origin', headers, signal: this.abort.signal, cache: 'no-store' })
        if ([401, 403, 404, 409, 428].includes(response.status)) throw new ApiError('实时连接需要重新同步', response.status, 'REALTIME_RESET_REQUIRED')
        if (!response.ok) throw new Error(`SSE HTTP ${response.status}`)
        if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new ApiError('无效的事件流响应', 502, 'INVALID_EVENT_STREAM')
        reader = response.body.getReader()
        const parser = new SSEParser(), decoder = new TextDecoder()
        while (!this.stopped) {
          window.clearTimeout(watchdog)
          watchdog = window.setTimeout(() => this.abort?.abort(), 45_000)
          const { value, done } = await reader.read()
          if (done) throw new Error('SSE disconnected')
          attempt = 0
          for (const entry of parser.feed(decoder.decode(value, { stream: true }))) {
            if (entry.event === 'reset') throw new ApiError('事件需要重新同步', 409, 'REALTIME_RESET_REQUIRED')
            if (entry.event === 'ready') continue
            if (entry.event !== 'frame') continue
            if (entry.id && entry.id === this.cursor) continue
            await this.onFrame(entry.data)
            if (entry.id) this.cursor = entry.id
            const frame = JSON.parse(entry.data)
            if (frame.type === 'group.ready' || frame.params?.type === 'gateway.ready') onReady()
          }
        }
      } catch (error) {
        if (this.stopped) return
        if (error instanceof ApiError) throw error
      } finally { window.clearTimeout(watchdog); await reader?.cancel().catch(() => {}); reader?.releaseLock() }
      await new Promise(r => window.setTimeout(r, Math.min(15_000, 500 * 2 ** Math.min(attempt++, 5))))
    }
  }
  async request(method: string, params: Record<string, JsonValue>, timeoutMs: number, requestId = createId('http-rpc')): Promise<JsonValue> {
    if (!this.ready || this.stopped) throw new ApiError('事件通道尚未就绪', 0, 'REALTIME_NOT_READY')
    type Receipt = { state: string; response?: { result?: JsonValue; error?: { message?: string; code?: string | number; data?: JsonValue } } }
    let receipt: Receipt
    try {
      receipt = await apiRequest(`/api/realtime/channels/${this.id}/commands`, {
        method: 'POST', headers: { 'Idempotency-Key': requestId }, body: { jsonrpc: '2.0', method, params }, timeoutMs,
      })
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error
      try { receipt = await apiRequest(`/api/realtime/commands/${encodeURIComponent(requestId)}`) }
      catch { throw new ApiError('提交结果未知，请同步历史确认', 0, 'SUBMISSION_UNCERTAIN') }
    }
    if (receipt.state === 'unknown' || receipt.state === 'pending') throw new ApiError('提交结果未知，请同步历史确认', 0, 'SUBMISSION_UNCERTAIN')
    if (receipt.response?.error) throw new HTTPRPCError(receipt.response.error.message ?? '上游拒绝请求', receipt.response.error.code, receipt.response.error.data)
    if (receipt.state !== 'confirmed') throw new ApiError('无效的命令回执', 502, 'INVALID_RECEIPT')
    return receipt.response?.result ?? null
  }
  close(): void {
    this.stopped = true; this.abort?.abort()
    if (this.id) { const id = this.id; this.id = ''; void apiRequest(`/api/realtime/channels/${id}`, { method: 'DELETE' }).catch(() => {}) }
  }
}
