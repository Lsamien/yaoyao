// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { defaultAgentIdentity, encodeAgentAvatar, decodeAgentAvatar } from '../../src/shared/agentIdentity'
import {HttpError} from '../../src/server/errors'
import {WorkspaceAssets} from '../../src/server/workspaceAssets'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime, mentionedAgents } from '../../src/server/workspaceRuntime'
import type { Work } from '../../src/server/workspaceScheduler'
import { REPEATED_RELAY_NOTICE } from '../../src/server/workspaceRelay'
import { WorkspaceNodes } from '../../src/server/workspaceGateway'
import { UploadStore } from '../../src/server/uploads'
import type {
  WorkspaceConversation,
  WorkspaceRun,
  WorkspaceMessage,
  WorkspaceInteraction,
} from '../../src/shared/workspace'

let home: string,
  store: WorkspaceStore,
  uploads: UploadStore,
  runtime: WorkspaceRuntime,
  server: WebSocketServer
let requests: Array<{ method: string; params: Record<string, any> }>,
  reply: (socket: WebSocket, params: Record<string, any>) => void
let nodes: WorkspaceNodes
let configuredCwds: Map<string, string>
let rejectPrompt: string | undefined
let rejectedInterrupts: number
let recoveryHistory: Array<{ role: string; content: string; tool_calls?: unknown }>
let storedByRuntime: Map<string, string>, recoveryByStored: Map<string, Array<{ role: string; content: string }>>
const owner = 'first-user',
  other = 'second-user'
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-workspace-test-'))
  store = new WorkspaceStore(home)
  uploads = new UploadStore(home)
  requests = []
  configuredCwds = new Map()
  recoveryHistory = []
  storedByRuntime = new Map(); recoveryByStored = new Map()
  rejectPrompt = undefined
  rejectedInterrupts = 0
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as { port: number }
  const target = {
    url: new URL(`http://127.0.0.1:${address.port}`),
    client: { directAgent: undefined },
    session: {
      webSocketCredential: async () => ({ name: 'ticket', value: 'test' }),
      request: async (path: string, options?: {search?: URLSearchParams}) => ({
        status: 200,
        body: Buffer.from(JSON.stringify(path === '/api/config'
          ? { terminal: { cwd: configuredCwds.get(options?.search?.get('profile') ?? '') } }
          : { messages: (() => { const all = recoveryByStored.get(decodeURIComponent(path.split('/')[3]!)) ?? recoveryHistory; const offset = Number(options?.search?.get('offset') ?? 0); return all.slice(Math.max(0,all.length-offset-500), all.length-offset) })() })),
      }),
    },
  }
  nodes = { requireSource: () => {}, target: () => target } as unknown as WorkspaceNodes
  runtime = new WorkspaceRuntime(store, nodes, uploads)
  reply = (socket, p) =>
    setTimeout(
      () =>
        socket.send(
          JSON.stringify({
            method: 'event',
            params: {
              type: 'message.complete',
              session_id: p.session_id,
              payload: { text: '完成', status: 'complete' },
            },
          }),
        ),
      5,
    )
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready' } }))
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data))
      requests.push(frame)
      const respond = (result: unknown) => socket.send(JSON.stringify({ id: frame.id, result }))
      if (frame.method === 'session.create' || frame.method === 'session.resume') {
        const runtimeId = randomUUID(), storedId = frame.method === 'session.resume' ? frame.params.session_id : randomUUID()
        storedByRuntime.set(runtimeId, storedId)
        respond({ session_id: runtimeId, stored_session_id: storedId, running: false, info: { profile_name: frame.params.profile } })
      }
      else if (frame.method === 'session.cwd.set') respond({ cwd: frame.params.cwd })
      else if (frame.method === 'prompt.submit') {
        if (rejectPrompt) { socket.send(JSON.stringify({id:frame.id,error:{code:4006,message:rejectPrompt}})); return }
        respond({ status: 'streaming' })
        reply(socket, frame.params)
      } else if (frame.method === 'session.usage') respond({ context_used: 400, context_max: 1000 })
      else if (frame.method === 'session.interrupt' && rejectedInterrupts-- > 0) socket.send(JSON.stringify({id:frame.id,error:{code:500,message:'暂时不能中断'}}))
      else respond({ ok: true, status: 'interrupted' })
    })
  })
})
afterEach(async () => {
  runtime.close()
  await new Promise((resolve) => setTimeout(resolve, 10))
  for (const client of server.clients) client.terminate()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  uploads.close()
  store.close()
  rmSync(home, { recursive: true, force: true })
})
function agent(name: string, user = owner) {
  return store.createAgent(user, { name, profile: 'default', instructions: `规则：你是${name}` })
}
it('executes a structured assignment on its actual worker and leaves acceptance to its coordinator', async () => {
  const lead = store.updateAgent(owner, agent('负责人').id, { canManageTeam: true })
  const worker = agent('研究成员')
  const source = direct(lead.id)
  const original = runtime.send(owner, source.id, { requestId: randomUUID(), content: '完成研究' })
  for (const work of store.list<any>(owner, 'turn').filter(w => w.runId === original.id))
    store.put(owner, 'turn', work.id, { ...work, status: 'complete', planned: true })
  original.status = 'complete';store.saveRun(owner, original)
  const team = store.createGroup(owner, { name: '研究团队', memberIds: [lead.id,worker.id], administratorId: lead.id })
  const goal = runtime.tasks.begin(owner, store.tasks(owner, team.id)[0]!, lead, '研究事实', { conversationId: source.id, runId: original.id, agentId: lead.id })
  const assignment = runtime.tasks.createAssignment(owner, lead.id, { requestId: randomUUID(), goalId: goal.id, agentId: worker.id, title: '核对事实', brief: '提交核对结果' })
  await vi.waitFor(() => expect(store.get<any>(owner,'assignment',assignment.id)?.status).toBe('review'), { timeout: 5000 })
  const submitted = requests.find(r => r.method === 'prompt.submit' && String(r.params.text).includes('核对事实'))!
  expect(submitted.params.text).toContain('你是 研究成员')
  expect(submitted.params.text).toContain('执行子任务')
  expect(store.get<any>(owner,'goal',goal.id)?.status).not.toBe('complete')
})
function direct(id: string, user = owner) {
  return store
    .list<WorkspaceConversation>(user, 'conversation')
    .find((c) => c.kind === 'direct' && c.memberIds[0] === id)!
}
function defaultTask(conversationId: string, user = owner) {
  return store.tasks(user, conversationId)[0]!
}
async function finished(id: string) {
  await vi.waitFor(() =>
    expect(store.require<WorkspaceRun>(owner, 'run', id).status).toBe('complete'),
  )
  return store.require<WorkspaceRun>(owner, 'run', id)
}
describe('Web-owned workspace', () => {
  it('restores recent user and assistant context when moving a completed conversation to another runner',async()=>{
    const a=agent('移动成员'),c=direct(a.id)
    await finished(runtime.send(owner,c.id,{requestId:randomUUID(),content:'保存研究结论'}).id)
    const binding=store.list<any>(owner,'binding')[0]!
    store.put(owner,'binding',binding.id,{...binding,runnerId:'previous-runner'})
    const before=requests.length
    await finished(runtime.send(owner,c.id,{requestId:randomUUID(),content:'继续后续分析'}).id)
    const next=requests.slice(before)
    expect(next.some(r=>r.method==='session.resume')).toBe(false)
    const text=next.find(r=>r.method==='prompt.submit')!.params.text
    expect(text).toContain('执行节点已切换')
    expect(text).toContain('保存研究结论')
    expect(text).toContain('移动成员（complete）：完成')
    expect(text).toContain('继续后续分析')
  })
  it('uses each base profile cwd and replaces historical cwd before the next Bot turn', async () => {
    configuredCwds.set('default', '/profile/first')
    configuredCwds.set('other', '/profile/other')
    const a = agent('主助手'), c = direct(a.id)
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: 'first' }).id)
    expect(requests.find(r => r.method === 'session.create')?.params.cwd).toBe('/profile/first')
    expect(requests.find(r => r.method === 'session.cwd.set')?.params.cwd).toBe('/profile/first')
    configuredCwds.set('default', '/profile/changed')
    const before = requests.length
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: 'second' }).id)
    const next = requests.slice(before)
    expect(next[0].method).toBe('session.resume')
    expect(next.find(r => r.method === 'session.cwd.set')?.params.cwd).toBe('/profile/changed')
    expect(next.findIndex(r => r.method === 'session.cwd.set')).toBeLessThan(next.findIndex(r => r.method === 'prompt.submit'))
    const b = store.createAgent(owner, { name: '其他 Profile', profile: 'other' })
    await finished(runtime.send(owner, direct(b.id).id, { requestId: randomUUID(), content: 'third' }).id)
    expect(requests.filter(r => r.method === 'session.create').at(-1)?.params.cwd).toBe('/profile/other')
  })

  it('flushes a paused delta before completion and cancels pending flush on finish', async () => {
    let upstream: { socket: WebSocket; params: Record<string, any> } | undefined
    reply = (socket, params) => {
      upstream = { socket, params }
      const event = (type: string, payload: Record<string, unknown>) => socket.send(JSON.stringify({
        method: 'event', params: { type, session_id: params.session_id, payload },
      }))
      event('message.start', {})
      event('message.delta', { text: '# 流式标题' })
    }
    const bot = agent('流式助手'), conversation = direct(bot.id)
    const run = runtime.send(owner, conversation.id, { requestId: randomUUID(), content: '验证暂停分片' })
    const assistant = () => store.list<WorkspaceMessage>(owner, 'message').find(m => m.runId === run.id && m.role === 'assistant')
    await vi.waitFor(() => expect(assistant()?.content).toBe('# 流式标题'))
    expect(assistant()?.status).toBe('streaming')
    expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).not.toBe('complete')
    const { socket, params } = upstream!
    socket.send(JSON.stringify({ method: 'event', params: { type: 'message.delta', session_id: params.session_id, payload: { text: '\n\n最后一段' } } }))
    completeReply(socket, params, '# 最终正文')
    await finished(run.id)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(assistant()?.content).toBe('# 最终正文')
    expect(assistant()?.status).toBe('complete')
  })

  it('backfills legacy group history into the initial task instead of leaving a new empty task', () => {
    const legacyHome = mkdtempSync(join(tmpdir(), 'yaoyao-workspace-task-migration-'))
    let seededStore: WorkspaceStore | undefined = new WorkspaceStore(legacyHome)
    let migratedStore: WorkspaceStore | undefined
    try {
      const administrator = seededStore.createAgent(owner, { name: '历史管理员', profile: 'default' }),
        member = seededStore.createAgent(owner, { name: '历史成员', profile: 'default' }),
        conversation = seededStore.createGroup(owner, {
          name: '公众号文案团队',
          memberIds: [administrator.id, member.id],
          administratorId: administrator.id,
        }),
        initialTask = seededStore.tasks(owner, conversation.id)[0]!,
        userAt = 1_788_000_000_000,
        assistantAt = userAt + 60_000
      seededStore.put(owner, 'message', 'legacy-user', {
        id: 'legacy-user', conversationId: conversation.id, seq: 1, role: 'user',
        content: '请继续完成公众号文案', reasoning: '', status: 'complete',
        attachments: [], tools: [], createdAt: userAt,
      } satisfies WorkspaceMessage)
      seededStore.put(owner, 'message', 'legacy-assistant', {
        id: 'legacy-assistant', conversationId: conversation.id, seq: 2, role: 'assistant',
        agentId: administrator.id, agentName: '历史管理员', content: '旧内容已经完成。',
        reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: assistantAt,
      } satisfies WorkspaceMessage)
      seededStore.put(owner, 'conversation', conversation.id, {
        ...conversation,
        readSeq: 1,
        lastSeq: 2,
        preview: '旧内容已经完成。',
        lastMessageAt: assistantAt,
        updatedAt: assistantAt,
      })
      seededStore.put(owner, 'run', 'legacy-run', {
        id: 'legacy-run', conversationId: conversation.id, messageId: 'legacy-user',
        mentionIds: [], status: 'complete', round: 1, createdAt: userAt, updatedAt: assistantAt,
      } satisfies WorkspaceRun)
      seededStore.put(owner, 'turn', 'legacy-turn', {
        id: 'legacy-turn', runId: 'legacy-run', conversationId: conversation.id,
        agentId: administrator.id, messageId: 'legacy-user', status: 'complete', createdAt: userAt,
      })
      seededStore.put(owner, 'interaction', 'legacy-interaction', {
        id: 'legacy-interaction', conversationId: conversation.id, runId: 'legacy-run',
        agentId: administrator.id, kind: 'clarification', message: '补充说明',
        choices: [], resolved: true,
      } satisfies WorkspaceInteraction)
      seededStore.put(owner, 'interaction-binding', 'legacy-interaction', {
        key: `${conversation.id}:${administrator.id}`,
        upstreamId: 'upstream-interaction', taskId: 'legacy-turn',
      })
      seededStore.put(owner, 'binding', `${conversation.id}:${administrator.id}`, {
        nodeId: 'local', profile: 'default', storedId: 'stored-legacy',
        runtimeId: 'runtime-legacy', aliases: [], runId: 'legacy-run',
        messageId: 'legacy-user', taskId: 'legacy-turn',
      })
      seededStore.put(owner, 'context', conversation.id, {
        usedTokens: 100, limitTokens: 1_000, observedAt: assistantAt,
      })
      seededStore.db.prepare('DELETE FROM workspace_migrations WHERE id=?')
        .run('conversation-task-history-v1')
      seededStore.close()
      seededStore = undefined

      migratedStore = new WorkspaceStore(legacyHome)
      const tasks = migratedStore.tasks(owner, conversation.id)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        id: initialTask.id,
        title: '请继续完成公众号文案',
        titleSource: 'automatic',
        messageCount: 2,
        readSeq: 1,
        lastSeq: 2,
        unreadCount: 1,
        lastMessageAt: assistantAt,
        createdAt: userAt,
        updatedAt: assistantAt,
      })
      expect(
        migratedStore.messages(
          owner, conversation.id, Number.MAX_SAFE_INTEGER, 100, false, initialTask.id,
        ).map(message => message.id),
      ).toEqual(['legacy-user', 'legacy-assistant'])
      expect(migratedStore.require<WorkspaceRun>(owner, 'run', 'legacy-run').conversationTaskId)
        .toBe(initialTask.id)
      expect(migratedStore.require<{ conversationTaskId: string }>(owner, 'turn', 'legacy-turn').conversationTaskId)
        .toBe(initialTask.id)
      expect(migratedStore.require<WorkspaceInteraction>(owner, 'interaction', 'legacy-interaction').conversationTaskId)
        .toBe(initialTask.id)
      expect(migratedStore.get(owner, 'binding', `${conversation.id}:${administrator.id}`)).toBeUndefined()
      expect(migratedStore.get(owner, 'binding', `${conversation.id}:${initialTask.id}:${administrator.id}`))
        .toMatchObject({ conversationTaskId: initialTask.id })
      expect(migratedStore.get(owner, 'context', conversation.id)).toBeUndefined()
      expect(migratedStore.get(owner, 'context', initialTask.id))
        .toMatchObject({ conversationTaskId: initialTask.id })
    } finally {
      seededStore?.close()
      migratedStore?.close()
      rmSync(legacyHome, { recursive: true, force: true })
    }
  })

  it('serializes one Agent across group tasks while keeping messages, sessions and context isolated', async () => {
    const administrator = store.createAgent(owner, { name: '多任务远程管理员', profile: 'remote-profile', nodeId: 'remote-node' }),
      member = agent('多任务成员'),
      conversation = store.createGroup(owner, {
        name: '多任务群聊',
        memberIds: [administrator.id, member.id],
        administratorId: administrator.id,
      }),
      firstTask = defaultTask(conversation.id),
      secondTask = store.createTask(owner, conversation.id, { title: '显式标题' })
    const pending: Array<{ socket: WebSocket; params: Record<string, any> }> = []
    reply = (socket, params) => {
      pending.push({ socket, params })
    }
    const complete = (item: typeof pending[number]) => {
        const text = item.params.text.includes('第一项工作') ? '第一项结果' : '第二项结果'
        setTimeout(() => item.socket.send(JSON.stringify({
          method: 'event',
          params: { type: 'message.complete', session_id: item.params.session_id, payload: { text, status: 'complete' } },
        })), 5)
    }
    const firstRun = runtime.send(owner, conversation.id, { requestId: randomUUID(), taskId: firstTask.id, content: '第一项工作' }),
      secondRun = runtime.send(owner, conversation.id, { requestId: randomUUID(), taskId: secondTask.id, content: '第二项工作' })
    await vi.waitFor(()=>expect(pending).toHaveLength(1))
    expect(store.require<WorkspaceRun>(owner,'run',secondRun.id).status).toBe('queued')
    complete(pending[0]!)
    await finished(firstRun.id)
    await vi.waitFor(()=>expect(pending).toHaveLength(2))
    complete(pending[1]!)
    await finished(secondRun.id)
    const firstMessages = store.messages(owner, conversation.id, Number.MAX_SAFE_INTEGER, 100, false, firstTask.id),
      secondMessages = store.messages(owner, conversation.id, Number.MAX_SAFE_INTEGER, 100, false, secondTask.id)
    expect(firstMessages.map(message => message.content)).toEqual(['第一项工作', '第一项结果'])
    expect(secondMessages.map(message => message.content)).toEqual(['第二项工作', '第二项结果'])
    expect(firstMessages.every(message => message.conversationTaskId === firstTask.id)).toBe(true)
    expect(secondMessages.every(message => message.conversationTaskId === secondTask.id)).toBe(true)
    const prompts = requests.filter(request => request.method === 'prompt.submit').map(request => String(request.params.text))
    expect(prompts.find(prompt => prompt.includes('第一项工作'))).not.toContain('第二项工作')
    expect(prompts.find(prompt => prompt.includes('第二项工作'))).not.toContain('第一项工作')
    const bindings = store.list<any>(owner, 'binding')
    expect(bindings.map(binding => binding.conversationTaskId).sort()).toEqual([firstTask.id, secondTask.id].sort())
    expect(bindings.every(binding => binding.nodeId === 'remote-node' && binding.profile === 'remote-profile')).toBe(true)
    expect(new Set(bindings.map(binding => binding.storedId)).size).toBe(2)
    expect(store.get<any>(owner, 'context', firstTask.id)).toMatchObject({ conversationTaskId: firstTask.id, percent: 40 })
    expect(store.get<any>(owner, 'context', secondTask.id)).toMatchObject({ conversationTaskId: secondTask.id, percent: 40 })
    const firstSummary = store.require<any>(owner, 'conversation-task', firstTask.id)
    expect(firstSummary).toMatchObject({ title: '第一项工作', titleSource: 'automatic', messageCount: 2, unreadCount: 2 })
    expect(store.require<any>(owner, 'conversation-task', secondTask.id)).toMatchObject({ title: '显式标题', titleSource: 'user', messageCount: 2 })
    expect(store.markTaskRead(owner, conversation.id, firstTask.id, firstSummary.lastSeq).unreadCount).toBe(0)
    store.deleteTask(owner, conversation.id, firstTask.id)
    expect(store.list<WorkspaceMessage>(owner, 'message').some(message => message.conversationTaskId === firstTask.id)).toBe(false)
    expect(store.list<any>(owner, 'binding').some(binding => binding.conversationTaskId === firstTask.id)).toBe(false)
    expect(store.get(owner, 'context', firstTask.id)).toBeUndefined()
    expect(store.messages(owner, conversation.id, Number.MAX_SAFE_INTEGER, 100, false, secondTask.id).map(message => message.content))
      .toEqual(['第二项工作', '第二项结果'])
  })

  it('limits a group to four active conversation tasks while retaining the global scheduler limit', async () => {
    const administrator = agent('并发任务管理员'),
      member = agent('并发任务成员'),
      conversation = store.createGroup(owner, {
        name: '并发任务群聊',
        memberIds: [administrator.id, member.id],
        administratorId: administrator.id,
      }),
      tasks = [defaultTask(conversation.id), ...Array.from({ length: 4 }, (_, index) => store.createTask(owner, conversation.id, { title: `任务 ${index + 2}` }))]
    reply = () => {}
    for (const [index, task] of tasks.slice(0, 4).entries())
      runtime.send(owner, conversation.id, { requestId: randomUUID(), taskId: task.id, content: `执行 ${index + 1}` })
    expect(store.activeTaskCount(owner, conversation.id)).toBe(4)
    expect(() => runtime.send(owner, conversation.id, { requestId: randomUUID(), taskId: tasks[4]!.id, content: '第五项' }))
      .toThrow('最多同时运行 4 个任务')
    await Promise.all(tasks.slice(0, 4).map(task => runtime.stopTask(owner, conversation.id, task.id)))
  })

  it('keeps same-named upstream interactions scoped to their conversation task', async () => {
    const administrator = agent('交互隔离管理员'),
      member = agent('交互隔离成员'),
      conversation = store.createGroup(owner, {
        name: '交互隔离群聊',
        memberIds: [administrator.id, member.id],
        administratorId: administrator.id,
      }),
      firstTask = defaultTask(conversation.id),
      secondTask = store.createTask(owner, conversation.id, {})
    const pending: Array<{socket:WebSocket;params:Record<string,any>}> = []
    reply = (socket, params) => { pending.push({socket,params});setTimeout(() => socket.send(JSON.stringify({
      method: 'event',
      params: {
        type: 'approval.request',
        session_id: params.session_id,
        payload: { request_id: 'same-upstream-id', message: '允许执行吗？' },
      },
    })), 5) }
    const firstRun=runtime.send(owner, conversation.id, { requestId: randomUUID(), taskId: firstTask.id, content: '任务甲' })
    // Different tasks admitted in the same millisecond need not win a lane in
    // insertion order. Establish the active task before testing its isolation.
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const secondRun=runtime.send(owner, conversation.id, { requestId: randomUUID(), taskId: secondTask.id, content: '任务乙' })
    await vi.waitFor(() => expect(store.list<WorkspaceInteraction>(owner, 'interaction').filter(interaction => !interaction.resolved)).toHaveLength(1))
    const first=store.list<WorkspaceInteraction>(owner,'interaction').find(i=>i.conversationTaskId===firstTask.id)!
    expect(store.require<any>(owner, 'conversation-task', firstTask.id).activeRunStatus).toBe('waiting')
    expect(store.require<WorkspaceRun>(owner,'run',secondRun.id).status).toBe('queued')
    await runtime.respond(owner, first.id, 'once')
    pending[0]!.socket.send(JSON.stringify({method:'event',params:{type:'message.complete',session_id:pending[0]!.params.session_id,payload:{text:'任务甲完成',status:'complete'}}}))
    await finished(firstRun.id)
    await vi.waitFor(()=>expect(store.list<WorkspaceInteraction>(owner,'interaction')).toHaveLength(2))
    const second=store.list<WorkspaceInteraction>(owner,'interaction').find(i=>i.conversationTaskId===secondTask.id)!
    expect(second.id).not.toBe(first.id)
    expect(store.require<any>(owner, 'conversation-task', secondTask.id).activeRunStatus).toBe('waiting')
    await runtime.respond(owner,first.id,'once')
    expect(store.require<WorkspaceInteraction>(owner, 'interaction', first.id).resolved).toBe(true)
    expect(store.require<WorkspaceInteraction>(owner, 'interaction', second.id).resolved).toBe(false)
    await Promise.all([runtime.stopTask(owner, conversation.id, firstTask.id), runtime.stopTask(owner, conversation.id, secondTask.id)])
  })

  it('persists a visible failure when a fixed member loses its source node',async()=>{
    const a=agent('不可用成员'),c=direct(a.id)
    runtime.close()
    runtime=new WorkspaceRuntime(store,{requireSource: () => {},target:()=>{throw new Error('基础节点不可用')}} as unknown as WorkspaceNodes,uploads)
    const run=runtime.send(owner,c.id,{requestId:randomUUID(),content:'执行任务'})
    await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('failed'))
    expect(store.messages(owner,c.id).at(-1)).toMatchObject({role:'system',status:'failed',content:'执行失败：基础节点不可用'})
    expect(store.require<WorkspaceConversation>(owner,'conversation',c.id).activeRunId).toBeUndefined()
  })
  it('interprets a reply against its launch-time roster when names or mode change mid-turn', async () => {
    const a = agent('管理员'),
      b = agent('执行者')
    const c = store.createGroup(owner, {
      name: '配置更新',
      memberIds: [a.id, b.id],
      administratorId: a.id,
      maxReplyRounds: 3,
    })
    let count = 0
    reply = (socket, p) => {
      let text = '已完成'
      if (count++ === 0) {
        store.updateAgent(owner, b.id, { name: '新名字', instructions: '新规则' })
        store.updateConversation(owner, c.id, { mode: 'free', administratorId: b.id })
        text = '请继续 @执行者'
      }
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              method: 'event',
              params: { type: 'message.complete', session_id: p.session_id, payload: { text } },
            }),
          ),
        5,
      )
    }
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '开始' }).id)
    expect(
      store
        .messages(owner, c.id)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.agentId),
    ).toEqual([a.id, b.id])
    expect(requests.filter((r) => r.method === 'prompt.submit').at(-1)!.params.text).toContain(
      '新规则',
    )
  })
  it('rejects unscoped and foreign-session completion events', async () => {
    const a = agent('会话隔离'),
      c = direct(a.id)
    reply = (socket, p) => {
      for (const session_id of [undefined, 'another-session'])
        socket.send(
          JSON.stringify({
            method: 'event',
            params: { type: 'message.complete', session_id, payload: { text: '别人的结果' } },
          }),
        )
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              method: 'event',
              params: {
                type: 'message.complete',
                session_id: p.session_id,
                payload: { text: '本轮结果' },
              },
            }),
          ),
        15,
      )
    }
    const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '执行' })
    await finished(run.id)
    expect(store.messages(owner, c.id).at(-1)?.content).toBe('本轮结果')
    expect(store.get<{ percent: number }>(owner, 'context', c.id)?.percent).toBe(40)
  })
  it('resumes a persisted uncertain run by inspecting history, without resending the prompt', async () => {
    const a = agent('恢复测试'),
      c = direct(a.id)
    reply = (socket, p) => {
      recoveryHistory = [
        { role: 'user', content: p.text },
        { role: 'assistant', content: '已经执行完成' },
      ]
      socket.terminate()
    }
    const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '修改一次' })
    await vi.waitFor(() =>
      expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('uncertain'),
    )
    runtime.close()
    runtime = new WorkspaceRuntime(store, nodes, uploads)
    await runtime.reconcile(owner, run.id)
    await finished(run.id)
    expect(requests.filter((r) => r.method === 'prompt.submit')).toHaveLength(1)
    expect(store.messages(owner, c.id).map((m) => m.content)).toEqual(['修改一次', '已经执行完成'])
  })
  it('routes approvals and clarifications to the owning run and ignores optional push failures', async () => {
    const a = agent('交互测试'),
      c = direct(a.id)
    runtime.onNotify = () => {
      throw new Error('push storage unavailable')
    }
    let kind = 'approval'
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const f = JSON.parse(String(data))
        if (['approval.respond', 'clarify.respond'].includes(f.method))
          socket.send(
            JSON.stringify({
              method: 'event',
              params: {
                type: 'message.complete',
                session_id: f.params.session_id,
                payload: { text: '确认后完成' },
              },
            }),
          )
      }),
    )
    reply = (socket, p) =>
      socket.send(
        JSON.stringify({
          method: 'event',
          params: {
            type: `${kind}.request`,
            session_id: p.session_id,
            payload: { request_id: 'upstream-interaction', message: '请确认' },
          },
        }),
      )
    for (kind of ['approval', 'clarify']) {
      const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '继续' })
      await vi.waitFor(() =>
        expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('waiting'),
      )
      const interaction = store
        .list<WorkspaceInteraction>(owner, 'interaction')
        .find((i) => !i.resolved)!
      await expect(runtime.respond(other, interaction.id, 'once')).rejects.toThrow('记录不存在')
      await runtime.respond(owner, interaction.id, kind === 'approval' ? 'once' : '补充说明')
      await finished(run.id)
      expect(
        store.require<WorkspaceInteraction>(owner, 'interaction', interaction.id).resolved,
      ).toBe(true)
    }
    expect(
      requests
        .filter((r) => r.method === 'approval.respond' || r.method === 'clarify.respond')
        .map((r) => r.params.request_id),
    ).toEqual(['upstream-interaction', 'upstream-interaction'])
  })
  it('creates one direct chat without importing a native profile session', () => {
    const a = agent('编辑')
    expect(direct(a.id).kind).toBe('direct')
    expect(store.list(other, 'agent')).toEqual([])
    expect(() => store.require(other, 'conversation', direct(a.id).id)).toThrow('记录不存在')
    expect(requests).toEqual([])
  })
  it('protects the current administrator and validates member ownership', () => {
    const a = agent('甲'),
      b = agent('乙'),
      foreign = agent('外部', other)
    const c = store.createGroup(owner, {
      name: '团队',
      memberIds: [a.id, b.id],
      administratorId: a.id,
    })
    expect(() => store.updateConversation(owner, c.id, { memberIds: [b.id] })).toThrow('当前管理员不能移除')
    expect(() => store.updateConversation(owner, c.id, { memberIds: [b.id], administratorId: b.id })).toThrow('当前管理员不能移除')
    expect(() => store.updateConversation(owner, c.id, { memberIds: [a.id, foreign.id] })).toThrow('记录不存在')
    expect(() => store.updateConversation(owner, c.id, { memberIds: [a.id, a.id] })).toThrow('群成员或管理员无效')
    expect(() =>
      store.createGroup(owner, {
        name: '越权',
        memberIds: [a.id, foreign.id],
        administratorId: a.id,
      }),
    ).toThrow()
    store.updateAgent(owner, b.id, { archived: true })
    expect(store.require<WorkspaceConversation>(owner, 'conversation', c.id).memberIds).toEqual([
      a.id,
      b.id,
    ])
    expect(() =>
      store.createGroup(owner, { name: '新群', memberIds: [a.id, b.id], administratorId: a.id }),
    ).toThrow('已归档')
    expect(store.updateConversation(owner, c.id, { memberIds: [a.id] }).memberIds).toEqual([a.id])
    expect(() => store.updateConversation(owner, c.id, { memberIds: [a.id, b.id] })).toThrow('已归档')
  })
  it('adds and removes members, cleans automatic replies, and permits removal after administrator transfer', async () => {
    const a = agent('管理员'), b = agent('旧成员'), added = agent('新成员')
    const c = store.createGroup(owner, { name: '成员维护', memberIds: [a.id, b.id], administratorId: a.id, autoReplyIds: [b.id] })
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '保留这条历史' }).id)
    const before = store.require<WorkspaceConversation>(owner, 'conversation', c.id)
    const history = store.messages(owner, c.id)
    const changed = store.updateConversation(owner, c.id, { memberIds: [a.id, added.id] })
    expect(changed.memberIds).toEqual([a.id, added.id])
    expect(changed.autoReplyIds).toEqual([])
    expect(changed.lastMessageAt).toBe(before.lastMessageAt)
    expect(store.messages(owner, c.id)).toEqual(history)
    expect(store.events(owner, 0).at(-1)).toMatchObject({ type: 'conversation.changed', data: { memberIds: [a.id, added.id] } })
    store.updateConversation(owner, c.id, { administratorId: added.id })
    expect(store.updateConversation(owner, c.id, { memberIds: [added.id] }).memberIds).toEqual([added.id])
    expect(() => store.updateConversation(owner, c.id, { memberIds: [a.id] })).toThrow('当前管理员不能移除')
  })
  it('skips removed queued members and accepts a newly added member on the next request', async () => {
    const a = agent('管理员'), b = agent('待回复'), added = agent('新成员')
    const c = store.createGroup(owner, { name: '队列维护', memberIds: [a.id, b.id], administratorId: a.id, mode: 'free', autoReplyIds: [a.id, b.id] })
    reply = (socket, p) => {
      socket.send(JSON.stringify({ method: 'event', params: { type: 'message.complete', session_id: p.session_id, payload: { text: '请@待回复继续' } } }))
    }
    const queued = runtime.send(owner, c.id, { requestId: randomUUID(), content: '开始' })
    store.updateConversation(owner, c.id, { memberIds: [a.id, added.id] })
    await finished(queued.id)
    expect(store.messages(owner, c.id).filter(m => m.role === 'assistant').map(m => m.agentId)).toEqual([a.id])
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '请@新成员继续' }).id)
    expect(store.messages(owner, c.id).filter(m => m.role === 'assistant').map(m => m.agentId)).toEqual([a.id, added.id, a.id])
  })
  it('finishes an in-flight removed member reply without scheduling it again', async () => {
    const a = agent('管理员'), b = agent('正在回复')
    const c = store.createGroup(owner, { name: '回复中移除', memberIds: [a.id, b.id], administratorId: a.id })
    let turns = 0
    reply = (socket, p) => {
      if (turns++ === 1) store.updateConversation(owner, c.id, { memberIds: [a.id] })
      socket.send(JSON.stringify({ method: 'event', params: { type: 'message.complete', session_id: p.session_id, payload: { text: turns === 1 ? '请@正在回复继续' : '已完成' } } }))
    }
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '@正在回复 开始' }).id)
    expect(store.messages(owner, c.id).filter(m => m.role === 'assistant').map(m => m.agentId)).toEqual([a.id, b.id, a.id])
    expect(() => runtime.send(owner, c.id, { requestId: randomUUID(), content: '继续', mentionIds: [b.id] })).toThrow('只能 @ 群内成员')
  })
  it('dispatches a request exactly once across retries and rejects payload reuse', async () => {
    const a = agent('编辑'),
      c = direct(a.id),
      requestId = randomUUID(),
      payload = { requestId, content: '检查代码' }
    const run = runtime.send(owner, c.id, payload)
    expect(runtime.send(owner, c.id, payload).id).toBe(run.id)
    expect(() => runtime.send(owner, c.id, { ...payload, content: '另一件事' })).toThrow('请求编号')
    await finished(run.id)
    expect(requests.filter((r) => r.method === 'prompt.submit')).toHaveLength(1)
    expect(store.messages(owner, c.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
  it('keeps template responsibilities inside their group and follows Agent identity after rename', async () => {
    const a = agent('现有甲'), b = agent('现有乙')
    const before = store.require<WorkspaceAgent>(owner, 'agent', a.id)
    const c = store.createGroup(owner, { name: '模板群', memberIds: [a.id, b.id], administratorId: a.id, memberRoles: {
      [a.id]: { name: '调研负责人', description: '汇总可信结论' },
      [b.id]: { name: '事实核验', description: '交叉验证来源' },
    } })
    expect(store.require<WorkspaceAgent>(owner, 'agent', a.id)).toEqual(before)
    store.updateAgent(owner, a.id, { name: '改名后的甲' })
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '开始调研' }).id)
    const groupPrompt = requests.filter(r => r.method === 'prompt.submit').at(-1)!.params.text
    expect(groupPrompt).toContain('@改名后的甲：调研负责人；汇总可信结论')
    expect(groupPrompt).toContain('@现有乙：事实核验；交叉验证来源')
    await finished(runtime.send(owner, direct(a.id).id, { requestId: randomUUID(), content: '单聊' }).id)
    expect(requests.filter(r => r.method === 'prompt.submit').at(-1)!.params.text).not.toContain('汇总可信结论')
    const changed = store.updateConversation(owner, c.id, { memberIds: [a.id] })
    expect(changed.memberRoles).toEqual({ [a.id]: { name: '调研负责人', description: '汇总可信结论' } })
    expect(() => store.updateConversation(owner, c.id, { memberRoles: { [b.id]: { name: '已移除', description: '' } } })).toThrow('群成员或管理员无效')
  })
  it('isolates roles over the same profile and applies edited rules on the next turn', async () => {
    const a = agent('编辑'),
      b = agent('审查'),
      ca = direct(a.id),
      cb = direct(b.id)
    const first = runtime.send(owner, ca.id, { requestId: randomUUID(), content: '编辑任务' })
    const second = runtime.send(owner, cb.id, { requestId: randomUUID(), content: '审查任务' })
    await Promise.all([finished(first.id), finished(second.id)])
    expect(requests.filter((r) => r.method === 'session.create')).toHaveLength(2)
    expect(store.messages(owner, ca.id).some((m) => m.content === '审查任务')).toBe(false)
    store.updateAgent(owner, a.id, { instructions: '最新规则：先给证据' })
    await finished(runtime.send(owner, ca.id, { requestId: randomUUID(), content: '继续' }).id)
    expect(requests.filter((r) => r.method === 'prompt.submit').at(-1)!.params.text).toContain(
      '最新规则：先给证据',
    )
    expect(requests.some((r) => r.method === 'profiles.configure')).toBe(false)
    expect(
      requests
        .filter((r) => r.method === 'session.create')
        .every((r) => r.params.hidden && r.params.source === 'yaoyao_workspace'),
    ).toBe(true)
  })
  it('executes bounded administrator delegation and keeps group sessions separate from direct chat', async () => {
    const a = agent('管理员'),
      b = agent('开发者'),
      c = store.createGroup(owner, {
        name: '开发',
        memberIds: [a.id, b.id],
        administratorId: a.id,
        maxReplyRounds: 3,
      })
    let turns = 0
    reply = (socket, p) => {
      const text = turns++ === 0 ? '我已整理需求，现在请@开发者继续实现。' : '任务完成'
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              method: 'event',
              params: { type: 'message.complete', session_id: p.session_id, payload: { text } },
            }),
          ),
        5,
      )
    }
    await finished(runtime.send(owner, c.id, { requestId: randomUUID(), content: '实现功能' }).id)
    expect(
      store
        .messages(owner, c.id)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.agentId),
    ).toEqual([a.id, b.id, a.id])
    expect(store.messages(owner, direct(a.id).id)).toHaveLength(0)
    expect(turns).toBe(3)
  })
  it('does not trigger delegation from quoted text or code blocks', () => {
    const a = agent('甲'),
      b = agent('乙')
    expect(mentionedAgents('> @乙\n```\n@甲\n```\n`@all`', [a, b])).toEqual([])
    expect(mentionedAgents('请处理 @乙。', [a, b])).toEqual([b.id])
  })
  it('keeps uncertain submissions blocked instead of executing tools twice', async () => {
    const a = agent('执行者'),
      c = direct(a.id)
    reply = (socket) => socket.terminate()
    const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '修改文件' })
    await vi.waitFor(() =>
      expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('uncertain'),
    )
    const queued = runtime.send(owner, c.id, { requestId: randomUUID(), content: '后续请求' })
    expect(queued.status).toBe('queued')
    expect(requests.filter((r) => r.method === 'prompt.submit')).toHaveLength(1)
    await runtime.stopConversation(owner, c.id)
    expect(
      store.require<WorkspaceConversation>(owner, 'conversation', c.id).activeRunId,
    ).toBeUndefined()
  })
  it('publishes durable ordered events only after commit and rolls back failed transactions', () => {
    const a = agent('甲'),
      c = direct(a.id),
      cursor = store.cursor(owner)
    expect(() =>
      store.atomic(() => {
        store.event(owner, 'test', {})
        throw new Error('rollback')
      }),
    ).toThrow('rollback')
    expect(store.cursor(owner)).toBe(cursor)
    store.updateAgent(owner, a.id, { name: '乙' })
    expect(store.events(owner, cursor).map((e) => e.type)).toEqual([
      'agent.changed',
      'conversation.changed',
    ])
    expect(store.events(other, 0)).toEqual([])
    expect(store.require<WorkspaceConversation>(owner, 'conversation', c.id).name).toBe('乙')
  })
})


