import { createHash } from 'node:crypto'
import { OpenVikingError } from '@openviking/sdk'
import type { MemoryScope, WorkspaceMemory, WorkspaceMemoryRevision } from '../shared/workspaceKnowledge.js'
import type { WorkspaceMessage } from '../shared/workspace.js'
import { HttpError } from './errors.js'
import type { OpenVikingService } from './openVikingService.js'
import type { WorkspaceKnowledge, MemoryActor, MemoryScopeInput, MemoryWriteInput, MemoryWriteResult } from './workspaceKnowledge.js'

type Revision = WorkspaceMemoryRevision
interface StoredRecord {
  schemaVersion: 1
  memory: WorkspaceMemory
  revisions: Revision[]
  requestFingerprint: string
}
interface Tombstone { at: number }

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const normalize = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim()
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`
const isUuid = (value: string): boolean => /^[0-9a-f]{32}$/.test(value)
const memoryId = (requestId: string): string => requestId.replaceAll('-', '')
const MEMORY_TAG = 'yaoyao_memory=true'
const activeUri = (scope: MemoryScopeInput, id: string): string => `viking://~/memories/yaoyao/${scope.scope}/${id}.json`
const revisionsUri = (scope: MemoryScopeInput, id: string, revision: number): string => `viking://resources/yaoyao/${scope.scope}/${id}/revisions/${revision}.json`
const tombstoneUri = (scope: MemoryScopeInput, fingerprint: string): string => `viking://resources/yaoyao/${scope.scope}/tombstones/${fingerprint}.json`
const requestUri = (requestId: string): string => `viking://resources/yaoyao/requests/${requestId.replaceAll('-', '')}.json`
const fingerprintUri = (scope: MemoryScopeInput, fingerprint: string): string => `viking://resources/yaoyao/${scope.scope}/fingerprints/${fingerprint}.json`
const forgottenSourcesUri = (scope: MemoryScopeInput): string => `viking://resources/yaoyao/${scope.scope}/forgotten-sources.json`

function assertScope(scope: MemoryScopeInput): void {
  if (scope.scope === 'project' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(scope.projectId ?? '')) throw new HttpError(400, '需要选择项目', 'project_required')
}

async function notFoundAsUndefined<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try { return await operation() } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined
    if (error instanceof OpenVikingError && (error.statusCode === 404 || error.code === 'NOT_FOUND' || error.code === 'ENOENT')) return undefined
    throw error
  }
}

function uriName(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['uri', 'path', 'name', 'id']) if (typeof record[key] === 'string') return record[key] as string
  }
  return undefined
}

