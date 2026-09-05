import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealtimeBroker, type RealtimeActivity, type RealtimePrincipal, type StreamEntry } from '../../src/server/realtimeBroker.js'
import { RealtimeReceipts } from '../../src/server/realtimeReceipts.js'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()))
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-realtime-test-'))
  const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(ws, 'listening')
  cleanup.push(() => { for (const c of ws.clients) c.terminate(); ws.close() })
  const commands: any[] = []
  let count = 0
  let seq = 0, truncate = false, dropPrompt = false
  const history: any[] = []
  let peer: WebSocket
  ws.on('connection', socket => {
    peer = socket; count++
    socket.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'test' } } }))
    socket.on('message', raw => {
      const f = JSON.parse(raw.toString()); commands.push(f)
      if (f.method === 'prompt.submit' && dropPrompt) { socket.terminate(); return }
      if (f.method === 'profiles.list') {
        socket.send(JSON.stringify({id:f.id,result:{profiles:[{name:'default',ui_meta:{'hermes-bots':{chat:'stored-1'}}}]}}))
      } else if (f.method === 'session.events.since') {
        socket.send(JSON.stringify({ id: f.id, result: { epoch: 'test', truncated: truncate,
          events: history.filter(e => e.seq > f.params.last_seen) } }))
      } else if (f.method === 'session.branch') {
        socket.send(JSON.stringify({ id: f.id, result: { session_id: 'runtime-branch', stored_session_id: 'stored-branch' } }))
      } else if (f.method === 'session.create' || f.method === 'session.resume') {
        socket.send(JSON.stringify({ id: f.id, result: { session_id: 'runtime-1', stored_session_id: 'stored-1', running: false } }))
      } else {
        setTimeout(() => socket.send(JSON.stringify({ id: f.id, result: { status: 'submitted' } })), 20)
      }
    })
  })
  let now = Date.now()
  const activities: RealtimeActivity[] = []
  const broker = new RealtimeBroker(home, () => now, change => activities.push(change))
  cleanup.push(() => broker.close())
  const principal = (key: string): RealtimePrincipal => ({ key, upstreamKey: 'one-service', paired: false,
    valid: () => true, url: async () => new URL(`ws://127.0.0.1:${(ws.address() as any).port}`) })
  return { home, broker, principal, commands, activities, count: () => count, advance: (n: number) => { now += n },
    disconnect: () => peer!.terminate(), truncate: () => { truncate = true }, dropPrompt: () => { dropPrompt = true },
    emit: (type: string, payload: unknown) => {
      const params = { type, session_id: 'runtime-1', seq: ++seq, payload }; history.push(params)
      if (peer!.readyState === 1) peer!.send(JSON.stringify({ method: 'event', params }))
    } }
}
const resume = { method: 'session.resume', params: { session_id: 'stored-1', profile: 'default' } }
describe('realtime broker', () => {
  it('rejects resuming a history-only session before opening an upstream route', async () => {
    const f = await fixture()
    const routes: string[] = []
    f.broker.onNativeRoute = (_owner, _profile, stored) => routes.push(stored)
    const principal = { ...f.principal('alice'), canResume: async () => false }
    const channel = await f.broker.create(principal, 'chat')
    const receipt = await f.broker.command(channel, 'history-resume', resume)
    expect(receipt).toMatchObject({ state: 'rejected', response: { error: { code: 'history_session_read_only' } } })
    expect(f.commands).toEqual([])
    expect(routes).toEqual([])
  })
  it('allows only a native Bots configured chat without claiming arbitrary history', async () => {
    const f = await fixture()
    const principal = {...f.principal('native:user:alice:1'), nativeBot:true, canResume:async()=>false}
    const channel = await f.broker.create(principal,'chat')
    expect(await f.broker.command(channel,'native-canonical',resume)).toMatchObject({state:'confirmed'})
    expect(await f.broker.command(channel,'wrong-profile',{...resume,params:{...resume.params,profile:'other'}}))
      .toMatchObject({state:'rejected',response:{error:{code:'history_session_read_only'}}})
    expect(await f.broker.command(channel,'arbitrary-history',{...resume,params:{...resume.params,session_id:'history-2'}}))
      .toMatchObject({state:'rejected',response:{error:{code:'history_session_read_only'}}})
    expect(f.commands.filter(c=>c.method==='session.resume')).toHaveLength(1)
  })
  it('registers and resumes sessions only within one stable device owner', async () => {
    const f = await fixture()
    const owned = new Set<string>()
    const commands: Array<{ owner: string; stored: string; method: string }> = []
    const events: Array<{ owner: string; stored: string; type: string }> = []
    const ownershipKey = (owner: string, profile: string, stored: string) =>
      `${owner}\u0000${profile}\u0000${stored}`
    f.broker.onNativeRoute = (owner, profile, stored) => {
      owned.add(ownershipKey(owner, profile, stored))
    }
    f.broker.onNativeCommand = (owner, _profile, stored, method) => {
      commands.push({ owner, stored, method })
    }
    f.broker.onNativeEvent = (owner, _profile, stored, frame) => {
      events.push({ owner, stored, type: String(frame.type) })
    }
    const device = (id: string): RealtimePrincipal => ({
      ...f.principal(`device:${id}`),
      upstreamKey: `device-service:${id}`,
      paired: true,
      canResume: async (profile, stored) =>
        owned.has(ownershipKey(`device:${id}`, profile, stored)),
    })

    const deviceA = device('device-a')
    const first = await f.broker.create(deviceA, 'chat')
    const created = await f.broker.command(first, 'device-create', {
      method: 'session.create', params: { profile: 'default', source: 'web' },
    })
    expect(created.state).toBe('confirmed')
    expect(owned).toContain(ownershipKey('device:device-a', 'default', 'stored-1'))
    expect(commands).toContainEqual({ owner: 'device:device-a', stored: 'stored-1', method: 'session.create' })
    f.emit('message.delta', { text: 'device event' })
    await vi.waitFor(() => expect(events).toContainEqual({
      owner: 'device:device-a', stored: 'stored-1', type: 'message.delta',
    }))

    const sameDevice = await f.broker.create(device('device-a'), 'chat')
    expect((await f.broker.command(sameDevice, 'same-device-resume', resume)).state).toBe('confirmed')
    const unowned = await f.broker.command(sameDevice, 'source-web-unowned', {
      method: 'session.resume', params: { session_id: 'unowned-source-web', profile: 'default' },
    })
    expect(unowned).toMatchObject({ state: 'rejected', response: { error: { code: 'history_session_read_only' } } })

    const anotherDevice = await f.broker.create(device('device-b'), 'chat')
    expect(await f.broker.command(anotherDevice, 'other-device-resume', resume))
      .toMatchObject({ state: 'rejected', response: { error: { code: 'history_session_read_only' } } })
    const user = {
      ...f.principal('user:alice:1'),
      upstreamKey: 'user-service',
      canResume: async (profile: string, stored: string) =>
        owned.has(ownershipKey('alice', profile, stored)),
    }
    const userChannel = await f.broker.create(user, 'chat')
    expect(await f.broker.command(userChannel, 'user-resume-device-session', resume))
      .toMatchObject({ state: 'rejected', response: { error: { code: 'history_session_read_only' } } })
  })
  it('broadcasts a route title as an owner-scoped session list change', async () => {
    const f = await fixture()
    const globalOwners: string[] = []
    f.broker.onNativeGlobalEvent = (owner, type) => {
      if (type === 'sessions.changed') globalOwners.push(owner)
    }
    const routedPrincipal = { ...f.principal('user:alice:1'), canResume: async () => true }
    const routed = await f.broker.create(routedPrincipal, 'chat')
    const listOnly = await f.broker.create(f.principal('user:alice:1'), 'chat')
    const anotherUser = await f.broker.create(f.principal('user:bob:1'), 'chat')
    await f.broker.command(routed, 'owner-title-route', resume)
    const listFrames: StreamEntry[] = []
    const otherFrames: StreamEntry[] = []
    f.broker.subscribe(listOnly, undefined, entry => listFrames.push(entry))
    f.broker.subscribe(anotherUser, undefined, entry => otherFrames.push(entry))

    f.emit('session.title', { session_id: 'stored-1', title: '跨端标题' })

    await vi.waitFor(() => expect(listFrames.some(entry =>
      entry.data.includes('sessions.changed'))).toBe(true))
    expect(otherFrames.some(entry => entry.data.includes('sessions.changed'))).toBe(false)
    expect(globalOwners).toEqual(['alice'])
  })
  it('preserves restricted create provenance and never forwards source on resume', async () => {
    const f = await fixture()
    const channel = await f.broker.create(f.principal('alice'), 'chat')
    await f.broker.command(channel, 'create-ios', {
      method: 'session.create', params: { profile: 'default', source: 'ios' },
    })
    await f.broker.command(channel, 'create-web-default', {
      method: 'session.create', params: { profile: 'default' },
    })
    await f.broker.command(channel, 'resume-with-client-source', {
      method: 'session.resume', params: { session_id: 'stored-1', profile: 'default', source: 'ios' },
    })
    const openFrames = f.commands.filter(frame => frame.method === 'session.create' || frame.method === 'session.resume')
    expect(openFrames[0]?.params.source).toBe('ios')
    expect(openFrames[1]?.params.source).toBe('web')
    expect(openFrames[2]?.params).not.toHaveProperty('source')
    expect(() => f.broker.command(channel, 'create-invalid-source', {
      method: 'session.create', params: { profile: 'default', source: 'telegram' },
    })).toThrow(/source must be web or ios/)
  })
  it('shares upstream across subscribers and isolates unregistered routes', async () => {
    const f = await fixture()
    const a = await f.broker.create(f.principal('alice'), 'chat')
    const b = await f.broker.create(f.principal('bob'), 'chat')
    const c = await f.broker.create(f.principal('alice'), 'chat')
    await f.broker.command(a, 'resume-a', resume)
    await f.broker.command(c, 'resume-c', resume)
    const seenA: StreamEntry[] = [], seenB: StreamEntry[] = [], seenC: StreamEntry[] = []
    f.broker.subscribe(a, undefined, x => seenA.push(x)); f.broker.subscribe(b, undefined, x => seenB.push(x)); f.broker.subscribe(c, undefined, x => seenC.push(x))
    f.emit('message.delta', { text: '你好' })
    await new Promise(r => setTimeout(r, 30))
    expect(f.count()).toBe(1)
    expect(seenA.some(x => x.data.includes('你好'))).toBe(true)
    expect(seenC.some(x => x.data.includes('你好'))).toBe(true)
    expect(seenB.some(x => x.data.includes('你好'))).toBe(false)
    expect(() => f.broker.get(f.principal('bob'), a.id)).toThrow('Channel not found')
  })
  it('deduplicates simultaneous commands and rejects a changed payload', async () => {
    const f = await fixture(), p = f.principal('alice')
    const c = await f.broker.create(p, 'chat')
    await f.broker.command(c, 'open', resume)
    const prompt = { method: 'prompt.submit', params: { session_id: 'runtime-1', text: 'secret prompt' } }
    const [one, two] = await Promise.all([f.broker.command(c, 'outbox-1', prompt), f.broker.command(c, 'outbox-1', prompt)])
    expect(one).toEqual(two); expect(one.state).toBe('confirmed')
    expect(f.commands.filter(x => x.method === 'prompt.submit')).toHaveLength(1)
    expect(() => f.broker.command(c, 'outbox-1', { ...prompt, params: { ...prompt.params, text: 'different' } })).toThrow('conflict')
    expect(() => f.broker.receipt(f.principal('bob'), 'outbox-1')).toThrow('Receipt not found')
    for (const file of ['realtime-receipts.sqlite3', 'realtime-receipts.sqlite3-wal']) expect(readFileSync(join(f.home, file)).includes(Buffer.from('secret prompt'))).toBe(false)
  })
  it('keeps upstream alive after downstream detach and replays exact cursor', async () => {
    const f = await fixture(), p = f.principal('alice')
    const c = await f.broker.create(p, 'chat')
    await f.broker.command(c, 'open', resume)
    const entries: StreamEntry[] = []
    const off = f.broker.subscribe(c, undefined, x => entries.push(x))
    const cursor = entries.at(-1)!.id
    off(); f.emit('message.start', {}); f.emit('message.delta', { text: 'background' })
    await new Promise(r => setTimeout(r, 30))
    const replay: StreamEntry[] = []
    f.broker.subscribe(c, cursor, x => replay.push(x))
    expect(replay).toHaveLength(2); expect(f.count()).toBe(1)
    f.advance(600_001)
    expect(() => f.broker.subscribe(c, cursor, () => {})).toThrow('Replay window expired')
  })
  it('does not execute runtime commands without a route subscription', async () => {
    const f = await fixture()
    const c = await f.broker.create(f.principal('alice'), 'chat')
    const result = await f.broker.command(c, 'forbidden', { method: 'session.interrupt', params: { session_id: 'guessed' } })
    expect(result.state).toBe('rejected'); expect(f.commands).toHaveLength(0)
  })
  it('marks write-ahead admissions unknown after a process restart', () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-receipts-test-'))
    const a = new RealtimeReceipts(home)
    a.reserve('alice', 'submitted', '{"text":"private"}'); a.close()
    const b = new RealtimeReceipts(home)
    expect(b.reserve('alice', 'submitted', '{"text":"private"}')).toMatchObject({ state: 'unknown' })
    b.close()
  })
  it('registers branch identities without losing the original subscription', async () => {
    const f = await fixture()
    const ownershipCommands: Array<{ owner: string; stored: string; method: string }> = []
    f.broker.onNativeCommand = (owner, _profile, stored, method) => {
      ownershipCommands.push({ owner, stored, method })
    }
    const c = await f.broker.create(f.principal('user:alice:1'), 'chat')
    await f.broker.command(c, 'open', resume)
    const branch = await f.broker.command(c, 'branch', { method: 'session.branch', params: { session_id: 'runtime-1' } })
    expect(branch.state).toBe('confirmed')
    const sent = await f.broker.command(c, 'branched-prompt', { method: 'prompt.submit', params: { session_id: 'runtime-branch', text: 'branch' } })
    expect(sent.state).toBe('confirmed')
    expect(c.routes.size).toBe(2)
    expect(ownershipCommands).toContainEqual({ owner: 'alice', stored: 'stored-branch', method: 'session.branch' })
  })
  it('does not let guessed approval IDs escape a subscribed session', async () => {
    const f = await fixture(), c = await f.broker.create(f.principal('alice'), 'chat')
    await f.broker.command(c, 'open', resume)
    const result = await f.broker.command(c, 'approval', { method: 'approval.respond', params: { session_id: 'runtime-1', request_id: 'another-users-approval', approved: true } })
    expect(result).toMatchObject({ state: 'rejected', response: { error: { code: 'interaction_forbidden' } } })
    expect(f.commands.filter(x => x.method === 'approval.respond')).toHaveLength(0)
  })
  it('page reloads cannot exhaust live-stream capacity with detached handles', async () => {
    const f = await fixture(), p = f.principal('alice')
    for (let i = 0; i < 40; i++) await f.broker.create(p, 'chat')
    expect(f.broker.channels.size).toBe(32)
    expect(f.count()).toBe(1)
  })
  it('recovers the upstream replay ring without losing offline deltas', async () => {
    const f = await fixture(), c = await f.broker.create(f.principal('alice'), 'chat')
    await f.broker.command(c, 'open', resume)
    const received: StreamEntry[] = []
    f.broker.subscribe(c, undefined, e => received.push(e))
    f.emit('message.delta', { text: 'before' })
    await vi.waitFor(() => expect(received.some(e => e.data.includes('before'))).toBe(true))
    f.disconnect(); f.emit('message.delta', { text: 'offline' })
    await vi.waitFor(() => expect(received.filter(e => e.data.includes('offline'))).toHaveLength(1), { timeout: 2500 })
    expect(f.count()).toBe(2)
    expect(received.filter(e => e.event === 'reset')).toHaveLength(0)
  })
  it('reports reset when upstream history was truncated', async () => {
    const f = await fixture(), c = await f.broker.create(f.principal('alice'), 'chat')
    await f.broker.command(c, 'open', resume)
    const received: StreamEntry[] = []
    f.broker.subscribe(c, undefined, e => received.push(e))
    f.truncate(); f.disconnect()
    await vi.waitFor(() => expect(received.some(e => e.event === 'reset')).toBe(true), { timeout: 2500 })
  })
  it('never repeats a prompt when the upstream acceptance reply is lost', async () => {
    const f = await fixture(), c = await f.broker.create(f.principal('alice'), 'chat')
    await f.broker.command(c, 'open', resume)
    f.dropPrompt()
    const prompt = { method: 'prompt.submit', params: { session_id: 'runtime-1', text: 'do once' } }
    const result = await f.broker.command(c, 'lost-ack', prompt)
    expect(result.state).toBe('unknown')
    expect((await f.broker.command(c, 'lost-ack', prompt)).state).toBe('unknown')
    expect(f.commands.filter(f => f.method === 'prompt.submit')).toHaveLength(1)
  })
  it('invalidates read snapshots before/after mutation and before delivering live events', async () => {
    const f = await fixture(), c = await f.broker.create(f.principal('alice'), 'chat')
    await f.broker.command(c, 'open', resume)
    await f.broker.command(c, 'send', { method: 'prompt.submit', params: { session_id: 'runtime-1', text: 'once' } })
    expect(f.activities.filter(c => c.kind === 'command' && c.name === 'prompt.submit')).toEqual([
      { kind: 'command', name: 'prompt.submit', sessionId: 'stored-1' },
      { kind: 'command', name: 'prompt.submit', sessionId: 'stored-1' },
    ])
    const seen: StreamEntry[] = []
    f.broker.subscribe(c, undefined, entry => {
      if (entry.data.includes('message.delta')) expect(f.activities.at(-1)).toMatchObject({ kind: 'event', name: 'message.delta', sessionId: 'stored-1' })
      seen.push(entry)
    })
    f.emit('message.delta', { text: 'fresh' })
    await vi.waitFor(() => expect(seen.some(e => e.data.includes('fresh'))).toBe(true))
  })
})
