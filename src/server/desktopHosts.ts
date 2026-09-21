import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import Router from '@koa/router'
import type Koa from 'koa'
import { z } from 'zod'
import { HttpError } from './errors.js'
import { parse, type WorkspaceStore } from './workspaceStore.js'
import type { LocalAuthStore } from './localAuth.js'
import { DESKTOP_HOST_PROTOCOL, type DesktopHostExchange, type DesktopHostRecord, type DesktopHostSummary } from '../shared/desktopHost.js'
import { desktopHostExchangeSchema } from './desktopHostProtocol.js'
import { readComputerNames, saveComputerName } from './computerNames.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const enrollInput = z.object({
  name: z.string().trim().min(1).max(100),
  installId: z.string().uuid().optional(),
  previousHostId: z.string().uuid().optional(),
}).strict()

/** Outbound-only machine transport for remote computers. Browser auth and
 *  machine auth remain separate: these endpoints never enter the user session,
 *  CSRF or CORS pipeline, and reject any request carrying an Origin header. */
export class DesktopHostHub {
  /** Bound to DesktopEnvironments.remoteExchange once the runtime exists. */
  exchange: (id: string, value: DesktopHostExchange) => unknown = () => { throw new HttpError(503, '电脑尚未接入', 'desktop_host_offline') }
  /** Bound to DesktopEnvironments.dropHost so revocation fences live commands. */
  drop: (id: string) => void = () => {}
  private online = new Map<string, { seen: number; name: string; platform: string }>()
  constructor(readonly store: WorkspaceStore, readonly auth: LocalAuthStore) {}
  records(): DesktopHostRecord[] { return this.store.list('_system', 'desktop-host') }
  enroll(value: unknown) {
    const body = parse(enrollInput, value)
    const token = randomBytes(32).toString('base64url')
    const records = this.records()
    let record = body.installId ? records.find(item => item.installId === body.installId) : undefined
    if (!record && body.previousHostId) record = records.find(item => item.id === body.previousHostId)
    if (!record && body.installId) {
      const unnamed = records.filter(item => item.enabled && item.name === body.name && !item.installId).sort((a, b) => a.createdAt - b.createdAt)
      record = unnamed[0]
      for (const extra of unnamed.slice(1)) {
        extra.enabled = false
        this.store.put('_system', 'desktop-host', extra.id, extra)
        this.online.delete(extra.id)
        this.drop(extra.id)
      }
    }
    if (record) {
      record.name = body.name
      record.installId = body.installId
      record.tokenHash = hash(token)
      record.enabled = true
      this.store.put('_system', 'desktop-host', record.id, record)
      return { host: this.summary(record), token }
    }
    const created: DesktopHostRecord = { name: body.name, installId: body.installId, id: randomUUID(), tokenHash: hash(token), enabled: true, createdAt: Date.now() }
    this.store.put('_system', 'desktop-host', created.id, created)
    return { host: this.summary(created), token }
  }
  summary(record: DesktopHostRecord): DesktopHostSummary {
    const { tokenHash: _secret, ...publicRecord } = record
    const state = this.online.get(record.id)
    const displayName = readComputerNames(this.store.home)[record.id] || ''
    return { ...publicRecord, online: !!state && Date.now() - state.seen < 15_000, lastSeen: state?.seen, hostName: state?.name, platform: state?.platform, displayName }
  }
  remove(id: string) {
    const record = this.store.require<DesktopHostRecord>('_system', 'desktop-host', id)
    record.enabled = false
    this.store.put('_system', 'desktop-host', id, record)
    this.online.delete(id)
    this.drop(id)
  }
  adminRouter(): Router {
    const router = new Router()
    router.get('/api/app/admin/desktop-hosts', ctx => { this.auth.requireAdmin(ctx); ctx.set('Cache-Control', 'no-store'); const names = readComputerNames(this.store.home); ctx.body = { protocol: DESKTOP_HOST_PROTOCOL, localName: names.local || '', hosts: this.records().map(record => this.summary(record)) } })
    router.put('/api/app/admin/desktop-hosts/:id/name', ctx => { this.auth.requireAdmin(ctx); const id = ctx.params.id; if (id !== 'local' && !this.records().some(record => record.id === id && record.enabled)) throw new HttpError(404, '这台电脑不存在', 'desktop_host_unknown'); const name = typeof (ctx.request as any).body?.name === 'string' ? (ctx.request as any).body.name : ''; ctx.body = { id, name: saveComputerName(this.store.home, id, name)[id] || '' } })
    router.post('/api/app/admin/desktop-hosts', ctx => { this.auth.requireAdmin(ctx); ctx.body = this.enroll((ctx.request as any).body); ctx.status = 201 })
    router.delete('/api/app/admin/desktop-hosts/:id', ctx => { this.auth.requireAdmin(ctx); this.remove(ctx.params.id); ctx.body = { ok: true } })
    return router
  }
  middleware(): Koa.Middleware {
    return async (ctx, next) => {
      const match = /^\/api\/desktop-host\/v1\/([0-9a-f-]{36})\/exchange$/.exec(ctx.path)
      if (!match) return next()
      const record = this.store.get<DesktopHostRecord>('_system', 'desktop-host', match[1]!)
      const authorization = ctx.get('authorization')
      if (ctx.get('origin') || !record?.enabled || !authorization.startsWith('Bearer ') || !timingSafeEqual(Buffer.from(record.tokenHash), Buffer.from(hash(authorization.slice(7)))))
        throw new HttpError(403, '电脑授权无效', 'desktop_host_unauthorized')
      if (ctx.method !== 'POST') throw new HttpError(405, '仅允许 POST', 'method_not_allowed')
      if (ctx.get('x-desktop-host-protocol') !== String(DESKTOP_HOST_PROTOCOL)) throw new HttpError(409, '电脑连接协议不兼容', 'desktop_host_protocol_mismatch')
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of ctx.req) { bytes += chunk.length; if (bytes > 24 * 1024 * 1024) throw new HttpError(413, '电脑请求过大', 'desktop_limit'); chunks.push(Buffer.from(chunk)) }
      let json: unknown
      try { json = JSON.parse(Buffer.concat(chunks).toString()) } catch { throw new HttpError(400, '电脑请求格式无效', 'desktop_invalid') }
      const value = parse(desktopHostExchangeSchema, json)
      this.online.set(record.id, { seen: Date.now(), name: value.host.name, platform: value.host.platform })
      ctx.set('Cache-Control', 'no-store')
      ctx.body = this.exchange(record.id, value)
    }
  }
  close() { this.online.clear() }
}
