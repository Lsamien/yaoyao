import {createHash} from 'node:crypto'
import {HttpError} from './errors.js'
import type {WorkspaceStore} from './workspaceStore.js'

interface ResultSummary {cached:boolean;bytes:number;sha256:string;reason?:'observation'|'binary'|'size'}
interface Receipt {id:string;workId:string;name:string;fingerprint:string;state:'started'|'complete'|'failed';startedAt:number;completedAt?:number;result?:unknown;resultSummary?:ResultSummary;error?:{message:string;code:string;status:number}}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value
const MAX_CACHED_RESULT_BYTES=16*1024
const observations=new Set(['computer_read_file','computer_desktop_state','managed_browser_state','managed_browser_snapshot'])
function observation(name:string,args:unknown){
  if(observations.has(name))return true
  if(name!=='managed_browser_action'||!args||typeof args!=='object')return false
  const action=(args as {action?:unknown}).action
  return !!action&&typeof action==='object'&&['state','downloads','snapshot','screenshot'].includes(String((action as {kind?:unknown}).kind))
}
function containsBinary(value:unknown):boolean{
  if(Buffer.isBuffer(value))return true
  if(typeof value==='string')return value.startsWith('data:')&&value.includes(';base64,')
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(containsBinary)
  const item=value as Record<string,unknown>
  if(typeof item.blob==='string'||typeof item.data==='string'&&(typeof item.mimeType==='string'||item.type==='image'||item.type==='audio'))return true
  return Object.values(item).some(containsBinary)
}

/** Persist intent before effects. Missing replies are never interpreted as permission to replay. */
export class ToolOperationJournal {
  private running=new Map<string,Promise<unknown>>()
  constructor(private readonly store:WorkspaceStore){}
  async execute<T>(owner:string,workId:string,callId:string|undefined,name:string,args:unknown,authorize:()=>void,action:()=>Promise<T>):Promise<T>{
    authorize()
    if(!callId)return action()
    if(callId.length>512)throw new HttpError(400,'工具调用编号过长','invalid_operation_id')
    const id=createHash('sha256').update(JSON.stringify([workId,callId])).digest('hex'),key=owner+':'+id
    const fingerprint=createHash('sha256').update(JSON.stringify(canonical([name,args]))).digest('hex')
    const old=this.store.get<Receipt>(owner,'tool-operation',id)
    if(old){
      if(old.fingerprint!==fingerprint)throw new HttpError(409,'工具调用编号已用于不同参数','idempotency_conflict')
      const pending=this.running.get(key);if(pending)return pending as Promise<T>
      if(old.state==='complete'&&'result' in old)return old.result as T
      if(old.state==='complete')throw new HttpError(409,'原操作已完成，回执已保留但未缓存完整结果，不能按同一编号重做；如需最新观察，请发起新的读取操作','tool_operation_result_unavailable')
      if(old.state==='failed'&&old.error)throw new HttpError(old.error.status,old.error.message,old.error.code)
      throw new HttpError(409,'原操作已提交但结果不确定，请核对环境，不能自动重做','tool_operation_uncertain')
    }
    const receipt:Receipt={id,workId,name,fingerprint,state:'started',startedAt:Date.now()}
    this.store.put(owner,'tool-operation',id,receipt)
    const pending=Promise.resolve().then(async()=>{
      authorize()
      const result=await action()
      // Receipts prove completion without making the workspace database a
      // second screenshot/file store. Only small, non-observation replies are
      // replayable; omitting a reply never authorizes repeating its effects.
      const encoded=JSON.stringify(result??null)
      const bytes=Buffer.byteLength(encoded),reason=observation(name,args)?'observation':bytes>MAX_CACHED_RESULT_BYTES?'size':containsBinary(result)?'binary':undefined
      const resultSummary:ResultSummary={cached:reason===undefined,bytes,sha256:createHash('sha256').update(encoded).digest('hex'),...(reason?{reason}:{})}
      this.store.put(owner,'tool-operation',id,{...receipt,state:'complete',completedAt:Date.now(),resultSummary,...(resultSummary.cached?{result:result??null}:{})})
      authorize();return result
    }).catch(error=>{
      // A transport failure can follow an external side effect; record the error,
      // but the same operation ID always returns it instead of executing again.
      this.store.put(owner,'tool-operation',id,{...receipt,state:'failed',completedAt:Date.now(),error:{message:(error instanceof Error?error.message:'工具执行失败').slice(0,2048),code:(error instanceof HttpError?error.code:'tool_operation_failed').slice(0,128),status:error instanceof HttpError?error.status:500}})
      throw error
    }).finally(()=>this.running.delete(key))
    this.running.set(key,pending);return pending
  }
}
