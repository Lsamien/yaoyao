// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {ComputerRuntime} from '../../src/runner/worker/gateway'
import {LocalVmImages} from '../../src/runner/computers/localVm'
import {UNCONFIGURED_COMPUTER_IMAGE} from '../../src/shared/runner'

async function fixture(){
 const home=await mkdtemp(join(tmpdir(),'yaoyao-local-vm-')),db=new DatabaseSync(':memory:')
 const runtime=new ComputerRuntime(db,{protocol:1,runnerId:randomUUID(),serverURL:'http://127.0.0.1',hermesURL:'http://127.0.0.1',token:'fixture',allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:UNCONFIGURED_COMPUTER_IMAGE,python:'/fixture/python',hermesSource:'/fixture/source',hermesHome:'/fixture/home'}},home)
 await runtime.ready
 const running=new Set<string>()
 vi.spyOn(runtime.provider,'verifyRuntime').mockResolvedValue()
 vi.spyOn(runtime.provider,'ensure').mockImplementation(async s=>{running.add(s.id);return {id:s.id,containerId:s.id,workspace:'/fixture',running:true,isolation:'container'}})
 vi.spyOn(runtime.provider,'stop').mockImplementation(async s=>{running.delete(s.id)})
 vi.spyOn(runtime.provider,'remove').mockImplementation(async s=>{running.delete(s.id)})
 vi.spyOn(runtime.provider,'health').mockResolvedValue({})
 vi.spyOn(runtime.provider,'capture').mockResolvedValue({data:'fixture',width:1280,height:900,capturedAt:Date.now()})
 vi.spyOn(runtime.provider,'deleteWorkspace').mockResolvedValue()
 return {db,runtime,running,async close(){await runtime.controls.close();await runtime.pool.close();db.close();await rm(home,{recursive:true,force:true})}}
}
it('defaults older settings to five minutes and persists never-stop independently of sharing policy',async()=>{
 const f=await fixture(),manager=new LocalVmImages(f.runtime,f.db)
 try{
  await manager.ready;expect((await manager.status()).idleStopMinutes).toBe(5)
  await manager.idlePolicy(0);await manager.policy('shared',3)
  expect(f.runtime.pool.idleStopMinutes).toBe(0)
  expect(JSON.parse(String(f.db.prepare('SELECT value FROM local_vm_runtime').get()?.value)).idleStopMinutes).toBe(0)
  for(const minutes of [-1,1.5,10081,NaN])await expect(manager.idlePolicy(minutes)).rejects.toMatchObject({code:'local_vm_idle_policy_invalid'})
  await manager.close();const restored=new LocalVmImages(f.runtime,f.db)
  await restored.ready;expect((await restored.status()).idleStopMinutes).toBe(0)
  await restored.idlePolicy(30);expect(f.runtime.pool.idleStopMinutes).toBe(30);await restored.close()
 }finally{await manager.close();await f.close()}
})
it('prepares one managed image, verifies the desktop, applies it and persists it without a catalog step',async()=>{
 const f=await fixture(),manager=new LocalVmImages(f.runtime,f.db),imageId='sha256:'+'a'.repeat(64)
 try{
  vi.spyOn(manager.images,'run').mockResolvedValue(imageId)
  vi.spyOn(manager.images,'inspect').mockImplementation(async id=>{if(id!==imageId)throw new Error('not ready');return {protocol:1,imageId,architecture:'arm64',driver:'0.20.0',layer:'5',createdAt:1}})
  await manager.ready
  expect((await manager.status()).image).toBe(false)
  const id=randomUUID(),check=vi.fn(async()=>{})
  await manager.prepare(id,check)
  await vi.waitFor(async()=>expect((await manager.status()).job?.state).toBe('complete'))
  expect(f.runtime.config.imageId).toBe(imageId)
  expect(f.runtime.provider.capture).toHaveBeenCalledOnce()
  expect(f.running.size).toBe(0)
  await manager.prepare(id,check)
  expect(f.runtime.provider.capture).toHaveBeenCalledOnce()
  await manager.close()
  const resumed=new LocalVmImages(f.runtime,f.db);await resumed.ready
  expect(f.runtime.config.imageId).toBe(imageId);await resumed.close()
 }finally{await manager.close();await f.close()}
})
it('retains completed desktop state but fences the old lease and counts idle desktops against capacity',async()=>{
 const f=await fixture(),spec={id:randomUUID(),ownerKey:'owner',imageId:'sha256:'+'a'.repeat(64)}
 try{
  await f.runtime.pool.desktop(spec,'create',()=>{})
  expect(f.running.has(spec.id)).toBe(true)
  expect((await f.runtime.controls.status({agentId:spec.id,environmentId:spec.id,ownerKey:'owner'})).mode).toBe('idle')
  const lease=await f.runtime.pool.acquire(spec,'turn-1',()=>{})
  await f.runtime.pool.release(lease,true)
  expect(()=>f.runtime.pool.use(lease,async()=>{})).toThrow()
  const second={...spec,id:randomUUID()};await f.runtime.pool.desktop(second,'create',()=>{})
  await expect(f.runtime.pool.desktop({...spec,id:randomUUID()},'create',()=>{})).rejects.toMatchObject({code:'computer_quota'})
  await expect(f.runtime.pool.desktop({...spec,ownerKey:'other'},'remove',()=>{})).rejects.toMatchObject({code:'computer_owner_mismatch'})
  await f.runtime.pool.desktop(spec,'stop',()=>{});expect(f.running.has(spec.id)).toBe(false)
  await f.runtime.pool.desktop(spec,'start',()=>{});expect(f.running.has(spec.id)).toBe(true)
  await f.runtime.pool.desktop(spec,'recreate',()=>{});expect(f.running.has(spec.id)).toBe(true)
  await f.runtime.pool.desktop(spec,'remove',()=>{});expect(f.runtime.pool.definition('owner',spec.id)).toBeUndefined()
  expect(f.runtime.provider.deleteWorkspace).not.toHaveBeenCalled()
 }finally{await f.close()}
})
it('refuses lifecycle changes while a human or Agent holds the VM',async()=>{
 const f=await fixture(),spec={id:randomUUID(),ownerKey:'owner',imageId:'sha256:'+'a'.repeat(64)}
 try{
  const lease=await f.runtime.pool.acquire(spec,'human:test',()=>{})
  for(const action of ['stop','remove','recreate'] as const)await expect(f.runtime.pool.desktop(spec,action,()=>{})).rejects.toMatchObject({code:'computer_busy'})
  await f.runtime.pool.release(lease)
 }finally{await f.close()}
})
it('allows sharing policy changes with idle desktops but preserves active leases and image maintenance guards',async()=>{
 const f=await fixture(),manager=new LocalVmImages(f.runtime,f.db),spec={id:randomUUID(),ownerKey:'owner',imageId:'sha256:'+'a'.repeat(64)}
 try{
  await manager.ready
  await f.runtime.pool.desktop(spec,'create',()=>{})
  expect(f.runtime.pool.status('owner')[0]?.status).toBe('idle')
  await manager.policy('shared',3)
  expect(f.running.has(spec.id)).toBe(true)
  expect((await manager.status()).mode).toBe('shared')
  expect(f.runtime.pool.limits.concurrent).toBe(3)
  expect(()=>f.runtime.pool.beginMaintenance()).toThrow()
  const lease=await f.runtime.pool.acquire(spec,'human:fixture',()=>{})
  await expect(manager.policy('per-bot',2)).rejects.toMatchObject({code:'computer_busy'})
  expect((await manager.status()).mode).toBe('shared')
  expect(f.runtime.pool.limits.concurrent).toBe(3)
  await f.runtime.pool.release(lease,true)
  await manager.policy('per-bot',2)
  expect((await manager.status()).mode).toBe('per-bot')
  expect(f.running.has(spec.id)).toBe(true)
  await f.runtime.pool.desktop(spec,'stop',()=>{})
  const release=f.runtime.pool.beginMaintenance();release()
 }finally{await manager.close();await f.close()}
})
it('creates without a model and can stop or remove an existing desktop after Profile resolution fails',async()=>{
 const f=await fixture(),meta={environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'owner'}
 try{
  f.runtime.config.imageId='sha256:'+'a'.repeat(64)
  const model=vi.spyOn(f.runtime,'resolve').mockRejectedValue(new Error('model unavailable'))
  const workspace=vi.spyOn(f.runtime,'resolveWorkspace').mockResolvedValue({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:'.'})
  await f.runtime.desktop(meta,'default','create',()=>{})
  expect(f.running.has(meta.environmentId)).toBe(true)
  expect(f.runtime.pool.definition('owner',meta.environmentId)?.cwd).toBe('/home/cua/workspace')
  workspace.mockRejectedValue(new Error('Profile was removed'))
  await f.runtime.desktop(meta,'default','stop',()=>{})
  expect(f.running.has(meta.environmentId)).toBe(false)
  await f.runtime.desktop(meta,'default','remove',()=>{})
  expect(f.runtime.pool.definition('owner',meta.environmentId)).toBeUndefined()
  expect(workspace).toHaveBeenCalledOnce()
  expect(model).not.toHaveBeenCalled()
  expect(f.runtime.provider.deleteWorkspace).not.toHaveBeenCalled()
 }finally{await f.close()}
})
it('keeps uncertain preparation cleanup fenced and retries cleanup when runtime recovers',async()=>{
 const f=await fixture(),manager=new LocalVmImages(f.runtime,f.db),imageId='sha256:'+'a'.repeat(64)
 let canStop=false
 try{
  await manager.ready
  vi.spyOn(manager.images,'run').mockResolvedValue(imageId)
  vi.spyOn(manager.images,'inspect').mockResolvedValue({protocol:1,imageId,architecture:'arm64',driver:'0.20.0',layer:'5',createdAt:1})
  vi.mocked(f.runtime.provider.remove).mockImplementation(async()=>{if(!canStop)throw new Error('stop uncertain')})
  await manager.prepare(randomUUID(),async()=>{})
  await vi.waitFor(async()=>expect((await manager.status()).job?.state).toBe('failed'))
  expect(()=>f.runtime.pool.beginMaintenance()).toThrow()
  expect(f.runtime.config.imageId).toBe(UNCONFIGURED_COMPUTER_IMAGE)
  canStop=true;expect((await manager.status()).busy).toBe(false)
  const release=f.runtime.pool.beginMaintenance();release()
 }finally{canStop=true;await manager.close();await f.close()}
})

