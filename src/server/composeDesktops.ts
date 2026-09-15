import {request} from 'node:http'
import {z} from 'zod'
import {HttpError} from './errors.js'
import type {ComposeDesktop,ComposeDesktopState} from '../shared/composeDesktops.js'
import {LOCAL_VM_IMAGE_KEYS} from '../shared/localVm.js'

export function parseComposeDesktops(value:string|undefined):ComposeDesktop[]{
  if(!value?.trim())return []
  let input:unknown
  try{input=JSON.parse(value)}catch{throw new Error('HERMES_YAOYAO_COMPOSE_DESKTOPS 必须为有效 JSON')}
  const parsed=z.array(z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(100),socketPath:z.string().regex(/^\/run\/yaoyao-desktops\/[a-z0-9_-]+\/desktop\.sock$/),imageKey:z.enum(LOCAL_VM_IMAGE_KEYS).optional()}).strict()).min(1).max(32).parse(input)
  if(new Set(parsed.map(x=>x.id)).size!==parsed.length||new Set(parsed.map(x=>x.socketPath)).size!==parsed.length)throw new Error('Compose 桌面 ID 和连接路径不能重复')
  return parsed
}

/** Only deployment-owned Unix sockets are addressable. No Docker daemon access. */
export class ComposeDesktops {
  constructor(readonly desktops:ComposeDesktop[]){}
  async call(id:string,operation:string,body:Record<string,unknown>={}):Promise<any>{
    const desktop=this.desktops.find(x=>x.id===id)
    if(!desktop)throw new HttpError(404,'该桌面不在 Compose 配置中','compose_desktop_missing')
    if(!['health','frame','acquire','renew','release','execute','skills-install'].includes(operation))throw new HttpError(409,'Compose 管理桌面数量和生命周期','compose_desktop_managed')
    return new Promise((resolve,reject)=>{
      const data=JSON.stringify({...body,desktopId:id}),req=request({socketPath:desktop.socketPath,path:`/${operation}`,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)},timeout:70000},res=>{
        const chunks:Buffer[]=[];let size=0
        res.on('data',chunk=>{size+=chunk.length;if(size>40*1024*1024)req.destroy(new Error('桌面回应过大'));else chunks.push(chunk)})
        res.on('end',()=>{try{if(res.headers['x-yaoyao-desktop-id']!==id)throw new HttpError(502,'Compose 桌面连接身份不匹配','compose_desktop_mismatch');const value=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw new HttpError(res.statusCode??502,value.error||'桌面操作失败',value.code||'compose_desktop_error');resolve(value)}catch(error){reject(error)}})
      })
      req.on('timeout',()=>req.destroy(new Error('桌面回应超时')))
      req.on('error',()=>reject(new HttpError(503,`无法连接「${desktop.name}」，请检查对应 Compose 桌面容器`,'compose_desktop_offline')))
      req.end(data)
    })
  }
  async status():Promise<ComposeDesktopState[]>{return Promise.all(this.desktops.map(async d=>{try{const state=await this.call(d.id,'health');if(state.id!==d.id||state.protocol!==1)throw new Error('身份不匹配');return {id:d.id,name:d.name,imageKey:d.imageKey,online:true,ready:state.ready===true}}catch{return {id:d.id,name:d.name,imageKey:d.imageKey,online:false,ready:false}}}))}
}
