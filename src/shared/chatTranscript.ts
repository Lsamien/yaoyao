/** Ordinary-chat display protocol. Upstream identities remain server metadata. */
export const CHAT_TRANSCRIPT_FEATURE = 'ordinary-chat-transcript-v2'
export interface TranscriptMessage {
  id: string
  seq: number
  revision: number
  source_message_id: string
  client_message_id?: string
  turn_id?: string
  segment_kind?: 'input' | 'commentary' | 'answer' | 'tool' | 'system'
  role: string
  content: unknown
  reasoning?: string
  status?: string
  [key: string]: unknown
}
export interface TranscriptPatch {
  id: string
  seq: number
  baseRevision: number
  revision: number
  contentAppend: string
  reasoningAppend: string
}
export interface TranscriptEvent {
  cursor: number
  profile: string
  sessionId: string
  epoch?: string
  previousCursor?: number
  total?: number
  type:
    | 'message.upsert'
    | 'message.patch'
    | 'message.deleted'
    | 'session.changed'
    | 'session.deleted'
    | 'session.migrated'
  data: unknown
}
export interface TranscriptSnapshot {
  protocol: typeof CHAT_TRANSCRIPT_FEATURE
  epoch: string
  cursor: number
  profile: string
  sessionId: string
  messages: TranscriptMessage[]
  session: Record<string, unknown>
  hasOlder: boolean
  total: number
  state: string
  deletedIds?: string[]
  running?: boolean
  queued?: boolean
  pendingApproval?: Record<string, unknown> | null
  pendingClarification?: Record<string, unknown> | null
  liveStatus?: string | null
  error?: string | null
}
export class TranscriptGap extends Error {
  constructor() {
    super('普通聊天消息版本不连续，需要重新同步')
  }
}
export function applyTranscriptEvent(
  messages: TranscriptMessage[],
  event: TranscriptEvent,
): TranscriptMessage[] {
  const data = event.data as TranscriptMessage & TranscriptPatch
  const index = messages.findIndex((message) => message.id === data.id)
  const old = messages[index]
  if (event.type === 'message.deleted') {
    if (!Number.isSafeInteger(data.revision) || data.revision < 1) throw new TranscriptGap()
    return old && old.revision >= data.revision
      ? messages
      : messages.filter((message) => message.id !== data.id)
  }
  if (event.type === 'message.upsert') {
    if (
      !data.id ||
      !Number.isSafeInteger(data.seq) ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 1
    )
      throw new TranscriptGap()
    if (old && old.revision >= data.revision) return messages
    return [...messages.filter((message) => message.id !== data.id), data].sort(
      (a, b) => a.seq - b.seq || a.id.localeCompare(b.id),
    )
  }
  if (event.type === 'message.patch') {
    if (old && old.revision >= data.revision) return messages
    if (
      !old ||
      old.revision !== data.baseRevision ||
      data.revision !== data.baseRevision + 1 ||
      old.seq !== data.seq ||
      typeof old.content !== 'string' ||
      typeof data.contentAppend !== 'string' ||
      typeof data.reasoningAppend !== 'string'
    )
      throw new TranscriptGap()
    const next = [...messages]
    next[index] = {
      ...old,
      revision: data.revision,
      content: old.content + data.contentAppend,
      reasoning: String(old.reasoning ?? '') + data.reasoningAppend,
    }
    return next
  }
  return messages
}
