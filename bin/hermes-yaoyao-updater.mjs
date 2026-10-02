#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  realpathSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const label = 'com.samien.hermes-yaoyao'
import { LaunchAgentService, updateMutex, recoverTransition, switchRelease, transitionService } from './lib/service-update.mjs'
import { readRuntime } from './lib/runtime-release.mjs'
import { assertRollbackCompatible } from './lib/service-data.mjs'
import { NPM_PACKAGE, npmInstallationLocation, npmRuntimeDigest, parseNpmRelease, verifyPreparedNpmArchive } from './lib/npm-release.mjs'

const uid = process.getuid?.() ?? 501
const domain = `gui/${uid}`

function fail(message) { throw new Error(message) }

function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')) }

function writeJSON(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function validateManifest(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) fail('release.json 格式无效')
  for (const key of ['releaseVersion', 'webVersion']) {
    if (typeof value[key] !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value[key])) {
      fail(`release.json ${key} 无效`)
    }
  }
  if (value.releaseVersion !== value.webVersion || value.gitTag !== `v${value.releaseVersion}`) {
    fail('release.json 版本组合不一致')
  }
  return value
}

function updateJob(jobPath, patch) {
  const current = readJSON(jobPath)
  writeJSON(jobPath, { ...current, ...patch, updatedAt: new Date().toISOString() })
}

const COMMAND_OUTPUT_LIMIT = 6_000

function cleanCommandOutput(value) {
  if (value === undefined || value === null) return ''
  return String(value)
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, '$1***@')
    .replace(/([?&](?:access_token|token|password)=)[^&\s]+/gi, '$1***')
    .trim()
}

function outputTail(value) {
  if (value.length <= COMMAND_OUTPUT_LIMIT) return value
  return `…已省略前面的输出…\n${value.slice(-COMMAND_OUTPUT_LIMIT)}`
}

export function formatCommandFailure(command, args, error) {
  const commandLine = cleanCommandOutput([command, ...args].join(' '))
  const status = typeof error?.status === 'number'
    ? `，退出码 ${error.status}`
    : error?.signal ? `，信号 ${error.signal}` : ''
  const stdout = cleanCommandOutput(error?.stdout)
  const stderr = cleanCommandOutput(error?.stderr)
  let detail = [stdout, stderr].filter(Boolean).join('\n')
  if (!detail) {
    detail = cleanCommandOutput(error instanceof Error ? error.message : error)
      .replace(/^Command failed:[^\n]*(?:\n|$)/, '')
      .trim()
  }
  return `${commandLine} 失败${status}${detail ? `\n${outputTail(detail)}` : ''}`
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: options.timeout ?? 120_000,
      maxBuffer: 8 * 1_024 * 1_024,
    })
  } catch (error) {
    throw new Error(formatCommandFailure(command, args, error))
  }
}

function pathInside(path, parent) {
  const target = resolve(path)
  const root = resolve(parent)
  return target.startsWith(`${root}${sep}`)
}

function removeInside(path, parent) {
  if (!pathInside(path, parent)) fail(`拒绝清理非预期路径：${path}`)
  rmSync(path, { recursive: true, force: true })
}

function loaded() {
  try {
    run('launchctl', ['print', `${domain}/${label}`])
    return true
  } catch {
    return false
  }
}

function stopService() {
  if (loaded()) run('launchctl', ['bootout', `${domain}/${label}`])
}

