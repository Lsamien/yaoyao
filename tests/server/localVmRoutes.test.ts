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
import {saveHostTools} from '../../src/server/hostToolSettings'

function fixture(options:{docker?:boolean;licensed?:string[]}={}){
 const home=mkdtempSync(join(tmpdir(),'local-vm-routes-')),store=new WorkspaceStore(home)
 let version=1
 const licensed=new Set(options.licensed??['alice','carol'])
 const auth:any={
  require:(ctx:any)=>({id:ctx.get('x-owner')||'alice'}),
  requireAdmin:(ctx:any)=>{if(ctx.get('x-admin')!=='yes')throw new HttpError(403,'需要管理员权限','admin_required');return {id:'alice'}},
  isAdminActive:(owner:string)=>owner==='alice',isUserActive:()=>true,pushAuthorizationVersion:()=>version,
  canUseVm:(owner:string)=>licensed.has(owner),
 }
 const runner={id:randomUUID(),enabled:true,sourceNodeId:'local',sourceOwner:'_system'}
 const nodes:any={requireSource:vi.fn()}
 const hub:any={records:()=>[runner],summary:()=>({online:true,features:['local-vm-v1','bot-desktops-v1']}),
  localVm:vi.fn(async()=>({configured:true,daemonUp:true,image:true,mode:'shared',maxInstances:2,maxDesktops:4,busy:false})),
  systemLocalVm:vi.fn(async(_owner:string,_runner:string,payload:any)=>payload.op==='adopt'?{adopted:payload.sources.map((s:any)=>s.environmentId)}:{ok:true}),
  computer:vi.fn(async()=>({container:'running',ready:true}))}
 const shared=new SharedComputers(store,auth,nodes,hub)
 const create=()=>new LocalVmService(store,auth,nodes,hub,shared,{home,...(options.docker?{deployment:'docker'}:{})} as any)
 const mount=(service:LocalVmService)=>{const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(e){ctx.status=(e as any).status||500;ctx.body={error:String(e),code:(e as any).code}}});app.use(bodyParser());app.use(service.router().routes());app.use(shared.router().routes());return app.callback()}
 return {home,store,auth,hub,runner,licensed,create,mount,bump(){version++},close(){store.close();rmSync(home,{recursive:true,force:true})}}
}

