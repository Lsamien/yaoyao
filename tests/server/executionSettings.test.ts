// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {ExecutionSettings} from '../../src/server/executionSettings'
import {buildWorkspaceEnvironment,workspaceEnvironmentTools} from '../../src/server/workspaceEnvironment'
import {parseHostTools} from '../../src/server/hostToolSettings'
import {TASK_COMMAND,redactTaskOutput} from '../../src/runner/worker/taskEnvironment'
import {spawnSync} from 'node:child_process'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {LocalAuthStore} from '../../src/server/localAuth'
let home:string,store:WorkspaceStore,settings:ExecutionSettings
const id=randomUUID(),other=randomUUID()
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'yaoyao-execution-'));store=new WorkspaceStore(home)
  const config=loadServerConfig({HERMES_YAOYAO_HOME:home,HERMES_YAOYAO_UPSTREAM:'http://127.0.0.1:9119'})
  const nodes=new WorkspaceNodes(store,config,{} as any,randomUUID())
  settings=new ExecutionSettings(store,nodes,{isUserActive:()=>true} as any)
  for(const [owner,agentId] of [['alice',id],['bob',other]])store.put(owner!,'agent',agentId!,{id:agentId,name:owner,nodeId:'local',profile:'default',archived:false})
})
afterEach(()=>{settings.close();vi.restoreAllMocks();store.db.close();rmSync(home,{recursive:true,force:true})})
it('defaults a new installation to no environment; shared resources require explicit Bot grants',()=>{
  expect(settings.selection()).toMatchObject({mode:'none',credentialSource:'yaoyao'})
  const resource=settings.saveResource({name:'API',kind:'api',baseUrl:'https://api.example.test/v1/',token:'fixture-sensitive-token',tokenEnv:'XAI_API_KEY',agentIds:[id]})
  expect(settings.openTurn('alice',id).vmTaskEnvironment().variables.XAI_API_KEY).toBe('fixture-sensitive-token')
  expect(settings.openTurn('bob',other).vmTaskEnvironment().variables).toEqual({})
  expect(JSON.stringify(settings.view())).not.toContain('fixture-sensitive-token')
  expect(JSON.stringify(store.list('_system','execution-resource'))).not.toContain('fixture-sensitive-token')
  expect(()=>settings.saveResource({...resource,envKeys:undefined,configured:undefined,revision:resource.revision} as any)).toThrow() // public summaries cannot overwrite secrets
})
it('keeps VM resource grants when the default target changes and still revokes old turns',()=>{
  const resource=settings.saveResource({name:'Variables',kind:'variables',variables:{SERVICE_SECRET:'fixture-secret'},agentIds:[id]})
  const turn=settings.openTurn('alice',id)
  settings.saveSelection({mode:'server',revision:1})
  const serverDefaultTurn=settings.openTurn('alice',id)
  expect(serverDefaultTurn.vmTaskEnvironment()).toEqual({variables:{SERVICE_SECRET:'fixture-secret'},files:[]})
  expect(process.env.SERVICE_SECRET).toBeUndefined()
  expect(turn.vmTaskEnvironment().variables.SERVICE_SECRET).toBe('fixture-secret') // default target does not revoke resource grants
  settings.removeResource(resource.id)
  expect(()=>turn.vmTaskEnvironment()).toThrow('授权已变化')
  expect(()=>serverDefaultTurn.vmTaskEnvironment()).toThrow('授权已变化')
})
it('preserves write-only secrets, rejects conflicting variables and internal environment overrides',()=>{
  const r=settings.saveResource({name:'Variables',kind:'variables',variables:{EXTERNAL_KEY:'saved'},agentIds:[id]})
  settings.saveResource({name:'Renamed',kind:'variables',agentIds:[id],revision:r.revision},r.id)
  expect(settings.openTurn('alice',id).vmTaskEnvironment().variables.EXTERNAL_KEY).toBe('saved')
  expect(()=>settings.saveResource({name:'Conflict',kind:'variables',variables:{EXTERNAL_KEY:'new'},agentIds:[id]})).toThrow('重复')
  for(const key of ['YAOYAO_ADMIN_TOKEN','NODE_OPTIONS','LD_PRELOAD','HTTPS_PROXY','CODEX_HOME'])expect(()=>settings.saveResource({name:'unsafe',kind:'variables',variables:{[key]:'bad'},agentIds:[id]})).toThrow()
})
it.each(['none','server','virtual'] as const)('keeps authorized API requests scoped and redacted with default %s',async mode=>{
  settings.saveSelection({mode,revision:1})
  const r=settings.saveResource({name:'Grok API',kind:'api',baseUrl:'https://api.example.test/v1/',token:'secret-fixture',agentIds:[id]})
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('secret-fixture'))
  const turn=settings.openTurn('alice',id)
  expect(await turn.call({serviceId:r.id,path:'images/generations',method:'POST',body:{prompt:'test'}},new AbortController().signal)).toEqual({status:200,body:'[已隐藏授权]'})
  expect(turn.catalog().map(tool=>tool.id)).toContain('yaoyao_service_request')
  await expect(settings.openTurn('bob',other).call({serviceId:r.id,path:'images',method:'GET'},new AbortController().signal)).rejects.toThrow('未授权')
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({headers:{authorization:'Bearer secret-fixture'},redirect:'error'})
  for(const path of ['https://evil.test','../admin','/%2e%2e/admin','..%2fadmin','..%5cadmin','%252e%252e/admin'])await expect(turn.call({serviceId:r.id,path,method:'GET'},new AbortController().signal)).rejects.toThrow()
})
it('requires an administrator on every settings endpoint and never returns credential values',async()=>{
  const auth=Object.create(LocalAuthStore.prototype)
  auth.current=(ctx:Koa.Context)=>ctx.get('x-role')?{id:'fixture',role:ctx.get('x-role'),mustChangePassword:false}:undefined
  settings.auth.requireAdmin=ctx=>auth.requireAdmin(ctx)
  settings.saveResource({name:'Private',kind:'variables',variables:{API_KEY:'private-fixture-key'},agentIds:[id]})
  const app=new Koa(),router=settings.router()
  app.use(async(ctx,next)=>{try{await next()}catch(error){ctx.status=(error as any).status??500;ctx.body={error:'rejected'}}})
  app.use(router.routes())
  for(const role of ['', 'member']){
    const status=role?403:401
    for(const [method,path] of [['get',''],['put','/environment'],['put','/proxy'],['post','/proxy/test'],['post','/resources'],['put','/resources/'+randomUUID()],['delete','/resources/'+randomUUID()],['post','/codex-auth'],['get','/codex-auth/'+randomUUID()],['delete','/codex-auth/'+randomUUID()]]){
      await (request(app.callback()) as any)[method!]('/api/app/admin/execution'+path).set('x-role',role).expect(status)
    }
  }
  const response=await request(app.callback()).get('/api/app/admin/execution').set('x-role','admin').expect(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(JSON.stringify(response.body)).not.toContain('private-fixture-key')
})
it('saves a browser login through the encrypted resource store and only consumes it after successful validation',async()=>{
  const secret=JSON.stringify({tokens:{access_token:'browser-fixture-secret'}}),attemptId=randomUUID()
  settings.auth.requireAdmin=()=>({id:'alice',role:'admin'}) as any
  const credentials=vi.spyOn(settings.codexAuthorization,'credentials').mockReturnValue(secret)
  const consume=vi.spyOn(settings.codexAuthorization,'cancel').mockReturnValue({id:attemptId,status:'cancelled',expiresAt:0})
  const app=new Koa(),router=settings.router()
  app.use(async(ctx,next)=>{try{await next()}catch(error){ctx.status=(error as any).status??500;ctx.body={error:'rejected'}}})
  app.use(bodyParser());app.use(router.routes())
  const body={name:'浏览器登录',kind:'codex',agentIds:[id],authAttemptId:attemptId}
  await request(app.callback()).post('/api/app/admin/execution/resources').send({...body,revision:9}).expect(409)
  expect(consume).not.toHaveBeenCalled()
  await request(app.callback()).post('/api/app/admin/execution/resources').send({...body,authJson:secret}).expect(400)
  const result=await request(app.callback()).post('/api/app/admin/execution/resources').send(body).expect(201)
  expect(credentials).toHaveBeenCalledWith('alice',attemptId);expect(consume).toHaveBeenCalledWith('alice',attemptId)
  expect(JSON.stringify(result.body)).not.toContain('browser-fixture-secret')
  expect(JSON.stringify(store.list('_system','execution-resource'))).not.toContain('browser-fixture-secret')
  expect(settings.openTurn('alice',id).vmTaskEnvironment().files).toEqual([{name:'auth.json',content:secret,envKey:'CODEX_HOME'}])
  expect(settings.openTurn('bob',other).vmTaskEnvironment().files).toEqual([])
})
it('requires every co-resident Bot to be granted credentials before injecting them into a shared VM',()=>{
  const environment=randomUUID()
  for(const [owner,agentId] of [['alice',id],['bob',other]])store.put(owner!,'agent',agentId!,{...store.require<any>(owner!,'agent',agentId!),computerEnvironmentId:environment})
  const resource=settings.saveResource({name:'Shared',kind:'variables',variables:{API_KEY:'fixture'},agentIds:[id]})
  expect(()=>settings.openTurn('alice',id).vmTaskEnvironment()).toThrow('共享虚拟环境')
  settings.saveResource({name:'Shared',kind:'variables',agentIds:[id,other],revision:resource.revision},resource.id)
  expect(settings.openTurn('alice',id).vmTaskEnvironment().variables.API_KEY).toBe('fixture')
})
it('migrates existing installations to the server environment without promoting account credentials',()=>{
  store.remove('_system','execution-settings','selection')
  store.put('alice','account-authorization','fixture',{token:'account-private-fixture'})
  const migrated=new ExecutionSettings(store,settings.nodes,settings.auth)
  expect(migrated.selection()).toMatchObject({mode:'server',credentialSource:'native'})
  expect(migrated.view().resources).toEqual([])
  expect(store.get('alice','account-authorization','fixture')).toEqual({token:'account-private-fixture'})
})
it('isolates credential files per command and removes them on nonzero exits',()=>{
  const environment={variables:{EXTERNAL_KEY:'fixture-secret'},files:[{name:'auth.json',content:'{"tokens":{"access_token":"codex-fixture-secret"}}',envKey:'CODEX_HOME'}]}
  const result=spawnSync('python3',['-c',TASK_COMMAND],{input:JSON.stringify({environment,command:'printf "%s\\n" "$EXTERNAL_KEY" "$CODEX_HOME"; cat "$CODEX_HOME/auth.json"; exit 7'}),encoding:'utf8'})
  expect(result.status).toBe(7);expect(result.stdout).toContain('fixture-secret')
  const path=result.stdout.split('\n')[1]!
  expect(()=>readFileSync(join(path,'auth.json'))).toThrow()
  expect(redactTaskOutput({stdout:result.stdout},environment).stdout).not.toContain('fixture-secret')
})
it.each(['none','server','virtual'] as const)('mounts all allowed environments regardless of default %s',mode=>{
  const agent=store.require<any>('alice','agent',id)
  const env=buildWorkspaceEnvironment({agent,globals:parseHostTools({managedBrowser:true}),execution:{mode,revision:1,credentialSource:mode==='server'?'native':'yaoyao'},desktop:{capturedAt:0,hosts:[]},bridge:true,cloud:true,plugins:true,managedBrowser:true})
  const names=workspaceEnvironmentTools(env).map(t=>t.id)
  expect(names).toEqual(expect.arrayContaining(['computer_shell','cloud_computer_shell','managed_browser_open','managed_browser_to_vm']))
  expect(env.tools.plugins).toBe(true)
  const disabled=buildWorkspaceEnvironment({agent,globals:parseHostTools({vm:false,cloud:false,managedBrowser:false}),execution:env.selection,desktop:{capturedAt:0,hosts:[]},bridge:true,cloud:true,plugins:false,managedBrowser:true})
  expect(workspaceEnvironmentTools(disabled)).toEqual([])
  expect(disabled.virtual.vm.status).toBe('disabled')
})
