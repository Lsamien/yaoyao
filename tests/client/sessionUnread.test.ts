import { afterEach, expect, it, vi } from 'vitest'
import { getSessionUnread } from '@/api/sessions'

afterEach(() => vi.unstubAllGlobals())

it('uses final result counts for list badges, including an explicit zero', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [
    { session_id: 'result', unread_count: 12, final_unread_count: 1 },
    { session_id: 'tools', unread_count: 8, final_unread_count: 0 },
    { session_id: 'legacy', unread_count: 2 },
  ] })))
  expect(await getSessionUnread('default')).toEqual({ result: 1, tools: 0, legacy: 2 })
})
