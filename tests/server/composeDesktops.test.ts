// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {SharedComputers} from '../../src/server/sharedComputers'
import {LocalVmService} from '../../src/server/localVm'
import {loadServerConfig} from '../../src/server/config'
import {ComposeDesktops,parseComposeDesktops} from '../../src/server/composeDesktops'
import {ComposeComputerProvider} from '../../src/runner/computers/compose'
import {ComputerPool} from '../../src/runner/computers/pool'
import {COMPOSE_DESKTOP_IMAGE} from '../../src/shared/composeDesktops'

it('accepts only fixed deployment socket paths and rejects undeclared desktop targets',async()=>{
 const desktop={id:randomUUID(),name:'共享桌面',socketPath:'/run/yaoyao-desktops/desktop-1/desktop.sock'}
 expect(parseComposeDesktops(JSON.stringify([desktop]))).toEqual([desktop])
 for(const path of ['/var/run/docker.sock','http://host:1234','/run/yaoyao-desktops/../../docker.sock'])expect(()=>parseComposeDesktops(JSON.stringify([{...desktop,socketPath:path}]))).toThrow()
 expect(()=>parseComposeDesktops(JSON.stringify([desktop,desktop]))).toThrow()
 await expect(new ComposeDesktops([desktop]).call(randomUUID(),'health')).rejects.toMatchObject({code:'compose_desktop_missing'})
 await expect(new ComposeDesktops([desktop]).call(desktop.id,'remove')).rejects.toMatchObject({code:'compose_desktop_managed'})
})

it('locks Compose capacity and binds existing desktops without allowing cross-account reuse',async()=>{
 const home=mkdtempSync(join(tmpdir(),'yaoyao-compose-routes-')),store=new WorkspaceStore(home)
 const desktops=[1,2].map(n=>({id:randomUUID(),name:`共享桌面 ${n}`,socketPath:`/run/yaoyao-desktops/desktop-${n}/desktop.sock`}))
 const config=loadServerConfig({HERMES_YAOYAO_HOME:home,HERMES_YAOYAO_COMPOSE_DESKTOPS:JSON.stringify(desktops)})
 const nodes=new WorkspaceNodes(store,config,{} as any),runner={id:randomUUID(),name:'执行端',enabled:true,sourceNodeId:'local',sourceOwner:'_system'}
 const auth:any={require:(ctx:any)=>({id:ctx.get('x-owner')||'alice'}),requireAdmin:(ctx:any)=>{if(ctx.get('x-admin')!=='yes')throw Object.assign(new Error('管理员权限'),{status:403});return {id:'alice'}}}
 const hub:any={records:()=>[runner],summary:()=>({online:true,features:['compose-desktops-v1']}),composeDesktops:{status:async()=>desktops.map(d=>({...d,online:true,ready:true}))},localVm:vi.fn()}
 const shared=new SharedComputers(store,auth,nodes,hub),service=new LocalVmService(store,auth,nodes,hub,shared,config),app=new Koa()
 app.use(async(ctx,next)=>{try{await next()}catch(e){ctx.status=(e as any).status||500;ctx.body={code:(e as any).code}}});app.use(bodyParser());app.use(service.router().routes())
 try{
  expect(await service.status('alice')).toMatchObject({fixedCapacity:true,maxInstances:2,mode:'shared'})
  for(const [verb,path,body] of [['post','/prepare',{requestId:randomUUID()}],['put','/policy',{requestId:randomUUID(),maxInstances:4,mode:'per-bot'}],['post',`/instances/${desktops[0]!.id}/remove`,{requestId:randomUUID()}]] as const){await request(app.callback())[verb]('/api/app/admin/local-vm'+path).set('x-admin','yes').send(body).expect(409,{code:'compose_desktop_managed'})}
  const first=store.createAgent('alice',{name:'研究员',profile:'default',computer:'cloud',allowHostEnvironment:true}),second=store.createAgent('alice',{name:'写作者',profile:'writer'}),other=store.createAgent('bob',{name:'其他账号',profile:'default'})
  const bind=(id:string,desktopId:string,owner='alice')=>request(app.callback()).put(`/api/app/agents/${id}/local-vm`).set('x-owner',owner).send({enabled:true,desktopId})
  await bind(first.id,randomUUID()).expect(400)
  await bind(first.id,desktops[0]!.id).expect(200);await bind(second.id,desktops[0]!.id).expect(200)
  expect(store.require('alice','agent',first.id)).toMatchObject({computer:'vm',execution:'computer',allowHostEnvironment:true})
  await request(app.callback()).put(`/api/app/agents/${first.id}/local-vm/image`).send({imageKey:'cursor'}).expect(409,{code:'compose_desktop_managed'})
  for(const id of [first.id,second.id])expect(()=>nodes.requireSource('alice',store.require('alice','agent',id))).not.toThrow()
  await bind(other.id,desktops[0]!.id,'bob').expect(403)
  expect((await service.status('bob')).desktops?.[0]?.available).toBe(false)
  for(const op of ['create','start','stop','recreate','remove'])await request(app.callback()).post(`/api/app/agents/${first.id}/local-vm/${op}`).send({}).expect(409)
  const child=store.createAgent('alice',{name:'团队新成员',profile:'default',execution:'computer'},{createdByAgentId:first.id,createdFromRunId:randomUUID()})
  expect(child.computerEnvironmentId).toBe(desktops[0]!.id)
  expect(hub.localVm).not.toHaveBeenCalled()
  expect((await service.status('alice')).maxInstances).toBe(2)
 }finally{nodes.close();await service.close();store.close();rmSync(home,{recursive:true,force:true})}
})

