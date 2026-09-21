import Router from '@koa/router'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import {parse,type WorkspaceStore} from './workspaceStore.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceNodes} from './workspaceGateway.js'
import type {WorkspaceRuntime} from './workspaceRuntime.js'
import type {WorkspaceAgent,WorkspaceConversation,WorkspaceRun} from '../shared/workspace.js'
import type {WorkspaceRoutine,WorkspaceSchedule,WorkspaceRoutineRun} from '../shared/workspacePanels.js'
import {HttpError} from './errors.js'
const timezone=z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true}catch{return false}},'时区无效')
const clock=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const schedule=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('once'),timezone,at:z.number().int().positive()}).strict(),
  z.object({kind:z.literal('interval'),timezone,everyMinutes:z.number().int().min(1).max(525600)}).strict(),
  z.object({kind:z.literal('daily'),timezone,time:clock}).strict(),
  z.object({kind:z.literal('weekly'),timezone,time:clock,weekdays:z.array(z.number().int().min(0).max(6)).min(1).max(7)}).strict(),
])
const input=z.object({name:z.string().trim().min(1).max(100),prompt:z.string().trim().min(1).max(24000),enabled:z.boolean(),deviceHost:z.union([z.literal('local'),z.string().uuid()]).nullish(),schedule}).strict()
export function nextRoutineAt(s:WorkspaceSchedule,after:number):number|undefined {
  if(s.kind==='once')return s.at!>after?s.at:undefined
  if(s.kind==='interval')return after+s.everyMinutes!*60000
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone:s.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit',weekday:'short'})
  for(let at=Math.floor(after/60000)*60000+60000;at<=after+8*86400000;at+=60000){
    const parts=Object.fromEntries(formatter.formatToParts(at).map(p=>[p.type,p.value]))
    if(`${parts.hour}:${parts.minute}`===s.time&&(s.kind==='daily'||s.weekdays!.includes(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday!))))return at
  }
  throw new HttpError(400,'无法计算下次执行时间','routine_schedule_invalid')
}
const terminal=(status:string)=>['complete','failed','interrupted','skipped'].includes(status)
export class WorkspaceRoutines {
  paused:()=>boolean=()=>false
  private timer?:ReturnType<typeof setInterval>;private ticking=false;private closed=false
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,readonly runtime:WorkspaceRuntime){}
  private agent(owner:string,id:string){const agent=this.store.require<WorkspaceAgent>(owner,'agent',id);if(agent.archived||agent.temporaryGoalId||agent.remoteAgentId)throw new HttpError(409,'此机器人不能建立定时任务','routine_agent_unavailable');this.nodes.requireSource(owner,agent);return agent}
  save(owner:string,agentId:string,body:unknown,id:string=randomUUID()){
    this.agent(owner,agentId);const value=parse(input,body),old=this.store.get<WorkspaceRoutine>(owner,'routine',id)
    if(old&&old.agentId!==agentId)throw new HttpError(404,'定时任务不存在','not_found')
    const now=Date.now(),unchanged=!!old&&old.enabled===value.enabled&&JSON.stringify(parse(schedule,old.schedule))===JSON.stringify(value.schedule),nextAt=unchanged?old!.nextAt:value.enabled?nextRoutineAt(value.schedule,now):undefined
    if(value.enabled&&!nextAt)throw new HttpError(400,'请选择未来的执行时间','routine_time_invalid')
    const routine:WorkspaceRoutine={...value,deviceHost:value.deviceHost===undefined?old?.deviceHost:value.deviceHost??undefined,id,agentId,nextAt,createdAt:old?.createdAt??now,updatedAt:now,lastAt:old?.lastAt}
    this.store.put(owner,'routine',id,routine);this.store.event(owner,'routine.changed',routine);return routine
  }
  runs(owner:string,agentId:string){return this.store.list<WorkspaceRoutineRun>(owner,'routine-run').filter(r=>r.agentId===agentId).map(r=>{
    const run=r.runId?this.store.get<WorkspaceRun>(owner,'run',r.runId):undefined
    return run?{...r,status:run.status,error:run.error}:r
  }).sort((a,b)=>b.startedAt-a.startedAt).slice(0,100)}
  run(owner:string,routine:WorkspaceRoutine,scheduledAt:number,requestId:string=randomUUID()){
    return this.store.command(owner,requestId,{operation:'routine.run',routineId:routine.id,scheduledAt},()=>this.store.atomic(()=>{
      this.agent(owner,routine.agentId)
      const id=randomUUID(),entry:WorkspaceRoutineRun={id,routineId:routine.id,agentId:routine.agentId,scheduledAt,startedAt:Date.now(),status:'queued'}
      try {
        if(this.store.list<WorkspaceRoutineRun>(owner,'routine-run').some(r=>r.routineId===routine.id&&!terminal((r.runId?this.store.get<WorkspaceRun>(owner,'run',r.runId)?.status:undefined)??r.status)))throw new HttpError(409,'上次定时任务仍在执行，本次已跳过','routine_overlap')
        const conversation=this.store.list<WorkspaceConversation>(owner,'conversation').find(c=>c.kind==='direct'&&!c.archived&&c.memberIds[0]===routine.agentId)
        if(!conversation)throw new HttpError(409,'机器人的聊天已归档或删除','routine_conversation_unavailable')
        const run=this.runtime.send(owner,conversation.id,{requestId:id,content:routine.prompt,deviceHost:routine.deviceHost})
        Object.assign(entry,{runId:run.id,conversationId:conversation.id})
      }catch(error){entry.status=error instanceof HttpError&&error.code==='routine_overlap'?'skipped':'failed';entry.error=error instanceof Error?error.message:'定时任务未能启动'}
      this.store.put(owner,'routine-run',id,entry)
      const old=this.store.list<WorkspaceRoutineRun>(owner,'routine-run').filter(r=>r.agentId===routine.agentId).sort((a,b)=>b.startedAt-a.startedAt).slice(100)
      for(const run of old)if(terminal(this.store.get<WorkspaceRun>(owner,'run',run.runId??'')?.status??run.status))this.store.remove(owner,'routine-run',run.id)
      return entry
    }))
  }
  tick(now=Date.now()){
    if(this.closed||this.ticking||this.paused())return;this.ticking=true
    try {for(const owner of this.store.owners())for(const routine of this.store.list<WorkspaceRoutine>(owner,'routine')){
      if(!routine.enabled||!routine.nextAt||routine.nextAt>now)continue
      this.store.atomic(()=>{
        const due=routine.nextAt!
        try{if(!this.auth.isUserActive(owner))throw new Error('账号当前不可用');this.run(owner,routine,due)}catch(error){const id=randomUUID();routine.enabled=false;this.store.put(owner,'routine-run',id,{id,routineId:routine.id,agentId:routine.agentId,scheduledAt:due,startedAt:now,status:'failed',error:error instanceof Error?error.message:'定时任务未能启动'})}
        routine.lastAt=due;routine.nextAt=routine.enabled?nextRoutineAt(routine.schedule,now):undefined;if(!routine.nextAt)routine.enabled=false
        routine.updatedAt=now;this.store.put(owner,'routine',routine.id,routine);this.store.event(owner,'routine.changed',routine)
      })
    }}finally{this.ticking=false}
  }
  start(){if(this.timer)return;this.tick();this.timer=setInterval(()=>this.tick(),10000);this.timer.unref()}
  close(){this.closed=true;clearInterval(this.timer)}
  router(){const router=new Router()
    router.get('/api/app/bot-tools/automations',ctx=>{
      const owner=this.auth.require(ctx).id
      const agents=this.store.list<WorkspaceAgent>(owner,'agent').filter(a=>{try{this.agent(owner,a.id);return true}catch(error){if(error instanceof HttpError&&[403,404,409].includes(error.status))return false;throw error}})
      const allowed=new Set(agents.map(a=>a.id))
      const runs=this.store.list<WorkspaceRoutineRun>(owner,'routine-run').filter(r=>allowed.has(r.agentId)).sort((a,b)=>b.startedAt-a.startedAt).slice(0,300).map(r=>{const run=r.runId?this.store.get<WorkspaceRun>(owner,'run',r.runId):undefined;return run?{...r,status:run.status,error:run.error}:r})
      ctx.body={agents:agents.map(({id,name,avatar})=>({id,name,avatar})),routines:this.store.list<WorkspaceRoutine>(owner,'routine').filter(r=>allowed.has(r.agentId)),runs}
    })
    router.get('/api/app/agents/:id/routines',ctx=>{const owner=this.auth.require(ctx).id;this.store.require(owner,'agent',ctx.params.id);ctx.body={routines:this.store.list<WorkspaceRoutine>(owner,'routine').filter(r=>r.agentId===ctx.params.id),runs:this.runs(owner,ctx.params.id)}})
    router.post('/api/app/agents/:id/routines',ctx=>{ctx.body={routine:this.save(this.auth.require(ctx).id,ctx.params.id,(ctx.request as any).body)};ctx.status=201})
    router.put('/api/app/agents/:id/routines/:routineId',ctx=>{const owner=this.auth.require(ctx).id;this.store.require(owner,'routine',ctx.params.routineId);ctx.body={routine:this.save(owner,ctx.params.id,(ctx.request as any).body,ctx.params.routineId)}})
    router.delete('/api/app/agents/:id/routines/:routineId',ctx=>{const owner=this.auth.require(ctx).id,r=this.store.require<WorkspaceRoutine>(owner,'routine',ctx.params.routineId);if(r.agentId!==ctx.params.id)throw new HttpError(404,'定时任务不存在','not_found');this.store.remove(owner,'routine',r.id);ctx.body={ok:true}})
    router.post('/api/app/agents/:id/routines/:routineId/run',ctx=>{const owner=this.auth.require(ctx).id,r=this.store.require<WorkspaceRoutine>(owner,'routine',ctx.params.routineId);if(r.agentId!==ctx.params.id)throw new HttpError(404,'定时任务不存在','not_found');const body=parse(z.object({requestId:z.string().uuid()}).strict(),(ctx.request as any).body);ctx.body={run:this.run(owner,r,0,body.requestId)}})
    return router
  }
}
