import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { HttpError } from '../errors.js'
import { kernelEnv, kernelPaths, requireKernel } from './paths.js'

/**
 * Long-lived `runtime/hermes_service.py` processes, one per Hermes home.
 * Adapted from yaovi-agent src/server/hermes/service.ts (Apache-2.0).
 *
 * The system home is `<data>/hermes`; a Bot home is `<data>/bots/<agentId>/runtime` and reads the
 * system home as its Hermes profile parent (config, .env and auth.json read-through).
 */
/** `system` is the default profile; named profiles live in `<system>/profiles/<name>` (native layout). */
export type HermesScope = 'system' | { profile: string } | { botId: string; profile?: string }
const PROFILE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export interface HermesServiceOptions { env?: NodeJS.ProcessEnv; idleMs?: number }
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
type Proc = { child: ChildProcessWithoutNullStreams; ready: Promise<void>; pending: Map<string, Pending>; idle?: ReturnType<typeof setTimeout>; holds: number }

export interface HermesCallOptions { timeoutMs?: number; hold?: boolean; release?: boolean; signal?: AbortSignal }

export class HermesServicePool {
  private procs = new Map<string, Proc>()
  private authSessions = new Map<string, () => void>()
  private seq = 0
  constructor(readonly dataHome: string, private readonly options: HermesServiceOptions = {}) {}

  get env() { return this.options.env ?? process.env }
  get systemHome() { return join(this.dataHome, 'hermes') }
  botHome(botId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId)) throw new HttpError(400, 'Bot 标识无效', 'invalid_bot')
    return join(this.dataHome, 'bots', botId, 'runtime')
  }
  profileHome(profile = 'default') {
    if (profile === 'default') return this.systemHome
    if (!PROFILE.test(profile)) throw new HttpError(400, 'Profile 名称无效', 'invalid_profile')
    return join(this.systemHome, 'profiles', profile)
  }
  home(scope: HermesScope) {
    if (scope === 'system') return this.systemHome
    return 'botId' in scope ? this.botHome(scope.botId) : this.profileHome(scope.profile)
  }
  /** Profile parent read through for config, .env and auth.json; profiles use Hermes' native layout. */
  parent(scope: HermesScope): string | undefined {
    return scope !== 'system' && 'botId' in scope ? this.profileHome(scope.profile) : undefined
  }

  /** Call one service op. `hold` keeps the process alive (pending OAuth sessions live in its memory). */
  async call<T = any>(scope: HermesScope, op: string, args: Record<string, unknown> = {}, opts: HermesCallOptions = {}): Promise<T> {
    opts.signal?.throwIfAborted()
    const home = this.home(scope)
    const proc = this.start(home, this.parent(scope))
    await proc.ready
    if (proc.idle) clearTimeout(proc.idle)
    if (opts.hold) proc.holds++
    if (opts.release && proc.holds > 0) proc.holds--
    const id = String(++this.seq)
    let abort: (() => void) | undefined
    try {
      const result = await new Promise<T>((resolveCall, reject) => {
        const timer = setTimeout(() => { proc.pending.delete(id); reject(new HttpError(504, 'Hermes 服务响应超时', 'hermes_timeout')) }, opts.timeoutMs ?? 60_000)
        proc.pending.set(id, { resolve: resolveCall, reject, timer })
        abort = () => { proc.pending.delete(id); clearTimeout(timer); reject(opts.signal?.reason ?? new Error('Aborted')) }
        opts.signal?.addEventListener('abort', abort, { once: true })
        if (opts.signal?.aborted) { abort(); return }
        proc.child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
      })
      const session = result as { session_id?: string; expires_in?: number; status?: string }
      if (op === 'oauth.start' && session?.session_id) {
        const key = `${home}\0${session.session_id}`
        const release = () => { if (!this.authSessions.delete(key)) return; clearTimeout(timer); if (opts.hold && proc.holds > 0) proc.holds--; this.scheduleIdle(home, proc) }
        const timer = setTimeout(release, Math.min(30 * 60, Math.max(60, session.expires_in || 900)) * 1000 + 10_000)
        timer.unref()
        this.authSessions.set(key, release)
      }
      const sessionKey = `${home}\0${String(args.sessionId ?? args.session_id ?? '')}`
      if (op === 'oauth.cancel' || op === 'oauth.poll' && session?.status && session.status !== 'pending') this.authSessions.get(sessionKey)?.()
      return result
    } catch (error) { if (opts.hold && proc.holds > 0) proc.holds--; throw error }
    finally { if (abort) opts.signal?.removeEventListener('abort', abort); this.scheduleIdle(home, proc) }
  }

  close() {
    for (const release of [...this.authSessions.values()]) release()
    for (const [home, p] of this.procs) { if (p.idle) clearTimeout(p.idle); this.procs.delete(home); p.child.kill() }
  }

  private scheduleIdle(home: string, proc: Proc) {
    if (proc.idle) clearTimeout(proc.idle)
    if (proc.pending.size || proc.holds) return
    proc.idle = setTimeout(() => { if (!proc.pending.size && !proc.holds && this.procs.get(home) === proc) { this.procs.delete(home); proc.child.stdin.end() } }, this.options.idleMs ?? 10 * 60_000)
    proc.idle.unref?.()
  }

  private start(home: string, parent?: string): Proc {
    const existing = this.procs.get(home)
    if (existing && existing.child.exitCode === null && !existing.child.killed) return existing
    const paths = kernelPaths(this.env)
    requireKernel(paths, paths.service)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const env = kernelEnv(home, this.env, parent)
    const child = spawn(paths.python, ['-u', paths.service], { cwd: dirname(paths.service), env, stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map<string, Pending>()
    let ready!: () => void, failed!: (e: Error) => void
    const proc: Proc = { child, pending, holds: 0, ready: new Promise<void>((a, b) => { ready = a; failed = b }) }
    proc.ready.catch(() => {})
    child.stderr.resume()
    createInterface({ input: child.stdout }).on('line', line => {
      let frame: any
      try { frame = JSON.parse(line) } catch { return }
      if (frame.type === 'ready') return ready()
      const p = pending.get(String(frame.id))
      if (!p) return
      pending.delete(String(frame.id)); clearTimeout(p.timer)
      if (frame.ok) p.resolve(frame.result)
      else p.reject(new HttpError(frame.status >= 400 && frame.status < 600 ? frame.status : 502, String(frame.error || 'Hermes 服务错误').slice(0, 2000), 'hermes_error'))
    })
    child.on('exit', () => {
      if (this.procs.get(home) === proc) this.procs.delete(home)
      failed(new HttpError(503, 'Hermes 服务未能启动', 'hermes_unavailable'))
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new HttpError(503, 'Hermes 服务已退出', 'hermes_unavailable')) }
      pending.clear()
    })
    child.on('error', () => {})
    this.procs.set(home, proc)
    return proc
  }
}
