import { isSupportedFilePath, serverFilePath, serverFileUrl } from '@shared/serverFiles'

const IMAGE_EXTENSIONS = new Set([
  'apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jfi', 'jfif', 'jif',
  'jpe', 'jpeg', 'jpg', 'jxl', 'png', 'svg', 'tif', 'tiff', 'webp',
])
const MEDIA_MARKER = /MEDIA:\s*/g
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/

type MediaMatch = { path: string; end: number }

function inlineCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let index = 0
  while (index < line.length) {
    if (line[index] !== '`' || line[index - 1] === '\\') {
      index += 1
      continue
    }
    const start = index
    while (line[index] === '`') index += 1
    const fence = line.slice(start, index)
    const end = line.indexOf(fence, index)
    if (end < 0) {
      ranges.push([start, line.length])
      break
    }
    ranges.push([start, end + fence.length])
    index = end + fence.length
  }
  return ranges
}

function isInRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

function isSafeAbsolutePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || /\0/.test(path)) return false
  return !path.split('/').some(segment => segment === '..' || /^%2e%2e$/i.test(segment))
}

function unquotedPath(line: string, start: number, streaming: boolean): MediaMatch | undefined {
  if (line[start] !== '/') return undefined
  const tail = line.slice(start)
  const extension = /\.[A-Za-z0-9]{1,12}(?=$|[\s,，。;；:：!?！？\])}])/g
  const match = extension.exec(tail)
  if (!match) return undefined
  const end = start + match.index + match[0].length
  // A streamed unquoted path is ambiguous until the producer has emitted a
  // line boundary. Rendering early can turn a later path suffix into prose.
  if (streaming && end === line.length) return undefined
  return { path: line.slice(start, end), end }
}

function readMediaPath(line: string, start: number, streaming: boolean): MediaMatch | undefined {
  let cursor = start
  while (/\s/.test(line[cursor] ?? '')) cursor += 1
  const quote = line[cursor]
  if (quote === '"' || quote === "'" || quote === '`') {
    const close = line.indexOf(quote, cursor + 1)
    if (close < 0) return undefined
    return { path: line.slice(cursor + 1, close), end: close + 1 }
  }
  return unquotedPath(line, cursor, streaming)
}

function escapeLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1')
}

function asMarkdown(path: string): string {
  const fileName = path.split('/').filter(Boolean).at(-1) || '文件'
  const extension = fileName.split('.').at(-1)?.toLocaleLowerCase() || ''
  const label = escapeLabel(fileName)
  const destination = path.split('/').map(part => encodeURIComponent(part).replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/')
  return IMAGE_EXTENSIONS.has(extension) ? `![${label}](${destination})` : `[${label}](${destination})`
}

function transformLine(line: string, streaming: boolean, terminated: boolean): string {
  if (HEADING.test(line) || line.includes('|')) return line
  const codeRanges = inlineCodeRanges(line)
  let output = ''
  let cursor = 0
  MEDIA_MARKER.lastIndex = 0
  for (let marker = MEDIA_MARKER.exec(line); marker; marker = MEDIA_MARKER.exec(line)) {
    const markerStart = marker.index
    if (isInRanges(markerStart, codeRanges)) continue
    const media = readMediaPath(line, markerStart + marker[0].length, streaming && !terminated)
    if (!media || !isSafeAbsolutePath(media.path)) continue
    output += line.slice(cursor, markerStart)
    output += asMarkdown(media.path)
    cursor = media.end
    MEDIA_MARKER.lastIndex = media.end
  }
  return cursor ? output + line.slice(cursor) : line
}

function transformStandaloneFilePath(line: string, streaming: boolean): string {
  if (streaming || HEADING.test(line) || line.includes('|') || line.includes('](')) return line
  const match = /^(\s*)((?:[-+*]|\d+[.)])\s+)?(.+?)\s*$/.exec(line)
  if (!match) return line
  const candidate = match[3]
  const path = serverFilePath(candidate)
  if (!path || !serverFileUrl(candidate) || !isSupportedFilePath(path)) return line
  return `${match[1]}${match[2] || ''}${asMarkdown(path)}`
}

/**
 * Compatibility for historical assistant output. New agent output is already
 * Markdown and deliberately bypasses any message mutation at send time.
 */
export function normalizeAssistantMediaMarkdown(content: string, streaming = false): string {
  let inFence = false
  const parts = content.split(/(\r?\n)/)
  return parts.map((part, index) => {
    if (part === '\n' || part === '\r\n') return part
    const fence = FENCE.exec(part)
    if (fence) {
      inFence = !inFence
      return part
    }
    const terminated = parts[index + 1] === '\n' || parts[index + 1] === '\r\n'
    if (inFence) return part
    return transformStandaloneFilePath(transformLine(part, streaming, terminated), streaming)
  }).join('')
}
