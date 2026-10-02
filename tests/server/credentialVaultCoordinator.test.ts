// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type Koa from 'koa'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { CredentialVaultStore } from '../../src/server/credentialVault/store'
import { CredentialVaultBroker } from '../../src/server/credentialVault/broker'
import type {CredentialExecutor} from '../../src/server/credentialVault/executor'
import { CredentialVaultClient, serveCredentialVault } from '../../src/server/credentialVault/transport'
import { CredentialVaultCoordinator } from '../../src/server/credentialVault/coordinator'
import { LocalAuthStore } from '../../src/server/localAuth'
import { HttpError } from '../../src/server/errors'
import type { WorkspaceStore } from '../../src/server/workspaceStore'
import type { RunnerHub } from '../../src/server/runnerHub'
import type { Server } from 'node:http'
const cleanups:Array<()=>Promise<void>>=[]
const password='DUMMY-vault-master-only',secret='DUMMY-website-secret-only'
function context(cookie='',path='',method='GET',body:unknown={}):Koa.Context{
  const headers:Record<string,any>={}
  return {state:{},get:(key:string)=>key.toLowerCase()==='cookie'?cookie:'',set:(key:string,value:any)=>{headers[key.toLowerCase()]=value},response:{headers},path,method,request:{body},params:{},secure:false,req:{socket:{remoteAddress:'127.0.0.1'}}} as unknown as Koa.Context
}
function cookie(ctx:Koa.Context){const value=ctx.response.headers['set-cookie'];return String(Array.isArray(value)?value.at(-1):value).split(';')[0]!}
async function fixture(ipc=false,executor?:CredentialExecutor,configured=false){
  const home=mkdtempSync(join(tmpdir(),'yaoyao-vault-coordinator-')),auth=new LocalAuthStore(home),login=context(),user=auth.setupAdmin(login,'dummy-user','dummy-login-password'),cookies=cookie(login)
  const vault=await CredentialVaultStore.create(join(home,'vault')),broker=new CredentialVaultBroker(vault,Date.now,executor)
  let client:CredentialVaultClient,server:Server|undefined
  if(ipc){
    const socket=join(home,'dummy.sock'),tokenFile=join(home,'dummy-control'),token='DUMMY-CONTROL-TOKEN-NOT-PRODUCTION-00000'
    writeFileSync(tokenFile,token,{mode:0o600});server=serveCredentialVault(broker,token);server.listen(socket);await once(server,'listening');chmodSync(socket,0o600)
    // In-process fixtures do NOT prove OS isolation. Production executors remain disabled.
    client=new CredentialVaultClient({socket,tokenFile,hermesUid:process.getuid!()+1})
  }else{
    const epoch=randomUUID();broker.hello(epoch)
    client=new CredentialVaultClient()
    vi.spyOn(client,'call').mockImplementation(async(o,s,c,v)=>c==='execute'?broker.execute(epoch,o,s,(v as any).id,(v as any).input):broker.dispatch(epoch,o,s,c,v))
  }
  const agent={id:randomUUID(),name:'dummy-Bot',nodeId:'local',profile:'default',archived:false},run={id:randomUUID(),stopRequested:false},work={id:randomUUID(),agentId:agent.id,runId:run.id,status:'running',cancelRequested:false}
  const objects:any={agent,run,turn:work},store={require:(o:string,kind:string,id:string)=>{if(o!==user.id||objects[kind]?.id!==id)throw new HttpError(404,'fixture missing','not_found');return objects[kind]},list:(o:string,kind:string)=>o===user.id&&objects[kind]?[objects[kind]]:[]} as unknown as WorkspaceStore
  let binding={runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:'dummy-epoch'}
  const hub={credentialBinding:()=>binding} as unknown as RunnerHub,coordinator=new CredentialVaultCoordinator(client,store,auth,hub),router=coordinator.router()
  const request=async(path:string,method='GET',body:unknown={},c=cookies)=>{const ctx=context(c,'/api/app/vault'+path,method,body);await router.routes()(ctx,async()=>{});return ctx.body as any}
  cleanups.push(async()=>{coordinator.close();if(server){await new Promise<void>(resolve=>server!.close(()=>resolve()));server.closeAllConnections()}else broker.close();rmSync(home,{recursive:true,force:true})})
  await request('/initialize','POST',{password})
  const unlock=()=>request('/unlock','POST',{password}),status=()=>request('')
  await unlock();const entry=await request('/entries','POST',{name:'dummy-site',username:'dummy-user',target:{kind:'website',origin:'https://example.test'},secret,
    ...(configured?{usage:{kind:'website.form',loginPath:'/login',submitPath:'/login',successPath:'/account',formId:'login',usernameName:'username',passwordName:'password',successSelector:'#success'}}:{})})
  const grant=()=>request('/leases','POST',{credentialRef:entry.id,agentId:agent.id,workId:work.id,operation:'website.login',seconds:60})
  const turn=(signal=new AbortController().signal,waiting=vi.fn())=>coordinator.openTurn(user.id,agent.id,work.id,signal,()=>{},waiting)
  return {home,auth,user,cookies,broker,client,coordinator,request,unlock,status,entry,agent,run,work,grant,turn,changeBinding:()=>{binding={...binding,runnerInstance:randomUUID()}},hub,server}
}
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();vi.restoreAllMocks()})
it('uses private IPC for encrypted CRUD and short grants but returns manual takeover instead of a login',async()=>{
  const f=await fixture(true),lease=await f.grant(),t=f.turn()
  expect((await f.status()).leases).toHaveLength(1)
  expect(await t.call('credential_refs',{})).toEqual({references:[{credentialRef:f.entry.id,operation:'website.login',allowedTarget:f.entry.target}]})
  expect(await t.call('credential_request',{credentialRef:f.entry.id,operation:'website.login'})).toMatchObject({status:'manual_takeover_required',reason:'vault_executor_not_enabled'})
  const status=await f.status();expect(JSON.stringify(status)).not.toContain(secret);expect(status.execution).toBe('disabled');expect(lease.expiresAt-Date.now()).toBeLessThanOrEqual(60000)
  t.close();await vi.waitFor(async()=>expect((await f.status()).leases).toHaveLength(0))
})
it('discovers only configured metadata while unlocked, distinguishes discovery from task approval and hides it after lock',async()=>{
  const f=await fixture(false,undefined,true),t=f.turn()
  const references=async()=>((await t.call('credential_refs',{})) as any).references
  expect(await references()).toEqual([{credentialRef:f.entry.id,name:'dummy-site',operation:'website.login',allowedTarget:f.entry.target,allowedUse:f.entry.usage,authorized:false}])
  expect(JSON.stringify(await references())).not.toContain(secret);expect(JSON.stringify(await references())).not.toContain('dummy-user')
  const lease=await f.grant();expect((await references())[0].authorized).toBe(true)
  await f.request('/leases/'+lease.id,'DELETE');expect((await references())[0].authorized).toBe(false)
  await f.request('/lock','POST',{});expect(await references()).toEqual([]);t.close()
})
it.each(['lock','logout','connection'] as const)('rejects a late unlock response following %s and leaves the vault locked',async cause=>{
  const f=await fixture();await f.request('/lock','POST',{})
  const original=f.client.call.bind(f.client),reached=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  vi.spyOn(f.client,'call').mockImplementation(async(o,s,c,v)=>{const result=await original(o,s,c,v);if(c==='unlock'){reached.resolve();await release.promise}return result})
  const pending=f.unlock(),assertion=expect(pending).rejects.toMatchObject({code:'vault_session_revoked'});await reached.promise
  if(cause==='lock')await f.request('/lock','POST',{})
  if(cause==='logout'){await f.coordinator.logout(f.user.id,f.cookies);f.auth.logout(context(f.cookies))}
  if(cause==='connection')f.client.onDisconnect()
  release.resolve();await assertion
  expect(f.broker.status(f.user.id,f.auth.sessionBinding(f.cookies)!).unlocked).toBe(false)
})
it.each(['cancel','reconnect','permission'] as const)('revokes a grant created during %s before it can reach the Bot',async cause=>{
  const f=await fixture(),original=f.client.call.bind(f.client),reached=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  vi.spyOn(f.client,'call').mockImplementation(async(o,s,c,v)=>{const result=await original(o,s,c,v);if(c==='grant'){reached.resolve();await release.promise}return result})
  const pending=f.grant(),assertion=expect(pending).rejects.toMatchObject({code:cause==='permission'?'vault_session_revoked':'vault_task_revoked'});await reached.promise
  if(cause==='cancel')f.work.cancelRequested=true
  if(cause==='reconnect')f.changeBinding()
  if(cause==='permission')vi.spyOn(f.auth,'pushAuthorizationVersion').mockReturnValue(1000)
  release.resolve();await assertion
  expect(f.broker.status(f.user.id,f.auth.sessionBinding(f.cookies)!).leases).toHaveLength(0)
})
it('a Bot gets no stale refs after revoke or Runner reconnect and cannot request another Bot task',async()=>{
  const f=await fixture(),lease=await f.grant(),t=f.turn()
  await f.request('/leases/'+lease.id,'DELETE');expect(await t.call('credential_refs',{})).toEqual({references:[]})
  await f.grant();f.changeBinding();expect(await t.call('credential_refs',{})).toEqual({references:[]})
  f.work.agentId=randomUUID();await expect(t.call('credential_refs',{})).rejects.toMatchObject({code:'vault_task_revoked'});t.close()
})
it('cancellation releases locked/offline waiting and prevents fallback or pending requests lingering',async()=>{
  const f=await fixture(),controller=new AbortController(),waiting=vi.fn();await f.request('/lock','POST',{})
  vi.spyOn(f.hub,'credentialBinding').mockImplementation(()=>{throw new HttpError(503,'offline','vault_runner_offline')})
  const t=f.turn(controller.signal,waiting),pending=t.call('credential_request',{credentialRef:f.entry.id,operation:'website.login'}),assertion=expect(pending).rejects.toThrow()
  expect(waiting).toHaveBeenCalledWith(true);expect((await f.status()).requests).toHaveLength(1)
  controller.abort();await assertion;expect(waiting).toHaveBeenLastCalledWith(false);expect((await f.status()).requests).toHaveLength(0);t.close()
})
it('refuses old Runner capability and insecure remote UI immediately',async()=>{
  const f=await fixture();vi.spyOn(f.hub,'credentialBinding').mockImplementation(()=>{throw new HttpError(409,'upgrade','vault_runner_upgrade_required')})
  const t=f.turn();await expect(t.call('credential_request',{credentialRef:f.entry.id,operation:'website.login'})).rejects.toMatchObject({code:'vault_runner_upgrade_required'});t.close()
  const ctx=context(f.cookies,'/api/app/vault/unlock','POST',{password});Object.assign(ctx.req.socket,{remoteAddress:'192.0.2.10'})
  await expect(f.coordinator.router().routes()(ctx,async()=>{})).rejects.toMatchObject({code:'vault_https_required'})
})
it('default configuration remains offline and rejects same-UID control without reading a credential file',async()=>{
  await expect(new CredentialVaultClient().call('owner','a'.repeat(64),'status')).rejects.toMatchObject({code:'vault_offline'})
  await expect(new CredentialVaultClient({socket:'/not-a-real-socket',tokenFile:'/never-read',hermesUid:process.getuid!()}).call('owner','a'.repeat(64),'status')).rejects.toMatchObject({code:'vault_offline'})
})
it('binds the authenticated session token independent of unrelated cookie changes and ordering',async()=>{
  const f=await fixture(),status=await f.request('','GET',{},'dummy_csrf=changed; '+f.cookies+'; dummy_extra=1')
  expect(status.unlocked).toBe(true)
  await f.coordinator.logout(f.user.id,'dummy_extra=2; '+f.cookies)
  expect((await f.status()).unlocked).toBe(false)
})
it('parallel requests retain separate approvals and close cancels both waiting calls exactly once',async()=>{
  const f=await fixture(),waiting=vi.fn();await f.request('/lock','POST',{})
  const t=f.turn(undefined,waiting),one=t.call('credential_request',{credentialRef:f.entry.id,operation:'website.login'}),two=t.call('credential_request',{credentialRef:randomUUID(),operation:'website.login'})
  const assertions=[expect(one).rejects.toThrow(),expect(two).rejects.toThrow()]
  expect((await f.status()).requests).toHaveLength(2);expect(waiting).toHaveBeenCalledTimes(1)
  t.close();await Promise.all(assertions);expect(waiting).toHaveBeenLastCalledWith(false);expect(waiting.mock.calls.filter(([v])=>!v)).toHaveLength(1)
  expect((await f.status()).requests).toHaveLength(0)
})
it('a Runner change after execution but before its receipt reaches the Bot leaves an unknown result and cannot replay',async()=>{
  const execute=vi.fn(async()=>({status:'complete' as const,operation:'website.login' as const})),f=await fixture(false,{mode:'protected-adapters',execute});await f.grant()
  const original=f.client.call.bind(f.client),reached=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  vi.spyOn(f.client,'call').mockImplementation(async(o,s,c,v)=>{const result=await original(o,s,c,v);if(c==='execute'){reached.resolve();await release.promise}return result})
  const t=f.turn(),pending=t.call('credential_request',{credentialRef:f.entry.id,operation:'website.login'}),assertion=expect(pending).rejects.toMatchObject({code:'vault_operation_uncertain'})
  await reached.promise;f.changeBinding();release.resolve();await assertion
  expect(execute).toHaveBeenCalledOnce();expect((await f.status()).leases).toHaveLength(0);t.close()
})
it('losing the private execution connection aborts the lease and returns unknown once instead of waiting/retrying',async()=>{
  const reached=Promise.withResolvers<void>();let signal:AbortSignal|undefined
  const execute=vi.fn(async(_e,_i,s:AbortSignal)=>{signal=s;reached.resolve();await new Promise<void>((_r,reject)=>s.addEventListener('abort',()=>reject(new Error('DUMMY-private-error')),{once:true}));return {status:'complete' as const,operation:'website.login' as const}})
  const f=await fixture(true,{mode:'protected-adapters',execute});await f.grant()
  const t=f.turn(),pending=t.call('credential_request',{credentialRef:f.entry.id,operation:'website.login'}),assertion=expect(pending).rejects.toMatchObject({code:'vault_operation_uncertain'})
  await reached.promise;f.server!.closeAllConnections();await assertion
  await vi.waitFor(()=>expect(signal?.aborted).toBe(true));expect(execute).toHaveBeenCalledOnce()
  expect((await f.status()).leases).toHaveLength(0);t.close()
})
