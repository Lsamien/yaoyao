import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readBuildIdentity, type BuildIdentity } from './buildIdentity.js'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import type { ServerConfig } from './config.js'
import { DEFAULT_YAOYAO_RELEASE_SOURCE } from './config.js'
import { normalizeReleaseSource } from '../../bin/lib/release-source.mjs'
import { githubReleasePage, inspectGitHubRelease } from './githubReleases.js'
import {
  compareReleaseVersions,
  parseReleaseManifest,
  readReleaseManifest,
  type ReleaseManifest,
} from './releases.js'

export type UpdateJobState =
  | 'queued'
  | 'downloading'
  | 'building'
  | 'installing'
  | 'restarting'
  | 'verifying'
  | 'rolling_back'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'

export interface UpdateJob {
  id: string
  operation: 'update' | 'rollback'
  state: UpdateJobState
  message: string
  createdAt: string
  updatedAt: string
  target?: ReleaseManifest
  error?: string
}

interface UpdatePlan {
  home: string
  port: number
  source: string
  releaseRoot: string
  previousServiceRoot: string
  target?: ReleaseManifest
  targetCommit?: string
}

interface StoredUpdateJob extends UpdateJob {
  plan: UpdatePlan
}

export interface SystemUpdateStatus {
  releaseSource: string
  releasePageUrl?: string
  current: ReleaseManifest
  build?: BuildIdentity
  installationMode: 'source' | 'release' | 'desktop'
  latest?: ReleaseManifest
  updateAvailable: boolean
  supported: boolean
  unsupportedReason?: string
  canRollback: boolean
  job?: UpdateJob
}

export interface RemoteRelease {
  releasePageUrl?: string
  manifest: ReleaseManifest
  commit: string
}

type InspectRemote = (source: string, current: ReleaseManifest) => Promise<RemoteRelease | undefined>
type LaunchUpdater = (jobPath: string) => number | undefined | void

export interface SystemUpdateManagerOptions {
  projectRoot?: string
  manifestPath?: string
  updaterPath?: string
  inspectRemote?: InspectRemote
  launchUpdater?: LaunchUpdater
  platform?: NodeJS.Platform
  desktopOwned?: boolean
}

function run(command: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1_024 * 1_024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim()
        reject(detail ? new Error(detail) : error)
      }
      else resolvePromise(stdout)
    })
  })
}