it('reuses a fixed desktop, rotates authorization and never creates or deletes its container',async()=>{
 const id=randomUUID(),db=new DatabaseSync(':memory:'),operations:any[]=[],tokens:string[]=[]
 const relay=vi.fn(async(target:string,op:string,body:any)=>{operations.push({target,op,body});if(op==='list')return [{id,name:'固定桌面',ready:true}];if(target!==id)throw new Error('unknown desktop');if(op==='health')return {instance:'boot-1',ready:true};if(op==='acquire'){const token=randomUUID();tokens.push(token);return {token,instance:'boot-1'}};if(op==='execute')return {stdout:'ok',stderr:'',exitCode:0};return {ok:true}})
 const provider=new ComposeComputerProvider(randomUUID(),'/fixture',relay),engine=vi.spyOn(provider,'run'),pool=new ComputerPool(db,provider),spec={id,ownerKey:'owner',imageId:COMPOSE_DESKTOP_IMAGE}
 try{
  await pool.recover()
  const first=await pool.acquire(spec,'agent-a',()=>{})
  await pool.use(first,c=>provider.execute(spec,['pwd'],c))
  await pool.use(first,c=>provider.execute(spec,['id','-u'],{...c,user:'root'}))
  await pool.release(first,true)
  expect(()=>pool.use(first,async()=>{})).toThrow()
  const second=await pool.acquire(spec,'agent-b',()=>{})
  expect(tokens[0]).not.toBe(tokens[1])
  await pool.release(second)
  expect(operations.filter(x=>x.op==='release').map(x=>x.body.cancel)).toEqual([false,true])
  expect(operations.filter(x=>x.op==='execute').map(x=>x.body.user)).toEqual(['cua','root'])
  expect(engine).not.toHaveBeenCalled()
 }finally{await pool.close();db.close()}
})

it('serializes Compose desktop input while keeping command work concurrent and skipping cancelled queued input',async()=>{
 const spec={id:randomUUID(),ownerKey:'owner',imageId:COMPOSE_DESKTOP_IMAGE},calls:string[]=[],held=new Map<string,()=>void>()
 const relay=vi.fn(async(_target:string,op:string,body:any)=>{
  if(op==='health')return {instance:'boot-1',ready:true}
  if(op==='acquire')return {token:'lease',instance:'boot-1'}
  if(op==='execute'){
   const name=String(body.argv[0]);calls.push(name)
   if(name.startsWith('hold'))await new Promise<void>(resolve=>held.set(name,resolve))
   return {stdout:name,stderr:'',exitCode:0}
  }
  return {ok:true}
 })
 const provider=new ComposeComputerProvider(randomUUID(),'/fixture',relay),abort=new AbortController()
 await provider.ensure(spec,()=>{})
 const gui=provider.execute(spec,['hold-gui'],{authorize:()=>{},lane:'gui'})
 await vi.waitFor(()=>expect(calls).toContain('hold-gui'))
 const cancelled=provider.execute(spec,['cancelled-gui'],{authorize:()=>{},lane:'gui',signal:abort.signal}).catch(error=>error)
 const next=provider.execute(spec,['next-gui'],{authorize:()=>{},lane:'gui'})
 const shell=provider.execute(spec,['hold-shell'],{authorize:()=>{}})
 try{
  await provider.execute(spec,['parallel-shell'],{authorize:()=>{}})
  expect(calls).toEqual(['hold-gui','hold-shell','parallel-shell'])
  abort.abort();held.get('hold-gui')!()
  await gui;await next
  expect(await cancelled).toMatchObject({code:'computer_cancelled'})
  expect(calls).not.toContain('cancelled-gui')
  expect(calls).toContain('next-gui')
 }finally{for(const release of held.values())release();await Promise.allSettled([gui,next,cancelled,shell])}
})

