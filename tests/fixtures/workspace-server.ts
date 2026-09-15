import {nativeEnvironmentFixture} from './native-environment.js'
import {FixtureGrokAuthProvider} from './grok-auth-provider.js'
import { FixtureBotPlugins } from './bot-plugins.js'
import { defaultAgentIdentity, encodeAgentAvatar } from '../../src/shared/agentIdentity.js'
/** Isolated, deterministic Hermes fixture. Team-tool transport is simulated, with no live model. */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID, randomBytes, scryptSync } from 'node:crypto'
import { WebSocketServer } from 'ws'
import serve from 'koa-static'
import { createApplication, createNodeServer } from '../../src/server/app.js'
import { loadServerConfig } from '../../src/server/config.js'
import { LocalAuthStore } from '../../src/server/localAuth.js'
const home =
  process.env.WORKSPACE_FIXTURE_HOME || mkdtempSync(join(tmpdir(), 'yaoyao-workspace-browser-'))
const port = Number(process.env.WORKSPACE_FIXTURE_PORT || 18800),
  upstreamPort = Number(process.env.WORKSPACE_FIXTURE_UPSTREAM_PORT || 19119)
const sessions = new Map<
  string,
  {
    id: string
    profile: string
    source: string
    title: string
    messages: Array<{ role: string; content: string; id: string; timestamp: number }>
    running: boolean
    cwd?: string
  }
>()
const latestRuntimeBySession = new Map<string, string>()
const calls: Array<{ method: string; params: Record<string, unknown> }> = []
const heldReplies: Array<() => void> = []
const pluginsFixture = process.env.WORKSPACE_FIXTURE_PLUGINS === '1' ? new FixtureBotPlugins() : undefined
const profileState = new Map([
  ['default', { name: 'default', display_name: '通用助手', is_default: true, gateway_running: true, ui_meta: {} as Record<string, unknown>, ui_meta_revisions: {} as Record<string, number> }],
  ['server', { name: 'server', display_name: '开发助手', is_default: false, gateway_running: true, ui_meta: {} as Record<string, unknown>, ui_meta_revisions: {} as Record<string, number> }],
])

function broadcastUpstreamEvent(
  type: string,
  payload: Record<string, unknown>,
  sessionId?: string,
  profile = 'default',
) {
  const frame = JSON.stringify({
    method: 'event',
    params: {
      type,
      payload,
      ...(sessionId ? { session_id: sessionId, profile } : {}),
    },
  })
  for (const socket of wss.clients) {
    if (socket.readyState === 1) socket.send(frame)
  }
}

