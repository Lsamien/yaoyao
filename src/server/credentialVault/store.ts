import sodium from 'libsodium-wrappers-sumo'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { HttpError } from '../errors.js'
import { entryInput, updateInput, storedEntry, parse, masterPassword, type VaultEntry } from './schema.js'
import type { CredentialSummary } from '../../shared/credentialVault.js'
import { readPrivateUtf8 } from './privateFiles.js'

const MAX_BYTES = 2 * 1024 * 1024
const bytes = z.string().max(MAX_BYTES).regex(/^[A-Za-z0-9+/]*={0,2}$/)
const envelopeSchema = z.object({
  format: z.literal('yaoyao-credential-vault'), version: z.literal(1),
  owner: z.string().min(1).max(256), id: z.string().uuid(), revision: z.number().int().positive(),
  kdf: z.object({ algorithm: z.literal('argon2id13'), salt: bytes, ops: z.literal(3), memory: z.literal(67108864) }).strict(),
  wrapping: z.object({ nonce: bytes, ciphertext: bytes }).strict(),
  payload: z.object({ nonce: bytes, ciphertext: bytes }).strict(),
}).strict()
type Envelope = z.infer<typeof envelopeSchema>
const documentSchema = z.object({ entries: z.array(storedEntry).max(256) }).strict()
const encode = (value: Uint8Array) => sodium.to_base64(value, sodium.base64_variants.ORIGINAL)
const decode = (value: string, length?: number) => {
  const data = sodium.from_base64(value, sodium.base64_variants.ORIGINAL)
  if (length !== undefined && data.length !== length) throw new Error('invalid envelope')
  return data
}
const wipe = (value?: Uint8Array) => { if (value) sodium.memzero(value) }
function aad(e: Envelope, part: 'key' | 'entries') {
  return JSON.stringify(['yaoyao-credential-vault', e.version, e.owner, e.id, part,
    ...(part === 'key' ? [e.kdf] : [e.revision])])
}
function encrypt(value: Uint8Array, key: Uint8Array, associated: string) {
  const nonce = sodium.randombytes_buf(24)
  return { nonce: encode(nonce), ciphertext: encode(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(value, associated, null, nonce, key)) }
}
function decrypt(value: Envelope['payload'], key: Uint8Array, associated: string) {
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, decode(value.ciphertext), associated, decode(value.nonce, 24), key)
}
function derive(password: string, e: Envelope) {
  const data = sodium.from_string(masterPassword(password))
  try { return sodium.crypto_pwhash(32, data, decode(e.kdf.salt, 16), e.kdf.ops, e.kdf.memory, sodium.crypto_pwhash_ALG_ARGON2ID13) }
  finally { wipe(data) }
}
const summary = ({ secret: _secret, passphrase: _passphrase, usage, ...entry }: VaultEntry): CredentialSummary => ({...entry,...(usage?{usage:usage.kind==='sftp.write'?{kind:usage.kind,remotePath:usage.remotePath,bytes:Buffer.byteLength(usage.contents)}:usage}:{})})

/** This belongs in an independently isolated broker. No file/OS-account key is created.
 * JS strings/GC and WASM are not a secure enclave; same-UID process access must be
 * prevented by deployment. Restart discards the DEK and always starts locked. */
