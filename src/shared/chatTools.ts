/** Tool events and persisted tool-result rows share the same outcome rules. */
export function toolResultFailed(value: unknown, error?: unknown): boolean {
  if (error && error !== 'false') return true
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return false }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return Boolean(result.error && result.error !== 'false') || result.is_error === true
    || result.ok === false || result.success === false
    || ['failed', 'error', 'cancelled', 'canceled'].includes(String(result.status))
    || (typeof result.exit_code === 'number' && result.exit_code !== 0)
}

export function toolStatus(status: unknown, result?: unknown, error?: unknown): 'running' | 'completed' | 'failed' | 'interrupted' {
  if (toolResultFailed(result, error)) return 'failed'
  const value = String(status ?? '').replace(/^tool\./, '')
  if (['failed', 'error'].includes(value)) return 'failed'
  if (['interrupted', 'cancelled', 'canceled', 'unknown'].includes(value)) return 'interrupted'
  if (['complete', 'completed', 'success', 'done'].includes(value) || result !== undefined && result !== null) return 'completed'
  return 'running'
}
