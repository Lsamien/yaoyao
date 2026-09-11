import { projectChatEvent } from './chatEventProjection.js'
import { isFinalChatResult } from './chatUnread.js'
import { HttpError } from './errors.js'
import { createHash, randomUUID } from 'node:crypto'
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

// Hermes uses Unix seconds; local route registration uses milliseconds. Keep
// the public summary in seconds so Web and iOS compare the same activity time.
function timestampSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const numeric = Number(value)
  const seconds = Number.isFinite(numeric)
    ? numeric > 10_000_000_000 ? numeric / 1_000 : numeric
    : typeof value === 'string' ? Date.parse(value) / 1_000 : NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function firstTimestamp(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const timestamp = timestampSeconds(value[key])
    if (timestamp !== undefined) return timestamp
  }
  return undefined
}

const START_TIME_KEYS = ['started_at', 'startedAt', 'session_started', 'created_at', 'createdAt']
const ACTIVITY_TIME_KEYS = ['last_active', 'last_active_at', 'last_activity_at', 'lastActive', 'updated_at', 'updatedAt']

function mergeSessionMetadata(previous: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const summary = { ...previous, ...incoming }
  // A messages response can carry title/model metadata, but its envelope is
  // not a replacement for the session detail.
  delete summary.messages
  delete summary.pagination
  const started = firstTimestamp(incoming, START_TIME_KEYS) ?? firstTimestamp(previous, START_TIME_KEYS)
  const activity = firstTimestamp(incoming, ACTIVITY_TIME_KEYS) ?? firstTimestamp(previous, ACTIVITY_TIME_KEYS)
  if (started !== undefined) summary.started_at = started
  if (activity !== undefined) summary.last_active = activity
  return summary
}

