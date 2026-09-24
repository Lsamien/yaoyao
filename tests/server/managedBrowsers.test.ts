// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtempSync,rmSync,writeFileSync,symlinkSync,mkdirSync,realpathSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ManagedBrowsers,type BrowserTurn,type BrowserTurnOptions} from '../../src/server/managedBrowsers'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {saveHostTools} from '../../src/server/hostToolSettings'
import {HttpError} from '../../src/server/errors'
import type {LocalAuthStore} from '../../src/server/localAuth'
import type {RunnerHub} from '../../src/server/runnerHub'
import type {BrowserScope,BrowserState} from '../../src/runner/browser/types'
import type {BrowserInstallation,ManagedBrowserCard} from '../../src/shared/managedBrowser'
import {browserOwnedFile,browserVmFile} from '../../src/server/browserFiles'
import {UploadStore} from '../../src/server/uploads'
import {FileTransferFiles} from '../../src/shared/fileTransferEndpoint.mjs'

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const defer=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
function fixture(enabled=true){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'yaoyao-managed-browser-'))),store=new WorkspaceStore(home)
  if(enabled)saveHostTools(home,{managedBrowser:true})
  const versions=new Map<string,number>(),blockedSources=new Set<string>(),inactiveOwners=new Set<string>()
  const auth={require:(ctx:any)=>({id:ctx.get('x-fixture-owner')||'owner'}),pushAuthorizationVersion:(owner:string)=>versions.get(owner)??1,isUserActive:(owner:string)=>!inactiveOwners.has(owner)} as unknown as LocalAuthStore
  const nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any)
  nodes.sourceAllowed=(owner,node,profile)=>!blockedSources.has(`${owner}:${node}:${profile}`)
  let installation:BrowserInstallation|undefined,retention=true
  const states=new Map<string,BrowserState>(),calls:any[]=[],turns:BrowserTurn[]=[]
  let runnerId=randomUUID(),runnerEpoch=randomUUID(),downloadReply:(payload:any)=>unknown=()=>{throw new Error('Unexpected download')}
  let beforeReply:((payload:any)=>Promise<void>)|undefined
  let afterReply:((payload:any)=>Promise<void>)|undefined
  const stateFor=(scope:BrowserScope)=>{
    const key=runnerId+':'+runnerEpoch+':'+JSON.stringify(scope);let state=states.get(key)
    if(!state){state={open:false,generation:1,profile:scope.profile,tabs:[],downloads:[]};states.set(key,state)}
    return state
  }
  let service:ManagedBrowsers
  const hub={browserRunner:()=>({id:runnerId,browserEpoch:runnerEpoch}),supportsBrowserRetention:()=>retention,browser:vi.fn(async(owner:string,agent:any,payload:any,authorize:()=>void)=>{
    authorize()
    expect(service.allowed(runnerId,payload.scope,payload.grantId)).toBe(true)
    calls.push({owner,agentId:agent.id,runnerId,...structuredClone(payload)})
    const state=stateFor(payload.scope)
    if(beforeReply)await beforeReply(payload)
    let result:unknown
    if(payload.op==='prepare'){
      if(installation?.status!=='failed'||payload.retry)installation={status:'installing',message:'正在下载浏览器',updatedAt:Date.now()}
    }else if(payload.op==='open'){
      if(!state.open){state.open=true;state.generation++;state.tabs=[{id:'tab',title:'Example',url:'about:blank',active:true}]}
    }else if(payload.op==='pause'||payload.op==='resume'||payload.op==='park')state.generation++
    else if(payload.op==='close'){state.open=false;state.tabs=[];state.generation++}
    else if(payload.op==='download')result=downloadReply(payload)
    else if(payload.op==='execute'){
      if(payload.operation.generation!==state.generation)throw new HttpError(409,'代次改变','browser_generation_expired')
      if(payload.operation.action.kind==='screenshot')result={frameId:randomUUID(),generation:state.generation,data:'c2NyZWVu',width:800,height:600,createdAt:Date.now()}
      else {
        if(payload.operation.action.kind==='navigate'&&state.tabs[0])state.tabs[0].url=payload.operation.action.url
        result={ok:true,action:payload.operation.action}
      }
    }
    const reply=result??structuredClone({...state,...(installation?{available:installation.status==='ready',installation}:{})})
    if(afterReply)await afterReply(payload)
    authorize()
    return reply
  })} as unknown as RunnerHub
  service=new ManagedBrowsers(store,auth,nodes,hub)
  const app=new Koa()
  app.use(async(ctx,next)=>{try{await next()}catch(error){ctx.status=error instanceof HttpError?error.status:500;ctx.body={code:(error as any).code,error:error instanceof Error?error.message:'Failed'}}})
  app.use(bodyParser());const router=service.router();app.use(router.routes());app.use(router.allowedMethods())
  const agent=store.createAgent('owner',{name:'浏览器 Bot',profile:'default'})
  const base=`/api/app/agents/${agent.id}`
  const turn=(options:Partial<BrowserTurnOptions>={},owner='owner',target=agent)=>{
    const controller=new AbortController(),publish=vi.fn(async(name:string,bytes:Buffer)=>({name,size:bytes.length})),upload=vi.fn(async()=>{throw new HttpError(403,'附件未授权','file_forbidden')})
    const value=service.openTurn(owner,target,{workId:randomUUID(),signal:controller.signal,authorize:()=>{},publish,upload,...options})
    turns.push(value);return {value,controller,publish,upload}
  }
  return {home,store,nodes,service,agent,base,app,hub,calls,versions,blockedSources,inactiveOwners,turn,
    setInstallation:(status:BrowserInstallation['status'],message='浏览器环境',error?:string)=>{installation={status,message,error,updatedAt:Date.now()}},
    setRetention:(value:boolean)=>{retention=value},
    runnerClosed:(scope:BrowserScope)=>{const state=stateFor(scope);state.open=false;state.tabs=[];state.generation++},
    setRunner:(id:string)=>{runnerId=id},runner:()=>runnerId,
    setEpoch:(id:string)=>{runnerEpoch=id},
    setDownload:(reply:(payload:any)=>unknown)=>{downloadReply=reply},
    setBeforeReply:(value:typeof beforeReply)=>{beforeReply=value},
    setAfterReply:(value:typeof afterReply)=>{afterReply=value},
    async close(){for(const turn of turns)await turn.close();service.close();nodes.close();store.close();rmSync(home,{recursive:true,force:true})}}
}
const controlURL=(base:string,action='')=>`${base}/computer${action}?backend=managed-browser`
afterEach(()=>vi.restoreAllMocks())

