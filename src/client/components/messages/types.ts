export type UiToolCall = {
  id: string
  name: string
  status: 'running' | 'success' | 'error' | 'pending' | 'interrupted'
  input?: unknown
  output?: unknown
  durationMs?: number
}

export type UiMessageAttachment = {
  id: string
  name: string
  kind?: 'image' | 'video' | 'audio' | 'file'
  url?: string
  size?: number
}

export type UiLocalFileLink = {
  name: string
  url: string
}

export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  author?: string
  isRemoteAgent?: boolean
  content: string
  reasoning?: string
  createdAt?: string | number | Date
  status?: 'preparing' | 'attached' | 'pending' | 'accepted' | 'streaming' | 'settled' | 'failed' | 'unknown-receipt'
  error?: string
  attachments?: UiMessageAttachment[]
  tools?: UiToolCall[]
  profile?: string
  timelineKind?: 'delegation-complete' | 'background-process' | 'system'
  timelineMetadata?: Record<string, unknown>
  metadata?: string
}

export type UiInteraction = {
  id: string
  kind: 'approval' | 'clarification'
  title?: string
  prompt: string
  options?: string[]
  detail?: string
}