it('pins a direct chat without injecting or clearing optional profile fields', () => {
  const avatar = encodeAgentAvatar({...defaultAgentIdentity('reviewer'),shape:'triangle',color:'#00b9ac',expression:'curious'})
  const agent = store.createAgent(owner, { name: '审查员', profile: 'default', avatar })
  const chat = store.list<WorkspaceConversation>(owner, 'conversation')[0]!
  expect(store.updateConversation(owner, chat.id, { pinned: true }).pinned).toBe(true)
  expect(store.updateConversation(owner, chat.id, { pinned: false }).pinned).toBe(false)
  expect(store.require<WorkspaceConversation>(owner, 'conversation', chat.id).avatar).toBe(avatar)
  expect(store.updateAgent(owner, agent.id, { instructions: '请检查边界' }).avatar).toBe(avatar)
  expect(decodeAgentAvatar(store.updateAgent(owner, agent.id, { avatar: '' }).avatar)).toMatchObject({shape:'circle',color:'#00c875'})
})

it('accepts the existing cross-client mascot and team avatar formats', () => {
  const a = store.createAgent(owner, { name: '设计', profile: 'default', avatar: 'yaoyao-mascot:v1:square:377fe6:friendly' })
  const b = store.createAgent(owner, { name: '开发', profile: 'default' })
  const group = store.createGroup(owner, { name: '产品团队', memberIds: [a.id, b.id], administratorId: a.id, avatar: 'builtin:team-animal:fox' })
  expect(group.avatar).toBe('builtin:team-animal:fox')
  expect(() => store.updateAgent(owner, a.id, { avatar: 'javascript:alert(1)' })).toThrow()
})

