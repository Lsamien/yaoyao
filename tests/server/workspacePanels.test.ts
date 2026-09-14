// @vitest-environment node
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomUUID} from 'node:crypto'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {WorkspaceRoutines,nextRoutineAt} from '../../src/server/workspaceRoutines'
import {WorkspaceInspector,redactInspector} from '../../src/server/workspaceInspector'
import {GrokCloud,grokComputerRules} from '../../src/server/grokCloud'

let home:string,store:WorkspaceStore,nodes:WorkspaceNodes
const auth={require:(ctx:any)=>({id:ctx.get('x-user')||'owner',role:'admin'}),requireAdmin:(ctx:any)=>({id:ctx.get('x-user')||'owner',role:'admin'}),isUserActive:()=>true,pushAuthorizationVersion:()=>1} as any
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'workspace-panels-'));store=new WorkspaceStore(home);nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any)})
afterEach(()=>{nodes.close();store.close();rmSync(home,{recursive:true,force:true});vi.useRealTimers()})

it('changes the foundation only when idle and retires old session bindings without changing history',()=>{
 const agent=store.createAgent('owner',{name:'甲',profile:'default'}),conversation=store.list<any>('owner','conversation')[0]
 store.put('owner','binding',`${conversation.id}:${agent.id}`,{id:`${conversation.id}:${agent.id}`,storedId:'old-session'})
 store.put('owner','turn','busy',{agentId:agent.id,status:'queued'})
 expect(()=>store.updateAgent('owner',agent.id,{profile:'other'})).toThrow('先停止')
 store.remove('owner','turn','busy')
 expect(store.updateAgent('owner',agent.id,{profile:'other'}).profile).toBe('other')
 expect(store.list('owner','binding')).toEqual([])
 expect(store.require('owner','conversation',conversation.id)).toMatchObject({id:conversation.id,name:'甲'})
})

it('calculates daily and weekly schedules in the requested timezone, including DST',()=>{
 const after=Date.parse('2026-09-10T00:00:00Z')
 expect(nextRoutineAt({kind:'daily',timezone:'Asia/Shanghai',time:'09:00'},after)).toBe(Date.parse('2026-09-10T01:00:00Z'))
 expect(nextRoutineAt({kind:'weekly',timezone:'Asia/Shanghai',time:'09:00',weekdays:[1]},after)).toBe(Date.parse('2026-09-14T01:00:00Z'))
 expect(nextRoutineAt({kind:'daily',timezone:'America/New_York',time:'09:00'},Date.parse('2026-03-07T15:00:00Z'))).toBe(Date.parse('2026-03-08T13:00:00Z'))
})

it('returns an account-scoped automation overview with only currently permitted Bots and current run states',async()=>{
 const own=store.createAgent('owner',{name:'自己的 Bot',profile:'default'}),blocked=store.createAgent('owner',{name:'未授权 Bot',profile:'blocked'}),foreign=store.createAgent('other',{name:'其他账号 Bot',profile:'default'})
 const service=new WorkspaceRoutines(store,auth,nodes,{} as any)
 const body={name:'日常核对',prompt:'核对内容',enabled:true,schedule:{kind:'interval',timezone:'UTC',everyMinutes:60}}
 const routine=service.save('owner',own.id,body)
 service.save('owner',blocked.id,body);service.save('other',foreign.id,body)
 const id=randomUUID();store.put('owner','run',id,{id,status:'complete'})
 store.put('owner','routine-run','receipt',{id:'receipt',agentId:own.id,routineId:routine.id,runId:id,status:'queued',startedAt:1,scheduledAt:0})
 nodes.sourceAllowed=(_owner,_node,profile)=>profile!=='blocked'
 const app=new Koa();app.use(service.router().routes())
 const result=await request(app.callback()).get('/api/app/bot-tools/automations')
 expect(result.status).toBe(200)
 expect(result.body.agents.map((a:any)=>a.id)).toEqual([own.id])
 expect(result.body.routines.map((r:any)=>r.id)).toEqual([routine.id])
 expect(result.body.runs).toMatchObject([{id:'receipt',status:'complete'}])
 const other=await request(app.callback()).get('/api/app/bot-tools/automations').set('x-user','other')
 expect(other.body.agents.map((a:any)=>a.id)).toEqual([foreign.id])
 expect(other.body.runs).toEqual([])
})

