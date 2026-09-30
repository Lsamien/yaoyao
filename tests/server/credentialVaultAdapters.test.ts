// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {websiteFixture,sshFixture} from '../fixtures/credentialProtocols'
import {ProtectedCredentialExecutor} from '../../src/server/credentialVault/protectedExecutor'
import {OperatorIsolationGate} from '../../src/server/credentialVault/isolation'
import {parse,entryInput,type VaultEntry,type LeaseInput} from '../../src/server/credentialVault/schema'
const homes:string[]=[],cleanup:(()=>Promise<void>)[]=[]
const gate={assert(){}} // Dummy wiring validates protocols, never OS isolation.
function home(){const h=mkdtempSync(join(tmpdir(),'yaoyao-vault-adapters-'));homes.push(h);return h}
function entry(value:unknown):VaultEntry{return {...parse(entryInput,value),id:randomUUID(),revision:1,updatedAt:Date.now()}}
function input(e:VaultEntry,operation:LeaseInput['operation']):LeaseInput{return {credentialRef:e.id,agentId:randomUUID(),workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:'dummy',target:e.target,operation,seconds:60}}
afterEach(async()=>{for(const close of cleanup.splice(0))await close();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true})})
it('a protected standard form authenticates, verifies the marker, logs out and returns no secret/session/browser output',async()=>{
  const h=home(),site=await websiteFixture(h);cleanup.push(site.close)
  const e=entry({name:'dummy',username:site.username,secret:site.secret,target:{kind:'website',origin:site.origin},usage:site.usage})
  const executor=new ProtectedCredentialExecutor(join(h,'browser'),gate,site.cert)
  expect(await executor.execute(e,input(e,'website.login'),new AbortController().signal)).toEqual({status:'complete',operation:'website.login'})
  expect(site.state).toMatchObject({logins:1,proofs:1,logouts:1})
  // Fresh context cannot reuse the previous session.
  expect(await executor.execute(e,input(e,'website.login'),new AbortController().signal)).toEqual({status:'complete',operation:'website.login'})
  expect(site.state).toMatchObject({logins:2,proofs:2,logouts:2})
},20000)
it.each(['action','iframe','redirect'] as const)('rejects unapproved website %s and never exports a session',async cause=>{
  const h=home(),site=await websiteFixture(h);cleanup.push(site.close)
  if(cause==='action')site.state.formAction='https://127.0.0.1:1/steal'
  if(cause==='iframe')site.state.iframe=true
  if(cause==='redirect')site.state.redirect='https://127.0.0.1:1/steal'
  const e=entry({name:'dummy',username:site.username,secret:site.secret,target:{kind:'website',origin:site.origin},usage:site.usage})
  const result=await new ProtectedCredentialExecutor(join(h,'browser'),gate,site.cert).execute(e,input(e,'website.login'),new AbortController().signal)
  expect(result).toMatchObject({status:'manual_takeover_required',reason:'unsupported_form_flow'})
  expect(site.state.logins).toBe(cause==='redirect'?1:0);expect(site.state.proofs).toBe(0)
  expect(JSON.stringify(result)).not.toContain(site.secret)
},15000)
it('cancelling a submitted website login closes its private context and leaves an unknown result without retry/logout',async()=>{
  const h=home(),site=await websiteFixture(h);cleanup.push(site.close);site.state.delay=true
  const e=entry({name:'dummy',username:site.username,secret:site.secret,target:{kind:'website',origin:site.origin},usage:site.usage}),controller=new AbortController()
  const run=new ProtectedCredentialExecutor(join(h,'browser'),gate,site.cert).execute(e,input(e,'website.login'),controller.signal),result=expect(run).rejects.toThrow()
  await vi.waitFor(()=>expect(site.state.logins).toBe(1));controller.abort();await result
  expect(site.state.logins).toBe(1);expect(site.state.logouts).toBe(0)
},15000)
it('uses pinned public-key SSH, a fixed executable and bounded exact SFTP paths; receipts omit stdout and file contents',async()=>{
  const h=home(),ssh=await sshFixture();cleanup.push(ssh.close);const executor=new ProtectedCredentialExecutor(join(h,'executor'),gate)
  const base={name:'dummy',username:ssh.username,secret:ssh.secret,target:ssh.target}
  const command=entry({...base,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
  expect(await executor.execute(command,input(command,'ssh.exec'),new AbortController().signal)).toEqual({status:'complete',operation:'ssh.exec',exitCode:0})
  expect(ssh.state.commands).toEqual(['/usr/bin/uptime'])
  const read=entry({...base,usage:{kind:'sftp.read',remotePath:'/approved/input.txt',maxBytes:64}}),original=ssh.files.get('/approved/input.txt')!
  expect(await executor.execute(read,input(read,'sftp.read'),new AbortController().signal)).toEqual({status:'complete',operation:'sftp.read',bytes:original.length,sha256:createHash('sha256').update(original).digest('hex')})
  const write=entry({...base,usage:{kind:'sftp.write',remotePath:'/approved/output.txt',contents:'DUMMY-fixed-encrypted-transfer-body'}})
  const receipt=await executor.execute(write,input(write,'sftp.write'),new AbortController().signal)
  expect(receipt).toMatchObject({status:'complete',operation:'sftp.write',bytes:Buffer.byteLength('DUMMY-fixed-encrypted-transfer-body')});expect(JSON.stringify(receipt)).not.toContain('DUMMY')
  expect(ssh.files.get('/approved/output.txt')?.toString()).toBe('DUMMY-fixed-encrypted-transfer-body')
  expect(ssh.state.opens.at(-1)).toMatchObject({flags:58,mode:0o600})
  await expect(executor.execute(write,input(write,'sftp.write'),new AbortController().signal)).rejects.toThrow() // Never overwrite.
},15000)
it('rejects an unknown SSH host key before authentication, symlink targets and oversized files',async()=>{
  const h=home(),ssh=await sshFixture();cleanup.push(ssh.close);const executor=new ProtectedCredentialExecutor(join(h,'executor'),gate)
  const base={name:'dummy',username:ssh.username,secret:ssh.secret,target:ssh.target},e=entry({...base,target:{...ssh.target,hostKey:'SHA256:'+'A'.repeat(43)},usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
  await expect(executor.execute(e,input(e,'ssh.exec'),new AbortController().signal)).rejects.toMatchObject({code:'vault_host_key_rejected'});expect(ssh.state.auths).toBe(0)
  const read=entry({...base,usage:{kind:'sftp.read',remotePath:'/approved/input.txt',maxBytes:1}})
  await expect(executor.execute(read,input(read,'sftp.read'),new AbortController().signal)).rejects.toMatchObject({code:'vault_usage_forbidden'})
  ssh.state.readRedirect=true
  await expect(executor.execute(read,input(read,'sftp.read'),new AbortController().signal)).rejects.toMatchObject({code:'vault_usage_forbidden'})
  expect(ssh.state.opens).toHaveLength(1)
},15000)
it('a malformed private key produces a rejected operation without unhandled connection errors',async()=>{
  const h=home(),ssh=await sshFixture();cleanup.push(ssh.close)
  const e=entry({name:'dummy',username:ssh.username,secret:'DUMMY-not-a-private-key',target:ssh.target,usage:{kind:'ssh.exec',command:'/usr/bin/uptime'}})
  await expect(new ProtectedCredentialExecutor(join(h,'executor'),gate).execute(e,input(e,'ssh.exec'),new AbortController().signal)).rejects.toThrow()
  expect(ssh.state.auths).toBe(0)
})
it('cancelling SFTP during a lost write acknowledgement terminates promptly and leaves the partial result for manual inspection',async()=>{
  const h=home(),ssh=await sshFixture();cleanup.push(ssh.close);ssh.state.delayWrite=true
  const e=entry({name:'dummy',username:ssh.username,secret:ssh.secret,target:ssh.target,usage:{kind:'sftp.write',remotePath:'/approved/partial.txt',contents:'DUMMY-only'}}),controller=new AbortController()
  const run=new ProtectedCredentialExecutor(join(h,'executor'),gate).execute(e,input(e,'sftp.write'),controller.signal),result=expect(run).rejects.toThrow()
  await vi.waitFor(()=>expect(ssh.state.writes).toBe(1));controller.abort();await result
  expect(ssh.files.get('/approved/partial.txt')?.toString()).toBe('DUMMY-only');expect(ssh.state.writes).toBe(1)
},10000)
it('requires private, unexpired operator approval and the actual distinct Hermes process identity; revocation cannot downgrade',()=>{
  const h=home(),path=join(h,'approval.json'),uid=process.getuid!(),now=Date.now()
  const approval={version:1,approved:true,brokerUid:uid,hermesUid:uid+1,hermesPid:123,approvedAt:now,expiresAt:now+60000,controls:['separate-identity','hermes-no-control-access','browser-private-no-cdp','restricted-egress']}
  const save=(v:unknown)=>writeFileSync(path,JSON.stringify(v),{mode:0o600}),check=()=>new OperatorIsolationGate(path,uid+1,123,()=>uid+1,()=>now).assert()
  expect(check).toThrowError(expect.objectContaining({code:'vault_isolation_required'}));save(approval);expect(check).not.toThrow()
  expect(()=>new OperatorIsolationGate(path,uid+1,123,()=>uid,()=>now).assert()).toThrow()
  save({...approval,expiresAt:now});expect(check).toThrow();save(approval);chmodSync(path,0o644);expect(check).toThrow()
  chmodSync(path,0o600);save({...approval,approved:false});expect(check).toThrow()
})
