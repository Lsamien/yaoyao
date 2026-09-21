// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatCacheStore } from '../../src/server/chatCache'
import { applyTranscriptEvent } from '../../src/shared/chatTranscript'
import fixture from '../fixtures/ordinary-chat-v2/protocol.json'
const scope = ['owner', 'p', 's'] as const
const stores: Array<{ home: string; store: ChatCacheStore }> = []
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ordinary-v2-')),
    store = new ChatCacheStore(home)
  stores.push({ home, store })
  store.recordCommand(...scope, 'session.create', { source: 'web' })
  let seq = 0
  return {
    store,
    send: (type: string, payload: object = {}, id?: string) =>
      store.recordEvent(...scope, { type, payload, delivery_id: id ?? String(++seq) }),
  }
}
afterEach(() => {
  for (const f of stores.splice(0)) {
    if (!f.store.isClosed) f.store.close()
    rmSync(f.home, { recursive: true, force: true })
  }
})
const messages = (store: ChatCacheStore) => store.transcripts.all(...scope)
describe('ordinary v2 canonical writer', () => {
  it('updates a final preview in place and never writes another live representation', () => {
    const { store, send } = setup()
    send('message.start')
    send('message.delta', { text: '已经完成。' })
    const id = messages(store)[0]!.id
    for (let i = 0; i < 3; i++) send('message.interim', { text: '已经完成。', already_streamed: true })
    send('message.complete', { text: '已经完成。', response_previewed: true })
    send('run.completed', { text: '已经完成。' })
    expect(messages(store)).toHaveLength(1)
    expect(messages(store)[0]).toMatchObject({
      id,
      content: '已经完成。',
      status: 'complete',
      final_result: true,
    })
    expect(store.db.prepare('SELECT COUNT(*) n FROM chat_messages').get()!.n).toBe(0)
  })
  it('restores an active turn through a snapshot then promotes its upstream ID', () => {
    const { store, send } = setup()
    send('route.resumed', { running: true, inflight: { assistant: '前半段' } })
    const id = messages(store)[0]!.id
    send('message.delta', { message_id: 'upstream-event', text: '后半段' })
    send('message.complete', { message_id: 'persisted-42', text: '前半段后半段' })
    expect(messages(store)).toHaveLength(1)
    expect(messages(store)[0]).toMatchObject({
      id,
      source_message_id: 'persisted-42',
      content: '前半段后半段',
    })
  })
  it('preserves two identical actual sends and their queued turns across restart', () => {
    const { store, send } = setup()
    store.recordCommand(...scope, 'prompt.submit', { text: '相同问题', _delivery_id: 'web:prompt:one' })
    send('command.confirmed', { delivery_id: 'web:prompt:one' })
    send('message.start')
    send('message.delta', { text: '相同回复' })
    store.recordCommand(...scope, 'prompt.submit', {
      text: '相同问题',
      _delivery_id: 'web:prompt:two',
      queued: true,
    })
    send('command.confirmed', { delivery_id: 'web:prompt:two', status: 'queued' })
    send('message.complete', { text: '相同回复', queue_remaining: 1 })
    send('message.start')
    send('message.delta', { text: '相同回复' })
    send('message.complete', { text: '相同回复' })
    const all = messages(store)
    expect(all.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(all.filter((m) => m.final_result)).toHaveLength(2)
    expect(new Set(all.filter((m) => m.role === 'assistant').map((m) => m.turn_id)).size).toBe(2)
    const { home } = stores.at(-1)!
    store.close()
    const reopened = new ChatCacheStore(home)
    try {
      expect(messages(reopened)).toEqual(all)
    } finally {
      reopened.close()
    }
  })
  it('drops the local queue entry once the upstream accepts the prompt immediately', () => {
    const { store, send } = setup()
    store.recordCommand(...scope, 'prompt.submit', { text: '第一问', _delivery_id: 'web:prompt:one' })
    send('command.confirmed', { delivery_id: 'web:prompt:one' })
    send('message.start')
    send('message.delta', { text: '第一答' })
    // A lingering background job keeps the transcript head "running" after
    // the visible turn finished.
    send('message.complete', { text: '第一答', background_pending: 1 })
    store.recordCommand(...scope, 'prompt.submit', { text: '第二问', _delivery_id: 'web:prompt:two' })
    expect(store.transcripts.head(...scope).queued).toBe(true)
    // The upstream was actually idle and accepted the second prompt for
    // immediate execution; the local queue entry was only a stale mirror.
    send('command.confirmed', { delivery_id: 'web:prompt:two' })
    const head = store.transcripts.head(...scope)
    expect(head.queued).toBe(false)
    expect(head.queue).toHaveLength(0)
    send('message.start')
    send('message.delta', { text: '第二答' })
    send('message.complete', { text: '第二答' })
    const all = messages(store)
    expect(all.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(all.filter((m) => m.final_result)).toHaveLength(2)
    expect(new Set(all.filter((m) => m.role === 'assistant').map((m) => m.turn_id)).size).toBe(2)
    expect(store.transcripts.head(...scope).running).toBe(false)
  })
  it('places a steered message at the insertion point and continues the reply after it', () => {
    const { store, send } = setup()
    store.recordCommand(...scope, 'prompt.submit', { text: '开始', _delivery_id: 'web:prompt:one' })
    send('message.delta', { text: '前' })
    const assistant = messages(store).find((m) => m.role === 'assistant')!
    store.recordCommand(...scope, 'session.steer', { text: '补充', _delivery_id: 'web:prompt:steer' })
    send('message.delta', { text: '后' })
    send('message.complete', { text: '前后' })
    expect(messages(store).map((m) => [m.role, m.content])).toEqual([
      ['user', '开始'],
      ['assistant', '前'],
      ['user', '补充'],
      ['assistant', '后'],
    ])
    expect(messages(store).find((m) => m.content === '前')!.id).toBe(assistant.id)
    expect(new Set(messages(store).map((m) => m.turn_id)).size).toBe(1)
  })
  it('keeps a delayed tool result attached to its original segment', () => {
    const { store, send } = setup()
    send('message.interim', { text: '开始检查' })
    send('tool.start', { tool_id: 't', name: 'terminal' })
    send('message.interim', { text: '过程说明' })
    send('message.delta', { text: '完成' })
    send('tool.complete', { tool_id: 't', result: 'ok' })
    send('message.complete', { text: '完成' })
    expect(messages(store).map((m) => m.content)).toEqual(['开始检查', '过程说明', '完成'])
    expect(messages(store).flatMap((m) => (m.tool_calls ?? []) as object[])).toMatchObject([
      { id: 't', result: 'ok' },
    ])
  })
  it('keeps the visible wait through a tool-round complete', () => {
    const { store, send } = setup()
    send('message.delta', { text: '先查一下' })
    send('message.complete', { text: '先查一下', finish_reason: 'tool_calls' })
    expect(store.transcripts.head(...scope)).toMatchObject({ running: true, terminal: false })
    send('tool.start', { tool_id: 't', name: 'terminal' })
    send('message.complete', { text: '先查一下' })
    expect(store.transcripts.head(...scope).running).toBe(true)
    const calls = messages(store).flatMap((m) => (m.tool_calls ?? []) as { id: string; status: string }[])
    expect(calls).toMatchObject([{ id: 't', status: 'running' }])
    send('tool.complete', { tool_id: 't', result: 'ok' })
    send('message.delta', { text: '查完了' })
    send('message.complete', { text: '查完了', finish_reason: 'stop' })
    expect(store.transcripts.head(...scope).running).toBe(false)
    expect(messages(store).filter((m) => m.final_result)).toHaveLength(1)
  })
  it('deduplicates persisted source receipts after a restart', () => {
    const { store } = setup(),
      frame = {
        type: 'message.delta',
        session_id: 'runtime',
        epoch: 'upstream-epoch',
        seq: 3,
        payload: { text: '哈' },
        delivery_id: 'upstream-epoch:runtime:3',
      }
    store.recordEvent(...scope, frame)
    const before = messages(store)
    const home = stores.at(-1)!.home
    store.close()
    const reopened = new ChatCacheStore(home)
    try {
      expect(reopened.recordEvent(...scope, frame)).toBe(false)
      expect(messages(reopened)).toEqual(before)
      expect(reopened.transcripts.sourceCursor(...scope, 'runtime', 'upstream-epoch')).toBe(3)
    } finally {
      reopened.close()
    }
  })
  it('repairs a verified idle history in a new epoch without duplicating a partial page', () => {
    const { store, send } = setup()
    send('message.complete', { text: '最终结果' })
    const epoch = store.transcripts.epochFor(...scope)
    const result = store.applySync(
      ...scope,
      store.revision(...scope),
      [
        {
          key: 'history',
          kind: 'messages',
          startedAt: Date.now(),
          response: {
            status: 200,
            headers: new Headers(),
            body: Buffer.from(
              JSON.stringify({
                messages: [{ id: 'server-final', role: 'assistant', content: '最终结果' }],
                pagination: { offset: 0, total: 1 },
              }),
            ),
          },
        },
      ],
      true,
    )
    expect(result).toBe(true)
    expect(messages(store)).toHaveLength(1)
    expect(messages(store)[0]!.content).toBe('最终结果')
    expect(store.transcripts.epochFor(...scope)).not.toBe(epoch)
    expect(store.db.prepare('SELECT COUNT(*) n FROM chat_transcript_archives').get()!.n).toBeGreaterThan(0)
  })
  it('does not replace an active turn or its pending input while history is fetched', () => {
    const { store, send } = setup()
    store.recordCommand(...scope, 'prompt.submit', { text: '保留', _delivery_id: 'web:prompt:one' })
    send('message.delta', { text: '正在回复' })
    const before = messages(store)
    expect(store.applySync(...scope, store.revision(...scope), [], true)).toBe(false)
    expect(messages(store)).toEqual(before)
  })
  it('matches the shared protocol fixture including duplicate delivery', () => {
    let rows = fixture.snapshot.messages as any
    for (const event of fixture.events) rows = applyTranscriptEvent(rows, event as any)
    expect(rows).toEqual(fixture.expectedMessages)
  })
  it('does not append ambiguous replay bytes after an upstream reset snapshot', () => {
    const { store, send } = setup()
    send('message.delta', { text: '前' })
    const id = messages(store)[0]!.id
    send('gateway.reset', { reason: 'upstream_replay_unavailable' })
    send('route.resumed', { running: true, inflight: { assistant: '前后' } })
    send('message.delta', { text: '后' })
    expect(messages(store)[0]).toMatchObject({ id, content: '前后' })
    send('message.complete', { text: '前后完整结果' })
    expect(messages(store)).toHaveLength(1)
    expect(messages(store)[0]).toMatchObject({ id, content: '前后完整结果' })
  })
  it('does not allow another viewer resume to overwrite a newer live stream', () => {
    const { store, send } = setup()
    send('message.delta', { text: '较新的正文' })
    send('route.resumed', { running: true, inflight: { assistant: '旧快照' } })
    expect(messages(store).map((m) => m.content)).toEqual(['较新的正文'])
  })
  it('routes a late terminal snapshot to its identified old turn', () => {
    const { store, send } = setup()
    send('message.complete', { message_id: 'first', text: '第一轮' })
    store.recordCommand(...scope, 'prompt.submit', { text: '下一轮', _delivery_id: 'web:prompt:two' })
    send('message.delta', { message_id: 'second', text: '正在继续' })
    const current = store.transcripts.head(...scope).current
    send('message.complete', { message_id: 'first', text: '第一轮' })
    expect(store.transcripts.head(...scope)).toMatchObject({ current, running: true })
    expect(
      messages(store)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content),
    ).toEqual(['第一轮', '正在继续'])
  })
  it('keeps structured final attachments and error state in the canonical snapshot', () => {
    const { store, send } = setup()
    send('message.complete', { content: [{ type: 'file', path: '/result.pdf', name: '结果.pdf' }] })
    expect(messages(store)[0]!.content).toEqual([{ type: 'file', path: '/result.pdf', name: '结果.pdf' }])
    send('message.start')
    send('run.failed', { error: '工具执行失败' })
    expect(store.transcripts.snapshot(...scope, {}, 'current')).toMatchObject({
      running: false,
      error: '工具执行失败',
    })
  })
  it('does not resurrect a finished turn when a queued command is rejected late', () => {
    const { store, send } = setup()
    store.recordCommand(...scope, 'prompt.submit', { text: '第一问', _delivery_id: 'web:prompt:first' })
    send('message.delta', { text: '第一轮回复' })
    store.recordCommand(...scope, 'prompt.submit', { text: '排队', _delivery_id: 'web:prompt:queued' })
    send('message.complete', { text: '第一轮回复' })
    send('command.rejected', { delivery_id: 'web:prompt:queued', error: '未加入队列' })
    expect(store.transcripts.head(...scope)).toMatchObject({ running: false, queued: false })
    expect(messages(store).find((m) => m.client_message_id === 'queued')?.status).toBe('failed')
  })
  it('clears obsolete execution queues on an authoritative idle resume without deleting inputs', () => {
    const { store, send } = setup()
    store.recordCommand(...scope, 'prompt.submit', { text: '第一问', _delivery_id: 'web:prompt:first' })
    send('message.delta', { text: '部分回复' })
    store.recordCommand(...scope, 'prompt.submit', { text: '下一问', _delivery_id: 'web:prompt:queued' })
    send('route.resumed', { running: false, queued: null })
    expect(store.transcripts.head(...scope)).toMatchObject({ running: false, queued: false, queue: [] })
    expect(messages(store).filter((m) => m.role === 'user')).toHaveLength(2)
  })
})
