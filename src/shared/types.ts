export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type AuthStatus =
  | 'checking'
  | 'anonymous'
  | 'authenticating'
  | 'authenticated'
  | 'expired'
  | 'error'

export interface CurrentUser {
  id: string
  username: string
  avatar?: string
  displayName?: string
  email?: string
  provider?: string
  role?: string
  enabled?: boolean
  mustChangePassword?: boolean
}

export interface Profile {
  name: string
  agentName?: string
  displayName?: string
  description?: string
  isDefault: boolean
  model?: string
  provider?: string
  gatewayRunning?: boolean
  avatar?: string
  agentAvatar?: string
}

export interface ModelOption {
  id: string
  name: string
  provider: string
  supportsReasoning?: boolean
  reasoningEfforts?: string[]
  isDefault?: boolean
}

export interface BootstrapResponse {
  serverIdentity?: import('./serverIdentity.js').ServerIdentity
  status?: string
  authRequired: boolean
  setupRequired?: boolean
  user?: CurrentUser
  profiles: Profile[]
  csrfToken: string
  insecureLan?: boolean
  groupUploadsEnabled?: boolean
  upstreamReady?: boolean
  upstreamError?: string
  serverKind?: string
  models?: ModelOption[]
}

export interface UploadReference {
  id: string
  name: string
  mimeType: string
  size: number
  markdown?: string
  refText?: string
}

export interface AccountScope {
  upstream?: string
  userId: string
}

export interface SessionSummary {
  id: string
  profile?: string
  source: string
  /** Server-owned chat membership. `source` remains provenance only. */
  owned?: boolean
  title: string
  preview?: string
  model?: string
  provider?: string
  agent?: string
  messageCount: number
  toolCallCount: number
  inputTokens?: number
  outputTokens?: number
  startedAt: number
  updatedAt: number
  endedAt?: number | null
  parentSessionId?: string | null
  forkPointMessageId?: string | null
  workspace?: string | null
  archived?: boolean
  pinned?: boolean
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'
export type DeliveryStage =
  | 'preparing'
  | 'attached'
  | 'pending'
  | 'accepted'
  | 'streaming'
  | 'settled'
  | 'failed'
  | 'unknown-receipt'

export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  path?: string
  url?: string
  kind?: 'image' | 'pdf' | 'file'
}

export interface ToolCall {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  arguments?: JsonValue
  result?: JsonValue
  preview?: string
  error?: string
  durationSeconds?: number
}

export interface ChatMessage {
  id: string
  sessionId: string
  profile?: string
  role: ChatRole
  content: string
  reasoning?: string
  timestamp: number
  sequence?: number
  clientMessageId?: string
  serverMessageId?: string
  stage: DeliveryStage
  isStreaming?: boolean
  error?: string
  attachments?: ChatAttachment[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  displayKind?: string
  displayMetadata?: JsonValue
  raw?: JsonValue
}

export interface ChatRoute {
  profile: string
  sessionId: string
}

export interface ChatUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  contextTokens?: number
  contextLimit?: number
  percentUsed?: number
  raw?: JsonValue
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  message?: string
  toolName?: string
  choices?: string[]
  payload: Record<string, JsonValue>
}

export interface ClarificationRequest {
  id: string
  sessionId: string
  question: string
  choices?: string[]
  payload: Record<string, JsonValue>
}

export type RealtimeConnectionState =
  | 'idle'
  | 'leasing'
  | 'connecting'
  | 'connected'
  | 'ready'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'
  | 'needs-reset'

export interface ChatRouteState {
  route: ChatRoute
  messages: ChatMessage[]
  runtimeSessionId?: string
  historySynced: boolean
  hasMoreBefore: boolean
  loadedMessageCount: number
  messageTotal: number
  isLoadingHistory: boolean
  isStreaming: boolean
  isQueued: boolean
  fastMode?: boolean
  serverFastMode?: boolean
  fastModeDirty?: boolean
  liveStatus?: string
  usage?: ChatUsage
  pendingApproval?: ApprovalRequest
  pendingClarification?: ClarificationRequest
  error?: string
  generation: number
}

