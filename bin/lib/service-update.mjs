import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { DatabaseSync } from 'node:sqlite'
import { readJSON, readRuntime, syncDecision, verifyRuntimePackage } from './runtime-release.mjs'
import { backupData, databaseSchema, legacyDataIdle, restoreData } from './service-data.mjs'
import { normalizeReleaseSource } from './release-source.mjs'

const sleep = ms => new Promise(done => setTimeout(done, ms))
export const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
export function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, path)
}
export function updateMutex(home) {
  mkdirSync(join(home, 'updates'), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(home, 'updates', 'mutex.sqlite3'))
  chmodSync(join(home, 'updates', 'mutex.sqlite3'), 0o600)
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
  catch { db.close(); throw new Error('已有系统更新正在执行，请稍后重试') }
  return () => db.close()
}
export function reserveUpdate(home, jobID) {
  const path = join(home, 'updates', 'active.lock')
  if (existsSync(path)) {
    const lock = readJSON(path)
    if (Number.isSafeInteger(lock.pid) && alive(lock.pid)) throw new Error('已有系统更新正在执行，请稍后重试')
    // Called only while the common SQLite update mutex is held.
    rmSync(path)
  }
  writeFileSync(path, JSON.stringify({ jobID, pid: process.pid }), { flag: 'wx', mode: 0o600 })
  return () => { if (existsSync(path) && readJSON(path).jobID === jobID) rmSync(path) }
}
export function localRequest(url, token, method = 'GET') {
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) || target.username || target.password)
    throw new Error('升级只支持已核对的本机服务')
  return new Promise((done, reject) => {
    const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method, agent: false, headers: token ? { 'x-yaoyao-desktop-token': token } : {},
    }, res => {
      let data = ''
      res.on('data', bytes => { data += bytes; if (data.length > 128 * 1024) req.destroy(new Error('服务响应过大')) })
      res.on('end', () => { try { done({ status: res.statusCode, body: JSON.parse(data) }) } catch { reject(new Error('本地服务响应无效')) } })
    })
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('本地服务请求超时'))); req.end()
  })
}
function command(bin, args, input) {
  try { return execFileSync(bin, args, { encoding: 'utf8', input, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch { throw new Error(`${bin.split('/').at(-1)} ${args[0]} 未完成`) }
}
export function currentRelease(releaseRoot) {
  const path = join(releaseRoot, 'current')
  if (!existsSync(path)) return undefined
  if (!lstatSync(path).isSymbolicLink()) throw new Error('发布目录 current 必须是符号链接')
  return realpathSync(path)
}
export function switchRelease(releaseRoot, target) {
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
  releaseRoot = realpathSync(releaseRoot)
  if (target) target = realpathSync(target)
  const path = join(releaseRoot, 'current')
  if (existsSync(path) && !lstatSync(path).isSymbolicLink()) throw new Error('拒绝替换非符号链接发布目录')
  if (!target) { rmSync(path, { force: true }); return }
  const temp = join(releaseRoot, `.current-${randomUUID()}`)
  symlinkSync(relative(releaseRoot, target), temp); renameSync(temp, path)
}
export class LaunchAgentService {
  constructor({ home, port = 15300, releaseRoot, label = 'com.samien.hermes-yaoyao', plistPath, environment = {} }) {
    this.home = realpathSync(home); this.port = port; this.releaseRoot = resolve(releaseRoot)
    this.label = label; this.domain = `gui/${process.getuid()}`
    this.plistPath = plistPath ?? join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
    this.environment = environment
  }
  snapshot() {
    if (!existsSync(this.plistPath)) {
      // Never install a second service over an unregistered listener or owner.
      if (this.listeners().size || this.record()) throw new Error('已有服务未注册为此 App 的本机后台服务，暂不接管')
      return undefined
    }
    const plist = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', this.plistPath]))
    const env = plist.EnvironmentVariables ?? {}, root = realpathSync(plist.WorkingDirectory)
    this.tls = Boolean(env.HERMES_YAOYAO_TLS_CERT)
    if (plist.Label !== this.label || realpathSync(env.HERMES_YAOYAO_HOME ?? join(homedir(), '.hermes-yaoyao')) !== this.home || Number(env.HERMES_YAOYAO_PORT ?? 15300) !== this.port)
      throw new Error('已有服务的数据目录或端口与 App 不一致，暂不接管')
    const args = plist.ProgramArguments
    if (!Array.isArray(args) || args.length !== 2 || !['server.mjs', 'dist-server/server/index.js'].some(entry => realpathSync(args[1]) === join(root, entry)))
      throw new Error('已有服务的启动入口无法核对')
    readRuntime(root)
    const pid = this.pid(), listeners = this.listeners()
    if (listeners.size && (listeners.size !== 1 || !listeners.has(pid))) throw new Error('端口由另一个进程占用，暂不接管')
    if (pid) {
      const holders = this.holders(join(this.home, 'workspace.sqlite3'))
      if (!holders.has(pid)) throw new Error('无法确认现有服务的数据归属')
    }
    return { plist, root, wasRunning: Boolean(pid) }
  }
  pid() {
    try { return Number(execFileSync('launchctl', ['print', `${this.domain}/${this.label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/^\s*pid = (\d+)$/m)?.[1]) || undefined }
    catch { return undefined }
  }
  holders(path) {
    try { return new Set(execFileSync('/usr/sbin/lsof', ['-t', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).map(Number)) }
    catch { return new Set() }
  }
  listeners(established = false) {
    const pid = established ? this.pid() : undefined
    if (established && !pid) return new Set()
    try { return new Set(execFileSync('/usr/sbin/lsof', [...(pid ? ['-a', '-p', String(pid)] : []), '-nP', `-iTCP:${this.port}`, '-sTCP:' + (established ? 'ESTABLISHED' : 'LISTEN'), '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/).map(Number)) }
    catch { return new Set() }
  }
  record() {
    try {
      const value = readJSON(join(this.home, 'service-instance.json'))
      return value.protocol === 1 && value.dataKey === createHash('sha256').update(this.home).digest('hex') && Number.isSafeInteger(value.pid) && alive(value.pid) ? value : undefined
    } catch { return undefined }
  }
  url(record = this.record()) {
    if (!record?.url) return `${this.tls ? 'https' : 'http'}://127.0.0.1:${this.port}`
    const url = new URL(record.url)
    if (Number(url.port) !== this.port) throw new Error('本机服务端口发生变化')
    if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
    return url.origin
  }
  async quiesce(onProgress, timeout = 60000) {
    if (!this.pid()) return
    const deadline = Date.now() + timeout
    do {
      const record = this.record()
      if (record?.maintenanceProtocol === 1) {
        if (record.pid !== this.pid()) throw new Error('服务进程归属发生变化')
        const response = await localRequest(`${this.url(record)}/desktop/service/quiesce`, record.token, 'POST')
        if (response.status === 200 && response.body.quiesced === true) return
        if (response.status !== 409) throw new Error('服务未接受更新准备请求')
      } else if (legacyDataIdle(this.home) && !this.listeners(true).size) {
        return
      }
      onProgress('正在等待聊天和后台任务结束后同步 Web…')
      if (Date.now() >= deadline) break
      await sleep(1000)
    } while (Date.now() < deadline)
    throw Object.assign(new Error('当前仍有任务或旧版客户端连接，已延后同步；任务结束并关闭其他客户端后可重试'), { code: 'service_busy' })
  }
  async resume() {
    const record = this.record()
    if (record?.maintenanceProtocol === 1) await localRequest(`${this.url(record)}/desktop/service/quiesce`, record.token, 'DELETE').catch(() => {})
  }
  async stop() {
    const pid = this.pid()
    try { execFileSync('launchctl', ['print', `${this.domain}/${this.label}`], { stdio: 'ignore' }); command('launchctl', ['bootout', `${this.domain}/${this.label}`]) }
    catch (error) { if (this.pid()) throw error }
    const deadline = Date.now() + 15000
    while (pid && alive(pid) && Date.now() < deadline) await sleep(100)
    if ((pid && alive(pid)) || this.listeners().size || this.holders(join(this.home, 'workspace.sqlite3')).size)
      throw new Error('后台服务尚未完全停止，操作未完成')
  }
  writePlist(plist) {
    plist.EnvironmentVariables ??= {}
    plist.EnvironmentVariables.HERMES_YAOYAO_RELEASE_SOURCE = normalizeReleaseSource(plist.EnvironmentVariables.HERMES_YAOYAO_RELEASE_SOURCE)
    mkdirSync(dirname(this.plistPath), { recursive: true })
    const xml = command('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], JSON.stringify(plist))
    const temporary = `${this.plistPath}.${randomUUID()}`
    writeFileSync(temporary, xml, { mode: 0o600 }); renameSync(temporary, this.plistPath)
  }
  async boot() {
    let loaded = false
    try { execFileSync('launchctl', ['print', `${this.domain}/${this.label}`], { stdio: 'ignore' }); loaded = true } catch { /* Not registered yet. */ }
    if (loaded) { command('launchctl', ['kickstart', `${this.domain}/${this.label}`]); return }
    const deadline = Date.now() + 20000
    for (;;) {
      try { command('launchctl', ['bootstrap', this.domain, this.plistPath]); return }
      catch (error) { if (Date.now() >= deadline) throw error; await sleep(500) }
    }
  }
  async start(root, previous) {
    const stable = join(this.releaseRoot, 'current')
    const node = existsSync(join(root, 'node')) ? join(root, 'node') : previous?.plist.ProgramArguments[0] ?? process.execPath
    const plist = previous ? structuredClone(previous.plist) : {
      Label: this.label, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10, ProcessType: 'Interactive', Umask: 63,
      StandardOutPath: join(this.home, 'service.log'), StandardErrorPath: join(this.home, 'service.log'),
      EnvironmentVariables: { PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HERMES_YAOYAO_HOST: '127.0.0.1', ...this.environment },
    }
    plist.ProgramArguments = [node, join(stable, existsSync(join(root, 'server.mjs')) ? 'server.mjs' : 'dist-server/server/index.js')]
    plist.WorkingDirectory = stable
    Object.assign(plist.EnvironmentVariables, { NODE_ENV: 'production', HERMES_YAOYAO_HOME: this.home, HERMES_YAOYAO_PORT: String(this.port),
      HERMES_YAOYAO_SERVICE_ROOT: stable, HERMES_YAOYAO_RELEASE_ROOT: this.releaseRoot, HERMES_YAOYAO_DESKTOP: '0',
      HERMES_YAOYAO_STATIC_DIR: join(stable, existsSync(join(root, 'ui')) ? 'ui' : 'dist') })
    delete plist.EnvironmentVariables.ELECTRON_RUN_AS_NODE
    this.writePlist(plist); await this.boot()
  }
  async restore(previous) {
    if (!previous) { rmSync(this.plistPath, { force: true }); return }
    this.writePlist(previous.plist)
    if (previous.wasRunning && !this.pid()) await this.boot()
  }
  async verify(expected, timeout = 45000) {
    const deadline = Date.now() + timeout
    do {
      try {
        const record = this.record(), url = this.url(record)
        if (record?.build && record.pid === this.pid()) {
          const identity = await localRequest(`${url}/desktop/service`, record.token)
          const actual = identity.body
          if (identity.status !== 200 || actual.instanceId !== record.instanceId || actual.pid !== record.pid || actual.dataKey !== record.dataKey) throw new Error('实例不匹配')
          if (expected && (actual.version !== expected.version || actual.build.commit !== expected.commit || (expected.artifactDigest && actual.build.artifactDigest !== expected.artifactDigest))) throw new Error('运行构建不匹配')
        } else if (expected?.hasBuildIdentity || expected?.artifactDigest || !this.pid()) throw new Error('新构建尚未就绪')
        const health = await localRequest(`${url}/healthz`)
        const status = await localRequest(`${url}/api/status`)
        if (health.status === 200 && health.body.ok && status.status === 200 && status.body.server_kind === 'yaoyao-web') return
      } catch { /* Startup and launchd recovery can take a moment. */ }
      await sleep(300)
    } while (Date.now() < deadline)
    throw new Error('新服务的构建、健康或接口核验失败')
  }
}

export async function recoverTransition({ home, releaseRoot, driver, onProgress = () => {} }) {
  const path = join(home, 'updates', 'transition.json')
  if (!existsSync(path)) return
  const journal = readJSON(path)
  if (journal.home !== realpathSync(home) || journal.releaseRoot !== resolve(releaseRoot)) throw new Error('未完成更新的归属不一致')
  onProgress('正在恢复上一次未完成的更新…')
  if (journal.phase !== 'restored') {
    await driver.stop()
    if (journal.snapshot) restoreData(home, journal.snapshot)
    switchRelease(releaseRoot, journal.previousCurrent)
    const success = join(home, 'updates', 'last-success.json')
    if (journal.previousSuccess) writeJSON(success, journal.previousSuccess)
    else rmSync(success, { force: true })
    journal.phase = 'restored'; writeJSON(path, journal)
  }
  await driver.restore(journal.previous)
  if (journal.previous?.wasRunning) await driver.verify(undefined)
  rmSync(path)
  await driver.resume()
}
export async function transitionService({ home, releaseRoot, driver, finalRoot, onProgress = () => {}, rollback = false, waitForIdleMs }) {
  const previous = driver.snapshot(), previousCurrent = currentRelease(releaseRoot)
  const path = join(home, 'updates', 'transition.json'), id = randomUUID()
  const success = join(home, 'updates', 'last-success.json')
  const journal = { id, home: realpathSync(home), releaseRoot: resolve(releaseRoot), previous, previousCurrent, finalRoot,
    previousSuccess: existsSync(success) ? readJSON(success) : undefined }
  const expected = readRuntime(finalRoot)
  try {
    if (previous?.wasRunning) await driver.verify(undefined, 5000)
    await driver.quiesce(onProgress, waitForIdleMs)
    onProgress('正在备份数据并切换 Web 服务…')
    // Persist before stopping; recovery never mistakes a partial backup for a complete snapshot.
    writeJSON(path, journal)
    await driver.stop()
    journal.snapshot = join(home, 'updates', 'backups', id)
    let beforeSchema
    try { beforeSchema = backupData(home, journal.snapshot) }
    catch (error) { rmSync(journal.snapshot, { recursive: true, force: true }); throw error }
    writeJSON(path, journal)
    switchRelease(releaseRoot, finalRoot)
    await driver.start(finalRoot, previous)
    onProgress('正在核对 Web 构建及服务状态…')
    await driver.verify(expected)
    const afterSchema = databaseSchema(home)
    // The new process rejects application traffic until the durable journal is removed.
    const result = { previousCurrentTarget: previousCurrent, previousServiceRoot: previous?.root, previous,
      finalRoot, commit: expected.commit, target: expected.release, snapshot: journal.snapshot, beforeSchema, afterSchema }
    if (!rollback) writeJSON(join(home, 'updates', 'last-success.json'), result)
    rmSync(path)
    await driver.resume()
    return result
  } catch (error) {
    if (existsSync(path)) {
      try { await recoverTransition({ home, releaseRoot, driver, onProgress }) }
      catch (recovery) { throw new Error(`${error.message}；恢复未完成：${recovery.message}`) }
    } else await driver.resume()
    throw error
  }
}

export async function synchronizeDesktop({ home, runtimeRoot, releaseRoot, driver, onProgress = () => {} }) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const unlock = updateMutex(home), id = randomUUID()
  let release
  try {
    release = reserveUpdate(home, id)
    await recoverTransition({ home, releaseRoot, driver, onProgress })
    onProgress('正在核对 App 配套 Web 服务…')
    const target = verifyRuntimePackage(runtimeRoot)
    const marker = join(home, 'updates', 'desktop-sync.json')
    const previous = driver.snapshot(), current = previous ? readRuntime(previous.root) : undefined
    if (existsSync(marker) && readJSON(marker).artifactDigest === target.artifactDigest && previous) {
      if (!previous.wasRunning) { driver.writePlist(previous.plist); await driver.boot() }
      await driver.verify(undefined)
      return { action: 'already-synced', current }
    }
    const decision = syncDecision(target, current)
    if (decision === 'unknown') throw new Error('App 与 Web 的构建先后关系无法确定，已保留当前服务；请使用明确的新发布版本')
    if (decision === 'same' || decision === 'newer') {
      if (!previous.wasRunning) { driver.writePlist(previous.plist); await driver.boot() }
      await driver.verify(undefined)
      writeJSON(marker, { artifactDigest: target.artifactDigest, action: decision, completedAt: new Date().toISOString() })
      return { action: decision, current }
    }
    const finalRoot = join(releaseRoot, 'releases', `${target.version}-${target.artifactDigest.slice(0, 16)}`)
    if (!existsSync(finalRoot)) {
      const staging = join(releaseRoot, 'releases', `.staging-${id}`)
      mkdirSync(dirname(staging), { recursive: true, mode: 0o700 })
      try { cpSync(runtimeRoot, staging, { recursive: true }); verifyRuntimePackage(staging); chmodSync(join(staging, 'node'), 0o755); renameSync(staging, finalRoot) }
      finally { rmSync(staging, { recursive: true, force: true }) }
    }
    verifyRuntimePackage(finalRoot)
    await transitionService({ home, releaseRoot, driver, finalRoot, onProgress, waitForIdleMs: 0 })
    writeJSON(marker, { artifactDigest: target.artifactDigest, action: decision, completedAt: new Date().toISOString() })
    return { action: decision, current: target }
  } finally { release?.(); unlock() }
}

/** Explicit native Stop command. It never changes the release or user data,
 * and unloads the verified LaunchAgent so KeepAlive cannot restart it. */
export async function stopDesktopService({home,driver,onProgress=()=>{}}) {
  const unlock=updateMutex(home)
  let release
  try {
    release=reserveUpdate(home,randomUUID())
    if(existsSync(join(home,'updates','transition.json')))throw new Error('系统更新尚未完成，请完成更新后再停止后台服务')
    const previous=driver.snapshot()
    if(!previous)return {action:'stopped'}
    if(previous.wasRunning)await driver.verify(undefined,5000)
    onProgress('正在停止后台任务与虚拟机…')
    await driver.stop()
    onProgress('后台服务已停止')
    return {action:'stopped'}
  } finally {release?.();unlock()}
}
