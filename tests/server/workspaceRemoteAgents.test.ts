// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import { LocalAuthStore } from '../../src/server/localAuth'
let runtime: ApplicationRuntime, home:string, ws:WebSocketServer, frames:any[], forwarded:any[]
class Auth extends LocalAuthStore { override isUserActive(id:string) { return ['owner','other'].includes(id) } }
beforeEach(async()=>{
  home=mkdtempSync(join(tmpdir(),'remote-agent-export-'));frames=[];forwarded=[]
  ws=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise<void>(resolve=>ws.once('listening',resolve))
  ws.on('connection',socket=>{
    socket.send(JSON.stringify({method:'event',params:{type:'gateway.ready'}}))
    socket.on('message',raw=>{
      const frame=JSON.parse(String(raw));frames.push(frame)
      const result=['session.create','session.resume'].includes(frame.method) ? {session_id:randomUUID(),stored_session_id:frame.params.session_id ?? randomUUID(),info:{profile_name:frame.params.profile}}
        : frame.method==='session.cwd.set' ? {cwd:frame.params.cwd} : {ok:true}
      socket.send(JSON.stringify({id:frame.id,result}))
    })
  })
  const config=loadServerConfig({HERMES_YAOYAO_HOME:home,HERMES_YAOYAO_UPSTREAM:`http://127.0.0.1:${(ws.address() as any).port}`})
  runtime=createApplication({config,auth:new Auth(home),fetchImpl:(async(input,init={})=>{
    const url=new URL(String(input))
    if(url.hostname==='nested.test') {
      forwarded.push({path:url.pathname,headers:new Headers(init.headers),body:init.body?JSON.parse(String(init.body)):undefined})
      return Response.json(url.pathname.endsWith('/channels') ? {id:'55555555-5555-4555-8555-555555555555'} : {state:'confirmed',response:{result:{session_id:'runtime',stored_session_id:'stored'}}},{status:url.pathname.endsWith('/channels')?201:200})
    }
    if(url.pathname==='/api/auth/ws-ticket')return Response.json({ticket:'test-ticket'})
    if(url.pathname==='/api/config') {
      forwarded.push({path:url.pathname,profile:url.searchParams.get('profile'),headers:new Headers(init.headers)})
      return Response.json({terminal:{cwd:'/remote/'+url.searchParams.get('profile')}})
    }
    return Response.json({messages:[],profiles:[{name:'remote-profile'}]})
  }) as typeof fetch})
})
afterEach(async()=>{
  runtime.close();for(const client of ws.clients)client.terminate()
  await new Promise<void>(resolve=>ws.close(()=>resolve()));rmSync(home,{recursive:true,force:true})
})
function pair(owner?:string) {
  const code=runtime.pairings.create('delegated-native-cookie=test',undefined,owner)
  return runtime.pairings.claim({pairingID:code.id,secret:code.secret,deviceName:'parent'})
}
function call(grant:ReturnType<typeof pair>,method:'get'|'post'|'patch',path:string) {
  return request(runtime.app.callback())[method](`/node/${grant.device.id}/api/workspace-agents${path}`)
    .set('Host','127.0.0.1:15300').set('Authorization',`Bearer ${grant.token}`)
}
describe('referenced remote Bot Agents',()=>{
  it('lists only the QR issuing account and requires renewed authorization for legacy grants',async()=>{
    const agent=runtime.workspace.createAgent('owner',{name:'我的 Agent',profile:'remote-profile'})
    runtime.workspace.createAgent('other',{name:'其他账号私有 Agent',profile:'remote-profile'})
    const grant=pair('owner')
    expect((await call(grant,'get','').expect(200)).body.agents.map((a:any)=>a.id)).toEqual([agent.id])
    await call(pair(),'get','').expect(403)
    await call(grant,'patch',`/${agent.id}`).send({instructions:'overwrite'}).expect(405)
    runtime.pairings.revoke(grant.device.id)
    await call(grant,'get','').expect(401)
  })
  it('keeps the same delegated identity when renewing the QR grant',()=>{
    const old=pair()
    const qr=runtime.pairings.create('new-cookie=test',undefined,'owner')
    const renewed=runtime.pairings.claim({pairingID:qr.id,secret:qr.secret,deviceName:'parent',existingDeviceID:old.device.id,existingToken:old.token})
    expect(renewed.device.id).toBe(old.device.id);expect(renewed.token).toBe(old.token)
    expect(runtime.pairings.workspaceOwner(old.device.id,old.token,'agents.read')).toBe('owner')
  })
  it('executes using the remote profile and live remote rules, and isolates other Agent channels/history',async()=>{
    const agent=runtime.workspace.createAgent('owner',{name:'远端策划',profile:'remote-profile',instructions:'REMOTE RULE V1'})
    const other=runtime.workspace.createAgent('owner',{name:'另一 Agent',profile:'other-profile'})
    const grant=pair('owner'), base=`/${agent.id}/gateway/api/realtime`
    const channel=(await call(grant,'post',`${base}/channels`).send({channel:'chat'}).expect(201)).body.id
    async function rpc(method:string,params:any) {
      return call(grant,'post',`${base}/channels/${channel}/commands`).set('Idempotency-Key',randomUUID()).send({jsonrpc:'2.0',method,params})
    }
    const opened=await rpc('session.create',{profile:'wrong-profile',model:'overwrite',cwd:'/different',fast:true,reasoning_effort:'high',messages:[{role:'system',content:'override'}]})
    expect(opened.status).toBe(200)
    const result=opened.body.response.result
    expect(frames.at(-1).params.profile).toBe('remote-profile');expect(frames.at(-1).params.model).toBeUndefined();expect(frames.at(-1).params.cwd).toBe('/remote/remote-profile');expect(frames.at(-1).params.fast).toBeUndefined();expect(frames.at(-1).params.messages).toBeUndefined()
    expect((await rpc('prompt.submit',{session_id:result.session_id,text:'question'})).status).toBe(200)
    expect(frames.at(-1).params.text).toContain('REMOTE RULE V1')
    expect(frames.find(f=>f.method==='session.cwd.set')?.params.cwd).toBe('/remote/remote-profile')
    expect(forwarded.filter(f=>f.path==='/api/config').every(f=>f.profile==='remote-profile' && f.headers.get('cookie')?.includes('delegated-native-cookie=test'))).toBe(true)
    runtime.workspace.updateAgent('owner',agent.id,{instructions:'REMOTE RULE V2'})
    expect((await rpc('prompt.submit',{session_id:result.session_id,text:'next question'})).status).toBe(200)
    expect(frames.at(-1).params.text).toContain('REMOTE RULE V2');expect(frames.at(-1).params.text).not.toContain('REMOTE RULE V1')
    expect((await rpc('profiles.configure',{profile:'remote-profile'})).status).toBe(403)
    await call(grant,'get',`/${other.id}/gateway/api/realtime/channels/${channel}/events`).expect(403)
    await call(grant,'get',`/${agent.id}/gateway/api/sessions/foreign/messages`).expect(403)
    await call(grant,'get',`/${agent.id}/gateway/api/sessions/${result.stored_session_id}/messages`).expect(200)
    const next=(await call(grant,'post',`${base}/channels`).send({channel:'chat'}).expect(201)).body.id
    await call(grant,'post',`${base}/channels/${next}/commands`).set('Idempotency-Key',randomUUID())
      .send({jsonrpc:'2.0',method:'session.resume',params:{session_id:result.stored_session_id,profile:'wrong'}}).expect(200)
    runtime.workspace.updateAgent('owner',agent.id,{archived:true})
    await call(grant,'get',`/${agent.id}`).expect(410)
  })
  it('can reference an Agent backed by another paired child without exposing parent credentials',async()=>{
    const nodes=runtime.workspaceRuntime.nodes, nodeId=randomUUID(), childDevice=randomUUID()
    runtime.workspace.put('owner','node',nodeId,{id:nodeId,name:'nested',url:'http://nested.test:15300/',transport:'paired-web',deviceId:childDevice,secret:nodes.seal({token:'nested-secret'})})
    const agent=runtime.workspace.createAgent('owner',{name:'二级远端 Agent',profile:'remote-profile',nodeId,instructions:'nested rules'})
    const grant=pair('owner'), base=`/${agent.id}/gateway/api/realtime`
    const channel=(await call(grant,'post',`${base}/channels`).send({channel:'chat'}).expect(201)).body.id
    await call(grant,'post',`${base}/channels/${channel}/commands`).set('Idempotency-Key',randomUUID())
      .send({jsonrpc:'2.0',method:'session.create',params:{profile:'wrong'}}).expect(200)
    expect(forwarded.at(-1).headers.get('authorization')).toBe('Bearer nested-secret')
    expect(forwarded.at(-1).body.params.profile).toBe('remote-profile')
    expect(forwarded.at(-1).headers.get('x-yaoyao-agent-hops')).toBe('1')
  })
})