export interface RpcRequestFrame {
  jsonrpc: '2.0'
  id: string
  method: string
  params: Record<string, JsonValue>
}

export interface RpcEventFrame {
  jsonrpc?: '2.0'
  method: 'event'
  params: {
    type: string
    session_id?: string
    profile?: string
    payload?: JsonValue
  }
}

export interface GroupLimits {
  maxAgentsPerRoom: number
  maxMessageBytes: number
  maxToolStateBytes?: number
  maxInteractionPayloadBytes?: number
  maxMessagePageSize: number
  maxEventBatchSize?: number
  maxAgentDepth?: number
  maxRoomConcurrency?: number
  maxPluginConcurrency?: number
  defaultMaxReplyRounds: number
  unlimitedReplyRoundsValue: number
  maxAgentDisplayNameLength: number
}

export const MIN_SUPPORTED_GROUP_PROTOCOL_VERSION = 2
export const MAX_SUPPORTED_GROUP_PROTOCOL_VERSION = 12
export const SUPPORTED_GROUP_PROTOCOL_VERSION_LABEL = `v${MIN_SUPPORTED_GROUP_PROTOCOL_VERSION}–v${MAX_SUPPORTED_GROUP_PROTOCOL_VERSION}`

export function isSupportedGroupProtocolVersion(value: number): boolean {
  return Number.isInteger(value)
    && value >= MIN_SUPPORTED_GROUP_PROTOCOL_VERSION
    && value <= MAX_SUPPORTED_GROUP_PROTOCOL_VERSION
}

export interface GroupCapabilities {
  protocolVersion: number
  journalEpoch: string
  latestCursor: number
  limits: GroupLimits
  eventTypes: string[]
  features?: string[]
}

export type GroupAgentStatus = 'idle' | 'queued' | 'running' | 'awaiting_input' | 'unknown'
export type GroupMessageStatus = 'queued' | 'streaming' | 'completed' | 'failed' | 'interrupted' | 'unknown'

export interface GroupAgent {
  id: string
  roomId: string
  profile: string
  nodeId: string
  nodeLabel: string
  displayName: string
  description: string
  storedSessionId?: string | null
  lastContextMessageSeq: number
  enabled: boolean
  replyWithoutMention: boolean
  isHost: boolean
  model?: string | null
  provider?: string | null
  reasoningEffort?: string | null
  fastMode?: boolean | null
  createdAt: number
  updatedAt: number
  status: GroupAgentStatus
}

export interface GroupNodeProfile {
  name: string
  displayName: string
  model: string
  avatar?: string
  color?: string
}

export interface GroupNode {
  nodeId: string
  name: string
  serverUrl: string
  fingerprint: string
  createdAt: number
  updatedAt: number
  profiles: GroupNodeProfile[]
}

export interface GroupMessage {
  seq: number
  id: string
  roomId: string
  topicId?: string | null
  senderKind: 'human' | 'agent' | 'system' | 'unknown'
  senderId: string
  senderName: string
  rootMessageId: string
  replyToMessageId?: string | null
  clientMessageId?: string | null
  content: string
  reasoning: string
  toolState: JsonValue[]
  status: GroupMessageStatus
  error: string
  execution?: {
    requestedModel?: string | null
    requestedReasoningEffort?: string | null
    requestedFastMode?: boolean | null
    actualModel?: string | null
    actualReasoningEffort?: string | null
    actualFastMode?: boolean | null
  } | null
  createdAt: number
  updatedAt: number
}

export interface GroupRun {
  id: string
  roomId: string
  topicId?: string | null
  agentId: string
  triggerMessageId: string
  responseMessageId: string
  rootMessageId: string
  depth: number
  status: 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  runtimeSessionId?: string | null
  error: string
  replyMode?: 'mentioned' | 'automatic' | null
  createdAt: number
  updatedAt: number
}

