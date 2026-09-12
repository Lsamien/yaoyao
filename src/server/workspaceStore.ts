import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { isVisibleMessageFile } from '../shared/messageFiles.js'
import type { StoredWorkspaceFile } from './workspaceAssets.js'
import { notificationPlainText } from './notificationText.js'
import type { WorkspaceLifecycleAction, WorkspaceLifecyclePreview } from '../shared/workspaceLifecycle.js'
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
    execution:z.enum(['profile','computer']).default('profile'),
    computer:z.enum(['auto','cloud','vm','local','browser','off']).optional(),
    browserProfile:z.enum(['persistent','temporary']).optional(),
    canManageTeam: z.boolean().default(false),
    nodeId: z.string().default('local'),
    profile: z.string().min(1).max(256),
  })
  .strict()
export const agentPatch = z
  .object({
    name: name.optional(),
    avatar: avatar.optional(),
    instructions: z.string().max(24_000).optional(),
    execution:z.enum(['profile','computer']).optional(),
    computer:z.enum(['auto','cloud','vm','local','browser','off']).optional(),
    browserProfile:z.enum(['persistent','temporary']).optional(),
    nodeId:z.string().min(1).max(256).optional(),
    profile:z.string().min(1).max(256).optional(),
    canManageTeam: z.boolean().optional(),
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
  prepareAgent?: (owner:string,agent:Agent)=>void
  private observers = new Set<(owner: string, event: WorkspaceEvent) => void>()
  observe(listener: (owner: string, event: WorkspaceEvent) => void): () => void {
    this.observers.add(listener)
    return () => { this.observers.delete(listener) }
  }
  private publish(owner: string, event: WorkspaceEvent): void {
    this.changes.emit(owner, event)
    for (const listener of this.observers) { try { listener(owner, event) } catch { /* Observers cannot undo a committed transaction. */ } }
  }
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
      CREATE INDEX IF NOT EXISTS workspace_message_conversation ON workspace_entities(owner, json_extract(data,'$.conversationId'), json_extract(data,'$.seq')) WHERE kind='message';
      CREATE INDEX IF NOT EXISTS workspace_message_hidden ON workspace_entities(owner, json_extract(data,'$.conversationId'), json_extract(data,'$.conversationTaskId'), json_extract(data,'$.seq')) WHERE kind='message' AND json_extract(data,'$.visible')=0;
      CREATE INDEX IF NOT EXISTS workspace_task_unread ON workspace_entities(owner, json_extract(data,'$.conversationId'), json_extract(data,'$.unread')) WHERE kind='conversation-task';
      CREATE INDEX IF NOT EXISTS workspace_run_task ON workspace_entities(owner, json_extract(data,'$.conversationTaskId'), json_extract(data,'$.status')) WHERE kind='run';
      CREATE INDEX IF NOT EXISTS workspace_turn_task ON workspace_entities(owner, json_extract(data,'$.conversationTaskId'), json_extract(data,'$.status')) WHERE kind='turn';`)
    this.db.exec('CREATE TABLE IF NOT EXISTS server_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), server_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL)')
    this.db.prepare('INSERT OR IGNORE INTO server_identity VALUES(1, ?, ?, 0)').run(randomUUID(), '')
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
    this.atomic(() => {
      const migration = 'conversation-task-history-v1'
      if (this.db.prepare('SELECT id FROM workspace_migrations WHERE id=?').get(migration)) return
      for (const owner of this.owners()) {
        for (const conversation of this.list<Conversation>(owner, 'conversation')) {
          if (conversation.kind === 'group') this.backfillConversationTask(owner, conversation)
        }
      }
      this.db.prepare('INSERT INTO workspace_migrations VALUES(?)').run(migration)
    })
    this.atomic(() => {
      const migration = 'workspace-unread-flag-v1'
      if (this.db.prepare('SELECT id FROM workspace_migrations WHERE id=?').get(migration)) return
      for (const owner of this.owners()) {
        for (const task of this.list<Task>(owner, 'conversation-task')) {
          task.unread ??= task.unreadCount > 0
          task.unreadVersion ??= task.unread ? 1 : 0
          task.unreadCount = task.unread ? 1 : 0
          this.put(owner, 'conversation-task', task.id, task)
        }
        for (const conversation of this.list<Conversation>(owner, 'conversation')) {
          conversation.unread ??= conversation.kind === 'group'
            ? this.hasUnreadTask(owner, conversation.id)
            : !!this.db.prepare("SELECT 1 FROM workspace_entities WHERE owner=? AND kind='message' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.seq')>? AND coalesce(json_extract(data,'$.visible'),1)!=0 LIMIT 1").get(owner, conversation.id, conversation.readSeq)
          conversation.unreadVersion ??= conversation.unread ? 1 : 0
          conversation.unreadCount = conversation.unread ? 1 : 0
          this.put(owner, 'conversation', conversation.id, conversation)
        }
      }
      this.db.prepare('INSERT INTO workspace_migrations VALUES(?)').run(migration)
    })
  }
  private hasUnreadTask(owner: string, conversationId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM workspace_entities WHERE owner=? AND kind='conversation-task' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.unread')=1 LIMIT 1").get(owner, conversationId)
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
      for (const entry of events) this.publish(entry.owner, entry.event)
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
    const event = { seq, type, conversationId, data: this.eventDataForDisplay(owner, type, data) }
    if (this.transactionEvents) this.transactionEvents.push({ owner, event })
    else this.publish(owner, event)
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
        data: this.eventDataForDisplay(owner, String(r.type), JSON.parse(String(r.data))),
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
  taskMemberIds(owner:string,conversation:Conversation,taskId?:string):string[]{
    const base=conversation.memberIds.filter(id=>!this.get<Agent>(owner,'agent',id)?.temporaryGoalId)
    if(!taskId)return base
    const goal=this.get<import('../shared/agentTasks.js').AgentGoal>(owner,'goal',taskId)
    if(!goal||goal.conversationId!==conversation.id||['complete','blocked','cancelled','cancelling'].includes(goal.status))return base
    return [...new Set([...base,...this.list<Agent>(owner,'agent').filter(agent=>!agent.archived&&agent.temporaryGoalId===taskId&&agent.helperActivation===(goal.activation??1)).map(agent=>agent.id)])]
  }
  requireAgentTask(owner:string,agent:Agent,conversationId:string,taskId?:string):void {
    if(!agent.temporaryGoalId)return
    const conversation=this.require<Conversation>(owner,'conversation',conversationId)
    if(agent.temporaryGoalId!==taskId||!this.taskMemberIds(owner,conversation,taskId).includes(agent.id))throw new HttpError(403,'临时助手只能执行所属任务','helper_task_bound')
  }
  createAgent(owner: string, input: unknown, origin?: { createdByAgentId: string; createdFromRunId: string;temporaryGoalId?:string;helperActivation?:number;helperRunnerId?:string }): Agent {
    const body = parse(agentInput, input)
    if (origin) this.require<Agent>(owner, 'agent', origin.createdByAgentId)
    return this.atomic(() => {
      if (
        this.list<Agent>(owner, 'agent').some(
          (a) => a.name.toLocaleLowerCase() === body.name.toLocaleLowerCase(),
        )
      )
        throw new HttpError(409, '机器人名称已存在', 'duplicate_agent_name')
      const now = Date.now(),
        id = randomUUID()
      const agent: Agent = {
        ...body,
        ...origin,
        avatar: body.avatar ? normalizeAvatar(body.avatar) : encodeAgentAvatar(randomAgentIdentity(id, body.name)),
        id,
        archived: false,
        revision: 1,
        teamAuthorizationVersion: body.canManageTeam ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      }
      this.prepareAgent?.(owner,agent)
      this.put(owner, 'agent', id, agent)
      if(origin?.temporaryGoalId){this.event(owner,'agent.changed',agent);return agent}
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
        unread: false,
        unreadVersion: 0,
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
      const sourceChanged=(patch.nodeId!==undefined&&patch.nodeId!==agent.nodeId)||(patch.profile!==undefined&&patch.profile!==agent.profile)
      const destinationChanged=(patch.computer!==undefined&&patch.computer!==agent.computer)||(patch.browserProfile!==undefined&&patch.browserProfile!==(agent.browserProfile??'persistent'))
      if(sourceChanged||destinationChanged){
        if(this.list<{agentId:string;status:string}>(owner,'turn').some(work=>work.agentId===id&&['queued','running','waiting','uncertain','cancelling'].includes(work.status)))throw new HttpError(409,'请先停止当前任务，再修改机器人来源或电脑','agent_execution_busy')
        if(this.list<{owner:string;agentId:string;environmentId?:string;expiresAt:number}>('_system','computer-control').some(grant=>grant.owner===owner&&grant.expiresAt>Date.now()&&(grant.agentId===id||grant.environmentId===(agent.computerEnvironmentId??id))))throw new HttpError(409,'请先交还电脑控制权','agent_execution_busy')
        if(sourceChanged&&agent.computerEnvironmentId){const shared=this.require<{nodeId:string;profile:string;managedLocalVm?:boolean;managedCompose?:boolean}>(owner,'shared-computer',agent.computerEnvironmentId);if((patch.nodeId??agent.nodeId)!==shared.nodeId||(!shared.managedLocalVm&&!shared.managedCompose&&shared.profile!=='*'&&(patch.profile??agent.profile)!==shared.profile))throw new HttpError(409,'请先解除电脑共享，再切换到其他来源','shared_computer_active')}
      }
      if(agent.temporaryGoalId&&(Object.keys(patch).some(key=>key!=='archived')||patch.archived===false))throw new HttpError(409,'临时助手由所属任务管理，不能修改权限或恢复为持久成员','helper_task_bound')
      if(agent.computerEnvironmentId&&patch.execution==='profile')throw new HttpError(409,'请先解除电脑共享，再切换执行环境','shared_computer_active')
      if(patch.execution&&patch.execution!==(agent.execution??'profile')&&this.list<{agentId:string;status:string}>(owner,'turn').some(work=>work.agentId===id&&['running','waiting','uncertain'].includes(work.status)))throw new HttpError(409,'请先停止当前任务，再切换执行环境','agent_execution_busy')
      if (agent.remoteAgentId && Object.keys(patch).some(key => key !== 'archived'))
        throw new HttpError(409, '引用机器人的配置由远端管理', 'remote_agent_read_only')
      if (
        patch.name &&
        this.list<Agent>(owner, 'agent').some(
          (a) => a.id !== id && a.name.toLocaleLowerCase() === patch.name!.toLocaleLowerCase(),
        )
      )
        throw new HttpError(409, '机器人名称已存在', 'duplicate_agent_name')
      const next = { ...agent, ...patch, revision: agent.revision + 1, updatedAt: Date.now() }
      if (patch.canManageTeam !== undefined && patch.canManageTeam !== (agent.canManageTeam === true))
        next.teamAuthorizationVersion = (agent.teamAuthorizationVersion ?? 0) + 1
      this.put(owner, 'agent', id, next)
      if(sourceChanged)for(const binding of this.list<{id:string}>(owner,'binding').filter(binding=>binding.id.endsWith(`:${id}`))){this.put(owner,'binding-reset',binding.id,{id:binding.id});this.remove(owner,'binding',binding.id)}
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
  conversationLifecycle(owner: string, id: string): WorkspaceLifecyclePreview {
    const conversation = this.require<Conversation>(owner, 'conversation', id)
    const agent = conversation.kind === 'direct' ? this.require<Agent>(owner, 'agent', conversation.memberIds[0]!) : undefined
    const groups = agent ? this.list<Conversation>(owner, 'conversation')
      .filter(group => group.kind === 'group' && group.memberIds.includes(agent.id))
      .sort((a, b) => a.id.localeCompare(b.id)) : []
    return {
      name: conversation.name,
      kind: conversation.kind,
      groups: groups.map(group => ({ id: group.id, name: group.name, administrator: group.administratorId === agent?.id })),
      confirmationToken: createHash('sha256').update(JSON.stringify([
        conversation.id, conversation.name, conversation.archived, agent?.revision,
        groups.map(group => [group.id, group.name, group.administratorId, group.memberIds]),
      ])).digest('hex'),
    }
  }
  private requireConversationIdle(owner: string, id: string): void {
    if (['run', 'turn'].some(kind => this.list<{ conversationId: string; status: string }>(owner, kind).some(run => run.conversationId === id && !['complete', 'failed', 'interrupted', 'skipped'].includes(run.status))))
      throw new HttpError(409, '聊天仍有任务未结束，请停止任务后重试', 'conversation_running')
    if (this.list<{ conversationId: string; origin?: { conversationId: string }; status: string }>(owner, 'goal').some(goal =>
      (goal.conversationId === id || goal.origin?.conversationId === id) && !['complete', 'blocked', 'cancelled'].includes(goal.status)))
      throw new HttpError(409, '聊天仍有关联任务未结束，请停止任务后重试', 'conversation_running')
  }
  changeConversationLifecycle(owner: string, id: string, action: WorkspaceLifecycleAction, confirmationToken?: string): void {
    this.atomic(() => {
      const conversation = this.require<Conversation>(owner, 'conversation', id)
      const agent = conversation.kind === 'direct' ? this.require<Agent>(owner, 'agent', conversation.memberIds[0]!) : undefined
      if (action === 'restore') {
        if (agent) this.updateAgent(owner, agent.id, { archived: false })
        else this.updateConversation(owner, id, { archived: false })
        return
      }
      const preview = this.conversationLifecycle(owner, id)
      const managed = preview.groups.filter(group => group.administrator)
      if (managed.length) throw new HttpError(409, `此 Bot 是群聊${managed.map(group => `「${group.name}」`).join('、')}的管理者，请先转交管理权，再归档或删除`, 'agent_group_administrator')
      if (confirmationToken !== undefined && confirmationToken !== preview.confirmationToken)
        throw new HttpError(409, '聊天或群聊成员已变化，请重新确认后操作', 'lifecycle_confirmation_stale')
      if (preview.groups.length && !confirmationToken)
        throw new HttpError(409, '此 Bot 仍是群聊成员，请确认退出群聊后再归档或删除', 'agent_in_group')
      if (agent?.temporaryGoalId) throw new HttpError(409, '临时助手由所属任务管理', 'helper_task_bound')
      if (agent?.computerEnvironmentId) throw new HttpError(409, '请先解除电脑共享，再归档或删除 Bot', 'shared_computer_active')
      if (agent && this.list<{ agentId: string; status: string }>(owner, 'turn').some(turn => turn.agentId === agent.id && !['complete', 'failed', 'interrupted', 'skipped'].includes(turn.status)))
        throw new HttpError(409, 'Bot 仍有任务未结束，请停止任务后重试', 'agent_running')
      for (const conversationId of [id, ...preview.groups.map(group => group.id)]) this.requireConversationIdle(owner, conversationId)
      for (const group of preview.groups) {
        const current = this.require<Conversation>(owner, 'conversation', group.id)
        this.updateConversation(owner, group.id, { memberIds: current.memberIds.filter(memberId => memberId !== agent!.id) })
      }
      if (agent) {
        this.updateAgent(owner, agent.id, { archived: true })
        if (action === 'delete') this.deleteAgent(owner, agent.id)
      } else {
        this.updateConversation(owner, id, { archived: true })
        if (action === 'delete') this.deleteConversation(owner, id)
      }
    })
  }
  deleteAgent(owner: string, id: string): void {
    this.atomic(() => {
      const agent = this.require<Agent>(owner, 'agent', id)
      if (!agent.archived) throw new HttpError(409, '请先归档 Bot，再删除', 'agent_not_archived')
      if (agent.temporaryGoalId) throw new HttpError(409, '临时助手由所属任务管理', 'helper_task_bound')
      if (agent.computerEnvironmentId) throw new HttpError(409, '请先解除电脑共享，再删除 Bot', 'shared_computer_active')
      const conversations = this.list<Conversation>(owner, 'conversation')
      if (conversations.some(c => c.kind === 'group' && c.memberIds.includes(id)))
        throw new HttpError(409, '此 Bot 仍是群聊成员，请先从群聊移除或删除相关群聊', 'agent_in_group')
      if (this.list<{ agentId: string; status: string }>(owner, 'turn').some(work => work.agentId === id && !['complete', 'failed', 'interrupted', 'skipped'].includes(work.status)))
        throw new HttpError(409, 'Bot 仍有任务未结束，请停止任务后重试', 'agent_running')
      for (const conversation of conversations.filter(c => c.kind === 'direct' && c.memberIds[0] === id))
        this.deleteConversation(owner, conversation.id, true)
      for(const kind of ['routine','routine-run'])for(const item of this.list<{id:string;agentId:string}>(owner,kind).filter(item=>item.agentId===id))this.remove(owner,kind,item.id)
      this.remove(owner, 'agent', id)
      this.event(owner, 'agent.deleted', { id })
    })
  }
  deleteConversation(owner: string, id: string, deletingAgent = false): void {
    this.atomic(() => {
      const conversation = this.require<Conversation>(owner, 'conversation', id)
      if (conversation.kind === 'direct' && !deletingAgent)
        throw new HttpError(400, '请删除对应的 Bot', 'delete_agent_instead')
      if (!conversation.archived) throw new HttpError(409, '请先归档聊天，再删除', 'conversation_not_archived')
      this.requireConversationIdle(owner, id)
      const taskIds = new Set(this.list<Task>(owner, 'conversation-task').filter(task => task.conversationId === id).map(task => task.id))
      for (const taskId of taskIds) {
        this.remove(owner, 'context', taskId)
        this.db.prepare("DELETE FROM workspace_entities WHERE owner=? AND kind='task-delivery' AND json_extract(data,'$.goalId')=?").run(owner, taskId)
      }
      // Keep files in the file library, matching task deletion; detach their chat references.
      for (const file of this.list<{ id: string; conversationId?: string; conversationTaskId?: string }>(owner, 'file')) {
        if (file.conversationId === id || (file.conversationTaskId && taskIds.has(file.conversationTaskId)))
          this.put(owner, 'file', file.id, { ...file, conversationId: undefined, conversationTaskId: undefined, messageId: undefined })
      }
      const bindingPrefix = `${id}:`
      this.db.prepare("DELETE FROM workspace_entities WHERE owner=? AND ((kind='binding' AND substr(id,1,?)=?) OR (kind='interaction-binding' AND substr(json_extract(data,'$.key'),1,?)=?))").run(owner, bindingPrefix.length, bindingPrefix, bindingPrefix.length, bindingPrefix)
      this.db.prepare("DELETE FROM workspace_entities WHERE owner=? AND kind IN ('message','run','turn','interaction','interaction-binding','binding','conversation-task','goal','assignment') AND json_extract(data,'$.conversationId')=?").run(owner, id)
      this.db.prepare("DELETE FROM workspace_commands WHERE owner=? AND json_extract(result,'$.conversationId')=?").run(owner, id)
      this.remove(owner, 'context', id)
      if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_inspector'").get())this.db.prepare('DELETE FROM workspace_inspector WHERE owner=? AND conversation_id=?').run(owner,id)
      this.remove(owner, 'conversation', id)
      this.event(owner, 'conversation.deleted', { id }, id)
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
    for (const id of ids){
      const agent=this.require<Agent>(owner,'agent',id)
      if(agent.temporaryGoalId)throw new HttpError(409,'临时助手不能加入持久团队','helper_task_bound')
      if(agent.archived)throw new HttpError(409,'已归档机器人不能加入新群','agent_archived')
    }
    const now = Date.now()
    const c: Conversation = {
      ...body,
      id: randomUUID(),
      kind: 'group',
      archived: false,
      pinned: false,
      readSeq: 0,
      unread: false,
      unreadVersion: 0,
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
  private backfillConversationTask(owner: string, conversation: Conversation): void {
    const legacyMessages = this.list<Message>(owner, 'message')
      .filter(message => message.conversationId === conversation.id && !message.conversationTaskId)
      .sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    if (!legacyMessages.length) return

    const existingTasks = this.tasks(owner, conversation.id)
    const assignedTaskIds = new Set(
      this.list<Message>(owner, 'message')
        .filter(message => message.conversationId === conversation.id && message.conversationTaskId)
        .map(message => message.conversationTaskId!),
    )
    const reusable = existingTasks.length === 1
      && existingTasks[0]!.titleSource === 'automatic'
      && existingTasks[0]!.title === '新任务'
      && existingTasks[0]!.messageCount === 0
      && !assignedTaskIds.has(existingTasks[0]!.id)
      ? existingTasks[0]
      : undefined
    const visibleMessages = legacyMessages.filter(message => message.visible !== false)
    const meaningfulMessages = visibleMessages.filter(
      message => message.content.trim() || message.attachments.length,
    )
    const firstMessage = legacyMessages[0]!,
      lastMessage = meaningfulMessages.at(-1) ?? visibleMessages.at(-1) ?? legacyMessages.at(-1)!,
      firstUserMessage = visibleMessages.find(
        message => message.role === 'user' && (message.content.trim() || message.attachments.length),
      ),
      title = notificationPlainText(firstUserMessage?.content ?? '', {
        maximum: 48,
        fallback: firstUserMessage?.attachments[0]?.name ?? '',
      }).trim()
        || notificationPlainText(conversation.preview, { maximum: 48, fallback: '' }).trim()
        || '历史任务',
      lastSeq = legacyMessages.reduce((value, message) => Math.max(value, message.seq), 0),
      readSeq = Math.min(conversation.readSeq, lastSeq),
      task: Task = {
        ...(reusable ?? {
          id: randomUUID(),
          conversationId: conversation.id,
          title: '历史任务',
          titleSource: 'automatic' as const,
          messageCount: 0,
          readSeq: 0,
          lastSeq: 0,
          unreadCount: 0,
          createdAt: firstMessage.createdAt,
          updatedAt: lastMessage.createdAt,
        }),
        title,
        titleSource: 'automatic',
        messageCount: visibleMessages.length,
        readSeq,
        lastSeq,
        unreadCount: visibleMessages.some(message => message.seq > readSeq) ? 1 : 0,
        lastMessageAt: lastMessage.createdAt,
        createdAt: firstMessage.createdAt,
        updatedAt: lastMessage.createdAt,
      }

    for (const message of legacyMessages) {
      this.put(owner, 'message', message.id, {
        ...message,
        conversationTaskId: task.id,
      })
    }
    const migratedInteractions = new Map<string, string>()
    for (const kind of ['run', 'turn', 'interaction'] as const) {
      for (const entity of this.list<Record<string, unknown> & {
        id: string
        conversationId?: string
        conversationTaskId?: string
        agentId?: string
      }>(owner, kind)) {
        if (entity.conversationId !== conversation.id || entity.conversationTaskId) continue
        this.put(owner, kind, entity.id, { ...entity, conversationTaskId: task.id })
        if (kind === 'interaction' && entity.agentId) {
          migratedInteractions.set(entity.id, entity.agentId)
        }
      }
    }
    for (const [interactionId, agentId] of migratedInteractions) {
      const binding = this.get<Record<string, unknown> & {
        conversationTaskId?: string
      }>(owner, 'interaction-binding', interactionId)
      if (!binding || binding.conversationTaskId) continue
      this.put(owner, 'interaction-binding', interactionId, {
        ...binding,
        key: `${conversation.id}:${task.id}:${agentId}`,
        conversationTaskId: task.id,
      })
    }
    for (const agentId of conversation.memberIds) {
      const legacyKey = `${conversation.id}:${agentId}`,
        taskKey = `${conversation.id}:${task.id}:${agentId}`,
        binding = this.get<Record<string, unknown> & {
          conversationTaskId?: string
        }>(owner, 'binding', legacyKey)
      if (!binding || binding.conversationTaskId) continue
      this.put(owner, 'binding', taskKey, { ...binding, conversationTaskId: task.id })
      this.remove(owner, 'binding', legacyKey)
    }
    const context = this.get<Record<string, unknown> & {
      conversationTaskId?: string
    }>(owner, 'context', conversation.id)
    if (context && !context.conversationTaskId) {
      this.put(owner, 'context', task.id, { ...context, conversationTaskId: task.id })
      this.remove(owner, 'context', conversation.id)
    }
    this.db.prepare(
      `UPDATE workspace_commands
       SET result=json_set(result,'$.conversationTaskId',?)
       WHERE owner=? AND json_extract(result,'$.conversationId')=?
         AND json_extract(result,'$.conversationTaskId') IS NULL`,
    ).run(task.id, owner, conversation.id)

    const activeRuns = this.list<Run>(owner, 'run')
      .filter(run => run.conversationTaskId === task.id && !['complete', 'failed', 'interrupted'].includes(run.status))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    task.activeRunId = activeRuns[0]?.id
    task.activeRunStatus = activeRuns[0]?.status
    this.put(owner, 'conversation-task', task.id, task)
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
        unread: false,
        unreadVersion: 0,
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
  markTaskRead(owner: string, conversationId: string, taskId: string, seq: number, unreadVersion?: number): Task {
    return this.atomic(() => {
      const task = this.requireTask(owner, conversationId, taskId)
      task.readSeq = Math.max(task.readSeq, Math.min(seq, task.lastSeq))
      if (unreadVersion === undefined ? seq >= task.lastSeq : unreadVersion === (task.unreadVersion ?? 0)) task.unread = false
      task.unreadCount = task.unread ? 1 : 0
      this.put(owner, 'conversation-task', task.id, task)
      const conversation = this.require<Conversation>(owner, 'conversation', conversationId)
      conversation.unread = this.hasUnreadTask(owner, conversationId)
      conversation.unreadCount = conversation.unread ? 1 : 0
      this.put(owner, 'conversation', conversationId, conversation)
      this.event(owner, 'task.changed', task, conversationId)
      this.event(owner, 'conversation.changed', conversation, conversationId)
      return task
    })
  }
  markConversationRead(owner: string, conversationId: string, seq: number, unreadVersion?: number): Conversation {
    return this.atomic(() => {
      const conversation = this.require<Conversation>(owner, 'conversation', conversationId)
      conversation.readSeq = Math.max(conversation.readSeq, Math.min(seq, conversation.lastSeq))
      if (conversation.kind === 'direct' && (unreadVersion === undefined ? seq >= conversation.lastSeq : unreadVersion === (conversation.unreadVersion ?? 0))) conversation.unread = false
      conversation.unreadCount = conversation.unread ? 1 : 0
      this.put(owner, 'conversation', conversationId, conversation)
      this.event(owner, 'conversation.changed', conversation, conversationId)
      return this.conversationSummary(owner, conversation)
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
      conversation.unread = this.hasUnreadTask(owner, conversationId)
      conversation.unreadCount = conversation.unread ? 1 : 0
      this.projectConversationRuns(owner, conversation)
      this.put(owner, 'conversation', conversationId, conversation)
      this.event(owner, 'conversation.changed', conversation, conversationId)
    })
  }
  updateConversation(owner: string, id: string, input: unknown): Conversation {
    const patch = parse(conversationPatch, input),
      c = this.require<Conversation>(owner, 'conversation', id)
    if (c.kind === 'direct' && Object.keys(patch).some((k) => k !== 'pinned'))
      throw new HttpError(400, '请编辑机器人资料', 'edit_agent_instead')
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
      if(agent.temporaryGoalId)throw new HttpError(409,'临时助手不能加入其他群聊','helper_task_bound')
      if (!c.memberIds.includes(memberId) && agent.archived)
        throw new HttpError(409, '已归档机器人不能加入群聊', 'agent_archived')
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
      .map((r) => this.messageForDisplay(owner, JSON.parse(String(r.data)) as Message))
      .reverse()
  }
  nativeMessageForFile?: (owner: string, file: StoredWorkspaceFile) => Message | undefined
  visibleFiles(owner: string): StoredWorkspaceFile[] {
    const messages = new Map(this.list<Message>(owner, 'message').map(message => [message.id, message]))
    return this.list<StoredWorkspaceFile>(owner, 'file').filter(file =>
      isVisibleMessageFile(file, messages.get(file.messageId ?? '') ?? this.nativeMessageForFile?.(owner, file)))
  }
  messageForDisplay(owner: string, message: Message): Message {
    const attachments = message.role === 'user' || message.role === 'assistant'
      ? message.attachments.filter(file => isVisibleMessageFile(
        this.get<StoredWorkspaceFile>(owner, 'file', file.id) ?? file, message))
      : []
    return { ...message, attachments }
  }
  private eventDataForDisplay(owner: string, type: string, data: unknown): unknown {
    if (type === 'message.changed') return this.messageForDisplay(owner, data as Message)
    return data
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
      const needsAttention = (value: Message | undefined) => !!value && value.role !== 'user' && value.visible !== false
        && ['complete', 'failed', 'interrupted'].includes(value.status)
        && !!(value.content.trim() || value.error || this.messageForDisplay(owner, value).attachments.length)
      if (needsAttention(message) && !needsAttention(previous)) {
        c.unread = true
        c.unreadVersion = (c.unreadVersion ?? 0) + 1
        if (task) { task.unread = true; task.unreadVersion = (task.unreadVersion ?? 0) + 1 }
      }
      c.unreadCount = c.unread ? 1 : 0
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
        task.unreadCount = task.unread ? 1 : 0
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
    const member = conversation.kind === 'direct' ? this.get<Agent>(owner, 'agent', conversation.memberIds[0] ?? '') : undefined
    return {
      ...conversation,
      unread: conversation.unread ?? false,
      unreadVersion: conversation.unreadVersion ?? 0,
      unreadCount: conversation.unread ? 1 : 0,
      ...(member ? { avatar: this.agentSummary(member).avatar } : {}),
      lastMessageAt: conversation.lastMessageAt
        ?? (conversation.lastSeq > 0 ? this.messages(owner, conversation.id, Number.MAX_SAFE_INTEGER, 1).at(-1)?.createdAt : undefined)
        ?? conversation.createdAt,
    }
  }
  hiddenMessageIds(owner: string, conversationId: string, conversationTaskId?: string): string[] {
    this.require(owner, 'conversation', conversationId)
    if (conversationTaskId) this.requireTask(owner, conversationId, conversationTaskId)
    const taskClause = conversationTaskId ? "AND json_extract(data,'$.conversationTaskId')=?" : ''
    return this.db.prepare(`SELECT id FROM workspace_entities WHERE owner=? AND kind='message' AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.visible')=0 ${taskClause} ORDER BY json_extract(data,'$.seq') ASC`)
      .all(...(conversationTaskId ? [owner, conversationId, conversationTaskId] : [owner, conversationId])).map(row => String(row.id))
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
    this.changes.emit('workspace.close')
    this.changes.removeAllListeners()
    this.db.close()
  }
}