it('defaults off and reads an enabled browser without opening any execution environment',async()=>{
  const f=fixture(false)
  try{
    const off=await request(f.app.callback()).get(f.base+'/managed-browser').expect(200)
    expect(off.body).toMatchObject({enabled:false,available:false,open:false})
    expect(f.calls).toEqual([])
    saveHostTools(f.home,{managedBrowser:true,vm:false,serverComputer:false,scriptMachine:false})
    const status=await request(f.app.callback()).get(f.base+'/managed-browser').expect(200)
    expect(status.body).toMatchObject({enabled:true,available:true,open:false})
    expect(f.calls.map(call=>call.op)).toEqual(['status'])
    expect(f.service.allowed(f.runner(),f.calls[0].scope,f.calls[0].grantId)).toBe(false)
    await request(f.app.callback()).get(controlURL(f.base)).expect(200)
    expect(f.calls.some(call=>call.op==='open')).toBe(false)
  }finally{await f.close()}
})

it('isolates owner, source profile and grant scope instead of granting a whole runner',async()=>{
  const f=fixture()
  try{
    const other=f.store.createAgent('other',{name:'另一账号',profile:'default'})
    const first=f.turn(),second=f.turn({},'other',other)
    await first.value.call('managed_browser_state',{},'state-one')
    await second.value.call('managed_browser_state',{},'state-two')
    const [a,b]=f.calls
    expect(a.scope.ownerKey).toBe(digest('owner'));expect(b.scope.ownerKey).toBe(digest('other'))
    expect(f.service.allowed(f.runner(),a.scope,a.grantId)).toBe(true)
    expect(f.service.allowed(f.runner(),b.scope,a.grantId)).toBe(false)
    expect(f.service.allowed(randomUUID(),a.scope,a.grantId)).toBe(false)
    await request(f.app.callback()).get(f.base+'/managed-browser').set('x-fixture-owner','other').expect(404)
    f.blockedSources.add('owner:local:default')
    expect(f.service.allowed(f.runner(),a.scope,a.grantId)).toBe(false)
    await expect(first.value.call('managed_browser_state',{},'denied')).rejects.toMatchObject({code:'agent_source_forbidden'})
    expect((await f.service.state('owner',f.agent.id)).available).toBe(false)
  }finally{await f.close()}
})

it('keeps control tokens private, rejects cross-owner credentials and stale generations',async()=>{
  const f=fixture()
  try{
    const requestId=randomUUID(),take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId}).expect(200)
    const credentials={controlId:take.body.controlId,token:take.body.token}
    expect(credentials.token.length).toBeGreaterThan(32)
    const status=await request(f.app.callback()).get(controlURL(f.base)).expect(200)
    expect(status.body.mode).toBe('human');expect(status.body).not.toHaveProperty('token')
    expect(JSON.stringify(f.calls)).not.toContain(credentials.token)
    const repeat=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId}).expect(200)
    expect(repeat.body.token).toBe(credentials.token)
    await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(409)
    await request(f.app.callback()).post(controlURL(f.base,'/renew')).send({...credentials,token:'x'.repeat(43)}).expect(403)
    await request(f.app.callback()).post(controlURL(f.base,'/renew')).set('x-fixture-owner','other').send(credentials).expect(403)
    await request(f.app.callback()).post(f.base+'/managed-browser/action').send({...credentials,requestId:randomUUID(),generation:take.body.generation-1,action:{kind:'navigate',url:'https://example.com'}}).expect(409)
    const frame=await request(f.app.callback()).get(controlURL(f.base,'/frame')).expect(200)
    await request(f.app.callback()).post(controlURL(f.base,'/input')).send({...credentials,requestId:randomUUID(),generation:take.body.generation,frameId:randomUUID(),action:{kind:'click',x:1,y:1}}).expect(409)
    // Another viewer can read a frame without invalidating the human's recent
    // frame; retries of the same input must not press the key twice.
    await request(f.app.callback()).get(controlURL(f.base,'/frame')).expect(200)
    const input={...credentials,requestId:randomUUID(),generation:frame.body.generation,frameId:frame.body.id,action:{kind:'key',key:'a',modifiers:['ctrl']}}
    await request(f.app.callback()).post(controlURL(f.base,'/input')).send(input).expect(200)
    expect(f.calls.at(-1).operation.action).toEqual({kind:'key',key:'Control+a'})
    await request(f.app.callback()).post(controlURL(f.base,'/input')).send(input).expect(200)
    expect(f.calls.filter(call=>call.operation?.action.key==='Control+a')).toHaveLength(1)
    await request(f.app.callback()).post(controlURL(f.base,'/input')).send({...input,action:{kind:'text',text:'different'}}).expect(409)
    await request(f.app.callback()).post(controlURL(f.base,'/input')).send({...credentials,requestId:randomUUID(),generation:frame.body.generation,frameId:frame.body.id,action:{kind:'text',text:'stale'}}).expect(409)
    f.versions.set('owner',2)
    await request(f.app.callback()).post(controlURL(f.base,'/renew')).send(credentials).expect(410)
  }finally{await f.close()}
})

it('expires a human grant without admitting further input',async()=>{
  const f=fixture()
  try{
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    const credentials={controlId:take.body.controlId,token:take.body.token}
    vi.spyOn(Date,'now').mockReturnValue(take.body.expiresAt+1)
    await request(f.app.callback()).post(controlURL(f.base,'/renew')).send(credentials).expect(410)
    expect(f.service.allowed(f.runner(),f.calls[0].scope,credentials.controlId)).toBe(false)
  }finally{await f.close()}
})

