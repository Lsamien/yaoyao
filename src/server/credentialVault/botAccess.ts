import sodium from 'libsodium-wrappers-sumo'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, lstatSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HttpError } from '../errors.js'
import { parse, storedEntry, type VaultEntry } from './schema.js'
import { readPrivateUtf8 } from './privateFiles.js'
import type { CredentialBotReference, CredentialBotGrantSummary } from '../../shared/credentialVault.js'

const record = z.object({ owner:z.string().min(1).max(256), agentId:z.string().uuid(), entry:storedEntry }).strict()
  .refine(r=>r.entry.target.kind==='ssh'||!!r.entry.usage)
const envelope = z.object({ nonce:z.string(), ciphertext:z.string() }).strict()
const encode = (v:Uint8Array) => sodium.to_base64(v,sodium.base64_variants.ORIGINAL)
const decode = (v:string) => sodium.from_base64(v,sodium.base64_variants.ORIGINAL)

/** Local server authority, deliberately independent of the master-password
 * management session. Same-UID protection is the existing local-server trust
 * boundary; private execution material stays encrypted and never enters tools. */
export class BotCredentialAccess {
  private key:Uint8Array
  private active = new Map<AbortController,{owner:string;credentialRef:string;agentId:string}>()
  constructor(private root:string) {
    mkdirSync(root,{recursive:true,mode:0o700})
    const s=lstatSync(root)
    if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.())throw new Error('private Bot access directory required')
    const keyPath=join(root,'execution.key')
    if(!existsSync(keyPath)){this.write(keyPath,encode(sodium.randombytes_buf(32)));this.sync()}
    this.key=decode(readPrivateUtf8(keyPath,128))
    if(this.key.length!==32)throw new Error('invalid Bot access key')
  }
  private write(path:string,value:string){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,value);fsyncSync(fd)}finally{closeSync(fd)}}
  private sync(){const fd=openSync(this.root,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
  private path(owner:string,agentId:string,id:string){return join(this.root,createHash('sha256').update(JSON.stringify([owner,agentId,id])).digest('hex')+'.access')}
  private read(path:string){
    const e=parse(envelope,JSON.parse(readPrivateUtf8(path,256*1024)))
    const bytes=sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null,decode(e.ciphertext),'yaoyao-bot-access-v1',decode(e.nonce),this.key)
    try{return parse(record,JSON.parse(sodium.to_string(bytes)))}finally{sodium.memzero(bytes)}
  }
  private records(owner:string){return readdirSync(this.root).filter(n=>n.endsWith('.access')).map(n=>({path:join(this.root,n),value:this.read(join(this.root,n))})).filter(r=>r.value.owner===owner)}
  summaries(owner:string,agentId?:string):Array<CredentialBotGrantSummary&CredentialBotReference>{return this.records(owner).filter(r=>!agentId||r.value.agentId===agentId).map(({value:{entry,agentId}})=>({
    credentialRef:entry.id,agentId,name:entry.name,operation:entry.target.kind==='ssh'?'ssh.exec' as const:entry.usage!.kind==='website.form'?'website.login' as const:entry.usage!.kind,
    allowedTarget:entry.target,allowedUse:entry.target.kind==='ssh'?{kind:'ssh.exec' as const,mode:'unrestricted' as const}:entry.usage!.kind==='sftp.write'?{kind:entry.usage!.kind,remotePath:entry.usage!.remotePath,bytes:Buffer.byteLength(entry.usage!.contents)}:entry.usage!,authorized:true,
  }))}
  grant(owner:string,agentId:string,entry:Readonly<VaultEntry>){
    if(entry.target.kind!=='ssh'&&!entry.usage)throw new HttpError(403,'请先配置网站使用计划','vault_usage_forbidden')
    const value=parse(record,{owner,agentId,entry})
    const existing=this.path(owner,agentId,entry.id)
    if(existsSync(existing)){
      const old=this.read(existing).entry
      if(old.revision===entry.revision&&old.target.kind==='ssh'&&value.entry.target.kind==='ssh'&&!value.entry.target.hostKey
        &&old.target.host===value.entry.target.host&&old.target.port===value.entry.target.port)value.entry.target.hostKey=old.target.hostKey
    }
    if(!existsSync(this.path(owner,agentId,entry.id))&&this.records(owner).length>=1024)throw new HttpError(413,'Bot 授权数量已达到上限','vault_bot_grant_limit')
    this.save(value)
    this.abort(owner,entry.id,agentId)
  }
  private save(value:z.infer<typeof record>){
    const {owner,agentId,entry}=value
    const bytes=sodium.from_string(JSON.stringify(value)),nonce=sodium.randombytes_buf(24)
    const path=this.path(owner,agentId,entry.id),temp=path+'.'+randomUUID()
    try{
      const ciphertext=sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes,'yaoyao-bot-access-v1',null,nonce,this.key)
      this.write(temp,JSON.stringify({nonce:encode(nonce),ciphertext:encode(ciphertext)}))
      renameSync(temp,path);this.sync()
    }catch(error){rmSync(path,{force:true});this.abort(owner,entry.id,agentId);throw error}
    finally{sodium.memzero(bytes);rmSync(temp,{force:true})}
  }
  refresh(owner:string,entry:Readonly<VaultEntry>,preservePin:boolean){
    try{for(const r of this.records(owner).filter(r=>r.value.entry.id===entry.id)){
      const previous=r.value.entry.target
      const target=preservePin&&entry.target.kind==='ssh'&&previous.kind==='ssh'&&previous.hostKey
        ? {...entry.target,hostKey:previous.hostKey}:entry.target
      this.grant(owner,r.value.agentId,{...entry,target})
    }}catch(error){this.revoke(owner,entry.id);throw error}
  }
  pinSshHost(owner:string,agentId:string,id:string,revision:number,hostKey:string){
    const path=this.path(owner,agentId,id)
    if(!existsSync(path))throw new HttpError(403,'此 Bot 授权已撤销','vault_bot_forbidden')
    const value=this.read(path)
    if(value.entry.revision!==revision||value.entry.target.kind!=='ssh')throw new HttpError(409,'凭据已修改，请重新查询引用','vault_revision_conflict')
    if(!value.entry.target.hostKey){value.entry.target.hostKey=hostKey;this.save(value)}
    return value.entry
  }
  private abort(owner:string,id:string,agentId?:string){for(const [c,b] of this.active)if(b.owner===owner&&b.credentialRef===id&&(!agentId||b.agentId===agentId))c.abort()}
  revoke(owner:string,id:string,agentId?:string){
    this.abort(owner,id,agentId)
    for(const r of this.records(owner))if(r.value.entry.id===id&&(!agentId||r.value.agentId===agentId))rmSync(r.path)
    this.sync()
  }
  async execute<T>(owner:string,agentId:string,id:string,signal:AbortSignal,use:(entry:Readonly<VaultEntry>,signal:AbortSignal)=>Promise<T>){
    const path=this.path(owner,agentId,id)
    if(!existsSync(path))throw new HttpError(403,'此 Bot 尚未获准使用该凭据','vault_bot_forbidden')
    const value=this.read(path)
    if(value.owner!==owner||value.agentId!==agentId||value.entry.id!==id)throw new HttpError(403,'凭据授权范围不匹配','vault_scope_forbidden')
    const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal])
    this.active.set(controller,{owner,credentialRef:id,agentId})
    try{combined.throwIfAborted();const result=await use(value.entry,combined);combined.throwIfAborted();return result}
    finally{this.active.delete(controller)}
  }
  close(){for(const c of this.active.keys())c.abort();this.active.clear();sodium.memzero(this.key)}
}
