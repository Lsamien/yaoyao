/** Application-owned identities. Hermes profile/session IDs never identify a chat. */
export type WorkspaceApprovalPolicy = 'ask' | 'allow' | 'deny'
export type WorkspaceVoice='concise'|'casual'|'rigorous'|'custom'
export type WorkspaceActBias='ask_first'|'ask_key_then_act'|'act_now'
export interface WorkspaceAgent {
  modelSettings?: import('./botModelSettings.js').BotModelSettings | null
  /** Server-owned acknowledgement, bound to the resolved provider/model. */
  modelSettingsConfirmation?: string
  /** Server-owned native warning discovered while preparing an idle session. */
  modelSettingsPendingConfirmation?: { target: string; message: string }
  /** 一句话职责：这个 Bot 只做的一件事。 */
  job?: string
  /** 反任务清单：任何情况下都不做的事。 */
  antiJobs?: string[]
  voice?: WorkspaceVoice
  voiceCustom?: string
  actBias?: WorkspaceActBias
  /** Applied to new upstream approval requests; absent on older Bots means ask. */
  approvalPolicy?: WorkspaceApprovalPolicy
  canCollaborate?: boolean
  memoryEnabled?: boolean
  memoryStatus?: 'ready' | 'upgrade_required'
  id: string
  name: string
  avatar: string
  instructions: string
  /** Short standing identity, injected every turn. Absent on older records. */
  description?: string
  /** Explicit account-owner grant; absent on older records means disabled. */
  execution?: 'profile' | 'computer'
  computer?: 'auto' | 'cloud' | 'vm' | 'local' | 'browser' | 'off'
  /** Parallel environment toggles. Absent on older records: derive from computer. */
  envs?: { vm?: boolean; cloud?: boolean; desktop?: boolean; browser?: boolean }
  /** Bound computer: 'local' (loopback App) or a paired desktop-host id. */
  desktopHost?: string | null
  allowHostEnvironment?: boolean
  /** Local VM execution backend; older records retain the isolated Worker. */
  vmExecution?: 'worker' | 'profile'
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
export interface AgentEnvs { vm:boolean; cloud:boolean; desktop:boolean; browser:boolean }
/** Normalized parallel environments; legacy single-choice agents derive here. */
export function agentEnvs(agent: Pick<WorkspaceAgent,'computer'|'envs'> & {execution?:'profile'|'computer'}): AgentEnvs {
  if(agent.envs)return {vm:agent.envs.vm===true,cloud:agent.envs.cloud===true,desktop:agent.envs.desktop===true,browser:false}
  if(agent.computer===undefined&&agent.execution==='computer')return {vm:true,cloud:false,desktop:false,browser:false}
  switch(agent.computer){
    case 'vm':return {vm:true,cloud:false,desktop:false,browser:false}
    case 'cloud':return {vm:false,cloud:true,desktop:false,browser:false}
    case 'local':return {vm:false,cloud:false,desktop:true,browser:false}
    case 'browser':return {vm:false,cloud:false,desktop:false,browser:false}
    case 'auto':return {vm:true,cloud:true,desktop:true,browser:false}
    default:return {vm:false,cloud:false,desktop:false,browser:false}
  }
}
/** Single-choice projection kept for older clients reading agent.computer. */
export function deriveComputer(envs: Pick<AgentEnvs,'vm'|'cloud'|'desktop'|'browser'>): 'vm'|'cloud'|'local'|'browser'|'off' {
  return envs.vm?'vm':envs.cloud?'cloud':envs.desktop?'local':'off'
}
const VOICE_TEXT:Record<WorkspaceVoice,string>={concise:'简洁专业：直击要点，不用客套与废话。',casual:'轻松随和：像朋友一样自然交流，可以适度幽默。',rigorous:'严谨细致：条理清晰，重要结论给出依据，主动指出风险与前提。',custom:''}
const ACT_BIAS_TEXT:Record<WorkspaceActBias,string>={ask_first:'先问再做：任务不明确时先向用户澄清，确认后再执行。',ask_key_then_act:'先问关键问题即行动：最多问 2–3 个关键问题，职责清楚后立即开始，边做边汇报。',act_now:'直接行动：合理默认即可开工，只在重要分叉点询问。'}
/** Structured persona spec injected before free-form instructions. */
export function personaSection(agent:Pick<WorkspaceAgent,'job'|'antiJobs'|'voice'|'voiceCustom'|'actBias'>):string{
 const lines:string[]=[]
 if(agent.job)lines.push(`你的唯一职责：${agent.job}`)
 if(agent.antiJobs?.length)lines.push(`明确不做（反任务，任何情况下都不要做）：\n${agent.antiJobs.map(item=>`- ${item}`).join('\n')}`)
 const voice=agent.voice?(agent.voice==='custom'?(agent.voiceCustom?`按以下要求把握语气：${agent.voiceCustom}`:''):VOICE_TEXT[agent.voice]):''
 if(voice)lines.push(`语气：${voice}`)
 if(agent.actBias)lines.push(`行动策略：${ACT_BIAS_TEXT[agent.actBias]}`)
 return lines.join('\n')
}
/** Hermes toolsets a profile chat must not have. Checked environments use their own tools. */
export const PROFILE_DENIED_TOOLSETS = ['terminal', 'file'] as const
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
  collaborationMode?: 'discussion' | 'host' | 'free'
  projectId?: string
  collaborationWaiting?: number
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
  communication?: WorkspaceCommunication
  peerMessageId?: string
  revision?: number
  execution?:'profile'|'computer'
  /** Computer the user was on when sending: 'local' (YaoYao server) or paired computer uuid. */
  deviceHost?: string
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

export function workspaceHasUnfinishedOutput(messages: WorkspaceMessage[]): boolean {
  // Legacy transcripts may retain tool.generating after the turn has settled.
  // A terminal message status is authoritative over those stale tool events.
  return messages.some(message => message.visible !== false && message.role === 'assistant'
    && ['queued', 'streaming', 'uncertain'].includes(message.status))
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
/** Presentation-only provenance for a real Bot-to-Bot delivery. */
export interface WorkspaceCommunication {
  content?: string
  direction: 'outgoing' | 'incoming'
  peerId: string
  peerName: string
  peerAvatar: string
  peerKind: 'agent' | 'group'
}
export interface WorkspaceRun {
  projectId?: string
  peerMessageId?: string
  collaborationChainId?: string
  priority?: boolean
  discussion?: { memberIds: string[]; rounds: number }
  /** Copied from the triggering user message when present. */
  deviceHost?: string
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
  triggerKind?: 'assignment' | 'task_review' | 'task_result' | 'peer'
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
/** Per-agent token accounting derived from Hermes session usage deltas. */
export interface WorkspaceAgentUsageSummary {
  input: number
  output: number
  total: number
}
export interface WorkspaceAgentUsage {
  agentId: string
  today: string
  month: string
  todayUsage: WorkspaceAgentUsageSummary
  monthUsage: WorkspaceAgentUsageSummary
  totalUsage: WorkspaceAgentUsageSummary
  daily: Array<{ date: string } & WorkspaceAgentUsageSummary>
}
