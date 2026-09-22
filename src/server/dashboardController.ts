import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'

export interface DashboardController {
  readonly canRestart: boolean
  readonly unavailableReason?: string
  refresh?(): Promise<void>
  restart(): Promise<void>
}

type Run = (command: string, args: string[]) => Promise<string>
interface Options {
  platform?: NodeJS.Platform
  uid?: number
  run?: Run
  healthy?: (origin: string) => Promise<boolean>
  readyTimeoutMs?: number
  pollIntervalMs?: number
}
interface Service { target: string; pid: number }
interface OwnedDashboard extends DashboardController { suspendChecks?(): () => void }

const execFileAsync = promisify(execFile)
const labels = ['com.samien.hermes.dashboard.local', 'ai.hermes.dashboard']
const localOrigin = 'http://127.0.0.1:9119'

async function healthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' })
    await response.body?.cancel()
    return response.ok
  } catch { return false }
}

/** Runs only in the Yaoyao server. No browser, desktop IPC or client-supplied target is used. */
export class ServerDashboardController implements DashboardController {
  private readonly platform: NodeJS.Platform
  private readonly uid: number | undefined
  private readonly run: Run
  private readonly healthy: NonNullable<Options['healthy']>
  private readonly timeout: number
  private readonly interval: number
  private service: Service | undefined
  private restarting = false
  private stopped = false

  constructor(private readonly upstream: URL, private readonly owned?: OwnedDashboard, options: Options = {}) {
    this.platform = options.platform ?? process.platform
    this.uid = options.uid ?? process.getuid?.()
    this.run = options.run ?? (async (command, args) => (await execFileAsync(command, args, { timeout: 3000, maxBuffer: 256 * 1024 })).stdout)
    this.healthy = options.healthy ?? healthy
    this.timeout = options.readyTimeoutMs ?? 15000
    this.interval = options.pollIntervalMs ?? 250
  }

  get canRestart(): boolean {
    return !this.stopped && this.upstream.origin === localOrigin && (!!this.owned?.canRestart || !!this.service)
  }

  get unavailableReason(): string {
    if (this.upstream.origin !== localOrigin) return '此 Hermes 不在夭夭服务端可管理的本机地址，请在 Hermes 所在节点重启。'
    if (this.platform !== 'darwin') return '夭夭服务端尚未支持此系统的外部 Dashboard 服务管理，请在 Hermes 所在节点重启。'
    return '夭夭服务端未识别到与 9119 监听进程匹配的 Hermes Dashboard 系统服务，请在 Hermes 所在节点重启。'
  }

  async refresh(): Promise<void> {
    if (this.restarting || this.stopped) return
    const service = this.owned?.canRestart ? undefined : await this.discover()
    if (!this.restarting && !this.stopped) this.service = service
  }

  stop(): void { this.stopped = true; this.service = undefined }

  private async discover(): Promise<Service | undefined> {
    if (this.stopped || this.upstream.origin !== localOrigin || this.platform !== 'darwin' || this.uid === undefined) return
    for (const label of labels) {
      const target = `gui/${this.uid}/${label}`
      try {
        const detail = await this.run('/bin/launchctl', ['print', target])
        const pid = Number(detail.match(/^\s*pid = (\d+)\s*$/m)?.[1])
        const args = detail.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1]?.trim().split('\n').map(line => line.trim()) ?? []
        const dashboard = args.indexOf('dashboard')
        // Allow the Hermes executable or its Python entry point, never an arbitrary job with a familiar label.
        const hermes = dashboard === 1 && basename(args[0]!) === 'hermes'
          || dashboard === 2 && /^python(?:\d+(?:\.\d+)*)?$/.test(basename(args[0]!)) && basename(args[1]!) === 'hermes'
        if (!pid || !hermes) continue
        const listeners = await this.run('/usr/sbin/lsof', ['-nP', '-a', '-iTCP:9119', '-sTCP:LISTEN', '-Fp'])
        const pids = new Set([...listeners.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1])))
        if (pids.size === 1 && pids.has(pid)) return { target, pid }
      } catch { /* Missing job, permissions or an unknown listener: fail closed. */ }
    }
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
        await this.run('/bin/launchctl', ['kickstart', '-k', previous.target])
      }
      const deadline = Date.now() + this.timeout
      while (!this.stopped && Date.now() < deadline) {
        const replacement = owned ? undefined : await this.discover()
        const replaced = owned ? this.owned?.canRestart
          : replacement?.target === previous!.target && replacement.pid !== previous!.pid
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
