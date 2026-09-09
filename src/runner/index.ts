import { readFileSync, statSync, mkdirSync } from 'node:fs'
import { resolve, dirname, isAbsolute, join } from 'node:path'
import type { ParentPort } from 'electron'
import { RunnerAgent } from './agent.js'
import { parseRunnerConfiguration } from './config.js'
import { acquireServiceInstance } from '../server/serviceInstance.js'

const controller=new AbortController()
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort())
const parent=(process as unknown as {parentPort?:ParentPort}).parentPort
async function input():Promise<{config:ReturnType<typeof parseRunnerConfiguration>;home:string}> {
  if(process.argv.includes('--desktop-ipc')) {
    if(!parent)throw new Error('桌面配置只允许通过 App 私有进程通道传入')
    return new Promise((resolveInput,reject)=>{
      const timer=setTimeout(()=>reject(new Error('未收到桌面配置')),10000)
      parent.once('message',event=>{
        clearTimeout(timer)
        try {
          const data=event.data
          if(data?.type!=='configure'||typeof data.home!=='string'||!isAbsolute(data.home))throw new Error('桌面配置无效')
          const config=parseRunnerConfiguration(data.config)
          resolveInput({config,home:join(data.home,config.runnerId)})
        }catch{reject(new Error('桌面配置无效'))}
      })
    })
  }
  const index=process.argv.indexOf('--config'),path=index>=0?process.argv[index+1]:undefined
  if(!path)throw new Error('用法：yaoyao-runner --config /path/to/runner.json')
  if(process.platform!=='win32'&&(statSync(path).mode&0o077)!==0)throw new Error('执行节点配置必须为仅当前用户可读（chmod 600）')
  let value:unknown
  try{value=JSON.parse(readFileSync(path,'utf8'))}catch{throw new Error('无法读取执行节点 JSON 配置')}
  const config=parseRunnerConfiguration(value)
  return {config,home:resolve(dirname(path),'state',config.runnerId)}
}
try {
  const {config,home}=await input()
  parent?.on('message',event=>{if(event.data?.type==='shutdown')controller.abort()})
  mkdirSync(home,{recursive:true,mode:0o700})
  const instance=acquireServiceInstance(home,'1.0.0')
  process.once('exit',()=>instance.release())
  const agent=new RunnerAgent(config,home,fetch,message=>{
    if(parent)parent.postMessage({type:'status',message})
    else process.stderr.write(`${new Date().toISOString()} ${message}\n`)
  })
  try{await agent.run(controller.signal)}finally{instance.release()}
}catch(error){
  if(parent)parent.postMessage({type:'error',message:(error as {code?:string})?.code==='computer_stop_uncertain'?'尚未确认所有电脑环境已停止，请核对容器运行时':'执行节点启动或运行失败，请检查配置'})
  else process.stderr.write(`${error instanceof Error?error.message:'执行节点启动失败'}\n`)
  process.exitCode=1
}

// The utility IPC listener keeps Electron children alive; exit only after cleanup.
if(parent)process.exit(process.exitCode ?? 0)
