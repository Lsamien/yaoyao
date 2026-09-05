// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'

const roots: string[] = []
const runtimes: ApplicationRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('native Hermes chat and history are separated on 15300', () => {
  it('opens realtime chat while keeping non-Web history mutations read-only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'yaoyao-native-history-'))
    roots.push(home)
    let upstreamCalls = 0, upstreamWrites = 0
    const config: ServerConfig = {
      host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
      allowedHosts: new Set(), home, mediaRoot: home, attachmentsRoot: home,
      imagesRoot: home, mediaOwner: 'test', allowInsecureLan: false,
      insecureLan: false, production: false,
    }
    const runtime = createApplication({
      config,
      fetchImpl: (async (input, init) => {
        upstreamCalls += 1
        if (!['GET', 'HEAD'].includes(init?.method ?? 'GET')) upstreamWrites += 1
        const path = new URL(String(input)).pathname
        if (path === '/api/status') return Response.json({ auth_required: true })
        if (path === '/api/auth/me') return Response.json({ user_id: 'service' })
        if (path === '/api/auth/providers') return Response.json({ providers: [{ name: 'basic', supports_password: true }] })
        if (path === '/auth/password-login') return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json', 'set-cookie': 'hermes_service=session; Path=/; HttpOnly' },
        })
        if (path === '/api/profiles') return Response.json({ profiles: [{ name: 'default', ui_meta: {'hermes-bots': {chat: 'native-canonical'}} }] })
        if (path === '/api/auth/ws-ticket') return Response.json({ ticket: 'fixture-ticket' })
        if (path === '/api/sessions/session-web') return Response.json(init?.method === 'PATCH' ? { ok: true } : { id: 'session-web', source: 'web' })
        return Response.json({ method: init?.method ?? 'GET' })
      }) as typeof fetch,
    })
    runtimes.push(runtime)
    const agent = request.agent(runtime.app.callback())
    const origin = 'http://127.0.0.1:15300'
    const bootstrap = await agent.get('/api/app/bootstrap').set('Host', '127.0.0.1:15300').expect(200)
    const setup = await agent.post('/api/app/setup').set('Host', '127.0.0.1:15300')
      .set('Origin', origin).set('X-CSRF-Token', bootstrap.body.csrfToken)
      .send({ username: 'owner', password: 'fixture-password' }).expect(200)
    const csrf = setup.body.csrfToken
    const owner = String(setup.body.user.id)

    const capabilities = await agent.get('/api/realtime/capabilities').set('Host', '127.0.0.1:15300').expect(200)
    expect(capabilities.body.channels).toEqual(['chat'])
    const beforeWrites = upstreamCalls, beforeUpstreamWrites = upstreamWrites
    for (const path of ['/api/app/sessions/session-1', '/api/sessions/session-1']) {
      const response = await agent.patch(path).set('Host', '127.0.0.1:15300')
        .set('Origin', origin).set('X-CSRF-Token', csrf).send({ title: '不能修改' }).expect(410)
      expect(response.body.code).toBe('native_sessions_read_only')
    }
    const pairing = runtime.pairings.create('hermes_device=session')
    const paired = runtime.pairings.claim({
      pairingID: pairing.id,
      secret: pairing.secret,
      deviceName: 'history-only fixture',
    })
    const pairedWrite = await request(runtime.app.callback())
      .patch(`/node/${paired.device.id}/api/sessions/session-1`)
      .set('Host', '127.0.0.1:15300')
      .set('Authorization', `Bearer ${paired.token}`)
      .send({ title: '不能修改' })
      .expect(410)
    expect(pairedWrite.body.code).toBe('native_sessions_read_only')
    expect(upstreamCalls).toBeGreaterThan(beforeWrites)
    expect(upstreamWrites).toBe(beforeUpstreamWrites)

    const unownedWeb = await agent.patch('/api/app/sessions/session-web?profile=default')
      .set('Host', '127.0.0.1:15300').set('Origin', origin).set('X-CSRF-Token', csrf)
      .send({ title: '不能靠 source 修改' }).expect(410)
    expect(unownedWeb.body.code).toBe('native_sessions_read_only')
    const ownershipGate = runtime.realtime as unknown as {
      canResume(profile: string, sessionID: string, jar?: unknown, owner?: string): Promise<boolean>
    }
    expect(await ownershipGate.canResume('default', 'session-web', undefined, owner)).toBe(false)
    expect(await ownershipGate.canResume('default', 'native-canonical', undefined, owner)).toBe(false)
    await agent.get('/api/app/hermes-bot/local/api/realtime/capabilities').set('Host', '127.0.0.1:15300').expect(200)
    await request(runtime.app.callback()).get('/api/app/hermes-bot/local/api/realtime/capabilities').set('Host', '127.0.0.1:15300').expect(401)
    await agent.post('/api/app/hermes-bot/local/api/profiles').set('Host', '127.0.0.1:15300')
      .set('Origin', origin).set('X-CSRF-Token', csrf).send({}).expect(403)

    const deviceOwner = `device:${paired.device.id}`
    expect(await ownershipGate.canResume('default', 'session-web', undefined, deviceOwner)).toBe(false)

    runtime.chatCache!.store.recordRoute(deviceOwner, 'default', 'device-session', 'runtime-device')
    expect(await ownershipGate.canResume('default', 'device-session', undefined, deviceOwner)).toBe(true)
    expect(await ownershipGate.canResume('default', 'device-session', undefined, owner)).toBe(false)
    const anotherPairing = runtime.pairings.create('another_device=session')
    const anotherDevice = runtime.pairings.claim({
      pairingID: anotherPairing.id,
      secret: anotherPairing.secret,
      deviceName: 'another history fixture',
    })
    expect(await ownershipGate.canResume(
      'default',
      'device-session',
      undefined,
      `device:${anotherDevice.device.id}`,
    )).toBe(false)

    runtime.chatCache!.store.recordRoute(owner, 'default', 'session-web', 'runtime-web')
    runtime.chatCache!.store.recordCommand(owner, 'default', 'session-web', 'session.create', { source: 'ios' })
    expect(await ownershipGate.canResume('default', 'session-web', undefined, owner)).toBe(true)
    await agent.patch('/api/app/sessions/session-web?profile=default').set('Host', '127.0.0.1:15300')
      .set('Origin', origin).set('X-CSRF-Token', csrf).send({ title: '可修改的聊天' }).expect(200)
    expect(upstreamWrites).toBe(beforeUpstreamWrites + 1)
  })
})
