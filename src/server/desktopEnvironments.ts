import Router from '@koa/router'
import type Koa from 'koa'
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
import {HttpError} from './errors.js'
import {parse,type WorkspaceStore} from './workspaceStore.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceNodes,GatewayTarget} from './workspaceGateway.js'
import {type WorkspaceAgent} from '../shared/workspace.js'
import {readHostTools} from './hostToolSettings.js'
import {readComputerNames} from './computerNames.js'
import type {ComputerFrame,ComputerControlStatus} from '../shared/computerControl.js'
import {requireTeamToolBridge} from './workspaceToolLease.js'
import {copyBetweenEndpoints} from './fileTransfer.js'
import type {FileTransferEndpoint} from '../shared/fileTransfer.js'
import {deviceSourceText,deviceInventoryText,type DesktopEnvironmentMetadata,type DesktopEnvironmentSnapshot,type BotDeviceSnapshot,type DeviceCapability,type DeviceCapabilityStatus} from '../shared/botEnvironment.js'

import {desktopHostExchangeSchema} from './desktopHostProtocol.js'

const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
const inputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('click'),x:z.number().int().min(0).max(16384),y:z.number().int().min(0).max(16384),button:z.enum(['left','right','middle']).optional(),count:z.number().int().min(1).max(2).optional()}).strict(),
 z.object({kind:z.literal('drag'),fromX:z.number().int().min(0).max(16384),fromY:z.number().int().min(0).max(16384),toX:z.number().int().min(0).max(16384),toY:z.number().int().min(0).max(16384)}).strict(),
 z.object({kind:z.literal('text'),text:z.string().max(16000)}).strict(),
 z.object({kind:z.literal('key'),key:z.string().regex(/^[A-Za-z0-9_+ -]{1,40}$/),modifiers:z.array(z.enum(['ctrl','alt','shift','super'])).max(4).optional()}).strict(),
 z.object({kind:z.literal('scroll'),direction:z.enum(['up','down','left','right']),amount:z.number().int().min(1).max(50).optional()}).strict(),
])
const browserSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.enum(['navigate','new-tab']),url:z.string().max(4096).refine(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\\\x00-\x20]/.test(value)}catch{return false}},'请输入完整的 http 或 https 地址')}).strict(),
 z.object({kind:z.enum(['select-tab','close-tab']),tabId:z.string().uuid()}).strict(),
 z.object({kind:z.enum(['back','forward','reload','snapshot'])}).strict(),
 z.object({kind:z.enum(['click','fill']),ref:z.string().regex(/^e[0-9]+$/),snapshotId:z.string().uuid(),text:z.string().max(16000).optional()}).strict(),
])
const fileSchema=z.discriminatedUnion('op',[
 z.object({op:z.literal('list'),path:z.string().min(1).max(2048)}).strict(),
 z.object({op:z.literal('read'),path:z.string().min(1).max(2048)}).strict(),
 z.object({op:z.literal('write'),path:z.string().min(1).max(2048),data:z.string().max(14*1024*1024).refine(value=>Buffer.from(value,'base64').toString('base64')===value,'文件内容必须是 base64')}).strict(),
])
const shellSchema=z.object({command:z.string().min(1).max(8000),cwd:z.string().max(2048).optional(),timeoutMs:z.number().int().min(1000).max(120000).optional()}).strict()
const copySchema=z.object({sourceHost:z.string().trim().min(1).max(128),sourcePath:z.string().min(1).max(2048),targetHost:z.string().trim().min(1).max(128),targetPath:z.string().min(1).max(2048),overwrite:z.boolean().default(false)}).strict()
type Mode='local'|'browser'
interface NativeHost {id:string;name:string;platform:string;screen:boolean;accessibility:boolean;approved:string[];full?:string[];fileTransferVersion?:number;environment?:DesktopEnvironmentMetadata}
interface Pending {id:string;epoch:string;deadline:number;command:Record<string,unknown>;check:()=>void;resolve:(v:any)=>void;reject:(e:Error)=>void;sent:boolean;timer:ReturnType<typeof setTimeout>}
interface Manual {ready?:boolean;id:string;token:string;requestId:string;owner:string;agentId:string;version:number;expiresAt:number;generation:number;epoch:string;pending?:Promise<unknown>;releasing?:boolean;actions:Map<string,{fingerprint:string;value:Promise<unknown>}>}
/** All per-host state. The loopback App owns key 'local'; remote Macs each
 *  own the desktop-host id they paired with. */
