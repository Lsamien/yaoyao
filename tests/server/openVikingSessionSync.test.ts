// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { OpenVikingError } from '@openviking/sdk'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { OpenVikingService } from '../../src/server/openVikingService'
import { OpenVikingConfigurationManager } from '../../src/server/openVikingConfiguration'
import { OpenVikingSessionSync } from '../../src/server/openVikingSessionSync'
import type { WorkspaceAgent, WorkspaceConversation, WorkspaceMessage } from '../../src/shared/workspace'

let home: string, store: WorkspaceStore, service: OpenVikingService, sync: OpenVikingSessionSync, agent: WorkspaceAgent, conversation: WorkspaceConversation
const remote = new Map<string, any[]>(), clients: any[] = []
let failAfterWrite = false, offline = false, autoCommit = false
let partialWrite: number | undefined, silentPartial = false
const notFound = () => new OpenVikingError('not found', { code: 'NOT_FOUND', statusCode: 404 })
const config = { enabled: true, url: 'http://localhost:1933', accountId: 'test', adminKey: 'admin-secret' }
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-session-sync-')); store = new WorkspaceStore(home)
  const manager = new OpenVikingConfigurationManager(home, undefined, async () => {})
  await manager.update(config)
  service = new OpenVikingService(store, manager, identity => {
    const prefix = `${identity.baseUrl}:${identity.account}:${identity.user}:`
    const client = {
      adminRegisterUser: vi.fn(async () => ({ user_key: randomUUID() })),
      adminRemoveUser: vi.fn(async (_account: string, user: string) => { for (const key of remote.keys()) if (key.includes(`:${user}:`)) remote.delete(key) }),
      createSession: vi.fn(async ({ sessionId }: any) => { if (!remote.has(prefix + sessionId)) remote.set(prefix + sessionId, []); return { session_id: sessionId } }),
      getSession: vi.fn(async (id: string) => { if (offline) throw new Error('offline'); if (!remote.has(prefix + id)) throw notFound(); return { uri: id, message_count: remote.get(prefix + id)!.length, auto_commit_policy: autoCommit ? { message_count_threshold: 1 } : null } }),
      read: vi.fn(async (uri: string) => remote.get(prefix + uri.replace('/messages.jsonl', ''))!.map(row => JSON.stringify({ role: row.role, parts: [{ type: 'text', text: row.content }], created_at: row.createdAt })).join('\n')),
      batchAddMessages: vi.fn(async (id: string, messages: any[]) => { remote.get(prefix + id)!.push(...messages.slice(0, partialWrite ?? messages.length)); if (partialWrite !== undefined && !silentPartial) { partialWrite = undefined; throw new OpenVikingError('partial write', { code: 'INTERNAL', statusCode: 500 }) } partialWrite = undefined; if (failAfterWrite) { failAfterWrite = false; throw new Error('response lost') } return {} }),
      deleteSession: vi.fn(async (id: string) => { remote.delete(prefix + id) }),
      commitSession: vi.fn(),
    }
    clients.push(client); return client as any
  })
  vi.spyOn(service, 'disableSessionAutoCommit').mockImplementation(async () => { autoCommit = false })
  agent = store.createAgent('owner', { name: 'Bot', profile: 'default' })
  conversation = store.list<WorkspaceConversation>('owner', 'conversation')[0]!
  sync = new OpenVikingSessionSync(store, service)
})
afterEach(() => { sync.close(); store.close(); rmSync(home, { recursive: true, force: true }); remote.clear(); clients.length = 0; offline = false; failAfterWrite = false; autoCommit = false; partialWrite = undefined; silentPartial = false; vi.restoreAllMocks() })

function message(role: 'user' | 'assistant' | 'system', content: string, fields: Partial<WorkspaceMessage> = {}) {
  const value: WorkspaceMessage = { id: randomUUID(), conversationId: conversation.id, seq: 0, role, ...(role === 'assistant' ? { agentId: agent.id } : {}), content, reasoning: 'private thought', status: 'complete', attachments: [], tools: [{ secret: 'private tool' }], createdAt: Date.now(), ...fields }
  store.saveMessage('owner', value); return value
}
function unthrottle() { store.db.prepare('UPDATE openviking_sync_jobs SET next_at=0').run() }
async function drain(times = 6) { for (let i = 0; i < times; i++) { unthrottle(); await sync.tick() } }
const texts = () => [...remote.values()].flat().map(row => row.content)

