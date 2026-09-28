import type {ChildProcessWithoutNullStreams} from 'node:child_process'
import type {VmProxySettings} from '../../shared/executionEnvironment.js'
import type {ContainerComputerProvider,ComputerSpecification} from '../computers/container.js'
import {ComposeComputerProvider} from '../computers/compose.js'
import {PublicSocketBroker,type NetworkFrame} from './socketBroker.js'
import {publicDestination} from './publicDestination.js'
import {proxyLookup,proxySocket} from './upstreamProxy.js'

export class ManagedProxy {
  private stopped=false
  private child?:ChildProcessWithoutNullStreams
  private token?:string
  private outgoing:NetworkFrame[]=[]
  private loop?:Promise<void>
  private broker:PublicSocketBroker
  get closed(){return this.stopped}
  private constructor(private provider:ContainerComputerProvider,private spec:ComputerSpecification,proxy:VmProxySettings,authorize:()=>void,private onClose:()=>void){
    this.broker=new PublicSocketBroker(async frame=>{
      if(this.stopped)throw new Error('closed')
      if(this.child){if(this.child.stdin.writableLength>4*1024*1024)throw new Error('queue limit');await new Promise<void>((resolve,reject)=>this.child!.stdin.write(JSON.stringify(frame)+'\n',error=>error?reject(error):resolve()))}
      else{if(this.outgoing.length>=128)throw new Error('queue limit');this.outgoing.push(frame)}
    },authorize,(host,port)=>publicDestination(host,port,proxyLookup(proxy)),target=>proxySocket(proxy,target.address,target.port))
  }
  static async start(provider:ContainerComputerProvider,spec:ComputerSpecification,proxy:VmProxySettings,authorize:()=>void,onClose:()=>void=()=>{}){
    const result=new ManagedProxy(provider,spec,proxy,authorize,onClose)
    try{
      if(provider instanceof ComposeComputerProvider){
        const opened=await provider.relay(spec.id,'network-open',{ownerKey:spec.ownerKey})
        authorize();result.token=opened.token
        result.loop=(async()=>{while(!result.stopped){authorize();const value=await provider.relay(spec.id,'network-exchange',{ownerKey:spec.ownerKey,token:result.token,frames:result.outgoing.splice(0,32)});await Promise.all(value.frames.map((frame:NetworkFrame)=>result.broker.receive(frame)))}})().catch(()=>result.close())
      }else{
        const child=await provider.openNetworkPipe(spec,authorize);result.child=child
        child.stderr.resume();child.stdin.on('error',()=>{void result.close()});child.once('exit',()=>{void result.close()});child.once('error',()=>{void result.close()})
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>{reject(new Error('统一网络出口启动超时'));void result.close()},10000)
          let buffer='',ready=false
          child.once('exit',()=>{clearTimeout(timer);if(!ready)reject(new Error('统一网络出口已退出'))})
          child.stdout.on('data',chunk=>{buffer+=chunk;if(buffer.length>1024*1024){void result.close();return}for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const frame=JSON.parse(line);if(frame.op==='ready'){ready=true;clearTimeout(timer);resolve()}else void result.broker.receive(frame).catch(()=>result.close())}catch{void result.close()}}})
        })
      }
      authorize();return result
    }catch(error){await result.close();throw error}
  }
  async close(){if(this.stopped)return;this.stopped=true;this.onClose();this.broker.close();this.outgoing=[];this.child?.stdin.end();this.child?.kill('SIGTERM');if(this.token&&this.provider instanceof ComposeComputerProvider)await this.provider.relay(this.spec.id,'network-close',{ownerKey:this.spec.ownerKey,token:this.token}).catch(()=>{})}
}
