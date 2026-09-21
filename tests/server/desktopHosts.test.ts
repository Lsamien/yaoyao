// @vitest-environment node
import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import Koa from 'koa'
import {bodyParser} from '@koa/bodyparser'
import request from 'supertest'
import {WorkspaceStore} from '../../src/server/workspaceStore'
import {DesktopHostHub} from '../../src/server/desktopHosts'
import type {DesktopHostExchange} from '../../src/shared/desktopHost'
let home:string,store:WorkspaceStore,hub:DesktopHostHub,token:string,hostId:string,exchanged:DesktopHostExchange[]
const auth={requireAdmin:()=>({id:'admin',role:'admin'}),require:()=>({id:'owner'})} as any
const body=():DesktopHostExchange=>({host:{id:'11111111-1111-4111-8111-111111111111',name:'书房 iMac',platform:'darwin',screen:true,accessibility:true,approved:[]},results:[]})
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'desktop-hosts-'));store=new WorkspaceStore(home);hub=new DesktopHostHub(store,auth);exchanged=[];hub.exchange=(id,value)=>{exchanged.push(value);hostId=id;return {commands:[]}}})
afterEach(()=>{hub.close();store.close();rmSync(home,{recursive:true,force:true})})
const app=()=>{const a=new Koa();a.use(async(ctx,next)=>{try{await next()}catch(e:any){ctx.status=e.status??500;ctx.body={error:e.message,code:e.code}}});a.use((ctx,next)=>ctx.path.startsWith('/api/app/')?bodyParser()(ctx,next):next());a.use(hub.middleware());a.use(hub.adminRouter().routes());return a.callback()}
async function enroll(name='书房 iMac'){const response=await request(app()).post('/api/app/admin/desktop-hosts').send({name}).expect(201);token=response.body.token;hostId=response.body.host.id;return response.body}
const post=(url:string)=>request(app()).post(url).set('Authorization','Bearer '+token).set('x-desktop-host-protocol','1')
it('issues the token once and keeps it out of listings',async()=>{
  const enrolled=await enroll()
  expect(token).toMatch(/^[\w-]{40,}$/)
  expect(enrolled.host).not.toHaveProperty('tokenHash')
  const list=(await request(app()).get('/api/app/admin/desktop-hosts').expect(200)).body
  expect(list.protocol).toBe(1)
  expect(JSON.stringify(list)).not.toContain(token)
  expect(list.hosts).toHaveLength(1)
  expect(list.hosts[0]).toMatchObject({name:'书房 iMac',enabled:true,online:false})
})
it('rejects unauthorized transports before parsing the body',async()=>{
  await enroll()
  await request(app()).post(`/api/desktop-host/v1/${hostId}/exchange`).send(body()).expect(403)
  await post(`/api/desktop-host/v1/${hostId}/exchange`).set('Origin','http://evil.test').send(body()).expect(403)
  await request(app()).post(`/api/desktop-host/v1/${hostId}/exchange`).set('Authorization','Bearer wrong-token-wrong-token-wrong').set('x-desktop-host-protocol','1').send(body()).expect(403)
  await request(app()).post(`/api/desktop-host/v1/11111111-2222-4333-8444-555555555555/exchange`).set('Authorization','Bearer '+token).set('x-desktop-host-protocol','1').send(body()).expect(403)
})
it('requires the machine protocol header and POST method',async()=>{
  await enroll()
  await request(app()).post(`/api/desktop-host/v1/${hostId}/exchange`).set('Authorization','Bearer '+token).send(body()).expect(409)
  await request(app()).get(`/api/desktop-host/v1/${hostId}/exchange`).set('Authorization','Bearer '+token).set('x-desktop-host-protocol','1').send(body()).expect(405)
})
it('forwards a valid exchange to the desktop environment and reports it online',async()=>{
  await enroll()
  const response=await post(`/api/desktop-host/v1/${hostId}/exchange`).send(body()).expect(200)
  expect(response.body).toEqual({commands:[]})
  expect(exchanged).toHaveLength(1)
  expect(exchanged[0].host.name).toBe('书房 iMac')
  const list=(await request(app()).get('/api/app/admin/desktop-hosts').expect(200)).body
  expect(list.hosts[0]).toMatchObject({online:true,hostName:'书房 iMac',platform:'darwin'})
})
it('revocation fences the transport and notifies the live session',async()=>{
  const dropped:string[]=[]
  hub.drop=id=>dropped.push(id)
  await enroll()
  await post(`/api/desktop-host/v1/${hostId}/exchange`).send(body()).expect(200)
  await request(app()).delete(`/api/app/admin/desktop-hosts/${hostId}`).expect(200)
  expect(dropped).toEqual([hostId])
  await post(`/api/desktop-host/v1/${hostId}/exchange`).send(body()).expect(403)
})
it('renames the local computer and a paired host without touching the token', async () => {
  await enroll()
  const local = await request(app()).put('/api/app/admin/desktop-hosts/local/name').send({ name: '工作室' }).expect(200)
  expect(local.body).toEqual({ id: 'local', name: '工作室' })
  const renamed = await request(app()).put(`/api/app/admin/desktop-hosts/${hostId}/name`).send({ name: '前台' }).expect(200)
  expect(renamed.body.name).toBe('前台')
  const list = (await request(app()).get('/api/app/admin/desktop-hosts').expect(200)).body
  expect(list.localName).toBe('工作室')
  expect(list.hosts[0].displayName).toBe('前台')
  expect(JSON.stringify(list)).not.toContain(token)
})
it('validates the exchange payload shape',async()=>{
  await enroll()
  await post(`/api/desktop-host/v1/${hostId}/exchange`).send({host:{id:'not-a-uuid',name:'x',platform:'darwin',screen:true,accessibility:true,approved:[]},results:[]}).expect(400)
  await post(`/api/desktop-host/v1/${hostId}/exchange`).send('string').expect(400)
})

