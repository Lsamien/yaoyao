import {DESKTOP_ENVIRONMENT_TOOLS,DESKTOP_ENVIRONMENT_RULES,type DesktopEnvironments} from './desktopEnvironments.js'
import {GROK_COMPUTER_TOOLS,grokComputerRules,type GrokCloud} from './grokCloud.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { WorkspaceStore, parse } from './workspaceStore.js'
import { WorkspaceNodes, WorkspaceGateway, type GatewayFrame } from './workspaceGateway.js'
import { HttpError } from './errors.js'
import { applyWorkingDirectory, configuredWorkingDirectory } from './sessionWorkingDirectory.js'
import {type StoredWorkspaceFile} from './workspaceAssets.js'
import { UploadStore } from './uploads.js'
import type {
  WorkspaceAgent as Agent,
  WorkspaceConversation as Conversation,
  WorkspaceMessage as Message,
  WorkspaceRun,
  WorkspaceInteraction,
} from '../shared/workspace.js'

import { WorkspaceScheduler, type Work, NO_REPLY, HOST_FALLBACK } from './workspaceScheduler.js'
import type { WorkspacePlugins, OpenBotPlugins } from './botPlugins/workspacePlugins.js'
import { mentionedAgents } from './workspaceMentions.js'
import { WorkspaceTeamTools, TEAM_TOOL_RULES } from './workspaceTeamTools.js'
import { createWorkspaceToolLease, type WorkspaceToolLease } from './workspaceToolLease.js'
import { WorkspaceTaskCoordinator } from './taskCoordinator.js'
export { mentionedAgents } from './workspaceMentions.js'
type Run = WorkspaceRun

export interface WorkspaceBinding {
  runnerId?: string
  execution?:string
  computerEnvironmentId?:string
  remoteAgentId?: string
  id: string
  nodeId: string
  profile: string
  storedId: string
  runtimeId: string
  aliases: string[]
  runId: string
  messageId: string
  conversationTaskId?: string
  taskId?: string
  contextSeq?: number
}
interface LiveTurn {
  gateway: WorkspaceGateway
  runtimeId: string
  runId: string
  agentId: string
  conversationTaskId?: string
  taskId: string
  done(error?: Error): void
}
export const sendInput = z
  .object({
    requestId: z.string().uuid(),
    content: z.string().max(65_536).default(''),
    taskId: z.string().uuid().optional(),
    mode: z.enum(['chat', 'goal']).optional(),
    mentionIds: z.array(z.string().uuid()).max(8).default([]),
    fileIds: z.array(z.string().uuid()).max(8).default([]),
  })
  .strict()
  .refine((b) => b.content.trim() || b.fileIds.length, '请输入消息或添加附件')
