import { open, realpath, mkdir, mkdtemp, unlink, rename, link, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const CHUNK = 512 * 1024, HARD_LIMIT = 100 * 1024 * 1024, TTL = 10 * 60 * 1000
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const require = (value, message) => { if (!value) throw new Error(message) }

/** Bounded, replay-safe file operations shared by native desktops and runner hosts. */
export class FileTransferFiles {
  constructor(root, { confined = true } = {}) {
    this.root = root; this.confined = confined; this.transfers = new Map(); this.lanes = new Map(); this.closed = false
    this.timer = setInterval(() => { void this.expire() }, 60000); this.timer.unref()
  }
  async path(input, writing = false) {
    require(typeof input === 'string' && input.length > 0 && input.length <= 4096 && !input.includes('\0'), '文件路径无效')
    const root = await realpath(this.root), raw = resolve(root, input.replace(/^~\//, '').replace(/^~$/, ''))
    const inside = value => !this.confined || value === root || value.startsWith(root + sep)
    require(inside(raw), '路径超出允许范围')
    if (!writing) { const file = await realpath(raw); require(inside(file), '路径超出允许范围'); return file }
    let parent = dirname(raw)
    for (;;) {
      try { const existing = await realpath(parent); require(inside(existing), '路径超出允许范围'); break }
      catch (error) { if (error.code !== 'ENOENT') throw error; const next = dirname(parent); require(next !== parent, '目标目录不存在'); parent = next }
    }
    await mkdir(dirname(raw), { recursive: true })
    const directory = await realpath(dirname(raw)); require(inside(directory), '路径超出允许范围')
    try { require(inside(await realpath(raw)), '路径超出允许范围') } catch (error) { if (error.code !== 'ENOENT') throw error }
    return join(directory, raw.slice(dirname(raw).length + 1))
  }
  async call(action, authorize = () => {}) {
    require(validId(action?.transferId), '传输编号无效')
    const id = action.transferId, previous = this.lanes.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.perform(action, authorize))
    this.lanes.set(id, next)
    try { return await next } finally { if (this.lanes.get(id) === next) this.lanes.delete(id) }
  }
  async perform(action, authorize) {
    authorize(); require(!this.closed, '传输通道已关闭')
    const id = action.transferId
    let item = this.transfers.get(id)
    if (item && item.expiresAt <= Date.now()) { await this.dispose(id); item = undefined }
    const check = () => { authorize(); require(!this.closed, '传输通道已关闭'); if (item) item.expiresAt = Date.now() + TTL }
    if (action.op === 'transfer-abort') { await this.dispose(id); return { ok: true } }
    if (action.op === 'transfer-read-open' || action.op === 'transfer-write-open') {
      require(Number.isSafeInteger(action.maxBytes) && action.maxBytes >= 1024 * 1024 && action.maxBytes <= HARD_LIMIT, '传输大小上限无效')
      const signature = JSON.stringify(action)
      if (item) { require(item.signature === signature, '传输编号已用于其他文件'); return item.metadata }
      require(this.transfers.size < 64, '传输任务过多，请稍后重试')
      const writing = action.op === 'transfer-write-open', file = await this.path(action.path, writing)
      check()
      if (writing) {
        require(Number.isSafeInteger(action.size) && action.size >= 0 && action.size <= action.maxBytes, '文件超过传输大小上限')
        require(typeof action.overwrite === 'boolean' && /^[a-f0-9]{64}$/.test(action.sha256), '传输校验参数无效')
        const temporary = join(dirname(file), `.yaoyao-transfer-${id}`), handle = await open(temporary, 'wx+', 0o600)
        item = { kind: 'write', signature, handle, temporary, file, metadata: { path: action.path, size: action.size, sha256: action.sha256 }, received: 0, overwrite: action.overwrite, expiresAt: Date.now() + TTL }
        this.transfers.set(id, item)
      } else {
        const source = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
        let directory, handle
        try {
          const stat = await source.stat(); require(stat.isFile(), '来源不是普通文件'); require(stat.size <= action.maxBytes, '文件超过传输大小上限')
          directory = await mkdtemp(join(tmpdir(), 'yaoyao-transfer-'))
          const temporary = join(directory, 'source'); handle = await open(temporary, 'wx+', 0o600)
          const buffer = Buffer.alloc(CHUNK), sha = createHash('sha256'); let size = 0
          for (;;) {
            check(); const { bytesRead } = await source.read(buffer, 0, buffer.length, null); if (!bytesRead) break
            size += bytesRead; require(size <= action.maxBytes, '文件超过传输大小上限')
            const chunk = buffer.subarray(0, bytesRead); sha.update(chunk); await handle.writeFile(chunk)
          }
          check()
          item = { kind: 'read', signature, handle, directory, temporary, metadata: { path: action.path, size, sha256: sha.digest('hex') }, expiresAt: Date.now() + TTL }
          this.transfers.set(id, item)
        } catch (error) { await handle?.close(); if (directory) await rm(directory, { recursive: true, force: true }); throw error }
        finally { await source.close() }
      }
      check(); return item.metadata
    }
    require(item, '文件传输已过期，请重新发起')
    if (action.op === 'transfer-status') return { ...item.metadata, complete: item.kind === 'complete', received: item.received ?? 0 }
    if (action.op === 'transfer-read') {
      require(item.kind === 'read' && Number.isSafeInteger(action.offset) && action.offset >= 0 && action.offset <= item.metadata.size, '文件分块位置无效')
      const bytes = Buffer.alloc(Math.min(CHUNK, item.metadata.size - action.offset)); const { bytesRead } = await item.handle.read(bytes, 0, bytes.length, action.offset)
      require(bytesRead === bytes.length, '来源文件分块不完整'); check()
      return { offset: action.offset, data: bytes.toString('base64') }
    }
    if (action.op === 'transfer-append') {
      require(item.kind === 'write' && Number.isSafeInteger(action.offset) && action.offset >= 0 && action.offset <= item.received, '文件分块顺序无效')
      require(typeof action.data === 'string' && action.data.length <= Math.ceil(CHUNK / 3) * 4, '文件分块过大')
      const bytes = Buffer.from(action.data, 'base64'); require(bytes.length > 0 && bytes.length <= CHUNK && bytes.toString('base64') === action.data && action.offset + bytes.length <= item.metadata.size, '文件分块内容无效')
      if (action.offset < item.received) {
        require(action.offset + bytes.length <= item.received, '文件分块重叠')
        const saved = Buffer.alloc(bytes.length); const result = await item.handle.read(saved, 0, saved.length, action.offset)
        require(result.bytesRead === saved.length && saved.equals(bytes), '重复分块内容不一致')
      } else {
        let offset = 0
        while (offset < bytes.length) { check(); const { bytesWritten } = await item.handle.write(bytes, offset, bytes.length - offset, action.offset + offset); require(bytesWritten > 0, '文件写入失败'); offset += bytesWritten }
        item.received += bytes.length
      }
      check(); return { received: item.received }
    }
    if (action.op === 'transfer-finish') {
      if (item.kind === 'complete') return { ...item.metadata, complete: true }
      require(item.kind === 'write' && item.received === item.metadata.size, '文件尚未接收完整')
      await item.handle.sync()
      const sha = createHash('sha256'), bytes = Buffer.alloc(CHUNK); let offset = 0
      while (offset < item.received) { check(); const { bytesRead } = await item.handle.read(bytes, 0, Math.min(bytes.length, item.received - offset), offset); require(bytesRead > 0, '文件写入不完整'); sha.update(bytes.subarray(0, bytesRead)); offset += bytesRead }
      require(sha.digest('hex') === item.metadata.sha256, '目标文件校验失败')
      require(await this.path(item.metadata.path, true) === item.file, '目标目录已变化')
      check()
      if (item.overwrite) await rename(item.temporary, item.file)
      else await link(item.temporary, item.file).catch(error => { if (error.code === 'EEXIST') throw new Error('目标文件已存在，未覆盖'); throw error })
      // Mark committed before cleanup: a lost response must never cause a second write.
      item.kind = 'complete'
      await item.handle.close(); item.handle = undefined
      await unlink(item.temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      return { ...item.metadata, complete: true }
    }
    throw new Error('文件传输操作无效')
  }
  async dispose(id) {
    const item = this.transfers.get(id); if (!item) return
    this.transfers.delete(id)
    await item.handle?.close().catch(() => {})
    if (item.directory) await rm(item.directory, { recursive: true, force: true })
    else if (item.temporary) await unlink(item.temporary).catch(() => {})
  }
  async expire() { for (const [id, item] of this.transfers) if (item.expiresAt <= Date.now() && !this.lanes.has(id)) await this.dispose(id) }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.lanes.values()]); for (const id of this.transfers.keys()) await this.dispose(id) }
}
