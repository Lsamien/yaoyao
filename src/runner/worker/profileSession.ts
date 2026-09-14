import {setTimeout as delay} from 'node:timers/promises'
import {HttpError} from '../../server/errors.js'
import {WorkspaceGateway,type GatewayFrame,type GatewayTarget} from '../../server/workspaceGateway.js'
import {createWorkspaceToolLease,requireTeamToolBridge,type WorkspaceToolLease} from '../../server/workspaceToolLease.js'
import type {WorkerTool} from './process.js'

/** A normal Hermes Profile session, with the same native tool bridge as cloud computers. */
export class ProfileComputerSession {
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
    readonly call:(name:string,args:unknown,id:string)=>Promise<unknown>){
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
        session:()=>({runtimeId:this.runtimeId,storedId:this.storedId}),signal:this.controller.signal,
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
    return this.gateway.rpc(method,{...options,session_id:this.runtimeId})
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
