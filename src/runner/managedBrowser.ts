import {join} from 'node:path'
import {z} from 'zod'
import {BrowserRuntime,type BrowserScope,type BrowserUpload,type BrowserOperation} from './browser/runtime.js'
import {HttpError} from '../server/errors.js'
import type {RunnerConfiguration} from '../shared/runner.js'
import type {BrowserInstallation} from '../shared/managedBrowser.js'
import {createBrowserInstaller,browserInstallationFailure,type BrowserInstaller} from './browser/installation.js'

const scopeSchema=z.object({ownerKey:z.string().regex(/^[a-f0-9]{64}$/),environmentId:z.string().uuid(),profile:z.enum(['persistent','temporary'])}).strict()
const key=(scope:BrowserScope)=>JSON.stringify([scope.ownerKey,scope.environmentId])
interface InstallationJob {controller:AbortController;holders:Map<string,()=>Promise<void>>;promise:Promise<void>}

/** Uses the existing outbound Runner transport; no browser/CDP port is published. */
export class RunnerBrowser {
  available=false
  installation:BrowserInstallation={status:'checking',message:'正在检查节点浏览器',updatedAt:Date.now()}
  private readonly enabled:boolean
  private readonly installer:BrowserInstaller
  private installationJob?:InstallationJob
  private stopped=false
  readonly ready:Promise<void>
  readonly runtime:BrowserRuntime
  private uploads=new Map<string,BrowserUpload>()
  private downloads=new Map<string,{file:Awaited<ReturnType<BrowserRuntime['readDownload']>>;at:number}>()
  private active=new Set<AbortController>()
  private scopes=new Map<string,{scope:BrowserScope;at:number}>()
  constructor(config:NonNullable<RunnerConfiguration['browser']>,home:string,private readonly check:(scope:BrowserScope,grantId?:string)=>Promise<void>,dependencies:{runtime?:BrowserRuntime;probe?:()=>Promise<boolean>;installer?:BrowserInstaller}={}){
    this.enabled=config.enabled===true;this.installer=dependencies.installer??createBrowserInstaller()
    this.runtime=dependencies.runtime??new BrowserRuntime({root:join(home,'managed-browser'),enabled:config.enabled,maxSessions:config.maxSessions,
      authorize:scope=>check(scope),resolveUpload:async(scope,id)=>{const file=this.uploads.get(key(scope)+':'+id);if(!file)throw new HttpError(403,'上传文件未获本次授权','browser_upload_forbidden');return file}})
    this.ready=Promise.resolve().then(async()=>{
      if(this.enabled)this.available=await (dependencies.probe??this.installer.probe)()
      if(this.stopped){this.available=false;return}
      if(this.available||this.installation.status!=='failed')this.installation={status:this.available?'ready':'missing',message:this.available?'节点浏览器已就绪':this.enabled?'节点浏览器尚未就绪，请准备浏览器':'节点未启用托管浏览器',updatedAt:Date.now()}
    }).catch(()=>{this.available=false;this.installation={status:'failed',message:'节点浏览器检查失败',error:'无法检查节点浏览器，请重新准备',updatedAt:Date.now()}})
    this.idleTimeoutMs=config.idleTimeoutMs??1800000
  }
  private readonly idleTimeoutMs:number
  async invoke(raw:unknown,expiresAt:number,profileAllowed:(profile:string)=>void){
    const p=z.object({scope:scopeSchema,profile:z.string(),grantId:z.string().uuid(),op:z.enum(['status','prepare','open','execute','pause','resume','park','close','download']),retry:z.boolean().optional(),operation:z.unknown().optional(),downloadId:z.string().uuid().optional(),offset:z.number().int().min(0).optional(),upload:z.object({id:z.string().uuid(),name:z.string().max(240),mimeType:z.string().max(200),data:z.string().max(36*1024*1024)}).strict().optional()}).strict().parse(raw)
    profileAllowed(p.profile)
    const controller=new AbortController();this.active.add(controller)
    const authorize=async()=>{controller.signal.throwIfAborted();if(Date.now()>=expiresAt)throw new HttpError(410,'浏览器命令已过期','browser_command_expired');await this.check(p.scope,p.grantId);controller.signal.throwIfAborted();if(Date.now()>=expiresAt)throw new HttpError(410,'浏览器命令已过期','browser_command_expired')}
    // Network/download activity uses the long-lived task/control grant, not the
    // transport command's 30-second deadline.
    const context={authorize:()=>this.check(p.scope,p.grantId),signal:controller.signal}
    let checking=false
    const timer=setInterval(()=>{if(checking)return;checking=true;void authorize().catch(error=>controller.abort(error)).finally(()=>{checking=false})},2000);timer.unref()
    const uploadKey=p.upload?key(p.scope)+':'+p.upload.id:undefined
    try{
      if(!['status','prepare','close'].includes(p.op))await this.waitForCheck(controller.signal)
      await authorize()
      if(this.stopped)throw new HttpError(410,'Runner 已关闭','browser_unavailable')
      if((!this.available&&!['status','prepare','close'].includes(p.op))||(p.op==='prepare'&&!this.enabled))throw new HttpError(409,'托管浏览器未就绪，请先准备浏览器','browser_unavailable')
      const action=(p.operation as BrowserOperation|undefined)?.action?.kind
      const observing=p.op==='status'||p.op==='execute'&&['state','downloads','screenshot','snapshot'].includes(action??'')
      // Reading an idle preview must not keep a Chromium process alive forever.
      // Track observations for revocation, but refresh activity only for actual use.
      if(this.available&&!['prepare','close'].includes(p.op)&&(!observing||!this.scopes.has(key(p.scope))))this.scopes.set(key(p.scope),{scope:p.scope,at:Date.now()})
      if(p.upload){
        const buffer=Buffer.from(p.upload.data,'base64')
        if(buffer.length>25*1024*1024||buffer.toString('base64')!==p.upload.data)throw new HttpError(413,'上传文件无效或超过 25 MiB','browser_upload_limit')
        this.uploads.set(uploadKey!,{name:p.upload.name,mimeType:p.upload.mimeType,buffer})
      }
      let result:unknown
      if(p.op==='status'||p.op==='prepare'){
        if(p.op==='prepare')this.prepare(p.scope,p.grantId,p.retry===true)
        // Preparation only reports installation metadata, including when another
        // holder finishes setup before this request arrives. A subsequent status
        // call uses its own view/task authorization to read the actual session.
        const state=p.op==='status'&&this.enabled&&this.available?await this.runtime.status(p.scope,context):{open:false,generation:1,profile:p.scope.profile,tabs:[],downloads:[]}
        result={...state,enabled:this.enabled,available:this.available,installation:{...this.installation}}
      }
      else if(p.op==='open')result=await this.runtime.open(p.scope,context)
      else if(p.op==='execute')result=await this.runtime.execute(p.scope,p.operation as BrowserOperation,context)
      else if(p.op==='pause')result=await this.runtime.pause(p.scope,context)
      else if(p.op==='resume')result=await this.runtime.resume(p.scope,context)
      else if(p.op==='park')result=await this.runtime.park(p.scope,context)
      else if(p.op==='close'){this.releaseInstaller(p.scope,p.grantId);result=this.enabled&&this.available?await this.runtime.close(p.scope,context):{open:false,generation:1,profile:p.scope.profile,tabs:[],downloads:[]};this.clearDownloads(p.scope);this.scopes.delete(key(p.scope))}
      else{
        if(!p.downloadId)throw new HttpError(400,'缺少下载编号','browser_download_invalid')
        for(const [id,cached] of this.downloads)if(cached.at<Date.now()-60000)this.downloads.delete(id)
        const id=key(p.scope)+':'+p.downloadId
        let cached=this.downloads.get(id)
        if(!cached){
          if([...this.downloads.values()].reduce((sum,x)=>sum+x.file.buffer.length,0)>40*1024*1024)this.downloads.clear()
          cached={file:await this.runtime.readDownload(p.scope,p.downloadId,context),at:Date.now()};this.downloads.set(id,cached)
        }
        cached.at=Date.now();const {file}=cached,offset=p.offset??0
        if(offset>file.buffer.length)throw new HttpError(400,'下载分块范围无效','browser_download_invalid')
        const chunk=file.buffer.subarray(offset,offset+512*1024)
        result={...file.metadata,offset,data:chunk.toString('base64'),done:offset+chunk.length===file.buffer.length}
      }
      await authorize();return result
    }finally{clearInterval(timer);this.active.delete(controller);if(uploadKey)this.uploads.delete(uploadKey)}
  }
  private async waitForCheck(signal:AbortSignal){
    signal.throwIfAborted()
    let abort:()=>void=()=>{}
    try{
      await Promise.race([this.ready,new Promise<never>((_,reject)=>{
        abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true})
        if(signal.aborted)abort()
      })])
      signal.throwIfAborted()
    }finally{signal.removeEventListener('abort',abort)}
  }
  private prepare(scope:BrowserScope,grantId:string,retry:boolean){
    if(this.available)return
    const holder=JSON.stringify([key(scope),grantId]),authorize=()=>this.check(scope,grantId)
    if(this.installationJob){
      // Cancellation is irreversible; wait for that job to settle before retrying.
      if(!this.installationJob.controller.signal.aborted)this.installationJob.holders.set(holder,authorize)
      return
    }
    if(this.installation.status==='failed'&&!retry)return
    const job:InstallationJob={controller:new AbortController(),holders:new Map([[holder,authorize]]),promise:Promise.resolve()}
    this.installationJob=job
    if(this.installation.status!=='checking')this.installation={status:'installing',message:'正在准备节点浏览器',updatedAt:Date.now()}
    let checking=false
    const recheck=async()=>{
      if(checking)return;checking=true
      try{
        await Promise.all([...job.holders].map(async([id,check])=>{
          // A stalled authorization request must not retain an installer forever.
          let timeout:ReturnType<typeof setTimeout>|undefined
          try{await Promise.race([check(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('authorization timeout')),5000);timeout.unref()})])}
          catch{if(job.holders.get(id)===check)job.holders.delete(id)}finally{if(timeout)clearTimeout(timeout)}
        }))
        if(!job.holders.size)job.controller.abort()
      }finally{checking=false}
    }
    const timer=setInterval(()=>{void recheck()},2000);timer.unref()
    job.promise=(async()=>{
      try{
        // An authorized preparation can arrive while startup is still probing.
        // It must return promptly and never install until that check completes.
        await this.waitForCheck(job.controller.signal)
        if(this.available)return
        this.installation={status:'installing',message:'正在准备节点浏览器',updatedAt:Date.now()}
        await this.installer.install({signal:job.controller.signal,onUpdate:update=>{
          if(this.installationJob===job&&!job.controller.signal.aborted)this.installation={status:'installing',...update,updatedAt:Date.now()}
        }})
        // Recheck every holder at completion, including when a periodic check is in flight.
        while(checking)await new Promise(resolve=>setTimeout(resolve,10))
        await recheck();job.controller.signal.throwIfAborted()
        if(this.stopped)throw new Error('Runner closed')
        this.available=true;this.installation={status:'ready',message:'节点浏览器已就绪',updatedAt:Date.now()}
      }catch(error){
        this.available=false
        const message=job.controller.signal.aborted?'浏览器准备已取消，请重新发起准备':browserInstallationFailure(error)
        this.installation={status:'failed',message,error:message,updatedAt:Date.now()}
      }finally{clearInterval(timer);if(this.installationJob===job)this.installationJob=undefined}
    })()
  }
  private releaseInstaller(scope:BrowserScope,grantId:string){
    const job=this.installationJob;if(!job)return
    job.holders.delete(JSON.stringify([key(scope),grantId]));if(!job.holders.size)job.controller.abort()
  }
  private clearDownloads(scope:BrowserScope){for(const id of this.downloads.keys())if(id.startsWith(key(scope)+':'))this.downloads.delete(id)}
  async sweep(){
    for(const [id,item] of this.scopes){
      let allowed=true;try{await this.check(item.scope)}catch{allowed=false}
      // An input or a new controller may have refreshed this scope while the
      // asynchronous authorization check was in flight. Never revoke its lease.
      if(this.scopes.get(id)!==item)continue
      if(!allowed||Date.now()-item.at>this.idleTimeoutMs){this.scopes.delete(id);this.clearDownloads(item.scope);await this.runtime.revoke(item.scope)}
    }
  }
  async disconnect(){this.installationJob?.controller.abort();for(const controller of this.active)controller.abort();await Promise.allSettled([...this.scopes.values()].map(item=>this.runtime.revoke(item.scope)));this.scopes.clear();this.downloads.clear();this.uploads.clear();await this.installationJob?.promise}
  async shutdown(){this.stopped=true;this.available=false;await this.disconnect();await this.runtime.shutdown()}
}
