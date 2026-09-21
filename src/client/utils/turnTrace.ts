import type { UiMessage, UiToolCall } from '@/components/messages/types'
import { collapseDuplicateFailures } from './messageFailure'

export type TurnTraceEntry =
  | { id: string; type: 'reasoning'; messageId: string; content: string }
  | { id: string; type: 'tool'; messageId: string; tool: UiToolCall }

export type TurnTraceGroup = {
  id: string
  kind: 'trace'
  entries: TurnTraceEntry[]
  status: 'running' | 'success' | 'error'
}

export type MessageTimelineRow =
  | { id: string; kind: 'message'; message: UiMessage }
  | TurnTraceGroup

function assistantOwner(message: UiMessage): string {
  return `${message.profile || ''}\u0000${message.author || ''}`
}

function hasVisibleMessage(message: UiMessage): boolean {
  return Boolean(message.content.trim() || message.attachments?.length || message.error || message.status === 'failed')
}

function traceStatus(messages: UiMessage[], entries: TurnTraceEntry[]): TurnTraceGroup['status'] {
  if (messages.some(message => message.status === 'failed')
    || entries.some(entry => entry.type === 'tool' && entry.tool.status === 'error')) return 'error'
  if (messages.some(message => message.status === 'streaming')
    || entries.some(entry => entry.type === 'tool' && ['running', 'pending'].includes(entry.tool.status))) return 'running'
  return 'success'
}

function appendAssistantSegment(rows: MessageTimelineRow[], segment: UiMessage[], bodies?: WeakMap<UiMessage, UiMessage>): void {
  if (!segment.length) return
  const entries: TurnTraceEntry[] = []
  for (const message of segment) {
    if (message.reasoning?.trim()) {
      entries.push({ id: `reasoning:${message.id}`, type: 'reasoning', messageId: message.id, content: message.reasoning })
    }
    for (const tool of message.tools ?? []) {
      entries.push({ id: `tool:${message.id}:${tool.id}`, type: 'tool', messageId: message.id, tool })
    }
  }
  if (entries.length) {
    rows.push({ id: `trace:${segment[0]!.id}`, kind: 'trace', entries, status: traceStatus(segment, entries) })
  }
  for (const message of segment) {
    if (!hasVisibleMessage(message)) continue
    let body = bodies?.get(message)
    if (!body) {
      body = { ...message, reasoning: undefined, tools: undefined }
      bodies?.set(message, body)
    }
    rows.push({ id: `message:${message.id}`, kind: 'message', message: body })
  }
}

/** Groups contiguous assistant reasoning/tools by turn while preserving visible messages. */
export function buildMessageTimelineRows(messages: UiMessage[], bodies?: WeakMap<UiMessage, UiMessage>): MessageTimelineRow[] {
  const rows: MessageTimelineRow[] = []
  let segment: UiMessage[] = []
  let owner = ''
  const flush = () => { appendAssistantSegment(rows, segment, bodies); segment = []; owner = '' }
  for (const message of collapseDuplicateFailures(messages)) {
    if (message.role === 'assistant' && !message.timelineKind) {
      const nextOwner = assistantOwner(message)
      if (segment.length && nextOwner !== owner) flush()
      owner = nextOwner
      segment.push(message)
      // An interim/final assistant bubble is a real timeline boundary. Keep
      // later running tools and text below it instead of hoisting their trace
      // above the earlier visible message merely because the author matches.
      if (hasVisibleMessage(message)) flush()
      continue
    }
    flush()
    rows.push({ id: `message:${message.id}`, kind: 'message', message })
  }
  flush()
  return rows
}
