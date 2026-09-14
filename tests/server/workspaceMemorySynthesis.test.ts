// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import { WorkspaceMemorySynthesis } from '../../src/server/workspaceMemorySynthesis'
import { UploadStore } from '../../src/server/uploads'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceMessage, WorkspaceRun } from '../../src/shared/workspace'

const owner = 'synthesis-owner'
let home: string, store: WorkspaceStore, runtime: WorkspaceRuntime, synthesis: WorkspaceMemorySynthesis, uploads: UploadStore, agent: WorkspaceAgent
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-synthesis-')); store = new WorkspaceStore(home); uploads = new UploadStore(home)
  runtime = new WorkspaceRuntime(store, { requireSource: () => {} } as unknown as WorkspaceNodes, uploads)
  vi.spyOn(runtime, 'wake').mockImplementation(() => {})
  synthesis = new WorkspaceMemorySynthesis(runtime)
  agent = store.createAgent(owner, { name: '记忆成员', profile: 'default' })
})
afterEach(() => { synthesis.close(); runtime.close(); uploads.close(); store.close(); rmSync(home, { recursive: true, force: true }) })
function turn(content = '以后我喜欢简洁的中文回复') {
  const c = store.list<WorkspaceConversation>(owner, 'conversation')[0]!
  const run = runtime.send(owner, c.id, { requestId: randomUUID(), content })
  const reply: WorkspaceMessage = { id: randomUUID(), conversationId: c.id, seq: 0, role: 'assistant', agentId: agent.id, content: '将按此偏好回答', reasoning: 'private-execution-text', status: 'complete', runId: run.id, tools: [{ name: 'private-tool' }], attachments: [], createdAt: Date.now() }
  store.saveMessage(owner, reply); run.status = 'complete'; store.saveRun(owner, run)
  synthesis.enqueue(owner, run)
  return { run, source: store.require<WorkspaceMessage>(owner, 'message', run.messageId), reply }
}
it('merges one agent’s visible results per user request and retains pending jobs across restart', async () => {
  const { run, source, reply } = turn()
  store.saveMessage(owner, { ...reply, id: randomUUID(), seq: 0, content: '另一条公开结果' })
  synthesis.enqueue(owner, run)
  expect(runtime.knowledge.jobs(owner)).toHaveLength(1)
  synthesis.close(); synthesis = new WorkspaceMemorySynthesis(runtime)
  const infer = vi.fn(async (_owner, _agent, prompt: string) => {
    expect(prompt).not.toContain('private-execution-text'); expect(prompt).not.toContain('private-tool')
    return JSON.stringify({ memories: [{ scope: 'user', content: '用户偏好简洁中文', tier: 'profile', sourceMessageId: source.id, quote: source.content }] })
  })
  synthesis.infer = infer
  await synthesis.tick()
  expect(infer).toHaveBeenCalledTimes(1)
  expect(runtime.knowledge.memories(owner, { scope: 'user' })[0]?.content).toBe('用户偏好简洁中文')
  expect(runtime.knowledge.jobs(owner)[0]?.status).toBe('complete')
  await synthesis.tick(); expect(infer).toHaveBeenCalledTimes(1)
})
it('rejects fabricated evidence and does not promote an assistant assertion into shared user memory', async () => {
  const { source, reply } = turn('请完成这一次的接口分析')
  synthesis.infer = async () => JSON.stringify({ memories: [
    { scope: 'agent', content: '不存在的事实', tier: 'log', sourceMessageId: source.id, quote: '证据里没有这句话' },
    { scope: 'user', content: '用户是架构师', tier: 'profile', sourceMessageId: reply.id, quote: reply.content },
    { scope: 'project', content: '无项目不应保存', tier: 'log', sourceMessageId: source.id, quote: source.content },
  ] })
  await synthesis.tick()
  expect(runtime.knowledge.memories(owner, { scope: 'user' })).toEqual([])
  expect(runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })).toEqual([])
})
it('honors pause during inference and retries failures without breaking the conversation', async () => {
  const { run } = turn()
  synthesis.infer = async () => { throw new Error('temporary inference outage') }
  await synthesis.tick()
  const failed = runtime.knowledge.jobs(owner)[0]!
  expect(failed.status).toBe('pending'); expect(failed.attempts).toBe(1)
  expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('complete')
  runtime.knowledge.saveJob(owner, { ...failed, nextAt: 0 })
  synthesis.infer = async () => { store.updateAgent(owner, agent.id, { memoryEnabled: false }); return '{"memories":[]}' }
  await synthesis.tick()
  expect(runtime.knowledge.jobs(owner)[0]?.status).toBe('skipped')
})
it('does not recreate a forgotten fact by paraphrasing evidence from the same old turn', async () => {
  const { source } = turn()
  const fact = runtime.knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: agent.id, content: '偏好简洁中文', tier: 'profile', sources: [{ messageId: source.id, conversationId: source.conversationId, quote: source.content }] })
  runtime.knowledge.forget(owner, { requestId: randomUUID(), scope: 'agent', agentId: agent.id, id: fact.id, expectedRevision: fact.revision })
  synthesis.infer = async () => JSON.stringify({ memories: [{ scope: 'agent', content: '用中文简单回答用户', tier: 'profile', sourceMessageId: source.id, quote: source.content }] })
  await synthesis.tick()
  expect(runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })).toEqual([])
})

it('waits for asynchronous collaboration and extracts the returned result only in its originating context', async () => {
  const conversation = store.list<WorkspaceConversation>(owner, 'conversation')[0]!
  const root = runtime.send(owner, conversation.id, { requestId: randomUUID(), content: '请联系同伴核对项目规范并记住结果' })
  root.status = 'complete'; store.saveRun(owner, root)
  const peerId = randomUUID(), replyRunId = randomUUID()
  store.put(owner, 'collaboration-chain', root.id, { id: root.id, rootRunId: root.id, stopped: false })
  const peer = { id: peerId, chainId: root.id, status: 'running', conversationId: conversation.id, runId: replyRunId }
  store.put(owner, 'peer-message', peerId, peer)
  synthesis.enqueue(owner, root)
  expect(runtime.knowledge.jobs(owner)).toEqual([])
  const reply: WorkspaceRun = { ...root, id: replyRunId, triggerKind: 'peer', peerMessageId: peerId, collaborationChainId: root.id }
  store.saveRun(owner, reply)
  store.put(owner, 'peer-message', peerId, { ...peer, status: 'complete' })
  const message: WorkspaceMessage = { id: randomUUID(), conversationId: conversation.id, seq: 0, role: 'assistant', agentId: agent.id, content: '核对结果：接口需要保持向后兼容', reasoning: '', status: 'complete', runId: replyRunId, tools: [], attachments: [], createdAt: Date.now() }
  store.saveMessage(owner, message)
  synthesis.enqueue(owner, reply)
  expect(runtime.knowledge.jobs(owner)).toHaveLength(1)
  synthesis.infer = async (_owner, _agent, prompt) => {
    expect(prompt).toContain(message.content)
    return JSON.stringify({ memories: [{ scope: 'agent', content: '接口需要保持向后兼容', tier: 'log', sourceMessageId: message.id, quote: message.content }] })
  }
  await synthesis.tick()
  expect(runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })[0]?.content).toBe('接口需要保持向后兼容')
})
