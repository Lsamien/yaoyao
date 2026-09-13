import type { WorkspaceEvent, WorkspaceMessage, WorkspaceMessagePatch } from './workspace.js'

export const WORKSPACE_PATCH_CAPABILITY = 'workspace-message-patch-v1'
export const WORKSPACE_PATCH_FORMAT = 'patch-v1'

export function messageAppendPatch(previous: WorkspaceMessage | undefined, next: WorkspaceMessage): WorkspaceMessagePatch | undefined {
  if (!previous?.revision || previous.status !== 'streaming' || next.status !== 'streaming'
    || !next.content.startsWith(previous.content) || !next.reasoning.startsWith(previous.reasoning)) return
  const { content: oldContent, reasoning: oldReasoning, revision: oldRevision, ...oldFields } = previous
  const { content, reasoning, revision, ...fields } = next
  if (content === oldContent && reasoning === oldReasoning) return
  if (JSON.stringify(oldFields) !== JSON.stringify(fields)) return
  return { id: next.id, conversationId: next.conversationId, conversationTaskId: next.conversationTaskId,
    baseRevision: oldRevision, revision: revision!, contentAppend: content.slice(oldContent.length), reasoningAppend: reasoning.slice(oldReasoning.length) }
}

export class WorkspacePatchGap extends Error {
  constructor() { super('消息版本不连续，需要重新同步') }
}

/** Wire patches are normalized before they enter history/ACK reconciliation. */
export class WorkspaceMessageReconciler {
  private messages = new Map<string, WorkspaceMessage>()
  clear(): void { this.messages.clear() }
  remember(message: WorkspaceMessage): void {
    const previous = this.messages.get(message.id)
    if (previous && (previous.revision ?? 0) > (message.revision ?? 0)) return
    this.messages.delete(message.id); this.messages.set(message.id, message)
    while (this.messages.size > 512) this.messages.delete(this.messages.keys().next().value!)
  }
  normalize(event: WorkspaceEvent): WorkspaceEvent {
    if (event.type === 'conversation.deleted' || event.type === 'task.deleted') {
      const id = (event.data as { id: string }).id
      for (const [key, message] of this.messages) {
        if (event.type === 'conversation.deleted' ? message.conversationId === id : message.conversationTaskId === id) this.messages.delete(key)
      }
    }
    if (event.type === 'message.changed') {
      const message = event.data as WorkspaceMessage
      this.remember(message)
      return { ...event, data: this.messages.get(message.id)! }
    }
    if (event.type !== 'message.patch') return event
    const patch = event.data as WorkspaceMessagePatch, base = this.messages.get(patch.id)
    if (!base || base.conversationId !== patch.conversationId || event.conversationId !== patch.conversationId
      || (base.conversationTaskId ?? null) !== (patch.conversationTaskId ?? null)
      || !Number.isSafeInteger(patch.baseRevision) || patch.baseRevision < 1
      || patch.revision !== patch.baseRevision + 1
      || typeof patch.contentAppend !== 'string' || typeof patch.reasoningAppend !== 'string') throw new WorkspacePatchGap()
    if ((base.revision ?? 0) >= patch.revision) return { ...event, type: 'message.changed', data: base }
    if (base.revision !== patch.baseRevision) throw new WorkspacePatchGap()
    const message = { ...base, revision: patch.revision,
      content: base.content + patch.contentAppend, reasoning: base.reasoning + patch.reasoningAppend }
    this.remember(message)
    return { ...event, type: 'message.changed', data: message }
  }
}