it('keeps two prepared images and binds one immutable image per independent or shared desktop',async()=>{
 const f=await fixture(),standard='sha256:'+'a'.repeat(64),cursor='sha256:'+'b'.repeat(64)
 f.runtime.config.imageId=standard
 const manager=new LocalVmImages(f.runtime,f.db)
 const manifest=(id:string)=>({protocol:1 as const,imageId:id,architecture:'amd64' as const,driver:'0.20.0' as const,layer:'5' as const,imageKey:id===cursor?'cursor' as const:'standard' as const,createdAt:1})
 try{
  vi.spyOn(manager.images,'inspect').mockImplementation(async id=>manifest(id))
  vi.spyOn(manager.images,'run').mockResolvedValue(standard+'\n'+cursor)
  await manager.prepare(randomUUID(),async()=>{},'cursor')
  await vi.waitFor(async()=>expect((await manager.status()).job?.state).toBe('complete'))
  expect((await manager.status()).images?.filter(i=>i.ready).map(i=>i.key)).toEqual(['standard','cursor'])
  expect(f.runtime.config.imageId).toBe(standard)
  const a={environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'alice'},b={environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'alice'}
  await manager.select(a,'standard',()=>{})
  await manager.select(b,'cursor',()=>{})
  expect(f.runtime.imageFor(a)).toBe(standard);expect(f.runtime.imageFor(b)).toBe(cursor)
  expect(f.runtime.imageFor({...b,agentId:randomUUID()})).toBe(cursor)
  await expect(manager.select({...b,ownerKey:'bob'},'standard',()=>{})).rejects.toMatchObject({code:'computer_owner_mismatch'})
  vi.spyOn(f.runtime,'resolveWorkspace').mockResolvedValue({type:'resolved',cwd:'/home/cua/workspace',configuredCwd:'.'})
  await f.runtime.desktop(a,'default','create',()=>{})
  await f.runtime.desktop(b,'default','create',()=>{})
  expect(f.running.size).toBe(2)
  expect(f.runtime.pool.definition('alice',a.environmentId)?.imageId).toBe(standard)
  expect(f.runtime.pool.definition('alice',b.environmentId)?.imageId).toBe(cursor)
  await expect(manager.select(b,'standard',()=>{})).rejects.toMatchObject({code:'computer_image_in_use'})
  await f.runtime.desktop(b,'default','stop',()=>{})
  await expect(manager.select(b,'standard',()=>{})).rejects.toMatchObject({code:'computer_image_in_use'})
  await f.runtime.desktop(b,'default','remove',()=>{})
  expect(f.runtime.imageFor(b)).toBe(cursor)
  await manager.select(b,'standard',()=>{})
  expect(f.runtime.imageFor({...b,agentId:randomUUID()})).toBe(standard)
  expect(f.runtime.provider.deleteWorkspace).toHaveBeenCalledTimes(2) // Only preparation scratch space.
  await manager.close()
  const resumed=new LocalVmImages(f.runtime,f.db);await resumed.ready
  expect(f.runtime.imageFor(b)).toBe(standard)
  vi.spyOn(resumed.images,'inspect').mockImplementation(async id=>manifest(id))
  expect((await resumed.options()).filter(i=>i.ready)).toHaveLength(2)
  await resumed.close()
 }finally{await manager.close();await f.close()}
})

