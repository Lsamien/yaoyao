// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { SystemUpdateManager } from '../../src/server/updateManager.js'

const runtimes: ApplicationRuntime[] = []
const roots: string[] = []
const host = '127.0.0.1:15300'
const origin = `http://${host}`
const base = '/api/app/system/update'
const latest = { schemaVersion: 1 as const, releaseVersion: '0.3.0', webVersion: '0.3.0', gitTag: 'v0.3.0' }

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'yaoyao-offline-update-')); roots.push(root)
  const projectRoot = join(root, 'project'); mkdirSync(projectRoot)
  writeFileSync(join(projectRoot, 'release.json'), JSON.stringify({ ...latest, releaseVersion: '0.2.0', webVersion: '0.2.0', gitTag: 'v0.2.0' }))
  const config: ServerConfig = {
    host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts: new Set(), home: join(root, 'data'), mediaRoot: root,
    attachmentsRoot: root, imagesRoot: root, mediaOwner: 'tester',
    allowInsecureLan: false, insecureLan: false, production: false,
    releaseRoot: join(root, 'installed'), releaseSource: 'https://example.test/repo.git',
  }
  const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('9119 offline') })
  const inspectRemote = vi.fn(async () => ({ manifest: latest, commit: 'b'.repeat(40) }))
  const launchUpdater = vi.fn(() => undefined)
  const updates = new SystemUpdateManager(config, { projectRoot, inspectRemote, launchUpdater, platform: 'darwin' })
  const runtime = createApplication({ config, fetchImpl, updates }); runtimes.push(runtime)
  return { runtime, fetchImpl, inspectRemote, launchUpdater, config }
}

async function login(runtime: ApplicationRuntime, username = 'admin', password = 'offline-test-password') {
  const agent = request.agent(runtime.app.callback())
  const boot = await agent.get('/api/app/bootstrap').set('Host', host).expect(200)
  const signedIn = await agent.post(boot.body.setupRequired ? '/api/app/setup' : '/api/app/login').set('Host', host).set('Origin', origin)
    .set('X-CSRF-Token', boot.body.csrfToken).send({ username, password }).expect(200)
  if (!signedIn.body.user.mustChangePassword) {
    return { agent, csrf: signedIn.body.csrfToken as string, user: signedIn.body.user }
  }
  const changed = await agent.put('/api/app/account/credentials').set('Host', host).set('Origin', origin)
    .set('X-CSRF-Token', signedIn.body.csrfToken)
    .send({ currentPassword: password, newPassword: 'offline-test-password', username }).expect(200)
  return { agent, csrf: changed.body.csrfToken as string, user: changed.body.user }
}

