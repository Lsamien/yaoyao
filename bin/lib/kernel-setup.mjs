// Prepares the embedded Hermes kernel (Python 3.11 + locked dependencies).
// Adapted from yaovi-agent bin/lib/agent-setup.mjs (Apache-2.0).
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'

const UV_VERSION='0.13.0'

/** Virtual environment for the kernel: packaged apps keep it outside their read-only bundle. */
export function kernelVenv(root,env=process.env){
  return env.YAOYAO_KERNEL_VENV||join(root,'.venv')
}

/** Interpreter used for runtime/worker.py and runtime/hermes_service.py. */
export function kernelPython(root,env=process.env){
  return env.YAOYAO_KERNEL_PYTHON||(existsSync(join(root,'runtime/python/bin/python3'))?join(root,'runtime/python/bin/python3'):join(kernelVenv(root,env),'bin/python'))
}

function runCommand(command,args,{cwd,env,input,quiet=false}={}){
  const result=spawnSync(command,args,{cwd,env,input,encoding:'utf8',stdio:input!==undefined?['pipe','inherit','inherit']:quiet?'pipe':'inherit',timeout:600000})
  if(result.error)throw result.error
  if(result.status!==0)throw new Error(`${command} 执行失败（${result.status}）`)
}

export function verifyKernel({root,env=process.env,python=kernelPython(root,env),run=runCommand}){
  if(!existsSync(python))throw new Error('Hermes 内核未安装，请运行 yaoyao setup（源码目录使用 npm run kernel:setup）。')
  const home=mkdtempSync(join(env.TMPDIR||tmpdir(),'yaoyao-kernel-check-'))
  try{
    run(python,['-c',"import sys,runpy;sys.path.insert(0,'runtime/hermes');from run_agent import AIAgent;service=runpy.run_path('runtime/hermes_service.py');service['_bootstrap']();assert service['op_providers_catalog']({})['providers'];print('Hermes 内核及模型服务已就绪')"],
      {cwd:root,env:{...env,HOME:home,HERMES_HOME:home,YAOVI_KERNEL:'1',YAOVI_HERMES_TEST_OFFLINE:'1',HERMES_SKIP_UPDATE_CHECK:'1'}})
  }finally{rmSync(home,{recursive:true,force:true})}
  return python
}

async function resolveUv(root,env,run,fetchImpl){
  if(env.YAOYAO_UV){run(env.YAOYAO_UV,['--version'],{cwd:root,env,quiet:true});return env.YAOYAO_UV}
  const tools=env.YAOYAO_KERNEL_VENV?join(dirname(env.YAOYAO_KERNEL_VENV),'tool-bin'):join(root,'.tool-bin')
  const local=join(tools,'uv')
  if(existsSync(local))return local
  try{run('uv',['--version'],{cwd:root,env,quiet:true});return 'uv'}catch{/* install a private copy below */}
  console.log(`正在安装内核依赖管理器 uv ${UV_VERSION}…`)
  const response=await fetchImpl(`https://astral.sh/uv/${UV_VERSION}/install.sh`,{signal:AbortSignal.timeout(60000)})
  if(!response.ok)throw new Error(`uv 下载失败（HTTP ${response.status}）`)
  const installer=await response.text()
  if(installer.length>1024*1024)throw new Error('uv 安装脚本大小异常')
  mkdirSync(tools,{recursive:true})
  run('sh',[],{cwd:root,env:{...env,UV_UNMANAGED_INSTALL:tools,UV_NO_MODIFY_PATH:'1'},input:installer})
  if(!existsSync(local))throw new Error('uv 安装未生成可执行文件')
  return local
}

/** Writes only installation artifacts under the package root; never opens a user's Hermes home. */
export async function prepareKernel({root,env=process.env,run=runCommand,fetchImpl=fetch,force=false}){
  if(!['darwin','linux'].includes(process.platform))throw new Error('内置 Hermes 内核目前支持 macOS 和 Linux。')
  const python=kernelPython(root,env)
  if(env.YAOYAO_KERNEL_PYTHON)return verifyKernel({root,env,python,run})
  if(python===join(root,'runtime/python/bin/python3'))return python
  const fingerprint=createHash('sha256').update(readFileSync(join(root,'runtime/requirements.lock'))).digest('hex')
  const venv=kernelVenv(root,env)
  const marker=join(venv,'.yaoyao-requirements')
  if(!force&&existsSync(python)&&existsSync(marker)&&readFileSync(marker,'utf8')===fingerprint)return python
  // A previous successful fingerprint must not survive a failed repair.
  rmSync(marker,{force:true})
  try{
    const installEnv={...env,UV_PYTHON_INSTALL_DIR:env.YAOYAO_KERNEL_VENV?join(dirname(venv),'python'):join(root,'.python'),UV_PYTHON_DOWNLOADS:'automatic'}
    const uv=await resolveUv(root,installEnv,run,fetchImpl)
    if(!existsSync(python))run(uv,['venv','--managed-python','--python','3.11',venv],{cwd:root,env:installEnv})
    console.log('正在准备 Hermes 内核依赖…')
    run(uv,['pip','sync','--python',python,'--require-hashes',join(root,'runtime/requirements.lock')],{cwd:root,env:installEnv})
    verifyKernel({root,env,python,run})
    writeFileSync(marker,fingerprint)
    return python
  }catch(error){throw new Error(`Hermes 内核准备失败：${error.message}；请检查网络和目录权限后运行 yaoyao setup 重试。`)}
}
