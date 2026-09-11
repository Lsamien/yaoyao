import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ComputerImages } from './images.js'
import { ComputerError } from './container.js'
import { UNCONFIGURED_COMPUTER_IMAGE } from '../../shared/runner.js'
import type { LocalVmMode, LocalVmStatus } from '../../shared/localVm.js'
import {LOCAL_VM_IMAGES, type LocalVmImageKey, type LocalVmImageOption} from '../../shared/localVm.js'
import type { ComputerRuntime, ComputerTarget } from '../worker/gateway.js'
import {ComposeComputerProvider} from './compose.js'
import {COMPOSE_DESKTOP_IMAGE} from '../../shared/composeDesktops.js'

type State = { imageId: string; images?: Partial<Record<LocalVmImageKey,string>>; mode: LocalVmMode; maxInstances: number; job?: LocalVmStatus['job'] }

/** Settings prepares trusted recipes; each desktop keeps one immutable image. */
export class LocalVmImages {
  readonly images: ComputerImages
  readonly ready: Promise<void>
  private state: State
  private pending?: Promise<void>
  private closed = false
  private releaseMaintenance?: () => void
  constructor(readonly runtime: ComputerRuntime, readonly db: DatabaseSync) {
    this.images = new ComputerImages(runtime.config.runtime)
    db.exec('CREATE TABLE IF NOT EXISTS local_vm_runtime(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)')
    const row = db.prepare('SELECT value FROM local_vm_runtime WHERE id=1').get() as {value:string}|undefined
    this.state = row ? JSON.parse(row.value) : {imageId:runtime.config.imageId,mode:'per-bot',maxInstances:runtime.config.maxConcurrent ?? 2}
    if(runtime.provider.fixedCapacity)this.state={imageId:COMPOSE_DESKTOP_IMAGE,mode:'shared',maxInstances:2}
    // Preserve an already selected image when migrating; old archives and workspaces are untouched.
    if (!runtime.provider.fixedCapacity && !row && db.prepare("SELECT name FROM sqlite_master WHERE name='managed_image_selection'").get()) {
      const old = db.prepare('SELECT value FROM managed_image_selection WHERE id=1').get() as {value:string}|undefined
      if (old) this.state.imageId = JSON.parse(old.value).active ?? this.state.imageId
    }
    runtime.config.imageId = this.state.imageId
    this.state.images??={standard:this.state.imageId}
    runtime.pool.limits.concurrent = this.state.maxInstances
    runtime.retainDesktops = true
    this.releaseMaintenance = runtime.pool.holdMaintenance()
    this.ready = runtime.ready.then(async () => {
      if (this.state.job?.state === 'running') {
        try { await this.cleanup(this.state.job.id) }
        catch {this.state.job={...this.state.job,state:'failed',message:'上次准备的测试虚拟机停止状态待核对，请启动容器运行环境后重新检查'};this.save();return}
        this.state.job={...this.state.job,state:'failed',message:'上次准备已中断，可重新准备本地虚拟机'};this.save()
      }
      this.releaseMaintenance?.(); this.releaseMaintenance = undefined
    })
    void this.ready.catch(() => {})
  }
  private save() { this.db.prepare('INSERT OR REPLACE INTO local_vm_runtime VALUES(1,?)').run(JSON.stringify(this.state)) }
  private spec(id:string,imageId=this.runtime.config.imageId) { return {id,ownerKey:'local-vm-prepare',imageId} }
  private async cleanup(id:string) {
    const spec = this.spec(id)
    await this.runtime.provider.remove(spec)
    await this.runtime.provider.deleteWorkspace(spec)
  }
  async options():Promise<LocalVmImageOption[]> {
    await this.ready
    return Promise.all(LOCAL_VM_IMAGES.map(async option=>{
      const imageId=this.state.images?.[option.key]
      let ready=false
      if(imageId&&imageId!==UNCONFIGURED_COMPUTER_IMAGE)try{const image=await this.images.inspect(imageId);ready=(image.imageKey??'standard')===option.key}catch{}
      return {...option,ready,...(ready?{imageId}:{})}
    }))
  }
  async select(meta:ComputerTarget,key:LocalVmImageKey,authorize:()=>void) {
    if(this.runtime.provider.fixedCapacity)throw new ComputerError('compose_desktop_managed','桌面镜像由 Compose 配置')
    await this.ready;authorize();this.runtime.assertTarget(meta)
    const release=this.runtime.pool.beginMaintenance({allowIdle:true})
    try {
      this.runtime.imageFor(meta) // Validate ownership, including bindings without an instance.
      if(this.runtime.pool.definition(meta.ownerKey,meta.environmentId))throw new ComputerError('computer_image_in_use','请先移除虚拟机实例再切换镜像，工作文件和浏览器资料会保留')
      const image=(await this.options()).find(option=>option.key===key&&option.ready)
      if(!image?.imageId)throw new ComputerError('computer_image_required','请先在本地虚拟机设置中准备这个镜像')
      authorize()
      this.db.prepare('INSERT INTO computer_image_bindings VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET image_id=excluded.image_id').run(meta.environmentId,meta.ownerKey,image.imageId)
      return {ok:true}
    } finally {release()}
  }
  async status(owner?:string): Promise<LocalVmStatus> {
    await this.ready
    if(this.runtime.provider instanceof ComposeComputerProvider){
      const desktops=await this.runtime.provider.inventory()
      this.runtime.pool.limits.concurrent=Math.max(1,desktops.length)
      return {configured:true,executionHost:'runner',fixedCapacity:true,desktops,daemonUp:true,image:desktops.some((d:any)=>d.ready),imageId:COMPOSE_DESKTOP_IMAGE,mode:'shared',maxInstances:desktops.length,busy:false}
    }
    if(this.releaseMaintenance&&!this.pending&&this.state.job?.state==='failed') {
      try{await this.cleanup(this.state.job.id);this.releaseMaintenance();this.releaseMaintenance=undefined}catch{}
    }
    let daemonUp=false,image=false,problem:string|undefined
    try { await this.runtime.provider.verifyRuntime();daemonUp=true }
    catch { problem='请先安装并启动 Docker 或 Podman' }
    if(daemonUp && this.state.imageId!==UNCONFIGURED_COMPUTER_IMAGE) {
      try { await this.images.inspect(this.state.imageId);image=true } catch { problem='本地虚拟机镜像尚未就绪，请重新准备' }
    }
    return {configured:true,runtime:this.runtime.config.runtime,daemonUp,image,imageId:image?this.state.imageId:undefined,images:await this.options(),
      mode:this.state.mode,maxInstances:this.state.maxInstances,busy:!!this.pending||!!this.releaseMaintenance,problem,job:this.state.job,
      instances:owner?this.runtime.pool.status(owner).map(row=>({id:row.environmentId,status:row.status})):[]}
  }
  async policy(mode:LocalVmMode,maxInstances:number) {
    if(this.runtime.provider.fixedCapacity)throw new ComputerError('compose_desktop_managed','桌面数量与共享方式由 Compose 固定，不能在界面修改')
    await this.ready
    // Sharing changes future Agent bindings; an idle desktop can keep running.
    // Image preparation still requires every desktop to be stopped.
    const release=this.runtime.pool.beginMaintenance({allowIdle:true})
    try { this.state.mode=mode;this.state.maxInstances=maxInstances;this.runtime.pool.limits.concurrent=maxInstances;this.save() }
    finally { release() }
    return this.status()
  }
  async prepare(id:string,check:()=>Promise<void>,key:LocalVmImageKey='standard') {
    if(this.runtime.provider.fixedCapacity)throw new ComputerError('compose_desktop_managed','桌面镜像由 Compose 配置，无需在界面准备')
    await this.ready;await check()
    if(this.state.job?.id===id){if((this.state.job.imageKey??'standard')!==key)throw new ComputerError('idempotency_conflict','请求编号已用于其他镜像');return this.status()}
    if(this.pending||this.closed)throw new ComputerError('local_vm_busy','本地虚拟机正在准备，请稍后查看')
    this.releaseMaintenance=this.runtime.pool.beginMaintenance()
    this.state.job={id,state:'running',imageKey:key,message:'正在准备本地虚拟机'};this.save()
    const progress=(message:string)=>{this.state.job!.message=message;this.save()}
    this.pending=(async()=>{
      try {
        await this.runtime.provider.verifyRuntime();await check()
        const verify=async(manifest:{imageId:string})=>{
          progress('正在检查虚拟机桌面与电脑驱动')
          const spec=this.spec(id,manifest.imageId)
          try {
            await this.runtime.provider.ensure(spec,()=>{if(this.closed)throw new Error('服务已停止')})
            const deadline=Date.now()+60000
            for(;;) { await check();try{await this.runtime.provider.health(spec,()=>{});await this.runtime.provider.capture(spec,()=>{});break}catch(error){if(Date.now()>deadline)throw error;await new Promise(r=>setTimeout(r,1000))} }
          } finally { await this.runtime.provider.remove(spec);await this.runtime.provider.deleteWorkspace(spec) }
        }
        this.images.verify=verify
        const ids=(await this.images.run(this.images.runtime,['image','ls','--no-trunc','--quiet','--filter','label=cn.samien.yaoyao.computer-image=1'])).trim().split(/\s+/).filter(Boolean)
        let image
        for(const value of [this.state.images?.[key],...ids].filter((id):id is string=>!!id&&id!==UNCONFIGURED_COMPUTER_IMAGE)) { try{const candidate=await this.images.inspect(value);if((candidate.imageKey??'standard')===key){image=candidate;break}}catch{} }
        if(image)await verify(image)
        else {
          progress('正在准备托管桌面镜像，首次下载可能需要数分钟')
          const recipe=[join(dirname(this.runtime.script),'computer-image'),join(dirname(this.runtime.script),'../computers/computer-image'),resolve('deploy/computer')].find(p=>existsSync(join(p,'Dockerfile')))
          if(!recipe)throw new Error('缺少本地虚拟机资源，请重新安装 App')
          image=await this.images.prepare(recipe,key)
        }
        await check();const previous=this.state.images![key];this.state.images![key]=image.imageId
        // Preparing a second image must not change an existing desktop's choice.
        if(this.state.imageId===UNCONFIGURED_COMPUTER_IMAGE||this.state.imageId===previous){this.state.imageId=image.imageId;this.runtime.config.imageId=image.imageId}
        this.state.job={id,state:'complete',imageKey:key,message:'镜像已就绪，可在机器人的电脑面板中选择并创建桌面'};this.save()
      } catch(error) {
        this.state.job={id,state:'failed',imageKey:key,message:error instanceof Error?error.message.slice(0,240):'本地虚拟机准备失败'};this.save()
      } finally {
        // Do not release maintenance when an interrupted verification VM may still be alive.
        try { await this.cleanup(id);this.releaseMaintenance?.();this.releaseMaintenance=undefined } catch { this.state.job={id,state:'failed',message:'测试虚拟机停止状态待核对，请重启执行环境后重试'};this.save() }
        this.pending=undefined
      }
    })()
    return this.status()
  }
  async close() { this.closed=true;await this.ready;await this.pending }
}
