// @vitest-environment node
import Koa from 'koa'
import request from 'supertest'
import { expect, it } from 'vitest'
import { jsonCompression } from '../../src/server/jsonCompression.js'

it('compresses JSON for supported clients and leaves identity and SSE responses intact', async () => {
  const app = new Koa(), value = { content: 'large result'.repeat(2000) }
  app.use(jsonCompression)
  app.use(ctx => {
    if (ctx.path === '/api/events') { ctx.type = 'text/event-stream';ctx.body = 'event: ready\ndata: {}\n\n' }
    else ctx.body = value
  })
  const compressed = await request(app.callback()).get('/api/snapshot').set('Accept-Encoding', 'gzip').expect(200)
  expect(compressed.headers['content-encoding']).toBe('gzip')
  expect(compressed.headers.vary).toContain('Accept-Encoding')
  expect(compressed.body).toEqual(value)
  expect(Number(compressed.headers['content-length'])).toBeLessThan(1024)
  const identity = await request(app.callback()).get('/api/snapshot').set('Accept-Encoding', 'identity').expect(200)
  expect(identity.headers['content-encoding']).toBeUndefined()
  expect(identity.body).toEqual(value)
  const stream = await request(app.callback()).get('/api/events').set('Accept-Encoding', 'gzip').expect(200)
  expect(stream.headers['content-encoding']).toBeUndefined()
  expect(stream.text).toBe('event: ready\ndata: {}\n\n')
})
