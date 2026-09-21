// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { OpenVikingClient, OpenVikingError } from '@openviking/sdk'
import { loadOpenVikingConfiguration, OpenVikingConfigurationManager, openVikingConfigurationPath, openVikingKeyPath } from '../../src/server/openVikingConfiguration'
import { OpenVikingService, openVikingUserId } from '../../src/server/openVikingService'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { WorkspaceKnowledge } from '../../src/server/workspaceKnowledge'
import type { WorkspaceAgent } from '../../src/shared/workspace'

const owner = 'openviking-owner'
let home: string, store: WorkspaceStore, manager: OpenVikingConfigurationManager, service: OpenVikingService, knowledge: WorkspaceKnowledge, a: WorkspaceAgent, b: WorkspaceAgent
const files = new Map<string, string>()
const tagsByUri = new Map<string, string[]>()
const removed = new Set<string>()
const admin = {
  adminRegisterUser: vi.fn(async () => ({ user_key: `user-key-${admin.adminRegisterUser.mock.calls.length}` })),
  adminRegenerateKey: vi.fn(async () => ({ user_key: 'regenerated-key' })),
  adminRemoveUser: vi.fn(async () => ({ ok: true })),
}
const clients = new Map<string, { apiKey: string; client: unknown }>()
function mockClient(apiKey: string, user?: string): OpenVikingClient {
  const validateTags = (tags: string[]) => {
    if (tags.some(tag => !/^[^=]+=[^=]+$/.test(tag))) throw new OpenVikingError('expected strict k=v format', { code: 'INVALID_ARGUMENT', statusCode: 400 })
  }
  return {
    read: vi.fn(async (uri: string) => {
      if (!files.has(uri)) throw new OpenVikingError(`not found: ${uri}`, { code: 'NOT_FOUND', statusCode: 404 })
      return files.get(uri)!
    }),
    write: vi.fn(async (uri: string, content: string) => { files.set(uri, content); return { ok: true } }),
    remove: vi.fn(async (uri: string) => { files.delete(uri); removed.add(uri) }),
    setTags: vi.fn(async (uri: string, tags: string[]) => { validateTags(tags); tagsByUri.set(uri, tags); return { ok: true } }),
    list: vi.fn(async (uri: string) => {
      const entries = [...files.keys()].filter(name => name.startsWith(uri)).map(name => name.slice(uri.length + 1))
      if (!entries.length) throw new OpenVikingError(`Directory not found: ${uri}`, { code: 'NOT_FOUND', statusCode: 404 })
      return entries
    }),
    find: vi.fn(async (query: string, options: { tags: string[] }) => {
      validateTags(options.tags)
      return { memories: [...files.keys()].filter(uri => uri.includes('/memories/') && files.get(uri)?.includes(query)
        && options.tags.every(tag => tagsByUri.get(uri)?.includes(tag))).map(uri => ({ uri })) }
    }),
  } as unknown as OpenVikingClient
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-openviking-'))
  store = new WorkspaceStore(home)
  manager = new OpenVikingConfigurationManager(home, undefined, async () => undefined)
  await manager.update({ enabled: true, url: 'http://127.0.0.1:1933', accountId: 'account', adminKey: 'admin-key' })
  service = new OpenVikingService(store, manager, config => {
    if (!config.user) return admin as unknown as OpenVikingClient
    let entry = clients.get(config.user)
    if (!entry || entry.apiKey !== config.apiKey) {
      entry = { apiKey: config.apiKey, client: mockClient(config.apiKey, config.user) }
      clients.set(config.user, entry)
    }
    return entry.client as OpenVikingClient
  })
  knowledge = new WorkspaceKnowledge(home, store, service)
  a = store.createAgent(owner, { name: '甲', profile: 'same' })
  b = store.createAgent(owner, { name: '乙', profile: 'same' })
})
afterEach(() => { store.close(); rmSync(home, { recursive: true, force: true }); files.clear(); tagsByUri.clear(); removed.clear(); clients.clear(); vi.clearAllMocks() })

