import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { UpstreamResponse } from './upstream.js'
import type { UpstreamServiceSession } from './localAuth.js'

export type ChatCacheMode = 'upstream-only' | 'shadow' | 'prefer-local'
export type ChatCacheState = 'current' | 'stale' | 'syncing' | 'gap'
export type ChatCacheSource = 'local' | 'upstream'

interface StoredSnapshot {
  response: UpstreamResponse
  state: ChatCacheState
}

interface MessagePage {
  response: UpstreamResponse
  state: ChatCacheState
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function parseResponse(response: UpstreamResponse): Record<string, unknown> | undefined {
  if (response.status < 200 || response.status >= 300) return undefined
  try { return object(JSON.parse(response.body.toString('utf8'))) } catch { return undefined }
}

function headerRecord(headers: Headers): string {
  return JSON.stringify(Object.fromEntries([...headers.entries()].filter(([name]) => name.toLowerCase() !== 'set-cookie')))
}

function responseFromRow(row: Record<string, unknown>): UpstreamResponse {
  return {
    status: Number(row.status),
    headers: new Headers(JSON.parse(String(row.headers)) as Record<string, string>),
    body: Buffer.from(String(row.body), 'base64'),
  }
}

function profileOf(value: Record<string, unknown>, fallback = ''): string {
  return String(value.profile ?? value.profile_name ?? fallback).trim()
}

function sessionIDOf(value: Record<string, unknown>): string {
  return String(value.id ?? value.session_id ?? value.sessionId ?? '').trim()
}

function sessionSource(value: Record<string, unknown>): string {
  return String(value.source ?? '').trim()
}

function sessionTitle(value: Record<string, unknown>): string {
  return String(value.title ?? '').trim()
}

function isPlaceholderTitle(value: string): boolean {
  return new Set([
    '', '新对话', '新会话', '未命名对话', '未命名会话', 'new conversation', 'new session', 'untitled',
  ]).has(value.trim().toLowerCase())
}

function messageID(value: Record<string, unknown>, fallback: string): string {
  const id = String(value.id ?? value.row_id ?? value.message_id ?? value.messageId ?? '').trim()
  return id || createHash('sha256').update(JSON.stringify(value) + fallback).digest('hex')
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

const PATH_PATTERN = /(?:file:\/\/)?(\/(?:Users|private|var|tmp)\/[^\s<>'"`)\]}]+\.[A-Za-z0-9]{1,12})/g

function referencedPaths(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PATH_PATTERN)) output.add(match[1]!)
  } else if (Array.isArray(value)) {
    for (const child of value) referencedPaths(child, output)
  } else {
    const record = object(value)
    if (record) for (const child of Object.values(record)) referencedPaths(child, output)
  }
  return output
}

export class ChatCacheStore {
  readonly db: DatabaseSync
  readonly assetsRoot: string

