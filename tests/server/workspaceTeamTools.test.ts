// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import type { WorkspaceNodes, GatewayTarget } from '../../src/server/workspaceGateway'
import { UploadStore } from '../../src/server/uploads'
import { HttpError } from '../../src/server/errors'
import { createWorkspaceToolLease, requireTeamToolBridge, type WorkspaceToolLease } from '../../src/server/workspaceToolLease'
import type { Work } from '../../src/server/workspaceScheduler'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceTask, WorkspaceRun } from '../../src/shared/workspace'

let home: string, store: WorkspaceStore, runtime: WorkspaceRuntime, uploads: UploadStore
let manager: WorkspaceAgent, work: Work, nodes: WorkspaceNodes, active: boolean
let denied: Set<string>, target: GatewayTarget, binding: Record<string, any> | undefined
let leases: WorkspaceToolLease[], upstream: Array<{ path: string; body: any }>
const owner = 'account-one'
const call = (tool: string, args: unknown = {}) => runtime.teamTools.call(owner, work.id, `workspace_${tool}`, args) as Promise<any>
const selfCall = (tool: 'get' | 'update', args: unknown = {}) => runtime.knowledgeTools.call(owner, work.id, `workspace_${tool}_self_rules`, args, false) as Promise<any>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-team-tools-'))
  store = new WorkspaceStore(home); uploads = new UploadStore(home)
  active = true; denied = new Set(); leases = []; upstream = []; binding = undefined
  target = {
    url: new URL('http://127.0.0.1:19119'),
    session: { request: vi.fn(async (path, options) => {
      upstream.push({ path, body: options?.body })
      if (path.endsWith('/bind')) binding = options!.body as Record<string, any>
      return { status: 200, body: Buffer.from(JSON.stringify(path.endsWith('/capabilities')
        ? { version: 1, ready: true, native_tools: true, in_process: true }
        : { ok: true, native_tools: true })), headers: new Headers() }
    }) },
  } as unknown as GatewayTarget
  nodes = {
    target: () => target,
    requireSource: (user: string, source: {profile: string}) => {
      if (user !== owner || denied.has(source.profile)) throw new HttpError(403, '未分配', 'agent_source_forbidden')
    },
    sources: async () => ({ sources: [{nodeId:'local',profile:'default',name:'基础 Agent'}, {nodeId:'local',profile:'writer',name:'写作'}], errors: [] }),
  } as unknown as WorkspaceNodes
  runtime = new WorkspaceRuntime(store, nodes, uploads, () => active)
  vi.spyOn(runtime, 'wake').mockImplementation(() => {})
  manager = store.createAgent(owner, {name:'老板',profile:'default',canManageTeam:true})
  const direct = store.list<WorkspaceConversation>(owner,'conversation')[0]!
  const run = runtime.send(owner,direct.id,{requestId:randomUUID(),content:'组建项目团队'})
  work = store.list<Work>(owner,'turn').find(w=>w.runId===run.id)!
  work.status = 'running'; work.teamManagementRevision=manager.revision; store.put(owner,'turn',work.id,work)
})
afterEach(async () => {
  await Promise.all(leases.map(lease => lease.dispose()))
  runtime.close(); uploads.close(); store.close()
  rmSync(home,{recursive:true,force:true})
})

async function buildTeam() {
  const member = (await call('create_agent',{requestId:randomUUID(),name:'研究员',profile:'writer'})).agent as WorkspaceAgent
  const created = await call('create_team',{requestId:randomUUID(),name:'项目团队',memberIds:[member.id]})
  return { member, team: created.team as WorkspaceConversation, task: created.task as WorkspaceTask }
}

