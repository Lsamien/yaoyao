// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { LocalAuthStore } from '../../src/server/localAuth'
import { RunnerHub } from '../../src/server/runnerHub'
import { RunnerAgent } from '../../src/runner/agent'
import { WorkspaceGateway, type GatewayTarget, type GatewayFrame } from '../../src/server/workspaceGateway'
import { createWorkspaceToolLease } from '../../src/server/workspaceToolLease'
import { HttpError } from '../../src/server/errors'
import type { RunnerCommand, RunnerConfiguration } from '../../src/shared/runner'

class Auth extends LocalAuthStore {
  version=1
  allowed=true
  override isUserActive(){return true}
  override pushAuthorizationVersion(){return this.version}
  override canUseSource(){return this.allowed}
}
let home:string,store:WorkspaceStore,auth:Auth,hub:RunnerHub,runner:RunnerAgent,config:RunnerConfiguration
let web:Server,hermes:Server,ws:WebSocketServer,controller:AbortController,running:Promise<void>
let target:GatewayTarget,bindings:any[],rpc:Array<{method:string;params:any}>,frames:GatewayFrame[],sockets:WebSocket[]
const gateways:WorkspaceGateway[]=[]
const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)))
const close=(server:Server)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})
beforeEach(async()=>{
  home=mkdtempSync(join(tmpdir(),'yaoyao-runner-'));store=new WorkspaceStore(home);auth=new Auth(home)
  bindings=[];rpc=[];frames=[];sockets=[]
  hermes=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part
    if(req.url?.endsWith('/bind'))bindings.push(JSON.parse(body))
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify(req.url==='/api/auth/ws-ticket'?{ticket:'fixture'}:req.url==='/api/profiles'?{profiles:['default',{name:'writer'},{name:'secret'}]}:req.url?.endsWith('/capabilities')?{version:1,ready:true,in_process:true,native_tools:true}:{ok:true,native_tools:true,terminal:{cwd:'/fixture/workspace'}}))
  })
  const hermesURL=await listen(hermes)
  ws=new WebSocketServer({server:hermes})
  ws.on('connection',socket=>{
    sockets.push(socket);socket.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    socket.on('message',raw=>{
      const value=JSON.parse(String(raw));rpc.push(value)
      const result=['session.create','session.resume'].includes(value.method)?{session_id:randomUUID(),stored_session_id:randomUUID(),info:{profile_name:value.params.profile}}:{ok:true}
      socket.send(JSON.stringify({id:value.id,result}))
    })
  })
  hub=new RunnerHub(store,auth,{url:new URL(hermesURL)} as GatewayTarget)
  const registered=hub.enroll('owner',{name:'测试电脑',allowedProfiles:['default','writer']})
  const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(error){ctx.status=error instanceof HttpError?error.status:500;ctx.body={code:error instanceof HttpError?error.code:'error'}}});app.use(hub.middleware())
  web=createServer(app.callback());const serverURL=await listen(web)
  config={protocol:1,serverURL,runnerId:registered.runner.id,token:registered.token,hermesURL,allowedProfiles:['default','writer'],artifactRoots:[]}
  runner=new RunnerAgent(config,home);controller=new AbortController();running=runner.run(controller.signal);void running.catch(()=>{})
  await vi.waitFor(()=>expect(hub.summary(hub.records()[0]!).online).toBe(true))
  await vi.waitFor(()=>expect((runner as any).serverEpoch).toBeTruthy())
  target=hub.target('owner','local')!
})
afterEach(async()=>{
  for(const gateway of gateways.splice(0))gateway.close()
  controller.abort();await running.catch(()=>{});hub.close()
  for(const socket of ws.clients)socket.terminate()
  await new Promise<void>(resolve=>ws.close(()=>resolve()));await close(hermes);await close(web)
  store.close();rmSync(home,{recursive:true,force:true})
})
async function channel(){
  const gateway=new WorkspaceGateway(target);gateways.push(gateway);gateway.onEvent=frame=>frames.push(frame)
  await gateway.connect();const session=await gateway.rpc('session.create',{profile:'default'})
  return {gateway,session}
}
it('requires an upgraded Runner before granting mixed host and VM tools',()=>{
 const id=randomUUID()
 expect(()=>hub.target('owner','local',{environmentId:id,agentId:id,ownerKey:'owner',hostAccess:true})).toThrow('不支持同时使用本机和虚拟机')
})
async function machine(path:string,body?:unknown,overrides:Record<string,string>={}){
  return fetch(`${config.serverURL}/api/runner/v1/${config.runnerId}/${path}`,{
    method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${config.token}`,'x-runner-instance':runner.instance,'x-runner-protocol':'1','x-runner-epoch':(runner as any).serverEpoch,'Content-Type':'application/json',...overrides},...(body===undefined?{}:{body:JSON.stringify(body)})
  })
}
it('connects through outbound transport, filters profiles and forwards only owned session events',async()=>{
  const profiles=await target.session.request('/api/profiles')
  expect(JSON.parse(profiles.body.toString()).profiles).toEqual(['default',{name:'writer'}])
  const {gateway,session}=await channel()
  await expect(gateway.rpc('session.create',{profile:'secret'})).rejects.toMatchObject({code:'runner_profile_forbidden'})
  await expect(gateway.rpc('prompt.submit',{session_id:'someone-else',text:'no'})).rejects.toMatchObject({code:'runner_session_forbidden'})
  await gateway.rpc('prompt.submit',{session_id:session.session_id,text:'hello'})
  sockets[0]!.send(JSON.stringify({method:'event',params:{type:'message.delta',session_id:'someone-else',payload:{text:'private'}}}))
  sockets[0]!.send(JSON.stringify({method:'event',params:{type:'message.delta',session_id:session.session_id,payload:{text:'hello'}}}))
  await vi.waitFor(()=>expect(frames.some(f=>f.payload?.text==='hello')).toBe(true))
  expect(frames.some(f=>f.payload?.text==='private')).toBe(false)
})
it('mounts loopback-only tools with stable call ids and revokes an active grant',async()=>{
  const {session}=await channel(),abort=new AbortController(),call=vi.fn(async()=>({agent:{id:'created'}}))
  let active=true
  const lease=await createWorkspaceToolLease({target,profile:'default',workId:'work',session:()=>({runtimeId:session.session_id,storedId:session.stored_session_id}),signal:abort.signal,
    assertActive:()=>{if(!active)throw new HttpError(403,'撤权','revoked')},catalog:()=>[{id:'workspace_create_agent',name:'workspace_create_agent',description:'create',inputSchema:{type:'object'}}],call,onFailure:()=>{}})
  await lease.bind();const binding=bindings[0]
  const toolHTTP=(path:string,body:unknown)=>fetch(binding.bridge_url+path,{method:'POST',headers:{Authorization:`Bearer ${binding.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})
  const catalog=await (await toolHTTP('/tools/list',{})).json() as any
  const body={callId:'same-call',toolId:catalog.tools[0].id,arguments:{name:'worker'}}
  const first=await (await toolHTTP('/tools/call',body)).json()
  expect(await (await toolHTTP('/tools/call',body)).json()).toEqual(first)
  expect(call).toHaveBeenCalledExactlyOnceWith('workspace_create_agent',{name:'worker'},'same-call')
  active=false
  expect(await (await toolHTTP('/tools/call',{...body,callId:'late-call'})).json()).toMatchObject({isError:true})
  expect(call).toHaveBeenCalledTimes(1)
  await lease.dispose()
})
it('denies browser credentials, stale epochs, foreign lease ids and unauthorized HTTP operations',async()=>{
  expect((await machine('admit',{id:randomUUID()},{Origin:config.serverURL})).status).toBe(403)
  expect((await machine('admit',{id:randomUUID()},{Authorization:'Bearer wrong'})).status).toBe(403)
  expect((await machine('admit',{id:randomUUID()},{'x-runner-epoch':'old'})).status).toBe(409)
  expect((await machine('tool',{leaseId:randomUUID(),callId:'test',toolId:'workspace_create_agent',arguments:{}})).status).toBe(410)
  await expect(target.session.request('/api/config',{method:'POST',body:{}})).rejects.toMatchObject({code:'runner_http_forbidden'})
  await expect(target.session.request('/api/files/download',{search:new URLSearchParams({profile:'default',path:'/etc/hosts'})})).rejects.toMatchObject({code:'runner_artifact_forbidden'})
})
it('does not execute a queued command after account authorization changes',async()=>{
  const {gateway,session}=await channel()
  auth.version++
  await expect(gateway.rpc('prompt.submit',{session_id:session.session_id,text:'late'})).rejects.toMatchObject({code:'runner_command_not_admitted'})
  expect(rpc.filter(r=>r.method==='prompt.submit')).toHaveLength(0)
})
it('keeps one result for a command and refuses conflicting or unfinished replay after restart',async()=>{
  const seen:RunnerCommand[]=[];const execute=(runner as any).execute.bind(runner)
  vi.spyOn(runner as any,'execute').mockImplementation(async(command:any)=>{seen.push(command);return execute(command)})
  await channel()
  const command=seen.find(c=>c.kind==='gateway.rpc')!
  const before=rpc.length
  expect(await runner.handle(command)).toHaveProperty('result.session_id')
  expect(rpc).toHaveLength(before)
  await expect(runner.handle({...command,payload:{changed:true}})).rejects.toMatchObject({code:'idempotency_conflict'})
  const incomplete={...command,id:randomUUID()}
  const {createHash}=await import('node:crypto')
  ;(runner as any).db.prepare("INSERT INTO commands VALUES(?,?,'started',NULL,?)").run(incomplete.id,createHash('sha256').update(JSON.stringify(incomplete)).digest('hex'),Date.now())
  controller.abort();await running
  runner=new RunnerAgent(config,home);controller=new AbortController();running=runner.run(controller.signal);void running.catch(()=>{})
  await expect(runner.handle(incomplete)).rejects.toMatchObject({code:'runner_command_uncertain'})
  expect(await runner.handle(command)).toHaveProperty('result.session_id')
  expect(rpc).toHaveLength(before)
})
it('closes a pending gateway before a delayed handshake can revive it',async()=>{
  const connect=WorkspaceGateway.prototype.connect
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  vi.spyOn(WorkspaceGateway.prototype,'connect').mockImplementationOnce(async function(this:WorkspaceGateway){await gate;return connect.call(this)})
  const connectionId=randomUUID(),request=(hub as any).request.bind(hub)
  // The control plane normally installs this owner record before opening.
  ;(hub as any).connections.set(connectionId,{runnerId:config.runnerId,valid:()=>true,onEvent:()=>{},onDisconnect:()=>{}})
  const opening=request(config.runnerId,'gateway.open',{connectionId}).catch((error:unknown)=>error)
  await vi.waitFor(()=>expect((runner as any).connections.has(connectionId)).toBe(true))
  await request(config.runnerId,'gateway.close',{connectionId})
  release()
  expect(await opening).toBeInstanceOf(Error)
  expect((runner as any).connections.has(connectionId)).toBe(false)
})
it('fences a replaced process and does not route to the host when its runner goes offline',async()=>{
  const {gateway}=await channel();const disconnected=vi.fn();gateway.onDisconnect=disconnected
  const oldInstance=runner.instance
  controller.abort();await running
  runner=new RunnerAgent(config,home);controller=new AbortController();running=runner.run(controller.signal);void running.catch(()=>{})
  await vi.waitFor(()=>expect(disconnected).toHaveBeenCalled())
  expect((await machine('poll',undefined,{'x-runner-instance':oldInstance})).status).toBe(409)
  hub.remove(config.runnerId)
  await expect(target.session.request('/api/status')).rejects.toMatchObject({code:'runner_offline'})
})

