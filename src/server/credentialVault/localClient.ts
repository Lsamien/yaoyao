import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { CredentialVaultClient } from './transport.js'
import { CredentialVaultStore } from './store.js'
import { CredentialVaultBroker } from './broker.js'
import { HttpError } from '../errors.js'
import { acquireServiceInstance } from '../serviceInstance.js'
import { LocalCredentialExecutor } from './localExecutor.js'
import { z } from 'zod'
import { parse, leaseInput, updateInput,sshCommand,sshTimeout } from './schema.js'
import { BotCredentialAccess } from './botAccess.js'

/** Default encrypted vault with task-scoped execution in the trusted server. */
export class LocalCredentialVaultClient extends CredentialVaultClient {
  private readonly controlEpoch = randomUUID()
  private broker?: Promise<CredentialVaultBroker>
  private instance?: ReturnType<typeof acquireServiceInstance>
  private executor?: LocalCredentialExecutor
  private closed = false
  private botAccess?: BotCredentialAccess

  constructor(private readonly home: string, private readonly testCA?: Buffer) { super() }
  override get configured(): boolean { return true }
  override get executionLocation(): 'server' { return 'server' }

  override async call(owner: string, session: string, command: string, value?: unknown): Promise<any> {
    if (this.closed) throw new HttpError(503, '密码保险箱已关闭', 'vault_offline')
    this.broker ??= CredentialVaultStore.create(join(this.home, 'credential-vault')).then(store => {
      if (this.closed) throw new Error('closed')
      this.instance = acquireServiceInstance(store.root, 'credential-vault-v1')
      this.executor = new LocalCredentialExecutor(join(store.root, 'executor'), this.testCA)
      this.botAccess = new BotCredentialAccess(join(store.root,'bot-access'))
      const broker = new CredentialVaultBroker(store, Date.now, this.executor)
      broker.hello(this.controlEpoch)
      return broker
    }).catch(() => {
      this.botAccess?.close();this.botAccess=undefined
      this.executor?.close(); this.executor = undefined
      this.instance?.release(); this.instance = undefined
      this.broker = undefined
      throw new HttpError(503, '无法打开本机密码保险箱，请检查数据目录权限或是否已被其他服务使用', 'vault_offline')
    })
    const broker = await this.broker
    if (this.closed) throw new HttpError(503, '密码保险箱已关闭', 'vault_offline')
    try {
      if(command==='bot-refs')return this.botAccess!.summaries(owner,parse(z.object({agentId:z.string().uuid().optional()}).strict(),value??{}).agentId)
      if(command==='bot-grant'||command==='bot-revoke'){
        if(!broker.status(owner,session).unlocked)throw new HttpError(423,'请先解锁管理界面','vault_locked')
        const b=parse(z.object({credentialRef:z.string().uuid(),agentId:z.string().uuid()}).strict(),value)
        if(command==='bot-revoke'){this.botAccess!.revoke(owner,b.credentialRef,b.agentId);broker.recordBotAction(owner,'bot-revoke',b.credentialRef);return {ok:true}}
        const entry=broker.store.list(owner).find(e=>e.id===b.credentialRef)
        if(!entry||entry.target.kind!=='ssh'&&!entry.usage)throw new HttpError(403,'凭据不存在或尚未配置网站使用计划','vault_usage_forbidden')
        broker.store.withSecret(owner,b.credentialRef,e=>this.botAccess!.grant(owner,b.agentId,e))
        try{broker.recordBotAction(owner,'bot-grant',b.credentialRef)}catch(error){this.botAccess!.revoke(owner,b.credentialRef,b.agentId);throw error}
        return {ok:true}
      }
      if(command==='update'){
        if(!broker.status(owner,session).unlocked)throw new HttpError(423,'请先解锁管理界面','vault_locked')
        const b=parse(z.object({id:z.string().uuid(),entry:updateInput}).strict(),value)
        const old=broker.store.list(owner).find(e=>e.id===b.id)
        const changedEndpoint=old?.target.kind==='ssh'&&b.entry.target.kind==='ssh'&&(old.target.host!==b.entry.target.host||old.target.port!==b.entry.target.port)
        // An automatic pin belongs to an endpoint, not to a credential's name.
        if(changedEndpoint&&old?.target.kind==='ssh'&&b.entry.target.kind==='ssh'&&b.entry.target.hostKey===old.target.hostKey)delete b.entry.target.hostKey
        const preservePin=old?.target.kind==='ssh'&&b.entry.target.kind==='ssh'&&!changedEndpoint&&!old.target.hostKey&&!b.entry.target.hostKey
        try{
          const result=broker.dispatch(this.controlEpoch,owner,session,command,b)
          broker.store.withSecret(owner,b.id,e=>this.botAccess!.refresh(owner,e,!!preservePin))
          return result
        }catch(error){
          // Validation conflicts leave approval intact; uncertain writes cannot use old material.
          if(!(error instanceof HttpError))this.botAccess!.revoke(owner,b.id)
          throw error
        }
      }
      if(command==='remove'){
        const id=parse(z.object({id:z.string().uuid()}).passthrough(),value).id
        // Invalidate before mutation, including a partially committed write.
        if(broker.status(owner,session).unlocked)this.botAccess!.revoke(owner,id)
      }
      const result = command === 'execute'
        ? await (() => { const body = parse(z.object({ id: z.string().uuid(), input: leaseInput }).strict(), value); return broker.execute(this.controlEpoch, owner, session, body.id, body.input) })()
        : command === 'prepare-host' ? await broker.prepareHost(this.controlEpoch,owner,session,value)
        : broker.dispatch(this.controlEpoch, owner, session, command, value)
      return ['status', 'initialize', 'unlock', 'restore'].includes(command)
        ? { ...(result as object), storageMode: 'local', botGrants:this.botAccess!.summaries(owner) }
        : result
    } catch (error) {
      if (error instanceof HttpError) throw error
      broker.disconnect()
      this.onDisconnect()
      throw new HttpError(409, '密码保险箱操作未完成，请刷新状态后重新解锁', 'vault_request_failed')
    }
  }

