import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import type {ComputerProvider,ComputerSpecification} from './container.js'
import {ComputerError} from './container.js'
import {DEFAULT_VM_IDLE_STOP_MINUTES} from '../../shared/localVm.js'

export interface ComputerLease {id:string;environmentId:string;ownerKey:string;holderId:string;generation:number}
type Status='free'|'idle'|'preparing'|'active'|'stopping'|'uncertain'
interface Entry {spec:ComputerSpecification;generation:number;status:Status;holders:Map<string,Active>;expiresAt:number;updatedAt:number}
interface Active {lease:ComputerLease;authorize():void;controller:AbortController;operations:Set<Promise<unknown>>;detach():void}

/** Durable lifecycle fencing with shared holders. Turns hold the same
 * environment concurrently so sharing a desktop never queues whole turns;
 * starting, stopping and reconfiguring remain exclusive and drain everyone.
 * A holder that fails or cancels only fences itself — the container is
 * stopped once the last holder leaves. */
export class ComputerPool {
  idleStopMinutes = DEFAULT_VM_IDLE_STOP_MINUTES
  private entries=new Map<string,Entry>()
  private changing=new Map<string,Promise<unknown>>()
  private ready=false
  private closing=false
  private maintenance=false
  holdMaintenance(){this.maintenance=true;let released=false;return ()=>{if(!released){released=true;this.maintenance=false}}}
  beginMaintenance({allowIdle=false}={}){
    if(this.maintenance||this.changing.size||this.rows().some(row=>row.status!=='free'&&!(allowIdle&&row.status==='idle')))throw new ComputerError('computer_busy',allowIdle?'请先停止正在使用虚拟机的任务并交还控制权，再修改虚拟机设置':'请先停止电脑任务并交还控制权，再管理镜像')
    return this.holdMaintenance()
  }
  constructor(readonly db:DatabaseSync,readonly provider:ComputerProvider,readonly limits={concurrent:2,environments:32,ttlMs:30000},readonly now=Date.now) {
    if(![limits.concurrent,limits.environments,limits.ttlMs].every(Number.isSafeInteger)||limits.concurrent<1||limits.concurrent>8||limits.environments<limits.concurrent||limits.environments>128||limits.ttlMs<1000||limits.ttlMs>120000)throw new Error('电脑资源配额无效')
    db.exec('CREATE TABLE IF NOT EXISTS computer_environments(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
  }
  private rows():Entry[]{return [...this.entries.values()]}
  private get(id:string):Entry|undefined {return this.entries.get(id)}
  /** Holders are runtime-only state; the durable row keeps the lifecycle. */
  private save(entry:Entry){entry.updatedAt=this.now();this.db.prepare('INSERT INTO computer_environments VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(entry.spec.id,JSON.stringify({spec:entry.spec,generation:entry.generation,status:entry.status,expiresAt:entry.expiresAt,updatedAt:entry.updatedAt}))}
  private load():Entry[] {
    const rows=this.db.prepare('SELECT id,value FROM computer_environments').all() as {id:string;value:string}[]
    const entries=rows.map(row=>{const parsed=JSON.parse(row.value);return {spec:parsed.spec,generation:parsed.generation,status:parsed.status,holders:new Map(),expiresAt:parsed.expiresAt,updatedAt:parsed.updatedAt} as Entry})
    for(const entry of entries)this.entries.set(entry.spec.id,entry)
    return entries
  }
  private serial<T>(id:string,action:()=>Promise<T>):Promise<T>{
    const pending=(this.changing.get(id)??Promise.resolve()).catch(()=>{}).then(action)
    this.changing.set(id,pending);void pending.finally(()=>{if(this.changing.get(id)===pending)this.changing.delete(id)}).catch(()=>{})
    return pending
  }
  /** Must run under the Runner's OS instance lock before accepting commands. */
  async recover():Promise<void>{
    if(this.ready)throw new ComputerError('computer_pool_active','运行中的资源池不能重新执行启动恢复')
    for(const entry of this.load())if(entry.status!=='free')await this.serial(entry.spec.id,()=>this.stopEntry(entry)).catch(()=>{})
    this.ready=true
  }
  status(ownerKey:string){return this.rows().filter(row=>row.spec.ownerKey===ownerKey).map(row=>({environmentId:row.spec.id,status:row.status,generation:row.generation,holderIds:[...row.holders.values()].map(active=>active.lease.holderId),expiresAt:row.expiresAt}))}
  hasHolders(ownerKey:string,environmentId:string):boolean{const entry=this.get(environmentId);return !!entry&&entry.spec.ownerKey===ownerKey&&entry.status==='active'&&entry.holders.size>0}
  private require(lease:ComputerLease,activeOnly=true):Entry {
    const entry=this.get(lease.environmentId),active=entry?.holders.get(lease.id)
    if(!entry||entry.spec.ownerKey!==lease.ownerKey||!active||active.lease.holderId!==lease.holderId||active.lease.generation!==lease.generation||entry.generation!==lease.generation||(activeOnly&&entry.status!=='active'))throw new ComputerError('computer_lease_stale','电脑控制权已改变，旧操作不能继续')
    return entry
  }
  private assert(lease:ComputerLease){
    const entry=this.require(lease),active=entry.holders.get(lease.id)!
    if(this.closing||entry.expiresAt<=this.now())throw new ComputerError('computer_lease_expired','电脑控制授权已到期')
    active.authorize()
  }
  async acquire(spec:ComputerSpecification,holderId:string,authorize:()=>void,signal?:AbortSignal):Promise<ComputerLease>{
    spec=this.provider.validateSpecification(spec)
    if(!holderId||holderId.length>256)throw new ComputerError('computer_holder_invalid','电脑任务身份无效')
    return this.serial(spec.id,async()=>{
      authorize()
      if(signal?.aborted)throw new ComputerError('computer_cancelled','操作已停止')
      if(this.maintenance)throw new ComputerError('computer_busy','执行节点正在管理镜像，请稍后重试')
      if(!this.ready||this.closing)throw new ComputerError('computer_pool_unavailable','电脑资源正在恢复或关闭')
      let entry=this.get(spec.id)
      if(entry&&(entry.spec.ownerKey!==spec.ownerKey||JSON.stringify(entry.spec)!==JSON.stringify(spec)))throw new ComputerError('computer_owner_mismatch','电脑环境归属或配置不匹配')
      const own=entry&&entry.status==='active'?[...entry.holders.values()].find(active=>active.lease.holderId===holderId):undefined
      if(own){this.assert(own.lease);return own.lease}
      // An active environment is shared: a new holder joins it without
      // touching the container or the concurrency quota.
      const joining=entry?.status==='active'
      if(!joining&&entry&&entry.status!=='free'&&entry.status!=='idle')throw new ComputerError('computer_busy','电脑正在使用或需要核对停止状态')
      const rows=this.rows()
      if((!entry&&rows.length>=this.limits.environments)||(!joining&&rows.filter(row=>row.status!=='free'&&row.spec.id!==spec.id).length>=this.limits.concurrent))throw new ComputerError('computer_quota','本地虚拟机数量已达上限，请先停止另一台桌面')
      const lease:ComputerLease={id:randomUUID(),environmentId:spec.id,ownerKey:spec.ownerKey,holderId,generation:joining?(entry as Entry).generation:(entry?.generation??0)+1}
      if(!joining){entry={spec:structuredClone(spec),generation:lease.generation,status:'preparing',holders:new Map(),expiresAt:this.now()+this.limits.ttlMs,updatedAt:this.now()};this.entries.set(spec.id,entry)}
      const holder=entry as Entry
      // This reservation is synchronous, before any provider await or next acquire.
      const abort=()=>{
        const current=this.get(spec.id)
        if(!current?.holders.has(lease.id))return
        this.removeHolder(current,lease.id)
        if(current.holders.size){this.save(current);return}
        this.invalidate(current)
        void this.serial(spec.id,()=>this.stopEntry(current)).catch(()=>{})
      }
      const active:Active={lease,authorize,controller:new AbortController(),operations:new Set(),detach:()=>signal?.removeEventListener('abort',abort)}
      holder.holders.set(lease.id,active)
      holder.expiresAt=Math.max(holder.expiresAt,this.now()+this.limits.ttlMs)
      this.save(holder)
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
      if(joining){this.assert(lease);return lease}
      const guard=()=>{const current=this.require(lease,false);if(this.closing||active.controller.signal.aborted||current.status!=='preparing'||current.expiresAt<=this.now())throw new ComputerError('computer_lease_expired','电脑启动授权已失效');authorize()}
      try{
        await this.provider.ensure(spec,guard);guard()
        holder.status='active';this.save(holder);return lease
      }catch(error){
        this.removeHolder(holder,lease.id)
        await this.stopEntry(holder).catch(()=>{});throw error
      }
    })
  }
  async configure(spec:ComputerSpecification,authorize:()=>void):Promise<void>{
    spec=this.provider.validateSpecification(spec)
    return this.serial(spec.id,async()=>{
      authorize();if(this.maintenance)throw new ComputerError('computer_busy','执行节点正在管理镜像，请稍后重试')
      if(!this.ready||this.closing)throw new ComputerError('computer_pool_unavailable','电脑资源正在恢复或关闭')
      const entry=this.get(spec.id);if(!entry)return
      if(entry.spec.ownerKey!==spec.ownerKey)throw new ComputerError('computer_owner_mismatch','电脑环境归属不匹配')
      if(JSON.stringify(entry.spec)===JSON.stringify(spec))return
      if(entry.status!=='free'&&entry.status!=='idle')throw new ComputerError('computer_busy','请先释放当前电脑，再应用新的配置')
      entry.status='stopping';entry.generation++;this.save(entry)
      try{await this.provider.remove(entry.spec);authorize();entry.spec=spec;entry.status='free';this.save(entry)}
      catch(error){entry.status='uncertain';this.save(entry);throw error}
    })
  }
  authorize(lease:ComputerLease){this.assert(lease)}
  renew(lease:ComputerLease):void{this.assert(lease);const entry=this.require(lease);entry.expiresAt=this.now()+this.limits.ttlMs;this.save(entry);void this.provider.renewFence?.(entry.spec).catch(()=>{})}
  use<T>(lease:ComputerLease,action:(context:{signal:AbortSignal;authorize():void;mayFence():boolean})=>Promise<T>):Promise<T>{
    this.assert(lease)
    const active=this.require(lease).holders.get(lease.id)!
    const pending=Promise.resolve().then(()=>{this.assert(lease);return action({signal:active.controller.signal,authorize:()=>this.assert(lease),mayFence:()=>{try{const entry=this.require(lease,false);return entry.status==='active'&&entry.holders.size<=1}catch{return false}}})}).then(value=>{this.assert(lease);return value})
    active.operations.add(pending);void pending.finally(()=>active.operations.delete(pending)).catch(()=>{})
    return pending
  }
  /** Synchronous removal of one holder; true when it was the last one. */
  private removeHolder(entry:Entry,leaseId:string):boolean{
    const active=entry.holders.get(leaseId)
    if(active){entry.holders.delete(leaseId);active.controller.abort();active.detach()}
    return entry.holders.size===0
  }
  release(lease:ComputerLease,keepRunning=false):Promise<void>{
    // Synchronous identity check, like the original fence: an already-ended
    // lease must throw immediately rather than reject after queuing.
    {const entry=this.get(lease.environmentId),active=entry?.holders.get(lease.id)
    if(!entry||!active||entry.spec.ownerKey!==lease.ownerKey||active.lease.holderId!==lease.holderId)throw new ComputerError('computer_lease_stale','电脑控制权已改变，旧操作不能继续')}
    return this.serial(lease.environmentId,async()=>{
      const entry=this.get(lease.environmentId),active=entry?.holders.get(lease.id)
      if(!entry||!active||entry.spec.ownerKey!==lease.ownerKey||active.lease.holderId!==lease.holderId)throw new ComputerError('computer_lease_stale','电脑控制权已改变，旧操作不能继续')
      // A fencing release stops without further authorization, mirroring the
      // stop path: it must proceed even after the holder's grant just lapsed.
      if(keepRunning){
        this.assert(lease)
        if(active.operations.size)throw new ComputerError('computer_busy','电脑仍有未结束操作，暂不能交出环境')
      }
      this.removeHolder(entry,lease.id)
      if(entry.holders.size){this.save(entry);return}
      if(keepRunning){
        if(this.provider.releaseFence)await this.provider.releaseFence(entry.spec,true)
        entry.status='idle';entry.generation++;entry.expiresAt=0;this.save(entry);return
      }
      this.invalidate(entry)
      await this.stopEntry(entry)
    })
  }
  definition(ownerKey:string,id:string){const entry=this.get(id);if(entry&&entry.spec.ownerKey!==ownerKey)throw new ComputerError('computer_owner_mismatch','电脑环境归属不匹配');return entry?.spec}
  async desktop(spec:ComputerSpecification,action:'create'|'start'|'stop'|'recreate'|'remove',authorize:()=>void){
    spec=this.provider.validateSpecification(spec)
    await this.serial(spec.id,async()=>{
      authorize()
      if(!this.ready||this.closing||this.maintenance)throw new ComputerError('computer_busy','本地虚拟机正在维护')
      let entry=this.get(spec.id)
      if(entry?.spec.ownerKey!==undefined&&entry.spec.ownerKey!==spec.ownerKey)throw new ComputerError('computer_owner_mismatch','虚拟机归属不匹配')
      if(entry&&!['free','idle'].includes(entry.status))throw new ComputerError('computer_busy','请先停止机器人任务并交还控制权')
      const starts=['create','start','recreate'].includes(action)
      if(starts&&this.rows().filter(row=>row.status!=='free'&&row.spec.id!==spec.id).length>=this.limits.concurrent)throw new ComputerError('computer_quota','本地虚拟机数量已达上限，请先停止另一台桌面')
      if(!entry&&!starts)return
      entry??={spec,generation:0,status:'free',holders:new Map(),expiresAt:0,updatedAt:this.now()};this.entries.set(spec.id,entry)
      entry.status='preparing';entry.generation++;this.save(entry)
      try {
        if(['stop','recreate','remove'].includes(action)) {await this.provider.stop(entry.spec);await this.provider.remove(entry.spec)}
        authorize()
        if(starts){entry.spec=spec;await this.provider.ensure(spec,authorize);entry.status='idle'}else entry.status='free'
        if(action==='remove'){this.db.prepare('DELETE FROM computer_environments WHERE id=?').run(spec.id);this.entries.delete(spec.id)}
        else this.save(entry)
      }catch(error){entry.status='uncertain';this.save(entry);throw error}
    })
  }
  async retire(ownerKey:string,id:string):Promise<ComputerSpecification|undefined>{
    return this.serial(id,async()=>{
      const entry=this.get(id);if(!entry)return
      if(entry.spec.ownerKey!==ownerKey)throw new ComputerError('computer_owner_mismatch','电脑环境归属不匹配')
      if(entry.status!=='free'&&entry.status!=='idle')throw new ComputerError('computer_busy','电脑停止状态尚未确认')
      if(entry.status==='idle')await this.provider.stop(entry.spec)
      await this.provider.remove(entry.spec)
      this.db.prepare('DELETE FROM computer_environments WHERE id=?').run(id);this.entries.delete(id)
      return entry.spec
    })
  }
  async stopHolder(ownerKey:string,id:string,holderId:string):Promise<void>{
    return this.serial(id,async()=>{
      const entry=this.get(id)
      if(!entry||entry.spec.ownerKey!==ownerKey)throw new ComputerError('computer_owner_mismatch','电脑环境归属不匹配')
      const active=[...entry.holders.values()].find(active=>active.lease.holderId===holderId)
      if(!active)return
      this.removeHolder(entry,active.lease.id)
      if(entry.holders.size)this.save(entry)
      else{this.invalidate(entry);await this.stopEntry(entry)}
    })
  }
  /** The stop fence: ends every holder, then confirms the container stopped. */
  private invalidate(expected:Entry){
    const entry=this.get(expected.spec.id)
    if(!entry||entry.status==='free')return undefined
    if(entry.status!=='stopping'){entry.generation++;entry.status='stopping';entry.expiresAt=0;this.save(entry)}
    for(const active of entry.holders.values()){active.controller.abort();active.detach()}
    entry.holders.clear()
    return entry
  }
  private async stopEntry(expected:Entry):Promise<void>{
    const entry=this.invalidate(expected)
    if(!entry)return
    try{
      await this.provider.stop(entry.spec)
      // Retire the runtime identity as well as the lease generation. A delayed
      // exec targeting the old container ID can never enter its successor.
      await this.provider.remove(entry.spec)
      entry.status='free';entry.expiresAt=0;this.save(entry)
    }catch(error){entry.status='uncertain';this.save(entry);throw error}
  }
  async expire():Promise<void>{
    for(const id of this.rows().map(entry=>entry.spec.id)){
      const entry=this.get(id)!
      if(entry.status==='idle'&&this.idleStopMinutes>0&&this.now()-entry.updatedAt>=this.idleStopMinutes*60000){this.invalidate(entry);await this.serial(id,()=>this.stopEntry(entry)).catch(()=>{});continue}
      if((entry.status==='active'||entry.status==='preparing')&&entry.expiresAt<=this.now()){
        this.invalidate(entry);await this.serial(id,()=>this.stopEntry(entry)).catch(()=>{})
        continue
      }
      // An unconfirmed stop must not block the environment forever: retry it
      // on later sweeps until the provider confirms the desktop has stopped.
      if(entry.status==='uncertain'&&this.now()-entry.updatedAt>=30000)await this.serial(id,()=>this.stopEntry(entry)).catch(()=>{})
    }
  }
  async close():Promise<void>{
    this.closing=true
    for(const entry of this.rows())if(entry.status!=='free')this.invalidate(entry)
    await Promise.allSettled(this.rows().filter(entry=>entry.status!=='free').map(entry=>this.serial(entry.spec.id,()=>this.stopEntry(this.get(entry.spec.id)!))))
    if(this.rows().some(entry=>entry.status!=='free'))throw new ComputerError('computer_stop_uncertain','尚未确认所有电脑环境已停止')
  }
}
