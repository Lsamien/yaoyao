// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCredentialVaultClient, LocalCredentialVaultClient } from '../../src/server/credentialVault/localClient'

const homes: string[] = [], clients: LocalCredentialVaultClient[] = []
const session = 'a'.repeat(64), password = 'DUMMY-local-master-only', secret = 'DUMMY-local-website-secret'
function client(home = mkdtempSync(join(tmpdir(), 'yaoyao-local-vault-'))) {
  if (!homes.includes(home)) homes.push(home)
  const value = new LocalCredentialVaultClient(home); clients.push(value)
  return { home, value, call: (command: string, body?: unknown, owner = 'dummy-owner', binding = session) => value.call(owner, binding, command, body) }
}
afterEach(async () => { clients.splice(0).forEach(c => c.close()); await Promise.resolve(); homes.splice(0).forEach(h => rmSync(h, { recursive: true, force: true })) })

it('provides encrypted local CRUD by default without an external service or Bot executor', async () => {
  const f = client()
  expect(await f.call('status')).toMatchObject({ online: true, initialized: false, unlocked: false, execution: 'disabled', storageMode: 'local' })
  await f.call('initialize', { password })
  await expect(f.call('add', {})).rejects.toMatchObject({ code: 'vault_locked' })
  await f.call('unlock', { password })
  const entry = await f.call('add', { name: 'Dummy website', username: 'dummy', target: { kind: 'website', origin: 'https://example.test' }, secret })
  expect(entry).not.toHaveProperty('secret')
  const stored = readdirSync(join(f.home, 'credential-vault')).filter(name => name.endsWith('.vault')).map(name => readFileSync(join(f.home, 'credential-vault', name), 'utf8')).join('')
  expect(stored).not.toContain(secret); expect(stored).not.toContain(password); expect(stored).not.toContain('Dummy website')
  expect((await f.call('status')).entries).toHaveLength(1)
  await expect(f.call('grant', {})).rejects.toMatchObject({ code: 'vault_executor_not_enabled' })
  await expect(f.call('execute', {})).rejects.toMatchObject({ code: 'vault_executor_not_enabled' })
  await f.call('update', { id: entry.id, entry: { name: 'Updated', username: 'dummy', target: entry.target, revision: entry.revision } })
  expect((await f.call('status')).entries[0].name).toBe('Updated')
  await f.call('remove', { id: entry.id }); expect((await f.call('status')).entries).toEqual([])
})

it('isolates accounts and login sessions and starts locked after a server restart', async () => {
  const f = client(); await f.call('initialize', { password }); await f.call('unlock', { password })
  await f.call('add', { name: 'Dummy', username: 'dummy', target: { kind: 'website', origin: 'https://example.test' }, secret })
  expect(await f.call('status', undefined, 'another-owner')).toMatchObject({ initialized: false, entries: [] })
  expect(await f.call('status', undefined, 'dummy-owner', 'b'.repeat(64))).toMatchObject({ unlocked: false, entries: [] })
  await expect(f.call('add', {}, 'dummy-owner', 'b'.repeat(64))).rejects.toMatchObject({ code: 'vault_locked' })
  f.value.close(); await Promise.resolve()
  const restarted = client(f.home)
  expect(await restarted.call('status')).toMatchObject({ initialized: true, unlocked: false, entries: [] })
  await restarted.call('unlock', { password }); expect((await restarted.call('status')).entries).toHaveLength(1)
})

it('keeps an explicitly configured but unavailable private broker offline', async () => {
  const c = createCredentialVaultClient({ socket: '/missing/socket', tokenFile: '/missing/token', hermesUid: process.getuid!() + 1 }, '/unused')
  expect(c).not.toBeInstanceOf(LocalCredentialVaultClient)
  await expect(c.call('owner', session, 'status')).rejects.toMatchObject({ code: 'vault_offline' })
  c.close()
})

it('prevents concurrent brokers from writing the same local vault', async () => {
  const first = client(); await first.call('initialize', { password })
  const second = client(first.home)
  await expect(second.call('status')).rejects.toMatchObject({ code: 'vault_offline' })
  first.value.close(); await Promise.resolve()
  expect(await second.call('status')).toMatchObject({ initialized: true, unlocked: false })
})
