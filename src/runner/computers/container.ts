import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, realpath, chmod, lstat, rm, readFile } from 'node:fs/promises'
import { join, resolve, posix, dirname, basename } from 'node:path'
import { z } from 'zod'
import {recoverWorkspace} from './workspaceRecovery.js'

export const COMPUTER_WORKSPACE = '/home/cua/workspace'
export const CUA_DRIVER = '/usr/local/libexec/openmausbot/cua-driver'
export const CUA_SOCKET = '/run/user/1000/openmausbot-cua.sock'
const managedLabel='cn.samien.yaoyao.computer', runnerLabel='cn.samien.yaoyao.runner', specLabel='cn.samien.yaoyao.computer-spec', ownerLabel='cn.samien.yaoyao.computer-owner'
const mib=1024*1024
export interface CommandResult {stdout:string;stderr:string}
export interface SkillInstallation {namespace:string;revision:string;files:Record<string,string>}
export type ContainerCommand=(runtime:'docker'|'podman',args:string[],options?:{timeout?:number;signal?:AbortSignal;input?:Buffer})=>Promise<CommandResult>
const command:ContainerCommand=(runtime,args,options={})=>new Promise((resolveResult,reject)=>{
  const child=spawn(runtime,args,{stdio:'pipe',signal:options.signal}),out:Buffer[]=[],err:Buffer[]=[]
  let bytes=0,failure:Error|undefined
  const timer=setTimeout(()=>{failure=Object.assign(new Error('电脑命令超时'),{killed:true});child.kill('SIGTERM')},options.timeout??15000)
  const collect=(target:Buffer[],chunk:Buffer)=>{bytes+=chunk.length;if(bytes>8*mib){failure=Object.assign(new Error('电脑输出超过限制'),{killed:true});child.kill('SIGTERM')}else target.push(chunk)}
  child.stdout.on('data',chunk=>collect(out,Buffer.from(chunk)));child.stderr.on('data',chunk=>collect(err,Buffer.from(chunk)))
  child.once('error',error=>{failure=error});child.stdin.on('error',()=>{})
  child.once('close',code=>{clearTimeout(timer);const result={stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()};if(failure||code!==0)reject(Object.assign(failure??new Error('电脑命令失败'),{...result,...(!failure?{code}:{} )}));else resolveResult(result)})
  child.stdin.end(options.input)
})
const schema=z.object({
  network:z.enum(['none','public-proxy']).default('none'),
  id:z.string().uuid(),ownerKey:z.string().min(1).max(256),
  imageId:z.string().regex(/^sha256:[a-f0-9]{64}$/),
  cpus:z.number().int().min(1).max(8).default(2),memoryMiB:z.number().int().min(1024).max(16384).default(4096),
  cwd:z.string().max(4096).refine(value=>!/[\u0000-\u001f,]/.test(value)&&posix.isAbsolute(value)&&posix.normalize(value)===value&&value!=='/'&&!/^\/(?:proc|sys|dev|run|tmp|etc|usr|bin|sbin)(?:\/|$)/.test(value)&&value!=='/home/cua','电脑工作目录不受支持').default(COMPUTER_WORKSPACE),
  pids:z.number().int().min(64).max(1024).default(512),
}).strict()
export type ComputerSpecification=z.input<typeof schema>
type Spec=z.output<typeof schema>
export interface ComputerState {id:string;containerId:string;running:boolean;workspace:string;isolation:'container'|'vm'}
/** Execution lanes for one environment: shell and file operations run as
 * concurrent readers, desktop driver input is serialized, and lifecycle
 * operations (start/stop/reconfigure) drain every reader first. */
