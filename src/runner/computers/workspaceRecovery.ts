import {readFile,writeFile,chmod,rename,rm,lstat,readdir,cp} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'
const uuid='[0-9a-f-]{36}'
export async function copyWorkspace(source:string,target:string){
  await cp(source,target,{recursive:true,dereference:false,verbatimSymlinks:true,filter:async path=>{const item=await lstat(path);return item.isFile()||item.isDirectory()||item.isSymbolicLink()}})
}
export async function replaceWorkspaceContents(source:string,target:string){
  const [original,item]=await Promise.all([lstat(source),lstat(target)])
  if(!original.isDirectory()||original.isSymbolicLink()||!item.isDirectory()||item.isSymbolicLink())throw new Error('恢复目录不安全')
  const names=await readdir(source)
  for(const name of await readdir(target))if(!names.includes(name))await rm(join(target,name),{recursive:true,force:true})
  for(const name of names){
    const from=join(source,name),to=join(target,name),entry=await lstat(from),existing=await lstat(to).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
    // Keep common directories, including /home/cua/workspace, which is a
    // nested mount point cached by Docker Desktop even between containers.
    if(entry.isDirectory()&&!entry.isSymbolicLink()&&existing?.isDirectory()&&!existing.isSymbolicLink())await replaceWorkspaceContents(from,to)
    else {if(existing)await rm(to,{recursive:true,force:true});await copyWorkspace(from,to)}
  }
  await chmod(target,original.mode&0o777)
}
/** These children are bind mounts too. macOS retains their inode associations
 * even after the container is removed, so keep each mount root in place. */
export async function replaceUserDataContents(source:string,target:string){
  const item=await lstat(target)
  if(!item.isDirectory()||item.isSymbolicLink())throw new Error('用户资料恢复目录不安全')
  const names=await readdir(source)
  for(const name of await readdir(target))if(!names.includes(name))await rm(join(target,name),{recursive:true,force:true})
  for(const name of names){
    const from=join(source,name),to=join(target,name),original=await lstat(from),existing=await lstat(to).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
    if(['home','root'].includes(name)&&existing){
      if(!original.isDirectory()||original.isSymbolicLink())throw new Error('用户资料备份目录不安全')
      await replaceWorkspaceContents(from,to)
    }else if(name==='machine-id'&&existing){
      if(!original.isFile()||!existing.isFile()||original.isSymbolicLink()||existing.isSymbolicLink())throw new Error('设备标识备份不安全')
      await chmod(to,0o600);await writeFile(to,await readFile(from));await chmod(to,0o444)
    }else{
      if(existing)await rm(to,{recursive:true,force:true})
      await copyWorkspace(from,to)
    }
  }
}
/** Keep the bind-mount root inode stable on macOS shared filesystems. */
export async function recoverWorkspace(base:string,id:string){
  z.string().uuid().parse(id)
  const journal=join(base,`.restore-${id}.json`)
  let value:unknown
  try{value=JSON.parse(await readFile(journal,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
  const previousName=z.string().regex(new RegExp(`^\\.before-restore-${id}-${uuid}$`)),stagingName=z.string().regex(new RegExp(`^\\.restore-${uuid}$`))
  const record=z.object({protocol:z.literal(1),mode:z.literal('copy').optional(),staging:stagingName,previous:previousName,userData:z.object({previous:previousName.nullable(),staging:stagingName}).optional()}).strict().parse(value)
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
  if(record.userData){
    const dataBase=join(base,'..','computer-userdata'),data=join(dataBase,id)
    if(record.userData.previous===null)await rm(data,{recursive:true,force:true})
    else{
      const original=join(dataBase,record.userData.previous)
      if(!await exists(original))throw new Error('恢复日志中的原用户资料缺失，需要手动核对')
      if(await exists(data))await replaceUserDataContents(original,data)
      else await copyWorkspace(original,data)
    }
    await rm(join(dataBase,record.userData.staging),{recursive:true,force:true})
  }
  await rm(staging,{recursive:true,force:true});await rm(journal)
}