it('assigns a random v2 avatar only when a new Agent omits its avatar', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0)
  const created = store.createAgent(owner, { name: '随机头像', profile: 'default' })
  expect(decodeAgentAvatar(created.avatar)).toMatchObject({ shape: 'circle', color: '#000000', expression: 'idle' })
  expect(created.avatar).not.toBe(encodeAgentAvatar(defaultAgentIdentity(created.id, created.name)))
  random.mockRestore()
})

it('keeps the last message time independent of pinning and metadata edits', () => {
  const agent=store.createAgent(owner,{name:'时间验收',profile:'default'})
  const c=store.list<WorkspaceConversation>(owner,'conversation')[0]!
  const message: WorkspaceMessage={id:randomUUID(),conversationId:c.id,seq:0,role:'user',content:'历史消息',reasoning:'',status:'complete',attachments:[],tools:[],createdAt:Date.now()-600_000}
  store.saveMessage(owner,message)
  const pinned=store.updateConversation(owner,c.id,{pinned:true})
  expect(store.conversationSummary(owner,pinned).lastMessageAt).toBe(message.createdAt)
  store.updateAgent(owner,agent.id,{name:'改名之后'})
  expect(store.conversationSummary(owner,store.require(owner,'conversation',c.id)).lastMessageAt).toBe(message.createdAt)
  // Existing records without the summary field still use their transcript time.
  const previous={...pinned}; delete previous.lastMessageAt
  expect(store.conversationSummary(owner,previous).lastMessageAt).toBe(message.createdAt)
})


