// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCacheCoordinator, ChatCacheStore, chatCacheKey } from '../../src/server/chatCache.js'
import type { UpstreamServiceSession } from '../../src/server/localAuth.js'
import type { UpstreamResponse } from '../../src/server/upstream.js'

const homes: string[] = []
const owner = 'owner-1'
const profile = 'default'
const sessionID = 'session-web'

function response(value: unknown, status = 200, contentType = 'application/json'): UpstreamResponse {
  return { status, headers: new Headers({ 'content-type': contentType }), body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-chat-cache-'))
  homes.push(home)
  const store = new ChatCacheStore(home)
  const upstream = { request: vi.fn() } as unknown as UpstreamServiceSession
  return { home, store, coordinator: new ChatCacheCoordinator(store, upstream, 'prefer-local') }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('durable source=web chat cache', () => {
  it('serves a warm list without a second 9119 request and survives restart', async () => {
    const f = fixture()
    const search = new URLSearchParams({ source: 'web', profile })
    const key = chatCacheKey('list', profile, undefined, search)
    const load = vi.fn(async () => response({ sessions: [{ id: sessionID, profile, source: 'web', title: '本地会话' }] }))

    const first = await f.coordinator.read(owner, key, 'list', profile, undefined, load, true)
    const second = await f.coordinator.read(owner, key, 'list', profile, undefined, load, true)
    expect(first.source).toBe('upstream')
    expect(second.source).toBe('local')
    expect(load).toHaveBeenCalledTimes(1)

    f.store.close()
    const restored = new ChatCacheStore(f.home)
    const cached = restored.snapshot(owner, key)
    expect(JSON.parse(cached!.response.body.toString()).sessions[0].title).toBe('本地会话')
    restored.close()
  })

  it('materializes complete message pages and keeps owners isolated', () => {
    const f = fixture()
    f.store.putSnapshot(owner, 'detail', 'detail', profile, sessionID,
      response({ id: sessionID, profile, source: 'web', title: '对话' }))
    f.store.putSnapshot(owner, 'messages', 'messages', profile, sessionID, response({
      session: { id: sessionID, profile, source: 'web', title: '对话' },
      messages: [
        { id: 'm1', role: 'user', content: '开始' },
        { id: 'm2', role: 'assistant', content: '完成' },
      ],
      pagination: { total: 2, returned: 2, offset: 0, limit: 100, hasMore: false },
    }))

    const page = f.store.messagePage(owner, profile, sessionID, 0, 100)
    const payload = JSON.parse(page!.response.body.toString())
    expect(payload.session_id).toBe(sessionID)
    expect(payload.pagination).toMatchObject({ total: 2, returned: 2, offset: 0, limit: 100, has_more: false })
    expect(payload.messages.map((item: { id: string }) => item.id)).toEqual(['m1', 'm2'])
    expect(f.store.messagePage('another-owner', profile, sessionID, 0, 100)).toBeUndefined()
    f.store.close()
  })

  it('never persists non-Web history', () => {
    const f = fixture()
    expect(f.store.putSnapshot(owner, 'history', 'detail', profile, 'history-1',
      response({ id: 'history-1', profile, source: 'telegram', title: '历史' }))).toBe(false)
    expect(f.store.snapshot(owner, 'history')).toBeUndefined()
    f.store.close()
  })

  it('marks event gaps stale, deduplicates events, and falls back while 9119 is offline', async () => {
    const f = fixture()
    const key = 'detail-key'
    f.store.putSnapshot(owner, key, 'detail', profile, sessionID,
      response({ id: sessionID, profile, source: 'web', title: '稳定内容' }))
    const frame = { type: 'message.delta', seq: 2, payload: { text: '增量' } }
    f.store.recordEvent(owner, profile, sessionID, frame)
    f.store.recordEvent(owner, profile, sessionID, frame)
    const count = f.store.db.prepare('SELECT COUNT(*) count FROM chat_events').get() as { count: number }
    expect(count.count).toBe(1)
    f.store.recordRoute(owner, profile, sessionID, 'runtime-1')
    const route = f.store.db.prepare('SELECT runtime_id FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?')
      .get(owner, profile, sessionID) as { runtime_id: string }
    expect(route.runtime_id).toBe('runtime-1')
    const fallback = await f.coordinator.read(owner, key, 'detail', profile, sessionID,
      async () => { throw new Error('9119 offline') })
    expect(fallback).toMatchObject({ source: 'local', state: 'stale' })
    const serverFailure = await f.coordinator.read(owner, key, 'detail', profile, sessionID,
      async () => response({ error: 'unavailable' }, 503))
    expect(serverFailure).toMatchObject({ source: 'local', state: 'stale' })
    f.store.close()
  })

  it('caches only attachment paths discovered in source=web messages', () => {
    const f = fixture()
    const sourcePath = '/Users/test/.hermes/profiles/default/images/result.png'
    f.store.putSnapshot(owner, 'messages', 'messages', profile, sessionID, response({
      session: { id: sessionID, profile, source: 'web' },
      messages: [{ id: 'm1', role: 'assistant', content: `![结果](${sourcePath})` }],
      pagination: { total: 1, offset: 0, hasMore: false },
    }))
    expect(f.store.knowsAttachment(owner, sourcePath)).toBe(true)
    const bytes = response('image-data', 200, 'image/png')
    expect(f.store.storeAttachment(owner, sourcePath, bytes)).toBeTruthy()
    expect(f.store.attachment(owner, sourcePath)?.mimeType).toBe('image/png')
    expect(f.store.knowsAttachment(owner, '/Users/test/history.png')).toBe(false)
    f.store.close()
  })

  it('supports shadow and upstream-only rollback modes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-chat-cache-modes-')); homes.push(home)
    const store = new ChatCacheStore(home)
    const upstream = { request: vi.fn() } as unknown as UpstreamServiceSession
    const load = vi.fn(async () => response({ sessions: [{ id: sessionID, profile, source: 'web' }] }))
    const search = new URLSearchParams({ source: 'web' })
    const key = chatCacheKey('list', profile, undefined, search)
    const shadow = new ChatCacheCoordinator(store, upstream, 'shadow')
    await shadow.read(owner, key, 'list', profile, undefined, load, true)
    await shadow.read(owner, key, 'list', profile, undefined, load, true)
    expect(load).toHaveBeenCalledTimes(2)
    const upstreamOnly = new ChatCacheCoordinator(store, upstream, 'upstream-only')
    await upstreamOnly.read(owner, key, 'list', profile, undefined, load, true)
    expect(load).toHaveBeenCalledTimes(3)
    store.close()
  })
})
