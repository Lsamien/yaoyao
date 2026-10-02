import type Koa from 'koa'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const compress = promisify(gzip)

/** Compress completed API documents only; SSE must flush each event unchanged. */
export const jsonCompression: Koa.Middleware = async (ctx, next) => {
  await next()
  if (!ctx.path.startsWith('/api/') || ctx.method === 'HEAD' || ctx.status !== 200
    || ctx.respond === false || ctx.res.headersSent || !ctx.response.is('application/json')
    || ctx.response.get('Content-Encoding') || ctx.body == null) return
  const value = ctx.body
  if (!Buffer.isBuffer(value) && typeof value !== 'string' && typeof value !== 'object') return
  if (typeof value === 'object' && !Buffer.isBuffer(value) && 'pipe' in value) return
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  if (body.length < 1024) return
  ctx.vary('Accept-Encoding')
  if (ctx.acceptsEncodings('gzip', 'identity') !== 'gzip') return
  const compressed = await compress(body)
  if (compressed.length >= body.length) return
  ctx.set('Content-Encoding', 'gzip')
  ctx.remove('Content-Length')
  ctx.body = compressed
  ctx.type = 'application/json'
}
