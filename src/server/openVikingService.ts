import { OpenVikingClient, OpenVikingError } from '@openviking/sdk'
import { createHash } from 'node:crypto'
import { HttpError } from './errors.js'
import { decryptOpenVikingSecret, encryptOpenVikingSecret, type OpenVikingConfiguration, type OpenVikingConfigurationManager } from './openVikingConfiguration.js'
import type { WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceAgent } from '../shared/workspace.js'

export interface OpenVikingUserBinding {
  provider: 'openviking'
  owner: string
  agentId: string
  userId: string
  status: 'active' | 'removed'
  encryptedUserKey: string
  updatedAt: number
  namespace?: string
  pendingRemoval?: boolean
}

export type OpenVikingClientFactory = (config: { baseUrl: string; apiKey: string; account?: string; user?: string }) => OpenVikingClient

export const openVikingUserId = (agentId: string): string => `yy-${agentId.replaceAll('-', '')}`

function mapError(error: unknown, operation: string): never {
  if (error instanceof HttpError) throw error
  const message = error instanceof Error ? error.message : String(error)
  throw new HttpError(502, `OpenViking ${operation}失败：${message}`, 'openviking_unavailable')
}

function apiKeyFromResult(value: Record<string, unknown>): string {
  const user = value.user && typeof value.user === 'object' ? value.user as Record<string, unknown> : undefined
  const key = value.user_key ?? value.userKey ?? value.apiKey ?? value.api_key ?? value.key ?? value.token ?? user?.user_key ?? user?.userKey ?? user?.apiKey ?? user?.api_key
  if (typeof key !== 'string' || !key) throw new Error('server did not return a user API key')
  return key
}

