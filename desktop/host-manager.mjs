import {readFile,writeFile,rename,mkdir,rm,link} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {request as httpRequest} from 'node:http'
import {request as httpsRequest} from 'node:https'
import {parseDesktopHostConfiguration} from './host-config.mjs'

const FATAL = Symbol('desktop-host-fatal')

function checkExchangeStatus(status){
 if(status===401||status===403){const error=new Error('电脑授权已失效，请重新登录授权这台电脑');error[FATAL]=true;throw error}
 if(status===409){const error=new Error('电脑连接协议不兼容，请更新夭夭后重新授权');error[FATAL]=true;throw error}
 if(status!==200)throw new Error(`电脑未连接（HTTP ${status}）`)
}

async function fetchExchange(config,body,fetchImpl){
 const url=new URL(`/api/desktop-host/v1/${config.hostId}/exchange`,config.serverURL)
 if(!['http:','https:'].includes(url.protocol))throw new Error('夭夭服务地址无效')
 const signal=AbortSignal.timeout(10000)
 try{
  const response=await fetchImpl(url.href,{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal,
   headers:{Authorization:`Bearer ${config.token}`,'x-desktop-host-protocol':'1','content-type':'application/json'},body:JSON.stringify(body)})
  if(response.status!==200){await response.body?.cancel();checkExchangeStatus(response.status)}
  const reader=response.body?.getReader()
  if(!reader)throw new Error('电脑响应为空')
  let size=0;const chunks=[]
  try{
   while(true){
    const {done,value}=await reader.read()
    if(done)break
    size+=value.byteLength
    if(size>16*1024*1024){await reader.cancel();throw new Error('桌面命令超过限制')}
    chunks.push(value)
   }
  }finally{reader.releaseLock()}
  return JSON.parse(Buffer.concat(chunks).toString())
 }catch(error){if(signal.aborted)throw new Error('电脑连接超时');throw error}
}

export function remoteExchange(config,body,fetchImpl){
 if(fetchImpl)return fetchExchange(config,body,fetchImpl)
 return new Promise((resolve,reject)=>{
 const url=new URL(`/api/desktop-host/v1/${config.hostId}/exchange`,config.serverURL)
 if(!['http:','https:'].includes(url.protocol))return reject(new Error('夭夭服务地址无效'))
 const bytes=Buffer.from(JSON.stringify(body)),send=url.protocol==='https'?httpsRequest:httpRequest
 const req=send(url,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'x-desktop-host-protocol':'1','content-type':'application/json','content-length':bytes.length}},res=>{
  let size=0;const chunks=[]
  res.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024)res.destroy(new Error('桌面命令超过限制'));else chunks.push(chunk)})
  res.on('error',reject)
  res.on('end',()=>{try{
   checkExchangeStatus(res.statusCode)
   resolve(JSON.parse(Buffer.concat(chunks).toString()))
  }catch(error){reject(error)}})
 })
 req.on('error',reject)
 req.setTimeout(10000,()=>req.destroy(new Error('电脑连接超时')))
 req.end(bytes)
})}

/** Remote computer: imports an encrypted pairing config and exchanges
 *  commands with the paired server. Native-only; no browser IPC. */
