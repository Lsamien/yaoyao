// @vitest-environment node
import {expect,it,vi} from 'vitest'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import {createServer,type Server} from 'node:http'
import {mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WebSocketServer,type WebSocket} from 'ws'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {LocalAuthStore,UpstreamServiceSession} from '../../src/server/localAuth'
import {WorkspaceNodes,type GatewayTarget} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {saveHostTools} from '../../src/server/hostToolSettings'
import {RunnerHub} from '../../src/server/runnerHub'
import {RunnerAgent} from '../../src/runner/agent'
import {ManagedBrowsers,type BrowserTurn} from '../../src/server/managedBrowsers'
import {HttpError} from '../../src/server/errors'
import {UpstreamClient} from '../../src/server/upstream'
import {UploadStore} from '../../src/server/uploads'
import {WorkspaceRuntime} from '../../src/server/workspaceRuntime'
import type {RunnerConfiguration} from '../../src/shared/runner'
import type {WorkspaceConversation,WorkspaceMessage,WorkspaceRun} from '../../src/shared/workspace'

class FixtureAuth extends LocalAuthStore {
  version=1
  allowed=true
  owner='owner'
  override isUserActive(){return true}
  override pushAuthorizationVersion(){return this.version}
  override canUseSource(){return this.allowed}
  override require(){return {id:this.owner,username:'fixture',role:'admin'} as ReturnType<LocalAuthStore['require']>}
}
const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)))
const close=(server:Server)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})

/** YAOYAO_BROWSER_SMOKE=1 npx vitest run tests/server/managedBrowserSmoke.test.ts
 * Real outbound Runner protocol and Chromium; about:blank avoids website access.
 * The Hermes HTTP fixture never opens a model session or a computer Worker. */
