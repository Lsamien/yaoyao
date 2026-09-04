// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
    f.store.recordRoute(owner, profile, sessionID, 'runtime-web')
    f.store.recordCommand(owner, profile, sessionID, 'session.create', { source: 'web' })
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

  it('reprojects a pre-ownership list snapshot after restart before serving it', async () => {
    const f = fixture()
    const search = new URLSearchParams({ profile, offset: '0', limit: '100' })
    const key = chatCacheKey('list', profile, undefined, search)
    f.store.recordRoute(owner, profile, sessionID, 'runtime-web')
    f.store.recordCommand(owner, profile, sessionID, 'session.create', { source: 'ios' })
    f.store.putSnapshot(owner, key, 'list', profile, undefined, response({
      sessions: [{ id: sessionID, profile, source: 'ios', title: '旧快照标题' }],
      total: 1,
    }), true)
    f.store.db.prepare(`UPDATE chat_sessions SET authoritative_title=NULL,authoritative_title_at=0
      WHERE owner=? AND profile=? AND session_id=?`).run(owner, profile, sessionID)
    expect(JSON.parse(f.store.snapshot(owner, key)!.response.body.toString()).sessions[0].owned)
      .toBeUndefined()
    f.store.close()

    const restored = new ChatCacheStore(f.home)
    expect(restored.snapshot(owner, key)?.state).toBe('stale')
    expect((restored.db.prepare(`SELECT authoritative_title FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, sessionID) as { authoritative_title: string }).authoritative_title)
      .toBe('旧快照标题')
    const coordinator = new ChatCacheCoordinator(
      restored,
      { request: vi.fn() } as unknown as UpstreamServiceSession,
      'prefer-local',
    )
    const projected = await coordinator.read(
      owner,
      key,
      'list',
      profile,
      undefined,
      async () => { throw new Error('9119 offline') },
      true,
      { offset: 0, limit: 100 },
    )
    expect(projected).toMatchObject({ source: 'local', state: 'stale' })
    expect(JSON.parse(projected.response.body.toString()).sessions[0]).toMatchObject({
      id: sessionID,
      source: 'ios',
      owned: true,
    })
    restored.close()
  })

  it('adopts the released v0.3.26 registry once without using source for later membership', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-v026-registry-'))
    homes.push(home)
    const legacy = new DatabaseSync(join(home, 'chat-cache.sqlite3'))
    legacy.exec(`CREATE TABLE chat_sessions(
      owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
      runtime_id TEXT, source TEXT NOT NULL, data TEXT NOT NULL,
      sync_state TEXT NOT NULL DEFAULT 'stale', complete INTEGER NOT NULL DEFAULT 0,
      last_event_seq INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER NOT NULL,
      PRIMARY KEY(owner,profile,session_id))`)
    legacy.prepare(`INSERT INTO chat_sessions(
      owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_event_seq,last_synced_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      owner,
      profile,
      'v026-session',
      null,
      'web',
      JSON.stringify({ id: 'v026-session', profile, source: 'web', title: '已发布旧会话' }),
      'current',
      0,
      0,
      1_000,
    )
    legacy.close()

    const migrated = new ChatCacheStore(home, owner)
    expect(migrated.ownsSession(owner, profile, 'v026-session')).toBe(true)
    expect(migrated.db.prepare(`SELECT ownership_evidence FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, 'v026-session'))
      .toMatchObject({ ownership_evidence: 'legacy-single-user' })
    expect(migrated.putSnapshot(owner, 'new-source-row', 'detail', profile, 'new-source-row',
      response({ id: 'new-source-row', profile, source: 'web', title: '未登记新历史' }))).toBe(false)
    expect(migrated.ownsSession(owner, profile, 'new-source-row')).toBe(false)
    migrated.close()
  })

  it('does not adopt ambiguous multi-owner legacy cache rows without command evidence', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-v026-multi-owner-'))
    homes.push(home)
    const legacy = new DatabaseSync(join(home, 'chat-cache.sqlite3'))
    legacy.exec(`CREATE TABLE chat_sessions(
      owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
      runtime_id TEXT, source TEXT NOT NULL, data TEXT NOT NULL,
      sync_state TEXT NOT NULL DEFAULT 'stale', complete INTEGER NOT NULL DEFAULT 0,
      last_event_seq INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER NOT NULL,
      PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE chat_events(
        owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL,
        received_at INTEGER NOT NULL, PRIMARY KEY(owner,profile,session_id,event_seq,event_type));`)
    const insertSession = legacy.prepare(`INSERT INTO chat_sessions(
      owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_event_seq,last_synced_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    for (const [legacyOwner, id] of [
      ['owner-a', 'evidenced'],
      ['owner-a', 'source-only-a'],
      ['owner-b', 'source-only-b'],
    ] as const) {
      insertSession.run(
        legacyOwner,
        profile,
        id,
        null,
        'web',
        JSON.stringify({ id, profile, source: 'web', title: id }),
        'current',
        0,
        0,
        1_000,
      )
    }
    legacy.prepare(`INSERT INTO chat_events(
      owner,profile,session_id,event_seq,event_type,payload,received_at
    ) VALUES(?,?,?,?,?,?,?)`).run(
      'owner-a', profile, 'evidenced', 1, 'command:session.create', '{}', 900,
    )
    legacy.close()

    const migrated = new ChatCacheStore(home, 'owner-a')
    expect(migrated.ownsSession('owner-a', profile, 'evidenced')).toBe(true)
    expect(migrated.ownsSession('owner-a', profile, 'source-only-a')).toBe(false)
    expect(migrated.ownsSession('owner-b', profile, 'source-only-b')).toBe(false)
    migrated.close()
  })

  it('does not adopt one cached owner when the sole local user has another id', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-v026-owner-mismatch-'))
    homes.push(home)
    const legacy = new DatabaseSync(join(home, 'chat-cache.sqlite3'))
    legacy.exec(`CREATE TABLE chat_sessions(
      owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
      runtime_id TEXT, source TEXT NOT NULL, data TEXT NOT NULL,
      sync_state TEXT NOT NULL DEFAULT 'stale', complete INTEGER NOT NULL DEFAULT 0,
      last_event_seq INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER NOT NULL,
      PRIMARY KEY(owner,profile,session_id))`)
    legacy.prepare(`INSERT INTO chat_sessions(
      owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_event_seq,last_synced_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      'cached-old-user', profile, 'source-only', null, 'web',
      JSON.stringify({ id: 'source-only', profile, source: 'web', title: '旧缓存' }),
      'current', 0, 0, 1_000,
    )
    legacy.close()

    const migrated = new ChatCacheStore(home, 'current-sole-user')
    expect(migrated.ownsSession('cached-old-user', profile, 'source-only')).toBe(false)
    migrated.close()
  })

  it('re-enters ownership migration when columns exist but the completion marker is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-v026-interrupted-migration-'))
    homes.push(home)
    const interrupted = new DatabaseSync(join(home, 'chat-cache.sqlite3'))
    interrupted.exec(`CREATE TABLE chat_sessions(
      owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
      runtime_id TEXT, source TEXT NOT NULL, data TEXT NOT NULL,
      authoritative_title TEXT, authoritative_title_at INTEGER NOT NULL DEFAULT 0,
      owned_at INTEGER, ownership_evidence TEXT,
      sync_state TEXT NOT NULL DEFAULT 'stale', complete INTEGER NOT NULL DEFAULT 0,
      last_event_seq INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER NOT NULL,
      PRIMARY KEY(owner,profile,session_id))`)
    interrupted.prepare(`INSERT INTO chat_sessions(
      owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_event_seq,last_synced_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      owner, profile, 'interrupted-row', null, 'web',
      JSON.stringify({ id: 'interrupted-row', profile, source: 'web', title: '可恢复旧会话' }),
      'current', 0, 0, 1_000,
    )
    interrupted.close()

    const recovered = new ChatCacheStore(home, owner)
    expect(recovered.ownsSession(owner, profile, 'interrupted-row')).toBe(true)
    expect(recovered.db.prepare("SELECT value FROM chat_meta WHERE key='ownership-registry-v1'").get())
      .toMatchObject({ value: 'complete' })
    recovered.close()
  })

  it('materializes complete message pages and keeps owners isolated', () => {
    const f = fixture()
    f.store.recordRoute(owner, profile, sessionID, 'runtime-web')
    f.store.recordCommand(owner, profile, sessionID, 'session.create', { source: 'web' })
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

  it('never persists unregistered history regardless of source metadata', () => {
    const f = fixture()
    expect(f.store.putSnapshot(owner, 'history', 'detail', profile, 'history-1',
      response({ id: 'history-1', profile, source: 'telegram', title: '历史' }))).toBe(false)
    expect(f.store.putSnapshot(owner, 'unowned-web', 'detail', profile, 'unowned-web',
      response({ id: 'unowned-web', profile, source: 'web', title: '未登记 Web 历史' }))).toBe(false)
    expect(f.store.snapshot(owner, 'history')).toBeUndefined()
    expect(f.store.snapshot(owner, 'unowned-web')).toBeUndefined()
    f.store.close()
  })

  it('marks event gaps stale, deduplicates events, and falls back while 9119 is offline', async () => {
    const f = fixture()
    const key = 'detail-key'
    f.store.recordRoute(owner, profile, sessionID, 'runtime-1')
    f.store.recordCommand(owner, profile, sessionID, 'session.create', { source: 'web' })
    f.store.putSnapshot(owner, key, 'detail', profile, sessionID,
      response({ id: sessionID, profile, source: 'web', title: '稳定内容' }))
    const frame = { type: 'message.delta', seq: 2, payload: { text: '增量' } }
    f.store.recordEvent(owner, profile, sessionID, frame)
    f.store.recordEvent(owner, profile, sessionID, frame)
    const count = f.store.db.prepare("SELECT COUNT(*) count FROM chat_events WHERE event_type='message.delta'").get() as { count: number }
    expect(count.count).toBe(1)
    expect(f.store.ownsSession(owner, profile, sessionID)).toBe(true)
    expect(f.store.ownsSession('another-owner', profile, sessionID)).toBe(false)
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

  it.each(['session.title', 'session.title.updated'])(
    'projects %s into the owned summary without changing source metadata',
    (eventType) => {
      const f = fixture()
      const ownedSessionID = `owned-${eventType}`
      const listKey = chatCacheKey('list', profile, undefined, new URLSearchParams({ source: 'web', profile }))
      f.store.recordRoute(owner, profile, ownedSessionID, 'runtime-owned')
      f.store.recordCommand(owner, profile, ownedSessionID, 'session.create', { source: 'ios' })
      f.store.putSnapshot(owner, listKey, 'list', profile, undefined, response({ sessions: [] }), true)

      f.store.recordEvent(owner, profile, ownedSessionID, {
        type: eventType,
        payload: { session_id: ownedSessionID, title: '服务端生成的标题' },
      })

      expect(f.store.snapshot(owner, listKey)?.state).toBe('stale')
      const merged = f.store.mergeOwnedSessionsIntoList(owner, profile, response({ sessions: [], total: 0 }))
      expect(JSON.parse(merged.body.toString()).sessions).toContainEqual(expect.objectContaining({
        id: ownedSessionID,
        profile,
        source: 'ios',
        owned: true,
        title: '服务端生成的标题',
      }))

      const staleList = f.store.mergeOwnedSessionsIntoList(owner, profile, response({ sessions: [{
        id: ownedSessionID, profile, source: 'ios', title: '新对话',
      }] }))
      expect(JSON.parse(staleList.body.toString()).sessions[0].title).toBe('服务端生成的标题')

      const titleVersion = f.store.db.prepare(`SELECT authoritative_title_at FROM chat_sessions
        WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, ownedSessionID) as { authoritative_title_at: number }
      expect(f.store.putSnapshot(owner, 'delayed-detail', 'detail', profile, ownedSessionID,
        response({ id: ownedSessionID, profile, source: 'ios', title: '迟到的旧标题' }), false,
        titleVersion.authoritative_title_at - 1)).toBe(true)
      const afterDelayedDetail = f.store.markSessionOwnership(owner, profile, ownedSessionID,
        response({ id: ownedSessionID, profile, source: 'ios', title: '迟到的旧标题' }))
      expect(JSON.parse(afterDelayedDetail.body.toString()).title).toBe('服务端生成的标题')

      expect(f.store.putSnapshot(owner, 'newer-detail', 'detail', profile, ownedSessionID,
        response({ id: ownedSessionID, profile, source: 'ios', title: '后续详情标题' }), false,
        titleVersion.authoritative_title_at + 1)).toBe(true)
      expect(f.store.putSnapshot(owner, 'regressed-detail', 'detail', profile, ownedSessionID,
        response({ id: ownedSessionID, profile, source: 'ios', title: '新对话' }))).toBe(true)
      const afterDetail = f.store.markSessionOwnership(owner, profile, ownedSessionID,
        response({ id: ownedSessionID, profile, source: 'ios', title: '新对话' }))
      expect(JSON.parse(afterDetail.body.toString()).title).toBe('后续详情标题')
      f.store.close()
    },
  )

  it('accepts detail and messages for a registered session regardless of source metadata', () => {
    const f = fixture()
    const ownedSessionID = 'owned-ios-session'
    f.store.recordRoute(owner, profile, ownedSessionID, 'runtime-owned')
    f.store.recordCommand(owner, profile, ownedSessionID, 'session.create', { source: 'ios' })

    expect(f.store.putSnapshot(owner, 'owned-detail', 'detail', profile, ownedSessionID,
      response({ id: ownedSessionID, profile, source: 'ios', title: 'iOS 权威标题' }))).toBe(true)
    expect(f.store.putSnapshot(owner, 'owned-messages', 'messages', profile, ownedSessionID, response({
      session: { id: ownedSessionID, profile, source: 'ios', title: 'iOS 权威标题' },
      messages: [{ id: 'm-ios', role: 'assistant', content: '已同步' }],
      pagination: { total: 1, returned: 1, offset: 0, limit: 100, hasMore: false },
    }))).toBe(true)

    const page = f.store.messagePage(owner, profile, ownedSessionID, 0, 100)
    expect(JSON.parse(page!.response.body.toString())).toMatchObject({
      session_id: ownedSessionID,
      session: { source: 'ios', title: 'iOS 权威标题' },
      messages: [{ id: 'm-ios' }],
    })
    f.store.close()
  })

  it('caches only attachment paths discovered in source=web messages', () => {
    const f = fixture()
    f.store.recordRoute(owner, profile, sessionID, 'runtime-web')
    f.store.recordCommand(owner, profile, sessionID, 'session.create', { source: 'web' })
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
    store.recordRoute(owner, profile, sessionID, 'runtime-web')
    store.recordCommand(owner, profile, sessionID, 'session.create', { source: 'web' })
    const load = vi.fn(async () => response({ sessions: [{ id: sessionID, profile, source: 'web' }] }))
    const search = new URLSearchParams({ source: 'web' })
    const key = chatCacheKey('list', profile, undefined, search)
    const shadow = new ChatCacheCoordinator(store, upstream, 'shadow')
    await shadow.read(owner, key, 'list', profile, undefined, load, true)
    await shadow.read(owner, key, 'list', profile, undefined, load, true)
    expect(load).toHaveBeenCalledTimes(2)
    const upstreamOnly = new ChatCacheCoordinator(store, upstream, 'upstream-only')
    const upstreamResult = await upstreamOnly.read(owner, key, 'list', profile, undefined, load, true)
    expect(load).toHaveBeenCalledTimes(3)
    expect(JSON.parse(upstreamResult.response.body.toString()).sessions).toEqual([
      expect.objectContaining({ id: sessionID, owned: true }),
    ])
    upstreamOnly.route(owner, profile, 'upstream-only-created', 'runtime-upstream-only')
    expect(store.ownsSession(owner, profile, 'upstream-only-created')).toBe(true)
    store.close()
  })

  it('paginates the complete owner registry before slicing regardless of mixed upstream history', () => {
    const f = fixture()
    for (let index = 0; index < 15; index++) {
      const id = `owned-${index}`
      const source = index % 2 ? 'ios' : 'web'
      f.store.recordRoute(owner, profile, id, `runtime-${index}`)
      f.store.recordCommand(owner, profile, id, 'session.create', { source })
      expect(f.store.putSnapshot(owner, `detail-${index}`, 'detail', profile, id, response({
        id,
        profile,
        source,
        title: `Owned ${index}`,
        last_active: 1_000 + index,
      }))).toBe(true)
    }
    const upstreamSessions = [
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `unowned-${index}`,
        profile,
        source: index % 2 ? 'ios' : 'web',
        title: `Unowned ${index}`,
        last_active: 10_000 + index,
      })),
      ...Array.from({ length: 15 }, (_, index) => ({
        id: `owned-${index}`,
        profile,
        source: index % 2 ? 'ios' : 'web',
        title: '新对话',
        last_active: 1_000 + index,
      })),
    ]
    const merged = f.store.mergeOwnedSessionsIntoList(
      owner,
      profile,
      response({ sessions: upstreamSessions, total: upstreamSessions.length }),
      { offset: 5, limit: 4, archived: 'exclude' },
    )
    const payload = JSON.parse(merged.body.toString())
    expect(payload).toMatchObject({ total: 15, offset: 5, limit: 4 })
    expect(payload.sessions.map((session: { id: string }) => session.id))
      .toEqual(['owned-9', 'owned-8', 'owned-7', 'owned-6'])
    expect(payload.sessions.every((session: { owned?: boolean }) => session.owned === true)).toBe(true)

    const history = f.store.excludeOwnedSessionsFromList(
      owner,
      profile,
      response({ sessions: upstreamSessions, total: upstreamSessions.length }),
      { offset: 7, limit: 5 },
    )
    const historyPayload = JSON.parse(history.body.toString())
    expect(historyPayload).toMatchObject({ total: 40, offset: 7, limit: 5 })
    expect(historyPayload.sessions.map((session: { id: string }) => session.id))
      .toEqual(['unowned-7', 'unowned-8', 'unowned-9', 'unowned-10', 'unowned-11'])
    expect(historyPayload.sessions.some((session: { source: string }) => session.source === 'web')).toBe(true)
    f.store.close()
  })

  it('keeps an old pinned owned session on the first page after registry projection', () => {
    const f = fixture()
    for (let index = 0; index < 101; index++) {
      const id = `owned-${index}`
      f.store.recordRoute(owner, profile, id, `runtime-${index}`)
      f.store.recordCommand(owner, profile, id, 'session.create', { source: 'ios' })
      expect(f.store.putSnapshot(owner, `detail-${index}`, 'detail', profile, id, response({
        id,
        profile,
        source: 'ios',
        title: `Owned ${index}`,
        last_active: 1_000 + index,
        pinned: index === 0,
      }))).toBe(true)
    }

    const merged = f.store.mergeOwnedSessionsIntoList(
      owner,
      profile,
      response({ sessions: [], total: 0 }),
      { offset: 0, limit: 100, archived: 'exclude' },
    )
    const payload = JSON.parse(merged.body.toString())
    expect(payload).toMatchObject({ total: 101, offset: 0, limit: 100 })
    expect(payload.sessions).toHaveLength(100)
    expect(payload.sessions[0]).toMatchObject({ id: 'owned-0', pinned: true, owned: true })
    expect(payload.sessions.map((session: { id: string }) => session.id)).not.toContain('owned-1')
    f.store.close()
  })
})
