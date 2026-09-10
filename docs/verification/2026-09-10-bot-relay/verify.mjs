// Run after npm run build. Uses only a temporary SQLite home and loopback fake
// Hermes; no existing service, account, model, or group is contacted.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { WorkspaceRuntime } from '../../../dist-server/server/workspaceRuntime.js'
import { WorkspaceStore } from '../../../dist-server/server/workspaceStore.js'
import { UploadStore } from '../../../dist-server/server/uploads.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const receipt = '收到 @审核 终审维持通过。\n交付状态（不变）：入草稿箱 Media ID `fixture-draft`，发布目录 `/fixture/final/`。\n等用户群发指令。'
async function verify(mode, closingReceipt, expectedCalls) {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-relay-acceptance-'))
  const store = new WorkspaceStore(home), uploads = new UploadStore(home)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  let runtime, calls = 0
  try {
    await new Promise(resolve => server.once('listening', resolve))
    const target = {
      url: new URL(`http://127.0.0.1:${server.address().port}`), client: {},
      session: {
        webSocketCredential: async () => ({ name: 'ticket', value: 'fixture' }),
        request: async () => ({ status: 200, body: Buffer.from('{}') }),
      },
    }
    server.on('connection', socket => {
      socket.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready' } }))
      socket.on('message', raw => {
        const frame = JSON.parse(String(raw)), respond = result => socket.send(JSON.stringify({ id: frame.id, result }))
        if (frame.method === 'session.create' || frame.method === 'session.resume') {
          respond({ session_id: randomUUID(), stored_session_id: frame.params.session_id ?? randomUUID(), running: false, info: { profile_name: 'default' } })
        } else if (frame.method === 'prompt.submit') {
          calls++; respond({ status: 'streaming' })
          const lead = frame.params.text.startsWith('你是 竹儿。')
          const text = calls > 20 ? '完成' : lead ? closingReceipt && calls > 1 ? receipt : '@审核 请再次检查文案'
            : mode === 'host' ? '审核结果相同' : '@竹儿 请再次检查文案'
          socket.send(JSON.stringify({ method: 'event', params: { type: 'message.complete', session_id: frame.params.session_id, payload: { text, status: 'complete' } } }))
        } else respond({ ok: true })
      })
    })
    runtime = new WorkspaceRuntime(store, { requireSource() {}, target: () => target }, uploads)
    const owner = 'isolated-fixture'
    const a = store.createAgent(owner, { name: '竹儿', profile: 'default', instructions: '' })
    const b = store.createAgent(owner, { name: '审核', profile: 'default', instructions: '' })
    const group = store.createGroup(owner, { name: '隔离验收', memberIds: [a.id, b.id], administratorId: a.id, mode, maxReplyRounds: -1 })
    const run = runtime.send(owner, group.id, { requestId: randomUUID(), content: '@竹儿 开始' })
    const deadline = Date.now() + 10_000
    while (store.require(owner, 'run', run.id).status !== 'complete' && Date.now() < deadline) await sleep(10)
    assert.equal(store.require(owner, 'run', run.id).status, 'complete')
    assert.equal(calls, expectedCalls)
    await sleep(250)
    assert.equal(calls, expectedCalls, 'no further calls after settling')
    const pending = store.list(owner, 'turn').filter(w => !w.planned || !['complete', 'failed', 'interrupted'].includes(w.status))
    assert.equal(pending.length, 0)
    assert.equal(store.require(owner, 'conversation', group.id).activeRunId, undefined)
    const notices = store.messages(owner, group.id).filter(m => m.role === 'system' && m.content.includes('检测到重复协作'))
    assert.equal(notices.length, closingReceipt ? 0 : 1)
    return { mode, closingReceipt, calls, status: 'complete', pending: pending.length, notices: notices.length, stableAfterMs: 250 }
  } finally {
    runtime?.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
    await sleep(10)
    uploads.close(); store.close()
    rmSync(home, { recursive: true, force: true })
  }
}
const results = []
for (const [mode, closingReceipt, calls] of [['host', true, 3], ['host', false, 5], ['free', false, 4]]) {
  results.push(await verify(mode, closingReceipt, calls))
}
console.log(JSON.stringify({ source: 'dist-server', network: 'loopback fixture only', results }, null, 2))
