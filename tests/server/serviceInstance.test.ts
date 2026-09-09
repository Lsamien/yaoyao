// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import request from 'supertest'
import { acquireServiceInstance } from '../../src/server/serviceInstance'

let home: string
let instances: ReturnType<typeof acquireServiceInstance>[]
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'yaoyao-service-lock-')); instances = [] })
afterEach(() => { for (const instance of instances) instance.release(); rmSync(home, { recursive: true, force: true }) })
const acquire = (desktop = true) => { const instance = acquireServiceInstance(home, '0.3.32', desktop); instances.push(instance); return instance }

describe('service ownership', () => {
  it('rejects new application requests during shutdown without calling it an update',async()=>{
    const instance=acquire(false)
    const app=new Koa().use(instance.middleware(async()=>{})).use(ctx=>{ctx.body={ok:true}})
    await request(app.callback()).post('/api/app/conversations').expect(200)
    instance.beginShutdown()
    const blocked=await request(app.callback()).post('/api/app/conversations').expect(503)
    expect(blocked.body.code).toBe('service_stopping')
    const state=await request(app.callback()).get('/desktop/service').set('x-yaoyao-desktop-token',instance.record.token).expect(200)
    expect(state.body.stopping).toBe(true)
    expect(state.body.quiesced).toBe(false)
  })
  it('excludes a second process connection and releases ownership explicitly', () => {
    const first = acquire()
    expect(() => acquire()).toThrow('另一个')
    first.release()
    const next = acquire()
    expect(next.record.instanceId).not.toBe(first.record.instanceId)
    first.release()
    expect(JSON.parse(readFileSync(join(home, 'service-instance.json'), 'utf8')).instanceId).toBe(next.record.instanceId)
  })
  it('uses a private capability and exact local service identity, not a public port probe', async () => {
    const instance = acquire();instance.publish('http://127.0.0.1:12345')
    let stops = 0
    const app = new Koa().use(instance.middleware(async () => { stops++ }))
    await request(app.callback()).get('/desktop/service').expect(403)
    await request(app.callback()).get('/desktop/service').set('x-yaoyao-desktop-token', instance.record.token).set('Origin', 'http://evil.test').expect(403)
    const result = await request(app.callback()).get('/desktop/service').set('x-yaoyao-desktop-token', instance.record.token).expect(200)
    expect(result.body).toMatchObject({ protocol: 1, pid: process.pid, instanceId: instance.record.instanceId })
    expect(result.body.token).toBeUndefined()
    await request(app.callback()).delete('/desktop/service').set('x-yaoyao-desktop-token', instance.record.token).expect(200)
    await new Promise(resolve => setImmediate(resolve))
    expect(stops).toBe(1)
  })
  it('refuses stopping an externally managed CLI service', async () => {
    const instance = acquire(false)
    const app = new Koa().use(instance.middleware(async () => { throw new Error('must not stop') }))
    await request(app.callback()).delete('/desktop/service').set('x-yaoyao-desktop-token', instance.record.token).expect(405)
  })
  it('admits updates only when idle and blocks application traffic until verification commits', async () => {
    const instance = acquire(false)
    let busy = true, writes = 0
    const app = new Koa().use(instance.middleware(async () => {}, () => !busy)).use(ctx => { writes++; ctx.body = { ok: true } })
    const api = request(app.callback()), auth = { 'x-yaoyao-desktop-token': instance.record.token }
    await api.post('/desktop/service/quiesce').expect(403)
    await api.post('/desktop/service/quiesce').set(auth).expect(409)
    await api.post('/api/app/conversations').expect(200)
    busy = false
    await api.post('/desktop/service/quiesce').set(auth).expect(200)
    await api.post('/api/app/conversations').expect(503)
    expect(writes).toBe(1)
    mkdirSync(join(home, 'updates')); writeFileSync(join(home, 'updates', 'transition.json'), '{}')
    await api.delete('/desktop/service/quiesce').set(auth).expect(405)
    await api.get('/healthz').expect(200)
    rmSync(join(home, 'updates', 'transition.json'))
    await api.delete('/desktop/service/quiesce').set(auth).expect(200)
    await api.post('/api/app/conversations').expect(200)
  })
  it('expires a preparation lease if the updater exits before recording a transaction', async () => {
    const instance = acquire(false), now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const app = new Koa().use(instance.middleware(async () => {})).use(ctx => { ctx.body = { ok: true } })
      const api = request(app.callback())
      await api.post('/desktop/service/quiesce').set('x-yaoyao-desktop-token', instance.record.token).expect(200)
      await api.post('/api/app/conversations').expect(503)
      clock.mockReturnValue(now + 15001)
      await api.post('/api/app/conversations').expect(200)
    } finally { clock.mockRestore() }
  })
})
