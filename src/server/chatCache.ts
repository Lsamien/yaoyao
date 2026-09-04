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

  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const path = join(home, 'chat-cache.sqlite3')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.assetsRoot = join(home, 'chat-cache-assets')
    mkdirSync(this.assetsRoot, { recursive: true, mode: 0o700 })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chat_sessions(
        owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
        runtime_id TEXT, source TEXT NOT NULL, data TEXT NOT NULL,
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
        saved_at INTEGER NOT NULL, PRIMARY KEY(owner,cache_key));`)
  }

  close(): void { this.db.close() }

  stats(): Record<string, number> {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count)
    const bytes = Number((this.db.prepare(`SELECT COALESCE(SUM(size),0) bytes FROM chat_attachments WHERE state='cached'`).get() as { bytes: number }).bytes)
    return {
      sessions: count('chat_sessions'),
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
    response: UpstreamResponse, knownWeb = false): boolean {
    const payload = parseResponse(response)
    if (!payload) return false
    if (kind === 'list' && !knownWeb) return false
    const isWeb = knownWeb || this.payloadIsWeb(owner, profile, sessionID, payload)
    if (!isWeb) return false
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.ingestPayload(owner, profile, sessionID, payload, now)
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
      WHERE owner=? AND profile=? AND session_id=? AND source='web'`).get(owner, profile, sessionID) as Record<string, unknown> | undefined
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
    this.db.prepare(`UPDATE chat_snapshots SET sync_state=? WHERE owner=? AND (session_id=? OR kind='list')`)
      .run(state, owner, sessionID)
    this.db.prepare(`INSERT INTO chat_sync_cursors(owner,profile,event_cursor,sync_state,last_synced_at)
      VALUES(?,?,?,?,?) ON CONFLICT(owner,profile) DO UPDATE SET event_cursor=MAX(event_cursor,excluded.event_cursor),
      sync_state=excluded.sync_state,last_synced_at=excluded.last_synced_at`)
      .run(owner, profile, rawSeq > 0 ? rawSeq : lastSeen, state, now)
  }

  recordRoute(owner: string, profile: string, sessionID: string, runtimeID: string): void {
    const now = Date.now()
    const summary = { id: sessionID, profile, source: 'web', title: '新对话', started_at: now, last_active: now }
    this.db.prepare(`INSERT INTO chat_sessions(owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_synced_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET runtime_id=excluded.runtime_id,
      source='web',last_synced_at=excluded.last_synced_at`)
      .run(owner, profile, sessionID, runtimeID, 'web', JSON.stringify(summary), 'stale', 0, now)
  }

  recordCommand(owner: string, profile: string, sessionID: string, method: string,
    params: Record<string, unknown>): void {
    const now = Date.now()
    const summary = { id: sessionID, profile, source: 'web', title: '新对话', started_at: now, last_active: now }
    this.db.prepare(`INSERT INTO chat_sessions(owner,profile,session_id,source,data,sync_state,complete,last_synced_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET sync_state='stale',complete=0`)
      .run(owner, profile, sessionID, 'web', JSON.stringify(summary), 'stale', 0, now)
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

  isWebSession(owner: string, profile: string, sessionID: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 ok FROM chat_sessions WHERE owner=? AND profile=? AND session_id=? AND source='web'")
      .get(owner, profile, sessionID))
  }

  ownsSession(owner: string, profile: string, sessionID: string): boolean {
    return Boolean(this.db.prepare(
      'SELECT 1 ok FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?',
    ).get(owner, profile, sessionID))
  }

  mergeOwnedSessionsIntoList(
    owner: string,
    fallbackProfile: string,
    response: UpstreamResponse,
  ): UpstreamResponse {
    const payload = parseResponse(response)
    if (!payload) return response
    const collectionKey = Array.isArray(payload.items)
      ? 'items'
      : Array.isArray(payload.sessions) ? 'sessions' : undefined
    if (!collectionKey) return response

    const rows = (fallbackProfile
      ? this.db.prepare(`SELECT profile,session_id,data FROM chat_sessions
          WHERE owner=? AND profile=? ORDER BY last_synced_at DESC LIMIT 1000`)
          .all(owner, fallbackProfile)
      : this.db.prepare(`SELECT profile,session_id,data FROM chat_sessions
          WHERE owner=? ORDER BY last_synced_at DESC LIMIT 1000`).all(owner)) as Array<{
            profile: string
            session_id: string
            data: string
          }>
    const owned = new Map(rows.map(row => [
      `${row.profile}\u0000${row.session_id}`,
      row,
    ]))
    const merged = new Map<string, Record<string, unknown>>()
    for (const value of payload[collectionKey] as unknown[]) {
      const session = object(value)
      if (!session) continue
      const id = sessionIDOf(session)
      const profile = profileOf(session, fallbackProfile) || 'default'
      if (!id) continue
      const key = `${profile}\u0000${id}`
      if (sessionSource(session) === 'web' || owned.has(key)) {
        merged.set(key, { ...session, source: 'web' })
      }
    }
    for (const [key, row] of owned) {
      if (merged.has(key)) continue
      let stored: Record<string, unknown> = {}
      try { stored = object(JSON.parse(row.data)) ?? {} } catch { /* Ignore damaged display metadata. */ }
      merged.set(key, {
        ...stored,
        id: row.session_id,
        profile: row.profile,
        source: 'web',
      })
    }
    const activity = (session: Record<string, unknown>): number => Number(
      session.last_active_at
        ?? session.last_active
        ?? session.updated_at
        ?? session.started_at
        ?? 0,
    ) || 0
    const sessions = [...merged.values()].sort((left, right) =>
      activity(right) - activity(left))
    const body = Buffer.from(JSON.stringify({
      ...payload,
      [collectionKey]: sessions,
      total: Math.max(Number(payload.total) || 0, sessions.length),
    }))
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return { ...response, headers, body }
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

  private payloadIsWeb(owner: string, profile: string, sessionID: string | undefined, payload: Record<string, unknown>): boolean {
    const session = object(payload.session) ?? (sessionID ? payload : undefined)
    if (session && sessionSource(session) === 'web') return true
    const sessions = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.sessions) ? payload.sessions : []
    if (sessions.some(value => object(value) && sessionSource(object(value)!) === 'web')) return true
    if (!sessionID) return false
    return Boolean(this.db.prepare("SELECT 1 ok FROM chat_sessions WHERE owner=? AND profile=? AND session_id=? AND source='web'")
      .get(owner, profile, sessionID))
  }

  private ingestPayload(owner: string, fallbackProfile: string, sessionID: string | undefined,
    payload: Record<string, unknown>, now: number): void {
    const candidates: Record<string, unknown>[] = []
    const direct = object(payload.session)
    if (direct) candidates.push(direct)
    const listed = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.sessions) ? payload.sessions : []
    for (const value of listed) if (object(value)) candidates.push(object(value)!)
    if (sessionID && !direct && sessionSource(payload)) candidates.push(payload)
    for (const session of candidates) {
      if (sessionSource(session) !== 'web') continue
      const id = sessionIDOf(session)
      if (!id) continue
      const profile = profileOf(session, fallbackProfile) || fallbackProfile || 'default'
      this.db.prepare(`INSERT INTO chat_sessions(owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_synced_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET data=excluded.data,source='web',
        sync_state='current',last_synced_at=excluded.last_synced_at`)
        .run(owner, profile, id, null, 'web', JSON.stringify(session), 'current', 0, now)
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
}

