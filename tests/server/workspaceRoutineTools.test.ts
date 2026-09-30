// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'
import { UploadStore } from '../../src/server/uploads'
import { HttpError } from '../../src/server/errors'
import { WorkspaceRoutines } from '../../src/server/workspaceRoutines'
import { WorkspaceRoutineTools } from '../../src/server/workspaceRoutineTools'
import type { Work } from '../../src/server/workspaceScheduler'
import type { WorkspaceAgent } from '../../src/shared/workspace'
import { buildWorkspacePrompt, type WorkspacePromptInput } from '../../src/server/workspacePrompt'
import { ROUTINE_TOOL_RULES } from '../../src/server/workspaceRoutineTools'

let home: string, store: WorkspaceStore, runtime: WorkspaceRuntime, uploads: UploadStore, tools: WorkspaceRoutineTools, work: Work
const owner = 'account-one'
const schedule = { kind: 'daily' as const, timezone: 'Asia/Shanghai', time: '09:00' }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-routine-tools-'))
  store = new WorkspaceStore(home)
  uploads = new UploadStore(home)
  const nodes = {
    requireSource: () => {},
    target: () => { throw new Error('未连接') },
  } as unknown as WorkspaceNodes
  runtime = new WorkspaceRuntime(store, nodes, uploads, () => true)
  const routines = new WorkspaceRoutines(store, { isUserActive: () => true } as never, nodes, runtime)
  tools = new WorkspaceRoutineTools(routines, store, nodes, runtime)
  runtime.routineTools = tools
  const agent = store.createAgent(owner, { name: '日报', profile: 'default' })
  const direct = store.list<{ id: string }>(owner, 'conversation')[0]!
  const runId = randomUUID()
  store.put(owner, 'run', runId, { id: runId, conversationId: direct.id, messageId: randomUUID(), status: 'running', mentionIds: [], stopRequested: false })
  work = { id: randomUUID(), runId, conversationId: direct.id, agentId: agent.id, messageId: randomUUID(), triggerSeq: 1, depth: 0, batchId: runId, replyMode: 'mentioned', requiredReply: true, status: 'running', createdAt: Date.now() }
  store.put(owner, 'turn', work.id, work)
})
afterEach(() => {
  runtime.close(); uploads.close(); store.close()
  rmSync(home, { recursive: true, force: true })
})

it('creates, lists, updates and deletes only the speaking Bot routines, and retries reuse the same task', () => {
  expect(tools.catalog(owner, work.id).map(tool => tool.id)).toEqual([
    'workspace_list_routines', 'workspace_create_routine', 'workspace_update_routine', 'workspace_delete_routine',
  ])
  const requestId = randomUUID()
  const created = tools.call(owner, work.id, 'workspace_create_routine', { requestId, name: '晨间核对', prompt: '汇总昨日进展', enabled: true, schedule }) as { routine: { id: string } }
  const again = tools.call(owner, work.id, 'workspace_create_routine', { requestId, name: '晨间核对', prompt: '汇总昨日进展', enabled: true, schedule }) as { routine: { id: string } }
  expect(again.routine.id).toBe(created.routine.id)
  expect(store.list(owner, 'routine')).toHaveLength(1)
  const other = store.createAgent(owner, { name: '另一个', profile: 'default' })
  const foreign = new WorkspaceRoutines(store, { isUserActive: () => true } as never, { requireSource: () => {} } as never, runtime)
    .save(owner, other.id, { name: '别人的', prompt: '不要看见', enabled: false, schedule })
  const listed = tools.call(owner, work.id, 'workspace_list_routines', {}) as { routines: Array<{ id: string }> }
  expect(listed.routines.map(item => item.id)).toEqual([created.routine.id])
  const paused = tools.call(owner, work.id, 'workspace_update_routine', { requestId: randomUUID(), routineId: created.routine.id, enabled: false }) as { routine: { enabled: boolean } }
  expect(paused.routine.enabled).toBe(false)
  expect(() => tools.call(owner, work.id, 'workspace_delete_routine', { requestId: randomUUID(), routineId: foreign.id })).toThrow(/不存在/)
  tools.call(owner, work.id, 'workspace_delete_routine', { requestId: randomUUID(), routineId: created.routine.id })
  expect(store.list(owner, 'routine').map((item: { id: string }) => item.id)).toEqual([foreign.id])
})

it('rejects temporary and archived bots and a reused request id with different content', () => {
  const agent = store.require<WorkspaceAgent>(owner, 'agent', work.agentId)
  store.put(owner, 'agent', agent.id, { ...agent, temporaryGoalId: randomUUID() })
  expect(() => tools.call(owner, work.id, 'workspace_list_routines', {})).toThrow(HttpError)
  store.put(owner, 'agent', agent.id, agent)
  const requestId = randomUUID()
  tools.call(owner, work.id, 'workspace_create_routine', { requestId, name: '一次', prompt: '原来的内容', enabled: true, schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 30 } })
  expect(() => tools.call(owner, work.id, 'workspace_create_routine', { requestId, name: '一次', prompt: '换成别的', enabled: true, schedule: { kind: 'interval', timezone: 'UTC', everyMinutes: 30 } })).toThrow(/请求编号/)
})

it('tells every Bot not to use Hermes cron, and explains its own routine tools when they are mounted', () => {
  const fixture = {
    agent: { id: 'bot', name: '助手', avatar: '', instructions: '规则', nodeId: 'local', profile: 'dev', archived: false, revision: 1, createdAt: 1, updatedAt: 1 },
    conversation: { id: 'chat', kind: 'direct', name: '对话', avatar: '', memberIds: ['bot'], administratorId: 'bot', mode: 'free', instructions: '', autoReplyIds: [], maxReplyRounds: 1, archived: false, pinned: false, readSeq: 0, lastSeq: 0, preview: '', createdAt: 1, updatedAt: 1 },
    members: [{ id: 'bot', name: '助手' }],
    work: { depth: 0, requiredReply: false, replyMode: 'mentioned', messageId: 'message' },
    run: { mentionIds: [] },
    environment: { open: { computer: false, server: false, vm: false, cloud: false }, tools: { desktopView: false, desktopFile: false, vm: false, cloud: false, plugins: false }, version: 1, capturedAt: 1, execution: { nodeId: 'local', profile: 'dev' }, runtime: { connected: false }, desktop: { capturedAt: 1, hosts: [] }, virtual: { vm: { status: 'disabled' }, cloud: { status: 'disabled' } }, fileTransferMaxMiB: 25 },
    memory: '', noReply: '[[YAOYAO_NO_REPLY_V1]]', marker: '[yaoyao-run:run:result]', content: '每天提醒我', contentKind: 'user', attachmentRefs: [],
  } as WorkspacePromptInput
  expect(buildWorkspacePrompt(fixture)).toContain('不要调用 Hermes 的 cronjob')
  expect(buildWorkspacePrompt(fixture)).not.toContain('workspace_delete_routine')
  expect(buildWorkspacePrompt({ ...fixture, routineRules: ROUTINE_TOOL_RULES })).toContain('到点后在它的单聊中发送任务内容')
})
