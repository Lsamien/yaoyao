import {GrokAuth,grokHeaders} from './grokAuth.js'
import Router from '@koa/router'
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {z} from 'zod'
import {HttpError} from './errors.js'
import {readHostTools} from './hostToolSettings.js'
import {parse,type WorkspaceStore} from './workspaceStore.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceNodes,GatewayTarget} from './workspaceGateway.js'
import {requireTeamToolBridge} from './workspaceToolLease.js'
import type {SharedComputers} from './sharedComputers.js'
import {agentEnvs,deriveComputer,type WorkspaceAgent} from '../shared/workspace.js'
import type {ComputerControlStatus,ComputerFrame} from '../shared/computerControl.js'

interface Descriptor {gatewayUrl:string;gatewayToken:string;networkToken:string;execDaemonUrl:string;execDaemonAuthToken:string}
interface Credential {accessToken:string;account:string;version:string}
interface Manual {pending?:Promise<unknown>;releasing?:boolean;id:string;agentId:string;requestId:string;tokenHash:Buffer;token:string;expiresAt:number;generation:number;version:number;notes?:string;actions:Map<string,{fingerprint:string;value:Promise<unknown>}>}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
const field={type:'string'}
const schema=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false})
export const GROK_COMPUTER_TOOLS=[
  {id:'cloud_computer_shell',name:'cloud_computer_shell',description:'在共享的 Grok Bot 云端电脑 /workspace 中执行命令。不会在本机执行。',inputSchema:schema({command:field},['command'])},
  {id:'cloud_computer_read',name:'cloud_computer_read',description:'读取 Grok Bot 云端电脑的 UTF-8 文件。',inputSchema:schema({path:field},['path'])},
  {id:'cloud_computer_write',name:'cloud_computer_write',description:'写入 Grok Bot 云端电脑的 UTF-8 文件。',inputSchema:schema({path:field,content:field},['path','content'])},
  {id:'cloud_computer_desktop',name:'cloud_computer_desktop',description:'查看 Grok Bot 云端电脑桌面，返回真实截图。',inputSchema:schema({},[])},
  {id:'cloud_computer_action',name:'cloud_computer_action',description:'操作 Grok Bot 云端电脑。先查看桌面，再使用 click、text、key 或 scroll。',inputSchema:schema({kind:{enum:['click','text','key','scroll']},x:{type:'integer'},y:{type:'integer'},text:field,key:field,direction:{enum:['up','down','left','right']}},['kind'])},
]
export const GROK_COMPUTER_RULES='当前环境是云虚拟机，也就是 Grok Bot 虚拟机，工作目录 /workspace。电脑操作、文件读写和命令必须使用 cloud_computer_*。已连接的电脑、服务器和虚拟环境都不属于这台云虚拟机。多个机器人共享工作文件和浏览器登录，避免覆盖其他机器人的工作；人工接管时等待交还。'
export function grokComputerRules(_allowHostEnvironment = false){
  return GROK_COMPUTER_RULES
}

/** Credentials and network tokens stay on the Web server. Every robot of an
 * account addresses the same existing cloud computer; robots keep their own
 * Hermes sessions and permissions. No cloud provisioning happens in GETs. */
