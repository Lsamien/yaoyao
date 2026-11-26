import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { consoleClient } from './consoleClient.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import {
  AllowedHostsConfigurationManager,
  allowedHostsConfigurationPath,
  loadAllowedHostsConfiguration,
  normalizeAllowedHost,
} from '../../src/server/allowedHostsConfiguration.js'
import { createAuthenticatedApplication } from './authenticatedApplication.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-allowed-hosts-'))
  roots.push(home)
  return home
}

function config(home: string, allowedHosts = new Set<string>()): ServerConfig {
  return {
    host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts, home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
    mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
  }
}

describe('allowed hosts configuration', () => {
  it('normalizes domains and IP addresses and rejects URLs or ports', () => {
    expect(normalizeAllowedHost('YAOYAO.Example.COM.')).toBe('yaoyao.example.com')
    expect(normalizeAllowedHost('[2001:db8::10]')).toBe('2001:db8::10')
    expect(normalizeAllowedHost('例子.测试')).toBe('xn--fsqu00a.xn--0zwm56d')
    expect(() => normalizeAllowedHost('https://yaoyao.example.com')).toThrow(/不能包含协议/)
    expect(() => normalizeAllowedHost('203.0.113.10:15300')).toThrow(/不能附加端口/)
  })

  it('persists Web entries with restrictive permissions and merges environment entries after restart', () => {
    const home = temporaryHome()
    const initial = loadAllowedHostsConfiguration(home, {
      HERMES_YAOYAO_ALLOWED_HOSTS: 'localhost,127.0.0.1',
    })
    const runtimeHosts = new Set(initial.hosts)
    const manager = new AllowedHostsConfigurationManager(home, initial, runtimeHosts)

    const saved = manager.update(['YAOYAO.Example.COM.', '203.0.113.10'])
    expect(saved).toMatchObject({
      editableHosts: ['203.0.113.10', 'yaoyao.example.com'],
      environmentHosts: ['127.0.0.1', 'localhost'],
    })
    expect([...runtimeHosts].sort()).toEqual([
      '127.0.0.1', '203.0.113.10', 'localhost', 'yaoyao.example.com',
    ])
    expect(statSync(allowedHostsConfigurationPath(home)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(allowedHostsConfigurationPath(home), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      hosts: ['203.0.113.10', 'yaoyao.example.com'],
    })

    expect(loadAllowedHostsConfiguration(home, {
      HERMES_YAOYAO_ALLOWED_HOSTS: 'localhost,proxy.example.com',
    })).toMatchObject({
      hosts: ['203.0.113.10', 'localhost', 'proxy.example.com', 'yaoyao.example.com'],
      editableHosts: ['203.0.113.10', 'yaoyao.example.com'],
      environmentHosts: ['localhost', 'proxy.example.com'],
    })
  })

  it('updates the running Host guard immediately and keeps the current public host reachable', async () => {
    const home = temporaryHome()
    const serverConfig = config(home)
    serverConfig.allowedHostsSettings = {
      source: 'none', hosts: [], editableHosts: [], environmentHosts: [],
    }
    const runtime = createAuthenticatedApplication({ config: serverConfig })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)

    expect(bootstrap.body.csrfToken).toBeTruthy()
    const admin = await consoleClient(runtime)
    const saved = await admin.call('put', '/api/app/system/allowed-hosts')
      .send({ hosts: ['yaoyao.example.com', '203.0.113.10'] })
      .expect(200)
    expect(saved.body).toMatchObject({
      hosts: ['203.0.113.10', 'yaoyao.example.com'],
      editableHosts: ['203.0.113.10', 'yaoyao.example.com'],
    })
    await agent.get('/healthz').set('Host', 'yaoyao.example.com').expect(200)
    await agent.get('/healthz').set('Host', 'not-allowed.example.com').expect(421)

    await agent.get('/api/app/bootstrap').set('Host', 'yaoyao.example.com').expect(200)
    // Removing the host the console is being used through is refused.
    const rejected = await admin.agent.put('/api/app/system/allowed-hosts')
      .set('Host', `yaoyao.example.com:${runtime.config.admin.port}`)
      .set('Origin', `http://yaoyao.example.com:${runtime.config.admin.port}`)
      .set('X-CSRF-Token', admin.csrf())
      .send({ hosts: ['203.0.113.10'] })
      .expect(409)
    expect(rejected.body.code).toBe('current_host_required')
  })
})
