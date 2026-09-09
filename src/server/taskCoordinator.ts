import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { parse, type WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceRuntime } from './workspaceRuntime.js'
import type { WorkspaceMessage as Message, WorkspaceAgent as Agent, WorkspaceConversation as Conversation, WorkspaceRun as Run, WorkspaceTask as Task } from '../shared/workspace.js'
import type { AgentGoal, AgentAssignment, TaskDelivery, TaskOrigin } from '../shared/agentTasks.js'

const terminalRun = (status: string) => ['complete', 'failed', 'interrupted'].includes(status)
const terminalGoal = (status: string) => ['complete', 'blocked', 'cancelled'].includes(status)
const criteria = z.array(z.string().trim().min(1).max(1000)).max(12).default([])
export const assignmentInput = z.object({
  requestId: z.string().uuid(), goalId: z.string().uuid(), agentId: z.string().uuid(),
  title: z.string().trim().min(1).max(100), brief: z.string().trim().min(1).max(16000),
  acceptanceCriteria: criteria, dependsOn: z.array(z.string().uuid()).max(12).default([]),
}).strict()
export const assignmentReview = z.object({
  requestId: z.string().uuid(), assignmentId: z.string().uuid(),
  decision: z.enum(['accept', 'retry', 'blocked']), review: z.string().trim().min(1).max(4000),
}).strict()
export const assignmentUpdate = z.object({
  requestId: z.string().uuid(), assignmentId: z.string().uuid(),
  title: z.string().trim().min(1).max(100).optional(), brief: z.string().trim().min(1).max(16000).optional(),
  agentId: z.string().uuid().optional(),
  acceptanceCriteria: criteria.optional(), dependsOn: z.array(z.string().uuid()).max(12).optional(),
}).strict()
export const assignmentCancel = z.object({requestId:z.string().uuid(),assignmentId:z.string().uuid(),reason:z.string().trim().min(1).max(2000)}).strict()
export const finishGoalInput = z.object({
  requestId: z.string().uuid(), goalId: z.string().uuid(), status: z.enum(['complete', 'blocked', 'waiting']),
  result: z.string().trim().min(1).max(16000), artifactIds: z.array(z.string().uuid()).max(24).default([]),
  checks: z.array(z.object({criterion:z.number().int().min(0).max(11),passed:z.boolean(),evidence:z.string().trim().min(1).max(2000)}).strict()).max(12).default([]),
}).strict()
export const resumeGoalInput = z.object({requestId:z.string().uuid(),goalId:z.string().uuid()}).strict()

/** Stable internal command identity; retries can never create a second wake. */
function requestId(value: string): string {
  const h = createHash('sha256').update(value).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}