it('backfills archived history in pages and only uploads final visible transcript text', async () => {
  for (let i = 0; i < 260; i++) message(i % 2 ? 'assistant' : 'user', `message ${i}`)
  message('assistant', 'hidden', { visible: false })
  store.put('owner', 'conversation', conversation.id, { ...store.require('owner', 'conversation', conversation.id), archived: true })
  await sync.tick()
  expect(remote.size).toBe(0)
  await drain()
  expect(texts()).toHaveLength(260)
  expect(texts()[259]).toBe('message 259')
  expect(JSON.stringify([...remote.values()])).not.toMatch(/private thought|private tool|hidden/)
  expect(sync.status()).toMatchObject({ backfilling: false, complete: 1, pending: 0 })
  expect(clients.every(client => client.commitSession.mock.calls.length === 0)).toBe(true)
})

it('does not duplicate messages when an append succeeds remotely but the response is lost, including after restart', async () => {
  message('user', 'hello'); message('assistant', 'answer'); failAfterWrite = true
  await sync.tick()
  expect(texts()).toEqual(['hello', 'answer'])
  sync.close(); sync = new OpenVikingSessionSync(store, service)
  await drain()
  expect(texts()).toEqual(['hello', 'answer'])
  expect(sync.status().complete).toBe(1)
})

it('waits for streaming replies, preserves interrupted text, and catches up after disabling', async () => {
  message('user', 'first')
  const reply = message('assistant', 'partial', { status: 'streaming' })
  message('user', 'later')
  await sync.tick(); expect(texts()).toEqual(['first'])
  service.configure(undefined)
  store.saveMessage('owner', { ...reply, content: 'partial final', status: 'interrupted' })
  await sync.tick(); expect(texts()).toEqual(['first'])
  service.configure(config); await drain()
  expect(texts()).toEqual(['first', 'partial final', 'later'])
})

it('stops after three failures and retries on request without blocking local chat writes', async () => {
  message('user', 'hello'); offline = true
  await drain()
  expect(sync.status()).toMatchObject({ failed: 1, lastError: 'offline' })
  message('user', 'still chatting'); await sync.tick()
  expect(sync.status().failed).toBe(1)
  offline = false; sync.retry(); await drain()
  expect(texts()).toEqual(['hello', 'still chatting'])
  expect(sync.status()).toMatchObject({ failed: 0, complete: 1 })
})

it('keeps Bot namespaces separate and does not create sessions for temporary helpers', async () => {
  message('assistant', 'first bot')
  const second = store.createAgent('owner', { name: 'Second', profile: 'default' })
  const secondConversation = store.list<WorkspaceConversation>('owner', 'conversation').find(row => row.memberIds[0] === second.id)!
  message('assistant', 'second bot', { conversationId: secondConversation.id, agentId: second.id })
  const helper = store.createAgent('owner', { name: 'Temporary', profile: 'default' })
  store.put('owner', 'agent', helper.id, { ...helper, temporaryGoalId: randomUUID() })
  message('assistant', 'helper secret', { agentId: helper.id })
  await drain()
  expect(remote.size).toBe(2)
  expect([...remote.values()].every(rows => rows.length === 1)).toBe(true)
  expect(texts()).not.toContain('helper secret')
  service.configure({ ...config, accountId: 'new-account' }); await drain()
  expect(remote.size).toBe(4)
})

it('cleans up deleted conversations and cannot resurrect them on restart', async () => {
  message('user', 'hello'); await drain(); expect(remote.size).toBe(1)
  store.remove('owner', 'conversation', conversation.id)
  store.event('owner', 'conversation.deleted', { id: conversation.id }, conversation.id)
  await drain(); expect(remote.size).toBe(0)
  sync.close(); sync = new OpenVikingSessionSync(store, service); await drain()
  expect(remote.size).toBe(0)
})