it('keeps the original next occurrence when only a routine title or prompt changes',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-10T00:00:00Z'))
 const agent=store.createAgent('owner',{name:'排期验收',profile:'default'}),service=new WorkspaceRoutines(store,auth,nodes,{} as any)
 const body={name:'项目核对',prompt:'核对状态',enabled:true,schedule:{kind:'interval',timezone:'UTC',everyMinutes:60}}
 const routine=service.save('owner',agent.id,body)
 vi.setSystemTime(new Date('2026-09-10T00:25:00Z'))
 expect(service.save('owner',agent.id,{...body,name:'每日项目核对'},routine.id).nextAt).toBe(routine.nextAt)
 service.close()
})

it('persists due schedules, prevents overlap and deduplicates manual runs after restart',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-10T00:00:00Z'))
 const agent=store.createAgent('owner',{name:'日报机器人',profile:'default'})
 const send=vi.fn((_owner:string,_conversation:string,input:any)=>{const run={id:input.requestId,status:'queued'};store.put('owner','run',run.id,run);return run})
 const routines=new WorkspaceRoutines(store,auth,nodes,{send} as any)
 const routine=routines.save('owner',agent.id,{name:'检查',prompt:'检查任务',enabled:true,schedule:{kind:'interval',timezone:'UTC',everyMinutes:1}})
 vi.setSystemTime(new Date('2026-09-10T00:01:01Z'));routines.tick();routines.tick()
 expect(send).toHaveBeenCalledTimes(1)
 const replacement=new WorkspaceRoutines(store,auth,nodes,{send} as any);replacement.tick();expect(send).toHaveBeenCalledTimes(1)
 vi.setSystemTime(new Date('2026-09-10T00:02:02Z'));replacement.tick()
 expect(send).toHaveBeenCalledTimes(1);expect(replacement.runs('owner',agent.id).some(run=>run.status==='skipped')).toBe(true)
 const first=replacement.runs('owner',agent.id).find(run=>run.runId)!
 store.put('owner','run',first.runId!,{id:first.runId,status:'complete'})
 const requestId=randomUUID();replacement.run('owner',routine,0,requestId);replacement.run('owner',routine,0,requestId)
 expect(send).toHaveBeenCalledTimes(2)
 expect(()=>replacement.save('other',agent.id,{name:'forbidden'})).toThrow()
 routines.close();replacement.close()
})

it('records redacted requests and enforces conversation ownership and task scope',async()=>{
 const agent=store.createAgent('owner',{name:'检查机器人',profile:'default'}),conversation=store.list<any>('owner','conversation')[0]
 const inspector=new WorkspaceInspector(store,auth)
 inspector.record('owner',conversation.id,{agentId:agent.id,runId:randomUUID(),method:'prompt.submit',direction:'request',data:{authorization:'Bearer secret',nested:{access_token:'secret'},prompt:'hello',content_base64:'screenshot'}})
 const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(error:any){ctx.status=error.status??500;ctx.body={error:error.message}}});app.use(inspector.router().routes())
 const own=await request(app.callback()).get(`/api/app/conversations/${conversation.id}/inspector`)
 expect(own.status).toBe(200);expect(own.body.entries[0].data).toMatchObject({authorization:'[已隐藏]',prompt:'hello',nested:{access_token:'[已隐藏]'}})
 expect(JSON.stringify(own.body)).not.toContain('secret')
 expect((await request(app.callback()).get(`/api/app/conversations/${conversation.id}/inspector`).set('x-user','other')).status).toBe(404)
 expect(redactInspector({prompt:'Bearer abc-secret'})).toEqual({prompt:'Bearer [已隐藏]'})
})

