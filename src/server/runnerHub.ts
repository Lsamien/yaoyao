import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import Router from '@koa/router'
import type Koa from 'koa'
import {createReadStream,existsSync} from 'node:fs'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { parse, type WorkspaceStore } from './workspaceStore.js'
import type { LocalAuthStore } from './localAuth.js'
import type { GatewayFrame, GatewayTarget } from './workspaceGateway.js'
import type { UpstreamRequestOptions, UpstreamResponse } from './upstream.js'
import type { LeaseInput, WorkspaceToolLease } from './workspaceToolLease.js'
import { RUNNER_PROTOCOL, type RunnerCommand, type RunnerRecord } from '../shared/runner.js'
import {ComposeDesktops} from './composeDesktops.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const runnerBundle=()=>[resolve(dirname(fileURLToPath(import.meta.url)),'runner-bundle.tar.gz'),resolve(dirname(fileURLToPath(import.meta.url)),'../../runner-bundle.tar.gz')].find(existsSync)
const input = z.object({ name:z.string().trim().min(1).max(100),sourceNodeId:z.string().min(1).max(100).default('local'),
  allowedProfiles:z.array(z.string().min(1).max(100)).min(1).max(256) }).strict()
interface Pending { command:RunnerCommand; resolve(value:any):void; reject(error:Error):void; timer:ReturnType<typeof setTimeout>; nextDelivery:number; valid():boolean }
interface GatewayConnection { runnerId:string;computer?:{environmentId:string;ownerKey:string;agentId:string};cleanupOnly?:boolean;publishArtifact?:(name:string,bytes:Buffer)=>Promise<unknown>; valid():boolean; onEvent(frame:GatewayFrame):void; onDisconnect():void }
interface Lease { runnerId:string; input:LeaseInput; calls:Map<string,{fingerprint:string;result:Promise<unknown>}> }