export function currentTarget(releaseRoot) {
  const current = join(releaseRoot, 'current')
  try {
    const stat = lstatSync(current)
    if (!stat.isSymbolicLink()) fail('发布目录 current 必须是符号链接')
    return resolve(releaseRoot, readlinkSync(current))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export function switchCurrent(releaseRoot, target, token) {
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
  const current = join(releaseRoot, 'current')
  const temporary = join(releaseRoot, `.current-${token}`)
  removeInside(temporary, releaseRoot)
  symlinkSync(relative(releaseRoot, target), temporary, 'dir')
  renameSync(temporary, current)
}

function removeCurrent(releaseRoot) {
  const current = join(releaseRoot, 'current')
  try {
    if (!lstatSync(current).isSymbolicLink()) fail('拒绝删除非符号链接 current')
    rmSync(current)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function serviceEnvironment(serviceRoot, plan) {
  return {
    ...process.env,
    HERMES_YAOYAO_SERVICE_ROOT: serviceRoot,
    HERMES_YAOYAO_RELEASE_ROOT: plan.releaseRoot,
    HERMES_YAOYAO_RELEASE_SOURCE: plan.source,
    HERMES_YAOYAO_HOST: '0.0.0.0',
    HERMES_YAOYAO_ALLOW_INSECURE_LAN: '1',
  }
}

export function serviceInstallInvocation(
  serviceRoot,
  plan,
  stableRoot = true,
  lifecycleRoot = serviceRoot,
) {
  const cli = join(lifecycleRoot, 'bin', 'hermes-yaoyao.mjs')
  const env = serviceEnvironment(stableRoot ? join(plan.releaseRoot, 'current') : serviceRoot, plan)
  return { cli, env }
}

function startService(serviceRoot, plan, stableRoot = true, lifecycleRoot = serviceRoot) {
  const { cli, env } = serviceInstallInvocation(serviceRoot, plan, stableRoot, lifecycleRoot)
  if (!existsSync(cli)) fail(`服务入口不存在：${cli}`)
  run(process.execPath, [cli, 'service', 'install'], { env, timeout: 30_000 })
}

export function restorePreviousService({
  plan,
  previousCurrentTarget,
  previousServiceRoot,
  lifecycleRoot,
  token,
  switchCurrentCommand = switchCurrent,
  removeCurrentCommand = removeCurrent,
  startServiceCommand = startService,
}) {
  if (!lifecycleRoot) fail('当前发布版本不可用，无法安全执行回滚')
  if (previousCurrentTarget) {
    switchCurrentCommand(plan.releaseRoot, previousCurrentTarget, token)
    startServiceCommand(join(plan.releaseRoot, 'current'), plan, true, lifecycleRoot)
  } else {
    removeCurrentCommand(plan.releaseRoot)
    startServiceCommand(previousServiceRoot, plan, false, lifecycleRoot)
  }
}

async function responseJSON(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(3_000), cache: 'no-store' })
  if (!response.ok) fail(`${url} 返回 HTTP ${response.status}`)
  return response.json()
}

export async function verifyRuntime(timeoutMs = 45_000, fetchImpl = fetch) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      // /readyz deliberately includes 9119 reachability. Only the Web's own
      // health decides update/rollback success, including older releases.
      const health = await responseJSON('http://127.0.0.1:15300/healthz', fetchImpl)
      if (health.ok === true) return
      lastError = 'Web 服务尚未就绪'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  fail(`升级后健康检查失败：${lastError}`)
}

function stageRelease(job, jobPath) {
  const { plan, target, id } = job
  if (!target) fail('升级任务缺少目标版本')
  const releasesRoot = join(plan.releaseRoot, 'releases')
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 })
  const staging = join(releasesRoot, `.staging-${id}`)
  removeInside(staging, releasesRoot)
  updateJob(jobPath, { state: 'downloading', message: `正在下载 ${target.gitTag}` })
  run('git', ['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', target.gitTag, plan.source, staging], { timeout: 600_000 })
  const manifest = validateManifest(readJSON(join(staging, 'release.json')))
  for (const field of ['schemaVersion', 'releaseVersion', 'webVersion', 'gitTag']) {
    if (manifest[field] !== target[field]) fail('下载的发布清单与检查结果不一致')
  }
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: staging }).trim()
  if (!/^[0-9a-f]{40,64}$/.test(plan.targetCommit || '') || commit !== plan.targetCommit) {
    fail('下载提交与检查时锁定的发布提交不一致')
  }

  updateJob(jobPath, { state: 'building', message: `正在构建 Web ${target.webVersion}` })
  const buildEnvironment = { ...process.env, NODE_ENV: 'development' }
  run('npm', ['ci', '--include=dev'], { cwd: staging, env: buildEnvironment, timeout: 600_000 })
  run('npm', ['run', 'build'], { cwd: staging, env: buildEnvironment, timeout: 600_000 })
  const finalRoot = join(releasesRoot, `${target.releaseVersion}-${commit.slice(0, 12)}`)
  if (existsSync(finalRoot)) removeInside(staging, releasesRoot)
  else renameSync(staging, finalRoot)
  return { finalRoot, commit }
}

