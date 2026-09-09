// @vitest-environment node
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeServer, type NodeServerRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuthenticatedApplication as createApplication } from './authenticatedApplication.js'

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
  it('lets a QR-paired iOS node use authenticated HTTP+SSE and rejects old tickets', async () => {
    let pairedCookie = ''
    const cwdReads: Array<{ profile: string | null; cookie: string }> = []
    const pairedFrames: Array<Record<string, unknown>> = []
    const upstream = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/api/status') {
        pairedCookie = request.headers.cookie ?? pairedCookie
        response.setHeader('Set-Cookie', 'hermes_session_at=paired-user; Path=/; HttpOnly')
        response.end(JSON.stringify({ auth_required: true }))
      } else if (request.url === '/api/auth/me') {
        pairedCookie = request.headers.cookie ?? pairedCookie
        response.end(JSON.stringify({ user_id: 'paired-user', display_name: 'Paired User' }))
      } else if (request.url === '/api/profiles') {
        pairedCookie = request.headers.cookie ?? pairedCookie
        response.end(JSON.stringify({ profiles: [{ name: 'default', is_default: true }] }))
      } else if (request.url === '/api/plugins/yaoyao/profiles') {
        response.end(JSON.stringify({ profiles: [{ name: 'default', botName: '竹儿', agentName: '旧插件名称' }] }))
      } else if (request.url?.startsWith('/api/config?')) {
        const profile = new URL(request.url, 'http://hermes.test').searchParams.get('profile')
        cwdReads.push({ profile, cookie: request.headers.cookie ?? '' })
        response.end(JSON.stringify({ terminal: { cwd: '/Hermes/agent-work' } }))
      } else if (request.url === '/api/auth/providers') {
        response.end(JSON.stringify({ providers: [{ name: 'basic', supports_password: true }] }))
      } else if (request.url === '/auth/password-login' && request.method === 'POST') {
        response.setHeader('Set-Cookie', 'hermes_session_rt=paired-refresh; Path=/; HttpOnly')
        response.end(JSON.stringify({ ok: true }))
      } else if (request.url === '/api/auth/ws-ticket' && request.method === 'POST') {
        pairedCookie = request.headers.cookie ?? pairedCookie
        response.end(JSON.stringify({ ticket: 'paired-upstream-ticket' }))
      } else {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not found' }))
      }
    })
    const upstreamSockets = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/api/ws' || url.searchParams.get('ticket') !== 'paired-upstream-ticket') {
        socket.destroy()
        return
      }
      upstreamSockets.handleUpgrade(request, socket, head, client => {
        client.send(JSON.stringify({ method: 'event', params: { type: 'gateway.ready', payload: { paired: true } } }))
        client.on('message', data => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>
          pairedFrames.push(frame)
          client.send(JSON.stringify({ id: frame.id, result: frame.method === 'session.create'
            ? { session_id: 'runtime-test', stored_session_id: 'stored-test', info: { cwd: '/Hermes/agent-work' } } : {} }))
        })
      })
    })
    const upstreamPort = await listen(upstream)
    closers.push(async () => {
      for (const client of upstreamSockets.clients) client.terminate()
      upstreamSockets.close()
      await closeServer(upstream)
    })

    const home = mkdtempSync(join(tmpdir(), 'hermes-yaoyao-paired-ws-'))
    homes.push(home)
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300,
      upstream: new URL(`http://127.0.0.1:${upstreamPort}`),
      allowedHosts: new Set(), home,
      mediaRoot: join(home, 'media'), attachmentsRoot: join(home, 'attachments'), imagesRoot: join(home, 'images'), mediaOwner: 'tester',
      allowInsecureLan: false, insecureLan: false, production: false,
    }
    const application = createApplication({ config })
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
      headers: {
        'Content-Type': 'application/json', Cookie: cookie, Origin: origin,
        'X-CSRF-Token': bootstrapBody.csrfToken,
      },
      body: JSON.stringify({
        username: 'paired-user', password: 'paired-password',
      }),
    })
    expect(pairingResponse.status).toBe(201)
    const pairing = await pairingResponse.json() as { pairingId: string; qrPayload: string }
    const qr = new URL(pairing.qrPayload)
    const claimResponse = await fetch(`${origin}/api/pair/v1/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingId: pairing.pairingId,
        secret: qr.searchParams.get('secret'),
        deviceName: 'Test iPhone',
      }),
    })
    expect(claimResponse.status).toBe(201)
    const claim = await claimResponse.json() as { serverUrl: string; token: string; deviceId: string }
    const authorization = `Bearer ${claim.token}`

    const status = await fetch(`${claim.serverUrl}/api/status`, {
      headers: { Authorization: authorization },
    })
    expect(status.status).toBe(200)
    expect((await status.json() as { auth_required: boolean }).auth_required).toBe(true)
    const retired = await fetch(`${claim.serverUrl}/api/auth/ws-ticket`, {
      method: 'POST', headers: { Authorization: authorization },
    })
    expect(retired.status).toBe(410)
    const capabilities = await fetch(`${claim.serverUrl}/api/realtime/capabilities`, { headers: { Authorization: authorization } })
    expect(await capabilities.json()).toMatchObject({ protocolVersion: 1, channels: ['chat'] })
    const opened = await fetch(`${claim.serverUrl}/api/realtime/channels`, {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'chat' }),
    })
    expect(opened.status).toBe(201)
    expect(pairedFrames).toEqual([])
    const channel = (await opened.json() as { id: string }).id
    const command = (id: string, method: string, params: object) => fetch(`${claim.serverUrl}/api/realtime/channels/${channel}/commands`, {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Idempotency-Key': id },
      body: JSON.stringify({ method, params }),
    })
    const created = await command('ios-create', 'session.create', { profile: 'default', source: 'ios', cwd: '/mobile/override' })
    expect(await created.json()).toMatchObject({ state: 'confirmed' })
    expect(pairedFrames.at(-1)).toMatchObject({ method: 'session.create', params: { cwd: '/Hermes/agent-work' } })
    expect(await (await command('ios-send', 'prompt.submit', { session_id: 'runtime-test', text: 'hello' })).json()).toMatchObject({ state: 'confirmed' })
    expect(cwdReads).toHaveLength(2)
    expect(cwdReads.every(r => r.profile === 'default' && r.cookie.includes('paired'))).toBe(true)
    const revoke = await fetch(`${origin}/api/pair/v1/devices/${claim.deviceId}`, {
      method: 'DELETE', headers: { Authorization: authorization },
    })
    expect(revoke.status).toBe(200)
    expect(await fetch(`${claim.serverUrl}/api/status`, {
      headers: { Authorization: authorization },
    })).toHaveProperty('status', 401)
  })

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
