import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto'
import Router from '@koa/router'
import {z} from 'zod'
import {HttpError} from './errors.js'
import {parse,type WorkspaceStore} from './workspaceStore.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceAgent} from '../shared/workspace.js'
import type {WorkspaceNodes} from './workspaceGateway.js'
import type {RunnerHub} from './runnerHub.js'
const hash=(value:string)=>createHash('sha256').update(value).digest()
interface Grant {environmentId?:string;id:string;agentId:string;owner:string;requestId:string;runnerId:string;authVersion:number;expiresAt:number;tokenHash:string;sealedToken:string}
export class ComputerControlService {
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,readonly hub:RunnerHub){}
  private agent(owner:string,id:string){
    const agent=this.store.require<WorkspaceAgent>(owner,'agent',id)
    if(agent.archived||agent.execution!=='computer'||agent.remoteAgentId)throw new HttpError(409,'该机器人没有可用的隔离电脑','computer_unavailable')
    this.nodes.requireSource(owner,agent);return agent
  }
  allowed(id:string,runnerId:string):boolean{
    const grant=this.store.get<Grant>('_system','computer-control',id)
    if(!grant||grant.runnerId!==runnerId||grant.expiresAt<=Date.now()||this.auth.pushAuthorizationVersion(grant.owner)!==grant.authVersion)return false
    try{const agent=this.agent(grant.owner,grant.agentId);return (agent.computerEnvironmentId??agent.id)===(grant.environmentId??grant.agentId)}catch{return false}
  }
  private token(owner:string,agentId:string,body:unknown){
    const input=parse(z.object({controlId:z.string().uuid(),token:z.string().min(32).max(256)}).passthrough(),body)
    const grant=this.store.get<Grant>('_system','computer-control',input.controlId)
    if(!grant||grant.owner!==owner||grant.agentId!==agentId||!timingSafeEqual(Buffer.from(grant.tokenHash,'hex'),hash(input.token)))throw new HttpError(403,'需要当前电脑的控制凭据','computer_control_forbidden')
    if(!this.allowed(grant.id,grant.runnerId))throw new HttpError(410,'电脑控制权已过期','computer_control_expired')
    return grant
  }
  router(){
    const router=new Router()
    router.get('/api/app/computers',ctx=>{
      const actor=this.auth.require(ctx),agents=this.store.list<WorkspaceAgent>(actor.id,'agent').filter(agent=>!agent.archived)
      ctx.body={canManageLocalVm:actor.role==='admin',computers:agents.map(agent=>{
        let available=false,reason='在机器人设置中将执行环境设为隔离电脑'
        if(agent.execution==='computer')try{this.nodes.requireSource(actor.id,agent);const record=this.hub.computerRunner(actor.id,agent),features=this.hub.summary(record).features;if(features.includes('local-vm-v1')&&!features.includes('image-ready-v1'))throw new Error('请先在应用设置的本地虚拟机页面完成准备');available=true;reason='可以打开电脑面板'}catch(error){reason=error instanceof Error?error.message:'电脑不可用'}
        return {agent,available,reason}
      })}
    })
    router.get('/api/app/agents/:id/computer',async ctx=>{
      const owner=this.auth.require(ctx).id,agent=this.agent(owner,ctx.params.id)
      ctx.body=await this.hub.computer(owner,agent,'status',{},()=>{this.agent(owner,agent.id)})
    })
    router.get('/api/app/agents/:id/computer/frame',async ctx=>{
      const owner=this.auth.require(ctx).id,agent=this.agent(owner,ctx.params.id)
      ctx.set('Cache-Control','no-store');ctx.body=await this.hub.computer(owner,agent,'frame',{},()=>{this.agent(owner,agent.id)})
    })
    router.post('/api/app/agents/:id/computer/take',async ctx=>{
      const owner=this.auth.require(ctx).id,agent=this.agent(owner,ctx.params.id),input=parse(z.object({requestId:z.string().uuid()}).strict(),(ctx.request as any).body)
      const old=this.store.list<Grant>('_system','computer-control').find(grant=>grant.owner===owner&&(grant.environmentId??grant.agentId)===(agent.computerEnvironmentId??agent.id)&&grant.expiresAt>Date.now()&&this.allowed(grant.id,grant.runnerId))
      if(old&&(old.agentId!==agent.id||old.requestId!==input.requestId))throw new HttpError(409,'电脑已由另一个页面控制，关闭原页面或等待控制权到期','computer_control_busy')
      const runnerId=this.hub.computerRunner(owner,agent).id
      const token=old?this.nodes.open<string>(old.sealedToken):randomBytes(32).toString('base64url')
      const grant:Grant=old??{environmentId:agent.computerEnvironmentId??agent.id,id:randomUUID(),requestId:input.requestId,owner,agentId:agent.id,runnerId,authVersion:this.auth.pushAuthorizationVersion(owner)??0,expiresAt:Date.now()+30000,tokenHash:hash(token).toString('hex'),sealedToken:this.nodes.seal(token)}
      this.store.put('_system','computer-control',grant.id,grant)
      const status=await this.hub.computer(owner,agent,'take',{controlId:grant.id},()=>{if(!this.allowed(grant.id,runnerId))throw new HttpError(403,'电脑控制请求已失效','computer_control_expired')})
      ctx.body={...status,controlId:grant.id,token,expiresAt:grant.expiresAt}
    })
    router.post('/api/app/agents/:id/computer/renew',ctx=>{
      const owner=this.auth.require(ctx).id,grant=this.token(owner,ctx.params.id,(ctx.request as any).body)
      grant.expiresAt=Date.now()+30000;this.store.put('_system','computer-control',grant.id,grant);ctx.body={expiresAt:grant.expiresAt}
    })
    router.post('/api/app/agents/:id/computer/input',async ctx=>{
      const owner=this.auth.require(ctx).id,agent=this.agent(owner,ctx.params.id),input=parse(z.object({controlId:z.string().uuid(),token:z.string(),requestId:z.string().uuid(),generation:z.number().int().nonnegative(),frameId:z.string().uuid(),action:z.record(z.string(),z.unknown())}).strict(),(ctx.request as any).body)
      const grant=this.token(owner,agent.id,input)
      ctx.body=await this.hub.computer(owner,agent,'input',{controlId:grant.id,requestId:input.requestId,generation:input.generation,frameId:input.frameId,action:input.action},()=>{this.token(owner,agent.id,input)})
    })
    router.post('/api/app/agents/:id/computer/giveback',async ctx=>{
      const owner=this.auth.require(ctx).id,agent=this.agent(owner,ctx.params.id),input=parse(z.object({controlId:z.string().uuid(),token:z.string(),notes:z.string().max(4000).default('')}).strict(),(ctx.request as any).body)
      const grant=this.token(owner,agent.id,input)
      ctx.body=await this.hub.computer(owner,agent,'giveback',{controlId:grant.id,notes:input.notes},()=>{this.token(owner,agent.id,input)})
      grant.expiresAt=0;this.store.put('_system','computer-control',grant.id,grant)
    })
    return router
  }
}