it('disables inherited native auto-commit and preserves the paused automatic-memory preference', async () => {
  autoCommit = true; store.put('owner', 'agent', agent.id, { ...agent, memoryEnabled: false })
  message('user', 'hello'); await drain()
  expect(service.disableSessionAutoCommit).toHaveBeenCalledTimes(1)
  expect(texts()).toEqual(['hello'])
  expect(store.require('owner', 'agent', agent.id).memoryEnabled).toBe(false)
})

it('keeps group topics and participating Bots isolated, including their triggering user message', async () => {
  const second = store.createAgent('owner', { name: 'Second', profile: 'default' })
  const groupId = randomUUID()
  store.put('owner', 'conversation', groupId, { ...conversation, id: groupId, kind: 'group', memberIds: [agent.id, second.id], lastSeq: 0 })
  const taskIds = [randomUUID(), randomUUID()]
  for (const [index, taskId] of taskIds.entries()) {
    store.put('owner', 'conversation-task', taskId, { id: taskId, conversationId: groupId, memberIds: [agent.id, second.id], lastSeq: 0 })
    const source = message('user', `topic ${index}`, { conversationId: groupId, conversationTaskId: taskId })
    const runId = randomUUID(); store.put('owner', 'run', runId, { id: runId, messageId: source.id })
    message('assistant', `reply ${index}`, { conversationId: groupId, conversationTaskId: taskId, agentId: index ? second.id : agent.id, runId })
  }
  await drain()
  expect([...remote.values()].map(rows => rows.map(row => row.content))).toEqual([['topic 0', 'reply 0'], ['topic 1', 'reply 1']])
  store.remove('owner', 'conversation-task', taskIds[0]!)
  await drain(); expect([...remote.values()].map(rows => rows.map(row => row.content))).toEqual([['topic 1', 'reply 1']])
})

it('reconciles retained messages on restart even if the event log was pruned', async () => {
  message('user', 'before'); await drain(); sync.close()
  message('assistant', 'offline history')
  store.db.prepare('DELETE FROM workspace_events').run()
  sync = new OpenVikingSessionSync(store, service); await drain()
  expect(texts()).toEqual(['before', 'offline history'])
})

it('keeps attachment metadata without binary data and deletes removed Bots', async () => {
  message('user', 'attached', { attachments: [{ id: randomUUID(), name: 'proof.bin', mimeType: 'application/octet-stream', size: 15, sender: 'user', path: '/private/proof.bin', data: 'secret-binary' } as any] })
  await drain()
  expect(texts()[0]).toContain('proof.bin'); expect(texts()[0]).toContain('15')
  expect(texts()[0]).not.toMatch(/secret-binary|\/private/)
  store.remove('owner', 'agent', agent.id); await drain()
  expect(remote.size).toBe(0)
})


it('omits inline reasoning and finishes deletion queued while OpenViking was disabled', async () => {
  message('assistant', '<think>private thought</think>visible answer'); await drain()
  expect(texts()).toEqual(['visible answer'])
  service.configure(undefined); await sync.tick(); await service.removeUser('owner', agent)
  store.remove('owner', 'agent', agent.id)
  service.configure(config); await drain()
  expect(remote.size).toBe(0)
  expect(service.binding('owner', agent.id)).toMatchObject({ status: 'removed', pendingRemoval: false })
})


it('mirrors Bot communication bodies with sender and receiver roles, without internal display wrappers', async () => {
  const receiver = store.createAgent('owner', { name: 'Receiver', profile: 'default' })
  const destination = store.list<WorkspaceConversation>('owner', 'conversation').find(row => row.memberIds[0] === receiver.id)!
  const peerId = randomUUID()
  store.put('owner', 'peer-message', peerId, { id: peerId, fromAgentId: agent.id, toAgentId: receiver.id, originConversationId: conversation.id, conversationId: destination.id, content: 'collaboration body', fileIds: [] })
  message('system', 'internal wrapper', { peerMessageId: peerId })
  message('system', 'internal wrapper', { conversationId: destination.id, peerMessageId: peerId, runId: randomUUID() })
  await drain()
  expect([...remote.values()].flat().map(row => [row.role, row.content]).sort()).toEqual([['assistant', 'collaboration body'], ['user', 'collaboration body']])
})