it('resets the hub epoch after a transport failure and closes the obsolete gateways',async()=>{
  const {gateway}=await channel(),disconnected=vi.fn();gateway.onDisconnect=disconnected
  const epoch=(runner as any).serverEpoch
  await (runner as any).disconnect()
  // Wake the outstanding poll. Its response must be ignored after disconnect.
  ;(hub as any).online.get(config.runnerId).wake?.()
  await vi.waitFor(()=>expect((runner as any).serverEpoch).not.toBe(epoch))
  expect(disconnected).toHaveBeenCalledTimes(1)
  const next=await channel()
  expect(await next.gateway.rpc('session.usage',{session_id:next.session.session_id})).toEqual({ok:true})
})
it('a closed account channel cannot interrupt an unrelated connection',async()=>{
  const first=await channel(),second=await channel()
  const entries=[...(hub as any).connections.entries()] as Array<[string,any]>
  entries[0]![1].valid=()=>false
  sockets[0]!.send(JSON.stringify({method:'event',params:{type:'message.delta',session_id:first.session.session_id,payload:{text:'revoked'}}}))
  await vi.waitFor(()=>expect((runner as any).connections.size).toBe(1))
  expect((runner as any).connected).toBe(true)
  expect(await second.gateway.rpc('prompt.submit',{session_id:second.session.session_id,text:'continue'})).toEqual({ok:true})
  expect(rpc.filter(r=>r.method==='session.interrupt'&&r.params.session_id===second.session.session_id)).toHaveLength(0)
})
it('rechecks admission after a queued prompt loses its account permission',async()=>{
  const {gateway,session}=await channel()
  const api=(runner as any).api.bind(runner)
  let release!:()=>void,waiting=false
  const gate=new Promise<void>(resolve=>{release=resolve})
  vi.spyOn(runner as any,'api').mockImplementation(async(path:any,body:any)=>{if(path==='admit'){waiting=true;await gate}return api(path,body)})
  const result=gateway.rpc('prompt.submit',{session_id:session.session_id,text:'must not run'}).catch(error=>error)
  await vi.waitFor(()=>expect(waiting).toBe(true));auth.version++;release()
  expect(await result).toMatchObject({code:'runner_command_not_admitted'})
  expect(rpc.filter(r=>r.method==='prompt.submit')).toHaveLength(0)
})
it('does not recreate a lease when cancellation overtakes its admitted creation',async()=>{
  const {session}=await channel(),abort=new AbortController()
  const execute=(runner as any).execute.bind(runner)
  let release!:()=>void,waiting=false
  const gate=new Promise<void>(resolve=>{release=resolve})
  vi.spyOn(runner as any,'execute').mockImplementation(async(command:any)=>{if(command.kind==='lease.create'){waiting=true;await gate}return execute(command)})
  const result=createWorkspaceToolLease({target,profile:'default',workId:'cancel-race',session:()=>({runtimeId:session.session_id,storedId:session.stored_session_id}),signal:abort.signal,
    assertActive:()=>{if(abort.signal.aborted)throw new Error('stopped')},catalog:()=>[],call:async()=>({}),onFailure:()=>{}}).catch(error=>error)
  await vi.waitFor(()=>expect(waiting).toBe(true));abort.abort()
  await vi.waitFor(()=>expect((runner as any).closedLeases.size).toBe(1));release()
  expect(await result).toBeInstanceOf(Error)
  expect((runner as any).leases.size).toBe(0)
  expect(bindings).toHaveLength(0)
})