export type ComputerLane='exec'|'gui'
export type ComputerUser='cua'|'root'
export interface ComputerProvider {
  releaseFence?(spec:ComputerSpecification,keepRunning?:boolean):Promise<void>
  renewFence?(spec:ComputerSpecification):Promise<void>
  validateSpecification(spec:ComputerSpecification):ComputerSpecification
  readonly capabilities:{isolation:'container'|'vm';shell:boolean;desktop:boolean;persistentWorkspace:boolean;sharedDesktop:boolean;snapshots:boolean;network:'none'|'public-proxy'}
  inspect(spec:ComputerSpecification):Promise<ComputerState|undefined>
  ensure(spec:ComputerSpecification,authorize:()=>void):Promise<ComputerState>
  stop(spec:ComputerSpecification):Promise<void>
  remove(spec:ComputerSpecification):Promise<void>
  execute(spec:ComputerSpecification,argv:string[],options:{authorize():void;signal?:AbortSignal;timeout?:number;input?:Buffer;lane?:ComputerLane;mayFence?():boolean;user?:ComputerUser}):Promise<CommandResult>
  health(spec:ComputerSpecification,authorize:()=>void):Promise<unknown>
}
class Semaphore {
  private active=0
  private readonly queue:Array<()=>void>=[]
  constructor(readonly max:number) {}
  acquire():Promise<()=>void> {
    const admit=()=>{this.active++;let released=false;return ()=>{if(released)return;released=true;this.release()}}
    if(this.active<this.max)return Promise.resolve(admit())
    return new Promise(resolve=>this.queue.push(()=>resolve(admit())))
  }
  private release(){this.active--;this.queue.shift()?.()}
}
class Lane {
  private active=0
  private writer=false
  private readonly queue:Array<{writer:boolean;admit:()=>void}>=[]
  readonly exec=new Semaphore(8)
  readonly gui=new Semaphore(1)
  async read<T>(action:()=>Promise<T>,slot:Semaphore=this.exec):Promise<T> {
    await this.enter(false)
    const releaseSlot=await slot.acquire()
    try { return await action() }
    finally { releaseSlot(); this.leave() }
  }
  async write<T>(action:()=>Promise<T>):Promise<T> {
    await this.enter(true)
    try { return await action() }
    finally { this.leave() }
  }
  private enter(writer:boolean):Promise<void> {
    // Writer preference: once a lifecycle operation queues, new operations wait behind it.
    const blocked=writer?this.writer||this.active>0:this.writer||this.queue.some(item=>item.writer)
    if(!blocked){this.writer=writer;this.active++;return Promise.resolve()}
    return new Promise<void>(admit=>this.queue.push({writer,admit:()=>{this.writer=writer;this.active++;admit()}}))
  }
  private leave(){
    this.active--
    if(this.active>0)return
    this.writer=false
    while(this.queue.length){
      const head=this.queue[0]!
      if(head.writer){if(this.active===0){this.queue.shift();head.admit()}break}
      this.queue.shift();head.admit()
    }
  }
}
export class ComputerError extends Error { constructor(readonly code:string,message:string){super(message)} }
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const capabilities=(values:unknown)=>Array.isArray(values)?values.map(value=>String(value).toUpperCase().replace(/^CAP_/, '')).sort():[]

/** A private container per environment. No tools, filesystem operations or
 * process execution fall back to the host. Remote hosts run their own Runner. */
