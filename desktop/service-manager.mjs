import { readFile, realpath, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const dataKey = root => createHash('sha256').update(root).digest('hex')

export function localJSON(url, headers = {}, method = 'GET', timeout = 1500) {
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password)
    return Promise.reject(new Error('桌面服务必须使用本机回环地址。'))
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers, agent: false }, res => {
      let body = '', bytes = 0
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 64 * 1024) req.destroy(new Error('服务身份响应过大'))
        else body += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`服务返回 HTTP ${res.statusCode}`)); return }
        try { resolve(JSON.parse(body)) } catch { reject(new Error('服务返回了无效响应')) }
      })
    })
    req.setTimeout(timeout, () => req.destroy(new Error('服务连接超时')))
    req.on('error', reject); req.end()
  })
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}

/** One owner for a packaged service child. Existing services are connected to,
 * never stopped. All callbacks are fenced to their exact child generation. */
export class DesktopServiceManager {
  constructor(options) {
    this.options = options
    this.state = { phase: 'stopped', message: '本地服务尚未启动' }
    this.child = null
    this.generation = 0
    this.stopping = false
    this.restarts = []
  }
  publish(value) {
    if (value.phase === 'ready' && this.updateNotice) value = { ...value, updateNotice: this.updateNotice, message: `${value.message}，Web 同步待完成` }
    this.state = value; this.options.onState?.(value)
  }
  get canForceSynchronization() {
    return Boolean(this.options.synchronize) && (this.state.canForceSync === true || this.state.phase === 'ready' && this.state.version === this.options.version)
  }
  async retrySynchronization({ force = false } = {}) {
    if (this.starting) return this.starting
    if (force && !this.canForceSynchronization) throw new Error('当前状态不能覆盖同版本 Web')
    this.state = { phase: 'stopped', message: '正在准备同步 Web…' }
    return this.start({ force })
  }
  async reconnect() {
    const generation=this.generation
    if (this.state.phase === 'ready' && !this.stopping) {
      await this.check()
      if(this.stopping||generation!==this.generation)return this.state
    }
    if (this.state.phase === 'ready' && !this.stopping) return this.state
    clearTimeout(this.restartTimer)
    return this.start()
  }
  async readRecord() {
    try {
      const r = JSON.parse(await readFile(join(this.root, 'service-instance.json'), 'utf8'))
      return r.protocol === 1 && r.dataKey === dataKey(this.root) && isAlive(r.pid) ? r : null
    } catch { return null }
  }
  async verify(record) {
    if (!record.url) throw new Error('服务尚未监听')
    const url = new URL(record.url)
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
    const actual = await localJSON(new URL('/desktop/service', url), { 'x-yaoyao-desktop-token': record.token })
    if (actual.protocol !== 1 || actual.instanceId !== record.instanceId || actual.pid !== record.pid || actual.dataKey !== dataKey(this.root) || actual.version !== record.version || typeof actual.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(actual.version))
      throw new Error('服务身份与本地数据不匹配')
    if (this.child?.pid === actual.pid && actual.version !== this.options.version) throw new Error('App 内置服务版本不匹配，请重新安装完整 App')
    return { ...actual, url: url.origin }
  }
  async legacyService() {
    // Old CLI/LaunchAgent builds lack the new descriptor. Prove the listener
    // actually holds this directory's SQLite file before reusing its own UI.
    if (process.platform !== 'darwin') return null
    const pids = async args => {
      try { return new Set((await exec('/usr/sbin/lsof', args, { timeout: 3000 })).stdout.trim().split(/\s+/).filter(Boolean)) }
      catch { return new Set() }
    }
    const [holders, listeners] = await Promise.all([
      pids(['-t', join(this.root, 'workspace.sqlite3')]),
      pids(['-nP', `-iTCP:${this.options.port}`, '-sTCP:LISTEN', '-t']),
    ])
    if (!holders.size) return null
    if (holders.size !== 1 || !listeners.has([...holders][0])) throw new Error('数据目录正在被另一个服务使用，请先确认已有服务。')
    const url = `http://127.0.0.1:${this.options.port}`
    const status = await localJSON(new URL('/api/status', url))
    if (status.server_kind !== 'yaoyao-web') throw new Error('已有端口不是夭夭服务。')
    return { url, pid: Number([...holders][0]), external: true, legacy: true, version: '已有服务' }
  }
  async start({ force = false } = {}) {
    if (this.starting) return this.starting
    if (this.state.phase === 'ready' && !this.stopping) return this.state
    this.stopping = false
    this.starting = this.boot({ force }).finally(() => { this.starting = null })
    return this.starting
  }
  async boot({ force = false } = {}) {
    const generation = ++this.generation
    this.publish({ phase: 'starting', stage: 'checking', message: '正在检查本地服务…' })
    try {
      await this.options.prepareHome?.(message => this.publish({ phase: 'starting', stage: 'checking', message }))
      await mkdir(this.options.home, { recursive: true, mode: 0o700 })
      this.root = await realpath(this.options.home)
      this.updateNotice = undefined
      if (this.options.synchronize) {
        try { await this.options.synchronize(message => this.publish({ phase: 'starting', stage: 'installing', message }), { force }) }
        catch (error) {
          // Busy is reported before stopping or switching. Other failures still
          // fail closed; the existing service must pass the usual identity checks.
          if (error.code !== 'service_busy') throw error
          this.updateNotice = error.message
        }
        if (generation !== this.generation || this.stopping) return
      }
      this.publish({ phase: 'starting', stage: 'starting', message: '正在启动并检查服务…' })
      let record = await this.readRecord()
      if (generation !== this.generation || this.stopping) return
      if (record?.url) {
        const service = await this.verify(record)
        if (generation !== this.generation || this.stopping) return
        this.publish({ phase: 'ready', message: `已连接已有服务（${service.version}）`, ...service, external: !this.child })
        return this.state
      }
      const legacy = !record ? await this.legacyService() : null
      if (generation !== this.generation || this.stopping) return
      if (legacy) { this.publish({ phase: 'ready', message: '已连接已有后台服务', ...legacy }); return this.state }
      if (!record) {
        if (this.options.synchronize) throw new Error('独立后台服务尚未就绪，请稍后重试')
        const child = this.options.fork({ home: this.root, port: this.options.port })
        child.desktopExited = false
        this.child = child
        child.stdout?.on('data', b => this.options.log?.(String(b)))
        child.stderr?.on('data', b => this.options.log?.(String(b)))
        child.once('exit', code => {
          child.desktopExited = true
          if (this.child !== child) return
          this.child = null
          if (this.stopping || this.state.phase === 'starting') return
          this.options.log?.(`服务进程退出：${code}`)
          this.scheduleRestart(this.generation)
        })
      }
      const deadline = Date.now() + (this.options.timeoutMs ?? 30_000)
      let lastError
      while (Date.now() < deadline && !this.stopping && generation === this.generation) {
        record = await this.readRecord()
        if (record?.url) {
          try {
            const service = await this.verify(record)
            if (this.child && service.pid !== this.child.pid) throw new Error('服务启动期间归属发生变化')
            if (generation !== this.generation || this.stopping) return
            this.publish({ phase: 'ready', message: '本地服务已就绪', ...service, external: !this.child })
            return this.state
          } catch (e) { lastError = e }
        }
        if (!this.child && !record) throw new Error('服务进程未能启动，请查看日志后重试。')
        await sleep(100)
      }
      if (!this.stopping) throw new Error(lastError?.message || '服务启动超时，请查看日志后重试。')
    } catch (error) {
      if (generation !== this.generation || this.stopping) return
      await this.stopChild()
      this.publish({ phase: 'error', message: error.message, canForceSync: error.code === 'service_build_unknown' })
      throw error
    }
  }
  scheduleRestart(generation) {
    const now = Date.now()
    this.restarts = this.restarts.filter(time => now - time < 5 * 60_000)
    if (this.restarts.length >= (this.options.synchronize ? 12 : 3)) { this.publish({ phase: 'error', message: '服务多次断开，请查看日志后重试。' }); return }
    this.restarts.push(now)
    this.publish({ phase: 'restarting', message: '服务已断开，正在恢复…' })
    this.restartTimer = setTimeout(() => {
      if (this.stopping || generation !== this.generation) return
      void this.start().catch(() => { if (this.options.synchronize && !this.stopping) this.scheduleRestart(this.generation) })
    }, this.options.synchronize ? 5000 : 500 * this.restarts.length)
  }
  async check() {
    if (this.state.phase !== 'ready') return
    const generation = this.generation
    try {
      if (this.state.legacy) {
        if (!isAlive(this.state.pid)) throw new Error('已有服务已停止')
        await localJSON(new URL('/api/status', this.state.url))
      } else {
        const record = await this.readRecord()
        if (!record) throw new Error('服务已停止')
        const service = await this.verify(record)
        if (service.pid !== this.state.pid || service.version !== this.state.version || service.build?.commit !== this.state.build?.commit)
          this.publish({ phase: 'ready', message: `已连接后台服务（${service.version}）`, ...service, external: !this.child })
      }
    } catch {
      if (this.stopping || generation !== this.generation) return
      if (this.state.external) this.scheduleRestart(generation)
      else this.publish({ phase: 'error', message: '本地服务连接已断开，请重试。' })
    }
  }
  async stopChild() {
    const child = this.child
    if (!child || child.desktopExited) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    const record = await this.readRecord()
    if (record?.pid === child.pid && record.desktopOwned) {
      try { await localJSON(new URL('/desktop/service', record.url), { 'x-yaoyao-desktop-token': record.token }, 'DELETE') }
      catch { /* Owned process handle remains authoritative for cleanup. */ }
    } else child.kill()
    let timer
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve() }, 5000) })])
    clearTimeout(timer)
    if (!child.desktopExited) {
      await Promise.race([exited, sleep(2000)])
      if (!child.desktopExited && child.pid) {
        try { process.kill(child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
        await Promise.race([exited, sleep(2000)])
      }
      if (!child.desktopExited) throw new Error('旧服务进程尚未确认退出，暂不启动替代进程。')
    }
    if (this.child === child) this.child = null
  }
  async stop() {
    const owned = Boolean(this.child)
    this.stopping = true
    clearTimeout(this.restartTimer)
    ++this.generation
    await this.starting?.catch(() => {})
    await this.stopChild()
    this.publish(owned ? { phase: 'stopped', message: '后台服务已停止' }
      : { phase: 'disconnected', message: 'App 已断开后台连接' })
  }
  async stopBackground() {
    this.stopping = true
    clearTimeout(this.restartTimer)
    ++this.generation
    await this.starting?.catch(() => {})
    this.publish({phase:'stopping',message:'正在停止后台服务…'})
    try {
      if(this.options.stopBackground)await this.options.stopBackground(message=>this.publish({phase:'stopping',message}))
      else if(this.child)await this.stopChild()
      else throw new Error('此后台服务不由本 App 管理，请在它的启动位置停止')
      this.publish({phase:'stopped',message:'后台服务已停止'})
    } catch(error) {
      this.publish({phase:'error',message:'后台服务停止未完成，请重新连接检查'})
      throw error
    }
  }
}
