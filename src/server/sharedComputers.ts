import Router from '@koa/router'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import type {WorkspaceAgent} from '../shared/workspace.js'
import type {WorkspaceStore} from './workspaceStore.js'
import {parse} from './workspaceStore.js'
import {HttpError} from './errors.js'
import type {WorkspaceNodes} from './workspaceGateway.js'
import type {RunnerHub} from './runnerHub.js'
import type {LocalAuthStore} from './localAuth.js'
export interface SharedComputer {managedCompose?:boolean;managedLocalVm?:boolean;id:string;name:string;memberIds:string[];nodeId:string;profile:string;runnerId:string;archived:boolean;createdAt:number}
export function requireSharedComputer(store:WorkspaceStore,owner:string,agent:{id?:string;nodeId:string;profile:string;computerEnvironmentId?:string}){
  if(!agent.computerEnvironmentId)return
  const shared=store.require<SharedComputer>(owner,'shared-computer',agent.computerEnvironmentId)
  if(shared.archived||!agent.id||!shared.memberIds.includes(agent.id)||shared.nodeId!==agent.nodeId||(!shared.managedCompose&&!shared.managedLocalVm&&shared.profile!=='*'&&shared.profile!==agent.profile))throw new HttpError(403,'当前成员没有这台共享电脑的授权','shared_computer_forbidden')
}
export class SharedComputers {
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,readonly hub:RunnerHub){}
  private idle(owner:string,ids:string[],environmentId?:string){
    const busy=new Set(this.store.list<{agentId:string;status:string}>(owner,'turn').filter(work=>ids.includes(work.agentId)&&['queued','running','waiting','uncertain','cancelling'].includes(work.status)).map(work=>work.agentId))
    if(busy.size){
      const names=[...busy].slice(0,5).map(id=>`「${this.store.get<WorkspaceAgent>(owner,'agent',id)?.name??'未知成员'}」`).join('、')
      throw new HttpError(409,`请先停止${names}${busy.size>5?'等成员':''}的当前任务，再修改电脑共享`,'shared_computer_busy')
    }
    const environments=new Set(ids.map(id=>this.store.get<WorkspaceAgent>(owner,'agent',id)?.computerEnvironmentId??id))
    if(environmentId)environments.add(environmentId)
    if(this.store.list<{owner:string;agentId:string;environmentId?:string;expiresAt:number}>('_system','computer-control').some(grant=>grant.owner===owner&&grant.expiresAt>Date.now()&&(ids.includes(grant.agentId)||(grant.environmentId&&environments.has(grant.environmentId)))))throw new HttpError(409,'请先交还电脑控制权，再修改共享','shared_computer_busy')
  }
  private localVmAgents(owner:string){return this.store.list<WorkspaceAgent>(owner,'agent').filter(a=>a.nodeId==='local'&&!a.archived&&!a.remoteAgentId&&!a.temporaryGoalId&&(a.execution==='computer'||!!a.computerEnvironmentId))}
  assertLocalVmIdle(owner:string,ids?:string[]){this.idle(owner,ids??this.localVmAgents(owner).map(a=>a.id))}
  bindCompose(owner:string,agent:WorkspaceAgent,desktop:{id:string;name:string},runnerId:string,persist=true){
    this.idle(owner,[agent.id])
    const claim=this.store.get<{owner:string;runnerId:string}>('_system','compose-desktop-owner',desktop.id)
    if(claim&&(claim.owner!==owner||claim.runnerId!==runnerId))throw new HttpError(403,'这台共享桌面已分配给其他账号或执行节点','compose_desktop_forbidden')
    if(agent.computerEnvironmentId&&agent.computerEnvironmentId!==desktop.id)this.detachLocalVm(owner,agent)
    const group=this.store.get<SharedComputer>(owner,'shared-computer',desktop.id)??{id:desktop.id,name:desktop.name,nodeId:'local',profile:'*',runnerId,memberIds:[],archived:false,createdAt:Date.now(),managedCompose:true}
    group.archived=false;if(!group.memberIds.includes(agent.id))group.memberIds.push(agent.id)
    this.store.put('_system','compose-desktop-owner',desktop.id,{owner,runnerId})
    this.store.put(owner,'shared-computer',group.id,group)
    agent.execution='computer';agent.computer='vm';agent.computerEnvironmentId=desktop.id;agent.computerEnvironmentName=desktop.name
    if(persist){agent.revision++;agent.updatedAt=Date.now();this.store.put(owner,'agent',agent.id,agent);this.store.event(owner,'agent.changed',agent)}
  }
  attachLocalVm(owner:string,agent:WorkspaceAgent,runnerId:string){
    if(agent.nodeId!=='local'||agent.execution!=='computer'||agent.temporaryGoalId||agent.remoteAgentId||agent.computerEnvironmentId)return
    this.nodes.requireSource(owner,agent)
    const group=this.store.list<SharedComputer>(owner,'shared-computer').find(g=>!g.archived&&g.managedLocalVm&&g.runnerId===runnerId)
      ??{id:randomUUID(),name:'共享本地虚拟机',memberIds:[],nodeId:'local',profile:'*',runnerId,archived:false,createdAt:Date.now(),managedLocalVm:true}
    if(!group.memberIds.includes(agent.id))group.memberIds.push(agent.id)
    this.store.put(owner,'shared-computer',group.id,group)
    agent.computerEnvironmentId=group.id;agent.computerEnvironmentName=group.name
  }
  detachLocalVm(owner:string,agent:WorkspaceAgent){
    if(!agent.computerEnvironmentId)return
    const group=this.store.require<SharedComputer>(owner,'shared-computer',agent.computerEnvironmentId)
    group.memberIds=group.memberIds.filter(id=>id!==agent.id);group.archived=group.memberIds.length===0
    this.store.put(owner,'shared-computer',group.id,group)
    delete agent.computerEnvironmentId;delete agent.computerEnvironmentName
    this.store.put(owner,'agent',agent.id,agent)
  }
  setLocalVmMode(owner:string,mode:'shared'|'per-bot',runnerId:string){
    this.assertLocalVmIdle(owner)
    this.store.atomic(()=>{
      const agents=this.localVmAgents(owner)
      const previous=new Map(agents.map(a=>[a.id,{id:a.computerEnvironmentId,name:a.computerEnvironmentName}]))
      const groups=this.store.list<SharedComputer>(owner,'shared-computer').filter(g=>g.nodeId==='local'&&g.runnerId===runnerId)
      for(const group of groups){group.archived=true;this.store.put(owner,'shared-computer',group.id,group)}
      for(const agent of agents){
        if(agent.computerEnvironmentId&&groups.some(g=>g.id===agent.computerEnvironmentId)){delete agent.computerEnvironmentId;delete agent.computerEnvironmentName}
      }
      if(mode==='shared'){
        const members=agents.filter(a=>a.execution==='computer'&&!a.computerEnvironmentId)
        if(members.length){
          const group=groups.find(g=>g.managedLocalVm)??{id:randomUUID(),name:'共享本地虚拟机',memberIds:[],nodeId:'local',profile:'*',runnerId,archived:false,createdAt:Date.now(),managedLocalVm:true}
          group.profile='*';group.archived=false;group.managedLocalVm=true;group.memberIds=members.map(a=>a.id);this.store.put(owner,'shared-computer',group.id,group)
          for(const agent of members){agent.computerEnvironmentId=group.id;agent.computerEnvironmentName=group.name}
        }
      }
      for(const agent of agents){
        const before=previous.get(agent.id)!
        if(before.id===agent.computerEnvironmentId&&before.name===agent.computerEnvironmentName)continue
        agent.revision++;agent.updatedAt=Date.now();this.store.put(owner,'agent',agent.id,agent);this.store.event(owner,'agent.changed',agent)
      }
    })
  }
  create(owner:string,input:unknown){
    const body=parse(z.object({requestId:z.string().uuid(),name:z.string().trim().min(1).max(100),memberIds:z.array(z.string().uuid()).min(2).max(8),trusted:z.literal(true)}).strict(),input)
    return this.store.command(owner,body.requestId,{operation:'computer.share',...body},()=>this.store.atomic(()=>{
      if(new Set(body.memberIds).size!==body.memberIds.length)throw new HttpError(400,'成员不能重复','shared_computer_members')
      if(this.store.list<SharedComputer>(owner,'shared-computer').filter(value=>!value.archived).length>=16)throw new HttpError(409,'共享电脑数量已达上限','shared_computer_limit')
      const agents=body.memberIds.map(id=>this.store.require<WorkspaceAgent>(owner,'agent',id)),first=agents[0]!
      for(const agent of agents){
        this.nodes.requireSource(owner,agent)
        if(agent.archived||agent.temporaryGoalId||agent.remoteAgentId||agent.execution!=='computer'||agent.computerEnvironmentId||agent.nodeId!==first.nodeId)throw new HttpError(400,'请选择同一来源的持久隔离成员，且成员尚未加入其他共享电脑','shared_computer_members')
      }
      this.idle(owner,body.memberIds)
      const runnerId=this.hub.sharedComputerRunner(owner,first).id
      const shared:SharedComputer={id:randomUUID(),name:body.name,memberIds:body.memberIds,nodeId:first.nodeId,profile:'*',runnerId,archived:false,createdAt:Date.now()}
      this.store.put(owner,'shared-computer',shared.id,shared)
      for(const agent of agents){agent.computerEnvironmentId=shared.id;agent.computerEnvironmentName=shared.name;agent.revision++;agent.updatedAt=Date.now();this.store.put(owner,'agent',agent.id,agent);this.store.event(owner,'agent.changed',agent)}
      return shared
    }))
  }
  remove(owner:string,id:string){
    return this.store.atomic(()=>{
      const shared=this.store.require<SharedComputer>(owner,'shared-computer',id)
      if(shared.archived)return
      this.idle(owner,shared.memberIds,id)
      for(const agent of this.store.list<WorkspaceAgent>(owner,'agent').filter(agent=>agent.computerEnvironmentId===id)){
        delete agent.computerEnvironmentId;delete agent.computerEnvironmentName;agent.revision++;agent.updatedAt=Date.now();this.store.put(owner,'agent',agent.id,agent);this.store.event(owner,'agent.changed',agent)
      }
      shared.archived=true;this.store.put(owner,'shared-computer',id,shared)
    })
  }
  router(){
    const router=new Router()
    router.get('/api/app/computers/shared',ctx=>{const owner=this.auth.require(ctx).id;ctx.body={computers:this.store.list<SharedComputer>(owner,'shared-computer').filter(value=>!value.archived)}})
    router.post('/api/app/computers/shared',ctx=>{ctx.body={computer:this.create(this.auth.require(ctx).id,(ctx.request as any).body)};ctx.status=201})
    router.delete('/api/app/computers/shared/:id',ctx=>{this.remove(this.auth.require(ctx).id,ctx.params.id);ctx.body={ok:true}})
    return router
  }
}
