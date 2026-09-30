/** Optional two-checkout acceptance: real mobile core + real BFF over local HTTP.
 * Hermes is a deterministic loopback fixture. No production service is used. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer } from 'ws'
import { createApplication, type ApplicationRuntime } from '../src/server/app.js'
import type { ServerConfig } from '../src/server/config.js'

const root = resolve(import.meta.dirname, '..')
const mobile = resolve(process.env.YAOYAO_MOBILE_CHECKOUT ?? join(root, '../yaoyao-mobile'))
const { YaoyaoAPI } = await import(pathToFileURL(join(mobile, 'apps/mobile/src/core/api.ts')).href)
const { OrdinaryStore } = await import(pathToFileURL(join(mobile, 'apps/mobile/src/core/ordinary.ts')).href)
const { createOrdinaryCache } = await import(pathToFileURL(join(mobile, 'apps/mobile/src/core/ordinary-cache.ts')).href)
const listen = (server: Server, port = 0) => new Promise<string>(done => server.listen(port, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
const close = (server: Server) => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() })
function sqlite(db: DatabaseSync) {
  return { async execAsync(sql: string) { db.exec(sql) }, async runAsync(sql: string, ...args: any[]) { return db.prepare(sql).run(...args) },
    async getFirstAsync(sql: string, ...args: any[]) { return db.prepare(sql).get(...args) ?? null }, async getAllAsync(sql: string, ...args: any[]) { return db.prepare(sql).all(...args) } }
}

test('mobile 1.5 core recovers durable attachments across BFF restart, never repeats admission, and loses its transcript stream on logout', { timeout: 45000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-mobile-pair-')), cookies = new Map<string, string>()
  const commands: Array<{ method: string; params: any }> = []
  let runtime: ApplicationRuntime | undefined, web: Server | undefined, store: any, api: any, db: DatabaseSync | undefined
  let attached = false, simulateDisconnect = true
  const hermes = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const path = req.url?.split('?')[0]
    res.end(JSON.stringify(path === '/api/status' ? { auth_required: true, dashboard_running: true }
      : path === '/api/auth/ws-ticket' ? { ticket: 'fixture' }
      : path === '/api/profiles' ? { profiles: [{ name: 'default', is_default: true }] }
      : path?.endsWith('/messages') ? { messages: [], pagination: { total: 0, returned: 0 } }
      : path === '/api/sessions' || path === '/api/profiles/sessions' ? { sessions: [] }
      : path === '/api/config' ? { config: { terminal: { cwd: '' } } } : { ok: true }))
  })
  const upstream = await listen(hermes), ws = new WebSocketServer({ server: hermes })
  ws.on('connection', socket => {
    socket.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'fixture' } } }))
    socket.on('message', raw => {
      const f = JSON.parse(String(raw)); commands.push(f)
      const result = ['session.create', 'session.resume'].includes(f.method) ? { session_id: 'runtime-fixture', stored_session_id: 'stored-fixture', running: false, info: { profile_name: 'default' } }
        : f.method === 'file.attach' ? { ref_text: '@file:/fixture/upload.txt', path: '/fixture/upload.txt' }
        : f.method === 'session.events.since' ? { epoch: 'fixture', events: [] }
        : f.method === 'session.active_list' ? { sessions: [{ id: 'runtime-fixture', status: 'idle' }] } : { status: 'accepted', ok: true }
      socket.send(JSON.stringify({ id: f.id, result }))
    })
  })
  for (const folder of ['media', 'attachments', 'images']) mkdirSync(join(home, folder))
  const config: ServerConfig = { home, host: '127.0.0.1', port: 0, upstream: new URL(upstream), allowedHosts: new Set(),
    mediaRoot: join(home, 'media'), attachmentsRoot: join(home, 'attachments'), imagesRoot: join(home, 'images'), mediaOwner: 'fixture',
    production: true, allowInsecureLan: false, insecureLan: false, superviseDashboard: false, localVmHost: 'runner' }
  const fetcher = async (url: string, options?: RequestInit) => {
    const headers = new Headers(options?.headers)
    // This Node fixture has no native Cookie/URLSession jar. Avoid reusing its
    // global fetch pool across a deliberately destroyed/rebound test listener.
    headers.set('Connection', 'close')
    headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    if (attached && simulateDisconnect && decodeURIComponent(new URL(url).pathname).startsWith('/api/realtime/commands/ios:prompt:')) {
      simulateDisconnect = false; throw new Error('Fixture disconnect before prompt admission')
    }
    const response = await fetch(url, { ...options, headers })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!, at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1))
    }
    if (options?.method === 'POST' && new URL(url).pathname.endsWith('/commands') && JSON.parse(String(options.body)).method === 'file.attach' && response.ok) attached = true
    return response
  }
  const openCache = async () => {
    db = new DatabaseSync(join(home, 'mobile.sqlite3'))
    db.exec('CREATE TABLE IF NOT EXISTS account_documents(scope TEXT PRIMARY KEY,payload TEXT NOT NULL)')
    return createOrdinaryCache(sqlite(db))
  }
  try {
    runtime = createApplication({ config, deferBackground: true }); web = createServer(runtime.app.callback())
    const origin = await listen(web); config.port = Number(new URL(origin).port)
    api = new YaoyaoAPI(origin, fetcher); await api.bootstrap()
    const setup = await api.request('/api/app/setup', 'POST', { username: 'pair-fixture', password: 'pair-fixture-password' })
    api.csrf = setup.csrfToken
    const owner = setup.user.id
    assert.ok((await api.request('/api/realtime/capabilities')).features.includes('ordinary-chat-transcript-v2'))
    store = new OrdinaryStore(api, await openCache(), 'pair-account', randomUUID, async () => 'Zml4dHVyZQ==')
    await store.start(); await store.newSession('default')
    await store.setAttachments([{ id: 'file', name: 'fixture.txt', mimeType: 'text/plain', uri: 'file:///fixture.txt' }])
    await store.send('paired attachment')
    const pending = store.getSnapshot().data.pending[0]
    assert.ok(pending, 'the interrupted send must remain in the durable mobile cache')
    assert.ok(pending.attemptedCommands.includes(`ios:attachment:${pending.id}:file`), JSON.stringify({ state: pending.state, error: pending.error, attempted: pending.attemptedCommands, methods: commands.map(f => f.method) }))
    assert.ok(!pending.attemptedCommands.includes(`ios:prompt:${pending.id}`))
    assert.equal(commands.filter(f => f.method === 'file.attach').length, 1)
    assert.equal(commands.filter(f => f.method === 'prompt.submit').length, 0)
    await store.close(); await api.close(); db!.close(); db = undefined
    runtime.close(); runtime = undefined; await close(web); web = undefined
    runtime = createApplication({ config, deferBackground: true }); web = createServer(runtime.app.callback()); await listen(web, config.port)
    api = new YaoyaoAPI(origin, fetcher); await api.bootstrap()
    store = new OrdinaryStore(api, await openCache(), 'pair-account', randomUUID, async () => 'Zml4dHVyZQ==')
    await store.start(); await store.retry(pending.id); await store.retry(pending.id)
    assert.equal(commands.filter(f => f.method === 'file.attach').length, 1, 'restart must reuse the persisted attachment reference')
    const prompts = commands.filter(f => f.method === 'prompt.submit')
    assert.equal(prompts.length, 1, JSON.stringify({ expectation: 'retry must execute the never-admitted prompt once', pending: store.getSnapshot().data.pending.map((p: any) => ({ state: p.state, error: p.error, attempted: p.attemptedCommands })), methods: commands.map(f => f.method) }))
    assert.match(prompts[0]!.params.text, /@file:\/fixture\/upload\.txt/)
    const snapshot = await api.request('/api/app/chat/sessions/stored-fixture/snapshot?profile=default')
    assert.equal(snapshot.protocol, 'ordinary-chat-transcript-v2')
    assert.ok(snapshot.messages.some((m: any) => m.client_message_id === pending.id))
    let ready!: () => void
    const opened = new Promise<void>(done => { ready = done }), frames: any[] = []
    const stream = api.events('/api/app/chat/sessions/stored-fixture/events?profile=default', `${snapshot.epoch}:${snapshot.cursor}`, async (frame: any) => {
      frames.push(frame); if (frame.event === 'ready') ready()
    }).catch((error: Error) => error)
    await opened
    await api.request('/api/app/logout', 'POST', {})
    runtime.chatCache!.store.recordCommand(owner, 'default', 'stored-fixture', 'prompt.submit', { text: 'must-not-leak-after-logout', _delivery_id: 'late-fixture' })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([stream, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Logged-out transcript stream did not close')), 1500) })]) }
    finally { clearTimeout(timeout) }
    assert.ok(!JSON.stringify(frames).includes('must-not-leak-after-logout'))
    console.log('PAIR_OK: transcript-v2 handshake; real HTTP/SSE; SQLite reopen; BFF restart; attachment once; prompt once; canonical echo; logout closes stream')
  } finally {
    await store?.close().catch(() => {}); await api?.close().catch(() => {}); db?.close(); runtime?.close()
    if (web) await close(web)
    for (const socket of ws.clients) socket.terminate()
    await new Promise<void>(done => ws.close(() => done())); await close(hermes)
    rmSync(home, { recursive: true, force: true })
  }
})
