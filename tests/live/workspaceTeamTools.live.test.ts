// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import {createServer, type Server} from 'node:http'
import {RunnerAgent} from '../../src/runner/agent'
import { createApplication } from '../../src/server/app'
import { loadServerConfig } from '../../src/server/config'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceMessage, WorkspaceRun } from '../../src/shared/workspace'

// This opt-in test only accepts the isolated real-Hermes wire fixture, never a user service.
const url = process.env.HERMES_TEAM_WIRE_URL
it.skipIf(!url)('uses actual Hermes auth, sessions and native plugin tools to create a member, team and task', async () => {
  const base = new URL(url!)
  expect(base.hostname).toBe('127.0.0.1')
  const marker = await fetch(new URL('/api/yaoyao-verification-fixture',base))
  expect(marker.ok).toBe(true)
  const proof = await marker.json()
  expect(proof).toMatchObject({fixture:true,kind:'hermes-tool-bridge'})
  const home=mkdtempSync(join(tmpdir(),'yaoyao-team-wire-client-'))
  let runnerServer:Server|undefined,runnerDone:Promise<void>|undefined
  const runnerAbort=new AbortController()
  const app=createApplication({config:loadServerConfig({HERMES_YAOYAO_HOME:home,HERMES_YAOYAO_UPSTREAM:url!,HERMES_YAOYAO_UPSTREAM_USERNAME:'fixture',HERMES_YAOYAO_UPSTREAM_PASSWORD:'yaoyao-fixture-password'})})
  try {
    const bootstrap=await request(app.app.callback()).get('/api/app/bootstrap').set('Host','127.0.0.1:15300').expect(200)
    const setup=await request(app.app.callback()).post('/api/app/setup').set('Host','127.0.0.1:15300').set('Origin','http://127.0.0.1:15300')
      .set('Cookie',(bootstrap.headers['set-cookie'] as unknown as string[]).map(c=>c.split(';')[0]).join('; '))
      .set('X-CSRF-Token',bootstrap.body.csrfToken).send({username:'team-fixture',password:'team-fixture-password'}).expect(200)
    const owner=setup.body.user.id as string
    if(process.env.HERMES_TEAM_RUNNER==='1') {
      runnerServer=createServer(app.app.callback())
      await new Promise<void>(resolve=>runnerServer!.listen(0,'127.0.0.1',resolve))
      app.config.port=(runnerServer.address() as {port:number}).port
      const registered=app.runners.enroll(owner,{name:'真实协议 Runner',allowedProfiles:['default']})
      const runner=new RunnerAgent({protocol:1,serverURL:`http://127.0.0.1:${(runnerServer.address() as {port:number}).port}`,runnerId:registered.runner.id,token:registered.token,hermesURL:url!,allowedProfiles:['default'],artifactRoots:[],hermesCredentials:{username:'fixture',password:'yaoyao-fixture-password'}},home)
      runnerDone=runner.run(runnerAbort.signal);void runnerDone.catch(()=>{})
      await expect.poll(()=>app.runners.summary(app.runners.records()[0]!).online).toBe(true)
    }
    const manager=app.workspace.createAgent(owner,{name:'组队老板',profile:'default',canManageTeam:true})
    await app.workspaceRuntime.teamTools.requireAvailable(owner,manager)
    const direct=app.workspace.list<WorkspaceConversation>(owner,'conversation').find(c=>c.memberIds[0]===manager.id)!
    const invoke=async(name:string,args:unknown,allowed=true,conversation=direct)=>{
      const run=app.workspaceRuntime.send(owner,conversation.id,{requestId:randomUUID(),content:'wire_call:'+JSON.stringify({name,arguments:args})})
      await expect.poll(()=>app.workspace.require<WorkspaceRun>(owner,'run',run.id).status,{timeout:30_000}).toMatch(/complete|failed/)
      const current=app.workspace.require<WorkspaceRun>(owner,'run',run.id)
      const messages=app.workspace.messages(owner,conversation.id).filter(m=>m.runId===run.id && m.role==='assistant')
      expect(current.status,JSON.stringify(messages.map(m=>({status:m.status,content:m.content,error:m.error})))).toBe('complete')
      const report=JSON.parse(messages.at(-1)!.content)
      expect(report.actual_plugin_registry).toBe(true)
      expect(report.ok,report.error).toBe(allowed)
      if(allowed)expect(report.calls[0].native_name).toMatch(/^yaoyao_workspace_/)
      return messages
    }
    const requestId=randomUUID()
    await invoke('workspace_create_agent',{requestId,name:'实际工具成员',profile:'default',instructions:'执行分配任务并提交结果'})
    const member=app.workspace.list<WorkspaceAgent>(owner,'agent').find(a=>a.name==='实际工具成员')!
    expect(member).toBeDefined();expect(member.canManageTeam).toBe(true)
    await invoke('workspace_create_agent',{requestId,name:'实际工具成员',profile:'default',instructions:'执行分配任务并提交结果'})
    expect(app.workspace.list(owner,'agent')).toHaveLength(2)
    await invoke('workspace_create_team',{requestId:randomUUID(),name:'真实工具团队',memberIds:[member.id]})
    const team=app.workspace.list<WorkspaceConversation>(owner,'conversation').find(c=>c.kind==='group')!
    expect(team).toMatchObject({administratorId:manager.id,memberIds:[manager.id,member.id]})
    await invoke('workspace_start_team_task',{requestId:randomUUID(),teamId:team.id,title:'实际启动验证',content:'核验团队可用工具。\ncatalog'})
    await expect.poll(()=>app.workspace.list<WorkspaceRun>(owner,'run').filter(r=>r.conversationId===team.id).map(r=>r.status),{timeout:30_000}).toEqual(['complete'])
    const task=app.workspace.tasks(owner,team.id)[0]!
    expect(task.title).toBe('实际启动验证')
    expect(app.workspace.list<WorkspaceMessage>(owner,'message').some(m=>m.conversationId===team.id && m.role==='assistant' && m.content)).toBe(true)
    await invoke('workspace_get_team_task',{teamId:team.id,taskId:task.id})
    await invoke('workspace_assign_task',{requestId:randomUUID(),goalId:task.id,agentId:member.id,title:'核验执行权限',brief:'检查并报告当前执行环境。'})
    await expect.poll(()=>app.workspaceRuntime.tasks.assignments(owner,task.id)[0]?.status,{timeout:30_000}).toBe('review')
    const assignment=app.workspaceRuntime.tasks.assignments(owner,task.id)[0]!
    expect(JSON.parse(assignment.result!).tool_count).toBe(0)
    await invoke('workspace_review_assignment',{requestId:randomUUID(),assignmentId:assignment.id,decision:'accept',review:'已核对成员未继承组队工具。'})
    await invoke('workspace_finish_team_task',{requestId:randomUUID(),goalId:task.id,status:'complete',result:'团队执行权限核验完成。',checks:[{criterion:0,passed:true,evidence:'成员真实原生工具目录未获得组队权限，执行结果已经返回。'}]})
    await expect.poll(()=>app.workspace.tasks(owner,team.id)[0]?.goal?.status).toBe('complete')
    expect(app.workspace.messages(owner,direct.id).some(m=>m.taskReference?.taskId===task.id && m.role==='system')).toBe(true)
    // Hold both real native invocations open together to catch shared-registry
    // name collisions between simultaneous leases of the same logical tools.
    const peer=app.workspace.createAgent(owner,{name:'第二位老板',profile:'default',canManageTeam:true})
    const peerDirect=app.workspace.list<WorkspaceConversation>(owner,'conversation').find(c=>c.kind==='direct' && c.memberIds[0]===peer.id)!
    const execute=app.workspaceRuntime.teamTools.call.bind(app.workspaceRuntime.teamTools)
    let entered=0, release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    const deadline=setTimeout(()=>release(),5000)
    const spy=vi.spyOn(app.workspaceRuntime.teamTools,'call').mockImplementation(async(...args)=>{
      if(args[2]==='workspace_list_agents'){entered++;if(entered===2)release();await gate}
      return execute(...args)
    })
    try {
      const [a,b]=await Promise.all([invoke('workspace_list_agents',{}),invoke('workspace_list_agents',{},true,peerDirect)])
      expect(entered).toBe(2)
      expect(JSON.parse(a.at(-1)!.content).calls[0].native_name).not.toBe(JSON.parse(b.at(-1)!.content).calls[0].native_name)
    } finally { clearTimeout(deadline);spy.mockRestore() }
  } finally {
    runnerAbort.abort();await runnerDone?.catch(()=>{})
    if(runnerServer)await new Promise<void>(resolve=>{runnerServer!.close(()=>resolve());runnerServer!.closeAllConnections()})
    app.close()
    // Let asynchronous loopback lease unbinds finish before removing the fixture store.
    await new Promise(resolve=>setTimeout(resolve,100))
    rmSync(home,{recursive:true,force:true})
  }
},120_000)
