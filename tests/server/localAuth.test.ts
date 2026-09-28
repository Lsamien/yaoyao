import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Koa from 'koa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAuthStore } from '../../src/server/localAuth.js'

const homes: string[] = []

function context(cookie = ''): Koa.Context {
  const headers: Record<string, string | string[]> = {}
  return {
    state: {},
    get: (name: string) => name.toLowerCase() === 'cookie' ? cookie : '',
    set: (name: string, value: string | string[]) => { headers[name.toLowerCase()] = value },
    response: { headers },
  } as unknown as Koa.Context
}

function issuedCookie(ctx: Koa.Context): string {
  const value = ctx.response.headers['set-cookie']
  const raw = Array.isArray(value) ? value.at(-1) : String(value)
  return raw.split(';', 1)[0]!
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('15300 local users', () => {
  it('requires an explicit first administrator and persists its session', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-'))
    homes.push(home)
    const store = new LocalAuthStore(home)
    expect(store.setupRequired).toBe(true)
    const setup = context()
    const admin = store.setupAdmin(setup, 'owner', 'new-password')
    expect(admin).toMatchObject({ username: 'owner', role: 'admin', mustChangePassword: false })
    expect(store.setupRequired).toBe(false)
    expect(() => store.setupAdmin(context(), 'second', 'new-password')).toThrow(/已经初始化/)
    expect(store.require(context(issuedCookie(setup))).username).toBe('owner')
    const restarted = new LocalAuthStore(home)
    expect(restarted.require(context(issuedCookie(setup))).username).toBe('owner')
  })

  it('lets the administrator create, reset, disable and delete ordinary users', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-'))
    homes.push(home)
    const store = new LocalAuthStore(home)
    const first = context()
    store.setupAdmin(first, 'admin', 'new-password')
    const admin = store.require(context(issuedCookie(first)))
    const user = store.create(admin, 'member', 'temporary-password')
    expect(user.mustChangePassword).toBe(true)
    expect(store.updateUser(admin, user.id, { enabled: false }).enabled).toBe(false)
    store.deleteUser(admin, user.id)
    expect(store.list(admin).map(item => item.username)).toEqual(['admin'])
  })

  it('persists an account image without invalidating the existing session', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-')); homes.push(home)
    const store = new LocalAuthStore(home), login = context()
    store.setupAdmin(login, 'admin', 'new-password')
    const active = context(issuedCookie(login))
    const avatar = 'data:image/png;base64,aGVsbG8='
    expect(store.setAvatar(active, avatar).avatar).toBe(avatar)
    expect(store.require(active).avatar).toBe(avatar)
    expect(new LocalAuthStore(home).require(context(issuedCookie(login))).avatar).toBe(avatar)
    expect(() => store.setAvatar(active, 'https://example.test/avatar.png')).toThrow(/PNG、JPEG/)
    expect(store.setAvatar(active, null).avatar).toBeUndefined()
  })

  it('encrypts the 9119 service password at rest', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-local-auth-'))
    homes.push(home)
    const store = new LocalAuthStore(home)
    const first = context()
    store.setupAdmin(first, 'admin', 'new-password')
    const admin = store.require(context(issuedCookie(first)))
    store.setUpstreamCredentials(admin, { username: 'service', password: 'very-secret' })
    expect(store.upstreamCredentials()).toEqual({ username: 'service', password: 'very-secret' })
    expect(readFileSync(join(home, 'upstream-credentials.enc'), 'utf8')).not.toContain('very-secret')
  })
})

it('desktop authorizations survive time and server restart, but logout and password changes revoke them', () => {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-desktop-auth-')); homes.push(home)
  let store = new LocalAuthStore(home)
  store.setupAdmin(context(), 'admin', 'initial-password')
  const login = context(); store.login(login, 'admin', 'initial-password', true)
  const cookie = issuedCookie(login)
  const sessions = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8'))
  expect(sessions.sessions.some((s: { desktop?: boolean; expiresAt: number }) => s.desktop && s.expiresAt === Number.MAX_SAFE_INTEGER)).toBe(true)
  const later = Date.now() + 500 * 86400 * 1000
  vi.spyOn(Date, 'now').mockReturnValue(later)
  store = new LocalAuthStore(home)
  expect(store.require(context(cookie)).role).toBe('admin')
  const change = context(cookie)
  store.changeCredentials(change, 'initial-password', 'updated-password')
  expect(store.current(context(cookie))).toBeUndefined()
  expect(store.current(change)).toBeUndefined()
  const next = context(); store.login(next, 'admin', 'updated-password', true)
  const nextCookie = issuedCookie(next)
  store.logout(context(nextCookie))
  expect(new LocalAuthStore(home).current(context(nextCookie))).toBeUndefined()
})

it('upgrades an existing browser session and invalidates the replaced token', () => {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-upgrade-auth-')); homes.push(home)
  const store = new LocalAuthStore(home), setup = context()
  store.setupAdmin(setup, 'owner', 'initial-password')
  const oldCookie = issuedCookie(setup), upgrade = context(oldCookie)
  store.persistDesktopSession(upgrade)
  expect(store.current(context(oldCookie))).toBeUndefined()
  expect(new LocalAuthStore(home).require(context(issuedCookie(upgrade))).username).toBe('owner')
  expect(() => store.persistDesktopSession(context())).toThrow(/请先登录/)
})

it('local desktop creates or reuses the real administrator, without a public default password', () => {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-native-admin-')); homes.push(home)
  let store = new LocalAuthStore(home)
  const native = context(), admin = store.localDesktopSession(native)
  expect(admin).toMatchObject({ username: 'admin', role: 'admin', localDesktop: true, mustChangePassword: false })
  expect(store.current(context())).toBeUndefined()
  expect(() => store.login(context(), 'admin', 'admin')).toThrow()
  const active = context(issuedCookie(native))
  store.changeCredentials(active, '', 'remote-password')
  store = new LocalAuthStore(home)
  expect(store.localDesktopSession(context()).id).toBe(admin.id)
  const remote = context(); store.login(remote, 'admin', 'remote-password', true)
  expect(store.require(context(issuedCookie(remote))).localDesktop).toBeUndefined()
  expect(() => store.changeCredentials(context(issuedCookie(remote)), '', 'another-password')).toThrow('当前密码错误')
})
