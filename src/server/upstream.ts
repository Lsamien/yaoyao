import type Koa from 'koa'
import { createHash } from 'node:crypto'
import { readCacheContext, readPolicy, mutationTags, UpstreamReadCache } from './upstreamReadCache.js'
import { isLocalAuthorizationTarget, LoopbackTransport } from './loopbackAuthorization.js'
import { parse } from 'cookie'
import { HttpError } from './errors.js'
import { appendSetCookies, CSRF_COOKIE } from './security.js'

const RESPONSE_HEADER_ALLOWLIST = [
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const

function headerSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const combined = headers.get('set-cookie')
  if (!combined) return []
  // This fallback is only for fetch shims without getSetCookie. It avoids
  // splitting the comma in an Expires attribute.
  return combined.split(/,(?=\s*[^;,\s]+=)/g).map((value) => value.trim())
}

function cookiePair(value: string): [string, string] | null {
  const pair = value.split(';', 1)[0]?.trim()
  const separator = pair?.indexOf('=') ?? -1
  if (!pair || separator <= 0) return null
  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1).trim()
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return null
  return [name, cookieValue]
}

function browserCookie(value: string, publicSecure: boolean): string | null {
  const pair = cookiePair(value)
  if (!pair || pair[0] === CSRF_COOKIE) return null
  const attributes = value.split(';').slice(1).map((part) => part.trim())
  const kept = attributes.filter((attribute) => {
    const name = attribute.split('=', 1)[0]?.toLowerCase()
    return name !== 'domain' && name !== 'path' && name !== 'secure'
  })
  return [`${pair[0]}=${pair[1]}`, 'Path=/', ...kept, ...(publicSecure ? ['Secure'] : [])].join('; ')
}

export class CookieJar {
  readonly #values = new Map<string, string>()
  readonly #browserCookies = new Map<string, string>()
  #sessionToken: string | undefined

  constructor(cookieHeader?: string) {
    for (const [name, value] of Object.entries(parse(cookieHeader ?? ''))) {
      if (name !== CSRF_COOKIE && value !== undefined) this.#values.set(name, value)
    }
  }