export class ChatCacheCoordinator {
  private reconciling = new Map<string, Promise<void>>()
  constructor(readonly store: ChatCacheStore, readonly upstream: UpstreamServiceSession,
    readonly mode: ChatCacheMode = 'prefer-local') {}

  async read(owner: string, key: string, kind: string, profile: string, sessionID: string | undefined,
    load: () => Promise<UpstreamResponse>, knownWeb = false): Promise<{ response: UpstreamResponse; source: ChatCacheSource; state: ChatCacheState }> {
    if (this.mode === 'upstream-only') return { response: await load(), source: 'upstream', state: 'current' }
    const local = this.store.snapshot(owner, key)
    if (this.mode === 'prefer-local' && local?.state === 'current') {
      return { response: local.response, source: 'local', state: local.state }
    }
    try {
      const upstreamResponse = await load()
      if (this.mode === 'prefer-local' && local && upstreamResponse.status >= 500) {
        return { response: local.response, source: 'local', state: 'stale' }
      }
      const response = kind === 'list' && knownWeb
        ? this.store.mergeOwnedSessionsIntoList(
            owner,
            profile,
            upstreamResponse,
          )
        : upstreamResponse
      this.store.putSnapshot(owner, key, kind, profile, sessionID, response, knownWeb)
      return { response, source: 'upstream', state: 'current' }
    } catch (error) {
      if (this.mode === 'prefer-local' && local) return { response: local.response, source: 'local', state: 'stale' }
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
      && this.store.isWebSession(owner, profile, sessionID)
      && !this.store.messagePage(owner, profile, sessionID, 0, 1)) {
      void this.reconcile(owner, profile, sessionID)
    }
    return result
  }

  observe(owner: string, profile: string, sessionID: string, frame: Record<string, unknown>): void {
    if (this.mode === 'upstream-only') return
    this.store.recordEvent(owner, profile, sessionID, frame)
    if (String(frame.type) === 'message.complete') void this.reconcile(owner, profile, sessionID)
  }

  observeGlobal(owner: string, type: string): void {
    if (this.mode !== 'upstream-only' && type === 'sessions.changed') this.store.markListsStale(owner)
  }

  command(owner: string, profile: string, sessionID: string, method: string,
    params: Record<string, unknown>): void {
    if (this.mode !== 'upstream-only') this.store.recordCommand(owner, profile, sessionID, method, params)
  }

  route(owner: string, profile: string, sessionID: string, runtimeID: string): void {
    if (this.mode !== 'upstream-only') this.store.recordRoute(owner, profile, sessionID, runtimeID)
  }

  async reconcile(owner: string, profile: string, sessionID: string): Promise<void> {
    if (this.mode === 'upstream-only') return
    const key = JSON.stringify([owner, profile, sessionID])
    if (this.reconciling.has(key)) return this.reconciling.get(key)
    const task = (async () => {
      const detailPath = `/api/sessions/${encodeURIComponent(sessionID)}`
      const detailSearch = new URLSearchParams({ profile })
      const detail = await this.upstream.request(detailPath, { search: detailSearch })
      this.store.putSnapshot(owner, `detail:${profile}:${sessionID}`, 'detail', profile, sessionID, detail)
      let offset = 0
      for (let page = 0; page < 200; page++) {
        const search = new URLSearchParams({ profile, offset: String(offset), limit: '500', order: 'latest', include_compacted: 'true' })
        const response = await this.upstream.request(`${detailPath}/messages`, { search })
        if (!this.store.putSnapshot(owner, `messages:${profile}:${sessionID}:${offset}:500`, 'messages', profile, sessionID, response)) return
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
