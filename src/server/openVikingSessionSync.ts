import { createHash } from 'node:crypto'
import { OpenVikingError } from '@openviking/sdk'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceMessage, WorkspaceRun } from '../shared/workspace.js'
import type { OpenVikingSyncStatus } from '../shared/openVikingSync.js'
import type { WorkspaceStore } from './workspaceStore.js'
import type { OpenVikingService } from './openVikingService.js'
import { visibleMessageText } from '../shared/messageFiles.js'

type Payload = { role: string; content: string; createdAt: string }
type Job = { id: string; namespace: string; owner: string; agent: string; conversation: string; task: string; status: string; attempts: number; next_at: number; error: string | null; updated_at: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown) => error instanceof OpenVikingError && (error.statusCode === 404 || ['NOT_FOUND', 'ENOENT'].includes(error.code))
class Paused extends Error {}

/** A durable transcript mirror. Memory synthesis remains owned by WorkspaceMemorySynthesis. */
export class OpenVikingSessionSync {
  private timer?: ReturnType<typeof setInterval>
  private active = false
  private closed = false
  private scanningNamespace?: string
  constructor(readonly store: WorkspaceStore, readonly service: OpenVikingService, private readonly userActive: (owner: string) => boolean = () => true) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS openviking_sync_state(namespace TEXT PRIMARY KEY, scan_row INTEGER NOT NULL DEFAULT 0, scanned INTEGER NOT NULL DEFAULT 0, event_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS openviking_sync_jobs(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, owner TEXT NOT NULL, agent TEXT NOT NULL, conversation TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, synced_messages INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS openviking_sync_pending ON openviking_sync_jobs(namespace,status,next_at);
      CREATE TABLE IF NOT EXISTS openviking_sync_messages(session TEXT NOT NULL, message TEXT NOT NULL, seq INTEGER NOT NULL, ready INTEGER NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(session,message));
    `)
  }
  start(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => { void this.tick() }, 1000)
    this.timer.unref()
    void this.tick()
  }
  close(): void { this.closed = true; clearInterval(this.timer) }
  status(): OpenVikingSyncStatus {
    const namespace = this.service.namespace
    const rows = this.store.db.prepare('SELECT status,COUNT(*) AS n FROM openviking_sync_jobs WHERE namespace=? GROUP BY status').all(namespace)
    const count = (status: string) => Number(rows.find(row => row.status === status)?.n ?? 0)
    const state = this.store.db.prepare('SELECT scanned FROM openviking_sync_state WHERE namespace=?').get(namespace)
    const error = this.store.db.prepare("SELECT error FROM openviking_sync_jobs WHERE namespace=? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(namespace)
    return { enabled: this.service.enabled, backfilling: this.service.enabled && !state?.scanned, pending: count('pending'), complete: count('complete'), failed: count('failed'), ...(error?.error ? { lastError: String(error.error) } : {}) }
  }
  retry(): OpenVikingSyncStatus {
    this.store.db.prepare("UPDATE openviking_sync_jobs SET status='pending',attempts=0,next_at=0,error=NULL WHERE namespace=? AND status='failed'").run(this.service.namespace)
    return this.status()
  }
  private current(namespace: string): void {
    if (this.closed || !this.service.enabled || this.service.namespace !== namespace) throw new Paused()
  }
  private job(owner: string, agentId: string, message: WorkspaceMessage): Job | undefined {
    const agent = this.store.get<WorkspaceAgent>(owner, 'agent', agentId)
    if (!agent || agent.temporaryGoalId || !this.store.get(owner, 'conversation', message.conversationId)) return
    if (message.conversationTaskId && !this.store.get(owner, 'conversation-task', message.conversationTaskId)) return
    const namespace = this.service.namespace, task = message.conversationTaskId ?? ''
    const id = `yy-${hash(JSON.stringify([namespace, owner, agentId, message.conversationId, task]))}`
    this.store.db.prepare('INSERT OR IGNORE INTO openviking_sync_jobs(id,namespace,owner,agent,conversation,task,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, namespace, owner, agentId, message.conversationId, task, Date.now())
    return this.store.db.prepare('SELECT * FROM openviking_sync_jobs WHERE id=?').get(id) as unknown as Job
  }
  private enqueue(owner: string, agentId: string, message: WorkspaceMessage, role?: string): void {
    if (message.visible === false) return
    const job = this.job(owner, agentId, message)
    if (!job) return
    const shown = this.store.messageForDisplay(owner, message)
    const content = shown.communication?.content ?? (message.role === 'assistant' ? visibleMessageText(shown.content) : shown.content)
    const attachments = shown.attachments.map(file => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size }))
    const text = content + (attachments.length ? `\n\n附件：${JSON.stringify(attachments)}` : '')
    const ready = message.role !== 'assistant' || ['complete', 'failed', 'interrupted'].includes(message.status)
    const payload = ready && text.trim() ? JSON.stringify({ role: role ?? message.role, content: text, createdAt: new Date(message.createdAt).toISOString() } satisfies Payload) : ''
    const fingerprint = hash(payload)
    const old = this.store.db.prepare('SELECT fingerprint,ready,seq FROM openviking_sync_messages WHERE session=? AND message=?').get(job.id, message.id)
    if (old?.fingerprint === fingerprint && old.ready === Number(ready) && old.seq === message.seq) return
    this.store.db.prepare('INSERT INTO openviking_sync_messages VALUES(?,?,?,?,?,?) ON CONFLICT(session,message) DO UPDATE SET seq=excluded.seq,ready=excluded.ready,payload=excluded.payload,fingerprint=excluded.fingerprint')
      .run(job.id, message.id, message.seq, Number(ready), payload, fingerprint)
    this.store.db.prepare("UPDATE openviking_sync_jobs SET status=CASE WHEN status='failed' THEN status ELSE 'pending' END,updated_at=? WHERE id=?").run(Date.now(), job.id)
  }
  private ingest(owner: string, message: WorkspaceMessage): void {
    if (owner.startsWith('_') || message.visible === false) return
    if (message.role === 'assistant' && message.agentId) {
      const run = message.runId ? this.store.get<WorkspaceRun>(owner, 'run', message.runId) : undefined
      const source = run && this.store.get<WorkspaceMessage>(owner, 'message', run.messageId)
      if (source && source.conversationId === message.conversationId && source.conversationTaskId === message.conversationTaskId) {
        if (source.role === 'user') this.enqueue(owner, message.agentId, source)
        else if (source.peerMessageId) this.enqueue(owner, message.agentId, source, 'user')
      }
      this.enqueue(owner, message.agentId, message)
    } else if (message.role === 'user') {
      const conversation = this.store.get<WorkspaceConversation>(owner, 'conversation', message.conversationId)
      if (conversation?.kind === 'direct' && conversation.memberIds[0]) this.enqueue(owner, conversation.memberIds[0], message)
    } else if (message.peerMessageId) {
      const peer = this.store.get<{ fromAgentId: string; toAgentId?: string; originConversationId: string; originTaskId?: string; conversationId: string; taskId?: string }>(owner, 'peer-message', message.peerMessageId)
      if (!peer) return
      const incoming = !!message.runId && message.conversationId === peer.conversationId && message.conversationTaskId === peer.taskId
      const outgoing = !message.runId && message.conversationId === peer.originConversationId && message.conversationTaskId === peer.originTaskId
      if (incoming && peer.toAgentId) this.enqueue(owner, peer.toAgentId, message, 'user')
      if (outgoing) this.enqueue(owner, peer.fromAgentId, message, 'assistant')
    }
  }
  private discover(namespace: string): boolean {
    const cursor = Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM workspace_events').get()!.n)
    this.store.db.prepare('INSERT OR IGNORE INTO openviking_sync_state(namespace,event_seq) VALUES(?,?)').run(namespace, cursor)
    const state = this.store.db.prepare('SELECT * FROM openviking_sync_state WHERE namespace=?').get(namespace)!
    this.store.atomic(() => {
      if (!state.scanned) {
        const rows = this.store.db.prepare("SELECT rowid,owner,data FROM workspace_entities WHERE kind='message' AND rowid>? ORDER BY rowid LIMIT 250").all(Number(state.scan_row))
        for (const row of rows) this.ingest(String(row.owner), JSON.parse(String(row.data)))
        this.store.db.prepare('UPDATE openviking_sync_state SET scan_row=?,scanned=? WHERE namespace=?')
          .run(Number(rows.at(-1)?.rowid ?? state.scan_row), Number(rows.length < 250), namespace)
      }
      const events = this.store.db.prepare('SELECT * FROM workspace_events WHERE seq>? ORDER BY seq LIMIT 250').all(Number(state.event_seq))
      for (const event of events) {
        const owner = String(event.owner), data = JSON.parse(String(event.data))
        if (event.type === 'message.changed' || event.type === 'message.patch') {
          const message = this.store.get<WorkspaceMessage>(owner, 'message', data.id ?? data.messageId)
          if (message) this.ingest(owner, message)
        }
        if (['conversation.deleted', 'agent.deleted', 'conversation.task.deleted', 'task.deleted'].includes(String(event.type))) {
          this.store.db.prepare("UPDATE openviking_sync_jobs SET status='pending',attempts=0,next_at=0 WHERE namespace=? AND owner=? AND (conversation=? OR agent=? OR task=?)")
            .run(namespace, owner, data.id, data.id, data.id)
        }
      }
      this.store.db.prepare('UPDATE openviking_sync_state SET event_seq=? WHERE namespace=?').run(Number(events.at(-1)?.seq ?? state.event_seq), namespace)
    })
    const next = this.store.db.prepare('SELECT * FROM openviking_sync_state WHERE namespace=?').get(namespace)!
    return !!next.scanned && Number(next.event_seq) >= cursor
  }
  private exists(job: Job): boolean {
    return !!this.store.get(job.owner, 'agent', job.agent) && !!this.store.get(job.owner, 'conversation', job.conversation)
      && (!job.task || !!this.store.get(job.owner, 'conversation-task', job.task))
  }
  private async sync(job: Job): Promise<void> {
    const check = () => this.current(job.namespace)
    check()
    if (!this.userActive(job.owner)) { this.store.db.prepare('UPDATE openviking_sync_jobs SET next_at=? WHERE id=?').run(Date.now() + 30_000, job.id); return }
    if (!this.exists(job)) {
      if (!this.store.get(job.owner, 'agent', job.agent) && this.service.binding(job.owner, job.agent)?.pendingRemoval) {
        await this.service.removeUser(job.owner, { id: job.agent }); check()
      }
      if (this.service.binding(job.owner, job.agent)?.status === 'active') {
        try { await this.service.userClient(job.owner, job.agent).deleteSession(job.id) } catch (error) { if (!missing(error)) throw error }
      }
      check()
      this.store.db.prepare("UPDATE openviking_sync_jobs SET status='deleted',error=NULL WHERE id=?").run(job.id)
      this.store.db.prepare('DELETE FROM openviking_sync_messages WHERE session=?').run(job.id)
      return
    }
    const agent = this.store.require<WorkspaceAgent>(job.owner, 'agent', job.agent)
    await this.service.ensureUser(job.owner, agent); check()
    if (!this.exists(job)) return
    const client = this.service.userClient(job.owner, job.agent)
    let info: Record<string, unknown>
    try { info = await client.getSession(job.id) } catch (error) {
      if (!missing(error)) throw error
      check()
      if (!this.exists(job)) return
      await client.createSession({ sessionId: job.id, memoryPolicy: { self: { enabled: false }, peer: { enabled: false }, working_memory: { enabled: false } } })
      info = await client.getSession(job.id)
    }
    check()
    // Older servers have no auto-commit policy; newer servers may inherit one.
    if (info.auto_commit_policy) { await this.service.disableSessionAutoCommit(job.owner, job.agent, job.id); check() }
    const uri = typeof info.uri === 'string' ? info.uri : `viking://session/${job.id}`
    let raw = ''
    try { raw = await client.read(`${uri}/messages.jsonl`) } catch (error) { if (!missing(error) || Number(info.message_count ?? 0) > 0) throw error }
    check()
    const remote: Payload[] = raw.split('\n').filter(line => line.trim()).map(line => {
      const row = JSON.parse(line)
      return { role: row.role, content: Array.isArray(row.parts) ? row.parts.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') : row.content ?? '', createdAt: new Date(row.created_at).toISOString() }
    })
    const rows = this.store.db.prepare('SELECT * FROM openviking_sync_messages WHERE session=? ORDER BY seq,message').all(job.id)
    const desired: Payload[] = []
    let unfinished = false
    for (const row of rows) {
      if (!row.ready) { unfinished = true; break }
      if (row.payload) desired.push(JSON.parse(String(row.payload)))
    }
    for (let i = 0; i < remote.length; i++) {
      if (!desired[i] || JSON.stringify(remote[i]) !== JSON.stringify(desired[i])) throw new Error('OpenViking 会话记录与本地顺序不一致，已停止追加，请核对会话')
    }
    if (!this.exists(job)) return
    const batch = desired.slice(remote.length, remote.length + 100)
    if (batch.length) { await client.batchAddMessages(job.id, batch); check() }
    if (!this.exists(job)) return
    const complete = !unfinished && remote.length + batch.length === desired.length
    this.store.db.prepare('UPDATE openviking_sync_jobs SET status=?,synced_messages=?,attempts=0,next_at=?,error=NULL,updated_at=? WHERE id=?')
      .run(complete ? 'complete' : 'pending', remote.length + batch.length, unfinished && !batch.length ? Date.now() + 5000 : 0, Date.now(), job.id)
  }
  async tick(): Promise<void> {
    if (this.active || this.closed) return
    if (!this.service.enabled) { this.scanningNamespace = undefined; return }
    this.active = true
    const namespace = this.service.namespace
    try {
      // Reconcile retained history on every service start / re-enable as well as
      // consuming durable events, including databases whose events were pruned.
      if (this.scanningNamespace !== namespace) {
        this.store.db.prepare('UPDATE openviking_sync_state SET scan_row=0,scanned=0 WHERE namespace=?').run(namespace)
        this.scanningNamespace = namespace
      }
      if (!this.discover(namespace)) return
      // Deletions also recover when an old database has already pruned its events.
      this.store.db.prepare("UPDATE openviking_sync_jobs SET status='pending',next_at=0 WHERE namespace=? AND status='complete' AND (NOT EXISTS(SELECT 1 FROM workspace_entities e WHERE e.owner=openviking_sync_jobs.owner AND e.kind='agent' AND e.id=openviking_sync_jobs.agent) OR NOT EXISTS(SELECT 1 FROM workspace_entities e WHERE e.owner=openviking_sync_jobs.owner AND e.kind='conversation' AND e.id=openviking_sync_jobs.conversation) OR (task!='' AND NOT EXISTS(SELECT 1 FROM workspace_entities e WHERE e.owner=openviking_sync_jobs.owner AND e.kind='conversation-task' AND e.id=openviking_sync_jobs.task)))").run(namespace)
      const jobs = this.store.db.prepare("SELECT * FROM openviking_sync_jobs WHERE namespace=? AND status='pending' AND next_at<=? ORDER BY updated_at LIMIT 4").all(namespace, Date.now()) as unknown as Job[]
      for (const job of jobs) {
        try { await this.sync(job) } catch (error) {
          if (error instanceof Paused || this.closed) break
          const attempts = job.attempts + 1
          // Remote errors can contain request details; expose only a short error message.
          const message = error instanceof Error ? error.message.slice(0, 400) : 'OpenViking 会话同步失败'
          this.store.db.prepare('UPDATE openviking_sync_jobs SET status=?,attempts=?,next_at=?,error=?,updated_at=? WHERE id=?')
            .run(attempts >= 3 ? 'failed' : 'pending', attempts, Date.now() + 2000 * 2 ** attempts, message, Date.now(), job.id)
        }
      }
    } catch (error) {
      if (!this.closed && !(error instanceof Paused)) console.error('OpenViking 会话同步队列异常', error instanceof Error ? error.message : '未知错误')
    } finally { this.active = false }
  }
}