it('joins concurrent retries of a human click and requires a new frame for the next action',async()=>{
  const f=fixture(),gate=defer(),entered=defer()
  try{
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    const frame=await request(f.app.callback()).get(controlURL(f.base,'/frame')).expect(200)
    const input={controlId:take.body.controlId,token:take.body.token,requestId:randomUUID(),generation:frame.body.generation,frameId:frame.body.id,action:{kind:'click',x:15,y:25}}
    f.setBeforeReply(async payload=>{if(payload.operation?.action.kind==='coordinate'){entered.resolve();await gate.promise}})
    const first=request(f.app.callback()).post(controlURL(f.base,'/input')).send(input).then(value=>value)
    await entered.promise
    const retry=request(f.app.callback()).post(controlURL(f.base,'/input')).send(input).then(value=>value)
    await new Promise(resolve=>setTimeout(resolve,20));gate.resolve()
    expect((await Promise.all([first,retry])).map(reply=>reply.status)).toEqual([200,200])
    expect(f.calls.filter(call=>call.operation?.action.kind==='coordinate')).toHaveLength(1)
    await request(f.app.callback()).post(controlURL(f.base,'/input')).send({...input,requestId:randomUUID()}).expect(409)
    const current=await request(f.app.callback()).get(controlURL(f.base,'/frame')).expect(200)
    await request(f.app.callback()).post(controlURL(f.base,'/input')).send({...input,requestId:randomUUID(),frameId:current.body.id}).expect(200)
    expect(f.calls.filter(call=>call.operation?.action.kind==='coordinate')).toHaveLength(2)
  }finally{gate.resolve();await f.close()}
})

it('waits for one confirmed pause before returning duplicate takeover requests',async()=>{
  const f=fixture(),gate=defer(),entered=defer(),requestId=randomUUID()
  let firstSettled=false,secondSettled=false
  f.setBeforeReply(async payload=>{if(payload.op==='pause'){entered.resolve();await gate.promise}})
  try{
    const first=request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId}).then(value=>{firstSettled=true;return value})
    await entered.promise
    const second=request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId}).then(value=>{secondSettled=true;return value})
    await new Promise(resolve=>setTimeout(resolve,20))
    expect(firstSettled).toBe(false);expect(secondSettled).toBe(false)
    gate.resolve()
    const replies=await Promise.all([first,second])
    expect(replies.map(reply=>reply.status)).toEqual([200,200])
    expect(replies[0]!.body.controlId).toBe(replies[1]!.body.controlId)
    expect(replies[0]!.body.token).toBe(replies[1]!.body.token)
    expect(f.calls.filter(call=>call.op==='pause')).toHaveLength(1)
  }finally{gate.resolve();await f.close()}
})

it('joins duplicate takeovers that arrived while the previous task was parking',async()=>{
  const f=fixture(),gate=defer(),entered=defer(),requestId=randomUUID()
  try{
    const task=f.turn();await task.value.call('managed_browser_open',{},'open')
    f.setBeforeReply(async payload=>{if(payload.op==='park'){entered.resolve();await gate.promise}})
    const closing=task.value.close();await entered.promise
    const first=request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId}).then(value=>value)
    const second=request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId}).then(value=>value)
    await new Promise(resolve=>setTimeout(resolve,20));gate.resolve();await closing
    const replies=await Promise.all([first,second])
    expect(replies.map(reply=>reply.status)).toEqual([200,200])
    expect(replies[0]!.body.controlId).toBe(replies[1]!.body.controlId)
    expect(replies[0]!.body.token).toBe(replies[1]!.body.token)
    expect(f.calls.filter(call=>call.op==='pause')).toHaveLength(1)
  }finally{gate.resolve();await f.close()}
})

it('holds task actions through takeover and resumes the same session with human notes',async()=>{
  const f=fixture()
  try{
    const task=f.turn()
    await task.value.call('managed_browser_open',{},'open')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    let settled=false
    const paused=task.value.call('managed_browser_action',{action:{kind:'text',text:'continue'}},'after-human').finally(()=>{settled=true})
    await new Promise(resolve=>setTimeout(resolve,20))
    expect(settled).toBe(false)
    expect(f.calls.some(call=>call.operation?.action.text==='continue')).toBe(false)
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send({controlId:take.body.controlId,token:take.body.token,notes:'已经登录'}).expect(200)
    expect(await paused).toMatchObject({humanNote:'已经登录',result:{ok:true}})
    expect(f.calls.filter(call=>call.op==='open')).toHaveLength(2)
    expect(f.calls.some(call=>call.op==='close')).toBe(false)
    const action=f.calls.find(call=>call.operation?.action.text==='continue')
    expect(action.scope.environmentId).toBe(f.agent.id)
    expect(action.operation.generation).toBeGreaterThan(take.body.generation)
  }finally{await f.close()}
})

it('cancels a task waiting on human control without closing the human browser',async()=>{
  const f=fixture()
  try{
    const task=f.turn()
    await task.value.call('managed_browser_open',{},'open')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    const waiting=task.value.call('managed_browser_snapshot',{},'waiting')
    const rejected=expect(waiting).rejects.toMatchObject({code:'browser_authorization_revoked'})
    task.controller.abort();await rejected
    expect(f.calls.some(call=>call.op==='close')).toBe(false)
    const status=await request(f.app.callback()).get(controlURL(f.base)).expect(200)
    expect(status.body).toMatchObject({mode:'human',canResume:false,controlId:take.body.controlId})
  }finally{await f.close()}
})

it('assembles verified download chunks once and publishes through the existing artifact callback',async()=>{
  const f=fixture(),bytes=Buffer.alloc(512*1024+17,7),id=randomUUID()
  f.setDownload(({offset})=>({size:bytes.length,sha256:digest(bytes),name:'report.csv',mimeType:'text/csv',offset,data:bytes.subarray(offset,offset+512*1024).toString('base64')}))
  try{
    const task=f.turn()
    const first=await task.value.call('managed_browser_export',{downloadId:id},'download')
    const again=await task.value.call('managed_browser_export',{downloadId:id},'download')
    expect(again).toEqual(first)
    expect(task.publish).toHaveBeenCalledExactlyOnceWith('report.csv',bytes)
    expect(f.calls.filter(call=>call.op==='download').map(call=>call.offset)).toEqual([0,512*1024])
  }finally{await f.close()}
})

