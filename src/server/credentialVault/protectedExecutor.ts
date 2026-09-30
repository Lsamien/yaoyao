import {mkdirSync,lstatSync} from 'node:fs'
import type {CredentialExecutor,IsolationGate} from './executor.js'
import type {VaultEntry,LeaseInput} from './schema.js'
import {WebsiteFormExecutor} from './websiteExecutor.js'
import {SshSftpExecutor} from './sshExecutor.js'
export class ProtectedCredentialExecutor implements CredentialExecutor {
  readonly mode='protected-adapters' as const
  private website:WebsiteFormExecutor
  private ssh:SshSftpExecutor
  constructor(home:string,private gate:IsolationGate,testCA?:Buffer){
    gate.assert();mkdirSync(home,{recursive:true,mode:0o700});const stat=lstatSync(home)
    if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw new Error('private executor home required')
    this.website=new WebsiteFormExecutor(home,gate,testCA);this.ssh=new SshSftpExecutor(gate)
  }
  assertAvailable(){this.gate.assert()}
  execute(entry:Readonly<VaultEntry>,input:LeaseInput,signal:AbortSignal){this.gate.assert();return entry.target.kind==='website'?this.website.execute(entry,input,signal):this.ssh.execute(entry,input,signal)}
}
