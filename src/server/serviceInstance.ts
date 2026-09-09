import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type Koa from 'koa'
import type { BuildIdentity } from './buildIdentity.js'

export interface ServiceRecord {
  protocol: 1
  instanceId: string
  pid: number
  dataKey: string
  version: string
  url?: string
  token: string
  desktopOwned: boolean
  build?: BuildIdentity
  maintenanceProtocol: 1
}

/** Every executable entry takes this lock before opening any databases.
 * Process death can be recovered; an unknown or live owner always fails closed. */
export function acquireServiceInstance(home: string, version: string, desktopOwned = false, build?: BuildIdentity) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const root = realpathSync(home), file = join(root, 'service-instance.json')
  // SQLite holds an OS-level lock, released by the kernel on process death.
  // A separate database avoids blocking the application databases. No stale
  // PID-file unlink race can evict a replacement process.
  const lockPath = join(root, 'service-instance.sqlite3'), lock = new DatabaseSync(lockPath)
  chmodSync(lockPath, 0o600)
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE') }
  catch { lock.close(); throw new Error('这份数据已由另一个夭夭服务使用，请连接已有服务。') }
  const record: ServiceRecord = { protocol: 1, instanceId: randomUUID(), pid: process.pid,
    dataKey: createHash('sha256').update(root).digest('hex'), version,
    token: randomBytes(32).toString('base64url'), desktopOwned, build, maintenanceProtocol: 1 }
  const write = () => {
    const temporary = join(root, `service-instance-${record.instanceId}.tmp`)
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    renameSync(temporary, file)
  }
  try { write() } catch (error) { lock.close(); throw error }
  let released = false
  let stopping = false
  let quiescedUntil = 0, pendingMutations = 0
  const transition = join(root, 'updates', 'transition.json')
  const quiesced = () => Date.now() < quiescedUntil || existsSync(transition)
  return {
    record,
    get quiesced() { return quiesced() },
    beginShutdown() { stopping = true },
    publish(url: string) { record.url = url; write() },
    release() {
      if (released) return
      released = true
      try {
        const current = JSON.parse(readFileSync(file, 'utf8')) as ServiceRecord
        if (current.instanceId === record.instanceId && current.pid === process.pid) {
          rmSync(file)
        }
      } catch { /* Never remove a lock that can no longer be identified. */ }
      finally { lock.close() }
    },
    middleware(shutdown: () => Promise<void>, idle: () => boolean = () => true): Koa.Middleware {
      return async (ctx, next) => {
        const control = ctx.path === '/desktop/service' || ctx.path === '/desktop/service/quiesce'
        if (!control) {
          if(stopping){ctx.status=503;ctx.body={error:'后台服务正在停止',code:'service_stopping'};return}
          if (quiesced() && !['/healthz', '/readyz', '/api/status'].includes(ctx.path)) {
            ctx.status = 503; ctx.set('Retry-After', '3')
            ctx.body = { error: 'Web 服务正在更新，请稍后重试', code: 'service_updating' }; return
          }
          const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(ctx.method) && !/^\/api\/runner\/.*\/(poll|heartbeat)$/.test(ctx.path)
          if (mutation) pendingMutations++
          try { await next() } finally { if (mutation) pendingMutations-- }
          return
        }
        const received = createHash('sha256').update(ctx.get('x-yaoyao-desktop-token')).digest()
        const expected = createHash('sha256').update(record.token).digest()
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ctx.req.socket.remoteAddress ?? '')
        if (!local || ctx.get('origin') || !timingSafeEqual(received, expected)) { ctx.status = 403; ctx.body = { error: '桌面服务授权无效' }; return }
        ctx.set('Cache-Control', 'no-store')
        if (ctx.path.endsWith('/quiesce')) {
          if (ctx.method === 'POST') {
            if (pendingMutations || !idle()) { ctx.status = 409; ctx.body = { error: '正在等待任务完成', code: 'service_busy' }; return }
            quiescedUntil = Date.now() + 15000; ctx.body = { quiesced: true }
          } else if (ctx.method === 'DELETE' && !existsSync(transition)) {
            quiescedUntil = 0; ctx.body = { quiesced: false }
          } else { ctx.status = 405; ctx.body = { error: '更新事务尚未结束' } }
        } else if (ctx.method === 'GET') {
          const { token: _token, ...publicRecord } = record
          ctx.body = { ...publicRecord, quiesced: quiesced(), stopping }
        } else if (ctx.method === 'DELETE' && desktopOwned) {
          ctx.body = { stopping: true }
          setImmediate(() => { void shutdown() })
        } else { ctx.status = 405; ctx.body = { error: '此服务不接受桌面停止请求' } }
      }
    },
  }
}
