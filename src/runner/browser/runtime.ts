import {createHash,randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,open,readFile,writeFile,rm,lstat,realpath} from 'node:fs/promises'
import {basename,join,resolve} from 'node:path'
import {hostname} from 'node:os'
import {lookup} from 'mime-types'
import {z} from 'zod'
import type {BrowserContext,Download,ElementHandle,Page} from 'playwright'
import {BrowserPublicProxy,publicBrowserURL} from './publicProxy.js'
import {BrowserRuntimeError,type BrowserAction,type BrowserCallContext,type BrowserDownload,type BrowserLauncher,type BrowserOperation,type BrowserScope,type BrowserState,type BrowserUpload} from './types.js'
export * from './types.js'

const identifier=z.string().min(1).max(256)
const scopeSchema=z.object({ownerKey:identifier,environmentId:identifier,profile:z.enum(['persistent','temporary'])}).strict()
const refFields={snapshotId:z.string().uuid(),ref:z.string().regex(/^e[0-9]+$/)}
const actionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.enum(['state','downloads','snapshot','screenshot','back','forward','reload'])}).strict(),
  z.object({kind:z.enum(['navigate','new-tab']),url:z.string().max(8192)}).strict(),
  z.object({kind:z.enum(['select-tab','close-tab']),tabId:z.string().uuid()}).strict(),
  z.object({kind:z.literal('click'),...refFields}).strict(),
  z.object({kind:z.literal('fill'),...refFields,text:z.string().max(100000)}).strict(),
  z.object({kind:z.literal('upload'),...refFields,fileId:identifier}).strict(),
  z.object({kind:z.literal('coordinate'),x:z.number().finite().min(0).max(1279),y:z.number().finite().min(0).max(799),button:z.enum(['left','right','middle']).optional(),clickCount:z.union([z.literal(1),z.literal(2)]).optional()}).strict(),
  z.object({kind:z.literal('key'),key:z.string().regex(/^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/)}).strict(),
  z.object({kind:z.literal('text'),text:z.string().max(100000)}).strict(),
  z.object({kind:z.literal('scroll'),deltaX:z.number().finite().min(-5000).max(5000).optional(),deltaY:z.number().finite().min(-5000).max(5000)}).strict(),
])
const fail=(code:string,message:string):never=>{throw new BrowserRuntimeError(code,message)}
interface Entry {
  scope:BrowserScope;generation:number;tail:Promise<unknown>;context?:BrowserContext;proxy?:BrowserPublicProxy
  pages:Map<string,Page>;active:string;profileDirectory?:string;profileLock?:string;downloadDirectory?:string
  operations:Map<string,{fingerprint:string;result:Promise<unknown>;readOnly:boolean}>
  snapshot?:{id:string;page:Page;refs:Map<string,ElementHandle<Element>>}
  downloads:Map<string,BrowserDownload>;pendingDownloads:Set<Promise<void>>;downloadErrors:string[]
  networkContext?:BrowserCallContext;opening?:Promise<void>;parked?:boolean
}
export interface BrowserRuntimeOptions {
  root:string;enabled?:boolean;launcher?:BrowserLauncher;authorize?:(scope:BrowserScope)=>void|Promise<void>
  resolveUpload?:(scope:BrowserScope,fileId:string)=>Promise<BrowserUpload>
  maxSessions?:number;maxTabs?:number;maxDownloadBytes?:number;maxDownloads?:number;operationTimeoutMs?:number
  /** Injectable transport for tests or a separately isolated deployment. */
  proxyFactory?:(authorize:()=>Promise<void>)=>Promise<Pick<BrowserPublicProxy,'serverURL'|'username'|'password'|'close'|'disconnect'>>
}

/** Runner-owned contexts. All stateful actions for an authorized environment use
 * one queue and one profile writer. Callers own RPC authentication and human/agent
 * leases; generation fences protect against revoked or late tool requests. */