  constructor(home: string, legacySingleUserID?: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const path = join(home, 'chat-cache.sqlite3')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.assetsRoot = join(home, 'chat-cache-assets')
    mkdirSync(this.assetsRoot, { recursive: true, mode: 0o700 })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chat_sessions(
        owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
        runtime_id TEXT, source TEXT NOT NULL, data TEXT NOT NULL, authoritative_title TEXT,
        authoritative_title_at INTEGER NOT NULL DEFAULT 0,
        owned_at INTEGER, ownership_evidence TEXT,
        sync_state TEXT NOT NULL DEFAULT 'stale', complete INTEGER NOT NULL DEFAULT 0,
        last_event_seq INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER NOT NULL,
        PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_messages(
        owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
        content_hash TEXT NOT NULL, PRIMARY KEY(owner,profile,session_id,message_id));
      CREATE INDEX IF NOT EXISTS chat_messages_position ON chat_messages(owner,profile,session_id,position);
      CREATE TABLE IF NOT EXISTS chat_events(
        owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL,
        received_at INTEGER NOT NULL, PRIMARY KEY(owner,profile,session_id,event_seq,event_type));
      CREATE TABLE IF NOT EXISTS chat_attachments(
        owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
        source_path TEXT NOT NULL, sha256 TEXT, mime_type TEXT, size INTEGER,
        local_path TEXT, state TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner,profile,session_id,source_path));
      CREATE INDEX IF NOT EXISTS chat_attachments_source ON chat_attachments(owner,source_path);
      CREATE TABLE IF NOT EXISTS chat_sync_cursors(
        owner TEXT NOT NULL, profile TEXT NOT NULL, generation TEXT,
        event_cursor INTEGER NOT NULL DEFAULT 0, sync_state TEXT NOT NULL DEFAULT 'stale',
        last_synced_at INTEGER NOT NULL, PRIMARY KEY(owner,profile));
      CREATE TABLE IF NOT EXISTS chat_snapshots(
        owner TEXT NOT NULL, cache_key TEXT NOT NULL, kind TEXT NOT NULL,
        profile TEXT NOT NULL, session_id TEXT, status INTEGER NOT NULL,
        headers TEXT NOT NULL, body TEXT NOT NULL, sync_state TEXT NOT NULL,
        saved_at INTEGER NOT NULL, PRIMARY KEY(owner,cache_key));
      CREATE TABLE IF NOT EXISTS chat_meta(
        key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    const sessionColumns = this.db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!sessionColumns.some(column => column.name === 'authoritative_title')) {
        this.db.exec('ALTER TABLE chat_sessions ADD COLUMN authoritative_title TEXT')
      }
      if (!sessionColumns.some(column => column.name === 'authoritative_title_at')) {
        this.db.exec('ALTER TABLE chat_sessions ADD COLUMN authoritative_title_at INTEGER NOT NULL DEFAULT 0')
      }
      if (!sessionColumns.some(column => column.name === 'owned_at')) {
        this.db.exec('ALTER TABLE chat_sessions ADD COLUMN owned_at INTEGER')
      }
      if (!sessionColumns.some(column => column.name === 'ownership_evidence')) {
        this.db.exec('ALTER TABLE chat_sessions ADD COLUMN ownership_evidence TEXT')
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS chat_sessions_owned
        ON chat_sessions(owner,profile,owned_at,last_synced_at)`)
      const ownershipMigration = this.db.prepare(
        "SELECT value FROM chat_meta WHERE key='ownership-registry-v1'",
      ).get() as { value?: string } | undefined
      if (!ownershipMigration) {
        // A single cached owner is trusted only when the persisted local user
        // database independently confirms the same sole identity.
        const legacyOwners = this.db.prepare(
          'SELECT DISTINCT owner FROM chat_sessions ORDER BY owner',
        ).all() as Array<{ owner: string }>
        if (legacyOwners.length === 1 && legacyOwners[0]!.owner === legacySingleUserID) {
          this.db.exec(`UPDATE chat_sessions SET
            owned_at=COALESCE(owned_at,last_synced_at),
            ownership_evidence=COALESCE(ownership_evidence,'legacy-single-user')`)
        }
      }
      // Recover interrupted/new-schema writes only from explicit command proof.
      this.db.exec(`UPDATE chat_sessions SET
        owned_at=COALESCE(owned_at,(
          SELECT MIN(chat_events.received_at) FROM chat_events
          WHERE chat_events.owner=chat_sessions.owner
            AND chat_events.profile=chat_sessions.profile
            AND chat_events.session_id=chat_sessions.session_id
            AND chat_events.event_type IN ('command:session.create','command:session.branch')
        )),
        ownership_evidence=COALESCE(ownership_evidence,'command-migration')
        WHERE EXISTS (
          SELECT 1 FROM chat_events
          WHERE chat_events.owner=chat_sessions.owner
            AND chat_events.profile=chat_sessions.profile
            AND chat_events.session_id=chat_sessions.session_id
            AND chat_events.event_type IN ('command:session.create','command:session.branch')
        )`)
      const legacyTitles = this.db.prepare(`SELECT owner,profile,session_id,data FROM chat_sessions
        WHERE authoritative_title IS NULL`).all() as Array<{
          owner: string; profile: string; session_id: string; data: string
        }>
      const backfillTitle = this.db.prepare(`UPDATE chat_sessions SET authoritative_title=?
        WHERE owner=? AND profile=? AND session_id=? AND authoritative_title IS NULL`)
      for (const row of legacyTitles) {
        let summary: Record<string, unknown> = {}
        try { summary = object(JSON.parse(row.data)) ?? {} } catch { continue }
        const title = sessionTitle(summary)
        if (!isPlaceholderTitle(title)) backfillTitle.run(title, row.owner, row.profile, row.session_id)
      }
      // List bodies written before ownership became an explicit projection do
      // not carry `owned` and may have been filtered by `source`. Rebuild them on
      // first use after every restart instead of serving a semantically old page.
      this.db.prepare("UPDATE chat_snapshots SET sync_state='stale' WHERE kind='list'").run()
      this.db.prepare(`INSERT INTO chat_meta(key,value) VALUES('ownership-registry-v1','complete')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void { this.db.close() }

  stats(): Record<string, number> {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count)
    const bytes = Number((this.db.prepare(`SELECT COALESCE(SUM(size),0) bytes FROM chat_attachments WHERE state='cached'`).get() as { bytes: number }).bytes)
    return {
      sessions: Number((this.db.prepare(`SELECT COUNT(*) count FROM chat_sessions
        WHERE owned_at IS NOT NULL`).get() as { count: number }).count),
      messages: count('chat_messages'),
      events: count('chat_events'),
      attachments: count('chat_attachments'),
      attachmentBytes: bytes,
    }
  }

  snapshot(owner: string, key: string): StoredSnapshot | undefined {
    const row = this.db.prepare('SELECT status,headers,body,sync_state FROM chat_snapshots WHERE owner=? AND cache_key=?')
      .get(owner, key) as Record<string, unknown> | undefined
    return row ? { response: responseFromRow(row), state: String(row.sync_state) as ChatCacheState } : undefined
  }

  putSnapshot(owner: string, key: string, kind: string, profile: string, sessionID: string | undefined,
    response: UpstreamResponse, ownedList = false, requestStartedAt = Date.now()): boolean {
    const payload = parseResponse(response)
    if (!payload) return false
    if (kind === 'list' && !ownedList) return false
    const isOwnedChat = ownedList || this.payloadBelongsToOwnedChat(owner, profile, sessionID, payload)
    if (!isOwnedChat) return false
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ingestPayload(owner, profile, sessionID, payload, now, kind, requestStartedAt)
      this.db.prepare(`INSERT INTO chat_snapshots(owner,cache_key,kind,profile,session_id,status,headers,body,sync_state,saved_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,cache_key) DO UPDATE SET status=excluded.status,headers=excluded.headers,
        body=excluded.body,sync_state='current',saved_at=excluded.saved_at`)
        .run(owner, key, kind, profile, sessionID ?? null, response.status, headerRecord(response.headers),
          response.body.toString('base64'), 'current', now)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  messagePage(owner: string, profile: string, sessionID: string, offset: number, limit: number): MessagePage | undefined {
    const session = this.db.prepare(`SELECT data,sync_state,complete FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, sessionID) as Record<string, unknown> | undefined
    if (!session || !bool(session.complete)) return undefined
    const totalRow = this.db.prepare('SELECT COUNT(*) count FROM chat_messages WHERE owner=? AND profile=? AND session_id=?')
      .get(owner, profile, sessionID) as { count: number }
    const total = Number(totalRow.count)
    const end = Math.max(0, total - offset)
    const start = Math.max(0, end - limit)
    const rows = this.db.prepare(`SELECT data FROM chat_messages WHERE owner=? AND profile=? AND session_id=?
      AND position>=? AND position<? ORDER BY position`).all(owner, profile, sessionID, start, end) as Array<{ data: string }>
    const messages = rows.map(row => JSON.parse(row.data))
    const body = Buffer.from(JSON.stringify({
      session_id: sessionID,
      session: JSON.parse(String(session.data)),
      messages,
      pagination: {
        total,
        returned: messages.length,
        offset,
        limit,
        has_more: start > 0,
      },
    }))
    return {
      response: { status: 200, headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }), body },
      state: String(session.sync_state) as ChatCacheState,
    }
  }

  recordEvent(owner: string, profile: string, sessionID: string, frame: Record<string, unknown>): void {
    const rawSeq = Number(frame.seq ?? frame.sequence ?? 0)
    const type = String(frame.type ?? 'unknown')
    const payload = JSON.stringify(frame.payload ?? {})
    const seq = Number.isSafeInteger(rawSeq) && rawSeq > 0
      ? rawSeq
      : Number.parseInt(createHash('sha256').update(`${type}:${payload}`).digest('hex').slice(0, 12), 16)
    const now = Date.now()
    const previous = this.db.prepare(`SELECT last_event_seq FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, sessionID) as { last_event_seq?: number } | undefined
    const lastSeen = Number(previous?.last_event_seq ?? 0)
    this.db.prepare(`INSERT OR IGNORE INTO chat_events(owner,profile,session_id,event_seq,event_type,payload,received_at)
      VALUES(?,?,?,?,?,?,?)`).run(owner, profile, sessionID, Number.isSafeInteger(seq) ? seq : 0, type, payload, now)
    const state: ChatCacheState = type === 'gateway.reset' || type.includes('reset')
      || (rawSeq > 0 && lastSeen > 0 && rawSeq > lastSeen + 1) ? 'gap' : 'stale'
    this.db.prepare(`UPDATE chat_sessions SET sync_state=?,last_event_seq=MAX(last_event_seq,?),last_synced_at=?
      WHERE owner=? AND profile=? AND session_id=?`).run(state, rawSeq > 0 ? rawSeq : lastSeen, now, owner, profile, sessionID)
    if (type === 'session.title' || type === 'session.title.updated') {
      const title = String(object(frame.payload)?.title ?? frame.title ?? '').trim()
      if (title) this.updateOwnedSessionTitle(owner, profile, sessionID, title, now)
    }
    this.db.prepare(`UPDATE chat_snapshots SET sync_state=? WHERE owner=? AND (session_id=? OR kind='list')`)
      .run(state, owner, sessionID)
    this.db.prepare(`INSERT INTO chat_sync_cursors(owner,profile,event_cursor,sync_state,last_synced_at)
      VALUES(?,?,?,?,?) ON CONFLICT(owner,profile) DO UPDATE SET event_cursor=MAX(event_cursor,excluded.event_cursor),
      sync_state=excluded.sync_state,last_synced_at=excluded.last_synced_at`)
      .run(owner, profile, rawSeq > 0 ? rawSeq : lastSeen, state, now)
  }

  recordRoute(owner: string, profile: string, sessionID: string, runtimeID: string): void {
    const now = Date.now()
    const summary = { id: sessionID, profile, source: 'unknown', title: '新对话', started_at: now, last_active: now }
    this.db.prepare(`INSERT INTO chat_sessions(owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_synced_at,owned_at,ownership_evidence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET runtime_id=excluded.runtime_id,
      last_synced_at=excluded.last_synced_at,owned_at=COALESCE(chat_sessions.owned_at,excluded.owned_at),
      ownership_evidence=COALESCE(chat_sessions.ownership_evidence,excluded.ownership_evidence)`)
      .run(owner, profile, sessionID, runtimeID, 'unknown', JSON.stringify(summary), 'stale', 0, now, now, 'route-confirmed')
    this.markListsStale(owner)
  }

  recordCommand(owner: string, profile: string, sessionID: string, method: string,
    params: Record<string, unknown>): void {
    const now = Date.now()
    const source = sessionSource(params) || 'unknown'
    const establishesOwnership = method === 'session.create' || method === 'session.branch'
    const summary = { id: sessionID, profile, source, title: '新对话', started_at: now, last_active: now }
    this.db.prepare(`INSERT INTO chat_sessions(owner,profile,session_id,source,data,sync_state,complete,last_synced_at,owned_at,ownership_evidence)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET
      source=CASE WHEN excluded.source='unknown' THEN chat_sessions.source ELSE excluded.source END,
      sync_state='stale',complete=0,last_synced_at=excluded.last_synced_at,
      owned_at=COALESCE(chat_sessions.owned_at,excluded.owned_at),
      ownership_evidence=COALESCE(chat_sessions.ownership_evidence,excluded.ownership_evidence)`)
      .run(owner, profile, sessionID, source, JSON.stringify(summary), 'stale', 0, now,
        establishesOwnership ? now : null, establishesOwnership ? `command:${method}` : null)
    const payload = JSON.stringify(params)
    const seq = Number.parseInt(createHash('sha256').update(`${method}:${payload}`).digest('hex').slice(0, 12), 16)
    this.db.prepare(`INSERT OR IGNORE INTO chat_events(owner,profile,session_id,event_seq,event_type,payload,received_at)
      VALUES(?,?,?,?,?,?,?)`).run(owner, profile, sessionID, seq, `command:${method}`, payload, now)
    this.db.prepare("UPDATE chat_snapshots SET sync_state='stale' WHERE owner=? AND (session_id=? OR kind='list')")
      .run(owner, sessionID)
  }

  markListsStale(owner: string): void {
    this.db.prepare("UPDATE chat_snapshots SET sync_state='stale' WHERE owner=? AND kind='list'").run(owner)
  }

  recordAuthoritativeTitle(owner: string, profile: string, sessionID: string, title: string): void {
    const normalized = title.trim()
    if (!normalized) return
    this.updateOwnedSessionTitle(owner, profile, sessionID, normalized, Date.now())
    this.db.prepare(`UPDATE chat_snapshots SET sync_state='stale'
      WHERE owner=? AND (session_id=? OR kind='list')`).run(owner, sessionID)
  }

  deleteSession(owner: string, profile: string, sessionID: string): void {
    const assets = this.db.prepare(`SELECT DISTINCT local_path FROM chat_attachments
      WHERE owner=? AND profile=? AND session_id=? AND local_path IS NOT NULL`)
      .all(owner, profile, sessionID) as Array<{ local_path: string }>
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['chat_messages', 'chat_events', 'chat_attachments', 'chat_sessions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE owner=? AND profile=? AND session_id=?`).run(owner, profile, sessionID)
      }
      this.db.prepare("DELETE FROM chat_snapshots WHERE owner=? AND (session_id=? OR kind='list')").run(owner, sessionID)
      this.db.exec('COMMIT')
      for (const asset of assets) {
        const referenced = this.db.prepare('SELECT 1 ok FROM chat_attachments WHERE local_path=? LIMIT 1').get(asset.local_path)
        if (!referenced) try { unlinkSync(asset.local_path) } catch { /* Already absent. */ }
      }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  attachment(owner: string, sourcePath: string): { localPath: string; mimeType?: string } | undefined {
    const row = this.db.prepare(`SELECT local_path,mime_type FROM chat_attachments
      WHERE owner=? AND source_path=? AND state='cached' ORDER BY updated_at DESC LIMIT 1`).get(owner, sourcePath) as Record<string, unknown> | undefined
    const localPath = row?.local_path ? String(row.local_path) : ''
    return localPath && existsSync(localPath) ? { localPath, ...(row?.mime_type ? { mimeType: String(row.mime_type) } : {}) } : undefined
  }

  knowsAttachment(owner: string, sourcePath: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 ok FROM chat_attachments WHERE owner=? AND source_path=? LIMIT 1').get(owner, sourcePath))
  }

  ownsSession(owner: string, profile: string, sessionID: string): boolean {
    return Boolean(this.db.prepare(
      'SELECT 1 ok FROM chat_sessions WHERE owner=? AND profile=? AND session_id=? AND owned_at IS NOT NULL',
    ).get(owner, profile, sessionID))
  }

  ownedSessionMetadata(owner: string, profile: string, sessionID: string): {
    owned: boolean
    authoritativeTitle?: string
  } {
    const row = this.db.prepare(`SELECT authoritative_title FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=? AND owned_at IS NOT NULL`)
      .get(owner, profile, sessionID) as { authoritative_title?: string | null } | undefined
    const authoritativeTitle = String(row?.authoritative_title ?? '').trim()
    return {
      owned: Boolean(row),
      ...(authoritativeTitle ? { authoritativeTitle } : {}),
    }
  }

  mergeOwnedSessionsIntoList(
    owner: string,
    fallbackProfile: string,
    response: UpstreamResponse,
    page: { offset?: number; limit?: number; archived?: string } = {},
  ): UpstreamResponse {
    const payload = parseResponse(response)
    if (!payload) return response
    const collectionKey = Array.isArray(payload.items)
      ? 'items'
      : Array.isArray(payload.sessions) ? 'sessions' : undefined
    if (!collectionKey) return response

    const rows = (fallbackProfile
      ? this.db.prepare(`SELECT profile,session_id,source,data,authoritative_title,last_synced_at FROM chat_sessions
          WHERE owner=? AND profile=? AND owned_at IS NOT NULL`)
          .all(owner, fallbackProfile)
      : this.db.prepare(`SELECT profile,session_id,source,data,authoritative_title,last_synced_at FROM chat_sessions
          WHERE owner=? AND owned_at IS NOT NULL`).all(owner)) as Array<{
            profile: string
            session_id: string
            source: string
            data: string
            authoritative_title: string | null
            last_synced_at: number
          }>
    const owned = new Map(rows.map(row => [
      `${row.profile}\u0000${row.session_id}`,
      row,
    ]))
    const merged = new Map<string, Record<string, unknown>>()
    for (const [key, row] of owned) {
      let stored: Record<string, unknown> = {}
      try { stored = object(JSON.parse(row.data)) ?? {} } catch { /* Ignore damaged display metadata. */ }
      const storedSource = sessionSource(stored)
      merged.set(key, {
        ...stored,
        id: row.session_id,
        profile: row.profile,
        source: storedSource && storedSource !== 'unknown' ? storedSource : row.source,
        ...(row.authoritative_title?.trim() ? { title: row.authoritative_title.trim() } : {}),
        _yaoyao_registry_activity: row.last_synced_at,
        owned: true,
      })
    }
    for (const value of payload[collectionKey] as unknown[]) {
      const session = object(value)
      if (!session) continue
      const id = sessionIDOf(session)
      const profile = profileOf(session, fallbackProfile) || 'default'
      if (!id) continue
      const key = `${profile}\u0000${id}`
      const row = owned.get(key)
      if (row) {
        const title = row.authoritative_title?.trim()
        merged.set(key, {
          ...merged.get(key),
          ...session,
          ...(title ? { title } : {}),
          _yaoyao_registry_activity: row.last_synced_at,
          owned: true,
        })
      }
    }
    const activity = (session: Record<string, unknown>): number => Number(
      session.last_active_at
        ?? session.last_active
        ?? session.updated_at
        ?? session.started_at
        ?? session._yaoyao_registry_activity
        ?? 0,
    ) || 0
    const archived = (session: Record<string, unknown>): boolean => bool(
      session.is_archived ?? session.isArchived ?? session.archived,
    )
    const pinned = (session: Record<string, unknown>): boolean => bool(
      session.is_pinned ?? session.isPinned ?? session.pinned,
    )
    const archivedMode = page.archived ?? 'exclude'
    const allSessions = [...merged.values()]
      .filter(session => archivedMode === 'include'
        || (archivedMode === 'only' ? archived(session) : !archived(session)))
      .sort((left, right) => Number(pinned(right)) - Number(pinned(left))
        || activity(right) - activity(left))
    const offset = Math.max(0, Math.trunc(page.offset ?? 0))
    const limit = Math.max(1, Math.min(500, Math.trunc(page.limit ?? 100)))
    const sessions = allSessions.slice(offset, offset + limit).map((session) => {
      const publicSession = { ...session }
      delete publicSession._yaoyao_registry_activity
      return publicSession
    })
    const body = Buffer.from(JSON.stringify({
      ...payload,
      [collectionKey]: sessions,
      total: allSessions.length,
      offset,
      limit,
    }))
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return { ...response, headers, body }
  }

  excludeOwnedSessionsFromList(
    owner: string,
    fallbackProfile: string,
    response: UpstreamResponse,
    page: { offset?: number; limit?: number } = {},
  ): UpstreamResponse {
    const payload = parseResponse(response)
    if (!payload) return response
    const collectionKey = Array.isArray(payload.items)
      ? 'items'
      : Array.isArray(payload.sessions) ? 'sessions' : undefined
    if (!collectionKey) return response
    const allSessions = (payload[collectionKey] as unknown[]).filter((value) => {
      const session = object(value)
      if (!session) return true
      const id = sessionIDOf(session)
      const profile = profileOf(session, fallbackProfile) || 'default'
      return !id || !this.ownsSession(owner, profile, id)
    })
    const offset = Math.max(0, Math.trunc(page.offset ?? 0))
    const limit = Math.max(1, Math.min(500, Math.trunc(page.limit ?? 100)))
    const sessions = allSessions.slice(offset, offset + limit)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return {
      ...response,
      headers,
      body: Buffer.from(JSON.stringify({
        ...payload,
        [collectionKey]: sessions,
        total: allSessions.length,
        offset,
        limit,
      })),
    }
  }

  markSessionOwnership(
    owner: string,
    fallbackProfile: string,
    sessionID: string,
    response: UpstreamResponse,
  ): UpstreamResponse {
    const payload = parseResponse(response)
    if (!payload) return response
    const session = object(payload.session)
    const candidate = session ?? payload
    const id = sessionIDOf(candidate) || sessionID
    const profile = profileOf(candidate, fallbackProfile) || fallbackProfile || 'default'
    const row = this.db.prepare(`SELECT authoritative_title FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=? AND owned_at IS NOT NULL`).get(owner, profile, id) as { authoritative_title?: string | null } | undefined
    const owned = Boolean(row)
    const title = String(row?.authoritative_title ?? '').trim()
    const body = session
      ? Buffer.from(JSON.stringify({
          ...payload,
          session: { ...session, ...(title ? { title } : {}), owned },
          owned,
        }))
      : Buffer.from(JSON.stringify({ ...payload, ...(title ? { title } : {}), owned }))
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return { ...response, headers, body }
  }

  markOwnedSearchResults(
    owner: string,
    fallbackProfile: string,
    response: UpstreamResponse,
    view?: 'chat' | 'history',
    limit = 100,
  ): UpstreamResponse {
    const payload = parseResponse(response)
    if (!payload || !Array.isArray(payload.results)) return response
    const marked = payload.results.map((value) => {
      const session = object(value)
      if (!session) return value
      const id = sessionIDOf(session)
      const profile = profileOf(session, fallbackProfile) || fallbackProfile || 'default'
      const metadata = id
        ? this.ownedSessionMetadata(owner, profile, id)
        : { owned: false }
      return {
        ...session,
        ...(metadata.authoritativeTitle ? { title: metadata.authoritativeTitle } : {}),
        owned: metadata.owned,
      }
    })
    const projected = marked.filter((value) => {
      if (!view) return true
      const session = object(value)
      if (!session) return false
      return view === 'chat' ? session.owned === true : session.owned !== true
    })
    const results = projected.slice(0, Math.max(1, Math.min(100, Math.trunc(limit))))
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return {
      ...response,
      headers,
      body: Buffer.from(JSON.stringify({ ...payload, results, total: projected.length })),
    }
  }

  storeAttachment(owner: string, sourcePath: string, response: UpstreamResponse): string | undefined {
    if (response.status !== 200 || !response.body.length) return undefined
    const sha256 = createHash('sha256').update(response.body).digest('hex')
    const directory = join(this.assetsRoot, sha256.slice(0, 2))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, sha256)
    if (!existsSync(target)) {
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, response.body, { mode: 0o600 })
      renameSync(temporary, target)
    }
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]
    this.db.prepare(`UPDATE chat_attachments SET sha256=?,mime_type=?,size=?,local_path=?,state='cached',updated_at=?
      WHERE owner=? AND source_path=?`).run(sha256, mimeType ?? null, response.body.length, target, Date.now(), owner, sourcePath)
    return target
  }