  absorb(headers: Headers, publicSecure = false): void {
    for (const raw of headerSetCookies(headers)) {
      const pair = cookiePair(raw)
      const sanitized = browserCookie(raw, publicSecure)
      if (!pair || !sanitized) continue
      const [name, value] = pair
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(raw)) this.#values.delete(name)
      else this.#values.set(name, value)
      this.#browserCookies.set(name, sanitized)
    }
  }

  get header(): string | undefined {
    if (this.#values.size === 0) return undefined
    return [...this.#values.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get sessionToken(): string | undefined { return this.#sessionToken }

  setSessionToken(value: string | undefined): void {
    this.#sessionToken = value
  }

  replace(other: CookieJar): void {
    this.#values.clear(); this.#browserCookies.clear()
    for (const [name, value] of other.#values) this.#values.set(name, value)
    this.#sessionToken = other.#sessionToken
  }

  get browserCookies(): string[] {
    return [...this.#browserCookies.values()]
  }
}

export interface UpstreamResponse {
  status: number
  headers: Headers
  body: Buffer
}

export class UpstreamHttpError extends HttpError {
  constructor(readonly response: UpstreamResponse) {
    super(response.status, `Hermes returned HTTP ${response.status}`, 'upstream_http_error')
  }
}

export interface UpstreamRequestOptions {
  cache?: 'reload'
  method?: string
  search?: URLSearchParams
  body?: unknown
  rawBody?: BodyInit
  headers?: Record<string, string>
  maxResponseBytes?: number
  clientAddress?: string
}

export class UpstreamClient {
  readonly readCache: UpstreamReadCache
  private loopback = new LoopbackTransport()
  private reauthentication = new WeakMap<CookieJar, () => Promise<void>>()
  constructor(
    readonly baseURL: URL,
    readonly fetchImpl: typeof fetch = fetch,
    readonly publicSecure = false,
    now: () => number = Date.now,
  ) { this.readCache = new UpstreamReadCache(now) }
  get directAgent() { return isLocalAuthorizationTarget(this.baseURL) ? this.loopback.agent(this.baseURL) : undefined }
  close(): void { this.readCache.close(); this.loopback.close() }

  withReadScope<T>(scope: string, fresh: boolean, run: () => T): T {
    return readCacheContext.run({ scope, fresh }, run)
  }
  invalidateReads(tags?: readonly string[]): void { this.readCache.invalidate(tags) }
  observeRealtime(change: { kind: 'command' | 'event' | 'group' | 'reset'; name: string; sessionId?: string; roomId?: string }): void {
    if (change.kind === 'reset') { this.invalidateReads(['sessions', 'groups', 'profiles', 'models']); return }
    if (change.kind === 'group') {
      if (change.name === 'group.heartbeat' || change.name === 'group.ready') return
      this.invalidateReads(change.roomId ? ['group-list', `group:${change.roomId}`] : ['groups'])
      return
    }
    if (/^(profiles\.(configure|set_asset|changed)|pet\.changed|models\.changed|model\.)/.test(change.name)) {
      this.invalidateReads(['profiles', 'models']); return
    }
    if (change.name === 'sessions.changed') { this.invalidateReads(['sessions']); return }
    if (change.kind === 'command' && !/^(prompt\.submit|session\.(create|resume|branch|close|steer|interrupt)|config\.set|approval\.respond|clarify\.respond)$/.test(change.name)) return
    if (change.kind === 'event' && !/^(message\.|session\.|config\.|compression\.|run\.|error$)/.test(change.name)) return
    const tags = change.sessionId ? [`session:${change.sessionId}`] : ['sessions']
    if (change.kind === 'command' || !/\.delta$/.test(change.name)) tags.push('session-list')
    if (change.name === 'config.set') tags.push('models', 'profiles')
    this.invalidateReads(tags)
  }
  setReauthenticationHandler(jar: CookieJar, renew: () => Promise<void>): void { this.reauthentication.set(jar, renew) }

  async request(path: string, jar: CookieJar, options: UpstreamRequestOptions = {}): Promise<UpstreamResponse> {
    const method = options.method ?? 'GET'
    const tags = ['GET', 'HEAD'].includes(method) ? undefined : mutationTags(path)
    if (tags) this.invalidateReads(tags)
    const context = readCacheContext.getStore()
    const forcedTags = method === 'GET' && (context?.fresh || options.cache === 'reload') ? readPolicy(path, options.search)?.tags : undefined
    if (forcedTags) this.invalidateReads(forcedTags)
    const load = async () => {
      const sentCredentials = JSON.stringify([jar.header, jar.sessionToken])
      let response = await this.fetchResponse(path, jar, options)
      if (response.status === 401 || response.status === 403) this.invalidateReads()
      const renew = this.reauthentication.get(jar)
      if (response.status === 401 && renew && !path.startsWith('/api/auth/') && !path.startsWith('/auth/')) {
        // A parallel request may already have rotated the service cookies. Never replay
        // a whole route handler (it may have performed several writes); repair this one 401 only.
        if (JSON.stringify([jar.header, jar.sessionToken]) === sentCredentials) await renew()
        response = await this.fetchResponse(path, jar, options)
      }
      return response
    }
    try {
      const headers = new Headers(options.headers)
      const policy = method === 'GET' && context && !context.fresh && options.cache !== 'reload'
        && !['range', 'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since'].some(name => headers.has(name))
        ? readPolicy(path, options.search) : undefined
      let response: UpstreamResponse
      if (policy && context) {
        const search = new URLSearchParams(options.search); search.sort()
        const key = createHash('sha256').update(JSON.stringify([
          context.scope, this.baseURL.href, path, search.toString(), jar.header ?? '', jar.sessionToken ?? '',
          [...headers.entries()].sort(([a], [b]) => a.localeCompare(b)), options.clientAddress ?? '', options.maxResponseBytes ?? null,
        ])).digest('hex')
        response = await this.readCache.read(key, policy, load)
      } else response = await load()
      // Snapshot-after-anchor ordering: no room snapshot fetched before this fresh
      // journal cursor may be reused to bootstrap a stream starting at that cursor.
      return response
    } finally {
      if (tags) this.invalidateReads(tags)
      if (forcedTags) this.invalidateReads(forcedTags)
    }
  }

  private async fetchResponse(
    path: string,
    jar: CookieJar,
    options: UpstreamRequestOptions = {},
  ): Promise<UpstreamResponse> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      throw new HttpError(500, 'Invalid internal upstream path')
    }
    const url = new URL(this.baseURL)
    const prefix = this.baseURL.pathname === '/' ? '' : this.baseURL.pathname.replace(/\/$/, '')
    const expectedPath = `${prefix}${path}`
    url.pathname = expectedPath
    if (url.pathname !== expectedPath) {
      throw new HttpError(500, 'Upstream path normalization escaped its allowlisted route')
    }
    url.search = options.search?.toString() ?? ''
    url.hash = ''

    const headers = new Headers({
      accept: 'application/json',
      origin: this.baseURL.origin,
      'x-forwarded-host': this.baseURL.host,
      'x-forwarded-proto': this.publicSecure ? 'https' : 'http',
      ...options.headers,
    })
    if (options.clientAddress) {
      const clientAddress = options.clientAddress.replace(/^::ffff:/, '')
      if (/^[0-9a-f:.]+$/i.test(clientAddress)) headers.set('x-forwarded-for', clientAddress)
    }
    if (jar.header) headers.set('cookie', jar.header)
    if (jar.sessionToken) {
      if (!isLocalAuthorizationTarget(this.baseURL)) throw new HttpError(403, 'Local authorization cannot be sent to a remote upstream', 'loopback_auth_required')
      headers.set('X-Hermes-Session-Token', jar.sessionToken)
    }
    let body: BodyInit | undefined
    if (options.rawBody !== undefined) {
      body = options.rawBody
    } else if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(options.body)
    }

    let response: Response
    let timeout: ReturnType<typeof setTimeout> | undefined
    const requestTimeout = path === '/api/plugins/yaoyao-bot-bridge/memory-extract' && options.method === 'POST' ? 110_000 : 30_000
    const controller = new AbortController()
    try {
      response = await Promise.race([
        (isLocalAuthorizationTarget(url) && this.fetchImpl === globalThis.fetch ? this.loopback.fetch.bind(this.loopback) : this.fetchImpl)(url, {
          method: options.method ?? 'GET',
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new Error('request timed out')) }, requestTimeout)
          timeout.unref()
        }),
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'connection failed'
      throw new HttpError(502, `Unable to reach Hermes: ${message}`, 'upstream_unavailable')
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    jar.absorb(response.headers, this.publicSecure)
    const declaredLength = Number(response.headers.get('content-length') ?? '0')
    const limit = options.maxResponseBytes ?? 64 * 1_024 * 1_024
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
      await response.body?.cancel()
      throw new HttpError(502, 'Hermes response exceeded the configured limit', 'upstream_too_large')
    }
    // Enforce limits while reading, including chunked native-token pages without
    // Content-Length. Do not buffer an unbounded response before checking it.
    const chunks: Buffer[] = []
    let bytes = 0
    const reader = response.body?.getReader()
    if (reader) {
      let bodyTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          bodyTimeout = setTimeout(() => {
            reject(new HttpError(502, 'Hermes response timed out', 'upstream_unavailable'))
            void reader.cancel().catch(() => {})
          }, 30_000)
          bodyTimeout.unref()
        })
        while (true) {
          const part = await Promise.race([reader.read(), expired])
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > limit) {
            void reader.cancel().catch(() => {})
            throw new HttpError(502, 'Hermes response exceeded the configured limit', 'upstream_too_large')
          }
          chunks.push(Buffer.from(part.value))
        }
      } finally { if (bodyTimeout) clearTimeout(bodyTimeout); reader.releaseLock() }
    }
    const bodyBuffer = Buffer.concat(chunks, bytes)
    return { status: response.status, headers: response.headers, body: bodyBuffer }
  }

  async json<T>(
    path: string,
    jar: CookieJar,
    options: UpstreamRequestOptions = {},
  ): Promise<T> {
    const response = await this.request(path, jar, options)
    if (response.status < 200 || response.status >= 300) throw new UpstreamHttpError(response)
    try {
      return JSON.parse(response.body.toString('utf8')) as T
    } catch {
      throw new HttpError(502, 'Hermes returned invalid JSON', 'invalid_upstream_json')
    }
  }
}

export function applyUpstreamCookies(ctx: Koa.Context, jar: CookieJar): void {
  appendSetCookies(ctx, jar.browserCookies)
}

export function sendUpstreamResponse(
  ctx: Koa.Context,
  response: UpstreamResponse,
  _jar: CookieJar,
): void {
  ctx.status = response.status
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name)
    if (value) ctx.set(name, value)
  }
  ctx.body = response.status === 204 || ctx.method === 'HEAD' ? null : response.body
}

export function decodeUpstreamError(response: UpstreamResponse): { error: string; code: string } {
  try {
    const value = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>
    const message = typeof value.error === 'string'
      ? value.error
      : typeof value.message === 'string' ? value.message : `Hermes returned HTTP ${response.status}`
    return { error: message, code: 'upstream_rejected' }
  } catch {
    return { error: `Hermes returned HTTP ${response.status}`, code: 'upstream_rejected' }
  }
}
