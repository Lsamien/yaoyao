// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'

const runtimes: ApplicationRuntime[] = []
const homes: string[] = []
const host = '127.0.0.1:15300'
const origin = `http://${host}`
const sessionID = 'cached-session'

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function fixture(upstream: (method: string) => Response) {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-session-deletion-'))
  homes.push(home)
  const config: ServerConfig = {
    host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:19119'),
    allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
    mediaOwner: 'test', allowInsecureLan: false, insecureLan: false, production: false,
    chatCacheMode: 'prefer-local',
  }
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/status') return Response.json({ auth_required: false })
    if (url.pathname === '/') return new Response('<script>window.__HERMES_SESSION_TOKEN__="deletion-token-1234567890123456";</script>')
    if (url.pathname === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
    if (url.pathname === `/api/sessions/${sessionID}`) return upstream(init?.method ?? 'GET')
    if (url.pathname === '/api/sessions') return Response.json({ sessions: [], total: 0 })
    return Response.json({ error: 'Unknown fixture route' }, { status: 404 })
  })
  const runtime = createApplication({ config, fetchImpl })
  runtimes.push(runtime)
  const agent = request.agent(runtime.app.callback())
  const boot = await agent.get('/api/app/bootstrap').set('Host', host).expect(200)
  const setup = await agent.post('/api/app/setup').set('Host', host).set('Origin', origin)
    .set('X-CSRF-Token', boot.body.csrfToken)
    .send({ username: 'owner', password: 'fixture-password' }).expect(200)
  const owner = String(setup.body.user.id)
  const store = runtime.chatCache!.store
  for (const [account, profile] of [[owner, 'default'], [owner, 'other'], ['other-owner', 'default']]) {
    store.recordRoute(account!, profile!, sessionID, `runtime-${account}-${profile}`)
    store.putSnapshot(account!, `messages-${profile}`, 'messages', profile!, sessionID, {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      body: Buffer.from(JSON.stringify({
        session: { id: sessionID, profile, title: 'Cached history', message_count: 1 },
        messages: [{ id: 'cached-message', role: 'assistant', content: 'Saved answer' }],
        pagination: { total: 1, offset: 0, returned: 1, has_more: false },
      })),
    })
  }
  return {
    runtime, store, owner, fetchImpl, agent,
    remove: () => agent.delete(`/api/app/sessions/${sessionID}?profile=default`)
      .set('Host', host).set('Origin', origin).set('X-CSRF-Token', setup.body.csrfToken),
    assertOtherCopies: () => {
      expect(store.localDetail(owner, 'other', sessionID)).toBeDefined()
      expect(store.messagePage(owner, 'other', sessionID, 0, 100)).toBeDefined()
      expect(store.snapshot(owner, 'messages-other')).toBeDefined()
      expect(store.localDetail('other-owner', 'default', sessionID)).toBeDefined()
      expect(store.messagePage('other-owner', 'default', sessionID, 0, 100)).toBeDefined()
      expect(store.snapshot('other-owner', 'messages-default')).toBeDefined()
    },
  }
}

describe('deleting sessions retained only in cache', () => {
  it.each([
    { error: 'Session not found' },
    { error: 'session 不存在' },
    { message: '会话不存在' },
    { detail: 'Session not found: cached-session' },
    { detail: { message: 'Session not found' } },
    { code: 'session_not_found' },
  ])('cleans a missing session and keeps deletion idempotent: %j', async payload => {
    const f = await fixture(() => Response.json(payload, { status: 404 }))
    const listPath = '/api/app/sessions?view=chat&profile=default'
    const before = await f.agent.get(listPath).set('Host', host).expect(200)
    expect(before.body.sessions.map((session: { id: string }) => session.id)).toEqual([sessionID])
    expect(f.store.messagePage(f.owner, 'default', sessionID, 0, 100)).toBeDefined()

    await f.remove().expect(200, { ok: true })
    await f.remove().expect(200, { ok: true })
    expect(f.store.localDetail(f.owner, 'default', sessionID)).toBeUndefined()
    expect(f.store.messagePage(f.owner, 'default', sessionID, 0, 100)).toBeUndefined()
    expect(f.store.snapshot(f.owner, 'messages-default')).toBeUndefined()
    f.assertOtherCopies()
    const after = await f.agent.get(listPath).set('Host', host).expect(200)
    expect(after.body.sessions).toEqual([])
    const fresh = await f.agent.get(listPath).set('Host', host).set('X-Yaoyao-Cache', 'bypass').expect(200)
    expect(fresh.body.sessions).toEqual([])
    expect(f.fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it('cleans up when the session disappears between lookup and DELETE', async () => {
    const f = await fixture(method => method === 'DELETE'
      ? Response.json({ error: 'Session not found' }, { status: 404 })
      : Response.json({ id: sessionID, profile: 'default' }))
    await f.remove().expect(200, { ok: true })
    expect(f.store.localDetail(f.owner, 'default', sessionID)).toBeUndefined()
    expect(f.store.messagePage(f.owner, 'default', sessionID, 0, 100)).toBeUndefined()
    f.assertOtherCopies()
    const deletes = f.fetchImpl.mock.calls.filter(([, init]) => init?.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(new URL(String(deletes[0]![0])).searchParams.get('profile')).toBe('default')
  })

  it.each([
    [404, 'Not Found'], [404, 'Profile not found'], [404, 'Session route not found'],
    [401, 'Session not found'], [403, 'Session not found'], [500, 'Session not found'],
  ])('preserves cache on lookup failure %i: %s', async (status, error) => {
    const f = await fixture(() => Response.json({ error }, { status }))
    await f.remove().expect(status)
    expect(f.store.localDetail(f.owner, 'default', sessionID)).toBeDefined()
    expect(f.store.messagePage(f.owner, 'default', sessionID, 0, 100)).toBeDefined()
    f.assertOtherCopies()
    expect(f.fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it('preserves cache when DELETE itself fails', async () => {
    const f = await fixture(method => method === 'DELETE'
      ? Response.json({ error: 'Database unavailable' }, { status: 500 })
      : Response.json({ id: sessionID, profile: 'default' }))
    await f.remove().expect(500)
    expect(f.store.localDetail(f.owner, 'default', sessionID)).toBeDefined()
    expect(f.store.messagePage(f.owner, 'default', sessionID, 0, 100)).toBeDefined()
    f.assertOtherCopies()
  })

  it('still rejects upstream mutations of an existing unowned session', async () => {
    const f = await fixture(() => Response.json({ id: sessionID, profile: 'default' }))
    f.store.deleteSession(f.owner, 'default', sessionID)
    await f.remove().expect(410)
    f.assertOtherCopies()
    expect(f.fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })
})
