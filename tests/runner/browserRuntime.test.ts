// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest'
import {EventEmitter} from 'node:events'
import {mkdir,mkdtemp,readFile,readdir,realpath,writeFile,stat,rm} from 'node:fs/promises'
import {hostname,tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import type {BrowserContext,Download,ElementHandle} from 'playwright'
import {BrowserRuntime,type BrowserScope,type BrowserLauncher,type BrowserOperation} from '../../src/runner/browser/runtime.js'

const scope:BrowserScope={ownerKey:'account-a',environmentId:'bot-a',profile:'persistent'}
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
class FakePage extends EventEmitter {
  closed=false;address='about:blank';visits:string[]=[];block?:Promise<void>;handles:ElementHandle<Element>[]=[]
  mouse={click:vi.fn(async()=>{}),wheel:vi.fn(async()=>{})}
  keyboard={press:vi.fn(async()=>{}),insertText:vi.fn(async()=>{})}
  url(){return this.address}isClosed(){return this.closed}async title(){return 'Page'}mainFrame(){return this}
  async goto(url:string){this.visits.push(url);if(this.block)await this.block;if(this.closed)throw new Error('Target closed');this.address=url;this.emit('framenavigated',this)}
  async goBack(){}async goForward(){}async reload(){}async bringToFront(){}
  async close(){if(!this.closed){this.closed=true;this.emit('close')}}
  async screenshot(){return Buffer.from('png')}
  async $$(){return this.handles}
  locator(){return {innerText:async()=> 'A page'}}
}
class FakeContext extends EventEmitter {
  tab=new FakePage();all=[this.tab];closed=false;routeCallback?:Function
  setDefaultTimeout(){}setDefaultNavigationTimeout(){}async clearPermissions(){}
  async route(_match:string,callback:Function){this.routeCallback=callback}
  async routeWebSocket(){}
  pages(){return this.all}async newPage(){const page=new FakePage();this.all.push(page);this.emit('page',page);return page}
  async close(){if(this.closed)return;this.closed=true;for(const page of this.all)await page.close();this.emit('close')}
}
function element(type='text'){
  return {evaluate:vi.fn(async(fn:Function)=>String(fn).includes('getComputedStyle')?{tag:'input',type,text:'',label:'',placeholder:'',disabled:false}:String(fn).includes('HTMLInputElement')?type==='file':true),dispose:vi.fn(async()=>{}),click:vi.fn(async()=>{}),fill:vi.fn(async()=>{}),setInputFiles:vi.fn(async()=>{})} as unknown as ElementHandle<Element>
}
const roots:string[]=[],runtimes:BrowserRuntime[]=[]
async function fixture(extra:Partial<ConstructorParameters<typeof BrowserRuntime>[0]>={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-browser-test-')));roots.push(root)
  const contexts:FakeContext[]=[],directories:string[]=[],options:unknown[]=[]
  const launcher:BrowserLauncher={launchPersistentContext:vi.fn(async(directory,settings)=>{directories.push(directory);options.push(settings);const context=new FakeContext();contexts.push(context);return context as unknown as BrowserContext})}
  const proxyAuthorize:(()=>Promise<void>)[]=[],proxyClose=vi.fn(async()=>{}),proxyDisconnect=vi.fn()
  const runtime=new BrowserRuntime({root,enabled:true,launcher,proxyFactory:async authorize=>{proxyAuthorize.push(authorize);return {serverURL:'http://127.0.0.1:12345',username:'test',password:'test',close:proxyClose,disconnect:proxyDisconnect}},...extra})
  runtimes.push(runtime);return {runtime,launcher,contexts,directories,options,root,proxyAuthorize,proxyClose,proxyDisconnect}
}
function op(generation:number,operationId:string,action:BrowserOperation['action']):BrowserOperation{return {generation,operationId,action}}
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.shutdown();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})

