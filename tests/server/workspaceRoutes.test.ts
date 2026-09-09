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
  it('grants team management only with a ready bridge and persists explicit revocation', async () => {
    const denied = await req('post','/api/app/agents').send({name:'老板',profile:'default',canManageTeam:true}).expect(409)
    expect(denied.body.code).toBe('team_tools_unavailable')
    expect((await req('get','/api/app/agents')).body.agents).toEqual([])
    bridgeReady = true
    const agent = (await req('post','/api/app/agents').send({name:'老板',profile:'default',canManageTeam:true}).expect(201)).body.agent
    expect(agent.canManageTeam).toBe(true)
    await req('patch',`/api/app/agents/${agent.id}`,'second').send({canManageTeam:false}).expect(404)
    bridgeReady = false
    const disabled = await req('patch',`/api/app/agents/${agent.id}`).send({canManageTeam:false}).expect(200)
    expect(disabled.body.agent.canManageTeam).toBe(false)
    expect((await req('get','/api/app/agents')).body.agents[0].canManageTeam).toBe(false)
    await req('patch',`/api/app/agents/${agent.id}`).send({canManageTeam:true}).expect(409)
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
    expect(sources.some((s:any)=>s.nodeId===node.id && s.profile==='default')).toBe(true)
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