export function releaseManifestURL(source: string, tag: string): URL | undefined {
  try {
    const url = new URL(source)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    url.hash = ''
    url.search = ''
    url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}/raw/${encodeURIComponent(tag)}/release.json`
    return url
  } catch {
    return undefined
  }
}

async function fetchReleaseManifest(source: string, tag: string): Promise<ReleaseManifest | undefined> {
  const url = releaseManifestURL(source, tag)
  if (!url) return undefined
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  try {
    return parseReleaseManifest(await response.json())
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('远端 release.json 不是有效的 JSON')
    throw error
  }
}

function exactTagCommit(output: string): string | undefined {
  let commit: string | undefined
  for (const line of output.split('\n')) {
    const [candidate = '', reference = ''] = line.trim().split(/\s+/, 2)
    if (!/^[0-9a-f]{40,64}$/.test(candidate)) continue
    if (reference.endsWith('^{}')) return candidate
    if (reference) commit = candidate
  }
  return commit
}

export async function inspectGitRemote(source: string, current: ReleaseManifest): Promise<RemoteRelease | undefined> {
  source = normalizeReleaseSource(source)
  if (source === DEFAULT_YAOYAO_RELEASE_SOURCE) return inspectGitHubRelease(source)
  const output = await run('git', ['ls-remote', '--tags', source, 'refs/tags/v*'])
  const byVersion = new Map<string, { version: string; commit: string; peeled: boolean }>()
  for (const line of output.split('\n')) {
    const [commit = '', reference = ''] = line.trim().split(/\s+/, 2)
    const match = reference.match(/^refs\/tags\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(\^\{\})?$/)
    if (!match || !/^[0-9a-f]{40,64}$/.test(commit)) continue
    const version = match[1]!
    const peeled = Boolean(match[2])
    const existing = byVersion.get(version)
    if (!existing || peeled) byVersion.set(version, { version, commit, peeled })
  }
  const releases = [...byVersion.values()]
    .sort((left, right) => compareReleaseVersions(left.version, right.version))
  const latest = releases.at(-1)
  if (!latest || compareReleaseVersions(latest.version, current.releaseVersion) <= 0) return undefined

  const tag = `v${latest.version}`
  let manifest = await fetchReleaseManifest(source, tag)
  if (!manifest) {
    const temporary = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-update-check-'))
    try {
      await run('git', [
        'clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1',
        '--single-branch', '--branch', tag, source, temporary,
      ], 180_000)
      const commit = (await run('git', ['-C', temporary, 'rev-parse', 'HEAD'])).trim()
      if (commit !== latest.commit) throw new Error('远端发布标签在检查期间发生变化')
      manifest = parseReleaseManifest(JSON.parse(await run('git', ['-C', temporary, 'show', 'HEAD:release.json'])))
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  } else {
    const verification = await run('git', ['ls-remote', '--tags', source, `refs/tags/${tag}*`])
    if (exactTagCommit(verification) !== latest.commit) throw new Error('远端发布标签在检查期间发生变化')
  }
  if (manifest.releaseVersion !== latest.version) throw new Error('远端标签与 release.json 版本不一致')
  return { manifest, commit: latest.commit }
}

function publicJob(job: StoredUpdateJob | undefined): UpdateJob | undefined {
  if (!job) return undefined
  const { plan: _plan, ...value } = job
  return value
}

function terminal(state: UpdateJobState): boolean {
  return ['succeeded', 'failed', 'rolled_back'].includes(state)
}

export class SystemUpdateManager {
  private readonly projectRoot: string
  private readonly manifestPath: string
  private readonly updaterPath: string
  private readonly updateHome: string
  private readonly releaseRoot: string
  private readonly releaseSource: string
  private readonly inspectRemote: InspectRemote
  private readonly launchUpdater: LaunchUpdater
  private readonly platform: NodeJS.Platform
  private readonly desktopOwned: boolean

  constructor(private readonly config: ServerConfig, options: SystemUpdateManagerOptions = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.manifestPath = resolve(options.manifestPath ?? join(this.projectRoot, 'release.json'))
    this.updaterPath = resolve(options.updaterPath ?? join(this.projectRoot, 'bin', 'hermes-yaoyao-updater.mjs'))
    this.updateHome = join(config.home, 'updates')
    this.releaseRoot = resolve(config.releaseRoot ?? join(homedir(), '.local', 'share', 'hermes-yaoyao'))
    this.releaseSource = normalizeReleaseSource(config.releaseSource ?? DEFAULT_YAOYAO_RELEASE_SOURCE)
    this.inspectRemote = options.inspectRemote ?? inspectGitRemote
    this.platform = options.platform ?? process.platform
    this.desktopOwned = options.desktopOwned ?? process.env.HERMES_YAOYAO_DESKTOP === '1'
    this.launchUpdater = options.launchUpdater ?? ((jobPath) => {
      const child = spawn(process.execPath, [this.updaterPath, 'run', '--job', jobPath], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      })
      child.unref()
      return child.pid
    })
  }

  currentManifest(): ReleaseManifest {
    return readReleaseManifest(this.manifestPath)
  }

  private latestJobID(): string | undefined {
    try {
      const value = JSON.parse(readFileSync(join(this.updateHome, 'latest.json'), 'utf8')) as { id?: unknown }
      return typeof value.id === 'string' ? value.id : undefined
    } catch {
      return undefined
    }
  }

  private storedJob(id: string): StoredUpdateJob | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined
    try {
      return JSON.parse(readFileSync(join(this.updateHome, `${id}.json`), 'utf8')) as StoredUpdateJob
    } catch {
      return undefined
    }
  }

  job(id: string): UpdateJob | undefined {
    return publicJob(this.storedJob(id))
  }

  private latestJob(): StoredUpdateJob | undefined {
    const id = this.latestJobID()
    return id ? this.storedJob(id) : undefined
  }

  status(latest?: ReleaseManifest): SystemUpdateStatus {
    const current = this.currentManifest()
    const job = this.latestJob()
    return {
      current,
      releaseSource: this.releaseSource,
      releasePageUrl: githubReleasePage(this.releaseSource),
      build: readBuildIdentity(this.projectRoot),
      installationMode: this.desktopOwned ? 'desktop' : this.projectRoot.startsWith(`${this.releaseRoot}/`) ? 'release' : 'source',
      latest,
      updateAvailable: Boolean(latest && compareReleaseVersions(latest.releaseVersion, current.releaseVersion) > 0),
      supported: !this.desktopOwned && this.platform === 'darwin',
      unsupportedReason: this.desktopOwned ? 'App 内置服务随 App 一起更新，请使用夭夭菜单中的 App 更新与回退。' : this.platform === 'darwin' ? undefined : '容器和非 macOS 环境请通过替换部署镜像升级',
      canRollback: !this.desktopOwned && existsSync(join(this.updateHome, 'last-success.json')),
      job: publicJob(job),
    }
  }

  async check(): Promise<SystemUpdateStatus> {
    const current = this.currentManifest()
    if (this.desktopOwned) return this.status()
    const latest = await this.inspectRemote(this.releaseSource, current)
    return { ...this.status(latest?.manifest), releasePageUrl: latest?.releasePageUrl ?? githubReleasePage(this.releaseSource) }
  }

  private acquire(jobID: string): void {
    mkdirSync(this.updateHome, { recursive: true, mode: 0o700 })
    const mutex = new DatabaseSync(join(this.updateHome, 'mutex.sqlite3'))
    try { mutex.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
    catch { mutex.close(); throw new Error('已有系统更新正在执行') }
    try { this.acquireFileLock(jobID) } finally { mutex.close() }
  }

  private acquireFileLock(jobID: string): void {
    const lockPath = join(this.updateHome, 'active.lock')
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify({ jobID, pid: process.pid })}\n`)
      closeSync(descriptor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let lock: { jobID?: unknown; pid?: unknown } = {}
      try { lock = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof lock } catch { /* legacy lock */ }
      if (typeof lock.pid === 'number') {
        try {
          process.kill(lock.pid, 0)
          throw new Error('已有系统更新正在执行')
        } catch (processError) {
          if ((processError as NodeJS.ErrnoException).code !== 'ESRCH') throw processError
        }
      } else if (Date.now() - statSync(lockPath).mtimeMs < 5 * 60_000) {
        throw new Error('已有系统更新正在执行')
      }
      const latest = this.latestJob()
      if (latest && !terminal(latest.state)) {
        const failed = {
          ...latest,
          state: 'failed' as const,
          message: '升级进程意外终止，可重新检查更新',
          error: '升级进程已不存在',
          updatedAt: new Date().toISOString(),
        }
        writeFileSync(join(this.updateHome, `${latest.id}.json`), `${JSON.stringify(failed, null, 2)}\n`, { mode: 0o600 })
      }
      rmSync(lockPath, { force: true })
      const descriptor = openSync(lockPath, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify({ jobID, pid: process.pid })}\n`)
      closeSync(descriptor)
    }
  }

  private createJob(operation: UpdateJob['operation'], target?: ReleaseManifest, targetCommit?: string): StoredUpdateJob {
    const id = randomUUID()
    this.acquire(id)
    const now = new Date().toISOString()
    const job: StoredUpdateJob = {
      id,
      operation,
      state: 'queued',
      message: operation === 'update' ? '升级任务已排队' : '回滚任务已排队',
      createdAt: now,
      updatedAt: now,
      target,
      plan: {
        home: this.config.home,
        port: this.config.port,
        source: this.releaseSource,
        releaseRoot: this.releaseRoot,
        previousServiceRoot: this.projectRoot,
        target,
        targetCommit,
      },
    }
    const jobPath = join(this.updateHome, `${id}.json`)
    writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 })
    writeFileSync(join(this.updateHome, 'latest.json'), `${JSON.stringify({ id })}\n`, { mode: 0o600 })
    try {
      const pid = this.launchUpdater(jobPath)
      if (typeof pid === 'number' && existsSync(join(this.updateHome, 'active.lock'))) {
        writeFileSync(join(this.updateHome, 'active.lock'), `${JSON.stringify({ jobID: id, pid })}\n`, { mode: 0o600 })
      }
    } catch (error) {
      rmSync(join(this.updateHome, 'active.lock'), { force: true })
      throw error
    }
    return job
  }

  async startUpdate(targetVersion: string): Promise<UpdateJob> {
    if (this.desktopOwned) throw new Error('App 内置服务随 App 一起更新或回退')
    if (this.platform !== 'darwin') throw new Error('当前环境不支持服务内升级')
    const current = this.currentManifest()
    const latest = await this.inspectRemote(this.releaseSource, current)
    if (!latest || compareReleaseVersions(latest.manifest.releaseVersion, current.releaseVersion) <= 0) {
      throw new Error('当前已经是最新版本')
    }
    if (targetVersion !== latest.manifest.releaseVersion) throw new Error('目标版本不是当前发布源的最新版本')
    return publicJob(this.createJob('update', latest.manifest, latest.commit))!
  }

  startRollback(): UpdateJob {
    if (this.desktopOwned) throw new Error('App 内置服务随 App 一起更新或回退')
    if (this.platform !== 'darwin') throw new Error('当前环境不支持服务内回滚')
    if (!existsSync(join(this.updateHome, 'last-success.json'))) throw new Error('没有可回滚的上一版本')
    return publicJob(this.createJob('rollback'))!
  }
}
