// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../../src/server/workspaceStore.js'
import { readServerIdentity, updateServerIdentity } from '../../src/server/serverIdentity.js'
import { createAuthenticatedApplication, createUserAuthenticatedApplication } from './authenticatedApplication.js'
import type { ServerConfig } from '../../src/server/config.js'

const homes: string[] = []
const close: Array<() => void> = []
const home = () => { const path=mkdtempSync(join(tmpdir(),'server-name-'));homes.push(path);return path }
const store = (path=home()) => { const s=new WorkspaceStore(path);close.push(()=>s.close());return s }
afterEach(()=>{for(const f of close.splice(0).reverse())f();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true})})
describe('server identity',()=>{
  it('persists one name across accounts and restarts without changing the server id',()=>{
    const path=home(),s=store(path),initial=readServerIdentity(s)
    const saved=updateServerIdentity(s,{name:'  家里的 Mac  ',expectedRevision:0})
    expect(saved).toEqual({...initial,name:'家里的 Mac',displayName:'家里的 Mac',revision:1})
    expect(readServerIdentity(store(path))).toEqual(saved)
    expect(updateServerIdentity(s,{name:'家里的 Mac',expectedRevision:1})).toEqual(saved)
  })
  it('clears to the server hostname and rejects a stale edit',()=>{
    const s=store();updateServerIdentity(s,{name:'办公室',expectedRevision:0})
    expect(()=>updateServerIdentity(s,{name:'旧草稿',expectedRevision:0})).toThrow(/其他端更新/)
    expect(readServerIdentity(s).name).toBe('办公室')
    expect(updateServerIdentity(s,{name:'   ',expectedRevision:1})).toMatchObject({name:'',displayName:hostname(),revision:2})
  })
  it('rejects invalid values without changing the persisted revision',()=>{
    const s=store()
    for(const input of [{name:3},{name:'a'.repeat(101)},{name:'a\nb'},{name:'a\u0000b'},{name:'ok',expectedRevision:-1},{name:'ok',unexpected:1}])expect(()=>updateServerIdentity(s,input)).toThrow()
    expect(readServerIdentity(s).revision).toBe(0)
  })
  it('keeps independent servers separate',()=>{
    const a=store(),b=store();updateServerIdentity(a,{name:'A'})
    expect(()=>updateServerIdentity(b,{name:'错误目标',expectedServerId:readServerIdentity(a).serverId})).toThrow(/服务器连接已切换/)
    expect(readServerIdentity(b).name).toBe('');expect(readServerIdentity(a).serverId).not.toBe(readServerIdentity(b).serverId)
  })
  it('allows authenticated reads, admin saves, and includes updates in existing poll responses',async()=>{
    const path=home()
    const config:ServerConfig={home:path,host:'127.0.0.1',port:15300,upstream:new URL('http://127.0.0.1:19124'),allowedHosts:new Set(),mediaRoot:path,attachmentsRoot:path,imagesRoot:path,mediaOwner:'fixture',allowInsecureLan:false,insecureLan:false,production:false}
    const fetchImpl=async()=>new Response(JSON.stringify({state:'ready',profiles:[],auth_required:false}),{headers:{'Content-Type':'application/json'}})
    const admin=createAuthenticatedApplication({config,fetchImpl:fetchImpl as typeof fetch});close.push(()=>admin.close())
    const agent=request.agent(admin.app.callback())
    const bootstrap=await agent.get('/api/app/bootstrap').set('Host','127.0.0.1:15300').expect(200)
    const saved=await agent.put('/api/app/server-identity').set('Host','127.0.0.1:15300').set('Origin','http://127.0.0.1:15300').set('X-CSRF-Token',bootstrap.body.csrfToken).send({name:'共享服务器',expectedRevision:0}).expect(200)
    expect((await agent.get('/api/app/events?after=0').set('Host','127.0.0.1:15300').expect(200)).body.serverIdentity).toEqual(saved.body)
    const member=createUserAuthenticatedApplication({config,fetchImpl:fetchImpl as typeof fetch});close.push(()=>member.close())
    const reader=request.agent(member.app.callback()),token=(await reader.get('/api/app/bootstrap').set('Host','127.0.0.1:15300')).body.csrfToken
    expect((await reader.get('/api/app/server-identity').set('Host','127.0.0.1:15300').expect(200)).body).toEqual(saved.body)
    await reader.put('/api/app/server-identity').set('Host','127.0.0.1:15300').set('Origin','http://127.0.0.1:15300').set('X-CSRF-Token',token).send({name:'无权限'}).expect(403)
  })
})
