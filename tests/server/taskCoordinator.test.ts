// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import { UploadStore } from '../../src/server/uploads'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceRun } from '../../src/shared/workspace'
import type { AgentGoal, AgentAssignment, TaskDelivery } from '../../src/shared/agentTasks'

let home: string, store: WorkspaceStore, runtime: WorkspaceRuntime, uploads: UploadStore
let lead: WorkspaceAgent, worker: WorkspaceAgent, second: WorkspaceAgent, team: WorkspaceConversation, goal: AgentGoal
let active: boolean, authorizationVersion: number
const owner = 'task-owner'
beforeEach(() => {
  home=mkdtempSync(join(tmpdir(),'yaoyao-goal-tests-'));store=new WorkspaceStore(home);uploads=new UploadStore(home);active=true;authorizationVersion=1
  runtime=new WorkspaceRuntime(store,{requireSource:()=>{}} as unknown as WorkspaceNodes,uploads,()=>active,()=>authorizationVersion)
  vi.spyOn(runtime,'wake').mockImplementation(()=>{})
  lead=store.createAgent(owner,{name:'老板',profile:'default',canManageTeam:true})
  worker=store.createAgent(owner,{name:'研究',profile:'default'})
  second=store.createAgent(owner,{name:'编辑',profile:'default'})
  team=store.createGroup(owner,{name:'工作团队',memberIds:[lead.id,worker.id,second.id],administratorId:lead.id})
  const source=store.list<WorkspaceConversation>(owner,'conversation').find(c=>c.kind==='direct'&&c.memberIds[0]===lead.id)!
  const origin=runtime.send(owner,source.id,{requestId:randomUUID(),content:'完成调研报告'})
  origin.status='complete';store.saveRun(owner,origin)
  goal=runtime.tasks.begin(owner,store.tasks(owner,team.id)[0]!,lead,'完成调研报告',{conversationId:source.id,runId:origin.id,agentId:lead.id},['内容可核对'])
})
afterEach(()=>{runtime.close();uploads.close();store.close();rmSync(home,{recursive:true,force:true})})

function assign(name:string,agent=worker,dependsOn:string[]=[]) {
  return runtime.tasks.createAssignment(owner,lead.id,{requestId:randomUUID(),goalId:goal.id,agentId:agent.id,title:name,brief:'提交实际结果',acceptanceCriteria:['内容可核对'],dependsOn})
}
function settle(runId:string,status:WorkspaceRun['status']='complete',text='有依据的执行结果') {
  const run=store.require<WorkspaceRun>(owner,'run',runId)
  if(text)store.saveMessage(owner,{id:randomUUID(),conversationId:run.conversationId,conversationTaskId:run.conversationTaskId,
    seq:0,role:'assistant',agentId:run.targetAgentId||lead.id,content:text,reasoning:'',status:status==='complete'?'complete':'failed',runId,createdAt:Date.now(),attachments:[],tools:[]})
  run.status=status;store.saveRun(owner,run)
}
const assignment=(id:string)=>store.require<AgentAssignment>(owner,'assignment',id)

