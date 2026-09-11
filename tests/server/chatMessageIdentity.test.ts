// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCacheStore } from '../../src/server/chatCache.js'
import { mergeChatMessages } from '../../src/client/utils/messageReducer'
import { normalizeChatMessage } from '../../src/client/utils/normalize'

const fixtures: { home: string; store: ChatCacheStore }[] = []
const now = 1_789_089_547_214
const text = '查看服务器情况'
const scope = ['owner', 'server', 'session'] as const
type Row = Record<string, unknown>
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'chat-identity-'))
  const f = { home, store: new ChatCacheStore(home) }
  fixtures.push(f)
  f.store.recordCommand(...scope, 'session.create', { source: 'web' })
  return f
}
function response(messages: Row[], offset = 0, total = messages.length + offset) {
  return { status: 200, headers: new Headers(), body: Buffer.from(JSON.stringify({
    session_id: scope[2], messages, pagination: { total, offset },
  })) }
}
function submit(store: ChatCacheStore, client = 'local', at = now, options: Row = {}, outcome = 'confirmed') {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at)
  store.recordCommand(...scope, 'prompt.submit', { text, _delivery_id: `web:prompt:${client}`, ...options })
  clock.mockReturnValue(at + 34)
  if (outcome !== 'pending') store.recordEvent(...scope, {
    type: `command.${outcome}`, payload: { delivery_id: `web:prompt:${client}` }, delivery_id: `receipt:${client}`,
  })
  clock.mockRestore()
}
function row(id = '1155', at = now + 39): Row { return { id, role: 'user', content: text, timestamp: at / 1000 } }
function sync(store: ChatCacheStore, messages: Row[], force = false) {
  return store.applySync(...scope, store.revision(...scope), [{
    key: 'messages', kind: 'messages', response: response(messages), startedAt: now + 2000,
  }], force)
}
function read(store: ChatCacheStore, offset = 0, limit = 100): Row[] {
  return JSON.parse(store.messagePage(...scope, offset, limit)!.response.body.toString()).messages
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    if (!f.store.isClosed) f.store.close()
    rmSync(f.home, { recursive: true, force: true })
  }
})

