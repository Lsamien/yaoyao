// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RealtimeReceipts } from '../../src/server/realtimeReceipts'
import { RealtimeBroker, type RealtimePrincipal } from '../../src/server/realtimeBroker'

let home: string, receipts: RealtimeReceipts
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-receipt-recovery-'))
  receipts = new RealtimeReceipts(home)
})
afterEach(() => { receipts.close(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })

it('retains owner-scoped deduplication after result expiry and database reopen', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
  receipts.reserve('alice', 'prompt-1', 'private prompt')
  receipts.finish('alice', 'prompt-1', 'confirmed', { result: { status: 'submitted' } })
  now.mockReturnValue(100_000 + 86_400_001)
  receipts.reserve('alice', 'new-command', '{}')
  receipts.close(); receipts = new RealtimeReceipts(home)
  expect(receipts.lookup('alice', 'prompt-1')).toEqual({ requestId: 'prompt-1', state: 'unknown' })
  expect(receipts.reserve('alice', 'prompt-1', 'private prompt')).toMatchObject({ state: 'unknown' })
  expect(() => receipts.reserve('alice', 'prompt-1', 'changed payload')).toThrow('payload conflict')
  expect(receipts.lookup('bob', 'prompt-1')).toBeUndefined()
  expect(receipts.reserve('bob', 'prompt-1', 'private prompt')).toBeUndefined()
  for (const file of ['realtime-receipts.sqlite3', 'realtime-receipts.sqlite3-wal']) {
    expect(readFileSync(join(home, file)).includes(Buffer.from('private prompt'))).toBe(false)
  }
})

it('does not call the executor a second time after expired results are compacted', async () => {
  receipts.close()
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
  const broker = new RealtimeBroker(home)
  const perform = vi.fn(async () => ({ result: { status: 'submitted' } }))
  Object.assign(broker, { perform })
  const principal: RealtimePrincipal = { key: 'alice', upstreamKey: 'mock', paired: false,
    valid: () => true, url: async () => { throw new Error('No network allowed') } }
  try {
    const channel = { kind: 'chat', principal } as Parameters<RealtimeBroker['command']>[0]
    const frame = { method: 'prompt.submit', params: { session_id: 'runtime', text: 'do work' } }
    await broker.command(channel, 'prompt-1', frame)
    now.mockReturnValue(100_000 + 86_400_001)
    await broker.command(channel, 'new-prompt', frame)
    // Simulate losing the process-local full response, as on a restart.
    Object.assign(broker, { completed: new Map() })
    expect(await broker.command(channel, 'prompt-1', frame)).toMatchObject({ state: 'unknown' })
    expect(perform).toHaveBeenCalledTimes(2)
  } finally {
    broker.close()
    await Promise.resolve()
    receipts = new RealtimeReceipts(home)
  }
})

it.each(['file.attach', 'image.attach_bytes', 'pdf.attach'])('restores %s references without persisting attachment contents', method => {
  const id = method.replaceAll('.', '_')
  receipts.reserve('alice', id, '{}')
  receipts.finish('alice', id, 'confirmed', { result: {
    path: '/files/upload', image_path: '/images/upload', ref_path: 'upload', ref_text: '@file:upload',
    content: 'private bytes', content_base64: 'private bytes', text: 'private bytes',
  } }, { method })
  receipts.close(); receipts = new RealtimeReceipts(home)
  expect(receipts.lookup('alice', id)?.response?.result).toEqual({
    path: '/files/upload', image_path: '/images/upload', ref_path: 'upload', ref_text: '@file:upload',
  })
})

it('restores model confirmation metadata only for allowed configuration keys', () => {
  receipts.reserve('alice', 'model', '{}')
  receipts.finish('alice', 'model', 'confirmed', { result: {
    value: 'model --provider provider', deferred: false, confirm_required: true,
    confirm_message: 'Please confirm', warning: 'Cost warning', api_key: 'private key',
  } }, { method: 'config.set', params: { key: 'model' } })
  receipts.close(); receipts = new RealtimeReceipts(home)
  expect(receipts.lookup('alice', 'model')?.response?.result).toEqual({
    value: 'model --provider provider', deferred: false, confirm_required: true,
    confirm_message: 'Please confirm', warning: 'Cost warning',
  })
  receipts.reserve('alice', 'unrelated', '{}')
  receipts.finish('alice', 'unrelated', 'confirmed', { result: { value: 'private key', path: '/private' } },
    { method: 'config.set', params: { key: 'api_key' } })
  expect(receipts.lookup('alice', 'unrelated')?.response?.result).toEqual({})
})

it('does not persist unbounded recovery strings', () => {
  receipts.reserve('alice', 'large', '{}')
  receipts.finish('alice', 'large', 'confirmed', { result: { path: 'x'.repeat(4097) } }, { method: 'file.attach' })
  expect(receipts.lookup('alice', 'large')?.response?.result).toEqual({})
})
