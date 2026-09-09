import { randomUUID, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { realpath,access } from 'node:fs/promises'
import { resolve, sep, join } from 'node:path'
import {LocalVmImages} from './computers/localVm.js'
import {ComputerError} from './computers/container.js'
import {z} from 'zod'
import {ComputerRuntime,ComputerGateway,type ComputerTarget} from './worker/gateway.js'
import { HttpError } from '../server/errors.js'
import { UpstreamClient } from '../server/upstream.js'
import { UpstreamServiceSession } from '../server/localAuth.js'
import { WorkspaceGateway, type GatewayTarget, type GatewayFrame } from '../server/workspaceGateway.js'
import { createWorkspaceToolLease, type WorkspaceToolLease } from '../server/workspaceToolLease.js'
import {UNCONFIGURED_COMPUTER_IMAGE} from '../shared/runner.js'
import type { RunnerCommand, RunnerConfiguration } from '../shared/runner.js'
import { LoopbackTransport, isLocalAuthorizationTarget } from '../server/loopbackAuthorization.js'

const commands=new Set(['session.create','session.resume','session.close','session.usage','session.interrupt','session.cwd.set','prompt.submit','session.steer','image.attach_bytes','file.attach','approval.respond','clarify.respond'])
interface Connection {cleanupOnly?:boolean;gateway:WorkspaceGateway|ComputerGateway;sessions:Map<string,string>;running:Set<string>;events:Promise<void>}
interface Lease {connectionId:string;profile:string;lease:WorkspaceToolLease;controller:AbortController;session:{runtimeId:string;storedId:string}}

export class RunnerAgent {
  readonly instance=randomUUID()
  private active=true
  private connected=false
  private disconnectRevision=0
  private disconnecting?:Promise<void>
  private connections=new Map<string,Connection>()
  private leases=new Map<string,Lease>()
  private closedConnections=new Map<string,number>()
  private closedLeases=new Map<string,number>()
  private inflight=new Map<string,Promise<unknown>>()
  private db:DatabaseSync
  private computers?:ComputerRuntime
  private localVm?:LocalVmImages
  private target:GatewayTarget
  private controlTransport=new LoopbackTransport()
  private serverEpoch?:string
  private controlAbort=new AbortController()
  constructor(readonly config:RunnerConfiguration,home:string,readonly fetchImpl:typeof fetch=fetch,readonly onStatus:(message:string)=>void=()=>{}) {
    const web=new URL(config.serverURL),hermes=new URL(config.hermesURL)
    if(web.username||web.password||web.search||web.hash||!['http:','https:'].includes(web.protocol))throw new Error('Web 地址无效')
    if(web.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(web.hostname)&&!config.allowInsecureLan)throw new Error('远程执行节点必须使用 HTTPS，或明确配置可信局域网 HTTP')
    if(hermes.username||hermes.password||hermes.search||hermes.hash||!['127.0.0.1','[::1]'].includes(hermes.hostname)||!['http:','https:'].includes(hermes.protocol))throw new Error('Runner 必须连接本机 Hermes')
    const client=new UpstreamClient(hermes)
    this.target={url:hermes,client,session:new UpstreamServiceSession(client,()=>config.hermesCredentials)}
    this.db=new DatabaseSync(join(home,'runner-commands.sqlite3'))
    this.db.exec('CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL)')
    if(config.computers){this.computers=new ComputerRuntime(this.db,config,home);this.localVm=new LocalVmImages(this.computers,this.db)}
    this.compactReceipts()
  }
  private async api(path:string,body?:unknown):Promise<any> {
    const url=new URL(`/api/runner/v1/${this.config.runnerId}/${path}`,this.config.serverURL)
    if(url.hostname==='localhost')url.hostname='127.0.0.1'
    const response=await (isLocalAuthorizationTarget(url)&&this.fetchImpl===fetch?this.controlTransport.fetch.bind(this.controlTransport):this.fetchImpl)(url,{
      method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.any([this.controlAbort.signal,AbortSignal.timeout(25000)]),
      headers:{Authorization:`Bearer ${this.config.token}`,'x-runner-instance':this.instance,'x-runner-protocol':'1','x-runner-features':this.computers?'computer-worker-v1,artifact-chunks-v1,helper-retirement-v1,computer-control-v1,shared-computer-v1,local-vm-v1'+(this.computers.config.imageId!==UNCONFIGURED_COMPUTER_IMAGE?',image-ready-v1':''):'',...(this.serverEpoch?{'x-runner-epoch':this.serverEpoch}:{}),'Content-Type':'application/json',...(path==='poll'&&!this.connected?{'x-runner-reset':'1'}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    })
    if(!response.ok)throw new HttpError(response.status,`执行节点连接被拒绝（HTTP ${response.status}）`,response.status===403?'runner_unauthorized':'runner_request_failed')
    const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let bytes=0
    if(!reader)throw new Error('执行节点响应为空')
    try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>40*1024*1024)throw new Error('执行节点响应超过大小限制');chunks.push(part.value)}}finally{await reader.cancel()}
    return JSON.parse(Buffer.concat(chunks).toString())
  }
  private requireProfile(profile:unknown):string {
    if(typeof profile!=='string'||!this.config.allowedProfiles.includes(profile))throw new HttpError(403,'Profile 未授权','runner_profile_forbidden')
    return profile
  }
  private async closeConnection(id:string,interrupt=true) {
    this.closedConnections.set(id,Date.now()+60000)
    const connection=this.connections.get(id)
    if(!connection)return
    this.connections.delete(id)
    for(const [leaseId,lease] of this.leases)if(lease.connectionId===id){this.closedLeases.set(leaseId,Date.now()+60000);lease.controller.abort();this.leases.delete(leaseId);void lease.lease.dispose()}
    if(interrupt){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([Promise.all([...connection.running].map(session_id=>connection.gateway.rpc('session.interrupt',{session_id}).catch(()=>{}))),new Promise(resolve=>{timer=setTimeout(resolve,3000)})])}finally{clearTimeout(timer)}}
    await connection.gateway.close()
  }
  private disconnect():Promise<void> {
    if(this.disconnecting)return this.disconnecting
    this.disconnectRevision++;this.connected=false
    const leases=[...this.leases.values()];this.leases.clear()
    for(const value of leases)value.controller.abort()
    const pending=Promise.all([
      ...leases.map(value=>value.lease.dispose()),
      ...[...this.connections.keys()].map(id=>this.closeConnection(id)),
    ]).then(()=>{}).finally(()=>{if(this.disconnecting===pending)this.disconnecting=undefined})
    this.disconnecting=pending;return pending
  }
  private async execute(command:RunnerCommand):Promise<any> {
    const p=command.payload
    if(!this.active||!this.connected)throw new Error('执行节点已断开')
    if(command.kind==='local-vm.manage'){
      if(!this.localVm)throw new HttpError(409,'本地虚拟机尚未配置','computer_unavailable')
      const input=z.object({owner:z.string().regex(/^[a-f0-9]{64}$/),op:z.enum(['status','prepare','policy','instance']),id:z.string().uuid().optional(),mode:z.enum(['shared','per-bot']).optional(),maxInstances:z.number().int().min(1).max(4).optional(),environmentId:z.string().uuid().optional(),action:z.enum(['stop','remove']).optional()}).strict().parse(p)
      const check=async()=>{if(!this.connected||!this.active||(await this.api('local-vm-check',{id:input.id})).allowed!==true)throw new ComputerError('local_vm_authorization_revoked','本地虚拟机配置授权已失效')}
      if(input.op==='status')return this.localVm.status(input.owner)
      if(input.op==='instance'){
        await check()
        const spec=this.computers!.pool.definition(input.owner,input.environmentId!)
        if(spec)await this.computers!.pool.desktop(spec,input.action!,()=>{if(!this.active||!this.connected)throw new Error('节点已断开')})
        await check();return {ok:true}
      }
      if(input.op==='prepare')return this.localVm.prepare(input.id!,check)
      await check();return this.localVm.policy(input.mode!,input.maxInstances!)
    }
    if(command.kind==='computer.control'){
      if(!this.computers)throw new HttpError(409,'电脑服务未配置','computer_unavailable')
      const input=z.object({target:z.object({environmentId:z.string().uuid(),agentId:z.string().uuid(),ownerKey:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),profile:z.string(),op:z.enum(['status','detail','lifecycle','frame','take','input','giveback']),controlId:z.string().uuid().optional(),requestId:z.string().uuid().optional(),generation:z.number().int().optional(),frameId:z.string().uuid().optional(),action:z.unknown().optional(),notes:z.string().max(4000).optional()}).strict().parse(p)
      this.requireProfile(input.profile)
      const check=async()=>{if(!this.connected||!input.controlId||(await this.api('control-check',{controlId:input.controlId})).allowed!==true)throw new HttpError(403,'电脑控制授权已失效','computer_control_expired')}
      const authorize=()=>{if(!this.connected||!this.active||Date.now()>command.expiresAt)throw new HttpError(403,'电脑请求已失效','computer_control_expired')}
      await this.computers.ready
      if(input.op==='detail'){
        const vm=await this.localVm!.status(),spec=this.computers.pool.definition(input.target.ownerKey,input.target.environmentId)
        const state=await this.computers.controls.status(input.target)
        const actual=spec?await this.computers.provider.inspect(spec):undefined
        let ready=false
        if(actual?.running)try{await this.computers.provider.health(spec!,authorize);ready=true}catch{}
        return {...state,container:actual?.running?'running':spec?'stopped':'missing',ready,inUse:['agent','pausing','human','resuming'].includes(state.mode),mode:vm.mode,maxInstances:vm.maxInstances,image:vm.image,controlMode:state.mode}
      }
      if(input.op==='lifecycle'){
        const action=z.enum(['create','start','stop','recreate','remove']).parse(input.action)
        await this.computers.desktop(input.target,input.profile,action,authorize)
        return {ok:true}
      }
      if(input.op==='status')return this.computers.controls.status(input.target)
      if(input.op==='frame')return this.computers.controls.frame(input.target,authorize)
      if(input.op==='take')return this.computers.controls.take(input.target,input.profile,input.controlId!,check)
      if(input.op==='input')return this.computers.controls.input(input.target,input.controlId!,input.requestId!,input.generation!,input.frameId!,input.action)
      return this.computers.controls.giveBack(input.target,input.controlId!,input.notes??'')
    }
    if(command.kind==='computer.retire'){
      const meta=p as unknown as ComputerTarget
      if(!this.computers||![meta.environmentId,meta.agentId].every(value=>/^[0-9a-f-]{36}$/.test(value))||!/^[a-f0-9]{64}$/.test(meta.ownerKey))throw new HttpError(400,'电脑清理请求无效','computer_cleanup_invalid')
      await this.computers.retire(meta);return {ok:true}
    }
    if(command.kind==='http') {
      const path=String(p.path),search=new URLSearchParams(String(p.search??''))
      if(path==='/api/computer/capabilities'||(p.computer&&path==='/api/plugins/yaoyao-bot-bridge/capabilities')){
        this.requireProfile(search.get('profile')??'default')
        if(p.method!=='GET'||!this.computers)throw new HttpError(409,'执行节点未配置隔离电脑','computer_unavailable')
        await Promise.all([access(this.computers.config.python),access(this.computers.config.hermesSource),access(this.computers.script)])
        return {status:200,headers:{},body:Buffer.from(JSON.stringify({version:1,ready:true,native_tools:true,in_process:true,network:this.config.computers?.network??'none'})).toString('base64')}
      }
      if(p.computer&&path==='/api/files/download')throw new HttpError(409,'隔离电脑产物需通过产物导出接口读取','computer_artifact_required')
      if(p.computer&&/^\/api\/sessions\/[^/]+\/messages$/.test(path)){
        if(p.method!=='GET'||!this.computers)throw new HttpError(403,'电脑历史不可用','computer_unavailable')
        const profile=this.requireProfile(search.get('profile')??'default'),session=this.computers.session(decodeURIComponent(path.split('/')[3]!),p.computer as ComputerTarget,profile)
        const offset=Math.max(0,Number(search.get('offset')??0)),history=session.history
        return {status:200,headers:{},body:Buffer.from(JSON.stringify({messages:history.slice(Math.max(0,history.length-offset-500),history.length-offset)})).toString('base64')}
      }
      if(p.method!=='GET'||!(/^\/api\/(?:status|profiles|config)$/.test(path)||/^\/api\/sessions\/[^/]+\/messages$/.test(path)||path==='/api/plugins/yaoyao-bot-bridge/capabilities'||path==='/api/files/download'))throw new HttpError(403,'Runner 不支持此 HTTP 操作','runner_http_forbidden')
      if(!['/api/status','/api/profiles'].includes(path))this.requireProfile(search.get('profile')??'default')
      if(path==='/api/files/download') {
        const requested=await realpath(String(search.get('path')??''))
        const roots=await Promise.all(this.config.artifactRoots.map(root=>realpath(root)))
        if(!roots.some(root=>requested===root||requested.startsWith(root+sep)))throw new HttpError(403,'文件不在允许的产物目录','runner_artifact_forbidden')
      }
      const response=await this.target.session.request(path,{search,maxResponseBytes:8*1024*1024})
      return {status:response.status,headers:Object.fromEntries(response.headers.entries()),body:response.body.toString('base64')}
    }
    const connectionId=String(p.connectionId??'')
    if(command.kind==='gateway.open') {
      if(this.closedConnections.has(connectionId)||this.connections.has(connectionId)||!/^[0-9a-f-]{36}$/.test(connectionId)||this.connections.size>=64)throw new Error('执行通道无效或已达上限')
      let gateway:WorkspaceGateway|ComputerGateway
      if(p.computer){
        const meta=p.computer as ComputerTarget
        if(!this.computers||![meta.environmentId,meta.agentId,String(p.workId)].every(value=>/^[0-9a-f-]{36}$/.test(value))||!/^[a-f0-9]{64}$/.test(meta.ownerKey))throw new HttpError(409,'电脑任务配置或授权无效','computer_unavailable')
        gateway=new ComputerGateway(this.computers,meta,String(p.workId),async()=>{if(!this.active||!this.connected||(await this.api('check',{connectionId})).allowed!==true)throw new HttpError(403,'电脑任务授权已失效','computer_authorization_revoked')},body=>this.api('artifact',{connectionId,...body}))
      }else gateway=new WorkspaceGateway(this.target)
      const connection:Connection={cleanupOnly:p.cleanupOnly===true,gateway,sessions:new Map(),running:new Set(),events:Promise.resolve()}
      this.connections.set(connectionId,connection)
      gateway.onEvent=(frame:GatewayFrame)=>{
        if(frame.session_id&&!connection.sessions.has(frame.session_id))return
        if(frame.session_id&&['message.complete','run.completed','run.failed'].includes(frame.type))connection.running.delete(frame.session_id)
        if(frame.type==='session.info'&&frame.session_id)for(const lease of this.leases.values())if(lease.session.runtimeId===frame.session_id&&typeof frame.payload?.stored_session_id==='string')lease.session.storedId=frame.payload.stored_session_id
        connection.events=connection.events.then(()=>this.api('event',{connectionId,frame})).then(()=>{},error=>{if(error instanceof HttpError&&error.status===410)void this.closeConnection(connectionId);else void this.disconnect()})
      }
      gateway.onDisconnect=()=>{void this.api('event',{connectionId,closed:true}).catch(()=>{})}
      try {await gateway.connect();if(!this.active||!this.connected||this.connections.get(connectionId)!==connection)throw new Error('执行节点已断开');return {ok:true}}catch(error){this.connections.delete(connectionId);gateway.close();throw error}
    }
    if(command.kind==='gateway.close'){await this.closeConnection(connectionId);return {ok:true}}
    if(command.kind==='gateway.rpc') {
      const connection=this.connections.get(connectionId),method=String(p.method),params=p.params as Record<string,unknown>
      if(!connection||!commands.has(method)||!params||typeof params!=='object')throw new HttpError(403,'执行通道或命令无效','runner_command_forbidden')
      if(connection.cleanupOnly&&!['session.resume','session.interrupt','session.close'].includes(method))throw new HttpError(403,'清理通道不允许执行新工作','runner_cleanup_forbidden')
      if(method==='session.create'||method==='session.resume'){if(!connection.cleanupOnly)this.requireProfile(params.profile)}
      else if(!connection.sessions.has(String(params.session_id)))throw new HttpError(403,'会话不属于这个通道','runner_session_forbidden')
      if(method==='prompt.submit')connection.running.add(String(params.session_id))
      const result=await connection.gateway.rpc(method,params)
      if(method==='session.create'||method==='session.resume'){
        if(this.connections.get(connectionId)!==connection)throw new HttpError(409,'执行通道已关闭','runner_command_uncertain')
        connection.sessions.set(String(result.session_id),String(params.profile))
      }
      if(method==='session.interrupt')connection.running.delete(String(params.session_id))
      return result
    }
    const leaseId=String(p.leaseId??'')
    if(command.kind==='lease.create') {
      this.requireProfile(p.profile)
      if(this.closedLeases.has(leaseId)||this.leases.has(leaseId)||!/^[0-9a-f-]{36}$/.test(leaseId)||this.leases.size>=64)throw new Error('工具授权无效或已达上限')
      const session=p.session as {runtimeId:string;storedId:string}
      const source=[...this.connections].find(([,c])=>c.sessions.get(session?.runtimeId)===p.profile)
      if(!source)throw new HttpError(403,'工具会话不属于此节点','runner_session_forbidden')
      const controller=new AbortController()
      const virtual=source[1].gateway
      if(virtual instanceof ComputerGateway){
        virtual.installTeamLease(leaseId,p.catalog as any[],async(toolId,args,callId)=>(await this.api('tool',{leaseId,toolId,arguments:args,callId})).result)
        const lease={bind:async()=>{},dispose:async()=>{virtual.removeTeamLease(leaseId)}}
        this.leases.set(leaseId,{lease,controller,session,connectionId:source[0],profile:String(p.profile)});return {ok:true}
      }
      const lease=await createWorkspaceToolLease({target:this.target,profile:String(p.profile),workId:String(p.workId),session:()=>session,signal:controller.signal,
        assertActive:()=>{if(!this.connected||controller.signal.aborted)throw new Error('工具授权已失效')},
        catalog:()=>p.catalog as any[],call:async(toolId,args,callId)=>(await this.api('tool',{leaseId,toolId,arguments:args,callId:callId??randomUUID()})).result,
        onFailure:()=>{controller.abort()},
      })
      if(!this.active||!this.connected||this.closedLeases.has(leaseId)||!this.connections.has(source[0])){controller.abort();await lease.dispose();throw new Error('工具授权已停止')}
      this.leases.set(leaseId,{lease,controller,session,connectionId:source[0],profile:String(p.profile)});return {ok:true}
    }
    if(command.kind==='lease.bind') {
      const lease=this.leases.get(leaseId)
      if(!lease)throw new HttpError(410,'工具授权已关闭','runner_lease_expired')
      const update=p.session as {runtimeId?:string;storedId?:string}|undefined
      if(update?.runtimeId!==lease.session.runtimeId||!this.connections.get(lease.connectionId)?.sessions.has(update.runtimeId))throw new HttpError(403,'工具不能改绑其他会话','runner_session_forbidden')
      if(typeof update.storedId!=='string')throw new Error('存储会话编号无效')
      lease.session.storedId=update.storedId;await lease.lease.bind();return {ok:true}
    }
    if(command.kind==='lease.close') {
      this.closedLeases.set(leaseId,Date.now()+60000)
      const lease=this.leases.get(leaseId);this.leases.delete(leaseId)
      if(lease){lease.controller.abort();await lease.lease.dispose()}return {ok:true}
    }
    throw new HttpError(400,'未知执行命令','runner_command_unknown')
  }
  private compactReceipts(){
    // Keep fingerprints as replay tombstones; large HTTP/file replies expire.
    this.db.prepare("UPDATE commands SET state='retired',result=NULL WHERE state='complete' AND created<?").run(Date.now()-3600000)
  }
  private handled=0
  async handle(command:RunnerCommand):Promise<unknown> {
    if(++this.handled%256===0)this.compactReceipts()
    for(const map of [this.closedConnections,this.closedLeases])for(const [id,expires] of map)if(expires<Date.now())map.delete(id)
    const existing=this.inflight.get(command.id)
    const fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex')
    const previous=this.db.prepare('SELECT * FROM commands WHERE id=?').get(command.id)
    if(previous){
      if(previous.fingerprint!==fingerprint)throw new HttpError(409,'命令编号已用于其他内容','idempotency_conflict')
      if(existing)return existing
      if(previous.state==='complete')return JSON.parse(String(previous.result))
      throw new HttpError(409,'原命令结果不确定，禁止重复执行','runner_command_uncertain')
    }
    this.db.prepare("INSERT INTO commands VALUES(?,?,'started',NULL,?)").run(command.id,fingerprint,Date.now())
    const pending=Promise.resolve().then(async()=>{
      if(command.expiresAt<=Date.now()||!(await this.api('admit',{id:command.id})).allowed||command.expiresAt<=Date.now())throw new HttpError(403,'命令授权已经失效，未执行','runner_command_not_admitted')
      return this.execute(command)
    }).then(result=>({result}),error=>({error:{message:error instanceof HttpError||error instanceof ComputerError?error.message:'执行节点操作失败',code:error instanceof HttpError||error instanceof ComputerError?error.code:'runner_error'}}))
      .then(reply=>{this.db.prepare("UPDATE commands SET state='complete',result=? WHERE id=?").run(JSON.stringify(reply),command.id);return reply})
      .finally(()=>this.inflight.delete(command.id))
    this.inflight.set(command.id,pending);return pending
  }
  private lastStatus=''
  private status(message:string){if(message!==this.lastStatus){this.lastStatus=message;this.onStatus(message)}}
  async run(signal:AbortSignal):Promise<void> {
    const deliveries=new Map<string,Promise<void>>()
    const cleanupTimer=setInterval(()=>{void this.computers?.pool.expire().catch(()=>{})},5000);cleanupTimer.unref()
    const abort=()=>{this.active=false;this.controlAbort.abort();void this.disconnect()};signal.addEventListener('abort',abort,{once:true})
    try {
      while(this.active&&!signal.aborted) {
        try {
          const revision=this.disconnectRevision
          const response=await this.api('poll')
          await this.disconnecting
          if(revision!==this.disconnectRevision)continue
          if(this.serverEpoch&&this.serverEpoch!==response.epoch)await this.disconnect()
          this.serverEpoch=response.epoch;this.connected=true;this.status('执行节点已连接')
          for(const command of response.commands as RunnerCommand[]){
            if(deliveries.has(command.id))continue
            const delivery=(async()=>{
            let reply
            try {reply=await this.handle(command)}catch(error){reply={error:{message:'原命令需要核对',code:error instanceof HttpError?error.code:'runner_error'}}}
            await this.api('result',{id:command.id,...reply as object})
            })().catch(()=>{}).finally(()=>deliveries.delete(command.id))
            deliveries.set(command.id,delivery)
          }
        }catch(error){
          this.status(error instanceof HttpError?error.message:'连接暂时中断，正在重连')
          await this.disconnect()
          if(error instanceof HttpError&&error.code==='runner_unauthorized')throw error
          if(this.active)await new Promise(resolve=>setTimeout(resolve,1000))
        }
      }
    }finally{
      clearInterval(cleanupTimer)
      signal.removeEventListener('abort',abort)
      try{
        await this.disconnect().catch(()=>{})
        await Promise.allSettled(deliveries.values());await Promise.allSettled(this.inflight.values())
        await this.localVm?.close();await this.computers?.controls.close();await this.computers?.pool.close()
      }finally{this.target.client.close();this.controlTransport.close();this.db.close();this.status('执行节点已停止')}
    }
  }
}
