import { setTimeout as delay } from 'node:timers/promises'
import { HttpError } from './errors.js'

/** Interrupt acknowledgement only requests cancellation; native tools may still be running. */
export async function waitForHermesSessionIdle(
  rpc: (method: string, params: Record<string, unknown>) => Promise<any>,
  sessionId: string,
  profile: string,
  options: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  for (;;) {
    options.signal?.throwIfAborted()
    const state = await rpc('session.active_list', { profile, current_session_id: sessionId })
    if (!Array.isArray(state?.sessions)) throw new HttpError(502, 'Hermes 停止状态无效，原执行仍需核对', 'session_stop_unconfirmed')
    // Finalized sessions disappear from Hermes' live list.
    const session = state.sessions.find((item: { id?: string }) => item.id === sessionId)
    if (!session || session.status === 'idle') return
    if (Date.now() >= deadline) throw new HttpError(409, 'Hermes 原任务尚未停止，请等待执行结束后重试', 'session_still_stopping')
    await delay(options.pollMs ?? 100, undefined, { signal: options.signal })
  }
}
