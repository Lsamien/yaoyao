// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import request from 'supertest'
import {HermesBridgeManager} from '../../src/server/hermesBridge'
import type {ServerConfig} from '../../src/server/config'
import {createAuthenticatedApplication,createUserAuthenticatedApplication} from './authenticatedApplication'

let home:string,config:ServerConfig
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'yaoyao-bridge-manager-'));writeFileSync(join(home,'config.yaml'),'{}')
  config={host:'127.0.0.1',port:15300,upstream:new URL('http://127.0.0.1:9119'),home,allowedHosts:new Set(),mediaRoot:home,attachmentsRoot:home,imagesRoot:home,mediaOwner:'fixture',allowInsecureLan:false,insecureLan:false,production:false}
})
afterEach(()=>{rmSync(home,{recursive:true,force:true});vi.restoreAllMocks()})
function fixture(){
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
  const session={request:vi.fn(async(path:string)=>({status:200,headers:new Headers(),body:Buffer.from(JSON.stringify(path==='/api/profiles'?{profiles:[{name:'default'},{name:'writer'}]}:live))}))}
  const manager=new HermesBridgeManager(config,session,{home,python:process.execPath,assetsRoot:resolve('.'),run,isIdle:()=>idle})
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
  expect(installed.status.profiles.find(p=>p.profile==='writer')?.state).toBe('restart-required')
  expect(installed.status.profiles.find(p=>p.profile==='default')?.state).toBe('restart-required')
  f.ready();expect((await f.manager.status()).profiles.find(p=>p.profile==='writer')?.state).toBe('ready')
  expect(installed.backup).toBe(join(home,'backups','writer'))
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