describe('Runner browser lifecycle and fencing',()=>{
  it('is disabled by default and does not start Chromium',async()=>{
    const f=await fixture({enabled:undefined})
    await expect(f.runtime.open(scope)).rejects.toMatchObject({code:'browser_disabled'})
    expect(f.launcher.launchPersistentContext).not.toHaveBeenCalled()
  })
  it('shares one writer per environment and retains only persistent profiles on close',async()=>{
    const f=await fixture()
    const [a,b]=await Promise.all([f.runtime.open(scope),f.runtime.open(scope)])
    expect(a.generation).toBe(b.generation);expect(f.contexts).toHaveLength(1)
    await writeFile(join(f.directories[0]!,'login'),'cookie-data')
    await expect(f.runtime.open({...scope,profile:'temporary'})).rejects.toMatchObject({code:'browser_profile_busy'})
    await f.runtime.close(scope)
    expect(await readFile(join(f.directories[0]!,'login'),'utf8')).toBe('cookie-data')
    await f.runtime.open(scope);expect(f.directories[1]).toBe(f.directories[0])
    const temporary={...scope,environmentId:'task-a',profile:'temporary' as const}
    await f.runtime.open(temporary);const temporaryDirectory=f.directories[2]!
    await f.runtime.close(temporary);await expect(stat(temporaryDirectory)).rejects.toMatchObject({code:'ENOENT'})
    expect(f.options[0]).toMatchObject({chromiumSandbox:true,serviceWorkers:'block',proxy:{bypass:'<-loopback>'}})
  })
  it('locks the same persistent profile across runtime instances',async()=>{
    const a=await fixture();await a.runtime.open(scope)
    const b=await fixture({root:a.root})
    await expect(b.runtime.open(scope)).rejects.toMatchObject({code:'browser_profile_busy'})
    await a.runtime.close(scope);await b.runtime.open(scope)
    expect(b.contexts).toHaveLength(1)
  })
  it('rejects a delayed old network authorization even after the parked page is resumed',async()=>{
    const f=await fixture(),entered=deferred(),gate=deferred();let delay=false
    await f.runtime.open(scope,{authorize:async()=>{if(delay){entered.resolve();await gate.promise}}})
    delay=true
    const pending=f.proxyAuthorize[0]!().catch(error=>error)
    await entered.promise
    await f.runtime.park(scope,{authorize:async()=>{}})
    await f.runtime.resume(scope,{authorize:async()=>{}})
    gate.resolve()
    expect(await pending).toMatchObject({code:'browser_generation_expired'})
    await expect(f.proxyAuthorize[0]!()).resolves.toBeUndefined()
    expect(f.contexts[0]!.closed).toBe(false)
  })
  it('keeps same-generation network checks valid across consecutive operations and fences handoff connections',async()=>{
    const f=await fixture(),entered=deferred(),gate=deferred();let delay=false
    const state=await f.runtime.open(scope,{authorize:async()=>{if(delay){entered.resolve();await gate.promise}}})
    delay=true
    const pending=f.proxyAuthorize[0]!()
    await entered.promise
    await f.runtime.execute(scope,op(state.generation,'same-controller',{kind:'text',text:'next'}),{authorize:async()=>{}})
    gate.resolve();await expect(pending).resolves.toBeUndefined()
    expect(f.proxyDisconnect).not.toHaveBeenCalled()
    await f.runtime.pause(scope,{authorize:async()=>{}})
    expect(f.proxyDisconnect).toHaveBeenCalledOnce()
    expect(f.contexts[0]!.closed).toBe(false)
  })
  it('parks the same Bot page while fencing old actions and blocking network until new control',async()=>{
    const f=await fixture(),task={authorize:vi.fn(async()=>{})},human={authorize:vi.fn(async()=>{})}
    const first=await f.runtime.open(scope,task)
    await f.runtime.execute(scope,op(first.generation,'page',{kind:'navigate',url:'https://example.com/form'}),task)
    const page=f.contexts[0]!.tab,handle=element();page.handles=[handle]
    await f.runtime.execute(scope,op(first.generation,'refs',{kind:'snapshot'}),task)
    const other={...scope,environmentId:'bot-b'}
    await f.runtime.open(other,human)
    const parked=await f.runtime.park(scope,{authorize:async()=>{}})
    task.authorize.mockRejectedValue(new Error('old task revoked'))
    expect(parked).toMatchObject({open:true,tabs:[{url:'https://example.com/form'}]})
    expect(f.contexts[0]!.tab).toBe(page);expect(f.contexts[0]!.closed).toBe(false)
    expect(handle.dispose).toHaveBeenCalled();expect(f.proxyDisconnect).toHaveBeenCalledOnce()
    await expect(f.proxyAuthorize[0]!()).rejects.toMatchObject({code:'browser_parked'})
    await expect(f.proxyAuthorize[1]!()).resolves.toBeUndefined()
    await expect(f.runtime.execute(scope,op(first.generation,'late',{kind:'text',text:'old'}))).rejects.toMatchObject({code:'browser_generation_expired'})
    await expect(f.runtime.execute(scope,op(parked.generation,'idle-mutation',{kind:'text',text:'idle'}))).rejects.toMatchObject({code:'browser_parked'})
    await expect(f.runtime.execute(scope,op(parked.generation,'preview',{kind:'screenshot'}))).resolves.toMatchObject({mimeType:'image/png'})
    const next=await f.runtime.resume(scope,human)
    await expect(f.proxyAuthorize[0]!()).resolves.toBeUndefined()
    await f.runtime.execute(scope,op(next.generation,'fresh',{kind:'text',text:'new'}),human)
    expect(page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith('new')
    expect(f.contexts).toHaveLength(2);expect(next.tabs).toEqual(parked.tabs)
    await expect(f.runtime.execute(scope,op(next.generation,'expired-grant',{kind:'text',text:'old'}),task)).rejects.toThrow('old task revoked')
  })
  it('also locks a temporary environment across runtime instances',async()=>{
    const temporary={...scope,profile:'temporary' as const},a=await fixture();await a.runtime.open(temporary)
    const b=await fixture({root:a.root})
    await expect(b.runtime.open(temporary)).rejects.toMatchObject({code:'browser_profile_busy'})
    await a.runtime.close(temporary);await b.runtime.open(temporary)
    expect(b.contexts).toHaveLength(1)
  })
  it('recovers a same-host dead-process lock but refuses unknown locks',async()=>{
    const f=await fixture();await f.runtime.open(scope)
    const name=(await readdir(join(f.root,'locks')))[0]!,lock=join(f.root,'locks',name)
    await f.runtime.close(scope);await mkdir(lock)
    await expect(f.runtime.open(scope)).rejects.toMatchObject({code:'browser_profile_busy'})
    await writeFile(join(lock,'owner.json'),JSON.stringify({pid:2147483647,host:hostname()}))
    await f.runtime.open(scope);expect(f.contexts).toHaveLength(2)
  })
  it('separates owners and caps concurrent contexts',async()=>{
    const f=await fixture({maxSessions:2});await f.runtime.open(scope)
    await f.runtime.open({...scope,ownerKey:'account-b'})
    expect(f.directories[0]).not.toBe(f.directories[1])
    await f.runtime.park(scope)
    await expect(f.runtime.open({...scope,environmentId:'another'})).rejects.toMatchObject({code:'browser_capacity'})
    expect((await f.runtime.status(scope)).open).toBe(true)
    await f.runtime.close(scope);await f.runtime.open({...scope,environmentId:'another'})
    expect(f.contexts[1]!.closed).toBe(false)
  })
  it('deduplicates successful and uncertain operations, rejecting ID conflicts',async()=>{
    const f=await fixture(),state=await f.runtime.open(scope)
    const command=op(state.generation,'go-once',{kind:'navigate',url:'https://example.com/'})
    await Promise.all([f.runtime.execute(scope,command),f.runtime.execute(scope,command)])
    expect(f.contexts[0]!.tab.visits).toEqual(['https://example.com/'])
    await expect(f.runtime.execute(scope,{...command,action:{kind:'navigate',url:'https://other.example/'}})).rejects.toMatchObject({code:'browser_operation_conflict'})
  })
  it('does not exhaust the mutation journal during long-running screenshot polling',async()=>{
    const f=await fixture(),state=await f.runtime.open(scope)
    for(let index=0;index<1100;index++)await f.runtime.execute(scope,op(state.generation,'frame-'+index,{kind:'screenshot'}))
    await f.runtime.execute(scope,op(state.generation,'action-after-polling',{kind:'text',text:'still active'}))
    expect(f.contexts[0]!.tab.keyboard.insertText).toHaveBeenCalledWith('still active')
  })
  it('drains old actions before takeover without closing the login context',async()=>{
    const f=await fixture(),state=await f.runtime.open(scope),gate=deferred()
    f.contexts[0]!.tab.block=gate.promise
    const running=f.runtime.execute(scope,op(state.generation,'old',{kind:'navigate',url:'https://example.com/'})).catch(error=>error)
    await vi.waitFor(()=>expect(f.contexts[0]!.tab.visits).toHaveLength(1))
    const queued=f.runtime.execute(scope,op(state.generation,'queued',{kind:'text',text:'must not type'})).catch(error=>error)
    let paused=false;const takeover=f.runtime.pause(scope).then(value=>{paused=true;return value})
    await new Promise(resolve=>setTimeout(resolve,10));expect(paused).toBe(false)
    gate.resolve();const next=await takeover
    expect(await running).toMatchObject({code:'browser_generation_expired'})
    expect(await queued).toMatchObject({code:'browser_generation_expired'})
    expect(f.contexts[0]!.tab.keyboard.insertText).not.toHaveBeenCalled();expect(f.contexts[0]!.closed).toBe(false)
    expect(next.generation).toBeGreaterThan(state.generation)
    await f.runtime.execute(scope,op(next.generation,'human',{kind:'text',text:'login'}))
    expect(f.contexts[0]!.tab.keyboard.insertText).toHaveBeenCalledWith('login')
  })
  it('rechecks each caller authorization after queueing and does not replace network authority with a viewer',async()=>{
    const f=await fixture(),task=vi.fn(async()=>{}),viewer=vi.fn(async()=>{throw new Error('viewer expired')})
    const state=await f.runtime.open(scope,{authorize:task})
    await f.runtime.execute(scope,op(state.generation,'observe',{kind:'screenshot'}),{authorize:async()=>{}})
    await f.proxyAuthorize[0]!();expect(task).toHaveBeenCalled()
    await expect(f.runtime.execute(scope,op(state.generation,'forbidden',{kind:'text',text:'x'}),{authorize:viewer})).rejects.toThrow('viewer expired')
    expect(f.contexts[0]!.tab.keyboard.insertText).not.toHaveBeenCalled()
  })
  it('fences a launch that finishes after revocation and releases its lock afterward',async()=>{
    const ready=deferred(),finish=deferred<BrowserContext>(),context=new FakeContext()
    const launcher:BrowserLauncher={launchPersistentContext:async()=>{ready.resolve();return finish.promise}}
    const f=await fixture({launcher}),opening=f.runtime.open(scope).catch(error=>error)
    await ready.promise;const closing=f.runtime.revoke(scope)
    finish.resolve(context as unknown as BrowserContext)
    expect(await opening).toMatchObject({code:'browser_generation_expired'});expect((await closing).open).toBe(false);expect(context.closed).toBe(true)
  })
})

describe('Runner browser interactions and files',()=>{
  it('requires fresh element refs and accepts only resolved upload bytes',async()=>{
    const resolveUpload=vi.fn(async()=>({name:'../../report.txt',mimeType:'text/plain',buffer:Buffer.from('approved')}))
    const f=await fixture({resolveUpload}),state=await f.runtime.open(scope),handle=element('file');f.contexts[0]!.tab.handles=[handle]
    const snapshot=await f.runtime.execute(scope,op(state.generation,'snapshot',{kind:'snapshot'})) as {snapshotId:string}
    await expect(f.runtime.execute(scope,op(state.generation,'bad-fill',{kind:'fill',snapshotId:snapshot.snapshotId,ref:'e1',text:'/etc/passwd'}))).rejects.toMatchObject({code:'browser_upload_required'})
    await f.runtime.execute(scope,op(state.generation,'upload',{kind:'upload',snapshotId:snapshot.snapshotId,ref:'e1',fileId:'approved-id'}))
    expect(resolveUpload).toHaveBeenCalledWith(scope,'approved-id')
    expect(handle.setInputFiles).toHaveBeenCalledWith({name:'report.txt',mimeType:'text/plain',buffer:Buffer.from('approved')})
    await expect(f.runtime.execute(scope,op(state.generation,'stale',{kind:'click',snapshotId:snapshot.snapshotId,ref:'e1'}))).rejects.toMatchObject({code:'browser_snapshot_expired'})
    await expect(f.runtime.execute(scope,{generation:state.generation,operationId:'path-upload',action:{kind:'upload',snapshotId:snapshot.snapshotId,ref:'e1',fileId:'approved-id',path:'/etc/passwd'}} as BrowserOperation)).rejects.toThrow()
  })
  it('stores downloads by opaque ID and checks bytes and limits before exposing metadata',async()=>{
    const f=await fixture({maxDownloadBytes:10}),state=await f.runtime.open(scope)
    const download=(data:string)=>({createReadStream:async()=>Readable.from([Buffer.from(data)]),suggestedFilename:()=> '../../file.txt',url:()=> 'https://example.com/file',cancel:vi.fn(async()=>{}),delete:vi.fn(async()=>{})})
    const good=download('hello');f.contexts[0]!.tab.emit('download',good as unknown as Download)
    let metadata:{id:string;name:string;size:number}[]=[]
    await vi.waitFor(async()=>{metadata=(await f.runtime.status(scope)).downloads;expect(metadata).toHaveLength(1)})
    const file=await f.runtime.readDownload(scope,metadata[0]!.id)
    expect(file.name).toBe('file.txt');expect(file.buffer.toString()).toBe('hello');expect(file.metadata.sha256).toHaveLength(64)
    await expect(f.runtime.readDownload(scope,'../../etc/passwd')).rejects.toMatchObject({code:'browser_download_missing'})
    const oversized=download('much too large');f.contexts[0]!.tab.emit('download',oversized as unknown as Download)
    await vi.waitFor(()=>expect(oversized.cancel).toHaveBeenCalled())
    expect((await f.runtime.status(scope)).downloads).toHaveLength(1)
    await f.runtime.close(scope);await expect(f.runtime.readDownload(scope,metadata[0]!.id)).rejects.toMatchObject({code:'browser_download_missing'})
  })
  it('blocks unsupported URL schemes and raw browser protocols',async()=>{
    const f=await fixture(),state=await f.runtime.open(scope)
    await expect(f.runtime.execute(scope,op(state.generation,'file',{kind:'navigate',url:'file:///etc/passwd'}))).rejects.toThrow('HTTP(S)')
    await expect(f.runtime.execute(scope,op(state.generation,'port',{kind:'navigate',url:'http://example.com:9222/json'}))).rejects.toThrow('HTTP(S)')
    const abort=vi.fn(async()=>{}),proceed=vi.fn(async()=>{})
    await f.contexts[0]!.routeCallback!({request:()=>({url:()=> 'ftp://example.com/'}),abort,continue:proceed})
    expect(abort).toHaveBeenCalled();expect(proceed).not.toHaveBeenCalled()
  })
})
