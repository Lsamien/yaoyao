import Router from '@koa/router'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { parse, type WorkspaceStore } from '../workspaceStore.js'
import type { WorkspaceNodes, GatewayTarget } from '../workspaceGateway.js'
import type { WorkspaceRuntime } from '../workspaceRuntime.js'
import type { LocalAuthStore } from '../localAuth.js'
import type { WorkspaceAgent } from '../../shared/workspace.js'
import type { BotMcpPlugin } from '../../shared/workspacePlugins.js'
import { HttpError } from '../errors.js'
import { requireTeamToolBridge } from '../workspaceToolLease.js'
import { StdioMcp, type McpTool } from './stdioMcp.js'
import { HttpMcp, type PluginClient } from './httpMcp.js'
import { appSlug, ConnectedApps } from './connectedApps.js'

const agentIds = z.array(z.string().uuid()).max(100)
const secretMap = z.record(z.string().min(1).max(100), z.union([z.string().max(16_000), z.literal(true)])).refine(value => Object.keys(value).length <= 64)
const definition = z.object({
  name: z.string().trim().min(1).max(80), transport: z.enum(['stdio', 'http']),
  command: z.string().trim().max(1024).optional(), args: z.array(z.string().max(4096)).max(64).default([]),
  url: z.string().max(4096).optional(), env: secretMap.default({}), headers: secretMap.default({}), agentIds: agentIds.default([]),
}).strict()
type Definition = Omit<z.infer<typeof definition>, 'env' | 'headers'> & { env: Record<string, string>; headers: Record<string, string> }
interface StoredPlugin { id: string; sealed: string; enabled: boolean; agentIds: string[]; revision: number; testedAt?: number; tools: McpTool[] }
export interface BotPluginService { name: string; transport: 'stdio' | 'http'; toolCount: number }
export interface BotPluginWarning { name: string; code: string; message: string }
export interface OpenBotPlugins {
  catalog(): Array<{ id: string; name: string; description: string; inputSchema: unknown }>
  services(): BotPluginService[]
  warnings(): BotPluginWarning[]
  call(id: string, args: unknown): Promise<unknown>
  dispose(): Promise<void>
}
const toolSchema = z.object({ name: z.string().min(1).max(128), description: z.string().max(16000).optional(), inputSchema: z.object({ type: z.literal('object') }).passthrough().optional() }).passthrough()
function validateTools(value: McpTool[]): McpTool[] {
  const tools = parse(z.array(toolSchema).max(500), value)
  if (new Set(tools.map(t => t.name)).size !== tools.length) throw new HttpError(502, 'MCP 返回了重复工具名称', 'plugin_invalid_tools')
  return tools
}

