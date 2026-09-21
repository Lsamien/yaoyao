import { visibleMessageText, messageReasoningText } from '@shared/messageFiles'
import { workspaceConversationTimestamp, workspaceHasUnread } from '@shared/workspace'
import { toolResultFailed, toolStatus } from '@shared/chatTools'
import { serverFilePath, serverFileUrl } from '@shared/serverFiles'
import type {
  ApprovalRequest,
  ChatMessage,
  ClarificationRequest,
  ConversationArtifact,
  FileLibraryItem,
  GroupAgent,
  GroupInteraction,
  GroupMessage,
  GroupRoomDetail,
  GroupRoomSummary,
  SessionSummary,
  ToolCall,
} from '@shared/types'
import type { SidebarItem } from '@/components/app/types'
import type { UiAgent, UiRoom } from '@/components/groups/types'
import type { UiLibraryItem } from '@/components/library/types'
import type { UiInteraction, UiMessage, UiMessageAttachment, UiToolCall } from '@/components/messages/types'
import { normalizeAssistantMediaMarkdown } from '@/utils/mediaMarkdown'
import { formatMessageTime, formatConversationTime } from '@/utils/messageTime'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function formatRelative(value: number): string {
  const ms = value < 10_000_000_000 ? value * 1000 : value
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟`
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))} 小时`
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function historySection(value: number, pinned = false): string | undefined {
  if (pinned) return '已置顶'
  const ms = value < 10_000_000_000 ? value * 1000 : value
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (ms >= today.getTime()) return '今天'
  if (ms >= yesterday.getTime()) return '昨天'
  return '更早'
}

export function sessionSidebarItem(session: SessionSummary, unread = 0, agentName = ''): SidebarItem {
  return {
    id: session.id,
    title: session.title || '未命名会话',
    subtitle: session.preview || `${session.messageCount} 条消息`,
    meta: agentName || session.agent || formatRelative(session.updatedAt),
    section: historySection(session.updatedAt, session.pinned),
    icon: 'chat',
    pinned: session.pinned,
    unread,
  }
}

function toolToUi(tool: ToolCall): UiToolCall {
  const status: UiToolCall['status'] = tool.status === 'completed' ? 'success' : tool.status === 'failed' ? 'error' : tool.status
  return {
    id: tool.id,
    name: tool.name,
    status,
    input: tool.arguments,
    output: tool.error || tool.result || tool.preview,
    durationMs: tool.durationSeconds ? Math.round(tool.durationSeconds * 1000) : undefined,
  }
}

function toolResult(message: ChatMessage): unknown {
  const raw = record(message.raw)
  if (raw.result !== undefined) return raw.result
  if (raw.output !== undefined && typeof raw.output !== 'string') return raw.output
  try { return JSON.parse(message.content) } catch { return message.content || undefined }
}

function timelineMetadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const CONTEXT_COMPACTION_PREFIX = '[context compaction'
const BACKGROUND_PROCESS_NOTICE = /^\[IMPORTANT:\s*Background process\s+(\S+)\s+exited\s+\(exit code\s+(-?\d+)(?:,\s*([^)]+))?\)\.?\]?(?:\r?\n|$)/i

function isContextCompactionMessage(message: ChatMessage): boolean {
  return message.content.trim().toLocaleLowerCase().startsWith(CONTEXT_COMPACTION_PREFIX)
    || message.displayKind?.toLocaleLowerCase().includes('compaction') === true
}

function backgroundProcessMetadata(content: string): Record<string, unknown> | undefined {
  const match = content.trim().match(BACKGROUND_PROCESS_NOTICE)
  if (!match) return undefined
  return {
    process_id: match[1],
    exit_code: Number(match[2]),
    ...(match[3]?.trim() ? { signal: match[3].trim() } : {}),
  }
}

