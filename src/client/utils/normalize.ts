import type {
  ChatAttachment,
  ChatMessage,
  CurrentUser,
  FileKind,
  FileLibraryItem,
  GroupAgent,
  GroupCapabilities,
  GroupInteraction,
  GroupMessage,
  GroupRoomDetail,
  GroupRoomActivity,
  GroupRoomSummary,
  GroupRun,
  GroupTopicSummary,
  JsonValue,
  ModelOption,
  Profile,
  SessionSummary,
  ToolCall,
} from '@shared/types'

export type UnknownRecord = Record<string, unknown>

export function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function string(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

export function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return fallback
}

export function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pick(source: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key]
  return undefined
}

function jsonRecord(value: unknown): UnknownRecord {
  const direct = record(value)
  if (Object.keys(direct).length || typeof value !== 'string') return direct
  try { return record(JSON.parse(value)) } catch { return {} }
}

export function normalizeUser(value: unknown): CurrentUser {
  const source = record(value)
  const id = string(pick(source, 'id', 'user_id', 'userId')) || string(pick(source, 'email', 'username')) || 'local'
  return {
    id,
    username: string(pick(source, 'username', 'display_name', 'displayName', 'email', 'user_id', 'userId'), id),
    avatar: string(source.avatar) || undefined,
    displayName: string(pick(source, 'display_name', 'displayName')) || undefined,
    email: string(source.email) || undefined,
    provider: string(source.provider) || undefined,
    role: string(source.role) || undefined,
    enabled: source.enabled === undefined ? undefined : bool(source.enabled),
    mustChangePassword: bool(pick(source, 'mustChangePassword', 'must_change_password')),
  }
}

export function normalizeProfile(value: unknown): Profile {
  const source = record(value)
  const name = string(pick(source, 'name', 'profile', 'id'), 'default')
  return {
    name,
    agentName: string(pick(source, 'agentName', 'agent_name')) || undefined,
    displayName: string(pick(source, 'display_name', 'displayName', 'alias', 'description')) || undefined,
    description: string(source.description) || undefined,
    isDefault: bool(pick(source, 'is_default', 'isDefault', 'active')),
    model: string(source.model) || undefined,
    provider: string(source.provider) || undefined,
    gatewayRunning: source.gateway_running === undefined && source.gatewayRunning === undefined
      ? undefined
      : bool(pick(source, 'gateway_running', 'gatewayRunning')),
    avatar: string(source.avatar) || undefined,
    agentAvatar: string(pick(source, 'agentAvatar', 'agent_avatar')) || undefined,
  }
}

export function normalizeModel(value: unknown): ModelOption {
  const source = record(value)
  const provider = string(source.provider)
  const id = string(pick(source, 'id', 'model', 'value'))
  return {
    id,
    name: string(pick(source, 'name', 'display_name', 'displayName'), id),
    provider,
    supportsReasoning: source.supports_reasoning === undefined && source.supportsReasoning === undefined
      ? undefined
      : bool(pick(source, 'supports_reasoning', 'supportsReasoning')),
    reasoningEfforts: values(pick(source, 'reasoning_efforts', 'reasoningEfforts')).map(value => string(value)).filter(Boolean),
    isDefault: bool(pick(source, 'is_default', 'isDefault')),
  }
}

