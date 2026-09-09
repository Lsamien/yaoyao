import { visibleMessageText } from '@shared/messageFiles'

const ATTACHED_CONTEXT_MARKER_RE = /(?:^|\n)--- Attached Context ---\s*\n/
const CONTEXT_WARNINGS_MARKER_RE = /(?:^|\n)--- Context Warnings ---[\s\S]*$/
const CONTEXT_REF_RE = /@(file|folder|url|image|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/g

/**
 * Project persisted message content into the text shown to a person.
 *
 * Hermes deliberately keeps expanded reference payloads in the stored user
 * message so the model can consume them. Those payloads are transport data,
 * not part of the user's visible transcript. Keep the raw content in state and
 * apply this projection only at display/copy boundaries.
 */
export function displayContentForMessage(role: string, content: string): string {
  if (role === 'assistant') return visibleMessageText(content)
  if (role !== 'user') return content

  const marker = content.match(ATTACHED_CONTEXT_MARKER_RE)
  if (!marker || marker.index === undefined) {
    return content.replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()
  }

  const visibleText = content
    .slice(0, marker.index)
    .replace(CONTEXT_WARNINGS_MARKER_RE, '')
    .trim()
  const attachedContext = content.slice(marker.index + marker[0].length)
  const references = [...new Set(
    Array.from(attachedContext.matchAll(CONTEXT_REF_RE), match => match[0]),
  )]
  const missingReferences = references.filter(reference => !visibleText.includes(reference))

  return [missingReferences.join('\n'), visibleText].filter(Boolean).join('\n\n') || visibleText
}