export interface GroupInteraction {
  id: string
  roomId: string
  topicId?: string | null
  agentId: string
  runId: string
  kind: 'approval' | 'clarification' | 'unknown'
  payload: JsonValue
  status: 'pending' | 'resolved' | 'cancelled' | 'unknown'
  createdAt: number
  resolvedAt?: number | null
}

export interface GroupRoomSummary {
  id: string
  name: string
  cwd: string
  instructions?: string
  avatar?: string
  avatarMembers?: GroupRoomAvatarMember[]
  createdAt: number
  updatedAt: number
  archived: boolean
  agentCount: number
  lastMessage?: GroupMessage | null
  unreadCount: number
  activeRunCount?: number
  maxReplyRounds: number
  orchestrationMode?: 'free' | 'host'
}

export interface GroupRoomAvatarMember {
  profile: string
  nodeId: string
  displayName: string
}

export interface GroupRoomDetail extends Omit<GroupRoomSummary, 'agentCount' | 'lastMessage' | 'unreadCount'> {
  agents: GroupAgent[]
  runs: GroupRun[]
  pendingInteractions: GroupInteraction[]
  latestCursor: number
}

export interface GroupRoomPage {
  items: GroupRoomSummary[]
  nextCursor?: string | null
}

export interface GroupTopicSummary {
  id: string
  roomId: string
  title: string
  preview: string
  messageCount: number
  unreadCount?: number
  latestMessageSeq?: number
  createdAt: number
  updatedAt: number
  archived?: boolean
  pinned?: boolean
}

export interface GroupRoomActivity {
  roomId: string
  activeRunCount: number
  unreadCount: number
  lastMessage?: GroupMessage | null
}

export interface GroupTopicPage {
  items: GroupTopicSummary[]
  nextCursor?: string | null
}

export interface GroupMessagePage {
  items: GroupMessage[]
}

export type GroupEventType =
  | 'room.created'
  | 'room.updated'
  | 'room.deleted'
  | 'room.restored'
  | 'agent.created'
  | 'agent.updated'
  | 'agent.deleted'
  | 'agent.status'
  | 'message.upsert'
  | 'topic.updated'
  | 'topic.archived'
  | 'topic.restored'
  | 'room.activity'
  | 'interaction.requested'
  | 'interaction.resolved'
  | 'run.updated'
  | string

export interface GroupSocketEnvelope {
  type: 'group.ready' | 'group.event' | 'group.heartbeat' | 'group.reset_required'
  epoch?: string
  cursor?: number
  heartbeatSeconds?: number
  roomId?: string
  event?: GroupEventType
  payload?: JsonValue
  reason?: string
}

export interface FileOrigin {
  workspaceConversationId?: string
  id?: number | string
  profile?: string
  sessionId?: string
  sessionTitle?: string
  messageId?: string
  authorKind?: 'user' | 'agent' | 'tool'
  authorName?: string
  observedAt?: number
  originalPath?: string
  referencePath?: string
}

export type FileKind = 'image' | 'video' | 'audio' | 'document' | 'other'

export interface FileLibraryItem {
  id: string
  path: string
  name: string
  extension: string
  mimeType: string
  size: number
  modifiedAt: number
  exists: boolean
  availability?: 'archived' | 'source' | 'unavailable'
  archiveStatus?: string
  firstSeenAt?: number
  lastSeenAt?: number
  messageTimestamp?: number | null
  origins: FileOrigin[]
  kind: FileKind
  previewUrl?: string
  downloadUrl?: string
}

export interface FileLibraryPage {
  items: FileLibraryItem[]
  nextCursor?: string | null
  total?: number
}

export type ArtifactKind = 'image' | 'file' | 'link'

export interface ConversationArtifact {
  id: string
  kind: ArtifactKind
  value: string
  label: string
  sessionId: string
  sessionTitle: string
  profile?: string
  messageId: string
  timestamp: number
  mimeType?: string
  attachment?: ChatAttachment
}

export interface ComposerState {
  draft: string
  attachments: ChatAttachment[]
  quotedMessageId?: string
  isComposing: boolean
  mode: 'send' | 'queue' | 'steer'
}
