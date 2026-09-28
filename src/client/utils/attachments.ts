import { serverFilePath } from '@shared/serverFiles'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Use the authenticated file route for uploads from any Hermes home. */
export function imageAttachmentReference(raw: string, profile?: string): { path: string; url: string } | undefined {
  let source = raw.trim().replace(/^[`'"]|[`'"]$/g, '')
  let decode = true
  if (/^\/api\/(?:files\/(?:download|stream)|hermes\/download|media)\?/.test(source)) {
    source = new URL(source, 'https://local.invalid').searchParams.get('path') || ''
    decode = false // URLSearchParams already decoded the path.
  }
  // Encoded separators must not change the meaning of a path segment.
  if (/%2f|%5c|[\\\u0000-\u001f\u007f]/i.test(source)
    || source.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment))) return
  const path = serverFilePath(source, decode)
  if (!path || path.split('/').some(segment => segment === '.')) return
  if (decode && !/^(?:file:|sandbox:)/i.test(source)
    && /^\/(?:api|assets|icons|brand|attachments|uploads|media|chat|history|conversations|kanban|files|artifacts|settings)(?:\/|$)/.test(path)) return
  return { path, url: `/api/files/download?${new URLSearchParams({ path, preview: '1', ...(profile ? { profile } : {}) })}` }
}

export interface EncodedAttachment {
  name: string
  mimeType: string
  size: number
  base64: string
  dataUrl: string
  extension: string
  kind: 'image' | 'pdf' | 'file'
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })
}

export async function encodeAttachment(file: File): Promise<EncodedAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 25 MiB 限制`)
  const dataUrl = await readAsDataURL(file)
  const separator = dataUrl.indexOf(',')
  if (separator < 0) throw new Error(`${file.name} 编码失败`)
  const mimeType = file.type || 'application/octet-stream'
  return {
    name: file.name,
    mimeType,
    size: file.size,
    base64: dataUrl.slice(separator + 1),
    dataUrl,
    extension: file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : '',
    kind: mimeType.startsWith('image/') ? 'image' : mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'file',
  }
}
