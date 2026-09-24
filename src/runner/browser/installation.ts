import {spawn,type ChildProcess} from 'node:child_process'
import {existsSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import type {BrowserInstallation} from '../../shared/managedBrowser.js'

export interface BrowserInstallOptions {
  signal:AbortSignal
  onUpdate:(update:Pick<BrowserInstallation,'message'|'progress'>)=>void
}
export interface BrowserInstaller {
  probe:()=>Promise<boolean>
  install:(options:BrowserInstallOptions)=>Promise<void>
}
interface ChromiumProbe {
  executablePath:()=>string
  launch:(options:{headless:boolean;chromiumSandbox:boolean;timeout:number})=>Promise<{close:()=>Promise<void>}>
}
export interface BrowserInstallerDependencies {
  spawn?:typeof spawn
  chromium?:()=>Promise<ChromiumProbe>
  cliPath?:()=>string
  platform?:NodeJS.Platform
  getuid?:()=>number
  execPath?:string
  env?:NodeJS.ProcessEnv
  timeoutMs?:number
}
export class BrowserInstallationError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='BrowserInstallationError'}
}
const failure=(code:string,message:string)=>new BrowserInstallationError(code,message)
/** Never return CLI output: it can contain authenticated mirrors and personal paths. */
export function browserInstallationFailure(error:unknown):string {
  return error instanceof BrowserInstallationError?error.message:'浏览器准备失败，请检查节点网络和磁盘空间后重试'
}
const dependencyFailure=(message:string)=>/Host system is missing dependencies|Missing libraries:|error while loading shared libraries|cannot open shared object file/i.test(message)
const sandboxFailure=(message:string)=>/Chromium sandboxing failed|No usable sandbox|SUID sandbox|Running as root without --no-sandbox|Failed to move to new namespace|Failed to unshare|Operation not permitted.*sandbox|sandbox.*Operation not permitted/i.test(message)

