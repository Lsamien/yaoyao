import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { notificationPlainText } from './notificationText.js'
import { decodeAgentMascotAvatar, isAgentImageAvatar, defaultAgentIdentity, encodeAgentAvatar, normalizeAvatar, randomAgentIdentity, MAX_AVATAR_DESCRIPTOR_LENGTH } from '../shared/agentIdentity.js'
import type {
  WorkspaceAgent as Agent,
  WorkspaceConversation as Conversation,
  WorkspaceTask as Task,
  WorkspaceMessage as Message,
  WorkspaceRun as Run,
  WorkspaceEvent,
} from '../shared/workspace.js'

const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !/[\u0000-\u001f@]/.test(v), '名称不能包含 @ 或控制字符')
const avatar = z
  .string()
  .max(MAX_AVATAR_DESCRIPTOR_LENGTH)
  .refine(
    (v) => !v || isAgentImageAvatar(v) || !!decodeAgentMascotAvatar(v) || /^builtin:team-animal:(fox|whale|owl|rabbit|bear)$/.test(v),
    '请选择有效的内置头像或 PNG、JPEG、WebP 图片',
  )
const taskTitle = z.string().trim().min(1).max(100).refine((v) => !/[\u0000-\u001f]/.test(v), '标题不能包含控制字符')
export const agentInput = z
  .object({
    name,
    avatar: avatar.default(''),
    instructions: z.string().max(24_000).default(''),
    nodeId: z.string().default('local'),
    profile: z.string().min(1).max(256),
  })
  .strict()
