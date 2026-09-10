// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {WorkspaceNodes} from '../../src/server/workspaceGateway'
import {loadServerConfig} from '../../src/server/config'
import {GrokAuth} from '../../src/server/grokAuth'
import {HttpError} from '../../src/server/errors'

let home:string,store:WorkspaceStore,nodes:WorkspaceNodes,service:GrokAuth,version:number,active:boolean
let exchanges:Map<string,{accessToken:string;refreshToken:string}>,calls:Array<{url:URL;init:RequestInit}>
let oauth:(init:RequestInit)=>Promise<Response>,pollResponse:((url:URL)=>Promise<Response>)|undefined,verifyStatus:number
const token=(subject='account-a',seconds=3600)=>'header.'+Buffer.from(JSON.stringify({sub:subject,exp:Math.floor(Date.now()/1000)+seconds,email:subject+'@example.test'})).toString('base64url')+'.signature'
const auth={
 require:(ctx:any)=>({id:ctx.get('x-user')||'owner',role:ctx.get('x-user')==='member'?'user':'admin'}),
 requireAdmin:(ctx:any)=>{if(ctx.get('x-user')==='member')throw new HttpError(403,'仅限管理员','admin_required');return {id:ctx.get('x-user')||'owner',role:'admin'}},
 isUserActive:()=>active,isAdminActive:(owner:string)=>active&&owner!=='member',pushAuthorizationVersion:()=>version,
} as any
let fetcher:typeof fetch
beforeEach(()=>{
 home=mkdtempSync(join(tmpdir(),'grok-auth-test-'));store=new WorkspaceStore(home);nodes=new WorkspaceNodes(store,loadServerConfig({HERMES_YAOYAO_HOME:home}),{} as any)
 version=1;active=true;exchanges=new Map();calls=[];pollResponse=undefined;verifyStatus=200
 oauth=async()=>Response.json({access_token:token(),refresh_token:'rotated-refresh-token'})
 fetcher=(async(input,init={})=>{const url=new URL(String(input));calls.push({url,init})
  if(url.pathname==='/auth/poll'){if(pollResponse)return pollResponse(url);const tokens=exchanges.get(url.searchParams.get('uuid')!);return tokens?Response.json(tokens):new Response('',{status:404})}
  if(url.pathname==='/oauth/token')return oauth(init)
  if(url.pathname.endsWith('/GetSandBoxRunState'))return Response.json({state:'SAND_BOX_RUN_STATE_RUNNING'},{status:verifyStatus})
  if(url.pathname.endsWith('/GetMe'))return Response.json({email:'authorized@example.test',firstName:'Test',lastName:'Account'})
  throw new Error('Unexpected auth request')
 }) as typeof fetch
 service=new GrokAuth(store,auth,nodes,{fetcher})
})
afterEach(()=>{service.close();nodes.close();store.close();rmSync(home,{recursive:true,force:true});vi.useRealTimers()})
function begin(){return service.begin('owner',randomUUID()).attempt!}
function accept(a:ReturnType<typeof begin>,subject='account-a',seconds=3600){exchanges.set(new URL(a.loginUrl!).searchParams.get('uuid')!,{accessToken:token(subject,seconds),refreshToken:'private-refresh-token'})}
function stored(){return nodes.open<any>(store.require<any>('owner','grok-cloud','connection').sealed)}
function app(){const a=new Koa();a.use(async(ctx,next)=>{try{await next()}catch(error:any){ctx.status=error.status??500;ctx.body={error:error.message,code:error.code}}});a.use(bodyParser());a.use(service.router().routes());return a.callback()}

it('creates owner-bound PKCE challenges without sending the verifier or credentials to clients',async()=>{
 const a=begin(),url=new URL(a.loginUrl!),internal=store.require<any>('owner','grok-auth-attempt','current'),verifier=nodes.open<any>(internal.sealedVerifier).verifier
 expect(url.origin).toBe('https://cursor.com');expect(url.pathname).toBe('/loginDeepControl');expect(url.searchParams.get('redirectTarget')).toBe('cli')
 expect(url.searchParams.get('challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'))
 expect(JSON.stringify(a)).not.toContain(verifier);expect(JSON.stringify(internal)).not.toContain(verifier)
 await service.poll('owner',a.id);expect(service.snapshot('owner').attempt?.status).toBe('pending')
 accept(a);const result=await service.poll('owner',a.id)
 expect(result).toMatchObject({status:'connected',automaticRefresh:true,account:{email:'authorized@example.test',name:'Test Account'},attempt:{status:'complete'}})
 expect(JSON.stringify(result)).not.toContain('private-refresh-token');expect(JSON.stringify(result)).not.toContain('accessToken')
 expect(JSON.stringify(store.list('owner','grok-cloud'))).not.toContain('private-refresh-token')
 expect(stored().refreshToken).toBe('private-refresh-token')
 expect(store.require<any>('owner','grok-auth-attempt','current').sealedVerifier).toBeUndefined()
})

it('makes start retries idempotent and refuses a competing pending attempt',()=>{
 const id=randomUUID(),a=service.begin('owner',id)
 expect(service.begin('owner',id).attempt?.id).toBe(a.attempt?.id)
 expect(()=>service.begin('owner',randomUUID())).toThrow('已有进行中')
 expect(calls).toEqual([])
})