it.each([0o600,0o644])('runs the CLI with private configuration and rejects broad permissions (%s)',async(mode)=>{
  controller.abort();await running
  const file=join(home,'runner.json');writeFileSync(file,JSON.stringify(config),{mode})
  const bundle=process.env.RUNNER_BUNDLE_PATH
  const args=bundle?[bundle,'--config',file]:['--import','tsx','src/runner/index.ts','--config',file]
  const child=spawn(process.execPath,args,{stdio:['ignore','ignore','pipe']})
  let output='';child.stderr?.on('data',data=>{output+=String(data)})
  const exited=once(child,'exit')
  try {
    if(mode===0o644){expect((await exited)[0]).not.toBe(0);expect(output).toContain('chmod 600');return}
    await vi.waitFor(()=>{if(child.exitCode!==null)throw new Error(`Runner 提前退出 ${child.exitCode}: ${output}`);expect(output).toContain('执行节点已连接')},{timeout:7000})
    expect((await target.session.request('/api/profiles')).status).toBe(200)
    child.kill('SIGTERM')
    expect((await exited)[0]).toBe(0)
    expect(output).toContain('执行节点已停止')
    expect(output).not.toContain(config.token)
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited}}
},15000)
it('refuses a computer gateway on a legacy Runner before any native session is opened',async()=>{
  const target=hub.target('owner','local',{environmentId:randomUUID(),agentId:randomUUID(),ownerKey:'a'.repeat(64)})!
  const gateway=new WorkspaceGateway(target,{workId:randomUUID(),authorize:()=>{}});gateways.push(gateway)
  await expect(gateway.connect()).rejects.toMatchObject({code:'computer_unavailable'})
  expect(rpc.some(call=>call.method==='session.create')).toBe(false)
})
it('binds chunked artifacts to one live connection, validates bytes and publishes exactly once',async()=>{
  const {createHash}=await import('node:crypto'),bytes=Buffer.from('artifact payload'),id=randomUUID()
  const publish=vi.fn(async(name:string,data:Buffer)=>({id:randomUUID(),name,size:data.length}))
  const gateway=new WorkspaceGateway(target,{workId:randomUUID(),authorize:()=>{},publishArtifact:publish});gateways.push(gateway)
  await gateway.connect()
  const connectionId=[...(hub as any).connections.keys()][0]
  const send=(body:object)=>machine('artifact',{connectionId,id,...body})
  const metadata={phase:'begin',name:'report.txt',size:bytes.length,digest:createHash('sha256').update(bytes).digest('hex')}
  expect((await send(metadata)).status).toBe(200)
  expect((await send({phase:'finish'})).status).toBe(409)
  expect((await send({phase:'append',index:0,data:bytes.toString('base64')})).status).toBe(200)
  expect((await send({phase:'append',index:0,data:bytes.toString('base64')})).status).toBe(200)
  expect((await send({phase:'append',index:0,data:Buffer.from('wrong').toString('base64')})).status).toBe(409)
  const first=await (await send({phase:'finish'})).json()
  expect(await (await send({phase:'finish'})).json()).toEqual(first)
  expect(publish).toHaveBeenCalledExactlyOnceWith('report.txt',bytes)
  expect((await machine('artifact',{...metadata,connectionId:randomUUID(),id:randomUUID()})).status).toBe(403)
  auth.version++
  expect((await send({phase:'finish'})).status).toBe(403)
})
it('keeps only stop operations available on an existing channel after task permission is revoked',async()=>{
  let allowed=true
  const gateway=new WorkspaceGateway(target,{workId:randomUUID(),authorize:()=>{if(!allowed)throw new Error('revoked')}});gateways.push(gateway)
  await gateway.connect();const session=await gateway.rpc('session.create',{profile:'default'})
  allowed=false
  await expect(gateway.rpc('prompt.submit',{session_id:session.session_id,text:'forbidden'})).rejects.toMatchObject({code:'runner_command_not_admitted'})
  expect(await gateway.rpc('session.interrupt',{session_id:session.session_id})).toEqual({ok:true})
  expect(rpc.filter(call=>call.method==='prompt.submit')).toHaveLength(0)
})
