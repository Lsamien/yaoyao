/** Isolated, deterministic standard-Hermes fixture. It exposes no plugin APIs. */
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
  }
>()
const latestRuntimeBySession = new Map<string, string>()
const calls: Array<{ method: string; params: Record<string, unknown> }> = []
const heldReplies: Array<() => void> = []
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
  if (url.pathname === '/__release' && req.method === 'POST') {
    const held = heldReplies.splice(0)
    for (const complete of held) complete()
    send({ released: held.length })
    return
  }
  if (url.pathname.includes('/plugins/')) {
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
      const runtimeId = randomUUID()
      runtimes.set(runtimeId, stored.id)
      latestRuntimeBySession.set(stored.id, runtimeId)
      respond({
        session_id: runtimeId,
        stored_session_id: stored.id,
        session_key: stored.id,
        running: stored.running,
        info: { profile_name: stored.profile },
      })
      return
    }
    const stored = sessions.get(runtimes.get(f.params.session_id) ?? '')
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
      const name = /你是 (.*?)。/.exec(f.params.text)?.[1] || '助手'
      const requested = /本轮用户指定成员：([^\n]*)/.exec(f.params.text)?.[1] ?? ''
      const delegates = f.params.text.includes('你是管理员。') && !f.params.text.includes('本批次执行结果：') && requested.startsWith('@')
      const markdownStream = String(f.params.text).includes('[streaming-markdown]')
      const markdownPrefix = '# 流式标题\n\n**即时格式化**\n\n- 第一项\n- 第二项\n\n```ts\nconst answer = 42' + (String(f.params.text).includes('[long]') ? `\n\x60\x60\x60\n\n${'这是持续生成的长回复段落。\n\n'.repeat(80)}流式末尾标记\n\n\x60\x60\x60ts\nconst tail = 1` : '')
      const markdownFinal = `${markdownPrefix}\n\x60\x60\x60\n\n| 名称 | 数量 |\n| --- | --- |\n| 项目 | 2 |\n\n最终完整标记`
      const text = markdownStream ? markdownFinal : `我是${name}。已按角色规则处理这条消息。\n\n- 会话独立保存\n- 可以继续交流\n\n[报告](/tmp/workspace-report.txt)${delegates ? `\n请${requested}处理任务。` : ''}`
      event('message.start', {}, f.params.session_id)
      setTimeout(() => event('message.delta', { text: markdownStream ? markdownPrefix : text.slice(0, 12) }, f.params.session_id), 80)
      const complete = () => {
        stored!.running = false
        stored!.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: text,
          timestamp: Date.now() / 1000,
        })
        event('message.complete', { text, status: 'complete' }, f.params.session_id)
      }
      if (markdownStream || f.params.text.includes('[hold-workspace]')) heldReplies.push(complete)
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
const runtime = createApplication({ config, auth }),
  node = createNodeServer(runtime)
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
    void node.close().then(() => {
      for (const socket of wss.clients) socket.terminate()
      wss.close()
      upstream.close()
    })
  })