it('does not let a late browser result restore a cancelled or replaced login',async()=>{
 const a=begin();let deliver!:(r:Response)=>void
 pollResponse=()=>new Promise(resolve=>{deliver=resolve})
 const polling=service.poll('owner',a.id);await Promise.resolve()
 service.cancel('owner',a.id);const next=begin()
 deliver(Response.json({accessToken:token(),refreshToken:'late-refresh'}));await polling
 expect(service.configured('owner')).toBe(false);expect(service.snapshot('owner').attempt?.id).toBe(next.id)
})

it('expires links, removes verifiers and recovers an unexpired authorization after server restart',async()=>{
 vi.useFakeTimers();const a=begin();service.close();service=new GrokAuth(store,auth,nodes,{fetcher});accept(a)
 expect((await service.poll('owner',a.id)).status).toBe('connected')
 const b=begin();vi.advanceTimersByTime(10*60000+1)
 expect(service.snapshot('owner').attempt?.status).toBe('expired');expect(store.require<any>('owner','grok-auth-attempt','current').sealedVerifier).toBeUndefined()
 expect(begin().id).not.toBe(b.id)
})

it('refuses other owners and non-admin account linking',async()=>{
 const a=begin()
 await expect(service.poll('other',a.id)).rejects.toThrow('不存在')
 expect(()=>service.cancel('other',a.id)).toThrow('不存在')
 expect((await request(app()).post('/api/app/grok-cloud/auth/start').set('x-user','member').send({requestId:randomUUID()})).status).toBe(403)
 expect((await request(app()).get('/api/app/grok-cloud/auth').set('x-user','other')).body.configured).toBe(false)
})

it('cannot finish an authorization after local account permissions have changed',async()=>{
 const a=begin();accept(a);version++
 expect((await service.poll('owner',a.id)).attempt?.status).toBe('failed')
 expect(service.configured('owner')).toBe(false)
})

it('coalesces token refreshes and persists rotation without exposing tokens',async()=>{
 const a=begin();accept(a,'account-a',60);await service.poll('owner',a.id)
 const results=await Promise.all([service.credentials('owner'),service.credentials('owner'),service.credentials('owner')])
 expect(calls.filter(c=>c.url.pathname==='/oauth/token')).toHaveLength(1)
 expect(new Set(results.map(r=>r.accessToken)).size).toBe(1)
 expect(stored().refreshToken).toBe('rotated-refresh-token')
 const payload=JSON.parse(String(calls.find(c=>c.url.pathname==='/oauth/token')!.init.body))
 expect(payload).toMatchObject({client_id:'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB',grant_type:'refresh_token',refresh_token:'private-refresh-token'})
 expect(JSON.stringify(service.snapshot('owner'))).not.toContain('refreshToken')
})

it('keeps usable credentials on transient refresh failure and backs off retries',async()=>{
 const a=begin();accept(a,'account-a',60);await service.poll('owner',a.id)
 oauth=async()=>Response.json({error:'unavailable'},{status:503});const original=stored().accessToken
 expect((await service.credentials('owner')).accessToken).toBe(original)
 expect((await service.credentials('owner')).accessToken).toBe(original)
 expect(calls.filter(c=>c.url.pathname==='/oauth/token')).toHaveLength(1)
 expect(service.snapshot('owner')).toMatchObject({configured:true,status:'connected',automaticRefresh:true})
})

it('marks revoked authorization as requiring login without turning cloud auto selection off',async()=>{
 const a=begin();accept(a,'account-a',60);await service.poll('owner',a.id)
 oauth=async()=>Response.json({shouldLogout:true,error:'invalid_grant'})
 await expect(service.credentials('owner')).rejects.toMatchObject({status:409,code:'grok_login_required'})
 expect(service.snapshot('owner')).toMatchObject({configured:true,status:'reauthorization-required',automaticRefresh:false})
 expect(stored().accessToken).toBe('');expect(stored().refreshToken).toBeUndefined()
})

it('never restores a connection from a refresh response arriving after disconnect',async()=>{
 const a=begin();accept(a,'account-a',60);await service.poll('owner',a.id)
 let deliver!:(r:Response)=>void;oauth=()=>new Promise(resolve=>{deliver=resolve})
 const refreshing=service.credentials('owner');const rejection=expect(refreshing).rejects.toMatchObject({code:'grok_auth_superseded'});await Promise.resolve()
 service.disconnect('owner');deliver(Response.json({access_token:token(),refresh_token:'late-refresh'}));await rejection
 expect(service.snapshot('owner').status).toBe('disconnected');expect(store.list('_system','grok-account')).toEqual([])
})

it('refuses a different account during reauthorization and preserves the original connection',async()=>{
 const first=begin();accept(first);await service.poll('owner',first.id);const old=stored().account
 const a=begin();accept(a,'different-account');const result=await service.poll('owner',a.id)
 expect(result.attempt?.status).toBe('failed');expect(result.attempt?.error).toContain('当前已连接')
 expect(stored().account).toBe(old)
})

it('validates new credentials before replacing an existing connection',async()=>{
 await service.configure('owner',token(),'0.47.0','refresh-a');const old=store.require<any>('owner','grok-cloud','connection').sealed
 verifyStatus=403;await expect(service.configure('owner',token('second'),'0.47.0','refresh-b')).rejects.toThrow('未接受')
 expect(store.require<any>('owner','grok-cloud','connection').sealed).toBe(old)
})
