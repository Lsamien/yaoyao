// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import { UploadStore } from '../../src/server/uploads'
import { discussionRounds } from '../../src/server/workspaceDiscussion'
import type { Work } from '../../src/server/workspaceScheduler'
import type { WorkspaceAgent as Agent, WorkspaceConversation as Conversation, WorkspaceMessage as Message, WorkspaceRun as Run } from '../../src/shared/workspace'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'

const owner = 'collaboration-owner'
let home: string, store: WorkspaceStore, runtime: FakeRuntime, uploads: UploadStore
class FakeRuntime extends WorkspaceRuntime {
  calls: Array<{ agentId: string; work: Work }> = []
  reply: (agent: Agent, work: Work) => string = agent => `${agent.name} 的实质结果`
  interrupt: (work: Work) => Promise<void> = work => {
    work.status = 'interrupted'; this.saveWork('collaboration-owner', work)
    return Promise.resolve()
  }
  protected override async performTurn(user: string, c: Conversation, agent: Agent, work: Work): Promise<Message> {
    this.calls.push({ agentId: agent.id, work })
    const content = this.reply(agent, work)
    const message: Message = { id: randomUUID(), conversationId: c.id, conversationTaskId: work.conversationTaskId, seq: 0, role: 'assistant', agentId: agent.id, agentName: agent.name, content, reasoning: '', runId: work.runId, taskId: work.id, status: 'complete', attachments: [], tools: [], createdAt: Date.now() }
    this.store.saveMessage(user, message)
    work.status = 'complete'; work.currentMessageId = message.id; this.saveWork(user, work)
    return message
  }
  protected override async interruptTurn(user: string, work: Work): Promise<void> { await this.interrupt(work) }
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-collaboration-')); store = new WorkspaceStore(home); uploads = new UploadStore(home)
  runtime = new FakeRuntime(store, { requireSource: () => {} } as unknown as WorkspaceNodes, uploads)
})
afterEach(() => { runtime.close(); uploads.close(); store.close(); rmSync(home, { recursive: true, force: true }) })
const bot = (name: string) => store.createAgent(owner, { name, profile: 'default' })
const direct = (id: string) => store.list<Conversation>(owner, 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === id)!
it('settles a stop locally while remote interruption is unavailable', async () => {
  vi.spyOn(runtime, 'wake').mockImplementation(() => {})
  const a = bot('停止挂起')
  const run = runtime.send(owner, direct(a.id).id, { requestId: randomUUID(), content: '等待停止' })
  const work = store.list<Work>(owner, 'turn').find(item => item.runId === run.id)!
  work.status = 'running'
  work.submitted = true
  store.put(owner, 'turn', work.id, work)
  let finishInterrupt!: () => void
  runtime.interrupt = () => new Promise(resolve => { finishInterrupt = resolve })
  await Promise.race([
    runtime.stop(owner, run.id),
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop timed out')), 50)),
  ])
  expect(store.require<Run>(owner, 'run', run.id)).toMatchObject({ status: 'interrupted', stopRequested: true })
  expect(store.require<Work>(owner, 'turn', work.id)).toMatchObject({ status: 'interrupted', cleanupPending: true })
  expect(store.require<Conversation>(owner, 'conversation', run.conversationId).activeRunId).toBeUndefined()
  finishInterrupt()
  await vi.waitFor(() => expect(store.require<Work>(owner, 'turn', work.id).cleanupPending).toBe(false))
})
it('projects real deliveries into compact direction metadata for live events and history without rewriting raw messages', () => {
  vi.spyOn(runtime, 'wake').mockImplementation(() => {})
  const a = bot('竹儿'), b = bot('研究员')
  runtime.send(owner, direct(a.id).id, { requestId: randomUUID(), content: '请核对接口' })
  const work = store.list<Work>(owner, 'turn')[0]!
  work.status = 'running'; store.put(owner, 'turn', work.id, work)
  const events: Message[] = []
  const unsubscribe = store.observe((_owner, event) => { if (event.type === 'message.changed') events.push(event.data as Message) })
  const input = { requestId: randomUUID(), agentId: b.id, content: '请核对接口版本，确认旧客户端是否兼容。', fileIds: [] }
  const peer = runtime.collaboration.send(owner, work.id, input)
  const deliveries = events.filter(m => m.peerMessageId === peer.id)
  expect(deliveries.map(m => m.communication?.direction)).toEqual(['incoming', 'outgoing'])
  expect(deliveries.every(m => m.role === 'system' && m.communication?.content === input.content)).toBe(true)
  expect(deliveries[0]?.content).toContain('来自 Bot')
  expect(deliveries[1]?.content).toContain('已向')
  expect(deliveries[0]?.communication).toMatchObject({ peerId: a.id, peerName: '竹儿' })
  expect(deliveries[1]?.communication).toMatchObject({ peerId: b.id, peerName: '研究员' })
  const history = store.messages(owner, direct(a.id).id).find(m => m.peerMessageId === peer.id)!
  expect(history.communication).toEqual(deliveries[1]?.communication)
  expect(store.require<Message>(owner, 'message', history.id).content).toContain('已向')
  const ordinary: Message = { ...history, id: randomUUID(), peerMessageId: undefined, communication: undefined, content: '已向 Bot 发送只是普通文本' }
  expect(store.messageForDisplay(owner, ordinary).communication).toBeUndefined()
  unsubscribe()
})
it('honors explicit round counts and finishes all eight speakers in twelve rounds', async () => {
  expect(discussionRounds('请讨论一轮')).toBe(1); expect(discussionRounds('请讨论三轮')).toBe(3); expect(discussionRounds('讨论一下')).toBe(2)
  const members = Array.from({ length: 8 }, (_, i) => bot(`成员${i}`))
  const c = store.createGroup(owner, { name: '平等讨论', memberIds: members.map(a => a.id), collaborationMode: 'discussion' })
  const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '请讨论十二轮' })
  await vi.waitFor(() => expect(store.require<Run>(owner, 'run', run.id).status).toBe('complete'))
  expect(runtime.calls).toHaveLength(96)
  expect(runtime.calls.slice(8, 16).map(c => c.agentId)).toEqual([...members.slice(1), members[0]!].map(a => a.id))
  for (const member of members) expect(runtime.calls.filter(c => c.agentId === member.id)).toHaveLength(12)
})
it('selects mentioned speakers and continues after an individual failure without starting a goal', async () => {
  const a = bot('甲'), b = bot('乙'), c = bot('丙')
  const group = store.createGroup(owner, { name: '评审', memberIds: [a.id, b.id, c.id], collaborationMode: 'discussion' })
  runtime.reply = agent => { if (agent.id === b.id) throw new Error('成员暂不可用'); return '核对后的结果' }
  const run = runtime.send(owner, group.id, { requestId: randomUUID(), content: '回答一轮', mentionIds: [b.id, c.id] })
  await vi.waitFor(() => expect(store.require<Run>(owner, 'run', run.id).status).toBe('complete'))
  expect(runtime.calls.map(c => c.agentId)).toEqual([b.id, c.id])
  expect(store.list(owner, 'goal')).toEqual([])
  expect(store.list<Message>(owner, 'message').some(m => m.agentId === b.id && m.status === 'failed')).toBe(true)
})
it('delivers A → B → A asynchronously and returns the reply to the originating group topic', async () => {
  const a = bot('甲'), b = bot('乙')
  const group = store.createGroup(owner, { name: '原始话题', memberIds: [a.id, b.id], administratorId: a.id, mode: 'host' })
  const task = store.tasks(owner, group.id)[0]!
  runtime.reply = (agent, work) => {
    const run = store.require<Run>(owner, 'run', work.runId)
    if (!run.peerMessageId) runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: b.id, content: '请核对接口事实', fileIds: [] })
    else if (agent.id === b.id) runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: a.id, content: '已查明接口版本为二', fileIds: [], replyTo: run.peerMessageId })
    return agent.id === b.id ? '已发送核对结果' : run.peerMessageId ? '向用户交付最终结果' : '已请乙协助'
  }
  const deviceHost=randomUUID()
  runtime.send(owner, group.id, { requestId: randomUUID(), taskId: task.id, content: '请找乙核对接口后告诉我',deviceHost })
  await vi.waitFor(() => expect(runtime.calls).toHaveLength(3))
  await vi.waitFor(() => expect(store.list<Run>(owner, 'run').every(r => r.status === 'complete')).toBe(true))
  const reply = store.list<Message>(owner, 'message').find(m => m.content === '向用户交付最终结果')!
  expect(reply.conversationId).toBe(group.id); expect(reply.conversationTaskId).toBe(task.id)
  expect(runtime.collaboration.list(owner)).toHaveLength(2)
  expect(store.list<Run>(owner,'run').every(run=>run.deviceHost===deviceHost)).toBe(true)
  expect(store.list<Message>(owner, 'message').filter(m => m.peerMessageId).every(m => m.role !== 'user')).toBe(true)
})
it('deduplicates sends, suppresses acknowledgements and stops pending peers after the source turn ends', async () => {
  vi.spyOn(runtime, 'wake').mockImplementation(() => {})
  const a = bot('甲'), b = bot('乙'), run = runtime.send(owner, direct(a.id).id, { requestId: randomUUID(), content: '联系同伴' })
  const work = store.list<Work>(owner, 'turn')[0]!; work.status = 'running'; store.put(owner, 'turn', work.id, work)
  const input = { requestId: randomUUID(), agentId: b.id, content: '请核对接口', fileIds: [] }
  const first = runtime.collaboration.send(owner, work.id, input)
  expect(runtime.collaboration.send(owner, work.id, input).id).toBe(first.id)
  expect(() => runtime.collaboration.send(owner, work.id, { ...input, requestId: randomUUID() })).toThrowError(expect.objectContaining({ code: 'peer_repeated' }))
  expect(() => runtime.collaboration.send(owner, work.id, { ...input, requestId: randomUUID(), content: '收到，谢谢' })).toThrowError(expect.objectContaining({ code: 'peer_acknowledgement' }))
  run.status = 'complete'; store.saveRun(owner, run)
  await runtime.stop(owner, run.id)
  expect(store.require<any>(owner, 'peer-message', first.id).status).toBe('stopped')
  expect(store.require<Run>(owner, 'run', first.runId!).stopRequested).toBe(true)
})