describe('independent Web updates', () => {
  it.each(['offline', 'unauthorized', 'server-error', 'stalled'] as const)('keeps every update route independent of a %s 9119', async failure => {
    const f = fixture()
    const { agent, csrf } = await login(f.runtime)
    if (failure === 'unauthorized') f.fetchImpl.mockResolvedValue(Response.json({}, { status: 401 }))
    if (failure === 'server-error') f.fetchImpl.mockResolvedValue(Response.json({}, { status: 503 }))
    if (failure === 'stalled') f.fetchImpl.mockImplementation(() => new Promise<Response>(() => {}))
    f.fetchImpl.mockClear()
    const mutation = (path: string) => agent.post(base + path).set('Host', host).set('Origin', origin).set('X-CSRF-Token', csrf)
    const status = await agent.get(base + '/status').set('Host', host).expect(200)
    expect(status.body.current.webVersion).toBe('0.2.0')
    expect(status.body.installedPluginVersion).toBeUndefined()
    const checked = await mutation('/check').send({}).expect(200)
    expect(checked.body).toMatchObject({ updateAvailable: true, latest, supported: true })
    await mutation('/apply').send({ targetVersion: 'arbitrary-ref' }).expect(400)
    await mutation('/apply').send({ targetVersion: '0.2.1' }).expect(409)
    expect(f.launchUpdater).not.toHaveBeenCalled()
    const queued = await mutation('/apply').send({ targetVersion: '0.3.0' }).expect(202)
    expect(queued.body).toMatchObject({ operation: 'update', target: latest, state: 'queued' })
    expect(queued.body.plan).toBeUndefined()
    const jobPath = join(f.config.home, 'updates', `${queued.body.id}.json`)
    const stored = JSON.parse(readFileSync(jobPath, 'utf8'))
    expect(stored.plan.targetCommit).toBe('b'.repeat(40))
    await agent.get(`${base}/jobs/${queued.body.id}`).set('Host', host).expect(200)
    await mutation('/apply').send({ targetVersion: '0.3.0' }).expect(409)
    expect(f.launchUpdater).toHaveBeenCalledTimes(1)
    writeFileSync(jobPath, JSON.stringify({ ...stored, state: 'succeeded' }))
    rmSync(join(f.config.home, 'updates', 'active.lock'))
    writeFileSync(join(f.config.home, 'updates', 'last-success.json'), '{}')
    const rollback = await mutation('/rollback').send({}).expect(202)
    expect(rollback.body).toMatchObject({ operation: 'rollback', state: 'queued' })
    await agent.get(`${base}/jobs/${rollback.body.id}`).set('Host', host).expect(200)
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('still requires local login, admin privilege, Origin and CSRF when 9119 is down', async () => {
    const f = fixture()
    const anonymous = request.agent(f.runtime.app.callback())
    const boot = await anonymous.get('/api/app/bootstrap').set('Host', host).expect(200)
    const getPaths = ['/status', '/jobs/11111111-1111-4111-8111-111111111111']
    for (const path of getPaths) await anonymous.get(base + path).set('Host', host).expect(401)
    for (const path of ['/check', '/apply', '/rollback', '/activate']) {
      await anonymous.post(base + path).set('Host', host).set('Origin', origin).set('X-CSRF-Token', boot.body.csrfToken)
        .send({ targetVersion: '0.3.0' }).expect(401)
    }
    const admin = await login(f.runtime)
    f.runtime.auth.create(admin.user, 'member', 'temporary-password')
    const member = await login(f.runtime, 'member', 'temporary-password')
    f.fetchImpl.mockClear()
    for (const path of getPaths) await member.agent.get(base + path).set('Host', host).expect(403)
    for (const path of ['/check', '/apply', '/rollback', '/activate']) {
      await member.agent.post(base + path).set('Host', host).set('Origin', origin).set('X-CSRF-Token', member.csrf)
        .send({ targetVersion: '0.3.0' }).expect(403)
      await admin.agent.post(base + path).set('Host', host).set('Origin', origin).send({}).expect(403)
      await admin.agent.post(base + path).set('Host', host).set('Origin', 'https://wrong.example')
        .set('X-CSRF-Token', admin.csrf).send({}).expect(403)
    }
    expect(f.fetchImpl).not.toHaveBeenCalled()
    expect(f.launchUpdater).not.toHaveBeenCalled()
  })

  it('preserves local login during a stalled bootstrap and still exposes update status', async () => {
    const f = fixture()
    const { agent } = await login(f.runtime)
    f.fetchImpl.mockClear()
    let finish!: (response: Response) => void
    f.fetchImpl.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve }))
    const started = Date.now()
    const boot = await agent.get('/api/app/bootstrap').set('Host', host).expect(200)
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(boot.body).toMatchObject({ authenticated: true, upstreamReady: false, user: { role: 'admin' } })
    expect(boot.body.upstreamError).toContain('仍可管理 15300 和升级 Web')
    await agent.get(base + '/status').set('Host', host).expect(200)
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    finish(Response.json({}, { status: 503 }))
  }, 10_000)

  it('reports real release-source failures without launching or contacting 9119', async () => {
    const f = fixture()
    const { agent, csrf } = await login(f.runtime)
    f.fetchImpl.mockClear()
    f.inspectRemote.mockRejectedValue(new Error('Git source unreachable'))
    const failed = await agent.post(base + '/check').set('Host', host).set('Origin', origin)
      .set('X-CSRF-Token', csrf).send({}).expect(502)
    expect(failed.body).toMatchObject({ code: 'system_update_source_failed' })
    expect(failed.body.error).toContain('Git source unreachable')
    expect(f.fetchImpl).not.toHaveBeenCalled()
    expect(f.launchUpdater).not.toHaveBeenCalled()
  })
})