it('publishes only the executing member and clears avatar activity when stopped', async () => {
  const a=store.createAgent(owner,{name:'管理员头像',profile:'default'})
  const b=store.createAgent(owner,{name:'执行者头像',profile:'default'})
  const c=store.createGroup(owner,{name:'头像状态',memberIds:[a.id,b.id],administratorId:a.id})
  reply=(socket,p)=>socket.send(JSON.stringify({method:'event',params:{type:'approval.request',session_id:p.session_id,payload:{request_id:'approval-avatar',message:'需要确认'}}}))
  const run=runtime.send(owner,c.id,{requestId:randomUUID(),content:'处理任务',mentionIds:[b.id]})
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('waiting'))
  expect(store.require<WorkspaceConversation>(owner,'conversation',c.id)).toMatchObject({activeAgentId:a.id,activeRunStatus:'waiting'})
  await runtime.stop(owner,run.id)
  const stopped=store.require<WorkspaceConversation>(owner,'conversation',c.id)
  expect(stopped.activeAgentId).toBeUndefined()
  expect(stopped.activeRunStatus).toBeUndefined()
})

it('stores the expanded avatar shapes for cross-client role settings', () => {
  const agent=store.createAgent(owner,{name:'扩展头像验收',profile:'default'})
  for(const shape of ['ellipse','capsule','hexagon','cloud','droplet'] as const) {
    const avatar=encodeAgentAvatar({...defaultAgentIdentity('bot'),shape,color:'#f52ba5',expression:'curious'})
    expect(store.updateAgent(owner,agent.id,{avatar}).avatar).toBe(avatar)
  }
})