it('bounds a persisted asynchronous chain and rejects disabled recipients and unrelated files', () => {
  vi.spyOn(runtime, 'wake').mockImplementation(() => {})
  const a = bot('甲'), b = bot('乙')
  runtime.send(owner, direct(a.id).id, { requestId: randomUUID(), content: '开始协作' })
  let work = store.list<Work>(owner, 'turn')[0]!
  work.status = 'running'; store.put(owner, 'turn', work.id, work)
  expect(() => runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: b.id, content: '文件请求', fileIds: [randomUUID()] })).toThrowError(expect.objectContaining({ code: 'peer_file_forbidden' }))
  const hiddenFile = randomUUID()
  store.saveMessage(owner, { id: randomUUID(), conversationId: work.conversationId, seq: 0, role: 'assistant', agentId: a.id, visible: false, content: '内部执行资料', reasoning: '', status: 'complete', attachments: [{ id: hiddenFile, name: 'internal.txt', mimeType: 'text/plain', size: 1, sender: 'user', createdAt: Date.now() }], tools: [], createdAt: Date.now() })
  expect(() => runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: b.id, content: '不能分享内部附件', fileIds: [hiddenFile] })).toThrowError(expect.objectContaining({ code: 'peer_file_forbidden' }))
  for (let depth = 1; depth <= 8; depth++) {
    const peer = runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: work.agentId === a.id ? b.id : a.id, content: `第 ${depth} 次新的事实和请求`, fileIds: [] })
    expect(peer.depth).toBe(depth)
    work = store.list<Work>(owner, 'turn').find(w => w.runId === peer.runId)!
    work.status = 'running'; store.put(owner, 'turn', work.id, work)
  }
  expect(() => runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: work.agentId === a.id ? b.id : a.id, content: '第九次请求', fileIds: [] })).toThrowError(expect.objectContaining({ code: 'peer_chain_limit' }))
  expect(runtime.collaboration.list(owner)).toHaveLength(8)
})