it.skipIf(process.env.YAOYAO_BROWSER_SMOKE!=='1')('upgrades a legacy Runner without browser configuration through authenticated HTTP, UI takeover and the same task session',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'yaoyao-browser-http-smoke-'))),store=new WorkspaceStore(home),auth=new FixtureAuth(home)
  saveHostTools(home,{managedBrowser:true,vm:false,scriptMachine:false,serverComputer:false,cloud:false})
  let hermesRequests=0
  const hermes=createServer((_req,res)=>{hermesRequests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,auth_required:false}))})
  const hermesURL=await listen(hermes)
  const target={url:new URL(hermesURL)} as GatewayTarget
  const nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),target)
  nodes.sourceAllowed=(owner,node,profile)=>auth.canUseSource()
  const hub=new RunnerHub(store,auth,target),service=new ManagedBrowsers(store,auth,nodes,hub)
  hub.browserAllowed=(runnerId,scope,grantId)=>service.allowed(runnerId,scope,grantId)
  const registered=hub.enroll('owner',{name:'浏览器专用节点',allowedProfiles:['default']})
  const app=new Koa(),requests:string[]=[],checks:boolean[]=[]
  app.use(async(ctx,next)=>{
    requests.push(ctx.path)
    try{await next()}catch(error){ctx.status=error instanceof HttpError?error.status:500;ctx.body={code:(error as any).code,error:error instanceof Error?error.message:'Failed'}}
    if(ctx.path.endsWith('/browser-check'))checks.push((ctx.body as any)?.allowed===true)
  })
  // RunnerHub reads its authenticated machine JSON directly; keep bodyParser
  // after it, matching production router order.
  app.use(hub.middleware());app.use(bodyParser());const router=service.router();app.use(router.routes());app.use(router.allowedMethods())
  const web=createServer(app.callback()),serverURL=await listen(web)
  const config:RunnerConfiguration={protocol:1,serverURL,runnerId:registered.runner.id,token:registered.token,hermesURL,allowedProfiles:['default'],artifactRoots:[]}
  const status:string[]=[],runner=new RunnerAgent(config,home,fetch,message=>status.push(message)),controller=new AbortController()
  const running=runner.run(controller.signal);void running.catch(()=>{})
  let task:BrowserTurn|undefined
  const ui=async(path:string,body?:unknown,status=200)=>{
    const response=await fetch(serverURL+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const value=await response.json() as any
    expect(response.status,JSON.stringify(value)).toBe(status)
    return value
  }
  try{
    await vi.waitFor(()=>expect(hub.summary(hub.records()[0]!).features).toContain('managed-browser-v1'),{timeout:35000,interval:50})
    await vi.waitFor(()=>expect(status).toContain('执行节点已连接'))
    const features=hub.summary(hub.records()[0]!).features
    expect(features).toContain('managed-browser-retention-v1')
    expect(features).not.toContain('computer-worker-v1');expect(features).not.toContain('computer-control-v1')
    expect(config.computers).toBeUndefined();expect(config.browser).toBeUndefined()
    const agent=store.createAgent('owner',{name:'浏览器任务',profile:'default'}),base=`/api/app/agents/${agent.id}`
    expect(await ui(base+'/managed-browser')).toMatchObject({enabled:true,available:true,open:false})
    const taskController=new AbortController()
    task=service.openTurn('owner',agent,{workId:randomUUID(),signal:taskController.signal,authorize:()=>taskController.signal.throwIfAborted(),publish:async()=>{throw new Error('No download in this smoke')},upload:async()=>{throw new Error('No upload in this smoke')}})
    const opened=await task.call('managed_browser_open',{},'open') as any
    expect(opened.open).toBe(true);expect(opened.tabs).toHaveLength(1);expect(opened.tabs[0].url).toBe('about:blank')
    const before=await task.call('managed_browser_state',{},'state-before') as any
    const shot=await task.call('managed_browser_action',{action:{kind:'screenshot'}},'screenshot') as any
    expect(shot.content[0].mimeType).toBe('image/png')
    expect(Buffer.from(shot.content[0].data,'base64').subarray(1,4).toString()).toBe('PNG')
    const taken=await ui(base+'/computer/take?backend=managed-browser',{requestId:randomUUID()})
    expect(taken).toMatchObject({backend:'managed-browser',mode:'human',canResume:true})
    expect(taken.generation).toBeGreaterThan(before.generation)
    const credentials={controlId:taken.controlId,token:taken.token}
    const frame=await ui(base+'/computer/frame?backend=managed-browser')
    expect(frame).toMatchObject({generation:taken.generation,width:1280,height:800})
    await ui(base+'/computer/input?backend=managed-browser',{...credentials,requestId:randomUUID(),generation:frame.generation,frameId:frame.id,action:{kind:'key',key:'Tab'}})
    let completed=false
    const waiting=task.call('managed_browser_state',{},'state-after').finally(()=>{completed=true})
    await new Promise(resolve=>setTimeout(resolve,30));expect(completed).toBe(false)
    await ui(base+'/computer/giveback?backend=managed-browser',{...credentials,notes:'可以继续'})
    const resumed=await waiting as any
    expect(resumed.humanNote).toBe('可以继续')
    expect(resumed.result.tabs[0].id).toBe(before.tabs[0].id)
    expect(resumed.result.generation).toBeGreaterThan(taken.generation)
    await task.close({retain:true})
    taskController.abort()
    await expect(task.call('managed_browser_state',{},'finished-task')).rejects.toThrow()
    task=undefined
    const retained=await ui(base+'/managed-browser')
    expect(retained).toMatchObject({open:true,available:true})
    expect(retained.tabs).toEqual(before.tabs)
    expect(await ui(base+'/computer?backend=managed-browser')).toMatchObject({mode:'idle',canResume:false})
    const other=store.createAgent('owner',{name:'另一个浏览器 Bot',profile:'default'})
    expect(await ui(`/api/app/agents/${other.id}/managed-browser`)).toMatchObject({open:false,tabs:[]})
    auth.owner='other-owner'
    await ui(base+'/managed-browser',undefined,404)
    auth.owner='owner'
    const retaken=await ui(base+'/computer/take?backend=managed-browser',{requestId:randomUUID()})
    expect(retaken).toMatchObject({mode:'human',canResume:false})
    expect(retaken.generation).toBeGreaterThan(retained.generation)
    const newCredentials={controlId:retaken.controlId,token:retaken.token}
    expect((await ui(base+'/managed-browser')).tabs).toEqual(before.tabs)
    await ui(base+'/computer/renew?backend=managed-browser',credentials,403)
    const idle=await ui(base+'/computer/giveback?backend=managed-browser',newCredentials)
    expect(idle).toMatchObject({mode:'idle',canResume:false})
    expect((await ui(base+'/managed-browser')).tabs).toEqual(before.tabs)
    const closing=await ui(base+'/computer/take?backend=managed-browser',{requestId:randomUUID()})
    await ui(base+'/managed-browser/close',{controlId:closing.controlId,token:closing.token})
    expect(await ui(base+'/managed-browser')).toMatchObject({open:false,available:true,tabs:[]})
    for(const endpoint of ['poll','admit','result','browser-check'])expect(requests.some(path=>path.endsWith('/'+endpoint))).toBe(true)
    expect(checks.length).toBeGreaterThan(10);expect(checks.every(Boolean)).toBe(true)
    expect(hermesRequests).toBe(0)
  }finally{
    auth.owner='owner'
    await task?.close().catch(()=>{})
    controller.abort();await running.catch(()=>{})
    service.close();hub.close();nodes.close()
    await close(web);await close(hermes)
    store.close();rmSync(home,{recursive:true,force:true})
  }
},60000)

