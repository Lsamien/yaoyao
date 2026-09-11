// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatCacheStore } from '../../src/server/chatCache.js'
import { isFinalChatResult } from '../../src/server/chatUnread.js'

const stores: ChatCacheStore[] = [], homes: string[] = []
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'chat-unread-')); homes.push(home)
  const store = new ChatCacheStore(home); stores.push(store)
  store.recordCommand('owner', 'default', 'chat', 'session.create', {})
  return { store, home }
}
function snapshot(store: ChatCacheStore, messages: object[], total = messages.length) {
  store.putSnapshot('owner', 'messages', 'messages', 'default', 'chat', {
    status: 200, headers: new Headers(), body: Buffer.from(JSON.stringify({
      messages, pagination: { total, offset: 0 },
    })),
  })
}
afterEach(() => {
  for (const store of stores.splice(0)) if (!store.isClosed) store.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('ordinary conversation list unread results', () => {
  it('counts final history replies while preserving the existing counters and raw read positions', () => {
    const { store } = setup()
    const messages = [
      { id: 'u', role: 'user', content: '问题' },
      { id: 'call', role: 'assistant', content: '先查一下', tool_calls: JSON.stringify([{ id: 'tool' }]) },
      { id: 'tool', role: 'tool', content: '查询结果' },
      { id: 'reasoning', role: 'assistant', content: '<think>思考</think>' },
      { id: 'interim', role: 'assistant', content: '继续处理', final_result: false, status: 'complete' },
      { id: 'final', role: 'assistant', content: '最终结果' },
      { id: 'user2', role: 'user', content: '再问' },
      { id: 'final2', role: 'assistant', content: '第二个结果', tool_calls: '[]' },
    ]
    snapshot(store, messages)
    expect(store.unread('owner', 'default')).toMatchObject({ total_unread: 8, sessions: [
      { unread_count: 8, message_count: 8, read_message_count: 0, final_unread_count: 2 },
    ] })
    expect(store.markRead('owner', 'default', 'chat', 4)).toMatchObject({ read_message_count: 4, final_unread_count: 2 })
    expect(store.markRead('owner', 'default', 'chat', 6)).toMatchObject({ read_message_count: 6, final_unread_count: 1 })
    const list = JSON.parse(store.localList('owner', 'default', {}).body.toString())
    expect(list.sessions[0]).toMatchObject({ message_count: 8, final_unread_count: 1 })
    snapshot(store, messages)
    expect(store.markRead('owner', 'default', 'chat', 0).final_unread_count).toBe(1)
    expect(store.unread('other', 'default').sessions).toEqual([])
    expect(store.unread('owner', 'other').sessions).toEqual([])
    expect(store.markRead('owner', 'default', 'chat', 999).final_unread_count).toBe(0)
  })

  it('does not count tools, progress, or an unfinished answer, then counts completion once across restart', () => {
    const { store, home } = setup()
    let seq = 0
    const event = (type: string, payload: object = {}) => store.recordEvent('owner', 'default', 'chat', {type, payload, delivery_id: String(++seq)})
    event('message.start', { message_id: 'a' })
    event('message.delta', { text: '处理中' })
    event('message.interim')
    event('tool.start', { tool_id: 't', name: 'search' })
    event('tool.complete', { tool_id: 't', result: 'found' })
    expect(store.unread('owner', 'default').sessions[0].final_unread_count).toBe(0)
    store.markRead('owner', 'default', 'chat')
    event('message.complete', { text: '最终结果' })
    event('run.completed')
    expect(store.unread('owner', 'default').sessions[0]).toMatchObject({ unread_count: 0, final_unread_count: 1 })
    store.close()
    const restored = new ChatCacheStore(home); stores.push(restored)
    expect(restored.unread('owner', 'default').sessions[0].final_unread_count).toBe(1)
    expect(restored.markRead('owner', 'default', 'chat').final_unread_count).toBe(0)
  })

  it('uses existing read cursors for old caches and does not guess from missing history rows', () => {
    const { store } = setup()
    snapshot(store, [{ id: 'a', role: 'assistant', content: '结果' }], 20)
    store.db.prepare('UPDATE chat_local_state SET read_count=19, final_read_count=NULL').run()
    expect(store.unread('owner', 'default').sessions[0].final_unread_count).toBe(1)
    store.db.prepare('UPDATE chat_local_state SET read_count=20').run()
    expect(store.unread('owner', 'default').sessions[0].final_unread_count).toBe(0)
  })

  it('does not let an abandoned streaming row prevent later results from being marked read', () => {
    const { store } = setup()
    store.recordEvent('owner', 'default', 'chat', {type:'message.delta',payload:{text:'旧回复'},delivery_id:'old'})
    store.recordCommand('owner', 'default', 'chat', 'prompt.submit', {text:'新问题',_delivery_id:'new'})
    store.recordEvent('owner', 'default', 'chat', {type:'message.complete',payload:{text:'新结果'},delivery_id:'done'})
    expect(store.unread('owner', 'default').sessions[0].final_unread_count).toBe(1)
    expect(store.markRead('owner', 'default', 'chat').final_unread_count).toBe(0)
  })

  it('recognizes attachment-only results and ignores failed or reasoning-only outputs', () => {
    expect(isFinalChatResult({ role: 'assistant', attachments: [{ path: 'result.pdf' }] })).toBe(true)
    expect(isFinalChatResult({ role: 'assistant', content: [{ type: 'text', text: '结果' }] })).toBe(true)
    for (const message of [
      { role: 'system', content: 'notice' },
      { role: 'assistant', reasoning: '思考', content: '' },
      { role: 'assistant', content: '部分结果', status: 'failed' },
      { role: 'assistant', content: '处理中', status: 'streaming' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't' }] },
      { role: 'assistant', content: [{ type: 'text', text: '查询中' }, { type: 'tool_use', id: 't' }] },
    ]) expect(isFinalChatResult(message)).toBe(false)
  })
})
