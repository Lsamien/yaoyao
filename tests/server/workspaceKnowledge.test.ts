// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceKnowledge } from '../../src/server/workspaceKnowledge'
import type { WorkspaceAgent, WorkspaceMessage } from '../../src/shared/workspace'

let home: string, store: WorkspaceStore, knowledge: WorkspaceKnowledge, a: WorkspaceAgent, b: WorkspaceAgent
const owner = 'memory-owner'
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-file-memory-'))
  store = new WorkspaceStore(home); knowledge = new WorkspaceKnowledge(home, store)
  a = store.createAgent(owner, { name: '甲', profile: 'same-profile', canManageTeam: true })
  b = store.createAgent(owner, { name: '乙', profile: 'same-profile' })
})
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }) })
function source(content: string) {
  const conversation = store.list<any>(owner, 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === a.id)
  const message: WorkspaceMessage = { id: randomUUID(), conversationId: conversation.id, seq: 0, role: 'user', content, reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: Date.now() }
  store.saveMessage(owner, message)
  return { messageId: message.id, conversationId: message.conversationId, quote: content }
}
describe('Bot file memory', () => {
  it('preserves different shared contributions instead of overwriting the same topic', () => {
    for (const [agent, content] of [[a, '接口使用版本一'], [b, '接口使用版本二']] as const) knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'user', agentId: agent.id, topic: '接口版本', content, tier: 'profile' })
    const memories = knowledge.memories(owner, { scope: 'user' })
    expect(memories).toHaveLength(2)
    expect(memories.every(m => m.conflict)).toBe(true)
    expect(new Set(memories.map(m => m.agentId)).size).toBe(2)
  })
  it('isolates bots sharing one Profile and merges only shared user contributions', () => {
    const fact = source('以后请使用中文回答')
    knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '甲自己的经验', tier: 'profile' })
    knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'user', agentId: a.id, content: '用户偏好中文', tier: 'profile', sources: [fact] }, { agentId: a.id })
    expect(knowledge.context(owner, a.id).text).toContain('甲自己的经验')
    expect(knowledge.context(owner, b.id).text).not.toContain('甲自己的经验')
    expect(knowledge.context(owner, b.id).text).toContain('用户偏好中文')
    expect(() => knowledge.memories(owner, { scope: 'agent', agentId: a.id }, { agentId: b.id })).toThrowError(expect.objectContaining({ code: 'memory_forbidden' }))
    expect(() => knowledge.memories('other-owner', { scope: 'agent', agentId: a.id })).not.toThrow()
    expect(knowledge.memories('other-owner', { scope: 'agent', agentId: a.id })).toEqual([])
    const body = readFileSync(join(home, 'bot-workspace', owner, 'agents', a.id, 'memory', 'profile.md'), 'utf8')
    expect(body).toMatch(/- \(\d{4}-\d{2}-\d{2}\) 甲自己的经验/)
  })
  it('keeps files authoritative and rebuilds project membership and group projections', () => {
    const group = store.createGroup(owner, { name: '群', memberIds: [a.id, b.id], collaborationMode: 'discussion' })
    const requestId = randomUUID(), input = { requestId, name: '项目一', description: '共同工作', memberIds: [a.id, b.id], groupIds: [group.id] }
    const project = knowledge.saveProject(owner, input)
    expect(knowledge.saveProject(owner, input)).toEqual(project)
    store.remove(owner, 'project', project.id)
    const c = store.require<any>(owner, 'conversation', group.id); delete c.projectId; store.put(owner, 'conversation', c.id, c)
    knowledge = new WorkspaceKnowledge(home, store)
    expect(store.require<any>(owner, 'project', project.id).memberIds).toEqual([a.id, b.id].sort())
    expect(store.require<any>(owner, 'conversation', group.id).projectId).toBe(project.id)
    const fact = source('本项目使用版本化接口')
    knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'project', projectId: project.id, agentId: a.id, content: '接口需要版本号', tier: 'profile', sources: [fact] }, { agentId: a.id })
    expect(knowledge.context(owner, b.id, project.id).text).toContain('接口需要版本号')
    expect(knowledge.context(owner, b.id).text).not.toContain('接口需要版本号')
    knowledge.saveProject(owner, { ...input, requestId: randomUUID(), id: project.id, expectedRevision: project.revision, memberIds: [a.id], groupIds: [] })
    expect(() => knowledge.context(owner, b.id, project.id)).toThrowError(expect.objectContaining({ code: 'project_forbidden' }))
  })
  it('rejects stale revisions, cross-contributor writes and overwrite of user-maintained facts', () => {
    const fact = source('以后请精简回复')
    const input = { requestId: randomUUID(), scope: 'user' as const, agentId: a.id, content: '用户喜欢简洁', tier: 'profile' as const, sources: [fact] }
    const initial = knowledge.writeMemory(owner, input, { agentId: a.id })
    expect(() => knowledge.writeMemory(owner, { ...input, requestId: randomUUID() }, { agentId: b.id })).toThrowError(expect.objectContaining({ code: 'memory_forbidden' }))
    const edited = knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: initial.id, expectedRevision: 1, content: '回复简洁但保留依据' })
    expect(edited.revision).toBe(2)
    expect(() => knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: initial.id, expectedRevision: 1 })).toThrowError(expect.objectContaining({ code: 'memory_revision_conflict' }))
    expect(() => knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: initial.id, expectedRevision: 2 }, { agentId: a.id })).toThrowError(expect.objectContaining({ code: 'memory_manual_protected' }))
    expect(knowledge.revisions(owner, input, initial.id)).toHaveLength(2)
  })
  it('keeps tombstones across restart and prevents old synthesis from resurrecting forgotten facts', () => {
    const input = { requestId: randomUUID(), scope: 'agent' as const, agentId: a.id, content: '旧偏好', tier: 'profile' as const }
    const memory = knowledge.writeMemory(owner, input)
    knowledge.forget(owner, { ...input, requestId: randomUUID(), id: memory.id, expectedRevision: memory.revision })
    knowledge = new WorkspaceKnowledge(home, store)
    expect(() => knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), automatic: true, sources: [source('旧偏好')] }, { agentId: a.id })).toThrowError(expect.objectContaining({ code: 'memory_forgotten' }))
    expect(knowledge.memories(owner, input)).toEqual([])
    expect(knowledge.revisions(owner, input, memory.id)[0]?.operation).toBe('forget')
  })
  it('recovers a partially written multi-file transaction and does not duplicate its receipt or event', () => {
    const input = { requestId: randomUUID(), scope: 'agent' as const, agentId: a.id, content: '需要恢复的事实', tier: 'profile' as const }
    knowledge.fault = path => { if (path.endsWith('profile.md')) throw new Error('simulated power loss') }
    expect(() => knowledge.writeMemory(owner, input)).toThrow('simulated power loss')
    knowledge = new WorkspaceKnowledge(home, store)
    const restored = knowledge.memories(owner, input)
    expect(restored).toHaveLength(1)
    expect(knowledge.writeMemory(owner, input)).toEqual(restored[0])
    expect(store.events(owner, 0).filter(e => e.type === 'memory.changed')).toHaveLength(1)
    expect(knowledge.revisions(owner, input, restored[0]!.id)).toHaveLength(1)
  })
  it('reports corrupted metadata without silently replacing it and rejects unsafe paths', () => {
    const input = { requestId: randomUUID(), scope: 'agent' as const, agentId: a.id, content: '保留事实', tier: 'log' as const }
    knowledge.writeMemory(owner, input)
    const path = join(home, 'bot-workspace', owner, 'agents', a.id, 'memory', '.dreaming', 'records.json')
    writeFileSync(path, '{broken')
    expect(() => knowledge.memories(owner, input)).toThrowError(expect.objectContaining({ code: 'knowledge_file_corrupt' }))
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    expect(() => knowledge.memories(owner, { scope: 'project', projectId: '../other' })).toThrowError(expect.objectContaining({ code: 'knowledge_invalid_id' }))
  })
})
