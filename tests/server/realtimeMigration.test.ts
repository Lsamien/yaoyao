// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeServer, type NodeServerRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthenticatedApplication as createApplication } from './authenticatedApplication.js'
import { createEmbeddedHermes } from '../../src/server/hermes/embedded.js'
import { kernelPaths } from '../../src/server/hermes/paths.js'

const kernel = existsSync(kernelPaths().python)

const closers: Array<() => Promise<void>> = []
const homes: string[] = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
}

function closeRuntime(runtime: NodeServerRuntime): () => Promise<void> {
  return () => runtime.close()
}

describe('HTTP+SSE migration', () => {
  it.skipIf(!kernel)('lets a QR-paired iOS node chat with the embedded Hermes over HTTP+SSE', async () => {
    const model = createServer((request, response) => {
      let raw = ''
      request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        let body: { messages?: unknown[] } | undefined
        try { body = JSON.parse(raw) } catch { body = undefined }
        if (!Array.isArray(body?.messages)) {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }))
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const part of [
          { id: 't', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: '来自内置 Hermes 的回复' }, finish_reason: null }] },
          { id: 't', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } },
        ]) response.write(`data: ${JSON.stringify(part)}\n\n`)
        response.end('data: [DONE]\n\n')
      })
    })
    const modelPort = await listen(model)
    closers.push(() => closeServer(model))

    const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-paired-embedded-'))
    homes.push(home)
    mkdirSync(join(home, 'hermes'), { recursive: true })
    writeFileSync(join(home, 'hermes', 'config.yaml'), `model:\n  provider: custom\n  default: test-model\n  base_url: http://127.0.0.1:${modelPort}/v1\n  api_key: test-key\n`)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300,
      upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home,
      mediaRoot: join(home, 'media'), attachmentsRoot: join(home, 'attachments'), imagesRoot: join(home, 'images'), mediaOwner: 'tester',
      allowInsecureLan: false, insecureLan: false, production: false,
    }
    const hermes = createEmbeddedHermes(home, { env: { ...process.env, YAOVI_HERMES_TEST_OFFLINE: '1' }, defaultCwd: config.mediaRoot, policy: () => ({ approval: 'ask', denyHostTools: false }) })
    closers.push(async () => hermes.close())
    const application = createApplication({ config, hermes })
    const node = createNodeServer(application)
    await listen(node.server)
    closers.push(closeRuntime(node))
    const port = (node.server.address() as AddressInfo).port
    config.port = port
    const origin = `http://127.0.0.1:${port}`

    const bootstrap = await fetch(`${origin}/api/app/bootstrap`)
    const bootstrapBody = await bootstrap.json() as { csrfToken: string }
    const cookie = cookies(bootstrap)
    const pairingResponse = await fetch(`${origin}/api/app/pairings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin, 'X-CSRF-Token': bootstrapBody.csrfToken },
      body: JSON.stringify({}),
    })
    expect(pairingResponse.status).toBe(201)
    const pairing = await pairingResponse.json() as { pairingId: string; qrPayload: string }
    const qr = new URL(pairing.qrPayload)
    const claimResponse = await fetch(`${origin}/api/pair/v1/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingId: pairing.pairingId, secret: qr.searchParams.get('secret'), deviceName: 'Test iPhone' }),
    })
    expect(claimResponse.status).toBe(201)
    const claim = await claimResponse.json() as { serverUrl: string; token: string; deviceId: string }
    const authorization = `Bearer ${claim.token}`

    const status = await fetch(`${claim.serverUrl}/api/status`, { headers: { Authorization: authorization } })
    expect(status.status).toBe(200)
    expect(await fetch(`${claim.serverUrl}/api/auth/ws-ticket`, { method: 'POST', headers: { Authorization: authorization } })).toHaveProperty('status', 410)
    const opened = await fetch(`${claim.serverUrl}/api/realtime/channels`, {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'chat' }),
    })
    expect(opened.status).toBe(201)
    const channel = (await opened.json() as { id: string }).id
    const events = await fetch(`${claim.serverUrl}/api/realtime/channels/${channel}/events`, { headers: { Authorization: authorization } })
    const reader = events.body!.getReader()
    const command = (id: string, method: string, params: object) => fetch(`${claim.serverUrl}/api/realtime/channels/${channel}/commands`, {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Idempotency-Key': id },
      body: JSON.stringify({ method, params }),
    })
    const created = await (await command('ios-create', 'session.create', { profile: 'default', source: 'ios' })).json() as { state: string; result?: { result?: { session_id?: string } } }
    expect(created).toMatchObject({ state: 'confirmed' })
    const sessionId = JSON.stringify(created).match(/"session_id":"([A-Za-z0-9_-]+)"/)?.[1]
    expect(sessionId).toBeTruthy()
    expect(await (await command('ios-send', 'prompt.submit', { session_id: sessionId, text: 'hello' })).json()).toMatchObject({ state: 'confirmed' })
    let stream = ''
    const deadline = Date.now() + 90_000
    while (!stream.includes('message.complete') && Date.now() < deadline) {
      const part = await reader.read()
      if (part.done) break
      stream += Buffer.from(part.value).toString()
    }
    await reader.cancel()
    expect(stream).toContain('message.complete')
    expect(stream).toContain('来自内置 Hermes 的回复')

    const revoke = await fetch(`${origin}/api/pair/v1/devices/${claim.deviceId}`, { method: 'DELETE', headers: { Authorization: authorization } })
    expect(revoke.status).toBe(200)
    expect(await fetch(`${claim.serverUrl}/api/status`, { headers: { Authorization: authorization } })).toHaveProperty('status', 401)
  }, 180_000)

  it('rejects client WebSocket upgrades instead of keeping legacy compatibility', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-ws-'))
    homes.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 15300,
      upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(),
      home,
      allowInsecureLan: false,
      insecureLan: false,
      production: true,
    }
    const application = createApplication({ config })
    const node = createNodeServer(application)
    await listen(node.server)
    closers.push(closeRuntime(node))
    const port = (node.server.address() as AddressInfo).port
    config.port = port
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/vite-hmr`, {
        origin: `http://127.0.0.1:${port}`,
      })
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
        response.resume()
      })
      socket.once('error', reject)
    })
    expect(status).toBe(410)
  })
})
