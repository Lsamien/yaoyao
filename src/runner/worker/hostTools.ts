import {spawn} from 'node:child_process'
import {constants} from 'node:fs'
import {homedir} from 'node:os'
import {dirname,resolve} from 'node:path'
import {mkdir,open,writeFile} from 'node:fs/promises'
import {z} from 'zod'
import type {WorkerTool} from './process.js'
import {HttpError} from '../../server/errors.js'

const path=z.string().min(1).max(4096).refine(value=>!value.includes('\0'))
const text={type:'string'}
const object=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false})
export const HOST_TOOLS:WorkerTool[]=[
  {name:'host_shell',description:'在 Hermes 执行节点本机运行命令，使用本机操作系统和软件。与 computer_shell 的隔离 Linux 环境不同。',inputSchema:object({command:text,cwd:text},['command'])},
  {name:'host_read_file',description:'读取执行节点本机的 UTF-8 文件。相对路径基于本机 Profile 工作目录。',inputSchema:object({path:text},['path'])},
  {name:'host_write_file',description:'写入执行节点本机文件。只按用户要求修改；虚拟机文件请用 computer_write_file。',inputSchema:object({path:text,content:text},['path','content'])},
  {name:'computer_copy_file',description:'在本机和虚拟机之间复制一个文件，最多 25 MiB。from 指定来源环境，source 和 destination 分别使用各自环境的路径；目标同名文件会被覆盖。',inputSchema:object({from:{type:'string',enum:['host','vm']},source:text,destination:text},['from','source','destination'])},
]
export interface HostContext {cwd:string;signal:AbortSignal;authorize():void}
export const hostPath=(cwd:string,value:string)=>resolve(cwd,value==='~'?homedir():value.startsWith('~/')?resolve(homedir(),value.slice(2)):value)
export async function readHostFile(file:string,limit:number,context:HostContext){
  context.authorize();context.signal.throwIfAborted()
  const handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK)
  try{
    const stat=await handle.stat()
    if(!stat.isFile()||stat.size>limit)throw new HttpError(400,'文件类型或大小不符合要求','host_file_invalid')
    const buffer=Buffer.alloc(limit+1);let length=0
    while(length<buffer.length){context.authorize();context.signal.throwIfAborted();const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead}
    if(length>limit)throw new HttpError(413,'文件超过大小限制','host_file_limit')
    context.authorize();return buffer.subarray(0,length)
  }finally{await handle.close()}
}
export async function writeHostFile(file:string,bytes:Buffer,context:HostContext){
  context.authorize();context.signal.throwIfAborted();await mkdir(dirname(file),{recursive:true})
  context.authorize();await writeFile(file,bytes,{signal:context.signal});context.authorize()
}
export async function hostTool(name:string,args:unknown,context:HostContext):Promise<unknown>{
  context.authorize();context.signal.throwIfAborted()
  if(name==='host_read_file'){
    const body=z.object({path}).strict().parse(args)
    return {stdout:(await readHostFile(hostPath(context.cwd,body.path),1000000,context)).toString('utf8')}
  }
  if(name==='host_write_file'){
    const body=z.object({path,content:z.string().max(1000000)}).strict().parse(args)
    await writeHostFile(hostPath(context.cwd,body.path),Buffer.from(body.content),context);return {ok:true}
  }
  if(name!=='host_shell')throw new HttpError(403,'未授权的本机工具','computer_tool_forbidden')
  const body=z.object({command:z.string().min(1).max(65536),cwd:path.optional()}).strict().parse(args)
  return new Promise((done,reject)=>{
    const child=spawn(process.platform==='darwin'?'/bin/zsh':'/bin/bash',['-lc',body.command],{
      cwd:body.cwd?hostPath(context.cwd,body.cwd):context.cwd,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],
      env:{PATH:process.env.PATH,HOME:homedir(),TMPDIR:process.env.TMPDIR,LANG:process.env.LANG??'en_US.UTF-8'},
    })
    const out:Buffer[]=[],err:Buffer[]=[];let size=0,failure:Error|undefined,killTimer:ReturnType<typeof setTimeout>|undefined
    const kill=(signal:NodeJS.Signals)=>{if(!child.pid)return;try{if(process.platform!=='win32')process.kill(-child.pid,signal);else child.kill(signal)}catch{}}
    const stop=(error:Error)=>{if(failure)return;failure=error;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000)}
    const abort=()=>stop(new Error('本机命令已中断'))
    context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort()
    const timer=setTimeout(()=>stop(new Error('本机命令超过 60 秒')),60000)
    const collect=(target:Buffer[],chunk:Buffer)=>{size+=chunk.length;if(size>8*1024*1024)stop(new Error('本机命令输出超过限制'));else target.push(chunk)}
    child.stdout.on('data',chunk=>collect(out,Buffer.from(chunk)));child.stderr.on('data',chunk=>collect(err,Buffer.from(chunk)))
    child.once('error',error=>{failure=error})
    child.once('close',code=>{
      clearTimeout(timer);clearTimeout(killTimer);context.signal.removeEventListener('abort',abort)
      if(failure){kill('SIGKILL');reject(failure);return}
      try{context.authorize();done({exitCode:code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()})}catch(error){reject(error)}
    })
  })
}
