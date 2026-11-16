// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { unreadSnapshot, acknowledgeUnread } from '../../src/server/unreadCenter'

const homes: string[] = []; const stores: Array<{ close(): void }> = []
afterEach(() => { stores.reverse().forEach(s => s.close()); stores.length = 0; homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })) })

it('shares exact Bot snapshots between devices, isolates owners and Profiles, and acknowledges only seen messages', () => {
  const home = mkdtempSync(join(tmpdir(), 'unread-integration-')); homes.push(home)
  const workspace = new WorkspaceStore(home); stores.push(workspace)
  const a = workspace.createAgent('a', { name: 'bot', profile: 'p' }), b = workspace.createAgent('a', { name: 'two', profile: 'p' })
  const c = workspace.createGroup('a', { name: 'group', memberIds: [a.id, b.id], administratorId: a.id }), task = workspace.tasks('a', c.id)[0]!
  workspace.saveMessage('a', { id: 'bot-final', conversationId: c.id, conversationTaskId: task.id, seq: 0, role: 'assistant', status: 'complete', content: '附件答复', reasoning: '', attachments: [], tools: [], createdAt: 1 })
  const device1 = unreadSnapshot(workspace, 'a'), device2 = unreadSnapshot(workspace, 'a')
  // Ordinary chat is retired: `chat` stays 0 for older clients.
  expect(device1).toMatchObject({ total: 1, bot: 1, chat: 0 }); expect(device2).toEqual(device1)
  expect(unreadSnapshot(workspace, 'b').total).toBe(0)
  expect(unreadSnapshot(workspace, 'a', (_, profile) => profile !== 'p').total).toBe(0)
  workspace.saveMessage('a', { id: 'bot-later', conversationId: c.id, conversationTaskId: task.id, seq: 0, role: 'assistant', status: 'complete', content: '随后新消息', reasoning: '', attachments: [], tools: [], createdAt: 2 })
  acknowledgeUnread(workspace, 'a', device1.conversations)
  acknowledgeUnread(workspace, 'a', [{ mode: 'chat', id: 'retired', profile: 'p', messages: [{ id: 'x', seq: 1 }] }])
  expect(unreadSnapshot(workspace, 'a')).toMatchObject({ total: 1, bot: 1, chat: 0 })
})
