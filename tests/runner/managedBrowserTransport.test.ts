// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {RunnerBrowser} from '../../src/runner/managedBrowser.js'
import type {BrowserInstaller} from '../../src/runner/browser/installation.js'
import type {BrowserRuntime,BrowserCallContext,BrowserScope} from '../../src/runner/browser/runtime.js'

const scope:BrowserScope={ownerKey:'a'.repeat(64),environmentId:randomUUID(),profile:'persistent'},grantId=randomUUID()
const scopes:RunnerBrowser[]=[]
function fixture(config:{enabled:boolean;idleTimeoutMs?:number}={enabled:true},installer?:BrowserInstaller){
  const runtime={status:vi.fn(async()=>({open:false,generation:1,tabs:[],downloads:[]})),open:vi.fn(async()=>({open:true,generation:1,tabs:[],downloads:[]})),execute:vi.fn(async()=>({ok:true})),pause:vi.fn(),resume:vi.fn(),park:vi.fn(async()=>({open:true,generation:2,tabs:[],downloads:[]})),close:vi.fn(),readDownload:vi.fn(),revoke:vi.fn(async()=>{}),shutdown:vi.fn(async()=>{})}
  const check=vi.fn(async(_scope:BrowserScope,_grant?:string)=>{}),probe=vi.fn(async()=>true)
  const browser=new RunnerBrowser(config,'/unused-browser-test',check,{runtime:runtime as unknown as BrowserRuntime,probe,installer});scopes.push(browser)
  const profileAllowed=vi.fn((_profile:string)=>{})
  const invoke=(value:Record<string,unknown>,expiresAt=Date.now()+30000)=>browser.invoke({scope,profile:'default',grantId,...value},expiresAt,profileAllowed)
  return {browser,runtime,check,probe,profileAllowed,invoke}
}
afterEach(async()=>{vi.useRealTimers();for(const browser of scopes.splice(0))await browser.shutdown()})

