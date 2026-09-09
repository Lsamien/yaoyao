import Router from '@koa/router'
import { z } from 'zod'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RunnerAgent } from '../runner/agent.js'
import { UNCONFIGURED_COMPUTER_IMAGE, type RunnerConfiguration } from '../shared/runner.js'
import type { LocalVmMode, LocalVmStatus } from '../shared/localVm.js'
import type { WorkspaceAgent } from '../shared/workspace.js'
import { parse, type WorkspaceStore } from './workspaceStore.js'
import type { LocalAuthStore } from './localAuth.js'
import type { WorkspaceNodes } from './workspaceGateway.js'
import type { RunnerHub } from './runnerHub.js'
import type { SharedComputers } from './sharedComputers.js'
import type { ServerConfig } from './config.js'
import { HttpError } from './errors.js'

interface Grant {id:string;owner:string;runnerId:string;version:number;expiresAt:number}
const exec=promisify(execFile)

/** Settings owns preparation. Chats own each Agent's desktop and its lifecycle. */
export class LocalVmService {
  private url?:string
  private managed?:{agent:RunnerAgent;abort:AbortController;done:Promise<void>}
  private starting?:Promise<void>
  private problem?:string
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,
    readonly hub:RunnerHub,readonly shared:SharedComputers,readonly config:ServerConfig) {
    store.prepareAgent=(owner,agent)=>{
      const record=this.record()
      if(this.fixed){const parent=agent.createdByAgentId?store.get<WorkspaceAgent>(owner,'agent',agent.createdByAgentId):undefined,desktop=this.config.composeDesktops?.find(d=>d.id===parent?.computerEnvironmentId);if(record&&desktop&&agent.execution==='computer'){if(agent.nodeId!=='local')throw new HttpError(409,'Compose 桌面成员须使用当前 Web 的 Hermes 来源','compose_source_required');this.shared.bindCompose(owner,agent,desktop,record.id,false)}return}
      if(record&&this.mode(owner)==='shared')this.shared.attachLocalVm(owner,agent,record.id)
    }
  }
  private get fixed(){return !!this.config.composeDesktops?.length}
  private assertManaged(){if(this.fixed)throw new HttpError(409,'桌面由 Compose 创建和管理，数量和镜像不能在界面修改','compose_desktop_managed')}
  allowed(id:string,runnerId:string){
    const grant=this.store.get<Grant>('_system','local-vm-grant',id)
    return !!grant&&grant.runnerId===runnerId&&grant.expiresAt>Date.now()&&this.auth.isAdminActive(grant.owner)&&this.auth.pushAuthorizationVersion(grant.owner)===grant.version
  }
  private mode(owner:string):LocalVmMode { return this.fixed?'shared':this.store.get<{mode:LocalVmMode}>(owner,'local-vm-preferences','local')?.mode??'per-bot' }
  private record(){return this.hub.records().find(r=>r.enabled&&r.sourceNodeId==='local'&&r.sourceOwner==='_system')}
  async start(url:string) {
    this.url=url
    if(this.fixed||this.config.localVmHost==='runner')return
    const stored=this.store.get<{sealed:string}>('_system','local-vm-managed','local')
    if(!stored||this.managed)return
    const config=this.nodes.open<RunnerConfiguration>(stored.sealed)
    if(!this.hub.records().some(r=>r.id===config.runnerId&&r.enabled))return
    config.serverURL=url
    const home=join(this.config.home,'runner-state','local-vm',config.runnerId)
    mkdirSync(home,{recursive:true,mode:0o700})
    const abort=new AbortController(),agent=new RunnerAgent(config,home)
    const state={agent,abort,done:Promise.resolve()}
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
  private installation(){
    const hermesHome=join(homedir(),'.hermes'),hermesSource=join(hermesHome,'hermes-agent')
    return {hermesHome,hermesSource,python:join(hermesSource,'venv','bin','python')}
  }
  private async ensure(owner:string) {
    if(this.starting)await this.starting
    if(this.record()){
      if(this.url&&!this.managed)await this.start(this.url)
      return this.record()!
    }
    if(this.config.localVmHost==='runner')throw new HttpError(409,'Docker 版需要先连接运行 Hermes 的执行节点，并启用虚拟桌面。请在本页打开执行节点设置。','local_vm_runner_required')
    this.starting=(async()=>{
      if(!this.url)throw new HttpError(503,'本机 Web 服务尚未启动','local_vm_unavailable')
      const detected=await this.discover()
      if(!detected.runtime||!detected.daemonUp)throw new HttpError(409,'请先安装并启动 Docker 或 Podman','local_vm_runtime_required')
      const {hermesHome,hermesSource,python}=this.installation()
      if(!existsSync(python)||!existsSync(join(hermesSource,'run_agent.py')))throw new HttpError(409,'没有找到本机 Hermes 运行环境。请先安装 Hermes，或在高级连接设置中配置执行节点','local_vm_hermes_required')
      const sources=await this.nodes.sources(owner)
      const allowedProfiles=[...new Set(sources.sources.filter(s=>s.nodeId==='local').map(s=>s.profile))]
      const registered=this.hub.enroll(owner,{name:'本机虚拟机',sourceNodeId:'local',allowedProfiles})
      const config:RunnerConfiguration={protocol:1,serverURL:this.url,runnerId:registered.runner.id,token:registered.token,
        hermesURL:this.config.upstream.origin,allowedProfiles,artifactRoots:[],computers:{runtime:detected.runtime,
          imageId:UNCONFIGURED_COMPUTER_IMAGE,python,hermesSource,hermesHome,maxConcurrent:2,network:'public-proxy'}}
      this.store.put('_system','local-vm-managed','local',{sealed:this.nodes.seal(config)})
      await this.start(this.url)
    })().finally(()=>{this.starting=undefined})
    await this.starting
    const record=this.record()!
    const deadline=Date.now()+8000
    while(!this.hub.summary(record).online&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100))
    return record
  }
  private grant(owner:string,id:string,runnerId:string){
    const old=this.store.get<Grant>('_system','local-vm-grant',id)
    if(old&&(old.owner!==owner||old.runnerId!==runnerId))throw new HttpError(409,'请求编号已用于其他操作','idempotency_conflict')
    this.store.put('_system','local-vm-grant',id,{id,owner,runnerId,version:this.auth.pushAuthorizationVersion(owner)??0,expiresAt:Date.now()+3600000})
  }
  async status(owner:string):Promise<LocalVmStatus> {
    const record=this.record()
    if(this.fixed){
      const desktops=(await this.hub.composeDesktops.status()).map(d=>{const claim=this.store.get<{owner:string}>('_system','compose-desktop-owner',d.id);return {...d,available:!claim||claim.owner===owner}})
      const runner=record?this.hub.summary(record):undefined,connected=runner?.online&&runner.features.includes('compose-desktops-v1')
      return {configured:!!connected,executionHost:'runner',runnerName:record?.name,fixedCapacity:true,desktops,daemonUp:true,image:desktops.some(d=>d.ready),mode:'shared',maxInstances:desktops.length,busy:false,...(!connected?{setupRequired:'runner' as const,problem:'Compose 桌面数量已固定。请连接启用 Compose 桌面模式的 Hermes 执行节点。'}:{})}
    }
    const executionHost=this.config.localVmHost==='runner'||(record&&!this.store.get('_system','local-vm-managed','local'))?'runner':'server'
    if(record){
      if(this.url&&!this.managed)await this.start(this.url)
      const summary=this.hub.summary(record)
      if(!summary.online){
        if(executionHost==='runner')return {configured:true,executionHost,runnerName:record.name,setupRequired:'runner',daemonUp:false,image:false,mode:this.mode(owner),maxInstances:2,busy:false,problem:`执行节点「${record.name}」尚未连接，请在运行 Hermes 的电脑上启动 Runner。`}
        const detected=await this.discover()
        return {configured:true,...detected,image:false,mode:this.mode(owner),maxInstances:2,busy:false,problem:this.problem??'本机执行环境正在连接，请稍后重新检查'}
      }
      if(!summary.features?.includes('local-vm-v1'))return {configured:true,executionHost,runnerName:record.name,setupRequired:'worker',daemonUp:false,image:false,mode:this.mode(owner),maxInstances:2,busy:false,problem:'执行节点已连接，但未启用虚拟桌面或版本过旧。请启用隔离电脑 Worker 并使用配套版本的 Runner。'}
      const state=await this.hub.localVm(owner,record.id,{op:'status'}) as LocalVmStatus
      const agents=this.store.list<WorkspaceAgent>(owner,'agent'),groups=this.store.list<{id:string;name:string}>(owner,'shared-computer')
      return {...state,executionHost,runnerName:record.name,mode:this.mode(owner),instances:state.instances?.map(instance=>{
        const agent=agents.find(a=>!a.archived&&(a.computerEnvironmentId??a.id)===instance.id&&a.execution==='computer')
        return {...instance,name:agent?.computerEnvironmentName??agent?.name??groups.find(g=>g.id===instance.id)?.name??'保留的虚拟机',orphaned:!agent}
      })}
    }
    if(executionHost==='runner')return {configured:false,executionHost,setupRequired:'runner',daemonUp:false,image:false,mode:this.mode(owner),maxInstances:2,busy:false,problem:'Docker 版通过执行节点提供虚拟桌面。请在运行 Hermes 的电脑上连接执行节点。'}
    const detected=await this.discover()
    return {configured:false,...detected,image:false,mode:this.mode(owner),maxInstances:2,busy:false,problem:this.problem}
  }
  router(){
    const router=new Router()
    router.get('/api/app/admin/local-vm',async ctx=>{ctx.body=await this.status(this.auth.requireAdmin(ctx).id)})
    router.post('/api/app/admin/local-vm/prepare',async ctx=>{
      this.auth.requireAdmin(ctx);this.assertManaged()
      const actor=this.auth.requireAdmin(ctx),body=parse(z.object({requestId:z.string().uuid()}).strict(),(ctx.request as any).body)
      const record=await this.ensure(actor.id);this.grant(actor.id,body.requestId,record.id)
      ctx.body=await this.hub.localVm(actor.id,record.id,{op:'prepare',id:body.requestId})
    })
    router.put('/api/app/admin/local-vm/policy',async ctx=>{
      this.auth.requireAdmin(ctx);this.assertManaged()
      const owner=this.auth.requireAdmin(ctx).id,body=parse(z.object({requestId:z.string().uuid(),mode:z.enum(['shared','per-bot']),maxInstances:z.number().int().min(1).max(4)}).strict(),(ctx.request as any).body)
      const record=await this.ensure(owner);this.shared.assertLocalVmIdle(owner)
      this.grant(owner,body.requestId,record.id)
      await this.hub.localVm(owner,record.id,{op:'policy',id:body.requestId,mode:body.mode,maxInstances:body.maxInstances})
      this.shared.setLocalVmMode(owner,body.mode,record.id)
      this.store.put(owner,'local-vm-preferences','local',{mode:body.mode})
      ctx.body=await this.status(owner)
    })
    router.post('/api/app/admin/local-vm/instances/:id/:action',async ctx=>{
      this.auth.requireAdmin(ctx);this.assertManaged()
      const owner=this.auth.requireAdmin(ctx).id,id=parse(z.string().uuid(),ctx.params.id),action=parse(z.enum(['stop','remove']),ctx.params.action)
      const body=parse(z.object({requestId:z.string().uuid()}).strict(),(ctx.request as any).body),record=this.record()
      if(!record)throw new HttpError(409,'本地虚拟机尚未配置','local_vm_unavailable')
      this.grant(owner,body.requestId,record.id)
      ctx.body=await this.hub.localVm(owner,record.id,{op:'instance',id:body.requestId,environmentId:id,action})
    })
    router.get('/api/app/agents/:id/local-vm',async ctx=>{
      const owner=this.auth.require(ctx).id,agent=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id)
      this.nodes.requireSource(owner,agent)
      const fixed=this.fixed?{fixedCapacity:true,desktopId:agent.computerEnvironmentId,desktops:(await this.status(owner)).desktops}:{}
      if(agent.execution!=='computer'||(this.fixed&&!agent.computerEnvironmentId)){ctx.body={enabled:false,agent,...fixed};return}
      try { ctx.body={enabled:true,agent,...await this.hub.computer(owner,agent,'detail',{},()=>this.nodes.requireSource(owner,agent)),mode:agent.computerEnvironmentId?'shared':'per-bot',...fixed} }
      catch(error){ctx.body={enabled:true,agent,container:'missing',ready:false,image:false,problem:error instanceof Error?error.message:'本地虚拟机不可用',...fixed}}
    })
    router.put('/api/app/agents/:id/local-vm',ctx=>{
      const owner=this.auth.require(ctx).id,body=parse(z.object({enabled:z.boolean(),desktopId:z.string().uuid().optional()}).strict(),(ctx.request as any).body)
      const agent=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id);this.nodes.requireSource(owner,agent)
      if(agent.remoteAgentId||agent.temporaryGoalId)throw new HttpError(409,'请在该 Agent 所属的电脑上设置虚拟机','local_vm_remote')
      this.shared.assertLocalVmIdle(owner,[agent.id])
      if(this.fixed&&body.enabled){
        if(agent.nodeId!=='local')throw new HttpError(409,'Compose 桌面成员须使用当前 Web 的 Hermes 来源','compose_source_required')
        const desktop=this.config.composeDesktops!.find(d=>d.id===body.desktopId),record=this.record()
        if(!desktop)throw new HttpError(400,'请选择 Compose 中已有的共享桌面','compose_desktop_required')
        if(!record||!this.hub.summary(record).features.includes('compose-desktops-v1'))throw new HttpError(409,'请连接启用 Compose 桌面模式的执行节点','compose_runner_required')
        ctx.body=this.store.atomic(()=>{this.shared.bindCompose(owner,agent,desktop,record.id);return {agent:this.store.agentSummary(agent)}});return
      }
      ctx.body=this.store.atomic(()=>{
        if(!body.enabled)this.shared.detachLocalVm(owner,agent)
        this.store.updateAgent(owner,agent.id,{execution:body.enabled?'computer':'profile'})
        if(body.enabled&&!this.fixed&&this.mode(owner)==='shared'){const record=this.record();if(record)this.shared.setLocalVmMode(owner,'shared',record.id)}
        return {agent:this.store.agentSummary(this.store.require<WorkspaceAgent>(owner,'agent',agent.id))}
      })
    })
    router.post('/api/app/agents/:id/local-vm/:action',async ctx=>{
      this.auth.require(ctx);this.assertManaged()
      const owner=this.auth.require(ctx).id,action=parse(z.enum(['create','start','stop','recreate','remove']),ctx.params.action)
      const agent=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id)
      if(agent.temporaryGoalId)throw new HttpError(409,'临时助手的虚拟机由当前任务管理','helper_task_bound')
      if(agent.execution!=='computer'||agent.archived||agent.remoteAgentId)throw new HttpError(409,'此 Agent 未使用本地虚拟机','local_vm_disabled')
      this.shared.assertLocalVmIdle(owner,agent.computerEnvironmentId?this.store.list<WorkspaceAgent>(owner,'agent').filter(a=>a.computerEnvironmentId===agent.computerEnvironmentId).map(a=>a.id):[agent.id])
      ctx.body=await this.hub.computer(owner,agent,'lifecycle',{action},()=>this.nodes.requireSource(owner,agent))
    })
    return router
  }
  async close(){this.managed?.abort.abort();await this.managed?.done}
}