it.each(['offset','hash','size','base64','changed'] as const)('rejects %s corruption before exporting a download',async(problem)=>{
  const f=fixture(),bytes=Buffer.alloc(512*1024+1,3)
  f.setDownload(({offset})=>({size:problem==='size'?26*1024*1024:bytes.length,sha256:problem==='hash'?'0'.repeat(64):digest(bytes),name:problem==='changed'&&offset?'changed.txt':'file.txt',mimeType:'text/plain',offset:problem==='offset'?offset+1:offset,data:problem==='base64'?'%%%':bytes.subarray(offset,offset+512*1024).toString('base64')}))
  try{
    const task=f.turn()
    await expect(task.value.call('managed_browser_export',{downloadId:randomUUID()},'bad-download')).rejects.toMatchObject({code:problem==='changed'?'browser_download_changed':'browser_download_invalid'})
    expect(task.publish).not.toHaveBeenCalled()
  }finally{await f.close()}
})

it('resolves uploads only through the authorized attachment callback and refuses host paths',async()=>{
  const f=fixture()
  try{
    const snapshotId=randomUUID(),fileId=randomUUID(),upload=vi.fn(async(id:string)=>{if(id!==fileId)throw new HttpError(403,'附件未授权','file_forbidden');return {name:'allowed.txt',mimeType:'text/plain',buffer:Buffer.from('owned')}})
    const task=f.turn({upload})
    await task.value.call('managed_browser_upload',{fileId,snapshotId,ref:'e1'},'upload')
    expect(upload).toHaveBeenCalledExactlyOnceWith(fileId)
    const call=f.calls.find(call=>call.upload)
    expect(call.upload.data).toBe(Buffer.from('owned').toString('base64'))
    expect(call.operation.action).toMatchObject({kind:'upload',snapshotId,ref:'e1',fileId:call.upload.id})
    await expect(task.value.call('managed_browser_upload',{fileId,path:'/etc/passwd',snapshotId,ref:'e1'},'host-path')).rejects.toMatchObject({code:'browser_upload_invalid'})
    await expect(task.value.call('managed_browser_upload',{fileId:randomUUID(),snapshotId,ref:'e1'},'other-file')).rejects.toMatchObject({code:'file_forbidden'})
    await expect(task.value.call('managed_browser_upload_vm',{path:'/workspace/input.txt',snapshotId,ref:'e1'},'vm-not-granted')).rejects.toMatchObject({code:'browser_vm_unavailable'})
    expect(f.calls.filter(call=>call.upload)).toHaveLength(1)
  }finally{await f.close()}
})

it('allows a newly authorized profile after the prior browser task has closed',async()=>{
  const f=fixture()
  try{
    const first=f.turn();await first.value.call('managed_browser_open',{},'first');await first.value.close()
    const updated=f.store.updateAgent('owner',f.agent.id,{profile:'writer'})
    const second=f.turn({},'owner',updated)
    await expect(second.value.call('managed_browser_open',{},'second')).resolves.toMatchObject({open:true})
    expect((await f.service.state('owner',f.agent.id)).available).toBe(true)
  }finally{await f.close()}
})

it.each(['profile','runner'] as const)('recovers an active browser after its %s changes and fences the old task and human grant',async(source)=>{
  const f=fixture()
  try{
    const cards:ManagedBrowserCard[]=[]
    const first=f.turn({onCard:card=>{cards.push(card)}});await first.value.call('managed_browser_open',{},'first-open')
    const oldRunner=f.runner(),oldTask=f.calls[0]
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    const credentials={controlId:take.body.controlId,token:take.body.token}
    const updated=source==='profile'?f.store.updateAgent('owner',f.agent.id,{profile:'writer'}):f.agent
    if(source==='runner')f.setRunner(randomUUID())
    expect(f.service.allowed(oldRunner,oldTask.scope,oldTask.grantId)).toBe(false)
    expect(f.service.allowed(oldRunner,oldTask.scope,credentials.controlId)).toBe(false)
    await expect(first.value.call('managed_browser_state',{},'old-task')).rejects.toMatchObject({status:410})
    await request(f.app.callback()).post(controlURL(f.base,'/renew')).send(credentials).expect(410)

    const start=f.calls.length,second=f.turn({},'owner',updated)
    await expect(second.value.call('managed_browser_open',{},'new-open')).resolves.toMatchObject({open:true})
    expect(cards.at(-1)).toMatchObject({status:'closed',message:'浏览器执行来源已改变，本轮会话已结束'})
    const replacement=f.calls.slice(start)
    expect(replacement.map(call=>call.op)).toEqual(['close','status','open','status'])
    expect(replacement.every(call=>call.runnerId===f.runner())).toBe(true)
    expect(replacement.every(call=>call.grantId!==oldTask.grantId&&call.grantId!==credentials.controlId)).toBe(true)
    await request(f.app.callback()).post(controlURL(f.base,'/renew')).send(credentials).expect(403)
    await expect(first.value.call('managed_browser_state',{},'old-task-after-reset')).rejects.toMatchObject({status:410})

    // Finishing the retired task must not close the replacement's same-Bot
    // context, even when the browser scope stayed identical on one Runner.
    const beforeOldClose=f.calls.length;await first.value.close()
    expect(f.calls).toHaveLength(beforeOldClose)
    expect((await f.service.state('owner',f.agent.id)).open).toBe(true)
    const nextTake=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    expect(nextTake.body.controlId).not.toBe(credentials.controlId)
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send({controlId:nextTake.body.controlId,token:nextTake.body.token}).expect(200)
    await expect(second.value.call('managed_browser_state',{},'new-task-after-human')).resolves.toMatchObject({open:true})

    // Returning the routing configuration to its old value must not revive a
    // grant belonging to the replaced Resource object.
    if(source==='profile')f.store.updateAgent('owner',f.agent.id,{profile:'default'})
    else f.setRunner(oldRunner)
    expect(f.service.allowed(oldRunner,oldTask.scope,oldTask.grantId)).toBe(false)
    expect(f.service.allowed(oldRunner,oldTask.scope,credentials.controlId)).toBe(false)
  }finally{await f.close()}
})

