import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {open} from 'node:fs/promises'
import {posix} from 'node:path'
import {lookup} from 'mime-types'
import type {BrowserUpload} from '../runner/browser/types.js'
import type {WorkspaceStore} from './workspaceStore.js'
import type {WorkspaceNodes} from './workspaceGateway.js'
import type {UploadStore} from './uploads.js'
import type {StoredWorkspaceFile} from './workspaceAssets.js'
import {FILE_TRANSFER_CHUNK_BYTES,type FileTransferEndpoint} from '../shared/fileTransfer.js'
import {copyBetweenEndpoints} from './fileTransfer.js'
import {HttpError} from './errors.js'

export async function browserOwnedFile(store:WorkspaceStore,nodes:WorkspaceNodes,uploads:UploadStore,owner:string,id:string):Promise<BrowserUpload>{
  const file=store.visibleFiles(owner).find(file=>file.id===id)??uploads.records([id],owner)[0]!
  if('sourceNodeId' in file&&(file as StoredWorkspaceFile).sourceNodeId&&'profile' in file)nodes.requireSource(owner,{nodeId:(file as StoredWorkspaceFile).sourceNodeId!,profile:String(file.profile)})
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
    const size=(await handle.stat()).size
    if(size>25*1024*1024)throw new HttpError(413,'上传文件不能超过25 MiB','browser_upload_limit')
    const buffer=Buffer.alloc(size+1);let offset=0
    while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead}
    if(offset!==size)throw new HttpError(409,'文件读取期间发生变化','browser_upload_changed')
    return {name:file.name,mimeType:file.mimeType,buffer:buffer.subarray(0,size)}
  }finally{await handle.close()}
}

/** Reuse the same checked, chunked transfer as desktop/VM copies. */
export async function browserVmFile(transfer:(action:Record<string,unknown>)=>Promise<any>,path:string,check:()=>void,file?:BrowserUpload,overwrite=false,maxBytes=25*1024*1024):Promise<BrowserUpload|unknown>{
  if(!posix.isAbsolute(path)||path.includes('\0'))throw new HttpError(400,'请选择虚拟机内的绝对路径','browser_vm_path_invalid')
  let bytes=file?.buffer??Buffer.alloc(0),expected=0,expectedHash='',received=0,complete=false
  const chunks:Buffer[]=[]
  const memory:FileTransferEndpoint={host:'browser',name:'托管浏览器',path:'/transfer',chunks:true,call:async action=>{
    check()
    if(action.op==='transfer-read-open')return {size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
    if(action.op==='transfer-read'){const offset=Number(action.offset);return {offset,data:bytes.subarray(offset,offset+FILE_TRANSFER_CHUNK_BYTES).toString('base64')}}
    if(action.op==='transfer-write-open'){expected=Number(action.size);expectedHash=String(action.sha256);if(!Number.isSafeInteger(expected)||expected<0||expected>maxBytes)throw new HttpError(413,'文件超过传输上限','browser_file_limit');return {ok:true}}
    if(action.op==='transfer-append'){const chunk=Buffer.from(String(action.data),'base64');if(action.offset!==received||received+chunk.length>expected)throw new HttpError(502,'文件分块无效','browser_file_invalid');chunks.push(chunk);received+=chunk.length;return {received}}
    if(action.op==='transfer-finish'){
      bytes=Buffer.concat(chunks)
      if(bytes.length!==expected||createHash('sha256').update(bytes).digest('hex')!==expectedHash)throw new HttpError(502,'文件校验失败','browser_file_invalid')
      complete=true;return {complete:true,path:'/transfer',size:expected,sha256:expectedHash}
    }
    if(action.op==='transfer-status')return {complete,path:'/transfer',size:expected,sha256:expectedHash}
    if(action.op==='transfer-abort')return {ok:true}
    throw new HttpError(400,'文件操作无效','browser_file_invalid')
  }}
  const vm:FileTransferEndpoint={host:'vm',name:'虚拟机',path,chunks:true,call:transfer}
  const result=await copyBetweenEndpoints(file?memory:vm,file?vm:memory,maxBytes,overwrite,check)
  return file?result:{name:posix.basename(path),mimeType:lookup(path)||'application/octet-stream',buffer:bytes}
}
