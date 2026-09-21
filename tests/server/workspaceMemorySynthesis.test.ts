// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import { MEMORY_EXTRACTION_MAX_CHARS, WorkspaceMemorySynthesis } from '../../src/server/workspaceMemorySynthesis'
import { UploadStore } from '../../src/server/uploads'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceMessage, WorkspaceRun } from '../../src/shared/workspace'
import { HttpError } from '../../src/server/errors'

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
it('runs extraction on server Hermes even for a legacy computer Bot',async()=>{
  const request=vi.fn(async()=>({status:200,body:Buffer.from(JSON.stringify({text:'{"memories":[]}'}))}))
  const target={session:{request}}
  runtime.nodes.target=vi.fn(()=>target) as any
  runtime.nodes.targetForAgent=vi.fn(()=>{throw new Error('VM must not run inference')})
  vi.spyOn(runtime,'botCapabilities').mockResolvedValue({memory:true,extraction:true} as any)
  await synthesis.infer(owner,{...agent,execution:'computer'},'extract facts')
  expect(runtime.nodes.target).toHaveBeenCalledWith(owner,agent.nodeId)
  expect(runtime.nodes.targetForAgent).not.toHaveBeenCalled()
})
it.each([{ kind: 'text', content: '正文'.repeat(6000) }, { kind: 'escaped Unicode', content: '\u0000"\\😀'.repeat(2000) }])('keeps long $kind evidence valid JSON within the complete request budget', async ({ content }) => {
  const { source, reply, run } = turn(content)
  const project = runtime.knowledge.saveProject(owner, { requestId: randomUUID(), name: '项目', description: '', memberIds: [agent.id], groupIds: [] })
  run.projectId = project.id; store.saveRun(owner, run)
  const job = runtime.knowledge.jobs(owner)[0]!
  runtime.knowledge.saveJob(owner, { ...job, projectId: project.id })
  for (const scope of ['agent', 'user', 'project'] as const) {
    for (let index = 0; index < 6; index++) await runtime.knowledge.writeMemory(owner, {
      requestId: randomUUID(), scope, agentId: agent.id, projectId: scope === 'project' ? project.id : undefined,
      content: `${scope}-${index}:`.padEnd(2000, '甲'), tier: 'profile',
    })
  }
  for (let index = 0; index < 6; index++) store.saveMessage(owner, { ...reply, id: randomUUID(), seq: 0, content })
  const infer = vi.fn(async (_owner, _agent, prompt: string) => {
    expect(prompt.length).toBeLessThanOrEqual(MEMORY_EXTRACTION_MAX_CHARS)
    const serialized = prompt.slice(prompt.indexOf('本轮证据：') + '本轮证据：'.length)
    const evidence = JSON.parse(serialized)
    expect(evidence[0].id).toBe(source.id)
    expect(evidence[0].content.length).toBeGreaterThan(0)
    expect(evidence.every((message: { content: string }) => source.content.includes(message.content) || message.content === reply.content)).toBe(true)
    expect(prompt).not.toContain('private-execution-text')
    return '{"memories":[]}'
  })
  synthesis.infer = infer
  await synthesis.tick()
  expect(infer).toHaveBeenCalledOnce()
  expect(runtime.knowledge.jobs(owner)[0]?.status).toBe('complete')
})
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
  expect((await runtime.knowledge.memories(owner, { scope: 'user' }))[0]?.content).toBe('用户偏好简洁中文')
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
  expect(await runtime.knowledge.memories(owner, { scope: 'user' })).toEqual([])
  expect(await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })).toEqual([])
  expect(runtime.knowledge.jobs(owner)[0]?.result).toMatchObject({
    extractedCount: 3, writtenCount: 0, duplicateCount: 0, replayedCount: 0,
    skippedReasons: { quote_mismatch: 1, user_not_explicit: 1, project_unbound: 1 },
  })
})
it('reports an empty extraction separately from saved memories', async () => {
  turn('检查今天是否有新邮件')
  synthesis.infer = async () => '{"memories":[]}'
  const write = vi.spyOn(runtime.knowledge, 'writeMemoryWithResult')
  await synthesis.tick()
  expect(write).not.toHaveBeenCalled()
  expect(runtime.knowledge.jobs(owner)[0]).toMatchObject({ status: 'complete', result: {
    extractedCount: 0, writtenCount: 0, duplicateCount: 0, replayedCount: 0, skippedReasons: {},
  } })
})
it('retains confirmed Bot working context without a project and reports duplicate facts', async () => {
  const { source } = turn('开发机是 studio，项目文件位于 /workspace/app；服务端部署在 server。')
  const fact = { scope: 'agent', content: 'app 项目在 studio 的 /workspace/app 开发，服务端部署在 server。', tier: 'log', sourceMessageId: source.id, quote: source.content }
  synthesis.infer = async () => JSON.stringify({ memories: [fact, fact] })
  await synthesis.tick()
  const memories = await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })
  expect(memories).toHaveLength(1)
  expect(memories[0]).toMatchObject({ content: fact.content, scope: 'agent', tier: 'log', origin: 'synthesis' })
  expect((await runtime.knowledge.context(owner, agent.id)).text).toContain(fact.content)
  expect(runtime.knowledge.jobs(owner)[0]?.result).toMatchObject({ extractedCount: 2, writtenCount: 1, duplicateCount: 1 })
})
it('preserves partial results on a write failure and identifies replayed writes on retry', async () => {
  const { source } = turn('app 在开发机编译；部署时需要使用服务器。')
  synthesis.infer = async () => JSON.stringify({ memories: ['app 在开发机编译', 'app 部署时使用服务器'].map(content => ({
    scope: 'agent', tier: 'log', content, sourceMessageId: source.id, quote: source.content,
  })) })
  const write = runtime.knowledge.writeMemoryWithResult.bind(runtime.knowledge)
  let calls = 0
  vi.spyOn(runtime.knowledge, 'writeMemoryWithResult').mockImplementation((...args) => {
    if (++calls === 2) throw new HttpError(502, 'OpenViking 暂时不可用', 'openviking_unavailable')
    return write(...args)
  })
  await synthesis.tick()
  const pending = runtime.knowledge.jobs(owner)[0]!
  expect(pending).toMatchObject({ status: 'pending', result: { extractedCount: 2, writtenCount: 1, replayedCount: 0 }, error: 'OpenViking 暂时不可用' })
  runtime.knowledge.saveJob(owner, { ...pending, nextAt: 0 })
  await synthesis.tick()
  expect(runtime.knowledge.jobs(owner)[0]).toMatchObject({ status: 'complete', result: { extractedCount: 2, writtenCount: 1, replayedCount: 1, duplicateCount: 0 } })
  expect(await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })).toHaveLength(2)
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
  const fact = await runtime.knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: agent.id, content: '偏好简洁中文', tier: 'profile', sources: [{ messageId: source.id, conversationId: source.conversationId, quote: source.content }] })
  await runtime.knowledge.forget(owner, { requestId: randomUUID(), scope: 'agent', agentId: agent.id, id: fact.id, expectedRevision: fact.revision })
  synthesis.infer = async () => JSON.stringify({ memories: [{ scope: 'agent', content: '用中文简单回答用户', tier: 'profile', sourceMessageId: source.id, quote: source.content }] })
  await synthesis.tick()
  expect(await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id })).toEqual([])
  expect(runtime.knowledge.jobs(owner)[0]?.result?.skippedReasons).toEqual({ forgotten: 1 })
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
  expect((await runtime.knowledge.memories(owner, { scope: 'agent', agentId: agent.id }))[0]?.content).toBe('接口需要保持向后兼容')
})
