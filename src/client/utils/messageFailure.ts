import type { UiMessage } from '@/components/messages/types'

export type MessageFailure = { title: string; hint: string; detail: string; key: string; replacesContent: boolean }
const failurePrefix = /^执行失败[：:]\s*/

/** Presentation only: retain the original transcript and diagnostics for inspection. */
export function messageFailure(message: UiMessage): MessageFailure | undefined {
  if (message.communication || message.taskReference || message.role === 'tool') return
  if (message.status !== 'failed' && !message.error?.trim()) return
  const content = message.content.trim()
  const prefixed = message.role !== 'user' && message.status === 'failed' && failurePrefix.test(content)
  const error = message.error?.trim() || (prefixed ? content.replace(failurePrefix, '') : '')
  if (!error && message.status !== 'failed') return
  const providerNotice = message.role === 'assistant' && message.status === 'failed'
    && content.includes('Provider said:') && /didn[’']t respond in time on any of \d+ attempts/.test(content)
  const replacesContent = message.role !== 'user' && (prefixed || providerNotice || (!!error && content === error) || !content)
  const detail = [...new Set([replacesContent ? content.replace(failurePrefix, '') : '', error].filter(Boolean))]
    .filter((value, index, values) => !values.some((other, otherIndex) => otherIndex !== index && other.includes(value))).join('\n\n')
  const timeout = /timeout|timed?\s*out|no SSE events|didn[’']t respond in time|超时/i.test(error || detail)
  return {
    title: message.role === 'user' ? '消息未发送' : timeout ? '响应超时' : '回复暂时中断',
    hint: message.role === 'user' ? '请检查连接后重新发送。' : '请稍后重试，或切换模型。',
    detail, key: error || detail, replacesContent,
  }
}

/** Fold only the scheduler's immediately repeated system failure, never a user's message. */
export function collapseDuplicateFailures(messages: UiMessage[]): UiMessage[] {
  return messages.filter((message, index) => {
    const previous = messages[index - 1]
    if (!previous || previous.role !== 'assistant' || message.role !== 'system' || !/^执行失败[：:]/.test(message.content)) return true
    const failure = messageFailure(message), prior = messageFailure(previous)
    if (!failure?.key || failure.key !== prior?.key || message.attachments?.length || message.tools?.length || message.reasoning) return true
    if (message.runId && previous.runId) return message.runId !== previous.runId
    const at = new Date(message.createdAt ?? '').getTime(), before = new Date(previous.createdAt ?? '').getTime()
    return !Number.isFinite(at) || !Number.isFinite(before) || at < before || at - before > 2000
  })
}
