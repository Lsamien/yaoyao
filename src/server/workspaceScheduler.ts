import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from './workspaceStore.js'
import { HttpError } from './errors.js'
import { discussionOrder } from './workspaceDiscussion.js'
import { botRelayIntent, relayFingerprint, relayMessageValue, REPEATED_RELAY_NOTICE } from './workspaceRelay.js'
import type { WorkspaceAgent as Agent, WorkspaceConversation as Conversation, WorkspaceMessage as Message, WorkspaceRun as Run, WorkspaceInteraction } from '../shared/workspace.js'

export const NO_REPLY = '[[YAOYAO_NO_REPLY_V1]]'
export const WORKSPACE_CONCURRENCY_LIMIT = 10
export const HOST_FALLBACK = '我还不能确定你希望我处理什么，请补充具体目标、范围，或明确需要我协调的机器人。'
const terminal = (status: string) => ['complete', 'failed', 'interrupted'].includes(status)
export interface Work {
  discussionIndex?: number
  resourceWait?:boolean
  id: string
  runId: string
  conversationId: string
  conversationTaskId?: string
  agentId: string
  messageId: string
  triggerSeq: number
  depth: number
  batchId: string
  reviewOf?: string
  replyMode: 'mentioned' | 'automatic'
  requiredReply: boolean
  status: Run['status']
  currentMessageId?: string
  submitted?: boolean
  /** Revision captured when this turn receives a team-management grant. */
  teamManagementRevision?: number
  cancelRequested?: boolean
  planned?: boolean
  silent?: boolean
  hadInteraction?: boolean
  /** Durable assistant-to-assistant routing decisions, scoped to this run. */
  relay?: {
    fingerprints: Record<string, string>
    suppressed: Record<string, 'acknowledgement' | 'repeated'>
    notice?: boolean
  }
  error?: string
  contextThroughSeq?: number
  turnConfiguration?: { mode: 'host' | 'free'; administratorId: string; members: Array<Pick<Agent, 'id' | 'name'>> }
  createdAt: number
}

