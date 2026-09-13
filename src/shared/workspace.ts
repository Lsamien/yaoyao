/** Application-owned identities. Hermes profile/session IDs never identify a chat. */
export interface WorkspaceAgent {
  id: string
  name: string
  avatar: string
  instructions: string
  /** Explicit account-owner grant; absent on older records means disabled. */
  execution?: 'profile' | 'computer'
  computer?: 'auto' | 'cloud' | 'vm' | 'local' | 'browser' | 'off'
  allowHostEnvironment?: boolean
  browserProfile?: 'persistent' | 'temporary'
  computerEnvironmentId?:string
  computerEnvironmentName?:string
  canManageTeam?: boolean
  teamAuthorizationVersion?: number
  temporaryGoalId?:string
  helperActivation?:number
  helperRunnerId?:string
  retiredAt?:number
  cleanupState?:'pending'|'complete'
  createdByAgentId?: string
  createdFromRunId?: string
  nodeId: string
  profile: string
  remoteAgentId?: string
  archived: boolean
  revision: number
  createdAt: number
  updatedAt: number
}
export function supportsHostEnvironment(agent: Pick<WorkspaceAgent,'computer'|'execution'>):boolean {
  return agent.computer==='vm'||agent.computer==='cloud'||(!agent.computer&&agent.execution==='computer')
}
export function allowsHostEnvironment(agent: Pick<WorkspaceAgent,'computer'|'execution'|'allowHostEnvironment'|'archived'|'remoteAgentId'|'temporaryGoalId'>):boolean {
  return agent.allowHostEnvironment===true&&supportsHostEnvironment(agent)&&!agent.archived&&!agent.remoteAgentId&&!agent.temporaryGoalId
}
export interface WorkspaceMemberRole {
  name: string
  description: string
}
export interface WorkspaceConversation {
  id: string
  kind: 'direct' | 'group'
  name: string
  avatar: string
  memberIds: string[]
  memberRoles?: Record<string, WorkspaceMemberRole>
  instructions: string
  administratorId: string
  mode: 'host' | 'free'
  autoReplyIds: string[]
  maxReplyRounds: number
  archived: boolean
  pinned: boolean
  readSeq: number
  lastSeq: number
  lastMessageAt?: number
  preview: string
  previewAgentId?: string
  activeRunId?: string
  activeAgentId?: string
  activeRunStatus?: WorkspaceRun['status']
  activeAgentStates?: Record<string, 'running' | 'waiting' | 'uncertain' | 'queued'>
  avatarSignals?: Record<string, { id: string; state: 'success' | 'failure'; at: number }>
  queuedMessageCount?: number
  unread?: boolean
  /** Changes when new attention arrives, so an older read cannot clear it. */
  unreadVersion?: number
  /** Compatibility signal for older clients: always 0 or 1. */
  unreadCount?: number
  createdAt: number
  updatedAt: number
}
/** Shared by the HTTP lists, snapshots and Web/desktop incremental state. */
export function workspaceConversationTimestamp(value: Pick<WorkspaceConversation, 'lastMessageAt' | 'createdAt'>): number {
  return value.lastMessageAt ?? value.createdAt
}
export function compareWorkspaceConversations(a: WorkspaceConversation, b: WorkspaceConversation): number {
  return Number(b.pinned) - Number(a.pinned)
    || workspaceConversationTimestamp(b) - workspaceConversationTimestamp(a)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export interface WorkspaceTask {
  id: string
  conversationId: string
  title: string
  titleSource: 'automatic' | 'user'
  messageCount: number
  readSeq: number
  lastSeq: number
  unread?: boolean
  unreadVersion?: number
  /** Compatibility signal for older clients: always 0 or 1. */
  unreadCount: number
  activeRunId?: string
  activeRunStatus?: WorkspaceRun['status']
  lastMessageAt?: number
  createdAt: number
  updatedAt: number
  goal?: import('./agentTasks.js').AgentGoal
}
export function workspaceHasUnread(value: { unread?: boolean; unreadCount?: number; lastSeq: number; readSeq: number }): boolean {
  return value.unread ?? (value.unreadCount !== undefined ? value.unreadCount > 0 : value.lastSeq > value.readSeq)
}
export interface WorkspaceFile {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: number
  sourcePath?: string
  conversationId?: string
  messageId?: string
  profile?: string
  sender: 'user' | 'agent'
}
export interface WorkspaceMessage {
  revision?: number
  execution?:'profile'|'computer'
  id: string
  conversationId: string
  /** User-visible task scope. `taskId` below remains the scheduler turn ID. */
  conversationTaskId?: string
  seq: number
  role: 'user' | 'assistant' | 'system'
  taskReference?: { conversationId: string; taskId: string }
  agentId?: string
  agentName?: string
  content: string
  reasoning: string
  runId?: string
  taskId?: string
  visible?: boolean
  error?: string
  status: 'queued' | 'streaming' | 'complete' | 'failed' | 'interrupted' | 'uncertain'
  attachments: WorkspaceFile[]
  tools: Array<Record<string, unknown>>
  createdAt: number
}
export interface WorkspaceMessagePatch {
  id: string
  conversationId: string
  conversationTaskId?: string
  baseRevision: number
  revision: number
  contentAppend: string
  reasoningAppend: string
}
export interface WorkspaceRun {
  id: string
  conversationId: string
  conversationTaskId?: string
  messageId: string
  mentionIds: string[]
  activeAgentId?: string
  status: 'queued' | 'running' | 'waiting' | 'complete' | 'failed' | 'interrupted' | 'uncertain'
  round: number
  error?: string
  stopRequested?: boolean
  assignmentId?: string
  /** Structured delivery run; ordinary chat does not carry a goal. */
  goalId?: string
  targetAgentId?: string
  triggerKind?: 'assignment' | 'task_review' | 'task_result'
  internalInstruction?: string
  authorizationVersion?: number
  createdAt: number
  updatedAt: number
}
export interface WorkspaceInteraction {
  id: string
  conversationId: string
  conversationTaskId?: string
  runId: string
  agentId: string
  kind: 'approval' | 'clarification'
  message: string
  choices: string[]
  resolved: boolean
}
export interface WorkspaceEvent {
  seq: number
  type: string
  conversationId?: string
  data: unknown
}
/** Additional fields are optional while clients can still connect to older servers. */
export interface WorkspaceSendReceipt {
  requestId?: string
  run: WorkspaceRun
  message?: WorkspaceMessage
  conversation?: WorkspaceConversation
  task?: WorkspaceTask | null
  cursor?: number
}
export interface WorkspaceSource {
  nodeId: string
  profile: string
  name: string
}
