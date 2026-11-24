// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import { loadAdminConsoleConfig, loadServerConfig } from '../../src/server/config.js'
import { LocalAuthStore } from '../../src/server/localAuth.js'
import { AdminSessionStore } from '../../src/server/admin/sessions.js'
import { ipAllowed, needsReauthentication } from '../../src/server/admin/app.js'
import { isManagementRoute } from '../../src/server/admin/routes.js'
import { auditCsv, auditDetail } from '../../src/server/admin/audit.js'
import { totpCode, verifyTotp } from '../../src/server/admin/totp.js'
import { consoleClient } from './consoleClient.js'

const web = '127.0.0.1:15300'
let home: string, runtime: ApplicationRuntime | undefined, clock: number

function setupRuntime(env: Record<string, string> = {}): ApplicationRuntime {
  const config = loadServerConfig({ HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_MEDIA_ROOT: join(home, 'media'), ...env })
  const auth = new LocalAuthStore(home)
  const created = createApplication({ config, auth, adminSessions: new AdminSessionStore(home, auth, false, () => clock), fetchImpl: (async () => Response.json({ profiles: [{ name: 'default' }] })) as typeof fetch })
  runtime = created
  return created
}

async function webAgent() {
  const agent = request.agent(runtime!.app.callback())
  const boot = await agent.get('/api/app/bootstrap').set('Host', web).expect(200)
  const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, csrf = boot.body.csrfToken) =>
    agent[method](path).set('Host', web).set('Origin', `http://${web}`).set('X-CSRF-Token', csrf)
  return { agent, call, boot }
}

async function withAdminAndMember() {
  const owner = await webAgent()
  const setup = await owner.call('post', '/api/app/setup').send({ username: 'owner', password: 'owner-password' }).expect(200)
  const admin = await consoleClient(runtime!, { username: 'owner', password: 'owner-password' })
  await admin.call('post', '/api/app/admin/users').send({ username: 'member', password: 'member-password' }).expect(201)
  return { owner, ownerCsrf: setup.body.csrfToken as string, admin }
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'yaoyao-console-')); clock = Date.now() })
afterEach(() => { runtime?.close(); runtime = undefined; rmSync(home, { recursive: true, force: true }) })

