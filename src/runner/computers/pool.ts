import {randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import type {ComputerProvider,ComputerSpecification} from './container.js'
import {ComputerError} from './container.js'

export interface ComputerLease {id:string;environmentId:string;ownerKey:string;holderId:string;generation:number}
type Status='free'|'idle'|'preparing'|'active'|'stopping'|'uncertain'
interface Entry {spec:ComputerSpecification;generation:number;status:Status;lease?:ComputerLease;expiresAt:number;updatedAt:number}
interface Active {lease:ComputerLease;authorize():void;controller:AbortController;operations:Set<Promise<unknown>>;detach():void}

/** Durable exclusive use. A generation is invalidated before cancellation; no
 * successor is admitted until the old private environment is confirmed stopped. */
export class ComputerPool {
  private active=new Map<string,Active>()
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
  private rows():Entry[]{return (this.db.prepare('SELECT value FROM computer_environments').all() as {value:string}[]).map(row=>JSON.parse(row.value))}
  private get(id:string):Entry|undefined {const row=this.db.prepare('SELECT value FROM computer_environments WHERE id=?').get(id) as {value:string}|undefined;return row?JSON.parse(row.value):undefined}
  private save(entry:Entry){entry.updatedAt=this.now();this.db.prepare('INSERT INTO computer_environments VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(entry.spec.id,JSON.stringify(entry))}
  private serial<T>(id:string,action:()=>Promise<T>):Promise<T>{
    const pending=(this.changing.get(id)??Promise.resolve()).catch(()=>{}).then(action)
    this.changing.set(id,pending);void pending.finally(()=>{if(this.changing.get(id)===pending)this.changing.delete(id)}).catch(()=>{})
    return pending
  }
  /** Must run under the Runner's OS instance lock before accepting commands. */
  async recover():Promise<void>{
    if(this.ready)throw new ComputerError('computer_pool_active','运行中的资源池不能重新执行启动恢复')
    for(const entry of this.rows())if(entry.status!=='free')await this.serial(entry.spec.id,()=>this.stopEntry(entry)).catch(()=>{})
    this.ready=true
  }
  status(ownerKey:string){return this.rows().filter(row=>row.spec.ownerKey===ownerKey).map(row=>({environmentId:row.spec.id,status:row.status,generation:row.generation,holderId:row.lease?.holderId,expiresAt:row.expiresAt}))}
  private require(lease:ComputerLease,activeOnly=true):Entry {
    const entry=this.get(lease.environmentId)
    if(!entry||entry.spec.ownerKey!==lease.ownerKey||entry.lease?.id!==lease.id||entry.lease.holderId!==lease.holderId||entry.generation!==lease.generation||(activeOnly&&entry.status!=='active'))throw new ComputerError('computer_lease_stale','电脑控制权已改变，旧操作不能继续')
    return entry
  }
  private assert(lease:ComputerLease){
    const entry=this.require(lease),active=this.active.get(lease.id)
    if(this.closing||!active||active.controller.signal.aborted||entry.expiresAt<=this.now())throw new ComputerError('computer_lease_expired','电脑控制授权已到期')
    active.authorize()
  }
  async acquire(spec:ComputerSpecification,holderId:string,authorize:()=>void,signal?:AbortSignal):Promise<ComputerLease>{
    spec=this.provider.validateSpecification(spec)
    if(!holderId||holderId.length>256)throw new ComputerError('computer_holder_invalid','电脑任务身份无效')
    return this.serial(spec.id,async()=>{
      authorize()
      if(this.maintenance)throw new ComputerError('computer_busy','执行节点正在管理镜像，请稍后重试')
      if(!this.ready||this.closing)throw new ComputerError('computer_pool_unavailable','电脑资源正在恢复或关闭')
      let entry=this.get(spec.id)
      if(entry&&(entry.spec.ownerKey!==spec.ownerKey||JSON.stringify(entry.spec)!==JSON.stringify(spec)))throw new ComputerError('computer_owner_mismatch','电脑环境归属或配置不匹配')
      if(entry?.status==='active'&&entry.lease?.holderId===holderId&&this.active.has(entry.lease.id)){this.assert(entry.lease);return entry.lease}
      if(entry&&entry.status!=='free'&&entry.status!=='idle')throw new ComputerError('computer_busy','电脑正在使用或需要核对停止状态')
      const rows=this.rows()
      if((!entry&&rows.length>=this.limits.environments)||rows.filter(row=>row.status!=='free'&&row.spec.id!==spec.id).length>=this.limits.concurrent)throw new ComputerError('computer_quota','本地虚拟机数量已达上限，请先停止另一台桌面')
      const lease:ComputerLease={id:randomUUID(),environmentId:spec.id,ownerKey:spec.ownerKey,holderId,generation:(entry?.generation??0)+1}
      entry={spec:structuredClone(spec),lease,generation:lease.generation,status:'preparing',expiresAt:this.now()+this.limits.ttlMs,updatedAt:this.now()}
      // This reservation is synchronous, before any provider await or next acquire.
      this.save(entry)
      const abort=()=>{const current=this.get(spec.id);if(current?.lease?.id===lease.id)this.invalidate(current)}
      const active:Active={lease,authorize,controller:new AbortController(),operations:new Set(),detach:()=>signal?.removeEventListener('abort',abort)};this.active.set(lease.id,active)
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
      const guard=()=>{const current=this.require(lease,false);if(this.closing||active.controller.signal.aborted||current.status!=='preparing'||current.expiresAt<=this.now())throw new ComputerError('computer_lease_expired','电脑启动授权已失效');authorize()}
      try{
        await this.provider.ensure(spec,guard);guard()
        entry.status='active';this.save(entry);return lease
      }catch(error){await this.stopEntry(entry).catch(()=>{});throw error}
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
  async transfer(lease:ComputerLease,holderId:string,authorize:()=>void):Promise<ComputerLease>{
    return this.serial(lease.environmentId,async()=>{
      this.assert(lease);authorize()
      const active=this.active.get(lease.id)!
      if(active.operations.size)throw new ComputerError('computer_busy','电脑仍有在途操作，不能移交控制')
      const entry=this.require(lease),state=await this.provider.inspect(entry.spec)
      this.assert(lease);authorize()
      if(active.operations.size||!state?.running)throw new ComputerError('computer_busy','电脑尚未就绪，不能移交控制')
      const next:ComputerLease={...lease,id:randomUUID(),holderId,generation:entry.generation+1}
      active.detach();active.controller.abort();this.active.delete(lease.id)
      this.active.set(next.id,{lease:next,authorize,controller:new AbortController(),operations:new Set(),detach:()=>{}})
      entry.lease=next;entry.generation=next.generation;entry.expiresAt=this.now()+this.limits.ttlMs;this.save(entry)
      return next
    })
  }
  authorize(lease:ComputerLease){this.assert(lease)}
  renew(lease:ComputerLease):void{this.assert(lease);const entry=this.require(lease);entry.expiresAt=this.now()+this.limits.ttlMs;this.save(entry)}
  use<T>(lease:ComputerLease,action:(context:{signal:AbortSignal;authorize():void})=>Promise<T>):Promise<T>{
    this.assert(lease)
    const active=this.active.get(lease.id)!
    const pending=Promise.resolve().then(()=>{this.assert(lease);return action({signal:active.controller.signal,authorize:()=>this.assert(lease)})}).then(value=>{this.assert(lease);return value})
    active.operations.add(pending);void pending.finally(()=>active.operations.delete(pending)).catch(()=>{})
    return pending
  }
  release(lease:ComputerLease,keepRunning=false):Promise<void>{
    if(keepRunning)return this.serial(lease.environmentId,async()=>{
      this.assert(lease)
      const entry=this.require(lease),active=this.active.get(lease.id)!
      if(active.operations.size)throw new ComputerError('computer_busy','电脑仍有未结束操作，暂不能进入空闲状态')
      active.detach();active.controller.abort();this.active.delete(lease.id)
      entry.status='idle';entry.generation++;entry.lease=undefined;entry.expiresAt=0;this.save(entry)
    })
    const existing=this.get(lease.environmentId)
    const entry=existing&&existing.lease?.id===lease.id&&existing.spec.ownerKey===lease.ownerKey&&existing.lease.holderId===lease.holderId&&['stopping','uncertain'].includes(existing.status)?existing:this.require(lease,false)
    this.invalidate(entry)
    return this.serial(entry.spec.id,async()=>{const current=this.get(entry.spec.id)!;if(current.status==='free')return;await this.stopEntry(current)})
  }
  definition(ownerKey:string,id:string){const entry=this.get(id);if(entry&&entry.spec.ownerKey!==ownerKey)throw new ComputerError('computer_owner_mismatch','电脑环境归属不匹配');return entry?.spec}
  async desktop(spec:ComputerSpecification,action:'create'|'start'|'stop'|'recreate'|'remove',authorize:()=>void){
    spec=this.provider.validateSpecification(spec)
    await this.serial(spec.id,async()=>{
      authorize()
      if(!this.ready||this.closing||this.maintenance)throw new ComputerError('computer_busy','本地虚拟机正在维护')
      let entry=this.get(spec.id)
      if(entry?.spec.ownerKey!==undefined&&entry.spec.ownerKey!==spec.ownerKey)throw new ComputerError('computer_owner_mismatch','虚拟机归属不匹配')
      if(entry&&!['free','idle'].includes(entry.status))throw new ComputerError('computer_busy','请先停止 Agent 任务并交还控制权')
      const starts=['create','start','recreate'].includes(action)
      if(starts&&this.rows().filter(row=>row.status!=='free'&&row.spec.id!==spec.id).length>=this.limits.concurrent)throw new ComputerError('computer_quota','本地虚拟机数量已达上限，请先停止另一台桌面')
      if(!entry&&!starts)return
      entry??={spec,generation:0,status:'free',expiresAt:0,updatedAt:this.now()}
      entry.status='preparing';entry.generation++;this.save(entry)
      try {
        if(['stop','recreate','remove'].includes(action)) {await this.provider.stop(entry.spec);await this.provider.remove(entry.spec)}
        authorize()
        if(starts){entry.spec=spec;await this.provider.ensure(spec,authorize);entry.status='idle'}else entry.status='free'
        if(action==='remove')this.db.prepare('DELETE FROM computer_environments WHERE id=?').run(spec.id)
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
      this.db.prepare('DELETE FROM computer_environments WHERE id=?').run(id)
      return entry.spec
    })
  }
  async stopHolder(ownerKey:string,id:string,holderId:string):Promise<void>{
    const entry=this.get(id)
    if(!entry||entry.spec.ownerKey!==ownerKey)throw new ComputerError('computer_owner_mismatch','电脑环境归属不匹配')
    if(entry.lease?.holderId!==holderId)return
    this.invalidate(entry);await this.serial(id,()=>this.stopEntry(entry))
  }
  private invalidate(expected:Entry){
    const entry=this.get(expected.spec.id)
    if(!entry||entry.lease?.id!==expected.lease?.id||entry.status==='free')return
    if(entry.status!=='stopping'){entry.generation++;entry.status='stopping';entry.expiresAt=0;this.save(entry)}
    const active=entry.lease?this.active.get(entry.lease.id):undefined
    active?.controller.abort()
    return entry
  }
  private async stopEntry(expected:Entry):Promise<void>{
    const entry=this.invalidate(expected)
    if(!entry)return
    const active=entry.lease?this.active.get(entry.lease.id):undefined
    try{
      await this.provider.stop(entry.spec)
      // Retire the runtime identity as well as the lease generation. A delayed
      // exec targeting the old container ID can never enter its successor.
      await this.provider.remove(entry.spec)
      active?.detach();if(entry.lease)this.active.delete(entry.lease.id)
      entry.status='free';entry.lease=undefined;entry.expiresAt=0;this.save(entry)
    }catch(error){entry.status='uncertain';this.save(entry);throw error}
  }
  async expire():Promise<void>{
    for(const id of this.rows().map(entry=>entry.spec.id)){
      const entry=this.get(id)!
      if(entry.status==='idle'&&this.now()-entry.updatedAt>=300000){this.invalidate(entry);await this.serial(id,()=>this.stopEntry(entry)).catch(()=>{});continue}
      if((entry.status==='active'||entry.status==='preparing')&&entry.expiresAt<=this.now()){
        this.invalidate(entry);await this.serial(id,()=>this.stopEntry(entry)).catch(()=>{})
      }
    }
  }
  async close():Promise<void>{
    this.closing=true
    for(const entry of this.rows())if(entry.status!=='free')this.invalidate(entry)
    await Promise.allSettled(this.rows().filter(entry=>entry.status!=='free').map(entry=>this.serial(entry.spec.id,()=>this.stopEntry(this.get(entry.spec.id)!))))
    if(this.rows().some(entry=>entry.status!=='free'))throw new ComputerError('computer_stop_uncertain','尚未确认所有电脑环境已停止')
  }
}
