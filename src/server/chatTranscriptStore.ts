import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  CHAT_TRANSCRIPT_FEATURE,
  type TranscriptEvent,
  type TranscriptMessage,
  type TranscriptSnapshot,
} from '../shared/chatTranscript.js'
import { toolStatus } from '../shared/chatTools.js'
import { isFinalChatResult } from './chatUnread.js'

type Scope = [string, string, string]
type Data = Record<string, any>
interface TurnHead {
  turn?: string
  current?: string
  preview?: boolean
  terminal?: boolean
  running: boolean
  queued: boolean
  queue: Array<{ turn: string; user: string; delivery: string }>
  tools: Record<string, string>
  pending: Record<string, { user: string; turn: string; previousRunning: boolean }>
  pendingApproval?: Data | null
  pendingClarification?: Data | null
  liveStatus?: string | null
  resyncing?: boolean
  error?: string | null
  stagedAttachments?: Data[]
  localReadEstablished?: boolean
  importedReadPosition?: number
}
const emptyHead = (): TurnHead => ({ running: false, queued: false, queue: [], tools: {}, pending: {} })
const text = (p: Data): string => String(p.output ?? p.text ?? p.content ?? '')
const controlState = (head: TurnHead) => ({
  running: head.running,
  queued: head.queued,
  pendingApproval: head.pendingApproval ?? null,
  pendingClarification: head.pendingClarification ?? null,
  liveStatus: head.liveStatus ?? null,
  error: head.error ?? null,
})

