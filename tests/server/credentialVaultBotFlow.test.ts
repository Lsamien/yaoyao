// @vitest-environment node
import { expect, it, vi } from 'vitest'
import Koa from 'koa'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import { WorkspaceNodes, type GatewayTarget } from '../../src/server/workspaceGateway'
import { UploadStore } from '../../src/server/uploads'
import { loadServerConfig } from '../../src/server/config'
import { saveHostTools } from '../../src/server/hostToolSettings'
import { LocalAuthStore } from '../../src/server/localAuth'
import { CredentialVaultStore } from '../../src/server/credentialVault/store'
import { CredentialVaultBroker } from '../../src/server/credentialVault/broker'
import { CredentialVaultClient, serveCredentialVault } from '../../src/server/credentialVault/transport'
import { CredentialVaultCoordinator } from '../../src/server/credentialVault/coordinator'
import { ProtectedCredentialExecutor } from '../../src/server/credentialVault/protectedExecutor'
import { LocalCredentialVaultClient } from '../../src/server/credentialVault/localClient'
import { websiteFixture, sshFixture } from '../fixtures/credentialProtocols'
import { RunnerHub } from '../../src/server/runnerHub'
import type { Server } from 'node:http'
import type { WorkspaceRun } from '../../src/shared/workspace'

