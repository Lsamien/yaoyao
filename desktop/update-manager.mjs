import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
export async function githubDownload(url, fetchImpl, signal) {
  for (let redirect = 0; redirect < 6; redirect++) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !hosts.has(parsed.hostname)) throw new Error('安装包下载地址不受信任')
    const response = await fetchImpl(parsed.href, { redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('安装包下载重定向无效')
      url = new URL(location, parsed).href; continue
    }
    if (!response.ok) throw new Error(`安装包下载返回 HTTP ${response.status}`)
    return response
  }
  throw new Error('安装包下载重定向过多')
}
async function fileHash(path, signal) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('安装包缓存不是普通文件')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return { size: stat.size, hash: hash.digest('hex') }
}
function assertDigest(digest, actual) {
  if (digest && digest !== `sha256:${actual}`) throw new Error('GitHub 附件摘要与下载内容不一致')
}

export class DesktopUpdateManager {
  constructor({ version, arch = process.arch, platform = process.platform, cacheRoot, inspect, compare, source, fetchImpl = fetch,
    verifyImage = (path, signal) => promisify(execFile)('/usr/bin/hdiutil', ['verify', path], { timeout: 120000, signal, maxBuffer: 1024 * 1024 }) }) {
    Object.assign(this, { version, arch, platform, cacheRoot, inspect, compare, source, fetchImpl, verifyImage })
    this.state = { phase: 'idle', currentVersion: version, arch, message: '点击检查更新', available: false, received: 0, total: 0 }
  }
  snapshot() { return { ...this.state } }
  get busy() { return !!this.controller }
  cancel() { this.controller?.abort() }
  async check() {
    if (this.busy) return this.snapshot()
    const controller = this.controller = new AbortController()
    this.file = undefined; this.release = undefined
    this.state = { ...this.state, phase: 'checking', available: false, latestVersion: undefined, notes: '', releasePageUrl: undefined, message: '正在检查 GitHub 稳定版本…', error: undefined, received: 0, total: 0 }
    try {
      const release = await this.inspect(this.source, this.fetchImpl, controller.signal)
      controller.signal.throwIfAborted()
      this.release = release
      const version = release.manifest.webVersion
      this.asset = release.assets.find(asset => asset.name === `Yaoyao-${version}-${this.arch}.dmg`)
      this.checksum = release.assets.find(asset => asset.name === 'SHA256SUMS.txt')
      const newer = this.compare(version, this.version) > 0
      const supported = this.platform === 'darwin' && ['arm64', 'x64'].includes(this.arch)
        && this.asset?.size > 0 && this.asset.size <= 2 * 1024 ** 3 && this.checksum?.size <= 65536
      this.state = { ...this.state, phase: 'checked', latestVersion: version, notes: release.notes, releasePageUrl: release.releasePageUrl,
        available: Boolean(newer && supported), total: supported ? this.asset.size : 0,
        message: !newer ? '当前 App 已是最新版本' : supported ? `发现 App ${version}，可下载后手动安装` : '此版本缺少适用的安装包或校验文件，请查看发布页' }
    } catch (error) { this.failure(error, controller.signal) }
    finally { this.controller = undefined }
    return this.snapshot()
  }
  failure(error, signal) {
    this.state = { ...this.state, phase: signal.aborted ? 'cancelled' : 'failed',
      message: signal.aborted ? '已取消，可重新检查或下载' : '操作未完成，可重试', error: signal.aborted ? undefined : error.message }
  }
  async download() {
    if (this.busy || !this.state.available || !this.asset || !this.checksum) return this.snapshot()
    const controller = this.controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)])
    const directory = join(this.cacheRoot, this.release.manifest.webVersion)
    const path = join(directory, this.asset.name), partial = join(directory, `${randomUUID()}.part`)
    this.file = undefined
    this.state = { ...this.state, phase: 'downloading', received: 0, error: undefined, message: '正在下载并核对安装包…' }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const sums = await githubDownload(this.checksum.url, this.fetchImpl, signal)
      const chunks = []; let size = 0
      for await (const chunk of sums.body) {
        size += chunk.length
        if (size > 65536 || size > this.checksum.size) throw new Error('校验文件大小无效')
        chunks.push(Buffer.from(chunk))
      }
      if (size !== this.checksum.size) throw new Error('校验文件下载不完整')
      const bytes = Buffer.concat(chunks)
      assertDigest(this.checksum.digest, createHash('sha256').update(bytes).digest('hex'))
      const matches = bytes.toString('utf8').split(/\r?\n/).map(line => line.match(/^([a-fA-F0-9]{64}) [ *](.+)$/))
        .filter(match => match && match[2] === this.asset.name)
      if (matches.length !== 1) throw new Error('校验文件缺少唯一的安装包 SHA-256')
      const expected = matches[0][1].toLowerCase()
      assertDigest(this.asset.digest, expected)
      let cached
      try { cached = await fileHash(path, signal) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!cached || cached.size !== this.asset.size || cached.hash !== expected) {
        const response = await githubDownload(this.asset.url, this.fetchImpl, signal)
        const file = await open(partial, 'wx', 0o600), hash = createHash('sha256')
        let received = 0
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted(); received += chunk.length
            if (received > this.asset.size) throw new Error('安装包大小超过发布声明')
            hash.update(chunk)
            let offset = 0
            while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten
            this.state = { ...this.state, received }
          }
          if (received !== this.asset.size || hash.digest('hex') !== expected) throw new Error('安装包大小或 SHA-256 校验失败')
        } finally { await file.close() }
        this.state = { ...this.state, phase: 'verifying', message: '正在验证 DMG 完整性…' }
        await this.verifyImage(partial, signal); signal.throwIfAborted()
        await rename(partial, path)
      } else {
        this.state = { ...this.state, phase: 'verifying', message: '正在重新验证缓存安装包…' }
        await this.verifyImage(path, signal); signal.throwIfAborted()
      }
      this.file = { path, hash: expected, size: this.asset.size }
      this.state = { ...this.state, phase: 'ready', received: this.asset.size, message: '校验通过。打开安装包后手动拖入“应用程序”完成安装。' }
    } catch (error) { this.failure(error, controller.signal) }
    finally { await rm(partial, { force: true }).catch(() => {}); this.controller = undefined }
    return this.snapshot()
  }
  async verifiedFile() {
    if (this.busy || !this.file || this.state.phase !== 'ready') throw new Error('请先下载并验证安装包')
    const actual = await fileHash(this.file.path)
    if (actual.hash !== this.file.hash || actual.size !== this.file.size) {
      this.file = undefined; this.state = { ...this.state, phase: 'failed', message: '缓存安装包已改变，请重新下载' }
      throw new Error(this.state.message)
    }
    return this.file.path
  }
}
