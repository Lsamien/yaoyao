// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { saveFileAccess } from '../../src/server/fileAccess.js'

const homes: string[] = []
const runtimes: ApplicationRuntime[] = []
const host = '127.0.0.1:15300'
const origin = `http://${host}`

function cookie(response: request.Response): string {
  const values = response.headers['set-cookie'] as unknown as string[] | undefined
  return (values ?? []).map(value => value.split(';', 1)[0]).join('; ')
}

function config(home: string): ServerConfig {
  return {
    host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:19119'),
    allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
    mediaOwner: 'test', allowInsecureLan: false, insecureLan: false, production: false,
    chatCacheMode: 'prefer-local',
  }
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('source=web chat cache routes', () => {
  it('uses the Web-owned session registry when Hermes source metadata is stale', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-owned-chat-routes-'))
    homes.push(home)
    const listQueries: URLSearchParams[] = []
    let upstreamOwnedTitle = 'Hermes 仍标记为 iOS'
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.pathname === '/api/status') return Response.json({ auth_required: false })
      if (url.pathname === '/') {
        return new Response(
          '<script>window.__HERMES_SESSION_TOKEN__="cache-token-1234567890123456";</script>',
        )
      }
      if (headers.get('x-hermes-session-token') !== 'cache-token-1234567890123456') {
        return Response.json({}, { status: 401 })
      }
      if (url.pathname === '/api/profiles') {
        return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      }
      if (url.pathname === '/api/sessions/search') {
        const requestedSource = url.searchParams.get('source')
        const results = [
          { id: 'unowned-web', profile: 'default', source: 'web', title: '未登记 Web 历史' },
          { id: 'owned-session', profile: 'default', source: 'ios', title: 'Hermes 仍标记为 iOS' },
        ].filter(session => !requestedSource || session.source === requestedSource)
        return Response.json({ results })
      }
      if (url.pathname === '/api/sessions') {
        listQueries.push(new URLSearchParams(url.searchParams))
        // Model the real source filter so this fixture cannot pass by returning
        // an iOS row to a source=web request.
        if (url.searchParams.get('source') === 'web') {
          return Response.json({
            sessions: [{ id: 'unowned-web', profile: 'default', source: 'web', title: '未登记 Web 历史' }],
            total: 1,
          })
        }
        return Response.json({
          sessions: [
            {
              id: 'owned-session',
              profile: 'default',
              source: 'ios',
              title: 'Hermes 仍标记为 iOS',
            },
            {
              id: 'history-only',
              profile: 'default',
              source: 'ios',
              title: '未登记历史',
            },
            {
              id: 'unowned-web',
              profile: 'default',
              source: 'web',
              title: '未登记 Web 历史',
            },
          ],
          total: 3,
        })
      }
      if (url.pathname === '/api/sessions/owned-session') {
        if (init?.method === 'PATCH') {
          upstreamOwnedTitle = String(JSON.parse(String(init.body)).title ?? upstreamOwnedTitle)
          return Response.json({ ok: true })
        }
        return Response.json({
          id: 'owned-session',
          profile: 'default',
          source: 'ios',
          title: upstreamOwnedTitle,
        })
      }
      if (url.pathname === '/api/sessions/owned-session/messages') {
        return Response.json({
          session: { id: 'owned-session', profile: 'default', source: 'ios', title: 'Hermes 仍标记为 iOS' },
          messages: [{ id: 'owned-message', role: 'assistant', content: '已同步' }],
          pagination: { total: 1, returned: 1, offset: 0, limit: 100, has_more: false },
        })
      }
      if (url.pathname === '/api/sessions/history-only') {
        return Response.json({ id: 'history-only', profile: 'default', source: 'ios', title: '未登记历史' })
      }
      return Response.json({ error: 'missing fixture' }, { status: 404 })
    })
    const runtime = createApplication({ config: config(home), fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const boot = await agent.get('/api/app/bootstrap').set('Host', host).expect(200)
    const setup = await agent.post('/api/app/setup').set('Host', host)
      .set('Origin', origin).set('X-CSRF-Token', boot.body.csrfToken)
      .send({ username: 'owner', password: 'fixture-password' }).expect(200)
    const owner = String(setup.body.user.id)
    runtime.chatCache!.store.recordRoute(
      owner,
      'default',
      'owned-session',
      'runtime-owned',
    )
    runtime.chatCache!.store.recordCommand(
      owner,
      'default',
      'owned-session',
      'session.create',
      { source: 'ios' },
    )
    await runtime.chatCache!.reconcile(owner, 'default', 'owned-session')

    const list = await agent
      .get('/api/app/sessions?view=chat&profile=default&limit=100')
      .set('Host', host)
      .expect(200)
    expect(list.body.sessions).toEqual([expect.objectContaining({
      id: 'owned-session',
      source: 'ios',
      owned: true,
      title: 'Hermes 仍标记为 iOS',
      final_unread_count: 1,
    })])
    const unread = await agent.get('/api/app/sessions/unread?profile=default').set('Host', host).expect(200)
    expect(unread.body.sessions).toEqual([expect.objectContaining({
      session_id: 'owned-session', final_unread_count: 1,
    })])

    const history = await agent
      .get('/api/app/sessions?view=history&profile=default&limit=100')
      .set('Host', host)
      .expect(200)
    expect(history.body.sessions.map((session: { id: string }) => session.id).sort())
      .toEqual(['history-only', 'unowned-web'])
    expect(listQueries.length).toBeGreaterThan(0)
    expect(listQueries.every(query => !query.has('source'))).toBe(true)
    expect(listQueries.every(query => !query.get('exclude_sources')?.split(',').includes('web'))).toBe(true)
    expect(listQueries.every(query => query.get('order') === 'recent')).toBe(true)
    expect(listQueries.every(query => query.get('archived') === 'exclude')).toBe(true)

    const ownedDetail = await agent.get('/api/app/sessions/owned-session?profile=default')
      .set('Host', host).expect(200)
    expect(ownedDetail.body).toMatchObject({ id: 'owned-session', source: 'ios', owned: true })
    const historyDetail = await agent.get('/api/app/sessions/history-only?profile=default&view=history')
      .set('Host', host).expect(200)
    expect(historyDetail.body).toMatchObject({ id: 'history-only', source: 'ios', owned: false })
    await runtime.chatCache!.reconcile(String(setup.body.user.id), 'default', 'owned-session')
    const ownedMessages = await agent
      .get('/api/app/sessions/owned-session/messages?profile=default&offset=0&limit=100')
      .set('Host', host).expect(200)
    expect(ownedMessages.body).toMatchObject({
      owned: true,
      session: { id: 'owned-session', source: 'ios', owned: true },
      messages: [{ id: 'owned-message' }],
    })

    const searched = await agent.get('/api/app/sessions/search?q=Hermes&profile=default')
      .set('Host', host).expect(200)
    expect(searched.body.results).toEqual([
      expect.objectContaining({ id: 'unowned-web', source: 'web', owned: false }),
      expect.objectContaining({ id: 'owned-session', source: 'ios', owned: true }),
    ])
    const searchedChat = await agent
      .get('/api/app/sessions/search?q=Hermes&profile=default&view=chat&source=web&limit=1')
      .set('Host', host)
      .expect(200)
    expect(searchedChat.body).toMatchObject({
      total: 1,
      results: [expect.objectContaining({ id: 'owned-session', owned: true })],
    })
    const searchedHistory = await agent
      .get('/api/app/sessions/search?q=Hermes&profile=default&view=history&limit=1')
      .set('Host', host)
      .expect(200)
    expect(searchedHistory.body).toMatchObject({
      total: 1,
      results: [expect.objectContaining({ id: 'unowned-web', owned: false })],
    })
    const upstreamSearchRequests = fetchImpl.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter(url => url.pathname === '/api/sessions/search')
    expect(upstreamSearchRequests.every(url => url.searchParams.get('limit') === '100')).toBe(true)
    expect(upstreamSearchRequests.every(url => !url.searchParams.has('source'))).toBe(true)

    runtime.chatCache!.store.recordEvent(owner, 'default', 'owned-session', {
      type: 'session.title',
      payload: { session_id: 'owned-session', title: '事件权威标题' },
    })
    const eventTitledSearch = await agent
      .get('/api/app/sessions/search?q=Hermes&profile=default&view=chat')
      .set('Host', host)
      .expect(200)
    expect(eventTitledSearch.body.results).toEqual([
      expect.objectContaining({ id: 'owned-session', title: '事件权威标题', owned: true }),
    ])

    const forbiddenSourcePatch = await agent.patch('/api/app/sessions/owned-session?profile=default')
      .set('Host', host).set('Origin', origin)
      .set('X-CSRF-Token', setup.body.csrfToken)
      .send({ source: 'web' })
      .expect(400)
    expect(forbiddenSourcePatch.body.code).toBe('invalid_session_patch')
    await agent.patch('/api/app/sessions/owned-session?profile=default')
      .set('Host', host).set('Origin', origin)
      .set('X-CSRF-Token', setup.body.csrfToken)
      .send({ title: 'Web 可继续管理' })
      .expect(200)
    const patchCalls = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH')
    expect(patchCalls).toHaveLength(0) // Ordinary presentation state is owned by Web.
    const immediateRenamedDetail = await agent
      .get('/api/app/sessions/owned-session?profile=default')
      .set('Host', host)
      .expect(200)
    expect(immediateRenamedDetail.body.title).toBe('Web 可继续管理')

    // A reconcile may complete immediately after the mutation; it must retain
    // the synchronously published title.
    await runtime.chatCache!.reconcile(owner, 'default', 'owned-session')
    const reconciledDetail = await agent
      .get('/api/app/sessions/owned-session?profile=default')
      .set('Host', host)
      .expect(200)
    expect(reconciledDetail.body.title).toBe('Web 可继续管理')
    const renamedList = await agent
      .get('/api/app/sessions?view=chat&profile=default&limit=100')
      .set('Host', host)
      .expect(200)
    expect(renamedList.body.sessions).toContainEqual(expect.objectContaining({
      id: 'owned-session',
      title: 'Web 可继续管理',
      owned: true,
    }))
    const renamedSearch = await agent
      .get('/api/app/sessions/search?q=Hermes&profile=default&view=chat')
      .set('Host', host)
      .expect(200)
    expect(renamedSearch.body.results).toEqual([
      expect.objectContaining({ id: 'owned-session', title: 'Web 可继续管理', owned: true }),
    ])
  })

  it('paginates chat and history after projecting a multi-page mixed upstream list', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-owned-pagination-routes-'))
    homes.push(home)
    const upstreamSessions = Array.from({ length: 12 }, (_, index) => [
      { id: `unowned-${index}`, profile: 'default', source: index % 2 ? 'ios' : 'web', title: `Unowned ${index}` },
      ...(index < 8 ? [{ id: `owned-${index}`, profile: 'default', source: index % 2 ? 'web' : 'ios', title: `Owned ${index}` }] : []),
    ]).flat()
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.pathname === '/api/status') return Response.json({ auth_required: false })
      if (url.pathname === '/') return new Response('<script>window.__HERMES_SESSION_TOKEN__="pagination-token-1234567890123456";</script>')
      if (headers.get('x-hermes-session-token') !== 'pagination-token-1234567890123456') {
        return Response.json({}, { status: 401 })
      }
      if (url.pathname === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (url.pathname === '/api/sessions') {
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
        const limit = 5
        return Response.json({
          sessions: upstreamSessions.slice(offset, offset + limit),
          total: upstreamSessions.length,
          offset,
          limit,
        })
      }
      return Response.json({ error: 'missing fixture' }, { status: 404 })
    })
    const runtime = createApplication({ config: config(home), fetchImpl })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const boot = await agent.get('/api/app/bootstrap').set('Host', host).expect(200)
    const setup = await agent.post('/api/app/setup').set('Host', host)
      .set('Origin', origin).set('X-CSRF-Token', boot.body.csrfToken)
      .send({ username: 'owner', password: 'fixture-password' }).expect(200)
    const owner = String(setup.body.user.id)
    for (let index = 0; index < 8; index++) {
      const id = `owned-${index}`
      runtime.chatCache!.store.recordRoute(owner, 'default', id, `runtime-${index}`)
      runtime.chatCache!.store.recordCommand(owner, 'default', id, 'session.create', {
        source: index % 2 ? 'web' : 'ios',
      })
      runtime.chatCache!.store.putSnapshot(owner, `detail-${index}`, 'detail', 'default', id, {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: Buffer.from(JSON.stringify({
          id,
          profile: 'default',
          source: index % 2 ? 'web' : 'ios',
          title: `Owned ${index}`,
          last_active: 1_000 + index,
        })),
      })
    }

    const chat = await agent
      .get('/api/app/sessions?view=chat&profile=default&offset=2&limit=3')
      .set('Host', host).expect(200)
    expect(chat.body).toMatchObject({ total: 8, offset: 2, limit: 3 })
    expect(chat.body.sessions.map((session: { id: string }) => session.id))
      .toEqual(['owned-5', 'owned-4', 'owned-3'])

    const history = await agent
      .get('/api/app/sessions?view=history&profile=default&offset=4&limit=4')
      .set('Host', host).expect(200)
    expect(history.body).toMatchObject({ total: 12, offset: 4, limit: 4 })
    expect(history.body.sessions.map((session: { id: string }) => session.id))
      .toEqual(['unowned-4', 'unowned-5', 'unowned-6', 'unowned-7'])
  })

  it('serves warm and restarted chat reads locally while history stays upstream-only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-chat-cache-routes-')); homes.push(home)
    saveFileAccess(home, { mode: 'all', folders: [] })
    const counts = { list: 0, detail: 0, messages: 0, history: 0, media: 0 }
    const mediaPath = '/Users/test/.hermes/profiles/default/images/result.png'
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.pathname === '/api/status') return Response.json({ auth_required: false })
      if (url.pathname === '/') return new Response('<script>window.__HERMES_SESSION_TOKEN__="cache-token-1234567890123456";</script>')
      if (headers.get('x-hermes-session-token') !== 'cache-token-1234567890123456') return Response.json({}, { status: 401 })
      if (url.pathname === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (url.pathname === '/api/sessions') {
        counts.list++
        return Response.json({ sessions: [{ id: 'session-web', profile: 'default', source: 'web', title: '持久会话' }] })
      }
      if (url.pathname === '/api/profiles/sessions') {
        counts.history++
        return Response.json({ sessions: [{ id: 'history-only', source: 'telegram', title: '只读历史' }] })
      }
      if (url.pathname === '/api/sessions/session-web/messages') {
        counts.messages++
        return Response.json({
          session: { id: 'session-web', profile: 'default', source: 'web', title: '持久会话' },
          messages: [{ id: 'message-1', role: 'assistant', content: `持久消息\n![结果](${mediaPath})` }],
          pagination: { total: 1, returned: 1, offset: 0, limit: 100, hasMore: false },
        })
      }
      if (url.pathname === '/api/files/download') {
        counts.media++
        expect(url.searchParams.get('path')).toBe(mediaPath)
        return new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
      }
      if (url.pathname === '/api/sessions/session-web') {
        counts.detail++
        return Response.json({ id: 'session-web', profile: 'default', source: 'web', title: '持久会话' })
      }
      return Response.json({ error: 'missing fixture' }, { status: 404 })
    })
    const first = createApplication({ config: config(home), fetchImpl }); runtimes.push(first)
    const agent = request.agent(first.app.callback())
    const boot = await agent.get('/api/app/bootstrap').set('Host', host).expect(200)
    const setup = await agent.post('/api/app/setup').set('Host', host).set('Origin', origin)
      .set('X-CSRF-Token', boot.body.csrfToken).send({ username: 'owner', password: 'fixture-password' }).expect(200)
    const sessionCookie = cookie(setup)
    const owner = String(setup.body.user.id)
    first.chatCache!.store.recordRoute(owner, 'default', 'session-web', 'runtime-web')
    first.chatCache!.store.recordCommand(owner, 'default', 'session-web', 'session.create', { source: 'web' })

    await first.chatCache!.reconcile(owner,'default','session-web')
    const listPath = '/api/app/sessions?view=chat&profile=default&limit=100'
    await agent.get(listPath).set('Host', host).expect('X-Yaoyao-Data-Source', 'local').expect(200)
    await agent.get(listPath).set('Host', host).expect('X-Yaoyao-Data-Source', 'local').expect(200)
    await agent.get(listPath).set('Host', host).set('X-Yaoyao-Cache', 'bypass')
      .expect('X-Yaoyao-Data-Source', 'local').expect(200)
    const messagesPath = '/api/app/sessions/session-web/messages?profile=default&offset=0&limit=100'
    await agent.get(messagesPath).set('Host', host).expect('X-Yaoyao-Data-Source', 'local').expect(200)
    const cachedMessages = await agent.get(messagesPath).set('Host', host)
      .expect('X-Yaoyao-Data-Source', 'local').expect(200)
    expect(cachedMessages.body.messages[0].content).toContain('持久消息')
    await agent.get(mediaPath).set('Host', host).expect('X-Yaoyao-Data-Source', 'upstream').expect(200)
    const cachedMedia = await agent.get(mediaPath).set('Host', host)
      .expect('X-Yaoyao-Data-Source', 'local').expect(200)
    expect(Buffer.from(cachedMedia.body).toString()).toBe('png-bytes')
    const rangedMedia = await agent.get(mediaPath).set('Host', host).set('Range', 'bytes=0-2')
      .expect('X-Yaoyao-Data-Source', 'local').expect('Content-Range', 'bytes 0-2/9').expect(206)
    expect(Buffer.from(rangedMedia.body).toString()).toBe('png')
    await agent.get('/api/app/sessions?view=history').set('Host', host).expect(200)
    await agent.get('/api/app/sessions?view=history').set('Host', host).expect(200)
    expect(counts).toMatchObject({ list: 0, messages: 1, history: 1, media: 1 })
    const historySnapshots = first.chatCache!.store.db.prepare("SELECT COUNT(*) count FROM chat_snapshots WHERE kind='history'").get() as { count: number }
    expect(historySnapshots.count).toBe(0)

    first.close(); runtimes.splice(runtimes.indexOf(first), 1)
    const offlineFetch = vi.fn<typeof fetch>(async () => { throw new Error('9119 offline') })
    const restarted = createApplication({ config: config(home), fetchImpl: offlineFetch }); runtimes.push(restarted)
    const offlineList = await request(restarted.app.callback()).get(listPath).set('Host', host).set('Cookie', sessionCookie)
      .expect('X-Yaoyao-Data-Source', 'local').expect(200)
    expect(offlineList.body.sessions[0].title).toBe('持久会话')
    const offlineMessages = await request(restarted.app.callback()).get(messagesPath).set('Host', host).set('Cookie', sessionCookie)
      .expect('X-Yaoyao-Data-Source', 'local').expect(200)
    expect(offlineMessages.body.messages[0].content).toContain('持久消息')
    const offlineMedia = await request(restarted.app.callback()).get(mediaPath).set('Host', host).set('Cookie', sessionCookie)
      .expect('X-Yaoyao-Data-Source', 'local').expect(200)
    expect(Buffer.from(offlineMedia.body).toString()).toBe('png-bytes')
    expect(offlineFetch).not.toHaveBeenCalled()
    await request(restarted.app.callback()).get('/api/app/sessions?view=history').set('Host', host).set('Cookie', sessionCookie)
      .expect(502)
    expect(offlineFetch).toHaveBeenCalled()
  })
})
