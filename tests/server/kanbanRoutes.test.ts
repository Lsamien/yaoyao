import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import {
  createAuthenticatedApplication,
  createUserAuthenticatedApplication,
} from './authenticatedApplication.js'

const HOST = '127.0.0.1:15300'
const ORIGIN = `http://${HOST}`
const roots: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface UpstreamCall {
  path: string
  method: string
  search: string
  body?: unknown
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

function testConfig(): ServerConfig {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-kanban-routes-'))
  roots.push(home)
  return {
    host: '127.0.0.1',
    port: 15300,
    upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts: new Set(),
    home,
    mediaRoot: home,
    attachmentsRoot: home,
    imagesRoot: home,
    mediaOwner: 'tester',
    allowInsecureLan: false,
    insecureLan: false,
    production: false,
  }
}

function upstreamFixture(manifests: unknown[] = [{ name: 'kanban', version: '1.2.3' }]) {
  const calls: UpstreamCall[] = []
  const state: { manifests: unknown[]; kanbanBoardsStatus: number; taskDetail?: unknown; unauthorizedPaths: Set<string> } = {
    manifests,
    kanbanBoardsStatus: 200,
    unauthorizedPaths: new Set(),
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === '/api/status') return json({ auth_required: false })
    if (url.pathname === '/api/profiles') return json({ profiles: [{ name: 'default', is_default: true }] })
    if (url.pathname === '/api/plugins/yaoyao/profiles') return json({ profiles: [] })
    if (url.pathname === '/api/dashboard/plugins') return json(state.manifests)

    let requestBody: unknown
    if (init?.body !== undefined && init.body !== null) requestBody = JSON.parse(String(init.body))
    const call: UpstreamCall = {
      path: url.pathname,
      method: init?.method ?? 'GET',
      search: url.search,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    }
    calls.push(call)
    if (state.unauthorizedPaths.has(url.pathname)) {
      return json({ detail: 'Unauthorized' }, {
        status: 401,
        headers: { 'set-cookie': 'upstream_secret=must-not-leak; Path=/; HttpOnly' },
      })
    }
    if (url.pathname === '/api/plugins/kanban/boards'
      && call.method === 'GET' && state.kanbanBoardsStatus !== 200) {
      return json({ detail: 'Kanban API unavailable' }, { status: state.kanbanBoardsStatus })
    }
    if (/^\/api\/plugins\/kanban\/tasks\/[^/]+$/.test(url.pathname)
      && call.method === 'GET' && state.taskDetail !== undefined) {
      return json(state.taskDetail)
    }
    return json(call)
  }) as typeof fetch
  return { calls, state, fetchImpl }
}

type Agent = ReturnType<typeof request.agent>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

function apiRequest(agent: Agent, method: Method, path: string) {
  switch (method) {
    case 'GET': return agent.get(path)
    case 'POST': return agent.post(path)
    case 'PATCH': return agent.patch(path)
    case 'DELETE': return agent.delete(path)
  }
}

async function csrfToken(agent: Agent): Promise<string> {
  const response = await agent.get('/api/app/bootstrap').set('Host', HOST).expect(200)
  return response.body.csrfToken as string
}