function messageTimeBounds(messages: Record<string, unknown>[]): { first?: number; last?: number } {
  let first: number | undefined
  let last: number | undefined
  for (const message of messages) {
    const time = firstTimestamp(message, ['timestamp', 'created_at', 'createdAt'])
    if (time === undefined) continue
    first = Math.min(first ?? time, time)
    last = Math.max(last ?? time, time)
  }
  return { first, last }
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
  private closed = false
  get isClosed(): boolean { return this.closed }

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_local_state(
      owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL,
      pinned INTEGER, read_count INTEGER NOT NULL DEFAULT 0,
      assistant_id TEXT, PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_session_aliases(owner TEXT NOT NULL,profile TEXT NOT NULL,alias_id TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(owner,profile,alias_id));
      CREATE TABLE IF NOT EXISTS chat_recovery_jobs(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,force INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_event_receipts(
      owner TEXT NOT NULL, profile TEXT NOT NULL, session_id TEXT NOT NULL, event_id TEXT NOT NULL,
      PRIMARY KEY(owner,profile,session_id,event_id));`)
    const localColumns=this.db.prepare('PRAGMA table_info(chat_local_state)').all() as {name:string}[]
    for(const [name,type] of [['title','TEXT'],['archived','INTEGER'],['read_initialized','INTEGER NOT NULL DEFAULT 0'],['final_read_count','INTEGER']]){
      if(!localColumns.some(c=>c.name===name))this.db.exec(`ALTER TABLE chat_local_state ADD COLUMN ${name} ${type}`)
    }
    const sessionColumns = this.db.prepare('PRAGMA table_info(chat_sessions)').all() as Array<{ name: string }>
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!sessionColumns.some(column => column.name === 'sync_revision')) {
        this.db.exec('ALTER TABLE chat_sessions ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0')
      }
      if (!sessionColumns.some(column => column.name === 'message_total')) {
        this.db.exec('ALTER TABLE chat_sessions ADD COLUMN message_total INTEGER')
      }
      if (!sessionColumns.some(column => column.name === 'metadata_complete')) {
        this.db.exec('ALTER TABLE chat_sessions ADD COLUMN metadata_complete INTEGER NOT NULL DEFAULT 0')
        this.db.exec("UPDATE chat_sessions SET metadata_complete=1 WHERE json_valid(data) AND (json_type(data,'$.message_count') IS NOT NULL OR json_type(data,'$.model') IS NOT NULL)")
      }
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
      if (!this.db.prepare("SELECT 1 FROM chat_meta WHERE key='session-activity-v1'").get()) {
        const rows = this.db.prepare(`SELECT owner,profile,session_id,source,data,owned_at,message_total
          FROM chat_sessions WHERE owned_at IS NOT NULL`).all() as Array<{
            owner: string; profile: string; session_id: string; source: string; data: string
            owned_at: number; message_total: number | null
          }>
        const update = this.db.prepare(`UPDATE chat_sessions SET data=? WHERE owner=? AND profile=? AND session_id=?`)
        for (const row of rows) {
          let stored: Record<string, unknown>
          try { stored = object(JSON.parse(row.data)) ?? {} } catch { continue }
          const summary = mergeSessionMetadata({}, stored)
          if (Array.isArray(stored.messages) || !firstTimestamp(summary, START_TIME_KEYS)
            || !firstTimestamp(summary, ACTIVITY_TIME_KEYS)) {
            const messages = this.db.prepare(`SELECT data FROM chat_messages WHERE owner=? AND profile=? AND session_id=?`)
              .all(row.owner, row.profile, row.session_id) as Array<{ data: string }>
            const bounds = messageTimeBounds(messages.flatMap(message => {
              try { return [object(JSON.parse(message.data)) ?? {}] } catch { return [] }
            }))
            summary.started_at = firstTimestamp(summary, START_TIME_KEYS) ?? bounds.first ?? timestampSeconds(row.owned_at)
            summary.last_active = Math.max(firstTimestamp(summary, ACTIVITY_TIME_KEYS) ?? 0,
              bounds.last ?? 0) || summary.started_at
            if (row.message_total !== null) summary.message_count = row.message_total
          }
          summary.id = row.session_id
          summary.profile = row.profile
          summary.source = sessionSource(summary) || row.source
          update.run(JSON.stringify(summary), row.owner, row.profile, row.session_id)
        }
        this.db.prepare("INSERT INTO chat_meta(key,value) VALUES('session-activity-v1','complete')").run()
      }
      // List bodies written before ownership became an explicit projection do
      // not carry `owned` and may have been filtered by `source`. Rebuild them on
      // first use after every restart instead of serving a semantically old page.
      this.db.prepare("UPDATE chat_snapshots SET sync_state='stale' WHERE kind='list'").run()
      this.db.prepare(`INSERT INTO chat_meta(key,value) VALUES('ownership-registry-v1','complete')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run()
    this.db.prepare(`INSERT OR IGNORE INTO chat_local_state(owner,profile,session_id)
      SELECT owner,profile,session_id FROM chat_sessions WHERE owned_at IS NOT NULL`).run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void { this.closed = true; this.db.close() }

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

  localList(owner: string, profile: string, page: { offset?: number; limit?: number; archived?: string }): UpstreamResponse {
    const offset = Math.max(0, Math.trunc(page.offset ?? 0)), limit = Math.max(1, Math.min(200, Math.trunc(page.limit ?? 100)))
    const where = `s.owner=? AND s.owned_at IS NOT NULL AND (?='' OR s.profile=?)
      AND s.source NOT IN ('cron','ios_group','yaoyao_workspace')
      AND (?='include' OR COALESCE(l.archived,json_extract(s.data,'$.archived'),json_extract(s.data,'$.is_archived'),0)=CASE WHEN ?='only' THEN 1 ELSE 0 END)`
    const args = [owner, profile, profile, page.archived ?? 'exclude', page.archived ?? 'exclude']
    const total = Number((this.db.prepare(`SELECT count(*) n FROM chat_sessions s LEFT JOIN chat_local_state l USING(owner,profile,session_id) WHERE ${where}`).get(...args) as {n:number}).n)
    const rows = this.db.prepare(`SELECT s.profile,s.session_id,s.data,s.sync_state,s.complete,l.title local_title,
      COALESCE(l.pinned,json_extract(s.data,'$.pinned'),json_extract(s.data,'$.is_pinned'),0) pin
      FROM chat_sessions s LEFT JOIN chat_local_state l USING(owner,profile,session_id) WHERE ${where}
      ORDER BY pin DESC, COALESCE(json_extract(s.data,'$.last_active'),0) DESC, s.session_id
      LIMIT ? OFFSET ?`).all(...args, limit, offset) as Array<Record<string,any>>
    const unread = new Map(this.unread(owner, profile).sessions.map(row => [JSON.stringify([row.profile, row.session_id]), row.final_unread_count]))
    return {status:200,headers:new Headers({'content-type':'application/json'}),body:Buffer.from(JSON.stringify({
      sessions:rows.map(r=>({...JSON.parse(r.data),...(r.local_title!=null?{title:r.local_title}:{}),id:r.session_id,profile:r.profile,owned:true,pinned:!!r.pin,
        final_unread_count:unread.get(JSON.stringify([r.profile,r.session_id]))??0,
        sync_state:r.sync_state,history_complete:!!r.complete})), total,offset,limit,
      sync_state:this.needsListMetadata(owner,profile)?'syncing':'current'
    }))}
  }

  missingSessions(owner: string, profile: string): Array<{profile:string;session_id:string}> {
    return (this.db.prepare(`SELECT profile,session_id FROM chat_sessions WHERE owner=? AND owned_at IS NOT NULL
      AND (?='' OR profile=?) AND (metadata_complete=0 OR complete=0) LIMIT 100`)
      .all(owner,profile,profile) as {profile:string;session_id:string}[])
  }

  pins(owner: string, profile: string): string[] {
    return (this.db.prepare(`SELECT s.session_id FROM chat_sessions s LEFT JOIN chat_local_state l USING(owner,profile,session_id)
      WHERE s.owner=? AND s.owned_at IS NOT NULL AND (?='' OR s.profile=?)
      AND COALESCE(l.pinned,json_extract(s.data,'$.pinned'),json_extract(s.data,'$.is_pinned'),0)=1 ORDER BY s.last_synced_at DESC`)
      .all(owner,profile,profile) as {session_id:string}[]).map(r=>r.session_id)
  }

  unread(owner: string, profile: string) {
    const sessions = (this.db.prepare(`SELECT s.profile,s.session_id,COALESCE(s.message_total,0) message_count,
      CASE WHEN COALESCE(l.read_initialized,0)=1 THEN COALESCE(l.final_read_count,l.read_count) ELSE COALESCE(s.message_total,0) END final_read_count,
      CASE WHEN COALESCE(l.read_initialized,0)=1 THEN l.read_count ELSE COALESCE(s.message_total,0) END read_message_count FROM chat_sessions s LEFT JOIN chat_local_state l USING(owner,profile,session_id)
      WHERE s.owner=? AND s.owned_at IS NOT NULL AND (?='' OR s.profile=?)`).all(owner,profile,profile) as any[])
      .map(({final_read_count,...r})=>{
        const messages = this.db.prepare(`SELECT data FROM chat_messages
          WHERE owner=? AND profile=? AND session_id=? AND position>=?
          AND json_extract(data,'$.role')='assistant'`)
          .all(owner,r.profile,r.session_id,final_read_count) as {data:string}[]
        return {...r,updated_at:Date.now(),unread_count:Math.max(0,r.message_count-r.read_message_count),
          final_unread_count:messages.filter(row=>isFinalChatResult(JSON.parse(row.data))).length}
      })
    return {profile,supported:true,total_unread:sessions.reduce((n,r)=>n+r.unread_count,0),sessions}
  }

  markRead(owner: string, profile: string, id: string, count?: number) {
    id=this.canonicalSessionID(owner,profile,id)
    this.requireOwned(owner,profile,id)
    const total = Number((this.db.prepare('SELECT message_total FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?')
      .get(owner,profile,id) as any).message_total ?? 0)
    const read = Math.max(0,Math.min(total, count ?? total))
    // Reading a streaming placeholder must not consume its future final answer.
    // Keep the original cursor untouched for existing consumers.
    const pending = this.db.prepare(`SELECT MIN(position) position FROM chat_messages
      WHERE owner=? AND profile=? AND session_id=? AND position<?
      AND message_id=(SELECT assistant_id FROM chat_local_state WHERE owner=? AND profile=? AND session_id=?)
      AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.status')='streaming'`)
      .get(owner,profile,id,read,owner,profile,id) as {position:number|null}
    const finalRead = pending.position ?? read
    this.db.prepare(`INSERT INTO chat_local_state(owner,profile,session_id,read_count,final_read_count,read_initialized) VALUES(?,?,?,?,?,1)
      ON CONFLICT(owner,profile,session_id) DO UPDATE SET read_count=MAX(read_count,excluded.read_count),
      final_read_count=MAX(COALESCE(final_read_count,read_count),excluded.final_read_count),read_initialized=1`).run(owner,profile,id,read,finalRead)
    return this.unread(owner,profile).sessions.find(r=>r.session_id===id)!
  }

  requireOwned(owner: string, profile: string, id: string): void {
    if (!this.ownsSession(owner,profile,id)) throw new HttpError(404,'会话不存在','session_not_found')
  }

  patchLocal(owner: string, profile: string, id: string, patch: Record<string,unknown>): void {
    id=this.canonicalSessionID(owner,profile,id)
    this.requireOwned(owner,profile,id)
    this.db.exec('SAVEPOINT local_chat_patch')
    try {
      if (typeof patch.pinned==='boolean') this.db.prepare(`INSERT INTO chat_local_state(owner,profile,session_id,pinned) VALUES(?,?,?,?)
        ON CONFLICT(owner,profile,session_id) DO UPDATE SET pinned=excluded.pinned`).run(owner,profile,id,patch.pinned?1:0)
      const row = this.localDetail(owner,profile,id)!
      const data = {...JSON.parse(row.response.body.toString()),...patch}
      this.db.prepare('UPDATE chat_sessions SET data=? WHERE owner=? AND profile=? AND session_id=?').run(JSON.stringify(data),owner,profile,id)
      for(const key of ['title','archived'] as const)if(patch[key]!==undefined){
        const value=key==='archived'?(patch[key]?1:0):String(patch[key])
        this.db.prepare(`INSERT INTO chat_local_state(owner,profile,session_id,${key}) VALUES(?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET ${key}=excluded.${key}`).run(owner,profile,id,value)
      }
      if(typeof patch.title==='string') this.recordAuthoritativeTitle(owner,profile,id,patch.title)
      this.db.prepare("UPDATE chat_sessions SET sync_state=CASE WHEN complete=1 THEN 'current' ELSE sync_state END WHERE owner=? AND profile=? AND session_id=?").run(owner,profile,id)
      this.db.exec('RELEASE local_chat_patch')
    } catch(e) {this.db.exec('ROLLBACK TO local_chat_patch; RELEASE local_chat_patch');throw e}
  }

  private writeLiveMessage(owner:string,profile:string,id:string,message:Record<string,any>): void {
    const prior = this.db.prepare('SELECT position FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND message_id=?').get(owner,profile,id,message.id) as {position:number}|undefined
    const row = this.db.prepare('SELECT message_total,complete,data FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,id) as any
    const extent = Number((this.db.prepare('SELECT COALESCE(MAX(position)+1,0) n FROM chat_messages WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,id) as any).n)
    const position = prior?.position ?? Math.max(extent,Number(row.message_total??0))
    const data=JSON.stringify(message)
    this.db.prepare(`INSERT INTO chat_messages(owner,profile,session_id,message_id,position,data,content_hash) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(owner,profile,session_id,message_id) DO UPDATE SET data=excluded.data,content_hash=excluded.content_hash`).run(owner,profile,id,message.id,position,data,createHash('sha256').update(data).digest('hex'))
    const total=Math.max(Number(row.message_total??0),position+1), summary=JSON.parse(row.data)
    const now=Date.now()
    summary.message_count=total; summary.last_active=now/1000
    if (typeof message.content==='string' && message.content.trim()) summary.preview=message.content.slice(0,160)
    this.db.prepare('UPDATE chat_sessions SET data=?,message_total=?,last_synced_at=? WHERE owner=? AND profile=? AND session_id=?').run(JSON.stringify(summary),total,now,owner,profile,id)
    for(const path of referencedPaths(message)) this.db.prepare(`INSERT OR IGNORE INTO chat_attachments(owner,profile,session_id,source_path,state,updated_at) VALUES(?,?,?,?,'pending',?)`).run(owner,profile,id,path,now)
  }

  projectedMessageID(owner:string,profile:string,id:string):string|undefined {
    return (this.db.prepare(`SELECT message_id FROM chat_messages WHERE owner=? AND profile=? AND session_id=?
      AND json_extract(data,'$.role')='assistant' ORDER BY position DESC LIMIT 1`).get(owner,profile,id) as {message_id:string}|undefined)?.message_id
  }

  private projectEvent(owner:string,profile:string,id:string,type:string,p:Record<string,any>,eventID:string): void {
    if(!this.ownsSession(owner,profile,id))return
    if(type==='command.confirmed'||type==='command.rejected'){
      const userID=`user:${p.delivery_id}`
      const row=this.db.prepare('SELECT data FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND message_id=?').get(owner,profile,id,userID) as any
      if(row)this.writeLiveMessage(owner,profile,id,{...JSON.parse(row.data),status:type==='command.confirmed'?'complete':'failed',...(p.error?{error:p.error}:{})})
      this.db.prepare("UPDATE chat_sessions SET sync_state=CASE WHEN sync_state='gap' THEN 'gap' WHEN complete=1 THEN 'current' ELSE 'stale' END WHERE owner=? AND profile=? AND session_id=?").run(owner,profile,id)
      return
    }
    if (type==='message.user' || type==='peer_user_message') {
      this.writeLiveMessage(owner,profile,id,{...p,id:String(p.message_id??p.id??eventID),role:'user',content:p.text??p.content??'',timestamp:Date.now()/1000});return
    }
    const state=this.db.prepare('SELECT assistant_id FROM chat_local_state WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,id) as any
    const last=state?.assistant_id?this.db.prepare('SELECT data FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND message_id=?').get(owner,profile,id,state.assistant_id) as any:undefined
    const previous=last?JSON.parse(last.data):undefined
    // A new run must never append to the assistant row from the preceding turn.
    if(['message.complete','run.completed'].includes(type) && !previous && !p.text && !p.content && !p.message){
      this.db.prepare("UPDATE chat_sessions SET sync_state='gap' WHERE owner=? AND profile=? AND session_id=?").run(owner,profile,id);return
    }
    const startsNew=type==='message.start' && previous?.status!=='streaming'
    const message=projectChatEvent(type,p,startsNew?undefined:previous,`event:${eventID}`,Date.now())
    if(message){
      if(previous && previous.id !== message.id && !startsNew){
        const exists=this.db.prepare('SELECT 1 FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND message_id=?').get(owner,profile,id,message.id)
        if(!exists)this.db.prepare('UPDATE chat_messages SET message_id=? WHERE owner=? AND profile=? AND session_id=? AND message_id=?').run(message.id,owner,profile,id,previous.id)
        else {this.db.prepare("UPDATE chat_sessions SET sync_state='gap' WHERE owner=? AND profile=? AND session_id=?").run(owner,profile,id);return}
      }
      this.writeLiveMessage(owner,profile,id,message)
      this.db.prepare(`INSERT INTO chat_local_state(owner,profile,session_id,assistant_id) VALUES(?,?,?,?)
        ON CONFLICT(owner,profile,session_id) DO UPDATE SET assistant_id=excluded.assistant_id`).run(owner,profile,id,type==='message.interim'?null:message.id)
      this.db.prepare(`UPDATE chat_sessions SET sync_state=CASE WHEN sync_state='gap' THEN 'gap' WHEN complete=1 THEN 'current' ELSE 'stale' END
        WHERE owner=? AND profile=? AND session_id=?`).run(owner,profile,id)
    }
  }

  needsListMetadata(owner: string, profile: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM chat_sessions WHERE owner=? AND owned_at IS NOT NULL
      AND (?='' OR profile=?) AND metadata_complete=0 LIMIT 1`).get(owner, profile, profile))
  }

  localDetail(owner: string, profile: string, sessionID: string): StoredSnapshot | undefined {
    const row = this.db.prepare(`SELECT data,sync_state FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=? AND owned_at IS NOT NULL`)
      .get(owner, profile, sessionID) as { data: string; sync_state: ChatCacheState } | undefined
    if (!row) return undefined
    const local=this.db.prepare('SELECT title,archived,pinned FROM chat_local_state WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,sessionID) as any
    return { response: { status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      body: Buffer.from(JSON.stringify({...JSON.parse(row.data),...(local?.title!=null?{title:local.title}:{}),...(local?.archived!=null?{archived:!!local.archived}:{}),owned:true,pinned:local?.pinned!=null?!!local.pinned:bool(JSON.parse(row.data).pinned),sync_state:row.sync_state})) }, state: row.sync_state }
  }

  revision(owner: string, profile: string, sessionID: string): number {
    return Number((this.db.prepare('SELECT sync_revision FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?')
      .get(owner, profile, sessionID) as { sync_revision?: number } | undefined)?.sync_revision ?? 0)
  }

  hasMessage(owner: string, profile: string, sessionID: string, message: Record<string, unknown>, position: number): boolean {
    const id = messageID(message, String(position))
    const row = this.db.prepare('SELECT position FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND message_id=?')
      .get(owner, profile, sessionID, id) as { position: number } | undefined
    if (row && row.position !== position) throw new Error('Stored history changed; explicit refresh is required')
    return Boolean(row)
  }

  putSnapshot(owner: string, key: string, kind: string, profile: string, sessionID: string | undefined,
    response: UpstreamResponse, ownedList = false, requestStartedAt = Date.now(),
    metadataResponse: UpstreamResponse = response): boolean {
    const payload = parseResponse(response)
    if (!payload) return false
    if (kind === 'list' && !ownedList) return false
    const isOwnedChat = ownedList || this.payloadBelongsToOwnedChat(owner, profile, sessionID, payload)
    if (!isOwnedChat) return false
    const now = Date.now()
    this.db.exec('SAVEPOINT chat_snapshot')
    try {
      // Hydrate all registered sessions from the unsliced upstream list, while
      // persisting only the owner-filtered page as the public response snapshot.
      this.ingestPayload(owner, profile, sessionID, parseResponse(metadataResponse) ?? payload, now, kind, requestStartedAt)
      this.db.prepare(`INSERT INTO chat_snapshots(owner,cache_key,kind,profile,session_id,status,headers,body,sync_state,saved_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,cache_key) DO UPDATE SET status=excluded.status,headers=excluded.headers,
        body=excluded.body,sync_state='current',saved_at=excluded.saved_at`)
        .run(owner, key, kind, profile, sessionID ?? null, response.status, headerRecord(response.headers),
          response.body.toString('base64'), 'current', now)
      this.db.exec('RELEASE chat_snapshot')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK TO chat_snapshot; RELEASE chat_snapshot')
      throw error
    }
  }

  applySync(owner: string, profile: string, sessionID: string, revision: number,
    pages: Array<{ key: string; kind: string; response: UpstreamResponse; startedAt: number }>, force: boolean): boolean {
    if (this.revision(owner, profile, sessionID) !== revision) return false
    this.db.exec('SAVEPOINT history_sync')
    try {
      if (force) this.db.prepare('DELETE FROM chat_messages WHERE owner=? AND profile=? AND session_id=?').run(owner, profile, sessionID)
      // Recovery promotes locally generated stream identities to upstream row IDs.
      // Remove only replaced rows inside the verified window; keep older coverage.
      if(!force){
        const windows=pages.filter(p=>p.kind==='messages').map(p=>parseResponse(p.response)).filter(Boolean) as Record<string,any>[]
        for(const window of windows){
          const pagination=window.pagination??{},messages=window.messages as Record<string,any>[]
          if(!Array.isArray(messages)||!Number.isSafeInteger(pagination.total))continue
          const end=pagination.total-Number(pagination.offset??0),start=end-messages.length
          const ids=new Set(messages.map((m,index)=>messageID(m,String(start+index))))
          const existing=this.db.prepare('SELECT message_id,data FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND position>=? AND position<?').all(owner,profile,sessionID,start,end) as {message_id:string;data:string}[]
          for(const row of existing){
            if(ids.has(row.message_id))continue
            const value=JSON.parse(row.data)
            if(value.role==='user'&&value.status==='pending'&&!messages.some(m=>m.role==='user'&&m.content===value.content))
              throw new Error('Unconfirmed submission must be reconciled before history replacement')
            this.db.prepare('DELETE FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND message_id=?').run(owner,profile,sessionID,row.message_id)
          }
        }
      }
      this.db.prepare("DELETE FROM chat_snapshots WHERE owner=? AND profile=? AND session_id=? AND kind='messages'").run(owner, profile, sessionID)
      for (const page of pages) this.putSnapshot(owner, page.key, page.kind, profile, sessionID, page.response, false, page.startedAt)
      const latest=this.db.prepare("SELECT message_id FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND json_extract(data,'$.role')='assistant' ORDER BY position DESC LIMIT 1").get(owner,profile,sessionID) as {message_id:string}|undefined
      if(latest)this.db.prepare('UPDATE chat_local_state SET assistant_id=? WHERE owner=? AND profile=? AND session_id=?').run(latest.message_id,owner,profile,sessionID)
      this.db.exec('RELEASE history_sync')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK TO history_sync; RELEASE history_sync')
      throw error
    }
  }

  messagePage(owner: string, profile: string, sessionID: string, offset: number, limit: number): MessagePage | undefined {
    const session = this.db.prepare(`SELECT data,sync_state,complete,message_total FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, sessionID) as Record<string, unknown> | undefined
    if (!session) return undefined
    const totalRow = this.db.prepare('SELECT COUNT(*) count, MAX(position)+1 extent FROM chat_messages WHERE owner=? AND profile=? AND session_id=?')
      .get(owner, profile, sessionID) as { count: number; extent: number | null }
    if (session.message_total == null && !bool(session.complete)) return undefined
    const total = Number(session.message_total ?? totalRow.extent ?? 0)
    const end = Math.max(0, total - offset)
    const start = Math.max(0, end - limit)
    const rows = this.db.prepare(`SELECT data FROM chat_messages WHERE owner=? AND profile=? AND session_id=?
      AND position>=? AND position<? ORDER BY position`).all(owner, profile, sessionID, start, end) as Array<{ data: string }>
    const messages = rows.map(row => JSON.parse(row.data))
    if (messages.length !== end - start) return undefined // Fetch only an actually missing page.
    const body = Buffer.from(JSON.stringify({
      session_id: sessionID,
      session: JSON.parse(this.localDetail(owner,profile,sessionID)!.response.body.toString()),
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

  recordEvent(owner: string, profile: string, sessionID: string, frame: Record<string, unknown>): boolean {
    const rawSeq = Number(frame.seq ?? frame.sequence ?? 0)
    const type = String(frame.type ?? 'unknown')
    const payload = JSON.stringify(frame.payload ?? {})
    const eventID = String(frame.delivery_id ?? (rawSeq > 0 ? `${frame.epoch ?? ''}:${rawSeq}:${type}` : randomUUID()))
    const seq = Number.parseInt(createHash('sha256').update(eventID).digest('hex').slice(0,12),16)
    const now = Date.now()
    this.db.exec('SAVEPOINT live_event')
    try {
    const receipt=this.db.prepare('INSERT OR IGNORE INTO chat_event_receipts VALUES(?,?,?,?)').run(owner,profile,sessionID,eventID)
    if(!receipt.changes){this.db.exec('RELEASE live_event');return false}
    const previous = this.db.prepare(`SELECT last_event_seq FROM chat_sessions
      WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, sessionID) as { last_event_seq?: number } | undefined
    const lastSeen = Number(previous?.last_event_seq ?? 0)
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO chat_events(owner,profile,session_id,event_seq,event_type,payload,received_at)
      VALUES(?,?,?,?,?,?,?)`).run(owner, profile, sessionID, Number.isSafeInteger(seq) ? seq : 0, type, payload, now)
    if (!inserted.changes) {this.db.exec('RELEASE live_event');return false}
    const state: ChatCacheState = type === 'gateway.reset' || type.includes('reset')
      || (!frame.epoch && rawSeq > 0 && lastSeen > 0 && rawSeq > lastSeen + 1) ? 'gap' : 'stale'
    const metadataOnly = ['session.info', 'session.title', 'session.title.updated', 'session.usage', 'gateway.ready'].includes(type) && state !== 'gap'
    this.db.prepare(`UPDATE chat_sessions SET sync_state=CASE WHEN ? THEN sync_state WHEN sync_state='gap' THEN 'gap' ELSE ? END,
      sync_revision=sync_revision+?,last_event_seq=MAX(last_event_seq,?),last_synced_at=?
      WHERE owner=? AND profile=? AND session_id=?`).run(metadataOnly ? 1 : 0, state, metadataOnly ? 0 : 1, rawSeq > 0 ? rawSeq : lastSeen, now, owner, profile, sessionID)
    if (type === 'session.info') {
      const payload = object(frame.payload) ?? {}
      const info = object(payload.info) ?? payload
      const row = this.db.prepare('SELECT data FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?')
        .get(owner, profile, sessionID) as { data: string } | undefined
      if (row) {
        const summary = object(JSON.parse(row.data)) ?? {}
        for (const field of ['model', 'provider', 'fast']) if (info[field] !== undefined) summary[field] = info[field]
        this.db.prepare('UPDATE chat_sessions SET data=? WHERE owner=? AND profile=? AND session_id=?')
          .run(JSON.stringify(summary), owner, profile, sessionID)
      }
    }
    if (type === 'session.title' || type === 'session.title.updated') {
      const title = String(object(frame.payload)?.title ?? frame.title ?? '').trim()
      if (title) this.updateOwnedSessionTitle(owner, profile, sessionID, title, now)
    }
    this.db.prepare(`UPDATE chat_snapshots SET sync_state=? WHERE owner=? AND (session_id=? OR kind='list')
      AND (?=0 OR kind<>'messages')`).run(state, owner, sessionID, metadataOnly ? 1 : 0)
    this.db.prepare(`INSERT INTO chat_sync_cursors(owner,profile,event_cursor,sync_state,last_synced_at)
      VALUES(?,?,?,?,?) ON CONFLICT(owner,profile) DO UPDATE SET event_cursor=MAX(event_cursor,excluded.event_cursor),
      sync_state=excluded.sync_state,last_synced_at=excluded.last_synced_at`)
      .run(owner, profile, rawSeq > 0 ? rawSeq : lastSeen, state, now)
    this.projectEvent(owner,profile,sessionID,type,object(frame.payload)??{},eventID)
    this.db.exec('RELEASE live_event')
    return true
    }catch(e){this.db.exec('ROLLBACK TO live_event; RELEASE live_event');throw e}
  }

  canonicalSessionID(owner:string,profile:string,id:string):string {
    let current=id
    const seen=new Set<string>()
    for(let n=0;n<32&&!seen.has(current);n++){
      seen.add(current)
      const row=this.db.prepare('SELECT session_id FROM chat_session_aliases WHERE owner=? AND profile=? AND alias_id=?').get(owner,profile,current) as {session_id:string}|undefined
      if(!row)break
      current=row.session_id
    }
    return current
  }
  private migrateRuntimeSession(owner:string,profile:string,id:string,runtime:string):void {
    const old=this.db.prepare('SELECT session_id FROM chat_sessions WHERE owner=? AND profile=? AND runtime_id=? AND session_id<>? AND owned_at IS NOT NULL').get(owner,profile,runtime,id) as {session_id:string}|undefined
    if(!old||this.ownsSession(owner,profile,id))return
    this.db.exec('SAVEPOINT migrate_live_route')
    try{
      for(const table of ['chat_sessions','chat_messages','chat_events','chat_snapshots','chat_attachments','chat_local_state','chat_event_receipts','chat_recovery_jobs'])
        this.db.prepare(`UPDATE ${table} SET session_id=? WHERE owner=? AND profile=? AND session_id=?`).run(id,owner,profile,old.session_id)
      this.db.prepare('INSERT OR REPLACE INTO chat_session_aliases VALUES(?,?,?,?)').run(owner,profile,old.session_id,id)
      this.db.prepare('UPDATE chat_session_aliases SET session_id=? WHERE owner=? AND profile=? AND session_id=?').run(id,owner,profile,old.session_id)
      this.db.prepare("UPDATE chat_sessions SET data=json_set(data,'$.id',?) WHERE owner=? AND profile=? AND session_id=?").run(id,owner,profile,id)
      this.db.exec('RELEASE migrate_live_route')
    }catch(e){this.db.exec('ROLLBACK TO migrate_live_route; RELEASE migrate_live_route');throw e}
  }

  recordRoute(owner: string, profile: string, sessionID: string, runtimeID: string): void {
    this.migrateRuntimeSession(owner,profile,sessionID,runtimeID)
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
      sync_state=CASE WHEN chat_sessions.sync_state='gap' THEN 'gap' ELSE 'stale' END,sync_revision=chat_sessions.sync_revision+1,last_synced_at=excluded.last_synced_at,
      owned_at=COALESCE(chat_sessions.owned_at,excluded.owned_at),
      ownership_evidence=COALESCE(chat_sessions.ownership_evidence,excluded.ownership_evidence)`)
      .run(owner, profile, sessionID, source, JSON.stringify(summary), 'stale', 0, now,
        establishesOwnership ? now : null, establishesOwnership ? `command:${method}` : null)
    if(method==='session.create') this.db.prepare(`INSERT INTO chat_local_state(owner,profile,session_id,read_initialized) VALUES(?,?,?,1) ON CONFLICT(owner,profile,session_id) DO UPDATE SET read_initialized=1`).run(owner,profile,sessionID)
    if(method==='session.create') this.db.prepare(`UPDATE chat_sessions SET complete=1,metadata_complete=1,message_total=0,sync_state='current' WHERE owner=? AND profile=? AND session_id=? AND message_total IS NULL`).run(owner,profile,sessionID)
    if((method==='prompt.submit'||method==='session.steer') && params._delivery_id){
      const userID=`user:${params._delivery_id}`
      this.writeLiveMessage(owner,profile,sessionID,{id:userID,role:'user',content:params.text??params.input??'',timestamp:now/1000,status:'pending',client_message_id:String(params._delivery_id).replace(/^(web|ios):prompt:/,'')})
      this.db.prepare(`INSERT INTO chat_local_state(owner,profile,session_id,assistant_id) VALUES(?,?,?,NULL) ON CONFLICT(owner,profile,session_id) DO UPDATE SET assistant_id=NULL`).run(owner,profile,sessionID)
    }
    const payload = JSON.stringify(params)
    const seq = Number.parseInt(createHash('sha256').update(`${method}:${payload}`).digest('hex').slice(0, 12), 16)
    this.db.prepare(`INSERT OR IGNORE INTO chat_events(owner,profile,session_id,event_seq,event_type,payload,received_at)
      VALUES(?,?,?,?,?,?,?)`).run(owner, profile, sessionID, seq, `command:${method}`, payload, now)
    this.db.prepare("UPDATE chat_snapshots SET sync_state='stale' WHERE owner=? AND (session_id=? OR kind='list')")
      .run(owner, sessionID)
  }

  fileSourceMessage(owner: string, profile: string, sessionID: string, messageID: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT data FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND message_id=?')
      .get(owner, profile, sessionID, messageID)
    return row ? JSON.parse(String(row.data)) : undefined
  }

  markListsStale(owner: string): void {
    this.db.prepare("UPDATE chat_snapshots SET sync_state='stale' WHERE owner=? AND kind='list'").run(owner)
  }

  invalidateOwnedMetadata(owner: string): Array<{profile:string;session_id:string}> {
    return this.db.prepare(`UPDATE chat_sessions SET metadata_complete=0,sync_revision=sync_revision+1
      WHERE owner=? AND owned_at IS NOT NULL AND source NOT IN ('cron','ios_group','yaoyao_workspace')
      RETURNING profile,session_id`).all(owner) as Array<{profile:string;session_id:string}>
  }

  refreshMetadata(owner:string,profile:string,id:string,revision:number,response:UpstreamResponse,startedAt:number):boolean {
    const payload=parseResponse(response),summary=object(payload?.session)??payload
    const total=summary?.message_count??summary?.messageCount
    const row=this.db.prepare('SELECT metadata_complete,complete,message_total,sync_state FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?')
      .get(owner,profile,id) as {metadata_complete:number;complete:number;message_total:number;sync_state:string}|undefined
    if(!row||row.metadata_complete||!row.complete||total==null||Number(total)!==row.message_total||this.revision(owner,profile,id)!==revision)return false
    this.db.exec('SAVEPOINT metadata_refresh')
    try {
      const metadata={...summary};delete metadata.messages
      const headers=new Headers(response.headers);headers.delete('content-length')
      const metadataResponse={...response,headers,body:Buffer.from(JSON.stringify(metadata))}
      if(!this.putSnapshot(owner,`detail:${profile}:${id}`,'detail',profile,id,metadataResponse,false,startedAt))throw new Error('Invalid conversation metadata')
      // A metadata invalidation must not replace or downgrade the durable live tail.
      this.db.prepare('UPDATE chat_sessions SET sync_state=? WHERE owner=? AND profile=? AND session_id=?').run(row.sync_state,owner,profile,id)
      this.db.exec('RELEASE metadata_refresh');return true
    }catch(error){this.db.exec('ROLLBACK TO metadata_refresh; RELEASE metadata_refresh');throw error}
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
      for (const table of ['chat_messages', 'chat_events', 'chat_attachments', 'chat_local_state', 'chat_event_receipts', 'chat_recovery_jobs', 'chat_session_aliases', 'chat_sessions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE owner=? AND profile=? AND session_id=?`).run(owner, profile, sessionID)
      }
      this.db.prepare("DELETE FROM chat_snapshots WHERE owner=? AND ((profile=? AND session_id=?) OR kind='list')")
        .run(owner, profile, sessionID)
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
    sessionID=this.canonicalSessionID(owner,profile,sessionID)
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
    const local=this.db.prepare('SELECT title FROM chat_local_state WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,sessionID) as {title?:string}|undefined
    const authoritativeTitle = String(local?.title ?? row?.authoritative_title ?? '').trim()
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
          ...mergeSessionMetadata(merged.get(key) ?? {}, session),
          ...(title ? { title } : {}),
          _yaoyao_registry_activity: row.last_synced_at,
          owned: true,
        })
      }
    }
    const activity = (session: Record<string, unknown>): number =>
      firstTimestamp(session, ACTIVITY_TIME_KEYS) ?? firstTimestamp(session, START_TIME_KEYS) ?? 0
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
      const publicSession = mergeSessionMetadata({}, session)
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
    const local=this.db.prepare('SELECT title FROM chat_local_state WHERE owner=? AND profile=? AND session_id=?').get(owner,profile,id) as {title?:string}|undefined
    const title = String(local?.title ?? row?.authoritative_title ?? '').trim()
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
      const titleRow = this.db.prepare(`SELECT data,authoritative_title,authoritative_title_at FROM chat_sessions
        WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, id) as {
          data: string; authoritative_title?: string | null; authoritative_title_at?: number
        } | undefined
      const authoritativeTitle = String(titleRow?.authoritative_title ?? '').trim()
      const authoritativeTitleAt = Number(titleRow?.authoritative_title_at ?? 0)
      const incomingTitle = sessionTitle(session)
      const preservesAuthoritativeTitle = Boolean(authoritativeTitle)
        && (kind !== 'detail' || isPlaceholderTitle(incomingTitle)
          || requestStartedAt <= authoritativeTitleAt)
      let previous: Record<string, unknown> = {}
      try { previous = object(JSON.parse(titleRow?.data ?? '{}')) ?? {} } catch { /* Recover from incoming metadata. */ }
      const storedSession = mergeSessionMetadata(previous, session)
      if (preservesAuthoritativeTitle) storedSession.title = authoritativeTitle
      const metadataComplete = kind !== 'messages' || direct ? 1 : 0
      this.db.prepare(`INSERT INTO chat_sessions(owner,profile,session_id,runtime_id,source,data,sync_state,complete,last_synced_at,metadata_complete)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET data=excluded.data,
        metadata_complete=MAX(chat_sessions.metadata_complete,excluded.metadata_complete),
        source=CASE WHEN excluded.source='unknown' THEN chat_sessions.source ELSE excluded.source END,
        sync_state='current',last_synced_at=excluded.last_synced_at`)
        .run(owner, profile, id, null, source || 'unknown', JSON.stringify(storedSession), 'current', 0, now, metadataComplete)
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
    if (!Array.isArray(payload.messages) || !sessionID) return
    const profile = fallbackProfile || profileOf(direct ?? {}, 'default') || 'default'
    const pagination = object(payload.pagination) ?? {}
    const offset = Math.max(0, Number(pagination.offset ?? payload.offset ?? 0) || 0)
    const storedDetail = this.localDetail(owner, profile, sessionID)
    const storedSummary = storedDetail ? parseResponse(storedDetail.response) ?? {} : {}
    const total = Math.max(offset + messages.length,
      Number(pagination.total ?? payload.total ?? storedSummary.message_count ?? storedSummary.messageCount ?? 0) || 0)
    const start = Math.max(0, total - offset - messages.length)
    messages.forEach((message, index) => {
      const data = JSON.stringify(message)
      this.db.prepare(`INSERT INTO chat_messages(owner,profile,session_id,message_id,position,data,content_hash)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id,message_id) DO UPDATE SET position=excluded.position,
        data=excluded.data,content_hash=excluded.content_hash
        WHERE chat_messages.content_hash<>excluded.content_hash OR chat_messages.position<>excluded.position`)
        .run(owner, profile, sessionID, messageID(message, String(start + index)), start + index, data,
          createHash('sha256').update(data).digest('hex'))
      for (const sourcePath of referencedPaths(message)) {
        this.db.prepare(`INSERT INTO chat_attachments(owner,profile,session_id,source_path,state,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id,source_path) DO UPDATE SET updated_at=excluded.updated_at`)
          .run(owner, profile, sessionID, sourcePath, 'pending', now)
      }
    })
    const coverage = this.db.prepare(`SELECT COUNT(*) count, COUNT(DISTINCT position) positions, MIN(position) first, MAX(position) last
      FROM chat_messages WHERE owner=? AND profile=? AND session_id=?`).get(owner, profile, sessionID) as Record<string, number>
    const complete = total === 0 ? coverage.count === 0
      : coverage.count === total && coverage.positions === total && coverage.first === 0 && coverage.last === total - 1
    const row = this.db.prepare('SELECT data FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?')
      .get(owner, profile, sessionID) as { data: string }
    const summary = mergeSessionMetadata({}, object(JSON.parse(row.data)) ?? {})
    const bounds = messageTimeBounds(messages)
    if (!firstTimestamp(summary, START_TIME_KEYS) && bounds.first !== undefined) summary.started_at = bounds.first
    if (bounds.last !== undefined) {
      summary.last_active = Math.max(firstTimestamp(summary, ACTIVITY_TIME_KEYS) ?? 0, bounds.last)
    }
    summary.message_count = total
    this.db.prepare('UPDATE chat_sessions SET data=? WHERE owner=? AND profile=? AND session_id=?')
      .run(JSON.stringify(summary), owner, profile, sessionID)
    this.db.prepare(`UPDATE chat_sessions SET complete=?,message_total=?,sync_state='current',last_synced_at=?
      WHERE owner=? AND profile=? AND session_id=?`).run(complete ? 1 : 0, total, now, owner, profile, sessionID)
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
  onSynchronized: (owner: string, profile: string, sessionID: string) => void = () => {}
  constructor(readonly store: ChatCacheStore, readonly upstream: UpstreamServiceSession,
    readonly mode: ChatCacheMode = 'prefer-local') {
      const timer=setTimeout(()=>{
        this.retryTimers.delete(timer)
        if(this.store.isClosed||this.stopped)return
        void this.restoreReadPositions()
        for(const row of this.store.db.prepare('SELECT * FROM chat_recovery_jobs').all() as any[])this.schedule(row.owner,row.profile,row.session_id,!!row.force)
      },0);timer.unref();this.retryTimers.add(timer)
    }

  readonly diagnostics = {localReads:0, recoveryAttempts:0, recoveryFailures:0, recoveryCompleted:0}
  private async restoreReadPositions():Promise<void>{
    if(this.stopped||this.store.isClosed)return
    const scopes=this.store.db.prepare('SELECT DISTINCT owner,profile FROM chat_local_state WHERE read_initialized=0').all() as {owner:string;profile:string}[]
    let failed=false
    for(let i=0;i<scopes.length;i+=2)await Promise.all(scopes.slice(i,i+2).map(async({owner,profile})=>{
      if(this.stopped||this.store.isClosed)return
      try{
        const response=await this.upstream.request('/api/session-unread',{search:new URLSearchParams({profile})})
        if(this.stopped||this.store.isClosed)return
        if(response.status>=500)throw new Error('Read-position import unavailable')
        const payload=parseResponse(response),rows=Array.isArray(payload?.sessions)?payload.sessions:[]
        this.store.db.exec('SAVEPOINT read_position_import')
        try{
          for(const raw of rows){const r=object(raw);if(!r)continue;const id=String(r.session_id??r.sessionId??'')
            const count=Math.max(0,Number(r.read_message_count??r.readMessageCount??0)||0)
            this.store.db.prepare('UPDATE chat_local_state SET read_count=?,read_initialized=1 WHERE owner=? AND profile=? AND session_id=? AND read_initialized=0').run(count,owner,profile,id)
          }
          this.store.db.prepare(`UPDATE chat_local_state SET read_count=COALESCE((SELECT message_total FROM chat_sessions s WHERE s.owner=chat_local_state.owner AND s.profile=chat_local_state.profile AND s.session_id=chat_local_state.session_id),0),read_initialized=1 WHERE owner=? AND profile=? AND read_initialized=0`).run(owner,profile)
          this.store.db.exec('RELEASE read_position_import')
        }catch(e){this.store.db.exec('ROLLBACK TO read_position_import; RELEASE read_position_import');throw e}
      }catch{failed=true}
    }))
    if(failed&&!this.stopped&&!this.store.isClosed){const timer=setTimeout(()=>{this.retryTimers.delete(timer);void this.restoreReadPositions()},30_000);timer.unref();this.retryTimers.add(timer)}
  }
  private jobs = new Map<string,{owner:string;profile:string;id:string;force:boolean;attempt:number}>()
  private activeJobs = new Set<string>()
  private retryTimers = new Set<ReturnType<typeof setTimeout>>()
  private stopped = false
  close(): void {this.stopped=true;for(const timer of this.retryTimers)clearTimeout(timer);this.retryTimers.clear();this.jobs.clear()}

  schedule(owner:string,profile:string,id:string,force=false): void {
    if(this.stopped||this.store.isClosed||!this.store.ownsSession(owner,profile,id))return
    const key=JSON.stringify([owner,profile,id]),previous=this.jobs.get(key)
    if(previous){previous.force ||= force;if(force)this.store.db.prepare('UPDATE chat_recovery_jobs SET force=1 WHERE owner=? AND profile=? AND session_id=?').run(owner,profile,id);return}
    this.store.db.prepare('INSERT INTO chat_recovery_jobs VALUES(?,?,?,?) ON CONFLICT(owner,profile,session_id) DO UPDATE SET force=MAX(force,excluded.force)').run(owner,profile,id,force?1:0)
    this.jobs.set(key,{owner,profile,id,force,attempt:0})
    const timer=setTimeout(()=>{this.retryTimers.delete(timer);this.drain()},0);timer.unref();this.retryTimers.add(timer)
  }
  private drain(): void {
    if(this.stopped||this.store.isClosed)return
    for(const [key,job] of this.jobs){
      if(this.activeJobs.size>=2)break
      if(this.activeJobs.has(key)||job.attempt<0)continue
      this.activeJobs.add(key)
      this.diagnostics.recoveryAttempts++
      const force=job.force;job.force=false
      void this.reconcile(job.owner,job.profile,job.id,force).then(()=>{
        if(this.stopped||this.store.isClosed)return
        if(job.force){job.attempt=0;return}
        this.diagnostics.recoveryCompleted++
        this.jobs.delete(key)
        this.store.db.prepare('DELETE FROM chat_recovery_jobs WHERE owner=? AND profile=? AND session_id=?').run(job.owner,job.profile,job.id)
      }).catch(()=>{
        if(this.stopped||this.store.isClosed)return
        this.diagnostics.recoveryFailures++
        job.force ||= force
        const attempt=Math.abs(job.attempt)+1;job.attempt=-attempt
        const timer=setTimeout(()=>{this.retryTimers.delete(timer);job.attempt=attempt;this.drain()},Math.min(30_000,1000*2**Math.min(attempt-1,5)))
        timer.unref();this.retryTimers.add(timer)
      }).finally(()=>{this.activeJobs.delete(key);this.drain()})
    }
  }
  readLocal(owner:string,kind:'list'|'detail'|'messages',profile:string,id:string|undefined,
    page:{offset?:number;limit?:number;archived?:string},force=false): {response:UpstreamResponse;source:ChatCacheSource;state:ChatCacheState} {
    this.diagnostics.localReads++
    if(id)id=this.store.canonicalSessionID(owner,profile,id)
    if(kind==='list'){
      for(const row of this.store.missingSessions(owner,profile)) this.schedule(owner,row.profile,row.session_id,force)
      return {response:this.store.localList(owner,profile,page),source:'local',state:this.store.needsListMetadata(owner,profile)?'syncing':'current'}
    }
    this.store.requireOwned(owner,profile,id!)
    const local=kind==='detail'?this.store.localDetail(owner,profile,id!):this.store.messagePage(owner,profile,id!,page.offset??0,page.limit??100)
    if(force||!local||local.state==='gap')this.schedule(owner,profile,id!,force)
    if(!local)throw new HttpError(409,'历史正在后台补齐，请稍后重试','CHAT_HISTORY_SYNC_PENDING')
    return {response:local.response,source:'local',state:this.jobs.has(JSON.stringify([owner,profile,id]))?'syncing':local.state}
  }

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
    if (this.mode === 'prefer-local' && kind === 'list' && ownedList && !this.store.needsListMetadata(owner, profile)) {
      return { response: this.store.localList(owner, profile, listPage), source: 'local', state: 'current' }
    }
    const local = kind === 'list' && ownedList && this.store.needsListMetadata(owner, profile) ? undefined : kind === 'detail' && sessionID
      ? this.store.localDetail(owner, profile, sessionID) ?? this.store.snapshot(owner, key)
      : this.store.snapshot(owner, key)
    const projectedLocal = local && kind === 'list' && ownedList
      ? {
          ...local,
          response: this.store.mergeOwnedSessionsIntoList(owner, profile, local.response, listPage),
        }
      : local
    if (this.mode === 'prefer-local' && local) {
      return { response: projectedLocal!.response, source: 'local', state: local.state }
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
      this.store.putSnapshot(owner, key, kind, profile, sessionID, response, ownedList, requestStartedAt, upstreamResponse)
      return { response, source: 'upstream', state: 'current' }
    } catch (error) {
      if (this.mode === 'prefer-local' && local) return { response: projectedLocal!.response, source: 'local', state: 'stale' }
      throw error
    }
  }

  async messages(owner: string, key: string, profile: string, sessionID: string, offset: number, limit: number,
    load: () => Promise<UpstreamResponse>): Promise<{ response: UpstreamResponse; source: ChatCacheSource; state: ChatCacheState }> {
    if (this.mode === 'prefer-local') {
      // A completion may still be committing its authoritative tail. Join it for
      // the latest page; older, already stored pages never wait for the network.
      if (offset === 0) await this.reconciling.get(JSON.stringify([owner, profile, sessionID]))?.catch(() => {})
      const page = this.store.messagePage(owner, profile, sessionID, offset, limit)
      if (page) return { response: page.response, source: 'local', state: page.state }
    }
    return this.read(owner, key, 'messages', profile, sessionID, load)
  }

  observe(owner: string, profile: string, sessionID: string, frame: Record<string, unknown>): void {
    if (!this.store.recordEvent(owner, profile, sessionID, frame)) return
    if (String(frame.type).includes('reset') || this.store.localDetail(owner,profile,sessionID)?.state==='gap'
      || (['message.complete','run.completed'].includes(String(frame.type)) && this.store.localDetail(owner,profile,sessionID)?.state!=='current')) {
      this.schedule(owner, profile, sessionID)
    }
  }

  observeGlobal(owner: string, type: string, upstreamInvalidation=false): void {
    if (type !== 'sessions.changed' || this.stopped || this.store.isClosed) return
    this.store.markListsStale(owner)
    if(upstreamInvalidation)for(const row of this.store.invalidateOwnedMetadata(owner))this.schedule(owner,row.profile,row.session_id)
  }

  command(owner: string, profile: string, sessionID: string, method: string,
    params: Record<string, unknown>): void {
    this.store.recordCommand(owner, profile, sessionID, method, params)
  }

  route(owner: string, profile: string, sessionID: string, runtimeID: string): void {
    this.store.recordRoute(owner, profile, sessionID, runtimeID)
  }

  async reconcile(owner: string, profile: string, sessionID: string, force = false): Promise<void> {
    if(this.store.isClosed)return
    sessionID=this.store.canonicalSessionID(owner,profile,sessionID)
    if (this.stopped || this.store.isClosed || !this.store.ownsSession(owner, profile, sessionID)) return
    const key = JSON.stringify([owner, profile, sessionID])
    const pending = this.reconciling.get(key)
    if (pending) {
      await pending.catch(() => {})
      if (force || this.store.localDetail(owner, profile, sessionID)?.state !== 'current') {
        return this.reconcile(owner, profile, sessionID, force)
      }
      return
    }
    const task = (async () => {
      const revision = this.store.revision(owner, profile, sessionID)
      const previous = this.store.messagePage(owner, profile, sessionID, 0, 1)
      const previousTotal = previous ? Number(object(parseResponse(previous.response)?.pagination)?.total ?? 0) : 0
      const detailPath = `/api/sessions/${encodeURIComponent(sessionID)}`
      const detailStartedAt = Date.now()
      const detail = await this.upstream.request(detailPath, { search: new URLSearchParams({ profile }), cache: 'reload' })
      if (this.stopped || this.store.isClosed) return
      if (detail.status !== 200) throw new Error('Unable to synchronize conversation metadata')
      if(!force&&this.store.refreshMetadata(owner,profile,sessionID,revision,detail,detailStartedAt)) {
        this.onSynchronized(owner,profile,sessionID)
        return
      }
      const detailPayload = parseResponse(detail) ?? {}
      const detailSummary = object(detailPayload.session) ?? detailPayload
      const summaryTotal = Math.max(0, Number(detailSummary.message_count ?? detailSummary.messageCount ?? previousTotal) || 0)
      const pages = [{ key: `detail:${profile}:${sessionID}`, kind: 'detail', response: detail, startedAt: detailStartedAt, offset: 0 }]
      let offset = 0
      let done = false
      let expectedTotal: number | undefined
      let resolvedTotal = summaryTotal
      // Stop as soon as the authoritative tail overlaps durable messages. Only
      // explicit refresh (or uncached history) walks all the way to the beginning.
      for (let page = 0; page < 1_000; page++) {
        const search = new URLSearchParams({ profile, offset: String(offset), limit: '100', order: 'latest', include_compacted: 'true' })
        const startedAt = Date.now()
        const response = await this.upstream.request(`${detailPath}/messages`, { search, cache: 'reload' })
        if (this.stopped || this.store.isClosed) return
        const payload = parseResponse(response)
        if (response.status !== 200 || !Array.isArray(payload?.messages)) throw new Error('Unable to synchronize conversation messages')
        const messages = payload.messages.flatMap(value => object(value) ? [object(value)!] : [])
        const pagination = object(payload.pagination) ?? {}
        const explicitTotal = pagination.total ?? payload.total
        const total = Math.max(offset + messages.length, Number(explicitTotal ?? summaryTotal) || 0)
        if (!force && total < previousTotal) throw new Error('Stored history changed; explicit refresh is required')
        if (explicitTotal !== undefined) {
          if (expectedTotal !== undefined && expectedTotal !== total) throw new Error('Conversation changed during synchronization')
          expectedTotal = total
        }
        const anchors = !force ? messages.map((message, index) =>
          this.store.hasMessage(owner, profile, sessionID, message, total - offset - messages.length + index)) : []
        const overlap = anchors.some(Boolean)
        pages.push({ key: `messages:${profile}:${sessionID}:${offset}:100`, kind: 'messages', response, startedAt, offset })
        const more = pagination.hasMore ?? pagination.has_more ?? payload.hasMore ?? payload.has_more
        const hasMore = more === undefined ? messages.length >= 100 : bool(more)
        if (overlap || !hasMore) {
          if (!overlap && expectedTotal !== undefined && expectedTotal !== offset + messages.length) throw new Error('Conversation pagination ended before its declared total')
          resolvedTotal = overlap ? total : offset + messages.length
          done = true
          break
        }
        if (!messages.length) break
        offset += messages.length
      }
      if (!done) throw new Error('Conversation synchronization is incomplete')
      // Newer Hermes omits total/has_more. Once the end is known, project the
      // same verified total onto every page before assigning absolute positions.
      for (let index = 0; index < pages.length; index++) {
        const entry = pages[index]!
        const payload = parseResponse(entry.response)!
        if (entry.kind === 'detail') {
          const summary = object(payload.session) ?? payload
          summary.message_count = resolvedTotal
        } else {
          const pagination = object(payload.pagination) ?? {}
          const pageOffset = entry.offset
          payload.pagination = { ...pagination, total: resolvedTotal, offset: pageOffset,
            has_more: pageOffset + (payload.messages as unknown[]).length < resolvedTotal }
        }
        const headers = new Headers(entry.response.headers)
        headers.delete('content-length')
        entry.response = { ...entry.response, headers, body: Buffer.from(JSON.stringify(payload)) }
      }
      if (!this.store.applySync(owner, profile, sessionID, revision, pages, force)) {
        // Preserve the invalidation when a newer event arrived during the read.
        // Its completion joins this flight and schedules the next tail read.
        throw new Error('Conversation changed during refresh; retry after the reply completes')
      } else {
        this.onSynchronized(owner, profile, sessionID)
      }
    })().finally(() => { if (this.reconciling.get(key) === task) this.reconciling.delete(key) })
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
