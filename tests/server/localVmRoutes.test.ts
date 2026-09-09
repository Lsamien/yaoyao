// @vitest-environment node
import {it,expect,vi} from 'vitest'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {LocalVmService} from '../../src/server/localVm'
import {SharedComputers} from '../../src/server/sharedComputers'
import {HttpError} from '../../src/server/errors'

it('protects preparation, removes the old catalog API and scopes sharing to the account and profile',async()=>{
 const home=mkdtempSync(join(tmpdir(),'local-vm-routes-')),store=new WorkspaceStore(home)
 let version=1,active=true
 const auth:any={require:(ctx:any)=>({id:ctx.get('x-owner')||'alice'}),requireAdmin:(ctx:any)=>{if(ctx.get('x-admin')!=='yes'||!active)throw new HttpError(403,'需要管理员权限','admin_required');return {id:'alice'}},isAdminActive:()=>active,pushAuthorizationVersion:()=>version}
 const runner={id:randomUUID(),enabled:true,sourceNodeId:'local',sourceOwner:'_system'}
 const nodes:any={requireSource:vi.fn()}
 const hub:any={records:()=>[runner],summary:()=>({online:true}),localVm:vi.fn(async()=>({configured:true,daemonUp:true,image:true,mode:'per-bot',maxInstances:2,busy:false})),computer:vi.fn(async()=>({container:'running',ready:true}))}
 const shared=new SharedComputers(store,auth,nodes,hub),service=new LocalVmService(store,auth,nodes,hub,shared,{home} as any),app=new Koa()
 app.use(async(ctx,next)=>{try{await next()}catch(e){ctx.status=(e as any).status||500;ctx.body={error:String(e)}}});app.use(bodyParser());app.use(service.router().routes())
 try{
  const first=store.createAgent('alice',{name:'甲',profile:'default',execution:'computer'}),second=store.createAgent('alice',{name:'乙',profile:'default',execution:'computer'})
  const chatting=store.createAgent('alice',{name:'普通聊天成员',profile:'server'})
  store.put('alice','turn','ordinary-chat',{agentId:chatting.id,status:'running'})
  const other=store.createAgent('bob',{name:'其他账号',profile:'default',execution:'computer'})
  const id=randomUUID(),base='/api/app/admin/local-vm'
  await request(app.callback()).post(base+'/prepare').send({requestId:id}).expect(403)
  await request(app.callback()).post(base+'/prepare').set('x-admin','yes').send({requestId:id,imageId:'arbitrary'}).expect(400)
  await request(app.callback()).post(base+'/prepare').set('x-admin','yes').send({requestId:id}).expect(200)
  expect(service.allowed(id,runner.id)).toBe(true);expect(service.allowed(id,randomUUID())).toBe(false)
  version++;expect(service.allowed(id,runner.id)).toBe(false);version--
  await request(app.callback()).get(`/api/app/admin/runners/${runner.id}/images`).set('x-admin','yes').expect(404)
  await request(app.callback()).get(`/api/app/agents/${first.id}/local-vm`).set('x-owner','bob').expect(404)
  await request(app.callback()).put(base+'/policy').set('x-admin','yes').send({requestId:randomUUID(),mode:'shared',maxInstances:2}).expect(200)
  const a=store.require<any>('alice','agent',first.id),b=store.require<any>('alice','agent',second.id)
  expect(a.computerEnvironmentId).toBeTruthy();expect(b.computerEnvironmentId).toBe(a.computerEnvironmentId)
  expect(store.require('alice','agent',chatting.id)).toEqual(chatting)
  const later=store.createAgent('alice',{name:'后加入成员',profile:'default',execution:'computer'})
  expect(later.computerEnvironmentId).toBe(a.computerEnvironmentId)
  const disabled=await request(app.callback()).put(`/api/app/agents/${later.id}/local-vm`).send({enabled:false}).expect(200)
  expect(disabled.body.agent.execution).toBe('profile');expect(disabled.body.agent.computerEnvironmentId).toBeUndefined()
  expect(store.require<any>('alice','agent',first.id).computerEnvironmentId).toBe(a.computerEnvironmentId)
  expect(store.require<any>('bob','agent',other.id).computerEnvironmentId).toBeUndefined()
  await request(app.callback()).put(base+'/policy').set('x-admin','yes').send({requestId:randomUUID(),mode:'per-bot',maxInstances:2}).expect(200)
  expect(store.require<any>('alice','agent',first.id).computerEnvironmentId).toBeUndefined()
  expect(store.require('alice','agent',chatting.id)).toEqual(chatting)
  store.put('alice','turn','active-vm',{agentId:first.id,status:'uncertain'})
  hub.localVm.mockClear()
  const blocked=await request(app.callback()).put(base+'/policy').set('x-admin','yes').send({requestId:randomUUID(),mode:'shared',maxInstances:2}).expect(409)
  expect(blocked.body.error).toContain('请先停止「甲」')
  expect(hub.localVm).not.toHaveBeenCalled()
  store.remove('alice','turn','active-vm')
  const helper=store.createAgent('alice',{name:'临时任务助手',profile:'default',execution:'computer'},{createdByAgentId:first.id,createdFromRunId:randomUUID(),temporaryGoalId:randomUUID()})
  await request(app.callback()).post(`/api/app/agents/${helper.id}/local-vm/create`).send({}).expect(409)
  active=false;expect(service.allowed(id,runner.id)).toBe(false)
 }finally{store.close();rmSync(home,{recursive:true,force:true})}
})
