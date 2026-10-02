import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import { dashboardCommandIndex, standaloneDashboardCommand } from './dashboardCommand.js'
import { LoopbackTransport } from './loopbackAuthorization.js'

export interface DashboardController {
  readonly canRestart: boolean
  readonly unavailableReason?: string
  refresh?(): Promise<void>
  restart(): Promise<void>
}

type Run = (command: string, args: string[]) => Promise<string>
type Launch = (command: string, args: string[], cwd: string) => Promise<number>
interface Options {
  platform?: NodeJS.Platform
  uid?: number
  run?: Run
  healthy?: (origin: string) => Promise<boolean>
  readyTimeoutMs?: number
  pollIntervalMs?: number
  launch?: Launch
}
type Service = { kind: 'launchagent'; target: string; pid: number }
  | { kind: 'standalone'; command: string; args: string[]; cwd: string; pid: number }
interface OwnedDashboard extends DashboardController { suspendChecks?(): () => void }

const execFileAsync = promisify(execFile)
const labels = ['com.samien.hermes.dashboard.local', 'ai.hermes.dashboard']
const localOrigin = 'http://127.0.0.1:9119'

async function healthy(origin: string): Promise<boolean> {
  const transport = new LoopbackTransport()
  try {
    const response = await transport.fetch(new URL(`${origin}/api/health`), { signal: AbortSignal.timeout(1000) })
    await response.body?.cancel()
    return response.ok
  } catch { return false } finally { transport.close() }
}

const launch: Launch = (command, args, cwd) => new Promise((resolve, reject) => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('HERMES_YAOYAO_') || key.startsWith('ELECTRON_')) delete env[key]
  const child = spawn(command, args, { cwd, env, detached: true, stdio: 'ignore' })
  child.once('error', reject)
  child.once('spawn', () => { child.unref(); child.pid ? resolve(child.pid) : reject(new Error('Hermes Dashboard 启动失败。')) })
})

/** Runs only in the Yaoyao server. No browser, desktop IPC or client-supplied target is used. */
export class ServerDashboardController implements DashboardController {
  private readonly platform: NodeJS.Platform
  private readonly uid: number | undefined
  private readonly run: Run
  private readonly healthy: NonNullable<Options['healthy']>
  private readonly timeout: number
  private readonly interval: number
  private readonly launch: Launch
  private launchedPid?: number
  private service: Service | undefined
  private restarting = false
  private stopped = false

  constructor(private readonly upstream: URL, private readonly owned?: OwnedDashboard, options: Options = {}) {
    this.platform = options.platform ?? process.platform
    this.uid = options.uid ?? process.getuid?.()
    this.run = options.run ?? (async (command, args) => (await execFileAsync(command, args, { timeout: 3000, maxBuffer: 256 * 1024 })).stdout)
    this.healthy = options.healthy ?? healthy
    this.timeout = options.readyTimeoutMs ?? 30000
    this.interval = options.pollIntervalMs ?? 250
    this.launch = options.launch ?? launch
  }

  get canRestart(): boolean {
    return !this.stopped && this.upstream.origin === localOrigin && (!!this.owned?.canRestart || !!this.service)
  }

  get unavailableReason(): string {
    if (this.upstream.origin !== localOrigin) return '此 Hermes 不在夭夭服务端可管理的本机地址，请在 Hermes 所在节点重启。'
    if (this.platform !== 'darwin') return '夭夭服务端尚未支持此系统的外部 Dashboard 服务管理，请在 Hermes 所在节点重启。'
    return '夭夭服务端未识别到当前账号可管理的 9119 Hermes Dashboard 进程；请确认由本机 Hermes 命令启动且与夭夭使用同一系统账号。'
  }

  async refresh(): Promise<void> {
    if (this.restarting || this.stopped) return
    const service = this.owned?.canRestart ? undefined : await this.discover()
    if (!this.restarting && !this.stopped) this.service = service
  }

  stop(): void { this.stopped = true; this.service = undefined }

