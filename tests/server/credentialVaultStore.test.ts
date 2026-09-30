// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVaultStore } from '../../src/server/credentialVault/store'
const homes: string[] = [], stores: CredentialVaultStore[] = []
const owner = 'fixture-owner', password = 'dummy-master-password-only'
const secret = 'DUMMY-DO-NOT-USE-website-password'
const input = { name: 'fixture site', username: 'fixture-user', target: { kind: 'website' as const, origin: 'https://example.test' }, secret }
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-vault-store-')); homes.push(home)
  const store = await CredentialVaultStore.create(home); stores.push(store); return { store, home }
}
afterEach(() => { stores.splice(0).forEach(s => s.lockAll()); homes.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
it('starts locked, encrypts entries and exposes metadata only; restart requires manual unlock', async () => {
  const { store, home } = await fixture()
  expect(store.initialize(owner, password)).toMatchObject({ initialized: true, unlocked: false })
  expect(() => store.add(owner, input)).toThrowError(expect.objectContaining({ code: 'vault_locked' }))
  store.unlock(owner, password); const entry = store.add(owner, input)
  expect(entry).not.toHaveProperty('secret')
  const file = readdirSync(home)[0]!, bytes = readFileSync(join(home, file), 'utf8')
  expect(bytes).not.toContain(secret); expect(bytes).not.toContain(input.username); expect(bytes).not.toContain(password)
  expect(readdirSync(home)).toHaveLength(1) // No co-located key file.
  const restarted = await CredentialVaultStore.create(home); stores.push(restarted)
  expect(restarted.state(owner).unlocked).toBe(false)
  expect(() => restarted.unlock(owner, 'wrong-dummy-password')).toThrowError(expect.objectContaining({ code: 'vault_unlock_failed' }))
  expect(() => restarted.unlock(owner, password)).toThrowError(expect.objectContaining({ code: 'vault_unlock_throttled' }))
  expect(store.withSecret(owner, entry.id, e => e.secret)).toBe(secret)
})
it('binds encrypted payload to owner, vault ID, revision and KDF metadata', async () => {
  const { store, home } = await fixture(); store.initialize(owner, password)
  const path = join(home, readdirSync(home)[0]!), original = JSON.parse(readFileSync(path, 'utf8'))
  for (const mutate of [(e: any) => e.id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', (e: any) => e.revision++, (e: any) => e.kdf.salt = Buffer.alloc(16).toString('base64')]) {
    const e = structuredClone(original); mutate(e); writeFileSync(path, JSON.stringify(e), { mode: 0o600 })
    const probe = await CredentialVaultStore.create(home); stores.push(probe)
    expect(() => probe.unlock(owner, password)).toThrowError(expect.objectContaining({ code: 'vault_unlock_failed' }))
  }
})
it('uses fresh nonces, enforces entry revisions and atomically rotates the DEK and wrapping password', async () => {
  const { store, home } = await fixture(); store.initialize(owner, password); store.unlock(owner, password)
  const first = store.add(owner, input), path = join(home, readdirSync(home)[0]!), before = JSON.parse(readFileSync(path, 'utf8'))
  const next = store.update(owner, first.id, { ...input, secret: undefined, revision: 1 })
  expect(next.revision).toBe(2)
  expect(() => store.update(owner, first.id, { ...input, revision: 1 })).toThrowError(expect.objectContaining({ code: 'vault_revision_conflict' }))
  expect(JSON.parse(readFileSync(path, 'utf8')).payload.nonce).not.toBe(before.payload.nonce)
  store.rotate(owner, 'dummy-replacement-password')
  expect(store.state(owner).unlocked).toBe(false)
  store.unlock(owner, 'dummy-replacement-password')
  expect(store.withSecret(owner, first.id, e => e.secret)).toBe(secret)
  store.remove(owner, first.id); expect(store.list(owner)).toEqual([])
})
it('verifies encrypted backups, rejects owner changes and restores without retaining unlock', async () => {
  const { store } = await fixture(); store.initialize(owner, password); store.unlock(owner, password)
  const entry = store.add(owner, input), archive = store.backup(owner), { store: destination } = await fixture()
  expect(archive).not.toContain(secret)
  expect(() => destination.restore('another-owner', archive, password)).toThrowError(expect.objectContaining({ code: 'vault_backup_owner' }))
  destination.restore(owner, archive, password); expect(destination.state(owner).unlocked).toBe(false)
  destination.unlock(owner, password); expect(destination.withSecret(owner, entry.id, e => e.secret)).toBe(secret)
})
it('locks on a fixed deadline and preserves the old decryptable file if rotation is interrupted before rename', async () => {
  const { store, home } = await fixture(); store.initialize(owner, password)
  let now = 1000, fail = false
  const guarded = await CredentialVaultStore.create(home, () => now, () => { if (fail) throw new Error('dummy write interruption') }); stores.push(guarded)
  guarded.unlock(owner, password, 30); guarded.add(owner, input); const original = guarded.backup(owner)
  fail = true; expect(() => guarded.rotate(owner, 'dummy-new-master-password')).toThrow('dummy write interruption')
  expect(guarded.state(owner).unlocked).toBe(false);guarded.unlock(owner,password,30)
  expect(guarded.backup(owner)).toBe(original); expect(readdirSync(home)).toHaveLength(1)
  now += 30000; expect(guarded.state(owner).unlocked).toBe(false)
  fail = false; guarded.unlock(owner, password); expect(guarded.list(owner)).toHaveLength(1)
})
it('encrypts fixed SFTP contents, never returns them, retains a blank edit and revokes policy changes',async()=>{
  const {store,home}=await fixture();store.initialize(owner,password);store.unlock(owner,password)
  const ssh={name:'dummy',username:'dummy',secret:'DUMMY-key',target:{kind:'ssh',host:'127.0.0.1',port:22,hostKey:'SHA256:'+'A'.repeat(43)}}
  const body='DUMMY-fixed-private-file-body',e=store.add(owner,{...ssh,usage:{kind:'sftp.write',remotePath:'/approved/new.txt',contents:body}})
  expect(e.usage).toEqual({kind:'sftp.write',remotePath:'/approved/new.txt',bytes:Buffer.byteLength(body)})
  expect(JSON.stringify(store.list(owner))).not.toContain(body);expect(store.backup(owner)).not.toContain(body)
  let revoked=0;store.onLock=()=>revoked++
  const edit=store.update(owner,e.id,{...ssh,secret:undefined,revision:1,usage:{kind:'sftp.write',remotePath:'/approved/other.txt'}})
  expect(edit.usage).toMatchObject({bytes:Buffer.byteLength(body)});expect(store.withSecret(owner,e.id,x=>x.usage)).toMatchObject({contents:body});expect(revoked).toBe(1)
  for(const value of [{kind:'ssh.exec',command:'/bin/sh -c id'},{kind:'sftp.read',remotePath:'/approved/../outside',maxBytes:10}])expect(()=>store.update(owner,e.id,{...ssh,revision:2,usage:value})).toThrowError(expect.objectContaining({code:'vault_invalid_request'}))
  expect(readFileSync(join(home,readdirSync(home).find(v=>v.endsWith('.vault'))!),'utf8')).not.toContain(body)
})
