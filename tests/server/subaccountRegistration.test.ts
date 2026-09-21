// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { LocalAuthStore } from '../../src/server/localAuth'
import { RegistrationLimiter } from '../../src/server/subaccountAccess'
let runtime: ApplicationRuntime, home: string, csrf: string
let admin: ReturnType<typeof request.agent>, child: ReturnType<typeof request.agent>
const host = '127.0.0.1:15300'
const call = (agent: typeof admin, method: 'get'|'post'|'patch'|'head', path: string, token = '') => agent[method](path).set('Host', host).set('Origin', `http://${host}`).set('X-CSRF-Token', token)
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-registration-'))
  runtime = createApplication({ config: loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_UPSTREAM: 'http://127.0.0.1:1', HERMES_YAOYAO_ALLOWED_HOSTS: '127.0.0.1' }), fetchImpl: (async input => {
    const path = new URL(String(input)).pathname
    return Response.json(path === '/api/profiles' ? { profiles: [{ name: 'allowed' }] } : path === '/api/status' ? { auth_required: true } : { user_id: 'service' })
  }) as typeof fetch })
  admin = request.agent(runtime.app.callback()); child = request.agent(runtime.app.callback())
})
afterEach(() => { runtime.close(); rmSync(home, { recursive: true, force: true }) })
async function setup() {
  const boot = await call(admin, 'get', '/api/app/bootstrap')
  csrf = (await call(admin, 'post', '/api/app/setup', boot.body.csrfToken).send({ username: 'admin', password: 'admin-password' }).expect(200)).body.csrfToken
}
async function register(username = 'new-child') {
  const boot = await call(child, 'get', '/api/app/bootstrap')
  const result = await call(child, 'post', '/api/app/register', boot.body.csrfToken).send({ username, password: 'child-password' }).expect(201)
  expect(result.body.registrationStatus).toBe('pending')
  expect(result.headers['set-cookie']).toBeUndefined()
  return boot.body.csrfToken as string
}
describe('subaccount registration and approval through real middleware', () => {
  it('keeps initial setup exclusive and validates CSRF, role injection and credentials', async () => {
    const boot = await call(child, 'get', '/api/app/bootstrap')
    expect(boot.body.registrationAvailable).toBe(false)
    await call(child, 'post', '/api/app/register', boot.body.csrfToken).send({ username: 'early', password: 'child-password' }).expect(409)
    await setup()
    expect((await call(child, 'get', '/api/app/bootstrap')).body.registrationAvailable).toBe(true)
    await call(child, 'post', '/api/app/register').send({ username: 'bad', password: 'child-password' }).expect(403)
    await call(child, 'post', '/api/app/register', boot.body.csrfToken).send({ username: 'bad', password: 'child-password', role: 'admin', enabled: true }).expect(400)
    await call(child, 'post', '/api/app/register', boot.body.csrfToken).send({ username: 'bad', password: 'short' }).expect(400)
    await register()
    await call(child, 'post', '/api/app/register', boot.body.csrfToken).send({ username: 'NEW-CHILD', password: 'child-password' }).expect(409)
  })
  it('requires valid assigned profiles to approve; preserves pending status across restart and blocks enable bypass', async () => {
    await setup(); const token = await register()
    await call(child, 'post', '/api/app/login', token).send({ username: 'new-child', password: 'wrong' }).expect(401)
    expect((await call(child, 'post', '/api/app/login', token).send({ username: 'new-child', password: 'child-password' }).expect(403)).body.code).toBe('account_pending_approval')
    expect((await call(child, 'post', '/auth/password-login').send({ username: 'new-child', password: 'child-password' }).expect(403)).body.code).toBe('account_pending_approval')
    await call(child, 'get', '/api/app/workspace/snapshot').expect(401)
    const user = (await call(admin, 'get', '/api/app/admin/users')).body.items.find((u: any) => u.username === 'new-child')
    expect(user).toMatchObject({ registrationStatus: 'pending', role: 'user', enabled: false, assignedProfiles: [], mustChangePassword: false })
    expect(new LocalAuthStore(home).isUserActive(user.id)).toBe(false)
    await call(admin, 'patch', `/api/app/admin/users/${user.id}`, csrf).send({ enabled: true, assignedProfiles: ['allowed'] }).expect(409)
    await call(admin, 'post', `/api/app/admin/users/${user.id}/approve`, csrf).send({ assignedProfiles: [] }).expect(400)
    await call(admin, 'post', `/api/app/admin/users/${user.id}/approve`, csrf).send({ assignedProfiles: ['missing'] }).expect(409)
    await call(child, 'post', `/api/app/admin/users/${user.id}/approve`, token).send({ assignedProfiles: ['allowed'] }).expect(401)
    const approved = await call(admin, 'post', `/api/app/admin/users/${user.id}/approve`, csrf).send({ assignedProfiles: ['allowed'] }).expect(200)
    expect(approved.body).toMatchObject({ enabled: true, registrationStatus: 'approved', assignedProfiles: ['allowed'], mustChangePassword: false })
    await call(admin, 'post', `/api/app/admin/users/${user.id}/approve`, csrf).send({ assignedProfiles: ['allowed'] }).expect(409)
    const login = await call(child, 'post', '/api/app/login', token).send({ username: 'new-child', password: 'child-password' }).expect(200)
    const create = await call(child, 'post', '/api/app/agents', login.body.csrfToken).send({ name: '我的 Bot', profile: 'allowed' }).expect(201)
    const snapshot = (await call(child, 'get', '/api/app/workspace/snapshot').expect(200)).body
    expect(snapshot.agents.map((a: any) => a.id)).toEqual([create.body.agent.id])
    expect(snapshot.conversations).toHaveLength(1)
    expect((await call(admin, 'get', '/api/app/workspace/snapshot')).body.agents).toEqual([])
    await call(child, 'get', '/api/app/workspace/projects').expect(200)
    await call(child, 'get', '/api/app/workspace/collaboration').expect(200)
    await call(child, 'get', '/api/app/workspace/memory-jobs').expect(200)
    await call(child, 'post', '/api/app/workspace/snapshot', login.body.csrfToken).send({}).expect(403)
    await call(child, 'get', '/api/app/workspace/admin').expect(403)
    await call(child, 'get', '/api/app/admin/users').expect(403)
    await call(admin, 'patch', `/api/app/admin/users/${user.id}`, csrf).send({ enabled: false }).expect(200)
    await call(child, 'get', '/api/app/workspace/snapshot').expect(401)
  })
  it('bounds registration attempts without changing login or administrator creation', async () => {
    await setup()
    const token = (await call(child, 'get', '/api/app/bootstrap')).body.csrfToken
    for (let i = 0; i < 10; i++) await call(child, 'post', '/api/app/register', token).send({}).expect(400)
    const limited = await call(child, 'post', '/api/app/register', token).send({}).expect(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    await call(admin, 'post', '/api/app/admin/users', csrf).send({ username: 'managed', password: 'temporary-password' }).expect(201)
    const login = await call(child, 'post', '/api/app/login', token).send({ username: 'managed', password: 'temporary-password' }).expect(200)
    expect(login.body.user.mustChangePassword).toBe(true)
    const limiter = new RegistrationLimiter()
    for (let i = 0; i < 10; i++) expect(limiter.take('ip', 0)).toBe(0)
    expect(limiter.take('ip', 1)).toBe(900)
    expect(limiter.take('ip', 900_000)).toBe(0)
  })
  it('authorizes owner-scoped projects, memory, attachments and event replay through the complete middleware', async () => {
    await setup(); const token = await register()
    const user = (await call(admin, 'get', '/api/app/admin/users')).body.items.find((u: any) => u.username === 'new-child')
    await call(admin, 'post', `/api/app/admin/users/${user.id}/approve`, csrf).send({ assignedProfiles: ['allowed'] }).expect(200)
    const login = await call(child, 'post', '/api/app/login', token).send({ username: 'new-child', password: 'child-password' }).expect(200)
    const childCSRF = login.body.csrfToken
    const agent = (await call(child, 'post', '/api/app/agents', childCSRF).send({ name: '知识助手', profile: 'allowed' }).expect(201)).body.agent
    await call(child, 'head', '/api/app/workspace/snapshot').expect(200)
    const project = (await call(child, 'post', '/api/app/workspace/projects', childCSRF).send({ requestId: randomUUID(), name: '私人项目', memberIds: [agent.id] }).expect(200)).body.project
    expect((await call(admin, 'get', '/api/app/workspace/projects')).body.projects).toEqual([])
    const scope = { scope: 'project', agentId: agent.id, projectId: project.id }
    const memory = (await call(child, 'post', '/api/app/workspace/memories', childCSRF).send({ ...scope, requestId: randomUUID(), content: '只属于此账号的记忆' }).expect(200)).body.memory
    const query = new URLSearchParams(scope).toString()
    expect((await call(child, 'get', `/api/app/workspace/memories?${query}`).expect(200)).body.memories.map((m: any) => m.id)).toContain(memory.id)
    await call(child, 'get', `/api/app/workspace/memories/${memory.id}/revisions?${query}`).expect(200)
    expect((await call(child, 'get', `/api/app/workspace/memory-export?${query}`).expect(200)).text).toContain('只属于此账号的记忆')
    expect((await call(admin, 'get', `/api/app/workspace/memories?${query}`).expect(200)).body.memories).toEqual([])
    await call(admin, 'get', `/api/app/workspace/memories/${memory.id}/revisions?${query}`).expect(404)
    await call(child, 'post', '/api/app/workspace/memories/forget', childCSRF).send({ ...scope, id: memory.id, expectedRevision: memory.revision, requestId: randomUUID() }).expect(200)
    const file = (await call(child, 'post', '/api/app/uploads', childCSRF).attach('files', Buffer.from('子账号附件'), { filename: 'child.txt', contentType: 'text/plain' }).expect(201)).body.files[0]
    await call(child, 'get', `/api/app/files/${file.id}/download`).expect(200)
    await call(admin, 'get', `/api/app/files/${file.id}/download`).expect(404)
    // Unknown resources reach owner-scoped handlers, rather than the Bot-only gate.
    await call(child, 'post', `/api/app/workspace/memory-jobs/${randomUUID()}/retry`, childCSRF).send({}).expect(404)
    await call(child, 'post', `/api/app/workspace/collaboration/${randomUUID()}/stop`, childCSRF).send({}).expect(404)
    const events = await call(child, 'get', '/api/app/events?after=0').expect(200)
    expect(events.body.events.some((e: any) => e.type === 'project.changed')).toBe(true)
    const caps = (await call(child, 'get', '/api/app/capabilities')).body.features
    for (const feature of ['voice', 'context', 'nodes']) expect(caps).not.toContain(feature)
    expect((await call(admin, 'get', '/api/app/capabilities')).body.features).toEqual(expect.arrayContaining(['voice', 'context', 'nodes']))
    const server = createServer(runtime.app.callback())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const cookie = (login.headers['set-cookie'] as unknown as string[]).map(value => value.split(';')[0]).join('; ')
    const abort = new AbortController()
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/app/events/stream?after=${events.body.cursor}`, { headers: { host, cookie }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const reader = response.body!.getReader(), decoder = new TextDecoder()
      let text = ''
      while (!text.includes('event: ready')) text += decoder.decode((await reader.read()).value)
      await call(admin, 'patch', `/api/app/admin/users/${user.id}`, csrf).send({ enabled: false }).expect(200)
      while (!(await reader.read()).done) { /* Revocation closes the old stream no later than its heartbeat. */ }
      await call(child, 'get', '/api/app/workspace/snapshot').expect(401)
    } finally {
      abort.abort(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 25_000)
})
