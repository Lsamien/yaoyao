import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { createAuthenticatedApplication, createUserAuthenticatedApplication } from './authenticatedApplication.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Agent management admin routes', () => {
  it('rejects default-model writes from a regular 15300 user', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-agent-model-user-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const runtime = createUserAuthenticatedApplication({ config })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    await agent.put('/api/app/admin/profiles/default/model')
      .set('Host', '127.0.0.1:15300')
      .set('Origin', 'http://127.0.0.1:15300')
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ provider: 'opencode-free', model: 'free-a' })
      .expect(403, /子账号只能使用 Bot 模式/)
  })

  it('proxies profile-scoped model services and masked duplex voice settings through 9119', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-agent-management-'))
    roots.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
      mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    }
    const calls: Array<{ url: URL; method: string; body?: unknown }> = []
    let unsupported = false
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const method = init?.method || (input instanceof Request ? input.method : 'GET')
      const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ url, method, body: requestBody })
      if (url.pathname === '/api/status') return Response.json({ auth_required: true }, { headers: { 'set-cookie': 'hermes_session_at=session; Path=/; HttpOnly' } })
      if (url.pathname === '/api/auth/me') return Response.json({ user_id: 'service-admin' })
      if (url.pathname === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (url.pathname === '/api/plugins/yaoyao/profiles') return Response.json({ profiles: [] })
      if (url.pathname === '/api/config' && method === 'GET') return Response.json({ custom_providers: [{ name: 'tingly', base_url: 'http://tingly.test/v1', key_env: 'TINGLY_API_KEY', model: 'omni', models: { omni: {}, old: {} }, models_discovered: true }] })
      if (url.pathname === '/api/config' && method === 'PUT') return Response.json({ ok: true })
      if (url.pathname === '/api/model/options') return Response.json({ provider: 'custom:tingly', model: 'omni', providers: [{ slug: 'custom:tingly', name: 'tingly', models: ['omni', 'old'], is_current: true }] })
      if (url.pathname === '/api/env') return Response.json({ ok: true })
      if (url.pathname === '/api/model/set') return Response.json({ ok: true, provider: 'custom:tingly', model: 'omni-2' })
      if (url.pathname === '/api/profiles/worker/model' && method === 'PUT') return Response.json({ ok: true, provider: 'opencode-free', model: 'free-a' })
      if (unsupported && url.pathname === '/api/providers/custom-endpoints') return Response.json({ detail: 'missing' }, { status: 404 })
      if (url.pathname === '/api/providers/custom-endpoints/validate') return Response.json({ ok: true, reachable: true, message: '', models: ['model-a'] })
      if (url.pathname === '/api/providers/custom-endpoints') return Response.json({ endpoints: [], current: {}, ok: true })
      if (url.pathname.endsWith('/activate')) return Response.json({ ok: true, provider: 'local', model: 'model-a' })
      if (url.pathname.startsWith('/api/providers/custom-endpoints/')) return Response.json({ ok: true, endpoints: [], current: {} })
      if (url.pathname === '/api/plugins/yaoyao/voice/settings') return Response.json({ hasApiKey: true, voices: [{ id: 'voice-a', name: '音色 A' }], currentVoiceId: 'voice-a', updatedAt: 1 })
      return Response.json({ ok: true })
    }) as typeof fetch
    const runtime = createAuthenticatedApplication({ config, fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    const headers = (value: request.Test) => value
      .set('Host', '127.0.0.1:15300')
      .set('Origin', 'http://127.0.0.1:15300')
      .set('X-CSRF-Token', bootstrap.body.csrfToken)

    await agent.get('/api/app/admin/model-services?profile=worker').set('Host', '127.0.0.1:15300').expect(200)
    await headers(agent.post('/api/app/admin/model-services?profile=worker')).send({ name: 'Local', base_url: 'http://127.0.0.1:9000/v1', model: 'model-a', discover_models: true, make_default: false }).expect(200)
    await headers(agent.post('/api/app/admin/model-services/validate')).send({ name: 'Local', base_url: 'http://127.0.0.1:9000/v1', model: 'model-a', discover_models: true, make_default: false }).expect(200)
    await headers(agent.post('/api/app/admin/model-services/local/activate?profile=worker')).send({}).expect(200)
    await headers(agent.put('/api/app/admin/profiles/worker/model')).send({ provider: 'opencode-free', model: 'free-a' }).expect(200)
    await headers(agent.delete('/api/app/admin/model-services/local?profile=worker')).send({}).expect(200)
    const legacy = await agent.get('/api/app/admin/legacy-model-services?profile=worker').set('Host', '127.0.0.1:15300').expect(200)
    expect(legacy.body.items[0]).toMatchObject({ id: 'custom:tingly', models: ['omni', 'old'], has_api_key: true, can_edit_api_key: true, is_current: true })
    expect(JSON.stringify(legacy.body)).not.toContain('TINGLY_API_KEY')
    await headers(agent.put('/api/app/admin/legacy-model-services/custom%3Atingly?profile=worker')).send({
      name: 'tingly', base_url: 'http://tingly.test/v2', model: 'omni-2', models: ['omni', 'omni-2'],
      discover_models: false, make_default: false, api_key: 'replacement-secret',
    }).expect(200)
    const voice = await agent.get('/api/app/admin/duplex-voice').set('Host', '127.0.0.1:15300').expect(200)
    expect(voice.body).not.toHaveProperty('apiKey')
    await headers(agent.put('/api/app/admin/duplex-voice')).send({ voices: [{ id: 'voice-a', name: '音色 A' }], currentVoiceId: 'voice-a' }).expect(200)

    const featureCalls = calls.filter(call => call.url.pathname.includes('custom-endpoints') || call.url.pathname.includes('/voice/settings'))
    expect(featureCalls.map(call => [call.method, call.url.pathname, call.url.search])).toEqual([
      ['GET', '/api/providers/custom-endpoints', '?profile=worker'],
      ['POST', '/api/providers/custom-endpoints', '?profile=worker'],
      ['POST', '/api/providers/custom-endpoints/validate', ''],
      ['POST', '/api/providers/custom-endpoints/local/activate', '?profile=worker'],
      ['DELETE', '/api/providers/custom-endpoints/local', '?profile=worker'],
    ])
    expect(featureCalls[1]!.body).toMatchObject({ name: 'Local', model: 'model-a' })
    expect(calls.some(call => call.url.pathname.includes('/plugins/yaoyao'))).toBe(false)
    const configWrite = calls.find(call => call.url.pathname === '/api/config' && call.method === 'PUT')!
    expect(configWrite.body).toMatchObject({ config: { custom_providers: [{ name: 'tingly', base_url: 'http://tingly.test/v2', model: 'omni-2', models: { omni: {}, 'omni-2': {} }, models_discovered: false }] } })
    const envWrite = calls.find(call => call.url.pathname === '/api/env' && call.method === 'PUT')!
    expect(envWrite.body).toMatchObject({ key: 'TINGLY_API_KEY', value: 'replacement-secret' })
    expect(calls.some(call => call.url.pathname === '/api/model/set' && call.method === 'POST')).toBe(true)
    expect(calls.find(call => call.url.pathname === '/api/profiles/worker/model' && call.method === 'PUT')?.body)
      .toEqual({ provider: 'opencode-free', model: 'free-a' })

    unsupported = true
    await agent.get('/api/app/admin/model-services?profile=worker').set('Host', '127.0.0.1:15300')
      .expect(501, /当前上游版本不支持此管理功能/)
  })
})
