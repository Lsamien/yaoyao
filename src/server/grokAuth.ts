import {createHash,randomBytes,randomUUID} from 'node:crypto'
import Router from '@koa/router'
import {z} from 'zod'
import {HttpError} from './errors.js'
import {parse,type WorkspaceStore} from './workspaceStore.js'
import type {WorkspaceNodes} from './workspaceGateway.js'
import type {LocalAuthStore} from './localAuth.js'
import type {GrokAuthAttempt,GrokAuthSnapshot} from '../shared/grokAuth.js'

const CLIENT_ID='KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
export const GROK_CLIENT_VERSION='0.47.0'
const LOGIN_TTL=10*60000,REFRESH_LEEWAY=5*60000
const versionSchema=z.string().regex(/^\d+\.\d+\.\d+$/)
const tokensSchema=z.object({accessToken:z.string().min(32).max(16000),refreshToken:z.string().min(1).max(16000)})
function readTokens(value:unknown){const result=tokensSchema.safeParse(value);if(!result.success)throw new HttpError(502,'Grok Bot 授权服务返回的登录信息不完整，请重试。','grok_auth_response_invalid');return result.data}
interface Credential {accessToken:string;refreshToken?:string;account:string;subject?:string;version:string;expiresAt?:number;email?:string;name?:string;needsLogin?:boolean}
interface StoredAttempt extends Omit<GrokAuthAttempt,'loginUrl'> {requestId:string;uuid:string;challenge:string;sealedVerifier?:string;authVersion:number;epoch:number;expectedAccount?:string;nextPollAt:number;failures:number}
interface AuthOptions {
  fetcher?:typeof fetch;broker?:string;website?:string
  beforeChange?(owner:string,nextAccount?:string):void
  onChange?(owner:string,identityChanged:boolean):void
}
const digest=(v:string)=>createHash('sha256').update(v).digest('hex')
export function grokHeaders(accessToken:string,version:string){return {authorization:`Bearer ${accessToken}`,'content-type':'application/json','connect-protocol-version':'1','x-cursor-client-type':'sand','x-cursor-client-version':version,'x-sand-box-namespace':'prod','x-ghost-mode':'true'}}
function identity(accessToken:string){
  try{const value=JSON.parse(Buffer.from(accessToken.split('.')[1]!,'base64url').toString());if(typeof value.sub!=='string'||!value.sub||!Number.isFinite(value.exp)||value.exp*1000<=Date.now())throw new Error();return {subject:value.sub,account:digest(value.sub),expiresAt:value.exp*1000,...(typeof value.email==='string'?{email:value.email.slice(0,254)}:{})}}
  catch{throw new HttpError(400,'Grok Bot 返回的登录凭据无效或已过期，请重新授权。','grok_credential_invalid')}
}
/** Browser authorization follows Cursor's PKCE + authenticated polling flow.
 * The verifier, access token and refresh token are never sent to our clients. */
