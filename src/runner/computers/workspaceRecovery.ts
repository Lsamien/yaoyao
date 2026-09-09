import {readFile,rename,rm,lstat,readdir,cp} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'
const uuid='[0-9a-f-]{36}'
export async function copyWorkspace(source:string,target:string){
  await cp(source,target,{recursive:true,dereference:false,verbatimSymlinks:true,filter:async path=>{const item=await lstat(path);return item.isFile()||item.isDirectory()||item.isSymbolicLink()}})
}
export async function replaceWorkspaceContents(source:string,target:string){
  const item=await lstat(target)
  if(!item.isDirectory()||item.isSymbolicLink())throw new Error('恢复目录不安全')
  for(const name of await readdir(target))await rm(join(target,name),{recursive:true,force:true})
  await copyWorkspace(source,target)
}
/** Keep the bind-mount root inode stable on macOS shared filesystems. */
export async function recoverWorkspace(base:string,id:string){
  z.string().uuid().parse(id)
  const journal=join(base,`.restore-${id}.json`)
  let value:unknown
  try{value=JSON.parse(await readFile(journal,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  const record=z.object({protocol:z.literal(1),mode:z.literal('copy').optional(),staging:z.string().regex(new RegExp(`^\\.restore-${uuid}$`)),previous:z.string().regex(new RegExp(`^\\.before-restore-${id}-${uuid}$`))}).strict().parse(value)
  const workspace=join(base,id),previous=join(base,record.previous),staging=join(base,record.staging)
  const exists=async(path:string)=>{try{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('恢复目录不安全');return true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}}
  if(record.mode==='copy'){
    if(!await exists(previous))throw new Error('恢复日志中的原工作区缺失，需要手动核对')
    if(await exists(workspace))await replaceWorkspaceContents(previous,workspace)
    else await copyWorkspace(previous,workspace)
  }else if(!await exists(workspace)){
    if(!await exists(previous))throw new Error('恢复日志中的原工作区缺失，需要手动核对')
    await rename(previous,workspace)
  }
  await rm(staging,{recursive:true,force:true});await rm(journal)
}
