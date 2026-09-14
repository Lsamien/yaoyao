import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/ordinary-chat-v2/protocol.json'
import { ChatTranscriptClient } from '@/api/chatTranscript'
import type { TranscriptSnapshot } from '@shared/chatTranscript'
const api = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/api/client', () => ({ apiRequest: api.request }))
describe('ordinary v2 durable Web replica', () => {
  beforeEach(() => {
    api.request.mockReset()
  })
  function setup() {
    const changed = vi.fn().mockResolvedValue(undefined),
      client = new ChatTranscriptClient('p', 's', changed, vi.fn()) as any
    client.restore(structuredClone(fixture.snapshot))
    return { client, changed }
  }
  it('converges on the common fixture and does not resurrect a deletion from a delayed page', async () => {
    const { client, changed } = setup()
    let release!: (value: unknown) => void
    api.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const older = client.loadOlder()
    for (const event of fixture.events) await client.receive(event)
    release(fixture.stalePage)
    await older
    expect(changed.mock.lastCall![0]).toMatchObject({
      cursor: 4,
      messages: fixture.expectedMessages,
      deletedIds: ['old-preview'],
    })
  })
  it('does not advance messages or cursor when persistence fails, and can retry exactly once', async () => {
    const { client, changed } = setup()
    changed.mockRejectedValueOnce(new Error('disk full'))
    await expect(client.receive(fixture.events[0])).rejects.toThrow('disk full')
    expect(client.snapshot).toEqual(fixture.snapshot)
    await client.receive(fixture.events[0])
    await client.receive(fixture.events[0])
    expect(client.snapshot.messages[0].content).toBe('前半段后半段')
    expect(client.snapshot.cursor).toBe(2)
  })
  it('rejects gaps and old generations without corrupting its checkpoint', async () => {
    const { client } = setup()
    await expect(client.receive(fixture.events[2])).rejects.toThrow('版本不连续')
    await expect(client.receive({ ...fixture.events[0], epoch: 'old' })).rejects.toThrow('版本不连续')
    expect(client.snapshot).toEqual(fixture.snapshot)
  })
  it('discards v1 checkpoints rather than merging them into v2', () => {
    const client = new ChatTranscriptClient(
      'p',
      's',
      async () => {},
      () => {},
    ) as any
    client.restore({
      ...fixture.snapshot,
      protocol: 'ordinary-chat-transcript-v1',
    } as unknown as TranscriptSnapshot)
    expect(client.snapshot).toBeUndefined()
  })
  it('reopens an inactive event connection without dropping the durable cursor', async () => {
    vi.useFakeTimers()
    const { client } = setup()
    const fetchMock = vi.fn(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('inactive stream')), {
            once: true,
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const running = client.run()
    try {
      await vi.advanceTimersByTimeAsync(46_000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(client.snapshot.cursor).toBe(1)
      expect(fetchMock.mock.calls[1]![1].headers).toMatchObject({ 'Last-Event-ID': 'fixture-epoch:1' })
    } finally {
      client.close()
      await running
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
  it('restores running state and interactions before resuming the saved event cursor', async () => {
    const { client, changed } = setup()
    const saved = { ...fixture.snapshot, running: true, liveStatus: '正在思考', pendingApproval: { id: 'approval' } }
    client.restore(saved)
    const fetchMock = vi.fn((_url: unknown, options: RequestInit) => {
      expect(changed).toHaveBeenCalledWith(saved)
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('closed')), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const running = client.run()
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(api.request).not.toHaveBeenCalled()
      expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ 'Last-Event-ID': 'fixture-epoch:1' })
    } finally {
      client.close()
      await running
      vi.unstubAllGlobals()
    }
  })
})
