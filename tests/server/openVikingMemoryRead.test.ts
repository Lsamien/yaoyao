// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { OpenVikingMemoryProvider } from '../../src/server/openVikingMemoryProvider'
import type { OpenVikingService } from '../../src/server/openVikingService'
import type { WorkspaceKnowledge } from '../../src/server/workspaceKnowledge'

function fixture() {
  const records = Array.from({ length: 20 }, (_, index) => ({
    schemaVersion: 1, revisions: [], memory: {
      id: index.toString(16).padStart(32, '0'), scope: 'agent', agentId: 'agent', content: `fact-${index}`,
    },
  }))
  const list = vi.fn(async () => records.map(record => `${record.memory.id}.json`))
  const read = vi.fn(async (uri: string) => JSON.stringify(records.find(record => uri.endsWith(`${record.memory.id}.json`))))
  const client = { list, read }
  const service = { enabled: true, ensureUser: vi.fn(async () => undefined), userClient: vi.fn(() => client) }
  const knowledge = { agent: vi.fn(() => ({ id: 'agent' })) }
  return { provider: new OpenVikingMemoryProvider(service as unknown as OpenVikingService, knowledge as unknown as WorkspaceKnowledge),
    records, read, list }
}

it('overlaps at most eight reads while preserving listing order and scope isolation', async () => {
  const f = fixture()
  let active = 0, peak = 0
  const release: Array<() => void> = []
  f.records[3]!.memory.agentId = 'another-agent'
  f.read.mockImplementation(async uri => {
    active++; peak = Math.max(peak, active)
    await new Promise<void>(resolve => release.push(resolve))
    active--
    return JSON.stringify(f.records.find(record => uri.endsWith(`${record.memory.id}.json`)))
  })
  const pending = f.provider.list('owner', [{ scope: 'agent', agentId: 'agent' }])
  await vi.waitFor(() => expect(release).toHaveLength(8))
  // Release batches in reverse order, forcing responses to arrive out of listing order.
  while (f.read.mock.calls.length < 20 || active) {
    release.splice(0).reverse().forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect((await pending).map(memory => memory.content)).toEqual(f.records.filter(record => record.memory.agentId === 'agent').map(record => record.memory.content))
  expect(peak).toBe(8)
  expect(f.read).toHaveBeenCalledTimes(20)
})

it('keeps upstream failures visible and continues to reject corrupt records', async () => {
  const f = fixture()
  f.read.mockRejectedValueOnce(new Error('upstream unavailable'))
  await expect(f.provider.list('owner', [{ scope: 'agent', agentId: 'agent' }])).rejects.toThrow('upstream unavailable')
  f.read.mockResolvedValueOnce('invalid JSON')
  await expect(f.provider.list('owner', [{ scope: 'agent', agentId: 'agent' }])).rejects.toMatchObject({ code: 'openviking_memory_corrupt' })
})
