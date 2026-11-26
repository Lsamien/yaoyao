import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { systemUpdateRequestAllowed } from '../../src/server/routes.js'
import { SystemUpdateManager } from '../../src/server/updateManager.js'
import { createAuthenticatedApplication as createApplication } from './authenticatedApplication.js'
import { consoleClient } from './consoleClient.js'

const runtimes: ApplicationRuntime[] = []
const roots: string[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function cookieHeader(response: request.Response): string {
  const values = response.headers['set-cookie'] as unknown as string[]
  return values.map(value => value.split(';', 1)[0]).join('; ')
}

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

describe('system update routes', () => {
  it('allows loopback updates and requires an explicit opt-in for LAN clients', () => {
    expect(systemUpdateRequestAllowed('127.0.0.1')).toBe(true)
    expect(systemUpdateRequestAllowed('::ffff:127.0.0.1')).toBe(true)
    expect(systemUpdateRequestAllowed('192.168.1.8')).toBe(false)
    expect(systemUpdateRequestAllowed('192.168.1.8', true)).toBe(true)
  })

  it('checks and queues a fixed Web release without reconciling the plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-system-update-routes-'))
    roots.push(root)
    const projectRoot = join(root, 'project')
    mkdirSync(projectRoot)
    writeFileSync(join(projectRoot, 'release.json'), JSON.stringify({
      schemaVersion: 1, releaseVersion: '0.2.0', webVersion: '0.2.0', gitTag: 'v0.2.0',
    }))
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home: join(root, 'data'), mediaRoot: join(root, 'media'),
      attachmentsRoot: join(root, 'attachments'), imagesRoot: join(root, 'images'), mediaOwner: 'tester',
      allowInsecureLan: false, insecureLan: false, production: false,
      releaseRoot: join(root, 'installed'), releaseSource: 'https://example.test/hermes-yaoyao.git',
    }
    const launched: string[] = []
    const latest = {
      schemaVersion: 1 as const, releaseVersion: '0.3.0', webVersion: '0.3.0', gitTag: 'v0.3.0',
    }
    const updates = new SystemUpdateManager(config, {
      projectRoot,
      inspectRemote: async () => ({ manifest: latest, commit: 'b'.repeat(40) }),
      launchUpdater: path => { launched.push(path) },
      platform: 'darwin',
    })
    let pluginVersion = '1.7.1'
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path === '/api/status') return json({ auth_required: true }, { headers: { 'set-cookie': 'hermes_session_at=session; Path=/; HttpOnly' } })
      if (path === '/api/auth/me') return json({ user_id: 'admin', display_name: '管理员' })
      if (path === '/api/profiles') return json({ profiles: [{ name: 'default', is_default: true }] })
      if (path === '/api/plugins/yaoyao/profiles') return json({ profiles: [] })
      if (path === '/api/dashboard/plugins') return json([{ name: 'yaoyao', version: pluginVersion }])
      if (path === '/api/plugins/yaoyao/maintenance/storage') return json({ ready: true })
      if (path === '/api/dashboard/agent-plugins/install') {
        pluginVersion = '1.8.0'
        return json({ ok: true, plugin_name: 'yaoyao', enabled: true })
      }
      return json({ ok: true })
    }) as typeof fetch
    const runtime = createApplication({ config, fetchImpl, updates })
    runtimes.push(runtime)
    const admin = await consoleClient(runtime)
    const mutation = (path: string) => admin.call('post', path)

    const status = await admin.call('get', '/api/app/system/update/status').expect(200)
    expect(status.body).toMatchObject({ updateAvailable: false })
    expect(status.body.installedPluginVersion).toBeUndefined()

    const check = await mutation('/api/app/system/update/check').send({}).expect(200)
    expect(check.body).toMatchObject({ latest, updateAvailable: true })

    const queued = await mutation('/api/app/system/update/apply').send({ targetVersion: '0.3.0' }).expect(202)
    expect(queued.body).toMatchObject({ operation: 'update', state: 'queued', target: latest })
    expect(launched).toHaveLength(1)
    expect(pluginVersion).toBe('1.7.1')

    const jobResponse = await admin.call('get', `/api/app/system/update/jobs/${queued.body.id}`).expect(200)
    expect(jobResponse.body).toMatchObject({ id: queued.body.id, state: 'queued' })
  })
})