export function normalizeSession(value: unknown, fallbackProfile?: string): SessionSummary {
  const source = record(value)
  const modelConfig = jsonRecord(pick(source, 'model_config', 'modelConfig'))
  const owned = pick(source, 'owned', 'is_owned', 'isOwned')
  const startedAt = number(pick(source, 'started_at', 'startedAt', 'created_at', 'createdAt'))
  const updatedAt = number(pick(source, 'last_active', 'lastActive', 'updated_at', 'updatedAt'), startedAt)
  const id = string(pick(source, 'id', 'session_id', 'sessionId', 'stored_session_id', 'storedSessionId'))
  return {
    id,
    profile: string(source.profile, fallbackProfile) || undefined,
    source: string(source.source, 'cli'),
    owned: owned === undefined ? undefined : bool(owned),
    title: string(source.title, '未命名会话'),
    preview: string(source.preview) || undefined,
    model: string(source.model ?? modelConfig.model) || undefined,
    provider: string(source.provider ?? modelConfig.provider) || undefined,
    agent: string(source.agent) || undefined,
    messageCount: number(pick(source, 'message_count', 'messageCount')),
    toolCallCount: number(pick(source, 'tool_call_count', 'toolCallCount')),
    inputTokens: number(pick(source, 'input_tokens', 'inputTokens')) || undefined,
    outputTokens: number(pick(source, 'output_tokens', 'outputTokens')) || undefined,
    startedAt,
    updatedAt,
    endedAt: pick(source, 'ended_at', 'endedAt') == null ? null : number(pick(source, 'ended_at', 'endedAt')),
    parentSessionId: string(pick(source, 'parent_session_id', 'parentSessionId')) || null,
    forkPointMessageId: string(pick(source, 'fork_point_message_id', 'forkPointMessageId')) || null,
    workspace: string(source.workspace) || null,
    archived: bool(pick(source, 'is_archived', 'isArchived', 'archived')),
    pinned: bool(pick(source, 'is_pinned', 'isPinned', 'pinned')),
  }
}

function normalizeToolCall(value: unknown, index: number): ToolCall {
  const source = record(value)
  const functionCall = record(source.function)
  const error = string(source.error)
  const result = pick(source, 'result', 'output') as JsonValue | undefined
  return {
    id: string(pick(source, 'id', 'tool_call_id', 'toolCallId', 'tool_id'), `tool-${index}`),
    name: string(pick(source, 'name', 'tool_name', 'toolName') ?? functionCall.name, '工具'),
    status: error ? 'failed' : result !== undefined ? 'completed' : 'running',
    arguments: (pick(source, 'arguments', 'args', 'context') ?? functionCall.arguments) as JsonValue | undefined,
    result,
    preview: string(pick(source, 'preview', 'summary', 'args_text')) || undefined,
    error: error || undefined,
    durationSeconds: number(pick(source, 'duration_seconds', 'durationSeconds', 'duration_s')) || undefined,
  }
}

function parseJsonValue(value: unknown): JsonValue | undefined {
  if (typeof value !== 'string') return value as JsonValue | undefined
  try { return JSON.parse(value) as JsonValue } catch { return undefined }
}

export function normalizeAttachment(value: unknown, index = 0): ChatAttachment {
  const source = record(value)
  const mimeType = string(pick(source, 'mime_type', 'mimeType', 'media_type', 'mediaType'), 'application/octet-stream')
  const name = string(pick(source, 'name', 'filename'), `附件 ${index + 1}`)
  return {
    id: string(source.id, `${name}:${index}`),
    name,
    mimeType,
    size: number(source.size),
    path: string(source.path) || undefined,
    url: string(source.url) || undefined,
    kind: mimeType.startsWith('image/') ? 'image' : mimeType === 'application/pdf' ? 'pdf' : 'file',
  }
}

