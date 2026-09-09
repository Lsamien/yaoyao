import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'

const DASHBOARD_PORT = 9119
const SUPERVISION_INTERVAL_MS = 5_000
const RESTART_READY_TIMEOUT_MS = 15_000

type Run = (args: readonly string[]) => string
type Launch = (args: readonly string[]) => void
type Probe = (host: string, port: number) => Promise<boolean>

export interface DashboardSupervisorOptions {
  command?: string
  intervalMs?: number
  run?: Run
  launch?: Launch
  probe?: Probe
  log?: (message: string) => void
  managed?: boolean
}

function defaultRun(command: string): Run {
  return (args) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe' })
}

function defaultLaunch(command: string): Launch {
  return (args) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
    child.unref()
  }
}

function portIsListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (value: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** Keeps the local Hermes Dashboard available for the managed 15300 service. */
export class DashboardSupervisor {
  private readonly command: string
  private readonly dashboardHost = '127.0.0.1'
  private readonly run: Run
  private readonly launch: Launch
  private readonly probe: Probe
  private readonly log: (message: string) => void
  private readonly intervalMs: number
  private timer: NodeJS.Timeout | undefined
  private checking = false
  private owned: ChildProcess | undefined
  private stopped = false
  private readonly managed: boolean

  constructor(options: DashboardSupervisorOptions) {
    this.command = options.command ?? 'hermes'
    this.run = options.run ?? defaultRun(this.command)
    this.launch = options.launch ?? defaultLaunch(this.command)
    this.probe = options.probe ?? portIsListening
    this.log = options.log ?? console.info
    this.intervalMs = options.intervalMs ?? SUPERVISION_INTERVAL_MS
    this.managed = options.managed === true
  }

  start(): void {
    this.stopped = false
    void this.checkNow()
    this.timer = setInterval(() => { void this.checkNow() }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async restart(): Promise<void> {
    while (this.checking) await delay(25)
    if (this.managed) {
      if (!this.owned) throw new Error('此 Hermes 由外部服务管理，不能由桌面 App 停止。')
      await this.stopOwned()
      this.stopped = false
      await this.checkNow()
      return
    }
    this.run(['dashboard', '--stop'])
    await this.checkNow()
    const deadline = Date.now() + RESTART_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.probe('127.0.0.1', DASHBOARD_PORT)) return
      await delay(100)
    }
    throw new Error('Hermes Dashboard did not return on 9119 after restart')
  }

  async checkNow(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      // Installation must not rewrite credentials or restart/rebind an existing
      // upstream. Only a missing managed service is started on loopback.
      const running = await this.probe('127.0.0.1', DASHBOARD_PORT)
      if (running || this.stopped || this.owned) return
      this.log(`Hermes Dashboard is unavailable on 9119; starting it on ${this.dashboardHost}.`)
      if (this.managed) {
        const env: NodeJS.ProcessEnv = { ...process.env, HERMES_PARENT_PID: String(process.pid) }
        for (const key of Object.keys(env)) if (key.startsWith('HERMES_YAOYAO_') || key.startsWith('ELECTRON_')) delete env[key]
        const child = spawn(this.command, ['dashboard', '--host', this.dashboardHost, '--no-open', '--skip-build'], {
          env, detached: process.platform !== 'win32', stdio: 'ignore',
        })
        this.owned = child
        child.once('error', error => { if (this.owned === child) this.owned = undefined; this.log(`Hermes 启动失败：${error.message}`) })
        child.once('exit', () => { if (this.owned === child) this.owned = undefined })
      } else this.launch(['dashboard', '--host', this.dashboardHost])
    } catch (error) {
      this.log(`Hermes Dashboard supervision failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.checking = false
    }
  }
  async stopOwned(): Promise<void> {
    const child = this.owned
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([exited, delay(3000)])
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      await exited
    }
  }

}
