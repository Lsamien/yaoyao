// @vitest-environment node
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import type Koa from 'koa'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { LocalAuthStore, type LocalUser } from '../../src/server/localAuth'
import { WorkspaceAssets } from '../../src/server/workspaceAssets'
import { WorkspaceTranscriptStore } from '../../src/client/components/workspace/transcriptStore'
import { SharedComputers, type SharedComputer } from '../../src/server/sharedComputers'
import type { WorkspaceAgent, WorkspaceConversation } from '../../src/shared/workspace'

let home: string, runtime: ApplicationRuntime, cookie: string, csrf: string, upstream: string[], bridgeReady: boolean
const first: LocalUser = {
  id: 'first',
  username: 'first',
  role: 'admin',
  enabled: true,
  mustChangePassword: false,
  createdAt: 1,
  updatedAt: 1,
}
class TestAuth extends LocalAuthStore {
  override current(ctx: Koa.Context) {
    return this.require(ctx)
  }
  override require(ctx: Koa.Context) {
    return { ...first, id: ctx.get('x-test-user') || 'first' }
  }
  override requireAdmin(ctx: Koa.Context) {
    return this.require(ctx)
  }
  override canUseSource() { return true }
  override currentFromCookieHeader() {
    return first
  }
  override isUserActive() {
    return true
  }
}
function req(method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, user = 'first') {
  return request(runtime.app.callback())
    [method](path)
    .set('Host', '127.0.0.1:15300')
    .set('Origin', 'http://127.0.0.1:15300')
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('x-test-user', user)
}
function shareComputer(...agents: WorkspaceAgent[]): SharedComputer {
  const store = runtime.workspace
  const shared = new SharedComputers(store, runtime.auth, runtime.workspaceRuntime.nodes, runtime.runners)
  for (const agent of agents) {
    shared.attachLocalVm('first', agent, 'fixture-runner')
    store.put('first', 'agent', agent.id, agent)
  }
  return store.require('first', 'shared-computer', agents[0]!.computerEnvironmentId!)
}
it('serves file-backed project and memory CRUD with revisions and account isolation', async () => {
  const a = runtime.workspace.createAgent('first', { name: '记忆甲', profile: 'default' })
  const b = runtime.workspace.createAgent('first', { name: '记忆乙', profile: 'default' })
  const group = runtime.workspace.createGroup('first', { name: '项目群', memberIds: [a.id, b.id], collaborationMode: 'discussion' })
  const project = await req('post', '/api/app/workspace/projects').send({ requestId: randomUUID(), name: '项目', description: '多群共享', memberIds: [a.id, b.id], groupIds: [group.id] }).expect(200)
  const id = project.body.project.id
  const created = await req('post', '/api/app/workspace/memories').send({ requestId: randomUUID(), scope: 'project', projectId: id, agentId: a.id, content: '接口兼容旧版本', tier: 'profile' }).expect(200)
  const memory = created.body.memory
  expect((await req('get', `/api/app/workspace/memories?scope=project&projectId=${id}`).expect(200)).body.memories).toHaveLength(1)
  await req('post', '/api/app/workspace/memories').send({ requestId: randomUUID(), scope: 'project', projectId: id, agentId: a.id, id: memory.id, expectedRevision: 0, content: '旧版本修改', tier: 'profile' }).expect(400)
  expect((await req('get', `/api/app/workspace/memories/${memory.id}/revisions?scope=project&agentId=${a.id}&projectId=${id}`).expect(200)).body.revisions).toHaveLength(1)
  expect((await req('get', '/api/app/workspace/projects', 'second').expect(200)).body.projects).toEqual([])
  expect((await req('get', `/api/app/workspace/memory-export?scope=project&projectId=${id}`).expect(200)).text).toContain('接口兼容旧版本')
  await req('post', '/api/app/workspace/memories/forget').send({ requestId: randomUUID(), scope: 'project', projectId: id, agentId: a.id, id: memory.id, expectedRevision: 1 }).expect(200)
  expect((await req('get', `/api/app/workspace/memories?scope=project&projectId=${id}`).expect(200)).body.memories).toEqual([])
})
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-workspace-routes-'))
  upstream = []
  bridgeReady = false
  const config = loadServerConfig({
    HERMES_YAOYAO_HOME: home,
    HERMES_YAOYAO_UPSTREAM: 'http://127.0.0.1:19119',
    HERMES_YAOYAO_ALLOWED_HOSTS: '127.0.0.1,localhost',
  })
  runtime = createApplication({
    config,
    auth: new TestAuth(home, false),
    fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname
      upstream.push(path)
      const body =
        path === '/api/plugins/yaoyao-bot-bridge/capabilities' && bridgeReady
          ? {version:1,ready:true,in_process:true,native_tools:true}
          : path === '/api/pair/v1/capabilities'
          ? {protocolVersion:1,serviceType:'yaoyao-web',nodeId:'11111111-1111-4111-8111-111111111111',fingerprint:'f'.repeat(64)}
          : path === '/api/pair/v1/claim'
          ? {protocolVersion:1,serviceType:'yaoyao-web',nodeId:'11111111-1111-4111-8111-111111111111',fingerprint:'f'.repeat(64),deviceId:'22222222-2222-4222-8222-222222222222',token:'delegated-token',scopes:['agents.read','sessions.execute','history.read'],serverUrl:'http://child.test:15300/node/22222222-2222-4222-8222-222222222222'}
          : path === '/api/status'
          ? { auth_required: true }
          : path === '/api/auth/me'
            ? { user_id: 'upstream' }
            : path.endsWith('/api/profiles')
              ? { profiles: [{ name: 'default', display_name: '基础 Agent' }] }
              : { ok: true }
      return new Response(JSON.stringify(body), {
        status: path.includes('/plugins/') && !bridgeReady ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch,
  })
  const b = await request(runtime.app.callback())
    .get('/api/app/bootstrap')
    .set('Host', '127.0.0.1:15300')
    .expect(200)
  cookie = (b.headers['set-cookie'] as unknown as string[]).map((v) => v.split(';')[0]).join('; ')
  csrf = b.body.csrfToken
})
afterEach(() => {
  runtime.close()
  rmSync(home, { recursive: true, force: true })
})
describe('application workspace HTTP contract', () => {
  it.each(['empty', 'existing'] as const)('serves a complete %s Bot snapshot before any Runner or virtual machine is created', async state => {
    const store = runtime.workspace
    expect(runtime.runners.records()).toEqual([])
    expect(store.list('first', 'shared-computer')).toEqual([])
    let conversation: WorkspaceConversation | undefined
    if (state === 'existing') {
      store.createAgent('first', { name: '尚未配置电脑的 Bot', profile: 'default' })
      conversation = store.list<WorkspaceConversation>('first', 'conversation')[0]!
      store.saveMessage('first', { id: randomUUID(), conversationId: conversation.id, seq: 0, role: 'assistant',
        content: '没有虚拟机也能读取聊天记录', reasoning: '', status: 'complete', tools: [], attachments: [], createdAt: Date.now() })
    }
    const requestsBeforeSnapshot = [...upstream]
    const response = await req('get', '/api/app/workspace/snapshot').expect(200).expect('Content-Type', /json/)
    const snapshot = response.body
    expect(Number.isSafeInteger(snapshot.cursor)).toBe(true)
    expect(snapshot.cursor).toBeGreaterThanOrEqual(0)
    for (const key of ['agents', 'conversations', 'details', 'projects']) expect(Array.isArray(snapshot[key])).toBe(true)
    const client = new WorkspaceTranscriptStore()
    expect(() => client.hydrate(snapshot)).not.toThrow()
    expect(client.cursor).toBe(snapshot.cursor)
    if (conversation) {
      expect(client.conversations.map(row => row.id)).toEqual([conversation.id])
      expect(client.get(conversation.id)?.messages.map(message => message.content)).toEqual(['没有虚拟机也能读取聊天记录'])
    } else {
      expect(snapshot).toMatchObject({ cursor: 0, agents: [], conversations: [], details: [] })
    }
    expect(runtime.runners.records()).toEqual([])
    expect(store.list('first', 'shared-computer')).toEqual([])
    expect(upstream).toEqual(requestsBeforeSnapshot)
  })
  it('does not advertise retired remote Bot references and preserves their existing history', async () => {
    const store = runtime.workspace
    const agent = store.createAgent('first', { name: '历史远程 Bot', profile: 'default' })
    store.put('first', 'agent', agent.id, { ...agent, remoteAgentId: randomUUID() })
    const conversation = store.list<import('../../src/shared/workspace').WorkspaceConversation>('first', 'conversation')[0]!
    store.saveMessage('first', { id: randomUUID(), conversationId: conversation.id, seq: 0, role: 'assistant', content: '保留历史回复', reasoning: '', status: 'complete', tools: [], attachments: [], createdAt: Date.now() })
    const capabilities = (await req('get', '/api/app/capabilities').expect(200)).body.features
    expect(capabilities).not.toContain('remoteAgentReferences')
    expect((await req('get', `/api/app/nodes/${randomUUID()}/agents`).expect(410)).body.code).toBe('remote_agent_removed')
    expect((await req('post', '/api/app/agents/remote').send({ nodeId: randomUUID(), agentId: randomUUID() }).expect(410)).body.code).toBe('remote_agent_removed')
    expect((await req('get', `/api/app/conversations/${conversation.id}`).expect(200)).body.messages.some((message: { content: string }) => message.content === '保留历史回复')).toBe(true)
    expect(store.get('first', 'agent', agent.id)).toBeDefined()
  })
  it('uses the same ordering for snapshots, list refreshes and pin/message events', async () => {
    const store = runtime.workspace
    store.createAgent('first', { name: '排序验证', profile: 'default' })
    const base = store.list<import('../../src/shared/workspace').WorkspaceConversation>('first', 'conversation')[0]!
    store.remove('first', 'conversation', base.id)
    for (const item of [
      { id: 'a-old', lastMessageAt: 100, pinned: false },
      { id: 'b-new', lastMessageAt: 200, pinned: false },
      { id: 'z-pin', lastMessageAt: 50, pinned: true },
    ]) store.put('first', 'conversation', item.id, { ...base, ...item })
    const snapshot = (await req('get', '/api/app/workspace/snapshot').expect(200)).body
    const list = (await req('get', '/api/app/conversations').expect(200)).body.conversations
    expect(snapshot.conversations.map((c: { id: string }) => c.id)).toEqual(['z-pin', 'b-new', 'a-old'])
    expect(list.map((c: { id: string }) => c.id)).toEqual(snapshot.conversations.map((c: { id: string }) => c.id))
    const clients = [new WorkspaceTranscriptStore(), new WorkspaceTranscriptStore()]
    clients.forEach(client => client.hydrate(snapshot))
    const stop = store.observe((owner, event) => { if (owner === 'first') clients.forEach(client => client.apply(event)) })
    try {
      store.saveMessage('first', { id: randomUUID(), conversationId: 'a-old', seq: 0, role: 'assistant',
        content: '新的回复', reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: 300 })
      clients.forEach(client => expect(client.conversations.map(c => c.id)).toEqual(['z-pin', 'a-old', 'b-new']))
      await req('patch', '/api/app/conversations/a-old').send({ pinned: true }).expect(200)
      const expected = ['a-old', 'z-pin', 'b-new']
      clients.forEach(client => expect(client.conversations.map(c => c.id)).toEqual(expected))
      expect((await req('get', '/api/app/workspace/snapshot').expect(200)).body.conversations.map((c: { id: string }) => c.id)).toEqual(expected)
      expect((await req('get', '/api/app/conversations').expect(200)).body.conversations.map((c: { id: string }) => c.id)).toEqual(expected)
    } finally { stop() }
  })

  it.each(['direct', 'group'] as const)('uses versioned unread acknowledgments for %s without recounting history', async kind => {
    const store = runtime.workspace
    const first = store.createAgent('first', { name: '未读甲', profile: 'default' })
    const second = store.createAgent('first', { name: '未读乙', profile: 'default' })
    const conversation = kind === 'group'
      ? store.createGroup('first', { name: '未读群', memberIds: [first.id, second.id], administratorId: first.id })
      : store.list<any>('first', 'conversation').find(c => c.memberIds[0] === first.id)
    const task = kind === 'group' ? store.tasks('first', conversation.id)[0] : undefined
    const message: import('../../src/shared/workspace').WorkspaceMessage = { id: randomUUID(), conversationId: conversation.id, conversationTaskId: task?.id,
      seq: 0, role: 'assistant', content: '进行中', reasoning: '', status: 'streaming', attachments: [], tools: [], createdAt: Date.now() }
    store.saveMessage('first', message)
    const snapshot = (await req('get', `/api/app/conversations/${conversation.id}`).expect(200)).body
    const read = snapshot.task ?? snapshot.conversation
    expect(read.unread).toBe(false)
    message.status = 'complete'; message.content = '已完成'; store.saveMessage('first', message)
    const path = `/api/app/conversations/${conversation.id}${task ? `/tasks/${task.id}` : ''}/read`
    const display = vi.spyOn(store, 'messageForDisplay')
    const stale = (await req('put', path).send({ seq: read.lastSeq, unreadVersion: read.unreadVersion }).expect(200)).body
    expect(stale.conversation.unread).toBe(true)
    const current = stale.task ?? stale.conversation
    const acknowledged = (await req('put', path).send({ seq: current.lastSeq, unreadVersion: current.unreadVersion }).expect(200)).body
    expect(acknowledged.conversation).toMatchObject({ unread: false, unreadCount: 0 })
    expect(display).not.toHaveBeenCalled()
    await req('put', path, 'foreign').send({ seq: current.lastSeq, unreadVersion: current.unreadVersion }).expect(404)
    await req('put', path).send({ seq: current.lastSeq, unreadVersion: -1 }).expect(400)
    display.mockRestore()
  })
  it.each(['archive', 'delete'] as const)('%s removes a confirmed ordinary member from all groups atomically', async action => {
    const store = runtime.workspace
    const lead = store.createAgent('first', { name: '管理者', profile: 'default' })
    const bot = store.createAgent('first', { name: '待处理成员', profile: 'default' })
    const direct = store.list<any>('first', 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === bot.id)
    const group = store.createGroup('first', { name: '设计群', memberIds: [lead.id, bot.id], administratorId: lead.id, autoReplyIds: [bot.id], memberRoles: { [bot.id]: { name: '设计', description: '' } } })
    const oldGroup = store.createGroup('first', { name: '旧群', memberIds: [lead.id, bot.id], administratorId: lead.id })
    store.updateConversation('first', oldGroup.id, { archived: true })
    const path = `/api/app/conversations/${direct.id}/lifecycle`
    const preview = (await req('get', path).expect(200)).body
    expect(preview.groups).toEqual(expect.arrayContaining([{ id: group.id, name: '设计群', administrator: false }, { id: oldGroup.id, name: '旧群', administrator: false }]))
    await req('post', path).send({ action }).expect(409)
    expect((await req('patch', `/api/app/agents/${bot.id}`).send({ archived: true }).expect(409)).body.code).toBe('agent_in_group')
    await req('get', path, 'foreign').expect(404)
    await req('post', path, 'foreign').send({ action, confirmationToken: preview.confirmationToken }).expect(404)
    await req('post', path).set('X-CSRF-Token', 'invalid').send({ action, confirmationToken: preview.confirmationToken }).expect(403)
    await req('post', path).send({ action, confirmationToken: preview.confirmationToken }).expect(200)
    expect(store.require<any>('first', 'conversation', group.id)).toMatchObject({ memberIds: [lead.id], autoReplyIds: [], memberRoles: {}, administratorId: lead.id })
    expect(store.require<any>('first', 'conversation', oldGroup.id).memberIds).toEqual([lead.id])
    if (action === 'delete') {
      expect(store.get('first', 'agent', bot.id)).toBeUndefined()
      expect(store.get('first', 'conversation', direct.id)).toBeUndefined()
    } else {
      expect(store.require<any>('first', 'agent', bot.id).archived).toBe(true)
      await req('post', path).send({ action: 'restore' }).expect(200)
      expect(store.require<any>('first', 'conversation', direct.id).archived).toBe(false)
      expect(store.require<any>('first', 'conversation', group.id).memberIds).toEqual([lead.id])
    }
    expect(store.get('first', 'agent', lead.id)).toBeDefined()
  })
  it.each(['archive', 'delete'] as const)('blocks %s for a group administrator without removing other memberships', async action => {
    const store = runtime.workspace
    const bot = store.createAgent('first', { name: '群管理者', profile: 'default' })
    const other = store.createAgent('first', { name: '其他成员', profile: 'default' })
    const direct = store.list<any>('first', 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === bot.id)
    const regular = store.createGroup('first', { name: '普通群', memberIds: [bot.id, other.id], administratorId: other.id })
    const managed = store.createGroup('first', { name: '管理群', memberIds: [bot.id, other.id], administratorId: bot.id })
    const path = `/api/app/conversations/${direct.id}/lifecycle`
    const preview = (await req('get', path).expect(200)).body
    const cursor = store.cursor('first')
    const result = await req('post', path).send({ action, confirmationToken: preview.confirmationToken }).expect(409)
    expect(result.body.code).toBe('agent_group_administrator')
    expect(result.body.error).toContain('管理群')
    expect(store.require<any>('first', 'conversation', regular.id).memberIds).toContain(bot.id)
    expect(store.require<any>('first', 'conversation', managed.id).administratorId).toBe(bot.id)
    expect(store.require<any>('first', 'agent', bot.id).archived).toBe(false)
    expect(store.cursor('first')).toBe(cursor)
  })
  it.each(['archive', 'delete'] as const)('%s detaches only the selected Bot from its automatic shared computer', async action => {
    const store = runtime.workspace
    const bot = store.createAgent('first', { name: '待移除共享成员', profile: 'default' })
    const other = store.createAgent('first', { name: '继续使用电脑', profile: 'default' })
    const shared = shareComputer(bot, other)
    const otherBefore = store.require('first', 'agent', other.id)
    const direct = store.list<any>('first', 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === bot.id)
    const path = `/api/app/conversations/${direct.id}/lifecycle`
    const preview = (await req('get', path).expect(200)).body
    // Another member's running task must not prevent removing this idle Bot.
    store.put('first', 'turn', 'other-running', { id: 'other-running', agentId: other.id, status: 'running' })
    await req('post', path).send({ action, confirmationToken: preview.confirmationToken }).expect(200)
    expect(store.require('first', 'shared-computer', shared.id)).toEqual({ ...shared, memberIds: [other.id] })
    expect(store.require('first', 'agent', other.id)).toEqual(otherBefore)
    if (action === 'delete') expect(store.get('first', 'agent', bot.id)).toBeUndefined()
    else {
      const archived = store.require<WorkspaceAgent>('first', 'agent', bot.id)
      expect(archived.archived).toBe(true)
      expect(archived.computerEnvironmentId).toBeUndefined()
      expect(archived.computerEnvironmentName).toBeUndefined()
    }
    store.remove('first', 'turn', 'other-running')
  })
  it('keeps shared membership intact while the Bot is busy or its computer is under human control', async () => {
    const store = runtime.workspace
    const bot = store.createAgent('first', { name: '电脑成员', profile: 'default' })
    const shared = shareComputer(bot)
    const direct = store.list<any>('first', 'conversation').find(c => c.memberIds[0] === bot.id)
    const path = `/api/app/conversations/${direct.id}/lifecycle`
    const preview = (await req('get', path).expect(200)).body
    for (const status of ['queued', 'running', 'waiting', 'uncertain', 'cancelling']) {
      store.put('first', 'turn', 'busy', { id: 'busy', agentId: bot.id, status })
      expect((await req('post', path).send({ action: 'delete', confirmationToken: preview.confirmationToken }).expect(409)).body.code).toBe('agent_running')
    }
    store.remove('first', 'turn', 'busy')
    store.put('_system', 'computer-control', 'human', { owner: 'first', agentId: randomUUID(), environmentId: shared.id, expiresAt: Date.now() + 30_000 })
    expect((await req('post', path).send({ action: 'delete', confirmationToken: preview.confirmationToken }).expect(409)).body.code).toBe('agent_execution_busy')
    expect(store.require('first', 'shared-computer', shared.id)).toEqual(shared)
    expect(store.require('first', 'agent', bot.id)).toEqual(bot)
    store.remove('_system', 'computer-control', 'human')
    await req('patch', `/api/app/agents/${bot.id}`).send({ archived: true }).expect(200)
    expect(store.require('first', 'shared-computer', shared.id)).toMatchObject({ archived: true, memberIds: [] })
    expect(store.require<WorkspaceAgent>('first', 'agent', bot.id).computerEnvironmentId).toBeUndefined()
  })
  it.each(['manual', 'compose', 'missing'] as const)('deletes a legacy archived Bot with a %s computer binding', async mode => {
    const store = runtime.workspace
    const bot = store.createAgent('first', { name: '旧版归档成员', profile: 'default' })
    const shared = shareComputer(bot)
    const direct = store.list<any>('first', 'conversation').find(c => c.memberIds[0] === bot.id)
    store.put('first', 'agent', bot.id, { ...bot, archived: true })
    store.put('first', 'conversation', direct.id, { ...direct, archived: true })
    if (mode === 'missing') store.remove('first', 'shared-computer', shared.id)
    else store.put('first', 'shared-computer', shared.id, { ...shared, managedLocalVm: undefined, managedCompose: mode === 'compose' })
    await req('delete', `/api/app/agents/${bot.id}`).expect(200)
    expect(store.get('first', 'agent', bot.id)).toBeUndefined()
    expect(store.get('first', 'conversation', direct.id)).toBeUndefined()
    if (mode !== 'missing') expect(store.require('first', 'shared-computer', shared.id)).toMatchObject({ archived: true, memberIds: [] })
  })
  it('rejects a stale group confirmation and rolls back membership on a later deletion failure', async () => {
    const store = runtime.workspace
    const lead = store.createAgent('first', { name: '负责人', profile: 'default' })
    const bot = store.createAgent('first', { name: '成员', profile: 'default' })
    const shared = shareComputer(bot, lead)
    const direct = store.list<any>('first', 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === bot.id)
    const path = `/api/app/conversations/${direct.id}/lifecycle`
    const old = (await req('get', path).expect(200)).body
    const group = store.createGroup('first', { name: '后来加入的群', memberIds: [lead.id, bot.id], administratorId: lead.id })
    expect((await req('post', path).send({ action: 'delete', confirmationToken: old.confirmationToken }).expect(409)).body.code).toBe('lifecycle_confirmation_stale')
    const current = (await req('get', path).expect(200)).body
    store.put('first', 'turn', 'pending', { id: 'pending', agentId: bot.id, conversationId: group.id, status: 'uncertain' })
    await req('post', path).send({ action: 'archive', confirmationToken: current.confirmationToken }).expect(409)
    store.remove('first', 'turn', 'pending')
    const cursor = store.cursor('first')
    const failure = vi.spyOn(store, 'deleteAgent').mockImplementation(() => { throw new Error('模拟写入失败') })
    await req('post', path).send({ action: 'delete', confirmationToken: current.confirmationToken }).expect(500)
    failure.mockRestore()
    expect(store.require<any>('first', 'conversation', group.id).memberIds).toContain(bot.id)
    expect(store.require<any>('first', 'agent', bot.id).archived).toBe(false)
    expect(store.require<any>('first', 'conversation', direct.id).archived).toBe(false)
    expect(store.require('first', 'shared-computer', shared.id)).toEqual(shared)
    expect(store.require<WorkspaceAgent>('first', 'agent', bot.id).computerEnvironmentId).toBe(shared.id)
    expect(store.cursor('first')).toBe(cursor)
  })
  it('deletes an unarchived group while preserving its member Bots', async () => {
    const store = runtime.workspace
    const a = store.createAgent('first', { name: '甲', profile: 'default' }), b = store.createAgent('first', { name: '乙', profile: 'default' })
    const group = store.createGroup('first', { name: '待删除群', memberIds: [a.id, b.id], administratorId: a.id })
    const path = `/api/app/conversations/${group.id}/lifecycle`
    const preview = (await req('get', path).expect(200)).body
    await req('post', path).send({ action: 'delete', confirmationToken: preview.confirmationToken }).expect(200)
    expect(store.get('first', 'conversation', group.id)).toBeUndefined()
    expect(store.get('first', 'agent', a.id)).toBeDefined()
    expect(store.get('first', 'agent', b.id)).toBeDefined()
  })
  it('deletes only archived owned chats, clears their records, and preserves library files and members', async () => {
    const store = runtime.workspace
    const lead = store.createAgent('first', { name: '负责人', profile: 'default' })
    const member = store.createAgent('first', { name: '成员', profile: 'default' })
    const group = store.createGroup('first', { name: '待删除群聊', memberIds: [lead.id, member.id], administratorId: lead.id })
    const task = store.tasks('first', group.id)[0]!
    const path = `/api/app/conversations/${group.id}`
    await req('delete', path).expect(409)
    store.updateConversation('first', group.id, { archived: true })
    store.put('second', 'conversation', group.id, group)
    for (const kind of ['message', 'run', 'turn', 'interaction', 'interaction-binding', 'binding', 'assignment']) {
      store.put('first', kind, kind, { id: kind, conversationId: group.id, conversationTaskId: task.id, status: 'complete' })
      store.put('second', kind, kind, { id: kind, conversationId: group.id })
    }
    store.put('first', 'context', task.id, { used: 5 })
    const bindingKey = `${group.id}:${task.id}:${lead.id}`
    store.put('first', 'binding', bindingKey, { conversationTaskId: task.id, sessionId: 'session' })
    store.put('first', 'interaction-binding', 'legacy-interaction', { key: bindingKey, taskId: 'turn' })
    store.put('second', 'binding', bindingKey, { sessionId: 'other-session' })
    store.put('first', 'file', 'file', { id: 'file', conversationId: group.id, messageId: 'message', name: '保留.txt' })
    await req('delete', path, 'third').expect(404)
    await req('delete', path).set('X-CSRF-Token', 'invalid').expect(403)
    await req('delete', path).expect(200)
    await req('get', path).expect(404)
    expect(store.get('first', 'context', task.id)).toBeUndefined()
    expect(store.get('first', 'conversation-task', task.id)).toBeUndefined()
    expect(store.list('first', 'message')).toEqual([])
    expect(store.list('first', 'run')).toEqual([])
    expect(store.list('first', 'binding')).toEqual([])
    expect(store.list('first', 'interaction-binding')).toEqual([])
    expect(store.get('second', 'binding', bindingKey)).toEqual({ sessionId: 'other-session' })
    expect(store.get('first', 'file', 'file')).toEqual({ id: 'file', name: '保留.txt' })
    expect(store.list('first', 'agent')).toHaveLength(2)
    expect(store.get('second', 'conversation', group.id)).toEqual(group)
    expect(store.get('second', 'message', 'message')).toBeDefined()
    expect((await req('get', '/api/app/events')).body.events.some((e: any) => e.type === 'conversation.deleted' && e.conversationId === group.id)).toBe(true)
  })
  it('deletes an archived Bot and its direct chat only after group references are removed', async () => {
    const store = runtime.workspace
    const bot = store.createAgent('first', { name: '归档 Bot', profile: 'default' })
    const member = store.createAgent('first', { name: '成员', profile: 'default' })
    const direct = store.list<any>('first', 'conversation').find(c => c.memberIds[0] === bot.id)!
    const group = store.createGroup('first', { name: '关联群', memberIds: [bot.id, member.id], administratorId: member.id })
    const path = `/api/app/agents/${bot.id}`
    await req('delete', path).expect(409)
    store.updateAgent('first', bot.id, { archived: true })
    await req('delete', `/api/app/conversations/${direct.id}`).expect(400)
    expect((await req('delete', path).expect(409)).body.code).toBe('agent_in_group')
    expect(store.get('first', 'agent', bot.id)).toBeDefined()
    store.updateConversation('first', group.id, { memberIds: [member.id] })
    await req('delete', path, 'second').expect(404)
    await req('delete', path).expect(200)
    expect(store.get('first', 'agent', bot.id)).toBeUndefined()
    expect(store.get('first', 'conversation', direct.id)).toBeUndefined()
    expect(store.get('first', 'conversation', group.id)).toBeDefined()
    expect(store.get('first', 'agent', member.id)).toBeDefined()
  })
  it('keeps archived chats intact while runs or delegated goals are unresolved', async () => {
    const store = runtime.workspace
    const bot = store.createAgent('first', { name: '运行中', profile: 'default' })
    const direct = store.list<any>('first', 'conversation')[0]!
    store.updateAgent('first', bot.id, { archived: true })
    store.put('first', 'run', 'pending', { id: 'pending', conversationId: direct.id, status: 'uncertain' })
    const path = `/api/app/agents/${bot.id}`
    await req('delete', path).expect(409)
    expect(store.get('first', 'conversation', direct.id)).toBeDefined()
    store.remove('first', 'run', 'pending')
    store.put('first', 'goal', 'delegated', { id: 'delegated', conversationId: 'another-chat', origin: { conversationId: direct.id }, status: 'waiting' })
    await req('delete', path).expect(409)
    expect(store.get('first', 'agent', bot.id)).toBeDefined()
  })
  it('resumes a stopped goal from a real user request without duplicating its run',async()=>{
    vi.spyOn(runtime.workspaceRuntime,'wake').mockImplementation(()=>{})
    vi.spyOn(runtime.workspaceRuntime.teamTools,'requireAvailable').mockResolvedValue()
    const lead=runtime.workspace.createAgent('first',{name:'任务负责人',profile:'default',canManageTeam:true})
    const member=runtime.workspace.createAgent('first',{name:'成员',profile:'default'})
    const source=runtime.workspace.list<any>('first','conversation').find(c=>c.kind==='direct'&&c.memberIds[0]===lead.id)!
    const original=runtime.workspaceRuntime.send('first',source.id,{requestId:randomUUID(),content:'完成任务'})
    const team=runtime.workspace.createGroup('first',{name:'任务组',memberIds:[lead.id,member.id],administratorId:lead.id})
    const task=runtime.workspace.tasks('first',team.id)[0]!
    runtime.workspaceRuntime.tasks.begin('first',task,lead,'完成任务',{conversationId:source.id,runId:original.id,agentId:lead.id})
    await req('post',`/api/app/conversations/${team.id}/tasks/${task.id}/stop`).send({}).expect(200)
    const input={requestId:randomUUID()}
    const resumed=await req('post',`/api/app/conversations/${team.id}/tasks/${task.id}/resume`).send(input).expect(200)
    expect(resumed.body.goal.status).toBe('running')
    const repeated=await req('post',`/api/app/conversations/${team.id}/tasks/${task.id}/resume`).send(input).expect(200)
    expect(repeated.body.run.id).toBe(resumed.body.run.id)
    await req('post',`/api/app/conversations/${team.id}/tasks/${task.id}/resume`,'second').send({requestId:randomUUID()}).expect(404)
  })
  it('starts an explicit delivery and lets only its owner edit versioned acceptance criteria',async()=>{
    vi.spyOn(runtime.workspaceRuntime,'wake').mockImplementation(()=>{})
    vi.spyOn(runtime.workspaceRuntime.teamTools,'requireAvailable').mockResolvedValue()
    const lead=runtime.workspace.createAgent('first',{name:'负责人',profile:'default',canManageTeam:true})
    const member=runtime.workspace.createAgent('first',{name:'成员',profile:'default'})
    const team=runtime.workspace.createGroup('first',{name:'交付群',memberIds:[lead.id,member.id],administratorId:lead.id})
    const task=runtime.workspace.tasks('first',team.id)[0]!
    const path=`/api/app/conversations/${team.id}`
    const input={requestId:randomUUID(),taskId:task.id,content:'完成并交付报告',mode:'goal'}
    const sent=await req('post',`${path}/messages`).send(input).expect(202)
    expect(sent.body.run.goalId).toBe(task.id)
    expect((await req('post',`${path}/messages`).send(input).expect(202)).body.run.id).toBe(sent.body.run.id)
    expect((await req('get',`${path}/tasks/${task.id}/plan`).expect(200)).body.assignments).toEqual([])
    const update={requestId:randomUUID(),expectedRevision:1,acceptanceCriteria:['包含三种方案的比较']}
    const edited=await req('patch',`${path}/tasks/${task.id}/plan`).send(update).expect(200)
    expect(edited.body.goal).toMatchObject({acceptanceRevision:2,acceptanceCriteria:update.acceptanceCriteria})
    await req('patch',`${path}/tasks/${task.id}/plan`,'second').send({...update,requestId:randomUUID()}).expect(404)
    expect((await req('patch',`${path}/tasks/${task.id}/plan`).send({...update,requestId:randomUUID()}).expect(409)).body.code).toBe('goal_criteria_changed')
  })
  it('creates a bot with team tools on by default and does not require the bridge', async () => {
    bridgeReady = false
    const created = await req('post','/api/app/agents').send({name:'老板',profile:'default'})
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const agent = created.body.agent
    expect(agent.canManageTeam).toBe(true)
    await req('patch',`/api/app/agents/${agent.id}`,'second').send({name:'别人改的'}).expect(404)
    expect((await req('get','/api/app/agents')).body.agents[0].canManageTeam).toBe(true)
  })
  it('accepts only child pairing, hides credentials, and scopes address edits to the owner', async () => {
    const code = new URL('yaoyao://pair')
    for (const [key,value] of Object.entries({v:'1',url:'http://child.test:15300',node:'11111111-1111-4111-8111-111111111111',id:'33333333-3333-4333-8333-333333333333',fingerprint:'f'.repeat(64),secret:'s'.repeat(64)})) code.searchParams.set(key,value)
    await req('post','/api/app/nodes').send({name:'legacy',url:'http://child.test:9119',username:'user',password:'password'}).expect(400)
    await req('post','/api/app/nodes').send({name:'child',qrPayload:code.href.replace('://pair','://login')}).expect(400)
    await req('post','/api/app/nodes').send({name:'child',qrPayload:code.href}).expect(201)
    const listing=await req('get','/api/app/nodes').expect(200), node=listing.body.nodes[0]
    expect(node.transport).toBe('paired-web'); expect(JSON.stringify(listing.body)).not.toContain('delegated-token'); expect(node.secret).toBeUndefined()
    expect((await req('get','/api/app/nodes','second').expect(200)).body.nodes).toEqual([])
    await req('patch',`/api/app/nodes/${node.id}`,'second').send({name:'other',url:'http://new-ip.test:15300'}).expect(404)
    await req('patch',`/api/app/nodes/${node.id}`).send({name:'new name',url:'http://new-ip.test:15300'}).expect(200)
    const updated=(await req('get','/api/app/nodes').expect(200)).body.nodes[0]
    expect(updated.id).toBe(node.id); expect(updated.url).toBe('http://new-ip.test:15300/')
    const sources=(await req('get','/api/app/agents/sources').expect(200)).body.sources
    // Pairing still manages the node; retired remote Profiles are not Bot sources.
    expect(sources.some((s:any)=>s.nodeId===node.id)).toBe(false)
  })

  it('archives native-chat uploads through the standard file API with user ownership', async () => {
    const assets = new WorkspaceAssets(runtime.workspace, runtime.workspaceRuntime.nodes, home)
    await assets.archiveText(
      'first',
      '{"path":"/tmp/native-upload.txt"}',
      'local',
      'default',
      'native-session',
      'native-message',
      'user',
    )
    const page = await req('get', '/api/app/files').expect(200)
    expect(page.body.items[0]).toMatchObject({
      name: 'native-upload.txt',
      sender: 'user',
      profile: 'default',
    })
    expect(upstream).toContain('/api/files/download')
    expect((await req('get', '/api/app/files', 'second')).body.items).toEqual([])
    expect(upstream.some((p) => p.includes('/plugins/'))).toBe(false)
  })
  it('works without plugin discovery, installation, or any plugin HTTP request', async () => {
    const capabilities = (await req('get', '/api/app/capabilities').expect(200)).body.features
    expect(capabilities).toContain('editableGroups')
    expect(capabilities).not.toContain('immutableGroups')
    await req('get', '/api/app/files').expect(200)
    await req('get', '/api/app/voice/runtime').expect(200)
    await req('get', '/api/app/system/update/status').expect(200)
    await req('post', '/api/app/plugins/yaoyao/reconcile').send({}).expect(410)
    await req('get', '/api/plugins/yaoyao/v1/capabilities').expect(410)
    expect(upstream.some((p) => p.includes('/plugins/'))).toBe(false)
  })
  it('changes members over HTTP while protecting the administrator and ownership', async () => {
    const a = (
      await req('post', '/api/app/agents').send({ name: '编辑', profile: 'default' }).expect(201)
    ).body.agent
    const b = (
      await req('post', '/api/app/agents').send({ name: '审查', profile: 'default' }).expect(201)
    ).body.agent
    const c = (
      await req('post', '/api/app/conversations')
        .send({ name: '团队', memberIds: [a.id, b.id], administratorId: a.id })
        .expect(201)
    ).body.conversation
    const rows = await req('get', '/api/app/conversations').expect(200)
    expect(rows.body.conversations).toHaveLength(3)
    await req('patch', `/api/app/conversations/${c.id}`)
      .send({ memberIds: [b.id], administratorId: b.id })
      .expect(400)
    await req('patch', `/api/app/conversations/${c.id}`).send({ memberIds: [a.id] }).expect(200)
    expect((await req('get', `/api/app/conversations/${c.id}`)).body.conversation.memberIds).toEqual([a.id])
    await req('patch', `/api/app/conversations/${c.id}`).send({ memberIds: [a.id, b.id] }).expect(200)
    await req('get', `/api/app/conversations/${c.id}`, 'second').expect(404)
    await req('patch', `/api/app/agents/${a.id}`, 'second').send({ name: '入侵' }).expect(404)
    expect((await req('get', '/api/app/events', 'second')).body.events).toEqual([])
    expect(upstream.some((p) => p.includes('sessions'))).toBe(false)
  })
  it('creates, lists, renames, selects, and deletes group tasks without changing remote members', async () => {
    const a = (
      await req('post', '/api/app/agents').send({ name: '本机管理员', profile: 'default' }).expect(201)
    ).body.agent
    const b = (
      await req('post', '/api/app/agents').send({ name: '远程成员', nodeId: 'local', profile: 'default' }).expect(201)
    ).body.agent
    const conversation = (
      await req('post', '/api/app/conversations')
        .send({ name: '多任务团队', memberIds: [a.id, b.id], administratorId: a.id })
        .expect(201)
    ).body.conversation
    const initial = (await req('get', `/api/app/conversations/${conversation.id}/tasks`).expect(200)).body.tasks
    expect(initial).toHaveLength(1)
    expect(initial[0]).toMatchObject({
      conversationId: conversation.id,
      title: '新任务',
      titleSource: 'automatic',
      messageCount: 0,
    })
    const task = (
      await req('post', `/api/app/conversations/${conversation.id}/tasks`)
        .send({ title: '远程 Agent 调研' })
        .expect(201)
    ).body.task
    expect(task).toMatchObject({ title: '远程 Agent 调研', titleSource: 'user' })
    const renamed = (
      await req('patch', `/api/app/conversations/${conversation.id}/tasks/${task.id}`)
        .send({ title: '远程 Agent 复核' })
        .expect(200)
    ).body.task
    expect(renamed).toMatchObject({ title: '远程 Agent 复核', titleSource: 'user' })
    const detail = (await req('get', `/api/app/conversations/${conversation.id}?taskId=${task.id}`).expect(200)).body
    expect(detail.task.id).toBe(task.id)
    expect(detail.tasks.map((row: { id: string }) => row.id)).toContain(task.id)
    expect(detail.messages).toEqual([])
    expect(detail.conversation).toMatchObject({ memberIds: [a.id, b.id], administratorId: a.id })
    expect((await req('put', `/api/app/conversations/${conversation.id}/tasks/${task.id}/read`).send({ seq: 100 }).expect(200)).body.task)
      .toMatchObject({ readSeq: 0, lastSeq: 0, unreadCount: 0 })
    await req('get', `/api/app/conversations/${conversation.id}/tasks`, 'second').expect(404)
    await req('delete', `/api/app/conversations/${conversation.id}/tasks/${task.id}`).expect(200)
    const remaining = (await req('get', `/api/app/conversations/${conversation.id}/tasks`).expect(200)).body.tasks
    expect(remaining.map((row: { id: string }) => row.id)).not.toContain(task.id)
    expect((await req('get', `/api/app/conversations/${conversation.id}`)).body.conversation)
      .toMatchObject({ memberIds: [a.id, b.id], administratorId: a.id })
    await req('delete', `/api/app/conversations/${conversation.id}/tasks/${initial[0].id}`).expect(200)
    const replacement = (await req('get', `/api/app/conversations/${conversation.id}/tasks`).expect(200)).body.tasks
    expect(replacement).toHaveLength(1)
    expect(replacement[0].id).not.toBe(initial[0].id)
  })
  it('archives files on the Web server, preserves native library fields, and blocks cross-user downloads', async () => {
    const f = (
      await req('post', '/api/app/uploads')
        .attach('files', Buffer.from('hello'), { filename: 'hello.txt', contentType: 'text/plain' })
        .expect(201)
    ).body.files[0]
    expect(f.path).toBeUndefined()
    expect(runtime.uploads.cleanupUncommitted(0)).toBe(0)
    const list = await req('get', '/api/app/files').expect(200),
      item = list.body.items[0]
    expect(typeof item.id).toBe('number')
    expect(item.path).toBe(`/api/app/files/${f.id}/download`)
    expect(item).toMatchObject({ name: 'hello.txt', size: 5, exists: true, archiveStatus: 'ready' })
    expect((await req('get', item.path).expect(200)).text).toBe('hello')
    await req('get', item.path, 'second').expect(404)
    await req('get', `/api/app/files/${item.id}/download`, 'second').expect(404)
    expect((await req('get', '/api/app/files', 'second')).body.total).toBe(0)
    expect(upstream.some((p) => p.includes('/files'))).toBe(false)
  })
  it('does not serve uploaded HTML or SVG as executable same-origin previews', async () => {
    const f = (
      await req('post', '/api/app/uploads')
        .attach('files', Buffer.from('<svg onload="alert(1)"/>'), {
          filename: 'unsafe.svg',
          contentType: 'image/svg+xml',
        })
        .expect(201)
    ).body.files[0]
    const response = await req('get', `/api/app/files/${f.id}/preview`).expect(200)
    expect(response.headers['content-type']).toContain('application/octet-stream')
    expect(response.headers['content-disposition']).toContain('attachment')
  })
  it('persists encrypted voice credentials while giving each user their own selected voice', async () => {
    await req('put', '/api/app/admin/duplex-voice')
      .send({
        apiKey: 'private-test-key',
        voices: [
          { id: 'a', name: '甲' },
          { id: 'b', name: '乙' },
        ],
        currentVoiceId: 'a',
      })
      .expect(200)
    const publicResponse = await req('get', '/api/app/admin/duplex-voice').expect(200)
    expect(publicResponse.body.hasApiKey).toBe(true)
    expect(publicResponse.body.apiKey).toBeUndefined()
    await req('put', '/api/app/voice/current-voice', 'second')
      .send({ currentVoiceId: 'b' })
      .expect(200)
    expect((await req('get', '/api/app/voice/runtime')).body.currentVoiceId).toBe('a')
    expect((await req('get', '/api/app/voice/runtime', 'second')).body.currentVoiceId).toBe('b')
    expect(
      readFileSync(join(home, 'workspace.sqlite3')).includes(Buffer.from('private-test-key')),
    ).toBe(false)
  })
  it('stores monotonic profile-scoped context snapshots without a plugin', async () => {
    const path = '/api/app/session-context/session-one?profile=default'
    const b = { usedTokens: 200, limitTokens: 1000, percent: 20, observedAt: 20 }
    await req('put', path).send(b).expect(200)
    await req('put', path)
      .send({ ...b, usedTokens: 10, observedAt: 10 })
      .expect(200)
    expect((await req('get', path)).body.snapshot).toMatchObject({ ...b, sessionId: 'session-one' })
    expect((await req('get', path, 'second')).body.snapshot).toBeNull()
    expect(
      (await req('get', '/api/app/session-context/session-one?profile=other')).body.snapshot,
    ).toBeNull()
  })
  it('protects internal Hermes session IDs on native HTTP endpoints', async () => {
    runtime.workspace.put('first', 'binding', 'binding', {
      storedId: 'internal-session',
      runtimeId: 'internal-runtime',
      aliases: ['old-id'],
    })
    await req('get', '/api/app/sessions/internal-session/messages').expect(404)
    await req('get', '/api/sessions/old-id/messages', 'second').expect(404)
    expect(upstream.some((p) => p.includes('internal-session') || p.includes('old-id'))).toBe(false)
  })
})