it('protects administration, licenses each account and gives every account one computer with a desktop per Bot',async()=>{
 const f=fixture(),service=f.create(),app=f.mount(service),base='/api/app/admin/local-vm'
 try{
  // Administration stays administrator-only and validated.
  await request(app).put(base+'/idle-policy').send({requestId:randomUUID(),idleStopMinutes:0}).expect(403)
  for(const minutes of [-1,0.5,10081,null])await request(app).put(base+'/idle-policy').set('x-admin','yes').send({requestId:randomUUID(),idleStopMinutes:minutes}).expect(400)
  await request(app).put(base+'/idle-policy').set('x-admin','yes').send({requestId:randomUUID(),idleStopMinutes:0}).expect(200)
  const id=randomUUID()
  await request(app).post(base+'/prepare').send({requestId:id}).expect(403)
  await request(app).post(base+'/prepare').set('x-admin','yes').send({requestId:id,imageId:'arbitrary'}).expect(400)
  await request(app).post(base+'/prepare').set('x-admin','yes').send({requestId:id,imageKey:'cursor'}).expect(200)
  expect(f.hub.localVm).toHaveBeenLastCalledWith('alice',f.runner.id,expect.objectContaining({op:'prepare',imageKey:'cursor'}))
  expect(service.allowed(id,f.runner.id)).toBe(true);expect(service.allowed(id,randomUUID())).toBe(false)
  f.bump();expect(service.allowed(id,f.runner.id)).toBe(false)
  // The sharing mode is gone; only capacity can be set.
  await request(app).put(base+'/policy').set('x-admin','yes').send({requestId:randomUUID(),mode:'per-bot',maxInstances:2}).expect(400)
  await request(app).put(base+'/policy').set('x-admin','yes').send({requestId:randomUUID(),maxInstances:3,maxDesktops:9}).expect(400)
  await request(app).put(base+'/policy').set('x-admin','yes').send({requestId:randomUUID(),maxInstances:3,maxDesktops:5}).expect(200)
  expect(f.hub.localVm).toHaveBeenCalledWith('alice',f.runner.id,expect.objectContaining({op:'policy',maxInstances:3,maxDesktops:5}))

  // An unlicensed sub-account sees no VM and cannot enable or start one.
  const bobBot=f.store.createAgent('bob',{name:'未开通',profile:'default'})
  expect((await request(app).get(`/api/app/agents/${bobBot.id}/local-vm`).set('x-owner','bob').expect(200)).body).toMatchObject({enabled:false,licensed:false,supported:true})
  expect((await request(app).put(`/api/app/agents/${bobBot.id}/local-vm`).set('x-owner','bob').send({enabled:true}).expect(403)).body.code).toBe('local_vm_unlicensed')
  expect((await request(app).post(`/api/app/agents/${bobBot.id}/local-vm/start`).set('x-owner','bob').send({}).expect(403)).body.code).toBe('local_vm_unlicensed')
  expect(f.hub.computer).not.toHaveBeenCalled()

  // A licensed account: every Bot joins the same account computer.
  const one=f.store.createAgent('carol',{name:'甲',profile:'default'}),two=f.store.createAgent('carol',{name:'乙',profile:'default'})
  await request(app).put(`/api/app/agents/${one.id}/local-vm`).set('x-owner','carol').send({enabled:true}).expect(200)
  await request(app).put(`/api/app/agents/${two.id}/local-vm`).set('x-owner','carol').send({enabled:true}).expect(200)
  const a=f.store.require<any>('carol','agent',one.id),b=f.store.require<any>('carol','agent',two.id)
  expect(a.execution).toBe('computer');expect(a.computerEnvironmentId).toBeTruthy()
  expect(b.computerEnvironmentId).toBe(a.computerEnvironmentId)
  expect(a.computerEnvironmentId).not.toBe(f.store.list<any>('alice','shared-computer')[0]?.id)
  // Panel actions touch only the Bot's own desktop, so another Bot's running task does not block them.
  f.store.put('carol','turn','busy',{agentId:two.id,status:'running'})
  await request(app).post(`/api/app/agents/${one.id}/local-vm/start`).set('x-owner','carol').send({}).expect(200)
  expect(f.hub.computer).toHaveBeenLastCalledWith('carol',expect.objectContaining({id:one.id,computerEnvironmentId:a.computerEnvironmentId}),'lifecycle',{action:'start'},expect.any(Function))
  await request(app).post(`/api/app/agents/${two.id}/local-vm/stop`).set('x-owner','carol').send({}).expect(409)
  // The image belongs to the whole account computer.
  await request(app).put(`/api/app/agents/${one.id}/local-vm/image`).set('x-owner','carol').send({imageKey:'standard'}).expect(409)
  f.store.remove('carol','turn','busy')
  await request(app).put(`/api/app/agents/${one.id}/local-vm/image`).set('x-owner','carol').send({imageKey:'standard'}).expect(200)
  await request(app).get(`/api/app/agents/${one.id}/local-vm`).set('x-owner','bob').expect(404)
  // Hand-made shared computers are retired.
  await request(app).post('/api/app/computers/shared').set('x-owner','carol').send({}).expect(410)
  // Turning the VM off frees only this Bot's desktop.
  await request(app).put(`/api/app/agents/${two.id}/local-vm`).set('x-owner','carol').send({enabled:false}).expect(200)
  expect(f.hub.computer).toHaveBeenLastCalledWith('carol',expect.objectContaining({id:two.id}),'lifecycle',{action:'remove'},expect.any(Function))
  expect(f.store.require<any>('carol','agent',two.id).computer).toBe('off')

  // Revoking the license stops the account computer with a server grant, not an admin grant.
  f.licensed.delete('carol')
  await service.revokeUser('carol')
  const stop=f.hub.systemLocalVm.mock.calls.find((c:any[])=>c[0]==='carol'&&c[2].op==='instance'&&c[2].environmentId===a.computerEnvironmentId)
  expect(stop?.[2]).toMatchObject({action:'stop'})
  expect(service.allowed(stop![2].id,f.runner.id)).toBe(true)
  await request(app).post(`/api/app/agents/${one.id}/local-vm/start`).set('x-owner','carol').send({}).expect(403)
  // The global switch closes VMs for everyone, administrators included.
  saveHostTools(f.home,{vm:false})
  expect((await request(app).post(`/api/app/agents/${one.id}/local-vm/start`).send({}).expect(409)).body.code).toBe('local_vm_disabled')
 }finally{await service.close();f.close()}
})

