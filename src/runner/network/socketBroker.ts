import {connect,type Socket} from 'node:net'
import {z} from 'zod'
import {publicDestination} from './publicDestination.js'

export type NetworkFrame={op:string;id?:string;[key:string]:unknown}
const input=z.discriminatedUnion('op',[
  z.object({op:z.literal('open'),id:z.string().uuid(),host:z.string().max(253),port:z.number().int()}).strict(),
  z.object({op:z.literal('data'),id:z.string().uuid(),data:z.string().max(65536)}).strict(),
  z.object({op:z.literal('end'),id:z.string().uuid()}).strict(),
  z.object({op:z.literal('close'),id:z.string().uuid()}).strict(),
])
type Destination=Awaited<ReturnType<typeof publicDestination>>
interface Stream {socket?:Socket;received:number;sent:number;opened:boolean}
export class PublicSocketBroker {
  private streams=new Map<string,Stream>()
  private closed=false
  private transferred=0
  private timer:ReturnType<typeof setInterval>
  constructor(readonly send:(frame:NetworkFrame)=>Promise<void>,readonly authorize:()=>void,readonly resolve=publicDestination,readonly dial:(destination:Destination)=>Socket=target=>connect({host:target.address,family:target.family,port:target.port}),readonly limits={connections:16,bytes:256*1024*1024},readonly authorizeOpen:()=>Promise<void>=async()=>authorize()){
    this.timer=setInterval(()=>{try{authorize()}catch{this.close()}},1000);this.timer.unref()
  }
  get activeConnections(){return this.streams.size}
  async receive(value:unknown):Promise<void>{
    const frame=input.parse(value)
    if(this.closed)throw new Error('联网通道已关闭')
    this.authorize()
    if(frame.op==='open'){
      if(this.streams.has(frame.id))throw new Error('连接编号已被使用')
      if(this.streams.size>=this.limits.connections){await this.send({op:'error',id:frame.id,message:'联网连接已达上限'});return}
      const state:Stream={received:0,sent:0,opened:false};this.streams.set(frame.id,state)
      try{
        await this.authorizeOpen()
        const target=await this.resolve(frame.host,frame.port)
        await this.authorizeOpen();this.authorize();if(this.closed||this.streams.get(frame.id)!==state)return
        const socket=this.dial(target);state.socket=socket
        socket.setTimeout(30000,()=>socket.destroy())
        socket.once('connect',()=>{try{this.authorize();if(this.closed)throw new Error('closed');state.opened=true;void this.send({op:'opened',id:frame.id}).catch(()=>this.close())}catch{socket.destroy()}})
        socket.on('data',chunk=>{
          socket.pause()
          try{this.authorize();this.count(chunk.length);state.received+=chunk.length}
          catch{this.close();return}
          void this.send({op:'data',id:frame.id,data:chunk.toString('base64')}).then(()=>socket.resume(),()=>this.close())
        })
        socket.once('end',()=>{void this.send({op:'end',id:frame.id}).catch(()=>this.close())})
        socket.once('error',()=>{void this.send({op:'error',id:frame.id,message:'公网连接失败'}).catch(()=>this.close())})
        socket.once('close',()=>{if(this.streams.get(frame.id)===state)this.streams.delete(frame.id);void this.send({op:'close',id:frame.id}).catch(()=>this.close())})
      }catch{
        this.streams.delete(frame.id)
        await this.send({op:'error',id:frame.id,message:'联网目标被拒绝或不可达'})
      }
      return
    }
    const stream=this.streams.get(frame.id)
    if(!stream)return
    if(frame.op==='close'){this.streams.delete(frame.id);stream.socket?.destroy();return}
    if(!stream.opened||!stream.socket)throw new Error('连接尚未建立')
    if(frame.op==='end'){stream.socket.end();return}
    const bytes=Buffer.from(frame.data,'base64')
    this.count(bytes.length);stream.sent+=bytes.length
    if(stream.socket.writableLength+bytes.length>1024*1024)throw new Error('联网写入队列过长')
    await new Promise<void>((resolve,reject)=>stream.socket!.write(bytes,error=>error?reject(error):resolve()))
  }
  private count(bytes:number){this.transferred+=bytes;if(this.transferred>this.limits.bytes)throw new Error('本轮联网流量已达上限')}
  close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);for(const stream of this.streams.values())stream.socket?.destroy();this.streams.clear()}
}
