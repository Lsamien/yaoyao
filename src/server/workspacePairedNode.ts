import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'
import { SSEParser } from '../shared/sse.js'

export interface WorkspacePairCode { url: URL; nodeId: string; fingerprint: string; pairingId: string; secret: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function nodeServiceURL(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new HttpError(400, '节点地址无效', 'invalid_node') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new HttpError(400, '请填写子节点的 Web 地址', 'invalid_node')
  return url
}
export function parseWorkspacePairCode(payload: string): WorkspacePairCode {
  let code: URL
  try { code = new URL(payload) } catch { throw new HttpError(400, '无效的子节点二维码', 'invalid_pairing') }
  const fields = [...code.searchParams.keys()]
  if (code.protocol !== 'yaoyao:' || code.hostname !== 'pair' || code.searchParams.get('v') !== '1' || new Set(fields).size !== fields.length)
    throw new HttpError(400, '请扫描子节点配对二维码，不能使用服务器登录二维码', 'invalid_pairing')
  const nodeId = code.searchParams.get('node') ?? '', pairingId = code.searchParams.get('id') ?? '',
    fingerprint = code.searchParams.get('fingerprint') ?? '', secret = code.searchParams.get('secret') ?? ''
  if (!uuid.test(nodeId) || !uuid.test(pairingId) || fingerprint.length < 32 || fingerprint.length > 512 || secret.length < 32 || secret.length > 512)
    throw new HttpError(400, '子节点二维码信息不完整', 'invalid_pairing')
  return { url: nodeServiceURL(code.searchParams.get('url') ?? ''), nodeId, pairingId, fingerprint, secret }
}
export async function nodeJSON(fetchImpl: typeof fetch, url: URL, options: RequestInit = {}): Promise<any> {
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000) })
  if (!response.ok) throw new HttpError(502, '子节点请求失败，请检查地址、二维码或授权状态', 'node_unavailable')
  return response.status === 204 ? {} : response.json()
}
export async function verifyNode(fetchImpl: typeof fetch, url: URL, nodeId: string, fingerprint: string): Promise<any> {
  const capability = await nodeJSON(fetchImpl, new URL('api/pair/v1/capabilities', url))
  if (capability.protocolVersion !== 1 || capability.serviceType !== 'yaoyao-web' || capability.nodeId !== nodeId || capability.fingerprint !== fingerprint)
    throw new HttpError(409, '子节点身份不匹配，请确认 IP 指向原来的 15300 Web 服务', 'node_identity_mismatch')
  return capability
}

/** Delegated child-node transport. No browser cookie, login, or direct 9119 connection. */
export class WorkspacePairedChannel {
  private channel = ''
  private stopped = false
  private abort?: AbortController
  private cursor = ''
  constructor(private base: URL, private token: string, private fetchImpl: typeof fetch,
    private onEvent: (frame: any) => void, private onDisconnect: () => void) {}
  private url(path: string): URL { return new URL(`${this.base.href.replace(/\/$/, '')}/api/realtime/${path}`) }
  private headers(extra: Record<string, string> = {}) { return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...extra } }
  async connect(): Promise<void> {
    const created = await nodeJSON(this.fetchImpl, this.url('channels'), { method: 'POST', headers: this.headers(), body: JSON.stringify({ channel: 'chat' }) })
    if (!uuid.test(created.id)) throw new Error('Invalid child channel')
    this.channel = created.id
    if (this.stopped) { this.close(); throw new Error('Child channel closed') }
    await new Promise<void>((resolve, reject) => {
      let ready = false
      const timer = setTimeout(() => { this.close(); reject(new Error('子节点事件握手超时')) }, 20_000)
      void this.read(() => { ready = true; clearTimeout(timer); resolve() }).catch(error => {
        clearTimeout(timer)
        if (!ready) reject(error)
        if (!this.stopped) this.onDisconnect()
      })
    })
  }
  private async read(onReady: () => void): Promise<void> {
    let failures = 0
    while (!this.stopped) {
      this.abort = new AbortController()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let watchdog: ReturnType<typeof setTimeout> | undefined
      try {
        const response = await this.fetchImpl(this.url(`channels/${this.channel}/events`), {
          headers: this.headers({ Accept: 'text/event-stream', ...(this.cursor ? { 'Last-Event-ID': this.cursor } : {}) }),
          redirect: 'error', signal: this.abort.signal,
        })
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream'))
          throw new HttpError(502, '子节点事件流不可用', 'node_stream_unavailable')
        reader = response.body.getReader()
        const parser = new SSEParser(), decoder = new TextDecoder()
        while (!this.stopped) {
          clearTimeout(watchdog)
          watchdog = setTimeout(() => this.abort?.abort(), 45_000)
          const part = await reader.read()
          if (part.done) throw new Error('Child stream disconnected')
          failures = 0
          for (const entry of parser.feed(decoder.decode(part.value, { stream: true }))) {
            if (entry.event === 'reset') throw new HttpError(409, '子节点事件需要重新同步', 'node_stream_reset')
            if (entry.event !== 'frame' || (entry.id && entry.id === this.cursor)) continue
            const frame = JSON.parse(entry.data)
            if (frame.method === 'event' && frame.params) {
              this.onEvent(frame.params)
              if (frame.params.type === 'gateway.ready') onReady()
            }
            if (entry.id) this.cursor = entry.id
          }
        }
      } catch (error) {
        if (this.stopped) return
        if (error instanceof HttpError || ++failures >= 3) throw error
      } finally { clearTimeout(watchdog); await reader?.cancel().catch(() => {}); reader?.releaseLock() }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  async rpc(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.channel || this.stopped) throw new Error('Child channel unavailable')
    const id = randomUUID()
    let receipt: any
    try {
      receipt = await nodeJSON(this.fetchImpl, this.url(`channels/${this.channel}/commands`), {
        method: 'POST', headers: this.headers({ 'Idempotency-Key': id }), body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      })
    } catch {
      receipt = await nodeJSON(this.fetchImpl, this.url(`commands/${id}`), { headers: this.headers() })
    }
    if (receipt.response?.error) throw new HttpError(502, receipt.response.error.message || '子节点拒绝请求', 'gateway_rejected')
    if (receipt.state !== 'confirmed') throw new HttpError(502, '子节点提交结果尚未确认', 'node_submission_uncertain')
    return receipt.response?.result
  }
  close(): void {
    this.stopped = true
    this.abort?.abort()
    if (this.channel) {
      const id = this.channel; this.channel = ''
      void nodeJSON(this.fetchImpl, this.url(`channels/${id}`), { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5_000) }).catch(() => {})
    }
  }
}