function isSystemTimelineMessage(message: ChatMessage): boolean {
  return Boolean(message.displayKind)
    || /^\[system:/i.test(message.content.trim())
    || isContextCompactionMessage(message)
    || Boolean(backgroundProcessMetadata(message.content))
}

export function chatMessageToUi(message: ChatMessage, agentNameFor?: (profile?: string) => string | undefined): UiMessage {
  const attachments: UiMessageAttachment[] | undefined = message.attachments?.map(attachment => ({
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind === 'image' ? 'image' : 'file',
    url: serverFileUrl(attachment.url || attachment.path || '', message.profile) || attachment.url || attachment.path,
    size: attachment.size,
  }))
  return {
    id: message.id,
    role: message.role,
    author: message.role === 'assistant' ? agentNameFor?.(message.profile) || message.profile : undefined,
    content: message.role === 'assistant' ? visibleMessageText(message.content) : message.content,
    reasoning: message.role === 'assistant' ? messageReasoningText(message.content, message.reasoning) : message.reasoning,
    createdAt: message.timestamp < 10_000_000_000 ? message.timestamp * 1000 : message.timestamp,
    status: message.isStreaming ? 'streaming' : message.stage,
    error: message.error,
    attachments,
    // A later streaming string may replace an older structured body.
    contentParts: message.contentParts?.filter(part => 'text' in part).map(part => (part as { text: string }).text).filter(Boolean).join('\n\n') === message.content
      ? message.contentParts?.map(part => 'text' in part && message.role === 'assistant' ? { text: visibleMessageText(part.text) } : part)
      : undefined,
    tools: message.toolCalls?.filter(tool => tool.id).map(tool => toolToUi(!message.isStreaming && ['pending', 'running'].includes(tool.status)
      ? { ...tool, status: 'interrupted' } : tool)),
    profile: message.profile,
  }
}

/** Render only user and agent prose; tool result rows belong under their call. */
export function chatMessagesToUi(messages: ChatMessage[], agentNameFor?: (profile?: string) => string | undefined): UiMessage[] {
  const result: UiMessage[] = []
  const toolOwners = new Map<string, UiMessage>()
  let lastAssistant: UiMessage | undefined

  for (const message of messages) {
    if (message.role === 'tool') {
      const owner = (message.toolCallId && toolOwners.get(message.toolCallId)) || lastAssistant
      if (!owner) continue
      const id = message.toolCallId || message.id
      const tools = [...(owner.tools ?? [])]
      const index = tools.findIndex(tool => tool.id === id)
      const patch: UiToolCall = {
        id,
        name: message.toolName || tools[index]?.name || '工具',
        status: toolResultFailed(toolResult(message), message.error) ? 'error' : 'success',
        input: tools[index]?.input,
        output: message.error || toolResult(message),
      }
      if (index >= 0) tools[index] = { ...tools[index], ...patch }
      else tools.push(patch)
      owner.tools = tools
      if (message.toolCallId) toolOwners.set(message.toolCallId, owner)
      continue
    }
    // Gateway system rows are transport/protocol detail unless they carry an
    // explicit display marker or a human-readable [System: ...] notice.
    if (message.role === 'system' && !isSystemTimelineMessage(message)) continue
    const ui = chatMessageToUi(message, agentNameFor)
    if (isSystemTimelineMessage(message)) {
      const backgroundProcess = backgroundProcessMetadata(message.content)
      ui.role = 'system'
      ui.timelineKind = message.displayKind === 'async_delegation_complete'
        ? 'delegation-complete'
        : backgroundProcess
          ? 'background-process'
          : 'system'
      ui.timelineMetadata = {
        ...(timelineMetadata(message.displayMetadata) ?? {}),
        ...(backgroundProcess ?? {}),
        eventKind: isContextCompactionMessage(message) ? 'compaction' : message.displayKind,
      }
    }
    result.push(ui)
    if (message.role === 'assistant') {
      lastAssistant = ui
      ui.tools = ui.tools?.map(tool => {
        const previous = toolOwners.get(tool.id)
        const known = previous?.tools?.find(candidate => candidate.id === tool.id)
        if (previous && known && !/^tool-\d+$/.test(tool.id)) {
          previous.tools = previous.tools?.filter(candidate => candidate.id !== tool.id)
          tool = { ...known, ...tool, input: tool.input ?? known.input, output: tool.output ?? known.output,
            status: ['success', 'error'].includes(known.status) && !['success', 'error'].includes(tool.status) ? known.status : tool.status }
        }
        toolOwners.set(tool.id, ui)
        return tool
      })
    }
  }
  return result
}

export function chatInteraction(approval?: ApprovalRequest, clarification?: ClarificationRequest): UiInteraction | null {
  if (approval) return {
    id: approval.id,
    kind: 'approval',
    title: approval.toolName ? `允许 ${approval.toolName}` : '允许这项操作',
    prompt: approval.message || '机器人请求执行一项需要确认的操作。',
    options: approval.choices,
    detail: JSON.stringify(approval.payload, null, 2),
  }
  if (clarification) return {
    id: clarification.id,
    kind: 'clarification',
    prompt: clarification.question,
    options: clarification.choices,
    detail: JSON.stringify(clarification.payload, null, 2),
  }
  return null
}

export function roomSidebarItem(
  room: GroupRoomSummary,
  avatars: Record<string, string> = {},
  avatarsByName: Record<string, string> = {},
): SidebarItem {
  return {
    id: room.id,
    title: room.name || '未命名团队',
    subtitle: room.lastMessage?.content || `${room.agentCount} 个机器人`,
    meta: formatRelative(room.updatedAt),
    section: historySection(room.updatedAt),
    unread: room.unreadCount,
    avatar: room.avatar || '',
    avatarFallbackKey: room.id,
    avatarMembers: (room.avatarMembers || []).map(member => ({
      name: member.displayName || member.profile,
      avatar: member.nodeId === 'local' ? avatars[member.profile] || avatarsByName[member.displayName] : undefined,
    })),
  }
}

export function groupMessageToUi(message: GroupMessage, agents: GroupAgent[] = []): UiMessage {
  const tools = (message.toolState || []).map((entry, index) => {
    const value = record(entry)
    const rawStatus = string(value.status, 'success')
    const status: UiToolCall['status'] = rawStatus === 'completed' ? 'success' : rawStatus === 'failed' ? 'error' : ['running', 'pending', 'success', 'error'].includes(rawStatus) ? rawStatus as UiToolCall['status'] : 'success'
    return { id: string(value.id, `${message.id}:tool:${index}`), name: string(value.name ?? value.tool, '工具调用'), status, input: value.input ?? value.arguments, output: value.output ?? value.result }
  })
  const execution = message.execution
  const model = execution?.actualModel || execution?.requestedModel
  const reasoning = execution?.actualReasoningEffort || execution?.requestedReasoningEffort
  const fast = execution?.actualFastMode ?? execution?.requestedFastMode
  const metadata = model ? `${fast ? '⚡ ' : ''}${model}${reasoning ? ` · ${reasoning}` : ''}` : undefined
  const sender = message.senderKind === 'agent'
    ? agents.find(agent => agent.id === message.senderId)
    : undefined
  const content = sender && sender.nodeId !== 'local'
    ? rewriteRemoteNodeFiles(message.content, sender.nodeId, message.status === 'streaming')
    : message.content
  return {
    id: message.id,
    role: message.senderKind === 'human' ? 'user' : message.senderKind === 'agent' ? 'assistant' : 'system',
    author: sender?.displayName || message.senderName,
    isRemoteAgent: message.senderKind === 'agent' && sender != null && sender.nodeId !== 'local',
    // Only local agents share this Web client's Desktop Bots identity map.
    // Remote nodes keep their own identity and intentionally do not collide by
    // profile slug with a local agent.
    profile: sender
      ? sender.nodeId === 'local'
        ? sender.profile
        : `node:${sender.nodeId}:${sender.profile}`
      : undefined,
    content,
    reasoning: message.senderKind === 'agent' ? messageReasoningText(message.content, message.reasoning) : message.reasoning,
    createdAt: message.createdAt < 10_000_000_000 ? message.createdAt * 1000 : message.createdAt,
    status: message.status === 'completed' ? 'settled' : message.status === 'queued' ? 'pending' : message.status === 'streaming' ? 'streaming' : message.status === 'failed' ? 'failed' : message.status === 'unknown' ? 'unknown-receipt' : 'settled',
    error: message.error,
    tools,
    metadata,
  }
}

export function rewriteRemoteNodeFiles(content: string, nodeId: string, streaming = false): string {
  if (!/^[0-9a-f-]{36}$/i.test(nodeId)) return content
  return normalizeAssistantMediaMarkdown(content, streaming).replace(
    /(!?\[[^\]]*\]\()<?(?:file:\/\/|sandbox:)?(\/[^)>\n]+)>?(\))/g,
    (match, prefix: string, raw: string, suffix: string) => {
      const path = serverFilePath(raw)
      return path && serverFileUrl(raw) ? `${prefix}/api/app/groups/nodes/${encodeURIComponent(nodeId)}/files?path=${encodeURIComponent(path)}${suffix}` : match
    },
  )
}

