import {mkdir,lstat,realpath,readFile,writeFile,rename,rm,chmod} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {realpathSync} from 'node:fs'
import type {ContainerCommand,ComputerSpecification} from './container.js'
import {createSnapshot} from './dataSnapshot.js'

export const COMPUTER_HOME='/home/cua'
const owner=(spec:ComputerSpecification)=>createHash('sha256').update(spec.ownerKey).digest('hex')

/** Private, environment-scoped application data. Never mount the host user's HOME. */
export class ComputerUserData {
  constructor(readonly home:string,readonly runtime:'docker'|'podman',readonly run:ContainerCommand){}
  path(id:string){return resolve(realpathSync(this.home),'computer-userdata',id)}
  async existing(spec:ComputerSpecification):Promise<string|undefined>{
    const path=this.path(spec.id)
    const stat=await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
    if(!stat){
      const required=await lstat(path+'.required').catch(error=>{if(error.code==='ENOENT')return undefined;throw error})
      if(required)throw new Error('电脑用户资料缺失，已停止自动重建；请恢复用户资料备份')
      return undefined
    }
    if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path)throw new Error('电脑用户资料目录不安全')
    const manifest=JSON.parse(await readFile(join(path,'identity.json'),'utf8'))
    if(manifest.protocol!==1||manifest.environmentId!==spec.id||manifest.owner!==owner(spec))throw new Error('电脑用户资料归属不匹配')
    for(const name of ['home','root','machine-id']){
      const item=await lstat(join(path,name))
      if(item.isSymbolicLink()||(name==='machine-id'?!item.isFile():!item.isDirectory()))throw new Error('电脑用户资料挂载路径不安全')
    }
    if(!/^[a-f0-9]{32}\n?$/.test(await readFile(join(path,'machine-id'),'utf8')))throw new Error('电脑设备标识无效')
    return path
  }
  async beforeImageChange(spec:ComputerSpecification,workspace:string){
    const path=await this.existing(spec)
    if(!path)throw new Error('电脑用户资料缺失')
    const manifest=JSON.parse(await readFile(join(path,'identity.json'),'utf8'))
    if(manifest.imageId===spec.imageId)return
    const base=resolve(realpathSync(this.home),'computer-backups',spec.id)
    await mkdir(base,{recursive:true,mode:0o700})
    if(await realpath(base)!==base)throw new Error('电脑备份目录不安全')
    // A different image may upgrade browser/app databases on its first boot.
    // Keep the old image's complete, verified data before allowing that boot.
    const snapshot=await createSnapshot({...spec,imageId:manifest.imageId??spec.imageId},workspace,path,join(base,`before-image-${Date.now()}-${randomUUID()}`))
    const temporary=join(path,`.identity-${randomUUID()}.json`)
    await writeFile(temporary,JSON.stringify({...manifest,imageId:spec.imageId,previousSnapshot:snapshot.snapshot})+'\n',{mode:0o600,flag:'wx'})
    await rename(temporary,join(path,'identity.json'))
  }
  mounts(path:string){return [
    {source:join(path,'home'),destination:COMPUTER_HOME,rw:true},
    {source:join(path,'root'),destination:'/root',rw:true},
    {source:join(path,'machine-id'),destination:'/etc/machine-id',rw:false},
    {source:join(path,'machine-id'),destination:'/var/lib/dbus/machine-id',rw:false},
  ]}
  /** The caller has stopped and verified the source. Publish only a complete copy. */
  async capture(spec:ComputerSpecification,containerId:string,legacy:boolean){
    const existing=await this.existing(spec)
    if(existing)return existing
    const base=resolve(realpathSync(this.home),'computer-userdata')
    await mkdir(base,{recursive:true,mode:0o700})
    if(await realpath(base)!==base)throw new Error('电脑用户资料父目录不安全')
    const staging=join(base,`.migrate-${spec.id}-${randomUUID()}`)
    await mkdir(staging,{mode:0o700})
    try{
      // cp also works for stopped containers. Do not follow guest symlinks or
      // expose file contents through the Runner command/output channel.
      for(const [guest,name] of [[COMPUTER_HOME,'home'],['/root','root']] as const){
        await mkdir(join(staging,name),{mode:0o700})
        await this.run(this.runtime,['cp',`${containerId}:${guest}/.`,join(staging,name)],{timeout:300000})
      }
      // The workspace has its own mount; never retain a second stale copy.
      await rm(join(staging,'home','workspace'),{recursive:true,force:true})
      await mkdir(join(staging,'home','workspace'),{mode:0o700})
      let identity:string|undefined
      if(legacy){
        for(const guest of ['/etc/machine-id','/var/lib/dbus/machine-id']){
          try{
            await this.run(this.runtime,['cp',`${containerId}:${guest}`,join(staging,'machine-id')],{timeout:15000})
            const item=await lstat(join(staging,'machine-id'))
            if(item.isFile()&&!item.isSymbolicLink()){
              const copied=await readFile(join(staging,'machine-id'),'utf8')
              if(/^[a-f0-9]{32}\n?$/.test(copied)){identity=copied;break}
            }
          }catch(error){if(!/could not find|no such file|does not exist/i.test(String((error as any).stderr??'')))throw error}
          await rm(join(staging,'machine-id'),{force:true})
        }
      }
      await writeFile(join(staging,'machine-id'),identity??randomBytes(16).toString('hex')+'\n',{mode:0o444})
      await chmod(join(staging,'machine-id'),0o444)
      await writeFile(join(staging,'identity.json'),JSON.stringify({protocol:1,environmentId:spec.id,owner:owner(spec),imageId:spec.imageId,sourceContainer:containerId,createdAt:Date.now()})+'\n',{mode:0o600,flag:'wx'})
      await rename(staging,this.path(spec.id))
      await writeFile(this.path(spec.id)+'.required',JSON.stringify({environmentId:spec.id,owner:owner(spec)})+'\n',{mode:0o600,flag:'wx'})
      return (await this.existing(spec))!
    }catch{
      // Runtime errors can contain private filenames. Fail closed and retain the
      // old container; no empty profile may silently replace an existing login.
      throw new Error('电脑用户资料迁移失败，原容器已保留；请检查磁盘空间及容器运行时后重试')
    }finally{await rm(staging,{recursive:true,force:true})}
  }
}