describe('durable team task coordination',()=>{
  it('runs dependencies only after review, returns a result to the original conversation once',async()=>{
    const a=assign('调研'),b=assign('撰写',second,[a.id])
    await vi.waitFor(()=>expect(assignment(a.id).status).toBe('running'))
    expect(assignment(b.id).status).toBe('pending')
    const run=store.require<WorkspaceRun>(owner,'run',assignment(a.id).runId!)
    expect(run).toMatchObject({targetAgentId:worker.id,assignmentId:a.id,triggerKind:'assignment'})
    settle(run.id)
    await vi.waitFor(()=>expect(assignment(a.id).status).toBe('review'))
    expect(assignment(b.id).status).toBe('pending')
    await vi.waitFor(()=>expect(store.list<TaskDelivery>(owner,'task-delivery')).toHaveLength(1))
    const delivered=store.list<TaskDelivery>(owner,'task-delivery')[0]!
    expect(delivered.targetConversationId).toBe(goal.origin.conversationId)
    expect(store.messages(owner,goal.origin.conversationId).at(-1)?.role).toBe('system')
    runtime.tasks.wake();await new Promise(resolve=>setTimeout(resolve,5))
    expect(store.list(owner,'task-delivery')).toHaveLength(1)
    runtime.tasks.reviewAssignment(owner,lead.id,{requestId:randomUUID(),assignmentId:a.id,decision:'accept',review:'来源和内容均已核对'})
    await vi.waitFor(()=>expect(assignment(b.id).status).toBe('running'))
    expect(()=>runtime.tasks.finish(owner,lead.id,{requestId:randomUUID(),goalId:goal.id,status:'complete',result:'报告完成'})).toThrow('未验收')
    settle(assignment(b.id).runId!)
    await vi.waitFor(()=>expect(assignment(b.id).status).toBe('review'))
    runtime.tasks.reviewAssignment(owner,lead.id,{requestId:randomUUID(),assignmentId:b.id,decision:'accept',review:'报告满足要求'})
    const ended=runtime.tasks.finish(owner,lead.id,{requestId:randomUUID(),goalId:goal.id,status:'complete',result:'报告已完成，已复核来源和内容',checks:[{criterion:0,passed:true,evidence:'已逐项核对调研和撰写结果'}]},delivered.runId)
    expect(ended.status).toBe('complete')
    settle(delivered.runId!,'complete','报告已完成，已复核来源和内容')
    await vi.waitFor(()=>expect(store.list<TaskDelivery>(owner,'task-delivery').filter(d=>d.kind==='terminal'&&d.status==='delivered')).toHaveLength(1))
    const terminal=store.list<TaskDelivery>(owner,'task-delivery').find(d=>d.kind==='terminal')!
    expect(terminal.runId).toBe(delivered.runId)
  })

  it('does not treat a failed execution as accepted and supports bounded, explicit rework',async()=>{
    const a=assign('调研')
    await vi.waitFor(()=>expect(assignment(a.id).runId).toBeTruthy())
    settle(assignment(a.id).runId!,'failed','检索失败')
    await vi.waitFor(()=>expect(assignment(a.id).status).toBe('failed'))
    expect(()=>runtime.tasks.reviewAssignment(owner,lead.id,{requestId:randomUUID(),assignmentId:a.id,decision:'accept',review:'忽略错误'})).toThrow('失败')
    const old=assignment(a.id).runId
    runtime.tasks.reviewAssignment(owner,lead.id,{requestId:randomUUID(),assignmentId:a.id,decision:'retry',review:'缩小检索范围后重试'})
    await vi.waitFor(()=>expect(assignment(a.id).runId).not.toBe(old))
    expect(assignment(a.id).attempt).toBe(2)
  })

  it('rejects cross-goal dependencies and another coordinator',()=>{
    expect(()=>assign('非法依赖',worker,[randomUUID()])).toThrow('依赖')
    expect(()=>runtime.tasks.createAssignment(owner,worker.id,{requestId:randomUUID(),goalId:goal.id,agentId:second.id,title:'越权',brief:'不应执行'})).toThrow('无权')
    expect(()=>runtime.tasks.finish('another',lead.id,{requestId:randomUUID(),goalId:goal.id,status:'complete',result:'伪造'})).toThrow()
  })

  it.each(['disabled','credentials','permission','regranted','origin_stopped'])('never resurrects a stopped or revoked goal: %s',async reason=>{
    const a=assign('调研')
    await vi.waitFor(()=>expect(assignment(a.id).runId).toBeTruthy())
    if(reason==='disabled')active=false
    if(reason==='credentials')authorizationVersion++
    if(reason==='permission'||reason==='regranted')store.updateAgent(owner,lead.id,{canManageTeam:false})
    if(reason==='regranted')store.updateAgent(owner,lead.id,{canManageTeam:true})
    if(reason==='origin_stopped'){
      const source=store.require<WorkspaceRun>(owner,'run',goal.origin.runId);source.stopRequested=true;store.saveRun(owner,source)
    }
    settle(assignment(a.id).runId!)
    runtime.tasks.wake()
    await new Promise(resolve=>setTimeout(resolve,30))
    expect(store.list<TaskDelivery>(owner,'task-delivery').filter(d=>d.status==='delivered')).toEqual([])
  })
  it('resumes only from a new user instruction after previous execution is confirmed stopped',async()=>{
    const a=assign('调研')
    await vi.waitFor(()=>expect(assignment(a.id).runId).toBeTruthy())
    const old=assignment(a.id).runId!
    runtime.tasks.cancel(owner,goal.id)
    const source=runtime.send(owner,goal.origin.conversationId,{requestId:randomUUID(),content:'继续这个任务'})
    const origin={...goal.origin,runId:source.id}
    expect(()=>runtime.tasks.resume(owner,lead.id,{requestId:randomUUID(),goalId:goal.id},origin)).toThrow('旧执行')
    settle(old,'interrupted','')
    await vi.waitFor(()=>expect(store.get<AgentGoal>(owner,'goal',goal.id)?.status).toBe('cancelled'))
    const resumed=runtime.tasks.resume(owner,lead.id,{requestId:randomUUID(),goalId:goal.id},origin)
    expect(resumed.activation).toBe(2)
    expect(resumed.origin.runId).toBe(source.id)
    await vi.waitFor(()=>expect(assignment(a.id).runId).not.toBe(old))
    expect(assignment(a.id).attempt).toBe(2)
  })
  it('requires a result for every acceptance criterion',()=>{
    expect(()=>runtime.tasks.finish(owner,lead.id,{requestId:randomUUID(),goalId:goal.id,status:'complete',result:'完成'})).toThrow('逐项')
    expect(()=>runtime.tasks.finish(owner,lead.id,{requestId:randomUUID(),goalId:goal.id,status:'complete',result:'完成',checks:[{criterion:0,passed:false,evidence:'尚未核对'}]})).toThrow('逐项')
  })

  it('repairs a missed result dispatch without duplicating the durable source message',async()=>{
    const a=assign('调研')
    await vi.waitFor(()=>expect(assignment(a.id).runId).toBeTruthy())
    const dispatch=vi.spyOn(runtime,'dispatch')
    dispatch.mockImplementationOnce(()=>{throw new Error('simulate dispatch crash')})
    settle(assignment(a.id).runId!)
    await vi.waitFor(()=>expect(assignment(a.id).status).toBe('review'))
    runtime.tasks.wake()
    await vi.waitFor(()=>expect(store.list<TaskDelivery>(owner,'task-delivery').filter(d=>d.status==='delivered')).toHaveLength(1))
    const count=store.messages(owner,goal.origin.conversationId).length
    runtime.tasks.wake();await new Promise(resolve=>setTimeout(resolve,10))
    expect(store.messages(owner,goal.origin.conversationId)).toHaveLength(count)
  })
})