it('reads owned file IDs with the real upload store and rechecks their source authorization',async()=>{
  const f=fixture(),uploads=new UploadStore(f.home),id=randomUUID(),bytes=Buffer.from('private attachment')
  const tempPath=join(uploads.uploadRoot,'staged'),path=join(uploads.uploadRoot,id)
  writeFileSync(tempPath,bytes)
  uploads.commit([{id,name:'owned.txt',mimeType:'text/plain',size:bytes.length,path,tempPath,accountKey:'owner',referenced:false}])
  try{
    expect((await browserOwnedFile(f.store,f.nodes,uploads,'owner',id)).buffer).toEqual(bytes)
    await expect(browserOwnedFile(f.store,f.nodes,uploads,'other',id)).rejects.toMatchObject({code:'upload_not_found'})
    await expect(browserOwnedFile(f.store,f.nodes,uploads,'owner',path)).rejects.toMatchObject({code:'invalid_upload'})
    const artifactId=randomUUID(),artifactPath=join(f.home,'artifact.txt')
    writeFileSync(artifactPath,'generated')
    f.store.put('owner','file',artifactId,{id:artifactId,name:'artifact.txt',mimeType:'text/plain',size:9,path:artifactPath,sender:'agent',messageFileSource:'attachment',sourceNodeId:'local',profile:'writer',createdAt:Date.now()})
    expect((await browserOwnedFile(f.store,f.nodes,uploads,'owner',artifactId)).buffer.toString()).toBe('generated')
    f.blockedSources.add('owner:local:writer')
    await expect(browserOwnedFile(f.store,f.nodes,uploads,'owner',artifactId)).rejects.toMatchObject({code:'agent_source_forbidden'})
    const symlinkId=randomUUID(),symlinkPath=join(f.home,'linked.txt');symlinkSync(artifactPath,symlinkPath)
    f.store.put('owner','file',symlinkId,{id:symlinkId,name:'linked.txt',mimeType:'text/plain',size:9,path:symlinkPath,sender:'user',createdAt:Date.now()})
    await expect(browserOwnedFile(f.store,f.nodes,uploads,'owner',symlinkId)).rejects.toThrow()
  }finally{uploads.close();await f.close()}
})

it('copies browser bytes through the checked VM endpoint with overwrite and root confinement',async()=>{
  const f=fixture(),directory=join(f.home,'vm');mkdirSync(directory)
  const endpoint=new FileTransferFiles(directory),path=join(directory,'file.csv'),bytes=Buffer.alloc(512*1024+7,9),file={name:'file.csv',mimeType:'text/csv',buffer:bytes}
  const transfer=(action:Record<string,unknown>)=>endpoint.call(action)
  try{
    expect(await browserVmFile(transfer,path,()=>{},file)).toMatchObject({copied:true,target:{host:'vm',path}})
    expect(await readFile(path)).toEqual(bytes)
    await expect(browserVmFile(transfer,path,()=>{},file)).rejects.toThrow()
    expect((await browserVmFile(transfer,path,()=>{})) as any).toMatchObject({name:'file.csv',mimeType:'text/csv',buffer:bytes})
    await expect(browserVmFile(transfer,'../host-file',()=>{},file)).rejects.toMatchObject({code:'browser_vm_path_invalid'})
    await expect(browserVmFile(transfer,join(f.home,'outside.txt'),()=>{},file)).rejects.toThrow('路径')
    await browserVmFile(transfer,path,()=>{},{...file,buffer:Buffer.from('updated')},true)
    expect((await readFile(path)).toString()).toBe('updated')
  }finally{await endpoint.close();await f.close()}
})

it('prepares a missing environment without granting browser execution, and releases its installation grant when ready',async()=>{
  const f=fixture()
  try{
    f.setInstallation('missing')
    expect((await request(f.app.callback()).get(f.base+'/managed-browser').expect(200)).body).toMatchObject({enabled:true,available:false,installation:{status:'missing'}})
    expect(f.calls.some(call=>call.op==='prepare')).toBe(false)
    await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(409)
    expect(f.calls.some(call=>call.op==='open'||call.op==='pause')).toBe(false)
    const first=await request(f.app.callback()).post(f.base+'/managed-browser/prepare').send({}).expect(200)
    expect(first.body).toMatchObject({available:false,installation:{status:'installing'}})
    const setup=f.calls.find(call=>call.op==='prepare')
    expect(f.service.allowed(f.runner(),setup.scope,setup.grantId)).toBe(true)
    expect(f.service.allowed(f.runner(),setup.scope)).toBe(false)
    await request(f.app.callback()).post(f.base+'/managed-browser/prepare').send({}).expect(200)
    expect(f.calls.filter(call=>call.op==='prepare').every(call=>call.grantId===setup.grantId)).toBe(true)
    f.setInstallation('ready')
    expect((await request(f.app.callback()).get(f.base+'/managed-browser').expect(200)).body.available).toBe(true)
    expect(f.service.allowed(f.runner(),setup.scope,setup.grantId)).toBe(false)
    await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
  }finally{await f.close()}
})

it('requires explicit installation retry and applies current owner/source permissions to preparation',async()=>{
  const f=fixture()
  try{
    f.setInstallation('failed','下载失败','网络不可用')
    expect((await request(f.app.callback()).post(f.base+'/managed-browser/prepare').send({}).expect(200)).body.installation.status).toBe('failed')
    const failed=f.calls.find(call=>call.op==='prepare')
    expect(f.service.allowed(f.runner(),failed.scope,failed.grantId)).toBe(false)
    expect((await request(f.app.callback()).post(f.base+'/managed-browser/prepare').send({retry:true}).expect(200)).body.installation.status).toBe('installing')
    const retry=f.calls.at(-1)
    expect(retry.retry).toBe(true)
    expect(f.service.allowed(f.runner(),retry.scope,retry.grantId)).toBe(true)
    await request(f.app.callback()).post(f.base+'/managed-browser/prepare').set('x-fixture-owner','other').send({retry:true}).expect(404)
    f.blockedSources.add('owner:local:default')
    expect(f.service.allowed(f.runner(),retry.scope,retry.grantId)).toBe(false)
    await request(f.app.callback()).post(f.base+'/managed-browser/prepare').send({retry:true}).expect(403)
  }finally{await f.close()}
})

