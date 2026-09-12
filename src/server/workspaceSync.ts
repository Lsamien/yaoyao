import type Koa from 'koa'
import type { LocalAuthStore } from './localAuth.js'
import type { WorkspaceStore } from './workspaceStore.js'
import type { WorkspaceRuntime } from './workspaceRuntime.js'
import { readServerIdentity } from './serverIdentity.js'
import type { WorkspaceConversation, WorkspaceEvent, WorkspaceInteraction, WorkspaceRun } from '../shared/workspace.js'

/** Bot transcripts are a local projection. Snapshot and cursor are read in the same synchronous turn. */
export function workspaceDetail(store: WorkspaceStore, runtime: WorkspaceRuntime, owner: string,
  conversationId: string, taskId?: string, limit = 50) {
  const conversation = store.require<WorkspaceConversation>(owner, 'conversation', conversationId)
  const task = store.resolveTask(owner, conversationId, taskId)
  const activeRunId = task?.activeRunId ?? (conversation.kind === 'direct' ? conversation.activeRunId : undefined)
  const page = store.messages(owner, conversationId, Number.MAX_SAFE_INTEGER, limit + 1, false, task?.id)
  return {
    conversation: store.conversationSummary(owner, conversation), task: task ?? null,
    tasks: conversation.kind === 'group' ? store.tasks(owner, conversationId) : [],
    assignments: task ? runtime.tasks.assignments(owner, task.id) : [],
    messages: page.slice(-limit), hasOlder: page.length > limit,
    hiddenMessageIds: store.hiddenMessageIds(owner, conversationId, task?.id),
    run: activeRunId ? store.require<WorkspaceRun>(owner, 'run', activeRunId) : null,
    interactions: store.list<WorkspaceInteraction>(owner, 'interaction')
      .filter(value => value.conversationId === conversationId && value.conversationTaskId === task?.id && !value.resolved),
    context: store.get<Record<string, unknown>>(owner, 'context', task?.id ?? conversationId) ?? null,
    cursor: store.cursor(owner),
  }
}

/** Durable replay followed by live updates. A slow reader reconnects from its last applied cursor. */
export function streamWorkspace(ctx: Koa.Context, store: WorkspaceStore, auth: LocalAuthStore): void {
  const owner = auth.require(ctx).id, version = auth.pushAuthorizationVersion(owner)
  const res = ctx.res
  const raw = ctx.get('last-event-id') || String(ctx.query.after ?? '0')
  let cursor = /^\d+$/.test(raw) ? Number(raw) : 0
  let closed = false
  const valid = () => {
    try { return auth.require(ctx).id === owner && auth.isUserActive(owner) && auth.pushAuthorizationVersion(owner) === version }
    catch { return false }
  }
  const close = () => {
    if (closed) return
    closed = true; clearInterval(heartbeat)
    store.changes.off(owner, deliver); store.changes.off('workspace.close', close)
    if (!res.writableEnded) res.end()
  }
  const write = (text: string) => {
    if (closed || res.destroyed || res.writableEnded || !valid()) { close(); return }
    if (res.writableLength + Buffer.byteLength(text) > 4 * 1024 * 1024) { close(); return }
    res.write(text)
  }
  const deliver = (event: WorkspaceEvent) => {
    if (event.seq <= cursor) return
    write(`id: ${event.seq}\nevent: workspace\ndata: ${JSON.stringify(event)}\n\n`)
    cursor = event.seq
  }
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000)
  heartbeat.unref()
  ctx.respond = false
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.once('close', close); res.once('error', close)
  store.changes.on(owner, deliver); store.changes.once('workspace.close', close)
  const latest = store.cursor(owner)
  if (!Number.isSafeInteger(cursor) || cursor > latest) {
    write('event: reset\ndata: {}\n\n'); close(); return
  }
  // No await between replay and subscription: an event cannot fall through that boundary.
  while (!closed && cursor < latest) {
    const page = store.events(owner, cursor)
    if (!page.length) break
    for (const event of page) deliver(event)
  }
  write(`event: ready\ndata: ${JSON.stringify({ cursor, serverIdentity: readServerIdentity(store) })}\n\n`)
}
