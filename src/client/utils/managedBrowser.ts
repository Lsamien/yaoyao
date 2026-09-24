import { apiRequest } from '@/api/client'
import type { ManagedBrowserState } from '@shared/managedBrowser'

export function browserCanPrepare(state?: ManagedBrowserState): boolean {
  return !!state?.enabled && (!!state.available || !!state.installation)
}

/** Preparing installs the runtime only; taking control remains a separate action. */
export async function prepareManagedBrowser(agentId: string, initial: ManagedBrowserState | undefined, signal: AbortSignal, update: (state: ManagedBrowserState) => void): Promise<void> {
  const path = `/api/app/agents/${encodeURIComponent(agentId)}/managed-browser`
  let state = initial ?? await apiRequest<ManagedBrowserState>(path, { signal })
  signal.throwIfAborted()
  if (!browserCanPrepare(state)) throw new Error(state.reason || '托管浏览器不可用，请检查执行节点与授权')
  if (!state.available && state.installation?.status !== 'installing') {
    state = await apiRequest<ManagedBrowserState>(path + '/prepare', { method: 'POST', body: { retry: state.installation?.status === 'failed' }, signal })
  }
  const started = Date.now()
  for (;;) {
    signal.throwIfAborted(); update(state)
    if (state.available) return
    if (state.installation?.status === 'failed') throw new Error(state.installation.error || state.installation.message || '浏览器准备失败，请重试')
    if (!browserCanPrepare(state)) throw new Error(state.reason || '执行节点已不可用，请重新连接后重试')
    if (Date.now() - started > 10 * 60_000) throw new Error('浏览器仍在准备中，可稍后重新接管查看进度')
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1000)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    state = await apiRequest<ManagedBrowserState>(path, { signal })
  }
}
