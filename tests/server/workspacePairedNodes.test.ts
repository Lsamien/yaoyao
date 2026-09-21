// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceNodes, type WorkspaceNode } from '../../src/server/workspaceGateway'
import { parseWorkspacePairCode } from '../../src/server/workspacePairedNode'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { loadServerConfig } from '../../src/server/config'
import { UpstreamClient } from '../../src/server/upstream'
import { UpstreamServiceSession } from '../../src/server/localAuth'

const remote = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222',
  pairing = '33333333-3333-4333-8333-333333333333', channel = '44444444-4444-4444-8444-444444444444', fingerprint = 'f'.repeat(64)
const homes: string[] = [], stores: WorkspaceStore[] = [], clients: UpstreamClient[] = [], nodeStores: WorkspaceNodes[] = []
afterEach(() => { nodeStores.forEach(n => n.close()); clients.forEach(c => c.close()); stores.forEach(s => s.close()); homes.forEach(h => rmSync(h, { recursive: true, force: true })); homes.length = stores.length = clients.length = nodeStores.length = 0 })
function code() { const url = new URL('yaoyao://pair'); for (const [k,v] of Object.entries({v:'1', url:'http://192.168.1.10:15300/', node:remote, id:pairing, fingerprint, secret:'s'.repeat(64)})) url.searchParams.set(k,v); return url.href }
function setup(localID?: string) {
  const home = mkdtempSync(join(tmpdir(), 'workspace-child-')); homes.push(home)
  const config = loadServerConfig({ HERMES_YAOYAO_HOME: home }), store = new WorkspaceStore(home); stores.push(store)
  const seen: Array<{url: URL; headers: Headers; body: any}> = []
  let mismatch = false, lostCommandResponse = false, remoteRules = 'remote rules v1'
  const fetchImpl = (async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input)), headers = new Headers(init.headers), body = init.body ? JSON.parse(String(init.body)) : undefined
    seen.push({url,headers,body})
    if (url.pathname === '/api/pair/v1/capabilities') return Response.json({protocolVersion:1,serviceType:'yaoyao-web',nodeId:remote,fingerprint:mismatch ? 'x'.repeat(64) : fingerprint})
    if (url.pathname === '/api/pair/v1/claim') return Response.json({protocolVersion:1,serviceType:'yaoyao-web',nodeId:remote,fingerprint,deviceId:device,token:'delegated-token',scopes:['agents.read','history.read','sessions.execute'],serverUrl:`http://192.168.1.10:15300/node/${device}`})
    expect(headers.get('authorization')).toBe('Bearer delegated-token')
    expect(url.pathname).toContain(`/node/${device}/api/`)
    if (url.pathname.endsWith('/api/workspace-agents')) return Response.json({agents:[{id:'66666666-6666-4666-8666-666666666666',name:'远端现成 Agent',avatar:'',instructions:remoteRules,nodeId:'local',profile:'remote-profile',archived:false,revision:1,createdAt:1,updatedAt:1}]})
    if (url.pathname.endsWith('/profiles')) return Response.json({profiles:[{name:'remote-profile',display_name:'远端基础 Agent'}]})
    if (url.pathname.endsWith('/channels')) return Response.json({id:channel})
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('id: epoch:1\nevent: frame\ndata: '+JSON.stringify({method:'event',params:{type:'gateway.ready'}})+'\n\n'))
      init.signal?.addEventListener('abort', () => { try { controller.close() } catch {} })
    }}), {headers:{'Content-Type':'text/event-stream'}})
    if (url.pathname.endsWith('/commands') && lostCommandResponse) throw new Error('response lost after admission')
    if (url.pathname.endsWith('/commands') || url.pathname.includes('/api/realtime/commands/')) return Response.json({state:'confirmed',response:{result:{session_id:'runtime-child',stored_session_id:'stored-child'}}})
    return new Response(null,{status:204})
  }) as typeof fetch
  const client = new UpstreamClient(config.upstream, fetchImpl); clients.push(client)
  const nodes = new WorkspaceNodes(store,config,{url:config.upstream,client,session:new UpstreamServiceSession(client,()=>undefined)},localID); nodeStores.push(nodes)
  return {home,store,nodes,seen,mismatch:()=>{mismatch=true},loseResponse:()=>{lostCommandResponse=true},changeRemoteRules:()=>{remoteRules='remote rules v2'}}
}
describe('workspace 15300 child nodes', () => {
  it('rejects login codes and duplicate identity fields', () => {
    expect(()=>parseWorkspacePairCode(code().replace('://pair','://login'))).toThrow()
    expect(()=>parseWorkspacePairCode(code()+'&node='+remote)).toThrow()
  })
  it('pairs only under the owner, encrypts credentials, preserves agent binding when changing IP, and refuses execution of a retired paired node', async () => {
    const t=setup(); await t.nodes.pair('parent-user',{qrPayload:code(),name:'远端'})
    const node=t.store.list<WorkspaceNode>('parent-user','node')[0]!
    expect(node.transport).toBe('paired-web'); expect(node.url).toContain(':15300')
    expect(node.secret).not.toContain('delegated-token'); expect(t.store.list('other-user','node')).toEqual([])
    expect(()=>t.nodes.target('other-user',node.id)).toThrow()
    const agent=t.store.createAgent('parent-user',{name:'策划',profile:'remote-profile',nodeId:node.id,instructions:''})
    await t.nodes.update('parent-user',node.id,{name:'新名字',url:'http://192.168.1.20:15300'})
    expect(t.store.require<any>('parent-user','agent',agent.id).nodeId).toBe(node.id)
    expect(()=>t.nodes.target('parent-user',node.id)).toThrow('远程机器人已停用')
    expect(t.seen.some(r=>r.url.pathname.endsWith('/commands'))).toBe(false)
  })
  it('refuses retired paired-node execution before issuing remote commands', async () => {
    const t=setup(); await t.nodes.pair('owner',{qrPayload:code(),name:'child'})
    const id=t.store.list<WorkspaceNode>('owner','node')[0]!.id
    t.seen.length=0
    expect(()=>t.nodes.target('owner',id)).toThrow('远程机器人已停用')
    expect(t.seen).toEqual([])
  })
  it('rejects self-pairing before redeeming a code', async () => {
    const t=setup(remote)
    await expect(t.nodes.pair('owner',{qrPayload:code(),name:'self'})).rejects.toThrow('自己')
    expect(t.seen).toEqual([])
  })
  it('refuses importing retired remote agents without creating local references', async () => {
    const t=setup();await t.nodes.pair('owner',{qrPayload:code(),name:'child'})
    const node=t.store.list<WorkspaceNode>('owner','node')[0]!, remote='66666666-6666-4666-8666-666666666666'
    t.seen.length=0
    await expect(t.nodes.importRemoteAgent('owner',node.id,remote)).rejects.toThrow('远程机器人已停用')
    expect(t.store.list('owner','agent')).toEqual([])
    expect(t.seen).toEqual([])
  })
  it('checks identity at the new address before sending the saved bearer and leaves state unchanged on mismatch', async () => {
    const t=setup(); await t.nodes.pair('owner',{qrPayload:code(),name:'远端'})
    const node=t.store.list<WorkspaceNode>('owner','node')[0]!; t.seen.length=0; t.mismatch()
    await expect(t.nodes.update('owner',node.id,{name:'错误目标',url:'http://192.168.1.99:15300'})).rejects.toThrow('身份')
    expect(t.store.require<WorkspaceNode>('owner','node',node.id).url).toBe(node.url)
    expect(t.seen).toHaveLength(1); expect(t.seen[0]!.headers.has('authorization')).toBe(false)
  })
})
