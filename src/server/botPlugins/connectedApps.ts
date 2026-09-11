import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import type { WorkspaceStore } from '../workspaceStore.js'
import type { WorkspaceNodes } from '../workspaceGateway.js'
import { HttpError } from '../errors.js'
import type { BotAppCard, BotAppConnection, BotPluginSettings } from '../../shared/workspacePlugins.js'

const API = 'https://backend.composio.dev/api/v3.1'
const CATALOG_API = 'https://backend.composio.dev/api/v3'
export const appSlug = z.string().regex(/^[a-z][a-z0-9_-]{0,80}$/)
const sessionSchema = z.object({ session_id: z.string().min(1), mcp: z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }), config: z.object({ user_id: z.string().optional() }).passthrough().optional() }).passthrough()
type Session = z.infer<typeof sessionSchema>
interface Configuration { owner: string; key: string; userId: string; revision: number; session?: Session; authConfigs: Record<string, string> }
export const CURATED_APPS: BotAppCard[] = [
  ['gmail', 'Gmail', '邮件与草稿'], ['googledrive', 'Google Drive', '云端文件'], ['googlecalendar', 'Google Calendar', '日历与日程'],
  ['github', 'GitHub', '代码仓库与议题'], ['notion', 'Notion', '文档与知识库'], ['slack', 'Slack', '团队沟通'],
  ['linear', 'Linear', '项目与任务'], ['discord', 'Discord', '社区消息'], ['outlook', 'Outlook', '邮件与日历'],
  ['trello', 'Trello', '看板与任务'], ['airtable', 'Airtable', '表格与业务数据'], ['twitter', 'X', '社交内容'],
].map(([slug, name, description]) => ({ slug: slug!, name: name!, description: description! }))

function trustedUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new HttpError(502, '应用连接服务返回的地址无效', 'plugin_untrusted_url') }
  if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'composio.dev' || url.hostname.endsWith('.composio.dev'))) throw new HttpError(502, '应用连接服务返回的地址无效', 'plugin_untrusted_url')
  return url.href
}

/** Account-owned Composio sessions. Keys, session URLs and remote credentials
 * remain on the Web server, separate from ordinary Hermes configuration. */
