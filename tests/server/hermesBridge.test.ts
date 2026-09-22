// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import request from 'supertest'
import {HermesBridgeManager} from '../../src/server/hermesBridge'
import type {ServerConfig} from '../../src/server/config'
import type {DashboardController} from '../../src/server/dashboardController'
import {createAuthenticatedApplication,createUserAuthenticatedApplication} from './authenticatedApplication'

let home:string,config:ServerConfig
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'yaoyao-bridge-manager-'));writeFileSync(join(home,'config.yaml'),'{}')
  config={host:'127.0.0.1',port:15300,upstream:new URL('http://127.0.0.1:9119'),home,allowedHosts:new Set(),mediaRoot:home,attachmentsRoot:home,imagesRoot:home,mediaOwner:'fixture',allowInsecureLan:false,insecureLan:false,production:false}
})
afterEach(()=>{rmSync(home,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs()})
function fixture(dashboard?:DashboardController){
  let disk:any[]=[{profile:'default',exists:true,valid:true,enabled:true,installedVersion:'1.1.0',fingerprint:'old',filesCurrent:false},{profile:'writer',exists:true,valid:true,enabled:false,disabled:true,installedVersion:'1.2.0',fingerprint:'new',filesCurrent:true}]
  let live:any={ready:true,native_tools:true,in_process:true,computer_runtime_version:2,plugin_version:'1.1.0',plugin_fingerprint:'old'}
  let idle=true,gate:Promise<void>|undefined
  const run=vi.fn(async(_python:string,args:string[])=>{
    if(args.includes('--check'))return disk.map(row=>JSON.stringify(row)).join('\n')
    await gate
    const profile=args[args.indexOf('--profile')+1]
    disk=disk.map(row=>row.profile===profile?{...row,installedVersion:'1.2.0',fingerprint:'new',filesCurrent:true,enabled:true,disabled:false}:row)
    return JSON.stringify({profile,backup:join(home,'backups',profile),disabled:false})
  })
  const session={invalidateAuthentication:vi.fn(),request:vi.fn(async(path:string)=>({status:200,headers:new Headers(),body:Buffer.from(JSON.stringify(path==='/api/profiles'?{profiles:[{name:'default'},{name:'writer'}]}:live))}))}
  const manager=new HermesBridgeManager(config,session,{home,python:process.execPath,assetsRoot:resolve('.'),run,isIdle:()=>idle,dashboard})
  return {manager,run,session,setLive:(value:any)=>{live=value},ready:()=>{live={...live,plugin_fingerprint:'new',plugin_version:'1.2.0'}},busy:()=>{idle=false},wait:(value:Promise<void>)=>{gate=value}}
}
it('distinguishes stale files, disabled Profile, pending restart and the actually loaded plugin',async()=>{
  const f=fixture()
  const before=await f.manager.status();expect(before.profiles.map(p=>p.state)).toEqual(['outdated','disabled'])
  expect(before.profiles[1].canInstall).toBe(false)
  await expect(f.manager.install({profile:'writer',enable:true})).rejects.toMatchObject({code:'hermes_bridge_host_entry_required'})
  await f.manager.install({profile:'default'})
  const installed=await f.manager.install({profile:'writer',enable:true})
  expect(f.run.mock.calls.at(-2)?.[1]).toContain('--enable')
  expect(f.run.mock.calls.at(-2)?.[1]).toContain('--repair-profile-runtime')
  expect(installed.status.profiles.find(p=>p.profile==='writer')?.state).toBe('restart-required')
  expect(installed.status.profiles.find(p=>p.profile==='default')?.state).toBe('restart-required')
  f.ready();expect((await f.manager.status()).profiles.find(p=>p.profile==='writer')?.state).toBe('ready')
  expect(installed.backup).toBe(join(home,'backups','writer'))
})

it('restarts the managed Dashboard and verifies every Profile using fresh loaded fingerprints',async()=>{
  const dashboard={canRestart:true,restart:vi.fn(async()=>{f.ready()})},f=fixture(dashboard)
  await f.manager.install({profile:'default'});await f.manager.install({profile:'writer',enable:true})
  expect((await f.manager.status()).dashboard).toMatchObject({managed:true,canRestart:true,restarting:false})
  const result=await f.manager.restartDashboard()
  expect(dashboard.restart).toHaveBeenCalledTimes(1)
  expect(f.session.invalidateAuthentication).toHaveBeenCalledTimes(1)
  expect(result.status.profiles.every(p=>p.state==='ready'&&p.canInstall)).toBe(true)
  expect(result.status.dashboard).toMatchObject({canRestart:true,restarting:false})
  expect(result.message).toContain('工具桥已就绪')
})

it('discovers a server-managed Dashboard without desktop ownership and locks task admission while discovering',async()=>{
  let release!:()=>void
  const dashboard={canRestart:false,refresh:vi.fn(async()=>{await new Promise<void>(done=>{release=done});dashboard.canRestart=true}),restart:vi.fn(async()=>{})}
  const f=fixture(dashboard)
  const pending=f.manager.restartDashboard()
  expect(()=>f.manager.assertDashboardAvailable()).toThrow('正在重启')
  await expect(f.manager.restartDashboard()).rejects.toMatchObject({code:'hermes_dashboard_restarting'})
  await expect(f.manager.install({profile:'default'})).rejects.toMatchObject({code:'hermes_dashboard_restarting'})
  dashboard.refresh.mockImplementation(async()=>{})
  release();await pending
  expect(dashboard.restart).toHaveBeenCalledTimes(1)
  expect(f.manager.dashboardRestarting).toBe(false)
})

it('rejects client-supplied hosts, processes and commands before accessing a server service',async()=>{
  const dashboard={canRestart:true,refresh:vi.fn(async()=>{}),restart:vi.fn(async()=>{})},f=fixture(dashboard)
  for(const body of [{host:'client'},{pid:123},{command:'killall python'},{target:'gui/501/other'},{profile:'writer'}]){
    await expect(f.manager.restartDashboard(body)).rejects.toMatchObject({status:400,code:'invalid_dashboard_restart_request'})
  }
  expect(dashboard.refresh).not.toHaveBeenCalled();expect(dashboard.restart).not.toHaveBeenCalled()
})

it('keeps an unverified bridge pending after restart and releases the lock after failure',async()=>{
  const dashboard={canRestart:true,restart:vi.fn(async()=>{})},f=fixture(dashboard)
  await f.manager.install({profile:'default'})
  const result=await f.manager.restartDashboard()
  expect(result.status.profiles[0]!.state).toBe('restart-required')
  expect(result.message).toContain('尚未就绪')
  dashboard.restart.mockRejectedValueOnce(new Error('private process diagnostics'))
  await expect(f.manager.restartDashboard()).rejects.toMatchObject({code:'hermes_dashboard_restart_failed'})
  expect(f.manager.dashboardRestarting).toBe(false)
  expect(f.manager.idleForUpdate).toBe(true)
  expect((await f.manager.status()).dashboard?.canRestart).toBe(true)
})

it('blocks concurrent restart, installation and task admission until verification finishes',async()=>{
  let release!:()=>void
  const dashboard={canRestart:true,restart:vi.fn(()=>new Promise<void>(done=>{release=done}))},f=fixture(dashboard)
  const pending=f.manager.restartDashboard()
  expect(f.manager.idleForUpdate).toBe(false)
  expect(()=>f.manager.assertDashboardAvailable()).toThrow('正在重启')
  expect((await f.manager.status()).dashboard).toMatchObject({managed:true,canRestart:false,restarting:true})
  await expect(f.manager.restartDashboard()).rejects.toMatchObject({code:'hermes_dashboard_restarting'})
  await expect(f.manager.install({profile:'default'})).rejects.toMatchObject({code:'hermes_dashboard_restarting'})
  release();await pending
  expect(()=>f.manager.assertDashboardAvailable()).not.toThrow()
  expect(dashboard.restart).toHaveBeenCalledTimes(1)
  f.busy()
  expect((await f.manager.status()).dashboard?.canRestart).toBe(false)
  await expect(f.manager.restartDashboard()).rejects.toMatchObject({code:'hermes_bridge_tasks_running'})
})

it('refuses restart during installation and when process ownership is lost after the status check',async()=>{
  let release!:()=>void
  const dashboard={canRestart:true,restart:vi.fn(async()=>{})},f=fixture(dashboard)
  f.wait(new Promise<void>(done=>{release=done}))
  const installation=f.manager.install({profile:'default'})
  await expect(f.manager.restartDashboard()).rejects.toMatchObject({code:'hermes_bridge_install_busy'})
  release();await installation
  expect((await f.manager.status()).dashboard?.canRestart).toBe(true)
  dashboard.canRestart=false
  await expect(f.manager.restartDashboard()).rejects.toMatchObject({code:'hermes_dashboard_restart_unavailable'})
  expect(dashboard.restart).not.toHaveBeenCalled()
})

it('does not infer restart permission from local addresses or mounted directories',async()=>{
  const dashboard={canRestart:true,restart:vi.fn(async()=>{})},f=fixture()
  await expect(f.manager.restartDashboard()).rejects.toMatchObject({code:'hermes_dashboard_restart_unavailable'})
  for(const override of [
    {upstream:new URL('https://hermes.example')},
    {upstream:new URL('http://127.0.0.1:9120')},
    {localVmHost:'runner' as const},
    {hermesBridgeMount:{home,python:process.execPath}},
  ]){
    const manager=new HermesBridgeManager({...config,...override},f.session,{home,python:process.execPath,assetsRoot:resolve('.'),run:f.run,dashboard})
    expect((await manager.status()).dashboard?.managed).toBe(false)
    await expect(manager.restartDashboard()).rejects.toMatchObject({code:'hermes_dashboard_restart_unavailable'})
  }
  expect(dashboard.restart).not.toHaveBeenCalled()
})

it('requires admin and CSRF for restart, and blocks API and websocket task entry during restart',async()=>{
  let release!:()=>void
  const dashboard={canRestart:true,restart:vi.fn(()=>new Promise<void>(done=>{release=done}))},f=fixture(dashboard)
  const admin=createAuthenticatedApplication({config,hermesBridge:f.manager})
  try{
    const api=request.agent(admin.app.callback()),host='127.0.0.1:15300',path='/api/app/admin/hermes-bridge/restart'
    await api.post(path).set('Host',host).send({}).expect(403)
    const csrf=(await api.get('/api/app/bootstrap?csrfOnly=1').set('Host',host).expect(200)).body.csrfToken
    await api.post(path).set('Host',host).set('Origin','http://'+host).set('X-CSRF-Token',csrf).send({target:'client'}).expect(400)
    const post=(url:string)=>api.post(url).set('Host',host).set('Origin','http://'+host).set('X-CSRF-Token',csrf).send({})
    const pending=post(path).expect(200).then(response=>response)
    await vi.waitFor(()=>expect(dashboard.restart).toHaveBeenCalledTimes(1))
    expect((await post(path).expect(409)).body.code).toBe('hermes_dashboard_restarting')
    expect((await post('/api/app/agents').expect(409)).body.code).toBe('hermes_dashboard_restarting')
    expect(()=>admin.realtime.broker.command({} as any,'request',{})).toThrow('正在重启')
    vi.spyOn(admin.workspaceRuntime,'userActive').mockReturnValue(true)
    expect(()=>admin.workspaceRuntime.send('test-admin','unused',{})).toThrow('正在重启')
    const owners=vi.spyOn(admin.workspace,'owners');owners.mockClear()
    admin.workspaceRoutines.tick();expect(owners).not.toHaveBeenCalled();owners.mockRestore()
    release();const response=await pending
    expect(response.body.status.dashboard.restarting).toBe(false)
    expect(()=>admin.workspaceRuntime.assertCanSubmit()).not.toThrow()
  }finally{release?.();admin.close()}
  const user=createUserAuthenticatedApplication({config,hermesBridge:f.manager})
  try{
    const api=request.agent(user.app.callback()),host='127.0.0.1:15300'
    const csrf=(await api.get('/api/app/bootstrap?csrfOnly=1').set('Host',host).expect(200)).body.csrfToken
    await api.post('/api/app/admin/hermes-bridge/restart').set('Host',host).set('Origin','http://'+host).set('X-CSRF-Token',csrf).send({}).expect(403)
    expect(dashboard.restart).toHaveBeenCalledTimes(1)
  }finally{user.close()}
})

it('checks runtime activity and already admitted HTTP requests before acquiring the restart lock',async()=>{
  vi.stubEnv('HERMES_HOME',home)
  const dashboard={canRestart:true,restart:vi.fn(async()=>{})}
  const admin=createAuthenticatedApplication({config,dashboardSupervisor:dashboard})
  let release!:()=>void,entered=false
  const gate=new Promise<void>(done=>{release=done})
  admin.app.use(async ctx=>{if(ctx.path==='/restart-admission-fixture'){entered=true;await gate;ctx.body={ok:true}}})
  vi.spyOn(admin.upstreamSession,'request').mockImplementation(async()=>({status:200,headers:new Headers(),body:Buffer.from('{"profiles":[]}')}))
  try{
    const host='127.0.0.1:15300',api=request.agent(admin.app.callback())
    const csrf=(await api.get('/api/app/bootstrap?csrfOnly=1').set('Host',host).expect(200)).body.csrfToken
    const restart=()=>api.post('/api/app/admin/hermes-bridge/restart').set('Host',host).set('Origin','http://'+host).set('X-CSRF-Token',csrf).send({})
    for(const component of [admin.workspaceRuntime,admin.runners,admin.realtime.broker,admin.desktopEnvironments]){
      const idle=vi.spyOn(component,'idleForUpdate','get').mockReturnValue(false)
      expect((await restart().expect(409)).body.code).toBe('hermes_bridge_tasks_running')
      idle.mockRestore()
    }
    const pending=api.post('/restart-admission-fixture').set('Host',host).send({}).expect(200).then(r=>r)
    await vi.waitFor(()=>expect(entered).toBe(true))
    expect((await restart().expect(409)).body.code).toBe('hermes_bridge_tasks_running')
    expect(dashboard.restart).not.toHaveBeenCalled()
    release();await pending
    await restart().expect(200)
    expect(dashboard.restart).toHaveBeenCalledTimes(1)
  }finally{release();admin.close()}
})
it('prevents concurrent installs and rejects path injection, unknown profiles and installation during work',async()=>{
  const f=fixture();let release!:()=>void
  f.wait(new Promise<void>(done=>{release=done}))
  const pending=f.manager.install({profile:'default'})
  await vi.waitFor(()=>expect(f.run.mock.calls.some(([,args])=>!args.includes('--check'))).toBe(true))
  expect(f.manager.idleForUpdate).toBe(false)
  await expect(f.manager.install({profile:'writer'})).rejects.toMatchObject({code:'hermes_bridge_install_busy'})
  release();await pending
  expect(f.manager.idleForUpdate).toBe(true)
  await expect(f.manager.install({profile:'../other'})).rejects.toMatchObject({code:'invalid_bridge_install_request'})
  await expect(f.manager.install({profile:'default',home:'/wrong'})).rejects.toMatchObject({code:'invalid_bridge_install_request'})
  await expect(f.manager.install({profile:'missing'})).rejects.toMatchObject({code:'hermes_bridge_profile_missing'})
  f.busy();await expect(f.manager.install({profile:'default'})).rejects.toMatchObject({code:'hermes_bridge_tasks_running'})
})
it('checks remote Hermes but never invokes the local installer for it',async()=>{
  const f=fixture(),run=vi.fn()
  const manager=new HermesBridgeManager({...config,upstream:new URL('https://hermes.example')},f.session,{home,python:process.execPath,assetsRoot:resolve('.'),run})
  const status=await manager.status();expect(status.local).toBe(false);expect(status.profiles.every(p=>!p.canInstall)).toBe(true)
  await expect(manager.install({profile:'default'})).rejects.toMatchObject({code:'hermes_bridge_install_unavailable'})
  expect(run).not.toHaveBeenCalled()
})
it('exposes only admin/CSRF-protected management endpoints and returns the verified status after install',async()=>{
  const f=fixture(),admin=createAuthenticatedApplication({config,hermesBridge:f.manager})
  try{
    const api=request.agent(admin.app.callback()),host='127.0.0.1:15300'
    await api.get('/api/app/admin/hermes-bridge').set('Host',host).expect(200)
    await api.post('/api/app/admin/hermes-bridge/install').set('Host',host).send({profile:'default'}).expect(403)
    const csrf=(await api.get('/api/app/bootstrap?csrfOnly=1').set('Host',host).expect(200)).body.csrfToken
    const response=await api.post('/api/app/admin/hermes-bridge/install').set('Host',host).set('Origin','http://'+host).set('X-CSRF-Token',csrf).send({profile:'default'}).expect(200)
    expect(response.body.status.profiles[0].state).toBe('restart-required')
  }finally{admin.close()}
  const user=createUserAuthenticatedApplication({config,hermesBridge:f.manager})
  try{await request(user.app.callback()).get('/api/app/admin/hermes-bridge').set('Host','127.0.0.1:15300').expect(403)}finally{user.close()}
})

it('does not report an offline Hermes as loaded or expose installer diagnostic secrets',async()=>{
  const f=fixture()
  await f.manager.install({profile:'default'})
  f.session.request.mockRejectedValue(new Error('offline'))
  const state=await f.manager.status()
  expect(state.profiles[0].state).toBe('unavailable')
  expect(state.profiles[0].message).toContain('连接和权限')
  f.run.mockRejectedValue(new Error('sensitive diagnostic must stay private'))
  await expect(f.manager.install({profile:'default'})).rejects.not.toThrow('sensitive diagnostic')
})

it('uses explicitly mapped Hermes storage and the container interpreter with an external upstream',async()=>{
  const f=fixture()
  const mapped={...config,localVmHost:'runner' as const,upstream:new URL('http://hermes:9119'),hermesBridgeMount:{home,python:process.execPath}}
  const manager=new HermesBridgeManager(mapped,f.session,{assetsRoot:resolve('.'),run:f.run})
  expect(manager.home).toBe(home);expect(manager.python).toBe(process.execPath)
  const status=await manager.status()
  expect(status.mapped).toBe(true);expect(status.local).toBe(true);expect(status.profiles[0].canInstall).toBe(true)
  expect(status.message).toContain(home)
  await manager.install({profile:'default'})
  const call=f.run.mock.calls.find(([,args])=>args.includes('--profile'))!
  expect(call[0]).toBe(process.execPath)
  expect(call[1]).toContain(home)
  expect(call[1].join(' ')).not.toContain('/hermes-agent/venv/')
})
