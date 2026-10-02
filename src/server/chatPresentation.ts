import type { WorkspaceEvent, WorkspaceMessage } from '../shared/workspace.js'

/** Display projections never change the durable history or model context. */
export function sessionForList(value: Record<string, unknown>): Record<string, unknown> {
  const { system_prompt: _prompt, systemPrompt: _camelPrompt, tool_names: _tools, toolNames: _camelTools, ...summary } = value
  return summary
}

export function workspaceMessageForClient(message: WorkspaceMessage): WorkspaceMessage {
  return { ...message, tools: message.tools.map((tool, index) => {
    if (Buffer.byteLength(JSON.stringify(tool)) <= 8192) return tool
    const summary: Record<string, unknown> = {}
    for (const key of ['id', 'name', 'tool_name', 'status', 'duration_seconds', 'durationSeconds', 'duration_s']) {
      if (tool[key] !== undefined) summary[key] = tool[key]
    }
    if (!summary.status && (tool.result !== undefined || tool.output !== undefined)) summary.status = 'completed'
    if (typeof tool.error === 'string') summary.error = tool.error.slice(0, 512)
    if (typeof tool.preview === 'string') summary.preview = tool.preview.slice(0, 512)
    const query = new URLSearchParams({ revision: String(message.revision ?? 0) })
    if (tool.id != null) query.set('toolId', String(tool.id))
    summary.detailsUrl = `/api/app/conversations/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}/tools/${index}?${query}`
    return summary
  }) }
}

export function workspaceEventForClient(event: WorkspaceEvent): WorkspaceEvent {
  return event.type === 'message.changed'
    ? { ...event, data: workspaceMessageForClient(event.data as WorkspaceMessage) }
    : event
}