it('automatically reconciles lost completion without submitting the prompt again', async () => {
  const a=agent('自动恢复'),c=direct(a.id)
  reply=(socket,p)=>{recoveryHistory=[{role:'user',content:p.text},{role:'assistant',content:'已完成一次'}];socket.terminate()}
  const run=runtime.send(owner,c.id,{requestId:randomUUID(),content:'执行一次'})
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('complete'),{timeout:5000})
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(1)
  expect(store.messages(owner,c.id).at(-1)).toMatchObject({content:'已完成一次',status:'complete'})
})
it('reports a rejected prompt as failed instead of leaving it uncertain', async () => {
  rejectPrompt='本轮请求被明确拒绝'
  const a=agent('拒绝测试'),c=direct(a.id)
  const run=runtime.send(owner,c.id,{requestId:randomUUID(),content:'执行'})
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('failed'))
  expect(store.require<WorkspaceConversation>(owner,'conversation',c.id).activeRunId).toBeUndefined()
  expect(store.messages(owner,c.id).some(m=>m.status==='uncertain')).toBe(false)
})
it('keeps an unconfirmed turn separate from a later reply and retries history without resubmitting', async () => {
  const a = agent('恢复边界'), c = direct(a.id)
  let prompt = ''
  reply = (socket, p) => {
    prompt = p.text
    recoveryHistory = [{ role: 'user', content: prompt }, { role: 'user', content: '另一个请求' }, { role: 'assistant', content: '另一轮回复' }]
    socket.terminate()
  }
  const run = runtime.send(owner, c.id, { requestId: randomUUID(), content: '只执行一次' })
  await vi.waitFor(() => expect(requests.filter(r => r.method === 'session.resume').length).toBeGreaterThanOrEqual(1), { timeout: 3000 })
  expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('uncertain')
  expect(store.messages(owner, c.id).at(-1)?.content).not.toBe('另一轮回复')
  recoveryHistory = [{ role: 'user', content: prompt }, { role: 'assistant', content: '本轮结果' }]
  await vi.waitFor(() => expect(store.require<WorkspaceRun>(owner, 'run', run.id).status).toBe('complete'), { timeout: 4000 })
  expect(requests.filter(r => r.method === 'prompt.submit')).toHaveLength(1)
  expect(store.messages(owner, c.id).at(-1)).toMatchObject({ content: '本轮结果', status: 'complete' })
})
it('uses one generated avatar for the agent and its direct conversation',()=>{
  const a=agent('默认头像'),c=direct(a.id)
  expect(decodeAgentAvatar(a.avatar)).toMatchObject({version:2,avatarMode:'mascot'})
  expect(store.agentSummary(a).avatar).toBe(store.conversationSummary(owner,c).avatar)
  const changed=store.updateAgent(owner,a.id,{name:'换个名称'})
  expect(store.agentSummary(changed).avatar).toBe(store.agentSummary(a).avatar)
})
it('recognizes mentions inside Chinese sentences and ignores quoted code and emails',()=>{
  const a=agent('瑶儿'),b=agent('竹儿'),c=agent('瑶儿助手'),d=agent('Ann')
  const roster=[a,b,c,d]
  expect(mentionedAgents('先整理，再请@瑶儿帮忙，最后由（@竹儿）复核。',roster)).toEqual([a.id,b.id])
  expect(mentionedAgents('请**@瑶儿助手**继续',roster)).toEqual([c.id])
  expect(mentionedAgents('mail@Ann.com https://site/@竹儿 `@瑶儿` <quoted_message>@瑶儿</quoted_message>',roster)).toEqual([])
  expect(mentionedAgents('@Anna',roster)).toEqual([])
})

function completeReply(socket: WebSocket, p: Record<string, any>, text: string, status = 'complete') {
  socket.send(JSON.stringify({ method: 'event', params: { type: 'message.complete', session_id: p.session_id, payload: { text, status, ...(status === 'failed' ? { error: text } : {}) } } }))
}
const speaker = (p: Record<string, any>) => /^你是 (.*?)。/.exec(p.text)?.[1]