export function groupInteraction(interaction?: GroupInteraction): UiInteraction | null {
  if (!interaction || interaction.status !== 'pending') return null
  const payload = record(interaction.payload)
  const choices = Array.isArray(payload.choices) ? payload.choices.filter((choice): choice is string => typeof choice === 'string') : undefined
  return {
    id: interaction.id,
    kind: interaction.kind === 'clarification' ? 'clarification' : 'approval',
    title: string(payload.title || payload.tool_name),
    prompt: string(payload.question || payload.message || payload.prompt, interaction.kind === 'clarification' ? '机器人需要补充信息' : '机器人请求执行操作'),
    options: choices,
    detail: JSON.stringify(payload, null, 2),
  }
}

export function agentToUi(agent: GroupAgent): UiAgent {
  return {
    id: agent.id,
    name: agent.displayName || agent.profile,
    profile: agent.profile,
    nodeId: agent.nodeId,
    enabled: agent.enabled,
    autoReply: agent.replyWithoutMention,
    isHost: agent.isHost,
    status: agent.status === 'running' || agent.status === 'queued' ? 'working' : agent.status === 'unknown' ? 'offline' : 'idle',
  }
}

export function roomToUi(room: GroupRoomDetail): UiRoom {
  return {
    id: room.id,
    name: room.name,
    archived: room.archived,
    instructions: room.instructions,
    avatar: room.avatar,
    memberIds: room.agents.map(agent => agent.id),
    replyRounds: room.maxReplyRounds,
    orchestrationMode: room.orchestrationMode,
  }
}

