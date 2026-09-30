// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import request from 'supertest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app'
import type { RealtimeReceipts } from '../../src/server/realtimeReceipts'

let runtime: ApplicationRuntime | undefined, home: string, server: Server | undefined
afterEach(async () => { runtime?.close(); if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())) }
  if (home) rmSync(home, { recursive: true, force: true }) })
it('recovers encoded mobile receipt IDs while preserving authentication and strict ID validation', async () => {
  home = mkdtempSync(join(tmpdir(), 'yaoyao-receipt-route-'))
  for (const name of ['media', 'attachments', 'images']) mkdirSync(join(home, name))
  runtime = createApplication({ deferBackground: true, fetchImpl: async () => { throw new Error('No upstream network in this test') },
    config: { host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:1'), home, allowedHosts: new Set(),
      mediaRoot: join(home, 'media'), attachmentsRoot: join(home, 'attachments'), imagesRoot: join(home, 'images'),
      mediaOwner: 'fixture', production: false, allowInsecureLan: false, insecureLan: false } })
  server = createServer(runtime.app.callback()); await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
  const agent = request.agent(server), headers = { Host: '127.0.0.1:15300', Origin: 'http://127.0.0.1:15300' }
  const bootstrap = await agent.get('/api/app/bootstrap?inspectOnly=1').set(headers).expect(200)
  const setup = await agent.post('/api/app/setup').set(headers).set('X-CSRF-Token', bootstrap.body.csrfToken)
    .send({ username: 'receipt-fixture', password: 'fixture-password' }).expect(200)
  const id = 'ios:attachment:request:file', owner = `user:${setup.body.user.id}:${runtime.auth.pushAuthorizationVersion(setup.body.user.id)}`
  const receipts = (runtime.realtime.broker as unknown as { receipts: RealtimeReceipts }).receipts
  receipts.reserve(owner, id, '{}'); receipts.finish(owner, id, 'confirmed', { result: { ref_text: '@file:/fixture/file' } }, { method: 'file.attach' })
  for (const path of [id, encodeURIComponent(id)]) {
    const result = await agent.get(`/api/realtime/commands/${path}`).set(headers).expect(200)
    expect(result.body).toMatchObject({ requestId: id, state: 'confirmed', response: { result: { ref_text: '@file:/fixture/file' } } })
  }
  await request(server).get(`/api/realtime/commands/${encodeURIComponent(id)}`).set(headers).expect(401)
  for (const invalid of ['ios%2Fforeign', '%ZZ', 'bad%20id'])
    await agent.get(`/api/realtime/commands/${invalid}`).set(headers).expect(400)
})