it('catches messages from another client while an append is in flight', async () => {
  message('user', 'client A')
  await drain()
  message('user', 'client B')
  const client = clients.find(row => row.batchAddMessages.mock.calls.length)!
  const append = client.batchAddMessages.getMockImplementation()!
  client.batchAddMessages.mockImplementationOnce(async (id: string, batch: any[]) => {
    const result = await append(id, batch)
    message('user', 'client A while B appends')
    return result
  })
  await drain()
  expect(texts()).toEqual(['client A', 'client B', 'client A while B appends'])
  expect(sync.status()).toMatchObject({ complete: 1, pending: 0, failed: 0 })
})

it('serializes overlapping ticks from different sync instances sharing the same database', async () => {
  message('user', 'one copy')
  const other = new OpenVikingSessionSync(store, service)
  try {
    await Promise.all([sync.tick(), other.tick()])
    await drain()
    expect(texts()).toEqual(['one copy'])
    expect(sync.status().complete).toBe(1)
  } finally { other.close() }
})

it('recovers a partial failed append after restart without repeating the accepted prefix', async () => {
  message('user', 'first'); message('assistant', 'second'); message('user', 'third')
  partialWrite = 1
  await sync.tick()
  expect(texts()).toEqual(['first'])
  sync.close(); sync = new OpenVikingSessionSync(store, service)
  await drain()
  expect(texts()).toEqual(['first', 'second', 'third'])
  expect(sync.status()).toMatchObject({ complete: 1, failed: 0 })
})

it('verifies writes even when a server acknowledges a partial batch as successful', async () => {
  message('user', 'first'); message('assistant', 'second'); message('user', 'third')
  partialWrite = 1; silentPartial = true
  await drain()
  expect(texts()).toEqual(['first', 'second', 'third'])
  expect(sync.status()).toMatchObject({ complete: 1, failed: 0 })
})

it('detects a local revision received during the remote read before appending a suffix', async () => {
  const original = message('user', 'original'); await drain()
  message('assistant', 'must not append')
  const client = clients.find(row => row.batchAddMessages.mock.calls.length)!
  const read = client.read.getMockImplementation()!
  client.read.mockImplementationOnce(async (uri: string) => {
    const raw = await read(uri)
    store.saveMessage('owner', { ...original, content: 'changed on another client' })
    return raw
  })
  await drain()
  expect(texts()).toEqual(['original'])
  expect(sync.status()).toMatchObject({ failed: 1 })
  expect(sync.status().lastError).toContain('已停止追加')
})

it('recovers a legacy failed job only after verifying the remote prefix on startup', async () => {
  message('user', 'prefix'); await drain()
  message('assistant', 'suffix')
  store.db.prepare("UPDATE openviking_sync_jobs SET status='failed',attempts=3,error=?").run('OpenViking 会话记录与本地顺序不一致，已停止追加，请核对会话')
  sync.close(); sync = new OpenVikingSessionSync(store, service)
  await drain()
  expect(texts()).toEqual(['prefix', 'suffix'])
  expect(sync.status()).toMatchObject({ failed: 0, complete: 1 })
})

it.each(['reordered', 'changed', 'extra'])('keeps a real %s remote conflict closed across restart and explicit retry', async kind => {
  message('user', 'first', { createdAt: 1000 }); message('assistant', 'second', { createdAt: 2000 })
  await drain()
  const rows = [...remote.values()][0]!
  if (kind === 'reordered') rows.reverse()
  if (kind === 'changed') rows[0] = { ...rows[0], content: 'foreign revision' }
  if (kind === 'extra') rows.push({ role: 'user', content: 'foreign message', createdAt: new Date(3000).toISOString() })
  const before = JSON.stringify(rows)
  message('user', 'new suffix', { createdAt: 4000 })
  await drain()
  expect(sync.status().failed).toBe(1)
  sync.close(); sync = new OpenVikingSessionSync(store, service); await drain()
  sync.retry(); await drain()
  expect(JSON.stringify(rows)).toBe(before)
  expect(sync.status().failed).toBe(1)
  expect(clients.every(client => client.deleteSession.mock.calls.length === 0)).toBe(true)
})