const upstream = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${upstreamPort}`)
  res.setHeader('content-type', 'application/json')
  const send = (v: unknown) => res.end(JSON.stringify(v))
  if (pluginsFixture?.handle(req, res, url.pathname)) return
  if (url.pathname === '/api/config') {
    send({ terminal: { cwd: `/tmp/hermes-fixture/${url.searchParams.get('profile') || 'default'}` } })
    return
  }
  if (url.pathname === '/__release' && req.method === 'POST') {
    const held = heldReplies.splice(0)
    for (const complete of held) complete()
    send({ released: held.length })
    return
  }
  if (url.pathname.includes('/plugins/')) {
    if (process.env.WORKSPACE_FIXTURE_TEAM_TOOLS === '1' && ['/api/plugins/yaoyao-bot-bridge/bind', '/api/plugins/yaoyao-bot-bridge/unbind'].includes(url.pathname)) {
      req.resume()
      send({ok:true,native_tools:true})
      return
    }
    if (process.env.WORKSPACE_FIXTURE_TEAM_TOOLS === '1' && url.pathname === '/api/plugins/yaoyao-bot-bridge/capabilities') {
      send({ version: 1, ready: true, native_tools: true, in_process: true })
      return
    }
    res.statusCode = 404
    send({ error: 'This fixture has no plugins' })
    return
  }
  if (url.pathname === '/__calls') {
    send({ calls })
    return
  }
  if (url.pathname === '/__test/sessions/title' && req.method === 'POST') {
    const id = url.searchParams.get('id')?.trim() || ''
    const title = url.searchParams.get('title')?.trim() || ''
    const session = sessions.get(id)
    const runtimeId = latestRuntimeBySession.get(id)
    if (!session || !runtimeId || !title) {
      res.statusCode = 409
      send({ error: 'session route is not active' })
      return
    }
    session.title = title
    broadcastUpstreamEvent(
      'session.title',
      { session_id: id, title },
      runtimeId,
      session.profile,
    )
    send({ id, title })
    return
  }
  if (url.pathname === '/api/status') {
    send({ auth_required: true, overall: 'ready', gateway_running: true })
    return
  }
  if (url.pathname === '/api/auth/me') {
    send({ user_id: 'fixture', display_name: 'Fixture', provider: 'basic' })
    return
  }
  if (url.pathname === '/auth/password-login') {
    res.setHeader('set-cookie', 'hermes_session_at=fixture; Path=/; HttpOnly')
    send({ ok: true })
    return
  }
  if (url.pathname === '/api/auth/ws-ticket') {
    send({ ticket: 'fixture' })
    return
  }
  if (url.pathname === '/api/profiles') {
    send({ profiles: [...profileState.values()] })
    return
  }
  if (url.pathname === '/api/sessions') {
    const requestedSource = url.searchParams.get('source')
    const visible = [...sessions.values()].filter(session =>
      !requestedSource || session.source === requestedSource)
    send({
      sessions: visible.map((s) => ({
        id: s.id,
        title: s.title,
        source: s.source,
        profile: s.profile,
      })),
      total: visible.length,
      hasMore: false,
      offset: Number(url.searchParams.get('offset') ?? 0),
      limit: Number(url.searchParams.get('limit') ?? 100),
    })
    return
  }
  const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
  if (detail) {
    const session = sessions.get(detail[1]!)
    if (!session) {
      res.statusCode = 404
      send({ error: 'session not found' })
      return
    }
    send({
      id: session.id,
      profile: session.profile,
      source: session.source,
      title: session.title,
      message_count: session.messages.length,
    })
    return
  }
  const history = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
  if (history) {
    const messages = sessions.get(history[1]!)?.messages || []
    send({ session_id: history[1], messages,
      pagination: {offset: 0, limit: 100, returned: messages.length, total: messages.length, has_more: false} })
    return
  }
  if (url.pathname === '/api/files/download') {
    res.setHeader('content-type', 'text/plain')
    res.end('Fixture report\n')
    return
  }
  send({ ok: true })
})
const wss = new WebSocketServer({ server: upstream, path: '/api/ws' })
wss.on('connection', (socket) => {
  const runtimes = new Map<string, string>()
  socket.send(
    JSON.stringify({
      method: 'event',
      params: { type: 'gateway.ready', payload: { capabilities: [] } },
    }),
  )
  socket.on('message', (raw) => {
    const f = JSON.parse(String(raw))
    calls.push({ method: f.method, params: f.params })
    const respond = (result: unknown) => socket.send(JSON.stringify({ id: f.id, result }))
    const event = (type: string, payload: unknown, sessionId: string) => {
      if (socket.readyState === 1)
        socket.send(
          JSON.stringify({
            method: 'event',
            params: { type, payload, session_id: sessionId, profile: 'default' },
          }),
        )
    }
    if (f.method === 'profiles.list') {
      respond({ profiles: [...profileState.values()] })
      return
    }
    if (f.method === 'profiles.configure') {
      const profile = profileState.get(String(f.params.name))
      if (!profile) { respond({ error: 'profile_not_found' }); return }
      for (const [namespace, value] of Object.entries(f.params.ui_meta ?? {})) {
        profile.ui_meta[namespace] = value
        profile.ui_meta_revisions[namespace] = (profile.ui_meta_revisions[namespace] ?? 0) + 1
      }
      respond({ profile })
      return
    }
    if (f.method === 'session.create' || f.method === 'session.resume') {
      let stored = f.method === 'session.resume' ? sessions.get(f.params.session_id) : undefined
      if (!stored) {
        stored = {
          id: randomUUID(),
          profile: f.params.profile,
          source: String(f.params.source ?? 'web'),
          title: String(f.params.title ?? '新对话'),
          messages: [],
          running: false,
        }
        sessions.set(stored.id, stored)
      }
      // A live Hermes resume joins the same runtime, including other viewers.
      const runtimeId = latestRuntimeBySession.get(stored.id) ?? randomUUID()
      runtimes.set(runtimeId, stored.id)
      latestRuntimeBySession.set(stored.id, runtimeId)
      respond({
        session_id: runtimeId,
        stored_session_id: stored.id,
        session_key: stored.id,
        running: stored.running,
        info: { profile_name: stored.profile, cwd: stored.cwd },
      })
      return
    }
    const stored = sessions.get(runtimes.get(f.params.session_id) ?? '')
    if (f.method === 'session.cwd.set' && stored) {
      stored.cwd = String(f.params.cwd)
      respond({ cwd: stored.cwd })
      return
    }
    if (f.method === 'prompt.submit' && stored) {
      stored.running = true
      const requestedTitle = /^\[cross-client-title:([^\]\r\n]+)\]/
        .exec(String(f.params.text))?.[1]?.trim()
      if (requestedTitle) {
        stored.title = requestedTitle
        setTimeout(() => broadcastUpstreamEvent('sessions.changed', {}), 0)
      }
      stored.messages.push({
        id: randomUUID(),
        role: 'user',
        content: f.params.text,
        timestamp: Date.now() / 1000,
      })
      respond({ status: 'streaming' })
      const latencyMarker = /\[latency:([^\]]+)\]/.exec(String(f.params.text))?.[1]
      if (latencyMarker) {
        const chunks = latencyMarker.includes('long')
          ? Array.from({ length: 200 }, (_, i) => `第${String(i + 1).padStart(3, '0')}段。用于比较两个移动端的连续文本显示表现，全部内容来自隔离测试服务。\n\n`)
          : Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(2, '0')}测试文字 `)
        let text = '', index = 0
        setTimeout(() => {
          const tick = () => {
            if (socket.readyState !== 1 || !stored!.running) return
            if (index === chunks.length) {
              const tail = ` END-${latencyMarker}`; text += tail
              event('message.delta', { text: tail }, f.params.session_id)
              stored!.running = false
              stored!.messages.push({ id: randomUUID(), role: 'assistant', content: text, timestamp: Date.now() / 1000 })
              event('message.complete', { text, status: 'complete' }, f.params.session_id)
              return
            }
            const part = chunks[index++]!; text += part
            event('message.delta', { text: part }, f.params.session_id)
            setTimeout(tick, 20)
          }
          tick()
        }, 250)
        return
      }
      const name = /你是 (.*?)。/.exec(f.params.text)?.[1] || '助手'
      const requested = /本轮用户指定成员：([^\n]*)/.exec(f.params.text)?.[1] ?? ''
      const delegates = f.params.text.includes('你是管理员。') && !f.params.text.includes('本批次执行结果：') && requested.startsWith('@')
      const markdownStream = String(f.params.text).includes('[streaming-markdown]')
      const crossClientRun = String(f.params.text).includes('[cross-client-live]')
      const markdownPrefix = '# 流式标题\n\n**即时格式化**\n\n- 第一项\n- 第二项\n\n```ts\nconst answer = 42' + (String(f.params.text).includes('[long]') ? `\n\x60\x60\x60\n\n${'这是持续生成的长回复段落。\n\n'.repeat(80)}流式末尾标记\n\n\x60\x60\x60ts\nconst tail = 1` : '')
      const markdownFinal = `${markdownPrefix}\n\x60\x60\x60\n\n| 名称 | 数量 |\n| --- | --- |\n| 项目 | 2 |\n\n最终完整标记`
      let text = markdownStream ? markdownFinal : `我是${name}。已按角色规则处理这条消息。\n\n- 会话独立保存\n- 可以继续交流\n\n[报告](/tmp/workspace-report.txt)${delegates ? `\n请${requested}处理任务。` : ''}`
      event('message.start', {}, f.params.session_id)
      if (String(f.params.text).includes('[message-files]')) {
        event('reasoning.delta', { text: '![过程图](/tmp/process.png)' }, f.params.session_id)
        event('tool.start', { tool_id: 'process-file', name: 'read_file', arguments: { path: '/tmp/input.pdf' } }, f.params.session_id)
        event('tool.complete', { tool_id: 'process-file', name: 'read_file', result: { path: '/tmp/process.pdf' } }, f.params.session_id)
      }
      if (crossClientRun) event('tool.start', { tool_id: 'cross-client-tool', name: 'read_file' }, f.params.session_id)
      else setTimeout(() => event('message.delta', { text: markdownStream ? markdownPrefix : text.slice(0, 12) }, f.params.session_id), 80)
      const complete = () => {
        if (crossClientRun) event('tool.complete', { tool_id: 'cross-client-tool', name: 'read_file', result: 'ok' }, f.params.session_id)
        stored!.running = false
        stored!.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: text,
          timestamp: Date.now() / 1000,
        })
        event('message.complete', { text, status: 'complete' }, f.params.session_id)
      }
      if (pluginsFixture && f.params.text.includes('[plugin-roundtrip]')) {
        void pluginsFixture.exercise(f.params.session_id).then(({ tool, result }) => {
          event('tool.start', { tool_id: 'plugin-fixture', name: tool.name }, f.params.session_id)
          event('tool.complete', { tool_id: 'plugin-fixture', name: tool.name, result }, f.params.session_id)
          text = String(result.content?.[0]?.text ?? '插件未返回文字'); complete()
        }).catch(error => { stored!.running = false; event('run.failed', { error: String(error) }, f.params.session_id) })
      }
      else if (crossClientRun || markdownStream || f.params.text.includes('[hold-workspace]')) heldReplies.push(complete)
      else setTimeout(complete, 250)
      return
    }
    if (f.method === 'session.interrupt' && stored) stored.running = false
    if (f.method === 'file.attach') {
      respond({ attached: true, ref_text: '@file:fixture-upload.txt' })
      return
    }
    respond({ ok: true, status: 'interrupted' })
  })
})
await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))
const config = loadServerConfig({
  HERMES_YAOYAO_HOME: home,
  HERMES_YAOYAO_PORT: String(port),
  HERMES_YAOYAO_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  HERMES_YAOYAO_UPSTREAM_USERNAME: 'fixture',
  HERMES_YAOYAO_UPSTREAM_PASSWORD: 'fixture',
  HERMES_YAOYAO_ALLOWED_HOSTS: '127.0.0.1,localhost',
})
// Synthetic credentials are seeded only into this disposable fixture directory.
const usersPath = join(home, 'users.json')
if (!existsSync(usersPath)) {
  const salt = randomBytes(16),
    now = Date.now()
  writeFileSync(
    usersPath,
    JSON.stringify({
      version: 1,
      users: [
        {
          id: randomUUID(),
          username: 'fixture',
          normalizedUsername: 'fixture',
          role: 'admin',
          enabled: true,
          mustChangePassword: false,
          salt: salt.toString('base64'),
          passwordHash: scryptSync('fixture-pass', salt, 32, {
            N: 2 ** 14,
            r: 8,
            p: 1,
            maxmem: 64 * 1024 * 1024,
          }).toString('base64'),
          authVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    { mode: 0o600 },
  )
}
const auth = new LocalAuthStore(home, false)
const grokAuth=process.env.WORKSPACE_FIXTURE_GROK_AUTH==='1'?new FixtureGrokAuthProvider():undefined
const runtime = createApplication({ config, auth, grokFetch:grokAuth?.fetch, pluginFetch: pluginsFixture?.fetch }),
  node = createNodeServer(runtime)
const closeNative=process.env.WORKSPACE_FIXTURE_NATIVE==='1'?nativeEnvironmentFixture(runtime,home,port):undefined
if (process.env.WORKSPACE_FIXTURE_COMMUNICATION === '1') {
  const owner = JSON.parse(readFileSync(usersPath, 'utf8')).users[0].id as string
  const store = runtime.workspace
  const a = store.createAgent(owner, { name: '竹儿', profile: 'default', avatar: encodeAgentAvatar({ ...defaultAgentIdentity('lead', '竹儿'), color: '#ff9500' }) })
  const b = store.createAgent(owner, { name: '研究员', profile: 'default', avatar: encodeAgentAvatar({ ...defaultAgentIdentity('researcher', '研究员'), color: '#191a21' }) })
  const direct = (id: string) => store.list<import('../../src/shared/workspace.js').WorkspaceConversation>(owner, 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === id)!
  const c = direct(a.id), other = direct(b.id), now = Date.now()
  const texts = ['请让研究员核对接口版本，再告诉我结论。', '我请研究员核对一下。', '请核对接口版本，确认旧客户端是否兼容。', '已核对：当前为 v2，旧客户端仍可使用。', '核对完成，当前接口兼容旧客户端。']
  for (const [index, content] of texts.entries()) {
    const peerMessageId = index === 2 || index === 3 ? randomUUID() : undefined
    const runId = index === 3 ? randomUUID() : undefined
    if (peerMessageId) store.put(owner, 'peer-message', peerMessageId, { id: peerMessageId, chainId: 'fixture', fromAgentId: index === 2 ? a.id : b.id, toAgentId: index === 2 ? b.id : a.id, originConversationId: index === 2 ? c.id : other.id, conversationId: index === 2 ? other.id : c.id, sourceRunId: randomUUID(), runId, content, fileIds: [], depth: 1, priority: false, status: 'complete', createdAt: now + index, updatedAt: now + index })
    store.saveMessage(owner, { id: randomUUID(), conversationId: c.id, seq: 0, role: index === 0 ? 'user' : peerMessageId ? 'system' : 'assistant', agentId: index === 0 ? undefined : index === 3 ? b.id : a.id, agentName: index === 0 ? undefined : index === 3 ? b.name : a.name, content: index === 2 ? '已向 Bot「研究员」发送协作请求。结果将异步返回。' : index === 3 ? `来自 Bot「研究员」的回复：\n${content}` : content, reasoning: '', status: 'complete', attachments: [], tools: [], peerMessageId, runId, createdAt: now + index })
  }
  console.log(`Communication preview: http://127.0.0.1:${port}/conversations/${c.id}`)
}
runtime.app.use((ctx, next) => {
  if (ctx.path !== '/__test/workspace-transcript' || ctx.method !== 'POST') return next()
  const owner = auth.require(ctx).id
  if (typeof ctx.query.id === 'string') {
    const message = runtime.workspace.messages(owner, ctx.query.id, Number.MAX_SAFE_INTEGER, 1)[0]!
    runtime.workspace.saveMessage(owner, { ...message, content: message.content + '\n\n实时追加的内容', status: 'streaming' })
    ctx.body = { ok: true }; return
  }
  const agent = runtime.workspace.createAgent(owner, { name: '长会话性能验收', profile: 'default' })
  const conversation = runtime.workspace.list<any>(owner, 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === agent.id)!
  for (let index = 1; index <= 300; index++) runtime.workspace.saveMessage(owner, {
    id: randomUUID(), conversationId: conversation.id, seq: index, role: index % 2 ? 'user' : 'assistant',
    content: `消息 ${index}\n\n${'用于验证长会话缓存与滚动位置。'.repeat(12)}`, reasoning: '', status: 'complete',
    attachments: [], tools: [], createdAt: Date.now() + index,
  })
  ctx.body = { agentId: agent.id, conversationId: conversation.id }
})
runtime.app.use((ctx,next)=>{if(ctx.path!=='/__test/browser-page')return next();ctx.type='html';ctx.body='<!doctype html><meta charset="utf-8"><title>浏览器操作验收</title><body style="font:22px sans-serif;padding:48px;background:#edf4ff"><h1>机器人的独立浏览器</h1><p>这是隔离的真实浏览器验收页面。</p><input aria-label="输入内容"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">确认</button><output></output></body>'})
runtime.app.use((ctx,next) => {
  if (ctx.path !== '/__test/task-plan' || ctx.method !== 'POST') return next()
  const owner=auth.require(ctx).id
  const lead=runtime.workspace.createAgent(owner,{name:'验收负责人',profile:'default',canManageTeam:true})
  const worker=runtime.workspace.createAgent(owner,{name:'验收研究员',profile:'default'})
  const team=runtime.workspace.createGroup(owner,{name:'任务分工验收',memberIds:[lead.id,worker.id],administratorId:lead.id})
  const first=runtime.workspace.tasks(owner,team.id)[0]!
  runtime.workspace.updateTask(owner,team.id,first.id,{title:'调研任务'})
  const second=runtime.workspace.createTask(owner,team.id,{title:'独立任务'})
  const source=runtime.workspace.list<any>(owner,'conversation').find(c=>c.kind==='direct'&&c.memberIds[0]===lead.id)!
  const goal=runtime.workspaceRuntime.tasks.begin(owner,first,lead,'完成可核对的研究报告',{conversationId:source.id,runId:randomUUID(),agentId:lead.id},['来源可核对'])
  const temporary=ctx.query.helper==='1'?runtime.workspace.createAgent(owner,{name:'验收研究员（临时）',profile:'default',execution:'computer'},{createdByAgentId:lead.id,createdFromRunId:randomUUID(),temporaryGoalId:goal.id,helperActivation:goal.activation??1,helperRunnerId:randomUUID()}):undefined
  const assignment={id:randomUUID(),goalId:goal.id,conversationId:team.id,agentId:temporary?.id??worker.id,title:'研究资料',brief:'核对资料',acceptanceCriteria:['来源可核对'],dependsOn:[],status:'review',attempt:1,result:'资料已汇总',artifactIds:[],createdAt:Date.now(),updatedAt:Date.now()}
  runtime.workspace.put(owner,'assignment',assignment.id,assignment)
  runtime.workspace.event(owner,'assignment.changed',assignment,team.id)
  runtime.workspace.saveMessage(owner,{id:randomUUID(),conversationId:source.id,seq:0,role:'system',content:`任务已有结果。[打开任务](/conversations/${team.id}?taskId=${first.id})`,reasoning:'',status:'complete',attachments:[],tools:[],createdAt:Date.now()})
  ctx.body={conversationId:team.id,firstTaskId:first.id,secondTaskId:second.id,sourceConversationId:source.id}
})
runtime.app.use((ctx,next)=>{
 if(!grokAuth||!ctx.path.startsWith('/__test/grok-auth/')||ctx.method!=='POST')return next()
 const owner=auth.requireAdmin(ctx).id
 if(ctx.path==='/__test/grok-auth/complete'){
  const attempt=runtime.grokAuth.snapshot(owner).attempt
  if(!attempt?.loginUrl){ctx.status=409;ctx.body={error:'No pending fixture authorization'};return}
  grokAuth.accept(new URL(attempt.loginUrl).searchParams.get('uuid')!);ctx.body={ok:true};return
 }
 if(ctx.path==='/__test/grok-auth/reject'){grokAuth.rejectCloud=true;ctx.body={ok:true};return}
 return next()
})
const computerFixtures=new Map<string,{mode:string;generation:number;controlId?:string;actions:unknown[]}>()
const originalComputer=runtime.runners.computer.bind(runtime.runners),originalRunner=runtime.runners.computerRunner.bind(runtime.runners),originalSharedRunner=runtime.runners.sharedComputerRunner.bind(runtime.runners)
runtime.runners.sharedComputerRunner=(owner,agent)=>computerFixtures.has(agent.id)?{id:'11111111-1111-4111-8111-111111111111'} as any:originalSharedRunner(owner,agent)
runtime.runners.computerRunner=(owner,agent)=>computerFixtures.has(agent.id)?{id:'11111111-1111-4111-8111-111111111111'} as any:originalRunner(owner,agent)
runtime.runners.computer=async(owner,agent,op,data,authorize)=>{
  const state=computerFixtures.get(agent.id);if(!state)return originalComputer(owner,agent,op,data,authorize)
  authorize()
  if(op==='detail')return {enabled:agent.execution==='computer',container:state.mode==='off'?'missing':state.mode==='stopped'?'stopped':'running',ready:!['off','stopped'].includes(state.mode),inUse:state.mode==='human',controlMode:state.mode,image:vmFixture.image,mode:agent.computerEnvironmentId?'shared':'per-bot',maxInstances:vmFixture.maxInstances,idleStopMinutes:vmFixture.idleStopMinutes}
  if(op==='lifecycle'){state.mode=data.action==='remove'?'off':data.action==='stop'?'stopped':'idle';state.generation++;return {ok:true}}
  if(op==='frame'){const png=readFileSync(process.env.YAOYAO_VM_PREVIEW_PNG||resolve('public/icons/icon-512.png'));return {id:'22222222-2222-4222-8222-222222222222',generation:state.generation,width:png.readUInt32BE(16),height:png.readUInt32BE(20),capturedAt:Date.now(),data:png.toString('base64')}}
  if(op==='take'){state.controlId=String(data.controlId);state.mode='human';state.generation++}
  if(op==='input')state.actions.push(data.action)
  if(op==='giveback'){state.mode='agent';state.controlId=undefined;state.generation++}
  return {mode:state.mode,generation:state.generation,controlId:state.controlId,canResume:true,ok:true}
}
runtime.app.use((ctx,next)=>{
  if(ctx.path!=='/__test/computer')return next()
  const owner=auth.require(ctx).id
  if(ctx.method==='POST'){
    const agent=runtime.workspace.createAgent(owner,{name:(ctx.query.shared==='1'?'共享电脑主成员':'电脑面板验收')+' '+(computerFixtures.size+1),profile:'default',execution:'computer'})
    computerFixtures.set(agent.id,{mode:ctx.query.off==='1'?'off':'idle',generation:1,actions:[]})
    if(ctx.query.shared==='1'){
      const second=runtime.workspace.createAgent(owner,{name:'可信共享成员',profile:'default',execution:'computer'})
      computerFixtures.set(second.id,{mode:'off',generation:1,actions:[]})
      const team=runtime.workspace.createGroup(owner,{name:'共享电脑验收',memberIds:[agent.id,second.id],administratorId:agent.id})
      ctx.body={agentId:agent.id,secondId:second.id,conversationId:team.id};return
    }
    ctx.body={agentId:agent.id,conversationId:runtime.workspace.list<any>(owner,'conversation').find(c=>c.memberIds[0]===agent.id)!.id};return
  }
  ctx.body={actions:[...computerFixtures.values()].flatMap(state=>state.actions)}
})
const vmFixture={configured:true,runtime:'docker',daemonUp:true,image:false,mode:'per-bot',maxInstances:2,idleStopMinutes:5,busy:false,job:undefined as any}
let vmRunnerId=''
const originalSummary=runtime.runners.summary.bind(runtime.runners),originalLocalVm=runtime.runners.localVm.bind(runtime.runners)
runtime.runners.summary=record=>record.id===vmRunnerId?{...originalSummary(record),online:true,features:['computer-worker-v1','computer-control-v1','local-vm-v1','image-ready-v1']}:originalSummary(record)
runtime.runners.localVm=async(owner,id,p)=>{
 if(id!==vmRunnerId)return originalLocalVm(owner,id,p)
 if(p.op==='prepare'){vmFixture.image=true;vmFixture.job={id:p.id,state:'complete',message:'本地虚拟机已就绪'}}
 if(p.op==='policy'){vmFixture.mode=String(p.mode);vmFixture.maxInstances=Number(p.maxInstances)}
 if(p.op==='idle-policy')vmFixture.idleStopMinutes=Number(p.idleStopMinutes)
 return {...vmFixture}
}
runtime.app.use((ctx,next)=>{if(ctx.path!=='/__test/local-vm')return next();const owner=auth.requireAdmin(ctx).id;vmFixture.image=ctx.query.ready==='1';vmFixture.mode='per-bot';vmFixture.maxInstances=2;vmFixture.idleStopMinutes=5;vmFixture.job=undefined;(runtime.runners as any).online.delete(vmRunnerId);if(!vmRunnerId){for(const record of runtime.runners.records())if(record.sourceNodeId==='local'&&record.enabled)runtime.runners.remove(record.id);vmRunnerId=runtime.runners.enroll(owner,{name:'本机虚拟机',allowedProfiles:['default']}).runner.id;}ctx.body={runnerId:vmRunnerId}})
runtime.app.use((ctx,next)=>{if(ctx.path!=='/__test/hybrid-runner')return next();auth.requireAdmin(ctx);(runtime.runners as any).online.set(vmRunnerId,{instance:randomUUID(),epoch:'fixture',seen:Date.now(),features:['computer-worker-v1','computer-control-v1','local-vm-v1','image-ready-v1','host-computer-tools-v1','idle-stop-policy-v1','profile-computer-v1','hermes-computer-v2','workspace-memory-bind-v1']});ctx.body={ok:true}})
runtime.app.use((ctx,next)=>{
 if(ctx.path!=='/__test/cloud-host-option')return next();const owner=auth.requireAdmin(ctx).id,cloud=runtime.workspaceRuntime.cloud!
 cloud.state=async()=>({configured:true,running:false});cloud.status=async()=>({backend:'grok',mode:'off'});cloud.requireAvailable=async()=>{};cloud.connect=async()=>({} as any)
 const agent=runtime.workspace.createAgent(owner,{name:'云虚拟机本机选项',computer:'cloud',profile:'default'})
 ctx.body={agentId:agent.id,conversationId:runtime.workspace.list<any>(owner,'conversation').find(c=>c.memberIds[0]===agent.id)!.id}
})
runtime.app.use(serve(resolve('dist')))
runtime.app.use((ctx) => {
  if (!ctx.path.startsWith('/api/')) {
    ctx.type = 'html'
    ctx.body = readFileSync(resolve('dist/index.html'))
  }
})
await new Promise<void>((resolve) => node.server.listen(port, '127.0.0.1', resolve))
process.stdout.write(`Workspace fixture http://127.0.0.1:${port}; home=${home}\n`)
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    closeNative?.()
    void node.close().then(() => {
      for (const socket of wss.clients) socket.terminate()
      wss.close()
      upstream.close()
    })
  })
