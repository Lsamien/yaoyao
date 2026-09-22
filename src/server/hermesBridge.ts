import {execFile} from 'node:child_process'
import {existsSync,readFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {homedir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {z} from 'zod'
import {HttpError} from './errors.js'
import {isLoopbackHost,type ServerConfig} from './config.js'
import type {UpstreamServiceSession} from './localAuth.js'
import type {DashboardController} from './dashboardController.js'
import type {HermesBridgeStatus,HermesBridgeProfileStatus,HermesBridgeInstallResult,HermesDashboardRestartResult} from '../shared/hermesBridge.js'

const execFileAsync=promisify(execFile)
const profileName=z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const installInput=z.object({profile:profileName,enable:z.boolean().default(false)}).strict()
interface LocalProfile {profile:string;exists:boolean;valid:boolean;installedVersion?:string;enabled?:boolean;disabled?:boolean;fingerprint?:string;filesCurrent?:boolean;message?:string}
interface Options {home?:string;python?:string;assetsRoot?:string;isIdle?:()=>boolean;isRestartIdle?:()=>boolean;dashboard?:DashboardController;run?:(python:string,args:string[])=>Promise<string>}

function assetRoot(){
  const base=dirname(fileURLToPath(import.meta.url))
  return [base,resolve(base,'../runner'),resolve(base,'../../')].find(root=>existsSync(join(root,'install-hermes-bridge.py'))||existsSync(join(root,'scripts/install-hermes-bridge.py')))
}

/** Admin-only installer for the configured local Hermes. No client-supplied paths or commands. */
export class HermesBridgeManager {
  readonly home:string
  readonly python:string
  readonly script:string
  readonly bundled:boolean
  readonly bundledVersion:string
  readonly local:boolean
  readonly mapped:boolean
  private installing?:string
  private restarting=false
  private readonly run:(python:string,args:string[])=>Promise<string>
  constructor(readonly config:ServerConfig,readonly session:Pick<UpstreamServiceSession,'request'> & Partial<Pick<UpstreamServiceSession,'invalidateAuthentication'>>,readonly options:Options={}){
    this.mapped=!!config.hermesBridgeMount
    this.home=resolve(options.home??config.hermesBridgeMount?.home??process.env.HERMES_HOME??join(homedir(),'.hermes'))
    this.python=options.python??config.hermesBridgeMount?.python??join(this.home,'hermes-agent','venv','bin','python')
    const root=options.assetsRoot??assetRoot()??''
    this.script=root?(existsSync(join(root,'install-hermes-bridge.py'))?join(root,'install-hermes-bridge.py'):join(root,'scripts/install-hermes-bridge.py')):''
    this.bundled=!!root&&existsSync(this.script)&&(existsSync(join(root,'hermes-bots-bridge/plugin.yaml'))||existsSync(join(root,'integrations/hermes-bots-bridge/plugin.yaml')))
    const manifest=root&&[join(root,'hermes-bots-bridge/plugin.yaml'),join(root,'integrations/hermes-bots-bridge/plugin.yaml')].find(existsSync)
    this.bundledVersion=manifest?readFileSync(manifest,'utf8').match(/^version:\s*["']?([^\s"']+)/m)?.[1]??'未知':'不可用'
    this.local=this.mapped||(isLoopbackHost(config.upstream.hostname)&&config.localVmHost!=='runner')
    this.run=options.run??(async(python,args)=>(await execFileAsync(python,args,{timeout:20000,maxBuffer:512*1024,env:{PATH:process.env.PATH,HOME:homedir(),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}})).stdout)
  }
  get idleForUpdate(){return !this.installing&&!this.restarting}
  get dashboardRestarting(){return this.restarting}
  assertDashboardAvailable(){if(this.restarting)throw new HttpError(409,'Hermes Dashboard 正在重启，请稍后再提交任务。','hermes_dashboard_restarting')}
  private get serverDashboard(){return this.local&&!this.mapped&&this.config.upstream.origin==='http://127.0.0.1:9119'}
  private get dashboardManaged(){return this.serverDashboard&&!!this.options.dashboard?.canRestart}
  private get restartUnavailable(){return !this.serverDashboard?'此 Hermes 不在夭夭服务端可管理的本机地址，请在 Hermes 所在节点重启。':this.options.dashboard?.unavailableReason??'夭夭服务端未识别到可管理的 Hermes Dashboard 服务，请在 Hermes 所在节点重启。'}
  private dashboardStatus(restartComplete=false):NonNullable<HermesBridgeStatus['dashboard']>{
    const restarting=this.restarting&&!restartComplete
    const managed=this.dashboardManaged
    const busy=!(this.options.isIdle?.()??true)
    return {managed:managed||restarting,restarting,canRestart:managed&&!restarting&&!this.installing&&!busy,
      message:restarting?'正在重启 Hermes Dashboard 并检查工具桥加载状态…':
        !managed?this.restartUnavailable:
        this.installing?'工具桥正在安装，请等待完成后重启。':busy?'当前仍有任务运行，请结束任务后重启。':
        '重启在夭夭服务端执行，会短暂断开此 Dashboard 下所有 Profile 的连接，完成后自动检查工具桥。'}
  }
  private get available(){return this.local&&this.bundled&&existsSync(this.python)&&existsSync(join(this.home,'config.yaml'))}
  private async disk():Promise<LocalProfile[]>{
    if(!this.available)return []
    try{
      const output=await this.run(this.python,[this.script,'--hermes-home',this.home,'--check'])
      return output.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(item=>profileName.safeParse(item.profile).success).slice(0,64)
    }catch{throw new HttpError(409,'无法检查工具桥，请确认 Hermes 目录权限、Python 环境和 Profile 配置可用。','hermes_bridge_check_failed')}
  }
  async status():Promise<HermesBridgeStatus>{return this.snapshot()}
  private async snapshot(restartComplete=false):Promise<HermesBridgeStatus>{
    if(this.serverDashboard&&(!this.restarting||restartComplete))await this.options.dashboard?.refresh?.()
    const [disk,remote]=await Promise.allSettled([this.disk(),this.session.request('/api/profiles',{cache:'reload'})])
    const localProfiles=disk.status==='fulfilled'?disk.value:[]
    const connected=remote.status==='fulfilled'&&remote.value.status===200
    const hostEntry=localProfiles.find(item=>item.profile==='default')
    const hostEntryInstalled=hostEntry?.filesCurrent===true&&hostEntry.enabled===true&&!hostEntry.disabled
    const names=new Set(localProfiles.map(item=>item.profile))
    if(remote.status==='fulfilled'&&remote.value.status===200){
      try{for(const item of JSON.parse(remote.value.body.toString()).profiles??[]){const name=typeof item==='string'?item:item.name;if(profileName.safeParse(name).success&&names.size<64)names.add(name)}}catch{}
    }
    if(!names.size)names.add('default')
    const profiles:HermesBridgeProfileStatus[]=[]
    const ordered=[...names].sort((a,b)=>a==='default'?-1:b==='default'?1:a.localeCompare(b))
    for(let i=0;i<ordered.length;i+=4)profiles.push(...await Promise.all(ordered.slice(i,i+4).map(async profile=>{
      const local=localProfiles.find(item=>item.profile===profile)
      let live:any,liveStatus=0
      if(connected)try{const response=await this.session.request('/api/plugins/yaoyao-bot-bridge/capabilities',{search:new URLSearchParams({profile}),cache:'reload'});liveStatus=response.status;if(response.status===200)live=JSON.parse(response.body.toString())}catch{}
      const result:HermesBridgeProfileStatus={profile,state:'unavailable',message:'无法连接 Hermes 或读取工具桥状态',canInstall:this.available&&local?.valid===true&&!this.installing&&(!this.restarting||restartComplete)&&(this.options.isIdle?.()??true),
        ...(local?.installedVersion?{installedVersion:local.installedVersion}:{}),...(typeof live?.plugin_version==='string'?{loadedVersion:live.plugin_version}:{})}
      const ready=live?.ready===true&&live?.native_tools===true&&live?.in_process===true&&live?.computer_runtime_version===2
      if(local){
        if(!local.valid){result.message=local.message??'此 Profile 的配置不可用';return result}
        if(!local.installedVersion){result.state='missing';result.message='尚未安装工具桥插件'}
        else if(local.disabled||!local.enabled){result.state='disabled';result.message='工具桥插件已安装，但尚未启用'}
        else if(!local.filesCurrent){result.state='outdated';result.message='本机插件与随附版本不同，需要更新或修复'}
        else if(!connected||liveStatus===401||liveStatus===403){result.state='unavailable';result.message='插件文件已安装，但无法验证 Hermes 加载状态；请先检查上方连接和权限'}
        else if(ready&&live?.plugin_fingerprint===local.fingerprint){result.state='ready';result.message='Hermes 已加载当前工具桥，可以使用'}
        else if(live?.plugin_fingerprint===local.fingerprint&&!ready){result.state='disabled';result.message=typeof live.reason==='string'?live.reason.slice(0,300):'Hermes 尚未启用此 Profile 的工具桥，请检查工具集设置'}
        else {result.state='restart-required';result.message='插件文件已就位；请在空闲时重启 Hermes Dashboard 服务后重新检查'}
      }else if(ready){result.state='ready';result.message='Hermes 工具桥已就绪'}
      else if(live?.computer_runtime_version&&live.computer_runtime_version!==2){result.state='outdated';result.message='Hermes 已加载的工具桥版本需要更新'}
      else if(typeof live?.reason==='string')result.message=live.reason.slice(0,300)
      if(this.local&&profile!=='default'&&!hostEntryInstalled){result.canInstall=false;result.message+='；请先安装或更新默认 Profile 的工具桥入口'}
      return result
    })))
    return {endpoint:this.config.upstream.origin,local:this.local,dashboard:this.dashboardStatus(restartComplete),...(this.mapped?{mapped:true}:{}),bundledVersion:this.bundledVersion,checkedAt:Date.now(),profiles,...(this.installing?{installing:this.installing}:{}),
      ...(!this.local?{message:'当前 Hermes 由其他节点提供，请在 Hermes 所在节点安装或修复工具桥。'}:
        !this.bundled?{message:'当前服务未包含工具桥安装包，请更新 Yaoyao。'}:
        !this.available?{message:this.mapped?`映射目录 ${this.home} 或容器 Python 不可用，请检查目录映射和读取权限。`:'当前服务环境未找到本机 Hermes 安装目录和 Python，无法直接安装。'}:
        disk.status==='rejected'?{message:'插件检查失败，请核对 Hermes 目录权限和运行环境。'}:
        this.options.isIdle&&!this.options.isIdle()?{message:'当前仍有任务运行，请结束任务后安装。'}:
        this.mapped?{message:`已映射 Hermes 目录：${this.home}。此处仅安装工具桥；Profile 模型兼容修复需在 Hermes 所在容器或节点单独执行。完成后请重启 Hermes 服务。`}:{})}
  }
  async install(value:unknown):Promise<HermesBridgeInstallResult>{
    const parsed=installInput.safeParse(value)
    if(!parsed.success)throw new HttpError(400,'请选择有效的 Profile','invalid_bridge_install_request')
    this.assertDashboardAvailable()
    if(!this.available)throw new HttpError(409,'只能为当前服务可管理的本机或显式映射的 Hermes 目录安装工具桥。','hermes_bridge_install_unavailable')
    if(this.installing)throw new HttpError(409,'工具桥正在安装，请等待完成。','hermes_bridge_install_busy')
    if(this.options.isIdle&&!this.options.isIdle())throw new HttpError(409,'当前仍有任务运行，请结束任务后安装。','hermes_bridge_tasks_running')
    this.installing=parsed.data.profile
    let result:any
    try{
      const disk=await this.disk(),local=disk.find(item=>item.profile===parsed.data.profile)
      if(!local?.valid)throw new HttpError(404,'Hermes 目录中没有此 Profile 的有效配置。','hermes_bridge_profile_missing')
      const hostEntry=disk.find(item=>item.profile==='default')
      if(parsed.data.profile!=='default'&&(!hostEntry?.filesCurrent||!hostEntry.enabled||hostEntry.disabled))
        throw new HttpError(409,'请先安装或更新默认 Profile 的工具桥入口，再安装这个 Profile。','hermes_bridge_host_entry_required')
      // A mapped data directory does not expose the upstream Hermes runtime.
      // Repair core files only with the local Hermes interpreter.
      const output=await this.run(this.python,[this.script,'--hermes-home',this.home,'--profile',parsed.data.profile,...(this.mapped?[]:['--repair-profile-runtime']),...(parsed.data.enable?['--enable']:[])])
      result=JSON.parse(output.trim())
      if(result.profile!==parsed.data.profile||typeof result.backup!=='string')throw new Error('invalid installer result')
    }catch(error){
      if(error instanceof HttpError)throw error
      throw new HttpError(409,this.mapped?'工具桥安装失败，请检查共享 Hermes 目录的读写权限及 Profile 配置后重新检查状态。':'工具桥或 Profile 模型兼容修复安装失败，请检查 Hermes 版本兼容性与目录权限后重新检查状态。','hermes_bridge_install_failed')
    }finally{this.installing=undefined}
    const message=(result.disabled?'插件文件已更新，保留了禁用设置。':'工具桥已安装并启用。')
      +(this.mapped?'此处仅安装工具桥；Profile 模型兼容修复需在 Hermes 所在容器或节点单独执行。':result.profileRuntimeRepaired?'已备份并应用 Profile 模型兼容修复。':'')
      +'请在空闲时重启 Hermes Dashboard 服务，然后重新检查。'
    return {profile:parsed.data.profile,backup:result.backup,message,status:await this.status()}
  }
  async restartDashboard(value:unknown={}):Promise<HermesDashboardRestartResult>{
    if(!z.object({}).strict().safeParse(value).success)throw new HttpError(400,'重启目标由夭夭服务端确定，不接受客户端指定目标或命令。','invalid_dashboard_restart_request')
    this.assertDashboardAvailable()
    if(!this.serverDashboard||!this.options.dashboard)throw new HttpError(409,this.restartUnavailable,'hermes_dashboard_restart_unavailable')
    if(this.installing)throw new HttpError(409,'工具桥正在安装，请等待完成。','hermes_bridge_install_busy')
    if(!(this.options.isIdle?.()??true)||!(this.options.isRestartIdle?.()??true))throw new HttpError(409,'当前仍有任务运行，请结束任务后重启。','hermes_bridge_tasks_running')
    this.restarting=true
    try{
      await this.options.dashboard.refresh?.()
      if(!this.dashboardManaged)throw new HttpError(409,this.restartUnavailable,'hermes_dashboard_restart_unavailable')
      await this.options.dashboard!.restart()
      this.session.invalidateAuthentication?.()
      const status=await this.snapshot(true)
      if(!this.dashboardManaged)throw new Error('Dashboard ownership lost during verification')
      const ready=status.profiles.every(profile=>profile.state==='ready')
      return {message:ready?'Hermes Dashboard 已重启，工具桥已就绪。':'Hermes Dashboard 已重启。部分 Profile 的工具桥尚未就绪，请查看各 Profile 状态。',status}
    }catch(error){
      if(error instanceof HttpError)throw error
      throw new HttpError(409,'Hermes Dashboard 重启或状态检查失败，请重新检查连接和工具桥状态。','hermes_dashboard_restart_failed')
    }finally{this.restarting=false}
  }
}