/** Installs exactly the Chromium revision shipped with this Runner's Playwright. */
export function createBrowserInstaller(dependencies:BrowserInstallerDependencies={}):BrowserInstaller {
  const spawnChild=dependencies.spawn??spawn,platform=dependencies.platform??process.platform
  const chromium=dependencies.chromium??(async()=> (await import('playwright')).chromium)
  const cliPath=dependencies.cliPath??(()=>join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')),'cli.js'))
  const env:NodeJS.ProcessEnv={...(dependencies.env??process.env),ELECTRON_RUN_AS_NODE:'1',CI:'1',DEBIAN_FRONTEND:'noninteractive'}
  // Do not inherit debugging or Node preload options into the installer child.
  delete env.NODE_OPTIONS;delete env.NODE_V8_COVERAGE;delete env.PWDEBUG
  async function runCLI(args:string[],signal:AbortSignal,onUpdate:BrowserInstallOptions['onUpdate']){
    signal.throwIfAborted()
    await new Promise<void>((resolve,reject)=>{
      let child:ChildProcess,tail='',line='',killTimer:ReturnType<typeof setTimeout>|undefined,settled=false
      const finish=(error?:unknown)=>{
        if(settled)return;settled=true;signal.removeEventListener('abort',abort)
        // The CLI may exit before a downloader grandchild; terminate its entire
        // process group before reporting cancellation as complete.
        if(signal.aborted&&platform!=='win32')kill(true)
        if(killTimer)clearTimeout(killTimer)
        if(error)reject(error);else resolve()
      }
      const kill=(hard=false)=>{
        if(!child.pid)return
        if(platform==='win32'){
          // taskkill is non-interactive, and the PID comes from our own child.
          const killer=spawnChild('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',windowsHide:true});killer.on('error',()=>child.kill())
        }else{try{process.kill(-child.pid,hard?'SIGKILL':'SIGTERM')}catch{child.kill(hard?'SIGKILL':'SIGTERM')}}
      }
      const abort=()=>{kill();if(!settled){killTimer=setTimeout(()=>kill(true),2000);killTimer.unref()}}
      try{child=spawnChild(dependencies.execPath??process.execPath,[cliPath(),...args],{shell:false,stdio:['ignore','pipe','pipe'],detached:platform!=='win32',windowsHide:true,env})}
      catch(error){finish(error);return}
      const collect=(chunk:Buffer|string)=>{
        const text=String(chunk);tail=(tail+text).slice(-16384);line=(line+text).slice(-4096)
        for(const match of line.matchAll(/\b(\d{1,3})%/g)){
          const progress=Number(match[1]);if(progress<=100)onUpdate({message:`正在下载浏览器组件（当前组件 ${progress}%）`,progress})
        }
        const end=Math.max(line.lastIndexOf('\n'),line.lastIndexOf('\r'));if(end>=0)line=line.slice(end+1)
      }
      child.stdout?.on('data',collect);child.stderr?.on('data',collect)
      child.once('error',error=>finish(signal.aborted?signal.reason:error))
      child.once('close',code=>finish(signal.aborted?signal.reason:code===0?undefined:new Error(tail||'Browser installer failed')))
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    })
  }
  async function smoke(signal:AbortSignal){
    signal.throwIfAborted()
    const launch=(async()=>{
      const engine=await chromium();signal.throwIfAborted()
      const browser=await engine.launch({headless:true,chromiumSandbox:true,timeout:30000})
      await browser.close();signal.throwIfAborted()
    })()
    let abort:()=>void=()=>{}
    const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()})
    try{await Promise.race([launch,cancelled])}
    finally{signal.removeEventListener('abort',abort)}
  }
  return {
    async probe(){
      if(!existsSync((await chromium()).executablePath()))return false
      try{await smoke(AbortSignal.timeout(30000));return true}catch{return false}
    },
    async install({signal,onUpdate}){
      const controller=new AbortController()
      const cancel=()=>controller.abort(failure('browser_install_cancelled','浏览器准备已取消，请重新发起准备'))
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
      const timer=setTimeout(()=>controller.abort(failure('browser_install_timeout','浏览器准备超过 8 分钟，请检查节点网络后重试')),dependencies.timeoutMs??8*60000);timer.unref()
      try{
        controller.signal.throwIfAborted()
        onUpdate({message:'正在安装配套 Chromium 浏览器'})
        await runCLI(['install','chromium'],controller.signal,onUpdate)
        onUpdate({message:'正在验证 Chromium 沙箱启动'})
        try{await smoke(controller.signal)}catch(error){
          controller.signal.throwIfAborted()
          const message=String(error)
          if(platform==='linux'&&dependencyFailure(message)){
            if((dependencies.getuid??process.getuid)?.()!==0)throw failure('browser_install_dependencies','节点缺少 Chromium 系统库，请管理员在节点使用配套 Playwright 执行 install-deps chromium 后重试')
            onUpdate({message:'正在安装 Chromium 所需系统库'})
            await runCLI(['install-deps','chromium'],controller.signal,onUpdate)
            onUpdate({message:'正在重新验证 Chromium 沙箱启动'})
            await smoke(controller.signal)
          }else throw error
        }
        controller.signal.throwIfAborted()
      }catch(error){
        if(controller.signal.aborted)throw controller.signal.reason
        if(error instanceof BrowserInstallationError)throw error
        if(sandboxFailure(String(error)))throw failure('browser_install_sandbox','节点不支持 Chromium 安全沙箱，请管理员检查非 root 运行用户、用户命名空间和系统沙箱配置后重试')
        if(dependencyFailure(String(error)))throw failure('browser_install_dependencies','节点缺少 Chromium 系统库，请管理员在节点使用配套 Playwright 执行 install-deps chromium 后重试')
        throw failure('browser_install_failed','浏览器准备失败，请检查节点网络、磁盘空间和 Chromium 运行环境后重试')
      }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel)}
    },
  }
}