it('reuses the same computer when the installed Mac logs in again',async()=>{
  const installId = '22222222-2222-4222-8222-222222222222'
  const first = await request(app()).post('/api/app/admin/desktop-hosts').send({ name: '书房 iMac', installId }).expect(201)
  const again = await request(app()).post('/api/app/admin/desktop-hosts').send({ name: '书房 iMac', installId }).expect(201)
  expect(again.body.host.id).toBe(first.body.host.id)
  expect(again.body.token).not.toBe(first.body.token)
  const list = (await request(app()).get('/api/app/admin/desktop-hosts').expect(200)).body
  expect(list.hosts.filter((host: { enabled: boolean }) => host.enabled)).toHaveLength(1)
})

it('re-enables the exact disabled legacy computer after an explicit administrator login',async()=>{
  const first=await request(app()).post('/api/app/admin/desktop-hosts').send({name:'旧版 Mac'}).expect(201)
  await request(app()).delete(`/api/app/admin/desktop-hosts/${first.body.host.id}`).expect(200)
  const installId='33333333-3333-4333-8333-333333333333'
  const restored=await request(app()).post('/api/app/admin/desktop-hosts').send({name:'旧版 Mac',installId,previousHostId:first.body.host.id}).expect(201)
  expect(restored.body.host).toMatchObject({id:first.body.host.id,installId,enabled:true})
  expect(restored.body.token).not.toBe(first.body.token)
  const list=(await request(app()).get('/api/app/admin/desktop-hosts').expect(200)).body
  expect(list.hosts).toHaveLength(1)
  expect(list.hosts[0]).toMatchObject({id:first.body.host.id,installId,enabled:true})
  await request(app()).post(`/api/desktop-host/v1/${first.body.host.id}/exchange`)
    .set('Authorization','Bearer '+first.body.token)
    .set('x-desktop-host-protocol','1')
    .send(body())
    .expect(403)
})

it('admits optional negotiated environment facts through the same remote transport schema',async()=>{
 await enroll()
 const input=body()
 input.host.fileTransferVersion=1
 input.host.environment={version:1,osRelease:'25.0.0',arch:'arm64',shell:'/bin/zsh',homeDirectory:'/Users/fixture',defaultCwd:'/Users/fixture',fileRoots:['/Users/fixture'],shellScope:'user',timezone:'Asia/Shanghai'}
 await post(`/api/desktop-host/v1/${hostId}/exchange`).send(input).expect(200)
 expect(exchanged[0]?.host.environment).toEqual(input.host.environment)
 await post(`/api/desktop-host/v1/${hostId}/exchange`).send({...input,host:{...input.host,environment:{...input.host.environment,token:'must-not-be-metadata'}}}).expect(400)
 expect(exchanged).toHaveLength(1)
})
