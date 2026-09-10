import Router from '@koa/router'
import type Koa from 'koa'
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
import {HttpError} from './errors.js'
import {parse,type WorkspaceStore} from './workspaceStore.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceNodes,GatewayTarget} from './workspaceGateway.js'
import type {WorkspaceAgent} from '../shared/workspace.js'
import type {ComputerFrame,ComputerControlStatus} from '../shared/computerControl.js'
import {requireTeamToolBridge} from './workspaceToolLease.js'

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
type Mode='local'|'browser'
interface NativeHost {id:string;name:string;platform:string;screen:boolean;accessibility:boolean;approved:string[]}
interface Pending {id:string;epoch:string;deadline:number;command:Record<string,unknown>;check:()=>void;resolve:(v:any)=>void;reject:(e:Error)=>void;sent:boolean;timer:ReturnType<typeof setTimeout>}
interface Manual {ready?:boolean;id:string;token:string;requestId:string;owner:string;agentId:string;version:number;expiresAt:number;generation:number;epoch:string;pending?:Promise<unknown>;releasing?:boolean;actions:Map<string,{fingerprint:string;value:Promise<unknown>}>}
const props={kind:{type:'string'},url:{type:'string'},tabId:{type:'string'},ref:{type:'string'},snapshotId:{type:'string'},text:{type:'string'}}
export const DESKTOP_ENVIRONMENT_TOOLS=[
 {id:'desktop_environment_view',name:'desktop_environment_view',description:'查看当前已选电脑的真实截图，返回截图尺寸、环境类型和连接的电脑名称。',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {id:'desktop_environment_action',name:'desktop_environment_action',description:'操作当前已选电脑。必须先查看新截图；kind 为 click、drag、text、key 或 scroll，坐标使用截图像素。',inputSchema:{type:'object',properties:{kind:{enum:['click','drag','text','key','scroll']},x:{type:'integer'},y:{type:'integer'},fromX:{type:'integer'},fromY:{type:'integer'},toX:{type:'integer'},toY:{type:'integer'},button:{enum:['left','right','middle']},count:{type:'integer'},text:{type:'string'},key:{type:'string'},modifiers:{type:'array',items:{enum:['ctrl','alt','shift','super']}},direction:{enum:['up','down','left','right']},amount:{type:'integer'}},required:['kind'],additionalProperties:false}},
 {id:'desktop_browser',name:'desktop_browser',description:'操作机器人的独立浏览器。kind: navigate/new-tab(url)、select-tab/close-tab(tabId)、back/forward/reload、snapshot（读取页面元素与 ref）、click/fill(ref,snapshotId,text)。只在仅浏览器环境可用。',inputSchema:{type:'object',properties:props,required:['kind'],additionalProperties:false}},
]
export const DESKTOP_ENVIRONMENT_RULES='当前环境由用户连接的夭夭桌面端提供。使用 desktop_environment_view/action 查看和操作该环境；本机模式会影响这台真实电脑，遵循用户授权范围。仅浏览器模式使用独立浏览器，desktop_browser 可导航、查看页面及操作元素。先查看再操作，页面变化后重新获取截图或 snapshot；不得猜测旧坐标或 ref。人工接管时等待交还，按交还说明继续。电脑断开时报告原因，不得宣称操作成功。'

/** The native transport is admitted only by serviceInstance's private loopback
 * capability. Browser/desktop authority never crosses into the renderer. */
export class DesktopEnvironments {
 private host?:NativeHost
 private seen=0
 private pending=new Map<string,Pending>()
 private queue=new Map<string,Promise<unknown>>()
 private manual=new Map<string,Manual>()
 private paused=new Set<string>()
 private frames=new Map<string,ComputerFrame>()
 private generation=new Map<string,number>()
 private notes=new Map<string,string>()
 private toolFrames=new WeakMap<AbortSignal,string>()
 private activity=new Map<string,number>()
 private authorizing=new Map<string,Promise<unknown>>()
 private closed=false
 constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes){}
 get online(){return !this.closed&&!!this.host&&Date.now()-this.seen<8000}
 get idleForUpdate(){for(const key of this.manual.keys())this.current(key);return !this.pending.size&&!this.queue.size&&!this.manual.size}
 private ownerKey(owner:string){return digest((this.nodes.localNodeID??this.nodes.local.url.toString())+':'+owner)}
 private ready(owner:string){return this.online&&this.host!.platform==='darwin'&&this.host!.screen&&this.host!.accessibility&&this.host!.approved.includes(this.ownerKey(owner))}
 selected(owner:string,agent:WorkspaceAgent):Mode|undefined {if(agent.archived||agent.remoteAgentId||agent.temporaryGoalId)return undefined;if(agent.computer==='local'||agent.computer==='browser')return agent.computer;if(agent.computer==='auto'&&agent.execution!=='computer'&&this.ready(owner))return 'local';return undefined}
 private agent(owner:string,id:string){const a=this.store.require<WorkspaceAgent>(owner,'agent',id);this.nodes.requireSource(owner,a);if(a.archived||a.remoteAgentId||a.temporaryGoalId)throw new HttpError(409,'此机器人无法使用桌面环境','computer_unavailable');return a}
 private resource(owner:string,agent:WorkspaceAgent,mode:Mode){return mode==='local'?'local':digest(this.ownerKey(owner)+':'+agent.id+':'+(agent.browserProfile??'persistent'))}
 state(owner:string,agent:WorkspaceAgent){const mode=this.selected(owner,agent);return {online:this.online,host:this.online?{name:this.host!.name,platform:this.host!.platform}:null,local:{supported:this.online&&this.host!.platform==='darwin',authorized:this.online&&this.host!.approved.includes(this.ownerKey(owner)),screen:this.online&&this.host!.screen,accessibility:this.online&&this.host!.accessibility,ready:this.ready(owner)},browser:{available:this.online,profile:agent.browserProfile??'persistent'},selected:mode??null,agent:this.store.agentSummary(agent)}}
 private check(owner:string,agentId:string,mode:Mode,epoch:string,version:number){const a=this.agent(owner,agentId);if(!this.online||this.host!.id!==epoch)throw new HttpError(409,'桌面端已断开，请在电脑上打开夭夭后重试。','desktop_offline');if(this.auth.pushAuthorizationVersion(owner)!==version||this.selected(owner,a)!==mode)throw new HttpError(410,'电脑授权已改变，请重新连接。','computer_control_expired');if(mode==='local'&&!this.ready(owner))throw new HttpError(403,'请在桌面端授权本机控制，并开启屏幕录制和辅助功能。','desktop_permission_required')}
 private invalidate(){for(const p of this.pending.values()){if(p.sent&&['input','browser'].includes(String(p.command.operation)))this.paused.add(String(p.command.resource));clearTimeout(p.timer);p.reject(new HttpError(409,'桌面连接已改变；执行结果未确认，不会重试。','desktop_disconnected'))}this.pending.clear();this.frames.clear();for(const [key,m] of this.manual){this.paused.add(key);this.store.remove('_system','computer-control',m.id)}this.manual.clear()}
 close(){this.closed=true;this.invalidate()}
 async bridge(ctx:Koa.Context){
  if(ctx.method!=='POST'){ctx.status=405;return}
  let bytes=0;const chunks:Buffer[]=[];for await(const chunk of ctx.req){bytes+=chunk.length;if(bytes>24*1024*1024)throw new HttpError(413,'桌面响应过大','desktop_limit');chunks.push(Buffer.from(chunk))}
  let json:unknown;try{json=JSON.parse(Buffer.concat(chunks).toString())}catch{throw new HttpError(400,'桌面请求格式无效','desktop_invalid')}
  ctx.body=this.exchange(json)
 }
 exchange(body:unknown){
  const value=parse(z.object({host:z.object({id:z.string().uuid(),name:z.string().max(128),platform:z.string().max(16),screen:z.boolean(),accessibility:z.boolean(),approved:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100)}).strict(),results:z.array(z.object({id:z.string().uuid(),value:z.unknown().optional(),error:z.string().max(500).optional()}).strict()).max(20)}).strict(),body)
  if(this.closed)throw new HttpError(503,'服务已停止','desktop_closed')
  if(this.host&&(this.host.id!==value.host.id||!this.online))this.invalidate()
  this.host=value.host;this.seen=Date.now()
  for(const result of value.results){const p=this.pending.get(result.id);if(!p||p.epoch!==value.host.id)continue;this.pending.delete(p.id);clearTimeout(p.timer);try{p.check();if(result.error)throw new HttpError(409,result.error,'desktop_command_failed');p.resolve(result.value)}catch(error){p.reject(error as Error)}}
  const commands:Record<string,unknown>[]=[]
  for(const p of this.pending.values()){if(p.sent)continue;try{p.check();p.sent=true;commands.push({id:p.id,deadline:p.deadline,...p.command})}catch(error){this.pending.delete(p.id);clearTimeout(p.timer);p.reject(error as Error)}if(commands.length>=8)break}
  return {commands}
 }
 private command(command:Record<string,unknown>,check:()=>void,timeout=30000):Promise<any>{
  check();if(!this.online)throw new HttpError(409,'桌面端未连接，请在电脑上打开夭夭。','desktop_offline')
  if(this.pending.size>=64)throw new HttpError(429,'桌面操作过多，请稍后重试','desktop_busy')
  return new Promise((resolve,reject)=>{const id=randomUUID(),deadline=Date.now()+timeout,timer=setTimeout(()=>{this.pending.delete(id);if(['input','browser'].includes(String(command.operation)))this.paused.add(String(command.resource));reject(new HttpError(504,'桌面操作未确认，不会自动重试。','desktop_timeout'))},timeout);timer.unref();this.pending.set(id,{id,epoch:this.host!.id,deadline,command,check,resolve,reject,timer,sent:false})})
 }
 private context(owner:string,agent:WorkspaceAgent,mode:Mode){const epoch=this.host?.id??'',version=this.auth.pushAuthorizationVersion(owner)??0,profile=agent.browserProfile??'persistent',resource=this.resource(owner,agent,mode);return {key:resource,check:()=>{this.check(owner,agent.id,mode,epoch,version);if((this.agent(owner,agent.id).browserProfile??'persistent')!==profile)throw new HttpError(410,'浏览器资料已切换','computer_control_expired')},command:{mode,owner:this.ownerKey(owner),resource,profile}}}
 private current(key:string){const m=this.manual.get(key);if(m&&(!this.online||m.epoch!==this.host!.id||m.expiresAt<=Date.now()||this.auth.pushAuthorizationVersion(m.owner)!==m.version)){this.manual.delete(key);this.paused.add(key);this.frames.delete(key);this.store.remove('_system','computer-control',m.id);return undefined}return m}
 private serial<T>(key:string,work:()=>Promise<T>){const next=(this.queue.get(key)??Promise.resolve()).catch(()=>{}).then(work);this.queue.set(key,next);void next.finally(()=>{if(this.queue.get(key)===next)this.queue.delete(key)}).catch(()=>{});return next}
 private async capture(c:ReturnType<DesktopEnvironments['context']>){const cached=this.frames.get(c.key);c.check();if(cached&&cached.generation===(this.generation.get(c.key)??0)&&Date.now()-cached.capturedAt<700)return cached;const generation=this.generation.get(c.key)??0
  const value=await this.command({...c.command,operation:'view'},c.check)
  const image=parse(z.object({data:z.string().min(1).max(22*1024*1024),width:z.number().int().min(1).max(16384),height:z.number().int().min(1).max(16384)}).passthrough(),value)
  if(generation!==(this.generation.get(c.key)??0))throw new HttpError(409,'控制状态改变，请刷新画面','computer_frame_stale')
  const frame={...image,id:randomUUID(),generation,capturedAt:Date.now()};this.frames.set(c.key,frame);return frame
 }
 private status(owner:string,a:WorkspaceAgent,mode:Mode):ComputerControlStatus {const key=this.resource(owner,a,mode),m=this.current(key);return {backend:mode,hostName:this.online?this.host!.name:undefined,mode:!this.online?'off':m?(m.owner===owner&&m.ready?'human':'pausing'):this.paused.has(key)?'error':this.activity.get(key)?'agent':'idle',controlId:m?.owner===owner?m.id:undefined,generation:this.generation.get(key)??0,canResume:!!this.activity.get(key),error:!this.online?'请在电脑上打开夭夭桌面端':this.paused.has(key)?'接管已断开，请重新接管并交还后继续':undefined}}
 assertIdle(owner:string,agentId:string){const a=this.agent(owner,agentId),mode=this.selected(owner,a);if(mode&&this.current(this.resource(owner,a,mode)))throw new HttpError(409,'请先交还电脑控制权','computer_busy')}
 async requireAvailable(owner:string,a:WorkspaceAgent,target:GatewayTarget){const mode=this.selected(owner,a);if(!mode)throw new HttpError(409,'当前未选择桌面环境','desktop_unselected');this.context(owner,a,mode).check();await requireTeamToolBridge(target,a.profile)}
 async call(owner:string,agentId:string,id:string,input:unknown,signal:AbortSignal,assertActive:()=>void,expected:Mode,epoch:string){
  const a=this.agent(owner,agentId),c=this.context(owner,a,expected),check=()=>{signal.throwIfAborted();assertActive();c.check();if(this.host!.id!==epoch)throw new HttpError(410,'桌面连接已改变','desktop_disconnected')};check()
  this.activity.set(c.key,(this.activity.get(c.key)??0)+1)
  try{return await this.serial(c.key,async()=>{while(this.current(c.key)||this.paused.has(c.key)){check();await new Promise(resolve=>setTimeout(resolve,150))}check()
   let result:any
   if(id==='desktop_environment_view'){if(expected==='browser')await this.command({...c.command,operation:'open'},check);const frame=await this.capture({...c,check});this.toolFrames.set(signal,frame.id);result={content:[{type:'image',mimeType:'image/png',data:frame.data},{type:'text',text:JSON.stringify({width:frame.width,height:frame.height,host:this.host!.name,mode:expected})}]}}
   else if(id==='desktop_browser'&&expected==='browser'){result=await this.command({...c.command,operation:'browser',action:parse(browserSchema,input)},check);this.frames.delete(c.key)}
   else if(id==='desktop_environment_action'){const frame=this.frames.get(c.key);if(!frame||this.toolFrames.get(signal)!==frame.id||Date.now()-frame.capturedAt>15000)throw new HttpError(409,'请先查看最新电脑画面','computer_frame_stale');result=await this.command({...c.command,operation:'input',action:parse(inputSchema,input),frame:{width:frame.width,height:frame.height}},check);this.frames.delete(c.key)}
   else throw new HttpError(404,'当前环境不支持这个工具','tool_not_found')
   const note=this.notes.get(owner+':'+agentId);if(note){this.notes.delete(owner+':'+agentId);if(result.content)result.content.push({type:'text',text:'人工交还说明：'+note});else result={...result,handoffNote:note}}return result
  })}finally{this.activity.set(c.key,Math.max(0,(this.activity.get(c.key)??1)-1))}
 }
 get epoch(){return this.host?.id??''}
 private grant(owner:string,a:WorkspaceAgent,c:ReturnType<DesktopEnvironments['context']>,body:any){const m=this.current(c.key);const token=typeof body?.token==='string'?body.token:'';if(!m||!m.ready||m.owner!==owner||m.agentId!==a.id||m.id!==body?.controlId||!timingSafeEqual(Buffer.from(digest(token),'hex'),Buffer.from(digest(m.token),'hex')))throw new HttpError(410,'控制权已失效，请重新接管','computer_control_expired');c.check();return m}
 router(){const router=new Router()
  router.get('/api/app/agents/:id/desktop-environment',ctx=>{const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id);this.nodes.requireSource(owner,a);ctx.set('Cache-Control','no-store');ctx.body=this.state(owner,a)})
  router.post('/api/app/agents/:id/desktop-environment/authorize',async ctx=>{const user=this.auth.require(ctx);this.auth.requireAdmin(ctx);this.agent(user.id,ctx.params.id);const owner=this.ownerKey(user.id),epoch=this.epoch;let pending=this.authorizing.get(user.id);if(!pending){pending=this.command({operation:'authorize',owner,account:user.username},()=>{this.auth.requireAdmin(ctx);if(!this.online||epoch!==this.epoch)throw new HttpError(409,'桌面端已断开','desktop_offline')},120000).finally(()=>this.authorizing.delete(user.id));this.authorizing.set(user.id,pending)}ctx.body=await pending})
  router.put('/api/app/agents/:id/browser-profile',ctx=>{const owner=this.auth.require(ctx).id,a=this.agent(owner,ctx.params.id),body=parse(z.object({profile:z.enum(['persistent','temporary'])}).strict(),(ctx.request as any).body);this.assertIdle(owner,a.id);this.store.updateAgent(owner,a.id,{browserProfile:body.profile});ctx.body={ok:true}})
  router.get('/api/app/agents/:id/browser',async ctx=>{const owner=this.auth.require(ctx).id,a=this.agent(owner,ctx.params.id);if(this.selected(owner,a)!=='browser')throw new HttpError(409,'请先选择仅浏览器环境','desktop_unselected');const c=this.context(owner,a,'browser');ctx.body=await this.command({...c.command,operation:'browser-state'},c.check)})
  router.get('/api/app/agents/:id/computer',async(ctx,next)=>{const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id),mode=this.selected(owner,a);if(!mode)return next();this.agent(owner,a.id);ctx.body=this.status(owner,a,mode)})
  router.get('/api/app/agents/:id/computer/frame',async(ctx,next)=>{const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id),mode=this.selected(owner,a);if(!mode)return next();this.agent(owner,a.id);ctx.set('Cache-Control','no-store');ctx.body=await this.capture(this.context(owner,a,mode))})
  router.post('/api/app/agents/:id/computer/:action',async(ctx,next)=>{
   const owner=this.auth.require(ctx).id,a=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id),mode=this.selected(owner,a);if(!mode)return next();this.agent(owner,a.id);const c=this.context(owner,a,mode),body=(ctx.request as any).body,action=ctx.params.action;c.check()
   if(action==='take'){
    const {requestId}=parse(z.object({requestId:z.string().uuid()}).strict(),body),old=this.current(c.key)
    if(old){if(old.owner!==owner||old.agentId!==a.id||old.requestId!==requestId)throw new HttpError(409,'已有页面正在控制这台电脑','computer_busy');while(!old.ready){c.check();if(this.current(c.key)!==old)throw new HttpError(410,'接管已失效','computer_control_expired');await new Promise(resolve=>setTimeout(resolve,80))}ctx.body={...this.status(owner,a,mode),token:old.token};return}
    const m:Manual={id:randomUUID(),token:randomBytes(32).toString('base64url'),requestId,owner,agentId:a.id,version:this.auth.pushAuthorizationVersion(owner)??0,expiresAt:Date.now()+90000,generation:(this.generation.get(c.key)??0)+1,epoch:this.epoch,actions:new Map()};this.manual.set(c.key,m);this.generation.set(c.key,m.generation);this.frames.delete(c.key)
    this.store.put('_system','computer-control',m.id,{owner,agentId:a.id,environmentId:'desktop:'+c.key,expiresAt:m.expiresAt})
    // The lane may contain agent calls waiting for this takeover. Only await
    // commands already dispatched to the host, not the whole agent lane.
    while([...this.pending.values()].some(p=>p.command.resource===c.key)){c.check();if(this.current(c.key)!==m)throw new HttpError(410,'接管已失效','computer_control_expired');await new Promise(resolve=>setTimeout(resolve,80))}
    try{await this.command({...c.command,operation:'open'},c.check);m.ready=true;m.expiresAt=Date.now()+30000;ctx.body={...this.status(owner,a,mode),token:m.token}}catch(error){this.manual.delete(c.key);this.paused.add(c.key);this.store.remove('_system','computer-control',m.id);throw error}return
   }
   const m=this.grant(owner,a,c,body)
   if(action==='renew'){m.expiresAt=Date.now()+30000;this.store.put('_system','computer-control',m.id,{owner,agentId:a.id,environmentId:'desktop:'+c.key,expiresAt:m.expiresAt});ctx.body={ok:true};return}
   if(action==='giveback'){m.releasing=true;await m.pending?.catch(()=>{});if(typeof body.notes==='string')this.notes.set(owner+':'+a.id,body.notes.slice(0,4000));this.manual.delete(c.key);this.paused.delete(c.key);this.store.remove('_system','computer-control',m.id);this.generation.set(c.key,m.generation+1);this.frames.delete(c.key);ctx.body={ok:true};return}
   if(action==='input'||action==='browser'){
    const v=parse(z.object({controlId:z.string(),token:z.string(),requestId:z.string().uuid(),generation:z.number().int(),frameId:z.string().uuid(),action:z.unknown()}).strict(),body),fingerprint=JSON.stringify([action,v.generation,v.frameId,v.action]),old=m.actions.get(v.requestId)
    if(old){if(old.fingerprint!==fingerprint)throw new HttpError(409,'请求编号冲突','idempotency_conflict');ctx.body=await old.value;return}
    const f=this.frames.get(c.key);if(!f||f.id!==v.frameId||f.generation!==v.generation||m.generation!==v.generation||Date.now()-f.capturedAt>10000)throw new HttpError(409,'画面已过期，请刷新后操作','computer_frame_stale')
    if(m.releasing||m.actions.size>=512)throw new HttpError(409,'请交还后重新接管','computer_control_expired')
    if(action==='browser'&&mode!=='browser')throw new HttpError(409,'当前环境不是浏览器','desktop_unselected')
    const input=(action==='browser'?parse(browserSchema,v.action):parse(inputSchema,v.action)),check=()=>{this.grant(owner,a,c,body);if(this.current(c.key)!==m)throw new HttpError(410,'控制权已失效','computer_control_expired')}
    const result=(m.pending??Promise.resolve()).catch(()=>{}).then(()=>this.command({...c.command,operation:action==='browser'?'browser':'input',action:input,frame:{width:f.width,height:f.height}},check));m.pending=result;m.actions.set(v.requestId,{fingerprint,value:result});ctx.body=await result;this.frames.delete(c.key);return
   }
   throw new HttpError(404,'电脑操作不存在','not_found')
  })
  return router
 }
}