const scenarios=['website.login','ssh.exec','sftp.read','sftp.write','website.login.cancel','ssh.exec.cancel','sftp.write.cancel','ssh.exec.password','sftp.read.password','sftp.write.password','ssh.exec.password.cancel','ssh.exec.password.first-use','sftp.read.password.first-use','sftp.write.password.first-use'] as const
const baseCases=[...(['external','local'] as const).flatMap(storage=>scenarios.map(scenario=>({storage,scenario,persistent:false}))),...(['website.login','ssh.exec.password.first-use','sftp.read.password','ssh.exec.password.cancel'] as const).map(scenario=>({storage:'local' as const,scenario,persistent:true}))]
const cases=[...baseCases.map(c=>({...c,autonomous:false})),...(['ssh.exec.password.first-use','ssh.exec.password.cancel'] as const).map(scenario=>({storage:'local' as const,scenario,persistent:true,autonomous:true}))]
it.each(cases)('a Bot turn discovers and uses $storage vault references for dummy $scenario (persistent=$persistent, autonomous=$autonomous) with sanitized receipts',async({storage,scenario,persistent,autonomous})=>{
  const cancelled=scenario.endsWith('.cancel'),firstUse=scenario.endsWith('.first-use'),operation=scenario.replace('.password','').replace('.first-use','').replace(/\.cancel$/,'') as 'website.login'|'ssh.exec'|'sftp.read'|'sftp.write'
  const home=mkdtempSync(join(tmpdir(),'yaoyao-vault-bot-flow-'))
  const website=await websiteFixture(home),ssh=await sshFixture(scenario.includes('.password')?'password':'privateKey')
  if(cancelled){website.state.delay=true;ssh.state.delayExec=operation==='ssh.exec';ssh.state.delayWrite=true}
  const isWebsite=operation==='website.login',master='DUMMY-master-password-only',secret=isWebsite?website.secret:ssh.secret,username=isWebsite?website.username:ssh.username,sessionCookie=website.cookie
  const usage=operation==='website.login'?website.usage:operation==='ssh.exec'?{kind:'ssh.exec',command:'/usr/bin/uptime'}:operation==='sftp.read'?{kind:'sftp.read',remotePath:'/approved/input.txt',maxBytes:64}:{kind:'sftp.write',remotePath:'/approved/output.txt',contents:'DUMMY-fixed-transfer-body'}
  const credentialTarget=isWebsite?{kind:'website',origin:website.origin}:firstUse?(({hostKey:_hostKey,...target})=>target)(ssh.target):ssh.target
  const expected=operation==='website.login'?{status:'complete',operation}:operation==='ssh.exec'?{status:'complete',operation,exitCode:0}:operation==='sftp.read'?{status:'complete',operation,bytes:ssh.files.get('/approved/input.txt')!.length,sha256:createHash('sha256').update(ssh.files.get('/approved/input.txt')!).digest('hex')}:{status:'complete',operation,bytes:Buffer.byteLength('DUMMY-fixed-transfer-body'),sha256:createHash('sha256').update('DUMMY-fixed-transfer-body').digest('hex')}
  if(autonomous){ssh.state.execReplies.set('uname -s',{stdout:'Linux\n',stderr:''});ssh.state.execReplies.set('df -h / | head -n 2',{stdout:'Filesystem 40%\n',stderr:''})}
  const completed=autonomous?{status:'complete',operation:'ssh.exec',exitCode:0,stdout:'Linux\n',stderr:'',truncated:false}:persistent&&operation==='ssh.exec'?{...expected,stdout:'DUMMY-private-command-output',stderr:'DUMMY-private-stderr',truncated:false}:expected
  const expectedEffects=autonomous&&!cancelled?2:1
  const effectCount=()=>isWebsite?website.state.logins:operation==='ssh.exec'?ssh.state.commands.length:ssh.state.opens.length
  const store=new WorkspaceStore(home),uploads=new UploadStore(home),auth=new LocalAuthStore(home)
  const loginHeaders:Record<string,any>={},login={state:{},response:{headers:loginHeaders},get:()=>'',set:(k:string,v:any)=>{loginHeaders[k.toLowerCase()]=v}} as any
  const user=auth.setupAdmin(login,'dummy-admin','DUMMY-local-account-password'),cookies=String(loginHeaders['set-cookie']).split(';')[0]!,owner=user.id
  saveHostTools(home,{managedBrowser:false,vm:false,serverComputer:false,scriptMachine:false,cloud:false})
  const hermes=new WebSocketServer({port:0,host:'127.0.0.1'});await once(hermes,'listening')
  const bindings=new Map<string,any>(),prompts:string[]=[],results:any[]=[],catalogs:any[][]=[],references:any[]=[]
  let integrationError:unknown,credentialRef='',persistentBotId=''
  const target={url:new URL('http://127.0.0.1:'+(hermes.address() as any).port),client:{directAgent:undefined},session:{webSocketCredential:async()=>({name:'ticket',value:'dummy-ticket'}),request:async(path:string,input?:{body?:any})=>{
    if(path.endsWith('/bind'))bindings.set(input?.body.session_id,input?.body)
    const value=path.startsWith('/api/plugins/yaoyao-bot-bridge/')?{ok:true,version:1,ready:true,in_process:true,native_tools:true}:path==='/api/config'?{terminal:{}}:{messages:[]}
    return {status:200,headers:new Headers(),body:Buffer.from(JSON.stringify(value))}
  }}} as unknown as GatewayTarget
  const nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),target),runtime=new WorkspaceRuntime(store,nodes,uploads,owner=>auth.isUserActive(owner),owner=>auth.pushAuthorizationVersion(owner)??0)
  const socket=join(home,'dummy-vault.sock'),tokenFile=join(home,'dummy-control-token'),token=randomBytes(32).toString('base64url')
  let client:CredentialVaultClient,ipc:Server|undefined,hub:RunnerHub|undefined
  if(storage==='local'){
    client=new LocalCredentialVaultClient(home,website.cert)
    hub=new RunnerHub(store,auth,target) // The default direct Hermes setup has no registered Runner.
  }else{
    writeFileSync(tokenFile,token,{mode:0o600})
    const vault=await CredentialVaultStore.create(join(home,'vault')),broker=new CredentialVaultBroker(vault,Date.now,new ProtectedCredentialExecutor(join(home,'private-executor'),{assert(){}},website.cert))
    ipc=serveCredentialVault(broker,token);ipc.listen(socket);await once(ipc,'listening');chmodSync(socket,0o600)
    client=new CredentialVaultClient({socket,tokenFile,hermesUid:process.getuid!()+1})
  }
  const binding={runnerId:randomUUID(),runnerInstance:randomUUID(),runnerEpoch:'dummy-binding-epoch'}
  // This same-process dummy wiring exercises protocol and turn routing, not OS isolation.
  const coordinator=new CredentialVaultCoordinator(client,store,auth,hub??{credentialBinding:()=>binding} as unknown as RunnerHub);runtime.credentialVault=coordinator
  const app=new Koa();app.use(async(ctx,next)=>{try{await next()}catch(e){ctx.status=(e as any).status??500;ctx.body={code:(e as any).code}}})
  app.use(async(ctx,next)=>{const chunks:Buffer[]=[];for await(const c of ctx.req)chunks.push(Buffer.from(c));(ctx.request as any).body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};await next()})
  const router=coordinator.router();app.use(router.routes())
  const ui=(path:string,body?:unknown)=>body===undefined?request(app.callback()).get('/api/app/vault'+path).set('Cookie',cookies):request(app.callback()).post('/api/app/vault'+path).set('Cookie',cookies).send(body as any)
  hermes.on('connection',ws=>{
    ws.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    ws.on('message',raw=>{
      const f=JSON.parse(String(raw)),respond=(result:unknown)=>ws.send(JSON.stringify({id:f.id,result}))
      if(['session.create','session.resume'].includes(f.method))respond({session_id:randomUUID(),stored_session_id:randomUUID(),running:false,info:{profile_name:f.params.profile}})
      else if(f.method==='session.cwd.set')respond({cwd:f.params.cwd})
      else if(f.method==='session.usage')respond({context_used:10,context_max:1000})
      else if(f.method==='prompt.submit'){
        prompts.push(f.params.text);respond({status:'streaming'})
        void(async()=>{
          try{
            const bound=bindings.get(f.params.session_id)!,tool=async(path:string,value:any)=>{const response=await fetch(bound.bridge_url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bound.token},body:JSON.stringify(value)});expect(response.status).toBe(200);return response.json() as Promise<any>}
            const catalog=await tool('/tools/list',{});catalogs.push(catalog.tools)
            const named=(name:string)=>catalog.tools.find((t:any)=>t.name===name)!.id
            expect(named('credential_request')).toBeTruthy();expect(named('credential_refs')).toBeTruthy()
            const discovered=(await tool('/tools/call',{toolId:named('credential_refs'),arguments:{},callId:'before-approval'})).structuredContent.references
            expect(discovered).toHaveLength(1);expect(discovered[0]).toMatchObject({credentialRef,operation:persistent&&!isWebsite?'ssh.exec':operation,authorized:persistent});references.push(discovered)
            const call=autonomous?{toolId:named('credential_request'),arguments:{credentialRef:discovered[0].credentialRef,operation:'ssh.exec',command:'uname -s',timeoutSeconds:30},callId:'single-dummy-login'}:{toolId:named('credential_request'),arguments:{credentialRef:discovered[0].credentialRef,operation},callId:'single-dummy-login'}
            const pending=tool('/tools/call',call)
            if(!persistent){let view:any
            await vi.waitFor(async()=>{view=(await ui('')).body;expect(view.requests).toHaveLength(1)})
            expect(effectCount()).toBe(0)
            const waiting=store.require<any>(owner,'turn',view.requests[0].workId);expect(waiting.status).toBe('waiting')
            await ui('/leases',{credentialRef,agentId:view.requests[0].agentId,workId:view.requests[0].workId,operation,seconds:60}).expect(200)
            }
            if(cancelled){
              await (isWebsite?website.submitted:operation==='ssh.exec'?ssh.executed:ssh.written);expect(effectCount()).toBe(1)
              if(persistent){await ui('/unlock',{password:master}).expect(200);await ui('/bot-revoke',{credentialRef,agentId:persistentBotId}).expect(200)}
              else await ui('/lock',{}).expect(200)
            }
            const result=await pending;if(cancelled){expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('vault_operation_uncertain')}else expect(result.structuredContent).toEqual(completed);results.push(result)
            expect(await tool('/tools/call',call)).toEqual(result);expect(effectCount()).toBe(1) // Same call ID cannot log in twice.
            if(autonomous&&!cancelled){const command=result.structuredContent.stdout.includes('Linux')?'df -h / | head -n 2':'uname -s';const next=await tool('/tools/call',{toolId:named('credential_request'),arguments:{credentialRef,operation:'ssh.exec',command},callId:'followup-from-output'});expect(next.structuredContent).toMatchObject({status:'complete',stdout:'Filesystem 40%\n'});results.push(next)}
          }catch(e){integrationError=e}
          ws.send(JSON.stringify({method:'event',params:{type:'message.complete',session_id:f.params.session_id,payload:{text:'本地测试登录完成，凭据未展示。',status:'complete'}}}))
        })()
      }else respond({ok:true,status:'interrupted'})
    })
  })
  try{
    await ui('/initialize',{password:master}).expect(200);await ui('/unlock',{password:master}).expect(200)
    const entry=await ui('/entries',{name:'dummy-local-site',username,target:credentialTarget,usage,secret}).expect(200);credentialRef=entry.body.id
    expect(ssh.state.authMethods).toEqual([]) // Saving a password never opens a connection.
    const bot=store.createAgent(owner,{name:'dummy-login-Bot',profile:'default'}),conversation=store.list<any>(owner,'conversation').find(c=>c.kind==='direct'&&c.memberIds[0]===bot.id)!
    if(persistent){persistentBotId=bot.id;await ui('/bot-grant',{credentialRef,agentId:bot.id}).expect(200);await ui('/lock',{}).expect(200)}
    const run=runtime.send(owner,conversation.id,{requestId:randomUUID(),content:'请使用我授予当前任务的凭据引用完成本地测试登录。'})
    await vi.waitFor(()=>expect(['complete','failed']).toContain(store.require<WorkspaceRun>(owner,'run',run.id).status),{timeout:8000})
    expect(integrationError).toBeUndefined();expect(store.require<WorkspaceRun>(owner,'run',run.id).status).toBe('complete')
    expect(effectCount()).toBe(expectedEffects);if(isWebsite){expect(website.state.proofs).toBe(cancelled?0:1);expect(website.state.logouts).toBe(cancelled?0:1)};expect(results).toHaveLength(expectedEffects);expect(catalogs).toHaveLength(1)
    for(const blob of [JSON.stringify(results),JSON.stringify(references),JSON.stringify(catalogs),JSON.stringify(prompts),JSON.stringify(store.messages(owner,conversation.id)),readFileSync(join(home,storage==='local'?'credential-vault':'vault','audit.jsonl'),'utf8')]){
      for(const privateValue of [secret,master,username,sessionCookie,token,...(persistent&&operation==='ssh.exec'?[]:['DUMMY-private-command-output','DUMMY-private-stderr']),'DUMMY-private-file-contents','DUMMY-fixed-transfer-body'])expect(blob).not.toContain(privateValue)
    }
    expect((await ui('')).body.leases).toHaveLength(0)
    if(firstUse){if(persistent)await ui('/unlock',{password:master}).expect(200);const saved=(await ui('')).body.entries.find((e:any)=>e.id===credentialRef);if(persistent){expect(saved.target.hostKey).toBeUndefined();expect((await (client as LocalCredentialVaultClient).call(owner,'','bot-refs',{agentId:persistentBotId}))[0].allowedTarget.hostKey).toBe(ssh.target.hostKey);expect(saved.revision).toBe(1)}else{expect(saved.target.hostKey).toBe(ssh.target.hostKey);expect(saved.revision).toBe(2)};expect(ssh.state.authMethods).toEqual(Array(expectedEffects).fill('password'))}
  }finally{
    runtime.close();coordinator.close();await new Promise(resolve=>setTimeout(resolve,10))
    for(const ws of hermes.clients)ws.terminate();await new Promise<void>(resolve=>hermes.close(()=>resolve()))
    if(ipc)await new Promise<void>(resolve=>ipc!.close(()=>resolve()));hub?.close();await website.close();await ssh.close()
    nodes.close();uploads.close();store.close();rmSync(home,{recursive:true,force:true})
  }
},15000)
