import {readFile} from 'node:fs/promises'
import type {ChildProcessWithoutNullStreams} from 'node:child_process'
import {PublicSocketBroker,type NetworkFrame} from './socketBroker.js'
import type {ContainerComputerProvider,ComputerSpecification} from '../computers/container.js'

/** One private pipe per leased computer. This exposes no host listening port. */
export class ComputerPublicProxy {
  private broker:PublicSocketBroker
  private stopping=false
  private buffer=''
  private exited:Promise<void>
  private ready:Promise<void>
  private resolveReady!:()=>void
  private rejectReady!:(error:Error)=>void
  private lifetimeTimer:ReturnType<typeof setTimeout>
  private tasks=new Set<Promise<void>>()
  private constructor(readonly child:ChildProcessWithoutNullStreams,authorize:()=>void,check:()=>Promise<void>,readonly onFailure:()=>void){
    this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject});void this.ready.catch(()=>{})
    this.broker=new PublicSocketBroker(frame=>this.send(frame),authorize,undefined,undefined,undefined,check)
    child.stderr.resume();child.stdin.on('error',()=>this.fail())
    this.exited=new Promise(resolve=>{
      const ended=()=>{resolve();if(!this.stopping)this.fail()}
      child.once('exit',ended);child.once('error',ended)
    })
    child.stdout.on('data',chunk=>{
      this.buffer+=String(chunk)
      if(this.buffer.length>1024*1024){this.fail();return}
      for(;;){const end=this.buffer.indexOf('\n');if(end<0)break;const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1)
        try{
          const frame=JSON.parse(line)
          if(frame.op==='ready'&&frame.port===3128){this.resolveReady();continue}
          const task=this.broker.receive(frame).catch(()=>this.fail())
          this.tasks.add(task);void task.finally(()=>this.tasks.delete(task))
        }catch{this.fail()}
      }
    })
    this.lifetimeTimer=setTimeout(()=>this.fail(),30*60*1000);this.lifetimeTimer.unref()
  }
  static async start(provider:ContainerComputerProvider,spec:ComputerSpecification,script:string,authorize:()=>void,check:()=>Promise<void>,onFailure:()=>void){
    authorize()
    const source=await readFile(script,'utf8')
    authorize();await provider.configureNetwork(spec,authorize)
    const child=await provider.openPipe(spec,['python3','-u','-c',source],authorize)
    const proxy=new ComputerPublicProxy(child,authorize,check,onFailure)
    let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([proxy.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('电脑联网代理启动超时')),10000)})]);authorize();return proxy}
    catch(error){await proxy.close();throw error}finally{clearTimeout(timer)}
  }
  private send(frame:NetworkFrame):Promise<void>{
    if(this.stopping||this.child.stdin.destroyed)return Promise.reject(new Error('联网通道已关闭'))
    const line=JSON.stringify(frame)+'\n'
    if(this.child.stdin.writableLength+line.length>4*1024*1024)return Promise.reject(new Error('联网回传队列已满'))
    return new Promise((resolve,reject)=>this.child.stdin.write(line,error=>error?reject(error):resolve()))
  }
  private fail(){if(this.stopping)return;this.rejectReady(new Error('电脑联网通道已断开'));void this.close();this.onFailure()}
  async close(){
    if(this.stopping)return this.exited
    this.stopping=true;clearTimeout(this.lifetimeTimer);this.broker.close();this.child.stdin.end()
    let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([this.exited,new Promise(resolve=>{timer=setTimeout(resolve,1500)})])}finally{clearTimeout(timer)}
    if(this.child.exitCode===null&&this.child.signalCode===null)this.child.kill('SIGTERM')
    try{await Promise.race([this.exited,new Promise(resolve=>{timer=setTimeout(resolve,1500)})])}finally{clearTimeout(timer)}
    if(this.child.exitCode===null&&this.child.signalCode===null)this.child.kill('SIGKILL')
    await this.exited
  }
}
