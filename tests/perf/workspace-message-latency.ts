/** Run with: npx tsx tests/perf/workspace-message-latency.ts [output.json]
 * Owned temporary SQLite homes and loopback SSE only; no model or user service. */
import Koa from 'koa'
import { once } from 'node:events'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { WorkspaceStore } from '../../src/server/workspaceStore.js'
import { streamWorkspace } from '../../src/server/workspaceSync.js'
import { WorkspaceMessageReconciler } from '../../src/shared/workspaceMessagePatch.js'
import type { WorkspaceConversation, WorkspaceEvent, WorkspaceMessage } from '../../src/shared/workspace.js'
import type { LocalAuthStore } from '../../src/server/localAuth.js'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0
const auth = { require: () => ({ id: 'owner' }), isUserActive: () => true, pushAuthorizationVersion: () => 1 } as unknown as LocalAuthStore
async function measure(patches: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'workspace-message-perf-')), store = new WorkspaceStore(home, { messagePatches: patches })
  const messages: WorkspaceMessage[] = []
  for (let i = 0; i < 5; i++) {
    store.createAgent('owner', { name: `Bot ${i}`, profile: 'default' })
    const c = store.list<WorkspaceConversation>('owner', 'conversation').find(c => c.name === `Bot ${i}`)!
    const message: WorkspaceMessage = { id: `m${i}`, conversationId: c.id, seq: 0, role: 'assistant', content: '', reasoning: '', status: 'streaming', attachments: [], tools: [], createdAt: Date.now() }
    store.saveMessage('owner', message); messages.push(message)
  }
  const startCursor = store.cursor('owner'), folder = new WorkspaceMessageReconciler()
  messages.forEach(m => folder.remember(structuredClone(m)))
  const app = new Koa(); app.use(ctx => streamWorkspace(ctx, store, auth))
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const controller = new AbortController(), saves: number[] = [], completed = new Map<string, string>()
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable()
  let bytes = 0, events = 0, buffer = ''
  let consume: Promise<void> | undefined
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/?format=${patches ? 'patch-v1' : ''}`, { headers: { 'Last-Event-ID': String(startCursor) }, signal: controller.signal })
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    consume = (async () => {
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break
          bytes += next.value.length; buffer += decoder.decode(next.value, { stream: true })
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            if (!frame.includes('event: workspace')) continue
            const line = frame.split('\n').find(l => l.startsWith('data: '))!
            const event = folder.normalize(JSON.parse(line.slice(6)) as WorkspaceEvent); events++
            if (event.type === 'message.changed') {
              const message = event.data as WorkspaceMessage
              if (message.status === 'complete') completed.set(message.id, message.content)
            }
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error }
    })()
    const cpu = process.cpuUsage(), started = performance.now()
    const last = messages.map(() => -Infinity), timers: Array<ReturnType<typeof setTimeout> | undefined> = []
    const flush = (index: number) => {
      clearTimeout(timers[index]); timers[index] = undefined
      const start = performance.now(); store.saveMessage('owner', messages[index]!); saves.push(performance.now() - start); last[index] = performance.now()
    }
    for (let i = 0; i < 200; i++) {
      for (const [index, message] of messages.entries()) {
        message.content += `第${String(i + 1).padStart(3, '0')}段。用于比较两个移动端的连续文本显示表现，全部内容来自隔离测试服务。\n\n`
        const remaining = (patches ? 33 : 100) - (performance.now() - last[index]!)
        if (remaining <= 0) flush(index)
        else if (timers[index] === undefined) timers[index] = setTimeout(() => flush(index), remaining)
      }
      await sleep(20)
    }
    for (const [index, message] of messages.entries()) { message.status = 'complete'; flush(index) }
    const deadline = performance.now() + 3000
    while (completed.size !== 5 && performance.now() < deadline) await sleep(10)
    for (const message of messages) assert.equal(completed.get(message.id), message.content, 'complete streamed text equals the full stored message')
    const consumed = process.cpuUsage(cpu)
    return { format: patches ? 'patch-v1' : 'full-v1', concurrentBots: 5, sourceChunksPerBot: 200, finalCharactersPerBot: messages[0]!.content.length,
      sseBytes: bytes, events, saveCount: saves.length, saveMedianMs: quantile(saves, .5), saveP95Ms: quantile(saves, .95), saveMaxMs: Math.max(...saves),
      elapsedMs: performance.now() - started, cpuMs: (consumed.user + consumed.system) / 1000,
      eventLoopP95Ms: loop.percentile(95) / 1e6, walBytes: statSync(join(home, 'workspace.sqlite3-wal')).size,
      eventLogBytes: Number(store.db.prepare('SELECT sum(length(cast(data AS BLOB))) AS n FROM workspace_events WHERE seq>?').get(startCursor)!.n), completedMessages: completed.size }
  } finally {
    controller.abort(); await consume; loop.disable(); store.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true })
  }
}
const baseline = await measure(false), optimized = await measure(true)
const result = { baseline, optimized, sseReduction: 1 - optimized.sseBytes / baseline.sseBytes }
console.log(JSON.stringify(result, null, 2))
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2))
assert.ok(result.sseReduction >= .6, 'total SSE bytes reduced by at least 60%')
assert.ok(optimized.saveP95Ms <= 10, 'five concurrent Bots keep persistence and event encoding below 10ms P95')
