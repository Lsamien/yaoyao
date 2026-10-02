import {Client,type SFTPWrapper,type ServerHostKeyAlgorithm} from 'ssh2'
import {createHash,timingSafeEqual} from 'node:crypto'
import {StringDecoder} from 'node:string_decoder'
import type {IsolationGate,CredentialExecutionReceipt} from './executor.js'
import {parse,sshCommand,sshTimeout,type VaultEntry,type LeaseInput} from './schema.js'
import {HttpError} from '../errors.js'
const call=<T>(start:(done:(error:Error|undefined|null,value:T)=>void)=>void)=>new Promise<T>((resolve,reject)=>start((error,value)=>error?reject(error):resolve(value)))
const serverHostKey:ServerHostKeyAlgorithm[]=['ssh-ed25519','rsa-sha2-512','rsa-sha2-256','ecdsa-sha2-nistp256']
/** First-use discovery stops at key exchange. It never supplies credentials or authenticates. */
export async function probeSshHostKey(host:Extract<LeaseInput['target'],{kind:'ssh'}>,gate:IsolationGate,externalSignal:AbortSignal):Promise<string>{
  gate.assert();externalSignal.throwIfAborted()
  const conn=new Client(),signal=AbortSignal.any([externalSignal,AbortSignal.timeout(5000)])
  let abort!:()=>void
  try{
    return await new Promise<string>((resolve,reject)=>{
      let settled=false
      const fail=()=>{if(!settled){settled=true;reject(new HttpError(503,'无法连接 SSH 服务器，密码已保存，请检查地址和端口','vault_host_probe_failed'))}}
      abort=()=>{fail();conn.destroy()};signal.addEventListener('abort',abort,{once:true})
      conn.on('error',fail);conn.on('close',fail)
      conn.connect({host:host.host.replace(/^\[|\]$/g,''),port:host.port,username:'host-key-probe',authHandler:[],tryKeyboard:false,readyTimeout:5000,
        algorithms:{serverHostKey},hostVerifier:(key:Buffer)=>{
          try{signal.throwIfAborted();gate.assert();if(!settled){settled=true;resolve('SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,''))}}
          catch{fail()}
          return false // Reject before authentication even when discovery succeeded.
        }})
    })
  }finally{signal.removeEventListener('abort',abort);conn.destroy()}
}
/** Pinned SSH authentication. Autonomous commands are enabled only by trusted
 * Bot approval; credentials, forwarding and a local shell are never exposed. */
export class SshSftpExecutor {
  constructor(private gate:IsolationGate){}
  executeAutonomous(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal){
    if(input.operation!=='ssh.exec'||entry.target.kind!=='ssh')throw new HttpError(403,'此凭据不支持自主 SSH 运维','vault_usage_forbidden')
    const command=parse(sshCommand,input.command??(entry.usage?.kind==='ssh.exec'?entry.usage.command:undefined)),timeout=parse(sshTimeout,input.timeoutSeconds??60)
    return this.run({...entry,usage:{kind:'ssh.exec',command}},{...input,operation:'ssh.exec'},signal,{timeout})
  }
  execute(entry:Readonly<VaultEntry>,input:LeaseInput,externalSignal:AbortSignal){
    if(input.command!==undefined||input.timeoutSeconds!==undefined)throw new HttpError(403,'请先将 SSH 凭据授权给指定 Bot','vault_usage_forbidden')
    return this.run(entry,input,externalSignal)
  }
  private async run(entry:Readonly<VaultEntry>,input:LeaseInput,externalSignal:AbortSignal,autonomous?:{timeout:number}):Promise<CredentialExecutionReceipt>{
    this.gate.assert();externalSignal.throwIfAborted()
    const plan=entry.usage
    if(entry.target.kind!=='ssh'||input.target.kind!=='ssh'||JSON.stringify(entry.target)!==JSON.stringify(input.target)||!plan||plan.kind==='website.form'||plan.kind!==input.operation)
      return {status:'manual_takeover_required',reason:'usage_policy_required',submitted:false}
    const host=entry.target
    if(!host.hostKey)throw new HttpError(403,'首次使用前需要确认 SSH 服务器','vault_host_key_required')
    const expected=Buffer.from(host.hostKey.slice(7),'base64')
    if(expected.length!==32)throw new HttpError(403,'SSH host key 指纹无效','vault_host_key_rejected')
    const signal=AbortSignal.any([externalSignal,AbortSignal.timeout(autonomous?autonomous.timeout*1000:15000)]),conn=new Client()
    let hostRejected=false,finished=false,fail!:(error:unknown)=>void,ready!:()=>void
    const failure=new Promise<never>((_r,reject)=>{fail=reject}),connected=new Promise<void>(resolve=>{ready=resolve})
    // connect() can synchronously reject a malformed key before work is created.
    // Keep close/error rejection observed on that path as well.
    void failure.catch(()=>{})
    const invoke=<T>(start:(done:(error:Error|undefined|null,value:T)=>void)=>void)=>Promise.race([call(start),failure])
    const abort=()=>{fail(new Error('operation cancelled'));conn.destroy()}
    signal.addEventListener('abort',abort,{once:true})
    conn.on('error',()=>fail(hostRejected?new HttpError(403,'SSH 服务器指纹已改变，已停止连接','vault_host_key_rejected'):new Error('SSH connection unavailable')))
    conn.on('close',()=>{if(!finished)fail(new Error('SSH receipt unavailable'))})
    conn.once('ready',ready)
    const check=()=>{signal.throwIfAborted();this.gate.assert()}
    try{
      conn.connect({host:host.host.replace(/^\[|\]$/g,''),port:host.port,username:entry.username,
        ...(host.auth === 'password' ? {password:entry.secret} : {privateKey:entry.secret,...(entry.passphrase?{passphrase:entry.passphrase}:{})}),
        authHandler:[host.auth === 'password' ? 'password' : 'publickey'],tryKeyboard:false,agentForward:false,readyTimeout:5000,keepaliveInterval:0,
        algorithms:{serverHostKey},
        hostVerifier:(key:Buffer)=>{const digest=createHash('sha256').update(key).digest();const match=timingSafeEqual(digest,expected);hostRejected=!match;return match}})
      const work=(async():Promise<CredentialExecutionReceipt>=>{
        await Promise.race([connected,failure]);check()
        if(plan.kind==='ssh.exec'){
          // Autonomous commands run on the approved remote SSH account, never
          // through a local shell. Restricted approval still uses its fixed plan.
          const stream=await invoke<import('ssh2').ClientChannel>(done=>conn.exec(plan.command,{pty:false},done))
          check();let output=0,truncated=false
          const stdout:Buffer[]=[],stderr:Buffer[]=[],limit=65536
          const privateValues=[entry.secret,entry.passphrase].filter((s):s is string=>!!s).map(s=>s.replace(/\r\n/g,'\n'))
          if(entry.target.kind==='ssh'&&entry.target.auth!=='password')privateValues.push(...entry.secret.split(/\r?\n/).filter(s=>s.length>=8))
          const retainedLimit=limit+Math.max(...privateValues.map(s=>Buffer.byteLength(s)))
          let outBytes=0,errBytes=0
          const capture=(chunks:Buffer[],data:Buffer,bytes:number)=>{const available=Math.max(0,retainedLimit-bytes);if(available<data.length)truncated=true;if(available)chunks.push(Buffer.from(data.subarray(0,available)));return bytes+Math.min(data.length,available)}
          const discard=(data:Buffer)=>{output+=data.length;if(output>limit)abort()}
          stream.on('data',(data:Buffer)=>{if(autonomous)outBytes=capture(stdout,data,outBytes);else discard(data)})
          stream.stderr.on('data',(data:Buffer)=>{if(autonomous)errBytes=capture(stderr,data,errBytes);else discard(data)})
          stream.on('error',()=>fail(new Error('SSH command interrupted')))
          const code=await new Promise<number>((resolve,reject)=>{stream.once('close',(value:number|undefined)=>Number.isInteger(value)?resolve(value!):reject(new Error('SSH exit receipt unavailable')));stream.end()})
          check()
          if(autonomous){
            const sanitize=(chunks:Buffer[])=>{
              let text=Buffer.concat(chunks).toString('utf8').replace(/\r\n/g,'\n')
              for(const value of privateValues){
                // The retained buffer may end partway through a credential.
                for(let n=truncated?Math.min(value.length-1,text.length):0;n>0;n--)if(text.endsWith(value.slice(0,n))){text=text.slice(0,-n)+'[REDACTED]';break}
                text=text.split(value).join('[REDACTED]')
              }
              return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
            }
            try{
              const out=Buffer.from(sanitize(stdout)),err=Buffer.from(sanitize(stderr)),outSize=Math.min(out.length,limit),errSize=Math.min(err.length,limit-outSize)
              truncated ||=outSize<out.length||errSize<err.length
              return {status:'complete',operation:'ssh.exec',exitCode:code,stdout:new StringDecoder('utf8').write(out.subarray(0,outSize)),stderr:new StringDecoder('utf8').write(err.subarray(0,errSize)),truncated}
            }finally{for(const b of [...stdout,...stderr])b.fill(0)}
          }
          return {status:'complete',operation:'ssh.exec',exitCode:code}
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