describe('automatic relay termination', () => {
  const receipt = '收到 @审核 终审维持通过。\n\n交付状态（不变）：入草稿箱 Media ID `draft-123`，发布目录 `/work/final/`。\n等民哥群发指令。'
  const review = '@竹儿 维持通过，等民哥群发指令。无新事实、无新派工，本轮不重复核验。'
  const promptCount = () => requests.filter(r => r.method === 'prompt.submit').length
  async function idle(runId: string, conversationId: string) {
    await finished(runId)
    const count = promptCount()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(promptCount()).toBe(count)
    expect(store.list<Work>(owner, 'turn').filter(w => w.runId === runId && (!w.planned || !['complete', 'failed', 'interrupted'].includes(w.status)))).toEqual([])
    const summary = store.conversationSummary(owner, store.require(owner, 'conversation', conversationId))
    expect(summary.activeRunId).toBeUndefined()
    expect(summary.queuedMessageCount ?? 0).toBe(0)
  }
  it('finishes the observed host receipt cycle in exactly three calls and accepts a new user message', async () => {
    const a = agent('竹儿'), b = agent('审核')
    const g = store.createGroup(owner, { name: '收尾验收', memberIds: [a.id, b.id], administratorId: a.id, maxReplyRounds: -1 })
    let admin = 0
    reply = (socket, p) => completeReply(socket, p, speaker(p) === a.name ? admin++ === 0 ? '@审核 请审核文案' : receipt : review)
    const root = runtime.send(owner, g.id, { requestId: randomUUID(), content: '请完成文案' })
    await idle(root.id, g.id)
    expect(promptCount()).toBe(3)
    expect(store.messages(owner, g.id).map(m => m.content)).toEqual(['请完成文案', '@审核 请审核文案', review, receipt])
    expect(store.list<Work>(owner, 'turn').find(w => w.reviewOf)?.relay?.suppressed[b.id]).toBe('acknowledgement')
    const next = runtime.send(owner, g.id, { requestId: randomUUID(), content: '好的。' })
    await idle(next.id, g.id)
    expect(promptCount()).toBe(4)
  })
  it.each(['感谢 @审核，等待用户指令。', '收到，等待用户指令。'])('does not turn a free-mode receipt into an automatic broadcast: %s', content => {
    const a = agent('竹儿'), b = agent('审核')
    const g = store.createGroup(owner, { name: '自动收尾', memberIds: [a.id, b.id], administratorId: a.id, mode: 'free', autoReplyIds: [b.id], maxReplyRounds: -1 })
    reply = (socket, p) => completeReply(socket, p, content)
    return (async () => {
      const root = runtime.send(owner, g.id, { requestId: randomUUID(), content: '@竹儿 请处理' })
      await idle(root.id, g.id)
      expect(promptCount()).toBe(1)
      const next = runtime.send(owner, g.id, { requestId: randomUUID(), content: '感谢 @审核' })
      await idle(next.id, g.id)
      expect(speaker(requests.filter(r => r.method === 'prompt.submit').at(-1)!.params)).toBe(b.name)
    })()
  })
  it.each([
    ['host', 2, 5], ['host', 3, 7], ['free', 2, 4], ['free', 3, 5],
  ] as const)('bounds unchanged %s cooperation with %i members at %i calls', async (mode, size, expected) => {
    const members = [agent('甲'), agent('乙'), ...(size === 3 ? [agent('丙')] : [])]
    const g = store.createGroup(owner, { name: '重复往返', memberIds: members.map(a => a.id), administratorId: members[0]!.id, mode, maxReplyRounds: -1 })
    let count = 0
    reply = (socket, p) => {
      const index = members.findIndex(a => a.name === speaker(p)), whitespace = count++ % 2 ? '  ' : ' '
      const text = mode === 'host' ? index === 0 ? members.slice(1).map(a => `@${a.name}${whitespace}再检查一次`).join('，') : '检查结果相同'
        : `@${members[(index + 1) % members.length]!.name}${whitespace}再检查一次`
      completeReply(socket, p, count > 20 ? '完成' : text)
      completeReply(socket, p, count > 20 ? '完成' : text) // Duplicate completion must not double-plan.
    }
    const root = runtime.send(owner, g.id, { requestId: randomUUID(), content: '@甲 开始' })
    await idle(root.id, g.id)
    expect(count).toBe(expected)
    expect(store.messages(owner, g.id).filter(m => m.content === REPEATED_RELAY_NOTICE)).toHaveLength(1)
    expect(store.list<Work>(owner, 'turn').some(w => Object.values(w.relay?.suppressed ?? {}).includes('repeated'))).toBe(true)
  })
  it.each(['result', 'tool', 'attachment', 'interaction'] as const)('allows repeated instructions with new %s evidence beyond thirteen calls', async kind => {
    const a = agent('负责人'), b = agent('审核')
    const g = store.createGroup(owner, { name: '持续推进', memberIds: [a.id, b.id], administratorId: a.id, maxReplyRounds: -1 })
    let admin = 0, worker = 0
    reply = (socket, p) => {
      if (speaker(p) === a.name) completeReply(socket, p, admin++ < 7 ? '感谢 @审核，请重新检查第二段' : '完成')
      else { worker++; completeReply(socket, p, kind === 'result' ? `第 ${worker} 版结果` : '本次检查结果') }
    }
    runtime.onMessage = async (_owner, message) => {
      if (message.agentId !== b.id) return
      if (kind === 'tool') message.tools = [{ id: randomUUID(), name: 'verify', status: 'tool.complete', result: { revision: worker } }]
      if (kind === 'attachment') message.attachments = [{ id: randomUUID(), name: 'revision.txt', mimeType: 'text/plain', size: 10, createdAt: Date.now() }]
      if (kind === 'interaction') {
        const id = randomUUID()
        store.put(owner, 'interaction', id, { id, runId: message.runId, conversationId: g.id, conversationTaskId: message.conversationTaskId, agentId: b.id, kind: 'clarification', message: '继续重试？', answer: '继续', responseState: 'sent', resolved: true })
        store.put(owner, 'interaction-binding', id, { taskId: message.taskId })
      }
      store.saveMessage(owner, message)
    }
    const root = runtime.send(owner, g.id, { requestId: randomUUID(), content: '反复改进' })
    await idle(root.id, g.id)
    expect(promptCount()).toBe(15)
    expect(store.messages(owner, g.id).some(m => m.content === REPEATED_RELAY_NOTICE)).toBe(false)
  })
  it('ends only the repeating free-mode branch while an independent member finishes', async () => {
    const a = agent('甲'), b = agent('乙'), c = agent('独立成员')
    const g = store.createGroup(owner, { name: '分支隔离', memberIds: [a.id, b.id, c.id], administratorId: a.id, mode: 'free', maxReplyRounds: -1 })
    let pending: { socket: WebSocket; p: Record<string, any> } | undefined, loops = 0
    reply = (socket, p) => {
      if (speaker(p) === c.name) { pending = { socket, p }; return }
      completeReply(socket, p, ++loops > 15 ? '完成' : speaker(p) === a.name ? '@乙 再检查' : '@甲 再检查')
    }
    const root = runtime.send(owner, g.id, { requestId: randomUUID(), content: '@甲 @独立成员 请分别处理' })
    await vi.waitFor(() => expect(store.messages(owner, g.id).some(m => m.content === REPEATED_RELAY_NOTICE)).toBe(true))
    expect(store.require<WorkspaceRun>(owner, 'run', root.id).status).toBe('running')
    expect(store.list<Work>(owner, 'turn').filter(w => w.cancelRequested)).toEqual([])
    expect(loops).toBe(4)
    completeReply(pending!.socket, pending!.p, '完成')
    await idle(root.id, g.id)
    expect(store.messages(owner, g.id).find(m => m.agentId === c.id)).toMatchObject({ content: '完成', status: 'complete' })
  })
  it('checks each target independently when a new automatic member joins the same repeated reply', async () => {
    const a = agent('甲'), b = agent('乙'), c = agent('丙')
    const g = store.createGroup(owner, { name: '目标隔离', memberIds: [a.id, b.id, c.id], administratorId: a.id, mode: 'free', autoReplyIds: [a.id], maxReplyRounds: -1 })
    let calls = 0, admin = 0
    reply = (socket, p) => { calls++; completeReply(socket, p, calls > 15 ? '完成' : speaker(p) === a.name ? '@乙 再检查' : speaker(p) === b.name ? '继续检查' : '完成') }
    runtime.onMessage = async (_owner, message) => {
      if (message.agentId === b.id && ++admin === 2) store.updateConversation(owner, g.id, { autoReplyIds: [a.id, c.id] })
    }
    const root = runtime.send(owner, g.id, { requestId: randomUUID(), content: '@甲 开始' })
    await idle(root.id, g.id)
    expect(calls).toBe(5)
    const blocked = store.list<Work>(owner, 'turn').find(w => w.relay?.suppressed[a.id] === 'repeated')!
    expect(blocked.relay?.suppressed[c.id]).toBeUndefined()
    expect(store.list<Work>(owner, 'turn').find(w => w.batchId === blocked.id && w.agentId === c.id)?.status).toBe('complete')
  })
  it('starts fresh for identical new requests in the same task and a different task', async () => {
    const a = agent('甲'), b = agent('乙')
    const g = store.createGroup(owner, { name: '任务隔离', memberIds: [a.id, b.id], administratorId: a.id, mode: 'free', maxReplyRounds: -1 })
    let calls = 0
    reply = (socket, p) => { calls++; completeReply(socket, p, calls > 20 ? '完成' : speaker(p) === a.name ? '@乙 再检查' : '@甲 再检查') }
    const originalTask = defaultTask(g.id), secondTask = store.createTask(owner, g.id, { title: '另一个任务' })
    for (const [index, task] of [originalTask, originalTask, secondTask].entries()) {
      const root = runtime.send(owner, g.id, { requestId: randomUUID(), taskId: task.id, content: '@甲 开始' })
      await idle(root.id, g.id)
      expect(calls).toBe((index + 1) * 4)
      expect(store.messages(owner, g.id, Number.MAX_SAFE_INTEGER, 100, false, task.id).filter(m => m.runId === root.id && m.content === REPEATED_RELAY_NOTICE)).toHaveLength(1)
    }
  })
  it.each([false, true])('recovers repeat suppression across restart before planning (legacy=%s)', async legacy => {
    const a = agent('负责人'), b = agent('成员')
    const g = store.createGroup(owner, { name: '循环恢复', memberIds: [a.id, b.id], administratorId: a.id, maxReplyRounds: -1 })
    let calls = 0
    reply = (socket, p) => { calls++; completeReply(socket, p, calls > 15 ? '完成' : speaker(p) === a.name ? '@成员 再检查' : '结果相同') }
    runtime.onMessage = async () => { if (calls === 5) runtime.close() }
    const root = runtime.send(owner, g.id, { requestId: randomUUID(), content: '开始' })
    await vi.waitFor(() => expect(store.list<Work>(owner, 'turn').filter(w => w.status === 'complete')).toHaveLength(5))
    if (legacy) for (const work of store.list<Work>(owner, 'turn')) { delete work.relay; store.put(owner, 'turn', work.id, work) }
    runtime = new WorkspaceRuntime(store, nodes, uploads); runtime.start()
    await idle(root.id, g.id)
    expect(calls).toBe(5)
    expect(store.messages(owner, g.id).filter(m => m.content === REPEATED_RELAY_NOTICE)).toHaveLength(1)
    runtime.close(); runtime = new WorkspaceRuntime(store, nodes, uploads); runtime.start()
    await idle(root.id, g.id)
    expect(calls).toBe(5)
    expect(store.messages(owner, g.id).filter(m => m.content === REPEATED_RELAY_NOTICE)).toHaveLength(1)
  })
})

it('starts with the administrator, executes a batch concurrently, and reviews failures once without spending a round', async () => {
  const a = agent('管理员'), b = agent('成员乙'), c = agent('成员丙')
  const group = store.createGroup(owner, { name: '并行验收', memberIds: [a.id,b.id,c.id], administratorId: a.id, maxReplyRounds: 2 })
  const pending = new Map<string, { socket: WebSocket; p: Record<string, any> }>()
  let admin = 0, review = ''
  reply = (socket,p) => {
    if (speaker(p) === a.name) { if (admin++ === 0) completeReply(socket,p,'请@成员乙检查接口，@成员丙检查数据'); else { review=p.text; completeReply(socket,p,'汇总完成') } }
    else pending.set(speaker(p)!, {socket,p})
  }
  const root = runtime.send(owner,group.id,{requestId:randomUUID(),content:'@成员乙 请处理'})
  await vi.waitFor(()=>expect(pending.size).toBe(2))
  expect(admin).toBe(1)
  expect(store.require<WorkspaceConversation>(owner,'conversation',group.id).activeAgentStates).toEqual({[b.id]:'running',[c.id]:'running'})
  completeReply(pending.get(c.name)!.socket,pending.get(c.name)!.p,'数据检查失败','failed')
  await vi.waitFor(()=>expect(store.messages(owner,group.id).some(m=>m.status==='failed')).toBe(true))
  expect(admin).toBe(1)
  completeReply(pending.get(b.name)!.socket,pending.get(b.name)!.p,'接口正常')
  await finished(root.id)
  expect(admin).toBe(2)
  expect(review).toContain('数据检查失败')
  expect(review).toContain('接口正常')
  expect(store.require<WorkspaceRun>(owner,'run',root.id).round).toBe(1)
})

it('allows successive dependent delegations and does not charge administrator reviews against the limit', async () => {
  const a=agent('负责人'),b=agent('先做'),c=agent('后做')
  const g=store.createGroup(owner,{name:'串行依赖',memberIds:[a.id,b.id,c.id],administratorId:a.id,maxReplyRounds:3})
  const order:string[]=[];let admin=0
  reply=(socket,p)=>{const name=speaker(p)!;order.push(name);completeReply(socket,p,name===a.name ? ['@先做 第一步','@后做 第二步','完成'][admin++]! : '结果已提交')}
  await finished(runtime.send(owner,g.id,{requestId:randomUUID(),content:'执行'}).id)
  expect(order).toEqual([a.name,b.name,a.name,c.name,a.name])
})

it('continues free discussion automatically and hides irrelevant automatic replies', async () => {
  const a=agent('公开管理员'),b=agent('自动成员')
  const g=store.createGroup(owner,{name:'自由讨论',memberIds:[a.id,b.id],administratorId:a.id,mode:'free',autoReplyIds:[b.id],maxReplyRounds:3})
  reply=(socket,p)=>completeReply(socket,p,speaker(p)===a.name?'我来回答':'[[YAOYAO_NO_REPLY_V1]]')
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'一个问题'})
  await finished(root.id)
  expect(requests.filter(r=>r.method==='prompt.submit'&&speaker(r.params)===b.name)).toHaveLength(2)
  expect(store.messages(owner,g.id).map(m=>m.content)).toEqual(['一个问题','我来回答'])
  expect(store.conversationSummary(owner,store.require(owner,'conversation',g.id)).unreadCount).toBe(2)
  expect(store.hiddenMessageIds(owner,g.id)).toHaveLength(2)
})

it('requires a public administrator reply when the model tries to remain silent', async () => {
  const a=agent('必须答复'),b=agent('旁观者'),g=store.createGroup(owner,{name:'公开答复',memberIds:[a.id,b.id],administratorId:a.id})
  reply=(socket,p)=>completeReply(socket,p,'[[YAOYAO_NO_REPLY_V1]]')
  await finished(runtime.send(owner,g.id,{requestId:randomUUID(),content:'帮助我'}).id)
  const answer=store.messages(owner,g.id).at(-1)!
  expect(answer.content).toContain('请补充具体目标')
  expect(answer.content).not.toContain('YAOYAO_')
})

