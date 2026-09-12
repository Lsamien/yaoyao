import { describe, expect, it } from 'vitest'
import { foldDetail, WorkspaceTranscriptStore, type WorkspaceDetail } from '@/components/workspace/transcriptStore'
import type { WorkspaceConversation, WorkspaceEvent, WorkspaceMessage } from '@shared/workspace'

const conversation: WorkspaceConversation = { id: 'c', kind: 'direct', name: 'Bot', avatar: '', memberIds: ['a'], instructions: '', administratorId: 'a', mode: 'host', autoReplyIds: [], maxReplyRounds: 3, archived: false, pinned: false, readSeq: 0, lastSeq: 3, preview: '', createdAt: 1, updatedAt: 1 }
const message = (id: string, seq: number, content = id): WorkspaceMessage => ({ id, seq, conversationId: 'c', role: 'assistant', content, reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: seq })
const detail = (): WorkspaceDetail => ({ conversation, messages: [message('old', 1), message('live', 2)], cursor: 10, hasOlder: true, run: null, interactions: [], context: null })
const event = (seq: number, value: WorkspaceMessage): WorkspaceEvent => ({ seq, type: 'message.changed', conversationId: value.conversationId, data: value })

describe('Bot transcript cache', () => {
  it('returns a warm transcript without losing its older pages and preserves settled identities on a live update', () => {
    const store = new WorkspaceTranscriptStore(), initial = detail()
    store.hydrate({ agents: [], conversations: [conversation], details: [initial], cursor: 10 })
    expect(store.get('c')).toBe(initial)
    store.apply(event(11, { ...message('live', 2, '正在生成'), status: 'streaming' }))
    expect(store.get('c')!.messages[0]).toBe(initial.messages[0])
    expect(store.get('c')!.messages[1]!.content).toBe('正在生成')
    expect(store.get('c')!.hasOlder).toBe(true)
  })
  it('replays events received during a cold detail request instead of rolling back new text', () => {
    const store = new WorkspaceTranscriptStore(), token = store.beginRead()
    store.apply(event(12, message('live', 2, '更新后的内容')))
    const current = store.finishRead(token, detail())
    expect(current.messages.at(-1)!.content).toBe('更新后的内容')
  })
  it('does not apply pre-snapshot replay over a newer snapshot', () => {
    const store = new WorkspaceTranscriptStore(), token = store.beginRead()
    store.apply(event(9, message('live', 2, '旧事件')))
    expect(store.finishRead(token, detail()).messages.at(-1)!.content).toBe('live')
  })
  it('removes hidden messages, ignores duplicate events, and evicts deleted conversations', () => {
    const store = new WorkspaceTranscriptStore()
    store.hydrate({ agents: [], conversations: [conversation], details: [detail()], cursor: 10 })
    store.apply(event(11, { ...message('live', 2), visible: false }))
    store.apply(event(11, message('live', 2)))
    expect(store.get('c')!.messages.map(m => m.id)).toEqual(['old'])
    store.apply({ seq: 12, type: 'conversation.deleted', conversationId: 'c', data: { id: 'c' } })
    expect(store.get('c')).toBeUndefined()
    expect(store.conversations).toEqual([])
  })
  it('does not resurrect a conversation deleted while its detail request was in flight', () => {
    const store = new WorkspaceTranscriptStore(), token = store.beginRead()
    store.apply({ seq: 12, type: 'conversation.deleted', conversationId: 'c', data: { id: 'c' } })
    expect(() => store.finishRead(token, detail())).toThrow('已被删除')
    expect(store.get('c')).toBeUndefined()
  })
  it('keeps background tasks separate and settles approval cards directly from events', () => {
    const initial = detail()
    expect(foldDetail(initial, event(11, { ...message('other', 3), conversationTaskId: 'other' }))).toBe(initial)
    const pending = foldDetail(initial, { seq: 12, conversationId: 'c', type: 'interaction.changed', data: { id: 'approval', kind: 'approval', choices: [], message: '允许？' } })
    expect(pending.interactions).toHaveLength(1)
    expect(foldDetail(pending, { seq: 13, conversationId: 'c', type: 'interaction.changed', data: { id: 'approval', resolved: true } }).interactions).toHaveLength(0)
  })
})
