// @vitest-environment node
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import type { ServerConfig } from '../../src/server/config'
import { SSEParser } from '../../src/shared/sse'
import {
  applyTranscriptEvent,
  CHAT_TRANSCRIPT_FEATURE,
  type TranscriptEvent,
  type TranscriptMessage,
} from '../../src/shared/chatTranscript'
const fixtures: Array<{ home: string; runtime: ApplicationRuntime; server: Server }> = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.runtime.close()
    f.server.closeAllConnections()
    await new Promise<void>((resolve) => f.server.close(() => resolve()))
    rmSync(f.home, { recursive: true, force: true })
  }
})
describe('ordinary v2 HTTP snapshot and durable SSE integration', () => {
  it('replays the exact committed snapshot and rejects a legacy ordinary channel', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ordinary-v2-api-'))
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const config: ServerConfig = {
      host: '127.0.0.1',
      port,
      upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(),
      home,
      mediaRoot: home,
      attachmentsRoot: home,
      imagesRoot: home,
      mediaOwner: 'test',
      allowInsecureLan: false,
      insecureLan: false,
      production: false,
    }
    const runtime = createApplication({
      config,
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname
        return path === '/api/status'
          ? Response.json({ auth_required: false })
          : path === '/'
            ? new Response(
                '<script>window.__HERMES_SESSION_TOKEN__="fixture-token-1234567890123456";</script>',
              )
            : path === '/api/profiles'
              ? Response.json({ profiles: [{ name: 'default', is_default: true }] })
              : Response.json({})
      },
    })
    server.on('request', runtime.app.callback())
    fixtures.push({ home, runtime, server })
    const host = `127.0.0.1:${port}`,
      agent = request.agent(server)
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', host).expect(200)
    const setup = await agent
      .post('/api/app/setup')
      .set('Host', host)
      .set('Origin', `http://${host}`)
      .set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ username: 'owner', password: 'fixture-password' })
      .expect(200)
    const owner = String(setup.body.user.id),
      store = runtime.chatCache.store
    const capabilities = await agent.get('/api/realtime/capabilities').set('Host', host).expect(200)
    expect(capabilities.body.features).toContain(CHAT_TRANSCRIPT_FEATURE)
    await agent
      .post('/api/realtime/channels')
      .set('Host', host)
      .set('Origin', `http://${host}`)
      .set('X-CSRF-Token', capabilities.body.csrfToken)
      .send({ channel: 'chat' })
      .expect(426)
    store.recordCommand(owner, 'default', 's', 'session.create', { source: 'web' })
    const base = (
      await agent.get('/api/app/chat/sessions/s/snapshot?profile=default').set('Host', host).expect(200)
    ).body
    const cookies = new Map<string, string>()
    for (const response of [bootstrap, setup, capabilities])
      for (const value of (response.headers['set-cookie'] ?? []) as unknown as string[]) {
        const pair = value.split(';')[0]!
        cookies.set(pair.split('=')[0]!, pair)
      }
    const controller = new AbortController()
    const stream = await fetch(`http://127.0.0.1:${port}/api/app/chat/sessions/s/events?profile=default`, {
      headers: {
        Host: host,
        Cookie: [...cookies.values()].join('; '),
        'Last-Event-ID': `${base.epoch}:${base.cursor}`,
      },
      signal: controller.signal,
    })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader(),
      parser = new SSEParser(),
      decoder = new TextDecoder()
    let seq = 0
    for (const [type, payload] of [
      ['message.start', {}],
      ['message.delta', { text: '完成' }],
      ['message.interim', { text: '完成', already_streamed: true }],
      ['message.complete', { text: '完成', response_previewed: true }],
    ] as Array<[string, object]>)
      runtime.realtime.broker.onNativeEvent(owner, 'default', 's', {
        type,
        payload,
        session_id: 'runtime',
        seq: ++seq,
        epoch: 'native-epoch',
        delivery_id: `native:${seq}`,
      })
    const final = (
      await agent.get('/api/app/chat/sessions/s/snapshot?profile=default').set('Host', host).expect(200)
    ).body
    let rows: TranscriptMessage[] = base.messages,
      cursor = base.cursor
    try {
      while (cursor < final.cursor) {
        const chunk = await reader.read()
        expect(chunk.done).toBe(false)
        for (const frame of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
          if (frame.event !== 'transcript') continue
          const event = JSON.parse(frame.data) as TranscriptEvent
          expect(event.epoch).toBe(base.epoch)
          expect(event.previousCursor).toBe(cursor)
          rows = applyTranscriptEvent(rows, event)
          cursor = event.cursor
        }
      }
    } finally {
      controller.abort()
      await reader.cancel().catch(() => {})
    }
    expect(rows).toEqual(final.messages)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ content: '完成', status: 'complete', final_result: true })
    expect(store.db.prepare('SELECT COUNT(*) n FROM chat_messages').get()!.n).toBe(0)
  })
})