/** The model is a deterministic Hermes fixture, but its private tool bridge,
 * WorkspaceRuntime, Runner transport, grants and Chromium are all real.
 * example.com supplies a public page because production browsing rejects LAN URLs. */
it.skipIf(process.env.YAOYAO_BROWSER_SMOKE!=='1')('persists live Bot browser cards through the real workspace tool bridge and human handoff',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'yaoyao-browser-workspace-smoke-'))),store=new WorkspaceStore(home),auth=new FixtureAuth(home),uploads=new UploadStore(home)
  saveHostTools(home,{managedBrowser:true,vm:false,scriptMachine:false,serverComputer:false,cloud:false})
  const bindings:any[]=[],rpc:{method:string;params:any}[]=[],messages:WorkspaceMessage[]=[],requests:string[]=[],checks:boolean[]=[]
  let socket:WebSocket|undefined,runtimeId='',sessionRunning=false
  const hermes=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part
    const payload=body?JSON.parse(body):{},path=new URL(req.url!,'http://fixture').pathname
    if(path.endsWith('/bind'))bindings.push(payload)
    const result=path==='/api/auth/ws-ticket'?{ticket:'fixture'}:path.endsWith('/capabilities')?{version:1,ready:true,in_process:true,native_tools:true}:path==='/api/profiles'?{profiles:[{name:'default'}]}:{ok:true,native_tools:true,terminal:{cwd:home}}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result))
  })
  const hermesURL=await listen(hermes),ws=new WebSocketServer({server:hermes})
  const emit=(type:string,payload:unknown)=>socket?.send(JSON.stringify({method:'event',params:{type,session_id:runtimeId,profile:'default',payload}}))
  ws.on('connection',connected=>{
    socket=connected;connected.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    connected.on('message',raw=>{
      const request=JSON.parse(String(raw));rpc.push(request);let result:any={ok:true}
      if(request.method==='session.create'||request.method==='session.resume'){
        runtimeId=randomUUID();result={session_id:runtimeId,stored_session_id:randomUUID(),running:false,info:{profile_name:'default',cwd:home}}
      }else if(request.method==='prompt.submit')sessionRunning=true
      else if(request.method==='session.active_list')result={sessions:[{id:runtimeId,status:sessionRunning?'working':'idle'}]}
      else if(request.method==='session.usage')result={context_used:30,context_max:32000}
      else if(request.method==='session.interrupt'){sessionRunning=false;emit('message.complete',{text:'',status:'interrupted'})}
      connected.send(JSON.stringify({id:request.id,result}))
    })
  })
  const client=new UpstreamClient(new URL(hermesURL)),target:GatewayTarget={url:new URL(hermesURL),client,session:new UpstreamServiceSession(client,()=>undefined)}
  const nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),target)
  nodes.sourceAllowed=()=>auth.canUseSource()
  const hub=new RunnerHub(store,auth,target),service=new ManagedBrowsers(store,auth,nodes,hub),runtime=new WorkspaceRuntime(store,nodes,uploads,()=>auth.isUserActive(),()=>auth.version)
  runtime.managedBrowsers=service
  hub.browserAllowed=(runnerId,scope,grantId)=>service.allowed(runnerId,scope,grantId)
  nodes.runnerTarget=(owner,nodeId,computer)=>hub.target(owner,nodeId,computer)
  const stopObserving=store.observe((_owner,event)=>{if(event.type==='message.changed')messages.push(structuredClone(event.data as WorkspaceMessage))})
  const registered=hub.enroll('owner',{name:'真实浏览器任务节点',allowedProfiles:['default']})
  const app=new Koa()
  app.use(async(ctx,next)=>{
    requests.push(ctx.path)
    try{await next()}catch(error){ctx.status=error instanceof HttpError?error.status:500;ctx.body={code:(error as any).code,error:error instanceof Error?error.message:'Failed'}}
    if(ctx.path.endsWith('/browser-check'))checks.push((ctx.body as any)?.allowed===true)
  })
  app.use(hub.middleware());app.use(bodyParser());const router=service.router();app.use(router.routes());app.use(router.allowedMethods())
  const web=createServer(app.callback()),serverURL=await listen(web)
  const config:RunnerConfiguration={protocol:1,serverURL,runnerId:registered.runner.id,token:registered.token,hermesURL,allowedProfiles:['default'],artifactRoots:[],browser:{enabled:true}}
  const runner=new RunnerAgent(config,home),controller=new AbortController(),running=runner.run(controller.signal);void running.catch(()=>{})
  const ui=async(path:string,body?:unknown,status=200)=>{
    const response=await fetch(serverURL+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),value=await response.json() as any
    expect(response.status,JSON.stringify(value)).toBe(status);return value
  }
  const bridge=async(path:string,body:unknown,token=bindings.at(-1)?.token)=>{
    const binding=bindings.at(-1),response=await fetch(binding.bridge_url+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})
    return {status:response.status,body:await response.json() as any}
  }
  let rootRun:WorkspaceRun|undefined
  try{
    await vi.waitFor(()=>expect(hub.summary(hub.records()[0]!).features).toContain('managed-browser-v1'),{timeout:35000,interval:50})
    expect(hub.summary(hub.records()[0]!).features).toContain('managed-browser-retention-v1')
    expect(hub.summary(hub.records()[0]!).features).not.toContain('computer-worker-v1')
    const agent=store.createAgent('owner',{name:'真实网页任务',profile:'default'}),base=`/api/app/agents/${agent.id}`
    const conversation=store.list<WorkspaceConversation>('owner','conversation').find(value=>value.memberIds[0]===agent.id)!
    auth.allowed=false
    await ui(base+'/managed-browser/prepare',{},403)
    auth.allowed=true
    const prepared=await ui(base+'/managed-browser/prepare',{})
    expect(prepared.installation.status).toBe('ready');expect(prepared.open).toBe(false)
    rootRun=runtime.send('owner',conversation.id,{requestId:randomUUID(),content:'打开网页，等待我接管，然后继续原任务。'})
    await vi.waitFor(()=>expect(rpc.some(call=>call.method==='prompt.submit')).toBe(true),{timeout:10000})
    expect(bindings).toHaveLength(1)
    expect((await bridge('/tools/list',{},'invalid-token')).status).toBe(401)
    const catalog=await bridge('/tools/list',{})
    expect(catalog.status).toBe(200)
    expect(catalog.body.tools.map((tool:any)=>tool.name)).toContain('managed_browser_open')
    expect(catalog.body.tools.map((tool:any)=>tool.name)).not.toContain('computer_shell')
    const tool=async(name:string,args:unknown,callId=randomUUID())=>{
      const entry=catalog.body.tools.find((tool:any)=>tool.name===name);expect(entry).toBeDefined()
      const reply=await bridge('/tools/call',{toolId:entry.id,arguments:args,callId})
      expect(reply.status).toBe(200);expect(reply.body.isError,JSON.stringify(reply.body)).not.toBe(true)
      return reply.body.structuredContent??reply.body
    }
    const opened=await tool('managed_browser_open',{url:'https://example.com/'})
    const tab=opened.tabs.find((tab:any)=>tab.active)
    expect(tab.url).toBe('https://example.com/');expect(tab.title).toContain('Example Domain')
    const live=store.list<WorkspaceMessage>('owner','message').find(message=>message.browserCard?.status==='active')!
    expect(live.browserCard).toMatchObject({agentId:agent.id,agentName:agent.name,title:tab.title,url:tab.url,status:'active'})
    expect(live.status).toBe('streaming');expect(live.content).toBe('');expect(live.visible).toBe(true)
    expect(messages.filter(message=>message.browserCard).map(message=>message.browserCard!.status)).toEqual(expect.arrayContaining(['ready','active']))
    const shot=await tool('managed_browser_action',{action:{kind:'screenshot'}})
    expect(shot.content[0].mimeType).toBe('image/png')
    const taken=await ui(base+'/computer/take?backend=managed-browser',{requestId:randomUUID()}),credentials={controlId:taken.controlId,token:taken.token}
    expect(taken).toMatchObject({mode:'human',canResume:true})
    const frame=await ui(base+'/computer/frame?backend=managed-browser')
    await ui(base+'/computer/input?backend=managed-browser',{...credentials,requestId:randomUUID(),generation:frame.generation,frameId:frame.id,action:{kind:'key',key:'Tab'}})
    let settled=false
    const pending=tool('managed_browser_state',{}).finally(()=>{settled=true})
    await new Promise(resolve=>setTimeout(resolve,30));expect(settled).toBe(false)
    await ui(base+'/computer/giveback?backend=managed-browser',{...credentials,notes:'检查完成，请继续'})
    const resumed=await pending
    expect(resumed.humanNote).toBe('检查完成，请继续')
    expect(resumed.result.tabs.find((page:any)=>page.active)).toMatchObject({id:tab.id,title:tab.title,url:tab.url})
    expect(resumed.result.generation).toBeGreaterThan(taken.generation)
    // Force real network traffic after giveback, exercising the proxy's current
    // task grant instead of the revoked human grant that used to break reload.
    await tool('managed_browser_action',{action:{kind:'reload'}})
    expect((await tool('managed_browser_state',{})).tabs[0]).toMatchObject({id:tab.id,title:tab.title,url:tab.url})
    sessionRunning=false;emit('message.complete',{text:'',status:'complete'})
    await vi.waitFor(()=>expect(store.require<WorkspaceRun>('owner','run',rootRun!.id).status).toBe('complete'),{timeout:5000})
    await vi.waitFor(()=>expect(store.require<WorkspaceMessage>('owner','message',live.id).browserCard?.status).toBe('idle'))
    const saved=store.require<WorkspaceMessage>('owner','message',live.id)
    expect(saved).toMatchObject({visible:true,status:'complete',content:'',browserCard:{status:'idle',title:tab.title,url:tab.url}})
    const history=new WorkspaceStore(home)
    try{expect(history.require<WorkspaceMessage>('owner','message',live.id).browserCard).toEqual(saved.browserCard)}finally{history.close()}
    const retained=await ui(base+'/managed-browser')
    expect(retained).toMatchObject({open:true,available:true})
    expect(retained.tabs.find((page:any)=>page.active)).toMatchObject({id:tab.id,title:tab.title,url:tab.url})
    // Finishing also disposes this turn's private HTTP tool lease. Retaining
    // Chromium must not keep the former model's tool endpoint usable.
    await expect(bridge('/tools/list',{})).rejects.toThrow()
    const retaken=await ui(base+'/computer/take?backend=managed-browser',{requestId:randomUUID()})
    expect(retaken).toMatchObject({mode:'human',canResume:false})
    expect(retaken.generation).toBeGreaterThan(retained.generation)
    const retakenCredentials={controlId:retaken.controlId,token:retaken.token}
    const retainedFrame=await ui(base+'/computer/frame?backend=managed-browser')
    await ui(base+'/computer/input?backend=managed-browser',{...retakenCredentials,requestId:randomUUID(),generation:frame.generation,frameId:frame.id,action:{kind:'key',key:'Tab'}},409)
    await ui(base+'/computer/input?backend=managed-browser',{...retakenCredentials,requestId:randomUUID(),generation:retainedFrame.generation,frameId:retainedFrame.id,action:{kind:'key',key:'Tab'}})
    expect(await ui(base+'/computer/giveback?backend=managed-browser',retakenCredentials)).toMatchObject({mode:'idle',canResume:false})
    expect((await ui(base+'/managed-browser')).tabs.find((page:any)=>page.active)).toMatchObject({id:tab.id,title:tab.title,url:tab.url})
    const closing=await ui(base+'/computer/take?backend=managed-browser',{requestId:randomUUID()})
    expect(await ui(base+'/managed-browser/close',{controlId:closing.controlId,token:closing.token})).toMatchObject({mode:'off',canResume:false})
    expect(await ui(base+'/managed-browser')).toMatchObject({open:false,available:true,tabs:[]})
    for(const endpoint of ['poll','admit','result','browser-check'])expect(requests.some(path=>path.endsWith('/'+endpoint))).toBe(true)
    expect(checks.length).toBeGreaterThan(10)
    expect(rpc.filter(call=>call.method==='prompt.submit')).toHaveLength(1)
  }finally{
    auth.allowed=true
    if(rootRun)await runtime.stop('owner',rootRun.id).catch(()=>{})
    runtime.close();stopObserving()
    controller.abort();await running.catch(()=>{})
    service.close();hub.close();nodes.close();client.close();uploads.close()
    for(const connection of ws.clients)connection.terminate()
    await new Promise<void>(done=>ws.close(()=>done()));await close(web);await close(hermes)
    store.close();rmSync(home,{recursive:true,force:true})
  }
},60000)
