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

const FILE_CARD_EXTENSIONS = new Set([
  'apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jfi', 'jfif', 'jif',
  'jpe', 'jpeg', 'jpg', 'jxl', 'png', 'svg', 'tif', 'tiff', 'webp',
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv', 'rtf',
  'txt', 'md', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx',
  'jsx', 'vue', 'svelte', 'swift', 'kt', 'kts', 'java', 'py', 'rb', 'go',
  'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash',
  'fish', 'sql', 'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz',
])

/** Only promote file types that the preview/download experience understands. */
export function isSupportedFilePath(raw: string): boolean {
  const path = serverFilePath(raw)
  if (!path) return false
  const name = path.split('/').at(-1) || ''
  const match = /\.([A-Za-z0-9]{1,16})$/.exec(name)
  return Boolean(match && FILE_CARD_EXTENSIONS.has(match[1].toLowerCase()))
}

export function serverFileUrl(raw: string, profile?: string): string | undefined {
  const path = serverFilePath(raw)
  if (!path || !/^(?:file:|sandbox:)/i.test(raw) && /^\/(?:api|assets|icons|brand|attachments|uploads|media|chat|history|conversations|kanban|files|artifacts|settings)(?:\/|$)/.test(path)) return
  return `/api/files/download?${new URLSearchParams({ path, preview: '1', ...(profile ? { profile } : {}) })}`
}