export class WorkspaceRuntime extends WorkspaceScheduler {
  plugins?: WorkspacePlugins
  get idleForUpdate(): boolean {
    return this.live.size === 0 && this.executing.size === 0 && !this.store.db.prepare("SELECT 1 FROM workspace_entities WHERE kind IN ('run','turn') AND COALESCE(json_extract(data,'$.status'),'unknown') NOT IN ('complete','failed','interrupted') LIMIT 1").get()
  }
  desktopEnvironments?:DesktopEnvironments
  cloud?:GrokCloud
  inspector?:import('./workspaceInspector.js').WorkspaceInspector
  private live = new Map<string, LiveTurn>()
  readonly teamTools: WorkspaceTeamTools
  readonly tasks: WorkspaceTaskCoordinator
  retireHelper:(owner:string,helper:Agent)=>Promise<void>=async()=>{throw new Error('电脑清理服务未连接')}
  publishArtifact:(owner:string,message:Message,agent:Agent,name:string,bytes:Buffer)=>import('../shared/workspace.js').WorkspaceFile=()=>{throw new Error('产物服务未初始化')}
  onTeamCreated: (owner: string, team: Conversation) => void = () => {}
  constructor(store: WorkspaceStore, readonly nodes: WorkspaceNodes, readonly uploads: UploadStore, userActive: (owner: string) => boolean = () => true,
    readonly authorizationVersion: (owner: string) => number = () => 0) {
    super(store, userActive)
    this.teamTools = new WorkspaceTeamTools(store, nodes, this)
    this.tasks = new WorkspaceTaskCoordinator(store, this)
  }
  send(owner: string, conversationId: string, input: unknown): Run {
    return this.submit(owner, conversationId, input)
  }
  /** Server-owned provenance. This is never exposed as a model-supplied identity. */
  dispatch(owner: string, conversationId: string, input: unknown, source: {
    agentId: string; assignmentId?: string; targetAgentId?: string; kind: NonNullable<Run['triggerKind']>; instruction?: string; taskReference?: {conversationId:string;taskId:string}
  }): Run {
    this.nodes.requireSource(owner, this.store.require<Agent>(owner, 'agent', source.agentId))
    return this.submit(owner, conversationId, input, source)
  }
  private files(owner:string,ids:string[]){return ids.map(id=>{const file=this.store.get<StoredWorkspaceFile>(owner,'file',id);if(file){if(file.sourceNodeId&&file.profile)this.nodes.requireSource(owner,{nodeId:file.sourceNodeId,profile:file.profile});return file}return {...this.uploads.records([id],owner)[0]!,sender:'user' as const}})}
  private submit(owner: string, conversationId: string, input: unknown, source?: {
    agentId: string; assignmentId?: string; targetAgentId?: string; kind: NonNullable<Run['triggerKind']>; instruction?: string; taskReference?: {conversationId:string;taskId:string}
  }): Run {
    if (!this.userActive(owner)) throw new HttpError(403,'账号授权已失效','account_inactive')
    const body = parse(sendInput, input)
    for (const id of this.store.require<Conversation>(owner, 'conversation', conversationId).memberIds)
      this.nodes.requireSource(owner, this.store.require<Agent>(owner, 'agent', id))
    const result = this.store.command(owner, body.requestId, { conversationId, ...body, ...(source ? { source } : {}) }, () => {
      const c = this.store.require<Conversation>(owner, 'conversation', conversationId)
      if (c.archived) throw new HttpError(409, '聊天已归档', 'conversation_archived')
      const conversationTask = this.store.resolveTask(owner, conversationId, body.taskId),
        conversationTaskId = conversationTask?.id
      if (conversationTaskId) {
        const alreadyActive = this.store.list<Run>(owner, 'run').some(run => run.conversationTaskId === conversationTaskId && !['complete', 'failed', 'interrupted'].includes(run.status))
        if (!alreadyActive && this.store.activeTaskCount(owner, conversationId) >= 4)
          throw new HttpError(409, '最多同时运行 4 个任务', 'workspace_task_concurrency_limit')
      }
      if (body.mentionIds.some((a) => !this.store.taskMemberIds(owner,c,conversationTaskId).includes(a)))
        throw new HttpError(400, '只能 @ 群内成员', 'invalid_mentions')
      const records = this.files(owner,body.fileIds)
      const now = Date.now(),
        runId = randomUUID(),
        agents = this.store.taskMemberIds(owner,c,conversationTaskId).map((id) => this.store.require<Agent>(owner, 'agent', id))
      let goal = conversationTaskId ? this.store.get<import('../shared/agentTasks.js').AgentGoal>(owner, 'goal', conversationTaskId) : undefined
      if (body.mode === 'goal') {
        if (source || c.kind !== 'group' || !conversationTask || !body.content.trim())
          throw new HttpError(400, '请在群聊中说明需要交付的结果', 'goal_request_invalid')
        if (goal) throw new HttpError(409, '当前话题已有目标，请继续原目标或新建话题', 'goal_exists')
        const coordinator = this.store.require<Agent>(owner, 'agent', c.administratorId)
        if (!coordinator.canManageTeam || coordinator.archived || coordinator.remoteAgentId)
          throw new HttpError(403, '请先为负责人开启允许组建团队', 'goal_forbidden')
        if (this.store.list<Run>(owner, 'run').some(r => r.conversationTaskId === conversationTaskId && !['complete', 'failed', 'interrupted'].includes(r.status)))
          throw new HttpError(409, '请等待当前回复结束后再启动目标', 'goal_busy')
        goal = this.tasks.begin(owner, conversationTask, coordinator, body.content.trim(),
          { conversationId, conversationTaskId, runId, agentId: coordinator.id })
      }
      const mentions = [
        ...new Set(
          [...body.mentionIds, ...mentionedAgents(body.content, agents)],
        ),
      ]
      const message: Message = {
        id: randomUUID(),
        conversationId,
        conversationTaskId,
        seq: 0,
        role: source ? 'system' : 'user',
        ...(source?.taskReference ? {taskReference:source.taskReference} : {}),
        ...(source ? { agentId: source.agentId, agentName: this.store.require<Agent>(owner, 'agent', source.agentId).name } : {}),
        content: body.content.trim(),
        reasoning: '',
        runId,
        status: 'complete',
        attachments: records.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          sender: f.sender,
          createdAt: now,
        })),
        tools: [],
        createdAt: now,
      }
      this.store.saveMessage(owner, message)
      for (const file of records) {
        const existing = this.store.get<Record<string, unknown>>(owner, 'file', file.id)
        if (existing && !existing.messageId)
          this.store.put(owner, 'file', file.id, {
            ...existing,
            conversationId,
            messageId: message.id,
          })
      }
      const run: Run = {
        id: runId,
        conversationId,
        conversationTaskId,
        messageId: message.id,
        mentionIds: mentions,
        activeAgentId: c.administratorId,
        status: 'queued',
        round: 0,
        createdAt: now,
        updatedAt: now,
        authorizationVersion: this.authorizationVersion(owner),
        ...(source ? { assignmentId: source.assignmentId, targetAgentId: source.targetAgentId, triggerKind: source.kind, internalInstruction: source.instruction } : {}),
        ...(goal && ['running', 'review', 'waiting'].includes(goal.status) ? { goalId: goal.id, targetAgentId: source?.targetAgentId ?? goal.coordinatorId } : {}),
      }
      this.admit(owner, run, c, message)
      this.uploads.markReferenced(body.fileIds, owner)
      return run
    })
    this.wake()
    return this.store.require<Run>(owner, 'run', result.id)
  }
  protected async performTurn(
    owner: string,
    c: Conversation,
    agent: Agent,
    run: Work,
    recovering = false,
  ): Promise<Message> {
    this.requireAuthorization(owner, run.runId)
    this.store.requireAgentTask(owner,agent,c.id,run.conversationTaskId)
    this.nodes.requireSource(owner, agent)
    if (agent.remoteAgentId) agent = await this.nodes.refreshRemoteAgent(owner,agent)
    const key = this.bindingKey(c.id, run.conversationTaskId, agent.id),
      target = agent.remoteAgentId || agent.execution==='computer' ? this.nodes.targetForAgent(owner,agent) : this.nodes.target(owner, agent.nodeId)
    const gateway = new WorkspaceGateway(target,{workId:run.id,publishArtifact:async(name,bytes)=>{
      this.requireAuthorization(owner,run.runId);this.nodes.requireSource(owner,agent)
      const file=this.publishArtifact(owner,resultMessage,agent,name,bytes)
      if(!resultMessage.attachments.some(item=>item.id===file.id))resultMessage.attachments.push(file)
      this.store.saveMessage(owner,resultMessage)
      return {...file,url:`/api/app/files/${file.id}/download`}
    },authorize:()=>{
      this.requireAuthorization(owner,run.runId);this.nodes.requireSource(owner,agent)
      const current=this.getWork(owner,run.id),latest=this.store.require<Agent>(owner,'agent',agent.id),conversation=this.store.require<Conversation>(owner,'conversation',c.id)
      if(this.closing||conversation.archived||!this.store.taskMemberIds(owner,conversation,run.conversationTaskId).includes(agent.id)||this.store.require<Run>(owner,'run',run.runId).stopRequested||current.cancelRequested||['interrupted','complete','failed'].includes(current.status)||latest.archived||latest.computerEnvironmentId!==agent.computerEnvironmentId||(latest.allowHostEnvironment===true)!==(agent.allowHostEnvironment===true)||(latest.execution??'profile')!==(agent.execution??'profile')||latest.teamAuthorizationVersion!==agent.teamAuthorizationVersion)throw new HttpError(403,'本轮机器人或任务授权已结束','run_authorization_revoked')
    }})
    gateway.onTrace=entry=>this.inspector?.record(owner,c.id,{...entry,agentId:agent.id,runId:run.runId,taskId:run.conversationTaskId})
    let binding = this.store.get<WorkspaceBinding>(owner, 'binding', key)
    const movedRunner=!!this.store.get(owner,'binding-reset',key)||!!binding&&(binding.computerEnvironmentId!==agent.computerEnvironmentId||binding.runnerId!==target.runner?.id||(binding.execution??'profile')!==(agent.execution??'profile'))
    if(movedRunner) {
      if(recovering)throw new HttpError(409,'执行节点已变化，不能在另一节点重放原执行','runner_target_changed')
      binding=undefined
    }
    let message =
      run.currentMessageId
        ? this.store.require<Message>(owner, 'message', run.currentMessageId)
        : undefined
    if (!message) {
      message = {
        id: randomUUID(),
        conversationId: c.id,
        conversationTaskId: run.conversationTaskId,
        seq: 0,
        role: 'assistant',
        execution:agent.execution??'profile',
        agentId: agent.id,
        agentName: agent.name,
        content: '',
        reasoning: '',
        status: 'streaming',
        runId: run.runId,
        taskId: run.id,
        visible: run.replyMode !== 'automatic' || run.requiredReply,
        tools: [],
        attachments: [],
        createdAt: Date.now(),
      }
      run.currentMessageId = message.id
      this.store.atomic(() => {
        this.store.saveMessage(owner, message!)
        this.saveWork(owner, run)
      })
    }
    if(!recovering&&message.status==='queued'){message.status='streaming';message.error=undefined;message.visible=run.replyMode!=='automatic'||run.requiredReply}
    const resultMessage = message
    let submitted = recovering,
      settled = false,
      completedEvidence = false,
      completing = false,
      runtimeId = '',
      lastFlush = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const toolController = new AbortController()
    let toolLease: WorkspaceToolLease | undefined
    let pluginLease: OpenBotPlugins | undefined
    let resolveTurn!: (m: Message) => void, rejectTurn!: (e: Error) => void
    const completion = new Promise<Message>((resolve, reject) => {
      resolveTurn = resolve
      rejectTurn = reject
    })
    // Register rejection immediately; setup RPCs can still be awaiting a reply.
    void completion.catch(() => {})
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      toolController.abort()
      void toolLease?.dispose()
      void pluginLease?.dispose()
      clearTimeout(flushTimer)
      flushTimer = undefined
      this.live.delete(key)
      try {
        const current = this.getWork(owner, run.id)
        if(error&&!submitted&&current.status!=='interrupted'&&error instanceof HttpError&&['computer_busy','computer_quota','runner_offline'].includes(error.code??'')){
          current.status='queued';current.resourceWait=true;current.error='等待执行节点或电脑资源';resultMessage.status='queued';resultMessage.visible=false;resultMessage.error=undefined
        }else if (error) {
          current.status = current.status === 'interrupted' ? 'interrupted' : submitted ? 'uncertain' : 'failed'
          current.error = error.message.slice(0, 1000)
          resultMessage.status = current.status
          resultMessage.error = current.error
          const optionalUnpublished = current.replyMode === 'automatic' && !current.requiredReply && resultMessage.visible === false
          resultMessage.visible = !optionalUnpublished && (submitted || current.status !== 'interrupted')
          if (!resultMessage.content.trim() && current.status === 'failed') resultMessage.content = `执行失败：${current.error}`
        } else {
          const silent = (resultMessage.content.trim() === NO_REPLY || !resultMessage.content.trim()) && current.replyMode === 'automatic' && (!current.requiredReply || current.hadInteraction) && !resultMessage.tools.length && !resultMessage.attachments.length
          current.silent = silent
          if (current.replyMode === 'automatic') {
            resultMessage.content = resultMessage.content.replace(/\[\[YAOYAO_[A-Z0-9_]*(?:\]\])?/g, '').trim()
            resultMessage.reasoning = resultMessage.reasoning.replace(/\[\[YAOYAO_[A-Z0-9_]*(?:\]\])?/g, '')
          }
          if (current.requiredReply && !silent && !resultMessage.content) resultMessage.content = HOST_FALLBACK
          if (!silent && !resultMessage.content && !resultMessage.attachments.length && !resultMessage.tools.length) {
            current.status = 'failed'; current.error = '未返回有效回复'; resultMessage.content = '执行失败：未返回有效回复'
          } else { current.status = 'complete'; current.error = undefined }
          resultMessage.visible = !silent
          if (silent) resultMessage.reasoning = ''
          resultMessage.status = current.status
          resultMessage.error = current.error
        }
        if (current.status !== 'uncertain') {
          for (const tool of resultMessage.tools) {
            if (!/complete|error|failed/.test(String(tool.status))) tool.status = current.status === 'complete' ? 'tool.complete' : 'tool.error'
          }
        }
        this.store.atomic(() => {
          this.store.saveMessage(owner, resultMessage)
          this.saveWork(owner, current)
          if (current.status !== 'uncertain') this.resolveInteractions(owner, current.id)
        })
        if (error) rejectTurn(error)
        else resolveTurn(resultMessage)
      } catch (failure) { rejectTurn(failure instanceof Error ? failure : new Error('无法保存执行状态')) }
      finally { gateway.close() }
    }
    gateway.onDisconnect = () =>
      finish(completedEvidence ? undefined : new Error('Hermes 连接断开'))
    gateway.onEvent = (frame: GatewayFrame) => {
      if (settled || !runtimeId || frame.session_id !== runtimeId) return
      this.inspector?.record(owner,c.id,{direction:'event',method:frame.type,data:frame.payload,agentId:agent.id,runId:run.runId,taskId:run.conversationTaskId})
      const p = frame.payload ?? {},
        type = frame.type
      if(type==='computer.paused'||type==='computer.resumed'){const current=this.getWork(owner,run.id);current.status=type==='computer.paused'?'waiting':'running';this.saveWork(owner,current);return}
      if (type === 'message.delta') {
        resultMessage.content += String(p.text ?? p.delta ?? '')
        if (resultMessage.content.trim() && !NO_REPLY.startsWith(resultMessage.content.trim()) && !resultMessage.content.trim().startsWith('[[YAOYAO_')) resultMessage.visible = true
      }
      else if (type === 'reasoning.delta')
        resultMessage.reasoning += String(p.text ?? p.delta ?? '')
      else if (type === 'message.interim') {
        resultMessage.content += '\n\n'
      } else if (type.startsWith('tool.')) {
        resultMessage.visible = true
        const id = String(p.tool_id ?? p.id ?? ''),
          index = resultMessage.tools.findIndex((t) => t.id === id)
        const value = { ...p, id, status: type }
        if (index >= 0) resultMessage.tools[index] = { ...resultMessage.tools[index], ...value }
        else resultMessage.tools.push(value)
      } else if (
        ['approval.request', 'approval.requested', 'clarify.request', 'clarify.requested'].includes(
          type,
        )
      ) {
        const upstreamId = String(p.request_id ?? p.requestId ?? p.id ?? '')
        const previous = this.store.list<WorkspaceInteraction>(owner, 'interaction').find(i => {
          const b = this.store.get<{ taskId: string; upstreamId: string }>(owner, 'interaction-binding', i.id)
          return b?.taskId === run.id && b.upstreamId === upstreamId
        })
        if (previous?.resolved) return
        const interaction: WorkspaceInteraction = previous ?? {
          id: randomUUID(),
          conversationId: c.id,
          conversationTaskId: run.conversationTaskId,
          runId: run.runId,
          agentId: agent.id,
          kind: type.startsWith('approval') ? 'approval' : 'clarification',
          message: String(p.question ?? p.message ?? p.prompt ?? '需要确认'),
          choices: Array.isArray(p.choices) ? p.choices.map(String) : [],
          resolved: false,
        }
        this.store.put(owner, 'interaction', interaction.id, interaction)
        this.store.put(owner, 'interaction-binding', interaction.id, { key, upstreamId, taskId: run.id, conversationTaskId: run.conversationTaskId })
        this.store.event(owner, 'interaction.changed', interaction, c.id)
        const current = this.getWork(owner, run.id)
        current.hadInteraction = true
        current.status = 'waiting'
        this.saveWork(owner, current)
        this.notify(owner, c, this.store.require<Run>(owner, 'run', run.runId), undefined, interaction)
      } else if (['message.complete', 'run.completed'].includes(type)) {
        if (typeof p.text === 'string') resultMessage.content = p.text
        if (typeof p.reasoning === 'string') resultMessage.reasoning = p.reasoning
        if (p.status === 'interrupted') {
          const current = this.getWork(owner, run.id)
          current.status = 'interrupted'
          this.saveWork(owner, current)
          finish(new Error('已停止'))
        } else if (p.error || p.status === 'failed') {
          submitted = false
          finish(new HttpError(502, String(p.error ?? '运行失败'), 'run_failed'))
        } else if (!completing) {
          completedEvidence = true
          completing = true
          let timeout: ReturnType<typeof setTimeout>
          void Promise.race([
            gateway.rpc('session.usage', { session_id: runtimeId }),
            new Promise<undefined>((resolve) => {
              timeout = setTimeout(() => resolve(undefined), 1000)
            }),
          ])
            .then((usage) => {
              if (usage && !this.closing) {
                const used = usage.context_used ?? usage.used_tokens,
                  limit = usage.context_max ?? usage.context_limit
                const contextKey = run.conversationTaskId ?? c.id,
                  context = {
                  ...usage,
                  conversationTaskId: run.conversationTaskId,
                  usedTokens: used,
                  limitTokens: limit,
                  percent:
                    typeof used === 'number' && typeof limit === 'number' && limit > 0
                      ? Math.round((used / limit) * 1000) / 10
                      : undefined,
                  }
                this.store.put(owner, 'context', contextKey, context)
                this.store.event(
                  owner,
                  'context.changed',
                  context,
                  c.id,
                )
              }
            })
            .catch(() => {})
            .finally(() => {
              clearTimeout(timeout)
              finish()
            })
        }
        return
      } else if (['error', 'message.error', 'run.failed'].includes(type)) {
        submitted = false
        finish(new HttpError(502, String(p.message ?? p.error ?? '运行失败'), 'run_failed'))
        return
      } else if (['session.usage', 'usage.update', 'context.update'].includes(type)) {
        const context = { ...p, conversationTaskId: run.conversationTaskId }
        this.store.put(owner, 'context', run.conversationTaskId ?? c.id, context)
        this.store.event(owner, 'context.changed', context, c.id)
      } else if (type === 'session.info' && binding) {
        const storedId = p.stored_session_id ?? p.session_key
        if (typeof storedId === 'string' && storedId && storedId !== binding.storedId) {
          binding.aliases = [...new Set([...binding.aliases, binding.storedId, storedId])]
          binding.storedId = storedId
          this.store.put(owner, 'binding', key, binding)
        }
      }
      const flush = () => {
        clearTimeout(flushTimer)
        flushTimer = undefined
        if (settled || this.closing) return
        try {
          this.store.saveMessage(owner, resultMessage)
          lastFlush = Date.now()
        } catch (error) {
          finish(error instanceof Error ? error : new Error('无法保存流式消息'))
        }
      }
      const remaining = 100 - (Date.now() - lastFlush)
      if (remaining <= 0) flush()
      // A stream may pause after any chunk. Publish the latest text even when
      // no subsequent event arrives to trigger the next leading-edge flush.
      else if (flushTimer === undefined) flushTimer = setTimeout(flush, remaining)
    }
    try {
      await gateway.connect()
      this.requireAuthorization(owner, run.runId)
      this.nodes.requireSource(owner, agent)
      // Paired Web nodes enforce their own profile config at the destination.
      const cwd = recovering || target.pairedToken ? undefined
        : await configuredWorkingDirectory((path, options) => target.session.request(path, options), agent.profile)
      this.nodes.requireSource(owner, agent)
      const opened = binding?.storedId
        ? await gateway.rpc('session.resume', {
            profile: agent.profile,
            session_id: binding.storedId,
            omit_messages: true,
            ...(recovering&&target.runner?.computer?{recoverOnly:true}:{}),
            close_on_disconnect: false,
          })
        : await gateway.rpc('session.create', {
            profile: agent.profile,
            title: `Yaoyao ${c.id}${run.conversationTaskId ? ` / ${run.conversationTaskId}` : ''}`,
            source: 'yaoyao_workspace',
            ...(cwd ? { cwd } : {}),
            hidden: true,
            room_plumbing: true,
            close_on_disconnect: false,
          })
      runtimeId = String(opened.session_id ?? '')
      const storedId = String(
        opened.stored_session_id ?? opened.session_key ?? opened.resumed ?? binding?.storedId ?? '',
      )
      if (
        !runtimeId ||
        !storedId ||
        (opened.info?.profile_name && opened.info.profile_name !== agent.profile)
      )
        throw new Error('Hermes 会话身份不匹配')
      binding = {
        runnerId: target.runner?.id,
        execution:agent.execution,
        computerEnvironmentId:agent.computerEnvironmentId,
        id: key,
        nodeId: agent.nodeId,
        remoteAgentId: agent.remoteAgentId,
        profile: agent.profile,
        storedId,
        runtimeId,
        aliases: [
          ...new Set([
            ...(binding?.aliases ?? []),
            ...(binding ? [binding.storedId] : []),
            storedId,
          ]),
        ],
        runId: run.runId,
        conversationTaskId: run.conversationTaskId,
        taskId: run.id,
        contextSeq: binding?.contextSeq ?? 0,
        messageId: resultMessage.id,
      }
      this.store.put(owner, 'binding', key, binding)
      this.live.set(key, { gateway, runtimeId, runId: run.runId, conversationTaskId: run.conversationTaskId, taskId: run.id, agentId: agent.id, done: finish })
      if (this.closing || this.getWork(owner, run.id).cancelRequested || this.getWork(owner, run.id).status === 'interrupted')
        throw new Error('运行已停止')
      if (recovering) {
        if (opened.running) {
          const current = this.getWork(owner, run.id)
          current.status = 'running'
          this.saveWork(owner, current)
        } else {
          const marker = `[yaoyao-run:${run.runId}:${resultMessage.id}]`
          let answer: { content?: string; text?: string } | undefined
          let found = false, seenLastEvent = false
          for (let page = 0; page < 20 && !found; page++) {
            const response = await target.session.request(`/api/sessions/${encodeURIComponent(storedId)}/messages`, {
              search: new URLSearchParams({ profile: agent.profile, limit: '500', offset: String(page * 500), order: 'latest', include_compacted: 'true' }),
              maxResponseBytes: 8 * 1024 * 1024,
            })
            if (response.status !== 200) throw new Error('无法核对历史')
            const history = JSON.parse(response.body.toString()).messages
            if (!Array.isArray(history)) throw new Error('历史响应无效')
            for (const item of [...history].reverse()) {
              if (item.role === 'user') {
                if (String(item.content ?? item.text).includes(marker)) { found = true; break }
                answer = undefined; seenLastEvent = false
              } else if (!seenLastEvent && ['assistant', 'tool'].includes(item.role)) {
                seenLastEvent = true
                const calls = item.tool_calls
                const hasCalls = Array.isArray(calls) ? calls.length > 0 : !!calls && calls !== '[]'
                if (item.role === 'assistant' && !hasCalls && !item.function_call && item.finish_reason !== 'tool_calls' && (item.content || item.text)) answer = item
              }
            }
            if (history.length < 500) break
          }
          if (!found || !answer) throw new Error('无法确认本轮的最终回复，正在核对原执行；不会重复提交')
          resultMessage.content = String(answer.content ?? answer.text)
          binding.contextSeq = Math.max(binding.contextSeq ?? 0, run.contextThroughSeq ?? 0)
          this.store.put(owner, 'binding', key, binding)
          finish()
        }
      } else {
        if (opened.running) throw new HttpError(409, '上游会话仍在运行', 'session_busy')
        this.nodes.requireSource(owner, agent)
        const team=agent.canManageTeam===true&&!this.store.require<Run>(owner,'run',run.runId).assignmentId
        const cloud=!!this.cloud?.selected(owner,agent)
        const plugins=!!this.plugins?.selected(owner,agent)
        const desktop=this.desktopEnvironments?.toolMode(owner,agent),desktopEpoch=this.desktopEnvironments?.epoch??''
        if(team||cloud||desktop||plugins){
          if(team){
            const granted=this.getWork(owner,run.id);granted.teamManagementRevision=agent.revision;this.saveWork(owner,granted)
            await this.teamTools.requireAvailable(owner,agent)
          }
          if(desktop)await this.desktopEnvironments!.requireAvailable(owner,agent,target)
          if(cloud)await this.cloud!.requireAvailable(owner,agent,target)
          const assertActive=()=>{
            if(settled||this.closing||toolController.signal.aborted)throw new Error('运行已停止')
            this.requireAuthorization(owner,run.runId);this.nodes.requireSource(owner,this.store.require<Agent>(owner,'agent',agent.id))
            if(team)this.teamTools.assertTurn(owner,run.id)
            if(plugins){const current=this.getWork(owner,run.id),latest=this.store.require<Agent>(owner,'agent',agent.id);if(current.cancelRequested||this.store.require<Run>(owner,'run',run.runId).stopRequested||latest.archived||!['running','waiting'].includes(current.status))throw new HttpError(403,'本轮插件授权已结束','plugin_grant_revoked')}
          }
          if(plugins)pluginLease=await this.plugins!.open(owner,agent,target,toolController.signal,assertActive)
          toolLease=await createWorkspaceToolLease({
            target,profile:agent.profile,workId:run.id,signal:toolController.signal,
            session:()=>({runtimeId,storedId:binding!.storedId}),assertActive,
            catalog:()=>[...(team?this.teamTools.catalog(owner,run.id):[]),...(cloud?GROK_COMPUTER_TOOLS:[]),...(desktop?DESKTOP_ENVIRONMENT_TOOLS.filter(t=>desktop==='browser'||t.id!=='desktop_browser'):[]),...(pluginLease?.catalog()??[])],
            call:async(toolId,args)=>{assertActive();return toolId.startsWith('plugin_')&&pluginLease?pluginLease.call(toolId,args):toolId.startsWith('desktop_')?this.desktopEnvironments!.call(owner,agent.id,toolId,args,toolController.signal,assertActive,desktop!,desktopEpoch):toolId.startsWith('cloud_computer_')?this.cloud!.call(owner,agent.id,toolId,args,toolController.signal):this.teamTools.call(owner,run.id,toolId,args)},
            onFailure:error=>{if(!settled)void gateway.rpc('session.interrupt',{session_id:runtimeId}).catch(()=>{}).finally(()=>finish(error))},
          })
          await toolLease.bind();if(settled)return await completion
        }
        await applyWorkingDirectory((method, params) => gateway.rpc(method, params), runtimeId, cwd, undefined, opened.info?.cwd)
        const trigger = this.store.require<Message>(owner, 'message', run.messageId)
        const attachmentRefs: string[] = []
        for (const file of trigger.attachments) {
          this.requireAuthorization(owner, run.runId)
          const record = this.files(owner,[file.id])[0]!
          const bytes = readFileSync(record.path).toString('base64')
          const attached = record.mimeType.startsWith('image/')
            ? await gateway.rpc('image.attach_bytes', {
                session_id: runtimeId,
                filename: record.name,
                content_base64: bytes,
              })
            : await gateway.rpc('file.attach', {
                session_id: runtimeId,
                name: record.name,
                data_url: `data:${record.mimeType};base64,${bytes}`,
              })
          if (attached.ref_text) attachmentRefs.push(String(attached.ref_text))
        }
        const members = run.turnConfiguration!.members
        const goal = run.conversationTaskId ? this.store.get<import('../shared/agentTasks.js').AgentGoal>(owner, 'goal', run.conversationTaskId) : undefined
        const assignmentId = this.store.require<Run>(owner, 'run', run.runId).assignmentId
        const rules = [
          `你是 ${agent.name}。以下是用户为这个独立机器人配置的角色与规则（版本 ${agent.revision}）：\n${agent.remoteAgentId ? '配置由远端机器人管理。' : agent.instructions}`,
          c.kind === 'group' && Object.keys(c.memberRoles ?? {}).length
            ? `本群角色分工（仅在本群生效）：\n${members.flatMap(member => {
                const role = c.memberRoles?.[member.id]
                return role ? [`@${member.name}：${role.name}；${role.description}`] : []
              }).join('\n')}\n协作时使用上面的真实成员名称进行 @，不要使用职责名称代替成员名称。`
            : '',
          c.kind === 'group'
            ? `你正在群聊「${c.name}」发言。群成员：${members.map((a) => `@${a.name} (id=${a.id})`).join('、')}。\n群规则：${c.instructions}\n${c.mode === 'host' ? (agent.id === c.administratorId ? '你是管理员。必要时用精确 @成员名称 委派工作；收到结果后复核并给用户结论。任务完成时不要继续 @。' : '执行当前委派任务。公开给出结果，由管理员复核；不要安排其他成员。') : '按自己的职责回复，只在需要协作时 @成员。不要重复已完成的工作。'}`
            : '',
          c.kind === 'group' ? '只有安排具体的新工作时才用 @成员派工，并写明需要执行的动作。收到、感谢、审核通过、等待用户指令等确认不需要再次 @。任务收尾直接向用户报告结果；不要重复确认或把同一结果反复交回其他成员。' : '',
          run.requiredReply ? '你必须公开处理本次消息，直接回答、委派或澄清；禁止静默。管理员可按依赖一次 @一人，也可同时 @多人并行执行，整批结束后系统统一交回复核。' : run.replyMode === 'automatic' ? `你按自动参与配置收到消息。若与职责无关或仅是已完成工作的重复确认，禁止调用工具、禁止 @，完整答复只能是 ${NO_REPLY}。有新工作或新结果时正常回答。` : '',
          `本轮用户指定成员：${this.store.require<Run>(owner, 'run', run.runId).mentionIds.map(id => members.find(a => a.id === id)).filter(Boolean).map(a => '@' + a!.name).join('、') || '未指定'}`,
          '角色规则不赋予额外工具权限；仍遵守基础 Hermes 的工具和安全约束。',
          this.store.require<Run>(owner, 'run', run.runId).internalInstruction || '',
          goal && ['running', 'review', 'waiting'].includes(goal.status) ? `当前团队目标 ID：${goal.id}。目标：${goal.objective.slice(0,8000)}\n验收要求（版本 ${goal.acceptanceRevision ?? 1}）：${goal.acceptanceCriteria.join('；')}\n${assignmentId ? `你在执行子任务 ${assignmentId}，请完成分派并提交结果，不要扩大团队或再次委派。` : '先从用户要求提炼少量具体、可核对的交付条件；若仍是默认验收要求，使用 workspace_update_team_goal 保存。尊重用户调整后的要求。能直接完成就直接完成，不必创建子任务；仅确实需要分工时使用 workspace_assign_task，成员结果通过 workspace_review_assignment 复核，不要再用 @ 重复派发同一工作。最终使用 workspace_finish_team_task 记录完成、受阻或等待用户，完成时提供实际依据。'}` : '',
          agent.temporaryGoalId ? `你是当前任务的临时助手，任务 ID：${agent.temporaryGoalId}。仅处理分派工作，使用 computer_export 回传产物。任务结束后会退役；不要创建团队或改变自身权限。` : '',
          team ? TEAM_TOOL_RULES : '',
          plugins ? '本轮已挂载用户为当前 Bot 授权的插件工具，工具名以 plugin_ 开头，说明中包含实际服务和操作。仅按用户当前任务使用；连接或重新授权应用请让用户打开 Bot 模式的工具 → 已连接应用。不要索取 API Key 或在回复中展示凭据。' : '',
          desktop ? DESKTOP_ENVIRONMENT_RULES : '',
          cloud ? grokComputerRules(agent.computer==='cloud'&&agent.allowHostEnvironment===true) : '',
          `[yaoyao-run:${run.runId}:${resultMessage.id}]`,
        ]
          .filter(Boolean)
          .join('\n\n')
        const text = c.kind === 'group' ? this.contextText(owner, c, agent, run, binding.contextSeq ?? 0, movedRunner)
          : movedRunner ? `执行节点已切换。以下是原会话的近期记录，旧路径和执行状态需要在当前节点重新核实；不要重新执行已完成的操作。\n\n${this.contextText(owner,c,agent,run,0,true)}` : trigger.content
        const admission = this.getWork(owner, run.id)
        if (!this.store.taskMemberIds(owner,this.store.require<Conversation>(owner,'conversation',c.id),run.conversationTaskId).includes(agent.id)) {
          admission.status = 'interrupted'; admission.error = '执行前成员已移除'; this.saveWork(owner, admission)
          throw new Error('执行前成员已移除')
        }
        this.nodes.requireSource(owner, agent)
        this.requireAuthorization(owner, run.runId)
        if (admission.cancelRequested || admission.status === 'interrupted') throw new Error('运行已停止')
        admission.contextThroughSeq = run.contextThroughSeq ?? run.triggerSeq
        admission.submitted = true
        this.saveWork(owner, admission)
        submitted = true
        try {
          await gateway.rpc('prompt.submit', {
            session_id: runtimeId,
            ...(target.runner?.computer?{workMarker:`[yaoyao-run:${run.runId}:${resultMessage.id}]`}:{}),
            text: `${rules}\n\n${text}\n${attachmentRefs.join('\n')}`,
          })
          this.store.remove(owner,'binding-reset',key)
          binding.contextSeq = Math.max(binding.contextSeq ?? 0, admission.contextThroughSeq)
          this.store.put(owner, 'binding', key, binding)
        } catch (error) {
          // A JSON-RPC error is a definitive rejection, not a lost receipt.
          if (error instanceof HttpError && ['gateway_rejected','runner_command_not_admitted'].includes(error.code??'')) { submitted = false; const current = this.getWork(owner, run.id); current.submitted = false; this.saveWork(owner, current) }
          throw error
        }
      }
      return await completion
    } catch (error) {
      finish(error instanceof Error ? error : new Error('执行失败'))
      return await completion
    }
  }
  private requireAuthorization(owner: string, runId: string): void {
    const run=this.store.require<Run>(owner,'run',runId)
    if(!this.userActive(owner)||(run.authorizationVersion!==undefined&&run.authorizationVersion!==this.authorizationVersion(owner)))
      throw new HttpError(403,'本轮账号授权已失效','run_authorization_revoked')
  }
  private contextText(owner: string, c: Conversation, agent: Agent, work: Work, after: number, includeOwn = false): string {
    const rootTrigger = this.store.require<Message>(owner, 'message', work.messageId)
    const roots = new Map(this.store.list<Run>(owner, 'run').filter(r => r.conversationId === c.id && r.conversationTaskId === work.conversationTaskId).map(r => [r.id, this.store.get<Message>(owner, 'message', r.messageId)?.seq ?? 0]))
    const history = this.store.messages(owner, c.id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true, work.conversationTaskId)
    const unfinished = history.find(m => m.seq > after && m.seq <= work.triggerSeq && (['queued', 'streaming', 'uncertain'].includes(m.status) || (m.runId && (roots.get(m.runId) ?? 0) > rootTrigger.seq)))
    work.contextThroughSeq = unfinished ? unfinished.seq - 1 : work.triggerSeq
    const eligible = history
      .filter(m => m.seq > after && m.seq <= work.triggerSeq && m.visible !== false && ['complete', 'failed', 'interrupted'].includes(m.status)
        && (includeOwn || !(m.role === 'assistant' && m.agentId === agent.id)) && (!m.runId || (roots.get(m.runId) ?? 0) <= rootTrigger.seq))
    const selected: string[] = []
    let size = 0, omitted = 0
    for (const message of [...eligible].reverse()) {
      const files = message.attachments.map(f => `[附件 ${f.name}](${f.sourcePath || `/api/app/files/${f.id}/download`})`).join('\n')
      const content = message.content.length > 24_000 ? message.content.slice(0, 12_000) + '\n[内容过长，保留首尾片段]\n' + message.content.slice(-12_000) : message.content
      const reasoning = message.reasoning ? `\n思考摘要：${message.reasoning.slice(0, 2000)}` : ''
      const tools = [...new Set(message.tools.map(t => String(t.name ?? t.tool_name ?? '')).filter(name => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(name)))].slice(0, 16)
      const row = `${message.role === 'user' ? '用户' : message.agentName ?? '系统'}（${message.status}）：${content}${reasoning}${tools.length ? `\n使用工具：${tools.join('、')}` : ''}${message.error ? `\n错误：${message.error}` : ''}${files ? '\n' + files : ''}`
      if (selected.length >= 50 || size + row.length > 30_000) { omitted++; continue }
      selected.unshift(row); size += row.length
    }
    // Preserve a large trigger as a bounded excerpt rather than silently losing it.
    if (!selected.length && eligible.length) selected.push(eligible.at(-1)!.content.slice(-30_000))
    const batch = work.reviewOf ? this.works(owner, work.runId).filter(t => t.batchId === work.reviewOf).map(t => `${this.store.get<Agent>(owner, 'agent', t.agentId)?.name ?? t.agentId}：${t.status}${t.error ? `；${t.error}` : ''}`).join('\n') : ''
    return `${batch ? `本批次执行结果：\n${batch}\n\n` : ''}${omitted ? `较早上下文有 ${omitted} 条因长度限制省略，请勿假定已完整读取。\n\n` : ''}${selected.join('\n\n')}`
  }
  private resolveInteractions(owner: string, taskId: string): void {
    for (const interaction of this.store.list<WorkspaceInteraction>(owner, 'interaction')) {
      const binding = this.store.get<{ taskId?: string }>(owner, 'interaction-binding', interaction.id)
      if (binding?.taskId === taskId && !interaction.resolved) {
        interaction.resolved = true
        this.store.put(owner, 'interaction', interaction.id, interaction)
        this.store.event(owner, 'interaction.changed', interaction, interaction.conversationId)
      }
    }
  }
  async respond(owner: string, id: string, answer: string): Promise<void> {
    type Reply = WorkspaceInteraction & { answer?: string; responseState?: 'sending' | 'uncertain' | 'sent' }
    const interaction = this.store.require<Reply>(owner, 'interaction', id)
    this.requireAuthorization(owner,interaction.runId)
    this.nodes.requireSource(owner, this.store.require<Agent>(owner, 'agent', interaction.agentId))
    if (interaction.resolved) {
      if (interaction.answer && interaction.answer !== answer) throw new HttpError(409, '该请求已使用其他答复完成', 'interaction_answer_conflict')
      return
    }
    if (interaction.responseState === 'sending' || interaction.responseState === 'uncertain') throw new HttpError(409, '答复状态待确认，请核对原请求', 'interaction_uncertain')
    const binding = this.store.require<{ key: string; upstreamId: string; taskId: string }>(owner, 'interaction-binding', id)
    const live = this.live.get(binding.key)
    if (!live || live.taskId !== binding.taskId || live.runId !== interaction.runId) throw new HttpError(409, '请先恢复此轮连接', 'interaction_offline')
    if (interaction.kind === 'approval' && !['once', 'session', 'always', 'deny', 'allow', 'approve'].includes(answer)) throw new HttpError(400, '审批选项无效', 'invalid_approval')
    interaction.answer = answer; interaction.responseState = 'sending'
    this.store.put(owner, 'interaction', id, interaction)
    try {
      await live.gateway.rpc(interaction.kind === 'approval' ? 'approval.respond' : 'clarify.respond', {
        session_id: live.runtimeId, request_id: binding.upstreamId,
        ...(interaction.kind === 'approval' ? { choice: answer } : { answer }),
      })
    } catch (error) {
      const latest = this.store.require<Reply>(owner, 'interaction', id)
      if (!latest.resolved) {
        latest.responseState = error instanceof HttpError && error.code === 'gateway_rejected' ? undefined : 'uncertain'
        this.store.put(owner, 'interaction', id, latest)
      }
      throw error
    }
    interaction.resolved = true; interaction.responseState = 'sent'
    this.store.put(owner, 'interaction', id, interaction)
    this.store.event(owner, 'interaction.changed', interaction, interaction.conversationId)
    const current = this.getWork(owner, binding.taskId)
    if (current.status === 'waiting') { current.status = 'running'; this.saveWork(owner, current) }
  }
  protected async interruptTurn(owner: string, work: Work): Promise<void> {
    const key = this.bindingKey(work.conversationId, work.conversationTaskId, work.agentId)
    const live = this.live.get(key)
    if (live?.taskId === work.id) {
      await live.gateway.rpc('session.interrupt', { session_id: live.runtimeId })
      const current = this.getWork(owner, work.id)
      if (['complete', 'failed', 'interrupted'].includes(current.status)) return
      current.status = 'interrupted'; current.error = '已停止'
      this.saveWork(owner, current)
      if(current.currentMessageId){const message=this.store.require<Message>(owner,'message',current.currentMessageId);message.status='interrupted';message.error='已停止';this.store.saveMessage(owner,message)}
      live.done(new Error('已停止'))
    } else {
      const binding = this.store.get<WorkspaceBinding>(owner, 'binding', key)
      if (work.submitted) {
        if (!binding || binding.taskId !== work.id) throw new Error('无法确认待停止成员的会话身份')
        const target=binding.remoteAgentId||binding.execution==='computer'?this.nodes.targetForAgent(owner,{...binding,id:work.agentId}):this.nodes.target(owner,binding.nodeId)
        if(binding.runnerId!==target.runner?.id)throw new Error('执行节点已变化，无法确认原任务已停止')
        const gateway = new WorkspaceGateway(target,{workId:work.id,cleanupOnly:true,sessionId:binding.storedId,authorize:()=>{const current=this.store.get<WorkspaceBinding>(owner,'binding',key);if(current?.taskId!==work.id||current.storedId!==binding.storedId)throw new Error('原会话绑定已改变')}})
        try {
          await gateway.connect()
          const opened = await gateway.rpc('session.resume', { profile: binding.profile, session_id: binding.storedId, omit_messages: true, close_on_disconnect: false,...(binding.execution==='computer'?{recoverOnly:true}:{}) })
          if (opened.running) await gateway.rpc('session.interrupt', { session_id: opened.session_id })
        } finally { gateway.close() }
      }
      const current = this.getWork(owner, work.id)
      current.status = 'interrupted'; current.error = '已停止'
      this.saveWork(owner, current)
      if (current.currentMessageId) {
        const message = this.store.require<Message>(owner, 'message', current.currentMessageId)
        message.status = 'interrupted'; this.store.saveMessage(owner, message)
      }
    }
    this.resolveInteractions(owner, work.id)
  }
  override async stopTask(owner: string, conversationId: string, taskId: string, visited = new Set<string>()): Promise<void> {
    const key = `${owner}:${taskId}`
    if (visited.has(key)) return
    visited.add(key)
    this.tasks.cancel(owner, taskId)
    await Promise.all([super.stopTask(owner, conversationId, taskId), this.tasks.cancelOrigin(owner, conversationId, taskId, visited)])
  }
  override async stopConversation(owner: string, conversationId: string): Promise<void> {
    for (const task of this.store.list<import('../shared/workspace.js').WorkspaceTask>(owner, 'conversation-task'))
      if (task.conversationId === conversationId) this.tasks.cancel(owner, task.id)
    await Promise.all([super.stopConversation(owner, conversationId), this.tasks.cancelOrigin(owner, conversationId)])
  }
  close(): void {
    this.tasks.close()
    this.closeScheduler()
    for (const live of [...this.live.values()]) live.done(new Error('服务关闭'))
    this.live.clear()
  }

}
