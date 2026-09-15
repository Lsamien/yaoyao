/** Bot-mode state only. File-backed records never inherit a Hermes Profile ID. */
export type MemoryScope = 'agent' | 'user' | 'project'
export interface WorkspaceProject {
  id: string
  name: string
  description: string
  memberIds: string[]
  groupIds: string[]
  revision: number
  archived: boolean
  createdAt: number
  updatedAt: number
}
export interface WorkspaceMemorySource { messageId: string; conversationId: string; taskId?: string; quote?: string }
export interface WorkspaceMemory {
  id: string
  scope: MemoryScope
  agentId: string
  projectId?: string
  content: string
  topic?: string
  tier: 'profile' | 'log' | 'note'
  origin: 'explicit' | 'synthesis' | 'manual'
  sources: WorkspaceMemorySource[]
  revision: number
  createdAt: number
  updatedAt: number
  conflict?: boolean
}
export interface WorkspaceMemoryRevision {
  id: string
  memoryId: string
  revision: number
  operation: 'write' | 'forget'
  actor: string
  at: number
  before?: WorkspaceMemory
  after?: WorkspaceMemory
}
export interface WorkspaceMemoryJob {
  id: string
  agentId: string
  projectId?: string
  runId: string
  relatedRunIds?: string[]
  sourceMessageId: string
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped'
  attempts: number
  nextAt: number
  createdAt: number
  updatedAt: number
  error?: string
}
export interface WorkspacePeerMessage {
  fromName?: string
  fromAvatar?: string
  targetName?: string
  targetAvatar?: string
  id: string
  chainId: string
  fromAgentId: string
  toAgentId?: string
  targetGroupId?: string
  originConversationId: string
  originTaskId?: string
  originProjectId?: string
  sourceRunId: string
  conversationId: string
  taskId?: string
  replyTo?: string
  content: string
  fileIds: string[]
  depth: number
  priority: boolean
  status: 'queued' | 'running' | 'waiting' | 'complete' | 'failed' | 'stopped'
  runId?: string
  error?: string
  createdAt: number
  updatedAt: number
}