export async function stageNpmRelease(job, jobPath, { fetchImpl = fetch } = {}) {
  const { plan, target, id } = job
  validateManifest(target)
  const npm = parseNpmRelease({ name: NPM_PACKAGE, version: plan.npm?.version, dist: plan.npm })
  if (npm.version !== target.releaseVersion) fail('npm 发布信息与目标版本不一致')
  const downloads = join(plan.home, 'updates', 'npm'), staging = join(downloads, id)
  mkdirSync(downloads, { recursive: true, mode: 0o700 })
  // Only one update owns the mutex. A replacement download supersedes any
  // previous prepared archive, so temporary packages cannot accumulate.
  for (const name of readdirSync(downloads)) {
    if (/^[0-9a-f-]{36}$/.test(name)) removeInside(join(downloads, name), downloads)
  }
  mkdirSync(staging, { mode: 0o700 })
  const archive = join(staging, 'release.tgz')
  try {
    updateJob(jobPath, { state: 'downloading', message: `正在下载服务器 ${npm.version}…`, received: 0, total: 0 })
    const response = await fetchImpl(npm.tarball, { signal: AbortSignal.timeout(600000) })
    if (!response.ok || !response.body) fail(`npm 安装包下载失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0, limit = 512 * 1024 * 1024
    if (total > limit) fail('npm 安装包超过下载大小限制')
    const hash = createHash('sha512'), descriptor = openSync(archive, 'wx', 0o600)
    let received = 0, lastProgress = 0
    try {
      for await (const chunk of response.body) {
        received += chunk.length
        if (received > limit) fail('npm 安装包超过下载大小限制')
        for (let offset = 0; offset < chunk.length;) offset += writeSync(descriptor, chunk, offset, chunk.length - offset)
        hash.update(chunk)
        if (Date.now() - lastProgress > 250) {
          updateJob(jobPath, { received, total, message: total > 0 ? `正在下载服务器更新 · ${Math.min(100, Math.floor(received / total * 100))}%` : '正在下载服务器更新…' })
          lastProgress = Date.now()
        }
      }
    } finally { closeSync(descriptor) }
    if (`sha512-${hash.digest('base64')}` !== npm.integrity) fail('npm 安装包完整性校验失败，原服务保持运行')
    const prepared = { archive }
    updateJob(jobPath, { state: 'prepared', message: `服务器 ${npm.version} 已下载完成，点击“重启服务器”覆盖更新`, received, total, plan: { ...plan, prepared } })
    return prepared
  } catch (error) {
    removeInside(staging, downloads)
    throw error
  }
}

export async function overwriteNpmRelease(job, jobPath, { driver = serviceOptions(jobPath, job).driver, install = (archive, location) => run('npm', [
  'install', ...(location.global ? ['--global'] : []), '--prefix', location.prefix, '--no-save', '--package-lock=false', '--omit=dev', '--no-audit', '--no-fund', '--engine-strict', '--allow-file=all', archive,
], { cwd: location.prefix, timeout: 600000 }) } = {}) {
  const { plan, target } = job
  validateManifest(target)
  const npm = parseNpmRelease({ name: NPM_PACKAGE, version: plan.npm?.version, dist: plan.npm })
  if (npm.version !== target.releaseVersion) fail('npm 发布信息与目标版本不一致')
  const archive = verifyPreparedNpmArchive(plan.home, plan.prepared, npm)
  let stopped = false, quiescing = false
  try {
    const previous = driver.snapshot(), root = realpathSync(plan.previousServiceRoot)
    if (!previous || realpathSync(previous.root) !== root) fail('当前服务与 npm 安装目录不一致，已取消覆盖更新')
    const location = npmInstallationLocation(root), home = realpathSync(plan.home), modules = dirname(dirname(root))
    if (home === modules || pathInside(home, modules)) fail('用户数据目录位于 npm 程序目录内，已取消覆盖更新')
    if (existsSync(join(plan.home, 'updates', 'transition.json'))) fail('存在未完成的服务切换，请先处理后再覆盖更新')
    if (previous.wasRunning) await driver.verify(undefined, 5000)
    quiescing = true
    await driver.quiesce(message => updateJob(jobPath, { message }))
    updateJob(jobPath, { state: 'installing', message: '正在停止服务器并覆盖当前 npm 安装…' })
    await driver.stop(); stopped = true
    await install(archive, location)
    npmRuntimeDigest(root, npm.version)
    // Keep the same program path. No version copy, data snapshot or rollback
    // record is created for an npm overwrite.
    rmSync(join(plan.home, 'updates', 'last-success.json'), { force: true })
    switchRelease(plan.releaseRoot, root)
    updateJob(jobPath, { state: 'restarting', message: '正在启动更新后的服务器…' })
    await driver.start(root, previous)
    updateJob(jobPath, { state: 'verifying', message: '正在核对新版本和服务状态…' })
    await driver.verify(readRuntime(root))
    updateJob(jobPath, { state: 'succeeded', message: `服务器已覆盖更新到 ${target.webVersion}` })
  } catch (error) {
    if (quiescing && !stopped) await driver.resume()
    throw new Error(`${error.message}${stopped ? '；未保留旧版本，请修复当前安装后重启服务器' : ''}`)
  } finally {
    removeInside(dirname(archive), join(plan.home, 'updates', 'npm'))
  }
}

function serviceOptions(jobPath, job) {
  const home = job.plan.home || resolve(dirname(jobPath), '..')
  const options = { home, releaseRoot: job.plan.releaseRoot, port: job.plan.port || Number(process.env.HERMES_YAOYAO_PORT || 15300) }
  return { ...options, driver: new LaunchAgentService(options), onProgress: message => updateJob(jobPath, { message }) }
}

async function runUpdate(jobPath, job) {
  if (job.plan.npm) {
    if (job.plan.prepared) await overwriteNpmRelease(job, jobPath)
    else await stageNpmRelease(job, jobPath)
    return
  }
  const options = serviceOptions(jobPath, job)
  await recoverTransition(options)
  const { finalRoot } = stageRelease(job, jobPath)
  updateJob(jobPath, { state: 'installing', message: '正在准备切换 Web 服务' })
  await transitionService({ ...options, finalRoot })
  updateJob(jobPath, { state: 'succeeded', message: `已升级 Web ${job.target.webVersion}` })
}

async function runRollback(jobPath, job) {
  const options = serviceOptions(jobPath, job)
  await recoverTransition(options)
  const recordPath = join(dirname(jobPath), 'last-success.json')
  if (!existsSync(recordPath)) fail('没有可回滚的上一版本')
  const record = readJSON(recordPath)
  // Manual rollback never restores an older snapshot over data written since
  // the successful upgrade. Schema-changing releases need a separate recovery.
  assertRollbackCompatible(options.home, record)
  const finalRoot = record.previousCurrentTarget || record.previousServiceRoot
  if (!finalRoot || !existsSync(finalRoot)) fail('上一版本的程序目录已不可用')
  updateJob(jobPath, { state: 'rolling_back', message: '正在恢复上一版本' })
  await transitionService({ ...options, finalRoot, rollback: true })
  rmSync(recordPath)
  updateJob(jobPath, { state: 'rolled_back', message: '已回滚 Web 服务，保留现有数据' })
}

async function main() {
  const [, , command, flag, jobPathValue] = process.argv
  if (command !== 'run' || flag !== '--job' || !jobPathValue) fail('用法：hermes-yaoyao-updater run --job <path>')
  const jobPath = resolve(jobPathValue)
  const job = readJSON(jobPath)
  const unlock = updateMutex(job.plan.home || resolve(dirname(jobPath), '..'))
  try {
    if (job.operation === 'update') await runUpdate(jobPath, job)
    else if (job.operation === 'rollback') await runRollback(jobPath, job)
    else fail('未知升级任务类型')
  } catch (error) {
    updateJob(jobPath, {
      state: 'failed',
      message: job.operation === 'rollback' ? '回滚失败，需要人工处理' : '升级失败',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    const lockPath = join(dirname(jobPath), 'active.lock')
    try {
      const raw = readFileSync(lockPath, 'utf8').trim()
      let lockJobID = raw
      try { lockJobID = JSON.parse(raw).jobID } catch { /* legacy lock */ }
      if (lockJobID === job.id) rmSync(lockPath)
    } catch { /* already released */ }
    unlock()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