export class OpenVikingMemoryProvider {
  readonly #locks = new Map<string, Promise<unknown>>()
  constructor(private readonly service: OpenVikingService, private readonly knowledge: WorkspaceKnowledge) {}
  private async withLock(owner: string, agentId: string, operation: () => Promise<void>): Promise<void> {
    const key = `${owner}\0${agentId}`
    const previous = this.#locks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.#locks.set(key, next)
    try { await next } finally { if (this.#locks.get(key) === next) this.#locks.delete(key) }
  }
  private async ensure(owner: string, agentId: string): Promise<void> {
    if (!this.service.enabled) return
    const agent = this.knowledge.agent(owner, agentId)
    await this.service.ensureUser(owner, agent)
  }
  private async readRecord(owner: string, scope: MemoryScopeInput, id: string): Promise<StoredRecord | undefined> {
    assertScope(scope)
    const raw = await notFoundAsUndefined(() => this.service.userClient(owner, scope.agentId).read(activeUri(scope, id)))
    if (!raw) return undefined
    try {
      const value = JSON.parse(raw) as StoredRecord
      if (value.schemaVersion !== 1 || !value.memory || !Array.isArray(value.revisions)) throw new Error('invalid')
      return value
    } catch { throw new HttpError(409, 'OpenViking 记忆文件损坏', 'openviking_memory_corrupt') }
  }
  private async readJson<T>(owner: string, agentId: string, uri: string, fallback: T): Promise<T> {
    const raw = await notFoundAsUndefined(() => this.service.userClient(owner, agentId).read(uri))
    if (!raw) return fallback
    try { return JSON.parse(raw) as T } catch { throw new HttpError(409, 'OpenViking 记忆审计文件损坏', 'openviking_memory_corrupt') }
  }
  private async listScope(owner: string, scope: MemoryScopeInput): Promise<WorkspaceMemory[]> {
    assertScope(scope)
    const client = this.service.userClient(owner, scope.agentId)
    const directory = `viking://~/memories/yaoyao/${scope.scope}`
    const entries = await notFoundAsUndefined(() => client.list(directory, { recursive: true })) ?? []
    const records: WorkspaceMemory[] = []
    for (const entry of entries) {
      const name = uriName(entry)
      const match = /([0-9a-f]{32})\.json$/.exec(name ?? '')
      if (!match) continue
      const record = await this.readRecord(owner, scope, match[1]!)
      if (record && record.memory.scope === scope.scope && record.memory.agentId === scope.agentId
        && record.memory.projectId === scope.projectId) records.push(record.memory)
    }
    return records
  }
  async list(owner: string, scopes: MemoryScopeInput[]): Promise<WorkspaceMemory[]> {
    const result: WorkspaceMemory[] = []
    for (const scope of scopes) {
      await this.ensure(owner, scope.agentId)
      result.push(...await this.listScope(owner, scope))
    }
    return result
  }
  async writeWithResult(owner: string, input: MemoryWriteInput, actor: MemoryActor = {}): Promise<MemoryWriteResult> {
    assertScope(input)
    this.knowledge.authorizeMemory(owner, input, actor, true)
    if (input.scope === 'project') this.knowledge.requireProjectMember(owner, input.projectId!, input.agentId)
    let output: WorkspaceMemory | undefined
    let outcome: MemoryWriteResult['outcome'] = 'replayed'
    await this.withLock(owner, input.agentId, async () => {
      await this.ensure(owner, input.agentId)
      const client = this.service.userClient(owner, input.agentId)
      const requestFingerprint = sha(JSON.stringify({ operation: 'memory.write', input, actor }))
      const savedRequest = await this.readJson<{ fingerprint: string; memory: WorkspaceMemory } | undefined>(owner, input.agentId, requestUri(input.requestId), undefined)
      if (savedRequest) {
        if (savedRequest.fingerprint !== requestFingerprint) throw new HttpError(409, '请求标识已用于其他内容', 'idempotency_conflict')
        output = savedRequest.memory
        return
      }
      const all = await this.listScope(owner, input), old = input.id ? all.find(memory => memory.id === input.id) : undefined
      if (input.id && !old) throw new HttpError(404, '记忆不存在', 'memory_not_found')
      if (old && old.revision !== input.expectedRevision) throw new HttpError(409, '记忆已更新，请重新读取后保存；草稿已保留', 'memory_revision_conflict')
      if (actor.agentId && old?.origin === 'manual') throw new HttpError(403, '用户维护的记忆不能被机器人覆盖', 'memory_manual_protected')
      if (input.automatic && old && old.origin !== 'synthesis') throw new HttpError(403, '自动整理不能覆盖明确记忆', 'memory_explicit_protected')
      const content = normalize(input.content)
      if (!content || content.length > 2000) throw new HttpError(400, '每条记忆需要 1 至 2000 个字符', 'memory_content_invalid')
      const duplicate = all.find(memory => memory.id !== old?.id && memory.content.toLowerCase() === content.toLowerCase())
      if (duplicate) { output = duplicate; outcome = 'duplicate' }
      else {
        const fingerprint = sha(content.toLowerCase())
        const tombstone = await this.readJson<Tombstone | undefined>(owner, input.agentId, tombstoneUri(input, fingerprint), undefined)
        const forgottenSources = await this.readJson<string[]>(owner, input.agentId, forgottenSourcesUri(input), [])
        if (input.automatic && (tombstone || input.sources?.some(source => forgottenSources.includes(source.messageId)))) throw new HttpError(409, '此记忆或其旧来源已被遗忘', 'memory_forgotten')
        const sources = input.sources ?? old?.sources ?? []
        if (actor.agentId && !sources.length) throw new HttpError(400, '保存记忆需要来源消息', 'memory_source_required')
        for (const source of sources) {
          const message = this.knowledge.store.require<WorkspaceMessage>(owner, 'message', source.messageId)
          if (message.conversationId !== source.conversationId || message.visible === false || (source.quote && !message.content.includes(source.quote))) throw new HttpError(400, '记忆来源无效', 'memory_source_invalid')
          if (actor.agentId && input.scope === 'user' && (message.role !== 'user' || !source.quote?.trim())) throw new HttpError(400, '用户共享记忆需要用户原话依据', 'memory_user_evidence_required')
        }
        const now = Date.now()
        const memory: WorkspaceMemory = {
          id: old?.id ?? memoryId(input.requestId), scope: input.scope, agentId: input.agentId,
          ...(input.projectId ? { projectId: input.projectId } : {}), content, tier: input.tier,
          origin: actor.agentId ? input.automatic ? 'synthesis' : 'explicit' : 'manual', sources,
          revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now,
        }
        if (input.topic || old?.topic) memory.topic = normalize(input.topic ?? old!.topic!).slice(0, 100)
        const revision: Revision = { id: memoryId(`${input.requestId}-${memory.revision}`), memoryId: memory.id, revision: memory.revision, operation: 'write', actor: actor.agentId ?? 'user', at: now, before: old, after: memory }
        const previous = await this.readRecord(owner, input, memory.id)
        const record: StoredRecord = { schemaVersion: 1, memory, revisions: [...(previous?.revisions ?? []), revision], requestFingerprint }
        const uri = activeUri(input, memory.id)
        await client.write(uri, json(record), { wait: true })
        await client.setTags(uri, [MEMORY_TAG, `yaoyao_scope=${input.scope}`, `yaoyao_memory_id=${memory.id}`, ...(input.projectId ? [`yaoyao_project=${input.projectId}`] : [])])
        await client.write(revisionsUri(input, memory.id, memory.revision), json(revision), { wait: true })
        await client.write(requestUri(input.requestId), json({ fingerprint: requestFingerprint, memory }), { wait: true })
        await client.write(fingerprintUri(input, fingerprint), json({ id: memory.id, revision: memory.revision }), { wait: true })
        if (old && old.content.toLowerCase() !== content.toLowerCase() && memory.origin !== 'synthesis') {
          const oldFingerprint = sha(old.content.toLowerCase())
          await client.write(tombstoneUri(input, oldFingerprint), json({ at: now }), { wait: true })
          await client.write(forgottenSourcesUri(input), json([...new Set([...forgottenSources, ...old.sources.map(source => source.messageId)])]), { wait: true })
        }
        if (!input.automatic) await client.remove(tombstoneUri(input, fingerprint), { wait: true }).catch(() => undefined)
        output = memory
        outcome = 'written'
      }
      await client.write(requestUri(input.requestId), json({ fingerprint: requestFingerprint, memory: output! }), { wait: true })
    })
    this.knowledge.emitMemoryChanged(owner)
    return { memory: output!, outcome }
  }
  async forget(owner: string, input: MemoryScopeInput & { requestId: string; id: string; expectedRevision: number }, actor: MemoryActor = {}): Promise<{ id: string; scope: MemoryScope; agentId: string; projectId?: string }> {
    assertScope(input)
    this.knowledge.authorizeMemory(owner, input, actor, true)
    let output: { id: string; scope: MemoryScope; agentId: string; projectId?: string } | undefined
    const requestFingerprint = sha(JSON.stringify({ operation: 'memory.forget', input, actor }))
    await this.withLock(owner, input.agentId, async () => {
      await this.ensure(owner, input.agentId)
      const savedRequest = await this.readJson<{ fingerprint: string; result?: { id: string; scope: MemoryScope; agentId: string; projectId?: string } } | undefined>(owner, input.agentId, requestUri(input.requestId), undefined)
      if (savedRequest?.result) {
        if (savedRequest.fingerprint !== requestFingerprint) throw new HttpError(409, '请求标识已用于其他内容', 'idempotency_conflict')
        output = savedRequest.result
        return
      }
      const old = await this.readRecord(owner, input, input.id)
      if (!old) throw new HttpError(404, '记忆不存在', 'memory_not_found')
      if (old.memory.revision !== input.expectedRevision) throw new HttpError(409, '记忆已更新，请重新读取后操作', 'memory_revision_conflict')
      if (actor.agentId && old.memory.origin === 'manual') throw new HttpError(403, '用户维护的记忆不能被机器人删除', 'memory_manual_protected')
      const client = this.service.userClient(owner, input.agentId), now = Date.now(), fingerprint = sha(old.memory.content.toLowerCase())
      const revision: Revision = { id: memoryId(`${input.requestId}-${old.memory.revision + 1}`), memoryId: old.memory.id, revision: old.memory.revision + 1, operation: 'forget', actor: actor.agentId ?? 'user', at: now, before: old.memory }
      await client.remove(activeUri(input, old.memory.id), { wait: true })
      await client.write(revisionsUri(input, old.memory.id, revision.revision), json(revision), { wait: true })
      await client.write(tombstoneUri(input, fingerprint), json({ at: now }), { wait: true })
      await client.write(forgottenSourcesUri(input), json([...new Set([...await this.readJson<string[]>(owner, input.agentId, forgottenSourcesUri(input), []), ...old.memory.sources.map(source => source.messageId)])]), { wait: true })
      output = { id: old.memory.id, scope: old.memory.scope, agentId: old.memory.agentId, ...(old.memory.projectId ? { projectId: old.memory.projectId } : {}) }
      await client.write(requestUri(input.requestId), json({ fingerprint: requestFingerprint, result: output }), { wait: true })
    })
    this.knowledge.emitMemoryChanged(owner)
    return output!
  }
  async revisions(owner: string, scope: MemoryScopeInput, id: string): Promise<Revision[]> {
    assertScope(scope)
    this.knowledge.authorizeMemory(owner, scope, {})
    await this.ensure(owner, scope.agentId)
    if (!isUuid(id)) return []
    const directory = `viking://resources/yaoyao/${scope.scope}/${id}/revisions`
    const entries = await notFoundAsUndefined(() => this.service.userClient(owner, scope.agentId).list(directory, { recursive: true })) ?? []
    const revisions: Revision[] = []
    for (const entry of entries) {
      const name = uriName(entry), match = /(\d+)\.json$/.exec(name ?? '')
      if (match) {
        const revision = await this.readJson<Revision>(owner, scope.agentId, revisionsUri(scope, id, Number(match[1])), {} as Revision)
        if (revision.id) revisions.push(revision)
      }
    }
    return revisions.sort((left, right) => right.revision - left.revision)
  }
  async search(owner: string, query: { scope: MemoryScope; agentId?: string; projectId?: string; search?: string }, scopes: MemoryScopeInput[], actor: MemoryActor = {}): Promise<WorkspaceMemory[]> {
    const exact = await this.list(owner, scopes.filter(scope => {
      this.knowledge.authorizeMemory(owner, scope, actor)
      return true
    }))
    if (!query.search) return exact
    const wanted = new Set<string>()
    for (const scope of scopes) {
      const found = await notFoundAsUndefined(() => this.service.userClient(owner, scope.agentId).find(query.search!, { targetUri: `viking://~/memories/yaoyao/${query.scope}`, limit: 100, tags: [MEMORY_TAG] }))
      if (!found) continue
      for (const memory of Array.isArray(found.memories) ? found.memories : []) {
        const uri = uriName(memory) ?? uriName((memory as Record<string, unknown>).source)
        const match = /([0-9a-f]{32})\.json$/.exec(uri ?? '')
        if (match) wanted.add(match[1]!)
      }
    }
    return exact.filter(memory => wanted.has(memory.id) || memory.content.toLowerCase().includes(query.search!.toLowerCase()))
  }
}
