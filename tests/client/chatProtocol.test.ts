import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatRpcSocket, GroupEventSocket } from '@/api/realtime'
import { setApiCsrfToken } from '@/api/client'

beforeEach(() => { setApiCsrfToken('csrf-test'); vi.stubGlobal('WebSocket', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function httpFixture() {
  let kind = 'chat', epoch = '', cursor = 0
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const send = (frame: object) => stream!.enqueue(new TextEncoder().encode('event: frame\ndata: ' + JSON.stringify(frame) + '\n\n'))
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/capabilities')) return Response.json({ protocolVersion: 1, csrfToken: 'csrf-test', features:['ordinary-chat-transcript-v2'] })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (path.endsWith('/channels')) {
      const body = JSON.parse(String(init?.body)); kind = body.channel; epoch = body.epoch; cursor = body.cursor
      return Response.json({ id: 'channel-1' }, { status: 201 })
    }
    if (path.endsWith('/events')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller
        send(kind === 'chat'
          ? { method: 'event', params: { type: 'gateway.ready', payload: {} } }
          : { type: 'group.ready', epoch, cursor, heartbeatSeconds: 20 })
        init?.signal?.addEventListener('abort', () => { try { controller.close() } catch {} }, { once: true })
      } })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json({ state: 'confirmed', response: { result: { total_tokens: 42 } } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, send }
}

describe('HTTP-only realtime protocols', () => {
  it('waits for SSE ready and submits commands through HTTP without opening a WS', async () => {
    const f = httpFixture(), socket = new ChatRpcSocket(), events: string[] = []
    socket.onEvent(event => events.push(event.type))
    await socket.connect()
    expect(socket.state).toBe('ready')
    const result = await socket.request('session.usage', { session_id: 'runtime-1' }, 5000, 'stable-command')
    expect(result).toEqual({ total_tokens: 42 })
    const sent = f.fetchMock.mock.calls.find(([path]) => String(path).endsWith('/commands'))![1]!
    expect(new Headers(sent.headers).get('Idempotency-Key')).toBe('stable-command')
    expect(JSON.parse(String(sent.body))).toMatchObject({ method: 'session.usage', params: { session_id: 'runtime-1' } })
    expect(events).toEqual(['gateway.ready'])
    expect(WebSocket).not.toHaveBeenCalled()
    socket.close()
  })
  it('preserves the group epoch/cursor on the HTTP channel', async () => {
    const f = httpFixture(), socket = new GroupEventSocket()
    await socket.connect({ epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cursor: 12, onEnvelope: () => {}, onReset: () => {} })
    const sent = f.fetchMock.mock.calls.find(([path]) => String(path).endsWith('/channels'))![1]!
    expect(JSON.parse(String(sent.body))).toEqual({ channel: 'groups', epoch: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cursor: 12 })
    expect(WebSocket).not.toHaveBeenCalled()
    socket.close()
  })
  it.each([401, 404, 405, 410])('does not downgrade after HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unsupported or unauthorized' }, { status })))
    const socket = new ChatRpcSocket()
    await expect(socket.connect()).rejects.toThrow()
    expect(WebSocket).not.toHaveBeenCalled()
    socket.close()
  })
})
