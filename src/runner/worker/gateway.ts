import {randomUUID} from 'node:crypto'
import {join,dirname,posix} from 'node:path'
import {fileURLToPath} from 'node:url'
import {mkdir,rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import type {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {HttpError} from '../../server/errors.js'
import type {GatewayFrame} from '../../server/workspaceGateway.js'
import {UNCONFIGURED_COMPUTER_IMAGE} from '../../shared/runner.js'
import type {RunnerConfiguration} from '../../shared/runner.js'
import {ContainerComputerProvider,COMPUTER_WORKSPACE,CUA_DRIVER,CUA_SOCKET,type ComputerSpecification} from '../computers/container.js'
import {ComputerPool,type ComputerLease} from '../computers/pool.js'
import {ComposeComputerProvider} from '../computers/compose.js'
import {COMPOSE_DESKTOP_IMAGE,type DesktopRelay} from '../../shared/composeDesktops.js'
import {ComputerControls} from './control.js'
import {ComputerPublicProxy} from '../network/computerProxy.js'
import {HermesWorkerProcess,type WorkerModel,type WorkerTool,type WorkerFrame} from './process.js'

export interface ComputerTarget {environmentId:string;ownerKey:string;agentId:string}
export interface WorkerSession {agentId?:string;id:string;profile:string;ownerKey:string;environmentId:string;cwd:string;configuredCwd:string;history:any[];outcome?:'complete'|'failed'|'uncertain'}
interface Live {workMarker?:string;paused?:boolean;pauseJob?:Promise<ComputerLease>;segment?:number;toolCalls:Set<Promise<unknown>>;journal:Map<string,{name:string;result:unknown}>;proxy?:ComputerPublicProxy;session:WorkerSession;model:WorkerModel;lease:ComputerLease;controller:AbortController;worker?:HermesWorkerProcess;finishing?:Promise<void>;stopping?:Promise<void>;releasing?:Promise<void>;images:any[];running:boolean;received:boolean}
const object=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false})
const text={type:'string'}
const TOOLS:WorkerTool[]=[
  {name:'computer_export',description:'将隔离电脑中的文件作为可下载附件回传当前会话，最大 25 MiB。',inputSchema:object({path:text,name:text},['path'])},
  {name:'computer_shell',description:'在当前隔离电脑和 Profile 工作目录执行 shell 命令。',inputSchema:object({command:text},['command'])},
  {name:'computer_read_file',description:'读取隔离电脑内的 UTF-8 文本文件。',inputSchema:object({path:text},['path'])},
  {name:'computer_write_file',description:'向隔离电脑写入 UTF-8 文本文件。',inputSchema:object({path:text,content:text},['path','content'])},
  {name:'computer_desktop_state',description:'查看隔离电脑当前桌面，返回真实截图。',inputSchema:object({},[])},
  {name:'computer_action',description:'在隔离电脑内调用 CUA 动作；先查看桌面并使用可用动作。',inputSchema:object({name:text,arguments:{type:'object'}},['name','arguments'])},
]
const pathField=z.string().min(1).max(4096).refine(value=>!value.includes('\0'))
export class ComputerRuntime {
  retainDesktops=false
  readonly controls:ComputerControls
  readonly provider:ContainerComputerProvider
  readonly pool:ComputerPool
  readonly ready:Promise<void>
  readonly config:NonNullable<RunnerConfiguration['computers']>
  readonly gateways=new Map<string,ComputerGateway>()
  readonly workers=new Map<string,{environmentId:string;ownerKey:string;process:HermesWorkerProcess}>()
  readonly script:string
  readonly proxyScript:string
  constructor(readonly db:DatabaseSync,config:RunnerConfiguration,readonly home:string,script?:string,relay?:DesktopRelay){
    if(!config.computers)throw new HttpError(409,'执行节点尚未配置隔离电脑','computer_unavailable')
    this.config=config.computers
    this.script=script??join(dirname(fileURLToPath(import.meta.url)),'hermes_worker.py')
    this.proxyScript=existsSync(join(dirname(this.script),'guest_proxy.py'))?join(dirname(this.script),'guest_proxy.py'):join(dirname(this.script),'../network/guest_proxy.py')
    if(this.config.managedBy==='compose'){
      if(!relay)throw new HttpError(409,'缺少 Compose 桌面连接','compose_desktop_unavailable')
      this.config.imageId=COMPOSE_DESKTOP_IMAGE;this.config.network='none'
      this.provider=new ComposeComputerProvider(config.runnerId,home,relay)
    }else this.provider=new ContainerComputerProvider(this.config.runtime,config.runnerId,home)
    this.pool=new ComputerPool(db,this.provider,{concurrent:this.config.maxConcurrent??2,environments:32,ttlMs:30000})
    db.exec('CREATE TABLE IF NOT EXISTS retired_computers(id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,spec TEXT)')
    db.exec('CREATE TABLE IF NOT EXISTS computer_sessions(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
    this.controls=new ComputerControls(this)
    this.ready=this.pool.recover();void this.ready.catch(()=>{})
  }
  assertTarget(meta:ComputerTarget){if(this.db.prepare('SELECT id FROM retired_computers WHERE id=?').get(meta.environmentId))throw new HttpError(410,'临时电脑已退役','computer_retired')}
  async retire(meta:ComputerTarget){
    const old=this.db.prepare('SELECT owner_key,spec FROM retired_computers WHERE id=?').get(meta.environmentId) as {owner_key:string;spec?:string}|undefined
    if(old&&old.owner_key!==meta.ownerKey)throw new HttpError(403,'电脑归属不匹配','computer_owner_mismatch')
    this.pool.definition(meta.ownerKey,meta.environmentId)
    this.db.prepare('INSERT OR IGNORE INTO retired_computers VALUES(?,?,NULL)').run(meta.environmentId,meta.ownerKey)
    await Promise.all([...this.workers.values()].filter(worker=>worker.environmentId===meta.environmentId&&worker.ownerKey===meta.ownerKey).map(worker=>worker.process.close()))
    const current=this.pool.status(meta.ownerKey).find(row=>row.environmentId===meta.environmentId)
    if(current?.holderId)await this.pool.stopHolder(meta.ownerKey,meta.environmentId,current.holderId)
    let spec=old?.spec?JSON.parse(old.spec):undefined
    spec??=this.pool.definition(meta.ownerKey,meta.environmentId)
    if(spec)this.db.prepare('UPDATE retired_computers SET spec=? WHERE id=?').run(JSON.stringify(spec),meta.environmentId)
    await this.pool.retire(meta.ownerKey,meta.environmentId)
    if(spec)await this.provider.deleteWorkspace(spec)
    const sessions=(this.db.prepare('SELECT id,value FROM computer_sessions').all() as {id:string;value:string}[]).filter(row=>{const session=JSON.parse(row.value);return session.environmentId===meta.environmentId&&session.ownerKey===meta.ownerKey})
    for(const row of sessions){if(!/^[0-9a-f-]{36}$/.test(row.id))throw new Error('电脑会话编号无效');await rm(join(this.home,'workers',row.id),{recursive:true,force:true});this.db.prepare('DELETE FROM computer_sessions WHERE id=?').run(row.id)}
    this.db.prepare('UPDATE retired_computers SET spec=NULL WHERE id=?').run(meta.environmentId)
  }
  save(session:WorkerSession){this.db.prepare('INSERT INTO computer_sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(session.id,JSON.stringify(session))}
  session(id:string,meta:ComputerTarget,profile:string):WorkerSession {
    const row=this.db.prepare('SELECT value FROM computer_sessions WHERE id=?').get(id) as {value:string}|undefined
    const session:WorkerSession|undefined=row?JSON.parse(row.value):undefined
    if(!session||(session.agentId??session.environmentId)!==meta.agentId||session.ownerKey!==meta.ownerKey||session.environmentId!==meta.environmentId||session.profile!==profile)throw new HttpError(404,'电脑会话不存在或不属于当前任务','computer_session_missing')
    return session
  }
  async resolve(profile:string,signal?:AbortSignal){
    return this.resolveProfile(profile,'resolve',signal)
  }
  async resolveWorkspace(profile:string,signal?:AbortSignal){
    return this.resolveProfile(profile,'resolve-workspace',signal)
  }
  private async resolveProfile(profile:string,mode:'resolve'|'resolve-workspace',signal?:AbortSignal){
    const resolver=new HermesWorkerProcess(this.config.python,this.script,{mode,profile,defaultCwd:COMPUTER_WORKSPACE,hermesSource:this.config.hermesSource,hermesHome:this.config.hermesHome})
    const abort=()=>{void resolver.close()};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
    try{const result=await resolver.wait('resolved');return this.provider.fixedCapacity?{...result,cwd:COMPUTER_WORKSPACE}:result}finally{signal?.removeEventListener('abort',abort);await resolver.close()}
  }
  async desktop(meta:ComputerTarget,profile:string,action:'create'|'start'|'stop'|'recreate'|'remove',authorize:()=>void){
    if(this.provider.fixedCapacity)throw new HttpError(409,'桌面由 Compose 创建和管理，不能在界面增删或重建','compose_desktop_managed')
    this.assertTarget(meta);authorize()
    // Stopping/removing an existing desktop must remain possible even when
    // its Profile or model was removed or is temporarily misconfigured.
    if(action==='stop'||action==='remove'){
      const spec=this.pool.definition(meta.ownerKey,meta.environmentId)
      if(spec)await this.pool.desktop(spec,action,authorize)
      return
    }
    const resolved=await this.resolveWorkspace(profile);authorize()
    await this.pool.desktop({id:meta.environmentId,ownerKey:meta.ownerKey,imageId:this.config.imageId,cwd:resolved.cwd,network:this.config.network??'none'},action,authorize)
  }
}
export class ComputerGateway {
  onEvent:(frame:GatewayFrame)=>void=()=>{}
  onDisconnect:()=>void=()=>{}
  private live?:Live
  private recoverySession?:WorkerSession
  private closed=false
  private controller=new AbortController()
  private timer?:ReturnType<typeof setInterval>
  private checking=false
  private team?:{id:string;catalog:WorkerTool[];call(name:string,args:Record<string,unknown>,callId:string):Promise<unknown>}
  constructor(readonly runtime:ComputerRuntime,readonly meta:ComputerTarget,readonly workId:string,readonly check:()=>Promise<void>,readonly publish:(body:Record<string,unknown>)=>Promise<any>){ }
  async connect(){this.runtime.assertTarget(this.meta);await this.runtime.ready;await this.authorized()}
  private async authorized(){try{await this.check();this.guard()}catch(error){await this.interrupt().catch(()=>{});if(!this.closed)this.onDisconnect();throw error}}
  private guard(){if(this.closed||this.live?.controller.signal.aborted)throw new HttpError(410,'电脑任务授权已结束','computer_cancelled')}
  private event(type:string,payload:Record<string,unknown>){if(!this.closed&&this.live)this.onEvent({type,session_id:this.live.session.id,payload})}
  private spec(session:WorkerSession):ComputerSpecification{return {id:this.meta.environmentId,ownerKey:this.meta.ownerKey,imageId:this.runtime.config.imageId,cwd:session.cwd,network:this.runtime.config.network??'none'}}
  async rpc(method:string,params:Record<string,any>):Promise<any>{
    if((method==='session.interrupt'||method==='session.close')&&params.session_id===this.live?.session.id){await this.interrupt();return {status:'interrupted'}}
    if((method==='session.interrupt'||method==='session.close')&&params.session_id===this.recoverySession?.id){await this.runtime.pool.stopHolder(this.meta.ownerKey,this.meta.environmentId,this.workId);return {status:'interrupted'}}
    this.guard()
    if(method==='session.create'||method==='session.resume'){
      if(this.live)throw new HttpError(409,'电脑通道已有会话','computer_session_busy')
      await this.authorized()
      if(method==='session.resume'&&params.recoverOnly===true){const session=this.runtime.session(String(params.session_id),this.meta,String(params.profile));this.recoverySession=session;const resource=this.runtime.pool.status(this.meta.ownerKey).find(item=>item.environmentId===this.meta.environmentId);if(resource?.holderId===this.workId)await this.runtime.pool.stopHolder(this.meta.ownerKey,this.meta.environmentId,this.workId);return {session_id:session.id,stored_session_id:session.id,running:false,info:{profile_name:session.profile}}}
      if(this.runtime.config.imageId===UNCONFIGURED_COMPUTER_IMAGE)throw new HttpError(409,'请先在应用设置的本地虚拟机页面完成准备','computer_image_required')
      const profile=String(params.profile),resolved=await this.runtime.resolve(profile,this.controller.signal)
      await this.authorized();this.guard()
      const session:WorkerSession=method==='session.resume'?this.runtime.session(String(params.session_id),this.meta,profile):{id:randomUUID(),agentId:this.meta.agentId,ownerKey:this.meta.ownerKey,environmentId:this.meta.environmentId,profile,cwd:resolved.cwd,configuredCwd:resolved.configuredCwd,history:[]}
      session.cwd=resolved.cwd;session.configuredCwd=resolved.configuredCwd
      await this.runtime.pool.configure(this.spec(session),()=>this.guard())
      await this.authorized()
      const controller=new AbortController(),lease=await this.runtime.pool.acquire(this.spec(session),this.workId,()=>{this.guard();if(controller.signal.aborted)throw new Error('cancelled')},controller.signal)
      if(this.closed){controller.abort();await this.runtime.pool.release(lease);throw new Error('电脑通道已关闭')}
      this.live={session,lease,controller,model:resolved.model as WorkerModel,images:[],running:false,received:false,toolCalls:new Set(),journal:new Map()}
      this.runtime.save(session);this.runtime.gateways.set(this.meta.environmentId,this)
      if(this.runtime.config.network==='public-proxy'){
        const live=this.live
        try{live.proxy=await ComputerPublicProxy.start(this.runtime.provider,this.spec(session),this.runtime.proxyScript,()=>this.runtime.pool.authorize(live.lease),()=>this.authorized(),()=>{void this.interrupt().finally(()=>{if(!this.closed)this.onDisconnect()}).catch(()=>{})})}
        catch(error){await this.interrupt();throw error}
      }
      this.timer=setInterval(()=>{if(this.checking)return;this.checking=true;void this.authorized().then(()=>this.runtime.pool.renew(this.live!.lease)).catch(async()=>{await this.interrupt().catch(()=>{});if(!this.closed)this.onDisconnect()}).finally(()=>{this.checking=false})},5000);this.timer.unref()
      return {session_id:session.id,stored_session_id:session.id,running:false,info:{profile_name:profile}}
    }
    const live=this.live
    if(!live||params.session_id!==live.session.id)throw new HttpError(403,'电脑会话不属于当前通道','computer_session_forbidden')
    if(method==='session.interrupt'||method==='session.close'){await this.interrupt();return {status:'interrupted'}}
    if(method==='session.usage')return {}
    if(method==='session.cwd.set'){
      if(params.cwd!==live.session.cwd&&params.cwd!==live.session.configuredCwd)throw new HttpError(403,'工作目录必须采用基础 Profile 的配置','computer_cwd_forbidden')
      return {cwd:live.session.cwd}
    }
    if(method==='file.attach'||method==='image.attach_bytes'){
      if(live.running)throw new HttpError(409,'当前轮次已开始，不能追加附件','computer_session_busy')
      await this.authorized()
      const name=String(params.name??params.filename??'attachment').replace(/[\/\\\u0000-\u001f]/g,'_').slice(0,200)||'attachment'
      const encoded=method==='image.attach_bytes'?String(params.content_base64??''):String(params.data_url??'').split(',')[1]??''
      const bytes=Buffer.from(encoded,'base64');if(bytes.length>25*1024*1024)throw new HttpError(413,'附件超过 25 MiB','attachment_too_large')
      const relative=`.yaoyao-inputs/${randomUUID()}/${name}`
      await this.runtime.pool.use(live.lease,context=>this.runtime.provider.execute(this.spec(live.session),['python3','-c','import sys,pathlib; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read())',relative],{...context,input:bytes}))
      if(method==='image.attach_bytes'){
        const mime=String(params.mime_type??'image/png')
        if(!/^image\/(?:png|jpeg|webp|gif)$/.test(mime))throw new HttpError(400,'图片格式无效','invalid_image')
        if(JSON.stringify(live.images).length+encoded.length>64*1024*1024)throw new HttpError(413,'本轮图片总量超过限制','image_limit')
        live.images.push({type:'image_url',image_url:{url:`data:${mime};base64,${encoded}`}})
      }
      return {ref_text:`[附件 ${name}](${live.session.cwd}/${relative})`}
    }
    if(method==='prompt.submit'){
      if(live.running||live.received)throw new HttpError(409,'电脑会话已经提交过本轮','computer_session_busy')
      await this.authorized();this.guard()
      if(typeof params.workMarker==='string'&&/^\[yaoyao-run:[0-9a-f-]{36}:[0-9a-f-]{36}\]$/.test(params.workMarker))live.workMarker=params.workMarker
      await this.startModel(live,String(params.text??''),structuredClone(live.session.history))
      return {status:'streaming'}
    }
    throw new HttpError(409,'当前隔离 Worker 不支持此交互','computer_method_unavailable')
  }
  private async startModel(live:Live,prompt:string,history:any[]){
      live.received=false;live.running=true;live.session.outcome='uncertain';live.session.history.push({role:'user',content:prompt});this.runtime.save(live.session)
      const directory=join(this.runtime.home,'workers',live.session.id,this.workId,String(live.segment=(live.segment??0)+1))
      await mkdir(directory,{recursive:true,mode:0o700})
      const worker=new HermesWorkerProcess(this.runtime.config.python,this.runtime.script,{mode:'run',home:directory,hermesSource:this.runtime.config.hermesSource,model:live.model,sessionId:live.session.id,taskId:this.workId,cwd:live.session.cwd,network:this.runtime.config.network??'none',tools:[...TOOLS,...(this.team?.catalog??[])],prompt:live.images.length?[{type:'text',text:prompt},...live.images]:prompt,history})
      live.worker=worker
      this.runtime.workers.set(this.workId,{environmentId:this.meta.environmentId,ownerKey:this.meta.ownerKey,process:worker});void worker.exited.then(()=>{if(this.runtime.workers.get(this.workId)?.process===worker)this.runtime.workers.delete(this.workId)})
      worker.onTool=(name,args,id,callId)=>{
        const task=this.tool(live,name,args,id).then(result=>{if(callId)live.journal.set(callId,{name,result});return result},error=>{if(callId)live.journal.set(callId,{name,result:{error:'操作未完成或已中断'}});throw error})
        live.toolCalls.add(task);void task.finally(()=>live.toolCalls.delete(task)).catch(()=>{});return task
      }
      worker.onEvent=frame=>{
        if(frame.type==='checkpoint'&&Array.isArray(frame.messages)){live.session.history=frame.messages;this.runtime.save(live.session);return}
        if(live.paused)return
        if(frame.type==='delta')this.event('message.delta',{text:frame.text})
        if(frame.type==='reasoning')this.event('reasoning.delta',{text:frame.text})
        if(frame.type==='complete'){live.received=true;live.finishing=this.finish(live,frame);void live.finishing.catch(()=>this.lost(live))}
        if(frame.type==='failed')void this.lost(live)
      }
      void worker.exited.then(()=>{if(!live.paused&&!live.received&&live.running&&!this.closed)void this.lost(live)})
  }
  installTeamLease(id:string,catalog:WorkerTool[],call:(name:string,args:Record<string,unknown>,callId:string)=>Promise<unknown>){this.team={id,catalog,call}}
  removeTeamLease(id:string){if(this.team?.id===id)this.team=undefined}
  private async tool(live:Live,name:string,args:unknown,id:string):Promise<unknown>{
    if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')
    await this.authorized();this.guard()
    if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')
    this.event('tool.started',{tool_id:id,name})
    try{
      const team=this.team?.catalog.find(tool=>tool.name===name)
      if(team)return await this.team!.call(team.id??name,z.record(z.string(),z.unknown()).parse(args),id)
      return await this.runtime.pool.use(live.lease,async context=>{
        const execute=(argv:string[],input?:Buffer)=>this.runtime.provider.execute(this.spec(live.session),argv,{...context,input})
        if(name==='computer_export'){
          const body=z.object({path:pathField,name:z.string().min(1).max(240).optional()}).strict().parse(args)
          const snapshot=`/tmp/yaoyao-export-${randomUUID()}`
          try{
            const metadata=JSON.parse((await execute(['python3','-c','import pathlib,sys,shutil,json,hashlib; p=pathlib.Path(sys.argv[1]); assert p.is_file(),"not a file"; assert p.stat().st_size<=25*1024*1024,"file too large"; shutil.copyfile(p,sys.argv[2]); b=pathlib.Path(sys.argv[2]).read_bytes(); assert len(b)<=25*1024*1024,"file too large"; print(json.dumps({"size":len(b),"digest":hashlib.sha256(b).hexdigest()}))',body.path,snapshot])).stdout)
            await this.publish({phase:'begin',id,name:body.name??posix.basename(body.path),size:metadata.size,digest:metadata.digest})
            for(let offset=0,index=0;offset<metadata.size;offset+=524288,index++){
              context.authorize();await this.authorized()
              const data=(await execute(['python3','-c','import sys,base64; f=open(sys.argv[1],"rb"); f.seek(int(sys.argv[2])); print(base64.b64encode(f.read(524288)).decode())',snapshot,String(offset)])).stdout.trim()
              await this.publish({phase:'append',id,index,data})
            }
            context.authorize();await this.authorized()
            return (await this.publish({phase:'finish',id})).result
          }finally{await execute(['rm','-f','--',snapshot]).catch(()=>{})}
        }
        if(name==='computer_shell'){
          const body=z.object({command:z.string().min(1).max(65536)}).strict().parse(args)
          try{return {exitCode:0,...await execute(['/bin/bash','-lc',body.command])}}catch(error){if(typeof(error as any).code==='number')return {exitCode:(error as any).code,stdout:String((error as any).stdout??''),stderr:String((error as any).stderr??'')};throw error}
        }
        if(name==='computer_read_file'){
          const body=z.object({path:pathField}).strict().parse(args)
          return execute(['python3','-c','import sys; f=open(sys.argv[1],encoding="utf-8"); s=f.read(1000001); assert len(s)<=1000000,"file too large"; print(s,end="")',body.path])
        }
        if(name==='computer_write_file'){
          const body=z.object({path:pathField,content:z.string().max(1000000)}).strict().parse(args)
          await execute(['python3','-c','import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read())',body.path],Buffer.from(body.content));return {ok:true}
        }
        if(name==='computer_action'){
          const body=z.object({name:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/),arguments:z.record(z.string(),z.unknown())}).strict().parse(args)
          return execute([CUA_DRIVER,'call',body.name,JSON.stringify(body.arguments),'--socket',CUA_SOCKET])
        }
        if(name==='computer_desktop_state'){
          z.object({}).strict().parse(args)
          const path=`/tmp/yaoyao-frame-${randomUUID()}.png`
          const state=await execute([CUA_DRIVER,'call','get_desktop_state','{}','--socket',CUA_SOCKET,'--screenshot-out-file',path])
          const data=(await execute(['base64','-w0',path])).stdout.trim()
          return {_multimodal:true,text_summary:state.stdout,content:[{type:'image_url',image_url:{url:`data:image/png;base64,${data}`}}]}
        }
        throw new HttpError(403,'本轮未授权该工具','computer_tool_forbidden')
      })
    }finally{this.event('tool.completed',{tool_id:id,name})}
  }
  private async finish(live:Live,frame:WorkerFrame){
    if(this.closed||live.paused||live.controller.signal.aborted)return
    await this.authorized()
    this.runtime.pool.renew(live.lease)
    const success=frame.completed!==false&&!frame.interrupted
    if(success&&Array.isArray(frame.messages)){live.session.history=frame.messages;live.session.outcome='complete'}else live.session.outcome='failed'
    this.runtime.save(live.session)
    await this.release(live,success&&this.runtime.retainDesktops)
    live.running=false
    if(this.closed||live.controller.signal.aborted)return
    this.event('message.complete',{text:String(frame.text??''),status:success?'complete':'failed',...(!success?{error:'隔离 Worker 未完成本轮'}:{})})
  }
  private release(live:Live,keepRunning=false){clearInterval(this.timer);live.releasing??=(async()=>{await live.proxy?.close();await this.runtime.pool.release(live.lease,keepRunning)})();return live.releasing}
  private async lost(live:Live){
    if(!live.running||live.paused||this.closed||live.controller.signal.aborted)return
    live.running=false;await this.interrupt().catch(()=>{});if(!this.closed)this.onDisconnect()
  }
  get active(){return !!this.live?.running&&!this.live.received&&!this.closed}
  get paused(){return this.live?.paused===true}
  get lease(){return this.live?.lease}
  get specification(){return this.live?this.spec(this.live.session):undefined}
  async takeControl(controlId:string,authorize:()=>void):Promise<ComputerLease>{
    const live=this.live
    if(!live||!this.active)throw new HttpError(409,'Agent 已不在执行，请重新打开电脑','computer_not_active')
    if(live.pauseJob)return live.pauseJob
    live.paused=true;this.event('computer.paused',{stage:'pausing'})
    live.pauseJob=(async()=>{
      await live.worker?.close()
      await Promise.allSettled([...live.toolCalls])
      authorize();this.guard()
      const history=structuredClone(live.session.history),done=new Set(history.filter(message=>message.role==='tool').map(message=>message.tool_call_id))
      for(const message of [...history])for(const tool of message.tool_calls??[])if(!done.has(tool.id)){
        const entry=live.journal.get(tool.id),value=entry?.result??{error:'用户接管时此操作未完成，继续前请检查电脑状态，不要盲目重复'}
        const content=typeof value==='string'?value:JSON.stringify(value)
        history.push({role:'tool',name:tool.function?.name??entry?.name,tool_call_id:tool.id,content});done.add(tool.id)
      }
      live.session.history=history;this.runtime.save(live.session)
      live.lease=await this.runtime.pool.transfer(live.lease,`human:${controlId}`,authorize)
      this.event('computer.paused',{stage:'human',generation:live.lease.generation})
      return live.lease
    })()
    return live.pauseJob
  }
  async giveBack(notes:string):Promise<void>{
    const live=this.live
    if(!live?.paused)throw new HttpError(409,'Agent 没有处于接管状态','computer_not_paused')
    await live.pauseJob;await this.authorized()
    live.lease=await this.runtime.pool.transfer(live.lease,this.workId,()=>this.guard())
    live.paused=false;live.pauseJob=undefined;live.journal.clear()
    this.event('computer.resumed',{generation:live.lease.generation,notes})
    await this.startModel(live,`用户已完成电脑接管并明确交还控制。请先检查当前电脑状态，再继续原任务；不要重复已完成的副作用。用户说明：${notes||'无额外说明'}\n${live.workMarker??''}`,structuredClone(live.session.history))
  }
  async interrupt(){
    const live=this.live;if(!live)return
    if(live.stopping)return live.stopping
    live.stopping=(async()=>{
      live.controller.abort();clearInterval(this.timer)
      await live.worker?.close()
      try{await this.release(live)}catch(error){if((error as any).code!=='computer_lease_stale')throw error}
      live.running=false
    })()
    return live.stopping
  }
  async stopControl(){await this.interrupt();this.event('message.complete',{text:'电脑控制已结束，本轮已停止',status:'interrupted'})}
  close(){if(this.runtime.gateways.get(this.meta.environmentId)===this)this.runtime.gateways.delete(this.meta.environmentId);this.closed=true;this.controller.abort();this.team=undefined;clearInterval(this.timer);return this.interrupt()}
}