export function fileToUi(item: FileLibraryItem): UiLibraryItem {
  const extension = (item.extension || item.name.split('.').at(-1) || '').replace(/^\./, '').toLocaleLowerCase()
  const isTextFile = ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'js', 'ts', 'py', 'sh', 'css', 'html', 'xml'].includes(extension)
  const kind: UiLibraryItem['kind'] = item.mimeType === 'application/pdf' || extension === 'pdf'
    ? 'pdf'
    : isTextFile || /text|json|xml|javascript|typescript|css|html/i.test(item.mimeType)
      ? 'text'
      : item.kind === 'document' ? 'document' : item.kind === 'other' ? 'file' : item.kind
  const origin = item.origins.at(-1)
  return {
    id: item.id,
    name: item.name,
    kind,
    mimeType: item.mimeType,
    size: item.size,
    updatedAt: item.modifiedAt < 10_000_000_000 ? item.modifiedAt * 1000 : item.modifiedAt,
    previewUrl: item.previewUrl,
    downloadUrl: item.downloadUrl,
    sourceLabel: origin?.sessionTitle || origin?.authorName || origin?.profile,
    sourceSessionId: origin?.sessionId,
    sourceWorkspaceConversationId: origin?.workspaceConversationId,
    sourceMessageId: origin?.messageId,
    sourceProfile: origin?.profile,
  }
}

export function artifactToUi(item: ConversationArtifact): UiLibraryItem {
  const raw = item.attachment
  const kind: UiLibraryItem['kind'] = item.kind === 'link' ? 'link' : item.kind === 'image' ? 'image' : raw?.mimeType === 'application/pdf' ? 'pdf' : 'file'
  return {
    id: item.id,
    name: item.label || item.value.split('/').at(-1) || '产物',
    title: item.label,
    kind,
    mimeType: item.mimeType || raw?.mimeType,
    size: raw?.size,
    createdAt: item.timestamp < 10_000_000_000 ? item.timestamp * 1000 : item.timestamp,
    previewUrl: raw?.url || item.value,
    downloadUrl: raw?.url || (item.kind === 'file' ? item.value : undefined),
    sourceLabel: item.sessionTitle,
    sourceSessionId: item.sessionId,
    sourceMessageId: item.messageId,
    sourceProfile: item.profile,
  }
}


/** Adapt the Web-owned transcript to the existing chat presentation. */
export function workspaceMessagesToUi(messages: import('@shared/workspace').WorkspaceMessage[]): UiMessage[] {
  return messages.filter(message => message.visible !== false).map(message => ({
    id: message.id, role: message.role, author: message.agentName,
    communication: message.communication,
    taskReference: message.taskReference,
    error: message.error, runId: message.runId,
    profile: message.agentId, createdAt: message.createdAt,
    content: (message.communication?.content ?? (message.role === 'assistant' ? visibleMessageText(message.content) : message.content)).replace(/(!?\[[^\]]*\])\(<?([^)>]+)>?\)/g, (whole, label: string, path: string) => {
      const file = message.attachments.find(file => file.sourcePath === path)
      return file ? `${label}(/api/app/files/${file.id}/${label.startsWith('!') ? 'preview' : 'download'})` : whole
    }),
    reasoning: message.role === 'assistant' ? messageReasoningText(message.content, message.reasoning) : message.reasoning,
    status: message.status === 'complete' || message.status === 'interrupted' ? 'settled'
      : message.status === 'uncertain' ? 'unknown-receipt'
      : message.status === 'queued' ? 'pending' : message.status,
    attachments: message.attachments.map(file => ({
      id: file.id, name: file.name, size: file.size,
      kind: file.mimeType.startsWith('image/') ? 'image' : file.mimeType.startsWith('video/') ? 'video' : file.mimeType.startsWith('audio/') ? 'audio' : 'file',
      url: `/api/app/files/${file.id}/${file.mimeType.startsWith('image/') ? 'preview' : 'download'}`,
    })),
    tools: message.tools.map((tool, index) => {
      let status = toolStatus(tool.status, tool.result ?? tool.output, tool.error)
      // Match runtime finalization for older messages whose tools were not settled.
      if (status === 'running' && ['complete', 'failed', 'interrupted'].includes(message.status)) {
        status = message.status === 'complete' ? 'completed' : message.status === 'failed' ? 'failed' : 'interrupted'
      }
      return {
        id: String(tool.id || index), name: String(tool.name || tool.tool_name || '工具'),
        status: status === 'completed' ? 'success' : status === 'failed' ? 'error' : status,
        input: tool.arguments ?? tool.args ?? tool.input, output: tool.error ?? tool.result ?? tool.output,
      }
    }),
  }))
}


