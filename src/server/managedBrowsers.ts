import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import Router from '@koa/router'
import {z} from 'zod'
import {HttpError} from './errors.js'
import {readHostTools} from './hostToolSettings.js'
import {parse,type WorkspaceStore} from './workspaceStore.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceNodes} from './workspaceGateway.js'
import type {RunnerHub} from './runnerHub.js'
import type {WorkspaceAgent} from '../shared/workspace.js'
import type {ComputerFrame,ComputerControlStatus} from '../shared/computerControl.js'
import type {BrowserScope,BrowserState,BrowserUpload} from '../runner/browser/types.js'
import type {BrowserInstallation,ManagedBrowserCard,ManagedBrowserState} from '../shared/managedBrowser.js'
import {ToolOperationJournal} from './toolOperationJournal.js'

const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
const credentials=z.object({controlId:z.string().uuid(),token:z.string().min(32).max(256)}).passthrough()
type RuntimeState=BrowserState&{available?:boolean;installation?:BrowserInstallation}
interface Grant {id:string;role:'task'|'human'|'view'|'prepare'|'session';resource:Resource;expiresAt:number;authVersion:number;authorize():void;signal?:AbortSignal;parking?:boolean;requestId?:string;sealedToken?:string;tokenHash?:string}
interface Resource {owner:string;agent:WorkspaceAgent;runnerId:string;runnerEpoch?:string;authVersion:number;scope:BrowserScope;state:RuntimeState;task?:Grant;human?:Grant;session?:Grant;parked?:boolean;nextStatusAt?:number;refreshing?:Promise<void>;preparation?:Grant;notify?:()=>void;paused:boolean;forceClose?:boolean;retired?:boolean;resetRequired?:boolean;resetting?:Promise<void>;transition?:Promise<unknown>;taking?:Promise<void>;closing?:Promise<unknown>;frame?:ComputerFrame;frames?:Map<string,Omit<ComputerFrame,'data'>>;notes?:string}
export interface BrowserTurn {
  call(name:string,args:unknown,callId?:string):Promise<unknown>
  close(options?:{retain?:boolean}):Promise<void>
}
export interface BrowserTurnOptions {
  workId:string;signal:AbortSignal;authorize():void
  publish(name:string,bytes:Buffer):Promise<unknown>
  upload(fileId:string):Promise<BrowserUpload>
  /** Return false when persistence failed so the next observation can retry. */
  onCard?(card:ManagedBrowserCard):boolean|void
  toVm?(file:BrowserUpload,path:string,overwrite:boolean):Promise<unknown>
  fromVm?(path:string):Promise<BrowserUpload>
}

/** Browser grants share Runner authentication, owner/source policy and task lifetime.
 * They do not grant host/VM tools or reactivate the retired Electron browser path. */