it('prepares CSRF with capabilities and returns an idempotent committed send receipt', async () => {
  const caps = await req('get', '/api/app/capabilities').expect(200)
  expect(caps.body.csrfToken).toBe(csrf)
  expect(caps.headers['cache-control']).toBe('no-store')
  const store = runtime.workspace
  store.createAgent('first', { name: '回执测试', profile: 'default' })
  const conversation = store.list<any>('first', 'conversation')[0]
  const input = { requestId: randomUUID(), content: '确认后立即恢复' }
  const send = () => req('post', `/api/app/conversations/${conversation.id}/messages`).send(input).expect(202)
  const a = (await send()).body, b = (await send()).body
  expect(a.requestId).toBe(input.requestId)
  expect(a.message.id).toBe(a.run.messageId)
  expect(a.conversation.id).toBe(conversation.id)
  expect(a.cursor).toBeGreaterThan(0)
  expect(b.message.id).toBe(a.message.id)
  expect(b.run.id).toBe(a.run.id)
  expect(store.messages('first', conversation.id).filter(m => m.role === 'user')).toHaveLength(1)
})

it('aggregates per-agent daily token usage for today, month and lifetime', async () => {
  const store = runtime.workspace
  const agent = store.createAgent('first', { name: '用量统计', profile: 'default' })
  const other = store.createAgent('first', { name: '用量其他', profile: 'default' })
  const now = new Date(),
    pad = (n: number) => String(n).padStart(2, '0'),
    today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    month = today.slice(0, 7),
    older = `${month}-01`
  const seed = (agentId: string, date: string, input: number, output: number) =>
    store.put('first', 'agent-token-day', `${agentId}:${date}`, { agentId, date, input, output, total: input + output, updatedAt: 1 })
  seed(agent.id, today, 300, 100)
  seed(agent.id, older, 2000, 1000)
  seed(other.id, today, 99999, 99999)
  const usage = (await req('get', `/api/app/agents/${agent.id}/usage`).expect(200)).body
  expect(usage.today).toBe(today)
  expect(usage.todayUsage).toEqual({ input: 300, output: 100, total: 400 })
  expect(usage.monthUsage).toEqual({ input: 2300, output: 1100, total: 3400 })
  expect(usage.totalUsage).toEqual({ input: 2300, output: 1100, total: 3400 })
  expect(usage.daily.map((d: any) => d.date)).toEqual([today, older])
  await req('get', `/api/app/agents/${randomUUID()}/usage`).expect(404)
})

