import { WorkspaceMessageReconciler } from '@shared/workspaceMessagePatch'
import type { AgentAssignment, AgentGoal } from '@shared/agentTasks'
import { compareWorkspaceConversations } from '@shared/workspace'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceEvent, WorkspaceInteraction, WorkspaceMessage, WorkspaceRun, WorkspaceTask, WorkspaceSendReceipt } from '@shared/workspace'

export interface WorkspaceDetail {
  conversation: WorkspaceConversation
  messages: WorkspaceMessage[]
  task?: WorkspaceTask | null
  tasks?: WorkspaceTask[]
  assignments?: AgentAssignment[]
  run: WorkspaceRun | null
  interactions: WorkspaceInteraction[]
  context: Record<string, unknown> | null
  hiddenMessageIds?: string[]
  hasOlder?: boolean
  cursor?: number
}
export interface WorkspaceSnapshot {
  agents: WorkspaceAgent[]
  conversations: WorkspaceConversation[]
  details: WorkspaceDetail[]
  cursor: number
}
export const transcriptKey = (id: string, taskId?: string | null) => `${id}:${taskId ?? ''}`
function upsert<T extends { id: string }>(rows: T[], value: T): T[] {
  const index = rows.findIndex(row => row.id === value.id)
  if (index < 0) return [...rows, value]
  const next = rows.slice(); next[index] = value; return next
}

/** Apply only the entity named by an event; settled message objects keep their identity. */
export function foldDetail(detail: WorkspaceDetail, event: WorkspaceEvent): WorkspaceDetail {
  if (event.conversationId !== detail.conversation.id) return detail
  const data = event.data as Record<string, unknown>
  const inTask = (task: unknown) => (task ?? null) === (detail.task?.id ?? null)
  switch (event.type) {
    case 'conversation.changed': return { ...detail, conversation: event.data as WorkspaceConversation }
    case 'message.changed': {
      const message = event.data as WorkspaceMessage
      if (!inTask(message.conversationTaskId)) return detail
      const messages = message.visible === false ? detail.messages.filter(m => m.id !== message.id)
        : upsert(detail.messages, message).sort((a, b) => a.seq - b.seq)
      return { ...detail, messages }
    }
    case 'task.changed': {
      const task = event.data as WorkspaceTask
      return { ...detail, tasks: upsert(detail.tasks ?? [], task), task: detail.task?.id === task.id ? task : detail.task }
    }
    case 'task.deleted': return { ...detail, tasks: (detail.tasks ?? []).filter(t => t.id !== data.id) }
    case 'run.changed': return inTask(data.conversationTaskId) ? { ...detail, run: event.data as WorkspaceRun } : detail
    case 'context.changed': return inTask(data.conversationTaskId) ? { ...detail, context: data } : detail
    case 'interaction.changed': return inTask(data.conversationTaskId) ? { ...detail, interactions: data.resolved
      ? detail.interactions.filter(i => i.id !== data.id) : upsert(detail.interactions, event.data as WorkspaceInteraction) } : detail
    case 'assignment.changed': return data.goalId === detail.task?.id
      ? { ...detail, assignments: upsert(detail.assignments ?? [], event.data as AgentAssignment) } : detail
    case 'goal.changed': return data.id === detail.task?.id
      ? { ...detail, task: { ...detail.task!, goal: event.data as AgentGoal } } : detail
    default: return detail
  }
}