function attachmentMime(name: string): { mimeType: string; kind: ChatAttachment['kind'] } {
  const extension = name.split('.').at(-1)?.toLocaleLowerCase() || ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff'].includes(extension)) {
    return { mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`, kind: 'image' }
  }
  if (extension === 'pdf') return { mimeType: 'application/pdf', kind: 'pdf' }
  return { mimeType: 'application/octet-stream', kind: 'file' }
}

function persistedAttachmentUrl(path: string): { path: string; url: string } | undefined {
  if (path.startsWith('/')) return { path, url: path }
  const segments = path.split('/')
  const normalizedSegments = segments.map(segment => {
    try { return decodeURIComponent(segment) } catch { return '' }
  })
  if (segments[0] !== 'attachments' || segments.length < 2 || normalizedSegments.some(segment => !segment || segment === '.' || segment === '..')) return undefined
  return { path, url: `/${segments.map(encodeURIComponent).join('/')}` }
}

function persistedImageUrl(path: string): { path: string; url: string } | undefined {
  if (!path.startsWith('/')) return undefined
  const segments = path.slice(1).split('/')
  const normalizedSegments = segments.map(segment => {
    try { return decodeURIComponent(segment) } catch { return '' }
  })
  const rootImages = normalizedSegments[3] === 'images' && segments.length >= 5
  const profileImages = normalizedSegments[3] === 'profiles'
    && normalizedSegments[5] === 'images' && segments.length >= 7
  // User uploads belong to either the default Hermes home or the selected
  // Profile. Keep the full path so the Web media route reaches that Profile.
  if (normalizedSegments[0] !== 'Users' || normalizedSegments[2] !== '.hermes'
    || (!rootImages && !profileImages)
    || normalizedSegments.some(segment => !segment || segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment))) return undefined
  return { path, url: `/${segments.map(encodeURIComponent).join('/')}` }
}

function extractPersistedAttachments(content: string): { content: string; attachments: ChatAttachment[] } {
  const attachments: ChatAttachment[] = []
  const extracted = content.replace(
    /\[用户附加\s*(文件|图片|PDF)\s*：\s*([^\]\r\n]+)\]\s*(?:\r?\n)?@file:\s*(`[^`\r\n]+`|'[^'\r\n]+'|"[^"\r\n]+"|(?:\\?\/)[^\r\n]+)/g,
    (_match, _type: string, rawName: string, rawPath: string) => {
      const name = rawName.trim()
      const path = rawPath.trim().replace(/\\\//g, '/').replace(/^[`'"]|[`'"]$/g, '')
      const reference = persistedAttachmentUrl(path)
      if (!reference) return _match
      const media = attachmentMime(name)
      attachments.push({ id: `persisted:${reference.path}`, name, path: reference.path, url: reference.url, size: 0, ...media })
      return ''
    },
  )
  const cleaned = (attachments.length
    ? extracted.replace(/(?:^|\n)--- Attached Context ---[\s\S]*$/, '')
    : extracted
  ).replace(/\n{3,}/g, '\n\n').trim()
  return { content: cleaned, attachments }
}

function extractPersistedImages(content: string): { content: string; attachments: ChatAttachment[] } {
  const lines = content.split(/\r?\n/)
  const attachments: ChatAttachment[] = []
  const imageMarker = /^\[用户附加图片\s*：\s*([^\]\r\n]+)\]\s*$/
  const imageReference = /^@image:\s*(.+?)\s*$/
  const screenshot = /^\[screenshot\]\s*$/

  for (let index = 0; index < lines.length;) {
    const firstMarker = lines[index]?.match(imageMarker)
    if (!firstMarker) {
      index += 1
      continue
    }
    const start = index
    const names: string[] = []
    let cursor = index
    while (true) {
      const marker = lines[cursor]?.match(imageMarker)
      if (!marker) break
      names.push(marker[1]!.trim())
      cursor += 1
      while (lines[cursor]?.trim() === '') cursor += 1
    }
    const paths: string[] = []
    while (true) {
      const reference = lines[cursor]?.match(imageReference)
      if (!reference) break
      paths.push(reference[1]!.trim().replace(/^[`'"]|[`'"]$/g, ''))
      cursor += 1
    }
    const references = paths.map(persistedImageUrl)
    if (!paths.length || names.length !== paths.length || references.some(reference => !reference)) {
      index = start + 1
      continue
    }
    for (let position = 0; position < names.length; position += 1) {
      const reference = references[position]!
      const name = names[position]!
      attachments.push({ id: `persisted:${reference.path}`, name, path: reference.path, url: reference.url, size: 0, ...attachmentMime(name) })
    }
    while (screenshot.test(lines[cursor] || '')) cursor += 1
    lines.splice(start, cursor - start, ...Array(cursor - start).fill(''))
    index = cursor
  }
  return { content: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), attachments }
}

export function normalizeChatMessage(value: unknown, sessionId: string, fallbackProfile?: string): ChatMessage {
  const source = record(value)
  const contentValue = pick(source, 'content', 'text', 'output')
  let content = typeof contentValue === 'string' ? contentValue : ''
  let attachments: ChatAttachment[] = values(pick(source, 'attachments', 'files')).map(normalizeAttachment)
  if (Array.isArray(contentValue)) {
    const textBlocks: string[] = []
    const attachmentBlocks: ChatAttachment[] = []
    contentValue.forEach((blockValue, index) => {
      const block = record(blockValue)
      const type = string(block.type)
      if (type === 'text') textBlocks.push(string(block.text))
      if (type === 'image' || type === 'file') attachmentBlocks.push(normalizeAttachment(block, index))
    })
    content = textBlocks.filter(Boolean).join('\n\n')
    attachments = [...attachments, ...attachmentBlocks]
  }
  const roleValue = string(source.role, 'assistant')
  const role = ['user', 'assistant', 'tool', 'system'].includes(roleValue) ? roleValue as ChatMessage['role'] : 'system'
  if (role === 'user' && (content.includes('@file:') || content.includes('@image:'))) {
    const persistedFiles = extractPersistedAttachments(content)
    const persistedImages = extractPersistedImages(persistedFiles.content)
    content = persistedImages.content
    const known = new Set(attachments.map(item => item.path || item.url || item.name))
    attachments.push(...[...persistedFiles.attachments, ...persistedImages.attachments]
      .filter(item => !known.has(item.path || item.url || item.name)))
  }
  const id = string(pick(source, 'id', 'message_id', 'messageId')) || `history-${sessionId}-${number(source.timestamp)}-${Math.random()}`
  const status = string(pick(source, 'status', 'finish_reason', 'finishReason'))
  return {
    id,
    serverMessageId: id,
    clientMessageId: string(pick(source, 'client_message_id', 'clientMessageId')) || undefined,
    sessionId,
    profile: string(source.profile, fallbackProfile) || undefined,
    role,
    content,
    reasoning: string(pick(source, 'reasoning', 'thinking', 'reasoning_content', 'reasoningContent')) || undefined,
    timestamp: number(pick(source, 'timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt'), Date.now() / 1000),
    sequence: number(pick(source, 'seq', 'sequence')) || undefined,
    stage: status === 'error' || source.error ? 'failed' : 'settled',
    error: string(source.error) || undefined,
    attachments: attachments.length ? attachments : undefined,
    toolCalls: values(typeof pick(source, 'tool_calls', 'toolCalls', 'tools') === 'string'
      ? (() => { try { return JSON.parse(String(pick(source, 'tool_calls', 'toolCalls', 'tools'))) } catch { return [] } })()
      : pick(source, 'tool_calls', 'toolCalls', 'tools')).map(normalizeToolCall),
    toolCallId: string(pick(source, 'tool_call_id', 'toolCallId')) || undefined,
    toolName: string(pick(source, 'tool_name', 'toolName')) || undefined,
    displayKind: string(pick(source, 'display_kind', 'displayKind')) || undefined,
    displayMetadata: parseJsonValue(pick(source, 'display_metadata', 'displayMetadata')),
    raw: value as JsonValue,
  }
}

export function normalizeGroupCapabilities(value: unknown): GroupCapabilities {
  const source = record(value)
  const limits = record(source.limits)
  return {
    protocolVersion: number(pick(source, 'protocolVersion', 'protocol_version')),
    journalEpoch: string(pick(source, 'journalEpoch', 'journal_epoch')),
    latestCursor: number(pick(source, 'latestCursor', 'latest_cursor')),
    limits: {
      maxAgentsPerRoom: number(pick(limits, 'maxAgentsPerRoom', 'max_agents_per_room'), 8),
      maxMessageBytes: number(pick(limits, 'maxMessageBytes', 'max_message_bytes'), 64 * 1024),
      maxToolStateBytes: number(pick(limits, 'maxToolStateBytes', 'max_tool_state_bytes')) || undefined,
      maxInteractionPayloadBytes: number(pick(limits, 'maxInteractionPayloadBytes', 'max_interaction_payload_bytes')) || undefined,
      maxMessagePageSize: number(pick(limits, 'maxMessagePageSize', 'max_message_page_size'), 100),
      maxEventBatchSize: number(pick(limits, 'maxEventBatchSize', 'max_event_batch_size')) || undefined,
      maxAgentDepth: number(pick(limits, 'maxAgentDepth', 'max_agent_depth')) || undefined,
      maxRoomConcurrency: number(pick(limits, 'maxRoomConcurrency', 'max_room_concurrency')) || undefined,
      maxPluginConcurrency: number(pick(limits, 'maxPluginConcurrency', 'max_plugin_concurrency')) || undefined,
      defaultMaxReplyRounds: number(pick(limits, 'defaultMaxReplyRounds', 'default_max_reply_rounds'), 3),
      unlimitedReplyRoundsValue: number(pick(limits, 'unlimitedReplyRoundsValue', 'unlimited_reply_rounds_value'), -1),
      maxAgentDisplayNameLength: number(pick(limits, 'maxAgentDisplayNameLength', 'max_agent_display_name_length'), 100),
    },
    eventTypes: values(pick(source, 'eventTypes', 'event_types')).map(value => string(value)).filter(Boolean),
    features: values(source.features).map(value => string(value)).filter(Boolean),
  }
}

export function normalizeGroupAgent(value: unknown): GroupAgent {
  const source = record(value)
  const status = string(source.status, 'unknown') as GroupAgent['status']
  const rawFastMode = pick(source, 'fastMode', 'fast_mode')
  return {
    id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')),
    profile: string(source.profile),
    nodeId: string(pick(source, 'nodeId', 'node_id'), 'local'),
    nodeLabel: string(pick(source, 'nodeLabel', 'node_label')),
    displayName: string(pick(source, 'displayName', 'display_name'), string(source.profile)),
    description: string(source.description), storedSessionId: string(pick(source, 'storedSessionId', 'stored_session_id')) || null,
    lastContextMessageSeq: number(pick(source, 'lastContextMessageSeq', 'last_context_message_seq')),
    enabled: bool(source.enabled, true), replyWithoutMention: bool(pick(source, 'replyWithoutMention', 'reply_without_mention')),
    isHost: bool(pick(source, 'isHost', 'is_host')),
    model: string(source.model) || null, provider: string(source.provider) || null,
    reasoningEffort: string(pick(source, 'reasoningEffort', 'reasoning_effort')) || null,
    fastMode: rawFastMode == null ? null : bool(rawFastMode),
    createdAt: number(pick(source, 'createdAt', 'created_at')), updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
    status: ['idle', 'queued', 'running', 'awaiting_input'].includes(status) ? status : 'unknown',
  }
}

export function normalizeGroupMessage(value: unknown): GroupMessage {
  const source = record(value)
  const senderKind = string(pick(source, 'senderKind', 'sender_kind'), 'unknown') as GroupMessage['senderKind']
  const status = string(source.status, 'unknown') as GroupMessage['status']
  return {
    seq: number(source.seq), id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')),
    topicId: string(pick(source, 'topicId', 'topic_id')) || null,
    senderKind: ['human', 'agent', 'system'].includes(senderKind) ? senderKind : 'unknown',
    senderId: string(pick(source, 'senderId', 'sender_id')), senderName: string(pick(source, 'senderName', 'sender_name')),
    rootMessageId: string(pick(source, 'rootMessageId', 'root_message_id')), replyToMessageId: string(pick(source, 'replyToMessageId', 'reply_to_message_id')) || null,
    clientMessageId: string(pick(source, 'clientMessageId', 'client_message_id')) || null,
    content: string(source.content), reasoning: string(source.reasoning), toolState: values(pick(source, 'toolState', 'tool_state')) as JsonValue[],
    status: ['queued', 'streaming', 'completed', 'failed', 'interrupted'].includes(status) ? status : 'unknown',
    error: string(source.error), execution: source.execution ? record(source.execution) as GroupMessage['execution'] : null, createdAt: number(pick(source, 'createdAt', 'created_at')), updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
  }
}

export function normalizeGroupInteraction(value: unknown): GroupInteraction {
  const source = record(value)
  return {
    id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')), topicId: string(pick(source, 'topicId', 'topic_id')) || null,
    agentId: string(pick(source, 'agentId', 'agent_id')),
    runId: string(pick(source, 'runId', 'run_id')), kind: string(source.kind, 'unknown') as GroupInteraction['kind'],
    payload: (source.payload ?? null) as JsonValue, status: string(source.status, 'unknown') as GroupInteraction['status'],
    createdAt: number(pick(source, 'createdAt', 'created_at')), resolvedAt: pick(source, 'resolvedAt', 'resolved_at') == null ? null : number(pick(source, 'resolvedAt', 'resolved_at')),
  }
}

export function normalizeGroupRun(value: unknown): GroupRun {
  const source = record(value)
  const status = string(source.status, 'unknown') as GroupRun['status']
  const replyMode = string(pick(source, 'replyMode', 'reply_mode'))
  return {
    id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')),
    topicId: string(pick(source, 'topicId', 'topic_id')) || null,
    agentId: string(pick(source, 'agentId', 'agent_id')),
    triggerMessageId: string(pick(source, 'triggerMessageId', 'trigger_message_id')),
    responseMessageId: string(pick(source, 'responseMessageId', 'response_message_id')),
    rootMessageId: string(pick(source, 'rootMessageId', 'root_message_id')),
    depth: number(source.depth),
    status: ['queued', 'running', 'awaiting_input', 'completed', 'failed', 'interrupted'].includes(status) ? status : 'unknown',
    runtimeSessionId: string(pick(source, 'runtimeSessionId', 'runtime_session_id')) || null,
    error: string(source.error),
    replyMode: replyMode === 'mentioned' || replyMode === 'automatic' ? replyMode : null,
    createdAt: number(pick(source, 'createdAt', 'created_at')),
    updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
  }
}

export function normalizeGroupTopic(value: unknown): GroupTopicSummary {
  const source = record(value)
  return {
    id: string(source.id), roomId: string(pick(source, 'roomId', 'room_id')),
    title: string(source.title, '新话题'), preview: string(source.preview),
    messageCount: number(pick(source, 'messageCount', 'message_count')),
    unreadCount: number(pick(source, 'unreadCount', 'unread_count')),
    latestMessageSeq: number(pick(source, 'latestMessageSeq', 'latest_message_seq')),
    createdAt: number(pick(source, 'createdAt', 'created_at')),
    updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
    archived: bool(source.archived),
    pinned: bool(source.pinned),
  }
}

export function normalizeGroupRoom(value: unknown): GroupRoomSummary {
  const source = record(value)
  const rawAgents = source.agents
  const orchestrationMode = string(pick(source, 'orchestrationMode', 'orchestration_mode'))
  return {
    id: string(source.id), name: string(source.name, '未命名团队'), cwd: string(source.cwd), instructions: string(source.instructions), avatar: string(source.avatar),
    avatarMembers: values(pick(source, 'avatarMembers', 'avatar_members')).flatMap(value => {
      const member = record(value)
      const profile = string(member.profile)
      if (!profile) return []
      return [{ profile, nodeId: string(pick(member, 'nodeId', 'node_id'), 'local'), displayName: string(pick(member, 'displayName', 'display_name'), profile) }]
    }),
    createdAt: number(pick(source, 'createdAt', 'created_at')), updatedAt: number(pick(source, 'updatedAt', 'updated_at')),
    archived: bool(source.archived), agentCount: Array.isArray(rawAgents) ? rawAgents.length : number(pick(source, 'agentCount', 'agent_count')),
    lastMessage: source.lastMessage || source.last_message ? normalizeGroupMessage(pick(source, 'lastMessage', 'last_message')) : null,
    unreadCount: number(pick(source, 'unreadCount', 'unread_count')),
    activeRunCount: number(pick(source, 'activeRunCount', 'active_run_count')),
    maxReplyRounds: number(pick(source, 'maxReplyRounds', 'max_reply_rounds'), 3),
    orchestrationMode: orchestrationMode === 'host' ? 'host' : 'free',
  }
}

export function normalizeGroupRoomActivity(value: unknown): GroupRoomActivity {
  const source = record(value)
  const lastMessage = pick(source, 'lastMessage', 'last_message')
  return {
    roomId: string(pick(source, 'roomId', 'room_id')),
    activeRunCount: number(pick(source, 'activeRunCount', 'active_run_count')),
    unreadCount: number(pick(source, 'unreadCount', 'unread_count')),
    lastMessage: lastMessage == null ? null : normalizeGroupMessage(lastMessage),
  }
}

export function normalizeGroupRoomDetail(value: unknown): GroupRoomDetail {
  const source = record(value)
  const summary = normalizeGroupRoom(source)
  return {
    id: summary.id, name: summary.name, cwd: summary.cwd, instructions: summary.instructions, avatar: summary.avatar, avatarMembers: summary.avatarMembers, createdAt: summary.createdAt, updatedAt: summary.updatedAt,
    archived: summary.archived, maxReplyRounds: summary.maxReplyRounds, orchestrationMode: summary.orchestrationMode,
    agents: values(source.agents).map(normalizeGroupAgent), runs: values(source.runs).map(normalizeGroupRun),
    pendingInteractions: values(pick(source, 'pendingInteractions', 'pending_interactions')).map(normalizeGroupInteraction),
    latestCursor: number(pick(source, 'latestCursor', 'latest_cursor')),
  }
}

export function inferFileKind(mimeType: string, name: string): FileKind {
  const mime = mimeType.toLowerCase().split(';')[0]
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('text/') || /\.(pdf|docx?|xlsx?|pptx?|md|txt|csv|json|rtf|pages|numbers|key)$/i.test(name)) return 'document'
  return 'other'
}

export function normalizeFile(value: unknown, fallbackProfile?: string): FileLibraryItem {
  const source = record(value)
  const id = string(pick(source, 'id', 'fileId', 'file_id'))
  const mimeType = string(pick(source, 'mimeType', 'mime_type'), 'application/octet-stream')
  const name = string(source.name)
  const origins = values(source.origins).map(item => {
    const origin = record(item)
    return {
      id: origin.id as number | string | undefined,
      profile: string(origin.profile) || fallbackProfile || undefined,
      sessionId: string(pick(origin, 'sessionId', 'session_id')) || undefined,
      workspaceConversationId: string(origin.workspaceConversationId) || undefined,
      sessionTitle: string(pick(origin, 'sessionTitle', 'session_title')) || undefined,
      messageId: string(pick(origin, 'messageId', 'message_id')) || undefined,
      authorKind: string(pick(origin, 'authorKind', 'author_kind')) as FileLibraryItem['origins'][number]['authorKind'] || undefined,
      authorName: string(pick(origin, 'authorName', 'author_name')) || undefined,
      observedAt: number(pick(origin, 'observedAt', 'observed_at')) || undefined,
      originalPath: string(pick(origin, 'originalPath', 'original_path')) || undefined,
      referencePath: string(pick(origin, 'referencePath', 'reference_path')) || undefined,
    }
  })
  const profile = origins.find(origin => origin.profile)?.profile
  const profileQuery = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  return {
    id, path: string(source.path), name, extension: string(pick(source, 'extension', 'extensionName', 'extension_name')),
    mimeType, size: number(source.size), modifiedAt: number(pick(source, 'modifiedAt', 'modified_at')),
    exists: bool(source.exists, true), availability: string(source.availability) as FileLibraryItem['availability'] || undefined,
    archiveStatus: string(pick(source, 'archiveStatus', 'archive_status')) || undefined,
    firstSeenAt: number(pick(source, 'firstSeenAt', 'first_seen_at')) || undefined,
    lastSeenAt: number(pick(source, 'lastSeenAt', 'last_seen_at')) || undefined,
    messageTimestamp: pick(source, 'messageTimestamp', 'message_timestamp') == null ? null : number(pick(source, 'messageTimestamp', 'message_timestamp')),
    origins, kind: inferFileKind(mimeType, name),
    previewUrl: string(pick(source, 'previewUrl', 'preview_url'))
      || `/api/app/files/${encodeURIComponent(id)}/preview${profileQuery}`,
    downloadUrl: string(pick(source, 'downloadUrl', 'download_url'))
      || `/api/app/files/${encodeURIComponent(id)}/download${profileQuery}`,
  }
}