  assetStream(path: string): { stream: ReturnType<typeof createReadStream>; size: number } {
    return { stream: createReadStream(path), size: statSync(path).size }
  }

  private payloadBelongsToOwnedChat(owner: string, profile: string, sessionID: string | undefined,
    payload: Record<string, unknown>): boolean {
    const session = object(payload.session) ?? (sessionID ? payload : undefined)
    if (session) {
      const id = sessionIDOf(session) || sessionID || ''
      const sessionProfile = profileOf(session, profile) || profile || 'default'
      if (id && this.ownsSession(owner, sessionProfile, id)) return true
    }
    const sessions = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.sessions) ? payload.sessions : []
    if (sessions.some(value => {
      const candidate = object(value)
      if (!candidate) return false
      const id = sessionIDOf(candidate)
      const sessionProfile = profileOf(candidate, profile) || profile || 'default'
      return Boolean(id && this.ownsSession(owner, sessionProfile, id))
    })) return true
    return Boolean(sessionID && this.ownsSession(owner, profile || 'default', sessionID))
  }

  private ingestPayload(owner: string, fallbackProfile: string, sessionID: string | undefined,
    payload: Record<string, unknown>, now: number, kind: string, requestStartedAt: number): void {
    const candidates: Record<string, unknown>[] = []
    const direct = object(payload.session)
    if (direct) candidates.push(direct)
    const listed = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.sessions) ? payload.sessions : []
    for (const value of listed) if (object(value)) candidates.push(object(value)!)
    if (sessionID && !direct && (sessionIDOf(payload) || sessionSource(payload) || typeof payload.title === 'string')) {
      candidates.push(payload)
    }
    for (const session of candidates) {
      const id = sessionIDOf(session) || sessionID || ''
      if (!id) continue
      const profile = profileOf(session, fallbackProfile) || fallbackProfile || 'default'
      const registered = this.ownsSession(owner, profile, id)
      const source = sessionSource(session)
      if (!registered) continue
      const titleRow = this.db.prepare(`SELECT authoritative_title,authoritative_title_at FROM chat_sessions
        WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, id) as {
          authoritative_title?: string | null; authoritative_title_at?: number
        } | undefined
      const authoritativeTitle = String(titleRow?.authoritative_title ?? '').trim()
      const authoritativeTitleAt = Number(titleRow?.authoritative_title_at ?? 0)
      const incomingTitle = sessionTitle(session)
      const preservesAuthoritativeTitle = Boolean(authoritativeTitle)
        && (kind !== 'detail' || isPlaceholderTitle(incomingTitle)
          || requestStartedAt <= authoritativeTitleAt)
      const storedSession = preservesAuthoritativeTitle
        ? { ...session, title: authoritativeTitle }
        : session
      this.db.prepare(`INSERT INTO chat_sessions(owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_synced_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET data=excluded.data,
        source=CASE WHEN excluded.source='unknown' THEN chat_sessions.source ELSE excluded.source END,
        sync_state='current',last_synced_at=excluded.last_synced_at`)
        .run(owner, profile, id, null, source || 'unknown', JSON.stringify(storedSession), 'current', 0, now)
      const acceptedTitle = sessionTitle(storedSession)
      if (acceptedTitle && !isPlaceholderTitle(acceptedTitle)
        && (!authoritativeTitle || kind === 'detail')) {
        this.db.prepare(`UPDATE chat_sessions SET authoritative_title=?,authoritative_title_at=?
          WHERE owner=? AND profile=? AND session_id=?`).run(
            acceptedTitle,
            Math.max(requestStartedAt, authoritativeTitleAt),
            owner,
            profile,
            id,
          )
      }
    }
    const messages = Array.isArray(payload.messages) ? payload.messages.flatMap(value => object(value) ? [object(value)!] : []) : []
    if (!messages.length || !sessionID) return
    const profile = fallbackProfile || profileOf(direct ?? {}, 'default') || 'default'
    const pagination = object(payload.pagination) ?? {}
    const total = Math.max(messages.length, Number(pagination.total ?? payload.total ?? messages.length) || messages.length)
    const offset = Math.max(0, Number(pagination.offset ?? payload.offset ?? 0) || 0)
    const start = Math.max(0, total - offset - messages.length)
    messages.forEach((message, index) => {
      const data = JSON.stringify(message)
      this.db.prepare(`INSERT INTO chat_messages(owner,profile,session_id,message_id,position,data,content_hash)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id,message_id) DO UPDATE SET position=excluded.position,
        data=excluded.data,content_hash=excluded.content_hash`)
        .run(owner, profile, sessionID, messageID(message, String(start + index)), start + index, data,
          createHash('sha256').update(data).digest('hex'))
      for (const sourcePath of referencedPaths(message)) {
        this.db.prepare(`INSERT INTO chat_attachments(owner,profile,session_id,source_path,state,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id,source_path) DO UPDATE SET updated_at=excluded.updated_at`)
          .run(owner, profile, sessionID, sourcePath, 'pending', now)
      }
    })
    const hasMore = bool(pagination.hasMore ?? pagination.has_more ?? payload.hasMore ?? payload.has_more)
    const complete = !hasMore && offset + messages.length >= total
    this.db.prepare(`UPDATE chat_sessions SET complete=MAX(complete,?),sync_state='current',last_synced_at=?
      WHERE owner=? AND profile=? AND session_id=?`).run(complete ? 1 : 0, now, owner, profile, sessionID)
  }

  private updateOwnedSessionTitle(owner: string, profile: string, sessionID: string, title: string, now: number): void {
    const row = this.db.prepare(`SELECT source,data FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=? AND owned_at IS NOT NULL`).get(owner, profile, sessionID) as Record<string, unknown> | undefined
    if (!row) return
    let summary: Record<string, unknown> = {}
    try { summary = object(JSON.parse(String(row.data))) ?? {} } catch { /* Rebuild damaged display metadata below. */ }
    const storedSource = sessionSource(summary)
    const source = storedSource && storedSource !== 'unknown'
      ? storedSource
      : String(row.source || 'unknown')
    this.db.prepare(`UPDATE chat_sessions SET data=?,authoritative_title=?,authoritative_title_at=?,sync_state='stale',last_synced_at=?
      WHERE owner=? AND profile=? AND session_id=?`).run(JSON.stringify({
      ...summary,
      id: sessionID,
      profile,
      source,
      title,
    }), title, now, now, owner, profile, sessionID)
  }
}

export class ChatCacheCoordinator {
  private reconciling = new Map<string, Promise<void>>()
  constructor(readonly store: ChatCacheStore, readonly upstream: UpstreamServiceSession,
    readonly mode: ChatCacheMode = 'prefer-local') {}

  async read(owner: string, key: string, kind: string, profile: string, sessionID: string | undefined,
    load: () => Promise<UpstreamResponse>, ownedList = false,
    listPage: { offset?: number; limit?: number; archived?: string } = {}): Promise<{ response: UpstreamResponse; source: ChatCacheSource; state: ChatCacheState }> {
    if (this.mode === 'upstream-only') {
      const upstreamResponse = await load()
      return {
        response: kind === 'list' && ownedList
          ? this.store.mergeOwnedSessionsIntoList(owner, profile, upstreamResponse, listPage)
          : upstreamResponse,
        source: 'upstream',
        state: 'current',
      }
    }
    const local = this.store.snapshot(owner, key)
    const projectedLocal = local && kind === 'list' && ownedList
      ? {
          ...local,
          response: this.store.mergeOwnedSessionsIntoList(owner, profile, local.response, listPage),
        }
      : local
    if (this.mode === 'prefer-local' && local?.state === 'current') {
      return { response: local.response, source: 'local', state: local.state }
    }
    try {
      const requestStartedAt = Date.now()
      const upstreamResponse = await load()
      if (this.mode === 'prefer-local' && local && upstreamResponse.status >= 500) {
        return { response: projectedLocal!.response, source: 'local', state: 'stale' }
      }
      const response = kind === 'list' && ownedList
        ? this.store.mergeOwnedSessionsIntoList(
            owner,
            profile,
            upstreamResponse,
            listPage,
          )
        : upstreamResponse
      this.store.putSnapshot(owner, key, kind, profile, sessionID, response, ownedList, requestStartedAt)
      return { response, source: 'upstream', state: 'current' }
    } catch (error) {
      if (this.mode === 'prefer-local' && local) return { response: projectedLocal!.response, source: 'local', state: 'stale' }
      throw error
    }
  }

  async messages(owner: string, key: string, profile: string, sessionID: string, offset: number, limit: number,
    load: () => Promise<UpstreamResponse>): Promise<{ response: UpstreamResponse; source: ChatCacheSource; state: ChatCacheState }> {
    if (this.mode === 'prefer-local') {
      const page = this.store.messagePage(owner, profile, sessionID, offset, limit)
      if (page?.state === 'current') return { response: page.response, source: 'local', state: page.state }
    }
    const result = await this.read(owner, key, 'messages', profile, sessionID, load)
    if (result.source === 'upstream'
      && this.store.ownsSession(owner, profile, sessionID)
      && !this.store.messagePage(owner, profile, sessionID, 0, 1)) {
      void this.reconcile(owner, profile, sessionID)
    }
    return result
  }

  observe(owner: string, profile: string, sessionID: string, frame: Record<string, unknown>): void {
    this.store.recordEvent(owner, profile, sessionID, frame)
    if (this.mode !== 'upstream-only' && String(frame.type) === 'message.complete') {
      void this.reconcile(owner, profile, sessionID)
    }
  }

  observeGlobal(owner: string, type: string): void {
    if (type === 'sessions.changed') this.store.markListsStale(owner)
  }

  command(owner: string, profile: string, sessionID: string, method: string,
    params: Record<string, unknown>): void {
    this.store.recordCommand(owner, profile, sessionID, method, params)
  }

  route(owner: string, profile: string, sessionID: string, runtimeID: string): void {
    this.store.recordRoute(owner, profile, sessionID, runtimeID)
  }

  async reconcile(owner: string, profile: string, sessionID: string): Promise<void> {
    if (this.mode === 'upstream-only') return
    const key = JSON.stringify([owner, profile, sessionID])
    if (this.reconciling.has(key)) return this.reconciling.get(key)
    const task = (async () => {
      const detailPath = `/api/sessions/${encodeURIComponent(sessionID)}`
      const detailSearch = new URLSearchParams({ profile })
      const detailStartedAt = Date.now()
      const detail = await this.upstream.request(detailPath, { search: detailSearch })
      this.store.putSnapshot(owner, `detail:${profile}:${sessionID}`, 'detail', profile, sessionID, detail, false, detailStartedAt)
      let offset = 0
      for (let page = 0; page < 200; page++) {
        const search = new URLSearchParams({ profile, offset: String(offset), limit: '500', order: 'latest', include_compacted: 'true' })
        const messagesStartedAt = Date.now()
        const response = await this.upstream.request(`${detailPath}/messages`, { search })
        if (!this.store.putSnapshot(owner, `messages:${profile}:${sessionID}:${offset}:500`, 'messages', profile, sessionID, response, false, messagesStartedAt)) return
        const payload = parseResponse(response)
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const pagination = object(payload?.pagination) ?? {}
        if (!bool(pagination.hasMore ?? pagination.has_more ?? payload?.hasMore ?? payload?.has_more) || !messages.length) return
        offset += messages.length
      }
    })().catch(() => {}).finally(() => this.reconciling.delete(key))
    this.reconciling.set(key, task)
    return task
  }

  async cacheAttachment(owner: string, sourcePath: string): Promise<void> {
    if (this.mode === 'upstream-only' || !this.store.knowsAttachment(owner, sourcePath) || this.store.attachment(owner, sourcePath)) return
    try {
      const response = await this.upstream.request('/api/files/download', {
        search: new URLSearchParams({ path: sourcePath }), maxResponseBytes: 100 * 1_024 * 1_024,
      })
      this.store.storeAttachment(owner, sourcePath, response)
    } catch { /* The next authorized request can retry. */ }
  }
}

export function chatCacheKey(kind: string, profile: string, sessionID: string | undefined, search: URLSearchParams): string {
  const normalized = new URLSearchParams(search)
  normalized.sort()
  return [kind, profile, sessionID ?? '', normalized.toString()].join(':')
}
