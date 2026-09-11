/** List badges count completed results; transport rows and progress never count. */
export function isFinalChatResult(message: Record<string, any>): boolean {
  if (message.role !== 'assistant' || message.error || message.is_streaming || message.isStreaming) return false
  if (message.final_result === false || message.is_interim || message.display_kind || message.displayKind) return false
  const status = message.status ?? message.finish_reason ?? message.finishReason
  if (['streaming', 'pending', 'running', 'interim', 'failed', 'error', 'cancelled', 'interrupted', 'tool_calls', 'function_call'].includes(status)) return false
  // Live projections retain tool traces on the final answer. Historical tool
  // invocation rows have no explicit completion marker and must be excluded.
  if (message.final_result !== true) {
    let tools = message.tool_calls ?? message.toolCalls ?? message.tools
    if (typeof tools === 'string') {
      try { tools = JSON.parse(tools) } catch { return false }
    }
    if ((Array.isArray(tools) ? tools.length > 0 : !!tools) || message.function_call) return false
    if (Array.isArray(message.content) && message.content.some(block =>
      ['tool_use', 'tool_call', 'function_call'].includes(block?.type))) return false
  }
  const content = message.content ?? message.text
  const visible = (value: unknown) => typeof value === 'string'
    && value.replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '').trim().length > 0
  return visible(content)
    || (Array.isArray(content) && content.some(block => block && (
      ['text', 'output_text'].includes(block.type) && visible(block.text)
      || ['image', 'image_url', 'file', 'audio', 'video'].includes(block.type))))
    || (Array.isArray(message.attachments) && message.attachments.length > 0)
}
