// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { streamWorkspace } from '../../src/server/workspaceSync'
import { WorkspaceMessageReconciler, WorkspacePatchGap } from '../../src/shared/workspaceMessagePatch'
import type { WorkspaceConversation, WorkspaceEvent, WorkspaceMessage } from '../../src/shared/workspace'
import type { LocalAuthStore } from '../../src/server/localAuth'

let home: string, store: WorkspaceStore, message: WorkspaceMessage, server: Server
const auth = { require: () => ({ id: 'owner' }), isUserActive: () => true, pushAuthorizationVersion: () => 1 } as unknown as LocalAuthStore
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'workspace-patches-'))
  store = new WorkspaceStore(home, { messagePatches: true })
  store.createAgent('owner', { name: 'Patch', profile: 'default' })
  const conversation = store.list<WorkspaceConversation>('owner', 'conversation')[0]!
  message = { id: 'm', conversationId: conversation.id, seq: 0, role: 'assistant', content: '开始', reasoning: '', status: 'streaming', attachments: [], tools: [], createdAt: Date.now() }
  store.saveMessage('owner', message)
  const app = new Koa(); app.use(ctx => streamWorkspace(ctx, store, auth))
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
})
afterEach(async () => {
  store.close(); server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
})
const url = (format = '') => `http://127.0.0.1:${(server.address() as { port: number }).port}/?format=${format}`
const append = (text: string) => { message.content += text; store.saveMessage('owner', message) }

it('persists compact patches atomically while observers see complete stable messages', () => {
  const cursor = store.cursor('owner'), events: WorkspaceEvent[] = []
  store.observe((_, event) => events.push(structuredClone(event)))
  const folder = new WorkspaceMessageReconciler(); folder.remember(structuredClone(message))
  for (let i = 0; i < 40; i++) append(`中文🙂组合e\u0301-${i}`)
  const patches = store.events('owner', cursor).filter(e => e.type === 'message.patch')
  expect(patches).toHaveLength(40)
  for (const event of patches) folder.normalize(event)
  const last = folder.normalize(patches.at(-1)!)
  expect((last.data as WorkspaceMessage).content).toBe(message.content)
  expect(store.require<WorkspaceMessage>('owner', 'message', 'm')).toEqual(message)
  expect(events.filter(e => e.type === 'message.changed')).toHaveLength(40)
  expect(events.some(e => e.type === 'message.patch')).toBe(false)
  expect(events.filter(e => e.type === 'conversation.changed').length).toBeLessThan(5)
  expect(message.revision).toBe(41)
})

it('uses complete events for tools, rewritten content, visibility and terminal changes', () => {
  append('文字')
  for (const change of [() => { message.tools = [{ id: 'tool', status: 'running' }] },
    () => { message.content = '改写' }, () => { message.visible = false }, () => { message.visible = true },
    () => { message.status = 'complete' as const }]) {
    const cursor = store.cursor('owner'); change(); store.saveMessage('owner', message)
    expect(store.events('owner', cursor).some(e => e.type === 'message.changed')).toBe(true)
    expect(store.events('owner', cursor).some(e => e.type === 'message.patch')).toBe(false)
  }
})

it('detects missing revisions and task mismatches without manufacturing a second message', () => {
  const cursor = store.cursor('owner'), baseline = structuredClone(message)
  append('a'); append('b')
  const patches = store.events('owner', cursor).filter(e => e.type === 'message.patch')
  const folder = new WorkspaceMessageReconciler(); folder.remember(baseline)
  expect(() => folder.normalize(patches[1]!)).toThrow(WorkspacePatchGap)
  const first = folder.normalize(patches[0]!)
  expect(folder.normalize(patches[0]!).data).toEqual(first.data)
  expect(() => folder.normalize({ ...patches[1]!, data: { ...(patches[1]!.data as object), conversationTaskId: 'other' } })).toThrow(WorkspacePatchGap)
})

it('keeps persisted patches readable after restart and asks legacy replay to hydrate', async () => {
  const cursor = store.cursor('owner'); append('持久化')
  store.close(); store = new WorkspaceStore(home, { messagePatches: false })
  expect(store.require<WorkspaceMessage>('owner', 'message', 'm').content).toBe(message.content)
  expect(store.events('owner', cursor)[0]!.type).toBe('message.patch')
  const response = await fetch(url(), { headers: { 'Last-Event-ID': String(cursor) } })
  expect(await response.text()).toContain('event: reset')
})

