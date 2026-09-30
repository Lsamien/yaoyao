import Router from '@koa/router'
import type Koa from 'koa'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { HttpError } from '../errors.js'
import type { WorkspaceStore } from '../workspaceStore.js'
import type { LocalAuthStore } from '../localAuth.js'
import type { RunnerHub } from '../runnerHub.js'
import type { WorkspaceAgent, WorkspaceRun } from '../../shared/workspace.js'
import type { Work } from '../workspaceScheduler.js'
import type { CredentialLeaseSummary, CredentialVaultStatus, CredentialTarget,CredentialUseSummary } from '../../shared/credentialVault.js'
import { CredentialVaultClient } from './transport.js'
import { parse, leaseInput } from './schema.js'

interface Session { owner: string; key: string; cookie: string; version: number | undefined }
interface Grant { summary: CredentialLeaseSummary; target: CredentialTarget; usage?:CredentialUseSummary; session: Session; binding: ReturnType<RunnerHub['credentialBinding']> }
const toolSchema = { type: 'object', properties: { credentialRef: { type: 'string' }, operation: { enum: ['website.login', 'ssh.exec', 'sftp.read', 'sftp.write'] } }, required: ['credentialRef', 'operation'], additionalProperties: false }
export const CREDENTIAL_TOOLS = [
  { id: 'credential_refs', name: 'credential_refs', description: '列出用户授予当前 Bot/任务的凭据引用与允许目标，不包含账号密码或私钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { id: 'credential_request', name: 'credential_request', description: '请求并使用当前任务的短凭据授权，只执行用户配置的标准网站表单、固定 SSH 命令或指定 SFTP 操作。锁定/离线时等待用户解锁与授权，隔离未批准或复杂网站转人工接管。不得索取或读取密码，不得降级 fill/shell；未知结果不能自动重试。', inputSchema: toolSchema },
]
/** The Web control plane never receives a read-secret response. Deployment must
 * keep this process/IPC identity separate from Hermes' arbitrary shell identity. */
export class CredentialVaultCoordinator {
  private sessions = new Map<string, Session>()
  private grants = new Map<string, Grant>()
  private pending = new Map<string, { owner: string; agentId: string; workId: string; credentialRef: string; operation: string }>()
  private generations = new Map<string, number>()
  private logoutGenerations = new Map<string, number>()
  private connectionGeneration = 0
  private closed = false
  private turnControllers = new Set<AbortController>()
  private timer: ReturnType<typeof setInterval>
  constructor(readonly client: CredentialVaultClient, private store: WorkspaceStore, private auth: LocalAuthStore, private hub: RunnerHub) {
    client.onDisconnect = () => { this.connectionGeneration++; this.grants.clear(); this.sessions.clear() }
    this.timer = setInterval(() => {
      for (const s of [...this.sessions.values()]) if (!this.valid(s)) void this.endSession(s)
      for (const [id, g] of this.grants) {
        try { this.task(g.session.owner, g.summary.agentId, g.summary.workId); const current = this.binding(g.session.owner, g.summary.agentId); if (JSON.stringify(current) !== JSON.stringify(g.binding) || g.summary.expiresAt <= Date.now()) throw new Error() }
        catch { this.grants.delete(id); void this.client.call(g.session.owner, g.session.key, 'revoke', { id }).catch(() => {}) }
      }
    }, 1000); this.timer.unref()
  }
  private valid(s: Session) { return this.auth.currentFromCookieHeader(s.cookie)?.id === s.owner && this.auth.isUserActive(s.owner) && this.auth.pushAuthorizationVersion(s.owner) === s.version }
  private scope(ctx: Koa.Context) {
    if (this.closed) throw new HttpError(503, '密码库连接已关闭', 'vault_offline')
    const user = this.auth.require(ctx), cookie = ctx.get('cookie')
    if (this.auth.currentFromCookieHeader(cookie)?.id !== user.id) throw new HttpError(401, '当前会话已失效', 'vault_session_revoked')
    const key = this.auth.sessionBinding(cookie)
    if (!key) throw new HttpError(401, '当前会话已失效', 'vault_session_revoked')
    const s: Session = { owner: user.id, key, cookie, version: this.auth.pushAuthorizationVersion(user.id) }
    // Secrets may not traverse explicitly enabled insecure LAN HTTP.
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ctx.req.socket.remoteAddress ?? '')
    if (!ctx.secure && !local) throw new HttpError(403, '密码库管理需要 HTTPS 或本机回环连接', 'vault_https_required')
    ctx.set('Cache-Control', 'no-store'); return s
  }
  private async call(s: Session, command: string, value?: unknown) {
    if (!this.valid(s)) throw new HttpError(401, '当前会话已失效', 'vault_session_revoked')
    const generation=this.generations.get(s.owner)??0,logout=this.logoutGenerations.get(s.owner+':'+s.key)??0,connection=this.connectionGeneration
    const result = await this.client.call(s.owner, s.key, command, value)
    if (!this.valid(s)||generation!==(this.generations.get(s.owner)??0)||logout!==(this.logoutGenerations.get(s.owner+':'+s.key)??0)||connection!==this.connectionGeneration) {
      await this.endSession(s); throw new HttpError(401, '当前会话已失效', 'vault_session_revoked')
    }
    return result
  }
  async endSession(s: Session) {
    if (this.sessions.get(s.owner)?.key === s.key) this.sessions.delete(s.owner)
    for (const [id, g] of this.grants) if (g.session.key === s.key) this.grants.delete(id)
    await this.client.call(s.owner, s.key, 'logout').catch(() => {})
  }
  async logout(owner: string, cookie: string) {
    const binding=this.auth.sessionBinding(cookie);if(!binding)return
    const key=owner+':'+binding;this.logoutGenerations.set(key,(this.logoutGenerations.get(key)??0)+1)
    const s = this.sessions.get(owner)
    if (s?.key === binding) await this.endSession(s)
    else await this.client.call(owner, binding, 'logout').catch(() => {})
  }
  private task(owner: string, agentId: string, workId: string) {
    const agent = this.store.require<WorkspaceAgent>(owner, 'agent', agentId), work = this.store.require<Work>(owner, 'turn', workId)
    const run = this.store.require<WorkspaceRun>(owner, 'run', work.runId)
    if (!this.auth.isUserActive(owner) || agent.archived || work.agentId !== agent.id || !['running', 'waiting'].includes(work.status) || work.cancelRequested || run.stopRequested
      || !this.auth.canUseSource(owner, agent.nodeId, agent.profile)) throw new HttpError(410, 'Bot 任务授权已结束', 'vault_task_revoked')
    return { agent, work }
  }
  private binding(owner: string, agentId: string) { return this.hub.credentialBinding(owner, this.store.require<WorkspaceAgent>(owner, 'agent', agentId)) }
  private tasks(owner: string) {
    return this.store.list<Work>(owner, 'turn').flatMap(w => {
      try { const { agent } = this.task(owner, w.agentId, w.id); return [{ workId: w.id, agentId: agent.id, name: agent.name }] } catch { return [] }
    })
  }
  private offline(): CredentialVaultStatus { return { protocol: 1, online: false, initialized: false, unlocked: false, execution: 'disabled', reason: 'vault_offline', entries: [], leases: [] } }
  async view(s: Session) {
    let status: CredentialVaultStatus
    try { status = await this.call(s, 'status') } catch (e) { if (!(e instanceof HttpError) || e.code !== 'vault_offline') throw e; status = this.offline() }
    return { ...status, tasks: this.tasks(s.owner), requests: [...this.pending.values()].filter(p => p.owner === s.owner).map(({ owner: _owner, ...p }) => p) }
  }
  router() {
    const r = new Router(), root = '/api/app/vault'
    r.get(root, async ctx => { ctx.body = await this.view(this.scope(ctx)) })
    for (const command of ['initialize', 'unlock', 'lock', 'rotate', 'backup', 'restore'] as const)
      r.post(root + '/' + command, async ctx => {
        const s = this.scope(ctx)
        if(['unlock','lock','rotate'].includes(command))this.generations.set(s.owner,(this.generations.get(s.owner)??0)+1)
        if (['unlock','lock','rotate'].includes(command)) { this.grants.forEach((g, id) => { if (g.session.owner === s.owner) this.grants.delete(id) }) }
        const result = await this.call(s, command, (ctx.request as any).body ?? {})
        if (command === 'unlock') this.sessions.set(s.owner, s)
        if (command === 'lock' || command === 'rotate') this.sessions.delete(s.owner)
        ctx.body = result
      })
    r.post(root + '/entries', async ctx => { ctx.body = await this.call(this.scope(ctx), 'add', (ctx.request as any).body) })
    r.put(root + '/entries/:id', async ctx => {
      const s = this.scope(ctx); this.grants.forEach((g, id) => { if (g.summary.credentialRef === ctx.params.id && g.session.owner === s.owner) this.grants.delete(id) })
      ctx.body = await this.call(s, 'update', { id: ctx.params.id, entry: (ctx.request as any).body })
    })
    r.delete(root + '/entries/:id', async ctx => {
      const s = this.scope(ctx); this.grants.forEach((g, id) => { if (g.summary.credentialRef === ctx.params.id && g.session.owner === s.owner) this.grants.delete(id) })
      ctx.body = await this.call(s, 'remove', { id: ctx.params.id })
    })
    r.post(root + '/leases', async ctx => {
      const s = this.scope(ctx), body = parse(z.object({ credentialRef: z.string().uuid(), agentId: z.string().uuid(), workId: z.string().uuid(),
        operation: leaseInput.shape.operation, seconds: leaseInput.shape.seconds }).strict(), (ctx.request as any).body)
      this.task(s.owner, body.agentId, body.workId)
      const binding = this.binding(s.owner, body.agentId), state: CredentialVaultStatus = await this.call(s, 'status'), entry = state.entries.find(e => e.id === body.credentialRef)
      if (!entry) throw new HttpError(403, '请解锁并选择当前账号的凭据', 'vault_credential_forbidden')
      const summary = await this.call(s, 'grant', { ...body, ...binding, target: entry.target }) as CredentialLeaseSummary
      try {
        this.task(s.owner, body.agentId, body.workId)
        if (JSON.stringify(this.binding(s.owner, body.agentId)) !== JSON.stringify(binding)) throw new Error()
        this.grants.set(summary.id, { summary, target:entry.target,usage:entry.usage, session: s, binding }); ctx.body = summary
      } catch {
        await this.client.call(s.owner, s.key, 'revoke', { id: summary.id }).catch(() => {})
        throw new HttpError(410, '任务或执行节点已变化，授权未保留', 'vault_task_revoked')
      }
    })
    r.delete(root + '/leases/:id', async ctx => {
      const s = this.scope(ctx); this.grants.delete(ctx.params.id); ctx.body = await this.call(s, 'revoke', { id: ctx.params.id })
    })
    return r
  }
  openTurn(owner: string, agentId: string, workId: string, externalSignal: AbortSignal, authorize: () => void, waiting: (value: boolean) => void) {
    const controller=new AbortController(),signal=AbortSignal.any([externalSignal,controller.signal]),pendingIds=new Set<string>()
    let waitingCalls=0
    this.turnControllers.add(controller)
    const check = () => { signal.throwIfAborted(); if (this.closed) throw new HttpError(503, '密码库连接已关闭', 'vault_offline'); authorize(); this.task(owner, agentId, workId) }
    const abort = () => {
      this.turnControllers.delete(controller)
      for(const id of pendingIds)this.pending.delete(id)
      for (const [key, g] of this.grants) if (g.summary.workId === workId && g.session.owner === owner) this.grants.delete(key)
      const s = this.sessions.get(owner); if (s) void this.client.call(owner, s.key, 'revoke-work', { workId }).catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    const refs = async () => {
      const binding = this.binding(owner, agentId), entries = []
      for (const g of this.grants.values()) {
        if (g.session.owner !== owner || g.summary.agentId !== agentId || g.summary.workId !== workId || g.summary.expiresAt <= Date.now()
          || !this.valid(g.session) || JSON.stringify(g.binding) !== JSON.stringify(binding)) continue
        const state: CredentialVaultStatus = await this.call(g.session, 'status'); check()
        if (state.unlocked && state.leases.some(l => l.id === g.summary.id)) entries.push({ credentialRef:g.summary.credentialRef, operation:g.summary.operation, allowedTarget:g.target,...(g.usage?{allowedUse:g.usage}:{}) })
      }
      return entries
    }
    return { close: () => { controller.abort(); signal.removeEventListener('abort', abort) },
      call: async (name: string, value: unknown) => {
        check()
        if (name === 'credential_refs') { parse(z.object({}).strict(), value); return { references: await refs() } }
        if (name !== 'credential_request') throw new HttpError(404, '凭据工具不存在', 'vault_command_unknown')
        const b = parse(z.object({ credentialRef: z.string().uuid(), operation: leaseInput.shape.operation }).strict(), value)
        const id=randomUUID();pendingIds.add(id);this.pending.set(id, { owner, agentId, workId, ...b })
        if(++waitingCalls===1)waiting(true)
        try {
          let initialBinding: ReturnType<RunnerHub['credentialBinding']> | undefined
          // Bounded waiting is a state, never permission to execute or replay.
          const end = Date.now() + 120000
          while (Date.now() < end) {
            check()
            try {
              const binding = this.binding(owner, agentId)
              if (initialBinding && JSON.stringify(binding) !== JSON.stringify(initialBinding)) throw new HttpError(410, '节点重连后需要新的任务授权', 'vault_connection_revoked')
              initialBinding ??= binding
              const g = [...this.grants.values()].find(g => g.session.owner === owner && g.summary.workId === workId && g.summary.credentialRef === b.credentialRef && g.summary.operation === b.operation)
              if (g) {
                if (!this.valid(g.session) || g.summary.expiresAt <= Date.now() || JSON.stringify(g.binding) !== JSON.stringify(binding)) throw new HttpError(410, '凭据任务授权已结束', 'vault_lease_revoked')
                const state: CredentialVaultStatus = await this.call(g.session, 'status'); check()
                if (state.unlocked && state.leases.some(l => l.id === g.summary.id)) {
                  if(JSON.stringify(this.binding(owner,agentId))!==JSON.stringify(binding))throw new HttpError(410,'节点重连后需要新授权','vault_connection_revoked')
                  if (state.execution === 'dummy-fixture'||state.execution==='protected-adapters') {
                    try {
                      const result = await this.call(g.session,'execute',{id:g.summary.id,input:{...b,agentId,workId,...binding,target:g.target,seconds:60}})
                      check()
                      if(JSON.stringify(this.binding(owner,agentId))!==JSON.stringify(binding))throw new HttpError(409,'执行端在回执确认前变化，结果未知；不能自动重试','vault_operation_uncertain')
                      return result
                    } finally { this.grants.delete(g.summary.id) }
                  }
                  return { status: 'manual_takeover_required', reason: 'vault_executor_not_enabled', message: '正式网站/SSH 受保护执行器尚未启用；请人工接管，不能使用通用 fill 或 shell 替代。' }
                }
              }
            } catch (e) { if (!(e instanceof HttpError) || !['vault_offline', 'vault_runner_offline', 'vault_locked'].includes(e.code)) throw e }
            await delay(1000, undefined, { signal })
          }
          return { status: 'waiting_for_user', reason: 'vault_locked_or_offline', message: '仍需用户连接、解锁和本任务授权；未执行登录。' }
        } finally { this.pending.delete(id);pendingIds.delete(id);if(--waitingCalls===0)waiting(false) }
      },
    }
  }
  close() { this.closed=true; clearInterval(this.timer); for(const c of this.turnControllers)c.abort();this.turnControllers.clear();this.grants.clear(); this.pending.clear(); for (const s of this.sessions.values()) void this.endSession(s); this.sessions.clear() }
}
