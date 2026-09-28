import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { parse, type WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceNodes } from './workspaceGateway.js'
import type { WorkspaceRuntime } from './workspaceRuntime.js'
import type { Work } from './workspaceScheduler.js'
import type { WorkspaceAgent as Agent, WorkspaceConversation as Conversation, WorkspaceRun as Run } from '../shared/workspace.js'
import type { WorkspaceRoutine } from '../shared/workspacePanels.js'
import { routineScheduleSchema, routineWriteSchema, type WorkspaceRoutines } from './workspaceRoutines.js'

const uuid = z.string().uuid()
const empty = z.object({}).strict()
const createInput = routineWriteSchema.omit({ deviceHost: true }).extend({ requestId: uuid }).strict()
const updateInput = z.object({
  requestId: uuid,
  routineId: uuid,
  name: z.string().trim().min(1).max(100).optional(),
  prompt: z.string().trim().min(1).max(24000).optional(),
  enabled: z.boolean().optional(),
  schedule: routineScheduleSchema.optional(),
}).strict()
const deleteInput = z.object({ requestId: uuid, routineId: uuid }).strict()

const definitions = [
  ['workspace_list_routines', '列出当前 Bot 自己的定时任务。到点后在该 Bot 的单聊中执行，不会在群聊里自动发言。', empty],
  ['workspace_create_routine', '为当前 Bot 新建定时任务。用户要求定时、提醒或周期执行时使用。name 是任务名称，prompt 是到点后要执行的内容。schedule.kind 为 once、interval、daily 或 weekly。once 需要未来的 at（毫秒时间戳）；interval 需要 everyMinutes；daily 需要 time（HH:mm）和 timezone；weekly 还需要 weekdays（0 为周日，6 为周六）。requestId 使用新的 UUID，重试同一操作必须复用。不要使用 Hermes cron。', createInput],
  ['workspace_update_routine', '修改当前 Bot 已有的定时任务，可改名称、内容、是否启用或日程。暂停时设 enabled 为 false。requestId 对同一次修改保持不变。', updateInput],
  ['workspace_delete_routine', '删除当前 Bot 的一个定时任务。requestId 对同一次删除保持不变。', deleteInput],
] as const

export const ROUTINE_TOOL_RULES = '用户要求定时、提醒或周期执行时，使用 workspace_list_routines、workspace_create_routine、workspace_update_routine、workspace_delete_routine 管理当前 Bot 自己的定时任务。不要调用 Hermes 的 cronjob、cron 或其他 cron 工具。任务只属于当前 Bot，到点后在它的单聊中发送任务内容，不会在群聊里自动发言。新建和修改都要给出完整日程：once 用未来的 at，interval 用 everyMinutes，daily 用 timezone 和 time，weekly 再加 weekdays。requestId 使用新的 UUID，重试同一操作必须复用，不要因此创建重复任务。临时助手、已归档和远端机器人不能建立定时任务。'

/** The speaking Bot is taken from the server turn. The model cannot name another agent. */
export class WorkspaceRoutineTools {
  constructor(readonly routines: WorkspaceRoutines, readonly store: WorkspaceStore, readonly nodes: WorkspaceNodes, readonly runtime: WorkspaceRuntime) {}

  handles(toolId: string) {
    return definitions.some(([id]) => id === toolId)
  }

  private turn(owner: string, workId: string) {
    if (!this.runtime.userActive(owner)) throw new HttpError(403, '账号授权已失效', 'routine_tools_forbidden')
    const work = this.store.require<Work>(owner, 'turn', workId)
    const agent = this.store.require<Agent>(owner, 'agent', work.agentId)
    const conversation = this.store.require<Conversation>(owner, 'conversation', work.conversationId)
    const root = this.store.require<Run>(owner, 'run', work.runId)
    if (conversation.archived || !conversation.memberIds.includes(agent.id) || work.cancelRequested || root.stopRequested || !['running', 'waiting'].includes(work.status))
      throw new HttpError(403, '当前机器人的本轮授权已失效', 'routine_tools_forbidden')
    if (root.authorizationVersion !== undefined && root.authorizationVersion !== this.runtime.authorizationVersion(owner))
      throw new HttpError(403, '当前机器人的本轮授权已失效', 'routine_tools_forbidden')
    this.routines.requireSchedulable(owner, agent.id)
    return { agent, work }
  }

  catalog(owner: string, workId: string) {
    this.turn(owner, workId)
    return definitions.map(([id, description, schema]) => ({ id, name: id, description, inputSchema: z.toJSONSchema(schema) }))
  }

  private own(owner: string, agentId: string, routineId: string) {
    const routine = this.store.require<WorkspaceRoutine>(owner, 'routine', routineId)
    if (routine.agentId !== agentId) throw new HttpError(404, '定时任务不存在', 'not_found')
    return routine
  }

  private view(routine: WorkspaceRoutine) {
    return { id: routine.id, name: routine.name, prompt: routine.prompt, enabled: routine.enabled, schedule: routine.schedule, nextAt: routine.nextAt, lastAt: routine.lastAt }
  }

  call(owner: string, workId: string, toolId: string, input: unknown) {
    const { agent } = this.turn(owner, workId)
    if (toolId === 'workspace_list_routines') {
      parse(empty, input)
      return { delivery: '到点后在该 Bot 的单聊中执行', routines: this.store.list<WorkspaceRoutine>(owner, 'routine').filter(routine => routine.agentId === agent.id).map(routine => this.view(routine)) }
    }
    if (toolId === 'workspace_create_routine') {
      const { requestId, ...body } = parse(createInput, input)
      return this.store.command(owner, requestId, { agentId: agent.id, toolId, body }, () => {
        this.turn(owner, workId)
        return { routine: this.view(this.routines.save(owner, agent.id, body, randomUUID())) }
      })
    }
    if (toolId === 'workspace_update_routine') {
      const { requestId, routineId, ...patch } = parse(updateInput, input)
      if (patch.name === undefined && patch.prompt === undefined && patch.enabled === undefined && patch.schedule === undefined)
        throw new HttpError(400, '请提供要修改的内容', 'routine_patch_empty')
      this.own(owner, agent.id, routineId)
      return this.store.command(owner, requestId, { agentId: agent.id, toolId, routineId, patch }, () => {
        this.turn(owner, workId)
        const latest = this.own(owner, agent.id, routineId)
        return { routine: this.view(this.routines.save(owner, agent.id, {
          name: patch.name ?? latest.name,
          prompt: patch.prompt ?? latest.prompt,
          enabled: patch.enabled ?? latest.enabled,
          schedule: patch.schedule ?? latest.schedule,
          deviceHost: latest.deviceHost,
        }, latest.id)) }
      })
    }
    if (toolId === 'workspace_delete_routine') {
      const { requestId, routineId } = parse(deleteInput, input)
      this.own(owner, agent.id, routineId)
      return this.store.command(owner, requestId, { agentId: agent.id, toolId, routineId }, () => {
        this.turn(owner, workId)
        const latest = this.own(owner, agent.id, routineId)
        this.store.remove(owner, 'routine', latest.id)
        return { ok: true, id: latest.id }
      })
    }
    throw new HttpError(404, '本轮未授权此工具', 'routine_tool_not_found')
  }
}
