import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import Koa from 'koa'
import Router from '@koa/router'
import { bodyParser } from '@koa/bodyparser'
import send from 'koa-send'
import serve from 'koa-static'
import { z } from 'zod'
import type { ServerConfig } from '../config.js'
import { isLoopbackHost, isPrivateHost } from '../config.js'
import { errorMessage, HttpError } from '../errors.js'
import type { LocalAuthStore, LocalUser } from '../localAuth.js'
import { applySecurityHeaders, CsrfProtection, CSRF_COOKIE, isExactOrigin } from '../security.js'
import { AdminAudit, auditCsv, auditDetail } from './audit.js'
import { auditModule, CONSOLE_PREFIX, isConsoleSupportRoute, isManagementRoute } from './routes.js'
import { AdminSessionStore, AdminTwoStepStore, type ConsoleIdentity } from './sessions.js'
import { LoginThrottle } from './throttle.js'

/** Web cookies the console must neither read nor write (cookies are shared across ports on one host). */
const WEB_COOKIES = ['hermes_yaoyao_session', CSRF_COOKIE]
export const CONSOLE_CSRF_COOKIE = 'yaoyao_admin_csrf'

export interface ConsoleDependencies {
  config: ServerConfig
  auth: LocalAuthStore
  sessions: AdminSessionStore
  twoStep: AdminTwoStepStore
  audit: AdminAudit
  csrf: CsrfProtection
  throttle?: LoginThrottle
  /** Route handlers shared with the Web, mounted after the console's own gate. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes: Koa.Middleware<any, any>[]
  overview: (admin: LocalUser) => Promise<Record<string, unknown>>
  profiles: () => Promise<Array<{ name: string; label: string; isDefault: boolean }>>
  /** Wraps a request so read caches are scoped to the admin (same as the Web). */
  readScope?: (user: LocalUser, next: () => Promise<void>) => Promise<void>
  version: string
}

/** Writes that need the password again within the last 10 minutes. */
export function needsReauthentication(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  if (['GET', 'HEAD', 'OPTIONS'].includes(verb)) return false
  return /^\/api\/app\/admin\/hermes\/credentials$/.test(path)
    || /^\/api\/app\/admin\/hermes\/oauth\/[^/]+(?:\/token)?$/.test(path) && (verb === 'DELETE' || path.endsWith('/token'))
    || /^\/api\/app\/admin\/(?:legacy-)?model-services(?:\/[^/]+)?$/.test(path) && !path.endsWith('/validate')
    || /^\/api\/app\/system\/push-config(?:\/fcm)?$/.test(path)
    || /^\/api\/app\/system\/update\/(?:apply|activate|rollback)$/.test(path)
    || path === '/api/app/system/allowed-hosts'
    || /^\/api\/app\/admin\/users\/[^/]+$/.test(path) && verb === 'DELETE'
    || path === '/api/app/admin/runners' && verb === 'POST'
    || path === '/api/app/admin/desktop-hosts/pairing-codes'
}

export function ipAllowed(ip: string, allow: string[]): boolean {
  const address = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (isLoopbackHost(address)) return true
  return allow.some(entry => {
    const [base, bitsText] = entry.split('/')
    if (!bitsText) return base === address
    const family = isIP(base!)
    if (family !== isIP(address) || family === 0) return false
    const bits = Number(bitsText)
    if (family === 4) {
      const toInt = (value: string) => value.split('.').reduce((sum, part) => (sum << 8) + Number(part), 0) >>> 0
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      return (toInt(base!) & mask) === (toInt(address) & mask)
    }
    const expand = (value: string) => {
      const [head, tail = ''] = value.split('::')
      const left = head ? head.split(':') : [], right = tail ? tail.split(':') : []
      const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      return groups.map(group => parseInt(group || '0', 16).toString(2).padStart(16, '0')).join('')
    }
    return expand(base!).slice(0, bits) === expand(address).slice(0, bits)
  })
}

function consoleHostAllowed(value: string | undefined, config: ServerConfig): boolean {
  if (!value) return false
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(value.trim().toLowerCase())
  if (!match) return false
  const hostname = (match[1] ?? match[2] ?? '').replace(/\.$/, '')
  const port = match[3]
  // Explicitly allowed names may arrive through a different published port (Docker), as on the Web.
  if (config.allowedHosts.has(hostname)) return true
  if (port !== undefined && port !== String(config.admin.port)) return false
  return isPrivateHost(hostname)
}

function stripWebCookies(header: string | undefined): string {
  if (!header) return ''
  return header.split(';').map(part => part.trim()).filter(part => part && !WEB_COOKIES.includes(part.split('=')[0]!.trim())).join('; ')
}

