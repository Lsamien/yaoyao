/** Normalize a server-side file reference without confusing it with an app URL. */
export function serverFilePath(raw: string, decode = true): string | undefined {
  let value = raw.trim().replace(/^sandbox:/i, '')
  if (/^file:/i.test(value)) {
    try { const url = new URL(value); if (url.hostname && url.hostname !== 'localhost') return; value = url.pathname; decode = true } catch { return }
  }
  if (decode) try { value = decodeURIComponent(value) } catch { return }
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return
  if (value.split('/').some(part => part === '..' || /%2e|%2f|%5c/i.test(part))) return
  return value.replace(/\/{2,}/g, '/')
}

export function serverFileUrl(raw: string, profile?: string): string | undefined {
  const path = serverFilePath(raw)
  if (!path || !/^(?:file:|sandbox:)/i.test(raw) && /^\/(?:api|assets|icons|brand|attachments|uploads|media|chat|history|conversations|kanban)(?:\/|$)/.test(path)) return
  return `/api/files/download?${new URLSearchParams({ path, preview: '1', ...(profile ? { profile } : {}) })}`
}
