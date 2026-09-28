// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { UpstreamServiceSession } from '../../src/server/localAuth.js'
import { CookieJar, UpstreamClient } from '../../src/server/upstream.js'

describe('upstream service validation lease', () => {
  function fixture() {
    let now = 0, expire = false
    const paths: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname; paths.push(path)
      if (path === '/api/status') return Response.json({ auth_required: true })
      if (path === '/api/auth/me') {
        return expire && new Headers(init?.headers).get('cookie') === 'session=old'
          ? Response.json({ detail: 'expired' }, { status: 401 })
          : Response.json({ user_id: 'service' })
      }
      if (path === '/api/auth/providers') return Response.json({ providers: [] })
      if (path === '/auth/password-login') return Response.json({ ok: true }, { headers: { 'set-cookie': 'session=new; Path=/' } })
      if (expire && new Headers(init?.headers).get('cookie') === 'session=old') return Response.json({ error: 'expired' }, { status: 401 })
      return Response.json({ path })
    })
    const client = new UpstreamClient(new URL('http://localhost:9119'), fetch, false, () => now)
    const session = new UpstreamServiceSession(client, () => ({ username: 'service', password: 'fixture' }), { now: () => now })
    session.jar.replace(new CookieJar('session=old'))
    return { session, client, fetch, paths, advance: (n: number) => { now += n }, expire: () => { expire = true } }
  }
  it('validates once for concurrent requests and rechecks only after thirty seconds', async () => {
    const f = fixture()
    await Promise.all(Array.from({ length: 10 }, (_, i) => f.session.request(`/api/sessions/${i}`)))
    expect(f.paths.filter(p => p === '/api/status')).toHaveLength(1)
    expect(f.paths.filter(p => p === '/api/auth/me')).toHaveLength(1)
    await f.session.request('/api/sessions/a')
    expect(f.paths).toHaveLength(13)
    f.advance(30_001); await f.session.request('/api/sessions/b')
    expect(f.paths.filter(p => p === '/api/status')).toHaveLength(2)
  })
  it('reduces repeated protected reads to zero upstream calls on a warm hit', async () => {
    const f = fixture()
    const read = () => f.client.withReadScope('alice', false, () => f.session.request('/api/sessions'))
    await Promise.all([read(), read(), read()])
    expect(f.paths).toEqual(['/api/status', '/api/auth/me', '/api/sessions'])
    await read(); await read()
    expect(f.paths).toHaveLength(3)
  })
  it('repairs parallel 401s once, including raw withJar-style reads', async () => {
    const f = fixture(); await f.session.ensure(); f.expire()
    await Promise.all([f.client.request('/api/sessions/a', f.session.jar), f.client.request('/api/sessions/b', f.session.jar)])
    expect(f.paths.filter(p => p === '/auth/password-login')).toHaveLength(1)
    expect(f.paths.filter(p => p === '/api/sessions/a')).toHaveLength(2)
    expect(f.paths.filter(p => p === '/api/sessions/b')).toHaveLength(2)
    expect(f.session.jar.header).toBe('session=new')
  })
  it('never replays a write on a timeout or 500 response', async () => {
    const f = fixture(); await f.session.ensure()
    f.fetch.mockImplementation(async () => Response.json({ error: 'failed' }, { status: 500 }))
    const before = f.fetch.mock.calls.length
    expect((await f.session.request('/api/sessions/s', { method: 'POST', body: { text: 'once' } })).status).toBe(500)
    expect(f.fetch.mock.calls.length - before).toBe(1)
  })
  it.each(['GET', 'POST'])('reports a persistent service 401 as an upstream failure for %s requests', async method => {
    const f = fixture()
    await f.session.ensure()
    const fetch = f.fetch.getMockImplementation()!
    f.fetch.mockImplementation(async (input, init) => new URL(String(input)).pathname === '/api/sessions/rejected'
      ? Response.json({ error: 'service session rejected' }, { status: 401 }) : fetch(input, init))
    try {
      await expect(f.client.request('/api/sessions/rejected', f.session.jar, { method })).rejects.toMatchObject({
        status: 502, code: 'upstream_auth_unavailable',
      })
      expect(f.fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/sessions/rejected')).toHaveLength(2)
      expect(f.paths.filter(path => path === '/auth/password-login')).toHaveLength(1)
    } finally { f.client.close() }
  })

  it('preserves auth-endpoint 401s for service credential renewal', async () => {
    const f = fixture()
    await f.session.ensure()
    f.fetch.mockResolvedValue(Response.json({ error: 'expired' }, { status: 401 }))
    try {
      expect((await f.session.request('/api/auth/ws-ticket', { method: 'POST' })).status).toBe(401)
    } finally { f.client.close() }
  })
  it('invalidates validation and cached data on configured credential changes', async () => {
    const f = fixture()
    let password = 'first'
    const session = new UpstreamServiceSession(f.client, () => ({ username: 'service', password }), { now: () => 0 })
    await session.ensure()
    await f.client.withReadScope('alice', false, () => session.request('/api/sessions'))
    expect(f.client.readCache.stats().entries).toBe(1)
    password = 'second'; await session.ensure()
    expect(f.paths.filter(p => p === '/api/status')).toHaveLength(2)
    expect(f.client.readCache.stats().entries).toBe(0)
  })
  it('does not memoize failed validation', async () => {
    const f = fixture()
    f.fetch.mockResolvedValueOnce(Response.json({ error: 'offline' }, { status: 503 }))
    await expect(f.session.ensure()).rejects.toThrow('9119')
    await f.session.ensure()
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })
  it('cannot overwrite new credentials with a late old login response', async () => {
    let username = 'old', started = false
    let release!: () => void
    const blocked = new Promise<void>(r => { release = r })
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: true })
      if (path === '/api/auth/me') return Response.json({}, { status: 401 })
      if (path === '/api/auth/providers') return Response.json({ providers: [] })
      const body = JSON.parse(String(init?.body))
      if (body.username === 'old') { started = true; await blocked }
      return Response.json({ ok: true }, { headers: { 'set-cookie': `session=${body.username}; Path=/` } })
    })
    const client = new UpstreamClient(new URL('http://localhost:9119'), fetch)
    const session = new UpstreamServiceSession(client, () => ({ username, password: 'fixture' }))
    const old = session.ensure().then(() => undefined, error => error)
    await vi.waitFor(() => expect(started).toBe(true))
    username = 'new'
    await session.ensure()
    expect(session.jar.header).toBe('session=new')
    release()
    expect(await old).toMatchObject({ code: 'upstream_credentials_changed' })
    expect(session.jar.header).toBe('session=new')
  })

  it('uses the injected loopback session token without password login', async () => {
    const paths: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/api/status') return Response.json({ auth_required: false })
      if (path === '/') {
        return new Response('<script>window.__HERMES_SESSION_TOKEN__="loopback-token-123456";</script>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      const token = new Headers(init?.headers).get('x-hermes-session-token')
      return token === 'loopback-token-123456'
        ? Response.json({ ok: true })
        : Response.json({ detail: 'Unauthorized' }, { status: 401 })
    })
    const client = new UpstreamClient(new URL('http://127.0.0.1:9119'), fetch)
    const session = new UpstreamServiceSession(client, () => ({ username: 'unused', password: 'unused' }))

    expect((await session.request('/api/sessions')).status).toBe(200)
    expect(paths).toEqual(['/api/status', '/', '/api/profiles', '/api/sessions'])
    expect(session.connectionInfo()).toMatchObject({
      endpoint: 'http://127.0.0.1:9119',
      authMode: 'loopback-token',
      networkScope: 'local',
    })
  })

  it('refreshes a rotated loopback token once and replays parallel reads', async () => {
    let activeToken = 'loopback-token-first-fixture'
    let pageLoads = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: false })
      if (path === '/') {
        pageLoads += 1
        return new Response(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(activeToken)};</script>`)
      }
      return new Headers(init?.headers).get('x-hermes-session-token') === activeToken
        ? Response.json({ ok: true })
        : Response.json({ detail: 'Unauthorized' }, { status: 401 })
    })
    const client = new UpstreamClient(new URL('http://127.0.0.1:9119'), fetch)
    const session = new UpstreamServiceSession(client, () => undefined)
    await session.ensure()
    activeToken = 'loopback-token-second-fixture'

    const responses = await Promise.all([
      client.request('/api/sessions/a', session.jar),
      client.request('/api/sessions/b', session.jar),
    ])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect(pageLoads).toBe(2)
    expect(session.connectionInfo().authMode).toBe('loopback-token')
  })

  it('refuses token discovery from a non-loopback upstream', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ auth_required: false }))
    const client = new UpstreamClient(new URL('http://192.168.1.20:9119'), fetch)
    const session = new UpstreamServiceSession(client, () => undefined)

    await expect(session.ensure()).rejects.toMatchObject({ code: 'loopback_auth_required' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps older unauthenticated loopback dashboards compatible when no token is injected', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/status') return Response.json({ auth_required: false })
      if (path === '/') return new Response('<html>legacy dashboard</html>')
      return Response.json({ ok: true })
    })
    const client = new UpstreamClient(new URL('http://127.0.0.1:9119'), fetch)
    const session = new UpstreamServiceSession(client, () => undefined)

    expect((await session.request('/api/sessions')).status).toBe(200)
    expect(session.connectionInfo().authMode).toBe('loopback-direct')
  })
})