it('does not select an unprepared image or mutate a choice after authorization expires',async()=>{
 const f=await fixture(),manager=new LocalVmImages(f.runtime,f.db),meta={environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'alice'}
 try{
  await expect(manager.select(meta,'cursor',()=>{})).rejects.toMatchObject({code:'computer_image_required'})
  expect(f.runtime.imageFor(meta)).toBe(UNCONFIGURED_COMPUTER_IMAGE)
  const denied=()=>{throw new Error('expired')}
  await expect(manager.select(meta,'standard',denied)).rejects.toThrow('expired')
  expect(f.db.prepare('SELECT * FROM computer_image_bindings').all()).toEqual([])
 }finally{await manager.close();await f.close()}
})

it('does not fall back to the standard recipe when Cursor preparation fails',async()=>{
 const f=await fixture(),standard='sha256:'+'a'.repeat(64)
 f.runtime.config.imageId=standard
 const manager=new LocalVmImages(f.runtime,f.db)
 try{
  vi.spyOn(manager.images,'run').mockResolvedValue(standard)
  vi.spyOn(manager.images,'inspect').mockResolvedValue({protocol:1,imageId:standard,architecture:'arm64',driver:'0.20.0',layer:'5',createdAt:1})
  const prepare=vi.spyOn(manager.images,'prepare').mockRejectedValue(new Error('cursor build failed'))
  const id=randomUUID()
  await manager.prepare(id,async()=>{},'cursor')
  await vi.waitFor(async()=>expect((await manager.status()).job?.state).toBe('failed'))
  expect(prepare).toHaveBeenCalledWith(expect.any(String),'cursor')
  expect(f.runtime.config.imageId).toBe(standard)
  expect((await manager.options()).find(i=>i.key==='cursor')?.ready).toBe(false)
  await expect(manager.prepare(id,async()=>{},'standard')).rejects.toMatchObject({code:'idempotency_conflict'})
 }finally{await manager.close();await f.close()}
})