export class WorkspaceTaskCoordinator {
  private cleaning=new Set<string>()
  private cleanupAfter=new Map<string,number>()
  private pending = false
  private closed = false
  private unobserve: () => void
  private timer: ReturnType<typeof setInterval>
  constructor(readonly store: WorkspaceStore, readonly runtime: WorkspaceRuntime) {
    this.unobserve = store.observe((_owner, event) => {
      if (['run.changed', 'agent.changed', 'conversation.changed', 'task.deleted', 'assignment.changed', 'goal.changed'].includes(event.type)) this.wake()
    })
    this.timer = setInterval(() => this.wake(), 5000);this.timer.unref()
    this.wake()
  }
  begin(owner: string, task: Task, coordinator: Agent, objective: string, origin: TaskOrigin, acceptanceCriteria: string[] = []): AgentGoal {
    const old = this.store.get<AgentGoal>(owner, 'goal', task.id)
    if (old) throw new HttpError(409, '这个任务已有目标，请继续原任务或新建任务', 'goal_exists')
    const goal: AgentGoal = { id: task.id, conversationId: task.conversationId, coordinatorId: coordinator.id,
      authorityRevision: coordinator.teamAuthorizationVersion ?? 0, objective, acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : ['对照原始请求核验交付结果'],
      authorizationVersion: this.runtime.authorizationVersion(owner), activation: 1,
      status: 'running', origin, artifactIds: [], revision: 1, automaticWakes: 0, createdAt: Date.now(), updatedAt: Date.now() }
    this.saveGoal(owner, goal)
    return goal
  }
  private saveGoal(owner: string, goal: AgentGoal) {
    goal.updatedAt = Date.now()
    this.store.put(owner, 'goal', goal.id, goal)
    const task = this.store.get<Task>(owner, 'conversation-task', goal.id)
    if (task) {
      task.goal = goal
      this.store.put(owner, 'conversation-task', task.id, task)
      this.store.event(owner, 'task.changed', task, task.conversationId)
    }
    this.store.event(owner, 'goal.changed', goal, goal.conversationId)
  }
  private saveAssignment(owner: string, assignment: AgentAssignment) {
    assignment.updatedAt = Date.now()
    this.store.put(owner, 'assignment', assignment.id, assignment)
    this.store.event(owner, 'assignment.changed', assignment, assignment.conversationId)
  }
  assignments(owner: string, goalId: string): AgentAssignment[] {
    return this.store.list<AgentAssignment>(owner, 'assignment').filter(a => a.goalId === goalId)
      .sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }
  requireCoordinator(owner: string, goalId: string, actorId: string): AgentGoal {
    const goal = this.store.require<AgentGoal>(owner, 'goal', goalId)
    const team = this.store.require<Conversation>(owner, 'conversation', goal.conversationId)
    if (!this.authorized(owner, goal) || goal.coordinatorId !== actorId || team.administratorId !== actorId)
      throw new HttpError(403, '当前 Agent 无权管理这个任务', 'goal_forbidden')
    return goal
  }
  private authorized(owner: string, goal: AgentGoal): boolean {
    try {
      const agent = this.store.require<Agent>(owner, 'agent', goal.coordinatorId)
      const team = this.store.require<Conversation>(owner, 'conversation', goal.conversationId)
      this.store.requireTask(owner, team.id, goal.id)
      this.runtime.nodes.requireSource(owner, agent)
      return this.runtime.userActive(owner) && !agent.archived && agent.canManageTeam === true
        && (goal.authorizationVersion === undefined || goal.authorizationVersion === this.runtime.authorizationVersion(owner))
        && (agent.teamAuthorizationVersion ?? 0) === goal.authorityRevision
        && !team.archived && team.administratorId === agent.id && team.memberIds.includes(agent.id)
    } catch { return false }
  }
  createAssignment(owner: string, actorId: string, input: unknown): AgentAssignment {
    const { requestId: command, ...body } = parse(assignmentInput, input)
    const goal = this.requireCoordinator(owner, body.goalId, actorId)
    if (terminalGoal(goal.status)) throw new HttpError(409, '目标已结束', 'goal_terminal')
    const team = this.store.require<Conversation>(owner, 'conversation', goal.conversationId)
    const agent = this.store.require<Agent>(owner, 'agent', body.agentId)
    this.runtime.nodes.requireSource(owner, agent)
    if (!this.store.taskMemberIds(owner,team,goal.id).includes(agent.id) || agent.archived || agent.id === actorId)
      throw new HttpError(400, '请选择其他有效团队成员；管理员可以直接处理自己的工作。', 'invalid_assignment_agent')
    const previous = this.assignments(owner, goal.id)
    if (body.dependsOn.some(id => !previous.some(a => a.id === id))) throw new HttpError(400, '依赖必须属于同一目标中的已有子任务', 'invalid_assignment_dependency')
    return this.store.command(owner, command, { actorId, operation: 'assignment.create', ...body }, () => {
      if (previous.length >= 32) throw new HttpError(409, '每个目标最多 32 个子任务', 'assignment_limit')
      const assignment: AgentAssignment = { ...body, id: randomUUID(), conversationId: goal.conversationId,
        status: 'pending', attempt: 0, artifactIds: [], createdAt: Date.now(), updatedAt: Date.now() }
      this.saveAssignment(owner, assignment)
      if(goal.status!=='waiting')goal.status = 'running';goal.revision++;this.saveGoal(owner, goal)
      return assignment
    })
  }
  reviewAssignment(owner: string, actorId: string, input: unknown): AgentAssignment {
    const body = parse(assignmentReview, input)
    const assignment = this.store.require<AgentAssignment>(owner, 'assignment', body.assignmentId)
    const goal = this.requireCoordinator(owner, assignment.goalId, actorId)
    return this.store.command(owner, body.requestId, { actorId, operation: 'assignment.review', ...body }, () => {
      if (terminalGoal(goal.status) || !['review', 'failed', 'blocked'].includes(assignment.status))
        throw new HttpError(409, '子任务尚未进入复核状态', 'assignment_not_reviewable')
      if (body.decision === 'accept' && assignment.status !== 'review')
        throw new HttpError(409, '失败的执行不能直接验收为完成', 'assignment_failed')
      if (body.decision === 'retry' && assignment.attempt >= (assignment.maxAttempts ?? 3))
        throw new HttpError(409, '此子任务已达到 3 次执行上限，请调整方案', 'assignment_retry_limit')
      assignment.review = body.review
      assignment.status = body.decision === 'accept' ? 'complete' : body.decision === 'retry' ? 'pending' : 'blocked'
      if (body.decision === 'retry') { assignment.runId = undefined;assignment.result = undefined }
      this.saveAssignment(owner, assignment)
      if(goal.status!=='waiting')goal.status = 'running';goal.revision++;this.saveGoal(owner, goal)
      return assignment
    })
  }
  updateAssignment(owner: string, actorId: string, input: unknown): AgentAssignment {
    const {requestId:command,assignmentId,...patch}=parse(assignmentUpdate,input)
    const assignment=this.store.require<AgentAssignment>(owner,'assignment',assignmentId)
    const goal=this.requireCoordinator(owner,assignment.goalId,actorId)
    return this.store.command(owner,command,{actorId,operation:'assignment.update',assignmentId,...patch},()=>{
      if(terminalGoal(goal.status)||!['pending','failed','blocked'].includes(assignment.status))
        throw new HttpError(409,'只能调整尚未运行或已失败的子任务','assignment_not_editable')
      const all=this.assignments(owner,goal.id), dependencies=patch.dependsOn??assignment.dependsOn
      if(dependencies.some(id=>id===assignment.id||!all.some(a=>a.id===id)))throw new HttpError(400,'子任务依赖无效','invalid_assignment_dependency')
      const reaches=(id:string,seen=new Set<string>()):boolean=>{
        if(id===assignment.id)return true
        if(seen.has(id))return false
        seen.add(id);return (all.find(a=>a.id===id)?.dependsOn??[]).some(next=>reaches(next,seen))
      }
      if(dependencies.some(id=>reaches(id)))throw new HttpError(400,'子任务依赖不能形成循环','assignment_dependency_cycle')
      if(patch.agentId && patch.agentId!==assignment.agentId) {
        const target=this.store.require<Agent>(owner,'agent',patch.agentId)
        const team=this.store.require<Conversation>(owner,'conversation',goal.conversationId)
        this.runtime.nodes.requireSource(owner,target)
        if(target.archived||target.id===actorId||!this.store.taskMemberIds(owner,team,goal.id).includes(target.id))throw new HttpError(400,'请选择有效团队成员','invalid_assignment_agent')
        assignment.status='pending';assignment.runId=undefined;assignment.result=undefined
      }
      Object.assign(assignment,patch);this.saveAssignment(owner,assignment)
      goal.revision++;this.saveGoal(owner,goal);return assignment
    })
  }
  cancelAssignment(owner:string,actorId:string,input:unknown):AgentAssignment {
    const body=parse(assignmentCancel,input),assignment=this.store.require<AgentAssignment>(owner,'assignment',body.assignmentId)
    const goal=this.requireCoordinator(owner,assignment.goalId,actorId)
    return this.store.command(owner,body.requestId,{actorId,operation:'assignment.cancel',...body},()=>{
      if(terminalGoal(goal.status)||assignment.status==='complete')throw new HttpError(409,'已完成的工作不能通过取消操作撤销','assignment_not_cancellable')
      const run=assignment.runId?this.store.get<Run>(owner,'run',assignment.runId):undefined
      assignment.review=body.reason;assignment.status=run&&!terminalRun(run.status)?'cancelling':'cancelled'
      this.saveAssignment(owner,assignment)
      return assignment
    })
  }
  finish(owner: string, actorId: string, input: unknown, reportingRunId?: string): AgentGoal {
    const body = parse(finishGoalInput, input), goal = this.requireCoordinator(owner, body.goalId, actorId)
    return this.store.command(owner, body.requestId, { actorId, operation: 'goal.finish', ...body }, () => {
      if (terminalGoal(goal.status)) throw new HttpError(409, '目标已结束', 'goal_terminal')
      const assignments=this.assignments(owner,goal.id)
      if (body.status === 'complete' && (assignments.some(a => !['complete','cancelled'].includes(a.status)) || (assignments.length>0&&!assignments.some(a=>a.status==='complete'))))
        throw new HttpError(409, '还有未验收的子任务，不能宣布目标完成', 'goal_incomplete')
      if (body.status === 'complete' && goal.acceptanceCriteria.some((_criterion,index)=>!body.checks.some(check=>check.criterion===index&&check.passed&&check.evidence.trim())))
        throw new HttpError(409,'需要逐项提供验收依据，才能宣布目标完成','goal_checks_missing')
      if (body.status === 'complete' && this.store.list<Run>(owner,'run').some(r=>r.conversationId===goal.conversationId&&r.conversationTaskId===goal.id&&r.id!==reportingRunId&&!terminalRun(r.status)))
        throw new HttpError(409,'任务仍有运行中的执行，请先等待或停止','goal_still_running')
      for (const id of body.artifactIds) {
        const file = this.store.require<{ conversationId?: string }>(owner, 'file', id)
        if (file.conversationId && file.conversationId !== goal.conversationId)
          throw new HttpError(403, '产物不属于这个团队', 'goal_artifact_forbidden')
      }
      goal.status = body.status;goal.result = body.result;goal.artifactIds = body.artifactIds;goal.revision++
      goal.reportingRunId = reportingRunId
      goal.checks = body.checks
      this.saveGoal(owner, goal)
      return goal
    })
  }
  resume(owner: string, actorId: string, input: unknown, origin: TaskOrigin): AgentGoal {
    const body=parse(resumeGoalInput,input),goal=this.store.require<AgentGoal>(owner,'goal',body.goalId)
    const agent=this.store.require<Agent>(owner,'agent',actorId),team=this.store.require<Conversation>(owner,'conversation',goal.conversationId)
    this.runtime.nodes.requireSource(owner,agent)
    const source=this.store.require<Run>(owner,'run',origin.runId)
    const message=this.store.require<{role:string}>(owner,'message',source.messageId)
    if (!this.runtime.userActive(owner)||!agent.canManageTeam||agent.archived||team.archived||goal.coordinatorId!==actorId||team.administratorId!==actorId||source.triggerKind||message.role!=='user')
      throw new HttpError(403,'恢复任务需要当前用户的新指令和有效管理员权限','goal_resume_forbidden')
    return this.store.command(owner,body.requestId,{actorId,operation:'goal.resume',goalId:goal.id,origin},()=>{
      if(goal.status==='cancelling')throw new HttpError(409,'旧执行尚未确认结束，请先核对状态','goal_still_running')
      if(!['blocked','waiting','cancelled'].includes(goal.status))throw new HttpError(409,'只能恢复受阻、等待或已停止的目标','goal_not_resumable')
      if(this.store.list<Run>(owner,'run').some(r=>r.conversationId===goal.conversationId&&r.conversationTaskId===goal.id&&r.id!==source.id&&!terminalRun(r.status)))
        throw new HttpError(409,'旧执行尚未确认结束，请先核对状态','goal_still_running')
      for(const assignment of this.assignments(owner,goal.id)) {
        assignment.maxAttempts=assignment.attempt+3
        if(assignment.status==='cancelled') {assignment.status='pending';assignment.runId=undefined}
        this.saveAssignment(owner,assignment)
      }
      Object.assign(goal,{status:'running',origin,authorityRevision:agent.teamAuthorizationVersion??0,
        authorizationVersion:this.runtime.authorizationVersion(owner),activation:(goal.activation??0)+1,
        automaticWakes:0,reviewRunId:source.id,lastReviewedBatch:undefined,reportingRunId:undefined,result:undefined,checks:undefined})
      goal.revision++;this.saveGoal(owner,goal);return goal
    })
  }
  cancel(owner: string, goalId: string, reason = '用户已停止任务'): void {
    const goal = this.store.get<AgentGoal>(owner, 'goal', goalId)
    if (!goal || terminalGoal(goal.status) || goal.status==='cancelling') return
    this.store.atomic(() => {
      goal.status = 'cancelling';goal.result = reason;goal.revision++
      for (const assignment of this.assignments(owner, goal.id)) {
        if (!['complete', 'cancelled'].includes(assignment.status)) {
          const run=assignment.runId?this.store.get<Run>(owner,'run',assignment.runId):undefined
          assignment.status = run&&!terminalRun(run.status)?'cancelling':'cancelled';this.saveAssignment(owner, assignment)
        }
      }
      this.saveGoal(owner, goal)
    })
  }
  async cancelOrigin(owner: string, conversationId: string, taskId?: string, visited = new Set<string>()): Promise<void> {
    const pending:Promise<void>[]=[]
    for (const goal of this.store.list<AgentGoal>(owner, 'goal')) {
      if (terminalGoal(goal.status)) continue
      if (goal.origin.conversationId === conversationId && (!taskId || goal.origin.conversationTaskId === taskId)) {
        this.cancel(owner, goal.id)
        pending.push(this.runtime.stopTask(owner, goal.conversationId, goal.id, visited))
      }
    }
    await Promise.all(pending)
  }
  wake(): void {
    if (this.closed || this.pending) return
    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      if (this.closed) return
      for (const owner of this.store.owners()){
        for (const goal of this.store.list<AgentGoal>(owner, 'goal')) {
          try { this.reconcile(owner, goal);this.retireHelpers(owner,goal) } catch { /* The next committed event retries durable state. */ }
        }
        for(const goalId of new Set(this.store.list<Agent>(owner,'agent').flatMap(agent=>agent.temporaryGoalId?[agent.temporaryGoalId]:[])))if(!this.store.get(owner,'goal',goalId)||!this.store.get(owner,'conversation-task',goalId))this.retireHelpers(owner,{id:goalId,status:'cancelled',activation:0})
      }
    })
  }
  private retireHelpers(owner:string,goal:Pick<AgentGoal,'id'|'status'|'activation'>):void {
    for(const helper of this.store.list<Agent>(owner,'agent').filter(agent=>agent.temporaryGoalId===goal.id)){
      if(!helper.archived&&!terminalGoal(goal.status)&&helper.helperActivation===(goal.activation??1))continue
      if(!helper.archived){helper.archived=true;helper.revision++;helper.updatedAt=Date.now();helper.retiredAt=Date.now();helper.cleanupState='pending';this.store.put(owner,'agent',helper.id,helper);this.store.event(owner,'agent.changed',helper)}
      if(!helper.cleanupState){helper.cleanupState='pending';helper.retiredAt??=Date.now();this.store.put(owner,'agent',helper.id,helper)}
      const works=this.store.list<{agentId:string;runId:string;status:string}>(owner,'turn').filter(work=>work.agentId===helper.id&&!terminalRun(work.status))
      if(works.length){for(const runId of new Set(works.map(work=>work.runId)))void this.runtime.stop(owner,runId).catch(()=>{});continue}
      if(helper.cleanupState==='complete')continue
      const key=`${owner}:${helper.id}`
      if(this.cleaning.has(key)||(this.cleanupAfter.get(key)??0)>Date.now())continue
      this.cleaning.add(key)
      void this.runtime.retireHelper(owner,helper).then(()=>{
        if(this.closed)return
        const current=this.store.require<Agent>(owner,'agent',helper.id)
        current.cleanupState='complete';current.retiredAt??=Date.now();this.store.put(owner,'agent',current.id,current);this.store.event(owner,'agent.changed',current)
      }).catch(()=>{this.cleanupAfter.set(key,Date.now()+5000)}).finally(()=>this.cleaning.delete(key))
    }
  }
  private reconcile(owner: string, goal: AgentGoal): void {
    if(goal.status==='cancelling') {
      const all=this.store.list<AgentGoal>(owner,'goal'), owned=new Set([goal.id])
      for(let changed=true;changed;) {
        changed=false
        for(const child of all) if(child.origin.conversationTaskId&&owned.has(child.origin.conversationTaskId)&&!owned.has(child.id)) {owned.add(child.id);changed=true}
      }
      const active=this.store.list<Run>(owner,'run').filter(r=>r.conversationTaskId&&owned.has(r.conversationTaskId)&&!terminalRun(r.status))
      if(!active.length) {
        for(const assignment of this.assignments(owner,goal.id)) if(assignment.status==='cancelling'){assignment.status='cancelled';this.saveAssignment(owner,assignment)}
        goal.status='cancelled';goal.revision++;this.saveGoal(owner,goal)
      } else if(active.some(r=>!r.stopRequested))void this.runtime.stopTask(owner,goal.conversationId,goal.id).catch(()=>{})
      return
    }
    if (!this.authorized(owner, goal) && !terminalGoal(goal.status)) {
      this.cancel(owner, goal.id, '任务授权已失效')
      void this.runtime.stopTask(owner, goal.conversationId, goal.id).catch(() => {})
      return
    }
    if (goal.status === 'cancelled') return
    if (goal.status === 'blocked') {
      for (const assignment of this.assignments(owner,goal.id)) if (['pending','running','cancelling'].includes(assignment.status)) {
        const run=assignment.runId?this.store.get<Run>(owner,'run',assignment.runId):undefined
        const next=run&&!terminalRun(run.status)?'cancelling':'cancelled'
        if(assignment.status!==next){assignment.status=next;this.saveAssignment(owner,assignment)}
        if(run&&!terminalRun(run.status)&&!run.stopRequested)void this.runtime.stop(owner,run.id).catch(()=>{})
      }
    }
    if (terminalGoal(goal.status) || goal.status === 'waiting') { this.deliver(owner, goal, 'terminal', String(goal.revision));return }
    const assignments = this.assignments(owner, goal.id)
    for (const assignment of assignments) {
      if(assignment.status==='cancelling') {
        const run=assignment.runId?this.store.get<Run>(owner,'run',assignment.runId):undefined
        if(!run||terminalRun(run.status)){assignment.status='cancelled';this.saveAssignment(owner,assignment)}
        else void this.runtime.stop(owner,run.id).catch(()=>{})
        continue
      }
      if (assignment.status === 'running' && assignment.runId) {
        const run = this.store.get<Run>(owner, 'run', assignment.runId)
        if (run && terminalRun(run.status)) {
          const messages = this.store.messages(owner, goal.conversationId, Number.MAX_SAFE_INTEGER, 100, false, goal.id)
            .filter(m => m.runId === run.id && m.role === 'assistant')
          assignment.result = messages.map(m => m.content).join('\n\n').slice(-16000) || run.error || '未产生有效结果'
          assignment.artifactIds = [...new Set(messages.flatMap(m => m.attachments.map(f => f.id)))]
          assignment.status = run.status === 'complete' && messages.some(m => m.content.trim() || m.attachments.length) ? 'review' : 'failed'
          this.saveAssignment(owner, assignment)
        }
      }
      if (assignment.status === 'pending') {
        const dependencies = assignments.filter(a => assignment.dependsOn.includes(a.id))
        if (dependencies.some(a => ['failed', 'blocked', 'cancelled'].includes(a.status))) continue
        if (dependencies.some(a => a.status !== 'complete')) continue
        const target = this.store.get<Agent>(owner, 'agent', assignment.agentId)
        const team = this.store.require<Conversation>(owner, 'conversation', goal.conversationId)
        if (!target || target.archived || !this.store.taskMemberIds(owner,team,goal.id).includes(target.id)) {
          assignment.status = 'blocked';assignment.result = '负责成员已不可用';this.saveAssignment(owner, assignment);continue
        }
        try { this.runtime.nodes.requireSource(owner, target) }
        catch { assignment.status = 'blocked';assignment.result = '负责成员的基础 Profile 已撤权';this.saveAssignment(owner, assignment);continue }
        this.store.atomic(() => {
          const content = `由管理员分派的子任务：${assignment.title}\n${assignment.brief}\n验收要求：${assignment.acceptanceCriteria.join('；') || '提供实际结果及依据'}\n${assignment.review ? `上次复核意见：${assignment.review}\n` : ''}${dependencies.map(a => `依赖结果 ${a.title}：${a.result?.slice(0,1500)}`).join('\n')}\n完成后提交结果，由管理员复核，不要自行转交。`
          const originRun=this.store.get<Run>(owner,'run',goal.origin.runId)
          const inputFiles=originRun?this.store.get<Message>(owner,'message',originRun.messageId)?.attachments.map(file=>file.id)??[]:[]
          const fileIds=[...new Set([...inputFiles,...dependencies.flatMap(item=>item.artifactIds??[])])].slice(0,8)
          const run = this.runtime.dispatch(owner, goal.conversationId,
            { requestId: requestId(`assignment:${assignment.id}:${assignment.attempt}`), taskId: goal.id, content, fileIds },
            { agentId: goal.coordinatorId, assignmentId: assignment.id, targetAgentId: assignment.agentId, kind: 'assignment' })
          assignment.runId = run.id;assignment.attempt++;assignment.status = 'running';this.saveAssignment(owner, assignment)
        })
      }
    }
    const goalRuns = this.store.list<Run>(owner, 'run').filter(r => r.conversationId === goal.conversationId && r.conversationTaskId === goal.id)
    if (!assignments.length && !goalRuns.length) return
    const activeRuns = goalRuns.some(r => !terminalRun(r.status))
    if (activeRuns) return
    const reviewing = goal.reviewRunId && this.store.get<Run>(owner, 'run', goal.reviewRunId)
    if (reviewing && !terminalRun(reviewing.status)) return
    const batch = assignments.map(a => `${a.id}:${a.status}:${a.attempt}`).join('|') || 'initial'
    if (goal.lastReviewedBatch === batch) {
      if (goal.status === 'review') this.deliver(owner, goal, 'review', batch)
      return
    }
    if (!assignments.length || assignments.some(a => ['review', 'failed', 'blocked'].includes(a.status)) || assignments.every(a => ['complete','cancelled'].includes(a.status))) {
      goal.status = 'review';goal.lastReviewedBatch = batch;goal.revision++;this.saveGoal(owner, goal)
      this.deliver(owner, goal, 'review', batch)
    }
  }
  private deliver(owner: string, goal: AgentGoal, kind: TaskDelivery['kind'], batch: string): void {
    const id = requestId(`delivery:${goal.id}:${goal.activation??0}:${kind}:${batch}`)
    let delivery = this.store.get<TaskDelivery>(owner, 'task-delivery', id)
    if (delivery?.status === 'delivered' || delivery?.status === 'suppressed') return
    const source = this.store.get<Conversation>(owner, 'conversation', goal.origin.conversationId)
    const sourceRun = this.store.get<Run>(owner, 'run', goal.origin.runId)
    const canWake = this.authorized(owner, goal) && source && !source.archived && source.memberIds.includes(goal.origin.agentId)
      && sourceRun && !sourceRun.stopRequested && sourceRun.status !== 'interrupted'
      && (!goal.origin.conversationTaskId || this.store.get(owner, 'conversation-task', goal.origin.conversationTaskId))
    delivery ??= { id, goalId: goal.id, kind, status: 'pending', targetConversationId: goal.origin.conversationId,
      targetTaskId: goal.origin.conversationTaskId, createdAt: Date.now() }
    if (kind === 'terminal' && goal.reportingRunId) {
      const reported = this.store.get<Run>(owner, 'run', goal.reportingRunId)
      if (reported?.conversationId === goal.origin.conversationId && reported.conversationTaskId === goal.origin.conversationTaskId) {
        if (!terminalRun(reported.status)) return
        if (reported.status === 'complete' && this.store.messages(owner, reported.conversationId, Number.MAX_SAFE_INTEGER, 20, false, reported.conversationTaskId)
          .some(m => m.runId === reported.id && m.role === 'assistant' && m.content.trim())) {
          delivery.status = 'delivered';delivery.runId = reported.id;this.store.put(owner, 'task-delivery', id, delivery);return
        }
      }
    }
    if (!canWake || goal.automaticWakes >= 8) {
      delivery.status = 'suppressed';this.store.put(owner, 'task-delivery', id, delivery)
      return
    }
    const assignments = this.assignments(owner, goal.id)
    const taskTitle = this.store.get<Task>(owner,'conversation-task',goal.id)?.title || goal.objective.slice(0,100)
    const teamName = this.store.get<Conversation>(owner,'conversation',goal.conversationId)?.name || '团队'
    const statusLabel = {complete:'已完成',blocked:'遇到阻碍',waiting:'需要补充信息',review:'待复核',running:'进行中',cancelling:'正在停止',cancelled:'已停止'}[goal.status]
    const text = kind === 'terminal'
      ? `「${teamName}」的任务「${taskTitle}」${statusLabel}。\n${goal.result || ''}\n[打开任务](/conversations/${goal.conversationId}?taskId=${goal.id})`
      : `「${teamName}」的任务「${taskTitle}」已有执行结果，等待管理员复核。\n[打开任务](/conversations/${goal.conversationId}?taskId=${goal.id})`
    const instruction = `本条来自系统任务投递。团队 ID：${goal.conversationId}，目标/任务 ID：${goal.id}。目标：${goal.objective.slice(0,4000)}\n${assignments.slice(-12).map(a=>`${a.title}（${a.id}）：${a.status}\n${a.result?.slice(0,1000)||''}`).join('\n\n')}\n${kind==='terminal'?'向用户汇报实际结果，不要重复启动相同任务。':'请使用 workspace_get_team_task 读取完整状态，使用 workspace_review_assignment 复核成员结果，必要时调整方案；满足验收条件后使用 workspace_finish_team_task 记录完成。'}`
    this.store.atomic(() => {
      this.store.put(owner, 'task-delivery', id, delivery)
      const run = this.runtime.dispatch(owner, source!.id,
        { requestId: id, taskId: goal.origin.conversationTaskId, content: text, fileIds:[...new Set(assignments.flatMap(assignment=>assignment.artifactIds??[]))].slice(0,8) },
        { agentId: goal.coordinatorId, kind: kind === 'review' ? 'task_review' : 'task_result', instruction,
          taskReference:{conversationId:goal.conversationId,taskId:goal.id} })
      delivery!.runId = run.id;delivery!.status = 'delivered';this.store.put(owner, 'task-delivery', id, delivery)
      goal.automaticWakes++;this.saveGoal(owner, goal)
      if (kind === 'review') { goal.reviewRunId = run.id;this.saveGoal(owner, goal) }
    })
  }
  close(): void { this.closed = true;clearInterval(this.timer);this.unobserve() }
}