describe('OpenViking configuration', () => {
  it('stores the administrator key encrypted with private file permissions', async () => {
    expect(openVikingConfigurationPath(home)).toBeTruthy()
    expect(openVikingKeyPath(home)).toBeTruthy()
    expect(statSync(openVikingConfigurationPath(home)).mode & 0o777).toBe(0o600)
    expect(statSync(openVikingKeyPath(home)).mode & 0o777).toBe(0o600)
    expect(readFileSync(openVikingConfigurationPath(home), 'utf8')).not.toContain('admin-key')
    expect(manager.snapshot()).toMatchObject({ enabled: true, keyConfigured: true, source: 'file', status: 'ready' })
  })
  it('rolls back a failed update', async () => {
    const before = readFileSync(openVikingConfigurationPath(home))
    const probe = vi.fn(async () => { throw new Error('offline') })
    const failing = new OpenVikingConfigurationManager(home, undefined, probe)
    await expect(failing.update({ enabled: true, url: 'http://127.0.0.1:9999', accountId: 'other', adminKey: 'new-key' })).rejects.toThrow('OpenViking 连接验证失败')
    expect(readFileSync(openVikingConfigurationPath(home))).toEqual(before)
    expect(failing.snapshot().keyConfigured).toBe(true)
  })
  it('lets service environment variables override file settings', () => {
    const env = {
      HERMES_YAOYAO_OPENVIKING_URL: 'http://127.0.0.1:2933',
      HERMES_YAOYAO_OPENVIKING_ACCOUNT_ID: 'env-account',
      HERMES_YAOYAO_OPENVIKING_ADMIN_KEY: 'env-key',
    }
    expect(loadOpenVikingConfiguration(home, env)).toMatchObject({ enabled: true, url: env.HERMES_YAOYAO_OPENVIKING_URL, accountId: 'env-account', keyConfigured: true, source: 'environment', status: 'ready' })
  })
})

