import type { ChatMessage } from '@shared/types'
import { mergeChatMessages } from './messageReducer'

const projectedID = /^(?:stream:|resume:|event:|history-)/

/** Replace completed live projections only inside an identified history turn. */
export function reconcileChatHistory(existing: ChatMessage[], history: ChatMessage[], running: boolean): ChatMessage[] {
  const aliases = new Map<string, string>()
  for (const message of history) if (message.role === 'user') {
    aliases.set(message.id, message.id)
    if (message.clientMessageId) aliases.set(message.clientMessageId, message.id)
  }
  const userKey = (message: ChatMessage) => aliases.get(message.clientMessageId || '') ?? aliases.get(message.id) ?? message.id
  // A queued user message can appear after the currently executing assistant.
  // Protect the owner of that live segment, rather than the newest queue entry.
  let liveIndex = -1
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    if (existing[index]!.role === 'assistant' && existing[index]!.isStreaming) { liveIndex = index; break }
  }
  const activeUser = [...existing.slice(0, liveIndex < 0 ? undefined : liveIndex)].reverse().find(message => message.role === 'user')
  const active = running && activeUser ? userKey(activeUser) : ''
  const canonical = new Map(history.filter(message => message.serverMessageId && !projectedID.test(message.id)).map(message => [message.id, message]))
  const completedTurns = new Set<string>()
  let turn = ''
  for (const message of history) {
    if (message.role === 'user') turn = userKey(message)
    if (turn && (!running || active) && turn !== active && canonical.has(message.id) && message.role === 'assistant'
      && !message.isStreaming && message.content.trim() && !message.toolCalls?.length) completedTurns.add(turn)
  }
  turn = ''
  const retained = existing.flatMap(message => {
    if (message.role === 'user') turn = userKey(message)
    if (message.role !== 'assistant') return [message]
    const persisted = canonical.get(message.id)
    if (persisted && (!message.isStreaming || completedTurns.has(turn))) return [persisted]
    if (completedTurns.has(turn) && projectedID.test(message.id)) return []
    return [message]
  })
  return mergeChatMessages(retained, history, 'snapshot')
}