/** Outbound-only machine transport. Browser auth and machine auth remain separate. */
export class RunnerHub {
  composeDesktops=new ComposeDesktops([])
  get idleForUpdate(): boolean { return this.localVmActivity.size === 0 && [...this.pending.values()].every(commands => commands.size === 0) && [...this.artifacts.values()].every(upload => upload.result !== undefined) }
  private localVmActivity = new Map<string, { owner: string; runnerId: string }>()
  private localVmChecks = new Set<string>()
  controlAllowed:(id:string,runnerId:string)=>boolean=()=>false
  readonly epoch=randomUUID()
  private online = new Map<string,{instance:string;seen:number;epoch:string;features:string[];wake?:()=>void}>()
  private retired = new Map<string,Set<string>>()
  private pending = new Map<string,Map<string,Pending>>()
  private connections = new Map<string,GatewayConnection>()
  private artifacts=new Map<string,{runnerId:string;connectionId:string;name:string;size:number;digest:string;chunks:Buffer[];bytes:number;next:number;result?:unknown}>()
  private leases = new Map<string,Lease>()
  private watchdog: ReturnType<typeof setInterval>
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly local:GatewayTarget) {
    for (const grant of store.list<{ owner: string; runnerId: string; expiresAt: number }>('_system', 'local-vm-grant'))
      if (grant.expiresAt > Date.now()) this.localVmActivity.set(`${grant.owner}:${grant.runnerId}`, { owner: grant.owner, runnerId: grant.runnerId })
    this.watchdog=setInterval(()=>{
      for(const [id,state] of this.online) if(Date.now()-state.seen>35_000)this.disconnect(id)
      for(const [id,upload] of this.artifacts)if(!this.connections.has(upload.connectionId))this.artifacts.delete(id)
      for (const [key, activity] of this.localVmActivity) {
        if (this.localVmChecks.has(key) || !this.online.has(activity.runnerId)) continue
        this.localVmChecks.add(key)
        void this.request(activity.runnerId, 'local-vm.manage', { op: 'status', owner: hash(activity.owner) }, () => this.store.get<RunnerRecord>('_system', 'runner', activity.runnerId)?.enabled === true)
          .then(result => { if (result.busy === false && this.localVmActivity.get(key) === activity) this.localVmActivity.delete(key) })
          .catch(() => {}).finally(() => this.localVmChecks.delete(key))
      }
    },5000);this.watchdog.unref()
  }
  localVmAllowed:(id:string,runnerId:string)=>boolean=()=>false
  async localVm(owner:string,id:string,payload:Record<string,unknown>){
    const record=this.store.require<RunnerRecord>('_system','runner',id),version=this.auth.pushAuthorizationVersion(owner)
    if(!record.enabled||!this.online.get(id)?.features.includes('local-vm-v1'))throw new HttpError(409,'本地虚拟机执行环境离线或版本过旧，请重新连接或更新','local_vm_unavailable')
    const valid=()=>this.auth.isAdminActive(owner)&&this.auth.pushAuthorizationVersion(owner)===version&&this.store.get<RunnerRecord>('_system','runner',id)?.enabled===true
    if(!valid())throw new HttpError(403,'本地虚拟机设置需要管理员权限','admin_required')
    const key = `${owner}:${id}`
    if (payload.op === 'prepare') this.localVmActivity.set(key, { owner, runnerId: id })
    const activity = this.localVmActivity.get(key)
    const result=await this.request(id,'local-vm.manage',{...payload,owner:hash(owner)},valid)
    if(!valid())throw new HttpError(403,'本地虚拟机设置授权已失效','admin_required')
    if (payload.op === 'status' && result.busy === false && this.localVmActivity.get(key) === activity) this.localVmActivity.delete(key)
    else if (payload.op === 'status' && result.busy === true && !activity) this.localVmActivity.set(key, { owner, runnerId: id })
    return result
  }
  records():RunnerRecord[] {return this.store.list('_system','runner')}
  enroll(owner:string,value:unknown) {
    const body=parse(input,value)
    body.allowedProfiles=this.auth.validateAssignedProfiles(body.allowedProfiles)
    if(body.sourceNodeId!=='local'&&this.store.require<import('./workspaceGateway.js').WorkspaceNode>(owner,'node',body.sourceNodeId).transport==='paired-web')throw new HttpError(409,'配对 Web 节点应在它自己的服务中注册 Runner','runner_source_invalid')
    const sourceOwner=body.sourceNodeId==='local'?'_system':owner
    if(this.records().some(r=>r.enabled&&r.sourceOwner===sourceOwner&&r.sourceNodeId===body.sourceNodeId))
      throw new HttpError(409,'该来源已有执行节点，请先停用原节点','runner_source_in_use')
    const token=randomBytes(32).toString('base64url')
    const record:RunnerRecord={...body,id:randomUUID(),sourceOwner,tokenHash:hash(token),enabled:true,createdAt:Date.now()}
    this.store.put('_system','runner',record.id,record)
    return {runner:this.summary(record),token}
  }
  summary(record:RunnerRecord) {
    const {tokenHash:_secret,sourceOwner:_owner,...publicRecord}=record
    return {...publicRecord,features:this.online.get(record.id)?.features??[],online:!!this.online.get(record.id)&&Date.now()-this.online.get(record.id)!.seen<35_000}
  }
  remove(id:string) {
    const record=this.store.require<RunnerRecord>('_system','runner',id)
    record.enabled=false;this.store.put('_system','runner',id,record);this.disconnect(id)
  }
  private disconnect(id:string) {
    this.online.get(id)?.wake?.();this.online.delete(id)
    for(const [key,connection] of this.connections) if(connection.runnerId===id){this.connections.delete(key);connection.onDisconnect()}
    for(const [key,lease] of this.leases) if(lease.runnerId===id)this.leases.delete(key)
    for(const pending of this.pending.get(id)?.values()??[]){clearTimeout(pending.timer);pending.reject(new HttpError(503,'执行节点已断开，需核对原执行','runner_offline'))}
    this.pending.delete(id)
  }
  private request(id:string,kind:RunnerCommand['kind'],payload:Record<string,unknown>,valid:()=>boolean=()=>true):Promise<any> {
    if(!this.online.has(id))return Promise.reject(new HttpError(503,'执行节点未连接','runner_offline'))
    const queue=this.pending.get(id)??new Map<string,Pending>();this.pending.set(id,queue)
    if(queue.size>=64)return Promise.reject(new HttpError(429,'执行节点请求过多','runner_busy'))
    const command:RunnerCommand={id:randomUUID(),kind,payload,expiresAt:Date.now()+30000}
    const bytes=Buffer.byteLength(JSON.stringify(command))
    if(bytes>36*1024*1024)return Promise.reject(new HttpError(413,'执行命令超过传输限制','runner_payload_limit'))
    if([...queue.values()].reduce((size,p)=>size+Buffer.byteLength(JSON.stringify(p.command)),bytes)>64*1024*1024)return Promise.reject(new HttpError(429,'执行节点待传输数据过多','runner_busy'))
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{queue.delete(command.id);reject(new HttpError(504,'执行节点回应超时，请核对执行状态','runner_command_uncertain'))},30000)
      queue.set(command.id,{command,resolve,reject,timer,nextDelivery:0,valid});this.online.get(id)?.wake?.()
    })
  }
  target(owner:string,sourceNodeId:string,computer?:import('../runner/worker/gateway.js').ComputerTarget):GatewayTarget|undefined {
    const record=this.records().find(r=>r.enabled&&r.sourceNodeId===sourceNodeId&&(r.sourceOwner==='_system'||r.sourceOwner===owner))
    if(!record)return undefined
    const requireProfile=(profile:string)=>{
      if(!this.auth.canUseSource(owner,sourceNodeId,profile)||!record.allowedProfiles.includes(profile))throw new HttpError(403,'执行节点未授权这个基础 Profile','runner_profile_forbidden')
    }
    const requireComputer=()=>{
      if(computer&&this.composeDesktops.desktops.length){
        if(!this.online.get(record.id)?.features.includes('compose-desktops-v1'))throw new HttpError(409,'当前部署需要 Compose 桌面执行节点','compose_runner_required')
        const claim=this.store.get<{owner:string;runnerId:string}>('_system','compose-desktop-owner',computer.environmentId)
        if(!this.composeDesktops.desktops.some(d=>d.id===computer.environmentId)||claim?.owner!==owner||claim.runnerId!==record.id)throw new HttpError(409,'请先为机器人选择已有 Compose 共享桌面','compose_desktop_required')
      }
      if(computer&&!this.online.get(record.id)?.features.includes('computer-worker-v1'))throw new HttpError(409,'执行节点未提供隔离 Worker 能力，请检查配置或更新 Runner','computer_unavailable')
      if(computer&&computer.environmentId!==computer.agentId&&!this.online.get(record.id)?.features.includes('shared-computer-v1'))throw new HttpError(409,'执行节点不支持共享电脑，请更新 Runner','shared_computer_unavailable')
    }
    const requestHTTP=async(path:string,options:UpstreamRequestOptions={}):Promise<UpstreamResponse>=>{
      requireComputer()
      const profile=options.search?.get('profile')??'default'
      if(path!=='/api/profiles'&&path!=='/api/status')requireProfile(profile)
      const version=this.auth.pushAuthorizationVersion(owner)
      const valid=()=>this.auth.isUserActive(owner)&&this.auth.pushAuthorizationVersion(owner)===version&&this.store.get<RunnerRecord>('_system','runner',record.id)?.enabled===true
      const result=await this.request(record.id,'http',{path,method:options.method??'GET',search:options.search?.toString(),body:options.body,computer},valid)
      if(!valid())throw new HttpError(403,'读取权限已失效','runner_authorization_revoked')
      if(path==='/api/profiles') {
        const parsed=JSON.parse(Buffer.from(result.body,'base64').toString())
        parsed.profiles=(parsed.profiles??[]).filter((p:any)=>{const name=typeof p==='string'?p:p.name;return record.allowedProfiles.includes(name)&&this.auth.canUseSource(owner,sourceNodeId,name)})
        result.body=Buffer.from(JSON.stringify(parsed)).toString('base64')
      }
      return {status:result.status,headers:new Headers(result.headers),body:Buffer.from(result.body,'base64')}
    }
    return {url:this.local.url,client:this.local.client,session:{request:requestHTTP,webSocketCredential:async()=>{throw new Error('Runner uses its own authenticated gateway')}},
      runner:{id:record.id,computer:!!computer,helperRetirement:this.online.get(record.id)?.features.includes('helper-retirement-v1')===true,
        open:async(onEvent,onDisconnect,scope)=>{
          requireComputer()
          if(computer&&!scope)throw new HttpError(403,'隔离执行缺少任务授权','computer_scope_required')
          const version=this.auth.pushAuthorizationVersion(owner)
          const valid=()=>{try{scope?.authorize();return (scope?.cleanupOnly||(this.auth.isUserActive(owner)&&this.auth.pushAuthorizationVersion(owner)===version))&&this.store.get<RunnerRecord>('_system','runner',record.id)?.enabled===true}catch{return false}}
          const id=randomUUID();this.connections.set(id,{runnerId:record.id,computer,valid,onEvent,onDisconnect,publishArtifact:scope?.publishArtifact,cleanupOnly:scope?.cleanupOnly})
          try {await this.request(record.id,'gateway.open',{connectionId:id,computer,workId:scope?.workId,cleanupOnly:scope?.cleanupOnly})} catch(error){this.connections.delete(id);void this.request(record.id,'gateway.close',{connectionId:id}).catch(()=>{});throw error}
          let closed=false
          return {rpc:async(method,params)=>{
            if(closed)throw new Error('Runner gateway closed')
            const cleanup=['session.interrupt','session.close'].includes(method)
            if(scope?.cleanupOnly&&(!['session.resume','session.interrupt','session.close'].includes(method)||(method==='session.resume'&&params.session_id!==scope.sessionId)))throw new HttpError(403,'清理通道只能操作原绑定会话','runner_cleanup_forbidden')
            if(!cleanup&&!valid())throw new HttpError(403,'本轮执行授权已失效','runner_command_not_admitted')
            if(!scope?.cleanupOnly&&(method==='session.create'||method==='session.resume'))requireProfile(String(params.profile??'default'))
            return this.request(record.id,'gateway.rpc',{connectionId:id,method,params})
          },close:()=>{
            closed=true;this.connections.delete(id)
            for(const [key,pending] of this.pending.get(record.id)??[])if(pending.command.payload.connectionId===id){clearTimeout(pending.timer);pending.reject(new HttpError(409,'执行通道已关闭','runner_command_not_admitted'));this.pending.get(record.id)!.delete(key)}
            void this.request(record.id,'gateway.close',{connectionId:id}).catch(()=>{})
          }}
        },
        lease:async(options)=>{
          requireComputer();requireProfile(options.profile);options.assertActive()
          const id=randomUUID();this.leases.set(id,{runnerId:record.id,input:options,calls:new Map()})
          let disposed=false
          const dispose=async()=>{if(disposed)return;disposed=true;this.leases.delete(id);options.signal.removeEventListener('abort',abort);await this.request(record.id,'lease.close',{leaseId:id}).catch(()=>{})}
          const abort=()=>{void dispose()};options.signal.addEventListener('abort',abort,{once:true})
          try {
            await this.request(record.id,'lease.create',{leaseId:id,profile:options.profile,workId:options.workId,session:options.session(),catalog:options.catalog()})
            options.assertActive()
            if(options.signal.aborted)throw new Error('执行已停止')
            return {bind:async()=>{options.assertActive();await this.request(record.id,'lease.bind',{leaseId:id,session:options.session()});options.assertActive()},dispose} satisfies WorkspaceToolLease
          } catch(error){await dispose();throw error}
        },
      }}
  }
  computerRunner(owner:string,agent:import('../shared/workspace.js').WorkspaceAgent){
    const record=this.records().find(record=>record.enabled&&record.sourceNodeId===agent.nodeId&&(record.sourceOwner==='_system'||record.sourceOwner===owner))
    if(!record||!this.online.get(record.id)?.features.includes('computer-control-v1'))throw new HttpError(409,'执行节点不支持电脑查看与控制，请更新 Runner','computer_control_unavailable')
    if(this.composeDesktops.desktops.length&&!this.online.get(record.id)?.features.includes('compose-desktops-v1'))throw new HttpError(409,'当前部署需要 Compose 桌面执行节点','compose_runner_required')
    if(!record.allowedProfiles.includes(agent.profile)||!this.auth.canUseSource(owner,agent.nodeId,agent.profile))throw new HttpError(403,'电脑 Profile 未授权','computer_profile_forbidden')
    return record
  }
  sharedComputerRunner(owner:string,agent:import('../shared/workspace.js').WorkspaceAgent){const record=this.computerRunner(owner,agent);if(agent.computerEnvironmentId&&this.store.require<import('./sharedComputers.js').SharedComputer>(owner,'shared-computer',agent.computerEnvironmentId).runnerId!==record.id)throw new HttpError(409,'共享电脑的原执行节点已变化','shared_runner_changed');if(!this.online.get(record.id)?.features.includes('shared-computer-v1'))throw new HttpError(409,'执行节点不支持共享电脑，请更新 Runner','shared_computer_unavailable');return record}
  async computer(owner:string,agent:import('../shared/workspace.js').WorkspaceAgent,op:string,data:Record<string,unknown>,authorize:()=>void):Promise<any>{
    const record=agent.computerEnvironmentId?this.sharedComputerRunner(owner,agent):this.computerRunner(owner,agent),version=this.auth.pushAuthorizationVersion(owner)
    const valid=()=>{try{authorize();return this.auth.isUserActive(owner)&&this.auth.pushAuthorizationVersion(owner)===version}catch{return false}}
    const result=await this.request(record.id,'computer.control',{target:{environmentId:agent.computerEnvironmentId??agent.id,agentId:agent.id,ownerKey:hash(owner)},profile:agent.profile,op,...data},valid)
    if(!valid())throw new HttpError(403,'电脑请求授权已失效','computer_control_expired')
    return result
  }
  async retireHelper(owner:string,helper:import('../shared/workspace.js').WorkspaceAgent):Promise<void>{
    if(!helper.temporaryGoalId||!helper.archived||!helper.helperRunnerId)throw new HttpError(403,'只能清理已退役的任务助手','helper_cleanup_forbidden')
    const current=this.store.require<import('../shared/workspace.js').WorkspaceAgent>(owner,'agent',helper.id)
    if(!current.archived||current.temporaryGoalId!==helper.temporaryGoalId)throw new HttpError(409,'助手状态已改变','helper_cleanup_forbidden')
    const record=this.store.require<RunnerRecord>('_system','runner',helper.helperRunnerId)
    if(record.sourceNodeId!==helper.nodeId||(record.sourceOwner!=='_system'&&record.sourceOwner!==owner))throw new HttpError(403,'清理节点不匹配','helper_cleanup_forbidden')
    if(!this.online.get(record.id)?.features.includes('helper-retirement-v1'))throw new HttpError(503,'等待支持清理的原执行节点上线','runner_offline')
    await this.request(record.id,'computer.retire',{environmentId:helper.id,agentId:helper.id,ownerKey:hash(owner)})
  }
  adminRouter():Router {
    const router=new Router()
    router.get('/api/app/admin/runners',ctx=>{const actor=this.auth.requireAdmin(ctx);ctx.body={protocol:RUNNER_PROTOCOL,fixedDesktops:this.composeDesktops.desktops.length>0,bundleAvailable:!!runnerBundle(),runners:this.records().map(r=>this.summary(r)),sources:[{id:'local',name:'本地来源'},...this.store.list<import('./workspaceGateway.js').WorkspaceNode>(actor.id,'node').filter(n=>n.transport!=='paired-web').map(n=>({id:n.id,name:n.name}))]}})
    router.get('/api/app/admin/runners/bundle',ctx=>{this.auth.requireAdmin(ctx);const path=runnerBundle();if(!path)throw new HttpError(404,'当前服务未打包执行节点程序，请使用配套 App 或从源码构建 Runner','runner_bundle_missing');ctx.set('Cache-Control','no-store');ctx.attachment('yaoyao-runner.tar.gz');ctx.type='application/gzip';ctx.body=createReadStream(path)})
    router.post('/api/app/admin/runners',ctx=>{const actor=this.auth.requireAdmin(ctx);ctx.body=this.enroll(actor.id,(ctx.request as any).body);ctx.status=201})
    router.delete('/api/app/admin/runners/:id',ctx=>{this.auth.requireAdmin(ctx);this.remove(ctx.params.id);ctx.body={ok:true}})
    return router
  }
  middleware():Koa.Middleware {
    return async(ctx,next)=>{
      const match=/^\/api\/runner\/v1\/([0-9a-f-]{36})\/(poll|admit|result|event|tool|check|artifact|control-check|local-vm-check|desktop)$/.exec(ctx.path)
      if(!match)return next()
      const record=this.store.get<RunnerRecord>('_system','runner',match[1]!),token=ctx.get('authorization').replace(/^Bearer /,'')
      if(ctx.get('origin')||!record?.enabled||!ctx.get('authorization').startsWith('Bearer ')||!timingSafeEqual(Buffer.from(record.tokenHash),Buffer.from(hash(token))))
        throw new HttpError(403,'执行节点授权无效','runner_unauthorized')
      const instance=ctx.get('x-runner-instance')
      if(!/^[0-9a-f-]{36}$/.test(instance)||ctx.get('x-runner-protocol')!==String(RUNNER_PROTOCOL))throw new HttpError(409,'执行节点协议不兼容','runner_protocol_mismatch')
      let previous=this.online.get(record.id)
      if(match[2]==='poll'&&previous?.instance===instance&&ctx.get('x-runner-reset')==='1'){this.disconnect(record.id);previous=undefined}
      if(match[2]!=='poll'&&previous?.instance!==instance)throw new HttpError(409,'执行节点会话已更换','runner_instance_changed')
      if(this.retired.get(record.id)?.has(instance))throw new HttpError(409,'执行节点实例已被替换','runner_instance_retired')
      if(previous&&previous.instance!==instance){
        const retired=this.retired.get(record.id)??new Set<string>()
        if(retired.size>=256)throw new HttpError(409,'执行节点更换过于频繁，请重新注册','runner_instance_limit')
        retired.add(previous.instance);this.retired.set(record.id,retired);this.disconnect(record.id);previous=undefined
      }
      if(match[2]!=='poll'&&ctx.get('x-runner-epoch')!==previous?.epoch)throw new HttpError(409,'执行连接代次已改变','runner_epoch_changed')
      const state=this.online.get(record.id)??{instance,seen:Date.now(),features:[],epoch:`${this.epoch}:${randomUUID()}`};state.seen=Date.now();if(ctx.get('x-runner-features'))state.features=ctx.get('x-runner-features').split(',').filter(value=>['computer-worker-v1','artifact-chunks-v1','helper-retirement-v1','computer-control-v1','shared-computer-v1','local-vm-v1','image-ready-v1','compose-desktops-v1'].includes(value));this.online.set(record.id,state)
      ctx.set('Cache-Control','no-store')
      if(match[2]==='poll') {
        if(ctx.method!=='GET')throw new HttpError(405,'仅允许 GET','method_not_allowed')
        const available=()=>[...(this.pending.get(record.id)?.values()??[])].filter(p=>p.nextDelivery<=Date.now())
        if(previous&&!available().length)await new Promise<void>(resolve=>{
          const done=()=>{clearTimeout(timer);ctx.res.off('close',done);if(state.wake===done)state.wake=undefined;resolve()}
          const retry=Math.min(15000,...[...(this.pending.get(record.id)?.values()??[])].map(p=>Math.max(1,p.nextDelivery-Date.now())))
          const timer=setTimeout(done,retry);state.wake?.();state.wake=done;ctx.res.once('close',done)
        })
        if(this.online.get(record.id)!==state)throw new HttpError(409,'执行节点会话已更换','runner_instance_changed')
        let bytes=0
        const batch=available().filter(item=>{const size=Buffer.byteLength(JSON.stringify(item.command));if(bytes+size>38*1024*1024)return false;bytes+=size;return true});for(const item of batch)item.nextDelivery=Date.now()+5000
        ctx.body={epoch:state.epoch,commands:batch.map(p=>p.command)};return
      }
      if(ctx.method!=='POST')throw new HttpError(405,'仅允许 POST','method_not_allowed')
      let size=0;const chunks:Buffer[]=[]
      for await(const chunk of ctx.req){size+=chunk.length;if(size>(match[2]==='desktop'?40:16)*1024*1024)throw new HttpError(413,'执行节点响应过大','runner_payload_limit');chunks.push(Buffer.from(chunk))}
      let body:any
      try {body=JSON.parse(Buffer.concat(chunks).toString())}catch{throw new HttpError(400,'JSON 无效','invalid_json')}
      if(!body||typeof body!=='object'||Array.isArray(body))throw new HttpError(400,'请求必须是对象','invalid_json')
      if(match[2]==='desktop'){
        if(record.sourceNodeId!=='local'||record.sourceOwner!=='_system'||!state.features.includes('compose-desktops-v1'))throw new HttpError(403,'该节点不能访问 Compose 桌面','compose_desktop_forbidden')
        const {id,operation,ownerKey,...payload}=parse(z.object({id:z.string(),operation:z.enum(['list','health','frame','acquire','renew','release','execute']),ownerKey:z.string().optional()}).passthrough(),body)
        if(operation==='list'){ctx.body=await this.composeDesktops.status();return}
        const claim=this.store.get<{owner:string;runnerId:string}>('_system','compose-desktop-owner',id)
        if(!claim||claim.runnerId!==record.id||hash(claim.owner)!==ownerKey)throw new HttpError(403,'没有该共享桌面的使用权限','compose_desktop_forbidden')
        const valid=()=>this.auth.isUserActive(claim.owner)&&this.store.list<import('../shared/workspace.js').WorkspaceAgent>(claim.owner,'agent').some(a=>!a.archived&&a.computerEnvironmentId===id&&this.auth.canUseSource(claim.owner,a.nodeId,a.profile))
        const active=()=>[...this.connections.values()].some(c=>c.runnerId===record.id&&c.computer?.environmentId===id&&c.computer.ownerKey===ownerKey&&c.valid())||this.store.list<any>('_system','computer-control').some(g=>g.owner===claim.owner&&g.runnerId===record.id&&g.environmentId===id&&this.controlAllowed(g.id,record.id))
        if(operation!=='release'&&(!valid()||(!['health','frame'].includes(operation)&&!active())))throw new HttpError(403,'桌面操作缺少当前任务或接管授权','compose_desktop_forbidden')
        const result=await this.composeDesktops.call(id,operation,{...payload,owner:ownerKey})
        if(operation==='acquire'&&(!valid()||!active())){await this.composeDesktops.call(id,'release',{...result,cancel:true}).catch(()=>{});throw new HttpError(410,'桌面操作已取消','computer_control_expired')}
        ctx.body=result;return
      }
      if(match[2]==='local-vm-check'){ctx.body={allowed:typeof body.id==='string'&&this.localVmAllowed(body.id,record.id)};return}
      if(match[2]==='control-check'){ctx.body={allowed:typeof body.controlId==='string'&&this.controlAllowed(body.controlId,record.id)};return}
      if(match[2]==='artifact'){
        const value=parse(z.object({connectionId:z.string().uuid(),id:z.string().uuid(),phase:z.enum(['begin','append','finish']),name:z.string().min(1).max(240).optional(),size:z.number().int().min(0).max(25*1024*1024).optional(),digest:z.string().regex(/^[a-f0-9]{64}$/).optional(),index:z.number().int().min(0).optional(),data:z.string().max(1024*1024).optional()}).strict(),body)
        const connection=this.connections.get(value.connectionId)
        if(connection?.runnerId!==record.id||!connection.valid()||!connection.publishArtifact)throw new HttpError(403,'产物不属于当前有效任务','artifact_forbidden')
        let upload=this.artifacts.get(value.id)
        if(value.phase==='begin'){
          if(!value.name||value.size===undefined||!value.digest)throw new HttpError(400,'产物信息不完整','artifact_invalid')
          if(upload&&(upload.connectionId!==value.connectionId||upload.name!==value.name||upload.size!==value.size||upload.digest!==value.digest))throw new HttpError(409,'产物编号已用于其他内容','idempotency_conflict')
          if(!upload){
            const current=[...this.artifacts.values()]
            if(current.filter(item=>item.connectionId===value.connectionId).length>=8||current.filter(item=>item.runnerId===record.id&&item.result===undefined).reduce((sum,item)=>sum+item.size,0)+value.size>64*1024*1024)throw new HttpError(429,'待传产物过多','artifact_limit')
            upload={runnerId:record.id,connectionId:value.connectionId,name:value.name,size:value.size,digest:value.digest,chunks:[],bytes:0,next:0};this.artifacts.set(value.id,upload)
          }
        }else{
          if(!upload||upload.connectionId!==value.connectionId||upload.runnerId!==record.id)throw new HttpError(404,'产物传输不存在','artifact_missing')
          if(value.phase==='append'){
            if(value.index===undefined||value.data===undefined||upload.result!==undefined)throw new HttpError(400,'产物分块无效','artifact_invalid')
            const bytes=Buffer.from(value.data,'base64')
            if(value.index<upload.next){if(!upload.chunks[value.index]?.equals(bytes))throw new HttpError(409,'重复分块内容不一致','idempotency_conflict')}
            else{if(value.index!==upload.next||upload.bytes+bytes.length>upload.size)throw new HttpError(409,'分块顺序或大小无效','artifact_invalid');upload.chunks.push(bytes);upload.bytes+=bytes.length;upload.next++}
          }else if(upload.result===undefined){
            if(upload.bytes!==upload.size)throw new HttpError(409,'产物尚未传输完整','artifact_incomplete')
            const bytes=Buffer.concat(upload.chunks)
            if(createHash('sha256').update(bytes).digest('hex')!==upload.digest)throw new HttpError(409,'产物校验失败','artifact_digest_mismatch')
            upload.result=await connection.publishArtifact(upload.name,bytes);upload.chunks=[]
          }
        }
        ctx.body={ok:true,next:upload!.next,result:upload!.result};return
      }
      if(match[2]==='check'){const connection=this.connections.get(body.connectionId);ctx.body={allowed:connection?.runnerId===record.id&&connection.valid()};return}
      if(match[2]==='admit') {
        const pending=this.pending.get(record.id)?.get(body.id),command=pending?.command
        let allowed=!!command&&command.expiresAt>Date.now()&&pending!.valid()
        if(command?.kind==='gateway.rpc'||command?.kind==='gateway.open'){const connection=this.connections.get(String(command.payload.connectionId));allowed&&=connection?.runnerId===record.id&&(command.kind==='gateway.rpc'&&['session.interrupt','session.close'].includes(String(command.payload.method))||connection.valid())}
        if(command?.kind==='lease.create'||command?.kind==='lease.bind') {
          const lease=this.leases.get(String(command.payload.leaseId))
          try {if(lease?.runnerId!==record.id)allowed=false;else lease.input.assertActive()}catch{allowed=false}
        }
        ctx.body={allowed};return
      }
      if(match[2]==='result') {
        const waiter=this.pending.get(record.id)?.get(body.id)
        if(waiter){clearTimeout(waiter.timer);this.pending.get(record.id)!.delete(body.id);body.error?waiter.reject(new HttpError(502,String(body.error.message??'执行节点失败').slice(0,1000),String(body.error.code??'runner_error'))):waiter.resolve(body.result)}
        ctx.body={ok:true};return
      }
      if(match[2]==='event') {
        const connection=this.connections.get(body.connectionId)
        if(connection?.runnerId!==record.id)throw new HttpError(410,'执行通道已关闭','runner_connection_closed')
        if(!connection.valid()){this.connections.delete(body.connectionId);connection.onDisconnect();throw new HttpError(410,'执行通道授权已失效','runner_connection_closed')}
        if(body.closed){this.connections.delete(body.connectionId);connection.onDisconnect()}
        else if(body.frame&&typeof body.frame.type==='string')connection.onEvent(body.frame)
        ctx.body={ok:true};return
      }
      const value=parse(z.object({leaseId:z.string().uuid(),toolId:z.string().min(1).max(100),callId:z.string().min(1).max(200),arguments:z.record(z.string(),z.unknown())}).strict(),body)
      const lease=this.leases.get(value.leaseId)
      if(lease?.runnerId!==record.id)throw new HttpError(410,'工具授权已失效','runner_lease_expired')
      lease.input.assertActive()
      const fingerprint=hash(JSON.stringify([value.toolId,value.arguments]));let call=lease.calls.get(value.callId)
      if(call&&call.fingerprint!==fingerprint)throw new HttpError(409,'重复调用参数不一致','idempotency_conflict')
      if(!call){if(lease.calls.size>=128)throw new HttpError(429,'本轮工具调用已达上限','runner_call_limit');call={fingerprint,result:Promise.resolve().then(()=>lease.input.call(value.toolId,value.arguments,value.callId))};lease.calls.set(value.callId,call)}
      const result=await call.result;lease.input.assertActive();ctx.body={result}
    }
  }
  close(){clearInterval(this.watchdog);for(const id of [...this.online.keys()])this.disconnect(id)}
}