describe('OpenViking memory provider', () => {
  it('reports writes, duplicates and idempotent replays without changing the public memory shape', async () => {
    const input = { requestId: randomUUID(), scope: 'agent' as const, agentId: a.id, content: '开发环境为 studio', tier: 'log' as const }
    const first = await knowledge.writeMemoryWithResult(owner, input)
    expect(first.outcome).toBe('written')
    expect((await knowledge.writeMemoryWithResult(owner, input)).outcome).toBe('replayed')
    const duplicate = await knowledge.writeMemoryWithResult(owner, { ...input, requestId: randomUUID() })
    expect(duplicate).toEqual({ memory: first.memory, outcome: 'duplicate' })
    expect(await knowledge.writeMemory(owner, input)).toEqual(first.memory)
    expect(tagsByUri.get(`viking://~/memories/yaoyao/agent/${first.memory.id}.json`)).toEqual([
      'yaoyao_memory=true', 'yaoyao_scope=agent', `yaoyao_memory_id=${first.memory.id}`,
    ])
    expect((await knowledge.memories(owner, { scope: 'agent', agentId: a.id, search: 'studio' })).map(memory => memory.id)).toEqual([first.memory.id])
  })
  it('treats a missing search directory as empty while surfacing real upstream failures', async () => {
    await service.ensureUser(owner, a)
    const find = vi.mocked(service.userClient(owner, a.id).find)
    find.mockRejectedValueOnce(new OpenVikingError('Directory not found', { code: 'NOT_FOUND', statusCode: 404 }))
    expect(await knowledge.memories(owner, { scope: 'agent', agentId: a.id, search: '工作环境' })).toEqual([])
    find.mockRejectedValueOnce(new OpenVikingError('unavailable', { code: 'UNAVAILABLE', statusCode: 503 }))
    await expect(knowledge.memories(owner, { scope: 'agent', agentId: a.id, search: '工作环境' })).rejects.toMatchObject({ code: 'openviking_unavailable' })
  })
  it('preserves semantic matches without admitting another Bot’s private memories', async () => {
    const own = await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '用户偏爱低糖饮食', tier: 'profile' })
    const privateFact = await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: b.id, content: '另一个 Bot 的私有记录', tier: 'profile' })
    vi.mocked(service.userClient(owner, a.id).find).mockResolvedValue({ memories: [own, privateFact].map(memory => ({ uri: `viking://~/memories/yaoyao/agent/${memory.id}.json` })) } as any)
    const matches = await knowledge.memories(owner, { scope: 'agent', agentId: a.id, search: '饮食习惯' }, { agentId: a.id })
    expect(matches.map(memory => memory.id)).toEqual([own.id])
    expect(matches[0]!.content).not.toContain('饮食习惯')
  })
  it('lazily binds one deterministic user per existing Bot', async () => {
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '甲的经验', tier: 'profile' })
    expect(admin.adminRegisterUser).toHaveBeenCalledWith('account', openVikingUserId(a.id), 'user', expect.anything())
    const binding = store.require(owner, 'openviking-binding', a.id)
    expect(binding.userId).toBe(openVikingUserId(a.id))
    expect(JSON.stringify(binding)).not.toContain('user-key-')
    await service.removeUser(owner, a)
    expect(admin.adminRemoveUser).toHaveBeenCalledWith('account', binding.userId)
    expect(store.require(owner, 'openviking-binding', a.id).status).toBe('removed')
  })
  it('recovers an existing remote user without a local key binding', async () => {
    admin.adminRegisterUser.mockResolvedValueOnce({})
    await expect(service.ensureUser(owner, a)).rejects.toThrowError(expect.objectContaining({ code: 'openviking_unavailable' }))

    admin.adminRegisterUser.mockRejectedValueOnce(new OpenVikingError('user exists', { code: 'USER_EXISTS', statusCode: 409 }))
    const binding = await service.ensureUser(owner, a)
    expect(binding.userId).toBe(openVikingUserId(a.id))
    expect(JSON.stringify(binding)).not.toContain('regenerated-key')
    expect(admin.adminRegenerateKey).toHaveBeenCalledWith('account', binding.userId, `yaoyao:${a.id}`)
    expect(service.userClient(owner, a.id)).toBeTruthy()
    expect(clients.get(binding.userId)?.apiKey).toBe('regenerated-key')
  })
  it('keeps user memory isolated per contributing Bot', async () => {
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'user', agentId: a.id, topic: '接口', content: '甲认为使用版本一', tier: 'profile' })
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'user', agentId: b.id, topic: '接口', content: '乙认为使用版本二', tier: 'profile' })
    const memories = await knowledge.memories(owner, { scope: 'user' })
    expect(memories).toHaveLength(2)
    expect(memories.every(memory => memory.conflict)).toBe(true)
    expect((await knowledge.memories(owner, { scope: 'user', search: '版本二' })).map(memory => memory.agentId)).toEqual([b.id])
  })
  it('enforces revisions, idempotency and forgotten facts', async () => {
    const requestId = randomUUID(), input = { requestId, scope: 'agent' as const, agentId: a.id, content: '旧事实', tier: 'profile' as const }
    const memory = await knowledge.writeMemory(owner, input)
    expect(await knowledge.writeMemory(owner, input)).toEqual(memory)
    await expect(knowledge.writeMemory(owner, { ...input, content: '不同事实' })).rejects.toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
    await expect(knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: memory.id, expectedRevision: 0, content: '新事实' })).rejects.toThrowError(expect.objectContaining({ code: 'memory_revision_conflict' }))
    const edited = await knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), id: memory.id, expectedRevision: memory.revision, content: '新事实' })
    expect(edited.revision).toBe(2)
    await knowledge.forget(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, id: edited.id, expectedRevision: edited.revision })
    expect(await knowledge.memories(owner, { scope: 'agent', agentId: a.id })).toEqual([])
    expect((await knowledge.revisions(owner, { scope: 'agent', agentId: a.id }, edited.id)).at(-1)?.operation).toBe('write')
    await expect(knowledge.writeMemory(owner, { ...input, requestId: randomUUID(), automatic: true, content: '新事实' })).rejects.toThrowError(expect.objectContaining({ code: 'memory_forgotten' }))
    expect([...removed].some(uri => uri.includes('/memories/yaoyao/agent/'))).toBe(true)
    expect([...files.keys()].some(uri => uri.includes('/tombstones/'))).toBe(true)
  })
  it('uses context without falling back to local files', async () => {
    await knowledge.writeMemory(owner, { requestId: randomUUID(), scope: 'agent', agentId: a.id, content: '上下文事实', tier: 'profile' })
    const context = await knowledge.context(owner, a.id)
    expect(context.text).toContain('上下文事实')
    expect(context.text).toContain('来源 Bot')
    expect(existsSync(join(home, 'bot-workspace', owner, 'agents', a.id, 'memory', 'profile.md'))).toBe(false)
  })
})