export class ManagedBrowsers {
  private resources=new Map<string,Resource>()
  private grants=new Map<string,Grant>()
  private journal:ToolOperationJournal
  private timer:ReturnType<typeof setInterval>
  private closed=false
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,readonly hub:RunnerHub){
    this.journal=new ToolOperationJournal(store)
    this.timer=setInterval(()=>void this.sweep(),5000);this.timer.unref()
  }
  private agent(owner:string,id:string){
    if(this.closed||!readHostTools(this.store.home).managedBrowser)throw new HttpError(409,'托管浏览器未启用','browser_disabled')
    const agent=this.store.require<WorkspaceAgent>(owner,'agent',id)
    if(agent.archived||agent.remoteAgentId)throw new HttpError(409,'当前 Bot 没有托管浏览器','browser_unavailable')
    this.nodes.requireSource(owner,agent)
    return agent
  }
  available(owner:string,agent:WorkspaceAgent){try{this.agent(owner,agent.id);this.hub.browserRunner(owner,agent);return true}catch{return false}}
  private resource(owner:string,id:string){
    const agent=this.agent(owner,id),runner=this.hub.browserRunner(owner,agent),key=owner+':'+id
    let resource=this.resources.get(key),resetRequired=false
    if(resource&&(resource.retired||resource.authVersion!==(this.auth.pushAuthorizationVersion(owner)??0)||resource.runnerId!==runner.id||resource.runnerEpoch!==runner.browserEpoch||resource.agent.profile!==agent.profile||resource.agent.nodeId!==agent.nodeId)){
      // Source changes revoke every old holder. The old Runner observes the
      // revoked grant; the current Runner must confirm a close before reuse.
      this.retire(resource)
      resetRequired=true
      this.resources.delete(key);resource=undefined
    }
    if(!resource){
      const scope:BrowserScope={ownerKey:digest(owner),environmentId:agent.id,profile:agent.temporaryGoalId?'temporary':'persistent'}
      resource={owner,agent,runnerId:runner.id,runnerEpoch:runner.browserEpoch,authVersion:this.auth.pushAuthorizationVersion(owner)??0,scope,state:{open:false,generation:1,profile:scope.profile,tabs:[],downloads:[]},paused:false,resetRequired}
      this.resources.set(key,resource)
    }
    return resource
  }
  private grant(resource:Resource,role:Grant['role'],authorize:()=>void,signal?:AbortSignal,expiresAt=Infinity){
    const grant:Grant={id:randomUUID(),resource,role,authorize,signal,expiresAt,authVersion:this.auth.pushAuthorizationVersion(resource.owner)??0}
    this.grants.set(grant.id,grant);return grant
  }
  private check(grant:Grant){
    const r=grant.resource
    if(this.resources.get(r.owner+':'+r.agent.id)!==r||this.grants.get(grant.id)!==grant||grant.expiresAt<=Date.now()||grant.signal?.aborted||!this.auth.isUserActive(r.owner)||(this.auth.pushAuthorizationVersion(r.owner)??0)!==grant.authVersion)throw new HttpError(410,'浏览器操作授权已结束','browser_authorization_revoked')
    this.checkResource(r)
    grant.authorize()
  }
  private checkResource(r:Resource){
    if(r.retired||this.resources.get(r.owner+':'+r.agent.id)!==r||!this.auth.isUserActive(r.owner)||(this.auth.pushAuthorizationVersion(r.owner)??0)!==r.authVersion)throw new HttpError(410,'浏览器操作授权已结束','browser_authorization_revoked')
    const agent=this.agent(r.owner,r.agent.id),runner=this.hub.browserRunner(r.owner,agent)
    if(agent.nodeId!==r.agent.nodeId||agent.profile!==r.agent.profile||runner.id!==r.runnerId||runner.browserEpoch!==r.runnerEpoch)throw new HttpError(410,'浏览器执行来源已改变','browser_source_changed')
  }
  private retire(r:Resource){
    for(const [id,g] of this.grants)if(g.resource===r)this.grants.delete(id)
    r.retired=true;r.task=undefined;r.human=undefined;r.session=undefined;r.preparation=undefined;r.paused=false;r.notify?.()
  }
  private dropSession(r:Resource){if(r.session)this.grants.delete(r.session.id);r.session=undefined;r.parked=false}
  private keepSession(r:Resource){
    if(!r.forceClose&&r.scope.profile==='persistent'&&this.hub.supportsBrowserRetention(r.owner,r.agent))r.session??=this.grant(r,'session',()=>{})
  }
  private transition<T>(r:Resource,action:()=>Promise<T>):Promise<T>{
    const pending=(r.transition??Promise.resolve()).catch(()=>{}).then(action)
    r.transition=pending
    void pending.finally(()=>{if(r.transition===pending)r.transition=undefined}).catch(()=>{})
    return pending
  }
  private async rest(r:Resource,retain:boolean){
    this.checkResource(r)
    r.frame=undefined;r.frames?.clear();r.paused=false
    if(retain&&!r.forceClose&&r.scope.profile==='persistent'&&r.state.open&&this.hub.supportsBrowserRetention(r.owner,r.agent)){
      const session=r.session??=this.grant(r,'session',()=>{})
      try{
        const state=await this.request(session,'park')
        if(!state||typeof state.open!=='boolean'||!Number.isInteger(state.generation))throw new HttpError(502,'浏览器未确认页面保留','browser_park_unconfirmed')
        if(r.state.open){r.parked=true;r.nextStatusAt=Date.now()+30000}else this.dropSession(r)
        return
      }
      catch{this.dropSession(r)}
    }
    this.dropSession(r)
    try{await this.view(r,g=>this.request(g,'close'));r.forceClose=false}
    catch(error){r.resetRequired=true;throw error}
  }
  private async activate(g:Grant){
    while(g.resource.parked){
      await this.waitForControl(g)
      await this.transition(g.resource,async()=>{
        const r=g.resource;this.check(g)
        if(r.paused||!r.parked)return
        await this.request(g,'resume');r.parked=false;r.frame=undefined;r.frames?.clear()
      })
    }
  }
  allowed(runnerId:string,scope:unknown,grantId?:string){
    if(!scope||typeof scope!=='object')return false
    const s=scope as BrowserScope
    const matches=(g:Grant)=>g.resource.runnerId===runnerId&&g.resource.scope.ownerKey===s.ownerKey&&g.resource.scope.environmentId===s.environmentId&&g.resource.scope.profile===s.profile
    const valid=(g:Grant)=>{try{this.check(g);return true}catch{return false}}
    if(grantId){const g=this.grants.get(grantId);return !!g&&(g.role!=='session'||g.parking===true)&&matches(g)&&valid(g)}
    return [...this.grants.values()].some(g=>g.role!=='prepare'&&matches(g)&&valid(g))
  }
  private async request(grant:Grant,op:string,data:Record<string,unknown>={}){
    this.check(grant)
    if(grant.role==='session'&&op!=='park')throw new HttpError(403,'保留会话不授权浏览器操作','browser_tool_forbidden')
    if(grant.role==='task'&&!['status','close','prepare','resume'].includes(op))await this.waitForControl(grant)
    const r=grant.resource
    if(r.resetRequired){
      r.resetting??=(async()=>{
        const result=await this.hub.browser(r.owner,r.agent,{scope:r.scope,grantId:grant.id,op:'close'},()=>this.check(grant))
        r.state=result;r.resetRequired=false
      })().finally(()=>{r.resetting=undefined})
      await r.resetting
      this.check(grant)
    }
    if(grant.role==='session')grant.parking=true
    try{
      const result=await this.hub.browser(r.owner,r.agent,{scope:r.scope,grantId:grant.id,op,...data},()=>this.check(grant))
      if(result&&typeof result.open==='boolean'&&Number.isInteger(result.generation)&&result.generation>=r.state.generation){r.state=result;if(!r.state.open)this.dropSession(r);else if(op==='open'&&(grant.role==='task'||grant.role==='human'))this.keepSession(r);r.notify?.()}
      return result
    }finally{grant.parking=false}
  }
  private async waitForControl(g:Grant){
    while(g.resource.paused){
      this.check(g)
      await new Promise<void>((resolve,reject)=>{
        const stop=()=>{clearTimeout(timer);reject(new HttpError(410,'浏览器任务已停止','browser_authorization_revoked'))}
        const timer=setTimeout(()=>{g.signal?.removeEventListener('abort',stop);resolve()},250)
        g.signal?.addEventListener('abort',stop,{once:true})
        if(g.signal?.aborted){g.signal.removeEventListener('abort',stop);stop()}
      })
    }
    this.check(g)
  }
  private async view<T>(r:Resource,action:(g:Grant)=>Promise<T>){
    const grant=this.grant(r,'view',()=>{},undefined,Date.now()+30000)
    try{return await action(grant)}finally{this.grants.delete(grant.id)}
  }
  private controlStatus(r:Resource):ComputerControlStatus{
    return {backend:'managed-browser',hostName:'托管浏览器',mode:r.taking?'pausing':r.paused?(r.human?'human':'pausing'):r.task?'agent':r.state.open?'idle':'off',generation:r.state.generation,...(r.human?{controlId:r.human.id}:{}),canResume:!!r.task}
  }
  async state(owner:string,id:string){
    const enabled=readHostTools(this.store.home).managedBrowser===true
    try{const r=this.resource(owner,id);await this.view(r,g=>this.request(g,'status'));this.finishPreparation(r);return this.publicState(r)}
    catch(error){return {enabled,available:false,reason:error instanceof Error?error.message:'浏览器不可用',open:false,generation:0,profile:'persistent',tabs:[],downloads:[]}}
  }
  private publicState(r:Resource):ManagedBrowserState{return {enabled:true,...r.state,supportsRetention:this.hub.supportsBrowserRetention(r.owner,r.agent),available:r.state.available??true,...(r.state.available===false?{reason:r.state.installation?.message??'浏览器环境尚未就绪'}:{})}}
  private finishPreparation(r:Resource){
    if(r.preparation&&['ready','failed'].includes(r.state.installation?.status??'')){this.grants.delete(r.preparation.id);r.preparation=undefined}
  }
  async prepare(owner:string,id:string,retry=false){
    const r=this.resource(owner,id)
    await this.view(r,g=>this.request(g,'status'))
    if(r.state.available!==false){this.finishPreparation(r);return this.publicState(r)}
    if(r.preparation){try{this.check(r.preparation)}catch{this.grants.delete(r.preparation.id);r.preparation=undefined}}
    const g=r.preparation??=this.grant(r,'prepare',()=>{},undefined,Date.now()+600000)
    try{await this.request(g,'prepare',{retry});this.finishPreparation(r);return this.publicState(r)}
    catch(error){if(r.preparation===g){this.grants.delete(g.id);r.preparation=undefined}throw error}
  }
  private async ensureReady(g:Grant){
    await this.request(g,'status')
    if(g.resource.state.available!==false)return
    await this.request(g,'prepare')
    const deadline=Date.now()+540000
    while(g.resource.state.available===false){
      this.check(g)
      const installation=g.resource.state.installation
      if(installation?.status==='failed')throw new HttpError(409,installation.error||installation.message,'browser_install_failed')
      if(Date.now()>=deadline)throw new HttpError(504,'浏览器环境准备超时，请在卡片中检查状态后重试','browser_install_timeout')
      await new Promise<void>((resolve,reject)=>{
        const stop=()=>{clearTimeout(timer);reject(new HttpError(410,'浏览器任务已停止','browser_authorization_revoked'))}
        const timer=setTimeout(()=>{g.signal?.removeEventListener('abort',stop);resolve()},750)
        g.signal?.addEventListener('abort',stop,{once:true})
        if(g.signal?.aborted){g.signal.removeEventListener('abort',stop);stop()}
      })
      await this.request(g,'status')
    }
  }
  private token(owner:string,id:string,value:unknown){
    const input=parse(credentials,value),grant=this.grants.get(input.controlId)
    if(!grant||grant.role!=='human'||grant.resource.owner!==owner||grant.resource.agent.id!==id||!grant.tokenHash||!timingSafeEqual(Buffer.from(grant.tokenHash,'hex'),Buffer.from(digest(input.token),'hex')))throw new HttpError(403,'需要当前浏览器控制凭据','browser_control_forbidden')
    this.check(grant);if(grant.resource.human!==grant)throw new HttpError(410,'浏览器控制权已改变','browser_control_expired')
    return grant
  }
  private async download(grant:Grant,id:string):Promise<BrowserUpload>{
    const parts:Buffer[]=[];let offset=0,size:number|undefined,sha256='',name='',mimeType='application/octet-stream'
    do{
      const reply=await this.request(grant,'download',{downloadId:id,offset})
      if(!Number.isSafeInteger(reply.size)||reply.size<0||reply.size>25*1024*1024||reply.offset!==offset||typeof reply.data!=='string'||reply.data.length>710000||!/^[a-f0-9]{64}$/.test(reply.sha256))throw new HttpError(502,'下载分块无效','browser_download_invalid')
      if(size!==undefined&&(size!==reply.size||sha256!==reply.sha256||name!==reply.name))throw new HttpError(502,'下载文件在传输时改变','browser_download_changed')
      size=reply.size;sha256=reply.sha256;name=reply.name;mimeType=reply.mimeType
      const chunk=Buffer.from(reply.data,'base64')
      if(chunk.toString('base64')!==reply.data||chunk.length!==Math.min(512*1024,size!-offset))throw new HttpError(502,'下载分块不完整','browser_download_invalid')
      parts.push(chunk);offset+=chunk.length
    }while(offset<size!)
    const buffer=Buffer.concat(parts)
    if(createHash('sha256').update(buffer).digest('hex')!==sha256)throw new HttpError(502,'下载校验失败','browser_download_invalid')
    return {name,mimeType,buffer}
  }
  openTurn(owner:string,agent:WorkspaceAgent,options:BrowserTurnOptions):BrowserTurn{
    let grant:Grant|undefined,finished=false,activated=false,closing:Promise<void>|undefined,failure:string|undefined,lastCard='',lastTitle:string|undefined,lastUrl:string|undefined,listener:(()=>void)|undefined
    const notify=(r:Resource)=>{
      if(!options.onCard)return
      const tab=r.state.tabs.find(tab=>tab.active)
      let url:string|undefined
      try{const parsed=new URL(tab?.url??'');if(['https:','http:'].includes(parsed.protocol)){parsed.username='';parsed.password='';parsed.search='';parsed.hash='';url=parsed.href.slice(0,2000)}}catch{}
      if(tab){lastTitle=tab.title.slice(0,240);lastUrl=url}
      if((r.retired||finished&&!r.human&&!r.session)&&r.notify===listener)r.notify=undefined
      const status:ManagedBrowserCard['status']=r.retired?'closed':failure?'failed':finished&&!r.human?(r.session&&r.state.open?'idle':'closed'):r.state.available===false?'preparing':r.state.open?'active':'ready'
      const {updatedAt:_updated,...installation}=r.state.installation??{updatedAt:0}
      const body={id:options.workId,agentId:agent.id,agentName:agent.name,status,title:lastTitle,url:lastUrl,
        message:r.retired?'浏览器执行来源已改变，本轮会话已结束':failure??(status==='idle'?'本轮操作已结束，页面已保留':status==='closed'?'本轮浏览器操作已结束':r.human?(finished?(r.session&&!r.forceClose?'人工控制中，交还后保留页面':'人工控制中，交还后结束本轮会话'):'人工控制中，可交还机器人继续'):r.paused?'接管已过期，请重新接管后交还机器人':r.state.installation?.message),installation:r.state.installation}
      const signature=JSON.stringify({...body,installation})
      if(signature===lastCard)return
      // Chat persistence is an observer; a deleted history row or storage error
      // must never block control handoff, authorization cleanup, or the sweep.
      try{if(options.onCard({...body,updatedAt:Date.now()})!==false)lastCard=signature}catch{}
    }
    const get=async()=>{
      options.authorize();options.signal.throwIfAborted()
      if(finished)throw new HttpError(410,'浏览器任务已结束','browser_authorization_revoked')
      if(!grant){
        const r=this.resource(owner,agent.id)
        while(r.transition){
          await r.transition.catch(()=>{});options.authorize();options.signal.throwIfAborted()
          if(finished)throw new HttpError(410,'浏览器任务已结束','browser_authorization_revoked')
        }
        this.checkResource(r)
        if(r.task)throw new HttpError(409,'当前 Bot 浏览器正由另一个任务使用','browser_busy')
        r.notify?.()
        if(!r.human)r.forceClose=false
        grant=this.grant(r,'task',options.authorize,options.signal);r.task=grant;listener=()=>notify(r);r.notify=listener
      }
      this.check(grant);return grant
    }
    const close=(value:{retain?:boolean}={}):Promise<void>=>{
      if(finished)return closing??Promise.resolve();finished=true;options.signal.removeEventListener('abort',abort)
      if(!grant)return Promise.resolve()
      const g=grant,r=g.resource;this.grants.delete(g.id);if(r.task===g)r.task=undefined
      const retain=value.retain!==false&&!options.signal.aborted
      if(!retain){r.forceClose=true;this.dropSession(r)}
      closing=this.transition(r,async()=>{
        try{
          this.checkResource(r)
          if(r.human){try{this.check(r.human);return}catch{this.grants.delete(r.human.id);r.human=undefined}}
          // A status-only turn must not refresh the retained session's idle deadline.
          if(retain&&!activated&&r.session&&r.parked)return
          await this.rest(r,retain)
        }catch{ /* Revoked resources are fenced and reclaimed by the Runner. */ }
        finally{notify(r)}
      }).finally(()=>{if(r.closing===closing)r.closing=undefined})
      r.closing=closing;return closing
    }
    const abort=()=>{void close({retain:false})};options.signal.addEventListener('abort',abort,{once:true})
    return {close,call:async(name,raw,callId)=>{
      const g=await get(),r=g.resource
      notify(r)
      try{
      // Hold the current tool call while the user operates this exact session.
      await this.waitForControl(g)
      if(name!=='managed_browser_state'){await this.activate(g);activated=true}
      const args=z.record(z.string(),z.unknown()).parse(raw??{})
      const result=await this.journal.execute(owner,options.workId,callId,name,args,()=>this.check(g),async()=>{
        if(name==='managed_browser_state')return this.request(g,'status')
        if(name==='managed_browser_open'){
          const body=z.object({url:z.string().optional()}).strict().parse(args)
          await this.ensureReady(g)
          await this.request(g,'open')
          if(body.url)await this.request(g,'execute',{operation:{generation:r.state.generation,operationId:callId??randomUUID(),action:{kind:'navigate',url:body.url}}})
          return this.request(g,'status')
        }
        if(name==='managed_browser_export'||name==='managed_browser_to_vm'){
          const body=z.object({downloadId:z.string().uuid(),path:z.string().optional(),overwrite:z.boolean().default(false)}).strict().parse(args)
          const file=await this.download(g,body.downloadId)
          if(name==='managed_browser_export')return options.publish(file.name,file.buffer)
          if(!options.toVm||!body.path)throw new HttpError(403,'本轮未开放虚拟机文件传输','browser_vm_unavailable')
          return options.toVm(file,body.path,body.overwrite)
        }
        let action:unknown,upload:Record<string,unknown>|undefined
        if(name==='managed_browser_upload'||name==='managed_browser_upload_vm'){
          const body=z.object({fileId:z.string().optional(),path:z.string().optional(),snapshotId:z.string().uuid(),ref:z.string()}).strict().parse(args)
          let file:BrowserUpload
          if(name==='managed_browser_upload'){if(!body.fileId||body.path)throw new HttpError(400,'请选择附件编号','browser_upload_invalid');file=await options.upload(body.fileId)}
          else{if(!body.path||body.fileId||!options.fromVm)throw new HttpError(403,'本轮未开放虚拟机文件传输','browser_vm_unavailable');file=await options.fromVm(body.path)}
          const id=randomUUID();upload={id,name:file.name,mimeType:file.mimeType,data:file.buffer.toString('base64')};action={kind:'upload',snapshotId:body.snapshotId,ref:body.ref,fileId:id}
        }else if(name==='managed_browser_snapshot')action={kind:'snapshot'}
        else if(name==='managed_browser_action')action=z.object({action:z.record(z.string(),z.unknown())}).strict().parse(args).action
        else throw new HttpError(403,'本轮未授权此浏览器工具','browser_tool_forbidden')
        const value=await this.request(g,'execute',{operation:{generation:r.state.generation,operationId:callId??randomUUID(),action},...(upload?{upload}:{})})
        if(name==='managed_browser_action'&&!['snapshot','screenshot','downloads','state'].includes(String((action as {kind?:unknown})?.kind)))await this.request(g,'status')
        if(value?.mimeType==='image/png'&&typeof value.data==='string')return {content:[{type:'image',mimeType:'image/png',data:value.data},{type:'text',text:JSON.stringify({width:value.width,height:value.height,generation:value.generation})}]}
        return value
      })
      failure=undefined;notify(r)
      if(r.notes){const notes=r.notes;r.notes=undefined;return {result,humanNote:notes,instruction:'用户刚交还浏览器；重新读取页面后继续。'}}
      return result
      }catch(error){failure=error instanceof Error?error.message:'浏览器操作失败';notify(r);throw error}
    }}
  }
  router(){
    const router=new Router(),matches=(ctx:{query:Record<string,unknown>})=>ctx.query.backend==='managed-browser'
    router.get('/api/app/agents/:id/managed-browser',async ctx=>{const owner=this.auth.require(ctx).id;this.store.require(owner,'agent',ctx.params.id);ctx.set('Cache-Control','no-store');ctx.body=await this.state(owner,ctx.params.id)})
    router.post('/api/app/agents/:id/managed-browser/prepare',async ctx=>{const owner=this.auth.require(ctx).id,body=parse(z.object({retry:z.boolean().default(false)}).strict(),(ctx.request as any).body??{});ctx.body=await this.prepare(owner,ctx.params.id,body.retry)})
    router.get('/api/app/agents/:id/computer',async(ctx,next)=>{if(!matches(ctx))return next();const r=this.resource(this.auth.require(ctx).id,ctx.params.id);await this.view(r,g=>this.request(g,'status'));ctx.body=this.controlStatus(r)})
    router.get('/api/app/agents/:id/computer/frame',async(ctx,next)=>{if(!matches(ctx))return next();const r=this.resource(this.auth.require(ctx).id,ctx.params.id);const shot=await this.view(r,g=>this.request(g,'execute',{operation:{generation:r.state.generation,operationId:randomUUID(),action:{kind:'screenshot'}}}));r.frame={id:shot.frameId,generation:shot.generation,data:shot.data,width:shot.width,height:shot.height,capturedAt:shot.createdAt};r.frames??=new Map();const {data:_data,...metadata}=r.frame;r.frames.set(metadata.id,metadata);for(const [id,frame] of r.frames)if(frame.capturedAt<Date.now()-30000||r.frames.size>32)r.frames.delete(id);ctx.set('Cache-Control','no-store');ctx.body=r.frame})
    router.post('/api/app/agents/:id/computer/take',async(ctx,next)=>{
      if(!matches(ctx))return next()
      const r=this.resource(this.auth.require(ctx).id,ctx.params.id),body=parse(z.object({requestId:z.string().uuid()}).strict(),(ctx.request as any).body)
      ctx.body=await this.transition(r,async()=>{
      await this.view(r,g=>this.request(g,'status'))
      if(r.state.available===false)throw new HttpError(409,'浏览器环境尚未就绪，请先等待自动准备完成','browser_preparing')
      if(r.human&&r.human.expiresAt>Date.now()){
        this.check(r.human)
        if(r.human.requestId!==body.requestId)throw new HttpError(409,'浏览器已由另一页面接管','browser_control_busy')
        if(r.taking)await r.taking
        if(!r.human)throw new HttpError(409,'接管未完成，请重新接管','browser_control_expired')
        return {...this.controlStatus(r),controlId:r.human.id,token:this.nodes.open(r.human.sealedToken!),expiresAt:r.human.expiresAt}
      }
      if(r.human)this.grants.delete(r.human.id)
      const token=randomBytes(32).toString('base64url'),g=this.grant(r,'human',()=>{},undefined,Date.now()+30000)
      Object.assign(g,{requestId:body.requestId,tokenHash:digest(token),sealedToken:this.nodes.seal(token)});r.human=g;r.paused=true
      r.taking=(async()=>{await this.request(g,'pause');await this.request(g,'open');r.frame=undefined;r.frames?.clear();r.notify?.()})()
      try{await r.taking;r.parked=false;r.taking=undefined;return {...this.controlStatus(r),controlId:g.id,token,expiresAt:g.expiresAt}}
      catch(error){this.grants.delete(g.id);if(r.human===g)r.human=undefined;r.notify?.();throw error}
      finally{r.taking=undefined}
      })
    })
    router.post('/api/app/agents/:id/computer/renew',(ctx,next)=>{if(!matches(ctx))return next();const g=this.token(this.auth.require(ctx).id,ctx.params.id,(ctx.request as any).body);g.expiresAt=Date.now()+30000;ctx.body={expiresAt:g.expiresAt}})
    const input=async(owner:string,id:string,raw:unknown,navigation:boolean)=>{
      const body=parse(credentials.extend({requestId:z.string().uuid(),generation:z.number().int().positive(),frameId:z.string().uuid().optional(),action:z.record(z.string(),z.unknown())}).strict(),raw),g=this.token(owner,id,body),r=g.resource
      return this.journal.execute(owner,g.id,body.requestId,'managed_browser_human_input',{generation:body.generation,frameId:body.frameId,action:body.action,navigation},()=>{this.token(owner,id,body)},async()=>{
      if(r.taking||r.transition)throw new HttpError(409,'请等待当前操作结束后接管','browser_control_pending')
      if(body.generation!==r.state.generation)throw new HttpError(409,'控制代次已改变，请刷新','browser_generation_expired')
      let action=body.action
      if(!navigation){
        const frame=r.frames?.get(body.frameId??'')
        if(!frame||frame.generation!==body.generation||frame.capturedAt<Date.now()-30000)throw new HttpError(409,'画面已改变，请刷新后操作','browser_frame_stale')
        const a=body.action
        if(a.kind==='click')action={kind:'coordinate',x:a.x,y:a.y,...(a.button?{button:a.button}:{}),...(a.count?{clickCount:a.count}:{})}
        else if(a.kind==='key'){
          const names:Record<string,string>={Return:'Enter',BackSpace:'Backspace',Up:'ArrowUp',Down:'ArrowDown',Left:'ArrowLeft',Right:'ArrowRight',space:'Space'}
          const modifiers=z.array(z.enum(['ctrl','alt','shift','super'])).max(4).parse(a.modifiers??[]),key=z.string().max(40).parse(a.key)
          action={kind:'key',key:[...modifiers.map(m=>({ctrl:'Control',alt:'Alt',shift:'Shift',super:'Meta'})[m]),names[key]??key].join('+')}
        }else if(a.kind==='scroll'){
          const direction=z.enum(['up','down','left','right']).parse(a.direction),amount=z.number().int().min(1).max(50).parse(a.amount??3)*80
          action={kind:'scroll',deltaX:direction==='left'?-amount:direction==='right'?amount:0,deltaY:direction==='up'?-amount:direction==='down'?amount:0}
        }else if(a.kind!=='text')throw new HttpError(422,'托管浏览器暂不支持此输入','browser_input_unsupported')
      }
      const value=await this.request(g,'execute',{operation:{generation:body.generation,operationId:body.requestId,action}});r.frame=undefined;r.frames?.clear();return value
      })
    }
    router.post('/api/app/agents/:id/computer/input',async(ctx,next)=>{if(!matches(ctx))return next();ctx.body=await input(this.auth.require(ctx).id,ctx.params.id,(ctx.request as any).body,false)})
    router.post('/api/app/agents/:id/managed-browser/action',async ctx=>{ctx.body=await input(this.auth.require(ctx).id,ctx.params.id,(ctx.request as any).body,true)})
    router.post('/api/app/agents/:id/computer/giveback',async(ctx,next)=>{
      if(!matches(ctx))return next()
      const owner=this.auth.require(ctx).id,body=parse(credentials.extend({notes:z.string().max(4000).default('')}).strict(),(ctx.request as any).body),g=this.token(owner,ctx.params.id,body),r=g.resource
      ctx.body=await this.transition(r,async()=>{
      this.token(owner,ctx.params.id,body)
      // Keep the manual grant alive until the runner confirms the generation handoff.
      if(r.task)await this.request(r.task,'resume')
      else await this.rest(r,true)
      r.notes=body.notes;r.human=undefined;r.paused=false;r.frame=undefined;r.frames?.clear();this.grants.delete(g.id)
      r.notify?.()
      return this.controlStatus(r)
      })
    })
    router.post('/api/app/agents/:id/managed-browser/close',async ctx=>{
      const owner=this.auth.require(ctx).id,body=parse(credentials,(ctx.request as any).body),g=this.token(owner,ctx.params.id,body),r=g.resource
      ctx.body=await this.transition(r,async()=>{
        this.token(owner,ctx.params.id,body)
        if(r.task)throw new HttpError(409,'机器人任务仍在使用浏览器，请先停止任务','browser_busy')
        await this.rest(r,false)
        this.grants.delete(g.id);r.human=undefined;r.paused=false;r.notes=undefined;r.notify?.()
        return this.controlStatus(r)
      })
    })
    return router
  }
  private async sweep(){
    for(const r of this.resources.values()){
      try{this.checkResource(r)}catch{this.retire(r);continue}
      if(r.task){try{this.check(r.task)}catch{this.grants.delete(r.task.id);r.task=undefined;r.forceClose=true;this.dropSession(r)}}
      if(r.human){let valid=true;try{this.check(r.human)}catch{valid=false}if(!valid){
        this.grants.delete(r.human.id);r.human=undefined;r.paused=!!r.task;r.frame=undefined;r.frames?.clear()
        if(!r.task)await this.transition(r,async()=>{if(!r.task&&!r.human)await this.rest(r,true)}).catch(()=>{})
      }}
      if(r.preparation){try{this.check(r.preparation)}catch{this.grants.delete(r.preparation.id);r.preparation=undefined}}
      if(r.session&&!r.task&&!r.human&&!r.transition&&!r.refreshing&&Date.now()>=(r.nextStatusAt??0)){
        r.nextStatusAt=Date.now()+30000
        r.refreshing=this.transition(r,async()=>{if(!r.task&&!r.human&&r.session)await this.view(r,g=>this.request(g,'status'))})
          .then(()=>{},()=>this.retire(r)).finally(()=>{r.refreshing=undefined})
      }
      r.notify?.()
    }
  }
  close(){this.closed=true;clearInterval(this.timer);this.grants.clear();this.resources.clear()}
}