it('publishes preparation and same-session takeover cards, preserving safe page history after completion',async()=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[],preparing=defer()
  try{
    f.setInstallation('missing')
    const task=f.turn({onCard:card=>{cards.push(structuredClone(card))}})
    f.setBeforeReply(async payload=>{if(payload.op==='prepare')preparing.resolve()})
    const opening=task.value.call('managed_browser_open',{url:'https://user:secret@example.com/page?token=private#password'},'open')
    await preparing.promise
    await vi.waitFor(()=>expect(cards.at(-1)).toMatchObject({status:'preparing',installation:{status:'installing'}}))
    expect(f.calls.some(call=>call.op==='open')).toBe(false)
    f.setInstallation('ready')
    await opening
    const active=cards.at(-1)!
    expect(active).toMatchObject({agentId:f.agent.id,status:'active',title:'Example',url:'https://example.com/page'})
    expect(JSON.stringify(cards)).not.toMatch(/secret|private|password/)
    const taskGrant=f.calls.find(call=>call.op==='prepare')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    expect(cards.at(-1)?.message).toContain('人工控制中')
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send({controlId:take.body.controlId,token:take.body.token}).expect(200)
    const resume=f.calls.find(call=>call.op==='resume')
    expect(resume.grantId).toBe(taskGrant.grantId)
    expect(f.service.allowed(f.runner(),resume.scope,resume.grantId)).toBe(true)
    await task.value.close()
    expect(cards.at(-1)).toMatchObject({id:active.id,status:'idle',title:'Example',url:'https://example.com/page'})
    const takeAgain=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    expect(cards.at(-1)).toMatchObject({status:'active',message:'人工控制中，交还后保留页面'})
    await request(f.app.callback()).post(f.base+'/managed-browser/close').send({controlId:takeAgain.body.controlId,token:takeAgain.body.token}).expect(200)
    expect(cards.at(-1)).toMatchObject({status:'closed',url:'https://example.com/page'})
  }finally{await f.close()}
})

it('reports installation failure on the card without opening a browser or silently reinstalling',async()=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[]
  try{
    f.setInstallation('failed','浏览器下载失败','无法连接下载服务')
    const task=f.turn({onCard:card=>{cards.push(card)}})
    await expect(task.value.call('managed_browser_open',{},'open')).rejects.toMatchObject({code:'browser_install_failed'})
    expect(cards.at(-1)).toMatchObject({status:'failed',message:'无法连接下载服务',installation:{status:'failed'}})
    expect(f.calls.find(call=>call.op==='prepare')).not.toHaveProperty('retry',true)
    expect(f.calls.some(call=>call.op==='open')).toBe(false)
  }finally{await f.close()}
})

it('revokes an installing task immediately on cancellation, without late opening',async()=>{
  const f=fixture(),prepared=defer()
  try{
    f.setInstallation('missing')
    const task=f.turn()
    f.setBeforeReply(async payload=>{if(payload.op==='prepare')prepared.resolve()})
    const opening=task.value.call('managed_browser_open',{},'open')
    const rejected=expect(opening).rejects.toMatchObject({code:'browser_authorization_revoked'})
    await prepared.promise
    task.controller.abort()
    await rejected
    const setup=f.calls.find(call=>call.op==='prepare')
    expect(f.service.allowed(f.runner(),setup.scope,setup.grantId)).toBe(false)
    f.setInstallation('ready')
    expect(f.calls.some(call=>call.op==='open')).toBe(false)
  }finally{await f.close()}
})

it('retains the card through a task ending under human control and parks it after giveback',async()=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[]
  try{
    const task=f.turn({onCard:card=>{cards.push(card)}})
    await task.value.call('managed_browser_open',{url:'https://example.com/page'},'open')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    await task.value.close()
    expect(cards.at(-1)).toMatchObject({status:'active',message:'人工控制中，交还后保留页面'})
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send({controlId:take.body.controlId,token:take.body.token}).expect(200)
    expect(cards.at(-1)).toMatchObject({status:'idle',url:'https://example.com/page'})
  }finally{await f.close()}
})

it('keeps browser handoff and authorization cleanup working when the card observer throws',async()=>{
  const f=fixture(),observe=vi.fn(()=>{throw new Error('chat history unavailable')})
  try{
    const task=f.turn({onCard:observe})
    await expect(task.value.call('managed_browser_open',{url:'https://example.com/page'},'open')).resolves.toBeDefined()
    const taskGrant=f.calls.find(call=>call.op==='open')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    await expect(task.value.close()).resolves.toBeUndefined()
    expect(f.service.allowed(f.runner(),taskGrant.scope,taskGrant.grantId)).toBe(false)
    await expect((f.service as any).sweep()).resolves.toBeUndefined()
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send({controlId:take.body.controlId,token:take.body.token}).expect(200)
    expect(f.service.allowed(f.runner(),taskGrant.scope)).toBe(true)
    expect(f.calls.at(-1).op).toBe('park')
    expect(observe).toHaveBeenCalled()
  }finally{await f.close()}
})

it('retries an unchanged card after its persistence observer reports a failed save',async()=>{
  const f=fixture(),observe=vi.fn(()=>false)
  try{
    const task=f.turn({onCard:observe})
    await task.value.call('managed_browser_state',{},'state')
    const calls=observe.mock.calls.length
    await task.value.call('managed_browser_state',{},'state-again')
    expect(observe.mock.calls.length).toBeGreaterThan(calls)
    observe.mockReturnValue(true)
    await task.value.call('managed_browser_state',{},'state-saved')
    const saved=observe.mock.calls.length
    await task.value.call('managed_browser_state',{},'unchanged')
    expect(observe).toHaveBeenCalledTimes(saved)
  }finally{await f.close()}
})