  private async discover(): Promise<Service | undefined> {
    if (this.stopped || this.upstream.origin !== localOrigin || this.platform !== 'darwin' || this.uid === undefined) return
    const pids = await this.listeners().catch(() => [])
    if (pids.length !== 1) return
    const pid = pids[0]!
    for (const label of labels) {
      const service = await this.launchAgent(label, pid)
      if (service) return service
    }
    // Custom labels are common in manual installs. The listener PID, rather than
    // a label alone, identifies the only candidate we may inspect and restart.
    let jobs: { pid: number; label: string }[]
    try {
      const listing = await this.run('/bin/launchctl', ['list'])
      jobs = [...listing.matchAll(/^\s*(\d+)\s+-?\d+\s+(\S+)\s*$/gm)].map(m => ({ pid: Number(m[1]), label: m[2]! }))
    } catch { return }
    const job = jobs.find(job => job.pid === pid)
    if (job) return this.launchAgent(job.label, pid)
    const process = await this.process(pid)
    if (!process || process.uid !== this.uid || this.uid === 0 || (pid !== this.launchedPid && jobs.some(job => job.pid === process.parent))) return
    const invocation = standaloneDashboardCommand(process.command)
    if (!invocation) return
    if (process.parent !== 1 && pid !== this.launchedPid) {
      const parent = await this.process(process.parent)
      if (!parent || parent.uid !== this.uid || !/^(?:\S*\/)?-?(?:zsh|bash|sh|fish)(?:\s|$)/.test(parent.command)) return
    }
    // Module entry points can depend on the original working directory.
    try {
      const detail = await this.run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      const paths = detail.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
      const cwd = paths[0]
      if (paths.length === 1 && cwd && isAbsolute(cwd) && !/[\r\0]/.test(cwd)) return { kind: 'standalone', pid, cwd, ...invocation }
    } catch { /* Do not stop a process we cannot reliably relaunch. */ }
  }

  private async listeners(): Promise<number[]> {
    try {
      const listeners = await this.run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:9119', '-sTCP:LISTEN', '-Fp'])
      return [...new Set([...listeners.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1])))]
    } catch (error) {
      if ((error as { code?: number }).code === 1) return []
      throw error
    }
  }

  private async launchAgent(label: string, listener: number): Promise<Service | undefined> {
    if (!/^[A-Za-z0-9_.-]+$/.test(label)) return
    const target = `gui/${this.uid}/${label}`
    try {
      const detail = await this.run('/bin/launchctl', ['print', target])
      const pid = Number(detail.match(/^\s*pid = (\d+)\s*$/m)?.[1])
      const args = detail.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1]?.trim().split('\n').map(line => line.trim()) ?? []
      if (pid === listener && dashboardCommandIndex(args) !== undefined) return { kind: 'launchagent', target, pid }
    } catch { /* Missing job or unknown command: fail closed. */ }
  }

  private async process(pid: number): Promise<{ uid: number; parent: number; command: string } | undefined> {
    try {
      const detail = await this.run('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'ppid=', '-o', 'command='])
      const match = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/.exec(detail)
      if (match) return { uid: Number(match[1]), parent: Number(match[2]), command: match[3]!.trim() }
    } catch { /* Process has exited or is unreadable. */ }
  }

  private async restartStandalone(service: Extract<Service, { kind: 'standalone' }>): Promise<void> {
    // discover() has just checked the owner, executable and sole listener.
    await this.run('/bin/kill', ['-TERM', String(service.pid)])
    const deadline = Date.now() + this.timeout
    while (!this.stopped && await this.process(service.pid)) {
      if (Date.now() >= deadline) throw new Error('Hermes Dashboard 未能停止，请在所在节点检查。')
      await new Promise(resolve => setTimeout(resolve, this.interval))
    }
    if (this.stopped || (await this.listeners()).length) throw new Error('9119 已被其他进程占用，未启动新的 Dashboard。')
    this.launchedPid = await this.launch(service.command, service.args, service.cwd)
  }

  async restart(): Promise<void> {
    if (this.restarting) throw new Error('服务端 Hermes Dashboard 正在重启。')
    if (this.stopped || this.upstream.origin !== localOrigin) throw new Error(this.unavailableReason)
    this.restarting = true
    this.service = undefined
    let resumeChecks: (() => void) | undefined
    try {
      const owned = !!this.owned?.canRestart
      let previous: Service | undefined
      if (owned) await this.owned!.restart()
      else {
        resumeChecks = this.owned?.suspendChecks?.()
        // Refresh ownership at action time, even if the UI previously reported restart availability.
        previous = await this.discover()
        if (!previous || this.stopped) throw new Error(this.unavailableReason)
        if (previous.kind === 'launchagent') await this.run('/bin/launchctl', ['kickstart', '-k', previous.target])
        else await this.restartStandalone(previous)
      }
      const deadline = Date.now() + this.timeout
      while (!this.stopped && Date.now() < deadline) {
        const replacement = owned ? undefined : await this.discover()
        const replaced = owned ? this.owned?.canRestart : replacement && previous && replacement.pid !== previous.pid
          && (replacement.kind === 'launchagent' && previous.kind === 'launchagent' ? replacement.target === previous.target
            : replacement.kind === 'standalone' && previous.kind === 'standalone' && replacement.pid === this.launchedPid
              && replacement.command === previous.command && replacement.cwd === previous.cwd && JSON.stringify(replacement.args) === JSON.stringify(previous.args))
        if (replaced && await this.healthy(this.upstream.origin) && !this.stopped) {
          this.service = replacement
          return
        }
        await new Promise(resolve => setTimeout(resolve, this.interval))
      }
      throw new Error('服务端 Hermes Dashboard 重启后未恢复健康，请重新检查。')
    } finally { resumeChecks?.(); this.restarting = false }
  }
}
