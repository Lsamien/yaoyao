import { describe, expect, it } from 'vitest'
import { foldDetail, WorkspaceTranscriptStore, type WorkspaceDetail } from '@/components/workspace/transcriptStore'
import type { WorkspaceConversation, WorkspaceEvent, WorkspaceMessage } from '@shared/workspace'

const conversation: WorkspaceConversation = { id: 'c', kind: 'direct', name: 'Bot', avatar: '', memberIds: ['a'], instructions: '', administratorId: 'a', mode: 'host', autoReplyIds: [], maxReplyRounds: 3, archived: false, pinned: false, readSeq: 0, lastSeq: 3, preview: '', createdAt: 1, updatedAt: 1 }
const message = (id: string, seq: number, content = id): WorkspaceMessage => ({ id, seq, conversationId: 'c', role: 'assistant', content, reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: seq })
const detail = (): WorkspaceDetail => ({ conversation, messages: [message('old', 1), message('live', 2)], cursor: 10, hasOlder: true, run: null, interactions: [], context: null })
const event = (seq: number, value: WorkspaceMessage): WorkspaceEvent => ({ seq, type: 'message.changed', conversationId: value.conversationId, data: value })

describe('Bot transcript cache', () => {
  it('keeps independent clients ordered after snapshots, pin changes and new activity', () => {
    const rows: WorkspaceConversation[] = [
      { ...conversation, id: 'tie-b', lastMessageAt: 200 },
      { ...conversation, id: 'zero', lastMessageAt: 0, createdAt: 5000 },
      { ...conversation, id: 'old', lastMessageAt: 100, updatedAt: 99999 },
      { ...conversation, id: 'pin', pinned: true, lastMessageAt: 50 },
      { ...conversation, id: 'new', lastMessageAt: 400 },
      { ...conversation, id: 'tie-a', lastMessageAt: 200 },
      { ...conversation, id: 'fallback', lastMessageAt: undefined, createdAt: 300 },
    ]
    const before = rows.map(c => c.id)
    const clients = [new WorkspaceTranscriptStore(), new WorkspaceTranscriptStore()]
    clients[0]!.hydrate({ agents: [], conversations: rows, details: [], cursor: 0 })
    clients[1]!.hydrate({ agents: [], conversations: [...rows].reverse(), details: [], cursor: 0 })
    const ordered = (expected: string[]) => clients.forEach(client => expect(client.conversations.map(c => c.id)).toEqual(expected))
    ordered(['pin', 'new', 'fallback', 'tie-a', 'tie-b', 'old', 'zero'])
    expect(rows.map(c => c.id)).toEqual(before)
    const change = (seq: number, id: string, patch: Partial<WorkspaceConversation>) => clients.forEach(client => {
      const current = client.conversations.find(c => c.id === id) ?? { ...conversation, id }
      client.apply({ seq, type: 'conversation.changed', conversationId: id, data: { ...current, ...patch } })
    })
    change(1, 'old', { lastMessageAt: 500 })
    ordered(['pin', 'old', 'new', 'fallback', 'tie-a', 'tie-b', 'zero'])
    change(2, 'tie-b', { pinned: true })
    ordered(['tie-b', 'pin', 'old', 'new', 'fallback', 'tie-a', 'zero'])
    change(3, 'pin', { pinned: false })
    change(4, 'new-2', { lastMessageAt: 400 })
    ordered(['tie-b', 'old', 'new', 'new-2', 'fallback', 'tie-a', 'pin', 'zero'])
    change(3, 'pin', { pinned: true })
    ordered(['tie-b', 'old', 'new', 'new-2', 'fallback', 'tie-a', 'pin', 'zero'])
    clients[0]!.conversations = [...clients[1]!.conversations].reverse()
    ordered(['tie-b', 'old', 'new', 'new-2', 'fallback', 'tie-a', 'pin', 'zero'])
  })

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

it('merges send receipts without advancing replay or regressing newer events', () => {
  const store = new WorkspaceTranscriptStore()
  store.hydrate({ agents: [], conversations: [conversation], details: [detail()], cursor: 10 })
  const run = { id: 'r', conversationId: 'c', messageId: 'sent', status: 'queued' as const, mentionIds: [], round: 0, createdAt: 1, updatedAt: 1 }
  const receipt = { run, message: message('sent', 3, 'accepted'), conversation, cursor: 15 }
  const pending = store.beginRead()
  store.acceptReceipt(receipt)
  expect(store.cursor).toBe(10)
  store.apply(event(12, message('sent', 3, 'stale')))
  expect(store.get('c')!.messages.at(-1)!.content).toBe('accepted')
  store.apply(event(16, message('sent', 3, 'newer')))
  store.acceptReceipt(receipt)
  expect(store.get('c')!.messages.at(-1)!.content).toBe('newer')
  expect(store.get('c')!.messages.filter(m => m.id === 'sent')).toHaveLength(1)
  expect(store.finishRead(pending, detail()).messages.at(-1)!.content).toBe('newer')
  expect(store.cursor).toBe(16)
})

it('normalizes revision patches before replay and detects a gap without advancing the cursor', () => {
  const store = new WorkspaceTranscriptStore()
  store.hydrate({ agents: [], conversations: [conversation], details: [{ ...detail(), messages: [{ ...message('live', 2, '初始'), status: 'streaming', revision: 1 }] }], cursor: 10 })
  const patch = (seq: number, baseRevision: number, text: string): WorkspaceEvent => ({ seq, type: 'message.patch', conversationId: 'c',
    data: { id: 'live', conversationId: 'c', baseRevision, revision: baseRevision + 1, contentAppend: text, reasoningAppend: '思考' } })
  store.apply(patch(11, 1, '🙂'))
  store.apply(patch(11, 1, '🙂'))
  expect(store.get('c')!.messages[0]!.content).toBe('初始🙂')
  expect(() => store.apply(patch(12, 3, '丢失基线'))).toThrow()
  expect(store.cursor).toBe(11)
  store.apply(patch(12, 2, 'e\u0301'))
  expect(store.get('c')!.messages[0]!.content).toBe('初始🙂e\u0301')
})

it('preserves paged history across hydrate, removes hidden rows and rejects older reads', () => {
  const store = new WorkspaceTranscriptStore()
  store.hydrate({ agents: [], conversations: [conversation], details: [detail()], cursor: 10 })
  const read = store.beginRead()
  const updated = { ...detail(), conversation: { ...conversation, name: '新版' },
    messages: [{ ...message('live', 2, '新内容'), revision: 2 }], hiddenMessageIds: ['old'], cursor: 20 }
  store.hydrate({ agents: [], conversations: [updated.conversation], details: [updated], cursor: 20 })
  const merged = store.finishRead(read, { ...detail(), cursor: 11 })
  expect(merged.conversation.name).toBe('新版')
  expect(merged.messages.map(m => m.content)).toEqual(['新内容'])
})

it('does not resurrect a previous account through pending reads on logout', () => {
  const store = new WorkspaceTranscriptStore()
  store.hydrate({ agents: [], conversations: [conversation], details: [detail()], cursor: 10 })
  store.beginRead(); store.apply(event(11, message('private', 3)))
  store.hydrate({ agents: [], conversations: [], details: [], cursor: 0 })
  expect(store.conversations).toEqual([]); expect(store.details.size).toBe(0)
})