it('does not return a successful Compose command after its holder cancels',async()=>{
 const spec={id:randomUUID(),ownerKey:'owner',imageId:COMPOSE_DESKTOP_IMAGE},abort=new AbortController()
 const relay=vi.fn(async(_target:string,op:string)=>{
  if(op==='health')return {instance:'boot-1',ready:true}
  if(op==='acquire')return {token:'lease',instance:'boot-1'}
  if(op==='execute'){abort.abort();return {stdout:'late result',stderr:'',exitCode:0}}
  if(op==='cancel')return {ok:true,stopped:true}
  return {ok:true}
 })
 const provider=new ComposeComputerProvider(randomUUID(),'/fixture',relay)
 await provider.ensure(spec,()=>{})
 await expect(provider.execute(spec,['work'],{authorize:()=>{},signal:abort.signal,mayFence:()=>false})).rejects.toMatchObject({code:'computer_cancelled'})
 expect(relay.mock.calls.some(([,op])=>op==='release')).toBe(false)
})

it('cancels the in-flight Compose operation by ID and waits for a confirmed stop without releasing its shared lease',async()=>{
 const spec={id:randomUUID(),ownerKey:'owner',imageId:COMPOSE_DESKTOP_IMAGE},abort=new AbortController()
 let acknowledge:()=>void=()=>{}
 const relay=vi.fn(async(_target:string,op:string,body:any)=>{
  if(op==='health')return {instance:'boot-1',ready:true}
  if(op==='acquire')return {token:'lease',instance:'boot-1'}
  if(op==='execute')return new Promise(()=>{})
  if(op==='cancel'){await new Promise<void>(resolve=>{acknowledge=resolve});return {ok:true,stopped:true,operationId:body.operationId}}
  return {ok:true}
 })
 const provider=new ComposeComputerProvider(randomUUID(),'/fixture',relay)
 await provider.ensure(spec,()=>{})
 let finished=false
 const execution=provider.execute(spec,['work'],{authorize:()=>{},signal:abort.signal,mayFence:()=>false}).catch(error=>{finished=true;return error})
 await vi.waitFor(()=>expect(relay.mock.calls.some(([,op])=>op==='execute')).toBe(true))
 abort.abort()
 await vi.waitFor(()=>expect(relay.mock.calls.some(([,op])=>op==='cancel')).toBe(true))
 expect(finished).toBe(false)
 const execute=relay.mock.calls.find(([,op])=>op==='execute')![2],cancel=relay.mock.calls.find(([,op])=>op==='cancel')![2]
 expect(cancel).toMatchObject({token:'lease',instance:'boot-1',operationId:execute.operationId})
 expect(execute.operationId).toMatch(/^[a-f0-9-]{36}$/)
 acknowledge()
 expect(await execution).toMatchObject({code:'computer_cancelled'})
 expect(relay.mock.calls.some(([,op])=>op==='release')).toBe(false)
})

it('reports an unconfirmed Compose cancellation without claiming that shared work has stopped',async()=>{
 const spec={id:randomUUID(),ownerKey:'owner',imageId:COMPOSE_DESKTOP_IMAGE},abort=new AbortController()
 const relay=vi.fn(async(_target:string,op:string)=>{
  if(op==='health')return {instance:'boot-1',ready:true}
  if(op==='acquire')return {token:'lease',instance:'boot-1'}
  if(op==='execute'){abort.abort();return {stdout:'late',stderr:'',exitCode:0}}
  if(op==='cancel')throw new Error('disconnected')
  return {ok:true}
 })
 const provider=new ComposeComputerProvider(randomUUID(),'/fixture',relay)
 await provider.ensure(spec,()=>{})
 await expect(provider.execute(spec,['work'],{authorize:()=>{},signal:abort.signal,mayFence:()=>false})).rejects.toMatchObject({code:'computer_cancel_uncertain'})
 expect(relay.mock.calls.some(([,op])=>op==='release')).toBe(false)
})
