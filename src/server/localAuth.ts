import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type Koa from 'koa'
import { parse, serialize } from 'cookie'
import { HttpError } from './errors.js'
import { validAvatarImage } from '../shared/agentIdentity.js'
import { appendSetCookies } from './security.js'
import { CookieJar, type UpstreamRequestOptions, type UpstreamResponse, UpstreamClient } from './upstream.js'
import { allowsLocalAuthorization, isLocalAuthorizationTarget, localSessionToken } from './loopbackAuthorization.js'

const SESSION_COOKIE = 'hermes_yaoyao_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const USERNAME_PATTERN = /^[^\u0000-\u001f\u007f\s/@\\]{1,100}$/u

export type LocalRole = 'admin' | 'user'

interface StoredUser {
  id: string
  username: string
  avatar?: string
  normalizedUsername: string
  role: LocalRole
  enabled: boolean
  mustChangePassword: boolean
  salt: string
  passwordHash: string
  authVersion: number
  createdAt: number
  updatedAt: number
}

interface StoredUsers { version: 1; users: StoredUser[] }

interface SessionRecord {
  userID: string
  authVersion: number
  expiresAt: number
}
interface StoredSessions { version: 1; sessions: Array<SessionRecord & { tokenHash: string }> }

export interface LocalUser {
  id: string
  username: string
  avatar?: string
  role: LocalRole
  enabled: boolean
  mustChangePassword: boolean
  createdAt: number
  updatedAt: number
}

export interface UpstreamCredentials { username: string; password: string }

function passwordDigest(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, {
    N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1_024 * 1_024,
  })
}

function canonicalUsername(value: string): string {
  const username = value.trim()
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(400, '用户名必须为 1 到 100 个不含空格的字符', 'invalid_username')
  }
  return username
}

function validatePassword(value: string, allowDefault = false): string {
  if (value.length > 4_096 || (!allowDefault && value.length < 8) || (allowDefault && !value)) {
    throw new HttpError(400, '密码必须至少 8 个字符', 'invalid_password')
  }
  return value
}

