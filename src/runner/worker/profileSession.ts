import {setTimeout as delay} from 'node:timers/promises'
import {HttpError} from '../../server/errors.js'
import {WorkspaceGateway,type GatewayFrame,type GatewayTarget} from '../../server/workspaceGateway.js'
import {createWorkspaceToolLease,requireTeamToolBridge,type WorkspaceToolLease} from '../../server/workspaceToolLease.js'
import type {WorkerTool} from './process.js'

/** A normal Hermes Profile session, with the same native tool bridge as cloud computers. */
export class ProfileComputerSession {
  private fileTransferVersion=0
  private readonly gateway:WorkspaceGateway
  private toolLease?:WorkspaceToolLease
  private runtimeId=''
  storedId=''
  private closed=false
  private readonly controller=new AbortController()
  onEvent:(frame:GatewayFrame)=>void=()=>{}
  onDisconnect:()=>void=()=>{}
  onStoredId:(id:string)=>void=()=>{}
  constructor(readonly target:GatewayTarget,readonly profile:string,readonly workId:string,
    readonly authorize:()=>void,readonly catalog:()=>WorkerTool[],
    readonly call:(name:string,args:unknown,id:string)=>Promise<unknown>,
    readonly computerPolicy?: {mode:'isolated'|'profile';hostAccess:boolean},readonly workspaceMemory:()=>boolean=()=>false){
    this.gateway=new WorkspaceGateway(target)
    this.gateway.onDisconnect=()=>{if(!this.closed)this.onDisconnect()}
    this.gateway.onEvent=frame=>{
      if(this.closed||!this.runtimeId||frame.session_id!==this.runtimeId)return
      if(frame.type==='session.info'){
        const id=frame.payload?.stored_session_id??frame.payload?.session_key
        if(typeof id==='string'&&id){this.storedId=id;this.onStoredId(id)}
      }
      this.onEvent(frame)
    }
  }
  async open(storedId:string|undefined,params:Record<string,unknown>){
    if(this.computerPolicy){
      const response=await this.target.session.request('/api/plugins/yaoyao-bot-bridge/capabilities',{search:new URLSearchParams({profile:this.profile}),cache:'reload'})
      let capability:any;try{capability=JSON.parse(response.body.toString())}catch{}
      this.fileTransferVersion=capability?.file_transfer_version??0
      if(response.status!==200||capability?.ready!==true||capability?.computer_runtime_version!==2)
        throw new HttpError(409,'请更新夭夭工具桥并重启 Hermes Dashboard 服务，当前服务尚未加载托管虚拟机会话能力。','computer_bridge_upgrade_required')
    }
    await this.gateway.connect()
    const {session_id:_virtual,recoverOnly:_recover,...options}=params
    const opened=await this.gateway.rpc(storedId?'session.resume':'session.create',{
      ...options,profile:this.profile,close_on_disconnect:false,...(storedId?{session_id:storedId}:{}),
    })
    this.runtimeId=String(opened.session_id??'')
    this.storedId=String(opened.stored_session_id??opened.session_key??storedId??'')
    if(!this.runtimeId||!this.storedId)throw new HttpError(502,'本机 Profile 会话身份不完整','computer_profile_session_invalid')
    this.onStoredId(this.storedId)
    return opened
  }
  async bind(){
    this.authorize()
    if(!this.toolLease){
      await requireTeamToolBridge(this.target,this.profile)
      this.toolLease=await createWorkspaceToolLease({target:this.target,profile:this.profile,workId:this.workId,
        session:()=>({runtimeId:this.runtimeId,storedId:this.storedId}),signal:this.controller.signal,computerPolicy:this.computerPolicy,workspaceMemory:this.workspaceMemory(),
        assertActive:()=>{this.controller.signal.throwIfAborted();this.authorize()},
        catalog:()=>this.catalog().map(tool=>({...tool,id:tool.id??tool.name})),
        call:async(name,args,id)=>{
          const value=await this.call(name,args,id!)
          // Hermes Worker uses OpenAI image blocks; the Profile bridge speaks MCP.
          if(value&&typeof value==='object'&&(value as any)._multimodal){
            const result=value as any
            return {content:[{type:'text',text:result.text_summary??''},...result.content.map((item:any)=>{
              const match=/^data:(image\/[a-z]+);base64,(.+)$/.exec(item.image_url?.url??'')
              if(!match)throw new Error('虚拟机截图格式无效')
              return {type:'image',mimeType:match[1],data:match[2]}
            })]}
          }
          return value
        },onFailure:()=>{void this.stop().finally(()=>this.onDisconnect()).catch(()=>{})},
      })
    }
    await this.toolLease.bind()
  }
  rpc(method:string,params:Record<string,unknown>={}){
    const {session_id:_virtual,workMarker:_marker,...options}=params
    // session.active_list is manager-scoped: Hermes' contract is extra=forbid and rejects session_id.
    if(method==='session.active_list')return this.gateway.rpc(method,{...options,profile:this.profile})
    return this.gateway.rpc(method,{...options,session_id:this.runtimeId})
  }
  async file(action:'read'|'write',path:string,data?:string){
    this.authorize()
    if(!this.toolLease?.profileRequest)throw new HttpError(403,'Hermes 文件授权尚未建立','computer_file_forbidden')
    return this.toolLease.profileRequest('/computer-file',{action,path,...(data!==undefined?{data}:{})})
  }
  async transfer(direction:'read'|'write',path:string,transfer:Record<string,unknown>){
    this.authorize()
    if(this.fileTransferVersion!==1)throw new HttpError(409,'请更新 Hermes 工具桥以使用分块文件传输','computer_transfer_upgrade_required')
    if(!this.toolLease?.profileRequest)throw new HttpError(403,'Hermes 文件授权尚未建立','computer_file_forbidden')
    return this.toolLease.profileRequest('/computer-file',{action:'transfer',direction,path,transfer})
  }
  async stop(){
    if(!this.runtimeId||this.closed)return
    await this.rpc('session.interrupt')
    // An interrupt acknowledgement precedes actual termination of native tools.
    const deadline=Date.now()+20000
    for(;;){
      const state=await this.rpc('session.active_list')
      const session=state.sessions?.find((item:{id:string})=>item.id===this.runtimeId)
      if(session?.status==='idle')return
      if(Date.now()>=deadline)throw new HttpError(409,'本机任务尚未停止，暂不能交出电脑控制权','computer_profile_stopping')
      await delay(100,undefined,{signal:this.controller.signal})
    }
  }
  async close(){
    if(this.closed)return
    this.closed=true;this.controller.abort()
    await this.toolLease?.dispose()
    this.gateway.close()
  }
}
