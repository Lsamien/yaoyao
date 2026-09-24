import {WorkspaceGateway,type GatewayTarget} from './workspaceGateway.js'
import {HttpError} from './errors.js'

const schema=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false})
const field={type:'string'}

export const VM_COMPUTER_TOOLS=[
  {id:'computer_shell',name:'computer_shell',description:'在虚拟环境里执行命令。虚拟环境是服务端上的隔离 Linux 电脑，不会在服务器或已连接的电脑上执行。',inputSchema:schema({command:field,user:{type:'string',enum:['cua','root']}},['command'])},
  {id:'computer_read_file',name:'computer_read_file',description:'读取虚拟环境里的 UTF-8 文件。',inputSchema:schema({path:field},['path'])},
  {id:'computer_write_file',name:'computer_write_file',description:'写入虚拟环境里的 UTF-8 文件。',inputSchema:schema({path:field,content:field},['path','content'])},
  {id:'computer_desktop_state',name:'computer_desktop_state',description:'查看虚拟环境的真实桌面，返回截图和宽高。仅在需要看窗口或做点击输入时使用；命令和文件不要先截图。',inputSchema:schema({},[])},
  {id:'computer_action',name:'computer_action',description:'操作虚拟环境桌面。必须先查看桌面。kind 为 click、text、key 或 scroll，坐标用截图像素。',inputSchema:schema({kind:{enum:['click','drag','text','key','scroll']},x:{type:'integer'},y:{type:'integer'},fromX:{type:'integer'},fromY:{type:'integer'},toX:{type:'integer'},toY:{type:'integer'},button:{enum:['left','right','middle']},count:{type:'integer'},text:field,key:field,modifiers:{type:'array',items:{enum:['ctrl','alt','shift','super']}},direction:{enum:['up','down','left','right']},amount:{type:'integer'}},['kind'])},
  {id:'computer_export',name:'computer_export',description:'把虚拟环境里的文件作为附件回传到当前对话，最大 25 MiB。',inputSchema:schema({path:field,name:field},['path'])},
]

export const VM_COMPUTER_RULES='操作 Bot 虚拟环境时，使用 computer_*；它是隔离的 Linux 电脑。命令和文件用 computer_shell、computer_read_file、computer_write_file，无需先截图；窗口操作先 computer_desktop_state 再 computer_action，页面变化后重新截图。用 computer_export 回传产物。不能用 Hermes 原生工具代替虚拟机操作，不混用其他环境的路径。仅在任务需要时调用，普通聊天不启动虚拟机。'

export class VmToolSession {
  private gateway?: WorkspaceGateway
  private sessionId=''
  private opening?:Promise<void>
  constructor(private readonly target:GatewayTarget,private readonly profile:string,private readonly workId:string,private readonly authorize:()=>void,private readonly publishArtifact?:(name:string,bytes:Buffer)=>Promise<unknown>){}
  private async open(){
    if(this.opening)return this.opening
    if(!this.gateway){
      const gateway=new WorkspaceGateway(this.target,{workId:this.workId,authorize:this.authorize,...(this.publishArtifact?{publishArtifact:this.publishArtifact}:{})})
      this.gateway=gateway
      this.opening=(async()=>{
        this.authorize()
        await gateway.connect()
        this.authorize()
        const opened=await gateway.rpc('session.create',{profile:this.profile,toolsOnly:true,title:'Yaoyao vm tools',source:'yaoyao_workspace',close_on_disconnect:true})
        this.authorize()
        if(this.gateway!==gateway)throw new Error('虚拟环境连接已关闭')
        this.sessionId=String(opened.session_id??'')
        if(!this.sessionId)throw new Error('虚拟环境没有打开')
      })()
      try{await this.opening}catch(error){if(this.gateway===gateway)this.close();throw error}finally{this.opening=undefined}
    }
  }
  async transfer(action:Record<string,unknown>){
    this.authorize()
    if(!this.target.runner?.fileTransfer)throw new HttpError(409,'执行节点尚不支持虚拟机分块传输，请更新 Runner','computer_transfer_upgrade_required')
    await this.open()
    return this.gateway!.rpc('computer.transfer',{session_id:this.sessionId,action})
  }
  async call(name:string,args:unknown,callId?:string){
    await this.open()
    const value=await this.gateway!.rpc('computer.invoke',{session_id:this.sessionId,name,arguments:args??{},...(callId?{id:callId}:{})})
    if(name==='computer_desktop_state'&&value&&typeof value==='object'&&(value as any)._multimodal){
      const url=String((value as any).content?.[0]?.image_url?.url??'')
      const data=url.includes(',')?url.split(',')[1]:''
      return {content:[{type:'image',mimeType:'image/png',data},{type:'text',text:JSON.stringify({width:(value as any).width,height:(value as any).height})}]}
    }
    return value
  }
  close(){const gateway=this.gateway;this.gateway=undefined;this.sessionId='';gateway?.close()}
}