export class BrowserRuntime {
  private entries=new Map<string,Entry>()
  private enabled:boolean
  constructor(readonly options:BrowserRuntimeOptions){this.enabled=options.enabled===true}
  private entry(scope:BrowserScope):Entry {
    scope=scopeSchema.parse(scope)
    const key=createHash('sha256').update(JSON.stringify([scope.ownerKey,scope.environmentId])).digest('hex')
    let entry=this.entries.get(key)
    if(!entry){
      if(this.entries.size>=1000)fail('browser_capacity','浏览器环境记录已达上限')
      entry={scope,generation:1,tail:Promise.resolve(),pages:new Map(),active:'',operations:new Map(),downloads:new Map(),pendingDownloads:new Set(),downloadErrors:[]}
      this.entries.set(key,entry)
    }
    return entry
  }
  private key(entry:Entry){return createHash('sha256').update(JSON.stringify([entry.scope.ownerKey,entry.scope.environmentId])).digest('hex')}
  private async check(entry:Entry,generation?:number,context?:BrowserCallContext){
    if(!this.enabled)fail('browser_disabled','独立浏览器未启用')
    context?.signal?.throwIfAborted()
    await this.options.authorize?.(entry.scope);await context?.authorize()
    context?.signal?.throwIfAborted()
    if(generation!==undefined&&entry.generation!==generation)fail('browser_generation_expired','浏览器控制权已改变，请重新读取状态')
  }
  private queue<T>(entry:Entry,run:()=>Promise<T>):Promise<T>{
    const task=entry.tail.catch(()=>{}).then(run);entry.tail=task.catch(()=>{});return task
  }
  private invalidate(entry:Entry){const snapshot=entry.snapshot;entry.snapshot=undefined;if(snapshot)for(const ref of snapshot.refs.values())void ref.dispose().catch(()=>{})}
  private async state(entry:Entry):Promise<BrowserState>{
    const tabs=await Promise.all([...entry.pages].filter(([,page])=>!page.isClosed()).map(async([id,page])=>({id,url:page.url(),title:await page.title().catch(()=>''),active:entry.active===id})))
    return {open:!!entry.context,generation:entry.generation,profile:entry.scope.profile,tabs,downloads:[...entry.downloads.values()]}
  }
  async status(scope:BrowserScope,context?:BrowserCallContext){const entry=this.entry(scope);await this.check(entry,undefined,context);return this.queue(entry,async()=>{await this.check(entry,undefined,context);return this.state(entry)})}
  async open(scope:BrowserScope,context?:BrowserCallContext):Promise<BrowserState>{
    const entry=this.entry(scope),generation=entry.generation
    await this.check(entry,generation,context)
    return this.queue(entry,async()=>{
      await this.check(entry,generation,context)
      if(entry.context){if(entry.scope.profile!==scope.profile)fail('browser_profile_busy','请先关闭浏览器再切换资料模式');entry.parked=false;entry.networkContext=context;return this.state(entry)}
      entry.scope={...scope};entry.parked=false;entry.networkContext=context
      if([...this.entries.values()].filter(e=>e.context||e.opening).length>=(this.options.maxSessions??3))fail('browser_capacity','运行中的浏览器数量已达上限，请先关闭一个闲置 Bot 的浏览器')
      entry.opening=this.launch(entry,generation,context)
      try{await entry.opening;return await this.state(entry)}finally{entry.opening=undefined}
    })
  }
  private async directory(path:string){
    await mkdir(path,{recursive:true,mode:0o700})
    const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())fail('browser_storage_invalid','浏览器存储目录无效')
    if(await realpath(path)!==resolve(path))fail('browser_storage_invalid','浏览器存储不能经过符号链接')
  }
  private async acquireLock(path:string){
    const busy=()=>fail('browser_profile_busy','浏览器资料已被另一个进程使用，或遗留锁无法确认已失效')
    try{await mkdir(path,{mode:0o700})}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
      // Recover only a known, same-machine dead writer. An unknown/corrupt lock
      // or a live/reused PID is never taken over. The recovery marker prevents
      // competing processes from deleting a newly acquired lock.
      let owner:{pid:number;host:string}
      try{owner=JSON.parse(await readFile(join(path,'owner.json'),'utf8'))}catch{return busy()}
      if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||owner.host!==hostname())return busy()
      try{process.kill(owner.pid,0);return busy()}catch(check){if((check as NodeJS.ErrnoException).code!=='ESRCH')return busy()}
      let recovery
      try{recovery=await open(join(path,'recovering'),'wx',0o600)}catch{return busy()}
      await recovery.close()
      let current:{pid:number;host:string}|undefined
      try{current=JSON.parse(await readFile(join(path,'owner.json'),'utf8'))}catch{ /* A competing recovery may just have created a new lock. */ }
      if(current?.pid!==owner.pid||current?.host!==owner.host){await rm(join(path,'recovering'),{force:true});return busy()}
      await rm(path,{recursive:true,force:true})
      try{await mkdir(path,{mode:0o700})}catch{return busy()}
    }
    try{await writeFile(join(path,'owner.json'),JSON.stringify({pid:process.pid,host:hostname()}),{mode:0o600,flag:'wx'})}
    catch(error){await rm(path,{recursive:true,force:true});throw error}
  }
  private async launch(entry:Entry,generation:number,context?:BrowserCallContext){
    const root=resolve(this.options.root),profiles=join(root,'profiles'),temporary=join(root,'temporary'),locks=join(root,'locks')
    await this.directory(root);await this.directory(profiles);await this.directory(temporary);await this.directory(locks)
    // The lock belongs to the environment, including temporary profiles. Random
    // temporary directories must not allow two Runners to bypass single-writer.
    const lock=join(locks,this.key(entry))
    await this.acquireLock(lock)
    entry.profileLock=lock
    try{
      const profile=entry.scope.profile==='persistent'?join(profiles,this.key(entry)):await mkdtemp(join(temporary,this.key(entry)+'-'))
      entry.profileDirectory=profile;await this.directory(profile)
      const downloads=join(root,'downloads',this.key(entry));await this.directory(downloads);entry.downloadDirectory=downloads
      const authorize=async()=>{
        const generation=entry.generation,networkContext=entry.networkContext
        if(entry.parked)fail('browser_parked','浏览器已暂停网络活动，请重新接管或开始新任务')
        await this.check(entry,generation,networkContext)
        if(entry.parked)fail('browser_generation_expired','浏览器网络授权已改变')
      }
      entry.proxy=await (this.options.proxyFactory??BrowserPublicProxy.start)(authorize) as BrowserPublicProxy
      const launcher=this.options.launcher??(await import('playwright')).chromium
      const browser=await launcher.launchPersistentContext(profile,{
        headless:true,chromiumSandbox:true,acceptDownloads:true,viewport:{width:1280,height:800},serviceWorkers:'block',
        proxy:{server:entry.proxy.serverURL,username:entry.proxy.username,password:entry.proxy.password,bypass:'<-loopback>'},
        args:['--disable-quic','--disable-background-networking','--disable-extensions','--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        timeout:this.options.operationTimeoutMs??20000,
      })
      entry.context=browser
      await this.check(entry,generation,context)
      browser.setDefaultTimeout(this.options.operationTimeoutMs??20000)
      browser.setDefaultNavigationTimeout(this.options.operationTimeoutMs??20000)
      await browser.clearPermissions()
      await browser.route('**/*',async route=>{
        try{await authorize();publicBrowserURL(route.request().url());await route.continue()}catch{await route.abort('blockedbyclient').catch(()=>{})}
      })
      await browser.routeWebSocket('**/*',socket=>socket.close())
      browser.on('page',page=>this.attach(entry,page))
      browser.on('close',()=>{if(entry.context===browser){entry.context=undefined;entry.generation++;entry.pages.clear();this.invalidate(entry);void entry.proxy?.close();void this.queue(entry,()=>this.destroy(entry)).catch(()=>{})}})
      for(const page of browser.pages())this.attach(entry,page)
      if(!entry.pages.size)this.attach(entry,await browser.newPage())
      await this.check(entry,generation,context)
    }catch(error){await this.destroy(entry);throw error}
  }
  private attach(entry:Entry,page:Page){
    if([...entry.pages.values()].includes(page))return
    if(entry.pages.size>=(this.options.maxTabs??12)){void page.close().catch(()=>{});return}
    const id=randomUUID();entry.pages.set(id,page);if(!entry.active)entry.active=id
    page.on('dialog',dialog=>void dialog.dismiss().catch(()=>{}))
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())this.invalidate(entry)})
    page.on('close',()=>{entry.pages.delete(id);if(entry.active===id)entry.active=entry.pages.keys().next().value??'';this.invalidate(entry)})
    page.on('download',download=>{
      const generation=entry.generation,call=entry.networkContext
      const task=this.saveDownload(entry,download,generation,call).catch(error=>{entry.downloadErrors.push(error instanceof Error?error.message:'下载失败');entry.downloadErrors=entry.downloadErrors.slice(-10)})
      entry.pendingDownloads.add(task);void task.finally(()=>entry.pendingDownloads.delete(task))
    })
  }
  async execute(scope:BrowserScope,operation:BrowserOperation,context?:BrowserCallContext):Promise<unknown>{
    const entry=this.entry(scope)
    const input=z.object({generation:z.number().int().positive(),operationId:identifier,action:actionSchema}).strict().parse(operation)
    await this.check(entry,input.generation,context)
    const fingerprint=JSON.stringify(input),known=entry.operations.get(input.operationId)
    if(known){if(known.fingerprint!==fingerprint)fail('browser_operation_conflict','操作编号已用于不同请求');return known.result}
    const readOnly=['state','downloads','screenshot','snapshot'].includes(input.action.kind)
    // Viewer polling must not retain hundreds of PNGs or exhaust the mutation
    // journal. Old observations may be recomputed; mutations are never evicted.
    if(readOnly){const observations=[...entry.operations].filter(([,value])=>value.readOnly);if(observations.length>=32)entry.operations.delete(observations[0]![0])}
    if(entry.operations.size>=1024)fail('browser_operation_limit','本代浏览器操作过多，请重新获取控制权')
    const result=this.queue(entry,async()=>{
      await this.check(entry,input.generation,context)
      if(!entry.context)fail('browser_closed','请先打开浏览器')
      if(entry.scope.profile!==scope.profile)fail('browser_profile_busy','浏览器资料模式不匹配')
      if(!readOnly&&entry.parked)fail('browser_parked','请先重新取得浏览器操作权')
      if(!readOnly)entry.networkContext=context
      const abort=()=>{void this.revoke(scope).catch(()=>{})}
      context?.signal?.addEventListener('abort',abort,{once:true})
      try{await this.check(entry,input.generation,context);const value=await this.action(entry,input.action,context);await this.check(entry,input.generation,context);return value}
      finally{context?.signal?.removeEventListener('abort',abort)}
    })
    entry.operations.set(input.operationId,{fingerprint,result,readOnly});return result
  }
  private page(entry:Entry){const page=entry.pages.get(entry.active);if(!page||page.isClosed())fail('browser_tab_missing','当前标签页已关闭');return page!}
  private async reference(entry:Entry,snapshotId:string,ref:string){
    const snapshot=entry.snapshot,handle=snapshot?.refs.get(ref)
    if(!snapshot||snapshot.id!==snapshotId||snapshot.page!==this.page(entry)||!handle)fail('browser_snapshot_expired','页面已改变，请重新读取快照')
    if(!await handle!.evaluate(element=>{const r=element.getBoundingClientRect();return element.isConnected&&r.width>0&&r.height>0}).catch(()=>false))fail('browser_snapshot_expired','页面元素已改变，请重新读取快照')
    return handle!
  }
  private async action(entry:Entry,action:BrowserAction,context?:BrowserCallContext):Promise<unknown>{
    if(action.kind==='state')return this.state(entry)
    if(action.kind==='downloads')return {downloads:[...entry.downloads.values()],pending:entry.pendingDownloads.size,errors:[...entry.downloadErrors]}
    if(action.kind==='new-tab'){
      publicBrowserURL(action.url);if(entry.pages.size>=(this.options.maxTabs??12))fail('browser_tab_limit','标签页数量已达上限')
      const page=await entry.context!.newPage();this.attach(entry,page);entry.active=[...entry.pages].find(([,value])=>value===page)![0]
      await page.goto(action.url,{waitUntil:'domcontentloaded'});return this.state(entry)
    }
    if(action.kind==='select-tab'||action.kind==='close-tab'){
      const page=entry.pages.get(action.tabId);if(!page)fail('browser_tab_missing','标签页不存在')
      this.invalidate(entry)
      if(action.kind==='select-tab'){entry.active=action.tabId;await page!.bringToFront()}
      else{await page!.close();if(!entry.pages.size)this.attach(entry,await entry.context!.newPage())}
      return this.state(entry)
    }
    const page=this.page(entry)
    if(action.kind==='snapshot'){
      this.invalidate(entry);const id=randomUUID(),refs=new Map<string,ElementHandle<Element>>(),elements=[]
      const handles=await page.$$('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')
      await Promise.all(handles.slice(500).map(handle=>handle.dispose()))
      for(const handle of handles.slice(0,500)){
        const metadata=await handle.evaluate(element=>{const r=element.getBoundingClientRect(),style=getComputedStyle(element);if(!element.isConnected||r.width<=0||r.height<=0||style.visibility==='hidden'||style.display==='none')return null;return {tag:element.tagName.toLowerCase(),text:(element.textContent??'').trim().slice(0,200),label:element.getAttribute('aria-label')??'',type:element.getAttribute('type')??'',placeholder:element.getAttribute('placeholder')??'',disabled:element.hasAttribute('disabled')}}).catch(()=>null)
        if(!metadata){await handle.dispose();continue}
        const ref='e'+(refs.size+1);refs.set(ref,handle);elements.push({ref,...metadata})
      }
      entry.snapshot={id,page,refs}
      return {snapshotId:id,generation:entry.generation,url:page.url(),title:await page.title(),text:(await page.locator('body').innerText().catch(()=>'')).slice(0,30000),elements}
    }
    if(action.kind==='screenshot')return {generation:entry.generation,frameId:randomUUID(),createdAt:Date.now(),mimeType:'image/png',width:1280,height:800,data:(await page.screenshot({type:'png'})).toString('base64')}
    if(action.kind==='click'||action.kind==='fill'||action.kind==='upload'){
      const handle=await this.reference(entry,action.snapshotId,action.ref)
      if(action.kind==='click'){await handle.click()}
      if(action.kind==='fill'){
        if(await handle.evaluate(element=>element instanceof HTMLInputElement&&element.type==='file'))fail('browser_upload_required','文件上传必须使用授权文件编号')
        await handle.fill(action.text)
      }
      if(action.kind==='upload'){
        if(!this.options.resolveUpload)fail('browser_upload_unavailable','未配置授权文件上传')
        const file=await this.options.resolveUpload!(entry.scope,action.fileId)
        await this.check(entry,undefined,context)
        if(!Buffer.isBuffer(file.buffer)||file.buffer.length>(this.options.maxDownloadBytes??25*1024*1024))fail('browser_file_limit','上传文件过大')
        await handle.setInputFiles({name:this.safeName(file.name),mimeType:file.mimeType,buffer:file.buffer})
      }
      this.invalidate(entry);return {ok:true,generation:entry.generation,url:page.url()}
    }
    this.invalidate(entry)
    switch(action.kind){
      case 'navigate':publicBrowserURL(action.url);await page.goto(action.url,{waitUntil:'domcontentloaded'});break
      case 'back':await page.goBack({waitUntil:'domcontentloaded'});break
      case 'forward':await page.goForward({waitUntil:'domcontentloaded'});break
      case 'reload':await page.reload({waitUntil:'domcontentloaded'});break
      case 'coordinate':await page.mouse.click(action.x,action.y,{button:action.button,clickCount:action.clickCount});break
      case 'key':await page.keyboard.press(action.key);break
      case 'text':await page.keyboard.insertText(action.text);break
      case 'scroll':await page.mouse.wheel(action.deltaX??0,action.deltaY);break
    }
    return {ok:true,generation:entry.generation,url:page.url()}
  }
  private safeName(name:string){return basename(name.replaceAll('\\','/')).replace(/[\x00-\x1f\x7f]/g,'_').slice(0,240)||'download'}
  private async saveDownload(entry:Entry,download:Download,generation:number,context?:BrowserCallContext){
    const id=randomUUID(),path=join(entry.downloadDirectory!,id)
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
      await this.check(entry,generation,context)
      if(entry.downloads.size+entry.pendingDownloads.size>(this.options.maxDownloads??20))fail('browser_download_limit','下载文件数量已达上限')
      const stream=await Promise.race([download.createReadStream(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void download.cancel().catch(()=>{});reject(new BrowserRuntimeError('browser_download_timeout','下载超时'))},60000);timer.unref()})])
      if(!stream)fail('browser_download_failed','下载未返回文件')
      const file=await open(path,'wx',0o600),hash=createHash('sha256');let size=0
      try{
        for await(const chunk of stream!){await this.check(entry,generation,context);const bytes=Buffer.from(chunk);size+=bytes.length;if(size>(this.options.maxDownloadBytes??25*1024*1024))fail('browser_file_limit','下载文件过大');hash.update(bytes);await file.write(bytes)}
      }finally{await file.close()}
      await this.check(entry,generation,context)
      const name=this.safeName(download.suggestedFilename())
      entry.downloads.set(id,{id,name,mimeType:lookup(name)||'application/octet-stream',size,sha256:hash.digest('hex'),url:download.url(),createdAt:Date.now()})
    }catch(error){await download.cancel().catch(()=>{});await rm(path,{force:true});throw error}
    finally{clearTimeout(timer);await download.delete().catch(()=>{})}
  }
  async readDownload(scope:BrowserScope,id:string,context?:BrowserCallContext):Promise<BrowserUpload & {metadata:BrowserDownload}>{
    const entry=this.entry(scope),generation=entry.generation;await this.check(entry,generation,context)
    return this.queue(entry,async()=>{await this.check(entry,generation,context);const metadata=entry.downloads.get(id);if(!metadata)fail('browser_download_missing','下载文件不存在');const buffer=await readFile(join(entry.downloadDirectory!,metadata!.id));await this.check(entry,generation,context);if(buffer.length!==metadata!.size||createHash('sha256').update(buffer).digest('hex')!==metadata!.sha256)fail('browser_download_changed','下载文件校验失败');return {name:metadata!.name,mimeType:metadata!.mimeType,buffer,metadata:metadata!}})
  }
  /** Fence old requests immediately, then wait for their bounded actions to drain.
   * The same browser context is retained for manual takeover and login. */
  async pause(scope:BrowserScope,context?:BrowserCallContext){
    const entry=this.entry(scope);await this.check(entry,undefined,context);entry.generation++;entry.operations.clear();this.invalidate(entry);entry.parked=false;entry.networkContext=context;entry.proxy?.disconnect()
    return this.queue(entry,async()=>{await this.check(entry,undefined,context);return this.state(entry)})
  }
  async resume(scope:BrowserScope,context?:BrowserCallContext){return this.pause(scope,context)}
  /** Retain this Bot's page state without retaining a task's network authority. */
  async park(scope:BrowserScope,context?:BrowserCallContext){
    const entry=this.entry(scope);await this.check(entry,undefined,context)
    entry.generation++;entry.operations.clear();this.invalidate(entry)
    entry.parked=true;entry.networkContext=undefined;entry.proxy?.disconnect()
    return this.queue(entry,async()=>{await this.check(entry,undefined,context);return this.state(entry)})
  }
  /** Unlike pause, revoke closes the context immediately to interrupt old I/O. */
  async revoke(scope:BrowserScope){
    const entry=this.entry(scope);entry.generation++;entry.operations.clear();this.invalidate(entry)
    // Interrupt current I/O now, but retain profile locks until a concurrent
    // launch/action drains. Releasing them early would admit a second writer.
    const closing=Promise.allSettled([entry.context?.close(),entry.proxy?.close()])
    return this.queue(entry,async()=>{await closing;await this.destroy(entry);return this.state(entry)})
  }
  async close(scope:BrowserScope,context?:BrowserCallContext){const entry=this.entry(scope);await this.check(entry,undefined,context);return this.revoke(scope)}
  private async destroy(entry:Entry){
    const browser=entry.context;entry.context=undefined;entry.pages.clear();entry.active='';entry.parked=false;entry.networkContext=undefined;this.invalidate(entry)
    await entry.proxy?.close();entry.proxy=undefined
    if(browser)await browser.close().catch(()=>{})
    await Promise.allSettled([...entry.pendingDownloads])
    if(entry.profileLock)await rm(entry.profileLock,{recursive:true,force:true});entry.profileLock=undefined
    if(entry.scope.profile==='temporary'&&entry.profileDirectory)await rm(entry.profileDirectory,{recursive:true,force:true})
    entry.profileDirectory=undefined
    if(entry.downloadDirectory)await rm(entry.downloadDirectory,{recursive:true,force:true});entry.downloadDirectory=undefined;entry.downloads.clear();entry.downloadErrors=[]
  }
  async shutdown(){this.enabled=false;await Promise.all([...this.entries.values()].map(async entry=>{entry.generation++;entry.operations.clear();await Promise.allSettled([entry.context?.close(),entry.proxy?.close()]);await entry.tail.catch(()=>{});await this.destroy(entry)}))}
}