/** The sole ordinary-chat writer. Raw history is an import source, never a live projection. */
export class ChatTranscriptStore {
  readonly enabled = true
  readonly epoch: string
  private listeners = new Set<() => void>()
  private scheduled = false
  private closed = false
  constructor(
    readonly db: DatabaseSync,
    readonly enrich: (
      owner: string,
      profile: string,
      sessionId: string,
      rows: Record<string, any>[],
    ) => Record<string, any>[] = (_o, _p, _s, rows) => rows,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_transcript_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_transcript_scopes(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_transcript_execution(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_transcript_messages(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,
        id TEXT NOT NULL,seq INTEGER NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(owner,profile,session_id,id));
      CREATE INDEX IF NOT EXISTS chat_transcript_order ON chat_transcript_messages(owner,profile,session_id,seq);
      CREATE TABLE IF NOT EXISTS chat_transcript_aliases(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,
        source TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(owner,profile,session_id,source));
      CREATE TABLE IF NOT EXISTS chat_transcript_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,
        profile TEXT NOT NULL,session_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_transcript_replay ON chat_transcript_events(owner,profile,session_id,cursor);`)
    db.exec(`CREATE TABLE IF NOT EXISTS chat_transcript_heads(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,epoch TEXT NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(owner,profile,session_id));
      CREATE TABLE IF NOT EXISTS chat_transcript_archives(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,epoch TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(owner,profile,session_id,epoch));
      CREATE TABLE IF NOT EXISTS chat_transcript_reads(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(owner,profile,session_id,id));
      CREATE TABLE IF NOT EXISTS chat_transcript_source_cursors(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,runtime TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL,
      PRIMARY KEY(owner,profile,session_id,runtime,epoch));
      CREATE TABLE IF NOT EXISTS chat_transcript_repairs(owner TEXT NOT NULL,profile TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY(owner,profile,session_id));`)
    db.prepare("INSERT OR IGNORE INTO chat_transcript_meta VALUES('epoch',?)").run(randomUUID())
    this.epoch = String(db.prepare("SELECT value FROM chat_transcript_meta WHERE key='epoch'").get()!.value)
  }
  close() {
    this.closed = true
    this.listeners.clear()
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private notify() {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    // All enclosing cache savepoints finish synchronously. Read committed log
    // rows in subscribers; a rolled-back notification therefore emits nothing.
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.closed)
        for (const listener of this.listeners) {
          try {
            listener()
          } catch {}
        }
    })
  }
  private event(
    owner: string,
    profile: string,
    sessionId: string,
    type: TranscriptEvent['type'],
    data: unknown,
  ) {
    const previousCursor = this.cursor(owner, profile, sessionId)
    const envelope = {
      data,
      previousCursor,
      epoch: this.epochFor(owner, profile, sessionId),
      total: this.total(owner, profile, sessionId),
    }
    this.db
      .prepare(
        'INSERT INTO chat_transcript_events(owner,profile,session_id,type,data,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(owner, profile, sessionId, type, JSON.stringify(envelope), Date.now())
    this.notify()
  }
  private alias(owner: string, profile: string, sessionId: string, key: string): string | undefined {
    return (
      this.db
        .prepare(
          'SELECT id FROM chat_transcript_aliases WHERE owner=? AND profile=? AND session_id=? AND source=?',
        )
        .get(owner, profile, sessionId, key) as { id: string } | undefined
    )?.id
  }
  promote(owner: string, profile: string, sessionId: string, oldSource: string, newSource: string) {
    const id = this.alias(owner, profile, sessionId, `source:${oldSource}`)
    if (id && !this.alias(owner, profile, sessionId, `source:${newSource}`))
      this.db
        .prepare('INSERT INTO chat_transcript_aliases VALUES(?,?,?,?,?)')
        .run(owner, profile, sessionId, `source:${newSource}`, id)
  }
  upsert(
    owner: string,
    profile: string,
    sessionId: string,
    source: Record<string, any>,
    position: number,
  ): TranscriptMessage | undefined {
    const sourceID = String(source.id ?? source.message_id ?? '')
    if (!sourceID) return
    const keys = [`source:${sourceID}`]
    if (source.role === 'user' && source.client_message_id) keys.unshift(`client:${source.client_message_id}`)
    if (source.role === 'tool' && source.tool_call_id)
      keys.unshift(`tool:${source.turn_id ?? ''}:${source.tool_call_id}`)
    const id =
      this.message(owner, profile, sessionId, sourceID)?.id ??
      keys.map((key) => this.alias(owner, profile, sessionId, key)).find(Boolean) ??
      randomUUID()
    for (const duplicate of new Set(
      keys
        .map((key) => this.alias(owner, profile, sessionId, key))
        .filter((value): value is string => !!value && value !== id),
    )) {
      const old = this.db
        .prepare(
          'SELECT revision,deleted FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND id=?',
        )
        .get(owner, profile, sessionId, duplicate) as { revision: number; deleted: number } | undefined
      this.db
        .prepare(
          'UPDATE chat_transcript_aliases SET id=? WHERE owner=? AND profile=? AND session_id=? AND id=?',
        )
        .run(id, owner, profile, sessionId, duplicate)
      if (old && !old.deleted) {
        this.db
          .prepare(
            'UPDATE chat_transcript_messages SET deleted=1,revision=revision+1 WHERE owner=? AND profile=? AND session_id=? AND id=?',
          )
          .run(owner, profile, sessionId, duplicate)
        this.event(owner, profile, sessionId, 'message.deleted', {
          id: duplicate,
          revision: old.revision + 1,
        })
      }
    }
    const row = this.db
      .prepare(
        'SELECT data,revision,deleted FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND id=?',
      )
      .get(owner, profile, sessionId, id) as { data: string; revision: number; deleted: number } | undefined
    const old: TranscriptMessage | undefined = row ? JSON.parse(row.data) : undefined
    const next: TranscriptMessage = {
      ...source,
      id,
      source_message_id: source.source_message_id ?? old?.source_message_id ?? sourceID,
      seq: old?.seq ?? position + 1,
      revision: row?.revision ?? 0,
      role: String(source.role ?? 'assistant'),
      content: source.content ?? '',
      reasoning: String(source.reasoning ?? source.reasoning_content ?? ''),
    }
    if (!next.client_message_id && old?.client_message_id) next.client_message_id = old.client_message_id
    for (const key of keys)
      this.db
        .prepare(
          'INSERT INTO chat_transcript_aliases VALUES(?,?,?,?,?) ON CONFLICT(owner,profile,session_id,source) DO UPDATE SET id=excluded.id',
        )
        .run(owner, profile, sessionId, key, id)
    if (old && !row?.deleted && JSON.stringify(old) === JSON.stringify(next)) return old
    next.revision++
    this.db
      .prepare(
        'INSERT INTO chat_transcript_messages VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(owner,profile,session_id,id) DO UPDATE SET seq=excluded.seq,revision=excluded.revision,data=excluded.data,deleted=0',
      )
      .run(owner, profile, sessionId, id, next.seq, next.revision, JSON.stringify(next))
    let patch: Record<string, unknown> | undefined
    if (
      old &&
      !row?.deleted &&
      old.status === 'streaming' &&
      next.status === 'streaming' &&
      typeof old.content === 'string' &&
      typeof next.content === 'string' &&
      next.content.startsWith(old.content) &&
      next.reasoning!.startsWith(String(old.reasoning ?? ''))
    ) {
      const { content: a, reasoning: b, revision: c, ...oldMeta } = old
      const { content: d, reasoning: e, revision: f, ...newMeta } = next
      if (JSON.stringify(oldMeta) === JSON.stringify(newMeta))
        patch = {
          id,
          seq: next.seq,
          baseRevision: old.revision,
          revision: next.revision,
          contentAppend: next.content.slice(old.content.length),
          reasoningAppend: next.reasoning!.slice(String(old.reasoning ?? '').length),
        }
    }
    this.event(owner, profile, sessionId, patch ? 'message.patch' : 'message.upsert', patch ?? next)
    return next
  }
  reconcile(owner: string, profile: string, sessionId: string) {
    const scope: Scope = [owner, profile, sessionId]
    this.seed(...scope)
    if (this.head(...scope).running) throw new Error('Conversation is running; defer history repair')
    this.importHistory(scope, true)
  }
  seed(owner: string, profile: string, sessionId: string) {
    const scope: Scope = [owner, profile, sessionId]
    if (
      this.db
        .prepare('SELECT 1 FROM chat_transcript_heads WHERE owner=? AND profile=? AND session_id=?')
        .get(...scope)
    )
      return
    this.db.exec('SAVEPOINT transcript_seed')
    try {
      this.archive(scope)
      // v1 records were projections of the legacy writer. Preserve their source
      // for verification; do not mix their IDs/checkpoints with a v2 generation.
      for (const table of [
        'chat_transcript_messages',
        'chat_transcript_aliases',
        'chat_transcript_execution',
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE owner=? AND profile=? AND session_id=?`).run(...scope)
      this.db
        .prepare('INSERT INTO chat_transcript_heads VALUES(?,?,?,?,?)')
        .run(...scope, randomUUID(), JSON.stringify(emptyHead()))
      this.db.prepare('INSERT OR IGNORE INTO chat_transcript_scopes VALUES(?,?,?)').run(...scope)
      this.importHistory(scope, false)
      const active = this.all(...scope)
        .reverse()
        .find((m) => m.status === 'streaming' && m.role === 'assistant')
      if (active)
        this.db
          .prepare('UPDATE chat_transcript_heads SET data=? WHERE owner=? AND profile=? AND session_id=?')
          .run(
            JSON.stringify({ ...emptyHead(), turn: active.turn_id, current: active.id, running: true }),
            ...scope,
          )
      if (this.total(...scope))
        this.db
          .prepare('INSERT OR IGNORE INTO chat_transcript_repairs VALUES(?,?,?,?)')
          .run(...scope, 'pending')
      this.db.exec('RELEASE transcript_seed')
    } catch (error) {
      this.db.exec('ROLLBACK TO transcript_seed; RELEASE transcript_seed')
      throw error
    }
  }
  sessionChanged(owner: string, profile: string, sessionId: string, data: Record<string, unknown>) {
    this.reduce(owner, profile, sessionId, String(data.eventType), (data.payload ?? {}) as Data)
  }
  epochFor(...scope: Scope): string {
    return String(
      this.db
        .prepare('SELECT epoch FROM chat_transcript_heads WHERE owner=? AND profile=? AND session_id=?')
        .get(...scope)?.epoch ?? this.epoch,
    )
  }
  head(...scope: Scope): TurnHead {
    const row = this.db
      .prepare('SELECT data FROM chat_transcript_heads WHERE owner=? AND profile=? AND session_id=?')
      .get(...scope)
    return row ? JSON.parse(String(row.data)) : emptyHead()
  }
  message(owner: string, profile: string, sessionId: string, id: string): TranscriptMessage | undefined {
    const row = this.db
      .prepare(
        'SELECT data FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND id=? AND deleted=0',
      )
      .get(owner, profile, sessionId, id)
    return row ? JSON.parse(String(row.data)) : undefined
  }
  resolveMessage(
    owner: string,
    profile: string,
    sessionId: string,
    id: string,
  ): TranscriptMessage | undefined {
    return (
      this.message(owner, profile, sessionId, id) ??
      this.message(owner, profile, sessionId, this.alias(owner, profile, sessionId, `source:${id}`) ?? '')
    )
  }
  all(...scope: Scope): TranscriptMessage[] {
    return this.db
      .prepare(
        'SELECT data FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=0 ORDER BY seq,id',
      )
      .all(...scope)
      .map((row) => JSON.parse(String(row.data)))
  }
  total(...scope: Scope): number {
    return Number(
      this.db
        .prepare(
          'SELECT COUNT(*) n FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=0',
        )
        .get(...scope)!.n,
    )
  }
  private put(scope: Scope, value: Data): TranscriptMessage {
    const position = Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) n FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=?',
        )
        .get(...scope)!.n,
    )
    return this.upsert(
      ...scope,
      { timestamp: Date.now() / 1000, ...value, id: value.id ?? randomUUID() },
      position,
    )!
  }
  private bind(scope: Scope, source: string, id: string) {
    if (source)
      this.db
        .prepare(
          'INSERT INTO chat_transcript_aliases VALUES(?,?,?,?,?) ON CONFLICT(owner,profile,session_id,source) DO UPDATE SET id=excluded.id',
        )
        .run(...scope, `source:${source}`, id)
  }
  archive(scope: Scope) {
    const data = {
      messages: this.all(...scope),
      head: this.head(...scope),
      rawMessages: this.db
        .prepare(
          'SELECT message_id,position,data FROM chat_messages WHERE owner=? AND profile=? AND session_id=? ORDER BY position',
        )
        .all(...scope),
      aliases: this.db
        .prepare('SELECT source,id FROM chat_transcript_aliases WHERE owner=? AND profile=? AND session_id=?')
        .all(...scope),
    }
    if (data.messages.length || data.rawMessages.length)
      this.db
        .prepare('INSERT OR IGNORE INTO chat_transcript_archives VALUES(?,?,?,?,?,?)')
        .run(...scope, this.epochFor(...scope), JSON.stringify(data), Date.now())
  }
  private importHistory(scope: Scope, verified: boolean) {
    if (verified) this.archive(scope)
    const raw = this.db
      .prepare(
        'SELECT data,position FROM chat_messages WHERE owner=? AND profile=? AND session_id=? ORDER BY position',
      )
      .all(...scope) as { data: string; position: number }[]
    const incoming = this.enrich(
      ...scope,
      raw.map((row) => JSON.parse(row.data)),
    )
    const existing = this.all(...scope),
      retained = new Set<string>(),
      wasRead = new Set(
        this.db
          .prepare('SELECT id FROM chat_transcript_reads WHERE owner=? AND profile=? AND session_id=?')
          .all(...scope)
          .map((row) => String(row.id)),
      )
    if (
      verified &&
      existing.some(
        (m) =>
          m.role === 'user' &&
          m.status === 'complete' &&
          m.client_message_id &&
          m.source_message_id.startsWith('user:') &&
          !incoming.some(
            (source) =>
              source.role === 'user' &&
              (source.client_message_id === m.client_message_id ||
                String(source.id ?? source.message_id) === m.source_message_id),
          ),
      )
    ) {
      this.db
        .prepare(
          "INSERT INTO chat_transcript_repairs VALUES(?,?,?,'pending') ON CONFLICT(owner,profile,session_id) DO UPDATE SET status='pending'",
        )
        .run(...scope)
      return // The archive is available for verification; ambiguous live turns remain untouched.
    }
    const legacyRead = this.db
      .prepare(
        'SELECT COALESCE(final_read_count,read_count) n,read_initialized FROM chat_local_state WHERE owner=? AND profile=? AND session_id=?',
      )
      .get(...scope)
    const boundary = legacyRead?.read_initialized ? Number(legacyRead.n) : Infinity
    let turn = 'history:orphan',
      ordinal = 0
    for (const [index, source] of incoming.entries()) {
      const sourceID = String(source.id ?? source.message_id ?? raw[index]!.position)
      let known = this.resolveMessage(...scope, sourceID)
      if (source.role === 'user' && source.client_message_id)
        known ??= existing.find((m) => m.client_message_id === source.client_message_id)
      if (source.role === 'user') turn = known?.turn_id ?? `history:${sourceID}`
      const nextUser = incoming.findIndex((m, i) => i > index && m.role === 'user')
      const rest = incoming.slice(index + 1, nextUser < 0 ? undefined : nextUser)
      const final =
        isFinalChatResult(source) &&
        (source.final_result === true || !rest.some((message) => isFinalChatResult(message)))
      // Only a proven user identity can associate an upstream final with the
      // one live final of that turn. Content similarity is never an identity.
      if (!known && verified && final) {
        const candidates = existing.filter(
          (m) => m.turn_id === turn && m.final_result === true && !retained.has(m.id),
        )
        if (candidates.length === 1) known = candidates[0]
      }
      const value = this.upsert(
        ...scope,
        {
          ...source,
          id: known?.id ?? sourceID,
          source_message_id: sourceID,
          turn_id: turn,
          segment_kind:
            source.role === 'user'
              ? 'input'
              : source.role === 'tool'
                ? 'tool'
                : final
                  ? 'answer'
                  : 'commentary',
          final_result: final,
        },
        verified ? ordinal++ : raw[index]!.position,
      )!
      this.bind(scope, sourceID, value.id)
      retained.add(value.id)
      if (wasRead.has(known?.id ?? '') || raw[index]!.position < boundary)
        this.db.prepare('INSERT OR IGNORE INTO chat_transcript_reads VALUES(?,?,?,?)').run(...scope, value.id)
    }
    if (!verified) return
    // An unconfirmed local send is not disproven by a history snapshot.
    for (const message of existing)
      if (message.role === 'user' && message.status === 'pending') retained.add(message.id)
    let structural = [...retained].some((id) => !existing.some((message) => message.id === id))
    for (const message of existing)
      if (!retained.has(message.id)) {
        structural = true
        this.db
          .prepare(
            'UPDATE chat_transcript_messages SET deleted=1,revision=revision+1 WHERE owner=? AND profile=? AND session_id=? AND id=?',
          )
          .run(...scope, message.id)
        this.event(...scope, 'message.deleted', { id: message.id, revision: message.revision + 1 })
      }
    // Rebuild order only at an explicit generation boundary. Old pages/events
    // cannot be merged into this generation, even while a client is paging.
    const ordered = [...retained]
    for (const [index, id] of ordered.entries()) {
      const message = this.message(...scope, id)!
      if (message.seq !== index + 1) {
        structural = true
        this.db
          .prepare(
            'UPDATE chat_transcript_messages SET seq=?,revision=revision+1,data=? WHERE owner=? AND profile=? AND session_id=? AND id=?',
          )
          .run(
            index + 1,
            JSON.stringify({ ...message, seq: index + 1, revision: message.revision + 1 }),
            ...scope,
            id,
          )
      }
    }
    if (structural) {
      this.db
        .prepare('UPDATE chat_transcript_heads SET epoch=? WHERE owner=? AND profile=? AND session_id=?')
        .run(randomUUID(), ...scope)
      this.event(...scope, 'session.changed', {
        eventType: 'history.rebuilt',
        ...controlState(this.head(...scope)),
      })
    }
    this.db
      .prepare(
        "UPDATE chat_transcript_repairs SET status='complete' WHERE owner=? AND profile=? AND session_id=?",
      )
      .run(...scope)
  }
  markRead(owner: string, profile: string, sessionId: string, count = Infinity) {
    const head = this.head(owner, profile, sessionId)
    head.localReadEstablished = true
    this.db
      .prepare('UPDATE chat_transcript_heads SET data=? WHERE owner=? AND profile=? AND session_id=?')
      .run(JSON.stringify(head), owner, profile, sessionId)
    for (const m of this.all(owner, profile, sessionId))
      if (m.seq <= count && isFinalChatResult(m))
        this.db
          .prepare('INSERT OR IGNORE INTO chat_transcript_reads VALUES(?,?,?,?)')
          .run(owner, profile, sessionId, m.id)
  }
  unread(...scope: Scope): number {
    // Legacy read cursors can finish importing after the initial local snapshot.
    // Map only persisted source rows, never consume a live streaming result.
    const legacy = this.db
      .prepare(
        'SELECT COALESCE(final_read_count,read_count) n FROM chat_local_state WHERE owner=? AND profile=? AND session_id=? AND read_initialized=1',
      )
      .get(...scope)
    const head = this.head(...scope)
    if (legacy && !head.localReadEstablished && Number(legacy.n) > (head.importedReadPosition ?? -1)) {
      for (const row of this.db
        .prepare(
          'SELECT message_id FROM chat_messages WHERE owner=? AND profile=? AND session_id=? AND position<?',
        )
        .all(...scope, Number(legacy.n))) {
        const m = this.resolveMessage(...scope, String(row.message_id))
        if (m && isFinalChatResult(m))
          this.db.prepare('INSERT OR IGNORE INTO chat_transcript_reads VALUES(?,?,?,?)').run(...scope, m.id)
      }
      head.importedReadPosition = Number(legacy.n)
      this.db
        .prepare('UPDATE chat_transcript_heads SET data=? WHERE owner=? AND profile=? AND session_id=?')
        .run(JSON.stringify(head), ...scope)
    }
    return this.db
      .prepare(
        `SELECT m.data FROM chat_transcript_messages m LEFT JOIN chat_transcript_reads r USING(owner,profile,session_id,id)
      WHERE m.owner=? AND m.profile=? AND m.session_id=? AND m.deleted=0 AND r.id IS NULL AND json_extract(m.data,'$.final_result')=1`,
      )
      .all(...scope)
      .filter((row) => isFinalChatResult(JSON.parse(String(row.data)))).length
  }
  sourceCursor(owner: string, profile: string, sessionId: string, runtime: string, epoch: string): number {
    return Number(
      this.db
        .prepare(
          'SELECT seq FROM chat_transcript_source_cursors WHERE owner=? AND profile=? AND session_id=? AND runtime=? AND epoch=?',
        )
        .get(owner, profile, sessionId, runtime, epoch)?.seq ?? 0,
    )
  }
  recordSource(scope: Scope, frame: Data) {
    if (frame.epoch && frame.session_id && Number.isSafeInteger(frame.seq))
      this.db
        .prepare(
          'INSERT INTO chat_transcript_source_cursors VALUES(?,?,?,?,?,?) ON CONFLICT(owner,profile,session_id,runtime,epoch) DO UPDATE SET seq=MAX(seq,excluded.seq)',
        )
        .run(...scope, frame.session_id, frame.epoch, frame.seq)
  }

  /** Caller holds the transaction containing the input receipt and raw event. */
  reduce(owner: string, profile: string, sessionId: string, type: string, p: Data) {
    type =
      (
        {
          'message.started': 'message.start',
          'message.completed': 'message.complete',
          'run.complete': 'run.completed',
          'reasoning.completed': 'reasoning.complete',
          'peer.user.message': 'message.user',
          peer_user_message: 'message.user',
          'run.peer_user_message': 'message.user',
        } as Record<string, string>
      )[type] ?? type
    const scope: Scope = [owner, profile, sessionId]
    this.seed(...scope)
    const state = this.head(...scope)
    const before = JSON.stringify(state)
    const sourceID = String(p.message_id ?? p.message?.id ?? '')
    const upstreamRun = String(p.run_id ?? p.runId ?? p.inflight?.run_id ?? '')
    const knownTurn = upstreamRun ? this.alias(...scope, `source:turn:${upstreamRun}`) : undefined
    if (
      knownTurn &&
      (knownTurn !== state.turn || state.terminal) &&
      ['run.started', 'run.start', 'message.start'].includes(type)
    )
      return
    const known =
      (sourceID ? this.resolveMessage(...scope, sourceID) : undefined) ??
      (knownTurn && knownTurn !== state.turn
        ? this.all(...scope)
            .reverse()
            .find((m) => m.turn_id === knownTurn && m.role === 'assistant')
        : undefined)
    if (
      known &&
      state.turn &&
      known.turn_id !== state.turn &&
      ['message.complete', 'run.completed', 'message.delta', 'message.interim'].includes(type)
    ) {
      const terminal = ['message.complete', 'run.completed'].includes(type)
      this.put(scope, {
        ...known,
        content:
          type === 'message.delta'
            ? String(known.content ?? '') + String(p.delta ?? p.text ?? '')
            : text(p) || known.content,
        ...(terminal ? { status: 'complete', final_result: true } : {}),
      })
      return
    }
    const current = () => (state.current ? this.message(...scope, state.current) : undefined)
    const begin = () => {
      if (!state.turn || state.terminal) {
        const queued = state.queue.shift()
        state.turn = queued?.turn ?? randomUUID()
        state.current = undefined
        state.preview = false
        state.terminal = false
        state.tools = {}
        state.error = null
      }
      if (upstreamRun) this.bind(scope, `turn:${upstreamRun}`, state.turn!)
      state.running = true
      state.queued = state.queue.length > 0
    }
    const assistant = (): TranscriptMessage => {
      begin()
      const old = current()
      if (old) return old
      const created = this.put(scope, {
        role: 'assistant',
        turn_id: state.turn,
        segment_kind: 'answer',
        content: '',
        reasoning: '',
        status: 'streaming',
        final_result: false,
      })
      state.current = created.id
      return created
    }
    const saveAssistant = (value: Data) => {
      const old = assistant(),
        source = String(p.message_id ?? p.message?.id ?? '')
      const attachments = p.attachments ?? p.message?.attachments
      const saved = this.put(scope, {
        ...old,
        ...value,
        ...(attachments ? { attachments } : {}),
        ...(source ? { source_message_id: source } : {}),
      })
      this.bind(scope, source, saved.id)
      return saved
    }
    if (type === 'command.submitted') {
      const delivery = String(p.delivery_id),
        client = String(p.client_message_id ?? delivery.replace(/^(web|ios|android):prompt:/, ''))
      if (!this.alias(...scope, `client:${client}`)) {
        const previousRunning = state.running,
          steer = p.method === 'session.steer' && state.running
        const turn = steer ? state.turn! : randomUUID()
        const user = this.put(scope, {
          id: `user:${delivery}`,
          role: 'user',
          turn_id: turn,
          segment_kind: 'input',
          client_message_id: client,
          content: p.text ?? '',
          status: 'pending',
          ...(state.stagedAttachments?.length ? { attachments: state.stagedAttachments } : {}),
        })
        state.stagedAttachments = []
        state.error = null
        state.pending[delivery] = { user: user.id, turn, previousRunning }
        if (previousRunning && !steer) {
          state.queue.push({ turn, user: user.id, delivery })
          state.queued = true
        } else if (!steer) {
          state.turn = turn
          state.current = undefined
          state.preview = false
          state.terminal = false
          state.tools = {}
        }
        state.running = true
      }
    } else if (type === 'command.confirmed' || type === 'command.rejected') {
      const pending = state.pending[String(p.delivery_id)]
      if (pending) {
        const user = this.message(...scope, pending.user)
        if (user)
          this.put(scope, {
            ...user,
            status: type === 'command.rejected' ? 'failed' : 'complete',
            ...(p.error ? { error: p.error } : {}),
          })
        if (type === 'command.rejected') {
          state.queue = state.queue.filter((q) => q.delivery !== p.delivery_id)
          if (state.turn === pending.turn && !state.current) state.terminal = true
          state.running = !state.terminal || state.queue.length > 0
        }
        delete state.pending[String(p.delivery_id)]
        state.queued = state.queue.length > 0
      }
    } else if (type === 'message.user') {
      const client = String(p.client_message_id ?? p.queue_id ?? '').replace(/^(web|ios|android):prompt:/, '')
      const source = String(p.message_id ?? p.id ?? '')
      const old =
        (client
          ? this.all(...scope).find((m) => m.role === 'user' && m.client_message_id === client)
          : undefined) ?? (source ? this.resolveMessage(...scope, source) : undefined)
      if (source || client) {
        const turn = old?.turn_id ?? (p.steer ? state.turn : undefined) ?? randomUUID()
        const user = this.put(scope, {
          ...old,
          id: old?.id || source || randomUUID(),
          role: 'user',
          turn_id: turn,
          segment_kind: 'input',
          content: p.text ?? p.content ?? '',
          status: p.status === 'failed' ? 'failed' : 'complete',
          ...(client ? { client_message_id: client } : {}),
        })
        if (!old && p.status !== 'failed') {
          if (state.running && !p.steer) {
            state.queue.push({ turn, user: user.id, delivery: client || source })
            state.queued = true
          } else if (!p.steer) {
            state.turn = turn
            state.current = undefined
            state.terminal = false
            state.preview = false
          }
        }
      }
    } else if (['message.start', 'run.started', 'run.start'].includes(type)) {
      const old = current()
      if (
        type === 'message.start' &&
        sourceID &&
        old &&
        old.source_message_id !== sourceID &&
        !this.resolveMessage(...scope, sourceID) &&
        (old.content || old.reasoning || old.tool_calls)
      ) {
        this.put(scope, { ...old, status: 'complete', segment_kind: 'commentary', final_result: false })
        state.current = undefined
        state.preview = false
      }
      const row = assistant()
      if (sourceID) {
        this.bind(scope, sourceID, row.id)
        this.put(scope, { ...row, source_message_id: sourceID })
      }
    } else if (['message.delta', 'content.delta', 'assistant.delta'].includes(type) && !state.resyncing) {
      if (state.preview) {
        state.current = undefined
        state.preview = false
      }
      const old = assistant()
      saveAssistant({
        content:
          String(old.content ?? '') +
          String(p.delta ?? p.text_delta ?? p.content_delta ?? p.text ?? p.content ?? ''),
        status: 'streaming',
      })
    } else if (type === 'message.interim') {
      saveAssistant({
        content: text(p) || current()?.content || '',
        status: 'streaming',
        segment_kind: 'commentary',
        final_result: false,
      })
      state.preview = true
    } else if (type.startsWith('reasoning.') || type === 'thinking.delta' || type === 'thinking.complete') {
      const old = assistant(),
        full = p.reasoning ?? p.text ?? p.content ?? p.delta ?? ''
      saveAssistant({
        reasoning: type.endsWith('delta')
          ? String(old.reasoning ?? '') + String(p.delta ?? full)
          : String(full),
      })
    } else if (type.startsWith('tool.')) {
      const toolID = String(p.tool_call_id ?? p.tool_id ?? p.id ?? '')
      if (toolID) {
        let target = state.tools[toolID] ? this.message(...scope, state.tools[toolID]!) : undefined
        if (!target && /complete|failed/.test(type)) {
          const candidates = this.all(...scope).filter((m) =>
            (m.tool_calls as Data[] | undefined)?.some((t) => t.id === toolID),
          )
          if (candidates.length === 1) target = candidates[0]
        }
        if (!target) {
          if (state.preview) {
            const old = current()
            if (old) this.put(scope, { ...old, status: 'complete' })
            state.current = undefined
            state.preview = false
          }
          target = assistant()
          state.tools[toolID] = target.id
        }
        const tools = Array.isArray(target.tool_calls) ? ([...target.tool_calls] as Data[]) : [],
          index = tools.findIndex((t) => t.id === toolID)
        const old = index < 0 ? {} : tools[index]!,
          status = toolStatus(type, p.result ?? p.output, p.error)
        const tool = {
          ...old,
          ...p,
          id: toolID,
          status: ['completed', 'failed'].includes(old.status) && status === 'running' ? old.status : status,
        }
        if (index < 0) tools.push(tool)
        else tools[index] = tool
        this.put(scope, { ...target, tool_calls: tools })
      } else state.liveStatus = p.name ? `正在准备 ${p.name}` : state.liveStatus
    } else if (['message.complete', 'run.completed', 'run.complete', 'run.failed', 'error'].includes(type)) {
      // A replayed terminal snapshot updates the terminal slot. It never starts
      // another turn (the next run.started/delta owns advancing the queue).
      const old = current()
      const wasTerminal = state.terminal
      state.terminal = false
      const failed =
        ['run.failed', 'error'].includes(type) || p.error || ['failed', 'error'].includes(p.status)
      const interrupted = ['interrupted', 'cancelled', 'canceled'].includes(p.status)
      const output = p.output ?? p.text ?? p.content ?? p.message?.content
      if (old || output || p.attachments)
        saveAssistant({
          content: output === '' ? (old?.content ?? '') : (output ?? old?.content ?? ''),
          status: failed ? 'failed' : interrupted ? 'interrupted' : 'complete',
          segment_kind: 'answer',
          final_result: !failed && !interrupted,
          ...(failed ? { error: p.error ?? p.message ?? '运行失败' } : {}),
        })
      state.error = failed ? String(p.error ?? p.message ?? '运行失败') : null
      for (const m of this.all(...scope))
        if (m.turn_id === state.turn) {
          const calls = (m.tool_calls as Data[] | undefined)?.map((t) =>
            ['running', 'pending'].includes(t.status) ? { ...t, status: 'interrupted' } : t,
          )
          if (m.status === 'streaming' || calls)
            this.put(scope, {
              ...m,
              status: m.status === 'streaming' ? 'complete' : m.status,
              ...(calls ? { tool_calls: calls } : {}),
            })
        }
      state.terminal = true
      state.preview = false
      state.queued = state.queue.length > 0 || Number(p.queue_remaining ?? 0) > 0
      state.running = state.queued || Number(p.background_pending ?? 0) > 0
      state.resyncing = false
      state.pendingApproval = null
      state.pendingClarification = null
      state.liveStatus = null
      if (wasTerminal && state.queue.length === 0) state.running = false
    } else if (type === 'route.resumed') {
      const inflight = p.inflight ?? {},
        running = p.running === true || p.info?.running === true || inflight.streaming === true
      if (running) {
        const hadCurrent = !!current()
        begin()
        if (typeof inflight.assistant === 'string' && (!hadCurrent || state.resyncing))
          saveAssistant({ content: inflight.assistant, status: 'streaming' })
        else assistant()
      } else if (p.running === false) {
        const old = current()
        if (old && typeof inflight.assistant === 'string' && inflight.assistant)
          this.put(scope, {
            ...old,
            content: inflight.assistant,
            status: 'complete',
            final_result: true,
            segment_kind: 'answer',
          })
        state.running = false
        state.terminal = true
        state.resyncing = false
        state.queued = Boolean(p.queued?.user) || Number(p.queue_length ?? p.info?.queue_length ?? 0) > 0
        if (!state.queued) state.queue = []
        for (const m of this.all(...scope))
          if (m.status === 'streaming') this.put(scope, { ...m, status: 'complete' })
      }
      state.pendingApproval = p.pending_approval ?? inflight.pending_approval ?? null
      state.pendingClarification = p.pending_clarify ?? inflight.pending_clarify ?? null
    } else if (type === 'attachment.staged') {
      const attachment = p.attachment ?? p.file ?? p
      if (attachment.path || attachment.url)
        state.stagedAttachments = [...(state.stagedAttachments ?? []), attachment]
    } else if (type === 'gateway.reset') {
      // Without a replay barrier, a resume body can overlap deferred deltas.
      // Accept full snapshots until the terminal boundary, never append bytes
      // whose position cannot be established. The idle history job fills gaps.
      state.resyncing = true
      state.liveStatus = '正在恢复回复'
    } else if (['approval.request', 'approval.requested'].includes(type)) {
      state.pendingApproval = p
      state.running = true
    } else if (type === 'approval.resolved') state.pendingApproval = null
    else if (['clarify.request', 'clarify.requested'].includes(type)) {
      state.pendingClarification = p
      state.running = true
    } else if (['clarify.resolved', 'clarify.expire'].includes(type)) state.pendingClarification = null
    else if (type === 'status.update') {
      state.liveStatus = text(p)
      if (p.kind === 'warn') {
        const source = `status:${state.turn ?? 'session'}:warning`
        this.put(scope, {
          id: this.alias(...scope, `source:${source}`) ?? source,
          role: 'system',
          turn_id: state.turn,
          segment_kind: 'system',
          content: text(p),
          status: 'complete',
          display_kind: 'live_warning',
          final_result: false,
        })
      }
    } else if (
      [
        'compression.started',
        'compression.completed',
        'session.command',
        'session.workspace.updated',
      ].includes(type)
    ) {
      const source = `system:${state.turn ?? 'session'}:${type.startsWith('compression.') ? 'compression' : type}`
      const content =
        type === 'compression.started'
          ? '正在压缩上下文…'
          : type === 'compression.completed'
            ? '上下文压缩完成，继续回复'
            : text(p)
      if (content)
        this.put(scope, {
          id: this.alias(...scope, `source:${source}`) ?? source,
          role: 'system',
          turn_id: state.turn,
          segment_kind: 'system',
          content,
          status: type.endsWith('started') ? 'streaming' : 'complete',
          display_kind: type.startsWith('compression.') ? 'live_compression' : 'live_status',
          final_result: false,
        })
    }
    if (type === 'session.info') state.liveStatus = state.liveStatus ?? null
    this.db
      .prepare('UPDATE chat_transcript_heads SET data=? WHERE owner=? AND profile=? AND session_id=?')
      .run(JSON.stringify(state), ...scope)
    if (before !== JSON.stringify(state) || ['session.info', 'history.synced'].includes(type))
      this.event(...scope, 'session.changed', {
        eventType: type,
        payload: type === 'session.info' ? p : {},
        ...controlState(state),
      })
  }
  migrate(owner: string, profile: string, oldID: string, newID: string) {
    this.event(owner, profile, oldID, 'session.migrated', { sessionId: newID })
    for (const table of [
      'chat_transcript_messages',
      'chat_transcript_aliases',
      'chat_transcript_scopes',
      'chat_transcript_execution',
      'chat_transcript_heads',
      'chat_transcript_reads',
      'chat_transcript_source_cursors',
      'chat_transcript_repairs',
      'chat_transcript_archives',
    ])
      this.db
        .prepare(`UPDATE ${table} SET session_id=? WHERE owner=? AND profile=? AND session_id=?`)
        .run(newID, owner, profile, oldID)
  }
  remove(owner: string, profile: string, sessionId: string) {
    this.event(owner, profile, sessionId, 'session.deleted', { sessionId })
    for (const table of [
      'chat_transcript_messages',
      'chat_transcript_aliases',
      'chat_transcript_scopes',
      'chat_transcript_execution',
      'chat_transcript_heads',
      'chat_transcript_reads',
      'chat_transcript_source_cursors',
      'chat_transcript_repairs',
      'chat_transcript_archives',
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE owner=? AND profile=? AND session_id=?`)
        .run(owner, profile, sessionId)
  }
  cursor(owner: string, profile: string, sessionId: string): number {
    return Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(cursor),0) cursor FROM chat_transcript_events WHERE owner=? AND profile=? AND session_id=?',
        )
        .get(owner, profile, sessionId)!.cursor,
    )
  }
  events(owner: string, profile: string, sessionId: string, after: number, limit = 250): TranscriptEvent[] {
    return (
      this.db
        .prepare(
          'SELECT cursor,type,data FROM chat_transcript_events WHERE owner=? AND profile=? AND session_id=? AND cursor>? ORDER BY cursor LIMIT ?',
        )
        .all(owner, profile, sessionId, after, limit) as {
        cursor: number
        type: TranscriptEvent['type']
        data: string
      }[]
    ).map((row) => ({ ...row, profile, sessionId, ...JSON.parse(row.data) }))
  }
  snapshot(
    owner: string,
    profile: string,
    sessionId: string,
    session: Record<string, unknown>,
    state: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 150,
  ): TranscriptSnapshot {
    const run = this.head(owner, profile, sessionId)
    const coverage = this.db
      .prepare(
        'SELECT complete,message_total FROM chat_sessions WHERE owner=? AND profile=? AND session_id=?',
      )
      .get(owner, profile, sessionId)
    const incomplete = coverage?.complete === 0
    const rows = this.db
      .prepare(
        'SELECT data FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=0 AND seq<? ORDER BY seq DESC,id DESC LIMIT ?',
      )
      .all(owner, profile, sessionId, before, limit + 1) as { data: string }[]
    return {
      protocol: CHAT_TRANSCRIPT_FEATURE,
      epoch: this.epochFor(owner, profile, sessionId),
      cursor: this.cursor(owner, profile, sessionId),
      profile,
      sessionId,
      running: run.running,
      queued: run.queued,
      pendingApproval: run.pendingApproval,
      pendingClarification: run.pendingClarification,
      liveStatus: run.liveStatus,
      error: run.error,
      messages: rows
        .slice(0, limit)
        .reverse()
        .map((row) => JSON.parse(row.data)),
      session,
      state,
      deletedIds: (
        this.db
          .prepare(
            'SELECT id FROM chat_transcript_messages WHERE owner=? AND profile=? AND session_id=? AND deleted=1',
          )
          .all(owner, profile, sessionId) as { id: string }[]
      ).map((row) => row.id),
      hasOlder: rows.length > limit || (incomplete && before > 1),
      total: Math.max(
        this.total(owner, profile, sessionId),
        incomplete ? Number(coverage?.message_total ?? 0) : 0,
      ),
    }
  }
}
