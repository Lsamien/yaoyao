// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCacheCoordinator, ChatCacheStore } from '../../src/server/chatCache.js'
import type { UpstreamResponse } from '../../src/server/upstream.js'
import type { UpstreamServiceSession } from '../../src/server/localAuth.js'
const homes: string[] = []
afterEach(() => homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })))
function response(body: unknown): UpstreamResponse {
  return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: Buffer.from(JSON.stringify(body)) }
}
function fixture(count: number) {
  const home = mkdtempSync(join(tmpdir(), 'hermes-pagination-')); homes.push(home)
  const store = new ChatCacheStore(home)
  store.recordRoute('owner', 'default', 'chat', 'runtime')
  const rows = Array.from({ length: count }, (_, id) => ({ id: String(id), role: 'assistant', content: `row ${id}` }))
  const request = vi.fn(async (path: string, options: { search: URLSearchParams }) => {
    if (!path.endsWith('/messages')) return response({ id: 'chat', profile: 'default', title: 'History', message_count: count })
    const offset = Number(options.search.get('offset')), limit = Number(options.search.get('limit'))
    const end = Math.max(0, rows.length - offset)
    const messages = rows.slice(Math.max(0, end - limit), end)
    // Real Hermes 0.21 response: deliberately no total or has_more.
    return response({ session_id: 'chat', messages, pagination: { offset, limit, returned: messages.length, order: 'latest' } })
  })
  const coordinator = new ChatCacheCoordinator(store, { request } as unknown as UpstreamServiceSession)
  return { store, rows, request, coordinator }
}

describe('Hermes pagination without total and has_more', () => {
  it.each([250, 300])('force refresh preserves all %i messages and correct page positions', async count => {
    const f = fixture(count)
    await f.coordinator.reconcile('owner', 'default', 'chat', true)
    const page = f.store.sourceMessagePage('owner', 'default', 'chat', count - 100, 100)!
    const payload = JSON.parse(page.response.body.toString())
    expect(payload.pagination.total).toBe(count)
    expect(payload.messages[0].id).toBe('0')
    expect(payload.messages.at(-1).id).toBe('99')
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/messages'))).toHaveLength(Math.floor(count / 100) + 1)
    f.store.close()
  })

  it('uses known metadata for a partial page instead of declaring that page to be the entire history', () => {
    const f = fixture(250)
    f.store.putSnapshot('owner', 'detail', 'detail', 'default', 'chat', response({ id: 'chat', message_count: 250, title: 'History' }))
    f.store.putSnapshot('owner', 'tail', 'messages', 'default', 'chat', response({ session_id: 'chat', messages: f.rows.slice(-100), pagination: { offset: 0, limit: 100, returned: 100 } }))
    const payload = JSON.parse(f.store.sourceMessagePage('owner', 'default', 'chat', 0, 100)!.response.body.toString())
    expect(payload.pagination).toMatchObject({ total: 250, has_more: true })
    expect(f.store.sourceMessagePage('owner', 'default', 'chat', 100, 100)).toBeUndefined()
    f.store.close()
  })

  it('still reads only one overlapping tail page for an existing cache', async () => {
    const f = fixture(252)
    f.store.putSnapshot('owner', 'seed', 'messages', 'default', 'chat', response({ session: { id: 'chat', message_count: 250 }, messages: f.rows.slice(0, 250), pagination: { total: 250, offset: 0, has_more: false } }))
    await f.coordinator.reconcile('owner', 'default', 'chat')
    expect(f.request.mock.calls.filter(([path]) => path.endsWith('/messages'))).toHaveLength(1)
    const page = JSON.parse(f.store.sourceMessagePage('owner', 'default', 'chat', 0, 100)!.response.body.toString())
    expect(page.pagination.total).toBe(252)
    expect(page.messages.at(-1).id).toBe('251')
    f.store.close()
  })
})
