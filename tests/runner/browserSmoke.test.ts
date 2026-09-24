// @vitest-environment node
import {expect,it} from 'vitest'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {chromium,type BrowserContext,type Page} from 'playwright'
import {BrowserRuntime,type BrowserLauncher,type BrowserScope,type BrowserAction} from '../../src/runner/browser/runtime.js'

/** YAOYAO_BROWSER_SMOKE=1 npx vitest run tests/runner/browserSmoke.test.ts
 * Uses real Chromium and disk profiles, but page-level fixtures never contact a
 * website. Public proxy policy is exercised separately with real local sockets. */
it.skipIf(process.env.YAOYAO_BROWSER_SMOKE!=='1')('real Chromium: DOM refs, takeover, uploads/downloads and persistent login across runtime restart',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-browser-smoke-')))
  const scope:BrowserScope={ownerKey:'smoke-account',environmentId:'smoke-bot',profile:'persistent'}
  const contexts:BrowserContext[]=[],calls:string[]=[]
  const html=`<!doctype html><html><body>
    <label>Name <input id="name" aria-label="Name"></label>
    <button id="apply" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Apply</button>
    <button id="login" onclick="document.cookie='login=ok; Max-Age=86400; SameSite=Lax; path=/';document.querySelector('#result').textContent='logged in'">Login</button>
    <input id="file" type="file" aria-label="Upload" onchange="this.files[0].text().then(text=>document.querySelector('#uploaded').textContent=text)">
    <a href="/download">Download</a><output id="result"></output><output id="uploaded"></output>
    </body></html>`
  const prepare=async(page:Page)=>page.route('https://browser.fixture.test/**',async route=>{
    if(new URL(route.request().url()).pathname==='/download')await route.fulfill({status:200,headers:{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="report.txt"'},body:'controlled download'})
    else await route.fulfill({status:200,contentType:'text/html',body:html})
  })
  const launcher:BrowserLauncher={launchPersistentContext:async(directory,options)=>{
    const context=await chromium.launchPersistentContext(directory,options);contexts.push(context)
    for(const page of context.pages())await prepare(page)
    context.on('page',page=>void prepare(page))
    return context
  }}
  const create=()=>new BrowserRuntime({root,enabled:true,launcher,authorize:async()=>{calls.push('scope')},resolveUpload:async(_scope,fileId)=>{
    expect(fileId).toBe('attachment-id');return {name:'approved.txt',mimeType:'text/plain',buffer:Buffer.from('controlled upload')}
  }})
  let runtime=create(),generation=0,sequence=0
  const execute=(action:BrowserAction)=>runtime.execute(scope,{generation,operationId:'smoke-'+(++sequence),action},{authorize:async()=>{calls.push('actor')}})
  type Snapshot={snapshotId:string;elements:{ref:string;tag:string;type:string;text:string;label:string}[]}
  const snapshot=async()=>await execute({kind:'snapshot'}) as Snapshot
  try{
    generation=(await runtime.open(scope,{authorize:async()=>{calls.push('task')}})).generation
    await execute({kind:'navigate',url:'https://browser.fixture.test/'})
    const first=await snapshot();await execute({kind:'fill',snapshotId:first.snapshotId,ref:first.elements.find(e=>e.label==='Name')!.ref,text:'before takeover'})
    const second=await snapshot();await execute({kind:'click',snapshotId:second.snapshotId,ref:second.elements.find(e=>e.text==='Apply')!.ref})
    const page=contexts[0]!.pages()[0]!
    expect(await page.locator('#result').innerText()).toBe('before takeover')
    const before=contexts[0],oldGeneration=generation
    generation=(await runtime.pause(scope,{authorize:async()=>{calls.push('human')}})).generation
    expect(contexts[0]).toBe(before);expect(contexts).toHaveLength(1)
    await expect(runtime.execute(scope,{generation:oldGeneration,operationId:'stale',action:{kind:'text',text:'stale'}})).rejects.toMatchObject({code:'browser_generation_expired'})
    const login=await snapshot();await execute({kind:'click',snapshotId:login.snapshotId,ref:login.elements.find(e=>e.text==='Login')!.ref})
    expect((await contexts[0]!.cookies()).find(c=>c.name==='login')?.value).toBe('ok')
    const retained=(await runtime.status(scope)).tabs
    const parked=await runtime.park(scope,{authorize:async()=>{calls.push('retention')}})
    expect(parked.open).toBe(true);expect(parked.tabs).toEqual(retained)
    expect(await page.locator('#name').inputValue()).toBe('before takeover')
    expect(await page.locator('#result').innerText()).toBe('logged in')
    expect(contexts).toHaveLength(1)
    await expect(runtime.execute(scope,{generation:parked.generation,operationId:'idle-input',action:{kind:'text',text:'forbidden'}})).rejects.toMatchObject({code:'browser_parked'})
    generation=(await runtime.resume(scope,{authorize:async()=>{calls.push('task')}})).generation
    expect((await runtime.status(scope)).tabs).toEqual(retained)
    expect(await page.locator('#name').inputValue()).toBe('before takeover')
    const upload=await snapshot();await execute({kind:'upload',snapshotId:upload.snapshotId,ref:upload.elements.find(e=>e.type==='file')!.ref,fileId:'attachment-id'})
    await expect.poll(()=>page.locator('#uploaded').innerText()).toBe('controlled upload')
    const download=await snapshot();await execute({kind:'click',snapshotId:download.snapshotId,ref:download.elements.find(e=>e.text==='Download')!.ref})
    await expect.poll(async()=> (await runtime.status(scope)).downloads.length).toBe(1)
    const metadata=(await runtime.status(scope)).downloads[0]!,file=await runtime.readDownload(scope,metadata.id,{authorize:async()=>{calls.push('export')}})
    expect(file.buffer.toString()).toBe('controlled download');expect(file.name).toBe('report.txt')
    const frame=await execute({kind:'screenshot'}) as {data:string;mimeType:string}
    expect(frame.mimeType).toBe('image/png');expect(Buffer.from(frame.data,'base64').subarray(1,4).toString()).toBe('PNG')
    await runtime.shutdown();runtime=create()
    generation=(await runtime.open(scope)).generation
    await execute({kind:'navigate',url:'https://browser.fixture.test/'})
    expect((await contexts[1]!.cookies()).find(c=>c.name==='login')?.value).toBe('ok')
    expect((await runtime.status(scope)).downloads).toEqual([])
    expect(calls).toContain('actor');expect(calls).toContain('human');expect(calls).toContain('export')
  }finally{await runtime.shutdown();await rm(root,{recursive:true,force:true})}
},60000)