it('queues later user requests durably without leaking them into the preceding collaboration', async () => {
  const a=agent('排队管理员'),b=agent('排队执行者'),g=store.createGroup(owner,{name:'消息排队',memberIds:[a.id,b.id],administratorId:a.id})
  let first: {socket:WebSocket;p:Record<string,any>}|undefined
  let admin=0;const prompts:string[]=[]
  reply=(socket,p)=>{prompts.push(p.text);if(speaker(p)===a.name&&admin++===0)first={socket,p};else completeReply(socket,p,'已完成')}
  const one=runtime.send(owner,g.id,{requestId:randomUUID(),content:'第一条任务'})
  await vi.waitFor(()=>expect(first).toBeDefined())
  const two=runtime.send(owner,g.id,{requestId:randomUUID(),content:'之后才处理的秘密标记'})
  expect(two.status).toBe('queued')
  expect(store.require<WorkspaceConversation>(owner,'conversation',g.id).activeRunId).toBe(one.id)
  completeReply(first!.socket,first!.p,'请@排队执行者继续')
  await finished(one.id);await finished(two.id)
  expect(prompts).toHaveLength(4)
  expect(prompts.slice(0,3).every(p=>!p.includes('之后才处理的秘密标记'))).toBe(true)
  expect(prompts[3]).toContain('之后才处理的秘密标记')
})

it('stops one member while keeping its sibling running and returns the interrupted result for review', async () => {
  const a=agent('停止管理员'),b=agent('停止乙'),c=agent('继续丙'),g=store.createGroup(owner,{name:'独立停止',memberIds:[a.id,b.id,c.id],administratorId:a.id})
  const pending=new Map<string,{socket:WebSocket;p:Record<string,any>}>();let admin=0,review=''
  reply=(socket,p)=>{if(speaker(p)===a.name){if(admin++===0)completeReply(socket,p,'@停止乙 @继续丙');else {review=p.text;completeReply(socket,p,'已汇总')}}else pending.set(speaker(p)!,{socket,p})}
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'开始'})
  await vi.waitFor(()=>expect(pending.size).toBe(2))
  await runtime.stopAgent(owner,g.id,b.id)
  expect(admin).toBe(1)
  expect(store.require<WorkspaceConversation>(owner,'conversation',g.id).activeAgentStates?.[c.id]).toBe('running')
  completeReply(pending.get(c.name)!.socket,pending.get(c.name)!.p,'丙完成')
  await finished(root.id)
  expect(review).toContain('interrupted')
  expect(review).toContain('丙完成')
})

it('recovers a partially completed parallel batch after restart without resubmitting members or duplicating review', async () => {
  const a=agent('恢复管理员'),b=agent('恢复乙'),c=agent('恢复丙'),g=store.createGroup(owner,{name:'批次恢复',memberIds:[a.id,b.id,c.id],administratorId:a.id})
  let admin=0;const pending=new Map<string,{socket:WebSocket;p:Record<string,any>}>()
  reply=(socket,p)=>{if(speaker(p)===a.name)completeReply(socket,p,admin++===0?'@恢复乙 @恢复丙':'复核完成');else pending.set(speaker(p)!,{socket,p})}
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'并行执行'})
  await vi.waitFor(()=>expect(pending.size).toBe(2))
  completeReply(pending.get(b.name)!.socket,pending.get(b.name)!.p,'乙已完成')
  const last=pending.get(c.name)!
  recoveryByStored.set(storedByRuntime.get(last.p.session_id)!,[{role:'user',content:last.p.text},{role:'assistant',content:'丙已完成'}])
  last.socket.terminate()
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('uncertain'))
  runtime.close();runtime=new WorkspaceRuntime(store,nodes,uploads);runtime.start()
  await finished(root.id)
  expect(admin).toBe(2)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(4)
  expect(store.list<any>(owner,'turn').filter(t=>t.reviewOf)).toHaveLength(1)
})

it('persists the next delegation when restarted between reply completion and cascade planning', async () => {
  const a=agent('记录管理员'),b=agent('记录成员'),g=store.createGroup(owner,{name:'计划恢复',memberIds:[a.id,b.id],administratorId:a.id})
  let admin=0
  reply=(socket,p)=>completeReply(socket,p,speaker(p)===a.name&&admin++===0?'@记录成员 执行':'完成')
  runtime.onMessage=async()=>{runtime.close()}
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'执行一次'})
  await vi.waitFor(()=>expect(store.list<any>(owner,'turn')[0]?.status).toBe('complete'))
  runtime=new WorkspaceRuntime(store,nodes,uploads);runtime.start()
  await finished(root.id)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(3)
})

it('bounds long context while preserving the task beginning and ending', async () => {
  const a=agent('长上下文'),b=agent('辅助'),g=store.createGroup(owner,{name:'上下文边界',memberIds:[a.id,b.id],administratorId:a.id})
  const text='任务开始标记'+ '文'.repeat(60_000)+'任务结束标记'
  await finished(runtime.send(owner,g.id,{requestId:randomUUID(),content:text}).id)
  const prompt=requests.find(r=>r.method==='prompt.submit')!.params.text
  expect(prompt).toContain('任务开始标记');expect(prompt).toContain('任务结束标记')
  expect(prompt).toContain('保留首尾片段');expect(prompt.length).toBeLessThan(32_000)
})

it('enforces three tasks per group and four globally while preserving queued work', async () => {
  const agents=['并发甲','并发乙','并发丙','并发丁','其他群'].map(n=>agent(n))
  const group=store.createGroup(owner,{name:'并发限制',memberIds:agents.slice(0,4).map(a=>a.id),administratorId:agents[0]!.id,mode:'free',autoReplyIds:agents.slice(0,4).map(a=>a.id),maxReplyRounds:1})
  const pending=new Map<string,{socket:WebSocket;p:Record<string,any>}>()
  reply=(socket,p)=>pending.set(speaker(p)!,{socket,p})
  const one=runtime.send(owner,group.id,{requestId:randomUUID(),content:'并发测试'})
  const two=runtime.send(owner,direct(agents[4]!.id).id,{requestId:randomUUID(),content:'另一群'})
  await vi.waitFor(()=>expect(pending.size).toBe(4))
  expect(Object.keys(store.require<WorkspaceConversation>(owner,'conversation',group.id).activeAgentStates!)).toHaveLength(3)
  expect(store.list<any>(owner,'turn').filter(t=>t.status==='running')).toHaveLength(4)
  const released=[...pending.values()].find(v=>speaker(v.p)!==agents[4]!.name)!
  completeReply(released.socket,released.p,'完成')
  await vi.waitFor(()=>expect(pending.size).toBe(5))
  expect(store.list<any>(owner,'turn').filter(t=>t.status==='running').length).toBeLessThanOrEqual(4)
  for(const v of pending.values()) if(v!==released) completeReply(v.socket,v.p,'完成')
  await finished(one.id);await finished(two.id)
})

it('supports unlimited rounds beyond the finite limit and still permits stopping', async () => {
  const a=agent('不限甲'),b=agent('不限乙'),g=store.createGroup(owner,{name:'不限轮次',memberIds:[a.id,b.id],administratorId:a.id,mode:'free',autoReplyIds:[a.id],maxReplyRounds:-1})
  let count=0
  reply=(socket,p)=>{
    if(count++===0){const work=store.list<any>(owner,'turn').find(t=>t.status==='running')!;work.depth=100;store.put(owner,'turn',work.id,work);completeReply(socket,p,'继续讨论')}
    else completeReply(socket,p,'[[YAOYAO_NO_REPLY_V1]]')
  }
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'@不限乙 开始'})
  await finished(root.id)
  expect(count).toBe(2)
  expect(store.require<WorkspaceRun>(owner,'run',root.id).round).toBe(101)
  expect(()=>store.updateConversation(owner,g.id,{maxReplyRounds:0})).toThrow()
})

it('keeps parallel approval cards scoped to their member and deduplicates replayed requests and answers', async () => {
  const a=agent('审批管理员'),b=agent('审批乙'),c=agent('审批丙'),g=store.createGroup(owner,{name:'并发审批',memberIds:[a.id,b.id,c.id],administratorId:a.id})
  let admin=0
  server.on('connection',socket=>socket.on('message',raw=>{const f=JSON.parse(String(raw));if(f.method==='approval.respond')completeReply(socket,f.params,'已确认')}))
  reply=(socket,p)=>{
    if(speaker(p)===a.name){completeReply(socket,p,admin++===0?'@审批乙 @审批丙':'汇总');return}
    const frame=JSON.stringify({method:'event',params:{type:'approval.request',session_id:p.session_id,payload:{request_id:'same-request',message:'是否继续'}}})
    socket.send(frame);socket.send(frame)
  }
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'开始'})
  await vi.waitFor(()=>expect(store.list<WorkspaceInteraction>(owner,'interaction').filter(i=>!i.resolved)).toHaveLength(2))
  const interactions=store.list<WorkspaceInteraction>(owner,'interaction')
  expect(store.require<WorkspaceConversation>(owner,'conversation',g.id).activeAgentStates).toEqual({[b.id]:'waiting',[c.id]:'waiting'})
  await runtime.respond(owner,interactions[0]!.id,'once')
  await runtime.respond(owner,interactions[0]!.id,'once')
  await expect(runtime.respond(owner,interactions[0]!.id,'deny')).rejects.toThrow('其他答复')
  expect(admin).toBe(1)
  await runtime.respond(owner,interactions[1]!.id,'once')
  await finished(root.id)
  expect(requests.filter(r=>r.method==='approval.respond')).toHaveLength(2)
  expect(admin).toBe(2)
})

it('retries a rolled-back cascade plan without losing or duplicating delegation', async () => {
  const a=agent('事务管理员'),b=agent('事务成员'),g=store.createGroup(owner,{name:'调度事务',memberIds:[a.id,b.id],administratorId:a.id})
  const original=store.put.bind(store);let failed=false,admin=0
  store.put=(user,kind,id,value)=>{if(!failed&&kind==='turn'&&(value as any).agentId===b.id){failed=true;throw new Error('模拟一次写入失败')}original(user,kind,id,value)}
  reply=(socket,p)=>completeReply(socket,p,speaker(p)===a.name&&admin++===0?'@事务成员 继续':'完成')
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'开始'})
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('complete'),{timeout:4000})
  expect(failed).toBe(true)
  expect(store.list<any>(owner,'turn').filter(t=>t.agentId===b.id)).toHaveLength(1)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(3)
})