export class WorkspaceTranscriptStore {
  agents: WorkspaceAgent[] = []
  private conversationRows: WorkspaceConversation[] = []
  get conversations(): WorkspaceConversation[] { return this.conversationRows }
  set conversations(rows: WorkspaceConversation[]) {
    this.conversationRows = [...rows].sort(compareWorkspaceConversations)
  }
  readonly details = new Map<string, WorkspaceDetail>()
  cursor = 0
  readonly selectedTasks = new Map<string, string>()
  private reads = new Map<symbol, WorkspaceEvent[]>()
  private entityVersions = new Map<string, number>()
  private snapshotFloor = 0
  private messageReconciler = new WorkspaceMessageReconciler()
  readonly staleDetails = new Set<string>()
  acceptReceipt(receipt: WorkspaceSendReceipt): void {
    if (receipt.cursor === undefined) return
    for (const [type, data] of [['message.changed', receipt.message], ['run.changed', receipt.run],
      ['conversation.changed', receipt.conversation], ['task.changed', receipt.task]] as const) {
      if (data) this.accept({ seq: receipt.cursor, type, conversationId: receipt.run.conversationId, data })
    }
  }
  beginRead(): symbol { const token = Symbol(); this.reads.set(token, []); return token }
  cancelRead(token: symbol): void { this.reads.delete(token) }
  finishRead(token: symbol, incoming: WorkspaceDetail, preserveHistory = true): WorkspaceDetail {
    const key = transcriptKey(incoming.conversation.id, incoming.task?.id)
    const previous = this.details.get(key)
    if (previous && incoming.cursor !== undefined && incoming.cursor < this.snapshotFloor) {
      incoming = { ...previous, cursor: incoming.cursor, messages: incoming.messages,
        hiddenMessageIds: previous.hiddenMessageIds, hasOlder: previous.hasOlder }
    }
    let detail = incoming
    if (previous && preserveHistory) {
      const messages = new Map(previous.messages.map(message => [message.id, message]))
      for (const message of incoming.messages) {
        const current = messages.get(message.id)
        if (!current || (this.entityVersions.get(`message:${message.id}`) ?? this.snapshotFloor) <= (incoming.cursor ?? Number.MAX_SAFE_INTEGER)) messages.set(message.id, message)
      }
      detail = { ...incoming, hasOlder: previous.hasOlder,
        messages: [...messages.values()].filter(m => m.visible !== false && !incoming.hiddenMessageIds?.includes(m.id)).sort((a, b) => a.seq - b.seq) }
    }
    // A response that started before a live event must never overwrite that event.
    for (const event of this.reads.get(token) ?? []) {
      if (event.seq <= (incoming.cursor ?? 0)) continue
      const id = (event.data as { id?: string }).id
      if ((event.type === 'conversation.deleted' && id === incoming.conversation.id)
        || (event.type === 'task.deleted' && id === incoming.task?.id)) {
        this.reads.delete(token)
        throw new Error('会话或任务已被删除')
      }
      detail = foldDetail(detail, event)
    }
    this.reads.delete(token)
    this.details.set(key, detail); this.staleDetails.delete(key)
    for (const message of detail.messages) this.messageReconciler.remember(message)
    return detail
  }
  hydrate(snapshot: WorkspaceSnapshot): void {
    const reset = snapshot.cursor === 0 && snapshot.conversations.length === 0
    const previous = new Map(reset ? [] : this.details)
    if (reset) this.reads.clear()
    const concurrent = [...this.reads.values()].flat().filter(event => event.seq > snapshot.cursor).sort((a, b) => a.seq - b.seq)
    this.entityVersions.clear(); this.snapshotFloor = snapshot.cursor; this.messageReconciler.clear()
    this.agents = snapshot.agents; this.conversations = snapshot.conversations; this.cursor = snapshot.cursor
    this.details.clear(); this.staleDetails.clear()
    for (const incoming of snapshot.details) {
      const key = transcriptKey(incoming.conversation.id, incoming.task?.id), old = previous.get(key)
      const messages = new Map(old?.messages.map(m => [m.id, m]))
      for (const message of incoming.messages) messages.set(message.id, message)
      const detail = old ? { ...incoming, hasOlder: old?.hasOlder ?? incoming.hasOlder,
        messages: [...messages.values()].filter(m => m.visible !== false && !incoming.hiddenMessageIds?.includes(m.id)).sort((a, b) => a.seq - b.seq) } : incoming
      this.details.set(key, detail)
      for (const message of detail.messages) this.messageReconciler.remember(message)
    }
    for (const [key, detail] of previous) {
      const conversation = snapshot.conversations.find(c => c.id === detail.conversation.id)
      const current = snapshot.details.find(d => d.conversation.id === detail.conversation.id)
      if (!this.details.has(key) && conversation && (conversation.archived || current?.tasks?.some(t => t.id === detail.task?.id))) {
        this.details.set(key, { ...detail, conversation }); this.staleDetails.add(key)
      }
    }
    for (const event of concurrent) this.accept(event)
  }

  get(id: string, taskId?: string | null): WorkspaceDetail | undefined {
    if (taskId) return this.details.get(transcriptKey(id, taskId))
    const remembered = this.selectedTasks.get(id)
    return (remembered ? this.details.get(transcriptKey(id, remembered)) : undefined)
      ?? [...this.details.values()].find(detail => detail.conversation.id === id)
  }
  apply(event: WorkspaceEvent): void {
    if (event.seq <= this.cursor) return
    this.accept(event)
    this.cursor = event.seq
  }
  private accept(event: WorkspaceEvent): void {
    event = this.messageReconciler.normalize(event)
    const data = event.data as { id: string }
    const key = `${event.type.split('.')[0]}:${data.id ?? event.conversationId}`
    if (event.seq < (this.entityVersions.get(key) ?? this.snapshotFloor)) return
    this.entityVersions.set(key, event.seq)
    for (const events of this.reads.values()) events.push(event)
    if (event.type === 'agent.changed') this.agents = upsert(this.agents, event.data as WorkspaceAgent)
    if (event.type === 'agent.deleted') this.agents = this.agents.filter(a => a.id !== data.id)
    if (event.type === 'conversation.changed') this.conversations = upsert(this.conversations, event.data as WorkspaceConversation)
    if (event.type === 'conversation.deleted') this.conversations = this.conversations.filter(c => c.id !== data.id)
    for (const [key, detail] of this.details) {
      if ((event.type === 'conversation.deleted' && detail.conversation.id === data.id)
        || (event.type === 'task.deleted' && detail.task?.id === data.id)) this.details.delete(key)
      else if (event.conversationId === detail.conversation.id) this.details.set(key, foldDetail(detail, event))
    }
  }
}
