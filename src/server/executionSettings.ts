import Router from '@koa/router'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {z} from 'zod'
import type {WorkspaceStore} from './workspaceStore.js'
import {parse} from './workspaceStore.js'
import type {WorkspaceNodes} from './workspaceGateway.js'
import type {LocalAuthStore} from './localAuth.js'
import type {WorkspaceAgent} from '../shared/workspace.js'
import type {ExecutionSelection,VmProxySettings,TaskEnvironment,SystemResourceSummary} from '../shared/executionEnvironment.js'
import {HttpError} from './errors.js'
import {CodexAuthorization} from './codexAuthorization.js'

const SYSTEM='_system', KIND='execution-settings'
const key=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).refine(k=>! /^(?:YAOYAO_|HERMES_YAOYAO_|NODE_OPTIONS$|LD_|DYLD_|PYTHONPATH$|PYTHONHOME$|BASH_ENV$|ENV$|HOME$|PATH$|CODEX_HOME$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(k),'该变量由运行环境管理')
const variables=z.record(key,z.string().max(32000).refine(s=>!s.includes('\0'))).refine(v=>Object.keys(v).length<=100)
const resourceInput=z.object({name:z.string().trim().min(1).max(80),kind:z.enum(['variables','api','codex']),agentIds:z.array(z.string().uuid()).max(500),
  variables:variables.optional(),baseUrl:z.string().url().max(2000).optional(),token:z.string().min(1).max(32000).optional(),
  tokenEnv:z.union([key,z.literal('')]).optional(),authJson:z.string().max(64000).optional(),revision:z.number().int().nonnegative().default(0)}).strict()
type Resource=z.infer<typeof resourceInput>&{id:string}
interface StoredResource {id:string;sealed:string;revision:number}
export const SERVICE_TOOLS=[{id:'yaoyao_service_request',name:'yaoyao_service_request',description:'调用本轮获准的系统服务。serviceId 必须来自系统服务目录；凭据由系统附加。模型、图片等请求格式遵循对应服务和 Skill。',inputSchema:{type:'object',properties:{serviceId:{type:'string'},path:{type:'string'},method:{enum:['GET','POST']},body:{type:'object'}},required:['serviceId','path','method'],additionalProperties:false}}]

/** One encrypted system store; grants reference globally unique Bot IDs. */
export class ExecutionSettings {
  readonly codexAuthorization:CodexAuthorization
  testProxy:()=>Promise<unknown>=async()=>{throw new HttpError(409,'未连接虚拟环境执行节点','proxy_node_unavailable')}
  onProxyChange:()=>Promise<void>=async()=>{}
  nodeStatus:()=>Array<{id:string;name:string;online:boolean;status:string}>=()=>[]
  activeTurns:()=>Array<{agentId:string;mode:ExecutionSelection['mode'];revision:number}>=()=>[]
  constructor(readonly store:WorkspaceStore,readonly nodes:WorkspaceNodes,readonly auth:LocalAuthStore){
    this.codexAuthorization=new CodexAuthorization(auth)
    if(!store.get(SYSTEM,KIND,'selection')){
      const existing=existsSync(join(store.home,'host-tools.json'))||!!store.db.prepare("SELECT 1 FROM workspace_entities WHERE kind='agent' LIMIT 1").get()
      store.put(SYSTEM,KIND,'selection',{mode:existing?'server':'none',revision:1})
    }
  }
  selection():ExecutionSelection {const value=this.store.require<{mode:ExecutionSelection['mode'];revision:number}>(SYSTEM,KIND,'selection');return {...value,credentialSource:value.mode==='server'?'native':'yaoyao'}}
  proxy():VmProxySettings {const value=this.store.get<{sealed:string}>(SYSTEM,KIND,'proxy');return value?this.nodes.open<VmProxySettings>(value.sealed):{enabled:false,protocol:'http',host:'',port:8080,username:'',revision:0}}
  private entries(){return this.store.list<StoredResource>(SYSTEM,'execution-resource').map(row=>this.nodes.open<Resource>(row.sealed))}
  private summary(v:Resource):SystemResourceSummary{return {id:v.id,name:v.name,kind:v.kind,revision:v.revision,agentIds:v.agentIds,envKeys:[...Object.keys(v.variables??{}),...(v.tokenEnv?[v.tokenEnv]:[]),...(v.kind==='codex'?['CODEX_HOME']:[])],baseUrl:v.baseUrl,tokenEnv:v.tokenEnv,configured:true}}
  agents(){return (this.store.db.prepare("SELECT owner,data FROM workspace_entities WHERE kind='agent'").all() as {owner:string;data:string}[]).flatMap(row=>{const a=JSON.parse(row.data) as WorkspaceAgent;return a.archived||a.remoteAgentId?[]:[{id:a.id,name:a.name,owner:row.owner}]})}
  view(){const {password,...proxy}=this.proxy();return {execution:this.selection(),proxy:{...proxy,hasPassword:!!password},resources:this.entries().map(v=>this.summary(v)),agents:this.agents(),nodes:this.nodeStatus(),activeTurns:this.activeTurns()}}
  saveSelection(value:unknown){const v=parse(z.object({mode:z.enum(['none','server','virtual']),revision:z.number().int().positive()}).strict(),value);if(v.revision!==this.selection().revision)throw new HttpError(409,'配置已变化，请刷新','execution_revision_conflict');this.store.put(SYSTEM,KIND,'selection',{mode:v.mode,revision:v.revision+1});return this.selection()}
  async saveProxy(value:unknown){
    const v=parse(z.object({enabled:z.boolean(),protocol:z.enum(['http','socks5']),host:z.string().trim().max(253).refine(s=>!s||/^[A-Za-z0-9.:[\]_-]+$/.test(s)),port:z.number().int().min(1).max(65535),username:z.string().max(255),password:z.string().max(255).optional(),revision:z.number().int().nonnegative()}).strict(),value)
    const old=this.proxy();if(old.revision!==v.revision)throw new HttpError(409,'代理配置已变化，请刷新','execution_revision_conflict')
    if(v.enabled&&!v.host)throw new HttpError(400,'请输入代理服务器地址','proxy_host_required')
    this.store.put(SYSTEM,KIND,'proxy',{sealed:this.nodes.seal({...v,password:v.password??old.password,revision:v.revision+1})})
    await this.onProxyChange();return this.view().proxy
  }
  saveResource(value:unknown,id:string=randomUUID()){
    const v=parse(resourceInput,value),old=this.entries().find(row=>row.id===id)
    if((old?.revision??0)!==v.revision)throw new HttpError(409,'授权已变化，请刷新','execution_revision_conflict')
    const known=new Set(this.agents().map(a=>a.id));if(v.agentIds.some(a=>!known.has(a)))throw new HttpError(400,'授权列表包含不可用的 Bot','execution_agent_invalid')
    if(old&&old.kind!==v.kind)throw new HttpError(400,'请新建不同类型的授权','execution_resource_invalid')
    const next={...old,...v,id,revision:v.revision+1}
    if(v.kind==='api'){
      const url=new URL(next.baseUrl??'https://invalid.invalid');if(!next.baseUrl||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!next.token)throw new HttpError(400,'服务需要 HTTPS 地址和授权令牌','execution_resource_invalid')
    }
    if(v.kind==='codex'){
      try{const data=JSON.parse(next.authJson??'');if(!data||typeof data!=='object'||Array.isArray(data)||!(data.OPENAI_API_KEY||data.tokens?.access_token))throw new Error()}catch{throw new HttpError(400,'需要有效的 Codex auth.json；不会将它用作通用 API 密钥','execution_resource_invalid')}
    }
    if(next.tokenEnv&&Object.hasOwn(next.variables??{},next.tokenEnv))throw new HttpError(409,'授权令牌与环境变量名称重复','execution_variable_conflict')
    const other=this.entries().filter(r=>r.id!==id)
    const ownKeys=this.summary(next).envKeys
    if(other.some(r=>r.agentIds.some(a=>next.agentIds.includes(a))&&this.summary(r).envKeys.some(k=>ownKeys.includes(k))))throw new HttpError(409,'同一 Bot 的变量名称重复，请合并或移除重复授权','execution_variable_conflict')
    this.store.put(SYSTEM,'execution-resource',id,{id,revision:next.revision,sealed:this.nodes.seal(next)});return this.summary(next)
  }
  removeResource(id:string){this.store.remove(SYSTEM,'execution-resource',id)}
  private granted(owner:string,agentId:string){const agent=this.store.require<WorkspaceAgent>(owner,'agent',agentId);if(!this.auth.isUserActive(owner)||agent.archived)throw new HttpError(403,'Bot 授权已结束','execution_grant_revoked');return this.entries().filter(r=>r.agentIds.includes(agentId))}
  openTurn(owner:string,agentId:string){
    // Resource grants belong to the Bot, not its default execution target.
    // Variable/file injection is requested only by the VM tool session.
    const initial=this.granted(owner,agentId)
    const check=(id?:string)=>{const current=this.granted(owner,agentId);for(const r of initial.filter(v=>!id||id===v.id))if(!current.some(v=>v.id===r.id&&v.revision===r.revision))throw new HttpError(403,'系统变量或服务授权已变化，请开始新一轮任务','execution_grant_revoked')}
    const taskEnvironment=():TaskEnvironment=>{check();const agent=this.store.require<WorkspaceAgent>(owner,'agent',agentId);if(agent.computerEnvironmentId){const peers=(this.store.db.prepare("SELECT data FROM workspace_entities WHERE kind='agent'").all() as {data:string}[]).map(row=>JSON.parse(row.data) as WorkspaceAgent).filter(a=>!a.archived&&a.computerEnvironmentId===agent.computerEnvironmentId);if(initial.some(r=>this.summary(r).envKeys.length&&peers.some(a=>!r.agentIds.includes(a.id))))throw new HttpError(403,'共享虚拟环境内仍有未获授权的 Bot；请为成员统一授权，或改用独立环境和服务工具','execution_shared_credentials_forbidden')}const result:TaskEnvironment={variables:{},files:[]};for(const r of initial){Object.assign(result.variables,r.variables);if(r.kind==='api'&&r.tokenEnv)result.variables[r.tokenEnv]=r.token!;if(r.kind==='codex')result.files.push({name:'auth.json',content:r.authJson!,envKey:'CODEX_HOME'})}return result}
    return {check,vmTaskEnvironment:taskEnvironment,catalog:()=>initial.some(r=>r.kind==='api')?SERVICE_TOOLS:[],description:initial.map(r=>({id:r.id,name:r.name,kind:r.kind,envKeys:this.summary(r).envKeys,baseUrl:r.baseUrl})),
      call:async(args:unknown,signal:AbortSignal)=>{
        const body=parse(z.object({serviceId:z.string(),path:z.string().max(2000),method:z.enum(['GET','POST']),body:z.record(z.string(),z.unknown()).optional()}).strict(),args)
        check(body.serviceId);const r=initial.find(r=>r.id===body.serviceId&&r.kind==='api');if(!r)throw new HttpError(403,'当前环境未授权该系统服务','execution_service_forbidden')
        const base=new URL(r.baseUrl!.replace(/\/?$/,'/')),url=new URL(body.path.replace(/^\//,''),base)
        if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.username||url.password||/%(?:2f|5c|25)/i.test(url.pathname))throw new HttpError(400,'请求路径超出已授权服务','execution_service_path')
        try{const response=await fetch(url,{method:body.method,headers:{authorization:`Bearer ${r.token}`,'content-type':'application/json'},body:body.method==='POST'?JSON.stringify(body.body??{}):undefined,signal:AbortSignal.any([signal,AbortSignal.timeout(60000)]),redirect:'error'})
          const chunks:Buffer[]=[];let size=0;for await(const part of response.body??[]){const b=Buffer.from(part);size+=b.length;if(size>8*1024*1024)throw new Error('limit');chunks.push(b)}check(body.serviceId)
          const data=Buffer.concat(chunks).toString().split(r.token!).join('[已隐藏授权]');return {status:response.status,body:data}
        }catch(error){check(body.serviceId);throw new HttpError(502,'服务调用失败，请检查连接、授权和请求格式','execution_service_failed')}
      }}
  }
  router(){const router=new Router({prefix:'/api/app/admin/execution'});router.use(async(ctx,next)=>{this.auth.requireAdmin(ctx);ctx.set('Cache-Control','no-store');await next()});const body=(ctx:any)=>ctx.request.body
    router.get('/',ctx=>{ctx.body=this.view()});router.put('/environment',ctx=>{ctx.body=this.saveSelection(body(ctx))});router.put('/proxy',async ctx=>{ctx.body=await this.saveProxy(body(ctx))})
    router.post('/proxy/test',async ctx=>{ctx.body=await this.testProxy()})
    router.post('/codex-auth',ctx=>{const {requestId}=parse(z.object({requestId:z.string().uuid()}).strict(),body(ctx));ctx.body=this.codexAuthorization.begin(this.auth.requireAdmin(ctx).id,requestId)})
    router.get('/codex-auth/:id',ctx=>{ctx.body=this.codexAuthorization.snapshot(this.auth.requireAdmin(ctx).id,ctx.params.id)})
    router.delete('/codex-auth/:id',ctx=>{ctx.body=this.codexAuthorization.cancel(this.auth.requireAdmin(ctx).id,ctx.params.id)})
    const save=(ctx:any,id?:string)=>{
      const {authAttemptId,...input}=parse(resourceInput.extend({authAttemptId:z.string().uuid().optional()}),body(ctx))
      const owner=this.auth.requireAdmin(ctx).id
      if(authAttemptId){
        if(input.kind!=='codex'||input.authJson!==undefined)throw new HttpError(400,'请选择一种登录授权方式','execution_resource_invalid')
        input.authJson=this.codexAuthorization.credentials(owner,authAttemptId)
      }
      const result=this.saveResource(input,id)
      if(authAttemptId)this.codexAuthorization.cancel(owner,authAttemptId)
      return result
    }
    router.post('/resources',ctx=>{ctx.body=save(ctx);ctx.status=201});router.put('/resources/:id',ctx=>{ctx.body=save(ctx,ctx.params.id)});router.delete('/resources/:id',ctx=>{this.removeResource(ctx.params.id);ctx.body={ok:true}})
    return router
  }
  close(){this.codexAuthorization.close()}
}
