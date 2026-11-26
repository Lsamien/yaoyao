import Router from '@koa/router'
import { z } from 'zod'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { RunnerAgent } from '../runner/agent.js'
import { UNCONFIGURED_COMPUTER_IMAGE, type RunnerConfiguration } from '../shared/runner.js'
import type { LocalVmStatus } from '../shared/localVm.js'
import { LOCAL_VM_IMAGE_KEYS, MAX_DESKTOPS_PER_COMPUTER, MAX_VM_IDLE_STOP_MINUTES } from '../shared/localVm.js'
import type { WorkspaceAgent } from '../shared/workspace.js'
import { parse, type WorkspaceStore } from './workspaceStore.js'
import type { LocalAuthStore } from './localAuth.js'
import type { WorkspaceNodes } from './workspaceGateway.js'
import type { RunnerHub } from './runnerHub.js'
import type { SharedComputer, SharedComputers } from './sharedComputers.js'
import type { ServerConfig } from './config.js'
import { readHostTools } from './hostToolSettings.js'
import { kernelPaths } from './hermes/paths.js'
import { HttpError } from './errors.js'

interface Grant {id:string;owner:string;runnerId:string;version:number;expiresAt:number;system?:boolean}
/** Old per-Bot (or hand-made shared) computers still to be copied into the account computer. */
interface Migration {owner:string;target:string;sources:{environmentId:string;agentId:string}[];adopted:string[];done?:boolean}
const exec=promisify(execFile)

/**
 * Virtual machines, redesigned:
 * - Docker deployments never run virtual machines.
 * - Each account must be licensed by an administrator (administrators always are).
 * - One computer (container) per account; every Bot of the account gets its own
 *   desktop inside it and all of them share the workspace.
 */