function fakeCloud(){
 let ensure=0,exec=0
 const fetcher=vi.fn(async(url:any,init:any)=>{
  const path=new URL(String(url)).pathname
  if(path.endsWith('GetSandBoxRunState'))return Response.json({state:'SAND_BOX_RUN_STATE_RUNNING'})
  if(path.endsWith('EnsureSandBox')){ensure++;return Response.json({gatewayUrl:'https://gateway.cursorvm.com',gatewayToken:'private-gateway',networkToken:'private-network',execDaemonUrl:'https://exec.cursorvm.com',execDaemonAuthToken:'private-exec'})}
  if(path==='/health')return Response.json({ok:true,isBusy:false})
  if(path.endsWith('/Exec')){exec++;const frames=[{stdoutEvent:{data:'remote result'}},{exitEvent:{}},{}].map((event,i)=>{const text=Buffer.from(JSON.stringify(event)),frame=Buffer.alloc(text.length+5);frame[0]=i===2?2:0;frame.writeUInt32BE(text.length,1);text.copy(frame,5);return frame});return new Response(Buffer.concat(frames),{headers:{'content-type':'application/connect+json'}})}
  throw new Error('Unexpected request '+path)
 }) as typeof fetch
 const cloud=new GrokCloud(store,auth,nodes,{assertLocalVmIdle:()=>{}} as any,fetcher)
 const token='header.'+Buffer.from(JSON.stringify({sub:'fixture',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature'
 return {cloud,token,fetcher,counts:()=>({ensure,exec})}
}
it('persists the separate host option, checks the Runner grant and refuses changes during active work',async()=>{
 const {cloud}=fakeCloud(),agent=store.createAgent('owner',{name:'双环境',profile:'default',computer:'vm',execution:'computer'})
 const target=vi.fn(()=>({runner:{id:'fixture'}} as any));nodes.runnerTarget=target
 const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(error:any){ctx.status=error.status??500;ctx.body={error:error.message}}});app.use(bodyParser());app.use(cloud.router().routes())
 const path=`/api/app/agents/${agent.id}/computer-selection`
 const response=await request(app.callback()).put(path).send({computer:'vm',allowHostEnvironment:true}).expect(200)
 expect(response.body.agent).toMatchObject({computer:'vm',execution:'computer',allowHostEnvironment:true})
 expect(target).toHaveBeenCalledWith('owner','local',expect.objectContaining({agentId:agent.id,hostAccess:true}))
 await request(app.callback()).put(path).set('x-user','other').send({computer:'vm',allowHostEnvironment:true}).expect(404)
 store.put('owner','turn','active-hybrid',{agentId:agent.id,status:'running'})
 await request(app.callback()).put(path).send({computer:'vm',allowHostEnvironment:false}).expect(409)
 expect(store.require<any>('owner','agent',agent.id).allowHostEnvironment).toBe(true)
 store.remove('owner','turn','active-hybrid');await request(app.callback()).put(path).send({computer:'vm',allowHostEnvironment:false}).expect(200)
 target.mockClear();nodes.targetForAgent('owner',store.require<any>('owner','agent',agent.id))
 expect(target.mock.calls[0]?.[2]).not.toHaveProperty('hostAccess')
})
it('persists the separate Profile execution mode, checks its Runner capability and prevents running or inherited changes',async()=>{
 const {cloud}=fakeCloud(),agent=store.createAgent('owner',{name:'本机协作',profile:'default',computer:'vm',execution:'computer'})
 const target=vi.fn(()=>({runner:{id:'fixture'}} as any));nodes.runnerTarget=target
 const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(error:any){ctx.status=error.status??500;ctx.body={error:error.message}}});app.use(bodyParser());app.use(cloud.router().routes())
 const path=`/api/app/agents/${agent.id}/computer-selection`
 const changed=await request(app.callback()).put(path).send({computer:'vm',vmExecution:'profile'}).expect(200)
 expect(changed.body.agent).toMatchObject({computer:'vm',execution:'computer',vmExecution:'profile',allowHostEnvironment:true})
 expect(target).toHaveBeenCalledWith('owner','local',expect.objectContaining({profileSession:true,hostAccess:true}))
 store.put('owner','turn','active-profile',{agentId:agent.id,status:'running'})
 await request(app.callback()).put(path).send({computer:'vm',vmExecution:'worker'}).expect(409)
 expect(()=>store.updateAgent('owner',agent.id,{vmExecution:'worker'})).toThrow('先停止当前任务')
 store.remove('owner','turn','active-profile')
 const member=store.createAgent('owner',{name:'不继承模式',profile:'default',computer:'vm',execution:'computer',vmExecution:'profile'},{createdByAgentId:agent.id,createdFromRunId:'run'})
 expect(member.vmExecution).toBe('worker');expect(member.allowHostEnvironment).toBe(false)
 const worker=await request(app.callback()).put(path).send({computer:'vm',vmExecution:'worker'}).expect(200)
 expect(worker.body.agent).toMatchObject({vmExecution:'worker',allowHostEnvironment:false})
 await request(app.callback()).put(path).send({computer:'vm',vmExecution:'profile',allowHostEnvironment:false}).expect(400)
 await request(app.callback()).put(path).send({computer:'vm',vmExecution:'profile'}).expect(200)
 const legacy=await request(app.callback()).put(path).send({computer:'vm',allowHostEnvironment:false}).expect(200)
 expect(legacy.body.agent).toMatchObject({vmExecution:'worker',allowHostEnvironment:false})
 store.updateAgent('owner',agent.id,{vmExecution:'profile'})
 expect(store.updateAgent('owner',agent.id,{allowHostEnvironment:false})).toMatchObject({vmExecution:'worker',allowHostEnvironment:false})
 await request(app.callback()).put(path).send({computer:'vm',vmExecution:'profile'}).expect(200)
 await request(app.callback()).put(path).send({computer:'off'}).expect(200)
 expect(store.require<any>('owner','agent',agent.id)).toMatchObject({vmExecution:'worker',allowHostEnvironment:false})
})
it('allows the host option for cloud and VM only and clears it when selecting another environment',async()=>{
 const {cloud}=fakeCloud(),agent=store.createAgent('owner',{name:'云端本机选项',profile:'default',computer:'cloud'})
 const available=vi.spyOn(cloud,'requireAvailable').mockResolvedValue(),connect=vi.spyOn(cloud,'connect').mockResolvedValue({} as any)
 nodes.runnerTarget=()=>({runner:{id:'fixture'}} as any)
 const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(error:any){ctx.status=error.status??500;ctx.body={error:error.message}}});app.use(bodyParser());app.use(cloud.router().routes())
 const path=`/api/app/agents/${agent.id}/computer-selection`
 for(const computer of ['cloud','vm']){
  const enabled=await request(app.callback()).put(path).send({computer,allowHostEnvironment:true}).expect(200)
  expect(enabled.body.agent).toMatchObject({computer,allowHostEnvironment:true})
 }
 expect(connect).not.toHaveBeenCalled();expect(available).not.toHaveBeenCalled()
 for(const computer of ['auto','off','local','browser']){
  store.updateAgent('owner',agent.id,{computer:'vm',execution:'computer',allowHostEnvironment:true})
  const switched=await request(app.callback()).put(path).send({computer,allowHostEnvironment:true}).expect(200)
  expect(switched.body.agent.allowHostEnvironment).toBe(false)
  const returned=await request(app.callback()).put(path).send({computer:'vm'}).expect(200)
  expect(returned.body.agent.allowHostEnvironment).toBe(false)
 }
 await request(app.callback()).put(path).send({computer:'hybrid'}).expect(400)
 expect(grokComputerRules(true)).toContain('基础 Profile 已授权的本机文件和终端工具')
 expect(grokComputerRules(false)).toContain('本轮不要使用本机终端')
})
it('clears inapplicable host grants through generic updates and migrates the previous combined choice once',()=>{
 const agent=store.createAgent('owner',{name:'权限迁移',profile:'default',computer:'vm',execution:'computer',allowHostEnvironment:true})
 expect(store.updateAgent('owner',agent.id,{computer:'auto'}).allowHostEnvironment).toBe(false)
 store.put('owner','agent',agent.id,{...agent,computer:'hybrid',allowHostEnvironment:undefined})
 store.db.prepare('DELETE FROM workspace_migrations WHERE id=?').run('host-environment-option-v1')
 store.close();store=new WorkspaceStore(home)
 expect(store.require<any>('owner','agent',agent.id)).toMatchObject({computer:'vm',allowHostEnvironment:true})
 store.updateAgent('owner',agent.id,{computer:'off'});store.close();store=new WorkspaceStore(home)
 expect(store.require<any>('owner','agent',agent.id)).toMatchObject({computer:'off',allowHostEnvironment:false})
})

