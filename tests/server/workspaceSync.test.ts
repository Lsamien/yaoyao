// @vitest-environment node
import Koa from 'koa'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { streamWorkspace, workspaceDetail } from '../../src/server/workspaceSync'
import type { LocalAuthStore } from '../../src/server/localAuth'
import type { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import type { Server } from 'node:http'
import type { WorkspaceConversation, WorkspaceMessage } from '../../src/shared/workspace'

let home: string, store: WorkspaceStore, server: Server, version: number
const auth = { require: () => ({ id: 'owner' }), isUserActive: () => true, pushAuthorizationVersion: () => version } as unknown as LocalAuthStore
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'workspace-sync-')); store = new WorkspaceStore(home); version = 1
  const app = new Koa(); app.use(ctx => streamWorkspace(ctx, store, auth))
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
})
afterEach(async () => { store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }) })
const url = () => `http://127.0.0.1:${(server.address() as { port: number }).port}/stream`

it('replays more than one event page, stays owner-scoped, and continues live without a gap', async () => {
  for (let i = 0; i < 270; i++) store.event('owner', 'message.changed', { id: String(i), role: 'assistant', attachments: [], content: `消息${i}` }, 'c')
  store.event('someone-else', 'message.changed', { id: 'private', role: 'assistant', attachments: [], content: '别人的消息' }, 'private')
  const controller = new AbortController()
  const response = await fetch(url(), { signal: controller.signal, headers: { 'Last-Event-ID': '3' } })
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let text = ''
  while (!text.includes('event: ready')) text += decoder.decode((await reader.read()).value, { stream: true })
  expect(text.match(/event: workspace/g)).toHaveLength(267)
  expect(text).not.toContain('别人的消息')
  const seq = store.event('owner', 'conversation.changed', { id: 'c', preview: '新增' }, 'c')
  while (!text.includes(`id: ${seq}\n`)) text += decoder.decode((await reader.read()).value, { stream: true })
  expect(text).toContain('新增')
  controller.abort(); await reader.cancel().catch(() => {})
})

it('closes immediately on a live event after authorization changes', async () => {
  const response = await fetch(url())
  const reader = response.body!.getReader()
  await reader.read()
  version++
  store.event('owner', 'conversation.changed', { id: 'c' }, 'c')
  expect((await reader.read()).done).toBe(true)
  expect(store.changes.listenerCount('owner')).toBe(0)
})

it('requests a fresh snapshot when the database cursor has moved backwards', async () => {
  const response = await fetch(url(), { headers: { 'Last-Event-ID': '999' } })
  expect(await response.text()).toContain('event: reset')
})

it('returns only the latest 50 messages with an exact hasOlder flag and a matching cursor', () => {
  store.createAgent('owner', { name: 'Bot', nodeId: 'local', profile: 'default' })
  const conversation = store.list<WorkspaceConversation>('owner', 'conversation')[0]!
  for (let i = 1; i <= 51; i++) {
    const message: WorkspaceMessage = { id: `m${i}`, conversationId: conversation.id, seq: i, role: 'user', content: String(i), reasoning: '', status: 'complete', attachments: [], tools: [], createdAt: i }
    store.saveMessage('owner', message)
  }
  const runtime = { tasks: { assignments: () => [] } } as unknown as WorkspaceRuntime
  const detail = workspaceDetail(store, runtime, 'owner', conversation.id)
  expect(detail.messages).toHaveLength(50)
  expect(detail.messages[0]!.content).toBe('2')
  expect(detail.hasOlder).toBe(true)
  expect(detail.cursor).toBe(store.cursor('owner'))
  expect(() => workspaceDetail(store, runtime, 'another', conversation.id)).toThrow()
})
