import {Client,type SFTPWrapper} from 'ssh2'
import {createHash,timingSafeEqual} from 'node:crypto'
import type {IsolationGate,CredentialExecutionReceipt} from './executor.js'
import type {VaultEntry,LeaseInput} from './schema.js'
import {HttpError} from '../errors.js'
const call=<T>(start:(done:(error:Error|undefined|null,value:T)=>void)=>void)=>new Promise<T>((resolve,reject)=>start((error,value)=>error?reject(error):resolve(value)))
/** Key-only, pinned-host SSH. No shell session, command interpolation, PTY,
 * environment, agent forwarding, ProxyCommand, jump host or TCP forwarding. */
export class SshSftpExecutor {
  constructor(private gate:IsolationGate){}
  async execute(entry:Readonly<VaultEntry>,input:LeaseInput,externalSignal:AbortSignal):Promise<CredentialExecutionReceipt>{
    this.gate.assert();externalSignal.throwIfAborted()
    const plan=entry.usage
    if(entry.target.kind!=='ssh'||input.target.kind!=='ssh'||JSON.stringify(entry.target)!==JSON.stringify(input.target)||!plan||plan.kind==='website.form'||plan.kind!==input.operation)
      return {status:'manual_takeover_required',reason:'usage_policy_required',submitted:false}
    const host=entry.target,expected=Buffer.from(host.hostKey.slice(7),'base64')
    if(expected.length!==32)throw new HttpError(403,'SSH host key 指纹无效','vault_host_key_rejected')
    const signal=AbortSignal.any([externalSignal,AbortSignal.timeout(15000)]),conn=new Client()
    let hostRejected=false,finished=false,fail!:(error:unknown)=>void,ready!:()=>void
    const failure=new Promise<never>((_r,reject)=>{fail=reject}),connected=new Promise<void>(resolve=>{ready=resolve})
    // connect() can synchronously reject a malformed key before work is created.
    // Keep close/error rejection observed on that path as well.
    void failure.catch(()=>{})
    const invoke=<T>(start:(done:(error:Error|undefined|null,value:T)=>void)=>void)=>Promise.race([call(start),failure])
    const abort=()=>{fail(new Error('operation cancelled'));conn.destroy()}
    signal.addEventListener('abort',abort,{once:true})
    conn.on('error',()=>fail(hostRejected?new HttpError(403,'SSH host key 与人工批准指纹不符','vault_host_key_rejected'):new Error('SSH connection unavailable')))
    conn.on('close',()=>{if(!finished)fail(new Error('SSH receipt unavailable'))})
    conn.once('ready',ready)
    const check=()=>{signal.throwIfAborted();this.gate.assert()}
    try{
      conn.connect({host:host.host.replace(/^\[|\]$/g,''),port:host.port,username:entry.username,privateKey:entry.secret,...(entry.passphrase?{passphrase:entry.passphrase}:{}),
        authHandler:['publickey'],tryKeyboard:false,agentForward:false,readyTimeout:5000,keepaliveInterval:0,
        algorithms:{serverHostKey:['ssh-ed25519','rsa-sha2-512','rsa-sha2-256','ecdsa-sha2-nistp256']},
        hostVerifier:(key:Buffer)=>{const digest=createHash('sha256').update(key).digest();const match=timingSafeEqual(digest,expected);hostRejected=!match;return match}})
      const work=(async()=>{
        await Promise.race([connected,failure]);check()
        if(plan.kind==='ssh.exec'){
          // Exactly the user-approved absolute executable; no arguments or
          // strings assembled from model input are ever sent to the server.
          const stream=await invoke<import('ssh2').ClientChannel>(done=>conn.exec(plan.command,{pty:false},done))
          check();let output=0
          const discard=(data:Buffer)=>{output+=data.length;if(output>65536)abort()}
          stream.on('data',discard);stream.stderr.on('data',discard);stream.on('error',()=>fail(new Error('SSH command interrupted')))
          const code=await new Promise<number>((resolve,reject)=>{stream.once('close',(value:number|undefined)=>Number.isInteger(value)?resolve(value!):reject(new Error('SSH exit receipt unavailable')));stream.end()})
          check();return {status:'complete',operation:'ssh.exec',exitCode:code} as CredentialExecutionReceipt
        }
        const sftp=await invoke<SFTPWrapper>(done=>conn.sftp(done));sftp.on('error',()=>fail(new Error('SFTP interrupted')))
        check()
        if(plan.kind==='sftp.read'){
          const canonical=await invoke<string>(done=>sftp.realpath(plan.remotePath,done));check()
          if(canonical!==plan.remotePath)throw new HttpError(403,'SFTP 读取目标不是批准的准确路径','vault_usage_forbidden')
          const handle=await invoke<Buffer>(done=>sftp.open(plan.remotePath,'r',done));check()
          try{
            const stat=await invoke<import('ssh2').Stats>(done=>sftp.fstat(handle,done));check()
            if(!stat.isFile()||stat.size>plan.maxBytes)throw new HttpError(403,'SFTP 读取文件超出授权类型或大小','vault_usage_forbidden')
            const digest=createHash('sha256'),buffer=Buffer.alloc(16384);let bytes=0
            try{
              while(true){check();const count=await invoke<number>(done=>sftp.read(handle,buffer,0,Math.min(buffer.length,plan.maxBytes+1-bytes),bytes,(error,count)=>done(error,count)));check();if(!count)break;bytes+=count;if(bytes>plan.maxBytes)throw new Error('SFTP size limit');digest.update(buffer.subarray(0,count))}
              return {status:'complete',operation:'sftp.read',bytes,sha256:digest.digest('hex')} as CredentialExecutionReceipt
            }finally{buffer.fill(0)}
          }finally{await invoke<void>(done=>sftp.close(handle,error=>done(error,undefined))).catch(()=>{})}
        }
        const slash=plan.remotePath.lastIndexOf('/'),parent=plan.remotePath.slice(0,slash)||'/'
        const canonical=await invoke<string>(done=>sftp.realpath(parent,done));check()
        if(canonical!==parent)throw new HttpError(403,'SFTP 写入目录不是批准的准确路径','vault_usage_forbidden')
        if(Buffer.byteLength(plan.contents,'utf8')>65536)throw new HttpError(403,'SFTP 写入超过授权大小','vault_usage_forbidden')
        const data=Buffer.from(plan.contents,'utf8');let handle:Buffer|undefined
        try{
          // Exclusive creation: never overwrite or follow an existing final link.
          handle=await invoke<Buffer>(done=>sftp.open(plan.remotePath,'wx',{mode:0o600},done));check()
          for(let offset=0;offset<data.length;offset+=16384){check();await invoke<void>(done=>sftp.write(handle!,data,offset,Math.min(16384,data.length-offset),offset,error=>done(error,undefined)));check()}
          await invoke<void>(done=>sftp.close(handle!,error=>done(error,undefined)));check()
          handle=undefined
          return {status:'complete',operation:'sftp.write',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')} as CredentialExecutionReceipt
        }finally{data.fill(0);if(handle)await invoke<void>(done=>sftp.close(handle!,error=>done(error,undefined))).catch(()=>{})} // Interrupted writes may leave a partial file: never retry or overwrite automatically.
      })()
      const result=await Promise.race([work,failure]);finished=true;return result
    }finally{
      signal.removeEventListener('abort',abort);conn.destroy()
    }
  }
}
