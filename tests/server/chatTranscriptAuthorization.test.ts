// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Koa from 'koa'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalAuthStore, type UpstreamServiceSession } from '../../src/server/localAuth'
import { ChatCacheStore, ChatCacheCoordinator } from '../../src/server/chatCache'
import { chatTranscriptRouter } from '../../src/server/chatTranscriptApi'

class Response extends EventEmitter {
  writableEnded = false
  destroyed = false
  writableLength = 0
  writes: string[] = []
  writeHead() {}
  flushHeaders() {}
  write(value: string) { this.writes.push(value); return true }
  end() { this.writableEnded = true; this.emit('close') }
}
function context(cookie = ''): Koa.Context {
  const headers: Record<string, string | string[]> = {}
  return { state: {}, request: {}, response: { headers }, get: (name: string) => name === 'cookie' ? cookie : '',
    set: (name: string, value: string | string[]) => { headers[name.toLowerCase()] = value } } as unknown as Koa.Context
}
const issuedCookie = (ctx: Koa.Context) => (ctx.response.headers['set-cookie'] as string[])[0]!.split(';')[0]!
let home: string, store: ChatCacheStore, cache: ChatCacheCoordinator, auth: LocalAuthStore, cookie: string, owner: string, res: Response
beforeEach(async () => {
  vi.useFakeTimers()
  home = mkdtempSync(join(tmpdir(), 'yaoyao-transcript-auth-'))
  store = new ChatCacheStore(home)
  cache = new ChatCacheCoordinator(store, { request: vi.fn() } as unknown as UpstreamServiceSession)
  auth = new LocalAuthStore(home)
  const setup = context(); owner = auth.setupAdmin(setup, 'fixture-user', 'fixture-password').id; cookie = issuedCookie(setup)
  store.recordCommand(owner, 'default', 'session', 'session.create', {})
  store.transcripts.seed(owner, 'default', 'session')
  res = new Response()
  const ctx = context(cookie), cursor = `${store.transcripts.epochFor(owner, 'default', 'session')}:0`
  ctx.state.localUser = auth.require(ctx)
  ctx.path = '/api/app/chat/sessions/session/events'; ctx.method = 'GET'; ctx.query = { profile: 'default', after: cursor }
  ctx.res = res as unknown as Koa.Context['res']
  await chatTranscriptRouter(cache, auth).routes()(ctx, async () => {})
  expect(res.writes.join('')).toContain('event: ready')
})
afterEach(() => { res?.end(); cache?.close(); store?.close(); rmSync(home, { recursive: true, force: true }); vi.useRealTimers() })
const publish = () => store.recordCommand(owner, 'default', 'session', 'prompt.submit', { text: 'after-auth-change', _delivery_id: 'fixture-prompt' })

it('closes a cached-user transcript stream before publishing any message after logout', async () => {
  auth.logout(context(cookie))
  publish(); await Promise.resolve()
  expect(res.writableEnded).toBe(true)
  expect(res.writes.join('')).not.toContain('after-auth-change')
})
it('closes an idle expired-session transcript stream on its next heartbeat', () => {
  vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
  vi.advanceTimersByTime(5000)
  expect(res.writableEnded).toBe(true)
})
it('keeps a valid transcript stream open when another login logs out', async () => {
  const other = context(); auth.login(other, 'fixture-user', 'fixture-password'); auth.logout(context(issuedCookie(other)))
  publish(); await Promise.resolve()
  expect(res.writableEnded).toBe(false)
  expect(res.writes.join('')).toContain('after-auth-change')
})
it('closes the transcript stream after credentials revoke its session', async () => {
  auth.changeCredentials(context(cookie), 'fixture-password', 'fixture-password-changed')
  publish(); await Promise.resolve()
  expect(res.writableEnded).toBe(true)
  expect(res.writes.join('')).not.toContain('after-auth-change')
})
