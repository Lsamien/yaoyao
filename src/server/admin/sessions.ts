import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Koa from 'koa'
import { parse, serialize } from 'cookie'
import { HttpError } from '../errors.js'
import type { LocalAuthStore, LocalUser } from '../localAuth.js'
import { appendSetCookies } from '../security.js'
import { generateTotpSecret, otpauthURL, verifyTotp } from './totp.js'

export const CONSOLE_IDLE_MS = 30 * 60_000
export const CONSOLE_MAX_MS = 8 * 60 * 60_000
export const SUDO_MS = 10 * 60_000

/** `enroll`: signed in, but two-step verification must be set up before anything else. */
export type ConsoleStage = 'full' | 'enroll'

interface ConsoleSession {
  tokenHash: string
  userID: string
  authVersion: number
  createdAt: number
  lastSeenAt: number
  sudoUntil: number
  stage: ConsoleStage
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

  issue(ctx: Koa.Context, user: LocalUser, authVersion: number, stage: ConsoleStage): ConsoleIdentity {
    this.#prune()
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const session: ConsoleSession = { tokenHash: sha256(token), userID: user.id, authVersion, createdAt: now, lastSeenAt: now, sudoUntil: stage === 'full' ? now + SUDO_MS : 0, stage, ip: ctx.ip }
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

  complete(ctx: Koa.Context): void {
    const { session } = this.require(ctx)
    const stored = this.#sessions.get(session.tokenHash)!
    stored.stage = 'full'
    stored.sudoUntil = this.now() + SUDO_MS
    this.#persist(true)
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

interface TwoStepRecord {
  secret?: string
  enabledAt?: number
  pendingSecret?: string
  pendingAt?: number
  recoveryHashes: string[]
  lastCounter?: number
}

/** Authenticator-app verification for console logins. Secrets stay in the data directory with mode 0600. */
export class AdminTwoStepStore {
  readonly #path: string
  #records: Record<string, TwoStepRecord>

  constructor(home: string, readonly now = () => Date.now()) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.#path = join(home, 'admin-security.json')
    try { this.#records = (JSON.parse(readFileSync(this.#path, 'utf8')) as { users: Record<string, TwoStepRecord> }).users ?? {} }
    catch { this.#records = {} }
  }

  status(userID: string): { enabled: boolean; enabledAt?: number; recoveryCodesLeft: number } {
    const record = this.#records[userID]
    return { enabled: Boolean(record?.secret), ...(record?.enabledAt ? { enabledAt: record.enabledAt } : {}), recoveryCodesLeft: record?.recoveryHashes.length ?? 0 }
  }

  enabled(userID: string): boolean { return Boolean(this.#records[userID]?.secret) }

  begin(userID: string, account: string): { secret: string; otpauth: string } {
    const record = this.#records[userID] ?? { recoveryHashes: [] }
    record.pendingSecret = generateTotpSecret()
    record.pendingAt = this.now()
    this.#records[userID] = record
    this.#save()
    return { secret: record.pendingSecret, otpauth: otpauthURL(record.pendingSecret, account) }
  }

  /** Confirms the authenticator and returns ten one-time recovery codes (shown once). */
  confirm(userID: string, code: string): string[] {
    const record = this.#records[userID]
    if (!record?.pendingSecret || this.now() - (record.pendingAt ?? 0) > 15 * 60_000) throw new HttpError(409, '绑定已过期，请重新开始。', 'admin_two_step_expired')
    const counter = verifyTotp(record.pendingSecret, code, this.now())
    if (counter === undefined) throw new HttpError(400, '验证码不正确，请核对手机上的 6 位数字。', 'admin_two_step_invalid')
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'))
    this.#records[userID] = { secret: record.pendingSecret, enabledAt: this.now(), recoveryHashes: codes.map(value => sha256(value.replace('-', ''))), lastCounter: counter }
    this.#save()
    return codes
  }

  /** Accepts a current authenticator code (each code once) or an unused recovery code. */
  verify(userID: string, code: string): boolean {
    const record = this.#records[userID]
    if (!record?.secret) return false
    const counter = verifyTotp(record.secret, code, this.now())
    if (counter !== undefined) {
      if (record.lastCounter !== undefined && counter <= record.lastCounter) return false
      record.lastCounter = counter
      this.#save()
      return true
    }
    const recovery = sha256(code.replace(/[\s-]/g, '').toUpperCase())
    const index = record.recoveryHashes.indexOf(recovery)
    if (index < 0) return false
    record.recoveryHashes.splice(index, 1)
    this.#save()
    return true
  }

  disable(userID: string): void {
    delete this.#records[userID]
    this.#save()
  }

  #save(): void { atomicWrite(this.#path, JSON.stringify({ version: 1, users: this.#records })) }
}
