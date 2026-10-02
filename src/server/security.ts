import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type Koa from 'koa'
import { parse, serialize } from 'cookie'
import type { ServerConfig } from './config.js'
import { isLoopbackHost, isPrivateHost } from './config.js'
import { BOT_LOGO_ORIGINS } from '../shared/botProviderLogos.js'

export const CSRF_COOKIE = 'hermes_yaoyao_csrf'

function splitHostPort(value: string): { hostname: string; port?: string } | null {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || /[\s/@\\]/.test(trimmed)) return null
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return null
    const hostname = trimmed.slice(1, end)
    const suffix = trimmed.slice(end + 1)
    if (suffix && !/^:\d{1,5}$/.test(suffix)) return null
    return { hostname, port: suffix ? suffix.slice(1) : undefined }
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length
  if (colonCount > 1) return { hostname: trimmed }
  const [hostname, port] = trimmed.split(':')
  if (!hostname || (port && !/^\d{1,5}$/.test(port))) return null
  return { hostname: hostname.replace(/\.$/, ''), port }
}

export function isAllowedHostHeader(value: string | undefined, config: ServerConfig): boolean {
  if (!value) return false
  const parsed = splitHostPort(value)
  if (!parsed) return false
  if (config.allowedHosts.has(parsed.hostname)) return true
  if (!isPrivateHost(parsed.hostname)) return false
  return parsed.port === String(config.port) || parsed.port === undefined || parsed.port === '80' || parsed.port === '443'
}

function canonicalOrigin(origin: string): string | null {
  try {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (url.pathname !== '/' || url.search || url.hash) return null
    return `${url.protocol}//${url.host.toLowerCase()}`
  } catch {
    return null
  }
}

export function expectedRequestOrigin(host: string, secure: boolean): string | null {
  if (!splitHostPort(host)) return null
  return `${secure ? 'https' : 'http'}://${host.toLowerCase()}`
}

export function isExactOrigin(
  origin: string | undefined,
  host: string | undefined,
  secure: boolean,
  allowedHosts: ReadonlySet<string> = new Set(),
): boolean {
  if (!origin || !host) return false
  const expected = expectedRequestOrigin(host, secure)
  const actual = canonicalOrigin(origin)
  if (expected === null || actual === null) return false
  if (actual === expected) return true
  // A TLS-terminating reverse proxy forwards HTTP internally while the
  // browser's same-origin request correctly carries an https Origin.
  if (!secure && actual === expectedRequestOrigin(host, true)) return true
  try {
    return allowedHosts.has(new URL(actual).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''))
  } catch {
    return false
  }
}

export function acceptedRequestOrigin(
  origin: string | undefined,
  host: string | undefined,
  secure: boolean,
  allowedHosts: ReadonlySet<string>,
): string | null {
  if (!isExactOrigin(origin, host, secure, allowedHosts)) return null
  return canonicalOrigin(origin!)
}

export function appendSetCookies(ctx: Koa.Context, values: readonly string[]): void {
  if (values.length === 0) return
  const existing = ctx.response.headers['set-cookie']
  const current = Array.isArray(existing) ? existing : existing ? [String(existing)] : []
  ctx.set('Set-Cookie', [...current, ...values])
}

export class CsrfProtection {
  readonly #secret: Buffer
  readonly #secure: boolean

  constructor(secret: Buffer = randomBytes(32), secure = false) {
    this.#secret = secret
    this.#secure = secure
  }

  issue(ctx: Koa.Context, rotate = false): string {
    const currentCookie = typeof ctx.get === 'function' ? ctx.get('cookie') : undefined
    if (!rotate) {
      const current = this.#read(currentCookie)
      if (current) return current
    }
    const token = randomBytes(24).toString('base64url')
    const signed = `${token}.${this.#sign(token)}`
    appendSetCookies(ctx, [serialize(CSRF_COOKIE, signed, {
      httpOnly: true,
      secure: this.#secure,
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 8,
    })])
    return token
  }

  verify(cookieHeader: string | undefined, headerToken: string | undefined): boolean {
    if (!headerToken || headerToken.length > 256) return false
    const token = this.#read(cookieHeader)
    if (!token || token !== headerToken) return false
    return true
  }

  #read(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined
    const signed = parse(cookieHeader)[CSRF_COOKIE]
    if (!signed) return undefined
    const separator = signed.lastIndexOf('.')
    if (separator <= 0) return undefined
    const token = signed.slice(0, separator)
    const signature = signed.slice(separator + 1)
    const expected = this.#sign(token)
    const actualBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expected)
    if (actualBuffer.length !== expectedBuffer.length
      || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined
    return token
  }

  clear(ctx: Koa.Context): void {
    appendSetCookies(ctx, [serialize(CSRF_COOKIE, '', {
      httpOnly: true,
      secure: this.#secure,
      sameSite: 'strict',
      path: '/',
      maxAge: 0,
    })])
  }

  #sign(token: string): string {
    return createHmac('sha256', this.#secret).update(token).digest('base64url')
  }
}

export function accountKeyFromCookieHeader(cookieHeader: string | undefined, fallback = ''): string {
  const cookies = parse(cookieHeader ?? '')
  delete cookies[CSRF_COOKIE]
  const stable = Object.entries(cookies)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join(';')
  return createHmac('sha256', 'hermes-yaoyao-account-scope')
    .update(stable || `anonymous:${fallback}`)
    .digest('base64url')
}

export function requestAccountKey(request: IncomingMessage): string {
  return accountKeyFromCookieHeader(request.headers.cookie, request.socket.remoteAddress)
}

export function applySecurityHeaders(ctx: Koa.Context, tls: boolean, allowedHosts: ReadonlySet<string> = new Set()): void {
  const socketOrigin = `${tls ? 'wss' : 'ws'}://${ctx.host}`
  const proxySocketOrigins = [...allowedHosts].flatMap(host => {
    const authority = host.includes(':') ? `[${host}]` : host
    return [`ws://${authority}`, `wss://${authority}`]
  })
  ctx.set('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${BOT_LOGO_ORIGINS.join(' ')}`,
    "media-src 'self' blob:",
    `connect-src 'self' ${socketOrigin} ${proxySocketOrigins.join(' ')}`.trim(),
  ].join('; '))
  const requestHostname = splitHostPort(ctx.host)?.hostname ?? ''
  if (tls || isLoopbackHost(requestHostname)) {
    ctx.set('Cross-Origin-Opener-Policy', 'same-origin')
  }
  ctx.set('Referrer-Policy', 'no-referrer')
  ctx.set('X-Content-Type-Options', 'nosniff')
  ctx.set('X-Frame-Options', 'DENY')
  ctx.set('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()')
  if (tls) ctx.set('Strict-Transport-Security', 'max-age=31536000')
}
