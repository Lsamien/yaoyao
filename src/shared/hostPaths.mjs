import path from 'node:path'

export function hostPathInput(input, platform = process.platform) {
  const value = String(input ?? '')
  if (value.includes('\0')) throw new Error('路径无效')
  if (platform === 'win32') {
    // File tools never accept device namespaces, UNC shares, drive-relative
    // paths, alternate data streams, or Win32 names with ambiguous semantics.
    if (/^[\\/]{2}|^[A-Za-z]:(?![\\/])/.test(value)) throw new Error('路径无效')
    const rest = value.replace(/^[A-Za-z]:/, '')
    if (rest.includes(':') || rest.split(/[\\/]/).some(part =>
      (part !== '.' && part !== '..' && /[ .]$/.test(part)) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('路径无效')
    return value.replace(/^~[\\/]/, '').replace(/^~$/, '')
  }
  return value.replace(/^~\//, '').replace(/^~$/, '')
}

export function pathInside(root, target, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix
  const relative = api.relative(root, target)
  return relative === '' || (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + api.sep))
}
