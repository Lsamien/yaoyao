import type Koa from 'koa'
import type Router from '@koa/router'
import { HttpError } from './errors.js'
import type { EmbeddedHermes } from './hermes/embedded.js'
import type { HermesScope } from './hermes/service.js'

/**
 * Admin pages that replace the old Hermes Dashboard (9119): provider keys, account logins and
 * auxiliary models. Everything is answered by the embedded `hermes_service.py` of the selected
 * Profile home; nothing here reaches another process over the network.
 */
export interface HermesAdminDependencies {
  auth: { requireAdmin(ctx: Koa.Context): unknown }
  hermes?: EmbeddedHermes
}

const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TASK = /^(?:__reset__|[a-z0-9][a-z0-9_.-]{0,63})$/
const SESSION = /^[A-Za-z0-9_-]{1,256}$/
/** Messaging-channel credentials belong to channel integrations Yaoyao does not ship. */
const HIDDEN_CATEGORIES = new Set(['messaging'])

function input(ctx: Koa.Context): Record<string, unknown> {
  const value = (ctx.request as Koa.Request & { body?: unknown }).body
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, field: string, pattern?: RegExp, max = 256): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > max || (pattern && !pattern.test(result))) throw new HttpError(400, `${field} 无效`, 'invalid_hermes_setting')
  return result
}

function scopeOf(raw: unknown): HermesScope {
  const profile = typeof raw === 'string' && raw.trim() ? raw.trim() : 'default'
  if (profile === 'default') return 'system'
  if (!PROFILE.test(profile)) throw new HttpError(400, 'Profile 名称无效', 'invalid_profile')
  return { profile }
}

