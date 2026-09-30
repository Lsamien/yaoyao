// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type Koa from 'koa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { LocalAuthStore } from '../../src/server/localAuth'
import type { ServerConfig } from '../../src/server/config'
const runtimes:ApplicationRuntime[]=[],homes:string[]=[]
function context():Koa.Context{const headers:Record<string,any>={};return {state:{},get:()=>'',set:(k:string,v:any)=>{headers[k.toLowerCase()]=v},response:{headers}} as any}
function cookie(response:any){const values=response.headers['set-cookie'];return (Array.isArray(values)?values:[values]).filter(Boolean).map((v:string)=>v.split(';')[0]).join('; ')}
async function fixture(){
  const home=mkdtempSync(join(tmpdir(),'yaoyao-vault-routes-'));homes.push(home)
  const auth=new LocalAuthStore(home),login=context();auth.setupAdmin(login,'dummy-admin','DUMMY-only-login-password')
  const config={host:'127.0.0.1',port:15300,upstream:new URL('http://127.0.0.1:9119'),allowedHosts:new Set(),home,mediaRoot:join(home,'media'),attachmentsRoot:join(home,'attachments'),imagesRoot:join(home,'images'),mediaOwner:'dummy',allowInsecureLan:false,insecureLan:false,production:true} as ServerConfig
  const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({profiles:['default']}),{headers:{'content-type':'application/json'}})) as unknown as typeof fetch
  const runtime=createApplication({config,auth,fetchImpl});runtimes.push(runtime)
  const callback=runtime.app.callback(),bootstrap=await request(callback).get('/api/app/bootstrap?inspectOnly=1').set('Host','127.0.0.1:15300').set('Cookie',cookie(login.response)).expect(200)
  const cookies=cookie(login.response)+'; '+cookie(bootstrap),token=bootstrap.body.csrfToken
  return {runtime,callback,fetchImpl,cookies,token,mutation:(path:string)=>request(callback).post(path).set('Host','127.0.0.1:15300').set('Cookie',cookies).set('Origin','http://127.0.0.1:15300').set('X-CSRF-Token',token)}
}
afterEach(()=>{runtimes.splice(0).forEach(r=>r.close());homes.splice(0).forEach(h=>rmSync(h,{recursive:true,force:true}));vi.restoreAllMocks()})
it('vault routes enforce authentication, exact Origin and CSRF and stay offline without configuration',async()=>{
  const f=await fixture()
  await request(f.callback).get('/api/app/vault').set('Host','127.0.0.1:15300').expect(401)
  const status=await request(f.callback).get('/api/app/vault').set('Host','127.0.0.1:15300').set('Cookie',f.cookies).expect(200)
  expect(status.body).toMatchObject({online:false,unlocked:false,execution:'disabled',entries:[]});expect(status.headers['cache-control']).toBe('no-store')
  await request(f.callback).post('/api/app/vault/unlock').set('Host','127.0.0.1:15300').set('Cookie',f.cookies).set('Origin','http://127.0.0.1:15300').send({password:'DUMMY-master'}).expect(403)
  await f.mutation('/api/app/vault/unlock').set('Origin','https://evil.test').send({password:'DUMMY-master'}).expect(403)
  const response=await f.mutation('/api/app/vault/unlock').send({password:'DUMMY-master'}).expect(503)
  expect(response.body.code).toBe('vault_offline');expect(JSON.stringify(response.body)).not.toContain('DUMMY-master');expect(f.fetchImpl).not.toHaveBeenCalled()
})
it.each(['/api/app/logout','/auth/logout'])('logout path %s revokes vault before invalidating the authenticated session',async path=>{
  const f=await fixture(),logout=vi.spyOn(f.runtime.credentialVault,'logout').mockImplementation(async(owner,c)=>{expect(f.runtime.auth.currentFromCookieHeader(c)?.id).toBe(owner)})
  await f.mutation(path).send({}).expect(200);expect(logout).toHaveBeenCalledOnce()
  await request(f.callback).get('/api/app/vault').set('Host','127.0.0.1:15300').set('Cookie',f.cookies).expect(401)
})
