import {mkdir,lstat,readFile,writeFile,rm,realpath} from 'node:fs/promises'
import {join,resolve,dirname,basename} from 'node:path'
import {randomUUID} from 'node:crypto'
import {snapshotSchema,inventory,createSnapshot} from './dataSnapshot.js'
import {recoverWorkspace,copyWorkspace,replaceWorkspaceContents,replaceUserDataContents} from './workspaceRecovery.js'
import type {ComputerPool} from './pool.js'
import type {ContainerComputerProvider,ComputerSpecification} from './container.js'
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
  async backup(spec:ComputerSpecification,destination:string){
    return createSnapshot(spec,await this.stopped(spec),join(this.home,'computer-userdata',spec.id),destination)
  }
  async restore(spec:ComputerSpecification,snapshot:string){
    const workspace=await this.stopped(spec),source=resolve(snapshot),manifest=snapshotSchema.parse(JSON.parse(await readFile(join(source,'snapshot.json'),'utf8')))
    if(manifest.ownerKey!==spec.ownerKey||manifest.environmentId!==spec.id)throw new Error('备份不属于当前电脑及账号')
    const sourceWorkspace=join(source,'workspace')
    if((await lstat(sourceWorkspace)).isSymbolicLink())throw new Error('备份工作区不能是符号链接')
    if(JSON.stringify(await inventory(sourceWorkspace))!==JSON.stringify(manifest.files))throw new Error('备份内容校验失败，未替换工作区')
    const sourceData=join(source,'userdata'),dataBase=join(this.home,'computer-userdata'),data=join(dataBase,spec.id)
    if(manifest.userDataFiles){
      const item=await lstat(sourceData)
      if(!item.isDirectory()||item.isSymbolicLink()||JSON.stringify(await inventory(sourceData))!==JSON.stringify(manifest.userDataFiles))throw new Error('用户资料备份校验失败')
    }
    const staging=join(dirname(workspace),`.restore-${randomUUID()}`),previous=join(dirname(workspace),`.before-restore-${spec.id}-${randomUUID()}`)
    const dataStaging=join(dataBase,`.restore-${randomUUID()}`),dataPrevious=join(dataBase,`.before-restore-${spec.id}-${randomUUID()}`)
    let hadData=false
    try{
      await copyWorkspace(sourceWorkspace,staging)
      if(JSON.stringify(await inventory(staging))!==JSON.stringify(manifest.files))throw new Error('恢复暂存校验失败')
      await copyWorkspace(workspace,previous)
      if(JSON.stringify(await inventory(previous))!==JSON.stringify(await inventory(workspace)))throw new Error('恢复前数据备份校验失败')
      if(manifest.userDataFiles){
        await mkdir(dataBase,{recursive:true,mode:0o700})
        await copyWorkspace(sourceData,dataStaging)
        if(JSON.stringify(await inventory(dataStaging))!==JSON.stringify(manifest.userDataFiles))throw new Error('用户资料恢复暂存校验失败')
        const existing=await lstat(data).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
        hadData=!!existing
        if(existing){
          if(!existing.isDirectory()||existing.isSymbolicLink())throw new Error('用户资料目录不安全')
          await copyWorkspace(data,dataPrevious)
          if(JSON.stringify(await inventory(dataPrevious))!==JSON.stringify(await inventory(data)))throw new Error('恢复前用户资料备份校验失败')
        }
      }
      const journal=join(dirname(workspace),`.restore-${spec.id}.json`)
      await writeFile(journal,JSON.stringify({protocol:1,mode:'copy',staging:basename(staging),previous:basename(previous),...(manifest.userDataFiles?{userData:{previous:hadData?basename(dataPrevious):null,staging:basename(dataStaging)}}:{})}),{flag:'wx',mode:0o600})
      try{
        await replaceWorkspaceContents(staging,workspace)
        if(manifest.userDataFiles){if(hadData)await replaceUserDataContents(dataStaging,data);else await copyWorkspace(dataStaging,data)}
      }catch(error){await recoverWorkspace(dirname(workspace),spec.id);throw error}
      await rm(journal)
      return {restored:workspace,previousWorkspace:previous,imageId:spec.imageId,userDataRestored:!!manifest.userDataFiles,...(hadData?{previousUserData:dataPrevious}:{})}
    }finally{await rm(staging,{recursive:true,force:true});await rm(dataStaging,{recursive:true,force:true})}
  }
  async rebuild(spec:ComputerSpecification){const workspace=await this.stopped(spec);return {workspace,rebuildOnNextStart:true,imageId:spec.imageId}}
}