it('does not deduplicate distinct local messages with identical text and timestamps', async () => {
  message('user', 'repeat', { createdAt: 1000 }); message('user', 'repeat', { createdAt: 1000 })
  failAfterWrite = true; await drain()
  expect(texts()).toEqual(['repeat', 'repeat'])
  expect(sync.status().complete).toBe(1)
})

it('uses local sequence rather than client clocks and keeps it stable after reconnect', async () => {
  const first = message('user', 'client A first', { createdAt: 2000 })
  const second = message('assistant', 'client B second', { createdAt: 1000 })
  await drain()
  store.saveMessage('owner', { ...first, seq: 11 }); store.saveMessage('owner', { ...second, seq: 12 })
  sync.close(); sync = new OpenVikingSessionSync(store, service); await drain()
  expect(texts()).toEqual(['client A first', 'client B second'])
  expect(sync.status().complete).toBe(1)
})

it('rejects remote history loss instead of appending an already acknowledged transcript again', async () => {
  message('user', 'acknowledged'); await drain()
  const rows = [...remote.values()][0]!
  rows.length = 0
  message('user', 'later'); await drain()
  expect(rows).toEqual([])
  expect(sync.status().failed).toBe(1)
})


it('serializes independent database connections without holding a transaction during network waits', async () => {
  message('user', 'only once')
  const otherStore = new WorkspaceStore(home)
  const other = new OpenVikingSessionSync(otherStore, service)
  try {
    await Promise.all([sync.tick(), other.tick()])
    await drain()
    expect(texts()).toEqual(['only once'])
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM openviking_sync_locks').get()!.n).toBe(0)
  } finally { other.close(); otherStore.close() }
})

it('does not steal a live writer lock and recovers a crashed writer by validating its remote prefix', async () => {
  message('user', 'before crash'); await drain()
  message('user', 'after crash')
  const job = store.db.prepare('SELECT id FROM openviking_sync_jobs').get()!
  store.db.prepare('INSERT INTO openviking_sync_locks VALUES(?,?,?)').run(job.id, 'synthetic-writer', process.pid)
  await sync.tick()
  expect(texts()).toEqual(['before crash'])
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('synthetic dead process'), { code: 'ESRCH' }) })
  await drain()
  expect(texts()).toEqual(['before crash', 'after crash'])
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM openviking_sync_locks').get()!.n).toBe(0)
})

it('releases the writer lock after a lost response and after a configuration pause', async () => {
  message('user', 'prefix'); failAfterWrite = true
  await sync.tick()
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM openviking_sync_locks').get()!.n).toBe(0)
  await drain()
  const client = clients.find(row => row.batchAddMessages.mock.calls.length)!
  const append = client.batchAddMessages.getMockImplementation()!
  client.batchAddMessages.mockImplementationOnce(async (id: string, batch: any[]) => {
    const result = await append(id, batch)
    service.configure(undefined)
    return result
  })
  message('user', 'pause'); await sync.tick()
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM openviking_sync_locks').get()!.n).toBe(0)
  service.configure(config); await drain()
  expect(texts()).toEqual(['prefix', 'pause'])
  expect(sync.status()).toMatchObject({ complete: 1, failed: 0 })
})

it('does not recreate a missing session containing previously confirmed messages', async () => {
  message('user', 'confirmed'); await drain()
  remote.clear()
  message('user', 'later'); await drain()
  expect(remote.size).toBe(0)
  expect(sync.status().failed).toBe(1)
  expect(clients.flatMap(client => client.createSession.mock.calls)).toHaveLength(1)
})