it('auto observation never provisions; multiple robots share one cloud connection with private credentials',async()=>{
 const {cloud,token,counts}=fakeCloud();await cloud.configure('owner',token,'0.47.0')
 await cloud.state('owner');await cloud.status('owner');expect(counts()).toEqual({ensure:0,exec:0})
 const a=store.createAgent('owner',{name:'甲',profile:'default',computer:'cloud'}),b=store.createAgent('owner',{name:'乙',profile:'different',computer:'cloud'})
 await Promise.all([cloud.call('owner',a.id,'cloud_computer_shell',{command:'pwd'}),cloud.call('owner',b.id,'cloud_computer_shell',{command:'pwd'})])
 expect(counts()).toEqual({ensure:1,exec:2})
 expect(JSON.stringify(store.list('owner','grok-cloud'))).not.toContain(token)
 await expect(cloud.call('other',a.id,'cloud_computer_shell',{command:'pwd'})).rejects.toThrow()
 await expect(cloud.configure('other',token,'0.47.0')).rejects.toThrow('其他用户')
})

it('allows only one human controller for a shared cloud computer and resumes queued robot tools on return',async()=>{
 const {cloud,token,counts}=fakeCloud();await cloud.configure('owner',token,'0.47.0')
 const a=store.createAgent('owner',{name:'甲',profile:'default',computer:'cloud'}),b=store.createAgent('owner',{name:'乙',profile:'default',computer:'cloud'})
 const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(error:any){ctx.status=error.status??500;ctx.body={error:error.message}}});app.use(bodyParser());app.use(cloud.router().routes())
 const take=await request(app.callback()).post(`/api/app/agents/${a.id}/computer/take`).send({requestId:randomUUID()})
 expect(take.status).toBe(200);expect(take.body.mode).toBe('human')
 const denied=await request(app.callback()).post(`/api/app/agents/${b.id}/computer/take`).send({requestId:randomUUID()});expect(denied.status).toBe(409)
 const work=cloud.call('owner',b.id,'cloud_computer_shell',{command:'pwd'})
 await new Promise(resolve=>setTimeout(resolve,30));expect(counts().exec).toBe(0)
 const returned=await request(app.callback()).post(`/api/app/agents/${a.id}/computer/giveback`).send({controlId:take.body.controlId,token:take.body.token,notes:'完成登录'})
 expect(returned.status).toBe(200);await work;expect(counts().exec).toBe(1)
 expect(store.list('_system','computer-control')).toEqual([])
})

