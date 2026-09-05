import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { WorkspaceStore, parse } from './workspaceStore.js'
import { WorkspaceNodes, WorkspaceGateway, type GatewayFrame } from './workspaceGateway.js'
import { HttpError } from './errors.js'
import { UploadStore } from './uploads.js'
import type {
  WorkspaceAgent as Agent,
  WorkspaceConversation as Conversation,
  WorkspaceMessage as Message,
  WorkspaceRun,
  WorkspaceInteraction,
} from '../shared/workspace.js'

import { WorkspaceScheduler, type Work, NO_REPLY, HOST_FALLBACK } from './workspaceScheduler.js'
import { mentionedAgents } from './workspaceMentions.js'
export { mentionedAgents } from './workspaceMentions.js'
type Run = WorkspaceRun

export interface WorkspaceBinding {
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
    mentionIds: z.array(z.string().uuid()).max(8).default([]),
    fileIds: z.array(z.string().uuid()).max(8).default([]),
  })
  .strict()
  .refine((b) => b.content.trim() || b.fileIds.length, '请输入消息或添加附件')
export class WorkspaceRuntime extends WorkspaceScheduler {
  private live = new Map<string, LiveTurn>()
  constructor(store: WorkspaceStore, readonly nodes: WorkspaceNodes, readonly uploads: UploadStore, userActive: (owner: string) => boolean = () => true) { super(store, userActive) }
  send(owner: string, conversationId: string, input: unknown): Run {
    const body = parse(sendInput, input)
    for (const id of this.store.require<Conversation>(owner, 'conversation', conversationId).memberIds)
      this.nodes.requireSource(owner, this.store.require<Agent>(owner, 'agent', id))
    const result = this.store.command(owner, body.requestId, { conversationId, ...body }, () => {
      const c = this.store.require<Conversation>(owner, 'conversation', conversationId)
      if (c.archived) throw new HttpError(409, '聊天已归档', 'conversation_archived')
      const conversationTask = this.store.resolveTask(owner, conversationId, body.taskId),
        conversationTaskId = conversationTask?.id
      if (conversationTaskId) {
        const alreadyActive = this.store.list<Run>(owner, 'run').some(run => run.conversationTaskId === conversationTaskId && !['complete', 'failed', 'interrupted'].includes(run.status))
        if (!alreadyActive && this.store.activeTaskCount(owner, conversationId) >= 4)
          throw new HttpError(409, '最多同时运行 4 个任务', 'workspace_task_concurrency_limit')
      }
      if (body.mentionIds.some((a) => !c.memberIds.includes(a)))
        throw new HttpError(400, '只能 @ 群内成员', 'invalid_mentions')
      const records = this.uploads.records(body.fileIds, owner)
      const now = Date.now(),
        runId = randomUUID(),
        agents = c.memberIds.map((id) => this.store.require<Agent>(owner, 'agent', id))
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
        role: 'user',
        content: body.content.trim(),
        reasoning: '',
        runId,
        status: 'complete',
        attachments: records.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          sender: 'user',
          createdAt: now,
        })),
        tools: [],
        createdAt: now,
      }
      this.store.saveMessage(owner, message)
      for (const file of records) {
        const existing = this.store.get<Record<string, unknown>>(owner, 'file', file.id)
        if (existing)
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
    this.nodes.requireSource(owner, agent)
    if (agent.remoteAgentId) agent = await this.nodes.refreshRemoteAgent(owner,agent)
    const key = this.bindingKey(c.id, run.conversationTaskId, agent.id),
      target = agent.remoteAgentId ? this.nodes.targetForAgent(owner,agent) : this.nodes.target(owner, agent.nodeId)
    const gateway = new WorkspaceGateway(target)
    let binding = this.store.get<WorkspaceBinding>(owner, 'binding', key)
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
    const resultMessage = message
    let submitted = recovering,
      settled = false,
      completedEvidence = false,
      completing = false,
      runtimeId = '',
      lastFlush = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined
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
      clearTimeout(flushTimer)
      flushTimer = undefined
      this.live.delete(key)
      try {
        const current = this.getWork(owner, run.id)
        if (error) {
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
      const p = frame.payload ?? {},
        type = frame.type
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
      this.nodes.requireSource(owner, agent)
      const opened = binding?.storedId
        ? await gateway.rpc('session.resume', {
            profile: agent.profile,
            session_id: binding.storedId,
            omit_messages: true,
            close_on_disconnect: false,
          })
        : await gateway.rpc('session.create', {
            profile: agent.profile,
            title: `Yaoyao ${c.id}${run.conversationTaskId ? ` / ${run.conversationTaskId}` : ''}`,
            source: 'yaoyao_workspace',
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
        const trigger = this.store.require<Message>(owner, 'message', run.messageId)
        const attachmentRefs: string[] = []
        for (const file of trigger.attachments) {
          const record = this.uploads.records([file.id], owner)[0]!
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
        const rules = [
          `你是 ${agent.name}。以下是用户为这个独立 Agent 配置的角色与规则（版本 ${agent.revision}）：\n${agent.remoteAgentId ? '配置由远端 Agent 管理。' : agent.instructions}`,
          c.kind === 'group' && Object.keys(c.memberRoles ?? {}).length
            ? `本群角色分工（仅在本群生效）：\n${members.flatMap(member => {
                const role = c.memberRoles?.[member.id]
                return role ? [`@${member.name}：${role.name}；${role.description}`] : []
              }).join('\n')}\n协作时使用上面的真实成员名称进行 @，不要使用职责名称代替成员名称。`
            : '',
          c.kind === 'group'
            ? `你正在群聊「${c.name}」发言。群成员：${members.map((a) => `@${a.name} (id=${a.id})`).join('、')}。\n群规则：${c.instructions}\n${c.mode === 'host' ? (agent.id === c.administratorId ? '你是管理员。必要时用精确 @成员名称 委派工作；收到结果后复核并给用户结论。任务完成时不要继续 @。' : '执行当前委派任务。公开给出结果，由管理员复核；不要安排其他成员。') : '按自己的职责回复，只在需要协作时 @成员。不要重复已完成的工作。'}`
            : '',
          run.requiredReply ? '你必须公开处理本次消息，直接回答、委派或澄清；禁止静默。管理员可按依赖一次 @一人，也可同时 @多人并行执行，整批结束后系统统一交回复核。' : run.replyMode === 'automatic' ? `你按自动参与配置收到消息。若与职责无关，禁止调用工具、禁止 @，完整答复只能是 ${NO_REPLY}。有关时正常回答。` : '',
          `本轮用户指定成员：${this.store.require<Run>(owner, 'run', run.runId).mentionIds.map(id => members.find(a => a.id === id)).filter(Boolean).map(a => '@' + a!.name).join('、') || '未指定'}`,
          '角色规则不赋予额外工具权限；仍遵守基础 Hermes 的工具和安全约束。',
          `[yaoyao-run:${run.runId}:${resultMessage.id}]`,
        ]
          .filter(Boolean)
          .join('\n\n')
        const text = c.kind === 'group' ? this.contextText(owner, c, agent, run, binding.contextSeq ?? 0) : trigger.content
        const admission = this.getWork(owner, run.id)
        if (!this.store.require<Conversation>(owner, 'conversation', c.id).memberIds.includes(agent.id)) {
          admission.status = 'interrupted'; admission.error = '执行前成员已移除'; this.saveWork(owner, admission)
          throw new Error('执行前成员已移除')
        }
        this.nodes.requireSource(owner, agent)
        if (admission.cancelRequested || admission.status === 'interrupted') throw new Error('运行已停止')
        admission.contextThroughSeq = run.contextThroughSeq ?? run.triggerSeq
        admission.submitted = true
        this.saveWork(owner, admission)
        submitted = true
        try {
          await gateway.rpc('prompt.submit', {
            session_id: runtimeId,
            text: `${rules}\n\n${text}\n${attachmentRefs.join('\n')}`,
          })
          binding.contextSeq = Math.max(binding.contextSeq ?? 0, admission.contextThroughSeq)
          this.store.put(owner, 'binding', key, binding)
        } catch (error) {
          // A JSON-RPC error is a definitive rejection, not a lost receipt.
          if (error instanceof HttpError && error.code === 'gateway_rejected') { submitted = false; const current = this.getWork(owner, run.id); current.submitted = false; this.saveWork(owner, current) }
          throw error
        }
      }
      return await completion
    } catch (error) {
      finish(error instanceof Error ? error : new Error('执行失败'))
      return await completion
    }
  }
  private contextText(owner: string, c: Conversation, agent: Agent, work: Work, after: number): string {
    const rootTrigger = this.store.require<Message>(owner, 'message', work.messageId)
    const roots = new Map(this.store.list<Run>(owner, 'run').filter(r => r.conversationId === c.id && r.conversationTaskId === work.conversationTaskId).map(r => [r.id, this.store.get<Message>(owner, 'message', r.messageId)?.seq ?? 0]))
    const history = this.store.messages(owner, c.id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true, work.conversationTaskId)
    const unfinished = history.find(m => m.seq > after && m.seq <= work.triggerSeq && (['queued', 'streaming', 'uncertain'].includes(m.status) || (m.runId && (roots.get(m.runId) ?? 0) > rootTrigger.seq)))
    work.contextThroughSeq = unfinished ? unfinished.seq - 1 : work.triggerSeq
    const eligible = history
      .filter(m => m.seq > after && m.seq <= work.triggerSeq && m.visible !== false && ['complete', 'failed', 'interrupted'].includes(m.status)
        && !(m.role === 'assistant' && m.agentId === agent.id) && (!m.runId || (roots.get(m.runId) ?? 0) <= rootTrigger.seq))
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
      live.done(new Error('已停止'))
    } else {
      const binding = this.store.get<WorkspaceBinding>(owner, 'binding', key)
      if (work.submitted) {
        if (!binding || binding.taskId !== work.id) throw new Error('无法确认待停止成员的会话身份')
        const gateway = new WorkspaceGateway(binding.remoteAgentId ? this.nodes.targetForAgent(owner,binding) : this.nodes.target(owner, binding.nodeId))
        try {
          await gateway.connect()
          const opened = await gateway.rpc('session.resume', { profile: binding.profile, session_id: binding.storedId, omit_messages: true, close_on_disconnect: false })
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
  close(): void {
    this.closeScheduler()
    for (const live of [...this.live.values()]) live.done(new Error('服务关闭'))
    this.live.clear()
  }

}
