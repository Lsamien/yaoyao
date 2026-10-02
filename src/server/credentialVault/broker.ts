import { randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, fsyncSync, fstatSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HttpError } from '../errors.js'
import { CredentialVaultStore } from './store.js'
import { parse, leaseInput, type LeaseInput } from './schema.js'
import type {CredentialExecutor,CredentialExecutionReceipt} from './executor.js'
import type { CredentialLeaseSummary, CredentialVaultStatus } from '../../shared/credentialVault.js'
interface Lease extends CredentialLeaseSummary {
  owner: string; session: string; version: number; epoch: number; runnerInstance: string; runnerEpoch: string
  target: LeaseInput['target']; consumed: boolean; controller: AbortController
}
export type CredentialExecutorFixture = CredentialExecutor
export class CredentialVaultBroker {
  private sessions = new Map<string, string>()
  private epochs = new Map<string, number>()
  private leases = new Map<string, Lease>()
  private hostPreparations = new Map<AbortController,string>()
  private controlEpoch = ''
  private timer: ReturnType<typeof setInterval>
  constructor(readonly store: CredentialVaultStore, private now = Date.now, private executor?: CredentialExecutor) {
    store.onLock = owner => this.revokeOwner(owner)
    this.timer = setInterval(() => {
      try { this.executor?.assertAvailable?.() } catch { this.disconnect() }
      for (const owner of this.sessions.keys()) {
        try { store.state(owner) }
        catch { store.lock(owner); this.sessions.delete(owner); this.revokeOwner(owner) }
      }
      for (const [id, lease] of this.leases) if (lease.expiresAt <= this.now()) this.revoke(id)
    }, 1000); this.timer.unref()
  }
  private audit(owner: string, action: string, ref?: string, outcome = 'ok') {
    // No request body, username, target, secret, transport error or task output.
    const row = { at: this.now(), owner, action, ...(ref ? { ref } : {}), outcome }
    const path = join(this.store.root, 'audit.jsonl')
    let fd: number | undefined
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      const stat = fstatSync(fd)
      if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('密码库审计文件权限不安全')
      writeFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd)
    } catch {
      this.store.lock(owner); this.sessions.delete(owner); this.revokeOwner(owner)
      throw new HttpError(503, '密码库审计不可用，已锁定并撤销授权', 'vault_audit_unavailable')
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  recordBotAction(owner:string,action:'bot-grant'|'bot-revoke'|'bot-execute-started'|'bot-execute-complete'|'bot-execute-ended',ref:string,outcome='ok'){this.audit(owner,action,ref,outcome)}
  hello(epoch: string) {
    parse(z.string().uuid(), epoch)
    if (epoch !== this.controlEpoch) { this.store.lockAll(); this.revokeAll(); this.sessions.clear(); this.controlEpoch = epoch }
    return { protocol: 1, execution: this.execution().execution }
  }
  private execution():Pick<CredentialVaultStatus,'execution'|'reason'>{
    if(!this.executor)return {execution:'disabled',reason:'executor_not_enabled'}
    try{this.executor.assertAvailable?.();return {execution:this.executor.mode??'dummy-fixture',reason:this.executor.mode==='protected-adapters'?'operator_approved':this.executor.mode==='local-adapters'?'local_controlled':'dummy_fixture_only'}}
    catch{this.disconnect();return {execution:'disabled',reason:this.executor.mode==='local-adapters'?'executor_unavailable':'isolation_required'}}
  }
  private authorize(owner: string, session: string) {
    if (this.sessions.get(owner) !== session || !this.store.state(owner).unlocked)
      throw new HttpError(423, '请在本次登录的密码管理界面手动解锁', 'vault_locked')
  }
  status(owner: string, session: string): CredentialVaultStatus {
    const execution=this.execution(),state = this.store.state(owner), own = this.sessions.get(owner) === session && state.unlocked
    return { protocol: 1, online: true, initialized: state.initialized, unlocked: own,
      ...(own ? { unlockExpiresAt: state.unlockExpiresAt } : {}), ...execution,
      entries: own ? this.store.list(owner) : [], leases: own ? [...this.leases.values()].filter(l => l.owner === owner).map(({ id, credentialRef, agentId, workId, runnerId, operation, expiresAt }) =>
        ({ id, credentialRef, agentId, workId, runnerId, operation, expiresAt })) : [] }
  }
  revokeOwner(owner: string) {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1)
    for(const [controller,preparedOwner] of this.hostPreparations)if(preparedOwner===owner){this.hostPreparations.delete(controller);controller.abort()}
    for (const [id, l] of this.leases) if (l.owner === owner) this.revoke(id)
  }
  private revokeAll() { for (const id of [...this.leases.keys()]) this.revoke(id);for(const controller of this.hostPreparations.keys())controller.abort();this.hostPreparations.clear() }
  private revoke(id: string) { const l = this.leases.get(id); this.leases.delete(id); l?.controller.abort() }
  disconnect() { this.store.lockAll(); this.revokeAll(); this.sessions.clear() }
  close() { clearInterval(this.timer); this.disconnect() }
  async prepareHost(epoch:string,owner:string,session:string,value:unknown,externalSignal?:AbortSignal){
    parse(z.string().min(1).max(256),owner);parse(z.string().regex(/^[a-f0-9]{64}$/),session)
    if(epoch!==this.controlEpoch)throw new HttpError(410,'控制连接已更换，旧授权失效','vault_control_changed')
    this.authorize(owner,session)
    const body=parse(z.object({id:z.string().uuid(),revision:z.number().int().positive()}).strict(),value)
    const entry=this.store.list(owner).find(e=>e.id===body.id)
    if(!entry||entry.target.kind!=='ssh')throw new HttpError(403,'请选择当前账号的 SSH 凭据','vault_credential_forbidden')
    if(entry.revision!==body.revision)throw new HttpError(409,'凭据已变化，请刷新','vault_revision_conflict')
    if(entry.target.hostKey)return entry // A known identity is never replaced by a network probe.
    if(!this.executor?.prepareSshHost)throw new HttpError(409,'凭据执行器暂时不可用','vault_executor_not_enabled')
    if(this.hostPreparations.size>=64)throw new HttpError(429,'服务器连接检查过多，请稍后重试','vault_probe_limit')
    const controller=new AbortController(),generation=this.epochs.get(owner)??0
    const signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal
    this.hostPreparations.set(controller,owner)
    try{
      signal.throwIfAborted()
      const hostKey=await this.executor.prepareSshHost(entry.target,signal)
      signal.throwIfAborted();this.executor.assertAvailable?.();this.authorize(owner,session)
      if(epoch!==this.controlEpoch||generation!==(this.epochs.get(owner)??0))throw new HttpError(410,'服务器确认已取消，请重新授权','vault_scope_forbidden')
      this.hostPreparations.delete(controller)
      const result=this.store.update(owner,entry.id,{name:entry.name,username:entry.username,target:{...entry.target,hostKey},revision:entry.revision})
      this.audit(owner,'trust-host',entry.id);return result
    }catch(error){
      if(error instanceof HttpError)throw error
      throw new HttpError(409,'服务器确认未完成，请重新解锁并授权','vault_host_probe_failed')
    }finally{this.hostPreparations.delete(controller)}
  }
  dispatch(epoch: string, owner: string, session: string, command: string, value: unknown): unknown {
    parse(z.string().min(1).max(256), owner); parse(z.string().regex(/^[a-f0-9]{64}$/), session)
    if (epoch !== this.controlEpoch) throw new HttpError(410, '控制连接已更换，旧授权失效', 'vault_control_changed')
    if (command === 'status') return this.status(owner, session)
    if (command === 'initialize') { const body = parse(z.object({ password: z.string() }).strict(), value); this.store.initialize(owner, body.password); this.audit(owner, 'initialize'); return this.status(owner, session) }
    if (command === 'restore') {
      const b = parse(z.object({ archive: z.string(), password: z.string() }).strict(), value)
      this.store.restore(owner, b.archive, b.password); this.audit(owner, 'restore'); return this.status(owner, session)
    }
    if (command === 'unlock') {
      const b = parse(z.object({ password: z.string(), seconds: z.number().int().min(30).max(900).default(300) }).strict(), value)
      try { this.store.unlock(owner, b.password, b.seconds); this.sessions.set(owner, session); this.audit(owner, 'unlock') }
      catch (e) { this.audit(owner, 'unlock', undefined, 'denied'); throw e }
      return this.status(owner, session)
    }
    if (command === 'logout') { if (this.sessions.get(owner) === session) { this.store.lock(owner); this.sessions.delete(owner); this.audit(owner, 'logout') }; return { ok: true } }
    if (command === 'lock') { this.store.lock(owner); this.sessions.delete(owner); this.revokeOwner(owner); this.audit(owner, 'lock'); return { ok: true } }
    if (command === 'revoke-work') {
      const b = parse(z.object({ workId: z.string().uuid() }).strict(), value)
      for (const [id, l] of this.leases) if (l.owner === owner && l.workId === b.workId) this.revoke(id)
      this.audit(owner, 'revoke-work', b.workId); return { ok: true }
    }
    this.authorize(owner, session)
    if (command === 'add') { const e = this.store.add(owner, value); this.audit(owner, 'add', e.id); return e }
    if (command === 'update') { const b = parse(z.object({ id: z.string().uuid(), entry: z.unknown() }).strict(), value); const e = this.store.update(owner, b.id, b.entry); this.audit(owner, 'update', e.id); return e }
    if (command === 'remove') { const b = parse(z.object({ id: z.string().uuid() }).strict(), value); this.store.remove(owner, b.id); this.audit(owner, 'remove', b.id); return { ok: true } }
    if (command === 'backup') { this.audit(owner, 'backup'); return { archive: this.store.backup(owner) } }
    if (command === 'rotate') { const b = parse(z.object({ password: z.string() }).strict(), value); this.store.rotate(owner, b.password); this.audit(owner, 'rotate'); return { ok: true } }
    if (command === 'grant') {
      const b = parse(leaseInput, value)
      if(b.command!==undefined||b.timeoutSeconds!==undefined)throw new HttpError(403,'请先将 SSH 凭据授权给指定 Bot','vault_usage_forbidden')
      const entry = this.store.list(owner).find(e => e.id === b.credentialRef)
      if (!entry || JSON.stringify(entry.target) !== JSON.stringify(b.target) || (entry.target.kind === 'website') !== (b.operation === 'website.login'))
        throw new HttpError(403, '凭据目标或操作不匹配', 'vault_target_forbidden')
      if(entry.usage&&(entry.usage.kind==='website.form'?'website.login':entry.usage.kind)!==b.operation)throw new HttpError(403,'操作不属于用户批准的凭据使用计划','vault_usage_forbidden')
      if(entry.target.kind==='ssh'&&!entry.target.hostKey)throw new HttpError(409,'首次使用前需要确认 SSH 服务器','vault_host_key_required')
      if ([...this.leases.values()].filter(l => l.owner === owner).length >= 64) throw new HttpError(429, '任务授权数量已达到上限', 'vault_lease_limit')
      const { seconds: _seconds, target: _target, runnerInstance: _instance, runnerEpoch: _epoch, ...publicInput } = b
      const result: CredentialLeaseSummary = { ...publicInput, id: randomUUID(), expiresAt: Math.min(this.now() + b.seconds * 1000, this.store.state(owner).unlockExpiresAt!) }
      this.leases.set(result.id, { ...result, owner, session, version: entry.revision, target: entry.target, runnerInstance: b.runnerInstance,
        runnerEpoch: b.runnerEpoch, epoch: this.epochs.get(owner) ?? 0, consumed: false, controller: new AbortController() })
      this.audit(owner, 'grant', result.id); return result
    }
    if (command === 'revoke') {
      const b = parse(z.object({ id: z.string().uuid() }).strict(), value)
      if (this.leases.get(b.id)?.owner !== owner) throw new HttpError(404, '授权不存在', 'vault_lease_missing')
      this.revoke(b.id); this.audit(owner, 'revoke', b.id); return { ok: true }
    }
    throw new HttpError(404, '密码库操作不存在', 'vault_command_unknown')
  }
  async execute(epoch: string, owner: string, session: string, id: string, input: LeaseInput) {
    const b = parse(leaseInput, input), l = this.leases.get(id)
    const check = () => {
      if (epoch !== this.controlEpoch || !l || this.leases.get(id) !== l || l.owner !== owner || l.epoch !== (this.epochs.get(owner) ?? 0)
        || l.expiresAt <= this.now() || l.controller.signal.aborted) throw new HttpError(410, '凭据任务授权已失效', 'vault_lease_revoked')
      this.authorize(owner, l.session)
      if (session !== l.session) throw new HttpError(403, '执行请求不属于解锁会话', 'vault_scope_forbidden')
      if (['agentId', 'workId', 'runnerId', 'runnerInstance', 'runnerEpoch', 'credentialRef', 'operation'].some(k => l[k as keyof Lease] !== b[k as keyof LeaseInput])
        || JSON.stringify(l.target) !== JSON.stringify(b.target)) throw new HttpError(403, '凭据任务范围不匹配', 'vault_scope_forbidden')
      const entry = this.store.list(owner).find(e => e.id === l.credentialRef)
      if (entry?.revision !== l.version) throw new HttpError(410, '凭据版本已变化', 'vault_lease_revoked')
    }
    check()
    if (!this.executor) throw new HttpError(409, '受保护的浏览器与 SSH 执行器尚未启用，请人工接管', 'vault_executor_not_enabled')
    this.executor.assertAvailable?.()
    if (l!.consumed) throw new HttpError(409, '此授权已提交，不能重复执行', 'vault_operation_uncertain')
    l!.consumed = true
    this.audit(owner, 'execute-started', id)
    try {
      const result=await this.store.withSecret(owner, l!.credentialRef, entry => this.executor!.execute(entry, b, l!.controller.signal))
      check()
      if(result===undefined&&['protected-adapters','local-adapters'].includes(this.executor.mode??''))throw new Error('credential executor receipt missing')
      const receipt:CredentialExecutionReceipt=result===undefined?{status:'complete',operation:b.operation}:parse(z.union([
        z.object({status:z.literal('complete'),operation:leaseInput.shape.operation,exitCode:z.number().int().optional(),bytes:z.number().int().nonnegative().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),
        z.object({status:z.literal('manual_takeover_required'),reason:z.enum(['unsupported_form_flow','usage_policy_required']),submitted:z.boolean()}).strict(),
      ]),result)
      if(receipt.status==='complete'&&receipt.operation!==b.operation)throw new Error('receipt scope changed')
      this.audit(owner, receipt.status==='complete'?'execute-complete':'execute-manual', id)
      return receipt // No raw executor output, URL, exception, Cookie or secret.
    } catch(error) {
      this.audit(owner, 'execute-ended', id, 'not-confirmed')
      if(error instanceof HttpError&&['vault_host_key_rejected','vault_host_key_required','vault_usage_forbidden','vault_isolation_required'].includes(error.code))throw error
      throw new HttpError(409, '操作结果未确认，授权不再允许重试，请人工核对', 'vault_operation_uncertain')
    } finally { this.revoke(id) }
  }
  connectionClosed(owner:string,session:string,id:string){const l=this.leases.get(id);if(l?.owner===owner&&l.session===session)this.revoke(id)}
}
