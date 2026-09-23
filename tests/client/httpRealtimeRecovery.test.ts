import { afterEach, expect, it, vi } from 'vitest'
import { HTTPRealtimeChannel } from '@/api/httpRealtime'
const api = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), apiRequest: api.request }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); api.request.mockReset() })

it('times out response headers on every reconnect and preserves the received cursor', async () => {
  vi.useFakeTimers()
  api.request.mockResolvedValue({ id: 'channel' })
  let firstStream!: ReadableStreamDefaultController<Uint8Array>
  const attempts: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => {
    attempts.push(options)
    if (attempts.length > 1) return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('headers timed out')), { once: true })
    })
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) {
      firstStream = controller
      controller.enqueue(new TextEncoder().encode('id: epoch:9\nevent: frame\ndata: {"params":{"type":"gateway.ready"}}\n\n'))
    } }), { headers: { 'content-type': 'text/event-stream' } }))
  }))
  const failed = vi.fn(), channel = new HTTPRealtimeChannel(async () => {}, failed)
  try {
    await channel.open('chat')
    firstStream.error(new Error('connection lost'))
    await vi.advanceTimersByTimeAsync(500)
    expect(attempts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(attempts[1].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts).toHaveLength(3)
    expect(attempts[2].headers).toMatchObject({ 'Last-Event-ID': 'epoch:9' })
    expect(failed).not.toHaveBeenCalled()
  } finally {
    channel.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toHaveLength(3)
  }
})
