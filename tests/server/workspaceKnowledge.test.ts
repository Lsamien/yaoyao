// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { MEMORY_CONTEXT_MAX_CHARS, WorkspaceKnowledge } from '../../src/server/workspaceKnowledge'
import { acknowledgeMemory, memoryResetReason, memoryDelta, emptyMemoryContext } from '../../src/server/workspaceMemoryContext'
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
  it('retains case-insensitive keyword filtering for local files', async () => {
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: 'API uses JSON', tier: 'profile' })
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '用户偏爱低糖饮食', tier: 'profile' })
    expect((await knowledge.memories(owner, { scope: 'agent', agentId: a.id, search: 'json' })).map(memory => memory.content)).toEqual(['API uses JSON'])
    expect(await knowledge.memories(owner, { scope: 'agent', agentId: a.id, search: '饮食习惯' })).toEqual([])
  })
  it('does not change the injected version for unselected notes or source metadata', async () => {
    const input = { scope: 'agent' as const, agentId: a.id, content: '稳定事实', tier: 'profile' as const }
    const fact = await knowledge.writeMemory(owner, { ...input, requestId: randomUUID() })
    const before = await knowledge.context(owner, a.id), state = acknowledgeMemory(before)
    await knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: fact.id, expectedRevision: fact.revision, topic: '仅更新主题' })
    await knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), content: '未注入的短暂信息', tier: 'note' })
    const after = await knowledge.context(owner, a.id)
    expect(after.version).toBe(before.version)
    expect(memoryDelta(after, state)).toBe('')
    expect(memoryResetReason(after, state)).toBeUndefined()
    expect(memoryResetReason(await knowledge.context(owner, b.id), state)).toBe('memory_scope_changed')
    expect(memoryResetReason(emptyMemoryContext('unsupported'), state)).toBe('memory_scope_changed')
    expect(memoryResetReason(after, undefined, 'old-version')).toBe('memory_baseline_missing')
  })
  it('keeps reuse safe when bounded context evicts old facts, including later deletion of an evicted fact', async () => {
    const input = { scope: 'agent' as const, agentId: a.id, tier: 'profile' as const }
    const old = await knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), content: '原先注入的事实'.padEnd(2000, '旧') })
    const state = acknowledgeMemory(await knowledge.context(owner, a.id))
    for (let index = 0; index < 8; index++) await knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), content: `新增事实-${index}`.padEnd(2000, '新') })
    const current = await knowledge.context(owner, a.id)
    expect(current.text).not.toContain('原先注入的事实')
    expect(memoryResetReason(current, state)).toBeUndefined()
    expect(memoryDelta(current, state)).toContain('新增事实')
    const next = acknowledgeMemory(current, state)
    await knowledge.forget(owner, { ...input, requestId: randomUUID(), id: old.id, expectedRevision: old.revision })
    expect(memoryResetReason(await knowledge.context(owner, a.id), next)).toBe('memory_changed_or_removed')
  })
  it('bounds all three scopes together without truncating or deleting long profile facts', async () => {
    const project = knowledge.saveProject(owner, { requestId: randomUUID(), name: '长记忆项目', description: '', memberIds: [a.id], groupIds: [] })
    const all = []
    for (const scope of ['agent', 'project', 'user'] as const) {
      for (let index = 0; index < 6; index++) {
        const content = `${scope}-${index}:`.padEnd(2000, '甲')
        all.push(await knowledge.writeMemory(owner, { requestId: randomUUID(), scope, agentId: a.id, projectId: scope === 'project' ? project.id : undefined, content, tier: 'profile' }))
      }
    }
    const context = await knowledge.context(owner, a.id, project.id)
    expect(context.text.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS)
    for (const label of ['此 Bot 的记忆', '当前项目记忆', '用户共享记忆']) expect(context.text).toContain(label)
    const selected = context.text.split('\n').filter(line => line.startsWith('- '))
    expect(selected.length).toBeGreaterThanOrEqual(3)
    expect(selected.every(line => all.some(memory => line === `- ${memory.content}（profile；来源 Bot ${memory.agentId}；记忆 ID ${memory.id}）`))).toBe(true)
    const omitted = all.find(memory => !context.text.includes(memory.id))!
    expect(omitted).toBeDefined()
    const found = await knowledge.memories(owner, { scope: omitted.scope, agentId: a.id, projectId: omitted.projectId, search: omitted.content })
    expect(found.map(memory => memory.id)).toContain(omitted.id)
    expect((await knowledge.context(owner, a.id, project.id)).version).toBe(context.version)
  })
  it('prioritizes shared profile facts before recent private logs', async () => {
    for (let index = 0; index < 12; index++) await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: `${index}:`.padEnd(2000, '历史'), tier: 'log' })
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'user', agentId: b.id, content: '用户长期使用中文', tier: 'profile' })
    const context = await knowledge.context(owner, a.id)
    expect(context.text).toContain('用户长期使用中文')
    expect(context.text.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS)
  })
  it('preserves different shared contributions instead of overwriting the same topic', async () => {
    for (const [agent, content] of [[a, '接口使用版本一'], [b, '接口使用版本二']] as const) await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'user', agentId: agent.id, topic: '接口版本', content, tier: 'profile' })
    const memories = await knowledge.memories(owner, { scope: 'user' })
    expect(memories).toHaveLength(2)
    expect(memories.every(m => m.conflict)).toBe(true)
    expect(new Set(memories.map(m => m.agentId)).size).toBe(2)
  })
  it('keeps profile and log in the standing prompt and leaves notes out', async () => {
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '基础职责', tier: 'profile' })
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '昨天做过的事', tier: 'log' })
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '马上会过期', tier: 'note' })
    const text = (await knowledge.context(owner, a.id)).text
    expect(text).toContain('基础职责')
    expect(text).toContain('昨天做过的事')
    expect(text).not.toContain('马上会过期')
  })
  it('isolates bots sharing one Profile and merges only shared user contributions', async () => {
    const fact = source('以后请使用中文回答')
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '甲自己的经验', tier: 'profile' })
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'user', agentId: a.id, content: '用户偏好中文', tier: 'profile', sources: [fact] }, { agentId: a.id })
    expect((await knowledge.context(owner, a.id)).text).toContain('甲自己的经验')
    expect((await knowledge.context(owner, b.id)).text).not.toContain('甲自己的经验')
    expect((await knowledge.context(owner, b.id)).text).toContain('用户偏好中文')
    expect((await knowledge.context(owner, a.id)).text).toContain('以自己的记忆为准')
    await expect(knowledge.memories(owner, { scope: 'agent', agentId: a.id }, { agentId: b.id })).rejects.toThrowError(expect.objectContaining({ code: 'memory_forbidden' }))
    await expect(knowledge.memories('other-owner', { scope: 'agent', agentId: a.id })).resolves.toEqual([])
    const body = readFileSync(join(home, 'bot-workspace', owner, 'agents', a.id, 'memory', 'profile.md'), 'utf8')
    expect(body).toMatch(/- \(\d{4}-\d{2}-\d{2}\) 甲自己的经验/)
  })
  it('keeps files authoritative and rebuilds project membership and group projections', async () => {
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
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'project', projectId: project.id, agentId: a.id, content: '接口需要版本号', tier: 'profile', sources: [fact] }, { agentId: a.id })
    expect((await knowledge.context(owner, b.id, project.id)).text).toContain('接口需要版本号')
    expect((await knowledge.context(owner, b.id)).text).not.toContain('接口需要版本号')
    knowledge.saveProject(owner, { ...input, requestId: randomUUID(), id: project.id, expectedRevision: project.revision, memberIds: [a.id], groupIds: [] })
    await expect(knowledge.context(owner, b.id, project.id)).rejects.toThrowError(expect.objectContaining({ code: 'project_forbidden' }))
  })
  it('rejects stale revisions, cross-contributor writes and overwrite of user-maintained facts', async () => {
    const fact = source('以后请精简回复')
    const input = { requestId: randomUUID(), scope: 'user' as const, agentId: a.id, content: '用户喜欢简洁', tier: 'profile' as const, sources: [fact] }
    const initial = await knowledge.writeMemory(owner, input, { agentId: a.id })
    await expect(knowledge.writeMemory(owner, { ...input, requestId: randomUUID() }, { agentId: b.id })).rejects.toThrowError(expect.objectContaining({ code: 'memory_forbidden' }))
    const edited = await knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: initial.id, expectedRevision: 1, content: '回复简洁但保留依据' })
    expect(edited.revision).toBe(2)
    await expect(knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: initial.id, expectedRevision: 1 })).rejects.toThrowError(expect.objectContaining({ code: 'memory_revision_conflict' }))
    await expect(knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: initial.id, expectedRevision: 2 }, { agentId: a.id })).rejects.toThrowError(expect.objectContaining({ code: 'memory_manual_protected' }))
    expect(await knowledge.revisions(owner, input, initial.id)).toHaveLength(2)
  })
  it('keeps tombstones across restart and prevents old synthesis from resurrecting forgotten facts', async () => {
    const input = { requestId: randomUUID(), scope: 'agent' as const, agentId: a.id, content: '旧偏好', tier: 'profile' as const }
    const memory = await knowledge.writeMemory(owner, input)
    await knowledge.forget(owner, { ...input, requestId: randomUUID(), id: memory.id, expectedRevision: memory.revision })
    knowledge = new WorkspaceKnowledge(home, store)
    await expect(knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), automatic: true, sources: [source('旧偏好')] }, { agentId: a.id })).rejects.toThrowError(expect.objectContaining({ code: 'memory_forgotten' }))
    expect(await knowledge.memories(owner, input)).toEqual([])
    expect((await knowledge.revisions(owner, input, memory.id))[0]?.operation).toBe('forget')
  })
  it('recovers a partially written multi-file transaction and does not duplicate its receipt or event', async () => {
    const input = { requestId: randomUUID(), scope: 'agent' as const, agentId: a.id, content: '需要恢复的事实', tier: 'profile' as const }
    knowledge.fault = path => { if (path.endsWith('profile.md')) throw new Error('simulated power loss') }
    await expect(knowledge.writeMemory(owner, input)).rejects.toThrow('simulated power loss')
    knowledge = new WorkspaceKnowledge(home, store)
    const restored = await knowledge.memories(owner, input)
    expect(restored).toHaveLength(1)
    expect(await knowledge.writeMemory(owner, input)).toEqual(restored[0])
    expect(store.events(owner, 0).filter(e => e.type === 'memory.changed')).toHaveLength(1)
    expect(await knowledge.revisions(owner, input, restored[0]!.id)).toHaveLength(1)
  })
  it('reports corrupted metadata without silently replacing it and rejects unsafe paths', async () => {
    const input = { requestId: randomUUID(), scope: 'agent' as const, agentId: a.id, content: '保留事实', tier: 'log' as const }
    await knowledge.writeMemory(owner, input)
    const path = join(home, 'bot-workspace', owner, 'agents', a.id, 'memory', '.dreaming', 'records.json')
    writeFileSync(path, '{broken')
    await expect(knowledge.memories(owner, input)).rejects.toThrowError(expect.objectContaining({ code: 'knowledge_file_corrupt' }))
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    await expect(knowledge.memories(owner, { scope: 'project', projectId: '../other' })).rejects.toThrowError(expect.objectContaining({ code: 'knowledge_invalid_id' }))
  })
})