describe('admin console listener', () => {
  it('splits routes: management only on the console, chat only on the Web', async () => {
    setupRuntime()
    const { owner, admin } = await withAdminAndMember()
    for (const path of ['/api/app/admin/users', '/api/app/system/update/status', '/api/app/system/push-status']) {
      const moved = await owner.call('get', path).expect(410)
      expect(moved.body.code).toBe('moved_to_admin_console')
    }
    await owner.call('put', '/api/app/server-identity').send({ name: 'x' }).expect(410)
    await owner.call('get', '/api/app/server-identity').expect(200)
    await admin.call('get', '/api/app/admin/users').expect(200)
    for (const path of ['/api/app/conversations', '/api/app/agents', '/api/app/bootstrap', '/api/profiles'])
      await admin.call('get', path).expect(404)
    await admin.call('get', '/api/app/settings/host-tools').expect(200)
  })

  it('admits administrators only and records every attempt', async () => {
    setupRuntime()
    await withAdminAndMember()
    const member = await consoleClient(runtime!)
    const denied = await member.call('post', '/api/app/console/login').send({ username: 'member', password: 'member-password' }).expect(403)
    expect(denied.body.code).toBe('admin_console_admin_only')
    expect(denied.headers['set-cookie']?.join(';') ?? '').not.toContain('yaoyao_admin_session=')
    await member.call('post', '/api/app/console/login').send({ username: 'owner', password: 'wrong' }).expect(401)
    const entries = runtime!.adminAudit.list({ module: '后台登录' })
    expect(entries.map(entry => [entry.actor, entry.outcome])).toEqual(expect.arrayContaining([['member', 'denied'], ['owner', 'denied'], ['owner', 'ok']]))
  })

  it('locks an address after five failures and keeps the lock for valid passwords', async () => {
    setupRuntime()
    await withAdminAndMember()
    const client = await consoleClient(runtime!)
    for (let i = 0; i < 5; i++) await client.call('post', '/api/app/console/login').send({ username: 'owner', password: `wrong-${i}` }).expect(401)
    const locked = await client.call('post', '/api/app/console/login').send({ username: 'owner', password: 'owner-password' }).expect(429)
    expect(locked.body.code).toBe('admin_login_locked')
  })

  it('never accepts a Web session on the console, or a console session on the Web', async () => {
    setupRuntime()
    const { owner, admin } = await withAdminAndMember()
    const webCookie = (await owner.agent.get('/api/app/bootstrap').set('Host', web)).request.cookies
    expect(webCookie).toContain('hermes_yaoyao_session=')
    await request(runtime!.adminApp.callback()).get('/api/app/admin/users').set('Host', admin.host).set('Cookie', webCookie).expect(401)
    const consoleCookie = admin.login!.headers['set-cookie']!.map((value: string) => value.split(';')[0]).join('; ')
    expect(consoleCookie).toContain('yaoyao_admin_session=')
    await request(runtime!.app.callback()).get('/api/app/conversations').set('Host', web).set('Cookie', consoleCookie).expect(401)
    // The console never writes the Web's cookies, which would clobber them on the same host.
    const session = await request(runtime!.adminApp.callback()).get('/api/app/console/session').set('Host', admin.host)
    expect((session.headers['set-cookie'] ?? []).join(';')).not.toMatch(/hermes_yaoyao_(?:session|csrf)=/)
  })

  it('requires Origin and the console CSRF token for writes', async () => {
    setupRuntime()
    const { admin, ownerCsrf } = await withAdminAndMember()
    const body = { username: 'third', password: 'third-password' }
    await admin.agent.post('/api/app/admin/users').set('Host', admin.host).set('Origin', admin.origin).send(body).expect(403)
    await admin.agent.post('/api/app/admin/users').set('Host', admin.host).set('Origin', admin.origin).set('X-CSRF-Token', ownerCsrf).send(body).expect(403)
    await admin.agent.post('/api/app/admin/users').set('Host', admin.host).set('Origin', 'http://127.0.0.1:15300').set('X-CSRF-Token', admin.csrf()).send(body).expect(403)
    await admin.call('post', '/api/app/admin/users').send(body).expect(201)
  })

  it('asks for the password again for high-risk writes after ten minutes, and audits without secrets', async () => {
    setupRuntime()
    const { admin } = await withAdminAndMember()
    clock += 11 * 60_000
    const blocked = await admin.call('put', '/api/app/system/allowed-hosts').send({ hosts: ['yaoyao.example.com'] }).expect(428)
    expect(blocked.body.code).toBe('admin_reauth_required')
    await admin.call('post', '/api/app/console/sudo').send({ password: 'wrong' }).expect(401)
    await admin.call('post', '/api/app/console/sudo').send({ password: 'owner-password' }).expect(200)
    await admin.call('put', '/api/app/system/allowed-hosts').send({ hosts: ['yaoyao.example.com'] }).expect(200)
    const audit = runtime!.adminAudit.list({ module: '网络与安全' })
    expect(audit.map(entry => entry.outcome)).toEqual(['ok', 'denied'])
    expect(auditDetail({ key: 'OPENROUTER_API_KEY', value: 'sk-secret', apiKey: 'x', password: 'p' })).toBe('key=OPENROUTER_API_KEY, value=已修改, apiKey=已修改, password=已修改')
  })

  it('expires idle sessions after thirty minutes', async () => {
    setupRuntime()
    const { admin } = await withAdminAndMember()
    clock += 31 * 60_000
    await admin.call('get', '/api/app/admin/users').expect(401)
  })

  it('sets up two-step verification, then requires a fresh code at login', async () => {
    setupRuntime()
    const { admin } = await withAdminAndMember()
    const begun = await admin.call('post', '/api/app/console/two-step/begin').send({}).expect(200)
    expect(begun.body.otpauth).toMatch(/^otpauth:\/\/totp\//)
    await admin.call('post', '/api/app/console/two-step/confirm').send({ code: '000000' }).expect(400)
    const code = totpCode(begun.body.secret, Math.floor(clock / 30_000))
    const confirmed = await admin.call('post', '/api/app/console/two-step/confirm').send({ code }).expect(200)
    expect(confirmed.body.recoveryCodes).toHaveLength(10)
    expect(readFileSync(join(home, 'admin-security.json'), 'utf8')).not.toContain(confirmed.body.recoveryCodes[0])
    const next = await consoleClient(runtime!)
    const missing = await next.call('post', '/api/app/console/login').send({ username: 'owner', password: 'owner-password' }).expect(401)
    expect(missing.body.code).toBe('admin_two_step_code_required')
    // A code that was already used is refused; a recovery code works once.
    await next.call('post', '/api/app/console/login').send({ username: 'owner', password: 'owner-password', code }).expect(401)
    await next.call('post', '/api/app/console/login').send({ username: 'owner', password: 'owner-password', code: confirmed.body.recoveryCodes[0] }).expect(200)
    const again = await consoleClient(runtime!)
    await again.call('post', '/api/app/console/login').send({ username: 'owner', password: 'owner-password', code: confirmed.body.recoveryCodes[0] }).expect(401)
  })

  it('makes two-step verification mandatory when the console is reachable from other machines', async () => {
    setupRuntime({ YAOYAO_ADMIN_HOST: '0.0.0.0', YAOYAO_ADMIN_ALLOW_IPS: '172.16.0.0/12', YAOYAO_ADMIN_INSECURE_HTTP: '1' })
    const owner = await webAgent()
    await owner.call('post', '/api/app/setup').send({ username: 'owner', password: 'owner-password' }).expect(200)
    const admin = await consoleClient(runtime!, { username: 'owner', password: 'owner-password' })
    expect(admin.login!.body).toMatchObject({ stage: 'enroll', twoStepRequired: true })
    await admin.call('get', '/api/app/admin/users').expect(403)
    const begun = await admin.call('post', '/api/app/console/two-step/begin').send({}).expect(200)
    await admin.call('post', '/api/app/console/two-step/confirm').send({ code: totpCode(begun.body.secret, Math.floor(clock / 30_000)) }).expect(200)
    await admin.call('get', '/api/app/admin/users').expect(200)
    await admin.call('delete', '/api/app/console/two-step').expect(409)
  })

  it('changes the console password and signs the admin out of the Web', async () => {
    setupRuntime()
    const { owner, admin } = await withAdminAndMember()
    await admin.call('post', '/api/app/console/password').send({ currentPassword: 'wrong', newPassword: 'another-password' }).expect(401)
    await admin.call('post', '/api/app/console/password').send({ currentPassword: 'owner-password', newPassword: 'another-password' }).expect(200)
    await owner.agent.get('/api/app/conversations').set('Host', web).expect(401)
    await admin.call('get', '/api/app/admin/users').expect(200)
  })

  it('registers a computer with a one-time pairing code from the console', async () => {
    setupRuntime()
    const { admin } = await withAdminAndMember()
    const created = await admin.call('post', '/api/app/admin/desktop-hosts/pairing-codes').send({}).expect(201)
    expect(created.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const machine = () => request(runtime!.app.callback()).post('/api/desktop-host/v1/enroll').set('Host', web)
    await machine().set('Origin', `http://${web}`).send({ code: created.body.code, name: 'Studio Mac' }).expect(403)
    const enrolled = await machine().send({ code: created.body.code.toLowerCase(), name: 'Studio Mac' }).expect(201)
    expect(enrolled.body.token).toEqual(expect.any(String))
    expect(enrolled.body.host).toMatchObject({ name: 'Studio Mac', enabled: true })
    await machine().send({ code: created.body.code, name: 'Second Mac' }).expect(403)
    for (let i = 0; i < 9; i++) await machine().send({ code: 'WRONG-CODE', name: 'x' }).expect(403)
    await machine().send({ code: 'WRONG-CODE', name: 'x' }).expect(429)
    // Creating a code is a high-risk write: it needs a recent password confirmation.
    clock += 11 * 60_000
    await admin.call('post', '/api/app/admin/desktop-hosts/pairing-codes').send({}).expect(428)
  })

  it('exports the audit log as CSV with formulas neutralised', () => {
    const csv = auditCsv([{ id: 1, at: 0, actor: '=cmd', ip: '127.0.0.1', module: '用户与权限', action: 'POST /x', target: '/x', outcome: 'ok', status: 201, detail: 'a, "b"' }])
    expect(csv).toContain(`"'=cmd"`)
    expect(csv).toContain('"a, ""b"""')
  })
})

describe('admin console configuration', () => {
  it('defaults to a loopback listener on 15301', () => {
    expect(loadAdminConsoleConfig({}, 15300, false)).toMatchObject({ enabled: true, host: '127.0.0.1', port: 15301, external: false })
    expect(loadAdminConsoleConfig({ YAOYAO_ADMIN_PORT: 'off' }, 15300, false).enabled).toBe(false)
  })

  it('refuses an exposed listener without a client allowlist and transport security', () => {
    expect(() => loadAdminConsoleConfig({ YAOYAO_ADMIN_HOST: '0.0.0.0' }, 15300, true)).toThrow(/ALLOW_IPS/)
    expect(() => loadAdminConsoleConfig({ YAOYAO_ADMIN_HOST: '0.0.0.0', YAOYAO_ADMIN_ALLOW_IPS: '10.0.0.5' }, 15300, false)).toThrow(/TLS/)
    expect(loadAdminConsoleConfig({ YAOYAO_ADMIN_HOST: '0.0.0.0', YAOYAO_ADMIN_ALLOW_IPS: '10.0.0.5' }, 15300, true).external).toBe(true)
    expect(() => loadAdminConsoleConfig({ YAOYAO_ADMIN_PORT: '15300' }, 15300, false)).toThrow(/differ/)
    expect(() => loadAdminConsoleConfig({ YAOYAO_ADMIN_HOST: '0.0.0.0', YAOYAO_ADMIN_ALLOW_IPS: 'not an ip' }, 15300, true)).toThrow(/invalid entry/)
  })

  it('matches client addresses against the allowlist; loopback is always allowed', () => {
    expect(ipAllowed('127.0.0.1', [])).toBe(true)
    expect(ipAllowed('::ffff:172.18.0.1', ['172.16.0.0/12'])).toBe(true)
    expect(ipAllowed('192.168.1.10', ['172.16.0.0/12'])).toBe(false)
    expect(ipAllowed('10.0.0.5', ['10.0.0.5'])).toBe(true)
    expect(ipAllowed('fd00::1', ['fd00::/8'])).toBe(true)
  })

  it('classifies management routes and high-risk writes', () => {
    expect(isManagementRoute('GET', '/api/app/admin/users')).toBe(true)
    expect(isManagementRoute('GET', '/api/app/settings/host-tools')).toBe(false)
    expect(isManagementRoute('PUT', '/api/app/settings/host-tools')).toBe(true)
    expect(isManagementRoute('GET', '/api/app/grok-cloud/auth')).toBe(false)
    expect(isManagementRoute('POST', '/api/app/grok-cloud/auth/start')).toBe(true)
    expect(isManagementRoute('GET', '/api/app/nodes/abc/agents')).toBe(false)
    expect(isManagementRoute('GET', '/api/app/tts/settings')).toBe(false)
    expect(isManagementRoute('PUT', '/api/app/tts/settings/openai')).toBe(true)
    expect(isManagementRoute('DELETE', '/api/app/stt/settings/openai/secret/key')).toBe(true)
    expect(needsReauthentication('PUT', '/api/app/admin/hermes/credentials')).toBe(true)
    expect(needsReauthentication('POST', '/api/app/admin/model-services/validate')).toBe(false)
    expect(needsReauthentication('GET', '/api/app/system/update/status')).toBe(false)
    expect(verifyTotp('JBSWY3DPEHPK3PXP', totpCode('JBSWY3DPEHPK3PXP', 100), 100 * 30_000)).toBe(100)
  })
})
