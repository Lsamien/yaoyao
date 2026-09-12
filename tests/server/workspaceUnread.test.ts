// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import type { WorkspaceConversation, WorkspaceMessage, WorkspaceTask } from '../../src/shared/workspace'

let home: string, store: WorkspaceStore, direct: WorkspaceConversation, group: WorkspaceConversation
const owner = 'owner'
const current = (id: string) => store.require<WorkspaceConversation>(owner, 'conversation', id)
const task = (id: string) => store.require<WorkspaceTask>(owner, 'conversation-task', id)
function message(conversationId = direct.id, patch: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
  return { id: randomUUID(), conversationId, seq: 0, role: 'assistant', content: '完成', reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: 1, ...patch }
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-unread-'))
  store = new WorkspaceStore(home)
  const first = store.createAgent(owner, { name: '甲', profile: 'default' })
  const second = store.createAgent(owner, { name: '乙', profile: 'default' })
  direct = store.list<WorkspaceConversation>(owner, 'conversation').find(c => c.memberIds[0] === first.id)!
  group = store.createGroup(owner, { name: '测试群', memberIds: [first.id, second.id], administratorId: first.id })
})
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(home, { recursive: true, force: true }) })

it('stores one unread flag for any number of completed replies and persists read state', () => {
  for (let i = 0; i < 12; i++) store.saveMessage(owner, message())
  expect(current(direct.id)).toMatchObject({ unread: true, unreadCount: 1 })
  const display = vi.spyOn(store, 'messageForDisplay')
  expect(store.conversationSummary(owner, current(direct.id)).unread).toBe(true)
  store.markConversationRead(owner, direct.id, current(direct.id).lastSeq, current(direct.id).unreadVersion)
  expect(display).not.toHaveBeenCalled()
  expect(current(direct.id)).toMatchObject({ unread: false, unreadCount: 0 })
  store.close(); store = new WorkspaceStore(home)
  expect(current(direct.id).unread).toBe(false)
})

it('ignores user, streaming, hidden and empty tool output; completion at the same message sequence is new attention', () => {
  for (const patch of [{ role: 'user' as const }, { status: 'streaming' as const }, { visible: false }, { content: '', reasoning: '思考', tools: [{ name: 'read' }] }]) store.saveMessage(owner, message(direct.id, patch))
  const streamed = message(direct.id, { status: 'streaming' })
  store.saveMessage(owner, streamed)
  expect(current(direct.id).unread).toBe(false)
  const snapshot = current(direct.id)
  store.markConversationRead(owner, direct.id, snapshot.lastSeq, snapshot.unreadVersion)
  streamed.status = 'complete'; store.saveMessage(owner, streamed)
  expect(current(direct.id)).toMatchObject({ lastSeq: snapshot.lastSeq, unread: true })
  store.markConversationRead(owner, direct.id, snapshot.lastSeq, snapshot.unreadVersion)
  expect(current(direct.id).unread).toBe(true)
  store.markConversationRead(owner, direct.id, streamed.seq, current(direct.id).unreadVersion)
  store.saveMessage(owner, streamed)
  expect(current(direct.id).unread).toBe(false)
})

it('keeps group attention until every unread task is read, without parsing messages', () => {
  const first = store.tasks(owner, group.id)[0]!
  const second = store.createTask(owner, group.id, {})
  store.saveMessage(owner, message(group.id, { conversationTaskId: first.id }))
  store.saveMessage(owner, message(group.id, { conversationTaskId: second.id }))
  const display = vi.spyOn(store, 'messageForDisplay')
  store.markTaskRead(owner, group.id, first.id, task(first.id).lastSeq, task(first.id).unreadVersion)
  expect(task(first.id).unread).toBe(false)
  expect(current(group.id).unread).toBe(true)
  store.markTaskRead(owner, group.id, second.id, task(second.id).lastSeq, task(second.id).unreadVersion)
  expect(current(group.id).unread).toBe(false)
  expect(display).not.toHaveBeenCalled()
  expect(current(direct.id).unread).toBe(false)
})

it('does not let a stale task read clear another completion and recomputes flags after deletion', () => {
  const first = store.tasks(owner, group.id)[0]!
  store.saveMessage(owner, message(group.id, { conversationTaskId: first.id }))
  const snapshot = task(first.id)
  store.saveMessage(owner, message(group.id, { conversationTaskId: first.id, status: 'failed', error: '执行失败' }))
  store.markTaskRead(owner, group.id, first.id, snapshot.lastSeq, snapshot.unreadVersion)
  expect(task(first.id).unread).toBe(true)
  expect(() => store.markTaskRead('another-owner', group.id, first.id, 100, 1)).toThrow()
  expect(() => store.markTaskRead(owner, direct.id, first.id, 100, 1)).toThrow()
  store.deleteTask(owner, group.id, first.id)
  expect(current(group.id).unread).toBe(false)
})

it('migrates legacy counts once without loading message bodies and does not resurrect read flags', () => {
  const first = store.tasks(owner, group.id)[0]!
  store.saveMessage(owner, message())
  store.saveMessage(owner, message(group.id, { conversationTaskId: first.id }))
  store.db.exec("UPDATE workspace_entities SET data=json_remove(data,'$.unread','$.unreadVersion') WHERE kind IN ('conversation','conversation-task')")
  store.db.prepare('DELETE FROM workspace_migrations WHERE id=?').run('workspace-unread-flag-v1')
  store.close(); store = new WorkspaceStore(home)
  expect(current(direct.id)).toMatchObject({ unread: true, unreadVersion: 1, unreadCount: 1 })
  expect(current(group.id).unread).toBe(true)
  expect(task(first.id).unread).toBe(true)
  store.markConversationRead(owner, direct.id, current(direct.id).lastSeq, 1)
  store.close(); store = new WorkspaceStore(home)
  expect(current(direct.id).unread).toBe(false)
})

it('reads only hidden IDs while preserving owner and task boundaries', () => {
  const first = store.tasks(owner, group.id)[0]!, second = store.createTask(owner, group.id, {})
  const hidden = message(group.id, { conversationTaskId: first.id, visible: false })
  store.saveMessage(owner, hidden)
  store.saveMessage(owner, message(group.id, { conversationTaskId: second.id, visible: false }))
  store.saveMessage(owner, message(group.id, { conversationTaskId: first.id }))
  const display = vi.spyOn(store, 'messageForDisplay')
  expect(store.hiddenMessageIds(owner, group.id, first.id)).toEqual([hidden.id])
  expect(display).not.toHaveBeenCalled()
  expect(() => store.hiddenMessageIds('another-owner', group.id)).toThrow()
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM workspace_entities WHERE owner=? AND kind='message' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.visible')=0 AND json_extract(data,'$.conversationTaskId')=?").all(owner, group.id, first.id)
  expect(plan.some(row => String(row.detail).includes('workspace_message_hidden'))).toBe(true)
})