export class OpenVikingService {
  readonly #clients = new Map<string, OpenVikingClient>()
  readonly #adminClients = new Map<string, OpenVikingClient>()
  readonly #registrations = new Map<string, Promise<OpenVikingUserBinding>>()
  #configuration: OpenVikingConfiguration | undefined
  readonly #clientFactory: OpenVikingClientFactory
  constructor(private readonly store: WorkspaceStore, private readonly configurationManager: OpenVikingConfigurationManager, clientFactory?: OpenVikingClientFactory) {
    this.#clientFactory = clientFactory ?? (config => new OpenVikingClient(config))
    this.configure(configurationManager.configuration())
  }
  get enabled(): boolean { return Boolean(this.#configuration) }
  get namespace(): string {
    const config = this.#configuration
    return config ? createHash('sha256').update(`${config.url.replace(/\/$/, '')}\0${config.accountId}`).digest('hex') : ''
  }
  configure(config: OpenVikingConfiguration | undefined): void {
    const signature = config ? `${config.url}\0${config.accountId}\0${config.adminKey}` : ''
    if (signature !== this.#signature) {
      this.#clients.clear()
      this.#adminClients.clear()
    }
    this.#configuration = config
  }
  get #signature(): string { return this.#configuration ? `${this.#configuration.url}\0${this.#configuration.accountId}\0${this.#configuration.adminKey}` : '' }
  binding(owner: string, agentId: string): OpenVikingUserBinding | undefined {
    if (!this.enabled) return this.store.get<OpenVikingUserBinding>(owner, 'openviking-binding', agentId)
    const scoped = this.store.get<OpenVikingUserBinding>(owner, 'openviking-binding', `${this.namespace}:${agentId}`)
    if (scoped) return scoped
    const legacy = this.store.get<OpenVikingUserBinding>(owner, 'openviking-binding', agentId)
    return legacy && (!legacy.namespace || legacy.namespace === this.namespace) ? legacy : undefined
  }
  private saveBinding(binding: OpenVikingUserBinding): void {
    this.store.put(binding.owner, 'openviking-binding', `${binding.namespace}:${binding.agentId}`, binding)
    this.store.put(binding.owner, 'openviking-binding', binding.agentId, binding)
  }
  /** The pinned SDK lacks session-config PATCH; use the same scoped credentials. */
  async disableSessionAutoCommit(owner: string, agentId: string, sessionId: string): Promise<void> {
    const config = this.#configuration, binding = this.binding(owner, agentId)
    if (!config || !binding || binding.status !== 'active') throw new HttpError(409, 'OpenViking 用户未绑定', 'openviking_user_unbound')
    const response = await fetch(`${config.url.replace(/\/$/, '')}/api/v1/sessions/${encodeURIComponent(sessionId)}/config`, {
      method: 'PATCH', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', 'X-API-Key': decryptUserKey(this.store.home, binding.encryptedUserKey), 'X-OpenViking-Account': config.accountId, 'X-OpenViking-User': binding.userId },
      body: JSON.stringify({ auto_commit_policy: null }),
    })
    if (!response.ok) throw new HttpError(502, '无法关闭会话自动提交，请检查 OpenViking 版本', 'openviking_session_config_failed')
  }
  adminClient(): OpenVikingClient {
    const config = this.#configuration
    if (!config) throw new HttpError(409, 'OpenViking 记忆服务未启用', 'openviking_disabled')
    const key = `${config.url}\0${config.accountId}`
    let client = this.#adminClients.get(key)
    if (!client) {
      client = this.#clientFactory({ baseUrl: config.url, apiKey: config.adminKey, account: config.accountId })
      this.#adminClients.set(key, client)
    }
    return client
  }
  userClient(owner: string, agentId: string): OpenVikingClient {
    const config = this.#configuration
    if (!config) throw new HttpError(409, 'OpenViking 记忆服务未启用', 'openviking_disabled')
    const binding = this.binding(owner, agentId)
    if (!binding || binding.status !== 'active') throw new HttpError(409, `Bot 尚未绑定 OpenViking user：${agentId}`, 'openviking_user_unbound')
    const cacheKey = `${config.url}\0${config.accountId}\0${binding.userId}\0${binding.encryptedUserKey}`
    let client = this.#clients.get(cacheKey)
    if (!client) {
      const key = decryptUserKey(this.store.home, binding.encryptedUserKey)
      client = this.#clientFactory({ baseUrl: config.url, apiKey: key, account: config.accountId, user: binding.userId })
      this.#clients.set(cacheKey, client)
    }
    return client
  }
  async ensureUser(owner: string, agent: Pick<WorkspaceAgent, 'id' | 'temporaryGoalId'>): Promise<OpenVikingUserBinding> {
    const key = `${this.namespace}:${owner}:${agent.id}`
    const existing = this.#registrations.get(key)
    if (existing) return existing
    const pending = this.registerUser(owner, agent)
    this.#registrations.set(key, pending)
    try { return await pending } finally { this.#registrations.delete(key) }
  }
  private async registerUser(owner: string, agent: Pick<WorkspaceAgent, 'id' | 'temporaryGoalId'>): Promise<OpenVikingUserBinding> {
    if (!this.#configuration) throw new HttpError(409, 'OpenViking 记忆服务未启用', 'openviking_disabled')
    if (agent.temporaryGoalId) throw new HttpError(403, '临时助手不创建 OpenViking user', 'helper_task_bound')
    const existing = this.binding(owner, agent.id)
    if (existing?.status === 'active') {
      if (!existing.namespace) { existing.namespace = this.namespace; this.saveBinding(existing) }
      return existing
    }
    const namespace = this.namespace
    const accountId = this.#configuration.accountId
    const admin = this.adminClient()
    const userId = openVikingUserId(agent.id)
    let result: Record<string, unknown>
    try {
      try {
        result = await admin.adminRegisterUser(accountId, userId, 'user', { seed: `yaoyao:${agent.id}` }) as Record<string, unknown>
      } catch (error) {
        if (!(error instanceof OpenVikingError) || !['EXISTS', 'USER_EXISTS', 'CONFLICT', 'ALREADY_EXISTS'].includes(error.code)) throw error
        result = await admin.adminRegenerateKey(accountId, userId, `yaoyao:${agent.id}`) as Record<string, unknown>
      }
      const binding: OpenVikingUserBinding = {
        provider: 'openviking', owner, agentId: agent.id, userId, status: 'active',
        encryptedUserKey: encryptUserKey(this.store.home, apiKeyFromResult(result)), updatedAt: Date.now(), namespace,
      }
      this.saveBinding(binding)
      return binding
    } catch (error) {
      mapError(error, 'user 注册')
    }
  }
  async removeUser(owner: string, agent: Pick<WorkspaceAgent, 'id' | 'temporaryGoalId'>): Promise<void> {
    const binding = this.binding(owner, agent.id)
    if (!binding || binding.status !== 'active' && !binding.pendingRemoval) return
    if (!this.#configuration) {
      // Disabled mode preserves the remote data, but this local Bot can no longer reach it.
      this.saveBinding({ ...binding, status: 'removed', pendingRemoval: true, updatedAt: Date.now() })
      return
    }
    try {
      await this.adminClient().adminRemoveUser(this.#configuration.accountId, binding.userId)
    } catch (error) {
      if (!(error instanceof OpenVikingError) || ![404, 'NOT_FOUND'].includes(error.statusCode ?? error.code)) mapError(error, 'user 删除')
    }
    this.saveBinding({ ...binding, status: 'removed', pendingRemoval: false, updatedAt: Date.now() })
  }
}

function encryptUserKey(home: string, value: string): string {
  return encryptOpenVikingSecret(home, value)
}
function decryptUserKey(home: string, value: string): string {
  return decryptOpenVikingSecret(home, value)
}