export function registerHermesAdminRoutes(router: Router, dependencies: HermesAdminDependencies): void {
  const call = async <T = unknown>(ctx: Koa.Context, profile: unknown, op: string, args: Record<string, unknown> = {}, options: { timeoutMs?: number; hold?: boolean } = {}): Promise<T> => {
    dependencies.auth.requireAdmin(ctx)
    const hermes = dependencies.hermes
    if (!hermes) throw new HttpError(503, '内置 Hermes 尚未就绪', 'hermes_unavailable')
    return hermes.pool.call<T>(scopeOf(profile), op, args, { timeoutMs: options.timeoutMs ?? 60_000, ...(options.hold ? { hold: true } : {}) })
  }
  const profileQuery = (ctx: Koa.Context) => ctx.query.profile

  router.get('/api/app/admin/hermes/credentials', async (ctx) => {
    const rows = await call<Record<string, Record<string, unknown>>>(ctx, profileQuery(ctx), 'env.list')
    const variables = Object.entries(rows ?? {})
      .filter(([, row]) => !row.channel_managed && !HIDDEN_CATEGORIES.has(String(row.category ?? '')))
      .map(([key, row]) => ({
        key,
        isSet: row.is_set === true,
        preview: typeof row.redacted_value === 'string' ? row.redacted_value : null,
        description: typeof row.description === 'string' ? row.description : '',
        url: typeof row.url === 'string' ? row.url : null,
        category: typeof row.category === 'string' && row.category ? row.category : 'custom',
        secret: row.is_password === true,
        // Hermes flags most provider keys as advanced; the provider's own main key is what people need.
        advanced: row.advanced === true && row.provider_primary !== true,
        provider: typeof row.provider === 'string' ? row.provider : '',
        providerLabel: typeof row.provider_label === 'string' ? row.provider_label : '',
        custom: row.custom === true,
        readonly: row.readonly === true,
      }))
    ctx.body = { variables }
  })
  router.put('/api/app/admin/hermes/credentials', async (ctx) => {
    const request = input(ctx)
    const key = text(request.key, '变量名', ENV_KEY)
    if (typeof request.value !== 'string' || !request.value.trim() || request.value.length > 16_384) throw new HttpError(400, '请填写变量值', 'invalid_hermes_setting')
    await call(ctx, request.profile, 'env.set', { key, value: request.value.trim() })
    ctx.body = { ok: true }
  })
  router.delete('/api/app/admin/hermes/credentials', async (ctx) => {
    const request = input(ctx)
    await call(ctx, request.profile, 'env.delete', { key: text(request.key, '变量名', ENV_KEY) })
    ctx.body = { ok: true }
  })

  /** Auxiliary slots plus every Hermes provider, so a slot can be pinned even before its model list loads. */
  const auxiliary = async (ctx: Koa.Context, profile: unknown) => {
    const [value, catalog] = await Promise.all([
      call<Record<string, unknown>>(ctx, profile, 'model.auxiliary'),
      call<{ providers?: Array<{ id?: unknown; label?: unknown }> }>(ctx, profile, 'providers.catalog').catch(() => ({ providers: [] })),
    ])
    const providers = (catalog.providers ?? []).flatMap(item => typeof item.id === 'string' && item.id ? [{ id: item.id, label: typeof item.label === 'string' && item.label ? item.label : item.id }] : [])
    return { ...value, providers }
  }
  router.get('/api/app/admin/hermes/auxiliary', async (ctx) => {
    ctx.body = await auxiliary(ctx, profileQuery(ctx))
  })
  router.put('/api/app/admin/hermes/auxiliary', async (ctx) => {
    const request = input(ctx)
    const task = typeof request.task === 'string' ? request.task.trim() : ''
    if (task && !TASK.test(task)) throw new HttpError(400, '辅助任务无效', 'invalid_hermes_setting')
    const provider = task === '__reset__' ? 'auto' : text(request.provider, 'Provider', PROVIDER)
    const model = task === '__reset__' || provider === 'auto' ? '' : text(request.model, '模型', undefined, 256)
    await call(ctx, request.profile, 'model.set', { scope: 'auxiliary', task, provider, model })
    ctx.body = await auxiliary(ctx, request.profile)
  })

  router.get('/api/app/admin/hermes/oauth', async (ctx) => {
    ctx.body = await call(ctx, profileQuery(ctx), 'oauth.list')
  })
  router.post('/api/app/admin/hermes/oauth/:provider/start', async (ctx) => {
    const provider = text(ctx.params.provider, 'Provider', PROVIDER)
    ctx.body = await call(ctx, input(ctx).profile, 'oauth.start', { provider }, { timeoutMs: 60_000, hold: true })
  })
  router.post('/api/app/admin/hermes/oauth/:provider/poll', async (ctx) => {
    const request = input(ctx)
    ctx.body = await call(ctx, request.profile, 'oauth.poll', { provider: text(ctx.params.provider, 'Provider', PROVIDER), sessionId: text(request.sessionId, '登录会话', SESSION) })
  })
  router.post('/api/app/admin/hermes/oauth/:provider/cancel', async (ctx) => {
    const request = input(ctx)
    ctx.body = await call(ctx, request.profile, 'oauth.cancel', { provider: text(ctx.params.provider, 'Provider', PROVIDER), sessionId: text(request.sessionId, '登录会话', SESSION) })
  })
  router.post('/api/app/admin/hermes/oauth/:provider/token', async (ctx) => {
    const request = input(ctx)
    if (typeof request.token !== 'string' || !request.token.trim() || request.token.length > 16_384) throw new HttpError(400, '请粘贴凭据', 'invalid_hermes_setting')
    ctx.body = await call(ctx, request.profile, 'oauth.submit', { provider: text(ctx.params.provider, 'Provider', PROVIDER), token: request.token.trim() })
  })
  router.delete('/api/app/admin/hermes/oauth/:provider', async (ctx) => {
    ctx.body = await call(ctx, input(ctx).profile, 'oauth.disconnect', { provider: text(ctx.params.provider, 'Provider', PROVIDER) }) ?? { ok: true }
  })
}