export class GrokAuth {
  private readonly fetcher:typeof fetch
  private readonly broker:string
  private readonly website:string
  private readonly polling=new Map<string,Promise<void>>()
  private readonly refreshing=new Map<string,Promise<Credential>>()
  private readonly requests=new Set<AbortController>()
  private readonly retryAfter=new Map<string,number>()
  private timer?:ReturnType<typeof setInterval>
  private closed=false
  constructor(readonly store:WorkspaceStore,readonly auth:LocalAuthStore,readonly nodes:WorkspaceNodes,readonly options:AuthOptions={}){
    this.fetcher=options.fetcher??fetch;this.broker=options.broker??'https://api2.cursor.sh';this.website=options.website??'https://cursor.com'
  }
  configured(owner:string){return !!this.store.get(owner,'grok-cloud','connection')}
  private read(owner:string):{sealed:string;value:Credential}|undefined {const row=this.store.get<{sealed:string}>(owner,'grok-cloud','connection');return row?{sealed:row.sealed,value:this.nodes.open<Credential>(row.sealed)}:undefined}
  private epoch(owner:string){return this.store.get<{value:number}>(owner,'grok-auth-epoch','current')?.value??0}
  private advance(owner:string){const value=this.epoch(owner)+1;this.store.put(owner,'grok-auth-epoch','current',{value});return value}
  private assertOwner(owner:string,version:number,epoch:number,admin=false){if(this.closed||!this.auth.isUserActive(owner)||(admin&&!this.auth.isAdminActive(owner))||this.auth.pushAuthorizationVersion(owner)!==version||this.epoch(owner)!==epoch)throw new HttpError(409,'这次 Grok Bot 授权已取消或账号权限已变化。','grok_auth_superseded')}
  private activeAttempt(owner:string,id?:string){const attempt=this.store.get<StoredAttempt>(owner,'grok-auth-attempt','current');if(!attempt||(id&&attempt.id!==id))throw new HttpError(404,'授权请求不存在或已被替换。','grok_auth_not_found');return attempt}
  private loginUrl(a:StoredAttempt){const url=new URL('/loginDeepControl',this.website);url.search=new URLSearchParams({challenge:a.challenge,uuid:a.uuid,mode:'login',redirectTarget:'cli'}).toString();return url.href}
  private publicAttempt(a:StoredAttempt):GrokAuthAttempt {return {id:a.id,status:a.status,expiresAt:a.expiresAt,...(a.status==='pending'?{loginUrl:this.loginUrl(a)}:{}),...(a.error?{error:a.error}:{})}}
  private expire(owner:string,attempt:StoredAttempt){if(attempt.status==='pending'&&attempt.expiresAt<=Date.now()){attempt.status='expired';attempt.error='授权链接已过期，请重新登录。';delete attempt.sealedVerifier;this.store.put(owner,'grok-auth-attempt','current',attempt)}}
  snapshot(owner:string):GrokAuthSnapshot {
    const credential=this.read(owner)?.value,attempt=this.store.get<StoredAttempt>(owner,'grok-auth-attempt','current')
    if(attempt)this.expire(owner,attempt)
    let expiresAt=credential?.expiresAt
    if(!expiresAt&&credential?.accessToken)try{expiresAt=identity(credential.accessToken).expiresAt}catch{}
    const expired=!!credential&&(credential.needsLogin||!credential.accessToken||((expiresAt??0)<=Date.now()&&!credential.refreshToken))
    const error=this.store.get<{message:string}>(owner,'grok-auth-error','current')?.message
    return {configured:!!credential,status:!credential?'disconnected':expired?'reauthorization-required':this.refreshing.has(owner)?'refreshing':'connected',automaticRefresh:!!credential?.refreshToken&&!credential.needsLogin,version:credential?.version??GROK_CLIENT_VERSION,...(credential?{account:{email:credential.email,name:credential.name},expiresAt}:{}),...(error?{error}:{}),...(attempt?{attempt:this.publicAttempt(attempt)}:{})}
  }
  private async request(url:string,init:RequestInit={}){
    const controller=new AbortController();this.requests.add(controller)
    try{return await this.fetcher(url,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])})}
    catch{throw new HttpError(503,'暂时无法连接 Grok Bot 授权服务，请稍后重试。','grok_auth_network')}
    finally{this.requests.delete(controller)}
  }
  private async body(response:Response){try{return await response.json() as Record<string,any>}catch{throw new HttpError(502,'Grok Bot 授权服务返回了无效数据。','grok_auth_response_invalid')}}
  private async verify(accessToken:string,version:string){
    const response=await this.request(this.broker+'/aiserver.v1.GrokBotService/GetSandBoxRunState',{method:'POST',headers:grokHeaders(accessToken,version),body:'{}'})
    if(response.ok){await this.body(response);return}
    if(!response.ok){const data=await this.body(response).catch(()=>({} as Record<string,any>));if(response.headers.get('x-automation-failure-hint')==='SAND_CLIENT_UPDATE_REQUIRED'||/version.*(?:supported|update)/i.test(String(data.message)))throw new HttpError(409,'Grok Bot 客户端协议版本需要更新，已有登录仍保留。','grok_client_update_required');throw new HttpError(response.status>=500?503:409,response.status>=500?'Grok Bot 服务暂不可用，请稍后重试。':'Grok Bot 未接受这次授权，请确认登录账号具有访问权限。','grok_authorization_failed')}
  }
  private async profile(accessToken:string,version:string){
    try{const response=await this.request(this.broker+'/aiserver.v1.DashboardService/GetMe',{method:'POST',headers:grokHeaders(accessToken,version),body:'{}'});if(!response.ok)return {};const me=await this.body(response);return {...(typeof me.email==='string'?{email:me.email.slice(0,254)}:{}),name:[me.firstName,me.lastName].filter(v=>typeof v==='string').join(' ').slice(0,100)||undefined}}
    catch{return {}}
  }
  private commit(owner:string,credential:Credential){
    this.store.atomic(()=>{
      const old=this.read(owner)?.value,claim=this.store.get<{owner:string}>('_system','grok-account',credential.account)
      if(claim&&claim.owner!==owner)throw new HttpError(409,'该 Grok Bot 账号已连接其他用户，不能共享登录授权。','grok_account_in_use')
      this.options.beforeChange?.(owner,credential.account)
      if(old&&old.account!==credential.account&&this.store.get<{owner:string}>('_system','grok-account',old.account)?.owner===owner)this.store.remove('_system','grok-account',old.account)
      this.store.put(owner,'grok-cloud','connection',{sealed:this.nodes.seal(credential)});this.store.put('_system','grok-account',credential.account,{owner})
      this.store.remove(owner,'grok-auth-error','current');this.retryAfter.delete(owner);this.options.onChange?.(owner,old?.account!==credential.account)
    })
  }
  async configure(owner:string,accessToken:string,version=GROK_CLIENT_VERSION,refreshToken?:string){
    version=parse(versionSchema,version)
    const who=identity(accessToken),epoch=this.epoch(owner),authVersion=this.auth.pushAuthorizationVersion(owner)??0
    this.options.beforeChange?.(owner,who.account)
    await this.verify(accessToken,version);const profile=await this.profile(accessToken,version)
    this.store.atomic(()=>{this.assertOwner(owner,authVersion,epoch);this.commit(owner,{accessToken,refreshToken,version,...who,...profile});this.advance(owner);this.store.remove(owner,'grok-auth-attempt','current')})
    return this.snapshot(owner)
  }
  begin(owner:string,requestId:string){
    const current=this.store.get<StoredAttempt>(owner,'grok-auth-attempt','current')
    if(current?.requestId===requestId){this.expire(owner,current);return this.snapshot(owner)}
    if(current?.status==='pending'&&current.expiresAt>Date.now())throw new HttpError(409,'已有进行中的授权，请继续完成或先取消。','grok_auth_pending')
    const verifier=randomBytes(32).toString('base64url'),uuid=randomUUID(),epoch=this.advance(owner)
    const attempt:StoredAttempt={id:randomUUID(),requestId,uuid,challenge:createHash('sha256').update(verifier).digest('base64url'),sealedVerifier:this.nodes.seal({verifier}),status:'pending',expiresAt:Date.now()+LOGIN_TTL,authVersion:this.auth.pushAuthorizationVersion(owner)??0,epoch,expectedAccount:this.read(owner)?.value.account,nextPollAt:Date.now(),failures:0}
    this.assertOwner(owner,attempt.authVersion,epoch,true)
    this.store.put(owner,'grok-auth-attempt','current',attempt)
    return this.snapshot(owner)
  }
  cancel(owner:string,id:string){const attempt=this.activeAttempt(owner,id);if(attempt.status==='pending'){this.advance(owner);attempt.status='cancelled';attempt.error=undefined;delete attempt.sealedVerifier;this.store.put(owner,'grok-auth-attempt','current',attempt)}return this.snapshot(owner)}
  async poll(owner:string,id:string){
    const a=this.activeAttempt(owner,id);this.expire(owner,a)
    if(a.status!=='pending')return this.snapshot(owner)
    const existing=this.polling.get(owner);if(existing){await existing;return this.snapshot(owner)}
    const work=this.pollOnce(owner,a).finally(()=>{if(this.polling.get(owner)===work)this.polling.delete(owner)})
    this.polling.set(owner,work);await work;return this.snapshot(owner)
  }
  private async pollOnce(owner:string,attempt:StoredAttempt){
    const current=()=>{const a=this.activeAttempt(owner,attempt.id);this.expire(owner,a);this.assertOwner(owner,a.authVersion,a.epoch,true);if(a.status!=='pending')throw new HttpError(409,'授权请求已结束。','grok_auth_superseded');return a}
    try{
      current()
      const {verifier}=this.nodes.open<{verifier:string}>(attempt.sealedVerifier!)
      const url=new URL('/auth/poll',this.broker);url.search=new URLSearchParams({uuid:attempt.uuid,verifier}).toString()
      const response=await this.request(url.href,{headers:{'content-type':'application/json'}})
      const active=current()
      if(response.status===404||response.status===202){active.failures=0;active.error=undefined;active.nextPollAt=Date.now()+2000;this.store.put(owner,'grok-auth-attempt','current',active);return}
      if(!response.ok){if(response.status===429||response.status>=500)throw new HttpError(503,'授权服务暂时繁忙，正在重试。','grok_auth_network');throw new HttpError(409,'授权被拒绝或登录已失效，请重新登录。','grok_authorization_failed')}
      const raw=await this.body(response),parsed=readTokens({accessToken:raw.accessToken??raw.access_token,refreshToken:raw.refreshToken??raw.refresh_token}),who=identity(parsed.accessToken)
      if(active.expectedAccount&&active.expectedAccount!==who.account)throw new HttpError(409,'请使用当前已连接的 Grok Bot 账号重新授权；切换账号前请先断开连接。','grok_account_mismatch')
      const version=this.read(owner)?.value.version??GROK_CLIENT_VERSION
      await this.verify(parsed.accessToken,version);const profile=await this.profile(parsed.accessToken,version)
      this.store.atomic(()=>{const final=current();this.commit(owner,{...parsed,version,...who,...profile});final.status='complete';final.error=undefined;delete final.sealedVerifier;this.store.put(owner,'grok-auth-attempt','current',final)})
    }catch(error){
      if(this.closed)return
      const latest=this.store.get<StoredAttempt>(owner,'grok-auth-attempt','current')
      if(!latest||latest.id!==attempt.id||latest.status!=='pending'||latest.epoch!==this.epoch(owner))return
      latest.failures++;latest.error=error instanceof HttpError?error.message:'授权未能完成，请重试。'
      if(error instanceof HttpError&&error.code==='grok_auth_network'&&latest.expiresAt>Date.now()){latest.nextPollAt=Date.now()+Math.min(30000,2000*2**Math.min(latest.failures,4))}
      else{latest.status='failed';delete latest.sealedVerifier}
      this.store.put(owner,'grok-auth-attempt','current',latest)
    }
  }
  async credentials(owner:string,forceRefresh=false):Promise<Credential>{
    if(!this.auth.isUserActive(owner))throw new HttpError(403,'当前账号不可用。','grok_auth_forbidden')
    const stored=this.read(owner)
    if(!stored||stored.value.needsLogin||!stored.value.accessToken)throw new HttpError(409,'请登录 Grok Bot 完成授权。','grok_login_required')
    const value=stored.value,expiresAt=value.expiresAt??(()=>{try{return identity(value.accessToken).expiresAt}catch{return 0}})()
    if(!forceRefresh&&expiresAt>Date.now()+REFRESH_LEEWAY)return value
    if(!value.refreshToken){if(expiresAt>Date.now()&&!forceRefresh)return value;this.invalidate(owner,stored.sealed,'当前连接缺少自动续期授权，请重新登录 Grok Bot。');throw new HttpError(409,'Grok Bot 登录已过期，请重新授权。','grok_login_required')}
    const pending=this.refreshing.get(owner);if(pending)return pending
    if(!forceRefresh&&(this.retryAfter.get(owner)??0)>Date.now()){if(expiresAt>Date.now())return value;throw new HttpError(503,'Grok Bot 自动续期暂不可用，正在等待重试。','grok_auth_network')}
    const work=this.refresh(owner,stored).finally(()=>{if(this.refreshing.get(owner)===work)this.refreshing.delete(owner)})
    this.refreshing.set(owner,work);return work
  }
  private invalidate(owner:string,sealed:string,message:string){const current=this.read(owner);if(current?.sealed!==sealed)return;this.store.put(owner,'grok-cloud','connection',{sealed:this.nodes.seal({...current.value,accessToken:'',refreshToken:undefined,needsLogin:true})});this.store.put(owner,'grok-auth-error','current',{message});this.options.onChange?.(owner,true)}
  private async refresh(owner:string,stored:{sealed:string;value:Credential}){
    const authVersion=this.auth.pushAuthorizationVersion(owner)??0
    const assertCurrent=()=>{if(this.closed||!this.auth.isUserActive(owner)||this.auth.pushAuthorizationVersion(owner)!==authVersion||this.read(owner)?.sealed!==stored.sealed)throw new HttpError(409,'Grok Bot 连接已更新，旧续期结果已丢弃。','grok_auth_superseded')}
    try{
      assertCurrent()
      const response=await this.request(this.broker+'/oauth/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:CLIENT_ID,grant_type:'refresh_token',refresh_token:stored.value.refreshToken})})
      assertCurrent();const body=await this.body(response)
      if(response.status===429||response.status>=500)throw new HttpError(503,'Grok Bot 自动续期暂不可用，已有连接保留。','grok_auth_network')
      if(!response.ok||body.shouldLogout===true||body.error==='invalid_grant'){
        this.invalidate(owner,stored.sealed,'Grok Bot 已撤销登录授权，请重新登录。');throw new HttpError(409,'Grok Bot 登录授权已失效，请重新登录。','grok_login_required')
      }
      const parsed=readTokens({accessToken:body.access_token,refreshToken:body.refresh_token??stored.value.refreshToken}),who=identity(parsed.accessToken)
      if(who.account!==stored.value.account){this.invalidate(owner,stored.sealed,'续期账号与原账号不一致，请重新授权。');throw new HttpError(409,'Grok Bot 续期账号不匹配。','grok_account_mismatch')}
      assertCurrent();const value={...stored.value,...parsed,...who};this.store.put(owner,'grok-cloud','connection',{sealed:this.nodes.seal(value)});this.store.remove(owner,'grok-auth-error','current');this.retryAfter.delete(owner);return value
    }catch(error){
      if(error instanceof HttpError&&['grok_auth_network','grok_auth_response_invalid'].includes(error.code??'')&&this.read(owner)?.sealed===stored.sealed){this.retryAfter.set(owner,Date.now()+15000);this.store.put(owner,'grok-auth-error','current',{message:error.message});try{if(identity(stored.value.accessToken).expiresAt>Date.now())return stored.value}catch{}}
      throw error
    }
  }
  disconnect(owner:string){
    this.options.beforeChange?.(owner,undefined)
    this.store.atomic(()=>{this.advance(owner);const old=this.read(owner)?.value;if(old&&this.store.get<{owner:string}>('_system','grok-account',old.account)?.owner===owner)this.store.remove('_system','grok-account',old.account);this.store.remove(owner,'grok-cloud','connection');this.store.remove(owner,'grok-auth-error','current');this.store.remove(owner,'grok-auth-attempt','current');this.retryAfter.delete(owner);this.options.onChange?.(owner,true)})
    return this.snapshot(owner)
  }
  start(){if(this.timer)return;const tick=()=>{if(this.closed)return;for(const owner of this.store.owners()){const a=this.store.get<StoredAttempt>(owner,'grok-auth-attempt','current');if(a?.status==='pending'&&a.nextPollAt<=Date.now())void this.poll(owner,a.id).catch(()=>{})}};tick();this.timer=setInterval(tick,1000);this.timer.unref()}
  close(){this.closed=true;clearInterval(this.timer);for(const request of this.requests)request.abort()}
  router(){const router=new Router()
    router.get('/api/app/grok-cloud/auth',ctx=>{ctx.set('Cache-Control','no-store');ctx.body=this.snapshot(this.auth.require(ctx).id)})
    router.post('/api/app/grok-cloud/auth/start',ctx=>{const owner=this.auth.requireAdmin(ctx).id,input=parse(z.object({requestId:z.string().uuid()}).strict(),(ctx.request as any).body);ctx.body=this.begin(owner,input.requestId)})
    router.post('/api/app/grok-cloud/auth/:id/poll',async ctx=>{const owner=this.auth.requireAdmin(ctx).id;ctx.body=await this.poll(owner,parse(z.string().uuid(),ctx.params.id))})
    router.post('/api/app/grok-cloud/auth/:id/cancel',ctx=>{const owner=this.auth.requireAdmin(ctx).id;ctx.body=this.cancel(owner,parse(z.string().uuid(),ctx.params.id))})
    router.delete('/api/app/grok-cloud/auth',ctx=>{ctx.body=this.disconnect(this.auth.require(ctx).id)})
    return router
  }
}
