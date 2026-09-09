import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ComputerImages } from './images.js'
import { ComputerError } from './container.js'
import { UNCONFIGURED_COMPUTER_IMAGE } from '../../shared/runner.js'
import type { LocalVmMode, LocalVmStatus } from '../../shared/localVm.js'
import type { ComputerRuntime } from '../worker/gateway.js'

type State = { imageId: string; mode: LocalVmMode; maxInstances: number; job?: LocalVmStatus['job'] }

/** One managed Local VM image. It is prepared in Settings, never selected from an image catalog. */
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
    // Preserve an already selected image when migrating; old archives and workspaces are untouched.
    if (!row && db.prepare("SELECT name FROM sqlite_master WHERE name='managed_image_selection'").get()) {
      const old = db.prepare('SELECT value FROM managed_image_selection WHERE id=1').get() as {value:string}|undefined
      if (old) this.state.imageId = JSON.parse(old.value).active ?? this.state.imageId
    }
    runtime.config.imageId = this.state.imageId
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
  async status(owner?:string): Promise<LocalVmStatus> {
    await this.ready
    if(this.releaseMaintenance&&!this.pending&&this.state.job?.state==='failed') {
      try{await this.cleanup(this.state.job.id);this.releaseMaintenance();this.releaseMaintenance=undefined}catch{}
    }
    let daemonUp=false,image=false,problem:string|undefined
    try { await this.runtime.provider.verifyRuntime();daemonUp=true }
    catch { problem='请先安装并启动 Docker 或 Podman' }
    if(daemonUp && this.state.imageId!==UNCONFIGURED_COMPUTER_IMAGE) {
      try { await this.images.inspect(this.state.imageId);image=true } catch { problem='本地虚拟机镜像尚未就绪，请重新准备' }
    }
    return {configured:true,runtime:this.runtime.config.runtime,daemonUp,image,imageId:image?this.state.imageId:undefined,
      mode:this.state.mode,maxInstances:this.state.maxInstances,busy:!!this.pending||!!this.releaseMaintenance,problem,job:this.state.job,
      instances:owner?this.runtime.pool.status(owner).map(row=>({id:row.environmentId,status:row.status})):[]}
  }
  async policy(mode:LocalVmMode,maxInstances:number) {
    await this.ready
    // Sharing changes future Agent bindings; an idle desktop can keep running.
    // Image preparation still requires every desktop to be stopped.
    const release=this.runtime.pool.beginMaintenance({allowIdle:true})
    try { this.state.mode=mode;this.state.maxInstances=maxInstances;this.runtime.pool.limits.concurrent=maxInstances;this.save() }
    finally { release() }
    return this.status()
  }
  async prepare(id:string,check:()=>Promise<void>) {
    await this.ready;await check()
    if(this.state.job?.id===id)return this.status()
    if(this.pending||this.closed)throw new ComputerError('local_vm_busy','本地虚拟机正在准备，请稍后查看')
    this.releaseMaintenance=this.runtime.pool.beginMaintenance()
    this.state.job={id,state:'running',message:'正在准备本地虚拟机'};this.save()
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
        for(const value of [this.state.imageId,...ids].filter(id=>id!==UNCONFIGURED_COMPUTER_IMAGE)) { try{image=await this.images.inspect(value);break}catch{} }
        if(image)await verify(image)
        else {
          progress('正在准备托管桌面镜像，首次下载可能需要数分钟')
          const recipe=[join(dirname(this.runtime.script),'computer-image'),join(dirname(this.runtime.script),'../computers/computer-image'),resolve('deploy/computer')].find(p=>existsSync(join(p,'Dockerfile')))
          if(!recipe)throw new Error('缺少本地虚拟机资源，请重新安装 App')
          image=await this.images.prepare(recipe)
        }
        await check();this.state.imageId=image.imageId;this.runtime.config.imageId=image.imageId
        this.state.job={id,state:'complete',message:'本地虚拟机已就绪，可在 Agent 的电脑面板中创建桌面'};this.save()
      } catch(error) {
        this.state.job={id,state:'failed',message:error instanceof Error?error.message.slice(0,240):'本地虚拟机准备失败'};this.save()
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
