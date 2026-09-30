// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Koa from 'koa'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalAuthStore } from '../../src/server/localAuth'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { streamWorkspace } from '../../src/server/workspaceSync'

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
  return { state: {}, response: { headers }, get: (name: string) => name === 'cookie' ? cookie : '',
    set: (name: string, value: string | string[]) => { headers[name.toLowerCase()] = value } } as unknown as Koa.Context
}
const issuedCookie = (ctx: Koa.Context) => (ctx.response.headers['set-cookie'] as string[])[0]!.split(';')[0]!
let home: string, store: WorkspaceStore, auth: LocalAuthStore, cookie: string, owner: string, res: Response
beforeEach(() => {
  vi.useFakeTimers()
  home = mkdtempSync(join(tmpdir(), 'yaoyao-sse-auth-')); store = new WorkspaceStore(home); auth = new LocalAuthStore(home)
  const setup = context(); owner = auth.setupAdmin(setup, 'fixture-user', 'fixture-password').id; cookie = issuedCookie(setup)
  res = new Response()
  const ctx = context(cookie)
  // Mirror the authentication middleware's cached request identity.
  ctx.state.localUser = auth.require(ctx); ctx.query = {}; ctx.res = res as unknown as Koa.Context['res']
  streamWorkspace(ctx, store, auth)
})
afterEach(() => { res.end(); store.close(); rmSync(home, { recursive: true, force: true }); vi.useRealTimers() })

it('closes the cached-user stream and sends no further event after logout', () => {
  const version = auth.pushAuthorizationVersion(owner)
  auth.logout(context(cookie))
  expect(auth.pushAuthorizationVersion(owner)).toBe(version)
  expect(auth.currentFromCookieHeader(cookie)).toBeUndefined()
  store.event(owner, 'conversation.changed', { id: 'after-logout' })
  expect(res.writableEnded).toBe(true)
  expect(res.writes.join('')).not.toContain('after-logout')
  expect(store.changes.listenerCount(owner)).toBe(0)
})

it('closes an idle expired-session stream on its next heartbeat', () => {
  vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
  vi.advanceTimersByTime(15_000)
  expect(res.writableEnded).toBe(true)
  expect(store.changes.listenerCount(owner)).toBe(0)
})

it('keeps a different valid login stream open when another session logs out', () => {
  const other = context(); auth.login(other, 'fixture-user', 'fixture-password')
  auth.logout(context(issuedCookie(other)))
  store.event(owner, 'conversation.changed', { id: 'still-authorized' })
  expect(res.writableEnded).toBe(false)
  expect(res.writes.join('')).toContain('still-authorized')
})

it('still closes on account password revocation', () => {
  auth.changeCredentials(context(cookie), 'fixture-password', 'fixture-password-changed')
  store.event(owner, 'conversation.changed', { id: 'after-password-change' })
  expect(res.writableEnded).toBe(true)
  expect(res.writes.join('')).not.toContain('after-password-change')
})
