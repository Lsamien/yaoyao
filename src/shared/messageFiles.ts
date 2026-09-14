import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type { WorkspaceFile, WorkspaceMessage } from './workspace.js'

/** Only the conversational body can introduce a visible file reference. */
export function visibleMessageText(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:think|thinking|reasoning)>[\s\S]*$/gi, '')
}

export function messageReasoningText(text: string, reasoning = ''): string {
  const inline = [...text.matchAll(/<(think|thinking|reasoning)>([\s\S]*?)(?:<\/\1>|$)/gi)]
    .map(match => match[2]!.trim()).filter(Boolean)
  return [...new Set([reasoning.trim(), ...inline].filter(Boolean))].join('\n\n')
}

const markdown = new MarkdownIt({ html: false })

export function normalizedMessagePath(value: string): string {
  const path = value.replace(/^sandbox:/i, '')
  try { return decodeURIComponent(path) } catch { return path }
}

export function messageFileReferences(text: string): Set<string> {
  const paths = new Set<string>()
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      const destination = token.type === 'link_open' ? token.attrGet('href')
        : token.type === 'image' ? token.attrGet('src') : undefined
      if (destination) paths.add(normalizedMessagePath(destination))
      if (token.type === 'text') {
        for (const match of token.content.matchAll(/\bMEDIA:\s*(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/gi)) {
          paths.add(normalizedMessagePath(match[1] ?? match[2] ?? match[3] ?? match[4]!))
        }
      }
      if (token.children) visit(token.children)
    }
  }
  visit(markdown.parse(visibleMessageText(text), {}))
  return paths
}

export interface MessageFileOrigin {
  /** Absent on legacy records; references are reconciled against the body. */
  messageFileSource?: 'attachment' | 'reference'
}

export function isVisibleMessageFile(
  file: WorkspaceFile & MessageFileOrigin,
  message?: WorkspaceMessage,
): boolean {
  // Explicit user uploads also belong in the library before a draft is sent.
  if (file.sender === 'user') return true
  if (message && (message.visible === false || message.role !== 'assistant' && !message.peerMessageId)) return false
  if (file.messageFileSource === 'attachment') return true
  if (!message) return file.messageFileSource === 'reference'
  // Older explicitly published attachments have no sourcePath; the archive
  // scanner always recorded one. Do not trust an old attachment array alone.
  if (!file.sourcePath) return message.attachments.some(item => item.id === file.id)
  const references = messageFileReferences(message.content)
  return references.has(normalizedMessagePath(file.sourcePath))
    || references.has(`/api/app/files/${file.id}/download`)
    || references.has(`/api/app/files/${file.id}/preview`)
}

/** Extract only the declared body/attachments of a native message payload. */
export function nativeMessageFileText(data: Record<string, unknown>): string {
  if (data.role && data.role !== 'assistant' && data.role !== 'user') return ''
  if (data.display_kind || data.displayKind) return ''
  const content = data.content ?? data.text ?? data.output ?? ''
  const blocks = Array.isArray(content) ? content : []
  const texts = typeof content === 'string' ? [content] : []
  const attachments = [
    ...blocks,
    ...(Array.isArray(data.attachments) ? data.attachments : []),
    ...(Array.isArray(data.files) ? data.files : []),
  ]
  for (const value of attachments) {
    if (!value || typeof value !== 'object') continue
    const block = value as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    if (block.type && !['image', 'image_url', 'file', 'audio', 'video'].includes(String(block.type))) continue
    const image = block.image_url as { url?: string } | undefined
    const path = block.path ?? block.url ?? image?.url
    if (typeof path === 'string' && !/[<>\r\n]/.test(path)) texts.push(`[附件](<${path}>)`)
  }
  return visibleMessageText(texts.join('\n'))
}