describe('managed browser Runner transport',()=>{
  it('keeps default-disabled and missing-browser installations unavailable',async()=>{
    const f=fixture({enabled:false});await f.browser.ready
    expect(f.browser.available).toBe(false);expect(f.probe).not.toHaveBeenCalled()
    await expect(f.invoke({op:'open'})).rejects.toMatchObject({code:'browser_unavailable'})
    expect(f.runtime.open).not.toHaveBeenCalled()
    const unavailable=new RunnerBrowser({enabled:true},'/unused',async()=>{}, {runtime:f.runtime as unknown as BrowserRuntime,probe:async()=>false});scopes.push(unavailable)
    await unavailable.ready;expect(unavailable.available).toBe(false)
  })
  it('rejects forbidden Profiles, expired commands and foreign grants before execution',async()=>{
    const f=fixture();f.profileAllowed.mockImplementationOnce(()=>{throw new Error('profile forbidden')})
    await expect(f.invoke({op:'open'})).rejects.toThrow('profile forbidden')
    await expect(f.invoke({op:'open'},Date.now()-1)).rejects.toMatchObject({code:'browser_command_expired'})
    f.check.mockRejectedValueOnce(new Error('foreign grant'))
    await expect(f.invoke({op:'open'})).rejects.toThrow('foreign grant')
    expect(f.runtime.open).not.toHaveBeenCalled()
  })
  it('retains the explicit task grant for background activity after the command deadline',async()=>{
    vi.useFakeTimers();const f=fixture();let context:BrowserCallContext|undefined
    f.runtime.open.mockImplementationOnce(async(_scope?:unknown,call?:BrowserCallContext)=>{context=call;return {open:true,generation:1,tabs:[],downloads:[]}})
    await f.invoke({op:'open'},Date.now()+1000)
    await vi.advanceTimersByTimeAsync(5000)
    await context!.authorize()
    expect(f.check).toHaveBeenLastCalledWith(scope,grantId)
    expect(context!.signal!.aborted).toBe(false)
    f.check.mockRejectedValueOnce(new Error('grant revoked'))
    await expect(context!.authorize()).rejects.toThrow('grant revoked')
  })
  it('aborts in-flight execution when its transport deadline expires',async()=>{
    vi.useFakeTimers();const f=fixture()
    f.runtime.execute.mockImplementationOnce(async(_scope?:unknown,_operation?:unknown,context?:BrowserCallContext)=>new Promise((_resolve,reject)=>context!.signal!.addEventListener('abort',()=>reject(context!.signal!.reason),{once:true})))
    const result=f.invoke({op:'execute',operation:{generation:1,operationId:'slow',action:{kind:'text',text:'test'}}},Date.now()+1000).catch(error=>error)
    await vi.advanceTimersByTimeAsync(2100)
    expect(await result).toMatchObject({code:'browser_command_expired'})
    expect(f.runtime.execute).toHaveBeenCalledTimes(1)
  })
  it('disconnect aborts current calls and revokes all opened scopes',async()=>{
    const f=fixture()
    f.runtime.execute.mockImplementationOnce(async(_scope?:unknown,_operation?:unknown,context?:BrowserCallContext)=>new Promise((_resolve,reject)=>context!.signal!.addEventListener('abort',()=>reject(context!.signal!.reason),{once:true})))
    const result=f.invoke({op:'execute',operation:{generation:1,operationId:'inflight',action:{kind:'screenshot'}}}).catch(error=>error)
    await vi.waitFor(()=>expect(f.runtime.execute).toHaveBeenCalled())
    await f.browser.disconnect();expect(await result).toBeInstanceOf(Error)
    expect(f.runtime.revoke).toHaveBeenCalledWith(scope)
  })
  it('serves validated 512-KiB chunks, rechecking grants even for cached files',async()=>{
    const f=fixture(),id=randomUUID(),buffer=Buffer.alloc(512*1024+7,97),sha256=createHash('sha256').update(buffer).digest('hex')
    f.runtime.readDownload.mockResolvedValue({name:'large.txt',mimeType:'text/plain',buffer,metadata:{id,name:'large.txt',mimeType:'text/plain',size:buffer.length,sha256,url:'https://example.com/file',createdAt:Date.now()}})
    const first=await f.invoke({op:'download',downloadId:id,offset:0}) as {data:string;offset:number;done:boolean;sha256:string}
    const last=await f.invoke({op:'download',downloadId:id,offset:512*1024}) as typeof first
    expect(Buffer.from(first.data,'base64')).toHaveLength(512*1024);expect(first.done).toBe(false)
    expect(Buffer.from(last.data,'base64')).toHaveLength(7);expect(last.done).toBe(true);expect(last.sha256).toBe(sha256)
    expect(f.runtime.readDownload).toHaveBeenCalledTimes(1)
    await expect(f.invoke({op:'download',downloadId:id,offset:buffer.length+1})).rejects.toMatchObject({code:'browser_download_invalid'})
    f.check.mockRejectedValueOnce(new Error('download grant revoked'))
    await expect(f.invoke({op:'download',downloadId:id,offset:0})).rejects.toThrow('download grant revoked')
    await f.invoke({op:'close'});await f.invoke({op:'download',downloadId:id,offset:0})
    expect(f.runtime.readDownload).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid upload bytes and removes idle or unauthorized browser scopes',async()=>{
    vi.useFakeTimers();const f=fixture({enabled:true,idleTimeoutMs:60000})
    await expect(f.invoke({op:'execute',upload:{id:randomUUID(),name:'file',mimeType:'text/plain',data:'a'}})).rejects.toMatchObject({code:'browser_upload_limit'})
    expect(f.runtime.execute).not.toHaveBeenCalled()
    await f.invoke({op:'open'});await vi.advanceTimersByTimeAsync(61000);await f.browser.sweep()
    expect(f.runtime.revoke).toHaveBeenCalledWith(scope)
    f.runtime.revoke.mockClear();await f.invoke({op:'open'});f.check.mockRejectedValueOnce(new Error('owner disabled'));await f.browser.sweep()
    expect(f.runtime.revoke).toHaveBeenCalledWith(scope)
  })
  it('retains idle pages for thirty minutes without extending lifetime on preview polling',async()=>{
    vi.useFakeTimers();const f=fixture()
    await f.invoke({op:'open'});await f.invoke({op:'park'})
    expect(f.runtime.park).toHaveBeenCalledWith(scope,expect.objectContaining({authorize:expect.any(Function)}))
    await vi.advanceTimersByTimeAsync(10*60000)
    await f.invoke({op:'status'})
    await f.invoke({op:'execute',operation:{generation:2,operationId:'preview',action:{kind:'screenshot'}}})
    await f.browser.sweep();expect(f.runtime.revoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20*60000+1)
    await f.invoke({op:'status'});await f.browser.sweep()
    expect(f.runtime.revoke).toHaveBeenCalledExactlyOnceWith(scope)
  })
  it('refreshes idle time for real input but still revokes a parked scope when permission is removed',async()=>{
    vi.useFakeTimers();const f=fixture({enabled:true,idleTimeoutMs:60000})
    await f.invoke({op:'open'});await vi.advanceTimersByTimeAsync(55000)
    await f.invoke({op:'execute',operation:{generation:1,operationId:'type',action:{kind:'text',text:'active'}}})
    await vi.advanceTimersByTimeAsync(10000);await f.browser.sweep();expect(f.runtime.revoke).not.toHaveBeenCalled()
    await f.invoke({op:'park'});f.check.mockRejectedValueOnce(new Error('owner revoked'))
    await f.browser.sweep();expect(f.runtime.revoke).toHaveBeenCalledWith(scope)
  })
  it.each(['open','input'])('does not revoke a newly active record when %s arrives during an old idle sweep',async(action)=>{
    vi.useFakeTimers();const f=fixture({enabled:true,idleTimeoutMs:60000})
    await f.invoke({op:'open'});await vi.advanceTimersByTimeAsync(61000)
    let release!:()=>void,entered!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve}),checking=new Promise<void>(resolve=>{entered=resolve})
    f.check.mockImplementationOnce(async()=>{entered();await gate})
    const sweeping=f.browser.sweep()
    try{
      await checking
      await f.invoke(action==='open'?{op:'open'}:{op:'execute',operation:{generation:1,operationId:'renewed-input',action:{kind:'text',text:'still active'}}})
      release();await sweeping
      expect(f.runtime.revoke).not.toHaveBeenCalled()
      await f.browser.sweep();expect(f.runtime.revoke).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(61000);await f.browser.sweep()
      expect(f.runtime.revoke).toHaveBeenCalledExactlyOnceWith(scope)
    }finally{release();await sweeping}
  })
})

