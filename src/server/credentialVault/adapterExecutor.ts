import {mkdirSync,lstatSync} from 'node:fs'
import type {CredentialExecutor,IsolationGate} from './executor.js'
import type {VaultEntry,LeaseInput} from './schema.js'
import {WebsiteFormExecutor} from './websiteExecutor.js'
import {SshSftpExecutor,probeSshHostKey} from './sshExecutor.js'

/** Shared bounded protocols. The boot path determines the deployment boundary. */
export abstract class CredentialAdapterExecutor implements CredentialExecutor {
  abstract readonly mode:'protected-adapters'|'local-adapters'
  private website:WebsiteFormExecutor
  private ssh:SshSftpExecutor
  constructor(home:string,private gate:IsolationGate,testCA?:Buffer){
    gate.assert();mkdirSync(home,{recursive:true,mode:0o700});const stat=lstatSync(home)
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw new Error('private executor home required')
    this.website=new WebsiteFormExecutor(home,gate,testCA);this.ssh=new SshSftpExecutor(gate)
  }
  assertAvailable(){this.gate.assert()}
  prepareSshHost(target:Extract<LeaseInput['target'],{kind:'ssh'}>,signal:AbortSignal){return probeSshHostKey(target,this.gate,signal)}
  executeAutonomous(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal){this.gate.assert();return this.ssh.executeAutonomous(entry,input,signal)}
  execute(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal){this.gate.assert();return entry.target.kind==='website'?this.website.execute(entry,input,signal):this.ssh.execute(entry,input,signal)}
}