export class CredentialVaultStore {
  private unlocked = new Map<string, { envelope: Envelope; key: Uint8Array; entries: VaultEntry[]; until: number }>()
  private failures = new Map<string, { count: number; next: number }>()
  readonly root: string
  onLock: (owner: string) => void = () => {}
  constructor(root: string, private now = Date.now, private beforeRename?: () => void) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const stat = lstatSync(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('密码库目录必须为当前服务身份的私有目录')
  }
  static async create(root: string, now = Date.now, beforeRename?: () => void) {
    await sodium.ready
    return new CredentialVaultStore(root, now, beforeRename)
  }
  private path(owner: string) {
    parse(z.string().min(1).max(256), owner)
    return join(this.root, createHash('sha256').update(owner).digest('hex') + '.vault')
  }
  private load(owner: string): Envelope | undefined {
    const path = this.path(owner)
    try {
      const e = parse(envelopeSchema, JSON.parse(readPrivateUtf8(path, MAX_BYTES)))
      if (e.owner !== owner) throw new Error()
      return e
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new HttpError(409, '密码库文件无效或权限不安全', 'vault_corrupt')
    }
  }
  private save(e: Envelope) {
    const value = JSON.stringify(e)
    if (Buffer.byteLength(value) > MAX_BYTES) throw new HttpError(413, '密码库已达到大小上限', 'vault_size_limit')
    const path = this.path(e.owner), temp = path + '.' + randomUUID() + '.tmp'
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
      this.beforeRename?.()
      renameSync(temp, path)
      const directory = openSync(this.root, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally { rmSync(temp, { force: true }) }
  }
  private active(owner: string) {
    const session = this.unlocked.get(owner)
    if (session && session.until <= this.now()) this.lock(owner)
    const current = this.unlocked.get(owner)
    if (!current) throw new HttpError(423, '密码库已锁定，请在密码管理界面手动解锁', 'vault_locked')
    return current
  }
  state(owner: string) {
    const s = this.unlocked.get(owner)
    if (s && s.until <= this.now()) this.lock(owner)
    const current = this.unlocked.get(owner)
    return { initialized: !!this.load(owner), unlocked: !!current, ...(current ? { unlockExpiresAt: current.until } : {}) }
  }
  private decodeDocument(e: Envelope, key: Uint8Array) {
    const data = decrypt(e.payload, key, aad(e, 'entries'))
    try { return parse(documentSchema, JSON.parse(sodium.to_string(data))).entries }
    finally { wipe(data) }
  }
  private encodeDocument(e: Envelope, key: Uint8Array, entries: VaultEntry[]) {
    const data = sodium.from_string(JSON.stringify({ entries }))
    try { return { ...e, payload: encrypt(data, key, aad(e, 'entries')) } }
    finally { wipe(data) }
  }
  initialize(owner: string, password: string) {
    if (this.load(owner)) throw new HttpError(409, '密码库已存在', 'vault_exists')
    const key = sodium.randombytes_buf(32)
    const e: Envelope = { format: 'yaoyao-credential-vault', version: 1, owner, id: randomUUID(), revision: 1,
      kdf: { algorithm: 'argon2id13', salt: encode(sodium.randombytes_buf(16)), ops: 3, memory: 67108864 },
      wrapping: { nonce: '', ciphertext: '' }, payload: { nonce: '', ciphertext: '' } }
    let kek: Uint8Array | undefined
    try {
      kek = derive(password, e); e.wrapping = encrypt(key, kek, aad(e, 'key'))
      this.save(this.encodeDocument(e, key, []))
    } finally { wipe(kek); wipe(key) }
    return this.state(owner) // Creation does not silently unlock.
  }
  unlock(owner: string, password: string, seconds = 300) {
    parse(z.number().int().min(30).max(900), seconds)
    if ((this.failures.get(owner)?.next ?? 0) > this.now()) throw new HttpError(429, '解锁尝试过多，请稍后重试', 'vault_unlock_throttled')
    const e = this.load(owner)
    if (!e) throw new HttpError(404, '请先创建密码库', 'vault_missing')
    this.lock(owner)
    let kek: Uint8Array | undefined, key: Uint8Array | undefined
    try {
      kek = derive(password, e); key = decrypt(e.wrapping, kek, aad(e, 'key'))
      if (key.length !== 32) throw new Error()
      const entries = this.decodeDocument(e, key)
      this.unlocked.set(owner, { envelope: e, key, entries, until: this.now() + seconds * 1000 })
      key = undefined; this.failures.delete(owner)
    } catch {
      const count = (this.failures.get(owner)?.count ?? 0) + 1
      this.failures.set(owner, { count, next: this.now() + Math.min(60000, 1000 * 2 ** Math.min(count - 1, 6)) })
      throw new HttpError(401, '主密码错误或备份已损坏', 'vault_unlock_failed')
    } finally { wipe(kek); wipe(key) }
    return this.state(owner)
  }
  lock(owner: string) {
    const session = this.unlocked.get(owner)
    this.unlocked.delete(owner); wipe(session?.key)
    if (session) { session.entries.length = 0; this.onLock(owner) }
  }
  lockAll() { for (const owner of [...this.unlocked.keys()]) this.lock(owner) }
  list(owner: string) { return this.active(owner).entries.map(summary) }
  private commit(owner: string, entries: VaultEntry[]) {
    const s = this.active(owner)
    const next = this.encodeDocument({ ...s.envelope, revision: s.envelope.revision + 1 }, s.key, entries)
    try { this.save(next); s.envelope = next; s.entries = entries }
    catch (error) { this.lock(owner); throw error } // A rename may have happened before a failed directory fsync.
  }
  add(owner: string, value: unknown) {
    const s = this.active(owner), input = parse(entryInput, value)
    if (s.entries.length >= 256) throw new HttpError(413, '凭据数量已达到上限', 'vault_entry_limit')
    const entry = { ...input, id: randomUUID(), revision: 1, updatedAt: this.now() }
    this.commit(owner, [...s.entries, entry]); return summary(entry)
  }
  update(owner: string, id: string, value: unknown) {
    const s = this.active(owner), input = parse(updateInput, value), old = s.entries.find(v => v.id === id)
    if (!old) throw new HttpError(404, '凭据不存在', 'vault_entry_missing')
    if (old.revision !== input.revision) throw new HttpError(409, '凭据已变化，请刷新', 'vault_revision_conflict')
    const changedUsage=input.usage?.kind==='sftp.write'?{...input.usage,contents:input.usage.contents??(old.usage?.kind==='sftp.write'?old.usage.contents:undefined)}:input.usage??old.usage
    const next = parse(storedEntry,{ ...old, ...input,usage:changedUsage, secret: input.secret ?? old.secret, revision: old.revision + 1, updatedAt: this.now() })
    this.commit(owner, s.entries.map(v => v.id === id ? next : v)); this.onLock(owner)
    return summary(next)
  }
  remove(owner: string, id: string) {
    const s = this.active(owner)
    if (!s.entries.some(v => v.id === id)) throw new HttpError(404, '凭据不存在', 'vault_entry_missing')
    this.commit(owner, s.entries.filter(v => v.id !== id)); this.onLock(owner)
  }
  /** Only the isolated executor callback may receive this. No read-secret RPC exists. */
  withSecret<T>(owner: string, id: string, use: (entry: Readonly<VaultEntry>) => T): T {
    const s = this.active(owner), entry = s.entries.find(v => v.id === id)
    if (!entry) throw new HttpError(404, '凭据不存在', 'vault_entry_missing')
    return use(entry)
  }
  backup(owner: string) {
    this.active(owner)
    return JSON.stringify(this.load(owner))
  }
  restore(owner: string, archive: string, password: string) {
    if (this.load(owner)) throw new HttpError(409, '恢复需要尚未初始化的密码库，不能覆盖现有数据', 'vault_exists')
    if (Buffer.byteLength(archive) > MAX_BYTES) throw new HttpError(413, '备份过大', 'vault_size_limit')
    const e = parse(envelopeSchema, JSON.parse(archive))
    if (e.owner !== owner) throw new HttpError(403, '备份不属于当前账号', 'vault_backup_owner')
    let kek: Uint8Array | undefined, key: Uint8Array | undefined
    try { kek = derive(password, e); key = decrypt(e.wrapping, kek, aad(e, 'key')); this.decodeDocument(e, key); this.save(e) }
    catch { throw new HttpError(400, '备份无法验证，原密码库未改变', 'vault_backup_invalid') }
    finally { wipe(kek); wipe(key) }
    return this.state(owner)
  }
  rotate(owner: string, password: string) {
    const s = this.active(owner), key = sodium.randombytes_buf(32)
    const next = { ...s.envelope, revision: s.envelope.revision + 1,
      kdf: { ...s.envelope.kdf, salt: encode(sodium.randombytes_buf(16)) } }
    let kek: Uint8Array | undefined
    try {
      kek = derive(password, next); next.wrapping = encrypt(key, kek, aad(next, 'key'))
      this.save(this.encodeDocument(next, key, s.entries))
      this.lock(owner)
    } catch (error) { this.lock(owner); throw error }
    finally { wipe(kek); wipe(key) }
  }
}