interface HostState {
  readonly key:string
  readonly remote:boolean
  info?:NativeHost
  seen:number
  readonly pending:Map<string,Pending>
  readonly queue:Map<string,Promise<unknown>>
  readonly manual:Map<string,Manual>
  readonly paused:Set<string>
  readonly frames:Map<string,ComputerFrame>
  readonly generation:Map<string,number>
  readonly notes:Map<string,string>
  readonly activity:Map<string,number>
}
const newHostState=(key:string,remote:boolean):HostState=>({key,remote,seen:0,pending:new Map(),queue:new Map(),manual:new Map(),paused:new Set(),frames:new Map(),generation:new Map(),notes:new Map(),activity:new Map()})
export const DESKTOP_ENVIRONMENT_TOOLS=[
 {id:'desktop_environment_view',name:'desktop_environment_view',description:'查看电脑真实桌面截图，返回截图尺寸、环境类型和电脑名称。仅在需要看窗口、图标布局或做点击输入时使用；列目录、读文件、写文件、跑命令不要先截图。可用 host 指定目标电脑；省略或写「本机」时只使用本轮消息来源电脑；来源未知或离线时必须明确目标，禁止回退。',inputSchema:{type:'object',properties:{host:{type:'string',description:'可选，目标电脑的名称或编号；缺省用本轮消息来源电脑；server 明确指服务器'}},additionalProperties:false}},
 {id:'desktop_environment_action',name:'desktop_environment_action',description:'操作电脑桌面（click、text、key、scroll、drag）。做这些鼠标键盘操作前必须先截图，坐标用刚截到的像素；页面变化后重新截图。列目录和跑命令请用文件/shell 工具，不要用本工具。可用 host 指定目标电脑。',inputSchema:{type:'object',properties:{host:{type:'string'},kind:{enum:['click','drag','text','key','scroll']},x:{type:'integer'},y:{type:'integer'},fromX:{type:'integer'},fromY:{type:'integer'},toX:{type:'integer'},toY:{type:'integer'},button:{enum:['left','right','middle']},count:{type:'integer'},text:{type:'string'},key:{type:'string'},modifiers:{type:'array',items:{enum:['ctrl','alt','shift','super']}},direction:{enum:['up','down','left','right']},amount:{type:'integer'}},required:['kind'],additionalProperties:false}},
 {id:'desktop_file_list',name:'desktop_file_list',description:'列出当前电脑允许范围内的目录内容，返回名称、类型、大小与修改时间。路径相对于用户主目录，例如 Desktop、Documents，或 ~/Desktop。可用 host 指定目标电脑。',inputSchema:{type:'object',properties:{path:{type:'string'},host:{type:'string'}},required:['path'],additionalProperties:false}},
 {id:'desktop_file_read',name:'desktop_file_read',description:'读取当前电脑上的一个文件，返回 base64 内容与大小。路径相对于用户主目录；超出允许范围会被拒绝。可用 host 指定目标电脑。',inputSchema:{type:'object',properties:{path:{type:'string'},host:{type:'string'}},required:['path'],additionalProperties:false}},
 {id:'desktop_file_write',name:'desktop_file_write',description:'把 base64 内容写入当前电脑上的文件（覆盖已存在文件）。路径相对于用户主目录；超出允许范围会被拒绝。可用 host 指定目标电脑。',inputSchema:{type:'object',properties:{path:{type:'string'},data:{type:'string'},host:{type:'string'}},required:['path','data'],additionalProperties:false}},
 {id:'desktop_file_copy',name:'desktop_file_copy',description:'把文件从一台电脑直接复制到另一台电脑，支持电脑之间、电脑与服务器之间、电脑与当前 Bot 虚拟机之间双向传输。填写来源和目标电脑的名称或编号（服务器用 server，当前 Bot 的虚拟机用 vm；本机指本轮消息来源电脑），以及各自用户主目录内的文件路径，例如 Desktop/a.txt。保留来源文件，默认拒绝覆盖目标同名文件；只有用户要求覆盖时才设 overwrite=true。最大 25 MiB，支持二进制文件，写入并校验后返回结果。文件数据由服务器中转，不经过模型或聊天附件。',inputSchema:{type:'object',properties:{sourceHost:{type:'string'},sourcePath:{type:'string'},targetHost:{type:'string'},targetPath:{type:'string'},overwrite:{type:'boolean',default:false}},required:['sourceHost','sourcePath','targetHost','targetPath'],additionalProperties:false}},
 {id:'desktop_shell',name:'desktop_shell',description:'在这台电脑的用户主目录执行一条 shell 命令，返回 stdout、stderr 与退出码。长任务会超时终止；不要用它代替文件工具读写大文件。可用 host 指定目标电脑。',inputSchema:{type:'object',properties:{command:{type:'string'},cwd:{type:'string'},timeoutMs:{type:'integer'},host:{type:'string'}},required:['command'],additionalProperties:false}},
]
export const DESKTOP_FILE_TOOL_IDS=new Set(['desktop_file_list','desktop_file_read','desktop_file_write','desktop_file_copy','desktop_shell'])
export const DESKTOP_FILE_TRANSFER_RULES='电脑间传文件用 desktop_file_copy，一次指定 sourceHost、sourcePath、targetHost、targetPath；服务器用 server，当前 Bot 的虚拟机用 vm，设备名用设置里的名字，「本机」只指本轮消息来源电脑。例：把 mac1 桌面的 a.txt 放到 mac2 桌面，调用 {sourceHost:"mac1",sourcePath:"Desktop/a.txt",targetHost:"mac2",targetPath:"Desktop/a.txt"}。这是复制，保留原文件；只有用户明确要求覆盖时才传 overwrite:true。无需先截图，不要读取 base64 给模型、上传聊天附件或假设不同电脑共享文件路径。最大 25 MiB；工具返回已校验的成功结果后才报告完成。'
/** Macs connected to the server as computers. */
export const DESKTOP_ENVIRONMENT_RULES='操作连接服务器的电脑时，使用本轮提供的 desktop_* 工具，并用 host 指定电脑名称或编号。Hermes 原生终端和文件工具不能代替该电脑上的操作。'
/** Yaoyao host Mac — same look-then-act pattern as the cloud computer. */
export const SERVER_COMPUTER_RULES='操作服务器桌面时，使用本轮提供的 desktop_* 工具并明确指定 host="server"。处理 Hermes 运行环境内的文件与命令时，使用实际提供的原生工具；处理服务器桌面用户主目录内的文件时，使用已授权的 desktop_file_* 或 desktop_shell，不假定两者共享路径。'

/** The loopback native transport is admitted only by serviceInstance's
 *  private capability; remote hosts are admitted by DesktopHostHub's bearer
 *  pairing. Browser/desktop authority never crosses into the renderer. */
