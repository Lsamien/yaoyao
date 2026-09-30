export type UnreadMode = 'bot' | 'chat'
export interface UnreadMessage { id: string; seq: number; version?: number; taskId?: string }
export interface UnreadConversation {
  mode: UnreadMode; id: string; profile?: string; name: string; preview: string;
  count: number; updatedAt: number; messages: UnreadMessage[];
}
export interface UnreadSnapshot { total: number; bot: number; chat: number; conversations: UnreadConversation[] }
export const emptyUnread = (): UnreadSnapshot => ({ total: 0, bot: 0, chat: 0, conversations: [] })
/** Tool traces may accompany a final answer; standalone process/system records never qualify. */
export function isWorkspaceChatReply(m: { role: string; status: string; visible?: boolean; error?: string; content: string; attachments?: unknown[] }): boolean {
  return m.role === 'assistant' && m.status === 'complete' && m.visible !== false && !m.error
    && (!!m.content.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '').trim() || !!m.attachments?.length)
}
