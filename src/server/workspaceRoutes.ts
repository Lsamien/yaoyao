import { WORKSPACE_PATCH_CAPABILITY } from '../shared/workspaceMessagePatch.js'
import { KNOWLEDGE_FEATURES } from './workspaceKnowledge.js'
import { workspaceKnowledgeRouter } from './workspaceKnowledgeRoutes.js'
import { workspaceDetail, streamWorkspace } from './workspaceSync.js'
import { readServerIdentity } from './serverIdentity.js'
import { randomUUID } from 'node:crypto'
import Router from '@koa/router'
import type Koa from 'koa'
import { createReadStream, statSync } from 'node:fs'
import { z } from 'zod'
import { WorkspaceStore, agentInput, agentPatch, parse } from './workspaceStore.js'
import { botModelOptions, resolveBotModelSettings, botModelTarget } from './botModelSettings.js'
import { WorkspaceRuntime, sendInput } from './workspaceRuntime.js'
import { WorkspaceNodes, type WorkspaceNode } from './workspaceGateway.js'
import {
  WorkspaceAssets,
  libraryFile,
  publicFile,
  type StoredWorkspaceFile,
} from './workspaceAssets.js'
import { receiveGroupUploads, type UploadStore } from './uploads.js'
import { HttpError } from './errors.js'
import type { PushCoordinator } from './pushCoordinator.js'
import type { LocalAuthStore } from './localAuth.js'
import type { CsrfProtection } from './security.js'
import { compareWorkspaceConversations } from '../shared/workspace.js'
import type {
  WorkspaceMessage,
  WorkspaceAgent,
  WorkspaceAgentUsage,
  WorkspaceAgentUsageSummary,
  WorkspaceConversation,
  WorkspaceRun,
  WorkspaceInteraction,
} from '../shared/workspace.js'

const body = (ctx: Koa.Context): any => (ctx.request as Koa.Request & { body?: unknown }).body ?? {}
const number = (v: unknown, fallback: number) =>
  typeof v === 'string' && /^\d+$/.test(v) ? Math.min(Number(v), Number.MAX_SAFE_INTEGER) : fallback