export class LocalVmService {
  private url?:string
  private managed?:{agent:RunnerAgent;abort:AbortController;done:Promise<void>;warmup:Promise<void>}
  private starting?:Promise<void>
  private problem?:string
  private migrating=new Map<string,Promise<void>>()
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,
    readonly hub:RunnerHub,readonly shared:SharedComputers,readonly config:ServerConfig) {
    store.prepareAgent=(owner,agent)=>{
      // VM placement never changes where a Bot's Hermes session runs. Every local
      // Bot belongs to its account computer; only Bots with the VM enabled use it.
      const record=this.record()
      if(record)this.shared.attachLocalVm(owner,agent,record.id)
    }
  }
  get supported(){return this.config.deployment!=='docker'}
  private assertSupported(){if(!this.supported)throw new HttpError(409,'Docker 版不支持虚拟机','local_vm_docker_unsupported')}
  private assertLicensed(owner:string){
    this.assertSupported()
    if(!readHostTools(this.store.home).vm)throw new HttpError(409,'管理员已关闭虚拟机功能','local_vm_disabled')
    if(!this.auth.canUseVm(owner))throw new HttpError(403,'当前账号未开通虚拟机，请联系管理员','local_vm_unlicensed')
  }
  private usable(owner:string){try{this.assertLicensed(owner);return true}catch{return false}}
  allowed(id:string,runnerId:string){
    const grant=this.store.get<Grant>('_system','local-vm-grant',id)
    if(!grant||grant.runnerId!==runnerId||grant.expiresAt<=Date.now())return false
    if(grant.system)return true
    return this.auth.isAdminActive(grant.owner)&&this.auth.pushAuthorizationVersion(grant.owner)===grant.version
  }
  private record(){return this.hub.records().find(r=>r.enabled&&r.sourceNodeId==='local'&&r.sourceOwner==='_system')}
  private group(owner:string,runnerId:string):SharedComputer|undefined{return this.shared.reconcileLocalVmGroups(owner,runnerId)}
  /** Every account computer of this owner known to the server, current and legacy. */
  private environments(owner:string){
    const ids=new Set<string>()
    for(const group of this.store.list<SharedComputer>(owner,'shared-computer'))if(group.nodeId==='local')ids.add(group.id)
    for(const agent of this.store.list<WorkspaceAgent>(owner,'agent'))if(agent.nodeId==='local'&&!agent.remoteAgentId)ids.add(agent.computerEnvironmentId??agent.id)
    return [...ids]
  }
  /** One-time move of an account from per-Bot (or hand-made shared) computers to its
   * single account computer. Assignments change first; old data is copied by the Runner
   * when it can be (computer idle, image prepared) and is never deleted. */
  private async migrate(owner:string){
    if(!this.supported||!this.usable(owner))return
    const record=this.record()
    if(!record||!this.hub.summary(record).online||!this.hub.summary(record).features?.includes('bot-desktops-v1'))return
    let migration=this.store.get<Migration>('_system','local-vm-migration',owner)
    if(!migration){
      let retired:string[]
      try{retired=this.shared.setLocalVmMode(owner,'shared',record.id).retiredEnvironmentIds}catch{return /* busy: retried on the next check */}
      const target=this.group(owner,record.id)
      const sources=[...new Set(retired)].flatMap(environmentId=>{
        const agent=this.store.list<WorkspaceAgent>(owner,'agent').find(a=>a.id===environmentId)
          ??this.store.get<SharedComputer>(owner,'shared-computer',environmentId)?.memberIds.map(id=>this.store.get<WorkspaceAgent>(owner,'agent',id)).find(Boolean)
        return agent?[{environmentId,agentId:agent.id}]:[]
      })
      this.store.put(owner,'local-vm-preferences','local',{mode:'shared'})
      migration={owner,target:target?.id??'',sources,adopted:[],done:!target||!sources.length}
      this.store.put('_system','local-vm-migration',owner,migration)
    }
    if(migration.done||!migration.target)return
    const pending=migration.sources.filter(source=>!migration!.adopted.includes(source.environmentId))
    if(!pending.length){migration.done=true;this.store.put('_system','local-vm-migration',owner,migration);return}
    const id=randomUUID();this.grant(owner,id,record.id,true)
    const result=await this.hub.systemLocalVm(owner,record.id,{op:'adopt',id,environmentId:migration.target,sources:pending}) as {adopted?:string[]}
    const latest=this.store.get<Migration>('_system','local-vm-migration',owner)??migration
    latest.adopted=[...new Set([...latest.adopted,...(result.adopted??[])])]
    latest.done=latest.sources.every(source=>latest.adopted.includes(source.environmentId))
    this.store.put('_system','local-vm-migration',owner,latest)
  }
  private scheduleMigration(owner:string){
    if(this.migrating.has(owner))return
    const job=this.migrate(owner).catch(()=>{/* retried on the next status check or restart */}).finally(()=>this.migrating.delete(owner))
    this.migrating.set(owner,job)
  }
  private async restoreDesktops(runnerId:string,signal:AbortSignal){
    const restored=new Set<string>()
    for(const owner of this.store.owners()){
      if(signal.aborted||!readHostTools(this.store.home).vm)return
      if(!this.auth.isUserActive(owner)||!this.auth.canUseVm(owner))continue
      await this.migrate(owner).catch(()=>{})
      for(const agent of this.store.list<WorkspaceAgent>(owner,'agent')){
        const environmentId=agent.computerEnvironmentId??agent.id,key=`${owner}:${environmentId}`
        if(agent.nodeId!=='local'||agent.archived||agent.remoteAgentId||agent.temporaryGoalId||restored.has(key))continue
        const authorize=()=>{
          const current=this.store.require<WorkspaceAgent>(owner,'agent',agent.id)
          if(signal.aborted||!this.usable(owner)||current.archived||current.remoteAgentId||current.temporaryGoalId||current.nodeId!=='local'||current.profile!==agent.profile||(current.computerEnvironmentId??current.id)!==environmentId)throw new HttpError(403,'虚拟机启动授权已失效','local_vm_disabled')
          this.nodes.requireSource(owner,current)
          if(this.hub.computerRunner(owner,current).id!==runnerId)throw new HttpError(409,'虚拟机执行节点已变化','local_vm_runner_changed')
        }
        try{authorize()}catch{continue}
        restored.add(key)
        try{await this.hub.computer(owner,agent,'autostart',{},authorize)}catch{
          if(!signal.aborted)this.problem='部分已配置虚拟机未能自动启动，请检查 Docker、镜像和运行数量上限，或在电脑面板手动启动。'
        }
      }
    }
  }
  async start(url:string) {
    this.url=url
    if(!this.supported)return
    const stored=this.store.get<{sealed:string}>('_system','local-vm-managed','local')
    if(!stored||this.managed)return
    const config=this.nodes.open<RunnerConfiguration>(stored.sealed)
    if(!this.hub.records().some(r=>r.id===config.runnerId&&r.enabled))return
    config.serverURL=url
    const home=join(this.config.home,'runner-state','local-vm',config.runnerId)
    mkdirSync(home,{recursive:true,mode:0o700})
    this.problem=undefined
    const abort=new AbortController()
    let warming=false
    const agent=new RunnerAgent(config,home)
    agent.onConnected=()=>{
      // A transport reconnect must not undo a manual stop or idle expiry.
      if(!warming&&!abort.signal.aborted){
        warming=true
        state.warmup=this.restoreDesktops(config.runnerId,abort.signal).catch(()=>{if(!abort.signal.aborted)this.problem='虚拟机自动启动未完成，请在电脑面板检查状态。'})
      }
    }
    const state={agent,abort,done:Promise.resolve(),warmup:Promise.resolve()}
    this.managed=state
    state.done=agent.run(abort.signal).catch(error=>{this.problem=error instanceof Error?error.message:'本地虚拟机服务已断开'}).finally(()=>{if(this.managed===state)this.managed=undefined})
  }
  private async discover(){
    for(const runtime of ['docker','podman'] as const) {
      try {
        await exec(runtime,['--version'],{timeout:5000})
        try { await exec(runtime,['info'],{timeout:8000,maxBuffer:1024*1024});return {runtime,daemonUp:true} }
        catch{return {runtime,daemonUp:false}}
      }catch{}
    }
    return {runtime:undefined,daemonUp:false}
  }
  private async ensure(owner:string) {
    this.assertSupported()
    if(this.starting)await this.starting
    if(this.record()){
      if(this.url&&!this.managed)await this.start(this.url)
      return this.record()!
    }
    this.starting=(async()=>{
      if(!this.url)throw new HttpError(503,'本机 Web 服务尚未启动','local_vm_unavailable')
      const detected=await this.discover()
      if(!detected.runtime||!detected.daemonUp)throw new HttpError(409,'请先安装并启动 Docker 或 Podman','local_vm_runtime_required')
      const sources=await this.nodes.sources(owner)
      const allowedProfiles=[...new Set(sources.sources.filter(s=>s.nodeId==='local').map(s=>s.profile))]
      const registered=this.hub.enroll(owner,{name:'本机虚拟机',sourceNodeId:'local',allowedProfiles})
      // The virtual machine needs no host Hermes installation; the embedded kernel paths
      // are only handed over for compatibility with the Runner configuration format.
      const kernel=kernelPaths()
      const config:RunnerConfiguration={protocol:1,serverURL:this.url,runnerId:registered.runner.id,token:registered.token,
        hermesURL:this.config.upstream.origin,allowedProfiles,artifactRoots:[],computers:{runtime:detected.runtime,
          imageId:UNCONFIGURED_COMPUTER_IMAGE,python:kernel.python,hermesSource:join(kernel.root,'runtime','hermes'),hermesHome:join(this.config.home,'hermes'),maxConcurrent:2,network:'public-proxy'}}
      this.store.put('_system','local-vm-managed','local',{sealed:this.nodes.seal(config)})
      await this.start(this.url)
    })().finally(()=>{this.starting=undefined})
    await this.starting
    const record=this.record()!
    const deadline=Date.now()+8000
    while(!this.hub.summary(record).online&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100))
    return record
  }
  private grant(owner:string,id:string,runnerId:string,system=false){
    const old=this.store.get<Grant>('_system','local-vm-grant',id)
    if(old&&(old.owner!==owner||old.runnerId!==runnerId))throw new HttpError(409,'请求编号已用于其他操作','idempotency_conflict')
    this.store.put('_system','local-vm-grant',id,{id,owner,runnerId,version:this.auth.pushAuthorizationVersion(owner)??0,expiresAt:Date.now()+3600000,...(system?{system:true}:{})})
  }
  /** A revoked license stops the account's computer. Files and browser profiles stay. */
  async revokeUser(owner:string){
    const record=this.record()
    if(!record||!this.hub.summary(record).online)return
    for(const environmentId of this.environments(owner)){
      const id=randomUUID();this.grant(owner,id,record.id,true)
      await this.hub.systemLocalVm(owner,record.id,{op:'instance',id,environmentId,action:'stop'}).catch(()=>{})
    }
  }
  async status(owner:string):Promise<LocalVmStatus> {
    const unsupported={supported:false,configured:false,daemonUp:false,image:false,mode:'shared' as const,maxInstances:0,busy:false,problem:'Docker 版不支持虚拟机。需要虚拟机时，请使用 macOS App 或 npm 安装的服务端。'}
    if(!this.supported)return unsupported
    const record=this.record()
    const executionHost=record&&!this.store.get('_system','local-vm-managed','local')?'runner':'server'
    if(record){
      if(this.url&&!this.managed)await this.start(this.url)
      const summary=this.hub.summary(record)
      if(!summary.online){
        if(executionHost==='runner')return {supported:true,configured:true,executionHost,runnerName:record.name,setupRequired:'runner',daemonUp:false,image:false,mode:'shared',maxInstances:2,busy:false,problem:`执行节点「${record.name}」尚未连接，请在该电脑上启动 Runner。`}
        const detected=await this.discover()
        return {supported:true,configured:true,...detected,image:false,mode:'shared',maxInstances:2,busy:false,problem:this.problem??'本机执行环境正在连接，请稍后重新检查'}
      }
      if(!summary.features?.includes('local-vm-v1')||!summary.features?.includes('bot-desktops-v1'))return {supported:true,configured:true,executionHost,runnerName:record.name,setupRequired:'worker',daemonUp:false,image:false,mode:'shared',maxInstances:2,busy:false,problem:'执行节点已连接，但版本过旧，不支持每个机器人独立桌面。请更新配套 Runner。'}
      this.scheduleMigration(owner)
      const state=await this.hub.localVm(owner,record.id,{op:'status'}) as LocalVmStatus
      const agents=this.store.list<WorkspaceAgent>(owner,'agent'),groups=this.store.list<SharedComputer>(owner,'shared-computer')
      return {...state,supported:true,mode:'shared',problem:state.problem??this.problem,executionHost,runnerName:record.name,instances:state.instances?.map(instance=>{
        const group=groups.find(g=>g.id===instance.id&&!g.archived)
        const agent=agents.find(a=>!a.archived&&(a.computerEnvironmentId??a.id)===instance.id)
        return {...instance,name:group?'本账号的虚拟机':agent?.name??'保留的旧虚拟机',orphaned:!group&&!agent}
      })}
    }
    const detected=await this.discover()
    return {supported:true,configured:false,...detected,image:false,mode:'shared',maxInstances:2,busy:false,problem:this.problem}
  }
  /** The account computer id for a persistent local Bot, joining it on first use. */
  environmentFor(owner:string,agentId:string):string|undefined{
    const agent=this.store.get<WorkspaceAgent>(owner,'agent',agentId)
    if(!agent||agent.nodeId!=='local'||agent.temporaryGoalId||agent.remoteAgentId)return undefined
    return this.member(owner,agent).computerEnvironmentId
  }
  /** The Bot's account computer: created on first use, shared by all Bots of the account. */
  private member(owner:string,agent:WorkspaceAgent){
    if(agent.computerEnvironmentId)return agent
    const record=this.record()
    if(!record)return agent
    return this.store.atomic(()=>{
      const latest=this.store.require<WorkspaceAgent>(owner,'agent',agent.id)
      this.shared.attachLocalVm(owner,latest,record.id)
      if(latest.computerEnvironmentId){latest.revision++;latest.updatedAt=Date.now();this.store.put(owner,'agent',latest.id,latest);this.store.event(owner,'agent.changed',latest)}
      return latest
    })
  }
  router(){
    const router=new Router()
    router.get('/api/app/admin/local-vm',async ctx=>{ctx.body=await this.status(this.auth.requireAdmin(ctx).id)})
    router.post('/api/app/admin/local-vm/prepare',async ctx=>{
      const actor=this.auth.requireAdmin(ctx);this.assertSupported()
      const body=parse(z.object({requestId:z.string().uuid(),imageKey:z.enum(LOCAL_VM_IMAGE_KEYS).optional()}).strict(),(ctx.request as any).body)
      const record=await this.ensure(actor.id);this.grant(actor.id,body.requestId,record.id)
      ctx.body=await this.hub.localVm(actor.id,record.id,{op:'prepare',id:body.requestId,...(body.imageKey?{imageKey:body.imageKey}:{})})
    })
    router.put('/api/app/admin/local-vm/idle-policy',async ctx=>{
      const owner=this.auth.requireAdmin(ctx).id;this.assertSupported()
      const body=parse(z.object({requestId:z.string().uuid(),idleStopMinutes:z.number().int().min(0).max(MAX_VM_IDLE_STOP_MINUTES)}).strict(),(ctx.request as any).body)
      const record=await this.ensure(owner);this.grant(owner,body.requestId,record.id)
      ctx.body=await this.hub.localVm(owner,record.id,{op:'idle-policy',id:body.requestId,idleStopMinutes:body.idleStopMinutes})
    })
    router.put('/api/app/admin/local-vm/policy',async ctx=>{
      const owner=this.auth.requireAdmin(ctx).id;this.assertSupported()
      const body=parse(z.object({requestId:z.string().uuid(),maxInstances:z.number().int().min(1).max(8),maxDesktops:z.number().int().min(1).max(MAX_DESKTOPS_PER_COMPUTER).optional()}).strict(),(ctx.request as any).body)
      const record=await this.ensure(owner)
      this.grant(owner,body.requestId,record.id)
      await this.hub.localVm(owner,record.id,{op:'policy',id:body.requestId,maxInstances:body.maxInstances,...(body.maxDesktops?{maxDesktops:body.maxDesktops}:{})})
      ctx.body=await this.status(owner)
    })
    router.post('/api/app/admin/local-vm/instances/:id/:action',async ctx=>{
      const owner=this.auth.requireAdmin(ctx).id;this.assertSupported()
      const id=parse(z.string().uuid(),ctx.params.id),action=parse(z.enum(['stop','remove']),ctx.params.action)
      const body=parse(z.object({requestId:z.string().uuid()}).strict(),(ctx.request as any).body),record=this.record()
      if(!record)throw new HttpError(409,'本地虚拟机尚未配置','local_vm_unavailable')
      this.grant(owner,body.requestId,record.id)
      ctx.body=await this.hub.localVm(owner,record.id,{op:'instance',id:body.requestId,environmentId:id,action})
    })
    router.get('/api/app/agents/:id/local-vm',async ctx=>{
      const owner=this.auth.require(ctx).id,stored=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id)
      this.nodes.requireSource(owner,stored)
      const access={supported:this.supported,licensed:this.auth.canUseVm(owner)}
      if(!this.usable(owner)){ctx.body={enabled:false,agent:stored,...access};return}
      const agent=stored.temporaryGoalId||stored.remoteAgentId?stored:this.member(owner,stored)
      try { ctx.body={enabled:true,agent,...access,...await this.hub.computer(owner,agent,'detail',{},()=>this.nodes.requireSource(owner,agent)),mode:'shared'} }
      catch(error){ctx.body={enabled:true,agent,...access,container:'missing',ready:false,image:false,problem:error instanceof Error?error.message:'本地虚拟机不可用'}}
    })
    router.put('/api/app/agents/:id/local-vm',async ctx=>{
      const owner=this.auth.require(ctx).id,body=parse(z.object({enabled:z.boolean()}).strict(),(ctx.request as any).body)
      const agent=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id);this.nodes.requireSource(owner,agent)
      if(agent.remoteAgentId||agent.temporaryGoalId)throw new HttpError(409,'请在该机器人所属的电脑上设置虚拟机','local_vm_remote')
      if(body.enabled)this.assertLicensed(owner)
      this.shared.assertLocalVmIdle(owner,[agent.id])
      const member=body.enabled?this.member(owner,agent):agent
      ctx.body=this.store.atomic(()=>{
        this.store.updateAgent(owner,member.id,{execution:body.enabled?'computer':'profile',computer:body.enabled?'vm':'off'})
        return {agent:this.store.agentSummary(this.store.require<WorkspaceAgent>(owner,'agent',member.id))}
      })
      // Turning the VM off frees this Bot's desktop; its HOME and the shared files stay.
      if(!body.enabled&&this.usable(owner))await this.hub.computer(owner,member,'lifecycle',{action:'remove'},()=>this.nodes.requireSource(owner,member)).catch(()=>{})
    })
    router.put('/api/app/agents/:id/local-vm/image',async ctx=>{
      const owner=this.auth.require(ctx).id;this.assertLicensed(owner)
      const body=parse(z.object({imageKey:z.enum(LOCAL_VM_IMAGE_KEYS)}).strict(),(ctx.request as any).body)
      const agent=this.member(owner,this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id))
      this.nodes.requireSource(owner,agent)
      if(agent.archived||agent.remoteAgentId)throw new HttpError(409,'此机器人不能更改虚拟机镜像','local_vm_disabled')
      // The image belongs to the account computer, so every Bot of the account must be idle.
      this.shared.assertLocalVmIdle(owner,this.store.list<WorkspaceAgent>(owner,'agent').filter(a=>a.computerEnvironmentId===agent.computerEnvironmentId).map(a=>a.id))
      ctx.body=await this.hub.computer(owner,agent,'image',{imageKey:body.imageKey},()=>this.nodes.requireSource(owner,agent))
    })
    router.post('/api/app/agents/:id/local-vm/:action',async ctx=>{
      const owner=this.auth.require(ctx).id;this.assertLicensed(owner)
      const action=parse(z.enum(['create','start','stop','recreate','remove']),ctx.params.action)
      const agent=this.member(owner,this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id))
      if(agent.temporaryGoalId)throw new HttpError(409,'临时助手的虚拟机由当前任务管理','helper_task_bound')
      if(agent.archived||agent.remoteAgentId)throw new HttpError(409,'此机器人未使用本地虚拟机','local_vm_disabled')
      // Panel actions only touch this Bot's own desktop; other Bots keep working.
      this.shared.assertLocalVmIdle(owner,[agent.id])
      ctx.body=await this.hub.computer(owner,agent,'lifecycle',{action},()=>this.nodes.requireSource(owner,agent))
    })
    return router
  }
  async close(){const managed=this.managed;managed?.abort.abort();await managed?.done;await managed?.warmup;await Promise.allSettled([...this.migrating.values()])}
}
