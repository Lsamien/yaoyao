import {randomUUID,createHash} from 'node:crypto'
import {z} from 'zod'
import {HttpError} from '../../server/errors.js'
import {CUA_DRIVER,CUA_SOCKET,type ComputerSpecification} from '../computers/container.js'
import type {ComputerLease} from '../computers/pool.js'
import {ComputerPublicProxy} from '../network/computerProxy.js'
import type {ComputerRuntime,ComputerGateway,ComputerTarget} from './gateway.js'
import type {ComputerControlStatus,ComputerFrame} from '../../shared/computerControl.js'

const actionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('click'),x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),button:z.enum(['left','right','middle']).default('left'),count:z.number().int().min(1).max(2).default(1)}).strict(),
  z.object({kind:z.literal('drag'),fromX:z.number().int().nonnegative(),fromY:z.number().int().nonnegative(),toX:z.number().int().nonnegative(),toY:z.number().int().nonnegative()}).strict(),
  z.object({kind:z.literal('text'),text:z.string().max(16000)}).strict(),
  z.object({kind:z.literal('key'),key:z.string().min(1).max(40).regex(/^[A-Za-z0-9_+ -]+$/),modifiers:z.array(z.enum(['ctrl','alt','shift','super'])).max(4).default([])}).strict(),
  z.object({kind:z.literal('scroll'),direction:z.enum(['up','down','left','right']),amount:z.number().int().min(1).max(50).default(3)}).strict(),
])
interface Manual {
  id:string;meta:ComputerTarget;profile:string;mode:ComputerControlStatus['mode'];valid:boolean
  gateway?:ComputerGateway;lease?:ComputerLease;spec?:ComputerSpecification;proxy?:ComputerPublicProxy
  pending?:Promise<void>;error?:string;check():Promise<void>;checking:boolean
  stopping?:Promise<void>;actions:Map<string,{fingerprint:string;result:Promise<unknown>}>
}
export class ComputerControls {
  private manual=new Map<string,Manual>()
  private frames=new Map<string,ComputerFrame[]>()
  private captures=new Map<string,Promise<ComputerFrame>>()
  private timer:ReturnType<typeof setInterval>
  constructor(readonly runtime:ComputerRuntime){
    this.timer=setInterval(()=>{for(const state of this.manual.values()){
      if(state.checking)continue;state.checking=true
      void state.check().then(()=>{if(state.lease&&state.mode==='human')this.runtime.pool.renew(state.lease)}).catch(()=>this.stop(state)).finally(()=>{state.checking=false}).catch(()=>{})
    }},5000);this.timer.unref()
  }
  private guard(state:Manual){if(!state.valid||this.manual.get(state.meta.environmentId)!==state)throw new HttpError(410,'电脑控制权已结束','computer_control_expired')}
  private state(meta:ComputerTarget){const state=this.manual.get(meta.environmentId);if(state&&state.meta.ownerKey!==meta.ownerKey)throw new HttpError(403,'电脑归属不匹配','computer_owner_mismatch');return state}
  async status(meta:ComputerTarget):Promise<ComputerControlStatus>{
    const state=this.state(meta)
    if(state)return {mode:state.mode,controlId:state.id,generation:state.lease?.generation,canResume:!!state.gateway,error:state.error}
    const resource=this.runtime.pool.status(meta.ownerKey).find(item=>item.environmentId===meta.environmentId)
    if(this.runtime.provider.fixedCapacity&&(!resource||['free','idle'].includes(resource.status))){const state=await this.runtime.provider.inspect({id:meta.environmentId,ownerKey:meta.ownerKey,imageId:this.runtime.config.imageId});return {mode:state?.running?'idle':'off',generation:resource?.generation??0}}
    return {mode:resource?.status==='active'?'agent':resource?.status==='idle'?'idle':'off',generation:resource?.generation}
  }
  async frame(meta:ComputerTarget,authorize:()=>void):Promise<ComputerFrame>{
    this.runtime.assertTarget(meta);authorize()
    const spec=this.runtime.pool.definition(meta.ownerKey,meta.environmentId)??(this.runtime.provider.fixedCapacity?{id:meta.environmentId,ownerKey:meta.ownerKey,imageId:this.runtime.config.imageId}:undefined)
    if(!spec)throw new HttpError(409,'电脑尚未启动','computer_not_running')
    const status=await this.status(meta),cached=this.frames.get(meta.environmentId)?.at(-1)
    if(cached&&cached.generation===status.generation&&Date.now()-cached.capturedAt<700)return cached
    const existing=this.captures.get(meta.environmentId);if(existing)return existing.then(frame=>{authorize();return frame})
    const pending=this.runtime.provider.capture(spec,authorize).then(frame=>{
      authorize();const result:ComputerFrame={...frame,id:randomUUID(),generation:status.generation??0}
      const history=(this.frames.get(meta.environmentId)??[]).filter(frame=>Date.now()-frame.capturedAt<10000).slice(-4)
      this.frames.set(meta.environmentId,[...history,result]);return result
    }).finally(()=>this.captures.delete(meta.environmentId))
    this.captures.set(meta.environmentId,pending);return pending
  }
  async take(meta:ComputerTarget,profile:string,id:string,check:()=>Promise<void>):Promise<ComputerControlStatus>{
    this.runtime.assertTarget(meta);await check()
    const old=this.state(meta)
    if(old){if(old.id===id)return this.status(meta);throw new HttpError(409,'电脑已由另一控制会话接管','computer_control_busy')}
    const gateway=this.runtime.gateways.get(meta.environmentId)
    const state:Manual={id,meta,profile,mode:'pausing',valid:true,gateway:gateway?.active?gateway:undefined,check,checking:false,actions:new Map()}
    this.manual.set(meta.environmentId,state)
    state.pending=(async()=>{
      if(state.gateway){state.lease=await state.gateway.takeControl(id,()=>this.guard(state));state.spec=state.gateway.specification}
      else{
        const resolved=await this.runtime.resolveWorkspace(profile);await check();this.guard(state)
        state.spec={id:meta.environmentId,ownerKey:meta.ownerKey,imageId:this.runtime.config.imageId,cwd:resolved.cwd,network:this.runtime.config.network??'none'}
        await this.runtime.pool.configure(state.spec,()=>this.guard(state))
        state.lease=await this.runtime.pool.acquire(state.spec,`human:${id}`,()=>this.guard(state))
        if(this.runtime.config.network==='public-proxy')state.proxy=await ComputerPublicProxy.start(this.runtime.provider,state.spec,this.runtime.proxyScript,()=>this.runtime.pool.authorize(state.lease!),check,()=>{void this.stop(state)})
      }
      await check();this.guard(state);state.mode='human'
    })().catch(async()=>{if(!state.valid)return;state.mode='error';state.error='接管未完成，请等待当前操作结束后重试';await this.stop(state).catch(()=>{})})
    return this.status(meta)
  }
  async input(meta:ComputerTarget,id:string,requestId:string,generation:number,frameId:string,value:unknown):Promise<unknown>{
    const state=this.state(meta)
    if(!state||state.id!==id||state.mode!=='human'||!state.lease||!state.spec)throw new HttpError(403,'需要当前电脑的控制权','computer_control_required')
    this.guard(state);await state.check()
    if(state.lease.generation!==generation)throw new HttpError(409,'控制版本已变化','computer_control_stale')
    const frame=this.frames.get(meta.environmentId)?.find(frame=>frame.id===frameId&&frame.generation===generation&&Date.now()-frame.capturedAt<10000)
    if(!frame)throw new HttpError(409,'画面已过期，请刷新后操作','computer_frame_stale')
    const action=actionSchema.parse(value),fingerprint=createHash('sha256').update(JSON.stringify({action,generation,frameId})).digest('hex')
    const old=state.actions.get(requestId)
    if(old){if(old.fingerprint!==fingerprint)throw new HttpError(409,'操作编号与内容不一致','idempotency_conflict');return old.result}
    if(state.actions.size>=1000)throw new HttpError(429,'本次接管操作已达上限，请重新接管','computer_control_limit')
    const common={scope:'desktop',session:`yaoyao-control-${state.id}`}
    let tool:string,args:Record<string,unknown>,argv:string[]|undefined
    if(action.kind==='click'){
      if(action.x>=frame.width||action.y>=frame.height)throw new HttpError(400,'点击位置超出画面','computer_point_invalid')
      tool='click';args={...common,x:action.x,y:action.y,button:action.button,count:action.count}
    }else if(action.kind==='drag'){
      if(action.fromX>=frame.width||action.toX>=frame.width||action.fromY>=frame.height||action.toY>=frame.height)throw new HttpError(400,'拖动位置超出画面','computer_point_invalid')
      tool='drag';args={}
      argv=['env','DISPLAY=:1','xdotool','mousemove','--sync',String(action.fromX),String(action.fromY),'mousedown','1','mousemove','--sync',String(action.toX),String(action.toY),'mouseup','1']
    }else if(action.kind==='text'){tool='type_text';args={...common,text:action.text}}
    else if(action.kind==='key'){
      const key=({Return:'enter',BackSpace:'backspace',Escape:'esc'} as Record<string,string>)[action.key]??action.key.toLowerCase()
      tool=action.modifiers.length?'hotkey':'press_key';args=action.modifiers.length?{...common,keys:[...action.modifiers,key]}:{...common,key}
    }else {tool='scroll';args={...common,x:Math.floor(frame.width/2),y:Math.floor(frame.height/2),by:'line',direction:action.direction,amount:action.amount}}
    const result=this.runtime.pool.use(state.lease,async context=>{
      this.guard(state);await state.check()
      const response=await this.runtime.provider.execute(state.spec!,argv??[CUA_DRIVER,'call',tool,JSON.stringify(args),'--socket',CUA_SOCKET],context)
      this.guard(state);let parsed:any;try{parsed=JSON.parse(response.stdout)}catch{}
      if(parsed?.code||parsed?.error||parsed?.isError)throw new HttpError(502,'电脑未接受这次输入，请刷新画面后重试','computer_action_failed')
      return {ok:true,result:response.stdout}
    })
    state.actions.set(requestId,{fingerprint,result});return result
  }
  async giveBack(meta:ComputerTarget,id:string,notes:string){
    const state=this.state(meta);if(!state||state.id!==id)throw new HttpError(410,'电脑控制权已结束','computer_control_expired')
    await state.pending;this.guard(state);await state.check()
    if(state.gateway){state.mode='resuming';await state.gateway.giveBack(notes);state.valid=false;this.manual.delete(meta.environmentId)}
    else if(this.runtime.retainDesktops&&state.lease){
      await state.proxy?.close();await this.runtime.pool.release(state.lease,true)
      state.valid=false;this.manual.delete(meta.environmentId)
    }else await this.stop(state)
    return {ok:true}
  }
  private async stop(state:Manual){
    if(state.stopping)return state.stopping
    state.valid=false
    state.stopping=(async()=>{
      await state.proxy?.close()
      if(state.gateway)await state.gateway.stopControl()
      else if(state.lease)await this.runtime.pool.release(state.lease).catch(error=>{if(error.code!=='computer_lease_stale')throw error})
      if(this.manual.get(state.meta.environmentId)===state)this.manual.delete(state.meta.environmentId)
    })().catch(error=>{state.mode='error';state.error='电脑停止状态待确认';state.stopping=undefined;throw error})
    return state.stopping
  }
  async close(){clearInterval(this.timer);await Promise.allSettled([...this.manual.values()].map(state=>this.stop(state)))}
}
