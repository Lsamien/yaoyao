import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { apiRequest } from '@/api/client'
import { useUnreadStore } from '@/stores/unread'
import { emptyUnread, type UnreadSnapshot } from '@shared/unread'

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }))

const unread = useUnreadStore()
function snapshot(ids: string[]): UnreadSnapshot {
  return { total: ids.length, bot: ids.length, chat: 0, conversations: ids.length ? [{
    mode: 'bot', id: 'c', name: '研发助手', preview: '回复', count: ids.length, updatedAt: 1,
    messages: ids.map((id, seq) => ({ id, seq, version: 1 })),
  }] : [] }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => { vi.useFakeTimers(); unread.reset(); vi.mocked(apiRequest).mockReset() })
afterEach(() => { unread.reset(); vi.restoreAllMocks(); vi.useRealTimers() })

it('updates the badge from the read acknowledgement without waiting for another GET', async () => {
  const initial = snapshot(['first', 'second'])
  vi.mocked(apiRequest).mockResolvedValueOnce(initial)
  unread.start('owner'); await flushPromises()
  vi.mocked(apiRequest).mockImplementation(async path => {
    if (path === '/api/app/unread/read') return snapshot(['second']) as never
    throw new Error('后续同步暂不可用')
  })
  await unread.visible('bot', 'c', undefined, ['first'])
  expect(unread.total).toBe(1)
  expect(unread.snapshot.conversations[0]?.messages.map(message => message.id)).toEqual(['second'])
  expect(apiRequest).toHaveBeenLastCalledWith('/api/app/unread/read', expect.objectContaining({
    body: { items: [{ mode: 'bot', id: 'c', messages: [{ id: 'first', seq: 0, version: 1 }] }] },
  }))
  await unread.visible('bot', 'c', undefined, ['first'])
  expect(apiRequest).toHaveBeenCalledTimes(2)
})

it('does not let a poll started before reading restore already-read messages', async () => {
  const initial = snapshot(['first', 'second']), poll = deferred<UnreadSnapshot>()
  vi.mocked(apiRequest).mockResolvedValueOnce(initial)
  unread.start('owner'); await flushPromises()
  vi.mocked(apiRequest).mockImplementation(path => path === '/api/app/unread'
    ? poll.promise as never : Promise.resolve(snapshot(['second'])) as never)
  const polling = unread.refresh()
  await unread.visible('bot', 'c', undefined, ['first'])
  poll.resolve(initial); await polling
  expect(unread.total).toBe(1)
})

it('reconciles concurrent read acknowledgements that arrive in reverse order', async () => {
  const initial = snapshot(['first', 'second'])
  const first = deferred<UnreadSnapshot>(), second = deferred<UnreadSnapshot>()
  vi.mocked(apiRequest).mockResolvedValueOnce(initial)
  unread.start('owner'); await flushPromises()
  vi.mocked(apiRequest).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never).mockResolvedValue(emptyUnread())
  const readingFirst = unread.visible('bot', 'c', undefined, ['first'])
  const readingSecond = unread.visible('bot', 'c', undefined, ['second'])
  second.resolve(emptyUnread()); await readingSecond
  first.resolve(snapshot(['second'])); await readingFirst
  expect(unread.total).toBe(0)
  expect(unread.snapshot.conversations).toEqual([])
})

it('ignores a read acknowledgement after the account changes', async () => {
  const pending = deferred<UnreadSnapshot>()
  vi.mocked(apiRequest).mockResolvedValueOnce(snapshot(['first']))
  unread.start('owner'); await flushPromises()
  vi.mocked(apiRequest).mockReturnValueOnce(pending.promise as never)
  const reading = unread.visible('bot', 'c', undefined, ['first'])
  unread.reset('another-owner'); unread.snapshot = snapshot(['new-message'])
  pending.resolve(emptyUnread()); await reading
  expect(unread.total).toBe(1)
  expect(unread.snapshot.conversations[0]?.messages[0]?.id).toBe('new-message')
})