it('keeps cloud tools paused after a lost human lease until a new explicit handback',async()=>{
 const {cloud,token,counts}=fakeCloud();await cloud.configure('owner',token,'0.47.0')
 const agent=store.createAgent('owner',{name:'交还验收',profile:'default',computer:'cloud'})
 const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(error:any){ctx.status=error.status??500;ctx.body={error:error.message}}});app.use(bodyParser());app.use(cloud.router().routes())
 const base=`/api/app/agents/${agent.id}/computer`
 await request(app.callback()).post(base+'/take').send({requestId:randomUUID()})
 ;(cloud as any).manual.get('owner').expiresAt=Date.now()-1
 expect(await cloud.status('owner')).toMatchObject({mode:'error'})
 const work=cloud.call('owner',agent.id,'cloud_computer_shell',{command:'pwd'})
 await new Promise(resolve=>setTimeout(resolve,30));expect(counts().exec).toBe(0)
 const renewed=await request(app.callback()).post(base+'/take').send({requestId:randomUUID()});expect(renewed.status).toBe(200)
 await request(app.callback()).post(base+'/giveback').send({controlId:renewed.body.controlId,token:renewed.body.token,notes:'已完成登录'})
 expect(await work).toMatchObject({handoffNote:'已完成登录'});expect(counts().exec).toBe(1)
})