export class ContainerComputerProvider implements ComputerProvider {
  readonly fixedCapacity:boolean=false
  private lanes=new Map<string,Lane>()
  readonly capabilities={isolation:'container',shell:true,desktop:true,persistentWorkspace:true,sharedDesktop:false,snapshots:false,network:'none'} as const
  constructor(readonly runtime:'docker'|'podman',readonly runnerId:string,readonly home:string,readonly run:ContainerCommand=command,readonly environment:NodeJS.ProcessEnv=process.env) {
    z.string().uuid().parse(runnerId)
    if(!['docker','podman'].includes(runtime))throw new ComputerError('runtime_unsupported','电脑运行时不受支持')
  }
  private lane(id:string):Lane{let lane=this.lanes.get(id);if(!lane){lane=new Lane();this.lanes.set(id,lane)}return lane}
  async verifyRuntime() {
    if(this.runtime==='docker') {
      const endpoint=this.environment.DOCKER_HOST||JSON.parse((await this.run('docker',['context','inspect','--format','{{json .Endpoints.docker.Host}}'])).stdout)
      if(typeof endpoint!=='string'||!(/^(?:unix|npipe):\/\//.test(endpoint)))throw new ComputerError('computer_remote_engine','远程 Docker 引擎请在目的电脑安装 Runner')
    }else{
      const connections=JSON.parse((await this.run('podman',['system','connection','list','--format','json'])).stdout)
      const endpoint=this.environment.CONTAINER_HOST||connections.find((entry:any)=>entry.Default)?.URI
      if(endpoint){const url=new URL(endpoint);if(url.protocol!=='unix:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new ComputerError('computer_remote_engine','远程 Podman 引擎请在目的电脑安装 Runner')}
    }
  }
  validateSpecification(value:ComputerSpecification):Spec {
    const parsed=schema.safeParse(value)
    if(!parsed.success)throw new ComputerError('computer_spec_invalid','电脑环境配置无效')
    return parsed.data
  }
  private name(spec:Spec){return `yaoyao-computer-${digest([this.runnerId,spec.id]).slice(0,24)}`}
  private labels(spec:Spec){return {[managedLabel]:spec.id,[runnerLabel]:this.runnerId,[ownerLabel]:digest(spec.ownerKey),[specLabel]:digest(spec)}}
  private async workspace(spec:Spec) {
    const base=resolve(this.home,'computer-workspaces')
    await mkdir(base,{recursive:true,mode:0o700})
    const canonical=await realpath(base),path=join(canonical,spec.id)
    await recoverWorkspace(canonical,spec.id)
    if(/[,\n\r\0]/.test(path))throw new ComputerError('computer_path_invalid','电脑数据目录包含不支持的字符')
    await mkdir(path,{recursive:true,mode:0o700})
    if(await realpath(path)!==path)throw new ComputerError('computer_path_unsafe','电脑工作区不能指向其他目录')
    if(process.platform!=='win32')await chmod(path,0o700)
    return path
  }
  private async inspectRaw(name:string):Promise<any|undefined> {
    try {const result=await this.run(this.runtime,['inspect',name]);return JSON.parse(result.stdout)[0]}
    catch(error){
      if(/no such (?:object|container)|no container with name or ID/i.test(String((error as any).stderr??'')))return undefined
      throw error
    }
  }
  private assertOwned(spec:Spec,detail:any) {
    if(!detail||!/^[a-f0-9]{64}$/.test(String(detail.Id))||Object.entries(this.labels(spec)).filter(([key])=>key!==specLabel).some(([key,value])=>detail.Config?.Labels?.[key]!==value))
      throw new ComputerError('computer_owner_mismatch','电脑实例不属于当前执行节点或配置已变化')
  }
  private assertConfiguration(spec:Spec,detail:any,workspace:string) {
    this.assertOwned(spec,detail)
    const host=detail.HostConfig??{},expectedCaps=this.runtime==='podman'?['SETGID','SETUID','SYS_CHROOT']:['SETGID','SETUID']
    const nanoCPUs=host.NanoCpus??(host.CpuPeriod>0?host.CpuQuota/host.CpuPeriod*1e9:0)
    const ports=Object.entries(host.PortBindings??{}),mounts=detail.Mounts??[]
    const destinations=spec.cwd===COMPUTER_WORKSPACE?[COMPUTER_WORKSPACE]:[COMPUTER_WORKSPACE,spec.cwd]
    if(detail.Config?.Labels?.[specLabel]!==digest(spec)||detail.Image!==spec.imageId||host.Privileged!==false||host.Memory!==spec.memoryMiB*mib||host.MemorySwap!==spec.memoryMiB*mib
      ||nanoCPUs!==spec.cpus*1e9||host.PidsLimit!==spec.pids||host.IpcMode!=='private'||host.CgroupnsMode!=='private'
      ||host.NetworkMode!=='none'||host.PidMode==='host'||host.UsernsMode==='host'||host.UTSMode==='host'
      ||(host.SecurityOpt??[]).some((value:string)=>/^no-new-privileges(?::true)?$/.test(value)||/unconfined/.test(value))
      ||JSON.stringify(capabilities(host.CapAdd))!==JSON.stringify(expectedCaps)||!capabilities(host.CapDrop).includes('ALL')
      ||(host.Devices??[]).length||(host.DeviceRequests??[]).length||host.RestartPolicy?.Name!=='no'
      ||mounts.length!==destinations.length||mounts.some((mount:any)=>mount.Type!=='bind'||mount.Source!==workspace||!destinations.includes(mount.Destination)||mount.RW!==true)||new Set(mounts.map((mount:any)=>mount.Destination)).size!==destinations.length
      ||ports.length!==0)
      throw new ComputerError('computer_configuration_unsafe','电脑实例的隔离、资源或数据目录不符合要求，请先停止并核对')
  }
  private state(spec:Spec,detail:any,workspace:string):ComputerState {
    this.assertConfiguration(spec,detail,workspace)
    if(Object.values(detail.NetworkSettings?.Ports??{}).some(bindings=>Array.isArray(bindings)&&bindings.length))throw new ComputerError('computer_viewer_unsafe','电脑环境不能发布网络端口')
    return {id:spec.id,containerId:detail.Id,running:detail.State?.Running===true,workspace,isolation:'container'}
  }
  private async migratedContainer(spec:Spec,detail:any,workspace:string) {
    if(!detail || detail.Mounts?.every((mount:any)=>mount.Source===workspace))return detail
    let root=resolve(this.home)
    while(dirname(root)!==root&&basename(root)!=='.yaoyao')root=dirname(root)
    if(basename(root)!=='.yaoyao')return detail
    let migration
    try{migration=JSON.parse(await readFile(join(root,'.data-home-migration.json'),'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return detail;throw error}
    if(migration.phase!=='complete'||migration.target!==root||migration.source!==join(dirname(root),'.hermes-yaoyao'))return detail
    const oldWorkspace=migration.source+workspace.slice(root.length)
    this.assertConfiguration(spec,detail,oldWorkspace)
    if(detail.State?.Running)throw new ComputerError('computer_migration_busy','旧目录的虚拟机仍在运行，请停止后再迁移')
    // Preserve the old writable layer as a stopped backup; only the verified name changes.
    await this.run(this.runtime,['rename',detail.Id,`${this.name(spec)}-before-data-move-${detail.Id.slice(0,8)}`])
    return undefined
  }
  async inspect(value:ComputerSpecification):Promise<ComputerState|undefined> {
    await this.verifyRuntime()
    const spec=this.validateSpecification(value),workspace=await this.workspace(spec),detail=await this.migratedContainer(spec,await this.inspectRaw(this.name(spec)),workspace)
    return detail?this.state(spec,detail,workspace):undefined
  }
  private args(spec:Spec,workspace:string) {
    return ['create','--name',this.name(spec),'--hostname',this.name(spec),// The XFCE/VNC startup resolves its own hostname even without a network.
      '--add-host',`${this.name(spec)}:127.0.0.1`,
      ...Object.entries(this.labels(spec)).flatMap(([key,value])=>['--label',`${key}=${value}`]),
      '--restart','no','--network','none','--ipc','private','--cgroupns','private',
      '--memory',`${spec.memoryMiB}m`,'--memory-swap',`${spec.memoryMiB}m`,'--cpus',String(spec.cpus),'--pids-limit',String(spec.pids),
      '--shm-size','512m','--cap-drop','ALL','--cap-add','SETUID','--cap-add','SETGID',
      ...(this.runtime==='podman'?['--userns','keep-id:uid=1000,gid=1000','--user','root','--cap-add','SYS_CHROOT']:[]),
      ...[...new Set([COMPUTER_WORKSPACE,spec.cwd])].flatMap(destination=>['--mount',`type=bind,source=${workspace},target=${destination}${this.runtime==='podman'?',relabel=private':''}`]),
      ...(spec.network==='public-proxy'?['--env','HTTP_PROXY=http://127.0.0.1:3128','--env','HTTPS_PROXY=http://127.0.0.1:3128','--env','http_proxy=http://127.0.0.1:3128','--env','https_proxy=http://127.0.0.1:3128','--env','NO_PROXY=localhost,127.0.0.1,::1','--env','no_proxy=localhost,127.0.0.1,::1']:[]),
      '--env',`VNC_PW=${randomBytes(24).toString('base64url')}`,spec.imageId]
  }
  async ensure(value:ComputerSpecification,authorize:()=>void):Promise<ComputerState> {
    const spec=this.validateSpecification(value)
    return this.lane(spec.id).write(async()=>{
      authorize();await this.verifyRuntime();authorize()
      const workspace=await this.workspace(spec)
      let detail=await this.migratedContainer(spec,await this.inspectRaw(this.name(spec)),workspace)
      if(detail?.HostConfig?.SecurityOpt?.some((value:string)=>/^no-new-privileges(?::true)?$/.test(value))) {
        await this.stopOwned(spec,detail.Id)
        await this.run(this.runtime,['rm','--',detail.Id])
        detail=undefined
      }
      if(!detail) {
        const image=JSON.parse((await this.run(this.runtime,['image','inspect',spec.imageId])).stdout)[0]
        if(image?.Id!==spec.imageId||image.Config?.Labels?.['com.openmausbot.cua-driver']!=='0.20.0'||image.Config?.Labels?.['com.openmausbot.image-layer']!=='5')
          throw new ComputerError('computer_image_incompatible','电脑镜像缺少已验证的驱动，请先安装兼容镜像')
        authorize()
        const created=await this.run(this.runtime,this.args(spec,workspace))
        const id=created.stdout.trim()
        if(!/^[a-f0-9]{64}$/.test(id))throw new ComputerError('computer_creation_uncertain','电脑创建结果不确定，请核对实例')
        detail=await this.inspectRaw(id)
      }
      let state=this.state(spec,detail,workspace)
      authorize()
      if(!state.running)await this.run(this.runtime,['start','--',state.containerId])
      try {
        authorize();detail=await this.inspectRaw(state.containerId);state=this.state(spec,detail,workspace);authorize()
        if(!state.running)throw new ComputerError('computer_start_failed','电脑环境未能启动')
        return state
      }catch(error){await this.stopOwned(spec,state.containerId).catch(()=>{});throw error}
    })
  }
  private async stopOwned(spec:Spec,id:string) {
    const detail=await this.inspectRaw(id)
    if(!detail)return
    this.assertOwned(spec,detail)
    if(detail.State?.Running)await this.run(this.runtime,['stop','--time','10','--',id],{timeout:15000})
    const stopped=await this.inspectRaw(id)
    if(stopped?.State?.Running)throw new ComputerError('computer_stop_uncertain','尚未确认电脑环境已停止')
  }
  async stop(value:ComputerSpecification):Promise<void> {
    const spec=this.validateSpecification(value)
    return this.lane(spec.id).write(async()=>{await this.verifyRuntime();const detail=await this.inspectRaw(this.name(spec));if(detail){this.assertOwned(spec,detail);await this.stopOwned(spec,detail.Id)}})
  }
  async remove(value:ComputerSpecification):Promise<void> {
    const spec=this.validateSpecification(value)
    return this.lane(spec.id).write(async()=>{
      await this.verifyRuntime()
      const detail=await this.inspectRaw(this.name(spec));if(!detail)return
      this.assertOwned(spec,detail);await this.stopOwned(spec,detail.Id)
      await this.run(this.runtime,['rm','--',detail.Id])
      // Persistent workspace deletion is a separate, explicit operation.
    })
  }
  async execute(value:ComputerSpecification,argv:string[],options:{authorize():void;signal?:AbortSignal;timeout?:number;input?:Buffer;lane?:ComputerLane;mayFence?():boolean;user?:ComputerUser}):Promise<CommandResult> {
    const spec=this.validateSpecification(value)
    if(!argv.length||argv.length>64||argv.some(arg=>typeof arg!=='string'||arg.includes('\0'))||argv.join('').length>65536)throw new ComputerError('computer_command_invalid','电脑命令无效或过长')
    return this.lane(spec.id).read(async()=>{
      options.authorize();if(options.signal?.aborted)throw new ComputerError('computer_cancelled','操作已停止')
      const state=await this.inspect(spec)
      if(!state?.running)throw new ComputerError('computer_not_running','电脑环境尚未运行')
      options.authorize()
      try {
        const user=options.user??'cua',uid=user==='root'?'0:0':'1000:1000',home=user==='root'?'/root':'/home/cua'
        const result=await this.run(this.runtime,['exec',...(options.input?['-i']:[]),'--user',uid,'--env',`HOME=${home}`,'--env',`USER=${user}`,'--workdir',spec.cwd,'--',state.containerId,...argv],{timeout:Math.min(60000,Math.max(1000,options.timeout??30000)),signal:options.signal,input:options.input})
        options.authorize();return result
      }catch(error){
        // Killing a docker exec client alone cannot prove its guest process stopped.
        // A cancelled or unacknowledged operation closes this private environment —
        // unless other holders still share it, in which case only this operation fails.
        if(options.signal?.aborted||(error as any).killed||typeof (error as any).code!=='number'){
          if(options.mayFence===undefined||options.mayFence())this.fence(spec,state.containerId)
        }
        throw error
      }
    },options.lane==='gui'?this.lane(spec.id).gui:undefined)
  }
  /** Escalates to the lifecycle lane so the stop never runs under live operations. */
  private fence(spec:Spec,id:string){void this.lane(spec.id).write(async()=>{await this.stopOwned(spec,id).catch(()=>{})}).catch(()=>{})}
  async installSkill(value:ComputerSpecification,bundle:SkillInstallation,script:string,options:{authorize():void;signal?:AbortSignal}):Promise<{path:string;revision:string}> {
    const spec=this.validateSpecification(value)
    return this.lane(spec.id).read(async()=>{
      options.authorize();if(options.signal?.aborted)throw new ComputerError('computer_cancelled','操作已停止')
      const state=await this.inspect(spec)
      if(!state?.running)throw new ComputerError('computer_not_running','电脑环境尚未运行')
      options.authorize()
      const result=await this.run(this.runtime,['exec','-i','--user','0:0','--',state.containerId,'python3','-c',script,'install'],{input:Buffer.from(JSON.stringify(bundle)),signal:options.signal,timeout:30000})
      options.authorize();return JSON.parse(result.stdout)
    })
  }
  async capture(value:ComputerSpecification,authorize:()=>void):Promise<{data:string;width:number;height:number;capturedAt:number}> {
    const spec=this.validateSpecification(value)
    return this.lane(spec.id).read(async()=>{
      const state=await this.inspect(spec)
      authorize();if(!state?.running)throw new ComputerError('computer_not_running','电脑尚未运行')
      const file=`/tmp/yaoyao-view-${randomBytes(12).toString('hex')}.png`
      const exec=(args:string[])=>this.run(this.runtime,['exec','--user','1000:1000','--',state.containerId,...args],{timeout:10000})
      try{
        await exec([CUA_DRIVER,'call','get_desktop_state','{}','--socket',CUA_SOCKET,'--screenshot-out-file',file]);authorize()
        const data=(await exec(['base64','-w0',file])).stdout.trim(),bytes=Buffer.from(data,'base64')
        if(bytes.length<24||bytes.subarray(1,4).toString()!=='PNG')throw new ComputerError('computer_frame_invalid','电脑画面无效')
        authorize();return {data,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),capturedAt:Date.now()}
      }finally{await exec(['rm','-f','--',file]).catch(()=>{})}
    },this.lane(spec.id).gui)
  }
  async deleteWorkspace(value:ComputerSpecification):Promise<void>{
    const spec=this.validateSpecification(value)
    return this.lane(spec.id).write(async()=>{
      if(await this.inspectRaw(this.name(spec)))throw new ComputerError('computer_busy','删除工作区前必须移除电脑实例')
      const base=await realpath(resolve(this.home,'computer-workspaces')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
      if(!base)return
      const path=join(base,spec.id),info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
      if(!info)return
      if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw new ComputerError('computer_path_unsafe','拒绝删除非预期的电脑工作区')
      await rm(path,{recursive:true})
    })
  }
  async openPipe(value:ComputerSpecification,argv:string[],authorize:()=>void){
    const spec=this.validateSpecification(value)
    authorize();const state=await this.inspect(spec);authorize()
    if(!state?.running)throw new ComputerError('computer_not_running','电脑环境尚未运行')
    return spawn(this.runtime,['exec','-i','--user','1000:1000','--workdir',spec.cwd,'--',state.containerId,...argv],{stdio:'pipe'})
  }
  async configureNetwork(value:ComputerSpecification,authorize:()=>void){
    const spec=this.validateSpecification(value)
    if(spec.network!=='public-proxy')return
    return this.lane(spec.id).read(async()=>{
      authorize();const state=await this.inspect(spec);authorize()
      if(!state?.running)throw new ComputerError('computer_not_running','电脑环境尚未运行')
      const script='import pathlib,json; chrome={"ProxyMode":"fixed_servers","ProxyServer":"http://127.0.0.1:3128","ProxyBypassList":"localhost;127.0.0.1;[::1]","QuicAllowed":False}; firefox={"policies":{"Proxy":{"Mode":"manual","HTTPProxy":"http://127.0.0.1:3128","SSLProxy":"http://127.0.0.1:3128","Passthrough":"localhost,127.0.0.1,::1","Locked":True},"DNSOverHTTPS":{"Enabled":False,"Locked":True}}}; paths=[("/etc/chromium/policies/managed/yaoyao.json",chrome),("/etc/opt/chrome/policies/managed/yaoyao.json",chrome),("/usr/lib/firefox/policies/managed/yaoyao.json",firefox),("/usr/lib/firefox-esr/distribution/policies.json",firefox),("/opt/firefox/distribution/policies.json",firefox)]; [(pathlib.Path(p).parent.mkdir(parents=True,exist_ok=True),pathlib.Path(p).write_text(json.dumps(v))) for p,v in paths]'
      await this.run(this.runtime,['exec','--user','0','--',state.containerId,'python3','-c',script])
      authorize()
    })
  }
  async health(value:ComputerSpecification,authorize:()=>void):Promise<unknown> {
    return JSON.parse((await this.execute(value,[CUA_DRIVER,'call','health_report','{}','--socket',CUA_SOCKET],{authorize,lane:'gui'})).stdout)
  }
}
