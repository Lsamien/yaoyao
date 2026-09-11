import type { UiMessage } from '@/components/messages/types'
import { normalizeAssistantMediaMarkdown } from '@/utils/mediaMarkdown'
import { serverFileUrl } from '@shared/serverFiles'
import type { LibraryKind, UiLibraryItem } from './types'

const imageExtensions = new Set(['apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jfif', 'jpeg', 'jpg', 'jxl', 'png', 'svg', 'tif', 'tiff', 'webp'])
const videoExtensions = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm'])

export function previewItemFromUrl(name: string, url: string, id = `local:${url}`, kind?: LibraryKind): UiLibraryItem {
  const extension = name.split('.').at(-1)?.toLocaleLowerCase() || ''
  const inferred = imageExtensions.has(extension) ? 'image'
    : videoExtensions.has(extension) ? 'video'
      : ['mp3', 'wav', 'm4a', 'aac', 'ogg'].includes(extension) ? 'audio'
        : extension === 'pdf' ? 'pdf'
          : ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'js', 'ts', 'py', 'sh'].includes(extension) ? 'text' : 'file'
  return { id, name, kind: kind || inferred, previewUrl: url, downloadUrl: url }
}

export function mediaUrlIdentity(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)
    if (parsed.origin === window.location.origin && parsed.pathname === '/api/files/download') {
      parsed.searchParams.delete('_retry')
      parsed.searchParams.sort()
    }
    return parsed.href
  } catch {
    return url
  }
}

function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)
    const path = parsed.pathname === '/api/files/download' ? parsed.searchParams.get('path') || parsed.pathname : decodeURIComponent(parsed.pathname)
    return path.split('/').at(-1) || '媒体'
  } catch { return '媒体' }
}

/** The ordered image/video sequence visible in one normal or group conversation. */
export function mediaItemsFromMessages(messages: UiMessage[]): UiLibraryItem[] {
  const result: UiLibraryItem[] = []
  const seen = new Set<string>()
  const append = (item: UiLibraryItem) => {
    if (!item.previewUrl || !['image', 'video'].includes(item.kind)) return
    const identity = mediaUrlIdentity(item.previewUrl)
    if (seen.has(identity)) return
    seen.add(identity)
    result.push(item)
  }
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!attachment.url || !['image', 'video'].includes(attachment.kind || 'file')) continue
      append(previewItemFromUrl(attachment.name, attachment.url, `${message.id}:${attachment.id}`, attachment.kind))
    }
    const content = message.role === 'assistant' ? normalizeAssistantMediaMarkdown(message.content) : message.content
    const markdownMedia = /!\[[^\]]*\]\(([^)\s]+)\)|\[[^\]]+\]\(([^)\s]+)\)/g
    for (let match = markdownMedia.exec(content); match; match = markdownMedia.exec(content)) {
      const source = match[1] || match[2]
      if (!source) continue
      // Match MarkdownContent's renderer, including the selected server Profile.
      const url = serverFileUrl(source, message.profile) || source
      const item = previewItemFromUrl(nameFromUrl(url), url, `${message.id}:${url}`)
      append(item)
    }
  }
  return result
}