export class GrokCloud {
  readonly authorization:GrokAuth
  private connectionEpoch=new Map<string,number>()
  private descriptors=new Map<string,{value:Descriptor;expiresAt:number}>()
  private connecting=new Map<string,Promise<Descriptor>>()
  private queue=new Map<string,Promise<unknown>>()
  private manual=new Map<string,Manual>()
  private frames=new Map<string,ComputerFrame>()
  private paused=new Set<string>()
  private handoff=new Map<string,string>()
  private generations=new Map<string,number>()
  private activity=new Map<string,number>()
  private executing=new Map<string,number>()
  private stateCache=new Map<string,{at:number;value:{running:boolean}}>()
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,readonly shared:SharedComputers,
    readonly fetcher:typeof fetch=fetch,readonly broker='https://api2.cursor.sh'){
    this.authorization=new GrokAuth(store,auth,nodes,{fetcher,broker,
      beforeChange:(owner,nextAccount)=>{const old=this.configured(owner)?this.credential(owner).account:undefined;if(old===nextAccount&&nextAccount)return
        const active=new Set(this.store.list<WorkspaceAgent>(owner,'agent').filter(a=>this.selected(owner,a)).map(a=>a.id))
        if(this.current(owner)||this.queue.has(owner)||(this.activity.get(owner)??0)>0||this.store.list<{agentId:string;status:string}>(owner,'turn').some(t=>active.has(t.agentId)&&['queued','running','waiting','uncertain','cancelling'].includes(t.status)))throw new HttpError(409,'请先停止机器人的云端任务并交还控制权，再切换账号或断开连接。','computer_busy')
      },
      onChange:(owner,identityChanged)=>{this.stateCache.delete(owner);if(!identityChanged)return
        this.connectionEpoch.set(owner,(this.connectionEpoch.get(owner)??0)+1);this.descriptors.delete(owner);this.connecting.delete(owner);this.frames.delete(owner)
        const manual=this.manual.get(owner);if(!manual&&(!this.configured(owner)||this.credential(owner).accessToken)){this.paused.delete(owner);this.handoff.delete(owner)}if(manual){this.store.remove('_system','computer-control',manual.id);this.manual.delete(owner);this.paused.add(owner)}
      },
    })
  }
  preferDesktop?:(owner:string,agent:WorkspaceAgent)=>boolean
  beforeSelection?:(owner:string,agentId:string)=>void
  configured(owner:string){return !!this.store.get(owner,'grok-cloud','connection')}
  selected(owner:string,agent:WorkspaceAgent){
    if(agent.archived||agent.remoteAgentId)return false
    try{return readHostTools(this.store.home).cloud&&this.configured(owner)}catch{return false}
  }
  private credential(owner:string):Credential {const row=this.store.get<{sealed:string}>(owner,'grok-cloud','connection');if(!row)throw new HttpError(409,'请先连接 Grok Bot 云端账号','grok_cloud_not_configured');return this.nodes.open<Credential>(row.sealed)}
  private agent(owner:string,id:string){const agent=this.store.require<WorkspaceAgent>(owner,'agent',id);if(agent.archived||agent.remoteAgentId)throw new HttpError(409,'此机器人不能连接云端电脑','grok_agent_unavailable');this.nodes.requireSource(owner,agent);return agent}
  private authorize(owner:string,agentId:string){const agent=this.agent(owner,agentId);if(!this.selected(owner,agent))throw new HttpError(410,'机器人已切换电脑','computer_control_expired');return agent}
  private async response(response:Response){
    const text=await response.text()
    let value:any;try{value=JSON.parse(text)}catch{throw new HttpError(502,'Grok Bot 返回了无效响应','grok_response_invalid')}
    if(!response.ok){
      if(response.headers.get('x-automation-failure-hint')==='SAND_CLIENT_UPDATE_REQUIRED'||/version.*(?:supported|update)/i.test(String(value.message)))throw new HttpError(409,'Grok Bot 客户端协议需要更新，已有登录仍保留。','grok_client_update_required')
      throw new HttpError(response.status===401||response.status===403?409:502,response.status===401?'Grok Bot 未接受当前授权，请重新登录或检查账号权限。':response.status===403?'该 Grok Bot 账号没有当前云端资源的访问权限。':`Grok Bot 请求失败（${response.status}）`,'grok_request_failed')
    }
    return value
  }
  private async rpc(owner:string,method:string,body:unknown={}){
    let credential=await this.authorization.credentials(owner)
    const request=()=>this.fetcher(`${this.broker}/aiserver.v1.GrokBotService/${method}`,{method:'POST',redirect:'error',headers:grokHeaders(credential.accessToken,credential.version),body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
    let response=await request()
    if(response.status===401){
      const value=await response.clone().json().catch(()=>({})) as any
      const update=response.headers.get('x-automation-failure-hint')==='SAND_CLIENT_UPDATE_REQUIRED'||/version.*(?:supported|update)/i.test(String(value.message))
      if(!update){const current=await this.authorization.credentials(owner);credential=await this.authorization.credentials(owner,current.accessToken===credential.accessToken);response=await request()}
    }
    return this.response(response)
  }
  async configure(owner:string,accessToken:string,version:string,refreshToken?:string){return this.authorization.configure(owner,accessToken,version,refreshToken)}
  async state(owner:string){
    if(!this.configured(owner))return {configured:false,running:false}
    const cached=this.stateCache.get(owner);if(cached&&Date.now()-cached.at<5000)return {configured:true,...cached.value}
    const value=await this.rpc(owner,'GetSandBoxRunState'),state={running:value.state==='SAND_BOX_RUN_STATE_RUNNING'}
    this.stateCache.set(owner,{at:Date.now(),value:state});return {configured:true,...state}
  }
  async connect(owner:string){
    await this.authorization.credentials(owner)
    const epoch=this.connectionEpoch.get(owner)??0
    const cached=this.descriptors.get(owner);if(cached&&cached.expiresAt>Date.now())return cached.value
    const pending=this.connecting.get(owner);if(pending)return pending
    const work=(async()=>{
      const value=await this.rpc(owner,'EnsureSandBox') as Descriptor
      for(const key of ['gatewayUrl','execDaemonUrl'] as const){const url=new URL(value[key]);if(url.protocol!=='https:'||!url.hostname.endsWith('.cursorvm.com')||url.username||url.password)throw new HttpError(502,'云端电脑地址无效','grok_endpoint_invalid')}
      if(!value.gatewayToken||!value.networkToken||!value.execDaemonAuthToken)throw new HttpError(502,'云端电脑连接信息不完整','grok_endpoint_invalid')
      if((this.connectionEpoch.get(owner)??0)!==epoch||!this.configured(owner))throw new HttpError(409,'Grok Bot 连接已改变，旧连接已丢弃。','grok_auth_superseded')
      this.descriptors.set(owner,{value,expiresAt:Date.now()+5*60000});return value
    })().finally(()=>{if(this.connecting.get(owner)===work)this.connecting.delete(owner)})
    this.connecting.set(owner,work);return work
  }
  private descriptor(owner:string){const value=this.descriptors.get(owner);if(!value||value.expiresAt<=Date.now())throw new HttpError(409,'请打开云端电脑以建立连接','grok_connection_required');return value.value}
  private headers(d:Descriptor){return {authorization:`Bearer ${d.execDaemonAuthToken}`,'x-anyrun-network-token':d.networkToken,'connect-protocol-version':'1'}}
  async execute(owner:string,command:string,args:string[],signal?:AbortSignal){
    await this.authorization.credentials(owner)
    const epoch=this.connectionEpoch.get(owner)??0
    const d=this.descriptor(owner),json=Buffer.from(JSON.stringify({command,args,cwd:'/workspace'})),body=Buffer.alloc(5+json.length);body.writeUInt32BE(json.length,1);json.copy(body,5)
    const response=await this.fetcher(`${d.execDaemonUrl.replace(/\/$/,'')}/agent.v1.ControlService/Exec`,{method:'POST',redirect:'error',headers:{...this.headers(d),'content-type':'application/connect+json'},body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)})
    if(!response.ok)throw new HttpError(502,`云端命令未被接受（${response.status}）`,'grok_exec_failed')
    let buffer=Buffer.alloc(0),stdout='',stderr='',exitCode:number|undefined,total=0
    for await(const chunk of response.body! as any){total+=chunk.length;if(total>8*1024*1024)throw new HttpError(502,'云端命令输出超过限制','grok_output_limit');buffer=Buffer.concat([buffer,Buffer.from(chunk)])
      while(buffer.length>=5){const size=buffer.readUInt32BE(1);if(size>8*1024*1024)throw new HttpError(502,'云端响应超过限制','grok_output_limit');if(buffer.length<5+size)break
        const flags=buffer[0],event=JSON.parse(buffer.subarray(5,5+size).toString());buffer=buffer.subarray(5+size)
        if(flags===2&&event.error)throw new HttpError(502,'云端命令未正常结束','grok_exec_failed')
        if(event.stdoutEvent)stdout+=event.stdoutEvent.data??'';if(event.stderrEvent)stderr+=event.stderrEvent.data??'';if(event.exitEvent)exitCode=event.exitEvent.exitCode??0
      }
    }
    if(buffer.length||exitCode===undefined)throw new HttpError(502,'云端命令的完成状态不确定，未自动重试','grok_exec_uncertain')
    if((this.connectionEpoch.get(owner)??0)!==epoch)throw new HttpError(409,'执行期间云端授权已变化，请核对原执行结果，未自动重试。','grok_exec_uncertain')
    return {stdout,stderr,exitCode}
  }
  async capture(owner:string):Promise<ComputerFrame>{
    await this.authorization.credentials(owner)
    const cached=this.frames.get(owner),generation=this.generations.get(owner)??0
    if(cached&&Date.now()-cached.capturedAt<900&&cached.generation===generation)return cached
    const script="import os,io,base64,json; os.environ['DISPLAY']=':1'; from PIL import ImageGrab; im=ImageGrab.grab(xdisplay=':1'); b=io.BytesIO(); im.save(b,format='PNG'); print(json.dumps({'data':base64.b64encode(b.getvalue()).decode(),'width':im.width,'height':im.height}))"
    const result=await this.execute(owner,'python3',['-c',script])
    if(result.exitCode)throw new HttpError(502,'云端桌面截图暂不可用，请重试','grok_frame_failed')
    const frame={...JSON.parse(result.stdout),id:randomUUID(),capturedAt:Date.now(),generation} as ComputerFrame
    if(!frame.data||!Number.isInteger(frame.width)||!Number.isInteger(frame.height))throw new HttpError(502,'云端画面无效','grok_frame_failed')
    this.frames.set(owner,frame);return frame
  }
  private current(owner:string){const manual=this.manual.get(owner);if(manual&&(manual.expiresAt<=Date.now()||this.auth.pushAuthorizationVersion(owner)!==manual.version)){this.manual.delete(owner);this.paused.add(owner);this.store.remove('_system','computer-control',manual.id);this.generations.set(owner,manual.generation+1);return undefined}return manual}
  async status(owner:string):Promise<ComputerControlStatus>{const manual=this.current(owner);if(manual)return {backend:'grok',mode:'human',controlId:manual.id,generation:manual.generation,canResume:(this.activity.get(owner)??0)>0};if(this.paused.has(owner))return {backend:'grok',mode:'error',error:'接管连接已断开，请重新接管并交还后继续',generation:this.generations.get(owner)??0};const state=await this.state(owner);return {backend:'grok',mode:state.running?(this.activity.get(owner)?'agent':'idle'):'off',generation:this.generations.get(owner)??0}}
  private serial<T>(owner:string,work:()=>Promise<T>):Promise<T>{const previous=this.queue.get(owner)??Promise.resolve();const next=previous.catch(()=>{}).then(work);this.queue.set(owner,next);void next.finally(()=>{if(this.queue.get(owner)===next)this.queue.delete(owner)}).catch(()=>{});return next}
  private async available(owner:string,agentId:string,signal?:AbortSignal){
    while(this.current(owner)||this.paused.has(owner)){signal?.throwIfAborted();this.authorize(owner,agentId);await new Promise(resolve=>setTimeout(resolve,200))}
    signal?.throwIfAborted();this.authorize(owner,agentId)
  }
  async requireAvailable(owner:string,agent:WorkspaceAgent,target:GatewayTarget){await this.authorization.credentials(owner);await requireTeamToolBridge(target,agent.profile)}
  async call(owner:string,agentId:string,id:string,input:unknown,signal?:AbortSignal){
    this.activity.set(owner,(this.activity.get(owner)??0)+1)
    try{const result=await this.serial(owner,async()=>{
      await this.available(owner,agentId,signal);await this.connect(owner);await this.available(owner,agentId,signal);this.authorize(owner,agentId)
      this.executing.set(owner,(this.executing.get(owner)??0)+1)
      try{
      if(id==='cloud_computer_desktop'){const frame=await this.capture(owner);return {content:[{type:'image',mimeType:'image/png',data:frame.data},{type:'text',text:JSON.stringify({width:frame.width,height:frame.height})}]}}
      if(id==='cloud_computer_shell'){const args=parse(z.object({command:z.string().min(1).max(16000)}).strict(),input);return await this.execute(owner,'/bin/sh',['-c',args.command],signal)}
      if(id==='cloud_computer_read'){const args=parse(z.object({path:z.string().min(1).max(4096)}).strict(),input);return await this.execute(owner,'python3',['-c',"import pathlib,sys; p=pathlib.Path(sys.argv[1]); print(p.read_text()[:64000])",args.path],signal)}
      if(id==='cloud_computer_write'){const args=parse(z.object({path:z.string().min(1).max(4096),content:z.string().max(64000)}).strict(),input);return await this.execute(owner,'python3',['-c',"import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(sys.argv[2]); print('written')",args.path,args.content],signal)}
      if(id==='cloud_computer_action')return await this.input(owner,input,signal)
      throw new HttpError(404,'云端工具不存在','tool_not_found')
      }finally{this.executing.set(owner,Math.max(0,(this.executing.get(owner)??1)-1))}
    });const note=this.handoff.get(owner);if(note){this.handoff.delete(owner);return result&&typeof result==='object'&&Array.isArray((result as any).content)?{...result,content:[...(result as any).content,{type:'text',text:'人工交还说明：'+note}]}:{...result,handoffNote:note}}return result}finally{this.activity.set(owner,Math.max(0,(this.activity.get(owner)??1)-1))}
  }
  private async input(owner:string,input:unknown,signal?:AbortSignal){
    const action=parse(z.discriminatedUnion('kind',[
      z.object({kind:z.literal('click'),x:z.number().int().min(0).max(16384),y:z.number().int().min(0).max(16384),button:z.enum(['left','right','middle']).optional(),count:z.number().int().min(1).max(2).optional()}).strict(),
      z.object({kind:z.literal('drag'),fromX:z.number().int().min(0).max(16384),fromY:z.number().int().min(0).max(16384),toX:z.number().int().min(0).max(16384),toY:z.number().int().min(0).max(16384)}).strict(),
      z.object({kind:z.literal('text'),text:z.string().max(16000)}).strict(),
      z.object({kind:z.literal('key'),key:z.string().regex(/^[A-Za-z0-9_+ -]{1,40}$/),modifiers:z.array(z.enum(['ctrl','alt','shift','super'])).max(4).optional()}).strict(),
      z.object({kind:z.literal('scroll'),direction:z.enum(['up','down','left','right']),amount:z.number().int().min(1).max(50).optional()}).strict(),
    ]),input)
    const argv=action.kind==='text'?['type','--clearmodifiers','--',action.text]:action.kind==='key'?['key','--clearmodifiers',[...(action.modifiers??[]),action.key].join('+')]:action.kind==='scroll'?['click','--repeat',String(action.amount??3),String({up:4,down:5,left:6,right:7}[action.direction])]:action.kind==='drag'?['mousemove',String(action.fromX),String(action.fromY),'mousedown','1','mousemove',String(action.toX),String(action.toY),'mouseup','1']:['mousemove',String(action.x),String(action.y),'click','--repeat',String(action.count??1),String({left:1,middle:2,right:3}[action.button??'left'])]
    const result=await this.execute(owner,'/usr/bin/env',['DISPLAY=:1','xdotool',...argv],signal)
    if(result.exitCode!==0)throw new HttpError(502,'云端桌面未接受输入','grok_input_failed')
    this.frames.delete(owner);return {ok:true}
  }
  private grant(owner:string,agentId:string,body:unknown){const value=parse(z.object({controlId:z.string().uuid(),token:z.string().min(32).max(256)}).passthrough(),body),manual=this.current(owner);if(!manual||manual.id!==value.controlId||manual.agentId!==agentId||!timingSafeEqual(manual.tokenHash,Buffer.from(hash(value.token),'hex')))throw new HttpError(410,'云端控制权已失效','computer_control_expired');this.authorize(owner,agentId);return manual}
  router(){const router=new Router()
    router.get('/api/app/grok-cloud',async ctx=>{const owner=this.auth.require(ctx).id;ctx.body={...await this.state(owner),version:this.configured(owner)?this.credential(owner).version:'0.47.0'}})
    router.post('/api/app/grok-cloud/connect',async ctx=>{const owner=this.auth.requireAdmin(ctx).id,body=parse(z.object({accessToken:z.string().min(32).max(16000).optional(),refreshToken:z.string().min(1).max(16000).optional(),version:z.string().regex(/^\d+\.\d+\.\d+$/).default('0.47.0'),importLocal:z.boolean().optional()}).strict(),(ctx.request as any).body);let token=body.accessToken,refreshToken=body.refreshToken
      if(body.importLocal){try{const legacy=JSON.parse(await readFile(join(homedir(),'.grokbot','local-docker-credential','inference.json'),'utf8'));token=legacy.accessToken;refreshToken=legacy.refreshToken}catch{throw new HttpError(409,'未找到可导入的服务器登录，请使用浏览器授权。','grok_login_missing')}}
      if(!token)throw new HttpError(400,'请先通过浏览器完成 Grok Bot 授权。','grok_login_missing');ctx.body=await this.configure(owner,token,body.version,refreshToken)
    })
    router.put('/api/app/agents/:id/computer-selection',async ctx=>{
      const owner=this.auth.require(ctx).id,agent=this.agent(owner,ctx.params.id),body=parse(z.union([
        z.object({envs:z.object({vm:z.boolean().optional(),cloud:z.boolean().optional(),desktop:z.boolean().optional(),browser:z.boolean().optional()}).strict(),desktopHost:z.union([z.literal('local'),z.string().uuid(),z.null()]).optional()}).strict(),
        z.object({computer:z.enum(['auto','cloud','vm','local','browser','off']),desktopHost:z.union([z.literal('local'),z.string().uuid(),z.null()]).optional(),allowHostEnvironment:z.boolean().optional(),vmExecution:z.enum(['worker','profile']).optional()}).strict(),
      ]),(ctx.request as any).body)
      const legacy='computer' in body
      const legacyBody=legacy?body:undefined
      const envsBody=legacy?undefined:body.envs
      const current=agentEnvs(agent)
      const next=envsBody?{vm:envsBody.vm===true,cloud:envsBody.cloud===true,desktop:envsBody.desktop===true,browser:envsBody.browser===true}:undefined
      const targetComputer=next?deriveComputer(next):legacyBody!.computer
      this.beforeSelection?.(owner,agent.id);this.shared.assertLocalVmIdle(owner,[agent.id]);if(this.current(owner))throw new HttpError(409,'请先交还云端电脑','computer_busy')
      if(legacyBody&&legacyBody.vmExecution==='profile'&&legacyBody.allowHostEnvironment===false)throw new HttpError(400,'本机协作模式需要本机环境，请选择虚拟机模式','computer_profile_host_required')
      const vmExecution=targetComputer==='vm'?(next?(agent.vmExecution??'worker'):(legacyBody!.vmExecution??(legacyBody!.allowHostEnvironment===false?'worker':agent.vmExecution)??'worker')):'worker'
      const allowHostEnvironment=next?((next.vm||next.cloud)&&agent.allowHostEnvironment===true):((legacyBody!.computer==='vm'&&vmExecution==='profile')||(['vm','cloud'].includes(legacyBody!.computer)&&(legacyBody!.allowHostEnvironment??(legacyBody!.vmExecution==='worker'?false:agent.allowHostEnvironment)??false)))
      if(legacyBody&&legacyBody.computer==='vm'&&allowHostEnvironment)this.nodes.targetForAgent(owner,{...agent,execution:'computer',computer:'vm',allowHostEnvironment:true,vmExecution})
      const enteringCloud=(next?next.cloud:legacyBody!.computer==='cloud')&&!current.cloud
      if(enteringCloud)await this.requireAvailable(owner,agent,this.nodes.target(owner,agent.nodeId))
      this.store.atomic(()=>{const execution=next?'profile':targetComputer==='vm'?'computer':targetComputer==='auto'?(agent.execution??'profile'):'profile';if(execution!=='computer'&&agent.computerEnvironmentId&&!(next&&next.vm))this.shared.detachLocalVm(owner,agent);this.store.updateAgent(owner,agent.id,{...(next?{envs:next}:{computer:legacyBody!.computer}),...(body.desktopHost!==undefined?{desktopHost:body.desktopHost}:{}),execution,allowHostEnvironment,vmExecution});const updated=this.store.require<WorkspaceAgent>(owner,'agent',agent.id);this.store.prepareAgent?.(owner,updated);this.store.put(owner,'agent',agent.id,updated)})
      if(enteringCloud)await this.connect(owner)
      ctx.body={agent:this.store.agentSummary(this.store.require<WorkspaceAgent>(owner,'agent',agent.id))}
    })
    router.get('/api/app/agents/:id/cloud-computer',async ctx=>{const owner=this.auth.require(ctx).id,agent=this.agent(owner,ctx.params.id);ctx.body={...await this.state(owner),selected:this.selected(owner,agent),connected:!!this.descriptors.get(owner)&&this.descriptors.get(owner)!.expiresAt>Date.now(),shared:true,...await this.status(owner)}})
    router.post('/api/app/agents/:id/cloud-computer/open',async ctx=>{const owner=this.auth.require(ctx).id;this.authorize(owner,ctx.params.id);await this.connect(owner);ctx.body={ok:true}})
    // These routes precede the local computer router and preserve its wire
    // protocol so the desktop and iOS takeover viewers share one UI contract.
    router.use('/api/app/agents/:id/computer',async(ctx,next)=>{const owner=this.auth.require(ctx).id,agent=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id);if(typeof ctx.query.backend==='string'&&ctx.query.backend!=='cloud')return next();if(!this.selected(owner,agent))return next();this.authorize(owner,agent.id);ctx.state.grokOwner=owner;return next()})
    router.get('/api/app/agents/:id/computer',async(ctx,next)=>{const owner=ctx.state.grokOwner;if(!owner)return next();ctx.body=await this.status(owner)})
    router.get('/api/app/agents/:id/computer/frame',async(ctx,next)=>{const owner=this.auth.require(ctx).id,agent=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id);if(typeof ctx.query.backend==='string'&&ctx.query.backend!=='cloud')return next();if(!this.selected(owner,agent))return next();this.authorize(owner,agent.id);ctx.set('Cache-Control','no-store');ctx.body=await this.capture(owner)})
    router.post('/api/app/agents/:id/computer/:action',async(ctx,next)=>{
      const owner=this.auth.require(ctx).id,agent=this.store.require<WorkspaceAgent>(owner,'agent',ctx.params.id);if(typeof ctx.query.backend==='string'&&ctx.query.backend!=='cloud')return next();if(!this.selected(owner,agent))return next();this.authorize(owner,agent.id)
      const body=(ctx.request as any).body,action=ctx.params.action
      if(action==='take'){
        const value=parse(z.object({requestId:z.string().uuid()}).strict(),body),old=this.current(owner)
        if(old){if(old.agentId!==agent.id||old.requestId!==value.requestId)throw new HttpError(409,'其他页面正在控制同一台云端电脑','computer_busy');ctx.body={...await this.status(owner),token:old.token};return}
        await this.connect(owner)
        const d=this.descriptor(owner),health=await this.response(await this.fetcher(d.gatewayUrl+'/health',{headers:{authorization:`Bearer ${d.gatewayToken}`,'x-anyrun-network-token':d.networkToken},signal:AbortSignal.timeout(10000)}))
        if(health.isBusy)throw new HttpError(409,'Grok Bot 正在操作这台电脑，请先在 Grok Bot 中暂停后接管','computer_busy')
        if(this.current(owner))throw new HttpError(409,'其他页面已取得这台电脑的控制权','computer_busy')
        const token=randomBytes(32).toString('base64url'),generation=(this.generations.get(owner)??0)+1
        const manual:Manual={id:randomUUID(),agentId:agent.id,requestId:value.requestId,token,tokenHash:Buffer.from(hash(token),'hex'),generation,expiresAt:Date.now()+90000,version:this.auth.pushAuthorizationVersion(owner)??0,actions:new Map()}
        this.manual.set(owner,manual);this.generations.set(owner,generation)
        this.store.put('_system','computer-control',manual.id,{owner,agentId:agent.id,environmentId:'grok:'+this.credential(owner).account,expiresAt:manual.expiresAt})
        while(this.executing.get(owner)){if(!this.current(owner))throw new HttpError(410,'接管等待超时，请重试','computer_control_expired');await new Promise(resolve=>setTimeout(resolve,100))}
        manual.expiresAt=Date.now()+30000
        ctx.body={...await this.status(owner),token};return
      }
      const manual=this.grant(owner,agent.id,body)
      if(action==='renew'){manual.expiresAt=Date.now()+30000;this.store.put('_system','computer-control',manual.id,{owner,agentId:agent.id,environmentId:'grok:'+this.credential(owner).account,expiresAt:manual.expiresAt});ctx.body={ok:true};return}
      if(action==='giveback'){if(typeof body.notes==='string'&&body.notes.trim())this.handoff.set(owner,body.notes.trim().slice(0,4000));manual.releasing=true;await manual.pending?.catch(()=>{});this.manual.delete(owner);this.paused.delete(owner);this.store.remove('_system','computer-control',manual.id);this.generations.set(owner,manual.generation+1);this.frames.delete(owner);ctx.body={ok:true};return}
      if(action==='input'){
        const value=parse(z.object({controlId:z.string(),token:z.string(),requestId:z.string().uuid(),generation:z.number().int(),frameId:z.string().uuid(),action:z.unknown()}).strict(),body),frame=this.frames.get(owner)
        const fingerprint=JSON.stringify([value.generation,value.frameId,value.action]),previous=manual.actions.get(value.requestId)
        if(previous){if(previous.fingerprint!==fingerprint)throw new HttpError(409,'输入请求编号冲突','idempotency_conflict');ctx.body=await previous.value;return}
        if(!frame||frame.id!==value.frameId||frame.generation!==value.generation||manual.generation!==value.generation||Date.now()-frame.capturedAt>10000)throw new HttpError(409,'桌面画面已过期，请刷新后操作','computer_frame_stale')
        if(manual.actions.size>=512)throw new HttpError(429,'请交还后重新接管电脑','computer_input_limit')
        if(manual.releasing)throw new HttpError(409,'正在交还控制权','computer_control_expired')
        const result=(manual.pending??Promise.resolve()).catch(()=>{}).then(()=>{this.grant(owner,agent.id,body);return this.input(owner,value.action)});manual.pending=result;manual.actions.set(value.requestId,{fingerprint,value:result});ctx.body=await result;return
      }
      throw new HttpError(404,'电脑操作不存在','not_found')
    })
    return router
  }
}
