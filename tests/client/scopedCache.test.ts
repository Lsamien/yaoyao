import { afterEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

const storage = vi.hoisted(() => ({ records: new Map<string, unknown>(), fail: false }))
vi.mock('idb', () => ({ openDB: async () => ({
  put: async (_store: string, value: unknown, key: string) => {
    if (storage.fail) throw new Error('disk unavailable')
    storage.records.set(key, structuredClone(value))
  },
  get: async (_store: string, key: string) => {
    if (storage.fail) throw new Error('disk unavailable')
    return structuredClone(storage.records.get(key))
  },
}) }))

afterEach(() => { storage.records.clear(); storage.fail = false; vi.unstubAllGlobals(); vi.resetModules() })

it('durably stores reactive pending messages as detached snapshots', async () => {
  vi.stubGlobal('indexedDB', {})
  const { ScopedCache } = await import('../../src/client/utils/cache')
  const cache = new ScopedCache<{ messages: Array<{ content: string }>; cursor: number }>('reactive')
  const pending = reactive({ content: 'pending input' })
  const value = reactive({ messages: [pending], cursor: 3 })
  await cache.set('account', 'session', value, true)
  pending.content = 'later edit'
  value.cursor = 4
  expect(await cache.get('account', 'session')).toEqual({ messages: [{ content: 'pending input' }], cursor: 3 })
})

it('does not advance the memory checkpoint when durable storage fails', async () => {
  vi.stubGlobal('indexedDB', {})
  const { ScopedCache } = await import('../../src/client/utils/cache')
  const cache = new ScopedCache<{ cursor: number }>('failed-write')
  const value = reactive({ cursor: 3 })
  await cache.set('account', 'session', value, true)
  storage.fail = true
  value.cursor = 4
  await expect(cache.set('account', 'session', value, true)).rejects.toThrow('disk unavailable')
  expect(await cache.get('account', 'session')).toEqual({ cursor: 3 })
})