export class DesktopEnvironments {
 private readonly sessions=new Map<string,HostState>()
 private authorizing=new Map<string,Promise<unknown>>()
 private toolFrames=new WeakMap<AbortSignal,string>()
 private closed=false
 constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes){}
 private hostOnline(s:HostState){return !this.closed&&!!s.info&&Date.now()-s.seen<(s.remote?15000:8000)}
 get online(){const s=this.sessions.get('local');return !!s&&this.hostOnline(s)}
 get idleForUpdate(){for(const s of this.sessions.values()){for(const key of s.manual.keys())this.current(s,key);if(s.pending.size||s.queue.size||s.manual.size)return false}return true}
 private ownerKey(owner:string){return digest((this.nodes.localNodeID??this.nodes.local.url.toString())+':'+owner)}
 private ready(s:HostState,owner:string){return this.hostOnline(s)&&['darwin','win32'].includes(s.info!.platform)&&s.info!.screen&&s.info!.accessibility&&s.info!.approved.includes(this.ownerKey(owner))}
 /** File and shell grant: a separate approval tier held by the desktop app. */
 private readyFull(s:HostState,owner:string){return this.hostOnline(s)&&['darwin','win32'].includes(s.info!.platform)&&(s.info!.full??[]).includes(this.ownerKey(owner))}
 fileTools(owner:string,agent:WorkspaceAgent){return this.envTools(owner,agent).file}
 private localSession(){let s=this.sessions.get('local');if(!s){s=newHostState('local',false);this.sessions.set('local',s)}return s}
 /** Default session: agent desktopHost binding, else server local.
 *  「本机」 at tool time prefers the user message deviceHost when provided. */
 private computers(){try{const s=readHostTools(this.store.home);return {script:s.scriptMachine,server:s.serverComputer}}catch{return {script:false,server:false}}}
 private names(){try{return readComputerNames(this.store.home)}catch{return {}}}
 private label(s:HostState){const custom=this.names()[s.key];if(s.key==='local')return custom||'服务器';return custom||s.info?.name||''}
 private hostOpen(s:HostState){const g=this.computers();return s.key==='local'?g.server:g.script}
 private sessionFor(agent:WorkspaceAgent):HostState|undefined{
  const g=this.computers()
  if(g.script&&agent.desktopHost&&agent.desktopHost!=='local'){
   const pinned=this.sessions.get(agent.desktopHost)
   if(pinned)return pinned
  }
  if(!g.server)return undefined
  return this.sessions.get('local')
 }
 /** Tool aliases are relative to the triggering message, never to a Bot binding. */
 private namedHost(host:string,deviceHost?:string):HostState{
  if(host==='本机'||host==='local')return this.messageHost(deviceHost)
  if(host==='server'||host==='服务器')return this.requireHost(this.localSession())
  const matches=[...this.sessions.values()].filter(s=>
   s.key===host||
   this.label(s).toLowerCase()===host.toLowerCase()||s.info?.name.toLowerCase()===host.toLowerCase())
  if(matches.length>1)throw new HttpError(409,'电脑名称重复，请使用电脑编号指定目标。','desktop_host_ambiguous')
  const s=matches[0]
  if(!s)throw new HttpError(409,`指定的电脑未连接：${host.slice(0,64)}`,'desktop_host_unknown')
  return this.requireHost(s)
 }
 private requireHost(s:HostState):HostState{
  if(!this.hostOpen(s))throw new HttpError(403,'全局设置未开放这台电脑。','desktop_host_disabled')
  if(!this.hostOnline(s))throw new HttpError(409,'目标电脑已离线，请连接原电脑后重试。','desktop_offline')
  return s
 }
 private messageHost(deviceHost?:string):HostState{
  if(!deviceHost)throw new HttpError(409,'当前消息没有可控制的来源电脑，请指定电脑名称或编号。','desktop_source_required')
  const s=this.sessions.get(deviceHost)
  if(!s)throw new HttpError(409,'消息来源电脑未连接；不会改用其他电脑。','desktop_offline')
  return this.requireHost(s)
 }
 selected(_owner:string,agent:WorkspaceAgent):Mode|undefined {
  if(agent.archived||agent.remoteAgentId)return undefined
  const g=this.computers();return g.script||g.server?'local':undefined
 }
 toolMode(owner:string,agent:WorkspaceAgent):Mode|undefined{return this.selected(owner,agent)}
 modes(owner:string,agent:WorkspaceAgent):{desktop:boolean,browser:boolean}{return {desktop:!!this.selected(owner,agent),browser:false}}
 envTools(owner:string,agent:WorkspaceAgent):{view:boolean,browser:boolean,file:boolean}{
  const snapshot=this.snapshot(owner,agent)
  return {view:snapshot.hosts.some(host=>host.capabilities.view.enabled),browser:false,file:snapshot.hosts.some(host=>host.capabilities.fileRead.enabled)}
 }
 /** Viewer host ids are absolute; the wire id local identifies the server. */
 private takeoverSession(a:WorkspaceAgent,host:unknown):HostState|undefined{
  if(typeof host==='string'&&host)return this.namedHost(host==='local'?'server':host)
  return this.sessionFor(a)
 }
 private targetFor(_agent:WorkspaceAgent,host:unknown,deviceHost?:string):HostState{
  return typeof host==='string'&&host?this.namedHost(host,deviceHost):this.messageHost(deviceHost)
 }
 /** Collect current state without connecting a host, launching a browser or starting a computer. */
 snapshot(owner:string,agent?:WorkspaceAgent,deviceHost?:string,policy?:{script:boolean;server:boolean;maxMiB:number}):DesktopEnvironmentSnapshot {
  const capturedAt=Date.now(),global=policy??{...this.computers(),maxMiB:(()=>{try{return readHostTools(this.store.home).fileTransferMaxMiB}catch{return 25}})()}
  const records=this.store.list<import('../shared/desktopHost.js').DesktopHostRecord>('_system','desktop-host')
  const revoked=new Set(records.filter(record=>!record.enabled).map(record=>record.id))
  const states=[...this.sessions.values()]
  for(const record of records)if(!states.some(host=>host.key===record.id))states.push(newHostState(record.id,true))
  if(deviceHost&&!states.some(host=>host.key===deviceHost))states.push(newHostState(deviceHost,deviceHost!=='local'))
  // Revoked pairings remain stored for reauthorization, not as offline computers.
  // Filter after merging sessions and message origin so neither can resurrect them.
  const hosts:BotDeviceSnapshot[]=states.filter(s=>!revoked.has(s.key)).map((s):BotDeviceSnapshot=>{
   const info=s.info,online=this.hostOnline(s),record=records.find(record=>record.id===s.key),open=(s.key==='local'?global.server:global.script)&&record?.enabled!==false
   const manual=this.current(s,'local'),waiting=manual?'human_control':s.paused.has('local')?'paused':'ready'
   const base:DeviceCapabilityStatus|undefined=agent&&(agent.archived||agent.remoteAgentId)?'agent_unavailable':!open?'disabled':!online?'offline':!['darwin','win32'].includes(info?.platform??'')?'unsupported':undefined
   const capability=(reason?:DeviceCapabilityStatus):DeviceCapability=>({enabled:!reason,status:reason??waiting})
   const screen=capability(base??(!info?.approved.includes(this.ownerKey(owner))?'not_authorized':!info.screen||!info.accessibility?'system_permission_required':undefined))
   const files=capability(base??(!(info?.full??[]).includes(this.ownerKey(owner))?'not_authorized':undefined))
   const metadata=online&&info?.environment?{version:info.environment.version,osRelease:info.environment.osRelease,arch:info.environment.arch,timezone:info.environment.timezone,...(files.enabled?structuredClone(info.environment):{})}:undefined
   return {id:s.key,target:s.key==='local'?'server':s.key,name:this.label(s)||record?.name||s.key,kind:s.key==='local'?'server':'computer',source:s.key===deviceHost,online,open,
    ...(info?{epoch:info.id,platform:info.platform}:{}),...(s.seen?{lastSeen:s.seen}:{}),...(metadata?{metadata}:{}),
    capabilities:{view:{...screen},input:{...screen},fileRead:{...files},fileWrite:{...files},shell:{...files},fileTransfer:{...files}},
    transfer:{protocol:!info?'unknown':info.fileTransferVersion===1?'chunked':'legacy',readMaxMiB:!info?null:info.fileTransferVersion===1?global.maxMiB:Math.min(global.maxMiB,12),writeMaxMiB:!info?null:info.fileTransferVersion===1?global.maxMiB:Math.min(global.maxMiB,10)}}
  }).sort((a,b)=>a.id==='local'?-1:b.id==='local'?1:a.id.localeCompare(b.id))
  return {capturedAt,...(deviceHost?{sourceHost:deviceHost}:{}),hosts}
 }
 onlineHostsLine(owner:string,deviceHost?:string){return deviceInventoryText(this.snapshot(owner,undefined,deviceHost))}
 deviceContextLine(owner:string,deviceHost?:string){return deviceSourceText(this.snapshot(owner,undefined,deviceHost))}
 private agent(owner:string,id:string){const a=this.store.require<WorkspaceAgent>(owner,'agent',id);this.nodes.requireSource(owner,a);if(a.archived||a.remoteAgentId)throw new HttpError(409,'此机器人无法使用桌面环境','computer_unavailable');return a}
 private resource(owner:string,agent:WorkspaceAgent,mode:Mode){return mode==='local'?'local':digest(this.ownerKey(owner)+':'+agent.id+':'+(agent.browserProfile??'persistent'))}
 hostStates(owner:string){return [...this.sessions.values()].map(s=>{const online=this.hostOnline(s),info=online?s.info!:undefined;return {id:s.key,name:this.label(s),platform:info?.platform??'',online,local:{supported:['darwin','win32'].includes(info?.platform??''),authorized:!!info&&info.approved.includes(this.ownerKey(owner)),screen:info?.screen===true,accessibility:info?.accessibility===true,ready:!!info&&this.ready(s,owner),fullAuthorized:!!info&&(info.full??[]).includes(this.ownerKey(owner))},browser:{available:online}}}).sort((a,b)=>a.id==='local'?-1:b.id==='local'?1:a.name.localeCompare(b.name))}
 state(owner:string,agent:WorkspaceAgent){const mode=this.selected(owner,agent),s=this.sessionFor(agent),online=!!s&&this.hostOnline(s),info=online?s!.info:undefined;return {online,host:info?{id:s!.key,name:this.label(s!),platform:info.platform}:null,local:{supported:['darwin','win32'].includes(info?.platform??''),authorized:!!info&&info.approved.includes(this.ownerKey(owner)),screen:info?.screen===true,accessibility:info?.accessibility===true,ready:!!info&&this.ready(s!,owner),fullAuthorized:!!info&&(info.full??[]).includes(this.ownerKey(owner))},browser:{available:online,profile:agent.browserProfile??'persistent'},selected:mode??null,agent:this.store.agentSummary(agent),hosts:this.hostStates(owner)}}
 /** Every Bot follows the same global desktop policy. */
 private modeOpen(owner:string,agent:WorkspaceAgent,mode:Mode){return this.selected(owner,agent)===mode}
 private check(s:HostState|undefined,owner:string,agentId:string,mode:Mode,epoch:string,version:number,files=false){const a=this.agent(owner,agentId);if(!s||!this.hostOnline(s)||s.info!.id!==epoch)throw new HttpError(409,'桌面端已断开，请在电脑上打开夭夭后重试。','desktop_offline');if(this.auth.pushAuthorizationVersion(owner)!==version||!this.modeOpen(owner,a,mode))throw new HttpError(410,'电脑授权已改变，请重新连接。','computer_control_expired');this.requireHost(s);if(files&&!this.readyFull(s,owner))throw new HttpError(403,'请在桌面端授权文件与命令访问。','desktop_full_required');if(mode==='local'&&!files&&!this.ready(s,owner))throw new HttpError(403,s.info!.platform==='win32'?'请在 Windows 客户端授权本机控制，并解锁电脑、恢复桌面会话。':'请在桌面端授权本机控制，并开启屏幕录制和辅助功能。','desktop_permission_required')}
 private invalidate(s:HostState){for(const p of s.pending.values()){if(p.sent&&['input','browser'].includes(String(p.command.operation)))s.paused.add(String(p.command.resource));clearTimeout(p.timer);p.reject(new HttpError(409,'桌面连接已改变；执行结果未确认，不会重试。','desktop_disconnected'))}s.pending.clear();s.frames.clear();for(const [key,m] of s.manual){s.paused.add(key);this.store.remove('_system','computer-control',m.id)}s.manual.clear()}
 close(){this.closed=true;for(const s of this.sessions.values())this.invalidate(s)}
 async bridge(ctx:Koa.Context){
  if(ctx.method!=='POST'){ctx.status=405;return}
  let bytes=0;const chunks:Buffer[]=[];for await(const chunk of ctx.req){bytes+=chunk.length;if(bytes>24*1024*1024)throw new HttpError(413,'桌面响应过大','desktop_limit');chunks.push(Buffer.from(chunk))}
  let json:unknown;try{json=JSON.parse(Buffer.concat(chunks).toString())}catch{throw new HttpError(400,'桌面请求格式无效','desktop_invalid')}
  ctx.body=this.exchange(json)
 }
 /** Loopback App exchange; kept for the local service-instance channel. */
 exchange(body:unknown){return this.exchangeFor(this.localSession(),body)}
 /** Remote computer exchange, admitted upstream by DesktopHostHub. */
 remoteExchange(id:string,body:unknown){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new HttpError(404,'电脑不存在','desktop_host_unknown')
  let s=this.sessions.get(id)
  if(!s){s=newHostState(id,true);this.sessions.set(id,s)}
  return this.exchangeFor(s,body)
 }
 /** Revocation or replacement of a paired host fences its live commands. */
 dropHost(id:string){const s=this.sessions.get(id);if(s){this.invalidate(s);this.sessions.delete(id)}}
 private exchangeFor(s:HostState,body:unknown){
  const value=parse(desktopHostExchangeSchema,body)
  if(this.closed)throw new HttpError(503,'服务已停止','desktop_closed')
  if(s.info&&(s.info.id!==value.host.id||!this.hostOnline(s)))this.invalidate(s)
  s.info=value.host;s.seen=Date.now()
  for(const result of value.results){const p=s.pending.get(result.id);if(!p||p.epoch!==value.host.id)continue;s.pending.delete(p.id);clearTimeout(p.timer);try{p.check();if(result.error)throw new HttpError(409,result.error,'desktop_command_failed');p.resolve(result.value)}catch(error){p.reject(error as Error)}}
  const commands:Record<string,unknown>[]=[]
  for(const p of s.pending.values()){if(p.sent)continue;try{p.check();p.sent=true;commands.push({id:p.id,deadline:p.deadline,...p.command})}catch(error){s.pending.delete(p.id);clearTimeout(p.timer);p.reject(error as Error)}if(commands.length>=8)break}
  return {commands,capabilities:{environmentMetadata:1,desktopPlatforms:['darwin','win32']}}
 }
 private command(s:HostState,command:Record<string,unknown>,check:()=>void,timeout=30000):Promise<any>{
  check();if(!this.hostOnline(s))throw new HttpError(409,'桌面端未连接，请在电脑上打开夭夭。','desktop_offline')
  if(s.pending.size>=64)throw new HttpError(429,'桌面操作过多，请稍后重试','desktop_busy')
  return new Promise((resolve,reject)=>{const id=randomUUID(),deadline=Date.now()+timeout,timer=setTimeout(()=>{s.pending.delete(id);if(['input','browser'].includes(String(command.operation)))s.paused.add(String(command.resource));reject(new HttpError(504,'桌面操作未确认，不会自动重试。','desktop_timeout'))},timeout);timer.unref();s.pending.set(id,{id,epoch:s.info!.id,deadline,command,check,resolve,reject,timer,sent:false})})
 }
 private context(s:HostState|undefined,owner:string,agent:WorkspaceAgent,mode:Mode,files=false){const epoch=s?.info?.id??'',version=this.auth.pushAuthorizationVersion(owner)??0,profile=agent.browserProfile??'persistent',resource=this.resource(owner,agent,mode);return {key:resource,check:()=>{this.check(s,owner,agent.id,mode,epoch,version,files);if((this.agent(owner,agent.id).browserProfile??'persistent')!==profile)throw new HttpError(410,'浏览器资料已切换','computer_control_expired')},command:{mode,owner:this.ownerKey(owner),resource,profile}}}
 private current(s:HostState,key:string){const m=s.manual.get(key);if(m&&(!this.hostOnline(s)||m.epoch!==s.info!.id||m.expiresAt<=Date.now()||this.auth.pushAuthorizationVersion(m.owner)!==m.version)){s.manual.delete(key);s.paused.add(key);s.frames.delete(key);this.store.remove('_system','computer-control',m.id);return undefined}return m}
 private serial<T>(s:HostState,key:string,work:()=>Promise<T>){const next=(s.queue.get(key)??Promise.resolve()).catch(()=>{}).then(work);s.queue.set(key,next);void next.finally(()=>{if(s.queue.get(key)===next)s.queue.delete(key)}).catch(()=>{});return next}
 private async capture(s:HostState,c:ReturnType<DesktopEnvironments['context']>){const cached=s.frames.get(c.key);c.check();if(cached&&cached.generation===(s.generation.get(c.key)??0)&&Date.now()-cached.capturedAt<700)return cached;const generation=s.generation.get(c.key)??0
  const value=await this.command(s,{...c.command,operation:'view'},c.check)
  const image=parse(z.object({data:z.string().min(1).max(22*1024*1024),width:z.number().int().min(1).max(16384),height:z.number().int().min(1).max(16384)}).passthrough(),value)
  if(generation!==(s.generation.get(c.key)??0))throw new HttpError(409,'控制状态改变，请刷新画面','computer_frame_stale')
  const frame={...image,id:randomUUID(),generation,capturedAt:Date.now()};s.frames.set(c.key,frame);return frame
 }
 private status(s:HostState|undefined,owner:string,a:WorkspaceAgent,mode:Mode):ComputerControlStatus {const key=this.resource(owner,a,mode),m=s?this.current(s,key):undefined,online=!!s&&this.hostOnline(s);return {backend:mode,hostName:online?s!.info!.name:undefined,mode:!online?'off':m?(m.owner===owner&&m.ready?'human':'pausing'):s!.paused.has(key)?'error':s!.activity.get(key)?'agent':'idle',controlId:m?.owner===owner?m.id:undefined,generation:s?.generation.get(key)??0,canResume:!!s?.activity.get(key),error:!online?'请在电脑上打开夭夭桌面端':s!.paused.has(key)?'接管已断开，请重新接管并交还后继续':undefined}}
 assertIdle(owner:string,agentId:string){const a=this.agent(owner,agentId),mode=this.selected(owner,a);if(mode){const s=this.sessionFor(a);if(s&&this.current(s,this.resource(owner,a,mode)))throw new HttpError(409,'请先交还电脑控制权','computer_busy')}}
 async requireAvailable(owner:string,a:WorkspaceAgent,target:GatewayTarget){
  const tools=this.envTools(owner,a)
  if(tools.view||tools.file)await requireTeamToolBridge(target,a.profile)
 }
 private async copyFile(owner:string,agent:WorkspaceAgent,input:unknown,signal:AbortSignal,assertActive:()=>void,epoch:string|Record<string,string>|undefined,deviceHost?:string,vmTransfer?:(action:Record<string,unknown>)=>Promise<any>){
  const args=parse(copySchema,input),source=args.sourceHost==='vm'?undefined:this.namedHost(args.sourceHost,deviceHost),target=args.targetHost==='vm'?undefined:this.namedHost(args.targetHost,deviceHost)
  if(!source&&!target)throw new HttpError(400,'请至少指定一台电脑或服务器','desktop_transfer_invalid')
  if((!source||!target)&&(!vmTransfer||!readHostTools(this.store.home).vm))throw new HttpError(409,'当前 Bot 没有可用的虚拟机文件传输','computer_transfer_unavailable')
  const maxBytes=readHostTools(this.store.home).fileTransferMaxMiB*1024*1024
  const hosts=[...new Set([source,target].filter((host):host is HostState=>!!host))].sort((a,b)=>a.key.localeCompare(b.key))
  const contexts=hosts.map(host=>({host,context:this.context(host,owner,agent,'local',true),epoch:typeof epoch==='string'?(host===this.sessionFor(agent)?epoch:undefined):epoch?.[host.key]}))
  const check=()=>{signal.throwIfAborted();assertActive();for(const item of contexts){if(epoch&&typeof epoch==='object'&&!Object.hasOwn(epoch,item.host.key))throw new HttpError(410,'目标电脑不在本轮环境快照中，请发起新一轮对话。','desktop_context_changed');item.context.check();if(this.sessions.get(item.host.key)!==item.host||(item.epoch!==undefined&&item.host.info?.id!==item.epoch))throw new HttpError(410,'传输中的电脑连接已改变，请核对文件后重试。','desktop_disconnected')}}
  check()
  const command=async(host:HostState,action:Record<string,unknown>)=>{const context=contexts.find(item=>item.host===host)!.context;if(action.op!=='transfer-abort')await available();return this.command(host,{...context.command,operation:'file',action},action.op==='transfer-abort'?context.check:check,60000)}
  // A stable lock order prevents A→B and B→A transfers from deadlocking.
  const locked=(index:number):Promise<unknown>=>index<contexts.length
   ? this.serial(contexts[index]!.host,contexts[index]!.context.key,()=>locked(index+1))
   : perform()
  const available=async()=>{
   while(contexts.some(({host,context})=>this.current(host,context.key)||host.paused.has(context.key))){check();await new Promise(resolve=>setTimeout(resolve,150))}
   check()
  }
  const perform=async()=>{
   await available()
   const endpoint=(host:HostState|undefined,path:string):FileTransferEndpoint=>host
    ? {host:host.key,name:this.label(host),path,chunks:host.info?.fileTransferVersion===1,call:action=>command(host,action)}
    : {host:'vm',name:'当前 Bot 的虚拟机',path,chunks:true,call:async action=>{if(action.op!=='transfer-abort')await available();return vmTransfer!(action)}}
   const result=await copyBetweenEndpoints(endpoint(source,args.sourcePath),endpoint(target,args.targetPath),maxBytes,args.overwrite,check)
   const handoffNotes=contexts.flatMap(({host})=>{const key=owner+':'+agent.id,note=host.notes.get(key);if(!note)return [];host.notes.delete(key);return [`${this.label(host)}：${note}`]})
   return {...result,...(handoffNotes.length?{handoffNotes}:{})}
  }
  for(const {host,context} of contexts)host.activity.set(context.key,(host.activity.get(context.key)??0)+1)
  try{return await locked(0)}finally{for(const {host,context} of contexts)host.activity.set(context.key,Math.max(0,(host.activity.get(context.key)??1)-1))}
 }
 async call(owner:string,agentId:string,id:string,input:unknown,signal:AbortSignal,assertActive:()=>void,expected:Mode,epoch:string|Record<string,string>|undefined,deviceHost?:string,vmTransfer?:(action:Record<string,unknown>)=>Promise<any>){
  if(id==='desktop_browser'||expected==='browser')throw new HttpError(404,'当前环境不支持这个工具','tool_not_found')
  const a=this.agent(owner,agentId)
  if(id==='desktop_file_copy')return this.copyFile(owner,a,input,signal,assertActive,epoch,deviceHost,vmTransfer)
  const {host,...arguments_}=typeof input==='object'&&input?input as Record<string,unknown>:{}
  const requestedHost=host===undefined?undefined:parse(z.string().trim().min(1).max(128),host)
  const s=this.targetFor(a,requestedHost,deviceHost)
  const c=this.context(s,owner,a,expected,DESKTOP_FILE_TOOL_IDS.has(id))
  const pinned=typeof epoch==='string'?(s===this.sessionFor(a)?epoch:undefined):epoch?.[s.key]
  const check=()=>{signal.throwIfAborted();assertActive();if(epoch&&typeof epoch==='object'&&!Object.hasOwn(epoch,s.key))throw new HttpError(410,'目标电脑不在本轮环境快照中，请发起新一轮对话。','desktop_context_changed');c.check();if(pinned!==undefined&&s.info?.id!==pinned)throw new HttpError(410,'桌面连接已改变','desktop_disconnected')};check()
  s.activity.set(c.key,(s.activity.get(c.key)??0)+1)
  try{return await this.serial(s,c.key,async()=>{while(this.current(s,c.key)||s.paused.has(c.key)){check();await new Promise(resolve=>setTimeout(resolve,150))}check()
   let result:any
   if(id==='desktop_environment_view'){const frame=await this.capture(s,{...c,check});this.toolFrames.set(signal,frame.id);result={content:[{type:'image',mimeType:'image/png',data:frame.data},{type:'text',text:JSON.stringify({width:frame.width,height:frame.height,host:s.info!.name,mode:expected})}]}}
   else if(DESKTOP_FILE_TOOL_IDS.has(id)&&expected==='local'){
    if(!this.readyFull(s,owner))throw new HttpError(403,'请在桌面端授权文件与命令访问后重试。','desktop_full_required')
    const action=id==='desktop_shell'?parse(shellSchema,arguments_):parse(fileSchema,{op:id==='desktop_file_list'?'list':id==='desktop_file_read'?'read':'write',...arguments_})
    result=await this.command(s,{...c.command,operation:id==='desktop_shell'?'shell':'file',action},check,id==='desktop_shell'?150000:60000)
   }
   else if(id==='desktop_environment_action'){const frame=s.frames.get(c.key);if(!frame||this.toolFrames.get(signal)!==frame.id||Date.now()-frame.capturedAt>15000)throw new HttpError(409,'请先查看最新电脑画面','computer_frame_stale');result=await this.command(s,{...c.command,operation:'input',action:parse(inputSchema,arguments_),frame:{width:frame.width,height:frame.height}},check);s.frames.delete(c.key)}
   else throw new HttpError(404,'当前环境不支持这个工具','tool_not_found')
   const note=s.notes.get(owner+':'+agentId);if(note){s.notes.delete(owner+':'+agentId);if(result.content)result.content.push({type:'text',text:'人工交还说明：'+note});else result={...result,handoffNote:note}}return result
  })}finally{s.activity.set(c.key,Math.max(0,(s.activity.get(c.key)??1)-1))}
 }
 /** Epochs of every connected host; pins multi-host tool calls per machine. */
 hostEpochs(owner:string,agent:WorkspaceAgent):Record<string,string>{const epochs:Record<string,string>={};for(const s of this.sessions.values())if(s.info)epochs[s.key]=s.info.id;return epochs}
 hostEpoch(owner:string,agent:WorkspaceAgent){return this.sessionFor(agent)?.info?.id??''}
 get epoch(){return this.sessions.get('local')?.info?.id??''}
 private grant(s:HostState,owner:string,a:WorkspaceAgent,c:ReturnType<DesktopEnvironments['context']>,body:any){const m=this.current(s,c.key);const token=typeof body?.token==='string'?body.token:'';if(!m||!m.ready||m.owner!==owner||m.agentId!==a.id||m.id!==body?.controlId||!timingSafeEqual(Buffer.from(digest(token),'hex'),Buffer.from(digest(m.token),'hex')))throw new HttpError(410,'控制权已失效，请重新接管','computer_control_expired');c.check();return m}
 router(){const router=new Router()
  router.get('/api/app/agents/:id/desktop-environment',ctx=>{const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id);this.nodes.requireSource(owner,a);ctx.set('Cache-Control','no-store');ctx.body=this.state(owner,a)})
  router.post('/api/app/agents/:id/desktop-environment/authorize',async ctx=>{
   const user=this.auth.require(ctx);this.auth.requireAdmin(ctx);const a=this.agent(user.id,ctx.params.id)
   const body=parse(z.object({hostId:z.union([z.literal('local'),z.string().uuid()]).optional(),scope:z.enum(['screen','full']).default('screen')}).strict(),(ctx.request as any).body??{})
   const s=body.hostId!==undefined?this.sessions.get(body.hostId):this.sessionFor(a)
   if(!s||!this.hostOnline(s))throw new HttpError(409,'桌面端未连接，请在电脑上打开夭夭。','desktop_offline')
   const owner=this.ownerKey(user.id),epoch=s.info!.id,authorizeKey=user.id+':'+s.key+':'+body.scope
   let pending=this.authorizing.get(authorizeKey)
   if(!pending){pending=this.command(s,{operation:'authorize',owner,account:user.username,scope:body.scope},()=>{this.auth.requireAdmin(ctx);if(!this.hostOnline(s)||epoch!==s.info!.id)throw new HttpError(409,'桌面端已断开','desktop_offline')},120000).finally(()=>this.authorizing.delete(authorizeKey));this.authorizing.set(authorizeKey,pending)}
   ctx.body=await pending})
  router.put('/api/app/agents/:id/browser-profile',ctx=>{const owner=this.auth.require(ctx).id,a=this.agent(owner,ctx.params.id),body=parse(z.object({profile:z.enum(['persistent','temporary'])}).strict(),(ctx.request as any).body);this.assertIdle(owner,a.id);this.store.updateAgent(owner,a.id,{browserProfile:body.profile});ctx.body={ok:true}})
  router.get('/api/app/agents/:id/browser',async ctx=>{const owner=this.auth.require(ctx).id,a=this.agent(owner,ctx.params.id);if(this.selected(owner,a)!=='browser')throw new HttpError(409,'请先选择仅浏览器环境','desktop_unselected');const s=this.sessionFor(a);ctx.body=await this.command(s!,{...this.context(s,owner,a,'browser').command,operation:'browser-state'},this.context(s,owner,a,'browser').check)})
  router.get('/api/app/agents/:id/computer',async(ctx,next)=>{const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id),mode=this.selected(owner,a);if(typeof ctx.query.backend==='string'&&ctx.query.backend!=='desktop')return next();if(!mode)return next();this.agent(owner,a.id);ctx.body=this.status(this.takeoverSession(a,ctx.query.host),owner,a,mode)})
  router.get('/api/app/agents/:id/computer/frame',async(ctx,next)=>{const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id),mode=this.selected(owner,a);if(typeof ctx.query.backend==='string'&&ctx.query.backend!=='desktop')return next();if(!mode)return next();this.agent(owner,a.id);const s=this.takeoverSession(a,ctx.query.host),c=this.context(s,owner,a,mode);ctx.set('Cache-Control','no-store');c.check();ctx.body=await this.capture(s!,c)})
  router.post('/api/app/agents/:id/computer/:action',async(ctx,next)=>{
   const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id),mode=this.selected(owner,a);if(typeof ctx.query.backend==='string'&&ctx.query.backend!=='desktop')return next();if(!mode)return next();this.agent(owner,a.id);const s=this.takeoverSession(a,ctx.query.host),c=this.context(s,owner,a,mode),body=(ctx.request as any).body,action=ctx.params.action;c.check()
   if(action==='take'){
    const {requestId}=parse(z.object({requestId:z.string().uuid()}).strict(),body),old=this.current(s!,c.key)
    if(old){if(old.owner!==owner||old.agentId!==a.id||old.requestId!==requestId)throw new HttpError(409,'已有页面正在控制这台电脑','computer_busy');while(!old.ready){c.check();if(this.current(s!,c.key)!==old)throw new HttpError(410,'接管已失效','computer_control_expired');await new Promise(resolve=>setTimeout(resolve,80))}ctx.body={...this.status(s,owner,a,mode),token:old.token};return}
    const m:Manual={id:randomUUID(),token:randomBytes(32).toString('base64url'),requestId,owner,agentId:a.id,version:this.auth.pushAuthorizationVersion(owner)??0,expiresAt:Date.now()+90000,generation:(s!.generation.get(c.key)??0)+1,epoch:s!.info!.id,actions:new Map()};s!.manual.set(c.key,m);s!.generation.set(c.key,m.generation);s!.frames.delete(c.key)
    this.store.put('_system','computer-control',m.id,{owner,agentId:a.id,environmentId:'desktop:'+s!.key+':'+c.key,expiresAt:m.expiresAt})
    // The lane may contain agent calls waiting for this takeover. Only await
    // commands already dispatched to the host, not the whole agent lane.
    while([...s!.pending.values()].some(p=>p.command.resource===c.key)){c.check();if(this.current(s!,c.key)!==m)throw new HttpError(410,'接管已失效','computer_control_expired');await new Promise(resolve=>setTimeout(resolve,80))}
    try{await this.command(s!,{...c.command,operation:'open'},c.check);m.ready=true;m.expiresAt=Date.now()+30000;ctx.body={...this.status(s,owner,a,mode),token:m.token}}catch(error){s!.manual.delete(c.key);s!.paused.add(c.key);this.store.remove('_system','computer-control',m.id);throw error}return
   }
   const m=this.grant(s!,owner,a,c,body)
   if(action==='renew'){m.expiresAt=Date.now()+30000;this.store.put('_system','computer-control',m.id,{owner,agentId:a.id,environmentId:'desktop:'+s!.key+':'+c.key,expiresAt:m.expiresAt});ctx.body={ok:true};return}
   if(action==='giveback'){m.releasing=true;await m.pending?.catch(()=>{});if(typeof body.notes==='string')s!.notes.set(owner+':'+a.id,body.notes.slice(0,4000));s!.manual.delete(c.key);s!.paused.delete(c.key);this.store.remove('_system','computer-control',m.id);s!.generation.set(c.key,m.generation+1);s!.frames.delete(c.key);ctx.body={ok:true};return}
   if(action==='input'||action==='browser'){
    const v=parse(z.object({controlId:z.string(),token:z.string(),requestId:z.string().uuid(),generation:z.number().int(),frameId:z.string().uuid(),action:z.unknown()}).strict(),body),fingerprint=JSON.stringify([action,v.generation,v.frameId,v.action]),old=m.actions.get(v.requestId)
    if(old){if(old.fingerprint!==fingerprint)throw new HttpError(409,'请求编号冲突','idempotency_conflict');ctx.body=await old.value;return}
    const f=s!.frames.get(c.key);if(!f||f.id!==v.frameId||f.generation!==v.generation||m.generation!==v.generation||Date.now()-f.capturedAt>10000)throw new HttpError(409,'画面已过期，请刷新后操作','computer_frame_stale')
    if(m.releasing||m.actions.size>=512)throw new HttpError(409,'请交还后重新接管','computer_control_expired')
    if(action==='browser'&&mode!=='browser')throw new HttpError(409,'当前环境不是浏览器','desktop_unselected')
    const input=(action==='browser'?parse(browserSchema,v.action):parse(inputSchema,v.action)),check=()=>{this.grant(s!,owner,a,c,body);if(this.current(s!,c.key)!==m)throw new HttpError(410,'控制权已失效','computer_control_expired')}
    const result=(m.pending??Promise.resolve()).catch(()=>{}).then(()=>this.command(s!,{...c.command,operation:action==='browser'?'browser':'input',action:input,frame:{width:f.width,height:f.height}},check));m.pending=result;m.actions.set(v.requestId,{fingerprint,value:result});ctx.body=await result;s!.frames.delete(c.key);return
   }
   throw new HttpError(404,'电脑操作不存在','not_found')
  })
  return router
 }
}