function publicUser(user: StoredUser): LocalUser {
  return {
    id: user.id,
    username: user.username,
    ...(validAvatarImage(user.avatar) ? { avatar: user.avatar } : {}),
    role: user.role,
    enabled: user.enabled,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export class LocalAuthStore {
  readonly #path: string
  readonly #credentialPath: string
  readonly #keyPath: string
  readonly #sessionsPath: string
  readonly #secureCookie: boolean
  readonly #sessions = new Map<string, SessionRecord>()
  #users: StoredUser[]

  constructor(home: string, secureCookie = false) {
    this.#path = join(home, 'users.json')
    this.#credentialPath = join(home, 'upstream-credentials.enc')
    this.#keyPath = join(home, 'local-auth.key')
    this.#sessionsPath = join(home, 'sessions.json')
    this.#secureCookie = secureCookie
    this.#users = this.#loadUsers()
    this.#loadSessions()
  }

  get setupRequired(): boolean {
    return this.#users.length === 0
  }

  /** Exact persisted user identity used only to validate a legacy registry migration. */
  soleUserIDForLegacyMigration(): string | undefined {
    return this.#users.length === 1 ? this.#users[0]!.id : undefined
  }

  setupAdmin(
    ctx: Koa.Context,
    usernameValue: string,
    passwordValue: string,
  ): LocalUser {
    if (!this.setupRequired) {
      throw new HttpError(409, '管理员已经初始化', 'setup_already_completed')
    }
    const username = canonicalUsername(usernameValue)
    const password = validatePassword(passwordValue)
    const now = Date.now()
    const admin = this.#newUser(username, password, 'admin', false, now)
    this.#users = [admin]
    this.#saveUsers()
    return this.#issueSession(ctx, admin)
  }

  login(ctx: Koa.Context, usernameValue: string, password: string): LocalUser {
    const normalized = usernameValue.trim().toLocaleLowerCase('en-US')
    const user = this.#users.find(candidate => candidate.normalizedUsername === normalized)
    if (!user || !user.enabled || !this.#passwordMatches(user, password)) {
      throw new HttpError(401, '用户名或密码错误', 'login_failed')
    }
    return this.#issueSession(ctx, user)
  }

  issueSession(ctx: Koa.Context, userID: string): LocalUser {
    const user = this.#users.find(candidate => candidate.id === userID)
    if (!user || !user.enabled) {
      throw new HttpError(401, '用户已失效', 'account_pairing_user_unavailable')
    }
    return this.#issueSession(ctx, user)
  }

  #issueSession(ctx: Koa.Context, user: StoredUser): LocalUser {
    const token = randomBytes(32).toString('base64url')
    this.#sessions.set(this.#sessionKey(token), {
      userID: user.id,
      authVersion: user.authVersion,
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000,
    })
    this.#saveSessions()
    appendSetCookies(ctx, [serialize(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.#secureCookie,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    })])
    const published = publicUser(user)
    ctx.state.localUser = published
    return published
  }

  logout(ctx: Koa.Context): void {
    const token = this.#token(ctx)
    if (token) this.#sessions.delete(this.#sessionKey(token))
    this.#saveSessions()
    appendSetCookies(ctx, [serialize(SESSION_COOKIE, '', {
      httpOnly: true, secure: this.#secureCookie, sameSite: 'strict', path: '/', maxAge: 0,
    })])
  }

  current(ctx: Koa.Context): LocalUser | undefined {
    const injected = ctx.state.localUser as LocalUser | undefined
    if (injected) return injected
    return this.currentFromCookieHeader(ctx.get('cookie'))
  }

  /** Resolve the same authenticated user for non-Koa transports such as WS Upgrade. */
  currentFromCookieHeader(cookieHeader: string | undefined): LocalUser | undefined {
    const token = parse(cookieHeader ?? '')[SESSION_COOKIE]
    if (!token) return undefined
    const key = this.#sessionKey(token)
    const session = this.#sessions.get(key)
    if (!session || session.expiresAt <= Date.now()) {
      this.#sessions.delete(key)
      this.#saveSessions()
      return undefined
    }
    const user = this.#users.find(candidate => candidate.id === session.userID)
    if (!user || !user.enabled || user.authVersion !== session.authVersion) {
      this.#sessions.delete(key)
      this.#saveSessions()
      return undefined
    }
    return publicUser(user)
  }

  require(ctx: Koa.Context, allowPasswordChange = false): LocalUser {
    const user = this.current(ctx)
    if (!user) throw new HttpError(401, '请先登录夭夭', 'authentication_required')
    if (user.mustChangePassword && !allowPasswordChange) {
      throw new HttpError(428, '必须先修改初始密码', 'password_change_required')
    }
    return user
  }

  requireAdmin(ctx: Koa.Context): LocalUser {
    const user = this.require(ctx)
    if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    return user
  }

  isUserActive(userID: string): boolean {
    return this.#users.some(user => user.id === userID && user.enabled)
  }

  pushAuthorizationVersion(userID: string): number | undefined {
    const user = this.#users.find(candidate => candidate.id === userID && candidate.enabled)
    return user?.authVersion
  }

  list(admin: LocalUser): LocalUser[] {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    return this.#users.map(publicUser).sort((a, b) => a.createdAt - b.createdAt)
  }

  create(admin: LocalUser, usernameValue: string, passwordValue: string): LocalUser {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    const username = canonicalUsername(usernameValue)
    const normalizedUsername = username.toLocaleLowerCase('en-US')
    if (this.#users.some(user => user.normalizedUsername === normalizedUsername)) {
      throw new HttpError(409, '用户名已存在', 'username_exists')
    }
    const password = validatePassword(passwordValue)
    const now = Date.now()
    const user = this.#newUser(username, password, 'user', true, now)
    this.#users.push(user)
    this.#saveUsers()
    return publicUser(user)
  }

  updateUser(admin: LocalUser, userID: string, input: { enabled?: boolean; password?: string }): LocalUser {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    const user = this.#users.find(candidate => candidate.id === userID)
    if (!user) throw new HttpError(404, '用户不存在', 'user_not_found')
    if (user.role === 'admin') throw new HttpError(409, '管理员账号请在账号设置中修改', 'admin_account_protected')
    if (typeof input.enabled === 'boolean') user.enabled = input.enabled
    if (input.password !== undefined) {
      this.#setPassword(user, validatePassword(input.password), true)
    } else {
      user.authVersion += 1
    }
    user.updatedAt = Date.now()
    this.#saveUsers()
    return publicUser(user)
  }

  deleteUser(admin: LocalUser, userID: string): void {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    const user = this.#users.find(candidate => candidate.id === userID)
    if (!user) throw new HttpError(404, '用户不存在', 'user_not_found')
    if (user.role === 'admin') throw new HttpError(409, '不能删除管理员账号', 'admin_account_protected')
    this.#users = this.#users.filter(candidate => candidate.id !== userID)
    this.#saveUsers()
    this.#revokeUser(userID)
  }

  changeCredentials(
    ctx: Koa.Context,
    currentPassword: string,
    newPassword: string,
    newUsername?: string,
  ): LocalUser {
    const current = this.require(ctx, true)
    const user = this.#users.find(candidate => candidate.id === current.id)!
    if (!this.#passwordMatches(user, currentPassword)) {
      throw new HttpError(401, '当前密码错误', 'invalid_current_password')
    }
    const username = newUsername === undefined ? user.username : canonicalUsername(newUsername)
    const normalized = username.toLocaleLowerCase('en-US')
    if (this.#users.some(candidate => candidate.id !== user.id && candidate.normalizedUsername === normalized)) {
      throw new HttpError(409, '用户名已存在', 'username_exists')
    }
    user.username = username
    user.normalizedUsername = normalized
    this.#setPassword(user, validatePassword(newPassword), false)
    user.mustChangePassword = false
    user.updatedAt = Date.now()
    this.#saveUsers()
    this.#revokeUser(user.id)
    return this.login(ctx, username, newPassword)
  }

  setAvatar(ctx: Koa.Context, value: unknown): LocalUser {
    const current = this.require(ctx)
    const user = this.#users.find(candidate => candidate.id === current.id)!
    if (value !== null && value !== '' && !validAvatarImage(value)) {
      throw new HttpError(400, '头像必须是有效的 PNG、JPEG 或 WebP 图片', 'invalid_account_avatar')
    }
    if (typeof value === 'string' && value) user.avatar = value
    else delete user.avatar
    user.updatedAt = Date.now()
    this.#saveUsers()
    const published = publicUser(user)
    ctx.state.localUser = published
    return published
  }

  upstreamCredentials(fallback?: UpstreamCredentials): UpstreamCredentials | undefined {
    try {
      const encoded = Buffer.from(readFileSync(this.#credentialPath, 'utf8').trim(), 'base64url')
      if (encoded.byteLength < 29) return fallback
      const key = this.#key()
      const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12))
      decipher.setAuthTag(encoded.subarray(12, 28))
      const raw = Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8')
      const value = JSON.parse(raw) as UpstreamCredentials
      return value.username && value.password ? value : fallback
    } catch {
      return fallback
    }
  }

  setUpstreamCredentials(admin: LocalUser, credentials: UpstreamCredentials): void {
    if (admin.role !== 'admin') throw new HttpError(403, '需要管理员权限', 'admin_required')
    this.#writeUpstreamCredentials(credentials)
  }

  #writeUpstreamCredentials(credentials: UpstreamCredentials): void {
    const username = canonicalUsername(credentials.username)
    const password = validatePassword(credentials.password, true)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key(), iv)
    const encrypted = Buffer.concat([
      iv,
      cipher.update(JSON.stringify({ username, password }), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ])
    // Store as IV + auth tag + ciphertext for a stable, inspectable envelope.
    const normalized = Buffer.concat([encrypted.subarray(0, 12), encrypted.subarray(-16), encrypted.subarray(12, -16)])
    this.#atomicWrite(this.#credentialPath, `${normalized.toString('base64url')}\n`)
  }

  #token(ctx: Koa.Context): string | undefined {
    return parse(ctx.get('cookie') || '')[SESSION_COOKIE]
  }

  #revokeUser(userID: string): void {
    for (const [token, session] of this.#sessions) {
      if (session.userID === userID) this.#sessions.delete(token)
    }
    this.#saveSessions()
  }

  #passwordMatches(user: StoredUser, password: string): boolean {
    try {
      const expected = Buffer.from(user.passwordHash, 'base64')
      const actual = passwordDigest(password, Buffer.from(user.salt, 'base64'))
      return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
    } catch {
      return false
    }
  }

  #setPassword(user: StoredUser, password: string, mustChange: boolean): void {
    const salt = randomBytes(16)
    user.salt = salt.toString('base64')
    user.passwordHash = passwordDigest(password, salt).toString('base64')
    user.mustChangePassword = mustChange
    user.authVersion += 1
  }

  #newUser(username: string, password: string, role: LocalRole, mustChange: boolean, now: number): StoredUser {
    const salt = randomBytes(16)
    return {
      id: randomUUID().toLowerCase(),
      username,
      normalizedUsername: username.toLocaleLowerCase('en-US'),
      role,
      enabled: true,
      mustChangePassword: mustChange,
      salt: salt.toString('base64'),
      passwordHash: passwordDigest(password, salt).toString('base64'),
      authVersion: 1,
      createdAt: now,
      updatedAt: now,
    }
  }

  #loadUsers(): StoredUser[] {
    try {
      const value = JSON.parse(readFileSync(this.#path, 'utf8')) as StoredUsers
      if (value.version !== 1 || !Array.isArray(value.users) || value.users.length === 0) throw new Error()
      return value.users
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('15300 用户库损坏，已停止启动以避免覆盖数据')
      }
      return []
    }
  }

  #saveUsers(): void {
    this.#atomicWrite(this.#path, `${JSON.stringify({ version: 1, users: this.#users }, null, 2)}\n`)
  }

  #sessionKey(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url')
  }

  #loadSessions(): void {
    try {
      const value = JSON.parse(readFileSync(this.#sessionsPath, 'utf8')) as StoredSessions
      if (value.version !== 1 || !Array.isArray(value.sessions)) throw new Error('invalid sessions')
      const now = Date.now()
      for (const session of value.sessions) {
        if (session.tokenHash && session.expiresAt > now) {
          this.#sessions.set(session.tokenHash, {
            userID: session.userID, authVersion: session.authVersion, expiresAt: session.expiresAt,
          })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt sessions are safely discarded; user credentials remain authoritative.
      }
    }
  }

  #saveSessions(): void {
    const sessions = [...this.#sessions.entries()].map(([tokenHash, value]) => ({ tokenHash, ...value }))
    this.#atomicWrite(this.#sessionsPath, `${JSON.stringify({ version: 1, sessions })}\n`)
  }

  #key(): Buffer {
    try {
      const key = readFileSync(this.#keyPath)
      if (key.byteLength !== 32) throw new Error('invalid key')
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const key = randomBytes(32)
      this.#atomicWrite(this.#keyPath, key)
      return key
    }
  }

  #atomicWrite(path: string, value: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temporary, value, { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  }
}