it('retains tabs across task boundaries without retaining old task authority or waking on status',async()=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[]
  try{
    const first=f.turn({onCard:card=>{cards.push(card)}})
    const opened=await first.value.call('managed_browser_open',{url:'https://example.com/session'},'first') as BrowserState
    const original=f.calls.find(call=>call.op==='open')
    await first.value.close()
    const park=f.calls.at(-1)
    expect(park.op).toBe('park');expect(park.grantId).not.toBe(original.grantId)
    expect(f.service.allowed(f.runner(),original.scope,original.grantId)).toBe(false)
    expect(f.service.allowed(f.runner(),park.scope,park.grantId)).toBe(false)
    expect(f.service.allowed(f.runner(),park.scope)).toBe(true)
    expect(cards.at(-1)).toMatchObject({status:'idle',url:'https://example.com/session'})
    const statusTurn=f.turn(),start=f.calls.length
    expect(await statusTurn.value.call('managed_browser_state',{},'read')).toMatchObject({open:true,tabs:opened.tabs})
    await statusTurn.value.close()
    expect(f.calls.slice(start).map(call=>call.op)).toEqual(['status'])
    const next=f.turn(),before=f.calls.length
    await next.value.call('managed_browser_snapshot',{},'snapshot')
    expect(f.calls.slice(before).map(call=>call.op)).toEqual(['resume','execute'])
    expect(f.calls.at(-1).operation.generation).toBeGreaterThan(opened.generation)
    expect(f.calls.at(-1).grantId).not.toBe(park.grantId)
    await expect(first.value.call('managed_browser_state',{},'old')).rejects.toMatchObject({code:'browser_authorization_revoked'})
    expect((await f.service.state('owner',f.agent.id)).tabs).toEqual(opened.tabs)
  }finally{await f.close()}
})

it.each(['temporary','legacy','cancel'] as const)('recycles %s sessions instead of claiming they were retained',async kind=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[]
  try{
    if(kind==='legacy')f.setRetention(false)
    const agent=kind==='temporary'?{...f.agent,temporaryGoalId:randomUUID()}:f.agent
    if(kind==='temporary')f.store.put('owner','agent',agent.id,agent)
    const task=f.turn({onCard:card=>{cards.push(card)}},'owner',agent)
    await task.value.call('managed_browser_open',{},'open')
    const opening=f.calls.find(call=>call.op==='open')
    await task.value.close({retain:kind!=='cancel'})
    expect(f.calls.at(-1).op).toBe('close')
    expect(f.calls.some(call=>call.op==='park')).toBe(false)
    expect(f.service.allowed(f.runner(),opening.scope)).toBe(false)
    expect(cards.at(-1)?.status).toBe('closed')
    if(kind==='legacy')expect((await f.service.state('owner',agent.id)).supportsRetention).toBe(false)
  }finally{await f.close()}
})

it('keeps an independently controlled browser on task cancellation, then closes on giveback',async()=>{
  const f=fixture()
  try{
    const task=f.turn();await task.value.call('managed_browser_open',{},'open')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    const body={controlId:take.body.controlId,token:take.body.token},scope=f.calls[0].scope
    task.controller.abort();await task.value.close()
    expect(f.service.allowed(f.runner(),scope,take.body.controlId)).toBe(true)
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send(body).expect(200)
    expect(f.calls.at(-1).op).toBe('close');expect(f.service.allowed(f.runner(),scope)).toBe(false)
  }finally{await f.close()}
})

it('allows explicit close only for the current human holder after the task has ended',async()=>{
  const f=fixture()
  try{
    const task=f.turn();await task.value.call('managed_browser_open',{},'open')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    const body={controlId:take.body.controlId,token:take.body.token},scope=f.calls[0].scope
    await request(f.app.callback()).post(f.base+'/managed-browser/close').send(body).expect(409)
    await task.value.close()
    await request(f.app.callback()).post(f.base+'/managed-browser/close').send({...body,token:'x'.repeat(43)}).expect(403)
    await request(f.app.callback()).post(f.base+'/managed-browser/close').set('x-fixture-owner','other').send(body).expect(403)
    const other=f.store.createAgent('owner',{name:'另一个 Bot',profile:'default'})
    await request(f.app.callback()).post(`/api/app/agents/${other.id}/managed-browser/close`).send(body).expect(403)
    const result=await request(f.app.callback()).post(f.base+'/managed-browser/close').send(body).expect(200)
    expect(result.body).toMatchObject({mode:'off',canResume:false})
    expect(result.body).not.toHaveProperty('controlId')
    expect(f.service.allowed(f.runner(),scope)).toBe(false)
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send(body).expect(403)
  }finally{await f.close()}
})

it.each([false,true])('handles expired human control with task present=%s without reviving its authority',async active=>{
  const f=fixture()
  try{
    const task=active?f.turn():undefined
    if(task)await task.value.call('managed_browser_open',{},'open')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200),scope=f.calls[0].scope
    vi.spyOn(Date,'now').mockReturnValue(take.body.expiresAt+1)
    // The retained scope bridges expiry and the next server sweep; it grants no input.
    expect(f.service.allowed(f.runner(),scope)).toBe(true)
    expect(f.service.allowed(f.runner(),scope,take.body.controlId)).toBe(false)
    await (f.service as any).sweep()
    const status=await request(f.app.callback()).get(controlURL(f.base)).expect(200)
    expect(status.body.mode).toBe(active?'pausing':'idle')
    expect(f.calls.some(call=>call.op==='park')).toBe(!active)
    expect(f.calls.some(call=>call.op==='resume')).toBe(false)
    expect((await f.service.state('owner',f.agent.id)).open).toBe(true)
  }finally{await f.close()}
})

it.each(['owner','logout','source','global'] as const)('revokes retained sessions and human authority when %s access is removed',async reason=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[]
  try{
    const task=f.turn({onCard:card=>{cards.push(card)}});await task.value.call('managed_browser_open',{},'open');await task.value.close()
    const scope=f.calls[0].scope
    if(reason==='owner')f.inactiveOwners.add('owner')
    else if(reason==='logout')f.versions.set('owner',2)
    else if(reason==='source')f.blockedSources.add('owner:local:default')
    else saveHostTools(f.home,{managedBrowser:false})
    expect(f.service.allowed(f.runner(),scope)).toBe(false)
    await (f.service as any).sweep()
    expect(cards.at(-1)?.status).toBe('closed')
    expect(f.calls.filter(call=>call.op==='park')).toHaveLength(1)
  }finally{await f.close()}
})

