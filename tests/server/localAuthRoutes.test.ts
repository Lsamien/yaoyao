import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { Server } from 'node:http'
import type { ServerConfig } from '../../src/server/config.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []
const servers: Server[] = []
async function listen(runtime: ApplicationRuntime) {
  // Keep one listener for the whole scenario. Repeated implicit Supertest
  // listen/close cycles can race pooled HTTP connections on recent Node versions.
  const server = runtime.app.listen(0, '127.0.0.1'); servers.push(server)
  await new Promise<void>(resolve => server.once('listening', resolve))
  return server
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve())
  })
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function cookies(response: request.Response): string {
  const values = response.headers['set-cookie'] as unknown as string[] | undefined
  return (values ?? []).map(value => value.split(';', 1)[0]).join('; ')
}

describe('15300 local authentication routes', () => {
  it('installs without upstream credentials while keeping local login and CSRF mandatory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-token-')); roots.push(home)
    const token = 'fixture_local_only_session_token_123456'
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false, superviseDashboard: true,
    }
    const runtime = createApplication({ config, fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: false })
      if (path === '/') return new Response(`<script>window.__HERMES_SESSION_TOKEN__="${token}";</script>`)
      if (new Headers(init?.headers).get('x-hermes-session-token') !== token) return Response.json({}, { status: 401 })
      return Response.json({ profiles: [{ name: 'default', is_default: true, display_name: '丫头' }] })
    }) as typeof fetch }); runtimes.push(runtime)
    expect(runtime.auth.upstreamCredentials()).toBeUndefined()
    const server = await listen(runtime)
    const agent = request.agent(server), origin = 'http://127.0.0.1:15300'
    await agent.get('/api/realtime/capabilities').set('Host', '127.0.0.1:15300').expect(401)
    const boot = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    expect(boot.body).toMatchObject({ authRequired: true, setupRequired: true })
    await agent.post('/api/app/login').set('Host', '127.0.0.1:15300').set('Origin', origin)
      .set('X-CSRF-Token', boot.body.csrfToken).send({ username: 'admin', password: 'admin' }).expect(401)
    const setup = await agent.post('/api/app/setup').set('Host', '127.0.0.1:15300').set('Origin', origin)
      .set('X-CSRF-Token', boot.body.csrfToken).send({ username: 'owner', password: 'fixture-password' }).expect(200)
    await agent.post('/api/app/setup').set('Host', '127.0.0.1:15300').set('Origin', origin)
      .set('X-CSRF-Token', setup.body.csrfToken).send({ username: 'other', password: 'fixture-password' }).expect(409)
    const ready = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    expect(ready.body).toMatchObject({ authRequired: true, authenticated: true, upstreamReady: true })
    expect(ready.body.profiles).toHaveLength(1)
    expect(JSON.stringify([ready.body, ready.headers])).not.toContain(token)
    expect(runtime.auth.upstreamCredentials()).toBeUndefined()
    const avatar = 'data:image/png;base64,aGVsbG8='
    const avatarUpdate = await agent.put('/api/app/account/avatar').set('Host', '127.0.0.1:15300').set('Origin', origin)
      .set('X-CSRF-Token', ready.body.csrfToken).send({ avatar }).expect(200)
    expect(avatarUpdate.body.user.avatar).toBe(avatar)
    expect((await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)).body.user.avatar).toBe(avatar)
    expect((await agent.get('/api/auth/me').set('Host', '127.0.0.1:15300').expect(200)).body.avatar).toBe(avatar)
    await agent.put('/api/app/account/avatar').set('Host', '127.0.0.1:15300').set('Origin', origin)
      .set('X-CSRF-Token', ready.body.csrfToken).send({ avatar: 'https://example.test/avatar.png' }).expect(400)
    await agent.post('/api/realtime/channels').set('Host', '127.0.0.1:15300').set('Origin', origin).send({ channel: 'chat' }).expect(403)
    await request(server).get('/api/realtime/capabilities').set('Host', '127.0.0.1:15300').expect(401)
  })
  it('creates an explicit administrator, then serves shared profiles through the service account', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-routes-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
      superviseDashboard: true,
      upstreamUsername: 'service', upstreamPassword: 'fixture-password',
    }
    let wsTicketForwardedFor: string | null | undefined
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      const headers = new Headers(init?.headers)
      if (path === '/api/status') return Response.json({ auth_required: true })
      if (path === '/api/auth/me') return headers.get('cookie')
        ? Response.json({ user_id: 'service' })
        : Response.json({ error: 'unauthorized' }, { status: 401 })
      if (path === '/api/auth/providers') return Response.json({ providers: [{ name: 'basic', supports_password: true }] })
      if (path === '/auth/password-login') return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json', 'set-cookie': 'hermes_service=session; Path=/; HttpOnly' },
      })
      if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true, display_name: '丫头' }] })
      if (path === '/api/auth/ws-ticket') {
        wsTicketForwardedFor = headers.get('x-forwarded-for')
        return Response.json({ ticket: 'upstream-ticket' })
      }
      if (path === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [{ name: 'default', botName: '丫头' }] })
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createApplication({ config, fetchImpl })
    runtimes.push(runtime)
    const server = await listen(runtime)
    const agent = request.agent(server)
    const initial = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    const setup = await agent.post('/api/app/setup')
      .set('Host', '127.0.0.1:15300').set('Origin', 'http://127.0.0.1:15300')
      .set('X-CSRF-Token', initial.body.csrfToken).send({ username: 'owner', password: 'new-password' }).expect(200)
    expect(setup.body.user).toMatchObject({ username: 'owner', role: 'admin', mustChangePassword: false })
    expect(setup.body.profiles).toHaveLength(1)

    const ready = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    expect(ready.body).toMatchObject({ upstreamReady: true, serverKind: 'yaoyao-web' })
    expect(ready.body.profiles).toHaveLength(1)
    const connection = await agent.get('/api/app/admin/upstream-connection')
      .set('Host', '127.0.0.1:15300').expect(200)
    expect(connection.body).toMatchObject({
      endpoint: 'http://127.0.0.1:9119',
      authMode: 'password',
      networkScope: 'local',
      webNetworkScope: 'local',
      ready: true,
    })
    expect(connection.body.lastVerifiedAt).toEqual(expect.any(Number))

    await agent.post('/api/app/admin/users')
      .set('Host', '127.0.0.1:15300').set('Origin', 'http://127.0.0.1:15300')
      .set('X-CSRF-Token', ready.body.csrfToken)
      .send({ username: 'member', password: 'temporary-password' }).expect(201)
    const users = await agent.get('/api/app/admin/users').set('Host', '127.0.0.1:15300').expect(200)
    expect(users.body.items.map((user: { username: string }) => user.username)).toEqual(['owner', 'member'])
    expect(cookies(setup)).not.toContain('admin')

    const accountPairing = await agent.post('/api/app/account-pairings')
      .set('Host', '127.0.0.1:15300').set('Origin', 'http://127.0.0.1:15300')
      .set('X-CSRF-Token', ready.body.csrfToken).send({}).expect(201)
    const loginCode = new URL(accountPairing.body.qrPayload)
    expect(loginCode.hostname).toBe('login')
    const scanned = request.agent(server)
    await scanned.post('/api/account-pair/v1/claim').set('Host', '127.0.0.1:15300')
      .send({ pairingId: loginCode.searchParams.get('id'), secret: loginCode.searchParams.get('secret') })
      .expect(201)
    const scannedIdentity = await scanned.get('/api/auth/me').set('Host', '127.0.0.1:15300').expect(200)
    expect(scannedIdentity.body).toMatchObject({ username: 'owner', role: 'admin' })
    await request(server).post('/api/account-pair/v1/claim')
      .set('Host', '127.0.0.1:15300')
      .send({ pairingId: loginCode.searchParams.get('id'), secret: loginCode.searchParams.get('secret') })
      .expect(409)

    const native = request.agent(server)
    await native.get('/api/status').set('Host', '127.0.0.1:15300').expect(200, /yaoyao-web/)
    await native.post('/auth/password-login').set('Host', '127.0.0.1:15300')
      .send({ provider: 'basic', username: 'owner', password: 'new-password', next: '' }).expect(200)
    const identity = await native.get('/api/auth/me').set('Host', '127.0.0.1:15300').expect(200)
    expect(identity.body).toMatchObject({ username: 'owner', role: 'admin', server_kind: 'yaoyao-web' })
    const nativeProfiles = await native.get('/api/profiles').set('Host', '127.0.0.1:15300').expect(200)
    expect(nativeProfiles.body.profiles[0]).toMatchObject({
      name: 'default', description: '丫头', display_name: '丫头', agentName: '丫头',
    })
    await native.post('/api/auth/ws-ticket').set('Host', '127.0.0.1:15300').send({}).expect(410)
    expect(wsTicketForwardedFor).toBeUndefined()
  })
})