export class UpstreamServiceSession {
  readonly #jar = new CookieJar('')
  #loginTask: Promise<void> | undefined
  #ensureTask: Promise<void> | undefined
  #validatedUntil = 0
  #credentialFingerprint: string | undefined
  #generation = 0
  #authMode: 'unknown' | 'loopback-token' | 'loopback-direct' | 'password' = 'unknown'
  #lastVerifiedAt: number | undefined
  #localAuthorization = false
  readonly #now: () => number
  readonly #validationTTL: number

  constructor(
    readonly client: UpstreamClient,
    readonly credentials: () => UpstreamCredentials | undefined,
    options: { now?: () => number; validationTTL?: number } = {},
  ) {
    this.#now = options.now ?? Date.now
    this.#validationTTL = options.validationTTL ?? 30_000
    client.setReauthenticationHandler(this.#jar, async () => {
      this.#syncCredentials()
      this.#validatedUntil = 0
      await this.#renewAuthorization(this.#generation)
    })
  }

  get jar(): CookieJar { return this.#jar }
  get authorizationMode(): 'local' | 'account' { return this.#localAuthorization ? 'local' : 'account' }

  async webSocketCredential(): Promise<{ name: 'token' | 'ticket'; value: string }> {
    await this.ensure()
    if (this.#localAuthorization) {
      if (!this.#jar.sessionToken) await this.#renewAuthorization(this.#generation)
      else {
        // A restarted Hermes rotates its process token even within our REST
        // validation lease. Validate before a new socket; a 401 renews once.
        const check = await this.client.request('/api/profiles', this.#jar, { cache: 'reload' })
        if (check.status !== 200) throw new HttpError(502, 'Hermes 本机会话令牌验证失败', 'local_authorization_rejected')
      }
      if (this.#localAuthorization && this.#jar.sessionToken) return { name: 'token', value: this.#jar.sessionToken }
    }
    let response = await this.request('/api/auth/ws-ticket', { method: 'POST' })
    // Auth endpoints are excluded from generic request retries. Repair an
    // expired account cookie or a restarted upstream's changed auth mode here.
    if (response.status === 401) {
      await this.#renewAuthorization(this.#generation)
      if (this.#localAuthorization && this.#jar.sessionToken) return { name: 'token', value: this.#jar.sessionToken }
      response = await this.request('/api/auth/ws-ticket', { method: 'POST' })
    }
    if (this.#localAuthorization && this.#jar.sessionToken) return { name: 'token', value: this.#jar.sessionToken }
    if (response.status < 200 || response.status >= 300) throw new HttpError(502, 'Hermes 未签发实时连接凭据', 'upstream_auth_failed')
    let value: unknown
    try { value = JSON.parse(response.body.toString()).ticket } catch { /* fail closed */ }
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(502, 'Hermes 返回了空实时连接凭据', 'invalid_ticket')
    return { name: 'ticket', value: value.trim() }
  }

  connectionInfo(): {
    endpoint: string
    authMode: 'unknown' | 'loopback-token' | 'loopback-direct' | 'password'
    networkScope: 'local' | 'network'
    lastVerifiedAt?: number
  } {
    return {
      endpoint: this.client.baseURL.origin,
      authMode: this.#authMode,
      networkScope: this.#isLoopbackUpstream() ? 'local' : 'network',
      lastVerifiedAt: this.#lastVerifiedAt,
    }
  }

  async ensure(): Promise<void> {
    this.#syncCredentials()
    if (this.#validatedUntil > this.#now()) return
    if (this.#ensureTask) return this.#ensureTask
    const generation = this.#generation
    const task = this.#validate(generation).then(() => {
      this.#checkGeneration(generation)
      this.#lastVerifiedAt = this.#now()
      this.#validatedUntil = this.#lastVerifiedAt + this.#validationTTL
    }).finally(() => { if (this.#ensureTask === task) this.#ensureTask = undefined })
    this.#ensureTask = task
    return task
  }

  invalidateAuthentication(): void { this.#validatedUntil = 0; this.client.invalidateReads() }

  #syncCredentials(): void {
    const fingerprint = createHash('sha256').update(JSON.stringify(this.credentials() ?? null)).digest('hex')
    if (this.#credentialFingerprint !== undefined && fingerprint !== this.#credentialFingerprint) {
      this.#generation++
      this.#validatedUntil = 0; this.#ensureTask = undefined; this.#loginTask = undefined
      this.#jar.replace(new CookieJar())
      this.#authMode = 'unknown'
      this.#localAuthorization = false
      this.#lastVerifiedAt = undefined
      this.client.invalidateReads()
    }
    this.#credentialFingerprint = fingerprint
  }

  #checkGeneration(generation: number): void {
    this.#syncCredentials()
    if (generation !== this.#generation) throw new HttpError(409, '上游凭据已变化，请重试读取', 'upstream_credentials_changed')
  }

  async #validate(generation: number): Promise<void> {
    // Probe into a temporary jar. A delayed old probe must not overwrite freshly
    // rotated service credentials/cookies in the live jar.
    const probe = new CookieJar(this.#jar.header)
    probe.setSessionToken(this.#jar.sessionToken)
    const status = await this.client.request('/api/status', probe)
    if (status.status < 200 || status.status >= 300) throw new HttpError(502, '9119 状态不可用', 'upstream_unavailable')
    const parsed = JSON.parse(status.body.toString('utf8')) as Record<string, unknown>
    this.#checkGeneration(generation)
    if (allowsLocalAuthorization(parsed)) {
      this.#requireLocalTarget()
      const authMode = await this.#loadLoopbackToken(probe)
        ? 'loopback-token'
        : 'loopback-direct'
      this.#checkGeneration(generation)
      this.#authMode = authMode
      this.#localAuthorization = true
      this.#jar.replace(probe)
      return
    }
    this.#authMode = 'password'
    this.#localAuthorization = false
    probe.setSessionToken(undefined)
    const me = await this.client.request('/api/auth/me', probe)
    this.#checkGeneration(generation)
    if (me.status >= 200 && me.status < 300) {
      this.#jar.replace(probe)
      return
    }
    if (me.status !== 401 && me.status !== 403) throw new HttpError(502, '无法验证 9119 服务会话', 'upstream_auth_unavailable')
    await this.#login(generation)
  }

  async request(path: string, options: UpstreamRequestOptions = {}): Promise<UpstreamResponse> {
    await this.ensure()
    return this.client.request(path, this.#jar, options)
  }

  async verify(credentials: UpstreamCredentials): Promise<void> {
    await this.#authenticate(credentials, new CookieJar(''))
  }

  async #login(generation: number): Promise<void> {
    if (this.#loginTask) return this.#loginTask
    const credentials = this.credentials()
    if (!credentials) throw new HttpError(503, '9119 当前启用了账号鉴权，请配置服务账号；本机授权需由回环 9119 明确启用', 'upstream_credentials_required')
    const jar = new CookieJar()
    const task = this.#authenticate({ ...credentials }, jar).then(() => {
      this.#checkGeneration(generation)
      this.#jar.replace(jar)
      this.#authMode = 'password'
      this.#localAuthorization = false
      this.client.invalidateReads()
      this.#lastVerifiedAt = this.#now()
      this.#validatedUntil = this.#lastVerifiedAt + this.#validationTTL
    }).finally(() => { if (this.#loginTask === task) this.#loginTask = undefined })
    this.#loginTask = task
    return task
  }

  #requireLocalTarget(): void {
    if (!isLocalAuthorizationTarget(this.client.baseURL)) throw new HttpError(403, '免账号本机授权仅支持直连 127.0.0.1 或 ::1；远程上游必须启用鉴权', 'loopback_auth_required')
  }

  async #renewAuthorization(generation: number): Promise<void> {
    if (this.#loginTask) return this.#loginTask
    const probe = new CookieJar()
    const status = await this.client.request('/api/status', probe)
    if (status.status !== 200) throw new HttpError(502, '无法检查 9119 授权模式', 'upstream_auth_unavailable')
    const mode = JSON.parse(status.body.toString()) as Record<string, unknown>
    this.#checkGeneration(generation)
    if (this.#loginTask) return this.#loginTask
    if (!allowsLocalAuthorization(mode)) return this.#login(generation)
    this.#requireLocalTarget()
    const task = (async () => {
      const page = await this.client.request('/', probe, { maxResponseBytes: 2 * 1024 * 1024, cache: 'reload' })
      if (page.status !== 200) throw new HttpError(502, 'Hermes 本机授权入口不可用', 'local_authorization_unavailable')
      const token = localSessionToken(page.body.toString('utf8'))
      if (!token) throw new HttpError(502, 'Hermes 未提供本机会话令牌；不会降级或自动修改账号配置', 'local_authorization_unavailable')
      probe.setSessionToken(token)
      const check = await this.client.request('/api/profiles', probe, { cache: 'reload' })
      if (check.status !== 200) throw new HttpError(502, 'Hermes 本机会话令牌验证失败', 'local_authorization_rejected')
      this.#checkGeneration(generation)
      this.#jar.replace(probe); this.#localAuthorization = true
      this.#authMode = 'loopback-token'
      this.client.invalidateReads()
      this.#lastVerifiedAt = this.#now()
      this.#validatedUntil = this.#lastVerifiedAt + this.#validationTTL
    })().finally(() => { if (this.#loginTask === task) this.#loginTask = undefined })
    this.#loginTask = task
    return task
  }

  async #authenticate(credentials: UpstreamCredentials, jar: CookieJar): Promise<void> {
    const providers = await this.client.request('/api/auth/providers', jar)
    if (providers.status < 200 || providers.status >= 300) throw new HttpError(502, '无法读取 9119 登录方式', 'upstream_auth_unavailable')
    const response = await this.client.request('/auth/password-login', jar, {
      method: 'POST',
      body: { provider: 'basic', username: credentials.username, password: credentials.password, next: '' },
    })
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(503, '9119 服务账号验证失败', 'upstream_credentials_invalid')
    }
  }

  #isLoopbackUpstream(): boolean {
    const hostname = this.client.baseURL.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  }

  async #loadLoopbackToken(jar: CookieJar): Promise<boolean> {
    this.#requireLocalTarget()
    jar.setSessionToken(undefined)
    const response = await this.client.request('/', jar, {
      headers: { accept: 'text/html' },
      maxResponseBytes: 2 * 1_024 * 1_024,
      cache: 'reload',
    })
    if (response.status < 200 || response.status >= 300) return false
    const token = localSessionToken(response.body.toString('utf8'))
    if (!token) return false
    jar.setSessionToken(token)
    const check = await this.client.request('/api/profiles', jar, { cache: 'reload' })
    if (check.status !== 200) throw new HttpError(502, 'Hermes 本机会话令牌验证失败', 'local_authorization_rejected')
    return true
  }
}
