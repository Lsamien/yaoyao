// @vitest-environment node
import Koa from 'koa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatCacheStore, type ChatCacheCoordinator } from '../../src/server/chatCache'
import { chatTranscriptRouter } from '../../src/server/chatTranscriptApi'
import type { LocalAuthStore } from '../../src/server/localAuth'
import { ChatTranscriptClient } from '../../src/client/api/chatTranscript'
import type { TranscriptSnapshot } from '../../src/shared/chatTranscript'

const scope = ['owner', 'p', 's'] as const
const fixtures: Array<{ home: string; store: ChatCacheStore; server: Server }> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const { home, store, server } of fixtures.splice(0)) {
    store.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(home, { recursive: true, force: true })
  }
})

it.each([300, 1000])('replays %i committed events through the HTTP router before confirming the cursor', async count => {
  const home = mkdtempSync(join(tmpdir(), 'ordinary-replay-')), store = new ChatCacheStore(home)
  store.recordCommand(...scope, 'session.create', { source: 'web' })
  store.transcripts.seed(...scope)
  const base = store.transcripts.snapshot(...scope, {}, 'current')
  for (let i = 0; i < count; i++) {
    store.transcripts.upsert(...scope, { id: `m${i}`, role: 'assistant', content: `消息${i}`, status: 'complete' }, i)
  }
  const finalCursor = store.transcripts.cursor(...scope)
  const auth = {
    require: () => ({ id: scope[0] }), current: () => ({ id: scope[0] }),
    canUseSource: () => true, isUserActive: () => true, pushAuthorizationVersion: () => 1,
  } as unknown as LocalAuthStore
  const router = chatTranscriptRouter({ store, schedule: () => {} } as unknown as ChatCacheCoordinator, auth)
  const app = new Koa().use(router.routes()).use(router.allowedMethods())
  const server = app.listen(0, '127.0.0.1')
  fixtures.push({ home, store, server })
  await new Promise<void>(resolve => server.once('listening', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const nativeFetch = globalThis.fetch
  const requested: string[] = []
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    requested.push(String(input))
    return nativeFetch(new URL(String(input), origin), init)
  })
  let checkpoint: TranscriptSnapshot = base, commits = 0
  const failed = vi.fn()
  const client = new ChatTranscriptClient('p', 's', async value => { checkpoint = value; commits++ }, failed)
  client.restore(base)
  const running = client.run()
  try {
    // Restored checkpoint, every event, then ready; no snapshot repair is necessary.
    await vi.waitFor(() => expect(commits).toBe(count + 2), { timeout: 5000 })
    expect(checkpoint.cursor).toBe(finalCursor)
    expect(checkpoint.messages).toEqual(store.transcripts.all(...scope))
    expect(checkpoint.messages).toHaveLength(count)
    expect(failed).not.toHaveBeenCalled()
    expect(requested).toEqual(['/api/app/chat/sessions/s/events?profile=p'])
    store.transcripts.upsert(...scope, { id: 'live', role: 'assistant', content: '重连后新增', status: 'complete' }, count)
    await vi.waitFor(() => expect(checkpoint.messages).toHaveLength(count + 1))
    expect(checkpoint.messages.at(-1)?.content).toBe('重连后新增')
    expect(failed).not.toHaveBeenCalled()
  } finally {
    client.close()
    await running
  }
}, 15_000)
