import { readServerIdentity } from './serverIdentity.js'
import { randomUUID } from 'node:crypto'
import Router from '@koa/router'
import type Koa from 'koa'
import { createReadStream, statSync } from 'node:fs'
import { z } from 'zod'
import { WorkspaceStore, agentInput, parse } from './workspaceStore.js'
import { WorkspaceRuntime } from './workspaceRuntime.js'
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
import type {
  WorkspaceMessage,
  WorkspaceAgent,
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
    ctx.body = {
      protocolVersion: 1,
      serverKind: 'yaoyao-web',
      features: [
        'agents',
        'conversations',
        'conversationTasks',
        'editableGroups',
        'agentTeamManagement',
        'computerControl','sharedComputers','computerManagement',
        'files',
        'voice',
        'context',
        ...(auth.require(ctx).role === 'admin' ? ['nodes', 'pairedNodes', 'remoteAgentReferences', 'editableNodeAddress'] : []),
        'events',
      ],
    }
  })
  router.get('/api/app/agents/sources', async (ctx) => {
    ctx.body = await nodes.sources(owner(ctx))
  })
  router.get('/api/app/agents', async (ctx) => {
    const user=owner(ctx), agents=store.list<WorkspaceAgent>(user,'agent')
    for (const agent of agents) if (agent.remoteAgentId) void nodes.refreshRemoteAgent(user,agent).catch(()=>{})
    ctx.body = { agents: agents.map(agent=>store.agentSummary(agent)) }
  })
  router.get('/api/app/nodes/:id/agents', async ctx => {
    auth.requireAdmin(ctx)
    ctx.body = { agents: await nodes.remoteAgents(owner(ctx),ctx.params.id) }
  })
  router.post('/api/app/agents/remote', async ctx => {
    auth.requireAdmin(ctx)
    const input = parse(z.object({nodeId:z.string().uuid(),agentId:z.string().uuid()}).strict(),body(ctx))
    ctx.body = { agent: await nodes.importRemoteAgent(owner(ctx),input.nodeId,input.agentId) };ctx.status=201
  })
  router.post('/api/app/agents', async (ctx) => {
    const user = owner(ctx),
      input = parse(agentInput, body(ctx))
    const authorization = auth.pushAuthorizationVersion(user)
    nodes.requireSource(user, input)
    const sources = await nodes.sources(user)
    if (!sources.sources.some((s) => s.nodeId === input.nodeId && s.profile === input.profile))
      throw new HttpError(409, '基础 Agent 当前不可用', 'source_unavailable')
    nodes.requireSource(user, input)
    if (input.canManageTeam || input.execution==='computer') await runtime.teamTools.requireAvailable(user, input)
    if (auth.pushAuthorizationVersion(user) !== authorization) throw new HttpError(401,'账号授权已变化，请重新登录','session_revoked')
    ctx.body = { agent: store.agentSummary(store.createAgent(user, input)) }
    ctx.status = 201
  })
  router.patch('/api/app/agents/:id', async (ctx) => {
    const user = owner(ctx), agent = store.require<WorkspaceAgent>(user, 'agent', ctx.params.id), input = body(ctx)
    const authorization = auth.pushAuthorizationVersion(user)
    nodes.requireSource(user, agent)
    if ((input.canManageTeam === true && agent.canManageTeam !== true) || input.execution==='computer') await runtime.teamTools.requireAvailable(user, {...agent,...(input.execution?{execution:input.execution}:{})})
    if (auth.pushAuthorizationVersion(user) !== authorization) throw new HttpError(401,'账号授权已变化，请重新登录','session_revoked')
    nodes.requireSource(user, agent)
    ctx.body = { agent: store.agentSummary(store.updateAgent(user, ctx.params.id, input)) }
  })
  router.delete('/api/app/agents/:id', (ctx) => {
    store.deleteAgent(owner(ctx), ctx.params.id)
    ctx.body = { ok: true }
  })
  router.delete('/api/app/conversations/:id', (ctx) => {
    store.deleteConversation(owner(ctx), ctx.params.id)
    ctx.body = { ok: true }
  })
  router.get('/api/app/conversations', (ctx) => {
    const user = owner(ctx)
    ctx.body = {
      conversations: store
        .list<WorkspaceConversation>(user, 'conversation')
        .map(c => store.conversationSummary(user, c))
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt) ||
            a.id.localeCompare(b.id),
        ),
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
    await runtime.teamTools.requireAvailable(user,agent)
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
    const seq = parse(z.object({ seq: z.number().int().nonnegative() }).strict(), body(ctx)).seq
    ctx.body = { task: store.markTaskRead(owner(ctx), ctx.params.id, ctx.params.taskId, seq) }
  })
  router.delete('/api/app/conversations/:id/tasks/:taskId', async (ctx) => {
    const user = owner(ctx)
    await runtime.stopTask(user, ctx.params.id, ctx.params.taskId)
    store.deleteTask(user, ctx.params.id, ctx.params.taskId)
    ctx.body = { ok: true }
  })
  router.get('/api/app/conversations/:id', (ctx) => {
    const user = owner(ctx),
      conversation = store.require<WorkspaceConversation>(user, 'conversation', ctx.params.id),
      requestedTaskId = typeof ctx.query.taskId === 'string' ? ctx.query.taskId : undefined,
      task = store.resolveTask(user, conversation.id, requestedTaskId),
      tasks = conversation.kind === 'group' ? store.tasks(user, conversation.id) : [],
      activeRunId = task?.activeRunId ?? (conversation.kind === 'direct' ? conversation.activeRunId : undefined)
    ctx.body = {
      conversation: store.conversationSummary(user, conversation),
      task: task ?? null,
      tasks,
      assignments: task ? runtime.tasks.assignments(user, task.id) : [],
      messages: store.messages(user, conversation.id, Number.MAX_SAFE_INTEGER, 100, false, task?.id),
      hiddenMessageIds: store.hiddenMessageIds(user, conversation.id, task?.id),
      run: activeRunId
        ? store.require<WorkspaceRun>(user, 'run', activeRunId)
        : null,
      interactions: store
        .list<WorkspaceInteraction>(user, 'interaction')
        .filter((i) => i.conversationId === conversation.id && i.conversationTaskId === task?.id && !i.resolved),
      context: store.get(user, 'context', task?.id ?? conversation.id) ?? null,
    }
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
    }
  })
  router.post('/api/app/conversations/:id/messages', (ctx) => {
    const user = owner(ctx)
    ctx.body = { run: runtime.send(user, ctx.params.id, body(ctx)) }
    ctx.status = 202
  })
  router.put('/api/app/conversations/:id/read', (ctx) => {
    const user = owner(ctx),
      c = store.require<WorkspaceConversation>(user, 'conversation', ctx.params.id)
    const seq = parse(z.object({ seq: z.number().int().nonnegative() }).strict(), body(ctx)).seq
    if (c.kind === 'group') {
      const taskId = typeof ctx.query.taskId === 'string' ? ctx.query.taskId : undefined,
        task = store.resolveTask(user, c.id, taskId)!
      store.markTaskRead(user, c.id, task.id, seq)
    }
    c.readSeq = Math.max(c.readSeq, Math.min(seq, c.lastSeq))
    store.atomic(() => {
      store.put(user, 'conversation', c.id, c)
      store.event(user, 'conversation.changed', c, c.id)
    })
    ctx.body = { conversation: c }
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