it.each(['foreign part', 'bad JSON', 'bad date'])('rejects %s without leaking transcript contents or writing a suffix', async kind => {
  message('user', 'prefix'); await drain()
  const client = clients.find(row => row.batchAddMessages.mock.calls.length)!
  client.read.mockImplementation(async () => {
    if (kind === 'bad JSON') return 'private contents: invalid JSON'
    return JSON.stringify({ role: 'user', created_at: kind === 'bad date' ? 'bad date' : new Date(1000).toISOString(), parts: [{ type: kind === 'bad date' ? 'text' : 'tool', text: 'private contents' }] })
  })
  message('user', 'suffix'); await drain()
  expect(texts()).toEqual(['prefix'])
  expect(sync.status().failed).toBe(1)
  expect(sync.status().lastError).not.toContain('private contents')
})

it('normalizes equivalent timestamp representations without ignoring timestamp differences', async () => {
  message('user', 'prefix', { createdAt: 1000 }); await drain()
  const client = clients.find(row => row.batchAddMessages.mock.calls.length)!
  const read = client.read.getMockImplementation()!
  client.read.mockImplementation(async (uri: string) => (await read(uri)).replace('1970-01-01T00:00:01.000Z', '1970-01-01T08:00:01+08:00'))
  message('user', 'suffix', { createdAt: 2000 }); await drain()
  expect(texts()).toEqual(['prefix', 'suffix'])
  expect(sync.status().complete).toBe(1)
  client.read.mockImplementation(async (uri: string) => (await read(uri)).replace('1970-01-01T00:00:01.000Z', '1970-01-01T00:00:02.000Z'))
  message('user', 'must stop', { createdAt: 3000 }); await drain()
  expect(texts()).toEqual(['prefix', 'suffix'])
  expect(sync.status().failed).toBe(1)
})

it('backs off an acknowledged append that stores no messages instead of falsely completing', async () => {
  message('user', 'pending')
  partialWrite = 0; silentPartial = true
  await sync.tick()
  expect(texts()).toEqual([])
  expect(sync.status()).toMatchObject({ pending: 1, complete: 0 })
  expect(store.db.prepare('SELECT synced_messages FROM openviking_sync_jobs').get()!.synced_messages).toBe(0)
  await drain()
  expect(texts()).toEqual(['pending'])
})


it('does not replay a timed-out suffix while the original remote write may still finish', async () => {
  message('user', 'prefix'); await drain()
  const client = clients.find(row => row.batchAddMessages.mock.calls.length)!
  const append = client.batchAddMessages.getMockImplementation()!
  let finish: (() => Promise<unknown>) | undefined
  client.batchAddMessages.mockImplementationOnce(async (id: string, batch: any[]) => {
    finish = () => append(id, batch)
    throw new OpenVikingError('timeout', { code: 'DEADLINE_EXCEEDED' })
  })
  message('user', 'uncertain suffix'); await drain()
  expect(texts()).toEqual(['prefix'])
  expect(sync.status().failed).toBe(1)
  expect(sync.status().lastError).toContain('上次追加结果尚未确认')
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM openviking_sync_appends').get()!.n).toBe(1)
  sync.close(); sync = new OpenVikingSessionSync(store, service); sync.retry(); await drain()
  expect(texts()).toEqual(['prefix'])
  await finish!()
  sync.retry(); await drain()
  expect(texts()).toEqual(['prefix', 'uncertain suffix'])
  expect(sync.status().complete).toBe(1)
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM openviking_sync_appends').get()!.n).toBe(0)
})

it('preserves an uncertain append across a crash and refuses to steal its unfinished remote suffix', async () => {
  message('user', 'prefix'); await drain()
  const client = clients.find(row => row.batchAddMessages.mock.calls.length)!
  client.batchAddMessages.mockImplementationOnce(async () => { throw new Error('connection lost before confirmation') })
  message('user', 'suffix'); await sync.tick()
  sync.close(); sync = new OpenVikingSessionSync(store, service); await drain()
  expect(texts()).toEqual(['prefix'])
  expect(sync.status().failed).toBe(1)
  expect(client.batchAddMessages.mock.calls).toHaveLength(2)
})