export class DesktopHostManager {
 constructor(options){
  if(typeof options?.createCore!=='function')throw new Error('电脑需要命令执行核心')
  this.options=options
  this.path=join(options.home,'desktop-host.enc')
  this.createCore=options.createCore
  this.state='未配置电脑'
  this.core=undefined
  this.config=undefined
  this.timer=undefined
  this.backoff=400
  this.chain=Promise.resolve()
  this.generation=0
 }
 publish(message){this.state=message;this.options.onState?.(message)}
 async installIdentity(){
  const path=join(this.options.home,'desktop-install-id')
  const readIdentity=async()=>{
   const id=(await readFile(path,'utf8')).trim()
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('本机设备标识损坏，请恢复原设备标识后重试')
   return id
  }
  try{return await readIdentity()}catch(error){if(error.code!=='ENOENT')throw error}
  const id=randomUUID()
  await mkdir(this.options.home,{recursive:true,mode:0o700})
  const temporary=`${path}.${id}`
  try{
   // Publish a complete identity without overwriting a concurrent login's ID.
   await writeFile(temporary,id,{flag:'wx',mode:0o600})
   try{await link(temporary,path);return id}catch(error){if(error.code!=='EEXIST')throw error}
   return await readIdentity()
  }finally{await rm(temporary,{force:true})}
 }
 serial(work){const result=this.chain.catch(()=>{}).then(work);this.chain=result;return result}
 async read(){
  let encrypted
  try{encrypted=await readFile(this.path)}catch(error){if(error.code==='ENOENT')return;throw error}
  try{return parseDesktopHostConfiguration(JSON.parse(await this.options.decrypt(encrypted)))}
  catch{throw new Error('无法解锁电脑配置，请使用原系统账号或重新登录授权')}
 }
 importFile(path){
  const generation=++this.generation
  return this.serial(async()=>{
   let config
   try{config=parseDesktopHostConfiguration(JSON.parse(await readFile(path,'utf8')))}
   catch(error){throw error instanceof Error?error:new Error('电脑配置无效，请从夭夭重新下载配置')}
   await this.store(config,generation)
  })
 }
 /** Adopt a config obtained in-process (e.g. after a native remote login). */
 adopt(value){
  const generation=++this.generation
  return this.serial(async()=>{
   const config=parseDesktopHostConfiguration(value)
   await this.store(config,generation)
  })
 }
 async store(config,generation){
   // Encrypt before stopping a working host: failed Keychain access preserves it.
   if(generation!==this.generation)return
   const bytes=await this.options.encrypt(JSON.stringify(config))
   if(generation!==this.generation)return
   await this.stopLoop()
   if(generation!==this.generation)return
   await mkdir(this.options.home,{recursive:true,mode:0o700})
   const temporary=`${this.path}.${randomUUID()}`
   try{await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await rename(temporary,this.path)}
   finally{await rm(temporary,{force:true})}
   if(generation!==this.generation)return
   await this.startLoop(config)
 }
 start(){const generation=++this.generation;return this.serial(async()=>{const config=await this.read();if(generation!==this.generation)return;if(config)await this.startLoop(config)})}
 async startLoop(config){
  await this.stopLoop()
  this.config=config
  this.core=this.createCore({root:this.options.root,dataRoot:this.options.dataRoot})
  this.backoff=400
  this.publish(`电脑正在连接 ${new URL(config.serverURL).host}`)
  this.timer=setTimeout(()=>void this.cycle(),400)
  this.timer.unref?.()
 }
 async cycle(){
  const config=this.config,core=this.core
  if(!config||!core||this.core!==core)return
  try{
   await core.prepareInfo?.()
   if(this.config!==config||this.core!==core)return
   const value=await remoteExchange(config,{host:core.info(),results:core.takeResults()},this.options.fetchImpl)
   this.backoff=400
   if(this.config!==config||this.core!==core)return
   this.publish(process.platform==='win32'&&!(Array.isArray(value.capabilities?.desktopPlatforms)&&value.capabilities.desktopPlatforms.includes('win32'))
    ? '已连接；服务器尚不支持 Windows 电脑操作，请升级服务器（聊天可继续使用）'
    : `电脑已连接 ${new URL(config.serverURL).host}`)
   core.acceptCapabilities?.(value.capabilities)
   await core.handle(value.commands??[])
  }catch(error){
   if(this.config!==config||this.core!==core)return
   core.acceptCapabilities?.(undefined)
   if(error&&error[FATAL]){this.publish(error.message);await this.stopLoop();return}
   this.backoff=Math.min(this.backoff*2,5000)
   this.publish(`电脑连接中断，正在重试：${String(error.message).slice(0,120)}`)
  }finally{
   if(this.core===core){this.timer=setTimeout(()=>void this.cycle(),this.backoff);this.timer.unref?.()}
  }
 }
 async stopLoop(){
  clearTimeout(this.timer);this.timer=undefined
  const core=this.core
  this.core=undefined;this.config=undefined
  if(core)await core.close().catch(()=>{})
 }
 stop(){this.generation++;return this.serial(()=>this.stopLoop())}
 forget(){this.generation++;return this.serial(async()=>{await this.stopLoop();await rm(this.path,{force:true});this.publish('未配置电脑')})}
 revoke(){return this.serial(async()=>{await this.core?.revoke()})}
}
