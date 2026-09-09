import {mkdir,readdir,lstat,readlink,readFile,writeFile,rm,realpath} from 'node:fs/promises'
import {join,resolve,dirname,relative,basename} from 'node:path'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'
import {fileSHA256} from './images.js'
import {recoverWorkspace,copyWorkspace,replaceWorkspaceContents} from './workspaceRecovery.js'
import type {ComputerPool} from './pool.js'
import type {ContainerComputerProvider,ComputerSpecification} from './container.js'
const schema=z.object({protocol:z.literal(1),environmentId:z.string().uuid(),ownerKey:z.string(),imageId:z.string(),createdAt:z.number(),files:z.array(z.object({path:z.string(),kind:z.enum(['file','directory','symlink']),sha256:z.string().optional(),target:z.string().optional()}))}).strict()
type Snapshot=z.infer<typeof schema>
/** Offline maintenance: caller holds the exact Runner OS lock throughout. */
export class ComputerMaintenance {
  constructor(readonly pool:ComputerPool,readonly provider:ContainerComputerProvider,readonly home:string){}
  private async stopped(spec:ComputerSpecification){
    const row=this.pool.status(spec.ownerKey).find(row=>row.environmentId===spec.id)
    if(!row||row.status!=='free')throw new Error('电脑停止状态未确认，不能维护工作区')
    await this.provider.remove(spec)
    const base=join(this.home,'computer-workspaces'),path=join(base,spec.id)
    await recoverWorkspace(base,spec.id)
    const [root,detail]=await Promise.all([realpath(base),lstat(path)])
    if(!detail.isDirectory()||detail.isSymbolicLink()||await realpath(path)!==join(root,spec.id))throw new Error('电脑工作区路径不安全')
    return path
  }
  private async inventory(root:string):Promise<Snapshot['files']>{
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
  async backup(spec:ComputerSpecification,destination:string){
    const source=await this.stopped(spec),target=resolve(destination)
    if(target===resolve(source)||target.startsWith(resolve(source)+'/'))throw new Error('备份必须放在电脑工作区之外')
    // Reserve the destination. Never overwrite an earlier snapshot.
    await mkdir(target,{mode:0o700})
    try{
      await copyWorkspace(source,join(target,'workspace'))
      const manifest:Snapshot={protocol:1,environmentId:spec.id,ownerKey:spec.ownerKey,imageId:spec.imageId,createdAt:Date.now(),files:await this.inventory(join(target,'workspace'))}
      await writeFile(join(target,'snapshot.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
      return {snapshot:target,files:manifest.files.length}
    }catch(error){await rm(target,{recursive:true,force:true});throw error}
  }
  async restore(spec:ComputerSpecification,snapshot:string){
    const workspace=await this.stopped(spec),source=resolve(snapshot),manifest=schema.parse(JSON.parse(await readFile(join(source,'snapshot.json'),'utf8')))
    if(manifest.ownerKey!==spec.ownerKey||manifest.environmentId!==spec.id)throw new Error('备份不属于当前电脑及账号')
    const sourceWorkspace=join(source,'workspace')
    if((await lstat(sourceWorkspace)).isSymbolicLink())throw new Error('备份工作区不能是符号链接')
    if(JSON.stringify(await this.inventory(sourceWorkspace))!==JSON.stringify(manifest.files))throw new Error('备份内容校验失败，未替换工作区')
    const staging=join(dirname(workspace),`.restore-${randomUUID()}`),previous=join(dirname(workspace),`.before-restore-${spec.id}-${randomUUID()}`)
    try{
      await copyWorkspace(sourceWorkspace,staging)
      if(JSON.stringify(await this.inventory(staging))!==JSON.stringify(manifest.files))throw new Error('恢复暂存校验失败')
      await copyWorkspace(workspace,previous)
      if(JSON.stringify(await this.inventory(previous))!==JSON.stringify(await this.inventory(workspace)))throw new Error('恢复前数据备份校验失败')
      const journal=join(dirname(workspace),`.restore-${spec.id}.json`)
      await writeFile(journal,JSON.stringify({protocol:1,mode:'copy',staging:basename(staging),previous:basename(previous)}),{flag:'wx',mode:0o600})
      try{await replaceWorkspaceContents(staging,workspace)}catch(error){await recoverWorkspace(dirname(workspace),spec.id);throw error}
      await rm(journal)
      return {restored:workspace,previousWorkspace:previous,imageId:spec.imageId}
    }finally{await rm(staging,{recursive:true,force:true})}
  }
  async rebuild(spec:ComputerSpecification){const workspace=await this.stopped(spec);return {workspace,rebuildOnNextStart:true,imageId:spec.imageId}}
}