function installationFixture(){
  let complete!:()=>void,fail!:(error:Error)=>void,signal!:AbortSignal
  const install=vi.fn(async(options:Parameters<BrowserInstaller['install']>[0])=>{
    signal=options.signal
    await new Promise<void>((resolve,reject)=>{complete=resolve;fail=reject;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})
  })
  const installer={probe:vi.fn(async()=>false),install},f=fixture({enabled:true},installer)
  f.probe.mockResolvedValue(false)
  return {...f,installer,complete:()=>complete(),fail:(error:Error)=>fail(error),signal:()=>signal}
}

describe('managed browser installation transport',()=>{
  it('returns authorized setup state when missing and keeps close idempotent',async()=>{
    const f=installationFixture()
    await expect(f.invoke({op:'status'})).resolves.toMatchObject({open:false,available:false,installation:{status:'missing'}})
    await expect(f.invoke({op:'close'})).resolves.toMatchObject({open:false,tabs:[],downloads:[]})
    await expect(f.invoke({op:'open'})).rejects.toMatchObject({code:'browser_unavailable'})
    expect(f.installer.install).not.toHaveBeenCalled()
    f.check.mockRejectedValueOnce(new Error('foreign grant'))
    await expect(f.invoke({op:'prepare'})).rejects.toThrow('foreign grant')
    expect(f.installer.install).not.toHaveBeenCalled()
  })
  it('prepares with the real Runtime after a view grant ends without authorizing a browser session',async()=>{
    vi.useFakeTimers()
    const viewGrant=randomUUID(),prepareGrant=randomUUID(),grants=new Map<string,'view'|'prepare'>([[viewGrant,'view']])
    const check=vi.fn(async(_scope:BrowserScope,grant?:string)=>{
      if(grant?grants.has(grant):[...grants.values()].some(role=>role!=='prepare'))return
      throw new Error('browser session has no active grant')
    })
    let complete!:()=>void,signal!:AbortSignal
    const installer:BrowserInstaller={probe:async()=>false,install:async options=>{
      signal=options.signal
      await new Promise<void>((resolve,reject)=>{complete=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})
    }}
    // Use the production BrowserRuntime and its default scope-only authorization.
    const browser=new RunnerBrowser({enabled:true},'/unused-no-browser-session',check,{installer});scopes.push(browser)
    const readState=vi.spyOn(browser.runtime,'status')
    const invoke=(op:string,grant:string)=>browser.invoke({scope,profile:'default',grantId:grant,op},Date.now()+30000,()=>{})
    await expect(invoke('status',viewGrant)).resolves.toMatchObject({available:false,installation:{status:'missing'}})
    grants.delete(viewGrant);grants.set(prepareGrant,'prepare')
    await expect(invoke('prepare',prepareGrant)).resolves.toMatchObject({open:false,tabs:[],downloads:[],available:false,installation:{status:'installing'}})
    expect(readState).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2100);expect(signal.aborted).toBe(false)
    // Installing a binary never grants permission to use or retain a page.
    await expect(browser.runtime.status(scope)).rejects.toThrow('no active grant')
    await expect(browser.runtime.open(scope)).rejects.toThrow('no active grant')
    complete();await vi.advanceTimersByTimeAsync(20);expect(browser.available).toBe(true)
    readState.mockClear()
    // Another holder can finish setup between the server's view and prepare RPC.
    await expect(invoke('prepare',prepareGrant)).resolves.toMatchObject({open:false,tabs:[],available:true,installation:{status:'ready'}})
    expect(readState).not.toHaveBeenCalled()
    await expect(invoke('status',prepareGrant)).rejects.toThrow('no active grant')
    grants.set(viewGrant,'view')
    await expect(invoke('status',viewGrant)).resolves.toMatchObject({open:false,available:true,installation:{status:'ready'}})
    grants.delete(viewGrant)
    await expect(browser.runtime.status(scope)).rejects.toThrow('no active grant')
  })
  it('does not refresh the idle lease of an existing session when prepare finds it ready',async()=>{
    vi.useFakeTimers();const f=fixture({enabled:true,idleTimeoutMs:60000})
    await f.invoke({op:'open'});await vi.advanceTimersByTimeAsync(55000)
    await expect(f.invoke({op:'prepare'})).resolves.toMatchObject({open:false,available:true,installation:{status:'ready'}})
    expect(f.runtime.status).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000);await f.browser.sweep()
    expect(f.runtime.revoke).toHaveBeenCalledWith(scope)
  })
  it('returns checking immediately and queues one preparation behind a slow startup probe',async()=>{
    vi.useFakeTimers();const f=installationFixture();let finishProbe!:(value:boolean)=>void
    f.probe.mockImplementationOnce(()=>new Promise(resolve=>{finishProbe=resolve}))
    await expect(f.invoke({op:'status'},Date.now()+1000)).resolves.toMatchObject({available:false,installation:{status:'checking'}})
    await expect(f.invoke({op:'prepare'},Date.now()+1000)).resolves.toMatchObject({available:false,installation:{status:'checking'}})
    await f.invoke({op:'prepare'})
    await vi.advanceTimersByTimeAsync(31000)
    expect(f.installer.install).not.toHaveBeenCalled()
    await expect(f.invoke({op:'status'})).resolves.toMatchObject({installation:{status:'checking'}})
    finishProbe(false);await vi.advanceTimersByTimeAsync(20)
    expect(f.installer.install).toHaveBeenCalledTimes(1)
    expect(f.signal().aborted).toBe(false)
    f.complete();await vi.advanceTimersByTimeAsync(20);expect(f.browser.available).toBe(true)
  })
  it('does not install when a slow probe finds an existing browser or after disconnect',async()=>{
    const found=installationFixture();let finishFound!:(value:boolean)=>void
    found.probe.mockImplementationOnce(()=>new Promise(resolve=>{finishFound=resolve}))
    await expect(found.invoke({op:'prepare'})).resolves.toMatchObject({installation:{status:'checking'}})
    finishFound(true);await found.browser.ready
    await vi.waitFor(()=>expect(found.browser.available).toBe(true))
    expect(found.installer.install).not.toHaveBeenCalled()
    const disconnected=installationFixture();let finishDisconnected!:(value:boolean)=>void
    disconnected.probe.mockImplementationOnce(()=>new Promise(resolve=>{finishDisconnected=resolve}))
    await disconnected.invoke({op:'prepare'});await disconnected.browser.disconnect()
    expect(disconnected.browser.installation.status).toBe('failed')
    finishDisconnected(false);await disconnected.browser.ready
    expect(disconnected.browser.installation.status).toBe('failed')
    expect(disconnected.installer.install).not.toHaveBeenCalled()
  })
  it('cancels an open request that is still waiting for the startup check',async()=>{
    const f=installationFixture();let finishProbe!:(value:boolean)=>void
    f.probe.mockImplementationOnce(()=>new Promise(resolve=>{finishProbe=resolve}))
    const result=f.invoke({op:'open'}).catch(error=>error)
    await f.invoke({op:'status'});await f.browser.disconnect()
    expect(await result).toBeInstanceOf(Error)
    finishProbe(true);await f.browser.ready;expect(f.runtime.open).not.toHaveBeenCalled()
  })
  it('deduplicates preparation and retains the grant beyond an individual RPC deadline',async()=>{
    vi.useFakeTimers();const f=installationFixture()
    await expect(f.invoke({op:'prepare'},Date.now()+1000)).resolves.toMatchObject({available:false,installation:{status:'installing'}})
    await f.invoke({op:'prepare'})
    expect(f.installer.install).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(f.signal().aborted).toBe(false);expect(f.check).toHaveBeenLastCalledWith(scope,grantId)
    f.complete();await vi.advanceTimersByTimeAsync(20)
    await expect(f.invoke({op:'status'})).resolves.toMatchObject({available:true,installation:{status:'ready'}})
  })
  it('keeps other authorized holders when one grant is revoked',async()=>{
    vi.useFakeTimers();const f=installationFixture(),otherGrant=randomUUID()
    await f.invoke({op:'prepare'});await f.invoke({op:'prepare',grantId:otherGrant})
    f.check.mockImplementation(async(_scope,grant)=>{if(grant===grantId)throw new Error('revoked')})
    await vi.advanceTimersByTimeAsync(2100);expect(f.signal().aborted).toBe(false)
    f.complete();await vi.advanceTimersByTimeAsync(20)
    expect(f.browser.available).toBe(true)
  })
  it('cancels when all holders lose authorization and requires an explicit retry',async()=>{
    vi.useFakeTimers();const f=installationFixture();await f.invoke({op:'prepare'})
    f.check.mockRejectedValue(new Error('revoked'));await vi.advanceTimersByTimeAsync(2100)
    expect(f.signal().aborted).toBe(true);expect(f.browser.installation.status).toBe('failed')
    f.check.mockResolvedValue(undefined);await f.invoke({op:'prepare'})
    expect(f.installer.install).toHaveBeenCalledTimes(1)
    await f.invoke({op:'prepare',retry:true});expect(f.installer.install).toHaveBeenCalledTimes(2)
    f.complete();await vi.advanceTimersByTimeAsync(20);expect(f.browser.available).toBe(true)
  })
  it('closing one holder does not cancel another holder, while disconnect cancels the job',async()=>{
    const f=installationFixture(),otherGrant=randomUUID()
    await f.invoke({op:'prepare'});await f.invoke({op:'prepare',grantId:otherGrant});await f.invoke({op:'close'})
    expect(f.signal().aborted).toBe(false)
    await f.browser.disconnect();expect(f.signal().aborted).toBe(true);expect(f.browser.available).toBe(false)
    expect(f.browser.installation.status).toBe('failed')
  })
  it('does not start a late preparation after disconnect interrupts authorization',async()=>{
    const f=installationFixture();let authorize!:()=>void
    f.check.mockImplementationOnce(()=>new Promise(resolve=>{authorize=resolve}))
    const result=f.invoke({op:'prepare'}).catch(error=>error)
    await vi.waitFor(()=>expect(f.check).toHaveBeenCalled());await f.browser.disconnect()
    authorize();expect(await result).toBeInstanceOf(Error)
    expect(f.installer.install).not.toHaveBeenCalled()
  })
  it('sanitizes failure details and never runs installation while disabled',async()=>{
    const f=installationFixture();await f.invoke({op:'prepare'});await vi.waitFor(()=>expect(f.installer.install).toHaveBeenCalled());f.fail(new Error('token=secret /Users/personal'))
    await vi.waitFor(()=>expect(f.browser.installation.status).toBe('failed'))
    expect(JSON.stringify(f.browser.installation)).not.toMatch(/secret|personal/)
    const disabled=fixture({enabled:false},f.installer)
    await expect(disabled.invoke({op:'status'})).resolves.toMatchObject({enabled:false,available:false,installation:{status:'missing'}})
    await expect(disabled.invoke({op:'prepare'})).rejects.toMatchObject({code:'browser_unavailable'})
    expect(f.installer.install).toHaveBeenCalledTimes(1)
  })
})
