import {randomUUID,createHash} from 'node:crypto'
import {z} from 'zod'
import {HttpError} from '../../server/errors.js'
import {CUA_DRIVER,type ComputerSpecification} from '../computers/container.js'
import type {BotDesktop} from '../computers/desktops.js'
import type {ComputerLease} from '../computers/pool.js'
import type {ComputerRuntime,ComputerGateway,ComputerTarget,ProxyHandle} from './gateway.js'
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
  gateways:ComputerGateway[];lease?:ComputerLease;spec?:ComputerSpecification;desktop?:BotDesktop;proxyHandle?:ProxyHandle
  pending?:Promise<void>;error?:string;check():Promise<void>;checking:boolean
  stopping?:Promise<void>;actions:Map<string,{fingerprint:string;result:Promise<unknown>}>
}
/** Viewing and takeover address one Bot's own desktop inside its account computer. */
const key=(meta:ComputerTarget)=>`${meta.environmentId}:${meta.agentId}`
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
  private guard(state:Manual){if(!state.valid||this.manual.get(key(state.meta))!==state)throw new HttpError(410,'电脑控制权已结束','computer_control_expired')}
  private state(meta:ComputerTarget){const state=this.manual.get(key(meta));if(state&&state.meta.ownerKey!==meta.ownerKey)throw new HttpError(403,'电脑归属不匹配','computer_owner_mismatch');return state}
  private gatewaysOf(meta:ComputerTarget){return [...(this.runtime.gateways.get(meta.environmentId)??[])].filter(gateway=>gateway.meta.agentId===meta.agentId)}
  async status(meta:ComputerTarget):Promise<ComputerControlStatus>{
    const state=this.state(meta)
    if(state)return {mode:state.mode,controlId:state.id,generation:state.lease?.generation,canResume:!!state.gateways.length,error:state.error}
    const gateways=this.gatewaysOf(meta)
    if(gateways.some(gateway=>gateway.paused))return {mode:'pausing',generation:this.runtime.pool.status(meta.ownerKey).find(row=>row.environmentId===meta.environmentId)?.generation}
    const resource=this.runtime.pool.status(meta.ownerKey).find(item=>item.environmentId===meta.environmentId)
    // Another Bot working on its own desktop does not make this Bot's desktop busy.
    return {mode:gateways.some(gateway=>gateway.active)?'agent':resource&&['active','idle'].includes(resource.status)?'idle':'off',generation:resource?.generation}
  }
  async frame(meta:ComputerTarget,authorize:()=>void):Promise<ComputerFrame>{
    this.runtime.assertTarget(meta);authorize()
    const spec=this.runtime.pool.definition(meta.ownerKey,meta.environmentId)
    if(!spec)throw new HttpError(409,'电脑尚未启动','computer_not_running')
    // Viewing never starts anything: an unstarted Bot desktop shows the start button.
    const desktop=this.runtime.desktops.current(meta.ownerKey,meta.environmentId,meta.agentId)
    if(!desktop)throw new HttpError(409,'这个机器人的桌面尚未启动','computer_not_running')
    const id=key(meta),status=await this.status(meta),cached=this.frames.get(id)?.at(-1)
    if(cached&&cached.generation===status.generation&&Date.now()-cached.capturedAt<700)return cached
    const existing=this.captures.get(id);if(existing)return existing.then(frame=>{authorize();return frame})
    const pending=this.runtime.provider.capture(spec,authorize,desktop).then(frame=>{
      authorize();const result:ComputerFrame={...frame,id:randomUUID(),generation:status.generation??0}
      const history=(this.frames.get(id)??[]).filter(frame=>Date.now()-frame.capturedAt<10000).slice(-4)
      this.frames.set(id,[...history,result]);return result
    }).finally(()=>this.captures.delete(id))
    this.captures.set(id,pending);return pending
  }
  async take(meta:ComputerTarget,profile:string,id:string,check:()=>Promise<void>):Promise<ComputerControlStatus>{
    this.runtime.assertNetworkReady()
    this.runtime.assertTarget(meta);await check()
    const old=this.state(meta)
    if(old){if(old.id===id)return this.status(meta);throw new HttpError(409,'电脑已由另一控制会话接管','computer_control_busy')}
    // Pause only the Bot whose desktop is taken over; other Bots of the account
    // keep working on their own desktops. The human holds the computer too.
    const gateways=this.runtime.activeGateways(meta.environmentId).filter(gateway=>gateway.meta.agentId===meta.agentId)
    const state:Manual={id,meta,profile,mode:'pausing',valid:true,gateways,check,checking:false,actions:new Map()}
    this.manual.set(key(meta),state)
    state.pending=(async()=>{
      for(const gateway of gateways)await gateway.takeControl(id,()=>this.guard(state))
      const resource=this.runtime.pool.status(meta.ownerKey).find(row=>row.environmentId===meta.environmentId)
      let spec=this.runtime.pool.definition(meta.ownerKey,meta.environmentId)
      if(!spec||resource?.status!=='active'){
        await check();this.guard(state)
        spec=this.runtime.computerSpec(meta)
        await this.runtime.pool.configure(spec,()=>this.guard(state))
      }
      state.spec=spec
      state.lease=await this.runtime.pool.acquire(spec,`human:${id}`,()=>this.guard(state))
      if(this.runtime.network!=='none')state.proxyHandle=await this.runtime.acquireProxy(spec,()=>{if(!this.runtime.pool.hasHolders(meta.ownerKey,meta.environmentId))throw new HttpError(410,'电脑控制权已结束','computer_control_expired')})
      state.desktop=await this.runtime.desktops.ensure(spec,meta.agentId,()=>this.guard(state))
      await check();this.guard(state);state.mode='human'
    })().catch(async()=>{if(!state.valid)return;state.mode='error';state.error='接管未完成，请等待当前操作结束后重试';await this.stop(state).catch(()=>{})})
    return this.status(meta)
  }
  async input(meta:ComputerTarget,id:string,requestId:string,generation:number,frameId:string,value:unknown):Promise<unknown>{
    const state=this.state(meta)
    if(!state||state.id!==id||state.mode!=='human'||!state.lease||!state.spec||!state.desktop)throw new HttpError(403,'需要当前电脑的控制权','computer_control_required')
    this.guard(state);await state.check()
    if(state.lease.generation!==generation)throw new HttpError(409,'控制版本已变化','computer_control_stale')
    const frame=this.frames.get(key(meta))?.find(frame=>frame.id===frameId&&frame.generation===generation&&Date.now()-frame.capturedAt<10000)
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
      argv=['env',`DISPLAY=:${state.desktop.display}`,'xdotool','mousemove','--sync',String(action.fromX),String(action.fromY),'mousedown','1','mousemove','--sync',String(action.toX),String(action.toY),'mouseup','1']
    }else if(action.kind==='text'){tool='type_text';args={...common,text:action.text}}
    else if(action.kind==='key'){
      const key=({Return:'enter',BackSpace:'backspace',Escape:'esc'} as Record<string,string>)[action.key]??action.key.toLowerCase()
      tool=action.modifiers.length?'hotkey':'press_key';args=action.modifiers.length?{...common,keys:[...action.modifiers,key]}:{...common,key}
    }else {tool='scroll';args={...common,x:Math.floor(frame.width/2),y:Math.floor(frame.height/2),by:'line',direction:action.direction,amount:action.amount}}
    const result=this.runtime.pool.use(state.lease,async context=>{
      this.guard(state);await state.check()
      const response=await this.runtime.provider.execute(state.spec!,argv??[CUA_DRIVER,'call',tool,JSON.stringify(args),'--socket',state.desktop!.socket],{...context,lane:'gui',display:state.desktop!.display})
      this.guard(state);let parsed:any;try{parsed=JSON.parse(response.stdout)}catch{}
      if(parsed?.code||parsed?.error||parsed?.isError)throw new HttpError(502,'电脑未接受这次输入，请刷新画面后重试','computer_action_failed')
      return {ok:true,result:response.stdout}
    })
    state.actions.set(requestId,{fingerprint,result});return result
  }
  async giveBack(meta:ComputerTarget,id:string,notes:string){
    const state=this.state(meta);if(!state||state.id!==id)throw new HttpError(410,'电脑控制权已结束','computer_control_expired')
    await state.pending;this.guard(state);await state.check()
    state.mode='resuming'
    await state.proxyHandle?.release()
    if(state.lease)await this.runtime.pool.release(state.lease,this.runtime.retainDesktops).catch(error=>{if((error as any).code!=='computer_lease_stale')throw error})
    for(const gateway of state.gateways)await gateway.giveBack(notes)
    state.valid=false;this.manual.delete(key(meta))
    return {ok:true}
  }
  private async stop(state:Manual){
    if(state.stopping)return state.stopping
    state.valid=false
    state.stopping=(async()=>{
      await state.proxyHandle?.release()
      for(const gateway of state.gateways)await gateway.stopControl()
      if(state.lease)await this.runtime.pool.release(state.lease).catch(error=>{if(error.code!=='computer_lease_stale')throw error})
      if(this.manual.get(key(state.meta))===state)this.manual.delete(key(state.meta))
    })().catch(error=>{state.mode='error';state.error='电脑停止状态待确认';state.stopping=undefined;throw error})
    return state.stopping
  }
  async stopAll(){await Promise.all([...this.manual.values()].map(state=>this.stop(state)))}
  async close(){clearInterval(this.timer);await this.stopAll().catch(()=>{})}
}