it('restores the original project on reply without granting that project to an outside peer', async () => {
  const a = bot('项目成员'), b = bot('项目外顾问')
  const project = runtime.knowledge.saveProject(owner, { requestId: randomUUID(), name: '私有项目', description: '', memberIds: [a.id], groupIds: [] })
  const seen: Array<{ agentId: string; projectId?: string }> = []
  runtime.reply = (agent, work) => {
    const run = store.require<Run>(owner, 'run', work.runId)
    seen.push({ agentId: agent.id, projectId: run.projectId })
    if (!run.peerMessageId) runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: b.id, content: '请对公开接口提供建议', fileIds: [] })
    else if (agent.id === b.id) runtime.collaboration.send(owner, work.id, { requestId: randomUUID(), agentId: a.id, content: '建议保留旧版本兼容', fileIds: [], replyTo: run.peerMessageId })
    return '完成当前阶段'
  }
  runtime.send(owner, direct(a.id).id, { requestId: randomUUID(), content: '请参考顾问建议推进当前项目', projectId: project.id })
  await vi.waitFor(() => expect(seen).toHaveLength(3))
  expect(seen).toEqual([{ agentId: a.id, projectId: project.id }, { agentId: b.id, projectId: undefined }, { agentId: a.id, projectId: project.id }])
  expect(runtime.knowledge.memberships(owner, b.id)).toEqual([])
})