it('upgrades an admitted v0.3.7 execution without submitting its prompt again', async () => {
  const a=agent('升级执行'),c=direct(a.id)
  reply=(socket,p)=>{recoveryHistory=[{role:'user',content:p.text},{role:'assistant',content:'升级前已完成'}];socket.terminate()}
  const root=runtime.send(owner,c.id,{requestId:randomUUID(),content:'只执行一次'})
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('uncertain'))
  runtime.close()
  const old=store.list<any>(owner,'turn')[0]!
  for(const task of store.list<any>(owner,'turn'))store.remove(owner,'turn',task.id)
  const legacy=store.require<any>(owner,'run',root.id)
  Object.assign(legacy,{queue:[a.id],next:[],hostReturn:false,currentMessageId:old.currentMessageId,turnConfiguration:old.turnConfiguration})
  store.put(owner,'run',root.id,legacy)
  const binding=store.get<any>(owner,'binding',`${c.id}:${a.id}`)!
  delete binding.taskId;store.put(owner,'binding',binding.id,binding)
  runtime=new WorkspaceRuntime(store,nodes,uploads);runtime.start()
  await finished(root.id)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(1)
  expect(store.messages(owner,c.id).at(-1)?.content).toBe('升级前已完成')
})

it('does not read unrelated or orphaned historical runs when projecting a group prompt', async () => {
  const a=agent('上下文隔离'),b=agent('组内成员'),g=store.createGroup(owner,{name:'干净群',memberIds:[a.id,b.id],administratorId:a.id})
  store.put(owner,'run','historical-orphan',{id:'historical-orphan',conversationId:'unrelated-conversation',messageId:'missing-history',mentionIds:[],status:'complete',round:0,createdAt:1,updatedAt:1})
  await finished(runtime.send(owner,g.id,{requestId:randomUUID(),content:'当前群任务'}).id)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(1)
})

it('pages backwards to find a long-running turn marker and never mistakes a tool call for a final answer', async () => {
  const a=agent('分页恢复'),c=direct(a.id)
  reply=(socket,p)=>{
    recoveryHistory=[{role:'user',content:p.text},...Array.from({length:600},()=>({role:'tool',content:'工具结果'})),{role:'assistant',content:'最终结果'}]
    socket.terminate()
  }
  await finished(runtime.send(owner,c.id,{requestId:randomUUID(),content:'长时间执行'}).id)
  expect(store.messages(owner,c.id).at(-1)?.content).toBe('最终结果')
  let submitted=''
  reply=(socket,p)=>{submitted=p.text;recoveryHistory=[{role:'user',content:submitted},{role:'assistant',content:'准备调用工具',tool_calls:[{id:'tool'}]},{role:'tool',content:'工具输出'}];socket.terminate()}
  const root=runtime.send(owner,c.id,{requestId:randomUUID(),content:'不要把过程当结论'})
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('uncertain'))
  await runtime.reconcile(owner,root.id)
  await new Promise(resolve=>setTimeout(resolve,100))
  expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('uncertain')
  recoveryHistory.push({role:'assistant',content:'真正完成'})
  await runtime.reconcile(owner,root.id)
  await finished(root.id)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(2)
})

it('keeps explicit replies visible and emits one notice when the configured cascade limit is reached', async () => {
  const a=agent('轮数管理员'),b=agent('轮数成员'),g=store.createGroup(owner,{name:'有限轮次',memberIds:[a.id,b.id],administratorId:a.id,maxReplyRounds:2})
  reply=(socket,p)=>completeReply(socket,p,speaker(p)===a.name?'@轮数成员 继续':'已完成本步')
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'开始'})
  await finished(root.id)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(3)
  expect(store.messages(owner,g.id).filter(m=>m.content.includes('轮数上限'))).toHaveLength(1)
  store.updateConversation(owner,g.id,{mode:'free',autoReplyIds:[]})
  reply=(socket,p)=>completeReply(socket,p,'[[YAOYAO_NO_REPLY_V1]]')
  await finished(runtime.send(owner,g.id,{requestId:randomUUID(),content:'@轮数成员 显示这个字符串'}).id)
  expect(store.messages(owner,g.id).at(-1)?.content).toBe('[[YAOYAO_NO_REPLY_V1]]')
})

it('retries a failed stop of a live task without falsely completing it or resubmitting work', async () => {
  const a=agent('停止恢复'),c=direct(a.id)
  reply=()=>{}
  const root=runtime.send(owner,c.id,{requestId:randomUUID(),content:'等待停止'})
  await vi.waitFor(()=>expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(1))
  rejectedInterrupts=1
  await runtime.stop(owner,root.id)
  expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('uncertain')
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('interrupted'),{timeout:3000})
  expect(requests.filter(r=>r.method==='session.interrupt')).toHaveLength(2)
  expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(1)
})

it('marks a stopped administrator as interrupted without sending a false completion notification', async () => {
  const a=agent('管理员停止'),b=agent('普通成员'),g=store.createGroup(owner,{name:'停止管理员',memberIds:[a.id,b.id],administratorId:a.id})
  reply=()=>{}
  const notifications: string[]=[]
  runtime.onNotify=(_owner,_c,run)=>notifications.push(run.status)
  const root=runtime.send(owner,g.id,{requestId:randomUUID(),content:'等待'})
  await vi.waitFor(()=>expect(requests.filter(r=>r.method==='prompt.submit')).toHaveLength(1))
  await runtime.stopAgent(owner,g.id,a.id)
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',root.id).status).toBe('interrupted'))
  expect(notifications).toEqual([])
})

it('randomizes old default avatars once while preserving photos, custom v2 settings and direct snapshots',()=>{
  const a=store.createAgent(owner,{name:'旧头像',profile:'default',instructions:'保留规则'})
  const photo='data:image/png;base64,aGVsbG8='
  const b=store.createAgent(owner,{name:'照片',profile:'default',avatar:photo})
  store.put(owner,'agent',a.id,{...a,avatar:'yaoyao-mascot:v1:triangle:ff0000:friendly'})
  store.put(owner,'agent',b.id,{...b,avatar:photo})
  store.db.prepare("DELETE FROM workspace_migrations WHERE id IN ('avatar-v2','avatar-random-default-v1')").run()
  const random=vi.spyOn(Math,'random').mockReturnValue(0)
  const migrated=new WorkspaceStore(home)
  random.mockRestore()
  const next=migrated.require<any>(owner,'agent',a.id)
  expect(next.instructions).toBe('保留规则')
  expect(decodeAgentAvatar(next.avatar)).toMatchObject({avatarMode:'mascot'})
  expect(next.avatar).not.toBe(encodeAgentAvatar(defaultAgentIdentity(a.id,a.name)))
  const image=migrated.require<any>(owner,'agent',b.id)
  expect(decodeAgentAvatar(image.avatar)).toMatchObject({avatarMode:'image',imageDataURL:photo,imageCrop:'rounded'})
  for(const c of migrated.list<WorkspaceConversation>(owner,'conversation')) expect(c.avatar).toBe(migrated.require<any>(owner,'agent',c.memberIds[0]!).avatar)
  const customized=encodeAgentAvatar({...defaultAgentIdentity('bot'),bodyId:'star',expression:'proud',color:'#1488ff'})
  migrated.updateAgent(owner,a.id,{avatar:customized})
  migrated.close()
  const reopened=new WorkspaceStore(home)
  expect(reopened.require<any>(owner,'agent',a.id).avatar).toBe(customized)
  expect(reopened.db.prepare("SELECT count(*) AS count FROM workspace_migrations WHERE id='avatar-random-default-v1'").get()!.count).toBe(1)
  reopened.close()
})

// A member can have a queued follow-up while their current task needs approval.
it('keeps active avatar state ahead of queued work and publishes only recent outcomes', () => {
  const a=agent('状态优先级'), c=direct(a.id), now=Date.now()
  const run: WorkspaceRun={id:'avatar-run',conversationId:c.id,messageId:'unused',mentionIds:[],status:'complete',round:1,createdAt:now,updatedAt:now}
  for (const [id,status] of [['current','waiting'],['next','queued']] as const)
    store.put(owner,'turn',id,{id,conversationId:c.id,agentId:a.id,status,planned:true,updatedAt:now})
  store.put(owner,'turn','result',{id:'result',conversationId:c.id,agentId:a.id,status:'failed',updatedAt:now})
  store.saveRun(owner,run)
  let summary=store.require<WorkspaceConversation>(owner,'conversation',c.id)
  expect(summary.activeAgentStates).toEqual({[a.id]:'waiting'})
  expect(summary.avatarSignals?.[a.id]).toMatchObject({id:'result',state:'failure'})
  store.put(owner,'turn','result',{id:'result',conversationId:c.id,agentId:a.id,status:'complete',updatedAt:now-3000})
  store.saveRun(owner,run)
  expect(store.require<WorkspaceConversation>(owner,'conversation',c.id).avatarSignals).toEqual({})
})

it('queues an unsubmitted turn while computer capacity is unavailable and submits it once after recovery',async()=>{
  const a=agent('等候电脑'),c=direct(a.id),target=nodes.target(owner,'local')
  vi.spyOn(target.session,'request').mockRejectedValueOnce(new HttpError(429,'资源不足','computer_quota'))
  const run=runtime.send(owner,c.id,{requestId:randomUUID(),content:'等待资源后执行'})
  await vi.waitFor(()=>expect(store.list<any>(owner,'turn').find(work=>work.runId===run.id)?.resourceWait).toBe(true))
  expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('queued')
  await vi.waitFor(()=>expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('complete'),{timeout:5000})
  expect(requests.filter(request=>request.method==='prompt.submit')).toHaveLength(1)
})

it('forwards a generated artifact to a new task without changing its original provenance',async()=>{
  const a=agent('产物接收者'),c=direct(a.id)
  const first=runtime.send(owner,c.id,{requestId:randomUUID(),content:'first'})
  await finished(first.id)
  const message=store.messages(owner,c.id).find(message=>message.role==='assistant')!
  const assets=new WorkspaceAssets(store,nodes,home)
  const file=assets.publish(owner,message,a,'review.txt',Buffer.from('verified artifact'))
  const sent=runtime.dispatch(owner,c.id,{requestId:randomUUID(),content:'复核附件',fileIds:[file.id]},{agentId:a.id,kind:'task_review'})
  await finished(sent.id)
  const attached=requests.find(request=>request.method==='file.attach')!
  expect(Buffer.from(attached.params.data_url.split(',')[1],'base64').toString()).toBe('verified artifact')
  expect(store.require<any>(owner,'file',file.id).messageId).toBe(message.id)
  expect(store.require<WorkspaceMessage>(owner,'message',sent.messageId).attachments.map(file=>file.id)).toEqual([file.id])
  assets.close()
})