describe('Agent-owned team tools', () => {
  it('only assembles members when creating a team, without goals or assignments', async () => {
    const before = store.list(owner,'run').length
    const {team,task} = await buildTeam()
    expect(store.tasks(owner,team.id)).toHaveLength(1)
    expect(task.goal).toBeUndefined()
    expect(store.list(owner,'goal')).toEqual([])
    expect(store.list(owner,'assignment')).toEqual([])
    expect(store.list(owner,'run')).toHaveLength(before)
  })
  it('promotes the current user conversation into a goal without creating another task or turn', async () => {
    const {team,task} = await buildTeam()
    const run = runtime.send(owner,team.id,{requestId:randomUUID(),taskId:task.id,content:'把这件事做完并交付报告'})
    work = store.list<Work>(owner,'turn').find(w=>w.runId===run.id)!
    work.status='running';work.teamManagementRevision=manager.revision;store.put(owner,'turn',work.id,work)
    const before = store.list(owner,'run').length
    const input = {requestId:randomUUID(),teamId:team.id,title:'报告',content:'交付报告',acceptanceCriteria:['包含结论和依据']}
    const started = await call('start_team_task',input)
    expect((await call('start_team_task',input)).task.id).toBe(task.id)
    expect(store.tasks(owner,team.id)).toHaveLength(1)
    expect(store.list(owner,'run')).toHaveLength(before)
    expect(started.run.goalId).toBe(task.id)
    const edited = await call('update_team_goal',{requestId:randomUUID(),goalId:task.id,expectedRevision:1,acceptanceCriteria:['包含三条结论及对应来源']})
    expect(edited.goal.acceptanceRevision).toBe(2)
    await expect(call('start_team_task',{...input,requestId:randomUUID()})).rejects.toMatchObject({code:'goal_exists'})
  })
  it('records creator authority and archives only an unused member it created',async()=>{
    const initialRules = { instructions:'核验任务结果', description:'负责事实核验', job:'核验资料', antiJobs:['不猜测结论'], voice:'rigorous', actBias:'ask_key_then_act' }
    const child=(await call('create_agent',{requestId:randomUUID(),name:'临时项目成员',profile:'default',...initialRules})).agent
    expect(child.createdByAgentId).toBe(manager.id)
    expect(store.require(owner,'agent',child.id)).toMatchObject(initialRules)
    for (const [field, value] of Object.entries(initialRules)) await expect(call('update_created_agent',{requestId:randomUUID(),agentId:child.id,name:'改名成员',[field]:value})).rejects.toMatchObject({code:'invalid_workspace_request'})
    expect(store.require(owner,'agent',child.id)).toMatchObject({...initialRules,revision:1})
    const edited=await call('update_created_agent',{requestId:randomUUID(),agentId:child.id,name:'改名成员'})
    expect(edited.agent.name).toBe('改名成员')
    expect(store.require(owner,'agent',child.id)).toMatchObject(initialRules)
    const other=store.createAgent(owner,{name:'用户成员',profile:'default'})
    await expect(call('archive_created_agent',{requestId:randomUUID(),agentId:other.id,confirmName:other.name})).rejects.toMatchObject({status:403})
    const team=(await call('create_team',{requestId:randomUUID(),name:'成员管理测试',memberIds:[child.id]})).team
    await expect(call('archive_created_agent',{requestId:randomUUID(),agentId:child.id,confirmName:edited.agent.name})).rejects.toMatchObject({code:'agent_in_use'})
    await call('update_team',{requestId:randomUUID(),teamId:team.id,archived:true})
    expect((await call('archive_created_agent',{requestId:randomUUID(),agentId:child.id,confirmName:edited.agent.name})).agent.archived).toBe(true)
  })
  it('creates durable members, a managed team and one idempotent task with client-visible events', async () => {
    const requestId = randomUUID(), args = {requestId,name:'研究员',profile:'writer',instructions:'研究事实并给出处'}
    const first = await call('create_agent',args)
    expect(await call('create_agent',args)).toEqual(first)
    expect(first.agent.canManageTeam).toBe(true)
    expect(store.list(owner,'agent')).toHaveLength(2)
    const groupArgs = {requestId:randomUUID(),name:'项目团队',memberIds:[first.agent.id]}
    const created = await call('create_team',groupArgs)
    expect(await call('create_team',groupArgs)).toEqual(created)
    expect(created.team).toMatchObject({memberIds:[manager.id,first.agent.id],administratorId:manager.id,mode:'free',collaborationMode:'discussion'})
    const taskArgs = {requestId:randomUUID(),teamId:created.team.id,title:'核对资料',content:'请研究员核对资料后汇总。'}
    const root=store.require<any>(owner,'run',work.runId)
    root.deviceHost=randomUUID();store.saveRun(owner,root)
    const started = await call('start_team_task',taskArgs)
    expect(started.run.deviceHost).toBe(root.deviceHost)
    expect(await call('start_team_task',taskArgs)).toEqual(started)
    expect(started.run.status).toBe('queued')
    expect(store.tasks(owner,created.team.id)).toHaveLength(1)
    expect(started.task.id).toBe(created.task.id)
    const result = await call('get_team_task',{teamId:created.team.id,taskId:started.task.id})
    expect(result.runs).toHaveLength(1)
    expect(result.messages[0].content).toContain(taskArgs.content)
    expect(result.messages[0].role).toBe('system')
    expect(store.events(owner,0).map(e=>e.type)).toEqual(expect.arrayContaining(['agent.changed','conversation.changed','task.changed','message.changed','run.changed']))
    expect(store.list('other','agent')).toEqual([])
    expect(await call('list_teams')).toMatchObject({teams:[{id:created.team.id}]})
  })

  it('denies grants, caller identity and arbitrary fields supplied by the model', async () => {
    for (const extra of [{canManageTeam:true},{owner:'other'},{agentId:randomUUID()},{token:'pretend'}])
      await expect(call('create_agent',{requestId:randomUUID(),name:'伪造',profile:'default',...extra})).rejects.toMatchObject({status:400})
    await expect(call('list_agents',{owner:'other'})).rejects.toMatchObject({status:400})
    expect(store.list(owner,'agent')).toHaveLength(1)
    const ordinary = store.createAgent(owner,{name:'普通',profile:'default'})
    expect(ordinary.canManageTeam).toBe(true)
    store.updateAgent(owner,manager.id,{archived:true})
    await expect(call('list_agents')).rejects.toMatchObject({status:403})
  })

  it('checks source permission before and after asynchronous discovery', async () => {
    denied.add('writer')
    expect((await call('list_sources')).sources.map((s:any)=>s.profile)).toEqual(['default'])
    await expect(call('create_agent',{requestId:randomUUID(),name:'越权',profile:'writer'})).rejects.toMatchObject({status:403})
    denied.clear()
    vi.spyOn(nodes,'sources').mockImplementationOnce(async () => {
      store.updateAgent(owner,manager.id,{archived:true})
      return {sources:[{nodeId:'local',profile:'writer',name:'写作'}],errors:[]}
    })
    await expect(call('create_agent',{requestId:randomUUID(),name:'竞态',profile:'writer'})).rejects.toMatchObject({status:403})
    expect(store.list(owner,'agent')).toHaveLength(1)
  })

  it('never revives a previous turn grant after archiving and restoring the Bot', async () => {
    store.updateAgent(owner,manager.id,{archived:true})
    store.updateAgent(owner,manager.id,{archived:false})
    await expect(call('list_agents')).rejects.toMatchObject({status:403})
    store.put(owner,'turn',work.id,{...work,teamManagementRevision:store.require<WorkspaceAgent>(owner,'agent',manager.id).revision})
    expect((await call('list_agents')).agents).toHaveLength(1)
  })

  it('prevents account crossing and modification of teams controlled by another Agent', async () => {
    const {team,member} = await buildTeam()
    const other = store.createAgent('other',{name:'外部',profile:'default'})
    await expect(call('create_team',{requestId:randomUUID(),name:'跨账号',memberIds:[other.id]})).rejects.toMatchObject({status:404})
    store.updateConversation(owner,team.id,{administratorId:member.id})
    await expect(call('start_team_task',{requestId:randomUUID(),teamId:team.id,title:'越权',content:'开始'})).rejects.toMatchObject({status:403})
    expect((await call('list_teams')).teams).toEqual([])
  })

  it.each(['account','archive','cancel','stop','source','member','complete'])('revokes a live grant on %s changes', async reason => {
    if(reason==='account')active=false
    if(reason==='archive')store.updateAgent(owner,manager.id,{archived:true})
    if(reason==='source')denied.add('default')
    if(reason==='cancel')store.put(owner,'turn',work.id,{...work,cancelRequested:true})
    if(reason==='complete')store.put(owner,'turn',work.id,{...work,status:'complete'})
    if(reason==='stop')store.put(owner,'run',work.runId,{...store.require(owner,'run',work.runId),stopRequested:true})
    if(reason==='member')store.put(owner,'conversation',work.conversationId,{...store.require(owner,'conversation',work.conversationId),memberIds:[]})
    await expect(call('create_agent',{requestId:randomUUID(),name:'不应创建',profile:'default'})).rejects.toMatchObject({status:403})
  })

  it('rejects conflicting retries, duplicate teams and recursive starts', async () => {
    const requestId = randomUUID()
    await call('create_agent',{requestId,name:'甲',profile:'default'})
    await expect(call('create_agent',{requestId,name:'乙',profile:'default'})).rejects.toMatchObject({code:'idempotency_conflict'})
    const {team} = await buildTeam()
    await expect(call('create_team',{requestId:randomUUID(),name:team.name,memberIds:team.memberIds})).rejects.toMatchObject({code:'duplicate_team_name'})
    store.put(owner,'turn',work.id,{...work,conversationId:team.id})
    await expect(call('start_team_task',{requestId:randomUUID(),teamId:team.id,title:'递归',content:'再开始'})).rejects.toMatchObject({code:'team_task_reentrant'})
  })

  it('keeps operation receipts through a store reopen without creating duplicates', async () => {
    const args = {requestId:randomUUID(),name:'持久成员',profile:'default'}
    const first = await call('create_agent',args)
    runtime.close(); store.close()
    store = new WorkspaceStore(home)
    runtime = new WorkspaceRuntime(store,nodes,uploads,()=>active)
    vi.spyOn(runtime,'wake').mockImplementation(()=>{})
    store.put(owner,'turn',work.id,{...work,status:'running'})
    expect(await call('create_agent',args)).toEqual(first)
    expect(store.list(owner,'agent')).toHaveLength(2)
  })
})

