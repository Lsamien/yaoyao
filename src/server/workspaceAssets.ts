import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { lookup } from 'mime-types'
import { WorkspaceStore } from './workspaceStore.js'
import { WorkspaceNodes } from './workspaceGateway.js'
import type { WorkspaceAgent, WorkspaceFile, WorkspaceMessage } from '../shared/workspace.js'
export interface StoredWorkspaceFile extends WorkspaceFile {
  path: string
  digest?: string
}
export function publicFile(f: StoredWorkspaceFile): WorkspaceFile {
  const { path: _path, digest: _digest, ...result } = f
  return result
}
export function libraryFile(
  f: WorkspaceFile,
  id: number,
  conversation?: { id: string; name: string },
) {
  const path = `/api/app/files/${f.id}/download`
  const origin = {
    id,
    sourceKind: f.sender === 'user' ? 'upload' : 'agent_generated',
    eventKind: f.sender === 'user' ? 'uploaded' : 'generated',
    username: '',
    profile: f.profile ?? '',
    agent: f.profile ?? '',
    contextType: 'session',
    sessionId: f.conversationId ?? '',
    sessionTitle: conversation?.name ?? '',
    workspaceConversationId: conversation?.id,
    messageId: f.messageId ?? '',
    runId: '',
    workspace: '',
    originalPath: path,
    referencePath: path,
    observedAt: f.createdAt,
    messageTimestamp: f.createdAt,
    authorKind: f.sender,
  }
  return {
    ...f,
    id,
    itemId: id,
    path,
    extension: f.name.split('.').at(-1) ?? '',
    modifiedAt: f.createdAt,
    exists: true,
    firstSeenAt: f.createdAt,
    lastSeenAt: f.createdAt,
    messageTimestamp: f.createdAt,
    origins: [origin],
    archiveStatus: 'ready',
    availability: 'archived',
    archivedAt: f.createdAt,
    messageId: f.messageId ?? null,
    sessionId: f.conversationId ?? null,
    displayName: f.name,
    contentType: f.mimeType,
    byteCount: f.size,
    sizeBytes: f.size,
    kind: f.mimeType.startsWith('image/')
      ? 'image'
      : f.mimeType.startsWith('video/')
        ? 'video'
        : f.mimeType.startsWith('text/')
          ? 'text'
          : 'file',
    createdAt: new Date(f.createdAt).toISOString(),
    downloadUrl: path,
    previewUrl: `/api/app/files/${f.id}/preview`,
  }
}
export class WorkspaceAssets {
  private stopped = false
  private pending = new Set<string>()
  constructor(
    readonly store: WorkspaceStore,
    readonly nodes: WorkspaceNodes,
    readonly home: string,
  ) {}
  async archive(owner: string, message: WorkspaceMessage): Promise<void> {
    if (!message.agentId) return
    const agent = this.store.require<WorkspaceAgent>(owner, 'agent', message.agentId)
    await this.archiveText(
      owner,
      message.content + '\n' + JSON.stringify(message.tools),
      agent.nodeId,
      agent.profile,
      message.conversationId,
      message.id,
      'agent',
      agent.remoteAgentId,
    )
    if (this.stopped) return
    const attachments = this.store
      .list<StoredWorkspaceFile>(owner, 'file')
      .filter((f) => f.messageId === message.id)
      .map(publicFile)
    if (attachments.length) {
      message.attachments = attachments
      this.store.saveMessage(owner, message)
    }
  }
  async archiveText(
    owner: string,
    text: string,
    nodeId: string,
    profile: string,
    conversationId: string,
    messageId: string,
    sender: 'user' | 'agent' = 'agent',
    remoteAgentId?: string,
  ): Promise<void> {
    if (this.stopped) return
    const paths = new Set<string>()
    for (const m of text.matchAll(
      /(?:MEDIA:\s*|\]\(<?|"(?:path|file_path|output_path)"\s*:\s*")((?:\/|~\/)[^\n"<>)]{1,4096})/g,
    ))
      paths.add(m[1]!.replace(/\\n.*$/, '').trim())
    for (const path of [...paths].slice(0, 8)) {
      const key = createHash('sha256')
        .update(JSON.stringify([nodeId, profile, messageId, path]))
        .digest('hex')
      if (this.store.get(owner, 'archived-path', key) || this.pending.has(`${owner}:${key}`))
        continue
      this.pending.add(`${owner}:${key}`)
      try {
        const response = await (remoteAgentId ? this.nodes.targetForAgent(owner,{nodeId,remoteAgentId}) : this.nodes.target(owner,nodeId))
          .session.request('/api/files/download', {
            search: new URLSearchParams({ profile, path }),
            maxResponseBytes: 25 * 1024 * 1024,
          })
        if (response.status !== 200 || this.stopped) continue
        const dir = join(this.home, 'workspace-files', owner)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const digest = createHash('sha256').update(response.body).digest('hex')
        const id = randomUUID(),
          saved = join(dir, digest),
          name = basename(path)
        try { writeFileSync(saved, response.body, { mode: 0o600, flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        const file: StoredWorkspaceFile = {
          id,
          sourcePath: path,
          path: saved,
          digest,
          name,
          mimeType: String(
            response.headers.get('content-type') || lookup(name) || 'application/octet-stream',
          ).split(';')[0]!,
          size: response.body.length,
          sender,
          profile,
          conversationId,
          messageId,
          createdAt: Date.now(),
        }
        this.store.atomic(() => {
          this.store.put(owner, 'file', id, file)
          this.store.put(owner, 'archived-path', key, true)
          this.store.event(owner, 'files.changed', publicFile(file), conversationId)
        })
      } catch {
        /* A missing upstream file does not fail an otherwise completed reply. */
      } finally {
        this.pending.delete(`${owner}:${key}`)
      }
    }
  }
  close(): void {
    this.stopped = true
  }
}