export function createConsoleApp(deps: ConsoleDependencies): Koa {
  const { config, auth, sessions, twoStep, audit, csrf } = deps
  const throttle = deps.throttle ?? new LoginThrottle()
  const tls = Boolean(config.tlsCert)
  const app = new Koa()
  app.proxy = false

  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (error) {
      const status = error instanceof HttpError ? error.status
        : typeof (error as { status?: unknown })?.status === 'number' ? Number((error as { status: number }).status) : 500
      ctx.status = status
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = { error: status < 500 || error instanceof HttpError ? errorMessage(error) : 'Internal server error', code: error instanceof HttpError ? error.code : 'internal_error' }
      if (status >= 500 && !config.production) ctx.app.emit('error', error, ctx)
    }
  })

  // Transport: host, client address, headers, and the Web's cookies kept out of both directions.
  app.use(async (ctx, next) => {
    applySecurityHeaders(ctx, tls, config.allowedHosts)
    ctx.set('Cache-Control', 'no-store')
    if (!consoleHostAllowed(ctx.get('host'), config)) throw new HttpError(421, 'Request Host is not allowed', 'invalid_host')
    if (config.admin.external && !ipAllowed(ctx.ip, config.admin.allowIps)) throw new HttpError(403, '此地址不在管理后台的访问白名单中', 'admin_ip_not_allowed')
    ctx.request.header.cookie = stripWebCookies(ctx.request.header.cookie)
    await next()
    const cookies = ctx.response.get('Set-Cookie') as unknown as string[] | string | undefined
    const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : []
    const kept = list.filter(cookie => !WEB_COOKIES.includes(cookie.split('=')[0]!.trim()))
    if (kept.length !== list.length) { ctx.remove('Set-Cookie'); if (kept.length) ctx.set('Set-Cookie', kept) }
  })

  app.use(bodyParser({
    encoding: 'utf-8', enableTypes: ['json'], parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'], jsonLimit: '4mb',
    onError: (error, ctx) => { throw new HttpError(ctx.status === 413 || (error as { status?: number }).status === 413 ? 413 : 400, 'Invalid JSON request body', 'invalid_json_body') },
  }))

  const isApi = (path: string) => path === '/api' || path.startsWith('/api/')
  const anonymous = (method: string, path: string) =>
    (method === 'GET' && path === `${CONSOLE_PREFIX}/session`) || (method === 'POST' && path === `${CONSOLE_PREFIX}/login`)
  const enrollmentAllowed = (path: string) =>
    path === `${CONSOLE_PREFIX}/session` || path === `${CONSOLE_PREFIX}/logout` || path.startsWith(`${CONSOLE_PREFIX}/two-step`)

  // Every write on the console is recorded, successful or not.
  app.use(async (ctx, next) => {
    if (!isApi(ctx.path) || ['GET', 'HEAD', 'OPTIONS'].includes(ctx.method) || ctx.path === `${CONSOLE_PREFIX}/login`) return next()
    const record = (status: number) => {
      const identity = ctx.state.consoleIdentity as ConsoleIdentity | undefined
      try {
        audit.record({
          actor: identity?.user.username ?? '匿名', ip: ctx.ip, module: auditModule(ctx.path),
          action: `${ctx.method} ${ctx.path}`, target: ctx.path, outcome: status < 400 ? 'ok' : status === 401 || status === 403 || status === 428 ? 'denied' : 'failed',
          status, detail: auditDetail((ctx.request as Koa.Request & { body?: unknown }).body),
        })
      } catch { /* The audit log must never block the request. */ }
    }
    try {
      await next()
      record(ctx.status)
    } catch (error) {
      record(error instanceof HttpError ? error.status : 500)
      throw error
    }
  })

  // Only console routes, management routes and the few shared reads exist on this port.
  app.use(async (ctx, next) => {
    if (!isApi(ctx.path)) return next()
    const allowed = ctx.path.startsWith(`${CONSOLE_PREFIX}/`) || isManagementRoute(ctx.method, ctx.path) || isConsoleSupportRoute(ctx.method, ctx.path)
    if (!allowed) throw new HttpError(404, 'Route not found', 'not_found')
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)
    if (mutation) {
      if (!isExactOrigin(ctx.get('origin'), ctx.get('host'), tls, config.allowedHosts)) throw new HttpError(403, 'Request Origin is not allowed', 'invalid_origin')
      if (!csrf.verify(ctx.get('cookie'), ctx.get('x-csrf-token'))) throw new HttpError(403, 'CSRF token is invalid or missing', 'invalid_csrf')
    }
    if (anonymous(ctx.method, ctx.path)) return next()
    const identity = sessions.require(ctx)
    ctx.state.consoleIdentity = identity
    if (identity.session.stage === 'enroll' && !enrollmentAllowed(ctx.path))
      throw new HttpError(403, '请先完成二次验证设置', 'admin_two_step_required')
    if (identity.user.mustChangePassword && !enrollmentAllowed(ctx.path) && ctx.path !== `${CONSOLE_PREFIX}/password`)
      throw new HttpError(428, '请先修改初始密码', 'password_change_required')
    if (needsReauthentication(ctx.method, ctx.path) && identity.session.sudoUntil < sessions.now())
      throw new HttpError(428, '此操作需要再次输入管理员密码', 'admin_reauth_required')
    ctx.state.localUser = identity.user
    ctx.state.resolveLocalUser = () => sessions.current(ctx)?.user
    ctx.state.localAuth = auth
    await next()
  })

  const router = new Router({ prefix: CONSOLE_PREFIX })
  const body = (ctx: Koa.Context) => (ctx.request as Koa.Request & { body?: unknown }).body
  const twoStepRequired = () => config.admin.external
  const sessionView = (ctx: Koa.Context, identity?: ConsoleIdentity) => ({
    csrfToken: csrf.issue(ctx),
    // Same shape the Web's CSRF refresh expects, so the shared API client can renew tokens here.
    userId: identity?.user.id ?? null,
    version: deps.version,
    setupRequired: auth.setupRequired,
    external: config.admin.external,
    webPort: config.port,
    twoStepRequired: twoStepRequired(),
    ...(identity ? {
      user: { id: identity.user.id, username: identity.user.username, avatar: identity.user.avatar, mustChangePassword: identity.user.mustChangePassword },
      stage: identity.session.stage,
      expiresAt: sessions.expiresAt(identity.session),
      sudoUntil: identity.session.sudoUntil,
      twoStep: twoStep.status(identity.user.id),
    } : {}),
  })

  router.get('/session', ctx => { ctx.body = sessionView(ctx, sessions.current(ctx)) })

  router.post('/login', ctx => {
    const input = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1000), code: z.string().max(40).optional() }).safeParse(body(ctx))
    if (!input.success) throw new HttpError(400, '请填写账号和密码', 'invalid_login')
    const { username, password, code } = input.data
    throttle.assertAllowed(ctx.ip, username)
    const deny = (actor: string, reason: string, error: HttpError) => {
      const locked = throttle.fail(ctx.ip, username)
      audit.record({ actor, ip: ctx.ip, module: '后台登录', action: '登录', target: CONSOLE_PREFIX + '/login', outcome: 'denied', status: error.status, detail: reason + (locked ? '，已锁定 15 分钟' : '') })
      throw error
    }
    let verified: { user: LocalUser; authVersion: number }
    try { verified = auth.verifyCredentials(username, password) }
    catch (error) { return deny(username, '账号或密码错误', error instanceof HttpError ? error : new HttpError(401, '用户名或密码错误', 'login_failed')) }
    if (verified.user.role !== 'admin') return deny(verified.user.username, '非管理员', new HttpError(403, '此后台只允许管理员登录，普通账号请使用夭夭 Web。', 'admin_console_admin_only'))
    let stage: 'full' | 'enroll' = 'full'
    if (twoStep.enabled(verified.user.id)) {
      if (!code) throw new HttpError(401, '请输入验证器 App 上的 6 位验证码', 'admin_two_step_code_required')
      if (!twoStep.verify(verified.user.id, code)) return deny(verified.user.username, '二次验证码错误', new HttpError(401, '验证码不正确或已使用', 'admin_two_step_invalid'))
    } else if (twoStepRequired()) stage = 'enroll'
    throttle.succeed(ctx.ip, username)
    const identity = sessions.issue(ctx, verified.user, verified.authVersion, stage)
    audit.record({ actor: verified.user.username, ip: ctx.ip, module: '后台登录', action: '登录', target: CONSOLE_PREFIX + '/login', outcome: 'ok', status: 200, detail: stage === 'enroll' ? '需先设置二次验证' : '' })
    ctx.body = sessionView(ctx, identity)
  })

  router.post('/logout', ctx => { sessions.logout(ctx); ctx.body = { ok: true } })

  router.post('/sudo', ctx => {
    const identity = ctx.state.consoleIdentity as ConsoleIdentity
    const input = z.object({ password: z.string().min(1).max(1000) }).safeParse(body(ctx))
    if (!input.success || !auth.verifyPassword(identity.user.id, input.data.password)) throw new HttpError(401, '密码错误', 'invalid_current_password')
    ctx.body = { sudoUntil: sessions.grantSudo(ctx) }
  })

  router.post('/password', ctx => {
    const identity = ctx.state.consoleIdentity as ConsoleIdentity
    const input = z.object({ currentPassword: z.string().min(1).max(1000), newPassword: z.string().min(1).max(1000) }).safeParse(body(ctx))
    if (!input.success) throw new HttpError(400, '请填写当前密码和新密码', 'invalid_password_change')
    const changed = auth.changePassword(identity.user.id, input.data.currentPassword, input.data.newPassword)
    sessions.revokeUser(identity.user.id)
    sessions.issue(ctx, changed.user, changed.authVersion, identity.session.stage)
    ctx.body = { ok: true }
  })

  router.post('/two-step/begin', ctx => {
    const identity = ctx.state.consoleIdentity as ConsoleIdentity
    if (twoStep.enabled(identity.user.id) && identity.session.sudoUntil < sessions.now()) throw new HttpError(428, '此操作需要再次输入管理员密码', 'admin_reauth_required')
    ctx.body = twoStep.begin(identity.user.id, identity.user.username)
  })
  router.post('/two-step/confirm', ctx => {
    const identity = ctx.state.consoleIdentity as ConsoleIdentity
    const input = z.object({ code: z.string().min(6).max(12) }).safeParse(body(ctx))
    if (!input.success) throw new HttpError(400, '请输入 6 位验证码', 'admin_two_step_invalid')
    const recoveryCodes = twoStep.confirm(identity.user.id, input.data.code)
    if (identity.session.stage === 'enroll') sessions.complete(ctx)
    ctx.body = { recoveryCodes, twoStep: twoStep.status(identity.user.id) }
  })
  router.delete('/two-step', ctx => {
    const identity = ctx.state.consoleIdentity as ConsoleIdentity
    if (twoStepRequired()) throw new HttpError(409, '管理后台允许远程访问时，二次验证不能关闭。', 'admin_two_step_mandatory')
    if (identity.session.sudoUntil < sessions.now()) throw new HttpError(428, '此操作需要再次输入管理员密码', 'admin_reauth_required')
    twoStep.disable(identity.user.id)
    ctx.body = { twoStep: twoStep.status(identity.user.id) }
  })

  router.get('/overview', async ctx => {
    const identity = ctx.state.consoleIdentity as ConsoleIdentity
    ctx.body = { ...(await deps.overview(identity.user)), recentAudit: audit.list({ limit: 8 }) }
  })
  router.get('/profiles', async ctx => { ctx.body = { profiles: await deps.profiles() } })

  const auditQuery = (ctx: Koa.Context) => {
    const text = (key: string) => typeof ctx.query[key] === 'string' && ctx.query[key] ? String(ctx.query[key]) : undefined
    const number = (key: string) => { const value = Number(ctx.query[key]); return Number.isFinite(value) && value > 0 ? value : undefined }
    return { module: text('module'), actor: text('actor'), outcome: text('outcome'), since: number('since'), until: number('until'), before: number('before') }
  }
  router.get('/audit', ctx => { ctx.body = { entries: audit.list({ ...auditQuery(ctx), limit: Number(ctx.query.limit) || 100 }), modules: audit.modules() } })
  router.get('/audit.csv', ctx => {
    const rows = audit.list({ ...auditQuery(ctx), limit: 5000 })
    ctx.set('Content-Disposition', `attachment; filename="yaoyao-audit-${new Date().toISOString().slice(0, 10)}.csv"`)
    ctx.type = 'text/csv; charset=utf-8'
    ctx.body = auditCsv(rows)
  })

  app.use(router.routes())
  app.use(router.allowedMethods())

  app.use(async (ctx, next) => {
    const user = ctx.state.localUser as LocalUser | undefined
    if (user && deps.readScope && isApi(ctx.path)) return deps.readScope(user, next)
    return next()
  })
  for (const middleware of deps.routes) app.use(middleware)

  app.use(async (ctx, next) => {
    if (isApi(ctx.path)) throw new HttpError(404, 'Route not found', 'not_found')
    await next()
  })
  return app
}

/** Built console pages (`dist/admin`), with SPA fallback to admin.html. */
export function serveConsoleStatic(app: Koa, root: string): void {
  const dir = resolve(root)
  app.use(serve(dir, { index: 'admin.html' }))
  app.use(async ctx => {
    if (ctx.method !== 'GET' || !ctx.accepts('html') || !existsSync(resolve(dir, 'admin.html'))) {
      ctx.status = 404
      return
    }
    await send(ctx, 'admin.html', { root: dir })
  })
}
