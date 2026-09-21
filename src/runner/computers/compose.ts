import {randomUUID} from 'node:crypto'
import {ContainerComputerProvider,ComputerError,type ComputerSpecification,type ComputerState,type CommandResult,type SkillInstallation} from './container.js'
import type {DesktopRelay} from '../../shared/composeDesktops.js'
/** Uses only the fixed desktops declared by Compose; never calls a container engine. */
export class ComposeComputerProvider extends ContainerComputerProvider {
  readonly fixedCapacity=true
  private leases=new Map<string,{token:string;instance:string}>()
  constructor(runnerId:string,home:string,readonly relay:DesktopRelay){super('docker',runnerId,home)}
  async inventory(){return this.relay('','list',{})}
  async verifyRuntime(){await this.inventory()}
  async inspect(spec:ComputerSpecification):Promise<ComputerState|undefined>{
    this.validateSpecification(spec)
    const state=await this.relay(spec.id,'health',{ownerKey:spec.ownerKey})
    return {id:spec.id,containerId:state.instance,workspace:'/home/cua/workspace',running:state.ready===true,isolation:'container'}
  }
  async ensure(spec:ComputerSpecification,authorize:()=>void):Promise<ComputerState>{
    authorize();const state=await this.inspect(spec);authorize()
    if(!state?.running)throw new ComputerError('compose_desktop_offline','Compose 桌面尚未就绪，请检查对应桌面容器')
    if(!this.leases.has(spec.id)){
      const lease=await this.relay(spec.id,'acquire',{ownerKey:spec.ownerKey,requestId:randomUUID()})
      this.leases.set(spec.id,lease)
      try{authorize()}catch(error){await this.stop(spec);throw error}
    }
    return state
  }
  async releaseFence(spec:ComputerSpecification,keepRunning=false){
    const lease=this.leases.get(spec.id);if(!lease)return
    try{await this.relay(spec.id,'release',{ownerKey:spec.ownerKey,...lease,cancel:!keepRunning})}
    catch(error){const state=await this.relay(spec.id,'health',{ownerKey:spec.ownerKey}).catch(()=>undefined);if(!state||state.instance===lease.instance)throw error}
    this.leases.delete(spec.id)
  }
  async renewFence(spec:ComputerSpecification){const lease=this.leases.get(spec.id);if(lease)await this.relay(spec.id,'renew',{ownerKey:spec.ownerKey,...lease})}
  async stop(spec:ComputerSpecification){await this.releaseFence(spec)}
  async remove(spec:ComputerSpecification){await this.stop(spec)}
  async deleteWorkspace(_spec:ComputerSpecification){} // Compose owns the named volume.
  async execute(spec:ComputerSpecification,argv:string[],options:{authorize():void;signal?:AbortSignal;timeout?:number;input?:Buffer;lane?:string;mayFence?():boolean;user?:'cua'|'root'}):Promise<CommandResult>{
    options.authorize();if(options.signal?.aborted)throw new ComputerError('computer_cancelled','操作已停止')
    const lease=this.leases.get(spec.id);if(!lease)throw new ComputerError('computer_lease_stale','需要当前共享桌面的控制权')
    const result=await this.relay(spec.id,'execute',{ownerKey:spec.ownerKey,...lease,argv,cwd:spec.cwd??'/home/cua/workspace',timeout:options.timeout??30000,user:options.user??'cua',...(options.input?{input:options.input.toString('base64')}:{})})
    options.authorize();if(result.exitCode)throw Object.assign(new ComputerError('computer_command_failed','桌面命令执行失败'),{code:result.exitCode,stdout:result.stdout,stderr:result.stderr})
    return result
  }
  async installSkill(spec:ComputerSpecification,bundle:SkillInstallation,_script:string,options:{authorize():void;signal?:AbortSignal}):Promise<{path:string;revision:string}>{
    options.authorize();if(options.signal?.aborted)throw new ComputerError('computer_cancelled','操作已停止')
    const lease=this.leases.get(spec.id);if(!lease)throw new ComputerError('computer_lease_stale','需要当前共享桌面的控制权')
    const health=await this.relay(spec.id,'health',{ownerKey:spec.ownerKey})
    if(!health.features?.includes('skills-v1'))throw new ComputerError('computer_skills_unavailable','请更新 Compose 桌面镜像以使用共享技能')
    options.authorize()
    const result=await this.relay(spec.id,'skills-install',{ownerKey:spec.ownerKey,...lease,bundle})
    options.authorize();if(options.signal?.aborted)throw new ComputerError('computer_cancelled','操作已停止');return result
  }
  async capture(spec:ComputerSpecification,authorize:()=>void){authorize();const result=await this.relay(spec.id,'frame',{ownerKey:spec.ownerKey});authorize();return result}
  async health(spec:ComputerSpecification,authorize:()=>void){authorize();const result=await this.relay(spec.id,'health',{ownerKey:spec.ownerKey});if(!result.ready)throw new ComputerError('compose_desktop_offline','Compose 桌面尚未就绪');return result}
  async configureNetwork(_spec:ComputerSpecification,authorize:()=>void){authorize()}
}
