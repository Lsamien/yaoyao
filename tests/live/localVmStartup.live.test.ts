// @vitest-environment node
import {expect,it} from 'vitest'
import Koa from 'koa'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes,type GatewayTarget} from '../../src/server/workspaceGateway'
import {LocalAuthStore} from '../../src/server/localAuth'
import {RunnerHub} from '../../src/server/runnerHub'
import {SharedComputers} from '../../src/server/sharedComputers'
import {LocalVmService} from '../../src/server/localVm'
import {saveHostTools} from '../../src/server/hostToolSettings'
import {ComputerRuntime} from '../../src/runner/worker/gateway'
import {LocalVmImages} from '../../src/runner/computers/localVm'
import type {RunnerConfiguration} from '../../src/shared/runner'

class Auth extends LocalAuthStore {
  override isUserActive(owner:string){return owner==='startup-fixture'}
  override isAdminActive(owner:string){return this.isUserActive(owner)}
  override pushAuthorizationVersion(){return 1}
  override canUseSource(){return true}
}

it.skipIf(!process.env.YAOYAO_COMPUTER_IMAGE)('starts a real saved VM when the managed service restarts, before any Bot command',async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-startup-live-')),store=new WorkspaceStore(home),auth=new Auth(home)
  const owner='startup-fixture',ownerKey=createHash('sha256').update(owner).digest('hex')
  const app=new Koa(),server=createServer(app.callback())
  const target={url:new URL('http://127.0.0.1:1')} as GatewayTarget
  const hub=new RunnerHub(store,auth,target)
  app.use(async(ctx,next)=>{try{await next()}catch(error){ctx.status=(error as any).status??500;ctx.body={error:(error as Error).message,code:(error as any).code}}})
  app.use(hub.middleware())
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const config={home,upstream:target.url} as any,nodes=new WorkspaceNodes(store,config,target)
  const registered=hub.enroll(owner,{name:'启动验收',sourceNodeId:'local',allowedProfiles:['default']})
  const runnerConfig:RunnerConfiguration={protocol:1,runnerId:registered.runner.id,token:registered.token,serverURL:url,hermesURL:target.url.href,allowedProfiles:['default'],artifactRoots:[],computers:{runtime:'docker',imageId:process.env.YAOYAO_COMPUTER_IMAGE!,python:'/unused',hermesSource:home,hermesHome:home,network:'none'}}
  store.put('_system','local-vm-managed','local',{sealed:nodes.seal(runnerConfig)});saveHostTools(home,{vm:true})
  const bot=store.createAgent(owner,{name:'启动验收 Bot',profile:'default'})
  const directory=join(home,'runner-state','local-vm',runnerConfig.runnerId);await mkdir(directory,{recursive:true})
  const db=new DatabaseSync(join(directory,'runner-commands.sqlite3')),seed=new ComputerRuntime(db,runnerConfig,directory),images=new LocalVmImages(seed,db)
  const service=new LocalVmService(store,auth,nodes,hub,new SharedComputers(store,auth,nodes,hub),config)
  const spec={id:bot.id,ownerKey,imageId:runnerConfig.computers!.imageId,cwd:'/home/cua/workspace',network:'none' as const}
  let seeded=false
  try{
    await images.ready;await images.idlePolicy(0)
    await seed.pool.desktop(spec,'create',()=>{})
    await seed.provider.execute(spec,['/bin/sh','-c','printf startup-proof > startup.txt'],{authorize:()=>{}})
    await images.close();await seed.controls.close();await seed.pool.close();db.close();seeded=true
    expect(await seed.provider.inspect(spec)).toBeUndefined()
    await service.start(url)
    await expect.poll(async()=>(await seed.provider.inspect(spec))?.running,{timeout:30000,interval:250}).toBe(true)
    await (service as any).managed.warmup
    expect((service as any).problem).toBeUndefined()
    expect((await seed.provider.execute(spec,['cat','startup.txt'],{authorize:()=>{}})).stdout).toBe('startup-proof')
    const managed=(service as any).managed.agent.computers as ComputerRuntime
    expect(managed.pool.idleStopMinutes).toBe(0)
    expect(managed.pool.status(ownerKey)).toEqual([expect.objectContaining({status:'idle',holderIds:[]})])
    expect(store.list(owner,'turn')).toEqual([])
    await service.close();expect(await seed.provider.inspect(spec)).toBeUndefined()
    await service.start(url)
    await expect.poll(async()=>(await seed.provider.inspect(spec))?.running,{timeout:30000,interval:250}).toBe(true)
    await (service as any).managed.warmup
    expect((await seed.provider.execute(spec,['cat','startup.txt'],{authorize:()=>{}})).stdout).toBe('startup-proof')
  }finally{
    await service.close();hub.close()
    if(!seeded){await images.close();await seed.controls.close();await seed.pool.close();db.close()}
    await new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections()})
    nodes.close();store.close();await rm(home,{recursive:true,force:true})
  }
},120000)