export class WorkspacePlugins {
  readonly apps: ConnectedApps
  private live = new Set<{ owner: string; client: PluginClient; pluginId: string }>()
  private probes = 0
  constructor(readonly store: WorkspaceStore, readonly nodes: WorkspaceNodes, readonly auth: LocalAuthStore, readonly runtime: WorkspaceRuntime, readonly home: string, readonly fetchImpl: typeof fetch = fetch) {
    this.apps = new ConnectedApps(store, nodes, fetchImpl, owner => this.assertOwner(owner), owner => this.invalidate(owner, 'connected-apps'))
  }
  private assertOwner(owner: string) { if (!this.auth.isUserActive(owner)) throw new HttpError(403, '当前账号授权已失效', 'plugin_forbidden') }
  private assertAdmin(owner: string) { this.assertOwner(owner); if (!this.auth.isAdminActive(owner)) throw new HttpError(403, '自定义 MCP 服务仅允许管理员配置和使用', 'plugin_admin_required') }
  private agents(owner: string, ids: string[]) {
    for (const id of ids) {
      const agent = this.store.require<WorkspaceAgent>(owner, 'agent', id)
      if (agent.archived || agent.remoteAgentId || agent.temporaryGoalId) throw new HttpError(409, '请选择当前账号的有效 Bot', 'plugin_agent_unavailable')
      this.nodes.requireSource(owner, agent)
    }
    return [...new Set(ids)]
  }
  private value(owner: string, stored: StoredPlugin): Definition {
    const decoded = this.nodes.open<{ owner: string; definition: Definition }>(stored.sealed)
    if (decoded.owner !== owner) throw new HttpError(403, '插件不属于当前账号', 'plugin_forbidden')
    return decoded.definition
  }
  private summary(owner: string, stored: StoredPlugin): BotMcpPlugin {
    const { env, headers, ...value } = this.value(owner, stored)
    return { ...value, id: stored.id, enabled: stored.enabled, agentIds: stored.agentIds, revision: stored.revision, testedAt: stored.testedAt, toolCount: stored.tools.length, envKeys: Object.keys(env).sort(), headerKeys: Object.keys(headers).sort() }
  }
  list(owner: string) { return this.store.list<StoredPlugin>(owner, 'bot-mcp-plugin').map(item => this.summary(owner, item)) }
  save(owner: string, input: unknown, id: string = randomUUID(), revision = 0) {
    this.assertAdmin(owner)
    const data = parse(definition, input), old = this.store.get<StoredPlugin>(owner, 'bot-mcp-plugin', id)
    if ((old?.revision ?? 0) !== revision) throw new HttpError(409, '插件已被修改，请刷新后重试', 'plugin_revision_conflict')
    if (!old && this.list(owner).length >= 20) throw new HttpError(409, '最多添加 20 个 MCP 服务', 'plugin_limit')
    if (this.list(owner).some(p => p.id !== id && p.name.toLowerCase() === data.name.toLowerCase())) throw new HttpError(409, '插件名称已存在', 'plugin_name_conflict')
    const previous = old ? this.value(owner, old) : undefined
    const secrets = (incoming: Record<string, string | true>, saved: Record<string, string> = {}, header = false) => Object.fromEntries(Object.entries(incoming).map(([key, value]) => {
      if (!(header ? /^[A-Za-z0-9-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(key) || (header ? /^(host|cookie|origin|content-length|mcp-session-id|connection|transfer-encoding)$/i : /^(?:YAOYAO_|HERMES_|OMB_|OGB_|CODEX_)/).test(key)) throw new HttpError(400, '凭据字段名称无效或被保留', 'plugin_secret_key_invalid')
      const actual = value === true ? Object.hasOwn(saved, key) ? saved[key] : undefined : value
      if (actual === undefined || (header && /[\r\n]/.test(actual))) throw new HttpError(400, '凭据值无效；新增字段不能使用保留标记', 'plugin_secret_invalid')
      return [key, actual]
    }))
    const value: Definition = { ...data, env: secrets(data.env, previous?.env), headers: secrets(data.headers, previous?.headers, true), agentIds: this.agents(owner, data.agentIds) }
    if (value.transport === 'stdio') {
      if (!value.command || value.command.includes('\0') || value.args.some(a => a.includes('\0'))) throw new HttpError(400, '请填写有效的程序和参数', 'plugin_command_invalid')
      value.url = undefined; value.headers = {}
    } else {
      let url: URL
      try { url = new URL(value.url ?? '') } catch { throw new HttpError(400, '请填写完整的 MCP 地址', 'plugin_url_invalid') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new HttpError(400, 'MCP 地址必须使用 HTTP 或 HTTPS，凭据请填入请求头', 'plugin_url_invalid')
      value.url = url.href; value.command = undefined; value.args = []; value.env = {}
    }
    const entry: StoredPlugin = { id, sealed: this.nodes.seal({ owner, definition: value }), enabled: false, agentIds: value.agentIds, revision: revision + 1, tools: [] }
    this.store.put(owner, 'bot-mcp-plugin', id, entry); this.invalidate(owner, id)
    return this.summary(owner, entry)
  }
  private client(owner: string, value: Definition): PluginClient {
    if (value.transport === 'http') return new HttpMcp(value.url!, value.headers, this.fetchImpl)
    const directory = join(this.home, 'bot-plugins', createHash('sha256').update(owner).digest('hex'))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return new StdioMcp({ command: value.command!, args: value.args, env: value.env }, { env: { PATH: process.env.PATH, HOME: directory, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG ?? 'en_US.UTF-8' }, clientName: 'yaoyao-bot-plugins', ownProcessGroup: true })
  }
  async test(owner: string, id: string) {
    this.assertAdmin(owner)
    if (this.probes >= 2) throw new HttpError(429, '已有两个连接测试正在进行', 'plugin_test_busy')
    const entry = this.store.require<StoredPlugin>(owner, 'bot-mcp-plugin', id)
    const client = this.client(owner, this.value(owner, entry)), record = { owner, client, pluginId: id }; this.live.add(record); this.probes++
    try {
      const signal = AbortSignal.timeout(20_000)
      await client.init(signal); const tools = validateTools(await client.listTools(signal))
      this.assertAdmin(owner)
      if (this.store.require<StoredPlugin>(owner, 'bot-mcp-plugin', id).revision !== entry.revision) throw new HttpError(409, '插件配置已变化，请重新测试', 'plugin_revision_conflict')
      entry.testedAt = Date.now(); entry.tools = tools
      this.store.put(owner, 'bot-mcp-plugin', id, entry)
      return { plugin: this.summary(owner, entry), tools: tools.map(({ name, description }) => ({ name, description })) }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'MCP 连接测试失败，请检查程序、地址和凭据', 'plugin_test_failed')
    } finally { client.dispose(); await client.waitClosed(); this.live.delete(record); this.probes-- }
  }
  private invalidate(owner: string, pluginId: string) { for (const item of this.live) if (item.owner === owner && item.pluginId === pluginId) item.client.dispose() }
  selected(owner: string, agent: WorkspaceAgent): boolean {
    if (agent.remoteAgentId || agent.temporaryGoalId) return false
    return this.store.list<StoredPlugin>(owner, 'bot-mcp-plugin').some(p => p.enabled && p.agentIds.includes(agent.id)) || (this.apps.status(owner).configured && this.store.list<{ agentIds: string[] }>(owner, 'bot-app-grant').some(g => g.agentIds.includes(agent.id)))
  }
  async open(owner: string, agent: WorkspaceAgent, target: GatewayTarget, signal: AbortSignal, authorize: () => void): Promise<OpenBotPlugins> {
    const assertActive = () => {
      authorize(); this.assertOwner(owner); this.agents(owner, [agent.id])
      if (signal.aborted) throw new HttpError(403, '本轮插件授权已结束', 'plugin_grant_revoked')
    }
    assertActive()
    await requireTeamToolBridge(target, agent.profile)
    assertActive()
    const connections: Array<{ client: PluginClient; owner: string; pluginId: string }> = []
    const tools = new Map<string, { client: PluginClient; tool: McpTool; name: string; check: () => void }>()
    const services: Array<{ summary: BotPluginService; check: () => void }> = []
    const warnings: Array<{ summary: BotPluginWarning; check: () => void }> = []
    const unavailable = new Map<string, { message: string; check: () => void }>()
    const toolId = (id: string, name: string) => 'plugin_' + createHash('sha256').update(id + ':' + name).digest('hex').slice(0, 32)
    const dispose = async () => { for (const entry of connections) entry.client.dispose(); await Promise.all(connections.map(async entry => { await entry.client.waitClosed(); this.live.delete(entry) })); signal.removeEventListener('abort', abort) }
    const abort = () => { void dispose() }; signal.addEventListener('abort', abort, { once: true })
    const add = async (id: string, name: string, transport: 'stdio' | 'http', create: () => PluginClient | Promise<PluginClient>, check: () => void, knownTools: McpTool[] = []) => {
      let entry: (typeof connections)[number] | undefined
      try {
        assertActive(); check()
        const client = await create()
        entry = { client, owner, pluginId: id }; connections.push(entry); this.live.add(entry)
        await client.init(signal)
        const list = validateTools(await client.listTools(signal)); assertActive(); check()
        // Publish only complete, live inventories. A rejected service must not
        // leave partially mounted tools or remove another healthy service.
        if (tools.size + list.length > 500) throw new HttpError(409, '所选插件工具总数超过 500，请减少授权的服务', 'plugin_tools_limit')
        services.push({ summary: { name, transport, toolCount: list.length }, check })
        for (const tool of list) tools.set(toolId(id, tool.name), { client, tool, name, check })
      } catch (error) {
        if (entry) {
          entry.client.dispose(); await entry.client.waitClosed()
          this.live.delete(entry); connections.splice(connections.indexOf(entry), 1)
        }
        // Transport failure is optional; cancellation and authority changes are not.
        assertActive(); check()
        if (error instanceof HttpError && [401, 403].includes(error.status)) throw error
        const summary = { name, code: 'plugin_initialization_failed', message: `${name}暂时不可用，本轮未连接；请在已连接应用中测试连接后重试。` }
        warnings.push({ summary, check })
        for (const tool of knownTools) unavailable.set(toolId(id, tool.name), { message: summary.message, check })
      }
    }
    try {
      for (const plugin of this.store.list<StoredPlugin>(owner, 'bot-mcp-plugin').filter(p => p.enabled && p.agentIds.includes(agent.id))) {
        const check = () => {
          this.assertAdmin(owner)
          const current = this.store.get<StoredPlugin>(owner, 'bot-mcp-plugin', plugin.id)
          if (!current?.enabled || current.revision !== plugin.revision || !current.agentIds.includes(agent.id)) throw new HttpError(403, '该插件的本轮授权已结束', 'plugin_grant_revoked')
        }
        check(); const value = this.value(owner, plugin)
        await add(plugin.id, value.name, value.transport, () => this.client(owner, value), check, plugin.tools)
      }
      const grants = this.store.db.prepare("SELECT id,data FROM workspace_entities WHERE owner=? AND kind='bot-app-grant'").all(owner)
        .map(row => ({ slug: String(row.id), ...JSON.parse(String(row.data)) as { agentIds: string[]; revision: number } })).filter(g => g.agentIds.includes(agent.id))
      if (grants.length && this.apps.status(owner).configured) {
        const revision = this.apps.status(owner).revision
        const check = () => {
          this.assertOwner(owner)
          if (this.apps.status(owner).revision !== revision || grants.some(g => { const current = this.apps.grant(owner, g.slug); return current.revision !== g.revision || !current.agentIds.includes(agent.id) })) throw new HttpError(403, '应用连接的本轮授权已结束', 'plugin_grant_revoked')
        }
        await add('connected-apps', '已连接应用', 'http', async () => {
          const session = await this.apps.sessionFor(owner, agent.id, grants.map(g => g.slug), signal)
          return new HttpMcp(session.url, session.headers, this.fetchImpl)
        }, check)
      }
      return {
        catalog: () => [...tools].flatMap(([id, entry]) => { try { assertActive(); entry.check(); return [{ id, name: id, description: `${entry.name} · ${entry.tool.name}：${entry.tool.description ?? ''}`, inputSchema: entry.tool.inputSchema ?? { type: 'object', properties: {} } }] } catch { return [] } }),
        services: () => services.flatMap(entry => { try { assertActive(); entry.check(); return [{ ...entry.summary }] } catch { return [] } }),
        warnings: () => warnings.flatMap(entry => { try { assertActive(); entry.check(); return [{ ...entry.summary }] } catch { return [] } }),
        call: async (id, args) => {
          assertActive(); const entry = tools.get(id), failed = unavailable.get(id)
          if (failed) { failed.check(); throw new HttpError(503, failed.message, 'plugin_unavailable') }
          if (!entry) throw new HttpError(404, '插件工具不存在', 'plugin_tool_not_found')
          entry.check()
          try { const result = await entry.client.callTool(entry.tool.name, args, signal); assertActive(); entry.check(); return result }
          catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, '插件工具调用失败或连接已关闭', 'plugin_call_failed') }
        }, dispose,
      }
    } catch (error) { await dispose(); if (error instanceof HttpError) throw error; throw new HttpError(502, '插件初始化失败，请在已连接应用中测试连接', 'plugin_initialization_failed') }
  }
  router() {
    const router = new Router({ prefix: '/api/app/bot-tools' })
    const body = (ctx: any) => ctx.request.body
    router.get('/settings', ctx => { const owner = this.auth.require(ctx).id; ctx.body = { ...this.apps.status(owner), canManageMcp: this.auth.isAdminActive(owner) } })
    router.put('/settings', async ctx => {
      const owner = this.auth.require(ctx).id
      const value = parse(z.object({ apiKey: z.string().trim().max(4000), revision: z.number().int().nonnegative(), authConfigs: z.record(appSlug, z.string().max(200)).default({}) }).strict(), body(ctx))
      ctx.body = await this.apps.configure(owner, value.apiKey, value.revision, value.authConfigs)
    })
    router.get('/mcp', ctx => { const owner = this.auth.require(ctx).id; ctx.body = { plugins: this.list(owner), canManage: this.auth.isAdminActive(owner) } })
    router.post('/mcp', ctx => { ctx.body = { plugin: this.save(this.auth.require(ctx).id, body(ctx)) }; ctx.status = 201 })
    router.put('/mcp/:id', ctx => { const value = parse(z.object({ definition, revision: z.number().int().positive() }).strict(), body(ctx)); this.store.require(this.auth.require(ctx).id, 'bot-mcp-plugin', ctx.params.id); ctx.body = { plugin: this.save(this.auth.require(ctx).id, value.definition, ctx.params.id, value.revision) } })
    router.post('/mcp/:id/test', async ctx => { ctx.body = await this.test(this.auth.require(ctx).id, ctx.params.id) })
    router.patch('/mcp/:id', ctx => {
      const owner = this.auth.require(ctx).id; this.assertAdmin(owner)
      const value = parse(z.object({ enabled: z.boolean().optional(), agentIds: agentIds.optional(), revision: z.number().int().positive() }).strict(), body(ctx))
      const entry = this.store.require<StoredPlugin>(owner, 'bot-mcp-plugin', ctx.params.id)
      if (entry.revision !== value.revision) throw new HttpError(409, '插件配置已变化，请刷新', 'plugin_revision_conflict')
      if (value.enabled && !entry.testedAt) throw new HttpError(409, '请先成功测试连接，再启用插件', 'plugin_not_tested')
      if (value.enabled !== undefined) entry.enabled = value.enabled
      if (value.agentIds) entry.agentIds = this.agents(owner, value.agentIds)
      entry.revision++; this.store.put(owner, 'bot-mcp-plugin', entry.id, entry); this.invalidate(owner, entry.id)
      ctx.body = { plugin: this.summary(owner, entry) }
    })
    router.delete('/mcp/:id', ctx => { const owner = this.auth.require(ctx).id; this.assertAdmin(owner); this.store.require(owner, 'bot-mcp-plugin', ctx.params.id); this.store.remove(owner, 'bot-mcp-plugin', ctx.params.id); this.invalidate(owner, ctx.params.id); ctx.body = { ok: true } })
    router.get('/apps/catalog', async ctx => { ctx.body = await this.apps.catalog(this.auth.require(ctx).id) })
    router.get('/apps', async ctx => { const owner = this.auth.require(ctx).id; ctx.body = { configured: this.apps.status(owner).configured, connections: this.apps.status(owner).configured ? await this.apps.inventory(owner) : [], authoritative: true } })
    router.post('/apps/:slug/authorize', async ctx => { const value = parse(z.object({ alias: z.string().trim().min(1).max(64).optional() }).strict(), body(ctx)); ctx.body = await this.apps.authorize(this.auth.require(ctx).id, parse(appSlug, ctx.params.slug), value.alias) })
    router.put('/apps/:slug/agents', ctx => {
      const owner = this.auth.require(ctx).id, slug = parse(appSlug, ctx.params.slug), value = parse(z.object({ agentIds, revision: z.number().int().nonnegative() }).strict(), body(ctx))
      const current = this.apps.grant(owner, slug)
      if (current.revision !== value.revision) throw new HttpError(409, '应用授权已变化，请刷新', 'plugin_revision_conflict')
      const grant = { agentIds: this.agents(owner, value.agentIds), revision: current.revision + 1 }
      this.store.put(owner, 'bot-app-grant', slug, grant); this.invalidate(owner, 'connected-apps'); ctx.body = grant
    })
    router.delete('/apps/:slug/accounts/:id', async ctx => { await this.apps.disconnect(this.auth.require(ctx).id, parse(appSlug, ctx.params.slug), ctx.params.id); ctx.body = { ok: true } })
    return router
  }
  close() { for (const entry of this.live) entry.client.dispose(); this.live.clear() }
}
