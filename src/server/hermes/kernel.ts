import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { dirname } from 'node:path'
import { HttpError } from '../errors.js'
import { kernelEnv, kernelPaths, requireKernel, scrubSecrets } from './paths.js'

/**
 * Client for `runtime/worker.py`: one isolated Python process per running turn.
 * Adapted from yaovi-agent src/server/yaoviKernel.ts (Apache-2.0).
 *
 * The worker owns Hermes' AIAgent loop (model calls, context compression, native skills and
 * delegation). Every application tool is declared in `tools` and executed back here via `call`.
 */
export interface KernelTool { name: string; description: string; parameters: unknown }
export interface KernelRoute {
  provider: string
  model: string
  reasoningEffort: string
  fastMode?: 'normal' | 'fast'
  apiMode?: string
  /** Explicit endpoint, only for tests; normally Hermes resolves the provider from config/.env/auth.json. */
  baseURL?: string
  apiKey?: string
}
export interface KernelRequest {
  workspaceId: string
  botId: string
  sessionId: string
  runId: string
  /** Hermes home for this conversation (state.db, contexts, skills). */
  dataRoot: string
  /** System-layer Hermes home read as the profile parent. */
  hermesRoot?: string
  hostWorkspace?: { cwd: string }
  route: KernelRoute
  config: Record<string, unknown>
  instructions: string
  text: unknown
  turnContext?: string
  tools: KernelTool[]
  botPolicy?: { enabled: boolean; foreground: boolean; version?: 2 }
  /** Hermes session source (`web` native chats, `yaoyao_workspace` Bot sessions). */
  platform?: string
  compact?: Record<string, never>
}
export interface KernelControl { steer?: (text: string) => Promise<boolean> }
export interface KernelUsage { [key: string]: unknown }
export interface KernelResult { text: string; usage?: KernelUsage }

export interface KernelOptions {
  signal: AbortSignal
  maxSeconds: number
  control?: KernelControl
  /** True while the turn is blocked on a human (approval/clarification): the deadline pauses. */
  waiting?: () => boolean
  env?: NodeJS.ProcessEnv
  onEvent: (type: string, frame: any) => void
  call: (name: string, args: unknown, id: string, frame: any) => Promise<unknown>
}

/** Default Hermes agent configuration admitted for each worker. */
export function defaultKernelConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent: { max_iterations: 90 }, delegation: { enabled: true }, memory: { automatic: false }, ...overrides }
}

export async function runKernel(request: KernelRequest, options: KernelOptions): Promise<KernelResult> {
  options.signal.throwIfAborted()
  const source = options.env ?? process.env
  const paths = kernelPaths(source)
  requireKernel(paths, paths.worker)
  const env = kernelEnv(request.dataRoot, source, request.hermesRoot)
  const group = process.platform !== 'win32'
  const child = spawn(paths.python, ['-u', paths.worker], { cwd: dirname(paths.worker), env, detached: group, stdio: ['pipe', 'pipe', 'pipe'] })
  return new Promise((resolveResult, reject) => {
    let settled = false, done: KernelResult | undefined, bytes = 0, failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined, termTimer: ReturnType<typeof setTimeout> | undefined
    const pending = new Set<string>()
    const steers = new Map<string, (accepted: boolean) => void>()
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    const kill = (signal: NodeJS.Signals) => { try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* already exited */ } }
    const write = (value: unknown) => { if (!child.stdin.destroyed && !settled) child.stdin.write(JSON.stringify(value) + '\n') }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearInterval(deadline); clearTimeout(termTimer); clearTimeout(killTimer)
      options.signal.removeEventListener('abort', cancel); lines.close()
      for (const resolveSteer of steers.values()) resolveSteer(false)
      steers.clear()
      if (options.control) options.control.steer = undefined
      if (error) reject(error)
      else if (done) resolveResult(done)
      else reject(new HttpError(502, 'Hermes 内核未返回完成结果', 'kernel_failed'))
    }
    // Keep the watchdog until process close, including descendants, so a cancelled turn
    // cannot keep issuing actions after its tool grant ends.
    const stop = (error: Error) => {
      if (failure) return
      failure = error; write({ type: 'interrupt' })
      termTimer = setTimeout(() => kill('SIGTERM'), 500); termTimer.unref()
      killTimer = setTimeout(() => kill('SIGKILL'), 2500); killTimer.unref()
    }
    const cancel = () => stop(new HttpError(409, '已停止', 'interrupted'))
    let remaining = options.maxSeconds * 1000, lastTick = Date.now()
    const deadline = setInterval(() => {
      const now = Date.now()
      if (!options.waiting?.()) remaining -= now - lastTick
      lastTick = now
      if (remaining <= 0) stop(new HttpError(408, '运行达到时间限制', 'kernel_timeout'))
    }, 250)
    deadline.unref()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
    child.stdin.on('error', () => {})
    child.on('error', error => finish(error))
    child.on('close', code => finish(failure ?? (code === 0 && done ? undefined
      : new HttpError(502, `Hermes 内核异常退出（${code}）${stderr.trim() ? `：${scrubSecrets(stderr.trim().split('\n').at(-1) ?? '').slice(0, 300)}` : ''}`, 'kernel_failed'))))
    lines.on('line', line => {
      if (failure || settled) return
      try {
        bytes += Buffer.byteLength(line)
        if (bytes > 64 * 1024 * 1024) throw new Error('Hermes 内核事件超过本轮限制')
        const frame = JSON.parse(line)
        if (frame.type === 'tool.request') {
          if (typeof frame.id !== 'string' || typeof frame.name !== 'string' || pending.has(frame.id)) throw new Error('Hermes 工具请求编号无效或重复')
          pending.add(frame.id)
          void options.call(frame.name, frame.arguments, frame.id, frame).then(
            result => write({ id: frame.id, result }),
            error => write({ id: frame.id, error: error instanceof Error && error.message ? error.message.slice(0, 1000) : '工具执行失败' }),
          ).finally(() => pending.delete(frame.id))
        } else if (frame.type === 'steer.result') {
          const resolveSteer = steers.get(String(frame.id)); steers.delete(String(frame.id)); resolveSteer?.(frame.accepted === true)
        } else if (frame.type === 'completed') done = { text: String(frame.text ?? ''), usage: frame.usage }
        else if (frame.type === 'failed') stop(new HttpError(502, `执行失败：${scrubSecrets(String(frame.message)).slice(0, 1000)}`, 'kernel_execution_failed'))
        else options.onEvent(frame.type, frame)
      } catch (error) { stop(error instanceof Error ? error : new Error('Hermes 内核协议错误')) }
    })
    if (options.control) options.control.steer = text => new Promise<boolean>(resolveSteer => {
      if (settled || failure || child.stdin.destroyed) return resolveSteer(false)
      const id = randomUUID(), timer = setTimeout(() => { steers.delete(id); resolveSteer(false) }, 5000)
      timer.unref()
      steers.set(id, accepted => { clearTimeout(timer); resolveSteer(accepted) })
      write({ type: 'steer', id, text })
    })
    options.signal.addEventListener('abort', cancel, { once: true })
    if (options.signal.aborted) cancel(); else write(request)
  })
}