it('never offers virtual machines in a Docker deployment',async()=>{
 const f=fixture({docker:true}),service=f.create(),app=f.mount(service)
 try{
  expect(await service.status('alice')).toMatchObject({supported:false,configured:false})
  expect((await request(app).post('/api/app/admin/local-vm/prepare').set('x-admin','yes').send({requestId:randomUUID()}).expect(409)).body.code).toBe('local_vm_docker_unsupported')
  expect((await request(app).put('/api/app/admin/local-vm/policy').set('x-admin','yes').send({requestId:randomUUID(),maxInstances:2}).expect(409)).body.code).toBe('local_vm_docker_unsupported')
  const bot=f.store.createAgent('alice',{name:'Docker',profile:'default'})
  expect((await request(app).get(`/api/app/agents/${bot.id}/local-vm`).expect(200)).body).toMatchObject({enabled:false,supported:false})
  await request(app).put(`/api/app/agents/${bot.id}/local-vm`).send({enabled:true}).expect(409)
  expect(f.hub.localVm).not.toHaveBeenCalled();expect(f.hub.computer).not.toHaveBeenCalled()
 }finally{await service.close();f.close()}
})

it('moves per-Bot and hand-made shared computers into the account computer once, copying their data',async()=>{
 const f=fixture()
 try{
  // Bots from the old per-Bot mode (no account computer yet) and an old hand-made shared computer.
  const solo=f.store.createAgent('alice',{name:'独立',profile:'default',execution:'computer'})
  const x=f.store.createAgent('alice',{name:'共享甲',profile:'default',execution:'computer'}),y=f.store.createAgent('alice',{name:'共享乙',profile:'default',execution:'computer'})
  const old={id:randomUUID(),name:'旧共享电脑',memberIds:[x.id,y.id],nodeId:'local',profile:'*',runnerId:f.runner.id,archived:false,createdAt:1}
  f.store.put('alice','shared-computer',old.id,old)
  for(const bot of [x,y])f.store.put('alice','agent',bot.id,{...f.store.require<any>('alice','agent',bot.id),computerEnvironmentId:old.id})
  const service=f.create()
  try{
   await service.status('alice');await (service as any).migrating.get('alice')
   const target=f.store.require<any>('alice','agent',solo.id).computerEnvironmentId
   expect(target).toBeTruthy()
   for(const bot of [x,y])expect(f.store.require<any>('alice','agent',bot.id).computerEnvironmentId).toBe(target)
   const adopt=f.hub.systemLocalVm.mock.calls.find((c:any[])=>c[2].op==='adopt')!
   expect(adopt[2]).toMatchObject({environmentId:target})
   expect(adopt[2].sources).toEqual(expect.arrayContaining([{environmentId:solo.id,agentId:solo.id},{environmentId:old.id,agentId:x.id}]))
   expect(adopt[2].sources).toHaveLength(2)
   expect(f.store.get<any>('_system','local-vm-migration','alice')).toMatchObject({done:true})
   // Once is enough.
   await service.status('alice');await (service as any).migrating.get('alice')
   expect(f.hub.systemLocalVm.mock.calls.filter((c:any[])=>c[2].op==='adopt')).toHaveLength(1)
   // Bots created later join the account computer directly.
   const later=f.store.createAgent('alice',{name:'后加入',profile:'default'})
   expect(f.store.require<any>('alice','agent',later.id).computerEnvironmentId).toBe(target)
  }finally{await service.close()}
 }finally{f.close()}
})
