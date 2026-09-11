/** Shared durable representation of an ordinary Hermes turn. No client timers or UI state. */
export type ChatRecord = Record<string, any>
const text = (p: ChatRecord) => String(p.delta ?? p.text_delta ?? p.content_delta ?? p.text ?? '')
export function projectChatEvent(type: string, payload: ChatRecord, previous: ChatRecord | undefined,
  fallbackID: string, now: number): ChatRecord | undefined {
  const supported = /^(message\.(start|delta|interim|complete)|reasoning\.(delta|complete)|tool\.|run\.(completed|failed)|error$)/.test(type)
  if (!supported) return undefined
  const supplied = payload.message && typeof payload.message === 'object' ? payload.message : {}
  const id = String(supplied.id ?? payload.message_id ?? previous?.id ?? fallbackID)
  const message: ChatRecord = { role: 'assistant', content: '', reasoning: '', timestamp: now / 1000,
    ...previous, ...supplied, id }
  if (type === 'message.delta') message.content = String(message.content ?? '') + text(payload)
  if (type === 'message.interim') message.status = 'complete'
  if (type === 'reasoning.delta') message.reasoning = String(message.reasoning ?? '') + text(payload)
  if (type.startsWith('tool.')) {
    const tools: ChatRecord[] = Array.isArray(message.tool_calls) ? [...message.tool_calls] : []
    const toolID = String(payload.tool_id ?? payload.tool_call_id ?? payload.id ?? '')
    const index = tools.findIndex(t => t.id === toolID)
    const value = { ...(index >= 0 ? tools[index] : {}), ...payload, id: toolID, status: type }
    if (index >= 0) tools[index] = value; else tools.push(value)
    message.tool_calls = tools
  }
  if (type === 'message.complete' || type === 'run.completed') {
    if (typeof payload.output === 'string') message.content = payload.output
    else if (typeof payload.content === 'string') message.content = payload.content
    else if (typeof payload.text === 'string') message.content = payload.text
    message.status = payload.error || ['error','failed'].includes(payload.status) ? 'failed' : 'complete'
    if(payload.error)message.error=payload.error
  } else if (type === 'error' || type === 'run.failed') {
    message.status = 'failed'; message.error = String(payload.error ?? payload.message ?? '运行失败')
  } else if (type !== 'message.interim') message.status = 'streaming'
  message.final_result = (type === 'message.complete' || type === 'run.completed') && message.status === 'complete'
  return message
}
