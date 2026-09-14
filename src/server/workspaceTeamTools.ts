import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { agentInput, parse, type WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceNodes } from './workspaceGateway.js'
import type { WorkspaceRuntime } from './workspaceRuntime.js'
import { WORKSPACE_CONCURRENCY_LIMIT, type Work } from './workspaceScheduler.js'
import type { WorkspaceAgent as Agent, WorkspaceConversation as Conversation, WorkspaceRun as Run, WorkspaceInteraction } from '../shared/workspace.js'
import { requireTeamToolBridge } from './workspaceToolLease.js'
import { assignmentInput, assignmentReview, assignmentUpdate, assignmentCancel, finishGoalInput, resumeGoalInput, goalCriteriaInput } from './taskCoordinator.js'

const uuid = z.string().uuid()
const empty = z.object({}).strict()
const createAgent = agentInput.omit({ canManageTeam: true, allowHostEnvironment:true, vmExecution:true }).extend({ requestId: uuid,execution:z.enum(['profile','computer']).optional() }).strict()
const createHelper=agentInput.pick({name:true,instructions:true}).extend({requestId:uuid,goalId:uuid,profile:z.string().min(1).max(256).optional(),title:z.string().trim().min(1).max(100),brief:z.string().trim().min(1).max(16000),acceptanceCriteria:z.array(z.string().trim().min(1).max(1000)).max(12).default([]),dependsOn:z.array(uuid).max(12).default([])}).strict()
const createTeam = z.object({
  requestId: uuid,
  name: z.string().trim().min(1).max(100),
  memberIds: z.array(uuid).min(1).max(8),
  instructions: z.string().max(24_000).default(''),
  maxReplyRounds: z.number().int().min(1).max(12).default(6),
}).strict()
const startTask = z.object({
  requestId: uuid,
  teamId: uuid,
  title: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(32_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(12).default([]),
}).strict()
const getTask = z.object({ teamId: uuid, taskId: uuid }).strict()
const editCreatedAgent = z.object({requestId:uuid,agentId:uuid,name:z.string().trim().min(1).max(100).optional(),instructions:z.string().max(24000).optional()}).strict()
const archiveCreatedAgent = z.object({requestId:uuid,agentId:uuid,confirmName:z.string().min(1).max(100)}).strict()
const editTeam = z.object({requestId:uuid,teamId:uuid,name:z.string().trim().min(1).max(100).optional(),instructions:z.string().max(24000).optional(),memberIds:z.array(uuid).min(2).max(8).optional(),archived:z.boolean().optional()}).strict()

const definitions = [
  ['workspace_list_sources', '查看当前账号获准使用的基础机器人。创建成员前先查询。', empty],
  ['workspace_list_agents', '查看当前账号可复用的成员，优先复用已有机器人，避免重复创建。', empty],
  ['workspace_list_teams', '查看由你担任管理员的团队及其任务。', empty],
  ['workspace_create_agent', '创建持久保存的 Bot 机器人，复用已授权的基础 Profile。新成员不获得组队权限。requestId 使用新的 UUID；重试同一操作必须复用它。', createAgent],
  ['workspace_create_helper','为当前团队目标创建临时隔离助手并立即分派一个具体子任务。助手只参与此任务、不创建单聊、不获得组队权限；目标结束后退役。每个目标最多 8 个有效临时助手。优先用于一次性工作。',createHelper],
  ['workspace_create_team', '只建立持久团队，自动把你加入并设为管理员，不启动交付目标、不生成子任务或验收要求。其他成员使用真实机器人 ID，总人数最多 8 人。优先复用已有团队。requestId 使用新的 UUID，重试时复用。', createTeam],
  ['workspace_start_team_task', '仅当用户明确要求完成并交付具体结果时启动目标。简单问答、方案讨论、一次性咨询或仅创建群聊时不要调用。在当前群聊中可将当前话题升级为目标，在其他团队中启动独立话题；提炼少量可核对的验收要求。管理员可直接完成，不强制分工。立即返回不表示完成，requestId 重试时复用。', startTask],
  ['workspace_update_team_goal', '从用户的交付要求提炼验收条件，或按用户新指令调整。不要增加无关要求。expectedRevision 使用目标的 acceptanceRevision（旧记录默认为 1）；冲突时先重新读取，不覆盖用户的新修改。', goalCriteriaInput.extend({ goalId: uuid })],
  ['workspace_get_team_task', '读取你管理的团队任务的运行状态、最近 20 条结果和待处理问题。运行中不代表目标已完成；避免频繁轮询，用户可在团队内查看进展。', getTask],
  ['workspace_assign_task', '仅确实需要分工时创建有负责人、依赖和验收要求的子任务，能直接完成的工作不要拆分。仅可分派给团队内其他成员，依赖必须先完成复核。requestId 为重试复用的 UUID。', assignmentInput],
  ['workspace_review_assignment', '管理员复核子任务：accept 接受实际结果，retry 附具体修改意见后返工，blocked 记录受阻原因。失败执行不能直接验收通过。', assignmentReview],
  ['workspace_update_assignment', '调整尚未运行或已失败子任务的说明、验收要求和依赖。禁止依赖循环；正在执行的任务需要先停止。', assignmentUpdate],
  ['workspace_cancel_assignment', '停止一个子任务，必须记录原因。执行停止尚未确认时显示正在停止，不能当作已经撤销外部副作用。其他子任务和团队不受影响。', assignmentCancel],
  ['workspace_finish_team_task', '根据实际结果记录目标完成、受阻或等待用户。无需为完成而创建子任务；已有有效子任务须验收通过。完成时传入当前 acceptanceRevision 并逐项提供依据；结果会自动送回原始会话。', finishGoalInput],
  ['workspace_resume_team_task', '仅在当前用户的新指令中恢复受阻、等待或停止的目标。旧执行状态不确定时拒绝恢复；自动回传不能自行重新激活旧目标。', resumeGoalInput],
  ['workspace_update_created_agent', '调整你创建的成员的名称或职责，不能修改基础 Profile 或权限。变更从后续轮次生效。', editCreatedAgent],
  ['workspace_archive_created_agent', '归档你创建且已不再被有效团队引用的空闲成员，保留历史；confirmName 必须与当前名称完全一致。不能归档其他人创建的成员。', archiveCreatedAgent],
  ['workspace_update_team', '调整你管理的空闲团队名称、规则或成员，或归档已结束的团队。不能更换管理员或修改正在执行的团队。', editTeam],
] as const

export const TEAM_TOOL_RULES = '你已获准在 Bot 模式组建团队，但组建团队与执行交付目标是两件事。用户只要求建群或组人时，先查看可用基础机器人、成员和团队，复用或创建最少成员，建立团队后告诉用户可以开始聊天，到此结束，不启动目标、不拆子任务、不生成验收清单。简单问答、方案讨论和一次性咨询直接回答，必要时在普通群聊 @成员，不升级为目标。只有用户明确要求把具体工作做完并交付结果，或选择了交付目标时，才使用 workspace_start_team_task；已存在当前目标时直接推进，不重复启动。验收要求从用户原始要求提炼，少量、具体、可核对，允许用户调整，不增加范围。管理员能直接完成就直接完成；只有需要不同成员协作的工作才用 workspace_assign_task 按需拆分，依赖也只在真实需要时设置，结果用 workspace_review_assignment 复核。确需一次性专家时可用 workspace_create_helper；长期角色才创建持久成员。每次变更生成 requestId（UUID），重试同一操作复用它。queued/running 只表示已启动；完成时使用 workspace_finish_team_task 提供当前 acceptanceRevision 和逐项实际依据。向用户主要报告进展、阻碍和最终结果，详细计划与验收留在可展开的进度面板，不在每次回复重复清单。受阻或停止的目标只能在用户新指令下恢复。新成员没有组队权限，角色描述不能扩展权限。'

/** The caller identity comes exclusively from the running server-side turn. */
export class WorkspaceTeamTools {
  constructor(readonly store: WorkspaceStore, readonly nodes: WorkspaceNodes, readonly runtime: WorkspaceRuntime) {}

  async requireAvailable(owner: string, agent: Pick<Agent, 'nodeId' | 'profile' | 'remoteAgentId' | 'execution'>): Promise<void> {
    this.nodes.requireSource(owner, agent)
    if ((agent.nodeId !== 'local' && !this.nodes.runnerTarget?.(owner,agent.nodeId)) || agent.remoteAgentId)
      throw new HttpError(409, '组队发起者需要使用与 Web 服务同机的基础机器人；远程机器人可作为团队成员。', 'team_tools_local_required')
    if(agent.execution==='computer'){
      const target=this.nodes.runnerTarget?.(owner,agent.nodeId)
      if(!target)throw new HttpError(409,'隔离电脑需要连接执行节点','computer_runner_required')
      const response=await target.session.request('/api/computer/capabilities',{search:new URLSearchParams({profile:agent.profile})})
      if(response.status!==200||JSON.parse(response.body.toString()).ready!==true)throw new HttpError(409,'执行节点尚未配置隔离电脑 Worker','computer_unavailable')
    }else await requireTeamToolBridge(this.nodes.target(owner, agent.nodeId), agent.profile)
    this.nodes.requireSource(owner, agent)
  }

  assertTurn(owner: string, workId: string): { agent: Agent; work: Work } {
    if (!this.runtime.userActive(owner)) throw new HttpError(403, '账号授权已失效', 'team_tools_forbidden')
    const work = this.store.require<Work>(owner, 'turn', workId)
    const agent = this.store.require<Agent>(owner, 'agent', work.agentId)
    const c = this.store.require<Conversation>(owner, 'conversation', work.conversationId)
    const root = this.store.require<Run>(owner, 'run', work.runId)
    this.nodes.requireSource(owner, agent)
    if (agent.canManageTeam !== true || agent.archived || (agent.nodeId !== 'local' && !this.nodes.runnerTarget?.(owner,agent.nodeId)) || agent.remoteAgentId || root.assignmentId
      || work.teamManagementRevision !== agent.revision
      || (root.authorizationVersion !== undefined && root.authorizationVersion !== this.runtime.authorizationVersion(owner))
      || c.archived || !c.memberIds.includes(agent.id) || work.cancelRequested || root.stopRequested
      || !['running', 'waiting'].includes(work.status))
      throw new HttpError(403, '当前机器人的本轮组队授权已失效', 'team_tools_forbidden')
    return { agent, work }
  }

  catalog(owner: string, workId: string) {
    const {agent}=this.assertTurn(owner, workId)
    const helpers=this.nodes.runnerTarget?.(owner,agent.nodeId)?.runner?.helperRetirement===true
    return definitions.filter(([id])=>id!=='workspace_create_helper'||helpers).map(([id, description, schema]) => ({ id, name: id, description, inputSchema: z.toJSONSchema(schema) }))
  }

  private usable(owner: string, agent: Agent): boolean {
    if (agent.archived) return false
    try { this.nodes.requireSource(owner, agent); return true } catch { return false }
  }

  private team(owner: string, agentId: string, teamId: string): Conversation {
    const c = this.store.require<Conversation>(owner, 'conversation', teamId)
    if (c.kind !== 'group' || c.archived || c.administratorId !== agentId || !c.memberIds.includes(agentId))
      throw new HttpError(403, '只能操作由当前机器人担任管理员的有效团队', 'team_tools_forbidden')
    for (const id of c.memberIds) {
      const member = this.store.require<Agent>(owner, 'agent', id)
      this.nodes.requireSource(owner, member)
      if (member.archived) throw new HttpError(409, '团队成员已归档', 'agent_archived')
    }
    return c
  }

  async call(owner: string, workId: string, toolId: string, input: unknown): Promise<unknown> {
    const { agent, work } = this.assertTurn(owner, workId)
    if (toolId === 'workspace_list_sources') {
      parse(empty, input)
      const sources = await this.nodes.sources(owner)
      this.assertTurn(owner, workId)
      return { sources: sources.sources.filter(source => {
        try { this.nodes.requireSource(owner, source); return true } catch { return false }
      }), errors: sources.errors }
    }
    if (toolId === 'workspace_list_agents') {
      parse(empty, input)
      return { agents: this.store.list<Agent>(owner, 'agent').filter(a => this.usable(owner, a))
        .map(({ id, name, nodeId, profile, instructions }) => ({ id, name, nodeId, profile, instructions: instructions.slice(0, 2000) })) }
    }
    if (toolId === 'workspace_list_teams') {
      parse(empty, input)
      return { teams: this.store.list<Conversation>(owner, 'conversation').filter(c => {
        try { this.team(owner, agent.id, c.id); return true } catch { return false }
      }).map(c => ({ id: c.id, name: c.name, memberIds: c.memberIds, tasks: this.store.tasks(owner, c.id).slice(0, 20) })) }
    }
    if(toolId==='workspace_create_helper'){
      const body=parse(createHelper,input)
      const goal=this.runtime.tasks.requireCoordinator(owner,body.goalId,agent.id)
      if(!['running','review'].includes(goal.status))throw new HttpError(409,'目标已结束，不能创建临时助手','goal_terminal')
      const source={nodeId:agent.nodeId,profile:body.profile??agent.profile,execution:'computer' as const}
      await this.requireAvailable(owner,source);this.assertTurn(owner,workId)
      const runner=this.nodes.runnerTarget?.(owner,source.nodeId)?.runner,runnerId=runner?.id
      if(!runnerId||!runner.helperRetirement)throw new HttpError(409,'临时助手需要电脑执行节点','computer_runner_required')
      return this.store.command(owner,body.requestId,{agentId:agent.id,toolId,...body},()=>{
        const current=this.runtime.tasks.requireCoordinator(owner,goal.id,agent.id)
        if(current.activation!==goal.activation||!['running','review'].includes(current.status))throw new HttpError(409,'任务已变化，请重新读取状态','goal_changed')
        const all=this.store.list<Agent>(owner,'agent'),helpers=all.filter(item=>item.temporaryGoalId===goal.id)
        if(helpers.filter(item=>!item.archived).length>=8||helpers.length>=32)throw new HttpError(409,'临时助手已达任务上限，请复用现有助手','helper_limit')
        let name=body.name,index=2
        while(all.some(item=>item.name.toLocaleLowerCase()===name.toLocaleLowerCase()))name=`${body.name.slice(0,80)} · 临时${index++}`
        const helper=this.store.createAgent(owner,{...source,name,instructions:body.instructions,canManageTeam:false},{createdByAgentId:agent.id,createdFromRunId:work.runId,temporaryGoalId:goal.id,helperActivation:goal.activation??1,helperRunnerId:runnerId})
        const assignment=this.runtime.tasks.createAssignment(owner,agent.id,{requestId:randomUUID(),goalId:goal.id,agentId:helper.id,title:body.title,brief:body.brief,acceptanceCriteria:body.acceptanceCriteria,dependsOn:body.dependsOn})
        return {helper:this.store.agentSummary(helper),assignment}
      })
    }
    if (toolId === 'workspace_create_agent') {
      const { requestId, ...body } = parse(createAgent, input)
      body.execution??=agent.execution??'profile'
      if(agent.execution==='computer'&&body.execution!=='computer')throw new HttpError(403,'隔离机器人创建的成员必须使用隔离电脑','computer_scope_escalation')
      this.nodes.requireSource(owner, body)
      const sources = await this.nodes.sources(owner)
      this.assertTurn(owner, workId)
      this.nodes.requireSource(owner, body)
      if (!sources.sources.some(s => s.nodeId === body.nodeId && s.profile === body.profile))
        throw new HttpError(409, '基础机器人当前不可用', 'source_unavailable')
      if(body.execution==='computer'){await this.requireAvailable(owner,body);this.assertTurn(owner,workId)}
      return this.store.command(owner, requestId, { agentId: agent.id, toolId, body }, () => {
        if (this.store.list<Agent>(owner, 'agent').filter(a => !a.archived).length >= 100)
          throw new HttpError(409, '自动组队最多保留 100 个有效机器人，请先复用或归档已有成员。', 'team_agent_limit')
        const created = this.store.createAgent(owner, { ...body, canManageTeam: false }, { createdByAgentId: agent.id, createdFromRunId: work.runId })
        return { agent: this.store.agentSummary(created) }
      })
    }
    if (toolId === 'workspace_create_team') {
      const { requestId, ...body } = parse(createTeam, input)
      const memberIds = [...new Set([agent.id, ...body.memberIds])]
      if (memberIds.length < 2 || memberIds.length > 8)
        throw new HttpError(400, '团队包含管理员在内需要 2 至 8 名成员', 'invalid_members')
      for (const id of memberIds) this.nodes.requireSource(owner, this.store.require<Agent>(owner, 'agent', id))
      return this.store.command(owner, requestId, { agentId: agent.id, toolId, body }, () => {
        const teams = this.store.list<Conversation>(owner, 'conversation').filter(c => c.kind === 'group' && !c.archived && c.administratorId === agent.id)
        if (teams.length >= 20) throw new HttpError(409, '自动组队最多管理 20 个有效团队，请先复用已有团队。', 'team_count_limit')
        if (teams.some(c => c.name.toLocaleLowerCase() === body.name.toLocaleLowerCase()))
          throw new HttpError(409, '已有同名团队，请先查询并复用', 'duplicate_team_name')
        const team = this.store.createGroup(owner, { ...body, memberIds, administratorId: agent.id, mode: 'host', autoReplyIds: [] })
        this.runtime.onTeamCreated(owner, team)
        return { team, task: this.store.tasks(owner, team.id)[0] }
      })
    }
    if (toolId === 'workspace_start_team_task') {
      const { requestId, ...body } = parse(startTask, input)
      const team = this.team(owner, agent.id, body.teamId)
      const sourceRun = this.store.require<Run>(owner, 'run', work.runId)
      const sourceMessage = this.store.require<{role: string}>(owner, 'message', sourceRun.messageId)
      if (sourceRun.triggerKind || sourceMessage.role !== 'user' || sourceRun.conversationId !== work.conversationId)
        throw new HttpError(409, '新目标需要用户的交付指令，自动回传不能重复启动目标', 'team_task_reentrant')
      return this.store.command(owner, requestId, { agentId: agent.id, toolId, body }, () => {
        if (team.id === work.conversationId) {
          const task = this.store.requireTask(owner, team.id, work.conversationTaskId!)
          const goal = this.runtime.tasks.begin(owner, task, agent, body.content,
            { conversationId: team.id, conversationTaskId: task.id, runId: work.runId, agentId: agent.id }, body.acceptanceCriteria)
          sourceRun.goalId = goal.id
          sourceRun.targetAgentId = agent.id
          this.store.saveRun(owner, sourceRun)
          return { teamId: team.id, teamName: team.name, task: { ...task, goal }, run: sourceRun, message: '当前话题已作为交付目标，请按需直接完成或分工，不要重复启动。' }
        }
        if (this.store.activeTaskCount(owner, team.id) >= WORKSPACE_CONCURRENCY_LIMIT)
          throw new HttpError(409, `最多同时运行 ${WORKSPACE_CONCURRENCY_LIMIT} 个任务`, 'workspace_task_concurrency_limit')
        const emptyTask = this.store.tasks(owner, team.id).find(t => t.messageCount === 0 && !t.activeRunId && t.titleSource === 'automatic')
        const task = emptyTask
          ? this.store.updateTask(owner, team.id, emptyTask.id, { title: body.title })
          : this.store.createTask(owner, team.id, { title: body.title })
        const goal = this.runtime.tasks.begin(owner, task, agent, body.content,
          { conversationId: work.conversationId, conversationTaskId: work.conversationTaskId, runId: work.runId, agentId: agent.id }, body.acceptanceCriteria)
        const run = this.runtime.dispatch(owner, team.id, { requestId: randomUUID(), taskId: task.id, content: `由机器人「${agent.name}」发起的团队任务：\n${body.content}` }, { agentId: agent.id, kind: 'task_review' })
        return { teamId: team.id, teamName: team.name, task: { ...task, goal }, run, message: '任务已启动，尚未完成。执行结果会回到原会话，由管理员复核。' }
      })
    }
    if (toolId === 'workspace_get_team_task') {
      const body = parse(getTask, input)
      const team = this.team(owner, agent.id, body.teamId)
      const task = this.store.requireTask(owner, team.id, body.taskId)
      const runs = this.store.list<Run>(owner, 'run').filter(r => r.conversationId === team.id && r.conversationTaskId === task.id)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 4)
      const messages = this.store.messages(owner, team.id, Number.MAX_SAFE_INTEGER, 20, false, task.id)
        .map(m => ({ id: m.id, role: m.role, agentName: m.agentName, status: m.status, content: m.content.slice(0, 4000), attachments: m.attachments }))
      const interactions = this.store.list<WorkspaceInteraction>(owner, 'interaction')
        .filter(i => i.conversationId === team.id && i.conversationTaskId === task.id && !i.resolved)
        .map(({ agentId, kind, message, choices }) => ({ agentId, kind, message, choices }))
      return { teamId: team.id, teamName: team.name, task, runs, messages, interactions,
        assignments: this.runtime.tasks.assignments(owner, task.id) }
    }
    if (toolId === 'workspace_assign_task') return { assignment: this.runtime.tasks.createAssignment(owner, agent.id, input) }
    if (toolId === 'workspace_update_team_goal') {
      const { goalId, ...body } = parse(goalCriteriaInput.extend({ goalId: uuid }), input)
      return { goal: this.runtime.tasks.updateCriteria(owner, goalId, body, agent.id) }
    }
    if (toolId === 'workspace_review_assignment') return { assignment: this.runtime.tasks.reviewAssignment(owner, agent.id, input) }
    if (toolId === 'workspace_update_assignment') return { assignment: this.runtime.tasks.updateAssignment(owner, agent.id, input) }
    if (toolId === 'workspace_cancel_assignment') return { assignment: this.runtime.tasks.cancelAssignment(owner, agent.id, input) }
    if (toolId === 'workspace_finish_team_task') return { goal: this.runtime.tasks.finish(owner, agent.id, input, work.runId) }
    if (toolId === 'workspace_resume_team_task') return { goal: this.runtime.tasks.resume(owner,agent.id,input,{conversationId:work.conversationId,conversationTaskId:work.conversationTaskId,runId:work.runId,agentId:agent.id}) }
    if (toolId === 'workspace_update_created_agent' || toolId === 'workspace_archive_created_agent') {
      const body = toolId === 'workspace_update_created_agent' ? parse(editCreatedAgent,input) : parse(archiveCreatedAgent,input)
      const target = this.store.require<Agent>(owner,'agent',body.agentId)
      if (target.id === agent.id || target.createdByAgentId !== agent.id) throw new HttpError(403,'只能管理自己创建的成员','agent_creator_required')
      this.nodes.requireSource(owner,target)
      return this.store.command(owner,body.requestId,{agentId:agent.id,toolId,body},()=>{
        if ('confirmName' in body) {
          if (body.confirmName !== target.name) throw new HttpError(400,'成员名称不匹配','agent_name_mismatch')
          if (this.store.list<Conversation>(owner,'conversation').some(c=>c.kind==='group'&&!c.archived&&c.memberIds.includes(target.id)))
            throw new HttpError(409,'成员仍被有效团队使用，请先调整或归档团队','agent_in_use')
          if (this.store.list<Work>(owner,'turn').some(w=>w.agentId===target.id&&!['complete','failed','interrupted'].includes(w.status)))
            throw new HttpError(409,'成员仍在执行任务','agent_in_use')
          return {agent:this.store.agentSummary(this.store.updateAgent(owner,target.id,{archived:true}))}
        }
        const {requestId:_request,agentId:_target,...patch}=body
        return {agent:this.store.agentSummary(this.store.updateAgent(owner,target.id,patch))}
      })
    }
    if (toolId === 'workspace_update_team') {
      const {requestId,...body}=parse(editTeam,input), team=this.team(owner,agent.id,body.teamId)
      if (this.store.list<Run>(owner,'run').some(r=>r.conversationId===team.id&&!['complete','failed','interrupted'].includes(r.status)))
        throw new HttpError(409,'请在团队当前执行结束后调整','team_busy')
      if (body.archived && this.store.list<import('../shared/agentTasks.js').AgentGoal>(owner,'goal').some(g=>g.conversationId===team.id&&!['complete','blocked','cancelled'].includes(g.status)))
        throw new HttpError(409,'团队仍有未结束的目标','team_busy')
      if (body.memberIds && !body.memberIds.includes(agent.id)) throw new HttpError(400,'团队必须保留当前管理员','invalid_members')
      for (const id of body.memberIds??[]) this.nodes.requireSource(owner,this.store.require<Agent>(owner,'agent',id))
      return this.store.command(owner,requestId,{agentId:agent.id,toolId,body},()=>{
        const {teamId:_team,...patch}=body
        return {team:this.store.updateConversation(owner,team.id,patch)}
      })
    }
    throw new HttpError(404, '本轮未授权此工具', 'team_tool_not_found')
  }
}