describe('ordinary chat submission identities', () => {
  it('reconciles the real receipt-before-persistence shape all the way through the client reducer', () => {
    const { store } = fixture()
    submit(store)
    expect(sync(store, [row()])).toBe(true)
    const history = read(store).map(value => normalizeChatMessage(value, scope[2], scope[1]))
    expect(history[0]).toMatchObject({ id: '1155', clientMessageId: 'local' })
    const optimistic = { ...history[0]!, id: 'local', serverMessageId: undefined, stage: 'accepted' as const }
    const oldHistory = { ...history[0]!, clientMessageId: undefined }
    const merged = mergeChatMessages([optimistic, oldHistory], history, 'snapshot')
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ id: '1155', stage: 'settled' })
    expect(read(store)).toHaveLength(1)
  })

  it.each([100, 3000])('preserves independent identical sends %i ms apart and unrelated older history', gap => {
    const { store } = fixture()
    submit(store, 'first')
    submit(store, 'second', now + gap)
    sync(store, [row('old', now - 60_000), row('1'), row('2', now + gap + 39)])
    expect(read(store).map(value => [value.id, value.client_message_id]))
      .toEqual([['old', undefined], ['1', 'first'], ['2', 'second']])
  })

  it('retains bindings across restart, forced refresh and subsequent upstream pages without client IDs', () => {
    const f = fixture()
    submit(f.store)
    sync(f.store, [row()])
    f.store.close()
    f.store = new ChatCacheStore(f.home)
    f.store.db.prepare('DELETE FROM chat_events').run()
    sync(f.store, [row()], true)
    f.store.putSnapshot(scope[0], 'again', 'messages', scope[1], scope[2], response([row()]))
    expect(read(f.store)[0]).toMatchObject({ id: '1155', client_message_id: 'local' })
  })

  it('repairs existing local history from durable commands without fetching upstream or restarting', () => {
    const { store } = fixture()
    submit(store)
    sync(store, [row()])
    // Simulate a pre-upgrade cache which already replaced its temporary row.
    store.db.prepare('DELETE FROM chat_message_identities').run()
    store.db.prepare("UPDATE chat_messages SET data=json_remove(data,'$.client_message_id')").run()
    expect(read(store)[0]).toMatchObject({ id: '1155', client_message_id: 'local' })
  })

  it.each(['pending', 'rejected', 'queued', 'gateway-queued', 'ambiguous', 'outside-window'])('does not guess identity for %s submissions', mode => {
    const { store } = fixture()
    submit(store, 'local', now, mode === 'queued' ? { queued: true } : {},
      mode === 'pending' || mode === 'rejected' ? mode : 'confirmed')
    if (mode === 'gateway-queued') store.db.prepare("UPDATE chat_events SET payload=json_set(payload,'$.status','queued') WHERE event_type='command.confirmed'").run()
    const rows = mode === 'ambiguous' ? [row('1'), row('2', now + 40)]
      : [row('1', mode === 'outside-window' ? now + 30_000 : now + 39)]
    sync(store, rows, true)
    expect(read(store).map(value => value.client_message_id)).toEqual(rows.map(() => undefined))
  })

  it('keeps an unconfirmed send when an older identical user message occupies its position', () => {
    const { store } = fixture()
    submit(store, 'pending', now, {}, 'pending')
    expect(() => sync(store, [row('old', now - 60_000)]))
      .toThrow('Unconfirmed submission must be reconciled')
    expect(read(store)[0]).toMatchObject({ id: 'user:web:prompt:pending', status: 'pending' })
  })

  it('uses an explicit upstream identity for queued messages without timestamp heuristics', () => {
    const { store } = fixture()
    submit(store, 'queued', now, { queued: true })
    sync(store, [{ ...row('1', now + 3600_000), client_message_id: 'queued' }])
    expect(read(store)[0]).toMatchObject({ id: '1', client_message_id: 'queued' })
  })

  it('includes other cached pages when refusing an ambiguous legacy match', () => {
    const { store } = fixture()
    submit(store)
    sync(store, [row('1'), row('2', now + 40)], true)
    expect(read(store, 0, 1)[0]).not.toHaveProperty('client_message_id')
    expect(read(store, 1, 1)[0]).not.toHaveProperty('client_message_id')
  })

  it('does not bind the first page of an ambiguous multi-page refresh', () => {
    const { store } = fixture()
    submit(store)
    store.applySync(...scope, store.revision(...scope), [
      { key: 'tail', kind: 'messages', response: response([row('2', now + 40)], 0, 2), startedAt: now + 2000 },
      { key: 'older', kind: 'messages', response: response([row('1')], 1, 2), startedAt: now + 2000 },
    ], true)
    expect(read(store).map(value => value.client_message_id)).toEqual([undefined, undefined])
  })

  it('supports delayed agent startup using its run-start event', () => {
    const { store } = fixture()
    submit(store)
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000)
    store.recordEvent(...scope, { type: 'message.start', payload: {}, delivery_id: 'start' })
    sync(store, [row('1', now + 4999), { id: 'answer', role: 'assistant', content: '完成', timestamp: (now + 6000) / 1000 }])
    expect(read(store)[0]).toMatchObject({ id: '1', client_message_id: 'local' })
  })

  it('scopes bindings to owner, profile and session, migrates them with runtime routes and deletes them with the session', () => {
    const { store } = fixture()
    store.recordRoute(...scope, 'runtime')
    submit(store)
    sync(store, [row()])
    for (const other of [['other', scope[1], scope[2]], [scope[0], 'other', scope[2]], [scope[0], scope[1], 'other']]) {
      const [owner, profile, session] = other as [string, string, string]
      store.recordCommand(owner, profile, session, 'session.create', {})
      store.putSnapshot(owner, `other-${other.join(':')}`, 'messages', profile, session, response([row()]))
      const result = JSON.parse(store.messagePage(owner, profile, session, 0, 100)!.response.body.toString())
      expect(result.messages[0]).not.toHaveProperty('client_message_id')
    }
    store.recordRoute(scope[0], scope[1], 'compressed', 'runtime')
    expect(store.db.prepare('SELECT session_id FROM chat_message_identities').all()).toEqual([{ session_id: 'compressed' }])
    store.deleteSession(scope[0], scope[1], 'compressed')
    expect(store.db.prepare('SELECT * FROM chat_message_identities').all()).toEqual([])
  })
})
