import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {HttpError} from '../../server/errors.js'

export interface WorkerTool {id?:string;name:string;description:string;inputSchema:Record<string,unknown>}
export interface WorkerModel {provider:string;api_mode:string;base_url?:string;api_key?:string;model:string}
export interface WorkerContextConfiguration {compression?:Record<string,unknown>;model?:{context_length?:number;max_tokens?:number}}
const proxyEnvKeys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'] as const
export type WorkerProxyEnvironment=Partial<Record<typeof proxyEnvKeys[number],string>>
export interface WorkerFrame {type:string;[key:string]:any}
const configurationErrors:Record<string,string>={
  computer_profile_invalid:'基础 Profile 名称无效',
  computer_profile_missing:'未找到基础 Profile 配置，请检查执行节点上的 Hermes Profile',
  computer_profile_config_invalid:'基础 Profile 配置无法读取，请检查 config.yaml',
  computer_cwd_invalid:'基础 Profile 的 terminal.cwd 无效，请使用工作区内的相对路径或有效绝对路径',
  computer_model_missing:'基础 Profile 尚未配置模型，请先选择模型后再运行机器人',
  computer_model_unavailable:'基础 Profile 的模型配置无法使用，请检查 Provider 与认证信息',
  computer_model_unsupported:'基础 Profile 的模型接口暂不支持隔离电脑机器人',
}
export class HermesWorkerProcess {
  readonly nonce=randomUUID()
  readonly child:ChildProcessWithoutNullStreams
  readonly exited:Promise<void>
  private finished=false
  private output=''
  private pending=new Set<Promise<unknown>>()
  private waiters=new Map<string,{resolve(frame:WorkerFrame):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
  onEvent:(frame:WorkerFrame)=>void=()=>{}
  onTool:(name:string,args:unknown,id:string,callId?:string)=>Promise<unknown>=async()=>{throw new Error('工具未授权')}
  constructor(python:string,script:string,input:Record<string,unknown>,onDiagnostic?:(text:string)=>void){
    const {proxyEnv,...boot}=input
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',HOME:homedir(),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}
    // Only the selected Profile's proxy snapshot crosses this boundary. Never
    // inherit the Runner's proxy settings, credentials or Python overrides.
    if(proxyEnv&&typeof proxyEnv==='object'&&!Array.isArray(proxyEnv))for(const key of proxyEnvKeys){
      const value=(proxyEnv as Record<string,unknown>)[key]
      if(typeof value==='string')env[key]=value
    }
    this.child=spawn(python,['-u',script],{stdio:'pipe',env})
    if(onDiagnostic)this.child.stderr.on('data',chunk=>onDiagnostic(String(chunk)));else this.child.stderr.resume()
    this.exited=new Promise(resolve=>{
      const done=()=>{if(this.finished)return;this.finished=true;this.fail(new Error('Hermes Worker 已退出'));resolve()}
      this.child.once('error',done);this.child.once('exit',done)
    })
    this.child.stdout.on('data',chunk=>{
      this.output+=String(chunk)
      if(Buffer.byteLength(this.output)>128*1024*1024){void this.close();return}
      for(;;){const end=this.output.indexOf('\n');if(end<0)break;const line=this.output.slice(0,end);this.output=this.output.slice(end+1);try{const frame=JSON.parse(line);if(frame.nonce===this.nonce)this.receive(frame)}catch{/* non-protocol output has no authority */}}
    })
    this.child.stdin.on('error',()=>{})
    this.child.stdin.write(JSON.stringify({...boot,nonce:this.nonce})+'\n')
  }
  private receive(frame:WorkerFrame){
    const waiting=this.waiters.get(frame.type)
    if(waiting){clearTimeout(waiting.timer);this.waiters.delete(frame.type);waiting.resolve(frame)}
    if(frame.type==='failed'){
      const code=typeof frame.code==='string'&&Object.hasOwn(configurationErrors,frame.code)?frame.code:'computer_worker_failed'
      this.fail(new HttpError(502,configurationErrors[code]??'Hermes Worker 执行失败，请核对基础 Profile 与模型连接',code))
    }
    if(frame.type==='tool'){
      const work=Promise.resolve().then(()=>this.onTool(String(frame.name),frame.arguments,String(frame.id),typeof frame.callId==='string'?frame.callId:undefined)).then(result=>this.send({type:'result',id:frame.id,result}),()=>this.send({type:'result',id:frame.id,result:{error:'工具执行失败或授权已失效'}}))
      this.pending.add(work);void work.finally(()=>this.pending.delete(work)).catch(()=>{})
    }else this.onEvent(frame)
  }
  private fail(error:Error){for(const value of this.waiters.values()){clearTimeout(value.timer);value.reject(error)}this.waiters.clear()}
  private send(value:unknown){if(!this.finished&&!this.child.stdin.destroyed)this.child.stdin.write(JSON.stringify({...value as object,nonce:this.nonce})+'\n')}
  wait(type:string,timeout=30000):Promise<WorkerFrame>{
    if(this.finished)return Promise.reject(new Error('Hermes Worker 已退出'))
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters.delete(type);reject(new Error('Hermes Worker 回应超时'))},timeout);this.waiters.set(type,{resolve,reject,timer})})
  }
  async close(){
    if(this.finished)return
    this.send({type:'interrupt'})
    let timer:ReturnType<typeof setTimeout>|undefined
    try{await Promise.race([this.exited,new Promise(resolve=>{timer=setTimeout(resolve,1500)})])}finally{clearTimeout(timer)}
    if(!this.finished)this.child.kill('SIGTERM')
    try{await Promise.race([this.exited,new Promise(resolve=>{timer=setTimeout(resolve,1500)})])}finally{clearTimeout(timer)}
    if(!this.finished)this.child.kill('SIGKILL')
    await this.exited
  }
}
