import {randomUUID,createHash} from 'node:crypto'
import {join,dirname,posix} from 'node:path'
import {fileURLToPath} from 'node:url'
import {mkdir,rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import type {DatabaseSync} from 'node:sqlite'
import {z} from 'zod'
import {HttpError} from '../../server/errors.js'
import type {GatewayFrame,GatewayTarget} from '../../server/workspaceGateway.js'
import {ProfileComputerSession} from './profileSession.js'
import {UNCONFIGURED_COMPUTER_IMAGE} from '../../shared/runner.js'
import type {RunnerConfiguration} from '../../shared/runner.js'
import {ContainerComputerProvider,ComputerError,COMPUTER_WORKSPACE,CUA_DRIVER,CUA_SOCKET,type ComputerSpecification} from '../computers/container.js'
import {ComputerPool,type ComputerLease} from '../computers/pool.js'
import {needsVmLease,softComputerFailure} from '../computers/computerFailures.js'
import {ComposeComputerProvider} from '../computers/compose.js'
import {COMPOSE_DESKTOP_IMAGE,type DesktopRelay} from '../../shared/composeDesktops.js'
import {ComputerControls} from './control.js'
import {ComputerPublicProxy} from '../network/computerProxy.js'
import {HermesWorkerProcess,type WorkerModel,type WorkerProxyEnvironment,type WorkerContextConfiguration,type WorkerTool,type WorkerFrame} from './process.js'
import {HOST_TOOLS,hostTool,hostPath} from './hostTools.js'
import {ProfileSkillSession,SKILL_TOOLS,SKILL_RULES} from './skills.js'
import {homedir,platform} from 'node:os'
import {VM_FILE_TRANSFER_SCRIPT} from './fileTransfer.js'
import {FileTransferFiles} from '../../shared/fileTransferEndpoint.mjs'
import {copyBetweenEndpoints} from '../../server/fileTransfer.js'

export interface ComputerTarget {environmentId:string;ownerKey:string;agentId:string;hostAccess?:boolean;profileSession?:boolean;hermesRuntime?:boolean;fileTransferMaxBytes?:number}
export interface WorkerSession {agentId?:string;id:string;profile:string;ownerKey:string;environmentId:string;cwd:string;configuredCwd:string;history:any[];outcome?:'complete'|'failed'|'uncertain';vmExecution?:'profile';profileSessionId?:string;hermesRuntime?:boolean}
interface Live {toolsOnly?:boolean;workMarker?:string;paused?:boolean;desktop?:{width:number;height:number};pauseJob?:Promise<void>;segment?:number;toolCalls:Set<Promise<unknown>>;journal:Map<string,{name:string;result:unknown}>;proxyHandle?:ProxyHandle;session:WorkerSession;model:WorkerModel;contextConfig?:WorkerContextConfiguration;proxyEnv?:WorkerProxyEnvironment;lease?:ComputerLease;acquiring?:Promise<ComputerLease>;controller:AbortController;worker?:HermesWorkerProcess;finishing?:Promise<void>;stopping?:Promise<void>;releasing?:Promise<void>;images:any[];running:boolean;received:boolean}
const object=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false})
const text={type:'string'}
const TOOLS:WorkerTool[]=[
  {name:'computer_export',description:'将隔离电脑中的文件作为可下载附件回传当前会话，最大 25 MiB。',inputSchema:object({path:text,name:text},['path'])},
  {name:'computer_shell',description:'在当前隔离电脑和 Profile 工作目录执行 shell 命令。默认使用 cua 用户；只有安装系统软件或修改系统路径时才选择 root。',inputSchema:object({command:text,user:{type:'string',enum:['cua','root'],default:'cua'}},['command'])},
  {name:'computer_read_file',description:'读取隔离电脑内的 UTF-8 文本文件。',inputSchema:object({path:text},['path'])},
  {name:'computer_write_file',description:'向隔离电脑写入 UTF-8 文本文件。',inputSchema:object({path:text,content:text},['path','content'])},
  {name:'computer_desktop_state',description:'查看虚拟环境的真实桌面，返回截图和宽高。操作前必须先看。',inputSchema:object({},[])},
  {name:'computer_action',description:'操作虚拟环境桌面。必须先查看桌面。kind 为 click、text、key 或 scroll，坐标用截图像素。',inputSchema:object({kind:{enum:['click','drag','text','key','scroll']},x:{type:'integer'},y:{type:'integer'},fromX:{type:'integer'},fromY:{type:'integer'},toX:{type:'integer'},toY:{type:'integer'},button:{enum:['left','right','middle']},count:{type:'integer'},text:text,key:text,modifiers:{type:'array',items:{enum:['ctrl','alt','shift','super']}},direction:{enum:['up','down','left','right']},amount:{type:'integer'}},['kind'])},
]
const pathField=z.string().min(1).max(4096).refine(value=>!value.includes('\0'))
const desktopAction=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('click'),x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),button:z.enum(['left','right','middle']).default('left'),count:z.number().int().min(1).max(2).default(1)}).strict(),
 z.object({kind:z.literal('drag'),fromX:z.number().int().nonnegative(),fromY:z.number().int().nonnegative(),toX:z.number().int().nonnegative(),toY:z.number().int().nonnegative()}).strict(),
 z.object({kind:z.literal('text'),text:z.string().max(16000)}).strict(),
 z.object({kind:z.literal('key'),key:z.string().min(1).max(40).regex(/^[A-Za-z0-9_+ -]+$/),modifiers:z.array(z.enum(['ctrl','alt','shift','super'])).max(4).default([])}).strict(),
 z.object({kind:z.literal('scroll'),direction:z.enum(['up','down','left','right']),amount:z.number().int().min(1).max(50).default(3)}).strict(),
])
const PROFILE_COMPUTER_RULES='当前使用本机协作模式：沿用基础 Profile 的本机工具、配置和上下文，本地虚拟机是独立的 Linux 电脑。computer_shell/read_file/write_file/desktop_state/action/export 只操作虚拟机；本机文件、终端和程序使用 Profile 已授权的原生工具。computer_copy_file 在两个环境间显式复制文件。调用前明确目标环境，文件路径和浏览器登录互不通用；需要回传虚拟机文件时使用 computer_export。人工接管期间停止操作，交还后先检查当前状态。'
const HERMES_COMPUTER_RULES='本轮由 Hermes 管理模型、配置、识图、技能和授权资源。使用 Hermes 原生 skills_list、skill_view 和 skill_manage 发现、读取和维护技能；遵循当前 Profile 的技能规则。技能依赖本机登录态、环境变量或授权文件时，使用 Hermes 原生工具完成相应步骤；适合 Linux 的脚本与输入文件可经 computer_copy_file 传入虚拟机，再用 computer_shell 执行。路径、软件和登录态在本机与虚拟机之间不通用。不要自行复制 Profile 配置或凭据到虚拟机。'
const ISOLATED_COMPUTER_RULES='当前环境是虚拟环境，也就是服务端上的隔离虚拟机。先看 computer_desktop_state，再按截图像素用 computer_action 点击、输入、按键或滚动。命令和文件也通过 computer_* 在这台 Linux 电脑内部完成。不要使用服务器或已连接电脑的终端、文件或桌面，也不要在节点离线时改去服务器或电脑。电脑和云虚拟机是另外勾选的环境，不从这台虚拟机里打开。人工接管期间停止操作，交还后先检查当前状态。'
const ISOLATED_HERMES_RULES='本轮由 Hermes 管理模型、配置和这次会话。使用 Hermes 原生 skills_list、skill_view 和 skill_manage 发现、读取和维护技能。技能和 computer_* 都留在这台虚拟机里；不要把 Profile 的本机登录、文件或凭据复制进来。'
export interface ProxyHandle {readonly proxy:ComputerPublicProxy;release():Promise<void>}
export class ComputerRuntime {
  retainDesktops=false
  readonly controls:ComputerControls
  readonly provider:ContainerComputerProvider
  readonly pool:ComputerPool
  readonly ready:Promise<void>
  readonly config:NonNullable<RunnerConfiguration['computers']>
  readonly gateways=new Map<string,Set<ComputerGateway>>()
  readonly workers=new Map<string,{environmentId:string;ownerKey:string;process:HermesWorkerProcess}>()
  readonly script:string
  readonly proxyScript:string
  private proxyShares=new Map<string,{started:Promise<ComputerPublicProxy>;users:number}>()
  constructor(readonly db:DatabaseSync,config:RunnerConfiguration,readonly home:string,script?:string,relay?:DesktopRelay,readonly hermesTarget?:GatewayTarget){
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
    db.exec('CREATE TABLE IF NOT EXISTS computer_image_bindings(id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,image_id TEXT NOT NULL)')
    this.controls=new ComputerControls(this)
    this.ready=this.pool.recover();void this.ready.catch(()=>{})
  }
  attachGateway(gateway:ComputerGateway){let gateways=this.gateways.get(gateway.meta.environmentId);if(!gateways){gateways=new Set();this.gateways.set(gateway.meta.environmentId,gateways)}gateways.add(gateway)}
  detachGateway(gateway:ComputerGateway){const gateways=this.gateways.get(gateway.meta.environmentId);if(gateways){gateways.delete(gateway);if(!gateways.size)this.gateways.delete(gateway.meta.environmentId)}}
  activeGateways(environmentId:string):ComputerGateway[]{return [...(this.gateways.get(environmentId)??[])].filter(gateway=>gateway.active||gateway.paused)}
  /** One guest proxy per environment, shared by every holder; the guest
   * reserves port 3128, so concurrent holders must never start their own. */
  acquireProxy(spec:ComputerSpecification,authorize:()=>void):Promise<ProxyHandle>{
    let share=this.proxyShares.get(spec.id)
    if(!share){
      const started=ComputerPublicProxy.start(this.provider,spec,this.proxyScript,authorize,async()=>authorize(),()=>{if(this.proxyShares.get(spec.id)===share)this.proxyShares.delete(spec.id)})
      share={started,users:0};this.proxyShares.set(spec.id,share)
      void started.catch(()=>{if(this.proxyShares.get(spec.id)===share)this.proxyShares.delete(spec.id)})
    }
    return share.started.then(proxy=>{
      share!.users++
      let released=false
      return {proxy,release:async()=>{
        if(released)return;released=true
        const current=this.proxyShares.get(spec.id)
        if(current===share&&--share!.users>0)return
        if(current===share)this.proxyShares.delete(spec.id)
        await proxy.close().catch(()=>{})
      }}
    })
  }
  assertTarget(meta:ComputerTarget){if(this.db.prepare('SELECT id FROM retired_computers WHERE id=?').get(meta.environmentId))throw new HttpError(410,'临时电脑已退役','computer_retired')}
  imageFor(meta:ComputerTarget):string {
    const spec=this.pool.definition(meta.ownerKey,meta.environmentId)
    const binding=this.db.prepare('SELECT owner_key,image_id FROM computer_image_bindings WHERE id=?').get(meta.environmentId) as {owner_key:string;image_id:string}|undefined
    if(binding&&binding.owner_key!==meta.ownerKey)throw new HttpError(403,'电脑归属不匹配','computer_owner_mismatch')
    return spec?.imageId??binding?.image_id??this.config.imageId
  }
  async retire(meta:ComputerTarget){
    const old=this.db.prepare('SELECT owner_key,spec FROM retired_computers WHERE id=?').get(meta.environmentId) as {owner_key:string;spec?:string}|undefined
    if(old&&old.owner_key!==meta.ownerKey)throw new HttpError(403,'电脑归属不匹配','computer_owner_mismatch')
    this.pool.definition(meta.ownerKey,meta.environmentId)
    this.db.prepare('INSERT OR IGNORE INTO retired_computers VALUES(?,?,NULL)').run(meta.environmentId,meta.ownerKey)
    await Promise.all([...this.workers.values()].filter(worker=>worker.environmentId===meta.environmentId&&worker.ownerKey===meta.ownerKey).map(worker=>worker.process.close()))
    const current=this.pool.status(meta.ownerKey).find(row=>row.environmentId===meta.environmentId)
    for(const holderId of current?.holderIds??[])await this.pool.stopHolder(meta.ownerKey,meta.environmentId,holderId)
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
    if((session.vmExecution==='profile')!==(meta.profileSession===true))throw new HttpError(409,'虚拟机执行方式已改变，请使用新会话','computer_session_mode_changed')
    return session
  }
  async resolve(profile:string,signal?:AbortSignal){
    if(this.hermesTarget)throw new HttpError(409,'模型配置由 Hermes 会话管理','computer_hermes_owned')
    return this.resolveProfile(profile,'resolve',signal)
  }
  async resolveWorkspace(profile:string,signal?:AbortSignal){
    // VM paths belong to the VM. A Profile's host cwd is resolved by Hermes.
    if(this.hermesTarget)return {type:'resolved',cwd:COMPUTER_WORKSPACE,configuredCwd:'.'}
    return this.resolveProfile(profile,'resolve-workspace',signal)
  }
  async extractMemory(profile: string, prompt: string, signal?: AbortSignal): Promise<string> {
    if(this.hermesTarget){
      signal?.throwIfAborted()
      const response=await this.hermesTarget.session.request('/api/plugins/yaoyao-bot-bridge/memory-extract',{method:'POST',search:new URLSearchParams({profile}),body:{profile,prompt},maxResponseBytes:1024*1024})
      signal?.throwIfAborted()
      let value:any;try{value=JSON.parse(response.body.toString())}catch{}
      if(response.status!==200||typeof value?.text!=='string')throw new HttpError(409,'Hermes 记忆提炼接口不可用，请更新对应 Profile 的夭夭工具桥。','memory_extraction_unavailable')
      return value.text
    }
    const resolved = await this.resolve(profile, signal)
    const directory = join(this.home, 'memory-extraction', randomUUID())
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const worker = new HermesWorkerProcess(this.config.python, this.script, {
      mode: 'run', home: directory, hermesSource: this.config.hermesSource, model: resolved.model,
      contextConfig: resolved.contextConfig, proxyEnv: resolved.proxyEnv, sessionId: randomUUID(), taskId: randomUUID(),
      cwd: directory, network: 'none', tools: [], prompt, history: [],
    })
    const abort = () => { void worker.close() }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      const result = await worker.wait('complete', 90000)
      if (result.completed !== true || result.interrupted) throw new HttpError(502, '记忆提炼未完成', 'memory_extraction_failed')
      return String(result.text ?? '')
    } finally { signal?.removeEventListener('abort', abort); await worker.close(); await rm(directory, { recursive: true, force: true }) }
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
    await this.pool.desktop({id:meta.environmentId,ownerKey:meta.ownerKey,imageId:this.imageFor(meta),cwd:meta.environmentId!==meta.agentId?(this.pool.definition(meta.ownerKey,meta.environmentId)?.cwd??COMPUTER_WORKSPACE):resolved.cwd,network:this.config.network??'none'},action,authorize)
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
  private hostCwd=homedir()
  private profileSession?:ProfileComputerSession
  private skillSession?:ProfileSkillSession
  private hostTransfers?:FileTransferFiles
  private usedVmTransfers=false
  private transferNamespace(live:Live){return createHash('sha256').update(`${this.meta.ownerKey}:${this.meta.environmentId}:${this.workId}:${live.session.id}`).digest('hex')}
  private async transferFile(live:Live,action:Record<string,unknown>){
    const cleanup=action.op==='transfer-abort'
    if(live.paused&&!cleanup)throw new HttpError(409,'虚拟机正在等待人工操作','computer_paused')
    await this.authorized();this.guard()
    if(!cleanup&&['pausing','human','resuming','error'].includes((await this.runtime.controls.status(this.meta)).mode))throw new HttpError(409,'虚拟机正在等待人工操作','computer_paused')
    const input=z.object({op:z.enum(['transfer-read-open','transfer-write-open','transfer-read','transfer-append','transfer-finish','transfer-status','transfer-abort']),transferId:z.string().uuid(),path:z.string().min(1).max(4096).optional(),maxBytes:z.number().int().min(1024*1024).max(100*1024*1024).optional(),size:z.number().int().min(0).max(100*1024*1024).optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),overwrite:z.boolean().optional(),offset:z.number().int().min(0).max(100*1024*1024).optional(),data:z.string().max(699052).optional()}).strict().parse(action)
    const lease=await this.ensureLease(live)
    this.usedVmTransfers=true
    return this.runtime.pool.use(lease,async context=>{
      if(live.paused&&!cleanup)throw new HttpError(409,'虚拟机正在等待人工操作','computer_paused')
      const result=await this.runtime.provider.execute(this.spec(live.session),['python3','-c',VM_FILE_TRANSFER_SCRIPT,this.transferNamespace(live)],{...context,input:Buffer.from(JSON.stringify(input))})
      context.authorize();this.guard()
      return JSON.parse(result.stdout)
    })
  }
  private get hermesManaged(){return this.meta.hermesRuntime===true}
  private get rules(){const sharing=this.meta.environmentId!==this.meta.agentId?'多个机器人共用这台虚拟机：命令和文件操作并行执行，桌面操作交替进行；动手前注意其他机器人可能正在使用同一桌面，避免覆盖彼此的工作。':'';if(this.meta.profileSession)return `${sharing}${PROFILE_COMPUTER_RULES}\n${this.hermesManaged?HERMES_COMPUTER_RULES:SKILL_RULES}`;return `${sharing}${ISOLATED_COMPUTER_RULES}\n${this.hermesManaged?ISOLATED_HERMES_RULES:SKILL_RULES}`}
  private team?:{id:string;catalog:WorkerTool[];call(name:string,args:Record<string,unknown>,callId:string):Promise<unknown>;workspaceMemory:boolean}
  constructor(readonly runtime:ComputerRuntime,readonly meta:ComputerTarget,readonly workId:string,readonly check:()=>Promise<void>,readonly publish:(body:Record<string,unknown>)=>Promise<any>,readonly profileTarget?:GatewayTarget){ }
  async connect(){this.runtime.assertTarget(this.meta);await this.runtime.ready;await this.authorized();if(this.hermesManaged&&!this.profileTarget)throw new HttpError(409,'缺少 Hermes 会话连接，不能回退到独立 Worker。','computer_profile_unavailable')}
  private async authorized(){try{await this.check();this.guard()}catch(error){const stopping=this.interrupt().catch(()=>{});if(!this.profileSession)await stopping;if(!this.closed)this.onDisconnect();throw error}}
  private guard(){if(this.closed||this.live?.controller.signal.aborted)throw new HttpError(410,'电脑任务授权已结束','computer_cancelled')}
  private event(type:string,payload:Record<string,unknown>){if(!this.closed&&this.live)this.onEvent({type,session_id:this.live.session.id,payload})}
  private spec(session:WorkerSession):ComputerSpecification{return {id:this.meta.environmentId,ownerKey:this.meta.ownerKey,imageId:this.runtime.imageFor(this.meta),cwd:session.cwd,network:this.runtime.config.network??'none'}}
  async rpc(method:string,params:Record<string,any>):Promise<any>{
    if((method==='session.interrupt'||method==='session.close')&&params.session_id===this.live?.session.id){await this.interrupt();return {status:'interrupted'}}
    if((method==='session.interrupt'||method==='session.close')&&params.session_id===this.recoverySession?.id){await this.runtime.pool.stopHolder(this.meta.ownerKey,this.meta.environmentId,this.workId);return {status:'interrupted'}}
    this.guard()
    if(method==='session.create'||method==='session.resume'){
      if(this.live)throw new HttpError(409,'电脑通道已有会话','computer_session_busy')
      await this.authorized()
      if(method==='session.resume'&&params.recoverOnly===true){const session=this.runtime.session(String(params.session_id),this.meta,String(params.profile));this.recoverySession=session;if(session.profileSessionId){await this.openProfile(session,params);await this.profileSession!.stop()}const resource=this.runtime.pool.status(this.meta.ownerKey).find(item=>item.environmentId===this.meta.environmentId);if(resource?.holderIds.includes(this.workId))await this.runtime.pool.stopHolder(this.meta.ownerKey,this.meta.environmentId,this.workId);return {session_id:session.id,stored_session_id:session.id,running:false,info:{profile_name:session.profile}}}
      const profile=String(params.profile),resolved=this.hermesManaged?{cwd:this.runtime.pool.definition(this.meta.ownerKey,this.meta.environmentId)?.cwd??COMPUTER_WORKSPACE,configuredCwd:'.'}:await (this.meta.profileSession?this.runtime.resolveWorkspace(profile,this.controller.signal):this.runtime.resolve(profile,this.controller.signal))
      if(this.meta.hostAccess){const configured=String(resolved.configuredCwd??'.');this.hostCwd=['.','auto','cwd'].includes(configured)?homedir():hostPath(homedir(),configured)}
      await this.authorized();this.guard()
      const session:WorkerSession=method==='session.resume'?this.runtime.session(String(params.session_id),this.meta,profile):{id:randomUUID(),agentId:this.meta.agentId,ownerKey:this.meta.ownerKey,environmentId:this.meta.environmentId,profile,cwd:resolved.cwd,configuredCwd:resolved.configuredCwd,history:[]}
      if(this.meta.profileSession)session.vmExecution='profile'
      if(this.hermesManaged)session.hermesRuntime=true
      session.cwd=this.meta.environmentId!==this.meta.agentId?(this.runtime.pool.definition(this.meta.ownerKey,this.meta.environmentId)?.cwd??COMPUTER_WORKSPACE):resolved.cwd;session.configuredCwd=resolved.configuredCwd
      // Defer pool.configure/acquire until a computer_* (or skill) tool actually needs the VM.
      const controller=new AbortController()
      this.live={toolsOnly:params.toolsOnly===true,session,controller,model:('model' in resolved?resolved.model:undefined) as WorkerModel,contextConfig:'contextConfig' in resolved?resolved.contextConfig as WorkerContextConfiguration:undefined,proxyEnv:'proxyEnv' in resolved?resolved.proxyEnv as WorkerProxyEnvironment:undefined,images:[],running:false,received:false,toolCalls:new Set(),journal:new Map()}
      this.runtime.save(session);this.runtime.attachGateway(this)
      if(params.toolsOnly===true)return {session_id:session.id,stored_session_id:session.id,running:false,info:{profile_name:profile,tools_only:true}}
      if(this.meta.profileSession||this.hermesManaged){
        try{const opened=await this.openProfile(session,params);return {...opened,session_id:session.id,stored_session_id:session.id}}
        catch(error){await this.interrupt();throw error}
      }
      return {session_id:session.id,stored_session_id:session.id,running:false,info:{profile_name:profile}}
    }
    const live=this.live
    if(method==='computer.transfer'){
      if(!live||params.session_id!==live.session.id)throw new HttpError(403,'文件传输不属于当前电脑会话','computer_session_forbidden')
      const call=this.transferFile(live,z.record(z.string(),z.unknown()).parse(params.action))
      live.toolCalls.add(call);void call.finally(()=>live.toolCalls.delete(call)).catch(()=>{})
      return call
    }
    if(method==='computer.invoke'){
      if(!live||params.session_id!==live.session.id)throw new HttpError(403,'电脑会话不属于当前通道','computer_session_forbidden')
      const name=String(params.name??'')
      if(!TOOLS.some(tool=>tool.name===name))throw new HttpError(403,'本轮未授权该工具','computer_tool_forbidden')
      return this.tool(live,name,params.arguments??{},typeof params.id==='string'&&params.id?params.id:randomUUID())
    }
    if(!live||params.session_id!==live.session.id)throw new HttpError(403,'电脑会话不属于当前通道','computer_session_forbidden')
    if(method==='session.interrupt'||method==='session.close'){await this.interrupt();return {status:'interrupted'}}
    if(this.profileSession){
      if(method==='session.usage')return this.profileSession.rpc(method,params)
      if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')
      await this.authorized()
      if(method==='prompt.submit'){
        if(live.running||live.received)throw new HttpError(409,'电脑会话已经提交过本轮','computer_session_busy')
        if(typeof params.workMarker==='string'&&/^\[yaoyao-run:[0-9a-f-]{36}:[0-9a-f-]{36}\]$/.test(params.workMarker))live.workMarker=params.workMarker
        await this.profileSession.bind();this.guard()
        live.running=true;live.session.outcome='uncertain';this.runtime.save(live.session)
        return this.profileSession.rpc(method,{...params,text:`${this.rules}\n${String(params.text??'')}`})
      }
      return this.profileSession.rpc(method,params)
    }
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
      await this.ensureLease(live);await this.runtime.pool.use(live.lease!,context=>this.runtime.provider.execute(this.spec(live.session),['python3','-c','import sys,pathlib; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read())',relative],{...context,input:bytes}))
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
  private async openProfile(session:WorkerSession,params:Record<string,unknown>){
    if(!this.profileTarget)throw new HttpError(409,'缺少本机 Profile 连接，请更新执行节点','computer_profile_unavailable')
    if(params.session_id&&!session.profileSessionId)throw new HttpError(409,'本机 Profile 会话尚未建立，请新建会话','computer_profile_session_invalid')
    const native=new ProfileComputerSession(this.profileTarget,session.profile,this.workId,()=>this.guard(),
      ()=>[...TOOLS,...(this.hermesManaged?[]:SKILL_TOOLS),...HOST_TOOLS.filter(tool=>tool.name==='computer_copy_file').map(tool=>({...tool,description:tool.description.replace('25 MiB',`${(this.meta.fileTransferMaxBytes??25*1024*1024)/1024/1024} MiB`)})),...(this.team?.catalog??[])],
      async(name,args)=>{
        const live=this.live
        if(!live||!this.active||live.paused)throw new HttpError(410,'本轮电脑工具已结束或暂停','computer_cancelled')
        const call=this.tool(live,name,args,randomUUID())
        live.toolCalls.add(call);void call.finally(()=>live.toolCalls.delete(call)).catch(()=>{})
        return call
      },this.hermesManaged?{mode:this.meta.profileSession?'profile':'isolated',hostAccess:this.meta.hostAccess===true}:undefined,()=>this.team?.workspaceMemory===true)
    this.profileSession=native
    native.onStoredId=id=>{session.profileSessionId=id;this.runtime.save(session)}
    native.onDisconnect=()=>{void this.interrupt().finally(()=>{if(!this.closed)this.onDisconnect()}).catch(()=>{})}
    native.onEvent=frame=>{
      const live=this.live
      if(!live||this.closed||live.controller.signal.aborted||live.paused||live.received)return
      if(['message.complete','run.completed','run.failed','message.error','error'].includes(frame.type)){
        live.received=true
        live.finishing=this.finishProfile(live,frame)
        void live.finishing.catch(()=>this.lost(live))
      }else this.event(frame.type,frame.type==='session.info'?{...frame.payload,stored_session_id:session.id,session_key:session.id}:frame.payload??{})
    }
    return native.open(session.profileSessionId,params)
  }
  private async finishProfile(live:Live,frame:GatewayFrame){
    await Promise.allSettled([...live.toolCalls]);await this.authorized()
    const payload=frame.payload??{},success=['message.complete','run.completed'].includes(frame.type)&&!payload.error&&!['interrupted','failed','error'].includes(String(payload.status))
    live.session.outcome=success?'complete':'failed';this.runtime.save(live.session)
    await this.release(live,this.runtime.retainDesktops&&success);live.running=false
    if(this.closed||live.controller.signal.aborted)return
    this.event(frame.type,{...payload,...(payload.status==='error'?{status:'failed'}:{})})
  }
  private async startModel(live:Live,prompt:string,history:any[]){
      if(this.hermesManaged)throw new HttpError(409,'Hermes 托管会话不能启动独立 Worker','computer_hermes_owned')
      live.received=false;live.running=true;live.session.outcome='uncertain';live.session.history.push({role:'user',content:prompt});this.runtime.save(live.session)
      const directory=join(this.runtime.home,'workers',live.session.id,this.workId,String(live.segment=(live.segment??0)+1))
      await mkdir(directory,{recursive:true,mode:0o700})
      const worker=new HermesWorkerProcess(this.runtime.config.python,this.runtime.script,{mode:'run',home:directory,hermesSource:this.runtime.config.hermesSource,model:live.model,contextConfig:live.contextConfig,proxyEnv:live.proxyEnv,sessionId:live.session.id,taskId:this.workId,cwd:live.session.cwd,...(this.meta.hostAccess?{host:{cwd:this.hostCwd,platform:platform()}}:{}),network:this.runtime.config.network??'none',tools:[...TOOLS,...SKILL_TOOLS,...(this.meta.hostAccess?HOST_TOOLS.map(tool=>tool.name==='computer_copy_file'?{...tool,description:tool.description.replace('25 MiB',`${(this.meta.fileTransferMaxBytes??25*1024*1024)/1024/1024} MiB`)}:tool):[]),...(this.team?.catalog??[])],skillInstructions:SKILL_RULES,prompt:live.images.length?[{type:'text',text:prompt},...live.images]:prompt,history})
      live.worker=worker
      this.runtime.workers.set(this.workId,{environmentId:this.meta.environmentId,ownerKey:this.meta.ownerKey,process:worker});void worker.exited.then(()=>{if(this.runtime.workers.get(this.workId)?.process===worker)this.runtime.workers.delete(this.workId)})
      worker.onTool=(name,args,id,callId)=>{
        if(live.worker!==worker||live.received)throw new HttpError(410,'本轮 Worker 已结束','computer_worker_finished')
        const task=this.tool(live,name,args,id).then(result=>{if(callId)live.journal.set(callId,{name,result});return result},error=>{if(callId)live.journal.set(callId,{name,result:{error:'操作未完成或已中断'}});throw error})
        live.toolCalls.add(task);void task.finally(()=>live.toolCalls.delete(task)).catch(()=>{});return task
      }
      worker.onEvent=frame=>{
        if(this.closed||live.worker!==worker||live.received||live.controller.signal.aborted)return
        if(frame.type==='checkpoint'&&Array.isArray(frame.messages)){live.session.history=frame.messages;this.runtime.save(live.session);return}
        if(live.paused)return
        if(frame.type==='delta')this.event('message.delta',{text:frame.text})
        if(frame.type==='reasoning')this.event('reasoning.delta',{text:frame.text})
        if(frame.type==='complete'){live.received=true;live.finishing=this.finish(live,frame);void live.finishing.catch(()=>this.lost(live))}
        if(frame.type==='failed')void this.lost(live)
      }
      void worker.exited.then(()=>{if(!live.paused&&!live.received&&live.running&&!this.closed)void this.lost(live)})
  }
  installTeamLease(id:string,catalog:WorkerTool[],call:(name:string,args:Record<string,unknown>,callId:string)=>Promise<unknown>,workspaceMemory=false){this.team={id,catalog,call,workspaceMemory}}
  removeTeamLease(id:string){if(this.team?.id===id)this.team=undefined}
  private ensureLease(live:Live):Promise<ComputerLease>{
    if(live.lease)return Promise.resolve(live.lease)
    live.acquiring??=(async()=>{
      if(this.runtime.imageFor(this.meta)===UNCONFIGURED_COMPUTER_IMAGE)throw new HttpError(409,'请先在应用设置的本地虚拟机页面完成准备','computer_image_required')
      await this.runtime.pool.configure(this.spec(live.session),()=>this.guard())
      await this.authorized()
      const lease=await this.runtime.pool.acquire(this.spec(live.session),this.workId,()=>{this.guard();if(live.controller.signal.aborted)throw new Error('cancelled')},live.controller.signal)
      if(this.closed){await this.runtime.pool.release(lease);throw new Error('电脑通道已关闭')}
      live.lease=lease
      if(this.runtime.config.network==='public-proxy'){
        try{live.proxyHandle=await this.runtime.acquireProxy(this.spec(live.session),()=>{if(!this.runtime.pool.hasHolders(this.meta.ownerKey,this.meta.environmentId))throw new HttpError(403,'电脑任务授权已失效','computer_authorization_revoked')})}
        catch(error){await this.runtime.pool.release(lease).catch(()=>{});live.lease=undefined;throw error}
      }
      this.timer=setInterval(()=>{if(this.checking||!this.live?.lease)return;this.checking=true;void this.authorized().then(()=>this.runtime.pool.renew(this.live!.lease!)).catch(async()=>{await this.interrupt().catch(()=>{});if(!this.closed)this.onDisconnect()}).finally(()=>{this.checking=false})},5000);this.timer.unref()
      return lease
    })().finally(()=>{live.acquiring=undefined})
    return live.acquiring
  }
  private async tool(live:Live,name:string,args:unknown,id:string):Promise<unknown>{
    if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')
    await this.authorized();this.guard()
    if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')
    this.event('tool.started',{tool_id:id,name})
    try{
      const team=this.team?.catalog.find(tool=>tool.name===name)
      if(team)return await this.team!.call(team.id??name,z.record(z.string(),z.unknown()).parse(args),id)
      if(name.startsWith('host_')&&!this.meta.hostAccess||name==='computer_copy_file'&&!this.meta.hostAccess&&!this.hermesManaged)throw new HttpError(403,'本轮未授权该工具','computer_tool_forbidden')
      if(this.meta.hostAccess&&name.startsWith('host_'))return await hostTool(name,args,{cwd:this.hostCwd,signal:live.controller.signal,authorize:()=>{this.guard();if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')}})
      if((this.meta.hostAccess||this.hermesManaged)&&name==='computer_copy_file'){
        const body=z.object({from:z.enum(['host','vm']),source:pathField,destination:pathField}).strict().parse(args)
        const limit=this.meta.fileTransferMaxBytes??25*1024*1024
        const hostPathValue=body.from==='host'?body.source:body.destination
        this.hostTransfers??=new FileTransferFiles(this.hostCwd,{confined:false})
        const host={host:'server',name:'执行节点本机',path:hostPathValue,chunks:true,call:async(action:Record<string,unknown>)=>{
          await this.authorized();this.guard()
          if(this.hermesManaged)return this.profileSession!.transfer(body.from==='host'?'read':'write',hostPathValue,action)
          const result=await this.hostTransfers!.call({...action,...(action.path?{path:hostPath(this.hostCwd,String(action.path))}:{})},()=>{this.guard();if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')})
          return result.path?{...result,path:hostPathValue}:result
        }}
        const vm={host:'vm',name:'虚拟机',path:body.from==='host'?body.destination:body.source,chunks:true,call:(action:Record<string,unknown>)=>this.transferFile(live,action)}
        await copyBetweenEndpoints(body.from==='host'?host:vm,body.from==='host'?vm:host,limit,true,()=>{this.guard();if(live.paused)throw new HttpError(409,'电脑正在等待人工操作','computer_paused')})
        return {ok:true}
      }
      if(needsVmLease(name,this.team?.catalog.map(tool=>tool.name)??[],SKILL_TOOLS.map(tool=>tool.name))){
        try{await this.ensureLease(live)}
        catch(error){
          if(softComputerFailure(error)){
            const message=error instanceof Error&&error.message?error.message:'电脑环境不可用'
            return {error:message,code:error instanceof HttpError||error instanceof ComputerError?error.code:'computer_unavailable'}
          }
          throw error
        }
      }
      const lease=live.lease
      if(SKILL_TOOLS.some(tool=>tool.name===name)){
        if(!lease)throw new HttpError(409,'电脑环境尚未就绪','computer_unavailable')
        this.skillSession??=new ProfileSkillSession({
          python:this.runtime.config.python,script:this.runtime.script,hermesSource:this.runtime.config.hermesSource,hermesHome:this.runtime.config.hermesHome,
          profile:live.session.profile,ownerKey:this.meta.ownerKey,agentId:this.meta.agentId,taskId:this.workId,signal:live.controller.signal,
          authorize:async()=>{await this.authorized();if(live.paused||live.received)throw new HttpError(410,'本轮技能工具已结束或暂停','computer_cancelled');this.runtime.pool.authorize(lease)},
          execute:(argv,input)=>this.runtime.pool.use(lease,context=>this.runtime.provider.execute(this.spec(live.session),argv,{...context,input})),
          install:(bundle,script)=>this.runtime.pool.use(lease,context=>this.runtime.provider.installSkill(this.spec(live.session),bundle,script,context)),
        })
        return await this.skillSession.call(name,args)
      }
      if(!lease)throw new HttpError(409,'电脑环境尚未就绪','computer_unavailable')
      return await this.runtime.pool.use(lease,async context=>{
        const execute=(argv:string[],input?:Buffer,lane?:'exec'|'gui',user?:'cua'|'root')=>this.runtime.provider.execute(this.spec(live.session),argv,{...context,input,...(lane?{lane}:{}),...(user?{user}:{})})
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
          const body=z.object({command:z.string().min(1).max(65536),user:z.enum(['cua','root']).default('cua')}).strict().parse(args)
          try{return {exitCode:0,...await execute(['/bin/bash','-lc',body.command],undefined,undefined,body.user)}}catch(error){if(typeof(error as any).code==='number')return {exitCode:(error as any).code,stdout:String((error as any).stdout??''),stderr:String((error as any).stderr??'')};throw error}
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
          if(!live.desktop)throw new HttpError(409,'请先查看虚拟环境桌面','computer_frame_stale')
          const frame=live.desktop,action=desktopAction.parse(args),common={scope:'desktop',session:`yaoyao-vm-${live.session.id}`}
          let tool:string,toolArgs:Record<string,unknown>,argv:string[]|undefined
          if(action.kind==='click'){
            if(action.x>=frame.width||action.y>=frame.height)throw new HttpError(400,'点击位置超出画面','computer_point_invalid')
            tool='click';toolArgs={...common,x:action.x,y:action.y,button:action.button,count:action.count}
          }else if(action.kind==='drag'){
            if(action.fromX>=frame.width||action.toX>=frame.width||action.fromY>=frame.height||action.toY>=frame.height)throw new HttpError(400,'拖动位置超出画面','computer_point_invalid')
            tool='drag';toolArgs={}
            argv=['env','DISPLAY=:1','xdotool','mousemove','--sync',String(action.fromX),String(action.fromY),'mousedown','1','mousemove','--sync',String(action.toX),String(action.toY),'mouseup','1']
          }else if(action.kind==='text'){tool='type_text';toolArgs={...common,text:action.text}}
          else if(action.kind==='key'){
            const key=({Return:'enter',BackSpace:'backspace',Escape:'esc'} as Record<string,string>)[action.key]??action.key.toLowerCase()
            tool=action.modifiers.length?'hotkey':'press_key';toolArgs=action.modifiers.length?{...common,keys:[...action.modifiers,key]}:{...common,key}
          }else{tool='scroll';toolArgs={...common,x:Math.floor(frame.width/2),y:Math.floor(frame.height/2),by:'line',direction:action.direction,amount:action.amount}}
          live.desktop=undefined
          const response=await execute(argv??[CUA_DRIVER,'call',tool!,JSON.stringify(toolArgs!),'--socket',CUA_SOCKET],undefined,'gui')
          let parsed:any;try{parsed=JSON.parse(response.stdout)}catch{}
          if(parsed?.code||parsed?.error||parsed?.isError)throw new HttpError(502,'电脑未接受这次输入，请刷新画面后重试','computer_action_failed')
          return {ok:true}
        }
        if(name==='computer_desktop_state'){
          z.object({}).strict().parse(args)
          const path=`/tmp/yaoyao-frame-${randomUUID()}.png`
          const state=await execute([CUA_DRIVER,'call','get_desktop_state','{}','--socket',CUA_SOCKET,'--screenshot-out-file',path],undefined,'gui')
          const data=(await execute(['base64','-w0',path])).stdout.trim()
          const header=Buffer.from(data.slice(0,32),'base64'),width=header.length>=24?header.readUInt32BE(16):0,height=header.length>=24?header.readUInt32BE(20):0
          if(width<1||height<1)throw new HttpError(502,'虚拟环境画面无效','computer_frame_failed')
          live.desktop={width,height}
          return {_multimodal:true,width,height,text_summary:state.stdout,content:[{type:'image_url',image_url:{url:`data:image/png;base64,${data}`}}]}
        }
        throw new HttpError(403,'本轮未授权该工具','computer_tool_forbidden')
      })
    }catch(error){
      if(softComputerFailure(error)){
        const message=error instanceof Error&&error.message?error.message:'电脑环境不可用'
        return {error:message,code:error instanceof HttpError||error instanceof ComputerError?error.code:'computer_unavailable'}
      }
      throw error
    }finally{this.event('tool.completed',{tool_id:id,name})}
  }
  private async finish(live:Live,frame:WorkerFrame){
    if(this.closed||live.paused||live.controller.signal.aborted)return
    await this.authorized()
    if(live.lease)this.runtime.pool.renew(live.lease)
    const contextErrors:Record<string,string>={
      context_compaction_disabled:'模型上下文已超限，基础 Profile 关闭了自动压缩。请开启压缩、缩短输入或新建对话后继续。',
      context_compaction_failed:'模型上下文压缩未能完成，本轮已结束。请缩短输入、检查模型配置或新建对话后继续。',
    }
    const contextError=frame.completed===false&&!frame.interrupted&&Object.hasOwn(contextErrors,String(frame.failureCode))
      ?contextErrors[String(frame.failureCode)]:undefined
    const success=frame.completed!==false&&!frame.interrupted
    // Failed model turns can carry a newly compacted, authoritative history too.
    // A missing history leaves the last durable checkpoint intact.
    if(Array.isArray(frame.messages))live.session.history=frame.messages
    live.session.outcome=success?'complete':'failed'
    this.runtime.save(live.session)
    const keepRunning=this.runtime.retainDesktops&&(success||!!contextError)&&!live.toolCalls.size
    await live.worker?.close()
    await this.release(live,keepRunning)
    live.running=false
    if(this.closed||live.controller.signal.aborted)return
    const error=contextError?contextError+(keepRunning?' 虚拟机已进入空闲，后续按空闲停止设置处理。':''):'隔离 Worker 未完成本轮'
    this.event('message.complete',{text:contextError?error:String(frame.text??''),status:success?'complete':'failed',...(!success?{error,...(contextError?{code:frame.failureCode}:{})}:{})})
  }
  private release(live:Live,keepRunning=false){
    clearInterval(this.timer)
    live.releasing??=(async()=>{
      await this.hostTransfers?.close();this.hostTransfers=undefined
      if(!live.lease){await live.proxyHandle?.release().catch(()=>{});return}
      if(this.usedVmTransfers){
        // Cleanup remains allowed after cancellation, but can only remove this
        // session's staged files in the same VM generation, never a replacement.
        const lease=live.lease
        const authorize=()=>{const state=this.runtime.pool.status(this.meta.ownerKey).find(item=>item.environmentId===lease.environmentId);if(state?.generation!==lease.generation||!state.holderIds.includes(this.workId))throw new Error('文件传输所属虚拟机已变化')}
        await this.runtime.provider.execute(this.spec(live.session),['python3','-c',VM_FILE_TRANSFER_SCRIPT,this.transferNamespace(live)],{authorize,signal:AbortSignal.timeout(5000),timeout:5000,mayFence:()=>false,input:Buffer.from(JSON.stringify({op:'transfer-cleanup'}))}).catch(()=>{})
        this.usedVmTransfers=false
      }
      try{await live.proxyHandle?.release();await this.runtime.pool.release(live.lease,keepRunning)}
      catch(error){await this.runtime.pool.release(live.lease).catch(()=>{});throw error}
    })()
    return live.releasing
  }
  private async lost(live:Live){
    if(!live.running||live.paused||this.closed||live.controller.signal.aborted)return
    live.running=false;await this.interrupt().catch(()=>{});if(!this.closed)this.onDisconnect()
  }
  get active(){return !!this.live&&(this.live.running||this.live.toolsOnly===true&&this.live.toolCalls.size>0)&&!this.live.received&&!this.closed}
  get paused(){return this.live?.paused===true}
  get lease(){return this.live?.lease}
  get specification(){return this.live?this.spec(this.live.session):undefined}
  /** Pauses this turn for a human takeover: settles in-flight operations and
   * records pending tool calls so the model can resume coherently. The pool
   * lease stays — the human acquires a holder of the same shared desktop. */
  async takeControl(controlId:string,authorize:()=>void):Promise<void>{
    const live=this.live
    if(!live||!this.active)throw new HttpError(409,'机器人已不在执行，请重新打开电脑','computer_not_active')
    if(live.pauseJob)await live.pauseJob
    if(!live.paused){live.paused=true;this.event('computer.paused',{stage:'pausing'})}
    live.pauseJob=(async()=>{
      await this.profileSession?.stop()
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
      this.event('computer.paused',{stage:'human',generation:live.lease?.generation})
    })()
    await live.pauseJob
  }
  async giveBack(notes:string):Promise<void>{
    const live=this.live
    if(!live?.paused)throw new HttpError(409,'机器人没有处于接管状态','computer_not_paused')
    await live.pauseJob;await this.authorized()
    live.paused=false;live.pauseJob=undefined;live.journal.clear()
    this.event('computer.resumed',{generation:live.lease?.generation,notes})
    if(live.toolsOnly)return
    if(this.profileSession){
      await this.profileSession.bind();this.guard()
      await this.profileSession.rpc('prompt.submit',{text:`${this.rules}\n用户已交还电脑控制权。请先检查当前状态，避免重复已完成的操作。交还说明：${notes||'无额外说明'}\n${live.workMarker??''}`})
      return
    }
    await this.startModel(live,`用户已完成电脑接管并明确交还控制。请先检查当前电脑状态，再继续原任务；不要重复已完成的副作用。用户说明：${notes||'无额外说明'}\n${live.workMarker??''}`,structuredClone(live.session.history))
  }
  async interrupt(){
    const live=this.live;if(!live)return
    if(live.stopping)return live.stopping
    live.stopping=(async()=>{
      live.controller.abort();clearInterval(this.timer)
      try{await this.profileSession?.stop()}
      finally{
        await this.profileSession?.close();await live.worker?.close()
        try{await this.release(live)}catch(error){if((error as any).code!=='computer_lease_stale')throw error}
        live.running=false
      }
    })()
    return live.stopping
  }
  async stopControl(){await this.interrupt();this.event('message.complete',{text:'电脑控制已结束，本轮已停止',status:'interrupted'})}
  async close(){this.runtime.detachGateway(this);this.closed=true;this.controller.abort();this.team=undefined;clearInterval(this.timer);try{if(this.live?.running||this.live&&!this.live.releasing)await this.interrupt()}finally{await this.profileSession?.close()}}
}
