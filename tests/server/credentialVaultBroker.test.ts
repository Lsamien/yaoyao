// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CredentialVaultStore } from '../../src/server/credentialVault/store'
import { CredentialVaultBroker, type CredentialExecutorFixture } from '../../src/server/credentialVault/broker'
import type { LeaseInput } from '../../src/server/credentialVault/schema'
const homes:string[]=[], brokers:CredentialVaultBroker[]=[]
const owner='dummy-owner', session='a'.repeat(64), otherSession='b'.repeat(64), password='dummy-master-password', secret='DUMMY-CREDENTIAL-NEVER-REAL'
async function fixture(executor?:CredentialExecutorFixture){
  const home=mkdtempSync(join(tmpdir(),'yaoyao-vault-broker-'));homes.push(home)
  let now=Date.now();const store=await CredentialVaultStore.create(home,()=>now),broker=new CredentialVaultBroker(store,()=>now,executor);brokers.push(broker)
  let epoch=randomUUID();broker.hello(epoch)
  const dispatch=(command:string,value?:unknown,s=session,o=owner)=>broker.dispatch(epoch,o,s,command,value) as any
  dispatch('initialize',{password});dispatch('unlock',{password})
  const entry=dispatch('add',{name:'dummy-site',username:'dummy-username',target:{kind:'website',origin:'https://example.test'},secret})
  const input:LeaseInput={credentialRef:entry.id,agentId:randomUUID(),workId:randomUUID(),runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:'dummy-runner-epoch',operation:'website.login',target:entry.target,seconds:60}
  return {home,store,broker,dispatch,entry,input,grant:()=>dispatch('grant',input),execute:(id:string,b=input,o=owner,s=session)=>broker.execute(epoch,o,s,id,b),advance:(ms:number)=>{now+=ms},reconnect:()=>{epoch=randomUUID();broker.hello(epoch)}}
}
afterEach(()=>{brokers.splice(0).forEach(b=>b.close());homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true}))})
it('production has no execution adapter or read-secret RPC, even after user unlock and grant',async()=>{
  const f=await fixture(),lease=f.grant()
  await expect(f.execute(lease.id)).rejects.toMatchObject({code:'vault_executor_not_enabled'})
  expect(()=>f.dispatch('read-secret',{id:f.entry.id})).toThrowError(expect.objectContaining({code:'vault_command_unknown'}))
  const state=f.dispatch('status');expect(JSON.stringify(state)).not.toContain(secret)
  expect(state.execution).toBe('disabled');expect(f.dispatch('status',{},otherSession).entries).toEqual([])
})
it('binds a lease to owner, Bot, task, exact target, operation and Runner incarnation',async()=>{
  const execute=vi.fn(async()=>{}),f=await fixture({execute}),lease=f.grant()
  for(const patch of [{agentId:randomUUID()},{workId:randomUUID()},{runnerId:randomUUID()},{runnerInstance:randomUUID()},{runnerEpoch:'new-epoch'},{operation:'ssh.exec' as const},{target:{kind:'website' as const,origin:'https://other.test'}}])
    await expect(f.execute(lease.id,{...f.input,...patch})).rejects.toMatchObject({code:'vault_scope_forbidden'})
  await expect(f.execute(lease.id,f.input,'other-owner')).rejects.toMatchObject({code:'vault_lease_revoked'})
  await expect(f.execute(lease.id,f.input,owner,otherSession)).rejects.toMatchObject({code:'vault_scope_forbidden'})
  expect(()=>f.dispatch('grant',{...f.input,target:{kind:'website',origin:'http://example.test'}})).toThrowError(expect.objectContaining({code:'vault_invalid_request'}))
  expect(()=>f.dispatch('grant',{...f.input,target:{kind:'website',origin:'https://other.test'}})).toThrowError(expect.objectContaining({code:'vault_target_forbidden'}))
  expect(execute).not.toHaveBeenCalled()
  expect(await f.execute(lease.id)).toEqual({status:'complete',operation:'website.login'})
  await expect(f.execute(lease.id)).rejects.toMatchObject({code:'vault_lease_revoked'})
  expect(execute).toHaveBeenCalledOnce()
})
it('binds SSH grants to a pinned host key and port and rejects plaintext FTP',async()=>{
  const f=await fixture({execute:async()=>{}}),target={kind:'ssh',host:'ssh.example.test',port:22,hostKey:'SHA256:'+'A'.repeat(43)}
  const entry=f.dispatch('add',{name:'dummy-ssh',username:'dummy',target,secret:'DUMMY-PRIVATE-KEY'})
  const input={...f.input,credentialRef:entry.id,target,operation:'sftp.read',seconds:60} as LeaseInput
  const l=f.dispatch('grant',input)
  await expect(f.execute(l.id,{...input,target:{...input.target,port:2222} as any})).rejects.toMatchObject({code:'vault_scope_forbidden'})
  expect(()=>f.dispatch('grant',{...input,operation:'ftp.login'})).toThrowError(expect.objectContaining({code:'vault_invalid_request'}))
  expect(()=>f.dispatch('grant',{...input,target:{...target,hostKey:'SHA256:'+'B'.repeat(43)}})).toThrowError(expect.objectContaining({code:'vault_target_forbidden'}))
})
it.each(['lock','logout','revoke','cancel','reconnect','update','remove','expiry'] as const)('aborts an in-flight dummy executor on %s, hides errors and prevents retry',async cause=>{
  let release!:()=>void,signal:AbortSignal|undefined
  const started=Promise.withResolvers<void>(),f=await fixture({execute:async(entry,_input,s)=>{expect(entry.secret).toBe(secret);signal=s;started.resolve();await new Promise<void>(r=>{release=r})}}),lease=f.grant()
  const run=f.execute(lease.id),result=expect(run).rejects.toMatchObject({code:'vault_operation_uncertain'})
  await started.promise
  await expect(f.execute(lease.id)).rejects.toMatchObject({code:'vault_operation_uncertain'})
  if(cause==='lock'||cause==='logout')f.dispatch(cause)
  if(cause==='revoke')f.dispatch('revoke',{id:lease.id})
  if(cause==='cancel')f.dispatch('revoke-work',{workId:f.input.workId})
  if(cause==='reconnect')f.reconnect()
  if(cause==='update')f.dispatch('update',{id:f.entry.id,entry:{name:'new-name',username:'dummy',target:f.entry.target,revision:1}})
  if(cause==='remove')f.dispatch('remove',{id:f.entry.id})
  if(cause==='expiry'){f.advance(300000);f.dispatch('status')}
  expect(signal?.aborted).toBe(true);release();await result
  await expect(f.execute(lease.id)).rejects.toMatchObject({code:'vault_lease_revoked'})
  const audit=readFileSync(join(f.home,'audit.jsonl'),'utf8')
  for(const privateValue of [secret,password,'dummy-username','https://example.test'])expect(audit).not.toContain(privateValue)
  expect(audit).toContain('not-confirmed')
})
it('logout from another login cannot lock the session that unlocked the vault',async()=>{
  const f=await fixture();f.grant();f.dispatch('logout',{},otherSession)
  expect(f.dispatch('status').unlocked).toBe(true);f.dispatch('logout');expect(f.dispatch('status').unlocked).toBe(false)
})
it('refuses symlink audit sinks and leaves their destination unchanged',async()=>{
  const f=await fixture(),path=join(f.home,'audit.jsonl'),destination=join(f.home,'dummy-destination')
  writeFileSync(destination,'unchanged');rmSync(path);symlinkSync(destination,path)
  expect(()=>f.dispatch('backup')).toThrow();expect(readFileSync(destination,'utf8')).toBe('unchanged')
})
it.each([undefined,{status:'complete',operation:'website.login',secret},{status:'complete',operation:'ssh.exec'}])('never treats missing, raw or scope-mismatched protected receipts as success',async receipt=>{
  const f=await fixture({mode:'protected-adapters',execute:async()=>receipt as any}),lease=f.grant()
  await expect(f.execute(lease.id)).rejects.toMatchObject({code:'vault_operation_uncertain'})
  expect(f.dispatch('status').leases).toHaveLength(0)
  expect(readFileSync(join(f.home,'audit.jsonl'),'utf8')).not.toContain(secret)
})
it('revocation of deployment approval locks and cancels the current operation instead of downgrading its executor',async()=>{
  let approved=true,signal:AbortSignal|undefined
  const started=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>()
  const f=await fixture({mode:'protected-adapters',assertAvailable(){if(!approved)throw new Error('revoked')},execute:async(_e,_i,s)=>{signal=s;started.resolve();await finish.promise;return {status:'complete',operation:'website.login'}}}),lease=f.grant()
  const pending=f.execute(lease.id),assertion=expect(pending).rejects.toMatchObject({code:'vault_operation_uncertain'});await started.promise
  approved=false;expect(f.dispatch('status')).toMatchObject({unlocked:false,execution:'disabled',reason:'isolation_required',leases:[]})
  expect(signal?.aborted).toBe(true);finish.resolve();await assertion
})