describe('Kanban proxy routes', () => {
  it('maps the same explicit route and query allowlist for Web and native aliases', async () => {
    const fixture = upstreamFixture()
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const csrf = await csrfToken(agent)
    fixture.calls.splice(0)

    const cases: Array<{
      method: Method
      suffix: string
      upstreamPath: string
      search?: string
      body?: Record<string, unknown>
      upstreamBody?: Record<string, unknown>
    }> = [
      { method: 'GET', suffix: '/boards?include_archived=true&escape=1', upstreamPath: '/api/plugins/kanban/boards', search: '?include_archived=true' },
      { method: 'POST', suffix: '/boards?escape=1', upstreamPath: '/api/plugins/kanban/boards', body: { slug: 'main', name: 'Main' }, upstreamBody: { slug: 'main', name: 'Main', switch: false } },
      { method: 'GET', suffix: '/board?board=main&include_archived=true&escape=1', upstreamPath: '/api/plugins/kanban/board', search: '?board=main&include_archived=true' },
      { method: 'GET', suffix: '/profiles?escape=1', upstreamPath: '/api/plugins/kanban/profiles' },
      { method: 'GET', suffix: '/tasks/t_01234567?board=main&run_state_name=running&run_state_type=status&escape=1', upstreamPath: '/api/plugins/kanban/tasks/t_01234567', search: '?board=main&run_state_name=running&run_state_type=status' },
      { method: 'POST', suffix: '/tasks?board=main&escape=1', upstreamPath: '/api/plugins/kanban/tasks', search: '?board=main', body: { title: 'Ship it' } },
      { method: 'PATCH', suffix: '/tasks/t_01234567?board=main&escape=1', upstreamPath: '/api/plugins/kanban/tasks/t_01234567', search: '?board=main', body: { status: 'ready' } },
      { method: 'DELETE', suffix: '/tasks/t_01234567?board=main&escape=1', upstreamPath: '/api/plugins/kanban/tasks/t_01234567', search: '?board=main', body: {} },
      { method: 'POST', suffix: '/tasks/t_01234567/comments?board=main&escape=1', upstreamPath: '/api/plugins/kanban/tasks/t_01234567/comments', search: '?board=main', body: { author: 'forged', body: 'Looks good' }, upstreamBody: { author: 'test-admin', body: 'Looks good' } },
      { method: 'POST', suffix: '/dispatch?board=main&dry_run=true&max=2&escape=1', upstreamPath: '/api/plugins/kanban/dispatch', search: '?board=main&dry_run=true&max=2', body: {} },
    ]

    for (const route of cases) {
      const responses: unknown[] = []
      for (const prefix of ['/api/app/kanban', '/api/kanban/v1']) {
        let pending = apiRequest(agent, route.method, `${prefix}${route.suffix}`).set('Host', HOST)
        if (prefix.startsWith('/api/app/') && route.method !== 'GET') {
          pending = pending.set('Origin', ORIGIN).set('X-CSRF-Token', csrf)
        }
        if (route.body !== undefined) pending = pending.send(route.body)
        const response = await pending.expect(200)
        responses.push(response.body)
        expect(response.body).toEqual({
          path: route.upstreamPath,
          method: route.method,
          search: route.search ?? '',
          ...(route.body === undefined ? {} : { body: route.upstreamBody ?? route.body }),
        })
      }
      expect(responses[0]).toEqual(responses[1])
    }
    expect(fixture.calls).toHaveLength(cases.length * 2)
  })

  it('uses the authenticated boards API as availability truth and manifest only for metadata', async () => {
    const fixture = upstreamFixture()
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())

    const web = await agent.get('/api/app/kanban/status').set('Host', HOST).expect(200)
    const native = await agent.get('/api/kanban/v1/status').set('Host', HOST).expect(200)
    expect(web.body).toEqual({ available: true, version: '1.2.3' })
    expect(native.body).toEqual(web.body)

    fixture.state.manifests = [{ name: 'yaoyao', version: '1.7.3' }]
    const hidden = await agent.get('/api/app/kanban/status').set('Host', HOST).expect(200)
    expect(hidden.body).toEqual({ available: true })

    fixture.state.manifests = [{ name: 'kanban', version: '9.9.9', has_api: false }]
    fixture.state.kanbanBoardsStatus = 404
    const missing = await agent.get('/api/app/kanban/status').set('Host', HOST).expect(200)
    expect(missing.body).toEqual({
      available: false,
      reason: '9119 未安装、未启用或未挂载 Kanban API',
    })
  })

  it('rejects Bot-only users from every native Kanban read and mutation alias', async () => {
    const fixture = upstreamFixture()
    const runtime = createUserAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const csrf = await csrfToken(agent)
    fixture.calls.splice(0)

    await agent.get('/api/app/kanban/board?board=main').set('Host', HOST).expect(403)
    await agent.get('/api/kanban/v1/board?board=main').set('Host', HOST).expect(403)
    expect(fixture.calls).toHaveLength(0)

    const web = await agent.post('/api/app/kanban/tasks?board=main')
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ title: 'forbidden' })
      .expect(403)
    expect(web.body.code).toBe('bot_mode_required')

    const native = await agent.patch('/api/kanban/v1/tasks/t_01234567?board=main')
      .set('Host', HOST)
      .send({ status: 'ready' })
      .expect(403)
    expect(native.body.code).toBe('bot_mode_required')
    expect(fixture.calls).toHaveLength(0)
  })

  it('keeps CSRF on Web mutations while native admins can mutate without CSRF', async () => {
    const fixture = upstreamFixture()
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const csrf = await csrfToken(agent)
    fixture.calls.splice(0)

    const rejected = await agent.post('/api/app/kanban/tasks?board=main')
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .send({ title: 'missing csrf' })
      .expect(403)
    expect(rejected.body.code).toBe('invalid_csrf')
    expect(fixture.calls).toHaveLength(0)

    await agent.post('/api/app/kanban/tasks?board=main')
      .set('Host', HOST)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .send({ title: 'web' })
      .expect(200)
    await agent.post('/api/kanban/v1/tasks?board=main')
      .set('Host', HOST)
      .send({ title: 'native' })
      .expect(200)
    expect(fixture.calls.map(call => call.body)).toEqual([{ title: 'web' }, { title: 'native' }])
  })

  it('forces create-board switch off and drops fields outside the stable alias contract', async () => {
    const fixture = upstreamFixture()
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const csrf = await csrfToken(agent)
    fixture.calls.splice(0)

    const input = {
      slug: 'main', name: 'Main', description: 'Board', project_id: 'project-a',
      default_workdir: '/Users/forged/repository', icon: 'danger', color: '#f00',
      switch: true, delete: true, archive: '/tmp/escape.tar.gz',
    }
    await agent.post('/api/app/kanban/boards')
      .set('Host', HOST).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send(input).expect(200)
    await agent.post('/api/kanban/v1/boards').set('Host', HOST).send(input).expect(200)

    expect(fixture.calls.map(call => call.body)).toEqual([
      { slug: 'main', name: 'Main', description: 'Board', switch: false },
      { slug: 'main', name: 'Main', description: 'Board', switch: false },
    ])
  })

  it('derives comment audit authors from the authenticated admin for both aliases', async () => {
    const fixture = upstreamFixture()
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const csrf = await csrfToken(agent)
    fixture.calls.splice(0)

    const forged = { body: '审计内容', author: 'forged-user', role: 'owner' }
    await agent.post('/api/app/kanban/tasks/t_01234567/comments?board=main')
      .set('Host', HOST).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send(forged).expect(200)
    await agent.post('/api/kanban/v1/tasks/t_01234567/comments?board=main')
      .set('Host', HOST).send(forged).expect(200)

    expect(fixture.calls.map(call => call.body)).toEqual([
      { body: '审计内容', author: 'test-admin' },
      { body: '审计内容', author: 'test-admin' },
    ])
  })

  it('removes unsupported attachment paths from task detail responses for both aliases', async () => {
    const fixture = upstreamFixture()
    fixture.state.taskDetail = {
      task: { id: 't_01234567', title: 'Private path check', status: 'todo' },
      comments: [], events: [], links: { parents: [], children: [] }, runs: [],
      attachments: [{ id: 1, filename: 'secret.txt', stored_path: '/Users/upstream/.hermes/kanban/attachments/secret.txt' }],
    }
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())

    for (const prefix of ['/api/app/kanban', '/api/kanban/v1']) {
      const response = await agent.get(`${prefix}/tasks/t_01234567?board=main`).set('Host', HOST).expect(200)
      expect(response.body.attachments).toEqual([])
      expect(JSON.stringify(response.body)).not.toContain('/Users/upstream')
      expect(response.body.task).toMatchObject({ id: 't_01234567', status: 'todo' })
    }
  })

  it('maps server-owned upstream 401 responses without expiring the local 15300 session', async () => {
    const fixture = upstreamFixture()
    const config = testConfig()
    config.production = true
    config.upstreamUsername = 'service-admin'
    config.upstreamPassword = 'service-password'
    const runtime = createAuthenticatedApplication({ config, fetchImpl: (async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/status') return json({ auth_required: true })
      if (path === '/api/auth/providers') return json({}, { status: 503 })
      return fixture.fetchImpl(input, init)
    }) as typeof fetch })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())

    fixture.state.unauthorizedPaths.add('/api/plugins/kanban/boards')
    for (const prefix of ['/api/app/kanban', '/api/kanban/v1']) {
      const response = await agent.get(`${prefix}/status`).set('Host', HOST).expect(502)
      expect(response.body.code).toBe('upstream_auth_unavailable')
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toContain('upstream_secret')
    }
    fixture.state.unauthorizedPaths.clear()
    await agent.get('/api/app/kanban/status').set('Host', HOST).expect(200)

    fixture.state.unauthorizedPaths.add('/api/plugins/kanban/tasks/t_01234567')
    for (const prefix of ['/api/app/kanban', '/api/kanban/v1']) {
      const response = await agent.get(`${prefix}/tasks/t_01234567?board=main`).set('Host', HOST).expect(502)
      expect(response.body.code).toBe('upstream_auth_unavailable')
      expect(response.headers['set-cookie']).toBeUndefined()
    }
  })

  it('requires an explicit canonical board on every board-scoped endpoint', async () => {
    const fixture = upstreamFixture()
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const csrf = await csrfToken(agent)
    fixture.calls.splice(0)

    const cases: Array<{ method: Method; suffix: string; body?: Record<string, unknown> }> = [
      { method: 'GET', suffix: '/board' },
      { method: 'GET', suffix: '/tasks/t_01234567' },
      { method: 'POST', suffix: '/tasks', body: { title: 'missing board' } },
      { method: 'PATCH', suffix: '/tasks/t_01234567', body: { status: 'ready' } },
      { method: 'DELETE', suffix: '/tasks/t_01234567', body: {} },
      { method: 'POST', suffix: '/tasks/t_01234567/comments', body: { body: 'missing board' } },
      { method: 'POST', suffix: '/dispatch', body: {} },
    ]
    for (const prefix of ['/api/app/kanban', '/api/kanban/v1']) {
      for (const item of cases) {
        let pending = apiRequest(agent, item.method, `${prefix}${item.suffix}`).set('Host', HOST)
        if (prefix.startsWith('/api/app/') && item.method !== 'GET') {
          pending = pending.set('Origin', ORIGIN).set('X-CSRF-Token', csrf)
        }
        if (item.body) pending = pending.send(item.body)
        const response = await pending.expect(400)
        expect(response.body.code).toBe('kanban_board_required')
      }
    }
    const invalid = await agent.get('/api/app/kanban/board?board=..%2Fescape').set('Host', HOST).expect(400)
    expect(invalid.body.code).toBe('invalid_kanban_board')
    const duplicate = await agent.get('/api/kanban/v1/board?board=main&board=other').set('Host', HOST).expect(400)
    expect(duplicate.body.code).toBe('invalid_kanban_board')
    expect(fixture.calls).toHaveLength(0)
  })

  it('does not expose switch, bulk, attachments, or arbitrary nested plugin paths', async () => {
    const fixture = upstreamFixture()
    const runtime = createAuthenticatedApplication({ config: testConfig(), fetchImpl: fixture.fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const csrf = await csrfToken(agent)
    fixture.calls.splice(0)

    await agent.post('/api/app/kanban/boards/main/switch')
      .set('Host', HOST).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send({}).expect(404)
    await agent.post('/api/kanban/v1/tasks/bulk').set('Host', HOST).send({ ids: [] }).expect(404)
    await agent.post('/api/kanban/v1/tasks/t_01234567/attachments').set('Host', HOST).send({}).expect(404)
    await agent.get('/api/kanban/v1/orchestration').set('Host', HOST).expect(404)
    expect(fixture.calls).toHaveLength(0)
  })
})