it('falls back to confirmed close when parking fails',async()=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[]
  try{
    const task=f.turn({onCard:card=>{cards.push(card)}});await task.value.call('managed_browser_open',{},'open')
    f.setBeforeReply(async payload=>{if(payload.op==='park')throw new Error('park failed')})
    await task.value.close()
    expect(f.calls.slice(-2).map(call=>call.op)).toEqual(['park','close'])
    expect(f.service.allowed(f.runner(),f.calls[0].scope)).toBe(false)
    expect(cards.at(-1)?.status).toBe('closed')
  }finally{await f.close()}
})

it('updates the retained card and drops its grant after Runner idle reclamation',async()=>{
  const f=fixture(),cards:ManagedBrowserCard[]=[]
  try{
    const task=f.turn({onCard:card=>{cards.push(card)}});await task.value.call('managed_browser_open',{},'open');await task.value.close()
    const scope=f.calls[0].scope,start=f.calls.length
    f.runnerClosed(scope)
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+31000)
    await (f.service as any).sweep()
    await vi.waitFor(()=>expect(cards.at(-1)?.status).toBe('closed'))
    expect(f.calls.slice(start).map(call=>call.op)).toEqual(['status'])
    expect(f.service.allowed(f.runner(),scope)).toBe(false)
  }finally{await f.close()}
})

it('parks a status-only turn when its human holder expired before normal completion',async()=>{
  const f=fixture()
  try{
    const first=f.turn();await first.value.call('managed_browser_open',{},'open');await first.value.close()
    const read=f.turn();await read.value.call('managed_browser_state',{},'read')
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    vi.spyOn(Date,'now').mockReturnValue(take.body.expiresAt+1)
    await read.value.close()
    expect(f.calls.filter(call=>call.op==='park')).toHaveLength(2)
    expect(f.calls.at(-1).op).toBe('park')
    expect((await request(f.app.callback()).get(controlURL(f.base)).expect(200)).body.mode).toBe('idle')
  }finally{await f.close()}
})

it.each(['close','giveback'] as const)('serializes %s against the competing release action and a new takeover',async firstAction=>{
  const f=fixture(),entered=defer(),gate=defer()
  try{
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    const credentials={controlId:take.body.controlId,token:take.body.token}
    const url=(action:'close'|'giveback')=>action==='close'?f.base+'/managed-browser/close':controlURL(f.base,'/giveback')
    f.setBeforeReply(async payload=>{if(payload.op===(firstAction==='close'?'close':'park')){entered.resolve();await gate.promise}})
    const first=request(f.app.callback()).post(url(firstAction)).send(credentials).then(value=>value)
    await entered.promise
    const other=request(f.app.callback()).post(url(firstAction==='close'?'giveback':'close')).send(credentials).then(value=>value)
    let taken=false
    const next=request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).then(value=>{taken=true;return value})
    await new Promise(resolve=>setTimeout(resolve,20));expect(taken).toBe(false)
    gate.resolve()
    expect((await first).status).toBe(200);expect((await other).status).toBe(403)
    const current=await next
    expect(current.status).toBe(200);expect(current.body.controlId).not.toBe(credentials.controlId)
    expect(f.calls.at(-1).op).toBe('open')
  }finally{gate.resolve();await f.close()}
})

it('waits for a background retained-state check before admitting the next task',async()=>{
  const f=fixture(),entered=defer(),gate=defer()
  try{
    const first=f.turn();await first.value.call('managed_browser_open',{},'open');await first.value.close()
    f.setBeforeReply(async payload=>{if(payload.op==='status'){entered.resolve();await gate.promise}})
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+31000)
    await (f.service as any).sweep();await entered.promise
    const next=f.turn(),pending=next.value.call('managed_browser_snapshot',{},'next')
    gate.resolve()
    await expect(pending).resolves.toMatchObject({ok:true})
    expect(f.calls.slice(-2).map(call=>call.op)).toEqual(['resume','execute'])
  }finally{gate.resolve();await f.close()}
})

it('ignores a late closed-state reply instead of deleting the newly opened retained session',async()=>{
  const f=fixture(),entered=defer(),gate=defer();let held=false
  try{
    f.setAfterReply(async payload=>{if(payload.op==='status'&&!held){held=true;entered.resolve();await gate.promise}})
    const oldStatus=f.service.state('owner',f.agent.id);await entered.promise
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    gate.resolve();await oldStatus
    const current=await f.service.state('owner',f.agent.id)
    expect(current).toMatchObject({open:true,generation:take.body.generation})
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send({controlId:take.body.controlId,token:take.body.token}).expect(200)
    expect(f.calls.at(-1).op).toBe('park')
    expect(f.service.allowed(f.runner(),f.calls[0].scope)).toBe(true)
  }finally{gate.resolve();await f.close()}
})

it('accepts a restarted Runner generation after fencing the previous connection epoch',async()=>{
  const f=fixture()
  try{
    const old=f.turn();await old.value.call('managed_browser_open',{},'old')
    const taskGrant=f.calls.find(call=>call.op==='open')
    const earlier=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    await request(f.app.callback()).post(controlURL(f.base,'/giveback')).send({controlId:earlier.body.controlId,token:earlier.body.token}).expect(200)
    const take=await request(f.app.callback()).post(controlURL(f.base,'/take')).send({requestId:randomUUID()}).expect(200)
    await old.value.close()
    f.setEpoch(randomUUID())
    expect(f.service.allowed(f.runner(),taskGrant.scope,taskGrant.grantId)).toBe(false)
    expect(f.service.allowed(f.runner(),taskGrant.scope,take.body.controlId)).toBe(false)
    const start=f.calls.length,newTurn=f.turn(),state=await newTurn.value.call('managed_browser_open',{},'new') as BrowserState
    expect(f.calls.slice(start).map(call=>call.op)).toEqual(['close','status','open','status'])
    expect(state.open).toBe(true);expect(state.generation).toBeLessThan(take.body.generation)
    await newTurn.value.close()
    expect((await f.service.state('owner',f.agent.id)).open).toBe(true)
  }finally{await f.close()}
})