export const agentPatch = z
  .object({
    name: name.optional(),
    avatar: avatar.optional(),
    instructions: z.string().max(24_000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
const memberRoles = z.record(z.string().uuid(), z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
}).strict()).refine(value => Object.keys(value).length <= 8, '最多 8 个群内角色')
export const groupInput = z
  .object({
    name,
    avatar: avatar.default(''),
    memberIds: z.array(z.string().uuid()).min(2).max(8),
    memberRoles: memberRoles.default({}),
    instructions: z.string().max(24_000).default(''),
    administratorId: z.string().uuid(),
    mode: z.enum(['host', 'free']).default('host'),
    autoReplyIds: z.array(z.string().uuid()).max(8).default([]),
    maxReplyRounds: z.union([z.literal(-1), z.number().int().min(1).max(100)]).default(3),
  })
  .strict()
export const conversationPatch = z
  .object({
    name: name.optional(),
    avatar: avatar.optional(),
    instructions: z.string().max(24_000).optional(),
    memberIds: z.array(z.string().uuid()).min(1).max(8).optional(),
    memberRoles: memberRoles.optional(),
    administratorId: z.string().uuid().optional(),
    mode: z.enum(['host', 'free']).optional(),
    autoReplyIds: z.array(z.string().uuid()).max(8).optional(),
    maxReplyRounds: z.union([z.literal(-1), z.number().int().min(1).max(100)]).optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict()
export const taskInput = z
  .object({ title: z.string().trim().max(100).refine((v) => !/[\u0000-\u001f]/.test(v), '标题不能包含控制字符').optional() })
  .strict()
export const taskPatch = z
  .object({ title: taskTitle })
  .strict()
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      'invalid_workspace_request',
    )
  return parsed.data
}
export class WorkspaceStore {
  readonly db: DatabaseSync
  readonly changes = new EventEmitter()
  private transactionEvents: Array<{ owner: string; event: WorkspaceEvent }> | undefined
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const path = join(home, 'workspace.sqlite3')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspace_entities(owner TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,kind,id));
      CREATE TABLE IF NOT EXISTS workspace_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,type TEXT NOT NULL,conversation_id TEXT,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_events_owner ON workspace_events(owner,seq);
      CREATE TABLE IF NOT EXISTS workspace_commands(owner TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS workspace_turn_run ON workspace_entities(owner, json_extract(data,'$.runId')) WHERE kind='turn';
      CREATE INDEX IF NOT EXISTS workspace_turn_status ON workspace_entities(owner, json_extract(data,'$.status'), json_extract(data,'$.planned')) WHERE kind='turn';
      CREATE INDEX IF NOT EXISTS workspace_turn_conversation ON workspace_entities(owner, json_extract(data,'$.conversationId')) WHERE kind='turn';
      CREATE INDEX IF NOT EXISTS workspace_message_task ON workspace_entities(owner, json_extract(data,'$.conversationTaskId'), json_extract(data,'$.seq')) WHERE kind='message';
      CREATE INDEX IF NOT EXISTS workspace_run_task ON workspace_entities(owner, json_extract(data,'$.conversationTaskId'), json_extract(data,'$.status')) WHERE kind='run';
      CREATE INDEX IF NOT EXISTS workspace_turn_task ON workspace_entities(owner, json_extract(data,'$.conversationTaskId'), json_extract(data,'$.status')) WHERE kind='turn';`)
    this.changes.setMaxListeners(0)
    this.atomic(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS workspace_migrations(id TEXT PRIMARY KEY)')
      if (this.db.prepare('SELECT id FROM workspace_migrations WHERE id=?').get('avatar-v2')) return
      for (const owner of this.owners()) {
        for (const agent of this.list<Agent>(owner, 'agent')) {
          this.put(owner, 'agent', agent.id, { ...agent, avatar: normalizeAvatar(agent.avatar) })
        }
        for (const conversation of this.list<Conversation>(owner, 'conversation')) {
          if (conversation.kind !== 'direct') continue
          const agent = this.get<Agent>(owner, 'agent', conversation.memberIds[0] || '')
          this.put(owner, 'conversation', conversation.id, { ...conversation, avatar: agent?.avatar ?? normalizeAvatar(conversation.avatar) })
        }
      }
      this.db.prepare('INSERT INTO workspace_migrations VALUES(?)').run('avatar-v2')
    })
    this.atomic(() => {
      if (this.db.prepare('SELECT id FROM workspace_migrations WHERE id=?').get('avatar-random-default-v1')) return
      for (const owner of this.owners()) {
        for (const agent of this.list<Agent>(owner, 'agent')) {
          const identity = decodeAgentMascotAvatar(agent.avatar)
          const isSystemDefault = identity && !identity.imageDataURL && identity.shape === 'circle'
            && identity.color === '#00c875' && identity.expression === 'idle' && !identity.bodyId
          if (!isSystemDefault) continue
          const avatar = encodeAgentAvatar(randomAgentIdentity(agent.id, agent.name))
          this.put(owner, 'agent', agent.id, { ...agent, avatar })
          for (const conversation of this.list<Conversation>(owner, 'conversation')) {
            if (conversation.kind === 'direct' && conversation.memberIds[0] === agent.id) {
              this.put(owner, 'conversation', conversation.id, { ...conversation, avatar })
            }
          }
        }
      }
      this.db.prepare('INSERT INTO workspace_migrations VALUES(?)').run('avatar-random-default-v1')
    })
  }
  get<T>(owner: string, kind: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT data FROM workspace_entities WHERE owner=? AND kind=? AND id=?')
      .get(owner, kind, id)
    return row ? (JSON.parse(String(row.data)) as T) : undefined
  }
  require<T>(owner: string, kind: string, id: string): T {
    const value = this.get<T>(owner, kind, id)
    if (!value) throw new HttpError(404, '记录不存在', 'workspace_not_found')
    return value
  }
  list<T>(owner: string, kind: string): T[] {
    return this.db
      .prepare('SELECT data FROM workspace_entities WHERE owner=? AND kind=?')
      .all(owner, kind)
      .map((r) => JSON.parse(String(r.data)) as T)
  }
  owners(): string[] {
    return this.db
      .prepare('SELECT DISTINCT owner FROM workspace_entities')
      .all()
      .map((r) => String(r.owner))
  }
  put(owner: string, kind: string, id: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO workspace_entities VALUES(?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data',
      )
      .run(owner, kind, id, JSON.stringify(value))
  }
  remove(owner: string, kind: string, id: string): void {
    this.db
      .prepare('DELETE FROM workspace_entities WHERE owner=? AND kind=? AND id=?')
      .run(owner, kind, id)
  }
  atomic<T>(fn: () => T): T {
    if (this.transactionEvents) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionEvents = []
    try {
      const result = fn()
      this.db.exec('COMMIT')
      const events = this.transactionEvents
      this.transactionEvents = undefined
      for (const entry of events) this.changes.emit(entry.owner, entry.event)
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.transactionEvents = undefined
      throw error
    }
  }
  event(owner: string, type: string, data: unknown, conversationId?: string): number {
    const seq = Number(
      this.db
        .prepare('INSERT INTO workspace_events(owner,type,conversation_id,data) VALUES(?,?,?,?)')
        .run(owner, type, conversationId ?? null, JSON.stringify(data)).lastInsertRowid,
    )
    const event = { seq, type, conversationId, data }
    if (this.transactionEvents) this.transactionEvents.push({ owner, event })
    else this.changes.emit(owner, event)
    return seq
  }
  events(owner: string, after: number): WorkspaceEvent[] {
    return this.db
      .prepare('SELECT * FROM workspace_events WHERE owner=? AND seq>? ORDER BY seq LIMIT 250')
      .all(owner, after)
      .map((r) => ({
        seq: Number(r.seq),
        type: String(r.type),
        conversationId: r.conversation_id ? String(r.conversation_id) : undefined,
        data: JSON.parse(String(r.data)),
      }))
  }
  cursor(owner: string): number {
    return Number(
      this.db
        .prepare('SELECT coalesce(max(seq),0) AS n FROM workspace_events WHERE owner=?')
        .get(owner)!.n,
    )
  }
  command<T>(owner: string, id: string, payload: unknown, fn: () => T): T {
    parse(z.string().uuid(), id)
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    return this.atomic(() => {
      const old = this.db
        .prepare('SELECT fingerprint,result FROM workspace_commands WHERE owner=? AND id=?')
        .get(owner, id)
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HttpError(409, '请求编号已用于其他内容', 'idempotency_conflict')
        return JSON.parse(String(old.result)) as T
      }
      const result = fn()
      this.db
        .prepare('INSERT INTO workspace_commands VALUES(?,?,?,?)')
        .run(owner, id, fingerprint, JSON.stringify(result))
      return result
    })
  }
  createAgent(owner: string, input: unknown): Agent {
    const body = parse(agentInput, input)
    return this.atomic(() => {
      if (
        this.list<Agent>(owner, 'agent').some(
          (a) => a.name.toLocaleLowerCase() === body.name.toLocaleLowerCase(),
        )
      )
        throw new HttpError(409, 'Agent 名称已存在', 'duplicate_agent_name')
      const now = Date.now(),
        id = randomUUID()
      const agent: Agent = {
        ...body,
        avatar: body.avatar ? normalizeAvatar(body.avatar) : encodeAgentAvatar(randomAgentIdentity(id, body.name)),
        id,
        archived: false,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      this.put(owner, 'agent', id, agent)
      const conversation: Conversation = {
        id: randomUUID(),
        kind: 'direct',
        name: agent.name,
        avatar: agent.avatar,
        memberIds: [id],
        instructions: '',
        administratorId: id,
        mode: 'host',
        autoReplyIds: [],
        maxReplyRounds: 1,
        archived: false,
        pinned: false,
        readSeq: 0,
        lastSeq: 0,
        preview: '',
        createdAt: now,
        updatedAt: now,
      }
      this.put(owner, 'conversation', conversation.id, conversation)
      this.event(owner, 'agent.changed', agent)
      this.event(owner, 'conversation.changed', conversation, conversation.id)
      return agent
    })
  }
  updateAgent(owner: string, id: string, input: unknown): Agent {
    const patch = parse(agentPatch, input)
    if (patch.avatar !== undefined) patch.avatar = normalizeAvatar(patch.avatar)
    return this.atomic(() => {
      const agent = this.require<Agent>(owner, 'agent', id)
      if (
        patch.name &&
        this.list<Agent>(owner, 'agent').some(
          (a) => a.id !== id && a.name.toLocaleLowerCase() === patch.name!.toLocaleLowerCase(),
        )
      )
        throw new HttpError(409, 'Agent 名称已存在', 'duplicate_agent_name')
      const next = { ...agent, ...patch, revision: agent.revision + 1, updatedAt: Date.now() }
      this.put(owner, 'agent', id, next)
      this.event(owner, 'agent.changed', next)
      for (const c of this.list<Conversation>(owner, 'conversation').filter(
        (c) => c.kind === 'direct' && c.memberIds[0] === id,
      )) {
        Object.assign(c, { name: next.name, avatar: next.avatar, archived: next.archived })
        this.put(owner, 'conversation', c.id, c)
        this.event(owner, 'conversation.changed', c, c.id)
      }
      return next
    })
  }
  createGroup(owner: string, input: unknown): Conversation {
    const body = parse(groupInput, input)
    const ids = new Set(body.memberIds)
    if (
      ids.size !== body.memberIds.length ||
      !ids.has(body.administratorId) ||
      body.autoReplyIds.some((id) => !ids.has(id)) ||
      Object.keys(body.memberRoles).some(id => !ids.has(id))
    )
      throw new HttpError(400, '群成员或管理员无效', 'invalid_members')
    for (const id of ids)
      if (this.require<Agent>(owner, 'agent', id).archived)
        throw new HttpError(409, '已归档 Agent 不能加入新群', 'agent_archived')
    const now = Date.now()
    const c: Conversation = {
      ...body,
      id: randomUUID(),
      kind: 'group',
      archived: false,
      pinned: false,
      readSeq: 0,
      lastSeq: 0,
      preview: '',
      createdAt: now,
      updatedAt: now,
    }
    this.atomic(() => {
      this.put(owner, 'conversation', c.id, c)
      this.event(owner, 'conversation.changed', c, c.id)
      this.createTask(owner, c.id, {})
    })
    return c
  }
  tasks(owner: string, conversationId: string): Task[] {
    const conversation = this.require<Conversation>(owner, 'conversation', conversationId)
    if (conversation.kind !== 'group')
      throw new HttpError(400, '单聊不支持任务', 'conversation_tasks_unsupported')
    return this.list<Task>(owner, 'conversation-task')
      .filter((task) => task.conversationId === conversationId)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }
  createTask(owner: string, conversationId: string, input: unknown): Task {
    const body = parse(taskInput, input),
      conversation = this.require<Conversation>(owner, 'conversation', conversationId)
    if (conversation.kind !== 'group')
      throw new HttpError(400, '单聊不支持任务', 'conversation_tasks_unsupported')
    const now = Date.now(),
      explicitTitle = body.title?.trim(),
      task: Task = {
        id: randomUUID(),
        conversationId,
        title: explicitTitle || '新任务',
        titleSource: explicitTitle ? 'user' : 'automatic',
        messageCount: 0,
        readSeq: 0,
        lastSeq: 0,
        unreadCount: 0,
        createdAt: now,
        updatedAt: now,
      }
    this.atomic(() => {
      this.put(owner, 'conversation-task', task.id, task)
      this.event(owner, 'task.changed', task, conversationId)
    })
    return task
  }
  requireTask(owner: string, conversationId: string, taskId: string): Task {
    const task = this.require<Task>(owner, 'conversation-task', taskId)
    if (task.conversationId !== conversationId)
      throw new HttpError(404, '任务不存在', 'workspace_task_not_found')
    return task
  }
  resolveTask(owner: string, conversationId: string, taskId?: string): Task | undefined {
    const conversation = this.require<Conversation>(owner, 'conversation', conversationId)
    if (conversation.kind === 'direct') {
      if (taskId) throw new HttpError(400, '单聊不支持任务', 'conversation_tasks_unsupported')
      return undefined
    }
    if (taskId) return this.requireTask(owner, conversationId, taskId)
    return this.tasks(owner, conversationId)[0] ?? this.createTask(owner, conversationId, {})
  }
  updateTask(owner: string, conversationId: string, taskId: string, input: unknown): Task {
    const patch = parse(taskPatch, input)
    return this.atomic(() => {
      const task = this.requireTask(owner, conversationId, taskId),
        next: Task = { ...task, title: patch.title, titleSource: 'user', updatedAt: Date.now() }
      this.put(owner, 'conversation-task', task.id, next)
      this.event(owner, 'task.changed', next, conversationId)
      return next
    })
  }
  markTaskRead(owner: string, conversationId: string, taskId: string, seq: number): Task {
    return this.atomic(() => {
      const task = this.requireTask(owner, conversationId, taskId)
      task.readSeq = Math.max(task.readSeq, Math.min(seq, task.lastSeq))
      task.unreadCount = this.messages(owner, conversationId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false, task.id)
        .filter(message => message.seq > task.readSeq).length
      this.put(owner, 'conversation-task', task.id, task)
      this.event(owner, 'task.changed', task, conversationId)
      return task
    })
  }
  deleteTask(owner: string, conversationId: string, taskId: string): void {
    this.atomic(() => {
      const task = this.requireTask(owner, conversationId, taskId)
      if (this.list<Run>(owner, 'run').some(run => run.conversationTaskId === taskId && !['complete', 'failed', 'interrupted'].includes(run.status)))
        throw new HttpError(409, '任务仍在运行，暂时无法移除', 'workspace_task_running')
      const messageIds = new Set(this.list<Message>(owner, 'message').filter(message => message.conversationTaskId === taskId).map(message => message.id))
      this.db.prepare("DELETE FROM workspace_entities WHERE owner=? AND kind IN ('message','run','turn','interaction','interaction-binding','binding') AND json_extract(data,'$.conversationTaskId')=?").run(owner, taskId)
      this.remove(owner, 'context', taskId)
      this.remove(owner, 'conversation-task', taskId)
      this.db.prepare("DELETE FROM workspace_commands WHERE owner=? AND json_extract(result,'$.conversationTaskId')=?").run(owner, taskId)
      for (const file of this.list<Record<string, unknown> & { id: string; messageId?: string }>(owner, 'file')) {
        if (!file.messageId || !messageIds.has(file.messageId)) continue
        this.put(owner, 'file', String(file.id), { ...file, conversationId: undefined, messageId: undefined })
      }
      this.event(owner, 'task.deleted', { id: taskId, conversationId }, conversationId)
      const remaining = this.tasks(owner, conversationId)
      if (!remaining.length) this.createTask(owner, conversationId, {})
      const conversation = this.require<Conversation>(owner, 'conversation', conversationId),
        history = this.messages(owner, conversationId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      const last = history.at(-1)
      conversation.preview = last ? notificationPlainText(last.content, { maximum: 160, fallback: '' }) : ''
      conversation.previewAgentId = last?.role === 'assistant' ? last.agentId : undefined
      conversation.lastMessageAt = last?.createdAt
      conversation.updatedAt = Date.now()
      this.projectConversationRuns(owner, conversation)
      this.put(owner, 'conversation', conversationId, conversation)
      this.event(owner, 'conversation.changed', conversation, conversationId)
    })
  }
  updateConversation(owner: string, id: string, input: unknown): Conversation {
    const patch = parse(conversationPatch, input),
      c = this.require<Conversation>(owner, 'conversation', id)
    if (c.kind === 'direct' && Object.keys(patch).some((k) => k !== 'pinned'))
      throw new HttpError(400, '请编辑 Agent 资料', 'edit_agent_instead')
    const memberIds = patch.memberIds ?? c.memberIds
    const members = new Set(memberIds)
    if (!members.has(c.administratorId))
      throw new HttpError(400, '当前管理员不能移除，请先更换管理员并保存', 'administrator_required')
    if (
      members.size !== memberIds.length ||
      !members.has(patch.administratorId ?? c.administratorId) ||
      patch.autoReplyIds?.some((a) => !members.has(a) && !c.memberIds.includes(a)) ||
      Object.keys(patch.memberRoles ?? {}).some(a => !members.has(a) && !c.memberIds.includes(a))
    )
      throw new HttpError(400, '群成员或管理员无效', 'invalid_members')
    for (const memberId of memberIds) {
      const agent = this.require<Agent>(owner, 'agent', memberId)
      if (!c.memberIds.includes(memberId) && agent.archived)
        throw new HttpError(409, '已归档 Agent 不能加入群聊', 'agent_archived')
    }
    const next = {
      ...c, ...patch, memberIds,
      autoReplyIds: (patch.autoReplyIds ?? c.autoReplyIds).filter(a => members.has(a)),
      memberRoles: Object.fromEntries(Object.entries(patch.memberRoles ?? c.memberRoles ?? {}).filter(([id]) => members.has(id))),
      updatedAt: Date.now(),
    }
    this.atomic(() => {
      this.put(owner, 'conversation', id, next)
      this.event(owner, 'conversation.changed', next, id)
    })
    return next
  }
  messages(
    owner: string,
    conversationId: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 100,
    includeHidden = false,
    conversationTaskId?: string,
  ): Message[] {
    this.require(owner, 'conversation', conversationId)
    if (conversationTaskId) this.requireTask(owner, conversationId, conversationTaskId)
    const taskClause = conversationTaskId ? "AND json_extract(data,'$.conversationTaskId')=?" : ''
    return this.db
      .prepare(
        `SELECT data FROM workspace_entities WHERE owner=? AND kind='message' AND json_extract(data,'$.conversationId')=? ${taskClause} AND json_extract(data,'$.seq')<? ${includeHidden ? '' : "AND coalesce(json_extract(data,'$.visible'),1) != 0"} ORDER BY json_extract(data,'$.seq') DESC LIMIT ?`,
      )
      .all(...(conversationTaskId ? [owner, conversationId, conversationTaskId, before, limit] : [owner, conversationId, before, limit]))
      .map((r) => JSON.parse(String(r.data)) as Message)
      .reverse()
  }
  saveMessage(owner: string, message: Message): void {
    this.atomic(() => {
      const c = this.require<Conversation>(owner, 'conversation', message.conversationId)
      const previous = this.get<Message>(owner, 'message', message.id)
      if (previous && previous.conversationTaskId !== message.conversationTaskId)
        throw new HttpError(409, '消息不能移入其他任务', 'message_task_mismatch')
      const task = c.kind === 'group'
        ? message.conversationTaskId
          ? this.requireTask(owner, c.id, message.conversationTaskId)
          : (() => { throw new HttpError(400, '群聊消息必须指定任务', 'workspace_task_required') })()
        : undefined
      if (previous?.visible === false && message.visible !== false) message.seq = 0
      if (!message.seq) message.seq = c.lastSeq + 1
      c.lastSeq = Math.max(c.lastSeq, message.seq)
      if (message.visible !== false && (message.content.trim() || message.attachments.length)) {
        c.updatedAt = Date.now()
        c.lastMessageAt = Math.max(c.lastMessageAt ?? 0, message.createdAt)
        c.preview = notificationPlainText(message.content, { maximum: 160, fallback: '' })
        c.previewAgentId = message.role === 'assistant' ? message.agentId : undefined
      }
      this.put(owner, 'message', message.id, message)
      this.put(owner, 'conversation', c.id, c)
      if (task) {
        const becameVisible = message.visible !== false && (!previous || previous.visible === false),
          becameHidden = Boolean(previous && previous.visible !== false && message.visible === false)
        if (becameVisible) task.messageCount += 1
        if (becameHidden) task.messageCount = Math.max(0, task.messageCount - 1)
        task.lastSeq = Math.max(task.lastSeq, message.seq)
        if (becameVisible && message.seq > task.readSeq) task.unreadCount += 1
        if (becameHidden && message.seq > task.readSeq) task.unreadCount = Math.max(0, task.unreadCount - 1)
        if (message.visible !== false && (message.content.trim() || message.attachments.length)) {
          if (message.role === 'user' && task.titleSource === 'automatic' && task.messageCount <= 1) {
            const source = notificationPlainText(message.content, { maximum: 48, fallback: message.attachments[0]?.name ?? '' }).trim()
            if (source) task.title = source
          }
          task.lastMessageAt = Math.max(task.lastMessageAt ?? 0, message.createdAt)
          task.updatedAt = Date.now()
        }
        this.put(owner, 'conversation-task', task.id, task)
        this.event(owner, 'task.changed', task, c.id)
      }
      this.event(owner, 'message.changed', message, c.id)
      this.event(owner, 'conversation.changed', c, c.id)
    })
  }
  agentSummary(agent: Agent): Agent {
    return { ...agent, avatar: agent.avatar || encodeAgentAvatar(defaultAgentIdentity(agent.id, agent.name)) }
  }
  conversationSummary(owner: string, conversation: Conversation): Conversation {
    const member = conversation.kind === 'direct' ? this.get<Agent>(owner, 'agent', conversation.memberIds[0] ?? '') : undefined,
      unreadCount = conversation.kind === 'group'
        ? this.tasks(owner, conversation.id).reduce((count, task) => count + task.unreadCount, 0)
        : this.messages(owner, conversation.id, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).filter(message => message.seq > conversation.readSeq).length
    return {
      ...conversation,
      unreadCount,
      ...(member ? { avatar: this.agentSummary(member).avatar } : {}),
      lastMessageAt: conversation.lastMessageAt
        ?? (conversation.lastSeq > 0 ? this.messages(owner, conversation.id, Number.MAX_SAFE_INTEGER, 1).at(-1)?.createdAt : undefined)
        ?? conversation.createdAt,
    }
  }
  hiddenMessageIds(owner: string, conversationId: string, conversationTaskId?: string): string[] {
    return this.messages(owner, conversationId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true, conversationTaskId).filter(m => m.visible === false).map(m => m.id)
  }
  saveRun(owner: string, run: Run): void {
    this.atomic(() => {
      const c = this.require<Conversation>(owner, 'conversation', run.conversationId)
      run.updatedAt = Date.now()
      this.put(owner, 'run', run.id, run)
      if (run.conversationTaskId) {
        const task = this.requireTask(owner, c.id, run.conversationTaskId),
          activeRuns = this.list<Run>(owner, 'run')
            .filter(root => root.conversationTaskId === task.id && !['complete', 'failed', 'interrupted'].includes(root.status))
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
          active = activeRuns[0]
        task.activeRunId = active?.id
        task.activeRunStatus = active?.status
        this.put(owner, 'conversation-task', task.id, task)
        this.event(owner, 'task.changed', task, c.id)
      }
      this.projectConversationRuns(owner, c)
      this.put(owner, 'conversation', c.id, c)
      this.event(owner, 'run.changed', run, c.id)
      this.event(owner, 'conversation.changed', c, c.id)
    })
  }
  activeTaskCount(owner: string, conversationId: string): number {
    return new Set(
      this.list<Run>(owner, 'run')
        .filter(run => run.conversationId === conversationId && run.conversationTaskId && !['complete', 'failed', 'interrupted'].includes(run.status))
        .map(run => run.conversationTaskId!),
    ).size
  }
  private projectConversationRuns(owner: string, conversation: Conversation): void {
    const roots = this.list<Run>(owner, 'run').filter(run => run.conversationId === conversation.id && !['complete', 'failed', 'interrupted'].includes(run.status))
      .sort((a, b) => this.require<Message>(owner, 'message', a.messageId).seq - this.require<Message>(owner, 'message', b.messageId).seq),
      current = roots[0]
    conversation.activeRunId = current?.id
    conversation.activeAgentId = current?.activeAgentId
    conversation.activeRunStatus = current?.status
    const turns = this.db.prepare("SELECT data FROM workspace_entities WHERE owner=? AND kind='turn' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.status') IN ('running','waiting','uncertain','queued') AND (json_extract(data,'$.status') != 'queued' OR json_extract(data,'$.planned')=1) ORDER BY CASE json_extract(data,'$.status') WHEN 'queued' THEN 0 WHEN 'running' THEN 1 ELSE 2 END").all(owner, conversation.id)
      .map(row => JSON.parse(String(row.data)) as { agentId: string; status: string })
    conversation.activeAgentStates = Object.fromEntries(turns.map(turn => [turn.agentId, turn.status as 'running' | 'waiting' | 'uncertain' | 'queued']))
    const outcomes = this.db.prepare("SELECT data FROM workspace_entities WHERE owner=? AND kind='turn' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.status') IN ('complete','failed') AND json_extract(data,'$.updatedAt')>=? ORDER BY json_extract(data,'$.updatedAt') ASC").all(owner, conversation.id, Date.now() - 2000)
      .map(row => JSON.parse(String(row.data)) as {id:string;agentId:string;status:string;updatedAt:number})
    conversation.avatarSignals = Object.fromEntries(outcomes.filter(turn => Date.now() - turn.updatedAt < 2000).map(turn => [turn.agentId, { id:turn.id, state:turn.status === 'failed' ? 'failure' as const : 'success' as const, at:turn.updatedAt }]))
    conversation.queuedMessageCount = roots.filter(run => run.status === 'queued').length
  }
  ownsUpstream(id: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM workspace_entities WHERE kind='binding' AND (json_extract(data,'$.storedId')=? OR json_extract(data,'$.runtimeId')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.aliases')) WHERE value=?)) LIMIT 1`,
        )
        .get(id, id, id),
    )
  }
  close(): void {
    this.changes.removeAllListeners()
    this.db.close()
  }
}