export function workspaceAvatarMembers(memberIds: string[], agents: import('@shared/workspace').WorkspaceAgent[], conversation?: import('@shared/workspace').WorkspaceConversation) {
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  return memberIds.flatMap(id => {
    const agent = byId.get(id)
    return agent ? [{ name: agent.name, avatar: agent.avatar, state: workspaceAvatarState(conversation, agent.id), activityKey: conversation?.lastSeq }] : []
  })
}


export function workspaceAvatarState(conversation: import('@shared/workspace').WorkspaceConversation | undefined, agentId: string): 'idle' | 'working' | 'waiting' | 'loading' | 'success' | 'failure' | 'notifying' {
  const state = conversation?.activeAgentStates?.[agentId]
  if (state) return state === 'running' ? 'working' : state === 'queued' ? 'loading' : 'waiting'
  const signal = conversation?.avatarSignals?.[agentId]
  if (signal && Date.now() - signal.at < 2000) return signal.state
  if (conversation?.activeRunStatus === 'queued' && conversation.memberIds[0] === agentId) return 'loading'
  if (!conversation?.activeRunId || conversation.activeAgentId !== agentId) return conversation?.previewAgentId === agentId && workspaceHasUnread(conversation) ? 'notifying' : 'idle'
  return conversation.activeRunStatus === 'waiting' || conversation.activeRunStatus === 'uncertain' ? 'waiting' : 'working'
}

type WorkspaceAgentActivity = 'working' | 'waiting' | 'loading'

/** A Bot can be busy in several chats; one finished run must not hide another. */
export function workspaceAgentActivity(conversations: import('@shared/workspace').WorkspaceConversation[]): Map<string, WorkspaceAgentActivity> {
  const activity = new Map<string, WorkspaceAgentActivity>()
  const priority = { working: 3, waiting: 2, loading: 1 }
  for (const conversation of conversations) {
    for (const id of conversation.memberIds) {
      const state = workspaceAvatarState(conversation, id)
      if (state !== 'working' && state !== 'waiting' && state !== 'loading') continue
      const previous = activity.get(id)
      if (!previous || priority[state] > priority[previous]) activity.set(id, state)
    }
  }
  return activity
}

export function workspaceConversationItem(c: import('@shared/workspace').WorkspaceConversation, agents: import('@shared/workspace').WorkspaceAgent[], agentActivity?: ReadonlyMap<string, WorkspaceAgentActivity>): SidebarItem {
  const activity = c.kind === 'direct' ? agentActivity?.get(c.memberIds[0] || '') : undefined
  return {
    id: c.id, title: c.name, subtitle: c.preview || (c.kind === 'direct' ? agents.find(agent => agent.id === c.memberIds[0])?.job || '' : '') || '开始聊天', pinned: c.pinned,
    section: c.pinned ? '已置顶' : '聊天', avatar: c.kind === 'group' ? '' : c.avatar,
    avatarMembers: c.kind === 'group' ? workspaceAvatarMembers(c.memberIds, agents, c) : [],
    meta: formatConversationTime(workspaceConversationTimestamp(c)),
    avatarKind: c.kind === 'direct' ? 'agent' : 'team',
    avatarState: activity ?? workspaceAvatarState(c, c.memberIds[0] || ''), avatarActivityKey: c.lastSeq,
    unreadDot: workspaceHasUnread(c), status: activity || c.activeRunId ? 'working' : undefined,
  }
}