export function workspaceRouter(
  store: WorkspaceStore,
  runtime: WorkspaceRuntime,
  nodes: WorkspaceNodes,
  assets: WorkspaceAssets,
  uploads: UploadStore,
  auth: LocalAuthStore,
  push: PushCoordinator,
  csrf?: CsrfProtection,
): Router {
  const router = new Router(),
    owner = (ctx: Koa.Context) => auth.require(ctx).id
  const libraryId = (user: string, id: string) =>
    Number(
      store.db
        .prepare("SELECT rowid AS n FROM workspace_entities WHERE owner=? AND kind='file' AND id=?")
        .get(user, id)?.n ?? 0,
    )
  const fileRecord = (user: string, id: string): StoredWorkspaceFile => {
    if (/^\d+$/.test(id)) {
      const row = store.db
        .prepare("SELECT data FROM workspace_entities WHERE owner=? AND kind='file' AND rowid=?")
        .get(user, Number(id))
      if (row) {const file:StoredWorkspaceFile=JSON.parse(String(row.data));if(file.sourceNodeId&&file.profile)nodes.requireSource(user,{nodeId:file.sourceNodeId,profile:file.profile});return file}
    }
    const file=store.require<StoredWorkspaceFile>(user,'file',id)
    if(file.sourceNodeId&&file.profile)nodes.requireSource(user,{nodeId:file.sourceNodeId,profile:file.profile})
    return file
  }
  router.get('/api/app/capabilities', (ctx) => {
    owner(ctx)
    ctx.set('Cache-Control', 'no-store')
    ctx.body = {
      csrfToken: csrf?.issue(ctx),
      protocolVersion: 1,
      serverKind: 'yaoyao-web',
      features: [
        ...KNOWLEDGE_FEATURES,
        'agents',
        'botModelSettings',
        'conversations',
        'conversationTasks',
        'editableGroups',
        'agentTeamManagement',
        'computerControl','sharedComputers','computerManagement',
        'files',
        'voice',
        'context',
        ...(auth.require(ctx).role === 'admin' ? ['nodes', 'pairedNodes', 'editableNodeAddress'] : []),
        'events', 'workspace-stream-v1',
        ...(store.messagePatchesEnabled ? [WORKSPACE_PATCH_CAPABILITY] : []),
      ],
    }
  })
  router.get('/api/app/agents/sources', async (ctx) => {
    ctx.body = await nodes.sources(owner(ctx))
  })
  router.get('/api/app/agents', async (ctx) => {
    const user=owner(ctx), agents=store.list<WorkspaceAgent>(user,'agent')
    ctx.body = { agents: agents.map(agent=>store.agentSummary(agent)) }
  })
  router.get('/api/app/nodes/:id/agents', async ctx => {
    auth.requireAdmin(ctx)
    throw new HttpError(410, '远程机器人已停用', 'remote_agent_removed')
  })
  router.post('/api/app/agents/remote', async ctx => {
    auth.requireAdmin(ctx)
    throw new HttpError(410, '远程机器人已停用', 'remote_agent_removed')
  })
  router.post('/api/app/agents', async (ctx) => {
    const user = owner(ctx),
      input = parse(agentInput, body(ctx))
    const authorization = auth.pushAuthorizationVersion(user)
    nodes.requireSource(user, input)
    const sources = await nodes.sources(user)
    if (!sources.sources.some((s) => s.nodeId === input.nodeId && s.profile === input.profile))
      throw new HttpError(409, '基础机器人当前不可用', 'source_unavailable')
    nodes.requireSource(user, input)
    if (auth.pushAuthorizationVersion(user) !== authorization) throw new HttpError(401,'账号授权已变化，请重新登录','session_revoked')
    const id = randomUUID()
    await runtime.bindNewAgent(user, id)
    try {
      ctx.body = { agent: store.agentSummary(store.createAgent(user, input, undefined, id)) }
    } catch (error) {
      await runtime.cleanupAgent(user, id).catch(() => undefined)
      throw error
    }
    ctx.status = 201
  })
  router.get('/api/app/agents/:id/model-options', async ctx => {
    const user = owner(ctx), agent = store.require<WorkspaceAgent>(user, 'agent', ctx.params.id)
    nodes.requireSource(user, agent)
    const options = await botModelOptions(nodes.target(user, agent.nodeId), agent.profile)
    nodes.requireSource(user, agent)
    if (store.require<WorkspaceAgent>(user, 'agent', agent.id).revision !== agent.revision) throw new HttpError(409, 'Bot 资料已更新，请重新加载。', 'agent_revision_conflict')
    ctx.set('Cache-Control', 'no-store')
    ctx.body = { ...options, settings: agent.modelSettings ?? null, revision: agent.revision }
  })
  router.patch('/api/app/agents/:id', async (ctx) => {
    const raw = body(ctx), { confirmedModel, ...patch } = raw
    if (confirmedModel !== undefined && (typeof confirmedModel !== 'string' || confirmedModel.length > 1100)) throw new HttpError(400, '模型确认无效', 'invalid_model_confirmation')
    const user = owner(ctx), agent = store.require<WorkspaceAgent>(user, 'agent', ctx.params.id), input = parse(agentPatch,patch)
    const authorization = auth.pushAuthorizationVersion(user)
    const updated:WorkspaceAgent={...agent,...input,job:input.job??undefined,antiJobs:input.antiJobs??undefined,voice:input.voice??undefined,voiceCustom:input.voiceCustom??undefined,actBias:input.actBias??undefined}
    const sourceChanged=updated.nodeId!==agent.nodeId||updated.profile!==agent.profile
    nodes.requireSource(user,updated)
    let confirmation: string | undefined
    // Source-only edits are saved first, so clients can load the new Profile's
    // catalogue. Keep the selection intact; the next round also validates it.
    if (input.modelSettings !== undefined) {
      if (input.expectedRevision !== agent.revision) throw new HttpError(409, 'Bot 资料已更新，请重新加载后保存模型设置。', 'agent_revision_conflict')
      input.expectedRevision = agent.revision
      const resolution = await resolveBotModelSettings(nodes.target(user, updated.nodeId), updated.profile, updated.modelSettings ?? null)
      const target = botModelTarget(resolution.effective)
      const pending = agent.modelSettingsPendingConfirmation
      const confirmationMessage = [resolution.confirmationMessage, pending?.target === target ? pending.message : null].filter(Boolean).join('\n\n')
      if (confirmationMessage && confirmedModel !== target && agent.modelSettingsConfirmation !== target) {
        ctx.body = { confirmationRequired: true, confirmationMessage, confirmationTarget: target }
        return
      }
      confirmation = confirmedModel === target || agent.modelSettingsConfirmation === target ? target : ''
    }
    if(sourceChanged){
      const sources=await nodes.sources(user)
      if(!sources.sources.some(s=>s.nodeId===updated.nodeId&&s.profile===updated.profile))throw new HttpError(409,'基础机器人当前不可用','source_unavailable')
    }
    if(sourceChanged&&runtime.cloud?.selected(user,updated))await runtime.cloud.requireAvailable(user,updated,nodes.target(user,updated.nodeId))
    if (auth.pushAuthorizationVersion(user) !== authorization) throw new HttpError(401,'账号授权已变化，请重新登录','session_revoked')
    nodes.requireSource(user, updated)
    ctx.body = { agent: store.agentSummary(store.atomic(() => {
      if (input.archived === true && !agent.temporaryGoalId) {
        const direct = store.list<WorkspaceConversation>(user, 'conversation').find(c => c.kind === 'direct' && c.memberIds[0] === agent.id)
        if (direct) store.changeConversationLifecycle(user, direct.id, 'archive')
      }
      nodes.requireSource(user,{...store.require<WorkspaceAgent>(user,'agent',ctx.params.id),...input})
      const saved = store.updateAgent(user, ctx.params.id, input)
      if (confirmation !== undefined) {
        saved.modelSettingsConfirmation = confirmation || undefined
        saved.modelSettingsPendingConfirmation = undefined
        store.put(user, 'agent', saved.id, saved)
      }
      return saved
    })) }
  })
  router.delete('/api/app/agents/:id', async (ctx) => {
    const user = owner(ctx)
    await runtime.cleanupAgent(user, ctx.params.id)
    store.deleteAgent(user, ctx.params.id)
    ctx.body = { ok: true }
  })
  router.get('/api/app/agents/:id/usage', (ctx) => {
    const user = owner(ctx), agent = store.require<WorkspaceAgent>(user, 'agent', ctx.params.id)
    const days = store
      .list<WorkspaceAgentUsageSummary & { agentId: string; date: string; updatedAt: number }>(user, 'agent-token-day')
      .filter(day => day.agentId === agent.id)
      .sort((a, b) => b.date.localeCompare(a.date))
    const now = new Date(),
      today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      month = today.slice(0, 7)
    const summarize = (rows: typeof days): WorkspaceAgentUsageSummary =>
      rows.reduce<WorkspaceAgentUsageSummary>((sum, row) => ({
        input: sum.input + (row.input ?? 0), output: sum.output + (row.output ?? 0), total: sum.total + (row.total ?? 0),
      }), { input: 0, output: 0, total: 0 })
    const usage: WorkspaceAgentUsage = {
      agentId: agent.id,
      today, month,
      todayUsage: summarize(days.filter(day => day.date === today)),
      monthUsage: summarize(days.filter(day => day.date.startsWith(month))),
      totalUsage: summarize(days),
      daily: days.slice(0, 31).map(day => ({ date: day.date, input: day.input ?? 0, output: day.output ?? 0, total: day.total ?? 0 })),
    }
    ctx.body = usage
  })
  router.delete('/api/app/conversations/:id', (ctx) => {
    store.deleteConversation(owner(ctx), ctx.params.id)
    ctx.body = { ok: true }
  })
  router.get('/api/app/conversations/:id/lifecycle', ctx => {
    ctx.body = store.conversationLifecycle(owner(ctx), ctx.params.id)
  })
  router.post('/api/app/conversations/:id/lifecycle', async ctx => {
    const input = parse(z.object({ action: z.enum(['archive', 'restore', 'delete']), confirmationToken: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(), body(ctx))
    if (input.action !== 'restore' && !input.confirmationToken) throw new HttpError(409, '请先确认聊天操作', 'lifecycle_confirmation_required')
    const user = owner(ctx), conversation = store.require<WorkspaceConversation>(user, 'conversation', ctx.params.id)
    if (runtime.openViking?.enabled && input.action === 'delete' && conversation.kind === 'direct') {
      const agent = store.require<WorkspaceAgent>(user, 'agent', conversation.memberIds[0]!)
      store.changeConversationLifecycle(user, conversation.id, 'archive', input.confirmationToken)
      await runtime.cleanupAgent(user, agent.id)
      store.deleteAgent(user, agent.id)
    } else store.changeConversationLifecycle(user, conversation.id, input.action, input.confirmationToken)
    runtime.wake()
    ctx.body = { ok: true }
  })
  router.get('/api/app/conversations', (ctx) => {
    const user = owner(ctx)
    ctx.body = {
      conversations: store
        .list<WorkspaceConversation>(user, 'conversation')
        .map(c => store.conversationSummary(user, c))
        .sort(compareWorkspaceConversations),
      cursor: store.cursor(user),
    }
  })
  router.post('/api/app/conversations', (ctx) => {
    const user = owner(ctx),
      input = body(ctx)
    for (const id of Array.isArray(input.memberIds) ? input.memberIds : [])
      nodes.requireSource(user, store.require<WorkspaceAgent>(user, 'agent', id))
    const conversation = store.createGroup(user, input)
    try {
      push.setGroupSubscription(user, conversation.id, true, conversation.lastSeq)
    } catch {
      /* Optional delivery cannot undo a created chat. */
    }
    ctx.body = { conversation }
    ctx.status = 201
  })
  router.get('/api/app/conversations/:id/tasks', (ctx) => {
    const user = owner(ctx)
    store.resolveTask(user, ctx.params.id)
    ctx.body = { tasks: store.tasks(user, ctx.params.id) }
  })
  router.get('/api/app/conversations/:id/tasks/:taskId/plan', (ctx) => {
    const user = owner(ctx)
    store.requireTask(user, ctx.params.id, ctx.params.taskId)
    ctx.body = { goal: store.get(user, 'goal', ctx.params.taskId) ?? null,
      assignments: runtime.tasks.assignments(user, ctx.params.taskId) }
  })
  router.patch('/api/app/conversations/:id/tasks/:taskId/plan', (ctx) => {
    const user = owner(ctx)
    store.requireTask(user, ctx.params.id, ctx.params.taskId)
    ctx.body = { goal: runtime.tasks.updateCriteria(user, ctx.params.taskId, body(ctx)) }
  })
  router.post('/api/app/conversations/:id/tasks/:taskId/stop', async (ctx) => {
    const user=owner(ctx)
    store.requireTask(user,ctx.params.id,ctx.params.taskId)
    await runtime.stopTask(user,ctx.params.id,ctx.params.taskId)
    ctx.body={ok:true}
  })
  router.post('/api/app/conversations/:id/tasks/:taskId/resume', async (ctx) => {
    const user=owner(ctx), input=parse(z.object({requestId:z.string().uuid()}).strict(),body(ctx))
    const version=auth.pushAuthorizationVersion(user)
    store.requireTask(user,ctx.params.id,ctx.params.taskId)
    const goal=store.require<import('../shared/agentTasks.js').AgentGoal>(user,'goal',ctx.params.taskId)
    const agent=store.require<WorkspaceAgent>(user,'agent',goal.coordinatorId)
    if(auth.pushAuthorizationVersion(user)!==version)throw new HttpError(401,'账号授权已变化，请重新登录','session_revoked')
    ctx.body=store.command(user,input.requestId,{operation:'goal.resume-user',goalId:goal.id},()=>{
      const run=runtime.send(user,ctx.params.id,{requestId:randomUUID(),taskId:goal.id,content:'继续处理当前目标，请先核对已有工作，避免重复执行。'})
      const updated=runtime.tasks.resume(user,agent.id,{requestId:randomUUID(),goalId:goal.id},
        {conversationId:ctx.params.id,conversationTaskId:goal.id,runId:run.id,agentId:agent.id})
      return {goal:updated,run}
    })
  })
  router.post('/api/app/conversations/:id/tasks', (ctx) => {
    const task = store.createTask(owner(ctx), ctx.params.id, body(ctx))
    ctx.status = 201
    ctx.body = { task }
  })
  router.patch('/api/app/conversations/:id/tasks/:taskId', (ctx) => {
    ctx.body = { task: store.updateTask(owner(ctx), ctx.params.id, ctx.params.taskId, body(ctx)) }
  })
  router.put('/api/app/conversations/:id/tasks/:taskId/read', (ctx) => {
    const { seq, unreadVersion } = parse(z.object({ seq: z.number().int().nonnegative(), unreadVersion: z.number().int().nonnegative().optional() }).strict(), body(ctx))
    const user = owner(ctx)
    ctx.body = { task: store.markTaskRead(user, ctx.params.id, ctx.params.taskId, seq, unreadVersion),
      conversation: store.conversationSummary(user, store.require(user, 'conversation', ctx.params.id)) }
  })
  router.delete('/api/app/conversations/:id/tasks/:taskId', async (ctx) => {
    const user = owner(ctx)
    await runtime.stopTask(user, ctx.params.id, ctx.params.taskId)
    store.deleteTask(user, ctx.params.id, ctx.params.taskId)
    ctx.body = { ok: true }
  })
  router.get('/api/app/conversations/:id', (ctx) => {
    ctx.body = workspaceDetail(store, runtime, owner(ctx), ctx.params.id,
      typeof ctx.query.taskId === 'string' ? ctx.query.taskId : undefined,
      Math.max(1, Math.min(100, number(ctx.query.limit, 100))))
  })
  router.patch('/api/app/conversations/:id', async (ctx) => {
    const user = owner(ctx), input = body(ctx)
    for (const id of Array.isArray(input.memberIds) ? input.memberIds : [])
      nodes.requireSource(user, store.require<WorkspaceAgent>(user, 'agent', id))
    const conversation = store.updateConversation(user, ctx.params.id, input)
    if (conversation.archived) await runtime.stopConversation(user, conversation.id)
    runtime.wake()
    ctx.body = { conversation: store.require(user, 'conversation', conversation.id) }
  })
  router.post('/api/app/conversations/:id/agents/:agentId/stop', async (ctx) => {
    const user = owner(ctx),
      taskId = typeof ctx.query.taskId === 'string' ? ctx.query.taskId : undefined,
      task = store.resolveTask(user, ctx.params.id, taskId)
    await runtime.stopAgent(user, ctx.params.id, ctx.params.agentId, task?.id)
    ctx.body = { ok: true }
  })
  router.get('/api/app/conversations/:id/messages', (ctx) => {
    const user = owner(ctx),
      taskId = typeof ctx.query.taskId === 'string' ? ctx.query.taskId : undefined,
      task = store.resolveTask(user, ctx.params.id, taskId)
    ctx.body = {
      messages: store.messages(
        user,
        ctx.params.id,
        number(ctx.query.before, Number.MAX_SAFE_INTEGER),
        Math.min(200, number(ctx.query.limit, 100)),
        false,
        task?.id,
      ),
      cursor: store.cursor(user),
    }
  })
  router.post('/api/app/conversations/:id/messages', async (ctx) => {
    const user = owner(ctx)
    const input = parse(sendInput, body(ctx))
    if (input.mode === 'goal') {
      const version = auth.pushAuthorizationVersion(user)
      if (auth.pushAuthorizationVersion(user) !== version) throw new HttpError(401, '账号授权已变化，请重新登录', 'session_revoked')
    }
    const accepted = runtime.send(user, ctx.params.id, input)
    const run = store.require<WorkspaceRun>(user, 'run', accepted.id)
    ctx.body = {
      requestId: input.requestId, run,
      message: store.messageForDisplay(user, store.require<WorkspaceMessage>(user, 'message', run.messageId)),
      conversation: store.conversationSummary(user, store.require<WorkspaceConversation>(user, 'conversation', run.conversationId)),
      task: run.conversationTaskId ? store.requireTask(user, run.conversationId, run.conversationTaskId) : null,
      cursor: store.cursor(user),
    }
    ctx.status = 202
  })
  router.put('/api/app/conversations/:id/read', (ctx) => {
    const user = owner(ctx),
      c = store.require<WorkspaceConversation>(user, 'conversation', ctx.params.id)
    const { seq, unreadVersion } = parse(z.object({ seq: z.number().int().nonnegative(), unreadVersion: z.number().int().nonnegative().optional() }).strict(), body(ctx))
    if (c.kind === 'group') {
      const taskId = typeof ctx.query.taskId === 'string' ? ctx.query.taskId : undefined,
        task = store.resolveTask(user, c.id, taskId)!
      store.markTaskRead(user, c.id, task.id, seq, unreadVersion)
    }
    ctx.body = { conversation: store.markConversationRead(user, c.id, seq, unreadVersion) }
  })
  router.post('/api/app/runs/:id/stop', async (ctx) => {
    await runtime.stop(owner(ctx), ctx.params.id)
    ctx.body = { ok: true }
  })
  router.post('/api/app/runs/:id/reconcile', (ctx) => {
    const user = owner(ctx)
    store.require(user, 'run', ctx.params.id)
    void runtime.reconcile(user, ctx.params.id).catch(() => {})
    ctx.status = 202
    ctx.body = { ok: true }
  })
  router.post('/api/app/interactions/:id/respond', async (ctx) => {
    const b = parse(z.object({ answer: z.string().min(1).max(16_000) }).strict(), body(ctx))
    await runtime.respond(owner(ctx), ctx.params.id, b.answer)
    ctx.body = { ok: true }
  })
  router.get('/api/app/workspace/snapshot', ctx => {
    const user = owner(ctx)
    const conversations = store.list<WorkspaceConversation>(user, 'conversation')
      .map(c => store.conversationSummary(user, c)).sort(compareWorkspaceConversations)
    const details = conversations.filter(c => !c.archived).map(c => workspaceDetail(store, runtime, user, c.id))
    ctx.set('Cache-Control', 'no-store')
    ctx.body = { projects: runtime.knowledge.projects(user), agents: store.list<WorkspaceAgent>(user, 'agent').map(a => store.agentSummary(a)),
      conversations, details, cursor: store.cursor(user), serverIdentity: readServerIdentity(store) }
  })
  router.get('/api/app/events/stream', ctx => streamWorkspace(ctx, store, auth))
  router.get('/api/app/events', (ctx) => {
    const user = owner(ctx),
      after = number(ctx.query.after, 0),
      events = store.events(user, after)
    ctx.set('Cache-Control', 'no-store')
    ctx.body = { events, cursor: events.at(-1)?.seq ?? after, serverIdentity: readServerIdentity(store) }
  })
  router.get('/api/app/nodes', (ctx) => {
    auth.requireAdmin(ctx)
    ctx.body = {
      nodes: store
        .list<WorkspaceNode>(owner(ctx), 'node')
        .map(({ secret: _secret, ...node }) => node),
    }
  })
  router.post('/api/app/nodes', async (ctx) => {
    auth.requireAdmin(ctx)
    const input = parse(z.object({ qrPayload: z.string().min(1).max(8192), name: z.string().max(100).default(''), nodeId:z.string().uuid().optional() }).strict(), body(ctx))
    await nodes.pair(owner(ctx), input)
    ctx.status = 201; ctx.body = { ok: true }
  })
  router.patch('/api/app/nodes/:id', async (ctx) => {
    auth.requireAdmin(ctx)
    const input = parse(z.object({ name: z.string().min(1).max(100), url: z.string().url().max(2048) }).strict(), body(ctx))
    await nodes.update(owner(ctx), ctx.params.id, input)
    ctx.body = { ok: true }
  })
  router.delete('/api/app/nodes/:id', (ctx) => {
    auth.requireAdmin(ctx)
    nodes.remove(owner(ctx), ctx.params.id)
    ctx.body = { ok: true }
  })
  router.post('/api/app/uploads', async (ctx) => {
    const user = owner(ctx),
      refs = await receiveGroupUploads(ctx.req, uploads, user)
    const files = uploads
      .records(
        refs.map((r) => r.id),
        user,
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        mimeType: r.mimeType,
        size: r.size,
        path: r.path,
        sender: 'user' as const,
        createdAt: Date.now(),
      }))
    // A library entry owns its bytes even when the user cancels the draft.
    uploads.markReferenced(files.map(file => file.id), user)
    for (const f of files) store.put(user, 'file', f.id, f)
    ctx.status = 201
    ctx.body = { files: files.map(publicFile) }
  })
  router.get('/api/app/files', (ctx) => {
    const files = store
      .visibleFiles(owner(ctx))
      .filter(
        (f) =>
          (!ctx.query.search ||
            f.name.toLowerCase().includes(String(ctx.query.search).toLowerCase())) &&
          (!ctx.query.profile || f.profile === ctx.query.profile) &&
          (!ctx.query.session_id || f.conversationId === ctx.query.session_id) &&
          (!ctx.query.sender || f.sender === ctx.query.sender),
      )
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map((f) => libraryFile(publicFile(f), libraryId(owner(ctx), f.id), store.get<WorkspaceConversation>(owner(ctx),'conversation',f.conversationId ?? '')))
      .filter((f) => !ctx.query.kind || f.kind === ctx.query.kind)
    const start = number(ctx.query.cursor, 0),
      limit = Math.min(200, number(ctx.query.limit, 50))
    ctx.body = {
      items: files.slice(start, start + limit),
      total: files.length,
      nextCursor: start + limit < files.length ? String(start + limit) : null,
    }
  })
  router.get('/api/app/files/stats', (ctx) => {
    const files = store.visibleFiles(owner(ctx))
    ctx.body = { count: files.length, totalBytes: files.reduce((sum, f) => sum + f.size, 0) }
  })
  router.post('/api/app/message-files/query', (ctx) => {
    const ids = parse(
      z.object({ messageIds: z.array(z.union([z.string(), z.number()])).max(500) }),
      body(ctx),
    ).messageIds.map(String)
    const files = store.visibleFiles(owner(ctx))
    ctx.body = {
      messages: Object.fromEntries(
        ids.map((id) => [
          id,
          files
            .filter((f) => f.messageId === id || store.get<WorkspaceMessage>(owner(ctx),'message',id)?.attachments.some(attachment=>attachment.id===f.id))
            .map((f, ordinal) => ({
              itemId: libraryId(owner(ctx), f.id),
              messageId: id,
              ordinal,
              originalPath: `/api/app/files/${f.id}/download`,
              referencePath: `/api/app/files/${f.id}/download`,
              name: f.name,
              size: f.size,
              mimeType: f.mimeType,
              archiveStatus: 'ready',
              archivedAt: f.createdAt,
              availability: 'archived',
            })),
        ]),
      ),
    }
  })
  for (const action of ['download', 'preview'])
    router.get(`/api/app/files/:id/${action}`, (ctx) => {
      const file = fileRecord(owner(ctx), ctx.params.id),
        size = statSync(file.path).size
      const activeContent =
        /(?:html|svg|javascript|ecmascript|xml)/i.test(file.mimeType) ||
        /\.(?:html?|svg|js|mjs|xml|xhtml)$/i.test(file.name)
      ctx.type = activeContent ? 'application/octet-stream' : file.mimeType
      ctx.set(
        'Content-Disposition',
        `${action === 'preview' && !activeContent ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      ctx.set('Accept-Ranges', 'bytes')
      ctx.set('Cache-Control', 'private, no-store')
      if(size===0){ctx.body=Buffer.alloc(0);return}
      const range = ctx.get('range'),
        match = /^bytes=(\d*)-(\d*)$/.exec(range)
      let start = 0,
        end = size - 1
      if (range) {
        if (!match || (!match[1] && !match[2]))
          throw new HttpError(416, 'Range invalid', 'invalid_range')
        if (!match[1]) start = Math.max(0, size - Number(match[2]))
        else {
          start = Number(match[1])
          end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
        }
        if (start > end || start >= size) {
          ctx.set('Content-Range', `bytes */${size}`)
          throw new HttpError(416, 'Range invalid', 'invalid_range')
        }
        ctx.status = 206
        ctx.set('Content-Range', `bytes ${start}-${end}/${size}`)
      }
      ctx.length = Math.max(0, end - start + 1)
      ctx.body = size ? createReadStream(file.path, { start, end }) : Buffer.alloc(0)
    })
  const contextKey = (ctx: Koa.Context) =>
    JSON.stringify([ctx.query.profile ?? ctx.get('x-hermes-profile') ?? 'default', ctx.params.id])
  router.get('/api/app/session-context/:id', (ctx) => {
    ctx.body = { snapshot: store.get(owner(ctx), 'native-context', contextKey(ctx)) ?? null }
  })
  router.put('/api/app/session-context/:id', (ctx) => {
    const user = owner(ctx),
      key = contextKey(ctx)
    const value = parse(
      z
        .object({
          usedTokens: z.number().int().nonnegative(),
          limitTokens: z.number().int().positive().nullable().optional(),
          percent: z.number().nonnegative().nullable().optional(),
          compressions: z.number().int().nonnegative().nullable().optional(),
          model: z.string().max(512).nullable().optional(),
          provider: z.string().max(256).nullable().optional(),
          observedAt: z.number().nonnegative(),
        })
        .strict(),
      body(ctx),
    )
    const previous = store.get<{ observedAt: number }>(user, 'native-context', key)
    const snapshot =
      previous && previous.observedAt > value.observedAt
        ? previous
        : { ...value, sessionId: ctx.params.id, updatedAt: Date.now() / 1000 }
    store.put(user, 'native-context', key, snapshot)
    ctx.body = { snapshot }
  })
  registerVoice(router, store, nodes, owner, auth)
  const knowledgeRouter = workspaceKnowledgeRouter(runtime, auth)
  router.use(knowledgeRouter.routes(), knowledgeRouter.allowedMethods())
  return router
}

function registerVoice(
  router: Router,
  store: WorkspaceStore,
  vault: WorkspaceNodes,
  owner: (ctx: Koa.Context) => string,
  auth: LocalAuthStore,
): void {
  const read = (key: string): any => {
    const saved = store.get<string>('_system', 'voice', key)
    return saved ? vault.open(saved) : {}
  }
  const save = (key: string, value: unknown) =>
    store.put('_system', 'voice', key, vault.seal(value))
  const settings = () => ({
    voices: [],
    currentVoiceId: '',
    apiKey: '',
    updatedAt: 0,
    ...read('duplex'),
  })
  const publicSettings = () => {
    const { apiKey, ...value } = settings()
    return { ...value, hasApiKey: Boolean(apiKey) }
  }
  router.get('/api/app/admin/duplex-voice', (ctx) => {
    auth.requireAdmin(ctx)
    ctx.body = publicSettings()
  })
  router.put('/api/app/admin/duplex-voice', (ctx) => {
    auth.requireAdmin(ctx)
    const b = parse(
      z
        .object({
          apiKey: z.string().max(4096).optional(),
          voices: z
            .array(z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) }))
            .max(100),
          currentVoiceId: z.string().max(200),
        })
        .strict(),
      body(ctx),
    )
    if (
      new Set(b.voices.map((v) => v.id)).size !== b.voices.length ||
      (b.currentVoiceId && !b.voices.some((v) => v.id === b.currentVoiceId))
    )
      throw new HttpError(400, '音色设置无效')
    save('duplex', { ...settings(), ...b, updatedAt: Date.now() })
    ctx.body = publicSettings()
  })
  router.get('/api/app/voice/runtime', (ctx) => {
    const user = owner(ctx),
      value = settings()
    ctx.body = {
      ...value,
      currentVoiceId: store.get(user, 'voice-selection', 'current') ?? value.currentVoiceId,
    }
  })
  router.put('/api/app/voice/current-voice', (ctx) => {
    const user = owner(ctx),
      value = settings(),
      id = parse(z.object({ currentVoiceId: z.string() }).strict(), body(ctx)).currentVoiceId
    if (!value.voices.some((v: any) => v.id === id)) throw new HttpError(400, '音色不存在')
    store.put(user, 'voice-selection', 'current', id)
    ctx.body = { voices: value.voices, currentVoiceId: id, updatedAt: Date.now() }
  })
  for (const kind of ['tts', 'stt']) {
    const list = () => {
      const data = read(kind)
      return {
        activeProvider: data.activeProvider ?? (kind === 'tts' ? 'edge' : 'browser'),
        settings: Object.entries(data.providers ?? {}).map(([provider, v]: [string, any]) => ({
          provider,
          settings: v.settings,
          secrets: Object.fromEntries(Object.keys(v.secrets ?? {}).map((k) => [k, '[stored]'])),
        })),
      }
    }
    router.get(`/api/app/${kind}/settings`, (ctx) => {
      owner(ctx)
      ctx.body = list()
    })
    router.put(`/api/app/${kind}/settings/active`, (ctx) => {
      auth.requireAdmin(ctx)
      const data = read(kind),
        provider = parse(
          z.object({ provider: z.string().min(1).max(100) }).strict(),
          body(ctx),
        ).provider
      if (!data.providers?.[provider] && !['edge', 'browser'].includes(provider))
        throw new HttpError(400, '请先配置服务商')
      data.activeProvider = provider
      save(kind, data)
      ctx.body = list()
    })
    router.put(`/api/app/${kind}/settings/:provider`, (ctx) => {
      auth.requireAdmin(ctx)
      const input = parse(
        z
          .object({
            settings: z.record(z.string(), z.unknown()).default({}),
            secrets: z.record(z.string(), z.string().max(4096)).default({}),
            activeProvider: z.string().optional(),
          })
          .strict(),
        body(ctx),
      )
      if (JSON.stringify(input.settings).length > 32_000) throw new HttpError(413, '设置过大')
      const data = read(kind)
      data.providers ??= {}
      const old = data.providers[ctx.params.provider] ?? { settings: {}, secrets: {} }
      data.providers[ctx.params.provider] = {
        settings: { ...old.settings, ...input.settings },
        secrets: {
          ...old.secrets,
          ...Object.fromEntries(Object.entries(input.secrets).filter(([, v]) => v !== '[stored]')),
        },
      }
      if (input.activeProvider) data.activeProvider = input.activeProvider
      save(kind, data)
      ctx.body = list()
    })
    router.delete(`/api/app/${kind}/settings/:provider`, (ctx) => {
      auth.requireAdmin(ctx)
      const data = read(kind)
      if (data.providers) delete data.providers[ctx.params.provider]
      if (data.activeProvider === ctx.params.provider)
        data.activeProvider = kind === 'tts' ? 'edge' : 'browser'
      save(kind, data)
      ctx.body = list()
    })
    router.delete(`/api/app/${kind}/settings/:provider/secret/:secret`, (ctx) => {
      auth.requireAdmin(ctx)
      const data = read(kind)
      if (data.providers?.[ctx.params.provider]?.secrets)
        delete data.providers[ctx.params.provider].secrets[ctx.params.secret]
      save(kind, data)
      ctx.body = list()
    })
    router.delete(`/api/app/${kind}/settings/:provider/base-url-preset`, (ctx) => {
      auth.requireAdmin(ctx)
      const data = read(kind),
        s = data.providers?.[ctx.params.provider]?.settings
      if (s) s.baseUrlPresets = (s.baseUrlPresets ?? []).filter((v: string) => v !== ctx.query.url)
      save(kind, data)
      ctx.body = list()
    })
  }
  router.get('/api/app/voice/providers-info', (ctx) => {
    owner(ctx)
    ctx.body = {
      tts: ['edge', 'openai', 'custom', 'mimo', 'doubao'],
      stt: ['browser', 'openai', 'custom', 'doubao'],
    }
  })
  router.post('/api/app/voice/probe', async (ctx) => {
    auth.requireAdmin(ctx)
    const b = parse(
        z
          .object({
            kind: z.enum(['tts', 'stt']),
            provider: z.string().optional(),
            compatibility: z.enum(['manual', 'openai-compatible']).default('openai-compatible'),
            baseUrl: z.string().url(),
            apiKey: z.string().max(4096).optional(),
          })
          .strict(),
        body(ctx),
      ),
      url = new URL(b.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new HttpError(400, '服务地址无效')
    if (b.compatibility === 'manual') {
      ctx.body = { ok: true, models: [], normalizedBaseUrl: b.baseUrl, manualModelAllowed: true }
      return
    }
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
    const response = await fetch(url, {
      headers: b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
    const value = (await response.json()) as any
    ctx.body = {
      ok: response.ok,
      models: Array.isArray(value.data)
        ? value.data.slice(0, 500).map((m: any) => String(m.id))
        : [],
      normalizedBaseUrl: b.baseUrl,
      manualModelAllowed: true,
      errorSummary: response.ok ? '' : `HTTP ${response.status}`,
    }
  })
}