export class ConnectedApps {
  private catalogCache = new Map<string, { at: number; cards: BotAppCard[] }>()
  private sessions = new Map<string, Promise<Session>>()
  constructor(readonly store: WorkspaceStore, readonly nodes: WorkspaceNodes, readonly fetchImpl: typeof fetch, readonly assertOwner: (owner: string) => void, readonly invalidate: (owner: string) => void) {}
  read(owner: string): Configuration | undefined {
    const record = this.store.get<{ sealed: string }>(owner, 'bot-plugin-settings', 'apps')
    if (!record) return undefined
    const value = this.nodes.open<Configuration>(record.sealed)
    if (value.owner !== owner) throw new HttpError(403, '应用配置不属于当前账号', 'plugin_forbidden')
    return value
  }
  status(owner: string): BotPluginSettings { const value = this.read(owner); return { configured: !!value?.key, revision: value?.revision ?? 0 } }
  private current(owner: string, revision: number) {
    this.assertOwner(owner)
    if (this.status(owner).revision !== revision) throw new HttpError(409, '应用配置已变化，请刷新后重试', 'plugin_configuration_changed')
  }
  private async request(key: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal, base = API): Promise<any> {
    const response = await this.fetchImpl(base + path, { method, redirect: 'error', headers: { 'x-api-key': key, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) })
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, `应用连接服务请求失败（HTTP ${response.status}），请检查 API Key 和项目权限`, 'connected_apps_unavailable') }
    if (response.status === 204) return {}
    const reader = response.body?.getReader(); if (!reader) return {}
    const chunks: Uint8Array[] = []; let size = 0
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 8 * 1024 * 1024) throw new HttpError(502, '应用连接服务响应过大', 'plugin_response_limit'); chunks.push(next.value) } }
    finally { await reader.cancel().catch(() => {}) }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { throw new HttpError(502, '应用连接服务响应格式无效', 'plugin_invalid_response') }
  }
  private async createSession(config: Configuration, slugs?: string[], signal?: AbortSignal): Promise<Session> {
    const raw = await this.request(config.key, '/tool_router/session', {
      user_id: config.userId, ...(slugs ? { toolkits: { enable: slugs } } : {}), auth_configs: config.authConfigs,
      manage_connections: { enable: !slugs, enable_wait_for_connections: false, enable_connection_removal: false },
      multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true },
    }, 'POST', signal)
    const session = sessionSchema.safeParse(raw)
    if (!session.success || (session.data.config?.user_id && session.data.config.user_id !== config.userId)) throw new HttpError(502, '应用连接会话身份无效', 'plugin_invalid_response')
    session.data.mcp.url = trustedUrl(session.data.mcp.url)
    return session.data
  }
  async configure(owner: string, key: string, revision: number, authConfigs: Record<string, string>) {
    this.current(owner, revision)
    const old = this.read(owner)
    const value: Configuration = { owner, key, revision: revision + 1, userId: old?.userId ?? `yaoyao_${randomUUID()}`, authConfigs }
    if (key) value.session = await this.createSession(value)
    this.current(owner, revision)
    this.store.put(owner, 'bot-plugin-settings', 'apps', { sealed: this.nodes.seal(value) })
    this.catalogCache.delete(owner); this.invalidate(owner)
    return this.status(owner)
  }
  private require(owner: string) { const value = this.read(owner); if (!value?.key) throw new HttpError(409, '请先在已连接应用中配置 Composio API Key', 'connected_apps_unconfigured'); return value }
  async catalog(owner: string): Promise<{ cards: BotAppCard[]; source: 'api' | 'curated' }> {
    const value = this.read(owner), cache = this.catalogCache.get(owner)
    if (cache && Date.now() - cache.at < 600_000) return { cards: cache.cards, source: 'api' }
    if (value?.key) try {
      const items = await this.pages(value.key, '/toolkits', { limit: '500', sort_by: 'usage' }, undefined, CATALOG_API)
      this.current(owner, value.revision)
      const cards = items.filter(item => appSlug.safeParse(item.slug).success).map(item => ({ slug: item.slug, name: String(item.name ?? item.slug).slice(0, 100), description: String(item.meta?.description ?? item.description ?? '').slice(0, 180) }))
      if (cards.length) { this.catalogCache.set(owner, { at: Date.now(), cards }); return { cards, source: 'api' } }
    } catch { /* Catalog fallback never claims that account inventory is empty. */ }
    return { cards: CURATED_APPS, source: 'curated' }
  }
  private async pages(key: string, path: string, params: Record<string, string>, signal?: AbortSignal, base = API): Promise<any[]> {
    const items: any[] = [], cursors = new Set<string>(); let cursor = ''
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ ...params, ...(cursor ? { cursor } : {}) })
      const result = await this.request(key, path + '?' + query, undefined, 'GET', signal, base)
      if (!Array.isArray(result.items)) throw new HttpError(502, '应用列表响应格式无效', 'plugin_invalid_response')
      items.push(...result.items)
      if (!result.next_cursor) return items
      if (typeof result.next_cursor !== 'string' || cursors.has(result.next_cursor)) break
      cursor = result.next_cursor; cursors.add(cursor)
    }
    throw new HttpError(502, '应用列表尚未完整读取，请重试', 'plugin_inventory_incomplete')
  }
  async inventory(owner: string): Promise<BotAppConnection[]> {
    const config = this.require(owner)
    const accounts = await this.pages(config.key, '/connected_accounts', { user_ids: config.userId, limit: '100' })
    this.current(owner, config.revision)
    const groups = new Map<string, BotAppConnection>()
    for (const account of accounts) {
      const slug = String(account.toolkit?.slug ?? '').toLowerCase()
      if (!appSlug.safeParse(slug).success || !/^[A-Za-z0-9_-]{1,128}$/.test(account.id) || (account.user_id && account.user_id !== config.userId)) continue
      const grant = this.grant(owner, slug)
      const group = groups.get(slug) ?? { slug, accounts: [], ...grant }
      group.accounts.push({ id: account.id, alias: typeof account.alias === 'string' ? account.alias.slice(0, 64) : undefined, status: String(account.status ?? 'UNKNOWN').slice(0, 40) })
      groups.set(slug, group)
    }
    return [...groups.values()]
  }
  grant(owner: string, slug: string): { agentIds: string[]; revision: number } { return this.store.get(owner, 'bot-app-grant', slug) ?? { agentIds: [], revision: 0 } }
  async authorize(owner: string, slug: string, alias?: string) {
    const config = this.require(owner), inventory = await this.inventory(owner)
    const existing = inventory.find(item => item.slug === slug)?.accounts ?? []
    if (existing.some(a => /^(ACTIVE|INITIATED|PENDING|INITIALIZING)$/i.test(a.status)) && !alias) throw new HttpError(409, '添加另一个账号时请填写账号别名', 'plugin_alias_required')
    if (alias && existing.some(a => a.alias?.toLowerCase() === alias.toLowerCase())) throw new HttpError(409, '该账号别名已经存在', 'plugin_alias_conflict')
    if (!config.session) throw new HttpError(409, '请重新保存应用连接服务配置', 'plugin_session_missing')
    const result = await this.request(config.key, `/tool_router/session/${encodeURIComponent(config.session.session_id)}/link`, { toolkit: slug, ...(alias ? { alias } : {}) })
    this.current(owner, config.revision)
    return { url: trustedUrl(String(result.redirect_url ?? '')) }
  }
  async disconnect(owner: string, slug: string, id: string) {
    const config = this.require(owner)
    if (!(await this.inventory(owner)).some(item => item.slug === slug && item.accounts.some(a => a.id === id))) throw new HttpError(404, '应用账号不存在', 'not_found')
    this.current(owner, config.revision)
    await this.request(config.key, `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, undefined, 'DELETE')
    this.invalidate(owner)
  }
  async sessionFor(owner: string, agentId: string, slugs: string[], signal: AbortSignal): Promise<{ url: string; headers: Record<string, string>; revision: number }> {
    const config = this.require(owner)
    const id = createHash('sha256').update(JSON.stringify([agentId, config.revision, [...slugs].sort()])).digest('hex')
    const saved = this.store.get<{ sealed: string }>(owner, 'bot-app-session', id)
    const cacheKey = owner + ':' + id
    let session = saved ? this.nodes.open<{ owner: string; session: Session }>(saved.sealed) : undefined
    if (session && session.owner !== owner) throw new HttpError(403, '应用会话身份无效', 'plugin_forbidden')
    if (!session) {
      let pending = this.sessions.get(cacheKey)
      if (!pending) { pending = this.createSession(config, slugs, signal); this.sessions.set(cacheKey, pending); void pending.finally(() => this.sessions.delete(cacheKey)).catch(() => {}) }
      session = { owner, session: await pending }; this.current(owner, config.revision)
      this.store.put(owner, 'bot-app-session', id, { sealed: this.nodes.seal(session) })
    }
    this.current(owner, config.revision)
    return { url: trustedUrl(session.session.mcp.url), headers: { ...session.session.mcp.headers, 'x-api-key': config.key }, revision: config.revision }
  }
}
