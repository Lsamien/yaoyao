import {mkdir,readdir,lstat,readlink,writeFile,rm} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {z} from 'zod'
import {copyWorkspace} from './workspaceRecovery.js'
import type {ComputerSpecification} from './container.js'
async function fileSHA256(path:string){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex')}
const filesSchema=z.array(z.object({path:z.string(),kind:z.enum(['file','directory','symlink']),sha256:z.string().optional(),target:z.string().optional()}))
export const snapshotSchema=z.object({protocol:z.union([z.literal(1),z.literal(2)]),environmentId:z.string().uuid(),ownerKey:z.string(),imageId:z.string(),createdAt:z.number(),files:filesSchema,userDataFiles:filesSchema.optional()}).strict()
type Snapshot=z.infer<typeof snapshotSchema>
export async function inventory(root:string):Promise<Snapshot['files']>{
    const files:Snapshot['files']=[];let bytes=0
    const visit=async(directory:string)=>{
      for(const name of (await readdir(directory)).sort()){
        const path=join(directory,name),item=await lstat(path),key=relative(root,path)
        if(files.length>=200000)throw new Error('工作区文件数量超过备份上限')
        if(item.isSymbolicLink())files.push({path:key,kind:'symlink',target:await readlink(path)})
        else if(item.isDirectory()){files.push({path:key,kind:'directory'});await visit(path)}
        else if(item.isFile()){bytes+=item.size;if(bytes>20*1024**3)throw new Error('工作区超过 20 GiB 备份上限');files.push({path:key,kind:'file',sha256:await fileSHA256(path)})}
        // Runtime sockets are intentionally omitted; applications recreate them.
      }
    }
    await visit(root);return files
  }
export async function createSnapshot(spec:ComputerSpecification,source:string,userData:string,destination:string){
    const target=resolve(destination)
    const hasData=await lstat(userData).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
    if(hasData&&(!hasData.isDirectory()||hasData.isSymbolicLink()))throw new Error('用户资料目录不安全')
    if([source,userData].some(path=>target===resolve(path)||target.startsWith(resolve(path)+'/')))throw new Error('备份必须放在电脑工作区和用户资料之外')
    // Reserve the destination. Never overwrite an earlier snapshot.
    await mkdir(target,{mode:0o700})
    try{
      const files=await inventory(source),userDataFiles=hasData?await inventory(userData):undefined
      await copyWorkspace(source,join(target,'workspace'))
      if(hasData)await copyWorkspace(userData,join(target,'userdata'))
      if(JSON.stringify(await inventory(join(target,'workspace')))!==JSON.stringify(files)||hasData&&JSON.stringify(await inventory(join(target,'userdata')))!==JSON.stringify(userDataFiles))throw new Error('备份复制校验失败，未发布快照')
      const manifest:Snapshot={protocol:2,environmentId:spec.id,ownerKey:spec.ownerKey,imageId:spec.imageId,createdAt:Date.now(),files,...(userDataFiles?{userDataFiles}:{})}
      await writeFile(join(target,'snapshot.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
      return {snapshot:target,files:manifest.files.length}
    }catch(error){await rm(target,{recursive:true,force:true});throw error}
  }
