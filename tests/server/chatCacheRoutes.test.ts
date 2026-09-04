// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'

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
  it('serves warm and restarted chat reads locally while history stays upstream-only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-chat-cache-routes-')); homes.push(home)
    const counts = { list: 0, detail: 0, messages: 0, history: 0, media: 0 }
    const mediaPath = '/Users/test/.hermes/profiles/default/images/result.png'
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      if (url.pathname === '/api/status') return Response.json({ auth_required: false })
      if (url.pathname === '/') return new Response('<script>window.__HERMES_SESSION_TOKEN__="cache-token-1234567890123456";</script>')
      if (headers.get('x-hermes-session-token') !== 'cache-token-1234567890123456') return Response.json({}, { status: 401 })
      if (url.pathname === '/api/profiles') return Response.json({ profiles: [{ name: 'default', is_default: true }] })
      if (url.pathname === '/api/sessions' && url.searchParams.get('source') === 'web') {
        counts.list++
        return Response.json({ sessions: [{ id: 'session-web', profile: 'default', source: 'web', title: '持久会话' }] })
      }
      if (url.pathname === '/api/profiles/sessions' && url.searchParams.get('exclude_sources')?.includes('web')) {
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

    const listPath = '/api/app/sessions?view=chat&profile=default&limit=100'
    await agent.get(listPath).set('Host', host).expect('X-Yaoyao-Data-Source', 'upstream').expect(200)
    await agent.get(listPath).set('Host', host).expect('X-Yaoyao-Data-Source', 'local').expect(200)
    await agent.get(listPath).set('Host', host).set('X-Yaoyao-Cache', 'bypass')
      .expect('X-Yaoyao-Data-Source', 'upstream').expect(200)
    const messagesPath = '/api/app/sessions/session-web/messages?profile=default&offset=0&limit=100'
    await agent.get(messagesPath).set('Host', host).expect('X-Yaoyao-Data-Source', 'upstream').expect(200)
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
    expect(counts).toMatchObject({ list: 2, messages: 1, history: 1, media: 1 })
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
