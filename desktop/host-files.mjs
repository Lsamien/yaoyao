import {readdir,readFile,writeFile,mkdir,stat,realpath,open,link,rename,unlink} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {join,resolve,sep} from 'node:path'
import {homedir} from 'node:os'
import {execFile} from 'node:child_process'

export const FILE_READ_LIMIT=12*1024*1024
export const FILE_WRITE_LIMIT=10*1024*1024
export const FILE_LIST_LIMIT=500
export const SHELL_OUTPUT_LIMIT=512*1024
export const SHELL_TIMEOUT_MAX=120000

/** Resolve a user-supplied path inside an allowed root, refusing escapes
 *  through .., absolute outsiders and symlinks pointing out of the root. */
export async function resolveWithin(root,input,kind='target'){
  const base=await realpath(root)
  const raw=String(input??'').replace(/^~\//,'').replace(/^~$/,'')
  if(/\u0000/.test(raw))throw new Error('路径无效')
  const target=resolve(base,raw)
  let real=target
  try{real=await realpath(target)}catch(error){
    if(kind==='existing')throw new Error('文件或目录不存在')
    if(kind==='write'){
      let directory=join(target,'..')
      for(;;){
        try{
          const parent=await realpath(directory)
          if(parent!==base&&!parent.startsWith(base+sep))throw new Error('路径超出允许范围')
          break
        }catch(failure){
          if(failure.message==='路径超出允许范围')throw failure
          const next=join(directory,'..')
          if(directory===next)throw error
          directory=next
        }
      }
      return {base,target}
    }
  }
  if(real!==base&&!real.startsWith(base+sep))throw new Error('路径超出允许范围')
  return {base,target}
}

export async function listHostFiles(root,input){
  const {target}=await resolveWithin(root,input,'existing')
  const info=await stat(target).catch(()=>{throw new Error('文件或目录不存在')})
  if(!info.isDirectory())throw new Error('不是目录')
  const entries=await readdir(target,{withFileTypes:true})
  const limited=entries.slice(0,FILE_LIST_LIMIT)
  const rows=await Promise.all(limited.map(async entry=>{
    const full=join(target,entry.name)
    const details=await stat(full).then(value=>({size:value.size,mtime:Math.round(value.mtimeMs)})).catch(()=>({size:0,mtime:0}))
    return {name:entry.name,type:entry.isDirectory()?'directory':entry.isSymbolicLink()?'symlink':'file',...details}
  }))
  return {path:String(input),entries:rows,truncated:entries.length>FILE_LIST_LIMIT}
}

export async function readHostFile(root,input){
  const {target}=await resolveWithin(root,input,'existing')
  const info=await stat(target).catch(()=>{throw new Error('文件不存在')})
  if(!info.isFile())throw new Error('不是文件')
  if(info.size>FILE_READ_LIMIT)throw new Error(`文件超过读取上限（${Math.round(FILE_READ_LIMIT/1024/1024)} MB）`)
  const bytes=await readFile(target)
  return {path:String(input),size:bytes.length,data:bytes.toString('base64')}
}

export async function writeHostFile(root,input){
  const bytes=Buffer.from(String(input?.data??''),'base64')
  if(!bytes.length)throw new Error('文件内容为空')
  if(bytes.length>FILE_WRITE_LIMIT)throw new Error(`内容超过写入上限（${Math.round(FILE_WRITE_LIMIT/1024/1024)} MB）`)
  if(bytes.toString('base64')!==String(input?.data??''))throw new Error('文件内容必须是 base64')
  const {target}=await resolveWithin(root,input?.path,'write')
  await mkdir(join(target,'..'),{recursive:true})
  await writeFile(target,bytes,{mode:0o600})
  return {path:String(input?.path),size:bytes.length}
}

/** Receive a brokered copy: verify bytes, stage beside the destination, then
 *  commit atomically. An older client rejects the new op instead of clobbering. */
export async function receiveHostFile(root,input){
  if(typeof input?.data!=='string'||input.data.length>14*1024*1024)throw new Error('传输文件内容无效或超过 10 MiB')
  if(typeof input?.overwrite!=='boolean')throw new Error('传输覆盖选项无效')
  const bytes=Buffer.from(input.data,'base64')
  if(bytes.length>FILE_WRITE_LIMIT||bytes.toString('base64')!==input.data)throw new Error('传输文件内容无效或超过 10 MiB')
  const sha256=createHash('sha256').update(bytes).digest('hex')
  if(input.sha256!==sha256)throw new Error('传输文件校验失败，未写入目标文件')
  const {target}=await resolveWithin(root,input.path,'write')
  await mkdir(join(target,'..'),{recursive:true})
  const temporary=join(target,'..','.yaoyao-transfer-'+randomUUID())
  const handle=await open(temporary,'wx+',0o600)
  try{
    await handle.writeFile(bytes);await handle.sync()
    const stored=Buffer.alloc(bytes.length);let offset=0
    while(offset<stored.length){const {bytesRead}=await handle.read(stored,offset,stored.length-offset,offset);if(!bytesRead)break;offset+=bytesRead}
    if(offset!==bytes.length||createHash('sha256').update(stored).digest('hex')!==sha256)throw new Error('目标文件写入校验失败')
    await resolveWithin(root,input.path,'write')
    if(input.overwrite)await rename(temporary,target)
    else await link(temporary,target).catch(error=>{if(error.code==='EEXIST')throw new Error('目标文件已存在，未覆盖；只有用户要求覆盖时才设置 overwrite=true');throw error})
    return {path:input.path,size:bytes.length,sha256}
  }finally{await handle.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
}

export async function execHostShell(root,input){
  const command=String(input?.command??'')
  if(!command.trim())throw new Error('命令为空')
  const timeout=Math.min(Math.max(Number(input?.timeoutMs)||60000,1000),SHELL_TIMEOUT_MAX)
  let cwd
  try{cwd=resolve(String(root),String(input?.cwd??'').replace(/^~\//,'').replace(/^~$/,''))}catch{cwd=String(root)}
  return new Promise(done=>{
    execFile('/bin/zsh',['-c',command],{cwd,timeout,killSignal:'SIGKILL',maxBuffer:1024*1024,env:{...process.env,TERM:'dumb'}},(error,stdout,stderr)=>{
      const clip=value=>Buffer.from(value??'','utf8').subarray(0,SHELL_OUTPUT_LIMIT).toString('utf8')
      done({command,exitCode:error?typeof error.code==='number'?error.code:1:0,timedOut:error?.killed===true&&error?.signal==='SIGKILL',stdout:clip(stdout),stderr:clip(stderr)})
    })
  })
}
