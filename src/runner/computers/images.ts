import {createHash,randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir,mkdtemp,readFile,writeFile,rename,rm,stat} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {z} from 'zod'
import {ContainerComputerProvider} from './container.js'
import type {LocalVmImageKey} from '../../shared/localVm.js'
import {LOCAL_VM_IMAGE_KEYS} from '../../shared/localVm.js'

const imageId=z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const imageManifest=z.object({protocol:z.literal(1),imageId,architecture:z.enum(['amd64','arm64']),driver:z.literal('0.20.0'),layer:z.literal('5'),imageKey:z.enum(LOCAL_VM_IMAGE_KEYS).optional(),createdAt:z.number().int().nonnegative(),archiveSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()
export type ComputerImageManifest=z.infer<typeof imageManifest>
export async function fileSHA256(path:string){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex')}
export async function writeManifest(path:string,manifest:ComputerImageManifest){
  const validated=imageManifest.parse(manifest),temporary=path+'.'+randomUUID()
  await mkdir(dirname(path),{recursive:true,mode:0o700})
  try{await writeFile(temporary,JSON.stringify(validated,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path)}finally{await rm(temporary,{force:true})}
}
export type ImageCommand=(runtime:'docker'|'podman',args:string[])=>Promise<string>
const command:ImageCommand=(runtime,args)=>new Promise((resolveResult,reject)=>{
  const child=spawn(runtime,args,{stdio:['ignore','pipe','pipe']}),output:Buffer[]=[];let bytes=0,error:Error|undefined
  const timer=setTimeout(()=>{error=new Error('镜像操作超时，请核对运行时后重试');child.kill()},15*60*1000)
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes<=4*1024*1024)output.push(chunk);else{error=new Error('镜像输出过大');child.kill()}})
  child.stderr.on('data',chunk=>process.stderr.write(chunk))
  child.once('error',cause=>{error=cause})
  child.once('close',code=>{clearTimeout(timer);if(error||code!==0)reject(error??new Error(`镜像操作失败（${code}）`));else resolveResult(Buffer.concat(output).toString())})
})
/** Image operations never rewrite a running environment or a Runner configuration. */
export class ComputerImages {
  constructor(readonly runtime:'docker'|'podman',readonly run:ImageCommand=command){}
  async inspect(id:string):Promise<ComputerImageManifest>{
    imageId.parse(id)
    const image=JSON.parse(await this.run(this.runtime,['image','inspect',id]))[0]
    if(image?.Id!==id||image.Os!=='linux'||image.Config?.Labels?.['com.openmausbot.cua-driver']!=='0.20.0'||image.Config?.Labels?.['com.openmausbot.image-layer']!=='5')throw new Error('镜像身份或电脑驱动不兼容')
    return imageManifest.parse({protocol:1,imageId:id,architecture:image.Architecture,driver:'0.20.0',layer:'5',imageKey:image.Config.Labels['cn.samien.yaoyao.image-key']??'standard',createdAt:Date.now()})
  }
  async prepare(recipe:string,key:LocalVmImageKey='standard'):Promise<ComputerImageManifest>{
    const tag=`localhost/yaoyao/computer:prepare-${randomUUID()}`
    await this.run(this.runtime,['build','--pull=false',...(key==='cursor'?['--platform','linux/amd64','--file',join(resolve(recipe),'Dockerfile.cursor')]:[]),'--tag',tag,resolve(recipe)])
    const id=JSON.parse(await this.run(this.runtime,['image','inspect',tag]))[0]?.Id
    const manifest=await this.inspect(id)
    await this.verify(manifest)
    return manifest
  }
  async verify(manifest:ComputerImageManifest){
    const home=await mkdtemp(join(tmpdir(),'yaoyao-image-check-')),provider=new ContainerComputerProvider(this.runtime,randomUUID(),home)
    const spec={id:randomUUID(),ownerKey:'image-verification',imageId:manifest.imageId}
    let stopped=false
    try{
      await provider.ensure(spec,()=>{})
      const deadline=Date.now()+60000
      while(true){
        try{await provider.health(spec,()=>{});await provider.capture(spec,()=>{});break}
        catch(error){if(Date.now()>=deadline)throw new Error('镜像已构建，但电脑驱动未在 60 秒内就绪：'+String((error as {stderr?:string}).stderr??error).slice(0,2000));await new Promise(resolve=>setTimeout(resolve,500))}
      }
    }
    finally{try{await provider.remove(spec);stopped=true}finally{if(stopped)await rm(home,{recursive:true,force:true})}}
  }
  async export(id:string,archive:string){
    const manifest=await this.inspect(id),temporary=archive+'.'+randomUUID()
    // Exclusive reservation avoids overwriting a user archive on a repeated command.
    await writeFile(archive,'',{flag:'wx',mode:0o600})
    try{await this.run(this.runtime,['save','--output',temporary,id]);await rename(temporary,archive);manifest.archiveSha256=await fileSHA256(archive);await writeManifest(archive+'.json',manifest);return manifest}
    catch(error){await rm(archive,{force:true});throw error}finally{await rm(temporary,{force:true})}
  }
  async import(archive:string){
    const manifest=imageManifest.parse(JSON.parse(await readFile(archive+'.json','utf8')))
    if(!manifest.archiveSha256||(await stat(archive)).size>20*1024**3||await fileSHA256(archive)!==manifest.archiveSha256)throw new Error('镜像归档校验失败，未导入')
    await this.run(this.runtime,['load','--input',archive])
    const actual=await this.inspect(manifest.imageId)
    if(actual.architecture!==manifest.architecture)throw new Error('镜像架构与清单不一致')
    await this.verify(actual);return actual
  }
}