function stubBotModels(warning: string | null = null, duringResolve?: () => void) {
  const original=runtime.upstreamSession.request.bind(runtime.upstreamSession)
  return vi.spyOn(runtime.upstreamSession,'request').mockImplementation(async (path, options) => {
    const defaults={provider:'openai',model:'model-a',reasoningEffort:'medium',fastMode:'normal'}
    if(path.endsWith('/model-options'))return {status:200,headers:new Headers(),body:Buffer.from(JSON.stringify({version:1,defaults,models:[{provider:'openai',model:'model-a',name:'A',reasoningEfforts:['none','medium','high'],reasoningKnown:true,fastModes:['normal','fast','auto','cold'],api_key:'must-not-leak'}]}))}
    if(path.endsWith('/model-settings/resolve')){
      duringResolve?.()
      const settings=(options?.body as any)?.settings??{}
      return {status:200,headers:new Headers(),body:Buffer.from(JSON.stringify({version:1,effective:{...defaults,...Object.fromEntries(Object.entries(settings).filter(([,v])=>v!==null))},confirmationMessage:warning}))}
    }
    return original(path,options)
  })
}
it('exposes owned Bot model capabilities and saves settings without altering its peers or Profile', async () => {
  stubBotModels()
  const a=runtime.workspace.createAgent('first',{name:'模型甲',profile:'default'}),b=runtime.workspace.createAgent('first',{name:'模型乙',profile:'default'})
  const path=`/api/app/agents/${a.id}`
  const options=(await req('get',`${path}/model-options`).expect(200)).body
  expect(options).toMatchObject({revision:1,settings:null,defaults:{model:'model-a'}})
  expect(JSON.stringify(options)).not.toContain('must-not-leak')
  await req('get',`${path}/model-options`,'second').expect(404)
  const modelSettings={provider:'openai',model:'model-a',reasoningEffort:'none',fastMode:'auto'}
  const saved=(await req('patch',path).send({modelSettings,expectedRevision:1}).expect(200)).body.agent
  expect(saved.modelSettings).toEqual(modelSettings)
  expect(runtime.workspace.require<any>('first','agent',b.id).modelSettings).toBeUndefined()
  await req('patch',path).send({name:'改名'}).expect(200)
  expect(runtime.workspace.require<any>('first','agent',a.id).modelSettings).toEqual(modelSettings)
  await req('patch',path).send({modelSettings:null,expectedRevision:1}).expect(409)
  expect(upstream.some(p=>p.includes('/model/set'))).toBe(false)
})
it('requires model confirmation before saving and binds it to the resolved selection', async () => {
  stubBotModels('费用较高，请确认')
  const a=runtime.workspace.createAgent('first',{name:'确认模型',profile:'default'}),path=`/api/app/agents/${a.id}`
  const body={expectedRevision:1,modelSettings:{provider:'openai',model:'model-a',reasoningEffort:null,fastMode:null}}
  const confirmation=(await req('patch',path).send(body).expect(200)).body
  expect(confirmation.confirmationRequired).toBe(true)
  expect(runtime.workspace.require<any>('first','agent',a.id).revision).toBe(1)
  const result=(await req('patch',path).send({...body,confirmedModel:confirmation.confirmationTarget}).expect(200)).body.agent
  expect(result.modelSettingsConfirmation).toBe('["openai","model-a"]')
  const changed=(await req('patch',path).send({...body,expectedRevision:2,modelSettings:{...body.modelSettings,model:'model-b'},confirmedModel:confirmation.confirmationTarget}).expect(200)).body
  expect(changed.confirmationTarget).toBe('["openai","model-b"]')
  expect(runtime.workspace.require<any>('first','agent',a.id).revision).toBe(2)
})
it('detects a concurrent edit after asynchronous model validation without overwriting the new record', async () => {
  const a=runtime.workspace.createAgent('first',{name:'并发编辑',profile:'default'})
  stubBotModels(null,()=>runtime.workspace.updateAgent('first',a.id,{name:'另一端的新名称'}))
  await req('patch',`/api/app/agents/${a.id}`).send({expectedRevision:1,modelSettings:null}).expect(409)
  expect(runtime.workspace.require<any>('first','agent',a.id)).toMatchObject({name:'另一端的新名称',revision:2})
  expect(runtime.workspace.require<any>('first','agent',a.id).modelSettings).toBeUndefined()
})
it('preserves ordinary Bot editing when the installed bridge predates model settings', async () => {
  const a=runtime.workspace.createAgent('first',{name:'旧工具桥',profile:'default'}),path=`/api/app/agents/${a.id}`
  expect((await req('get',`${path}/model-options`).expect(409)).body.code).toBe('model_settings_upgrade_required')
  await req('patch',path).send({instructions:'新规则'}).expect(200)
  await req('patch',path).send({modelSettings:{provider:'openai',model:null,reasoningEffort:null,fastMode:null},expectedRevision:2}).expect(400)
})
it('confirms a session-dependent native warning in the profile save flow',async()=>{
  stubBotModels()
  const a=runtime.workspace.createAgent('first',{name:'长上下文切换',profile:'default'}),path=`/api/app/agents/${a.id}`
  runtime.workspace.put('first','agent',a.id,{...a,modelSettingsPendingConfirmation:{target:'["openai","model-a"]',message:'切换长上下文将增加费用'}})
  const body={expectedRevision:1,modelSettings:null}
  const warning=(await req('patch',path).send(body).expect(200)).body
  expect(warning.confirmationMessage).toContain('长上下文')
  const saved=(await req('patch',path).send({...body,confirmedModel:warning.confirmationTarget}).expect(200)).body.agent
  expect(saved.modelSettingsConfirmation).toBe('["openai","model-a"]')
  expect(saved.modelSettingsPendingConfirmation).toBeUndefined()
})
it('saves a new base Profile before reloading and validating its model catalogue',async()=>{
  const a=runtime.workspace.createAgent('first',{name:'换来源',profile:'other'}),path=`/api/app/agents/${a.id}`
  runtime.workspace.updateAgent('first',a.id,{modelSettings:{provider:'old-provider',model:'old-model',reasoningEffort:'high',fastMode:'cold'}})
  // Even an old bridge must allow source-only edits, preserving the draft values.
  const saved=(await req('patch',path).send({profile:'default'}).expect(200)).body.agent
  expect(saved.profile).toBe('default');expect(saved.modelSettings.model).toBe('old-model')
  stubBotModels()
  expect((await req('get',`${path}/model-options`).expect(200)).body).toMatchObject({revision:saved.revision,settings:saved.modelSettings})
})