describe('Bot self rules', () => {
  it('reads full rules, edits only itself and keeps its current tools usable across retries', async () => {
    const instructions = '完整长期角色规则。'.repeat(400)
    store.put(owner,'agent',manager.id,{...manager,instructions,voice:'custom',voiceCustom:'原先语气'})
    const before = (await selfCall('get')).agent
    expect(before).toMatchObject({id:manager.id,revision:1,instructions})
    const request = {requestId:randomUUID(),expectedRevision:before.revision,name:'核验助手',instructions:'先核验再回答',description:'事实助手',job:'核对来源',antiJobs:['不编造来源'],voice:'rigorous',voiceCustom:null,actBias:'ask_key_then_act'}
    const updated = await selfCall('update',request)
    expect(updated.agent).toMatchObject({id:manager.id,name:request.name,instructions:request.instructions,description:request.description,job:request.job,antiJobs:request.antiJobs,voice:request.voice,actBias:request.actBias,revision:2})
    expect(updated.agent.voiceCustom).toBeUndefined()
    expect(await selfCall('update',request)).toEqual(updated)
    expect((await selfCall('get')).agent).toEqual(updated.agent)
    expect(store.require<WorkspaceAgent>(owner,'agent',manager.id)).toMatchObject({profile:'default',nodeId:'local',revision:2,memoryEnabled:true})
    expect(store.require<WorkspaceConversation>(owner,'conversation',work.conversationId).name).toBe(request.name)
    expect(store.require<Work>(owner,'turn',work.id).teamManagementRevision).toBe(2)
    expect((await call('list_agents')).agents[0].name).toBe(request.name)
    await expect(selfCall('update',{...request,instructions:'同一编号改写'})).rejects.toMatchObject({code:'idempotency_conflict'})
    expect(upstream).toEqual([])
  })

  it('rejects stale revisions and empty edits without overwriting a user edit', async () => {
    const before = (await selfCall('get')).agent
    store.updateAgent(owner,manager.id,{instructions:'用户刚保存的规则'})
    await expect(selfCall('update',{requestId:randomUUID(),expectedRevision:before.revision,instructions:'旧版本覆盖'})).rejects.toMatchObject({code:'agent_revision_conflict'})
    await expect(selfCall('update',{requestId:randomUUID(),expectedRevision:2})).rejects.toMatchObject({code:'invalid_workspace_request'})
    expect(store.require<WorkspaceAgent>(owner,'agent',manager.id)).toMatchObject({instructions:'用户刚保存的规则',revision:2})
    expect(store.require<Work>(owner,'turn',work.id).teamManagementRevision).toBe(1)
    await expect(call('list_agents')).rejects.toMatchObject({code:'team_tools_forbidden'})
  })

  it.each([
    ['agentId',randomUUID()], ['profile','writer'], ['nodeId','other'], ['approvalPolicy','allow'],
    ['canManageTeam',true], ['canCollaborate',true], ['memoryEnabled',false], ['envs',{vm:true}], ['modelSettings',null],
  ])('rejects the protected %s field', async (field, value) => {
    await expect(selfCall('update',{requestId:randomUUID(),expectedRevision:1,instructions:'新规则',[field as string]:value})).rejects.toMatchObject({code:'invalid_workspace_request'})
    expect(store.require<WorkspaceAgent>(owner,'agent',manager.id)).toEqual(manager)
  })

  it('keeps self edits available to a persistent assigned Bot without granting team management', async () => {
    store.put(owner,'run',work.runId,{...store.require<WorkspaceRun>(owner,'run',work.runId),assignmentId:randomUUID()})
    store.put(owner,'turn',work.id,{...work,teamManagementRevision:undefined})
    const catalog = runtime.knowledgeTools.catalog(owner,work.id,false).map(tool => tool.name)
    expect(catalog).toEqual(expect.arrayContaining(['workspace_get_self_rules','workspace_update_self_rules']))
    expect(catalog).not.toContain('workspace_memory_write')
    await selfCall('update',{requestId:randomUUID(),expectedRevision:1,instructions:'自己的后续规则'})
    expect(store.require<Work>(owner,'turn',work.id).teamManagementRevision).toBeUndefined()
    await expect(call('list_agents')).rejects.toMatchObject({code:'team_tools_forbidden'})
  })

  it('keeps temporary helpers and remote references from editing their rules', async () => {
    for (const restricted of [{temporaryGoalId:randomUUID()},{remoteAgentId:randomUUID()}]) {
      store.put(owner,'agent',manager.id,{...manager,...restricted})
      if ('temporaryGoalId' in restricted) expect(()=>runtime.knowledgeTools.catalog(owner,work.id,false)).toThrow()
      else expect(runtime.knowledgeTools.catalog(owner,work.id,false).map(tool => tool.name)).not.toContain('workspace_update_self_rules')
      await expect(selfCall('update',{requestId:randomUUID(),expectedRevision:1,instructions:'不能修改'})).rejects.toMatchObject({code:'knowledge_tool_forbidden'})
    }
  })
})