  async executeBot(owner:string,input:unknown,signal:AbortSignal){
    const b=parse(leaseInput,input)
    if(b.command!==undefined)parse(sshCommand,b.command);if(b.timeoutSeconds!==undefined)parse(sshTimeout,b.timeoutSeconds)
    await this.call(owner,'','bot-refs',{agentId:b.agentId}) // Initialize the local broker without unlocking management.
    const broker=await this.broker!
    let submitted=false
    try{return await this.botAccess!.execute(owner,b.agentId,b.credentialRef,signal,async(entry,activeSignal)=>{
      const operation=entry.usage?.kind==='website.form'?'website.login':entry.usage?.kind
      const autonomous=entry.target.kind==='ssh'&&b.operation==='ssh.exec'
      const requestedTarget=b.target.kind==='ssh'&&!b.target.hostKey&&entry.target.kind==='ssh'?{...b.target,...(entry.target.hostKey?{hostKey:entry.target.hostKey}:{})}:b.target
      if((!autonomous&&operation!==b.operation)||!isDeepStrictEqual(entry.target,requestedTarget)||(!autonomous&&(b.command!==undefined||b.timeoutSeconds!==undefined)))throw new HttpError(403,'操作不属于已授权的使用计划','vault_usage_forbidden')
      if(autonomous)parse(sshCommand,b.command??(entry.usage?.kind==='ssh.exec'?entry.usage.command:undefined))
      if(entry.target.kind==='ssh'&&!entry.target.hostKey){
        const hostKey=await this.executor!.prepareSshHost(entry.target,activeSignal)
        activeSignal.throwIfAborted()
        entry=this.botAccess!.pinSshHost(owner,b.agentId,entry.id,entry.revision,hostKey)
      }
      broker.recordBotAction(owner,'bot-execute-started',b.credentialRef)
      submitted=true
      const receipt=await (autonomous?this.executor!.executeAutonomous(entry,{...b,target:entry.target},activeSignal):this.executor!.execute(entry,{...b,target:entry.target},activeSignal))
      const result=parse(z.union([
        z.object({status:z.literal('complete'),operation:z.literal('ssh.exec'),exitCode:z.number().int(),stdout:z.string().max(65536),stderr:z.string().max(65536),truncated:z.boolean()}).strict(),
        z.object({status:z.literal('complete'),operation:leaseInput.shape.operation,exitCode:z.number().int().optional(),bytes:z.number().int().nonnegative().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),
        z.object({status:z.literal('manual_takeover_required'),reason:z.enum(['unsupported_form_flow','usage_policy_required']),submitted:z.boolean()}).strict(),
      ]),receipt)
      if(result.status==='complete'&&result.operation!==b.operation)throw new Error('receipt scope changed')
      broker.recordBotAction(owner,'bot-execute-complete',b.credentialRef)
      return result
    })}catch(error){
      if(error instanceof HttpError&&['vault_bot_forbidden','vault_scope_forbidden','vault_usage_forbidden','vault_host_key_rejected','vault_host_key_required'].includes(error.code))throw error
      if(!submitted)throw error
      broker.recordBotAction(owner,'bot-execute-ended',b.credentialRef,'not-confirmed')
      throw new HttpError(409,'操作结果未确认，请人工核对，不能自动重试','vault_operation_uncertain')
    }
  }
  revokeBot(owner:string,credentialRef:string,agentId:string){this.botAccess?.revoke(owner,credentialRef,agentId)}

  override close(): void {
    this.closed = true
    void this.broker?.then(broker => {
      try { broker.close() } finally { this.botAccess?.close();this.botAccess=undefined;this.executor?.close(); this.executor = undefined; this.instance?.release(); this.instance = undefined }
    }).catch(() => {})
  }
}

export function createCredentialVaultClient(config: ConstructorParameters<typeof CredentialVaultClient>[0], home: string) {
  // An unavailable explicit deployment must never fall back to a different vault.
  return config ? new CredentialVaultClient(config) : new LocalCredentialVaultClient(home)
}
