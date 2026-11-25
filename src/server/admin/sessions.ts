import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Koa from 'koa'
import { parse, serialize } from 'cookie'
import { HttpError } from '../errors.js'
import type { LocalAuthStore, LocalUser } from '../localAuth.js'
import { appendSetCookies } from '../security.js'

export const CONSOLE_IDLE_MS = 30 * 60_000
export const CONSOLE_MAX_MS = 8 * 60 * 60_000
export const SUDO_MS = 10 * 60_000

interface ConsoleSession {
  tokenHash: string
  userID: string
  authVersion: number
  createdAt: number
  lastSeenAt: number
  sudoUntil: number
  ip: string
}

export interface ConsoleIdentity { user: LocalUser; session: Readonly<ConsoleSession> }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, value, { mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Console sessions live apart from Web sessions: their own file, cookie name and scope.
 * A Web session token is never accepted here, and a console token is never accepted on the Web.
 */
export class AdminSessionStore {
  readonly #path: string
  readonly #sessions = new Map<string, ConsoleSession>()
  readonly cookieName: string
  #lastPersist = 0

  constructor(home: string, readonly auth: LocalAuthStore, readonly secure = false, readonly now = () => Date.now()) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.#path = join(home, 'admin-sessions.json')
    // Cookies ignore ports: a distinct name keeps the Web and the console apart on one host.
    this.cookieName = secure ? '__Host-yaoyao_admin_session' : 'yaoyao_admin_session'
    try {
      const stored = JSON.parse(readFileSync(this.#path, 'utf8')) as { version: 1; sessions: ConsoleSession[] }
      for (const session of stored.sessions ?? []) this.#sessions.set(session.tokenHash, session)
    } catch { /* No sessions yet. */ }
  }

  issue(ctx: Koa.Context, user: LocalUser, authVersion: number): ConsoleIdentity {
    this.#prune()
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const session: ConsoleSession = { tokenHash: sha256(token), userID: user.id, authVersion, createdAt: now, lastSeenAt: now, sudoUntil: now + SUDO_MS, ip: ctx.ip }
    this.#sessions.set(session.tokenHash, session)
    this.#persist(true)
    appendSetCookies(ctx, [serialize(this.cookieName, token, { httpOnly: true, secure: this.secure, sameSite: 'strict', path: '/', maxAge: CONSOLE_MAX_MS / 1000 })])
    return { user, session }
  }

  current(ctx: Koa.Context): ConsoleIdentity | undefined {
    const token = parse(ctx.get('cookie') || '')[this.cookieName]
    if (!token) return undefined
    const key = sha256(token)
    const session = this.#sessions.get(key)
    if (!session || !timingSafeEqual(Buffer.from(session.tokenHash), Buffer.from(key))) return undefined
    const now = this.now()
    if (now - session.lastSeenAt > CONSOLE_IDLE_MS || now - session.createdAt > CONSOLE_MAX_MS) {
      this.#sessions.delete(key)
      this.#persist(true)
      return undefined
    }
    const user = this.auth.consoleAdmin(session.userID, session.authVersion)
    if (!user) {
      this.#sessions.delete(key)
      this.#persist(true)
      return undefined
    }
    session.lastSeenAt = now
    this.#persist(false)
    return { user, session }
  }

  require(ctx: Koa.Context): ConsoleIdentity {
    const identity = this.current(ctx)
    if (!identity) throw new HttpError(401, '请先登录管理后台', 'admin_console_login_required')
    return identity
  }

  /** Remaining lifetime of the console session, for the header countdown. */
  expiresAt(session: Readonly<ConsoleSession>): number {
    return Math.min(session.lastSeenAt + CONSOLE_IDLE_MS, session.createdAt + CONSOLE_MAX_MS)
  }

  grantSudo(ctx: Koa.Context): number {
    const { session } = this.require(ctx)
    const until = this.now() + SUDO_MS
    this.#sessions.get(session.tokenHash)!.sudoUntil = until
    this.#persist(true)
    return until
  }

  logout(ctx: Koa.Context): void {
    const token = parse(ctx.get('cookie') || '')[this.cookieName]
    if (token) this.#sessions.delete(sha256(token))
    this.#persist(true)
    appendSetCookies(ctx, [serialize(this.cookieName, '', { httpOnly: true, secure: this.secure, sameSite: 'strict', path: '/', maxAge: 0 })])
  }

  revokeUser(userID: string): void {
    for (const [key, session] of this.#sessions) if (session.userID === userID) this.#sessions.delete(key)
    this.#persist(true)
  }

  #prune(): void {
    const now = this.now()
    for (const [key, session] of this.#sessions)
      if (now - session.lastSeenAt > CONSOLE_IDLE_MS || now - session.createdAt > CONSOLE_MAX_MS) this.#sessions.delete(key)
  }

  /** Activity timestamps are written at most once a minute; security changes are written at once. */
  #persist(force: boolean): void {
    const now = this.now()
    if (!force && now - this.#lastPersist < 60_000) return
    this.#lastPersist = now
    atomicWrite(this.#path, JSON.stringify({ version: 1, sessions: [...this.#sessions.values()] }))
  }
}