/** Durable per-member work and cascade ledger; Hermes transport lives in WorkspaceRuntime. */
export abstract class WorkspaceScheduler {
  protected closing = false
  protected executing = new Set<string>()
  private wakePending = false
  private pumping = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private recoverAfter = new Map<string, number>()
  private attempts = new Map<string, number>()
  private interrupting = new Set<string>()
  onMessage: (owner: string, message: Message) => Promise<void> = async () => {}
  onNotify: (owner: string, c: Conversation, run: Run, message?: Message, interaction?: WorkspaceInteraction) => void = () => {}
  onRunSettled: (owner: string, run: Run) => void = () => {}
  constructor(readonly store: WorkspaceStore, readonly userActive: (owner: string) => boolean = () => true) {
    for (const owner of store.owners()) {
      // Forward the already-admitted v0.3.x turn without replaying its prompt.
      for (const root of store.list<Run & { queue?: string[]; next?: string[]; hostReturn?: boolean; round: number; currentMessageId?: string; turnConfiguration?: Work['turnConfiguration'] }>(owner, 'run')) {
        if (terminal(root.status) || this.works(owner, root.id).length) continue
        const c = store.require<Conversation>(owner, 'conversation', root.conversationId)
        const trigger = store.require<Message>(owner, 'message', root.messageId)
        const continuation = root.queue?.length === 0
        const ids = continuation ? root.hostReturn ? [c.administratorId] : root.next ?? [] : root.queue ?? [root.activeAgentId ?? c.administratorId]
        if (!ids.length && root.currentMessageId) {
          const agentId = store.get<Message>(owner, 'message', root.currentMessageId)?.agentId ?? root.activeAgentId
          if (agentId) ids.push(agentId)
        }
        if (!ids.length) { root.status = root.stopRequested ? 'interrupted' : 'complete'; store.saveRun(owner, root); continue }
        const last = store.messages(owner, c.id).filter(m => m.runId === root.id).at(-1)
        for (const [index, id] of ids.entries()) {
          const work = this.enqueue(owner, root, id, root.round + (continuation && !root.hostReturn ? 1 : 0), root.id, last?.seq ?? trigger.seq, 'mentioned', id === c.administratorId)
          if (index === 0 && root.currentMessageId) {
            Object.assign(work, { currentMessageId: root.currentMessageId, submitted: true, status: 'uncertain', turnConfiguration: root.turnConfiguration })
            store.put(owner, 'turn', work.id, work)
            const key = this.bindingKey(c.id, root.conversationTaskId, id)
            const binding = store.get<{ runId: string; messageId: string; taskId?: string }>(owner, 'binding', key)
            if (binding?.runId === root.id && binding.messageId === root.currentMessageId) {
              binding.taskId = work.id; store.put(owner, 'binding', key, binding)
            }
          }
        }
      }
      for (const work of this.works(owner)) {
        if (['running', 'waiting'].includes(work.status)) {
          work.status = work.submitted ? 'uncertain' : 'queued'
          work.error = work.submitted ? '服务已重启，正在核对原执行' : undefined
          store.put(owner, 'turn', work.id, work)
        }
      }
    }
  }
  protected notify(owner: string, c: Conversation, run: Run, message?: Message, interaction?: WorkspaceInteraction): void {
    try { this.onNotify(owner, c, run, message, interaction) } catch { /* Push cannot change execution. */ }
  }
  protected abstract performTurn(owner: string, c: Conversation, agent: Agent, work: Work, recovering: boolean): Promise<Message>
  protected abstract interruptTurn(owner: string, work: Work): Promise<void>
  protected bindingKey(conversationId: string, conversationTaskId: string | undefined, agentId: string): string {
    return conversationTaskId ? `${conversationId}:${conversationTaskId}:${agentId}` : `${conversationId}:${agentId}`
  }
  protected works(owner: string, runId?: string): Work[] {
    return this.store.db.prepare(`SELECT data FROM workspace_entities WHERE owner=? AND kind='turn' ${runId ? "AND json_extract(data,'$.runId')=?" : ''}`).all(...(runId ? [owner, runId] : [owner]))
      .map(row => JSON.parse(String(row.data)) as Work)
  }
  private pendingWorks(owner: string): Work[] {
    return this.store.db.prepare("SELECT data FROM workspace_entities WHERE owner=? AND kind='turn' AND (json_extract(data,'$.status') NOT IN ('complete','failed','interrupted') OR coalesce(json_extract(data,'$.planned'),0)=0)").all(owner)
      .map(row => JSON.parse(String(row.data)) as Work)
  }
  protected getWork(owner: string, id: string): Work { return this.store.require(owner, 'turn', id) }
  protected saveWork(owner: string, work: Work): void {
    this.store.atomic(() => { this.store.put(owner, 'turn', work.id, work); this.updateRoot(owner, work.runId) })
  }
  protected enqueue(owner: string, root: Run, agentId: string, depth: number, batchId: string, triggerSeq: number, replyMode: Work['replyMode'], requiredReply: boolean, reviewOf?: string): Work {
    const existing = this.works(owner, root.id).find(w => reviewOf ? w.reviewOf === reviewOf : w.agentId === agentId && w.depth === depth && !w.reviewOf)
    if (existing) return existing
    const work: Work = { id: randomUUID(), runId: root.id, conversationId: root.conversationId, conversationTaskId: root.conversationTaskId, agentId, messageId: root.messageId, depth, batchId, triggerSeq, replyMode, requiredReply, reviewOf, status: 'queued', createdAt: Date.now() }
    this.store.put(owner, 'turn', work.id, work)
    return work
  }
  protected admit(owner: string, root: Run, c: Conversation, trigger: Message): void {
    this.store.put(owner, 'run', root.id, root)
    if (root.discussion) {
      const first = discussionOrder(root.discussion)[0]
      if (first) {
        const work = this.enqueue(owner, root, first.agentId, 0, root.id, trigger.seq, 'mentioned', false)
        work.discussionIndex = 0
        this.store.put(owner, 'turn', work.id, work)
      }
      this.updateRoot(owner, root.id)
      return
    }
    const targeted = root.targetAgentId
    const ids = targeted ? [root.targetAgentId!] : c.kind === 'direct' || c.mode === 'host' ? [c.administratorId]
      : root.mentionIds.length ? root.mentionIds : [...new Set([c.administratorId, ...c.autoReplyIds])]
    for (const id of ids) this.enqueue(owner, root, id, 0, root.id, trigger.seq,
      c.kind === 'direct' || targeted ? 'mentioned' : c.mode === 'host' || !root.mentionIds.length ? 'automatic' : 'mentioned', !!targeted || c.kind === 'group' && id === c.administratorId && (c.mode === 'host' || !root.mentionIds.length))
    this.updateRoot(owner, root.id)
  }
  start(): void { this.wake() }
  wake(): void {
    if (this.closing || this.wakePending) return
    this.wakePending = true
    queueMicrotask(() => { this.wakePending = false; if (!this.closing) this.pump() })
  }
  private retrySoon(): void {
    if (this.closing || this.retryTimer) return
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.wake() }, 500)
    this.retryTimer.unref()
  }
  private updateRoot(owner: string, id: string): void {
    const root = this.store.require<Run>(owner, 'run', id), tasks = this.works(owner, id)
    const active = tasks.filter(t => !terminal(t.status))
    const done = !active.length && tasks.every(t => t.planned)
    const wasTerminal = terminal(root.status)
    root.round = Math.max(0, ...tasks.map(t => t.depth))
    root.activeAgentId = active.find(t => t.status !== 'queued')?.agentId ?? active[0]?.agentId
    if (done) {
      const interrupted = root.stopRequested || tasks.some(t => t.requiredReply && t.status === 'interrupted') || (tasks.length > 0 && tasks.every(t => t.status === 'interrupted'))
      const failed = tasks.some(t => t.status === 'failed' && (t.requiredReply || this.store.require<Conversation>(owner, 'conversation', root.conversationId).kind === 'direct'))
        || !!root.discussion && tasks.length > 0 && tasks.every(t => ['failed', 'interrupted'].includes(t.status))
      root.status = interrupted ? 'interrupted' : failed ? 'failed' : 'complete'
    } else {
      root.status = active.some(t => t.status === 'uncertain') ? 'uncertain' : active.some(t => t.status === 'running') ? 'running' : active.some(t => t.status === 'waiting') ? 'waiting' : tasks.some(t => t.status !== 'queued') ? 'running' : 'queued'
    }
    root.error = tasks.find(t => t.status === 'uncertain' || t.status === 'failed')?.error
    this.store.saveRun(owner, root)
    if (done && !wasTerminal) this.onRunSettled(owner, root)
    if (done && !wasTerminal && root.status !== 'interrupted') {
      const c = this.store.require<Conversation>(owner, 'conversation', root.conversationId)
      if (root.status === 'failed' && c.kind === 'direct') this.store.saveMessage(owner, { id: randomUUID(), conversationId: c.id, conversationTaskId: root.conversationTaskId, seq: 0, role: 'system', content: `执行失败：${root.error ?? '运行失败'}`, reasoning: '', status: 'failed', runId: root.id, attachments: [], tools: [], createdAt: Date.now() })
      this.notify(owner, c, root, this.store.messages(owner, c.id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false, root.conversationTaskId).filter(m => m.runId === id && m.visible !== false).at(-1))
    }
  }
  private plan(owner: string, id: string): void {
    this.store.atomic(() => {
      const work = this.getWork(owner, id)
      if (!terminal(work.status) || work.planned) return
      const root = this.store.require<Run>(owner, 'run', work.runId), c = this.store.require<Conversation>(owner, 'conversation', work.conversationId)
      work.planned = true
      this.store.put(owner, 'turn', work.id, work)
      if (root.discussion && !root.stopRequested && !c.archived) {
        const order = discussionOrder(root.discussion)
        let index = (work.discussionIndex ?? 0) + 1
        while (index < order.length) {
          const next = order[index]!
          const agent = this.store.get<Agent>(owner, 'agent', next.agentId)
          if (agent && !agent.archived && c.memberIds.includes(next.agentId)) {
            const through = Math.max(work.triggerSeq, ...this.works(owner, root.id).map(w => w.currentMessageId ? this.store.get<Message>(owner, 'message', w.currentMessageId)?.seq ?? 0 : 0))
            const queued = this.enqueue(owner, root, next.agentId, next.round, root.id, through, 'mentioned', false)
            queued.discussionIndex = index
            this.store.put(owner, 'turn', queued.id, queued)
            break
          }
          index++
        }
        this.updateRoot(owner, root.id)
        return
      }
      if (root.stopRequested || c.archived || c.kind === 'direct' || root.assignmentId || root.goalId || root.peerMessageId) { this.updateRoot(owner, root.id); return }
      const config = work.turnConfiguration ?? { mode: c.mode, administratorId: c.administratorId, members: c.memberIds.map(id => this.store.require<Agent>(owner, 'agent', id)) }
      const message = work.currentMessageId ? this.store.get<Message>(owner, 'message', work.currentMessageId) : undefined
      if (config.mode === 'host' && work.agentId !== config.administratorId) {
        const batch = this.works(owner, root.id).filter(t => t.batchId === work.batchId && !t.reviewOf)
        if (batch.every(t => terminal(t.status))) {
          const through = Math.max(work.triggerSeq, ...batch.map(t => t.currentMessageId ? this.store.get<Message>(owner, 'message', t.currentMessageId)?.seq ?? 0 : 0))
          this.enqueue(owner, root, c.administratorId, work.depth, `review:${work.batchId}`, through, 'automatic', true, work.batchId)
        }
      } else if (work.status === 'complete' && !work.silent && message) {
        const nextDepth = work.depth + 1
        const intent = botRelayIntent(message.content, config.members)
        const eligible = (id: string) => id !== work.agentId && this.store.taskMemberIds(owner, c, work.conversationTaskId).includes(id)
        const mentions = intent.targetIds.filter(eligible)
        // A filtered mention is still an explicit address. Never turn a closing
        // receipt back into a broadcast through the automatic participant list.
        const automatic = config.mode === 'free' ? c.autoReplyIds.filter(eligible) : []
        const targets = intent.mentionedIds.length ? mentions : intent.acknowledgementOnly ? [] : automatic
        work.relay = { fingerprints: {}, suppressed: {} }
        for (const target of intent.mentionedIds.filter(eligible)) {
          if (!mentions.includes(target)) work.relay.suppressed[target] = 'acknowledgement'
        }
        if (intent.acknowledgementOnly && !intent.mentionedIds.length)
          for (const target of automatic) work.relay.suppressed[target] = 'acknowledgement'
        if (targets.length && (c.maxReplyRounds === -1 || nextDepth < c.maxReplyRounds)) {
          const works = this.works(owner, root.id).filter(t => t.conversationId === c.id && t.conversationTaskId === work.conversationTaskId)
          const evidence = this.relayEvidence(owner, work, works)
          const previous = works.filter(t => t.id !== work.id && t.agentId === work.agentId && t.status === 'complete' && t.planned)
          const legacyEvidence = new Map<string, unknown>()
          for (const target of targets) {
            const fingerprint = evidence === undefined ? undefined : relayFingerprint({ target, evidence })
            if (fingerprint) work.relay.fingerprints[target] = fingerprint
            const repeated = fingerprint && previous.some(t => {
              if (t.relay) return t.relay.fingerprints[target] === fingerprint
              // Pre-upgrade turns have no receipt. Only a persisted child is
              // evidence that this particular edge was actually dispatched.
              if (!works.some(child => child.batchId === t.id && child.agentId === target && !child.reviewOf)) return false
              if (!legacyEvidence.has(t.id)) legacyEvidence.set(t.id, this.relayEvidence(owner, t, works))
              const old = legacyEvidence.get(t.id)
              return old !== undefined && relayFingerprint({ target, evidence: old }) === fingerprint
            })
            if (repeated) { work.relay.suppressed[target] = 'repeated'; continue }
            this.enqueue(owner, root, target, nextDepth, work.id, message.seq, mentions.includes(target) ? 'mentioned' : 'automatic', false)
          }
          if (Object.values(work.relay.suppressed).includes('repeated') && !works.some(t => t.relay?.notice)) {
            work.relay.notice = true
            this.store.saveMessage(owner, { id: randomUUID(), conversationId: c.id, conversationTaskId: root.conversationTaskId, seq: 0, role: 'system', content: REPEATED_RELAY_NOTICE, reasoning: '', status: 'complete', runId: root.id, attachments: [], tools: [], createdAt: Date.now() })
          }
        } else if (targets.length && !this.store.get(owner, 'limit-notice', root.id)) {
          this.store.put(owner, 'limit-notice', root.id, { id: root.id })
          this.store.saveMessage(owner, { id: randomUUID(), conversationId: c.id, conversationTaskId: root.conversationTaskId, seq: 0, role: 'system', content: '已达到自动协作轮数上限，本轮不再自动分派。', reasoning: '', status: 'complete', runId: root.id, attachments: [], tools: [], createdAt: Date.now() })
        }
        this.store.put(owner, 'turn', work.id, work)
      }
      this.updateRoot(owner, root.id)
    })
  }
  private relayEvidence(owner: string, work: Work, works: Work[]): unknown | undefined {
    const read = (id?: string) => {
      const message = id ? this.store.get<Message>(owner, 'message', id) : undefined
      return message?.conversationId === work.conversationId && message.conversationTaskId === work.conversationTaskId && message.runId === work.runId ? message : undefined
    }
    const reply = read(work.currentMessageId)
    if (!reply) return undefined
    const inputs = work.reviewOf ? works.filter(t => t.batchId === work.reviewOf && !t.reviewOf).sort((a, b) => a.agentId.localeCompare(b.agentId))
      : works.filter(t => t.id === work.batchId)
    let input: unknown
    if (inputs.length) {
      input = inputs.map(t => {
        const message = read(t.currentMessageId)
        return { agentId: t.agentId, status: t.status, error: t.error, message: message ? relayMessageValue(message) : null }
      })
    } else {
      // Initial turns and the legacy admission path have no parent Work.
      const row = this.store.db.prepare("SELECT data FROM workspace_entities WHERE owner=? AND kind='message' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.seq')=?").get(owner, work.conversationId, work.triggerSeq)
      const trigger = row ? read((JSON.parse(String(row.data)) as Message).id) : undefined
      if (!trigger) return undefined
      input = relayMessageValue(trigger)
    }
    const relevant = new Set([work.id, ...inputs.map(t => t.id)])
    const interactions = this.store.list<WorkspaceInteraction & { answer?: string; responseState?: string }>(owner, 'interaction')
      .filter(i => i.runId === work.runId && i.conversationId === work.conversationId && i.conversationTaskId === work.conversationTaskId && i.answer !== undefined && i.responseState === 'sent'
        && relevant.has(this.store.get<{ taskId: string }>(owner, 'interaction-binding', i.id)?.taskId ?? ''))
      // A fresh human answer is permission to advance, even if the person
      // chooses the same answer again. This is not a provider event ID.
      .map(i => ({ id: i.id, kind: i.kind, question: i.message, answer: i.answer })).sort((a, b) => a.id.localeCompare(b.id))
    return { version: 1, agentId: work.agentId, mode: work.turnConfiguration?.mode, input, reply: relayMessageValue(reply), interactions }
  }
  private pump(): void {
    if (this.pumping || this.closing) return
    this.pumping = true
    try {
      let all = this.store.owners().flatMap(owner => this.pendingWorks(owner).map(work => ({ owner, work })))
      for (const { owner, work } of all) {
        if (['running', 'waiting'].includes(work.status) && !this.executing.has(work.id)) {
          work.status = work.submitted ? 'uncertain' : 'queued'
          this.saveWork(owner, work)
        }
      }
      for (const { owner, work } of all) if (terminal(work.status) && !work.planned && !this.executing.has(work.id)) this.plan(owner, work.id)
      all = this.store.owners().flatMap(owner => this.pendingWorks(owner).map(work => ({ owner, work })))
      all.sort((a, b) => {
        const priority = (entry: typeof a) => {
          if (Date.now() - entry.work.createdAt > 60_000) return 0
          const run = this.store.get<Run>(entry.owner, 'run', entry.work.runId)
          if (run?.triggerKind === 'peer' && run.priority) return 0.5
          return run?.triggerKind === 'assignment' ? 2 : run?.triggerKind ? 1 : 0
        }
        const difference = priority(a) - priority(b)
        if (difference) return difference
        const am = this.store.require<Message>(a.owner, 'message', a.work.messageId), bm = this.store.require<Message>(b.owner, 'message', b.work.messageId)
        return am.createdAt - bm.createdAt || (a.work.conversationId === b.work.conversationId && a.work.conversationTaskId === b.work.conversationTaskId ? am.seq - bm.seq : 0) || a.work.createdAt - b.work.createdAt || a.work.id.localeCompare(b.work.id)
      })
      for (const { owner, work: candidate } of all) {
        const work = this.getWork(owner, candidate.id)
        if (work.cancelRequested && work.status === 'uncertain' && this.executing.has(work.id)) {
          if ((this.recoverAfter.get(work.id) ?? 0) > Date.now()) { this.retrySoon(); continue }
          if (!this.interrupting.has(work.id)) {
            this.interrupting.add(work.id)
            void this.interruptTurn(owner, work).catch(error => {
              if (this.closing) return
              const current = this.getWork(owner, work.id)
              if (terminal(current.status)) return
              current.status = 'uncertain'; current.error = `停止状态待确认：${error instanceof Error ? error.message : '连接中断'}`
              this.saveWork(owner, current)
              const attempt = this.attempts.get(work.id) ?? 0
              this.attempts.set(work.id, attempt + 1)
              this.recoverAfter.set(work.id, Date.now() + Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)))
              this.retrySoon()
            }).finally(() => { this.interrupting.delete(work.id); this.wake() }).catch(() => this.retrySoon())
          }
          continue
        }
        if (this.executing.size >= WORKSPACE_CONCURRENCY_LIMIT || !['queued', 'uncertain'].includes(work.status) || this.executing.has(work.id)) continue
        if (!this.userActive(owner)) { this.retrySoon(); continue }
        const c = this.store.require<Conversation>(owner, 'conversation', work.conversationId), root = this.store.require<Run>(owner, 'run', work.runId)
        if (work.status === 'queued' && !root.targetAgentId && !root.discussion && c.mode === 'host' && work.depth === 0 && work.batchId === root.id && work.requiredReply && !work.currentMessageId) {
          work.agentId = c.administratorId
        }
        if (work.status === 'queued' && (c.archived || root.stopRequested || !this.store.taskMemberIds(owner,c,work.conversationTaskId).includes(work.agentId))) {
          work.status = 'interrupted'; work.error = '执行前成员已移除或聊天已停止'; this.saveWork(owner, work); this.wake(); continue
        }
        const occupied = all.map(entry => this.getWork(entry.owner, entry.work.id)).filter(t => (['running', 'waiting', 'uncertain'].includes(t.status) || this.executing.has(t.id)) && t.id !== work.id)
        // Only the conversation/task/Agent binding shares mutable session state.
        // Other sessions may run concurrently; computer leases and tool queues
        // continue to serialize access to their actual shared resources.
        if (occupied.some(t => t.conversationId === c.id && t.conversationTaskId === work.conversationTaskId && t.agentId === work.agentId)) continue
        const inTask = occupied.filter(t => t.conversationId === c.id && t.conversationTaskId === work.conversationTaskId)
        if (root.discussion && inTask.length) continue
        if (work.status === 'queued' && (occupied.length >= WORKSPACE_CONCURRENCY_LIMIT || inTask.length >= 3)) continue
        if ((this.recoverAfter.get(work.id) ?? 0) > Date.now()) { this.retrySoon(); continue }
        if (c.mode === 'host' || c.kind === 'direct') {
          if (inTask.some(t => c.kind === 'direct'
            || (!root.assignmentId && (t.runId !== work.runId || t.batchId !== work.batchId))
            || t.agentId === c.administratorId || work.agentId === c.administratorId)) continue
        }
        this.executing.add(work.id)
        const recovering = work.status === 'uncertain'
        if (!recovering) {
          work.status = 'running';work.resourceWait=false
          if (c.kind === 'group' && c.mode === 'host' && work.agentId === c.administratorId) { work.requiredReply = true; work.replyMode = 'automatic' }
          work.turnConfiguration = { mode: c.mode, administratorId: c.administratorId, members: this.store.taskMemberIds(owner,c,work.conversationTaskId).map(id => { const a = this.store.require<Agent>(owner, 'agent', id); return { id, name: a.name } }) }
          this.saveWork(owner, work)
        }
        void this.executeWork(owner, work, recovering).catch(() => this.retrySoon())
      }
    } catch { this.retrySoon() } finally { this.pumping = false }
  }
  private async executeWork(owner: string, work: Work, recovering: boolean): Promise<void> {
    try {
      if (work.cancelRequested) await this.interruptTurn(owner, work)
      else {
        const c = this.store.require<Conversation>(owner, 'conversation', work.conversationId)
        const agent = this.store.require<Agent>(owner, 'agent', work.agentId)
        const message = await this.performTurn(owner, c, agent, work, recovering)
        if (message.visible !== false) await this.onMessage(owner, message).catch(() => {})
      }
    } catch (error) {
      if (this.closing) return
      const current = this.getWork(owner, work.id)
      if(!current.submitted&&error instanceof HttpError&&['computer_busy','computer_quota','runner_offline'].includes(error.code??'')&&current.status!=='interrupted'){
        current.status='queued';current.resourceWait=true;current.error='等待执行节点或电脑资源';this.saveWork(owner,current)
      }else if (!terminal(current.status) && current.status !== 'uncertain') {
        current.status = current.submitted ? 'uncertain' : 'failed'
        current.error = error instanceof Error ? error.message : '执行失败'
        this.saveWork(owner, current)
      }
      if (current.status === 'failed' && !current.currentMessageId) {
        current.currentMessageId = randomUUID()
        this.store.saveMessage(owner, { id: current.currentMessageId, conversationId: current.conversationId, conversationTaskId: current.conversationTaskId, seq: 0, role: 'assistant', agentId: current.agentId, agentName: this.store.get<Agent>(owner, 'agent', current.agentId)?.name, content: `执行失败：${current.error}`, reasoning: '', status: 'failed', error: current.error, taskId: current.id, runId: current.runId, attachments: [], tools: [], createdAt: Date.now() })
        this.saveWork(owner, current)
      }
    } finally {
      this.executing.delete(work.id)
      if (!this.closing) {
        const current = this.getWork(owner, work.id)
        if(current.status==='queued'&&current.resourceWait){this.recoverAfter.set(work.id,Date.now()+1000);this.retrySoon()}else if (current.status === 'uncertain') {
          const attempt = this.attempts.get(work.id) ?? 0
          this.attempts.set(work.id, attempt + 1)
          this.recoverAfter.set(work.id, Date.now() + Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)))
          this.retrySoon()
        } else { this.attempts.delete(work.id); this.recoverAfter.delete(work.id) }
        this.wake()
      }
    }
  }
  async reconcile(owner: string, id: string): Promise<void> {
    this.store.require<Run>(owner, 'run', id)
    for (const w of this.works(owner, id)) this.recoverAfter.delete(w.id)
    this.wake()
  }
  async stop(owner: string, id: string): Promise<void> {
    const root = this.store.require<Run>(owner, 'run', id)
    if (terminal(root.status)) return
    root.stopRequested = true
    this.store.saveRun(owner, root)
    await this.cancelWorks(owner, this.works(owner, id))
  }
  async stopAgent(owner: string, conversationId: string, agentId: string, conversationTaskId?: string): Promise<void> {
    const c = this.store.require<Conversation>(owner, 'conversation', conversationId)
    const helper=this.store.get<Agent>(owner,'agent',agentId)
    const scopedTaskId = c.kind === 'group' ? this.store.resolveTask(owner, conversationId, conversationTaskId??helper?.temporaryGoalId)!.id : undefined
    if (!this.store.taskMemberIds(owner,c,scopedTaskId).includes(agentId)) throw new HttpError(400, '只能停止当前任务成员', 'invalid_members')
    await this.cancelWorks(owner, this.works(owner).filter(w => w.conversationId === conversationId && w.agentId === agentId && w.conversationTaskId === scopedTaskId))
  }
  async stopTask(owner: string, conversationId: string, conversationTaskId: string): Promise<void> {
    this.store.requireTask(owner, conversationId, conversationTaskId)
    const roots = this.store.list<Run>(owner, 'run').filter(r => r.conversationId === conversationId && r.conversationTaskId === conversationTaskId && !terminal(r.status))
    this.store.atomic(() => { for (const root of roots) { root.stopRequested = true; this.store.saveRun(owner, root) } })
    await this.cancelWorks(owner, this.works(owner).filter(w => w.conversationId === conversationId && w.conversationTaskId === conversationTaskId))
  }
  async stopConversation(owner: string, id: string): Promise<void> {
    this.store.require<Conversation>(owner, 'conversation', id)
    const roots = this.store.list<Run>(owner, 'run').filter(r => r.conversationId === id && !terminal(r.status))
    this.store.atomic(() => { for (const root of roots) { root.stopRequested = true; this.store.saveRun(owner, root) } })
    await this.cancelWorks(owner, this.works(owner).filter(w => roots.some(r => r.id === w.runId)))
  }
  private async cancelWorks(owner: string, works: Work[]): Promise<void> {
    await Promise.all(works.filter(w => !terminal(w.status)).map(async w => {
      const current = this.getWork(owner, w.id)
      current.cancelRequested = true
      if (current.status === 'queued') { current.status = 'interrupted'; this.saveWork(owner, current) }
      else {
        this.saveWork(owner, current)
        try { await this.interruptTurn(owner, current) }
        catch (error) {
          const latest = this.getWork(owner, current.id)
          if (terminal(latest.status)) return
          latest.status = 'uncertain'; latest.error = `停止状态待确认：${error instanceof Error ? error.message : '连接中断'}`
          this.saveWork(owner, latest); this.recoverAfter.delete(latest.id); this.retrySoon()
        }
      }
    }))
    this.wake()
  }
  protected closeScheduler(): void {
    this.closing = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.recoverAfter.clear()
    this.attempts.clear()
  }
}