async function mount(signal = new AbortController().signal, onFailure: (error: Error) => void = () => {}) {
  const lease = await createWorkspaceToolLease({
    target, profile:manager.profile, workId:work.id,
    session:()=>({runtimeId:'runtime',storedId:'stored'}),signal,
    assertActive:()=>{runtime.teamTools.assertTurn(owner,work.id)},
    catalog:()=>[...runtime.teamTools.catalog(owner,work.id),...runtime.knowledgeTools.catalog(owner,work.id,false)],
    call:(id,args)=>runtime.knowledgeTools.handles(id)?runtime.knowledgeTools.call(owner,work.id,id,args,false):runtime.teamTools.call(owner,work.id,id,args),onFailure,
  })
  leases.push(lease); await lease.bind()
  return lease
}
function http(path:string, body:unknown, options:RequestInit={}) {
  return fetch(binding!.bridge_url+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${binding!.token}`},body:JSON.stringify(body),...options})
}

describe('loopback tool lease', () => {
  it.each(['503', 'upstream_unavailable'])('retains the original grant through %s renewal failures, then renews after recovery', async failure => {
    vi.useFakeTimers({toFake: ['Date', 'setInterval', 'clearInterval']})
    try {
      const failed = vi.fn()
      await mount(undefined, failed)
      const original = {...binding}, request = vi.mocked(target.session.request).getMockImplementation()!
      let unavailable = true
      vi.mocked(target.session.request).mockImplementation(async (path, options) => {
        if (path.endsWith('/bind') && unavailable) {
          if (failure === 'upstream_unavailable') throw new HttpError(502, 'Unable to reach Hermes', 'upstream_unavailable')
          return {status: 503, body: Buffer.from('{}'), headers: new Headers()}
        }
        return request(path, options)
      })
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(failed).not.toHaveBeenCalled()
      expect((await http('/tools/list', {})).status).toBe(200)
      unavailable = false
      await vi.advanceTimersByTimeAsync(30_000)
      expect(binding).toMatchObject({generation: original.generation, token: original.token, bridge_url: original.bridge_url})
      expect(binding!.expires_at).toBeGreaterThan(original.expires_at)
      expect(failed).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it.each([401, 503])('retires a lease on rejected renewal or its original expiry (HTTP %s)', async status => {
    vi.useFakeTimers({toFake: ['Date', 'setInterval', 'clearInterval']})
    try {
      const failed = vi.fn()
      await mount(undefined, failed)
      const request = vi.mocked(target.session.request).getMockImplementation()!
      vi.mocked(target.session.request).mockImplementation(async (path, options) => path.endsWith('/bind')
        ? {status, body: Buffer.from('{}'), headers: new Headers()} : request(path, options))
      await vi.advanceTimersByTimeAsync((status === 401 ? 5 : 30) * 60_000)
      expect(failed).toHaveBeenCalledOnce()
      expect(failed.mock.calls[0]![0]).toMatchObject({code: status === 401 ? 'team_tools_bind_failed' : 'team_tools_expired'})
      await expect(http('/tools/list', {})).rejects.toThrow()
    } finally { vi.useRealTimers() }
  })

  it('updates self rules through the bridge without ending the current tool lease', async () => {
    await mount()
    const catalog = await (await http('/tools/list',{})).json()
    const readId = catalog.tools.find((tool:any)=>tool.name==='workspace_get_self_rules').id
    const writeId = catalog.tools.find((tool:any)=>tool.name==='workspace_update_self_rules').id
    const current = await (await http('/tools/call',{callId:'read-self',toolId:readId,arguments:{}})).json()
    const request = {callId:'update-self',toolId:writeId,arguments:{requestId:randomUUID(),expectedRevision:current.structuredContent.agent.revision,name:'自己的新名字',instructions:'自己的新规则'}}
    const updated = await (await http('/tools/call',request)).json()
    expect(updated.structuredContent.agent).toMatchObject({id:manager.id,name:'自己的新名字',instructions:'自己的新规则',revision:2})
    expect(await (await http('/tools/call',request)).json()).toEqual(updated)
    expect((await http('/tools/list',{})).status).toBe(200)
    const after = await (await http('/tools/call',{callId:'read-updated',toolId:readId,arguments:{}})).json()
    expect(after.structuredContent.agent).toEqual(updated.structuredContent.agent)
    store.updateAgent(owner,manager.id,{instructions:'用户再修改'})
    expect((await http('/tools/list',{})).status).toBe(403)
  })
  it.each(['initializing','agent_initialization_failed','binding_busy','bridge_catalog_unreachable'])('preserves the Profile and the %s binding failure without reflecting upstream secrets',async code=>{
    manager.profile='yaoer'
    vi.mocked(target.session.request).mockImplementation(async path=>({status:path.endsWith('/bind')?409:200,
      body:Buffer.from(JSON.stringify(path.endsWith('/bind')?{code,detail:'api-key=fixture-secret'}:{ok:true})),headers:new Headers()}))
    await expect(mount()).rejects.toMatchObject({code:`hermes_bridge_${code}`,message:expect.stringContaining('Profile「yaoer」')})
    await expect(leases[0]!.bind()).rejects.not.toThrow('fixture-secret')
  })
  it('binds only the current session and executes the real HTTP catalog and call protocol', async () => {
    const lease = await mount()
    expect(binding).toMatchObject({native_tools:true,session_id:'runtime',stored_session_id:'stored',profile:'default'})
    const catalog = await (await http('/tools/list',{})).json()
    expect(catalog.tools.map((t:any)=>t.name)).toEqual(expect.arrayContaining(['workspace_create_agent','workspace_create_team','workspace_assign_task','workspace_review_assignment','workspace_finish_team_task']))
    expect(JSON.stringify(catalog)).not.toContain(binding!.token)
    const body={callId:'same-call',toolId:catalog.tools.find((t:any)=>t.name==='workspace_create_agent').id,arguments:{requestId:randomUUID(),name:'HTTP 成员',profile:'writer'}}
    const [first,second]=await Promise.all([http('/tools/call',body).then(r=>r.json()),http('/tools/call',body).then(r=>r.json())])
    expect(second).toEqual(first)
    expect(first.structuredContent.agent.canManageTeam).toBe(true)
    expect(store.list(owner,'agent')).toHaveLength(2)
    expect((await http('/tools/call',{...body,arguments:{...body.arguments,name:'替换'}})).status).toBe(409)
    await lease.dispose()
    expect(upstream.at(-1)).toMatchObject({path:expect.stringContaining('/unbind'),body:{session_id:'runtime',generation:binding!.generation}})
    await expect(http('/tools/list',{})).rejects.toThrow()
  })

  it('rejects missing tokens, browser origins, forged envelope identities and revoked permissions', async () => {
    await mount()
    expect((await http('/tools/list',{}, {headers:{'Content-Type':'application/json'}})).status).toBe(401)
    expect((await http('/tools/list',{}, {headers:{'Content-Type':'application/json',Authorization:`Bearer ${binding!.token}`,Origin:'http://evil.test'}})).status).toBe(403)
    expect((await http('/tools/list',{owner:'other'})).status).toBe(400)
    expect((await http('/tools/call',{toolId:'workspace_list_agents',arguments:{},callId:'id',owner:'other'})).status).toBe(400)
    store.updateAgent(owner,manager.id,{archived:true})
    expect((await http('/tools/list',{})).status).toBe(403)
  })

  it('reports the underlying error message instead of masking tool failures', async () => {
    const lease = await createWorkspaceToolLease({
      target, profile:manager.profile, workId:work.id,
      session:()=>({runtimeId:'runtime',storedId:'stored'}),signal:new AbortController().signal,
      assertActive:()=>{},catalog:()=>[{id:'workspace_probe',name:'workspace_probe',description:'probe',inputSchema:{}}],
      call:async()=>{throw new Error('虚拟机磁盘已满')},onFailure:()=>{},
    })
    leases.push(lease); await lease.bind()
    const catalog = await (await http('/tools/list',{})).json()
    const result = await (await http('/tools/call',{toolId:catalog.tools[0].id,arguments:{},callId:'probe'})).json()
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toMatchObject({error:'虚拟机磁盘已满',code:'team_tool_failed'})
  })

  it('keeps plain authorization stop messages readable', async () => {
    let active = true
    const lease = await createWorkspaceToolLease({
      target, profile:manager.profile, workId:work.id,
      session:()=>({runtimeId:'runtime',storedId:'stored'}),signal:new AbortController().signal,
      assertActive:()=>{if(!active)throw new Error('运行已停止')},
      catalog:()=>[],call:async()=>({}),onFailure:()=>{},
    })
    leases.push(lease); await lease.bind()
    active = false
    const response = await http('/tools/list',{})
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({error:'运行已停止',code:'team_tool_failed'})
  })

  it('checks readiness per Profile and rejects unavailable or remote bridges', async () => {
    await requireTeamToolBridge(target,'writer')
    expect(target.session.request).toHaveBeenCalledWith(expect.stringContaining('/capabilities'),expect.objectContaining({search:new URLSearchParams({profile:'writer'})}))
    await expect(requireTeamToolBridge({...target,url:new URL('http://192.168.1.20:9119')},'default')).rejects.toMatchObject({code:'team_tools_local_required'})
    vi.mocked(target.session.request).mockResolvedValueOnce({status:404,body:Buffer.from('{}'),headers:new Headers()})
    await expect(requireTeamToolBridge(target,'default')).rejects.toMatchObject({code:'team_tools_unavailable'})
  })

  it('closes a cancelled lease even if binding has not returned yet', async () => {
    let finish!:()=>void
    vi.mocked(target.session.request).mockImplementation(async(path,options)=>{
      upstream.push({path,body:options?.body})
      if(path.endsWith('/bind')){
        binding=options?.body as any
        await new Promise<void>(resolve=>{finish=resolve})
      }
      return {status:200,body:Buffer.from('{"ok":true,"native_tools":true}'),headers:new Headers()}
    })
    const controller=new AbortController()
    const pending=mount(controller.signal)
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
    controller.abort();finish()
    await expect(pending).rejects.toThrow()
    await vi.waitFor(()=>expect(upstream.at(-1)?.path).toContain('/unbind'))
    await expect(http('/tools/list',{})).rejects.toThrow()
  })

  it('rejects an expired lease and another lease token', async () => {
    await mount()
    const first={...binding}
    const firstCatalog=await (await http('/tools/list',{})).json()
    await mount()
    const secondCatalog=await (await http('/tools/list',{})).json()
    expect(secondCatalog.tools.map((t:any)=>t.id)).not.toEqual(firstCatalog.tools.map((t:any)=>t.id))
    expect((await http('/tools/call',{toolId:firstCatalog.tools[0].id,arguments:{},callId:'cross-lease'})).status).toBe(404)
    expect((await http('/tools/list',{}, {headers:{'Content-Type':'application/json',Authorization:`Bearer ${first.token}`}})).status).toBe(401)
    vi.useFakeTimers({toFake:['Date']})
    try {
      vi.setSystemTime(Date.now()+31*60_000)
      expect((await http('/tools/list',{})).status).toBe(410)
    } finally { vi.useRealTimers() }
  })
})
it('legacy VM managers create members on server Hermes and cannot rebind a running Agent',async()=>{
  store.put(owner,'agent',manager.id,{...manager,execution:'computer'})
  expect((await call('create_agent',{requestId:randomUUID(),name:'统一成员',profile:'default',execution:'profile'})).agent).toMatchObject({execution:'profile',canManageTeam:true})
  expect(()=>store.updateAgent(owner,manager.id,{execution:'profile'})).toThrow('请先停止当前任务')
})
it('creates a task-scoped helper once and rejects promotion or use outside its goal',async()=>{
  const {team,task}=await buildTeam()
  const goal=runtime.tasks.begin(owner,task,manager,'完成当前任务',{conversationId:work.conversationId,runId:work.runId,agentId:manager.id})
  const runnerId=randomUUID()
  nodes.runnerTarget=()=>({...target,runner:{id:runnerId,helperRetirement:true}} as GatewayTarget)
  const request={requestId:randomUUID(),goalId:goal.id,name:'临时调研',title:'调研资料',brief:'只核验当前任务的资料'}
  const created=await call('create_helper',request)
  expect(await call('create_helper',request)).toEqual(created)
  expect(created.helper).toMatchObject({execution:'profile',canManageTeam:true,temporaryGoalId:goal.id,helperActivation:1,helperRunnerId:runnerId,createdByAgentId:manager.id})
  expect(store.list<WorkspaceConversation>(owner,'conversation').some(c=>c.kind==='direct'&&c.memberIds.includes(created.helper.id))).toBe(false)
  expect(store.taskMemberIds(owner,team,goal.id)).toContain(created.helper.id)
  expect(store.taskMemberIds(owner,team,randomUUID())).not.toContain(created.helper.id)
  expect(()=>store.updateAgent(owner,created.helper.id,{archived:false})).toThrow()
  expect(()=>store.createGroup(owner,{name:'错误团队',memberIds:[manager.id,created.helper.id],administratorId:manager.id})).toThrow()
  expect(()=>runtime.send(owner,team.id,{requestId:randomUUID(),taskId:store.createTask(owner,team.id,{title:'另一个任务'}).id,content:'不应跨任务',mentionIds:[created.helper.id]})).toThrow()
})
it('retires task helpers after cancellation and retries cleanup without reviving the helper',async()=>{
  const {team,task}=await buildTeam()
  const goal=runtime.tasks.begin(owner,task,manager,'完成任务',{conversationId:work.conversationId,runId:work.runId,agentId:manager.id})
  nodes.runnerTarget=()=>({...target,runner:{id:randomUUID(),helperRetirement:true}} as GatewayTarget)
  const created=await call('create_helper',{requestId:randomUUID(),goalId:goal.id,name:'将退役的助手',title:'工作',brief:'完成工作'})
  const cleanup=vi.spyOn(runtime,'retireHelper').mockResolvedValue(undefined)
  store.put(owner,'turn',work.id,{...work,status:'complete',planned:true});const source=store.require<any>(owner,'run',work.runId);source.status='complete';store.saveRun(owner,source)
  vi.mocked(runtime.wake).mockRestore()
  await runtime.stopTask(owner,team.id,task.id)
  await vi.waitFor(()=>expect(store.require<any>(owner,'agent',created.helper.id).cleanupState).toBe('complete'))
  expect(store.require<any>(owner,'agent',created.helper.id)).toMatchObject({archived:true,temporaryGoalId:goal.id})
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(()=>store.updateAgent(owner,created.helper.id,{archived:false})).toThrow()
})