it('sends a full live baseline then patches, with ordered legacy full frames and terminal flush', async () => {
  const cursor = store.cursor('owner')
  async function connect(format: string) {
    const controller = new AbortController()
    const response = await fetch(url(format), { headers: { 'Last-Event-ID': String(cursor) }, signal: controller.signal })
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let text = ''
    const until = async (needle: string) => { while (!text.includes(needle)) text += decoder.decode((await reader.read()).value); return text }
    await until('event: ready')
    return { controller, reader, until }
  }
  const modern = await connect('patch-v1'), legacy = await connect('')
  try {
    append('a'); append('b'); append('c')
    message.status = 'complete'; store.saveMessage('owner', message)
    const a = await modern.until('"status":"complete"'), b = await legacy.until('"status":"complete"')
    expect(a).toContain('"type":"message.patch"')
    expect(a).toContain('"content":"开始a"')
    expect(b).not.toContain('"type":"message.patch"')
    expect(b).toContain('"content":"开始abc"')
    const ids = [...b.matchAll(/^id: (\d+)/gm)].map(m => Number(m[1]))
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b))
  } finally { modern.controller.abort(); legacy.controller.abort(); await modern.reader.cancel().catch(() => {}); await legacy.reader.cancel().catch(() => {}) }
})

it('rolls back both the full row and patch event before any observer sees an update', () => {
  const cursor = store.cursor('owner'), before = structuredClone(message), observed: WorkspaceEvent[] = []
  store.observe((_, event) => observed.push(event))
  store.db.exec("CREATE TRIGGER reject_patch BEFORE INSERT ON workspace_events WHEN NEW.type='message.patch' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
  expect(() => append('回滚文字')).toThrow('fixture rollback')
  expect(store.require('owner', 'message', 'm')).toEqual(before)
  expect(store.cursor('owner')).toBe(cursor); expect(observed).toEqual([])
  store.db.exec('DROP TRIGGER reject_patch')
  store.saveMessage('owner', message)
  expect(store.require<WorkspaceMessage>('owner', 'message', 'm').revision).toBe(2)
  expect(store.events('owner', cursor).filter(e => e.type === 'message.patch')).toHaveLength(1)
})

it('flushes the last paused-stream preview without creating an extra message revision', async () => {
  append('暂停前的最后文字')
  const revision = message.revision
  await new Promise(resolve => setTimeout(resolve, 280))
  expect(store.require<WorkspaceConversation>('owner', 'conversation', message.conversationId).preview).toContain('暂停前的最后文字')
  expect(store.require<WorkspaceMessage>('owner', 'message', 'm').revision).toBe(revision)
})

it('persists card-only messages and replays installation updates as full frames without losing the card on text patches',()=>{
  message.content='';message.visible=true
  message.browserCard={id:'browser-turn',agentId:'bot',agentName:'浏览器 Bot',status:'preparing',installation:{status:'installing',message:'下载中',progress:20,updatedAt:1},updatedAt:1}
  let cursor=store.cursor('owner')
  store.saveMessage('owner',message)
  expect(store.events('owner',cursor).find(e=>e.type==='message.changed')?.data).toMatchObject({browserCard:{installation:{progress:20}}})
  expect(store.require<WorkspaceConversation>('owner','conversation',message.conversationId).preview).toContain('托管浏览器')
  const folder=new WorkspaceMessageReconciler();folder.remember(structuredClone(message))
  cursor=store.cursor('owner')
  message.browserCard={...message.browserCard,status:'active',title:'测试网页',url:'https://example.com/',installation:{status:'ready',message:'已就绪',updatedAt:2},updatedAt:2}
  store.saveMessage('owner',message)
  const events=store.events('owner',cursor)
  expect(events.some(e=>e.type==='message.patch')).toBe(false)
  for(const e of events)folder.normalize(e)
  cursor=store.cursor('owner');append('浏览器已打开')
  const patched=folder.normalize(store.events('owner',cursor).find(e=>e.type==='message.patch')!)
  expect(patched.data).toMatchObject({content:'浏览器已打开',browserCard:{status:'active',title:'测试网页'}})
  message.content='';message.status='complete';message.browserCard={...message.browserCard,status:'closed'}
  store.saveMessage('owner',message)
  store.close();store=new WorkspaceStore(home,{messagePatches:true})
  expect(store.require<WorkspaceMessage>('owner','message',message.id)).toMatchObject({visible:true,status:'complete',content:'',browserCard:{status:'closed',title:'测试网页'}})
  expect(store.require<WorkspaceConversation>('owner','conversation',message.conversationId).unread).toBe(true)
})

it('persists nonfatal service warnings independently of reply text and keeps terminal warning-only replies visible',()=>{
  message.content='';message.visible=true
  message.serviceWarnings=[{service:'离线服务',code:'plugin_initialization_failed',message:'本轮未连接'}]
  const cursor=store.cursor('owner');store.saveMessage('owner',message)
  expect(store.events('owner',cursor).find(e=>e.type==='message.changed')?.data).toMatchObject({serviceWarnings:message.serviceWarnings})
  expect(store.require<WorkspaceConversation>('owner','conversation',message.conversationId).preview).toBe('部分服务暂时不可用')
  message.status='complete';store.saveMessage('owner',message)
  expect(store.require<WorkspaceMessage>('owner','message',message.id)).toMatchObject({visible:true,content:'',status:'complete',serviceWarnings:message.serviceWarnings})
  expect(store.require<WorkspaceConversation>('owner','conversation',message.conversationId).unread).toBe(true)
})
