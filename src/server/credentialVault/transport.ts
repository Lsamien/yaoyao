import { createServer, request, type Server } from 'node:http'
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { CredentialVaultBroker } from './broker.js'
import { parse } from './schema.js'
import { HttpError } from '../errors.js'
import { readPrivateUtf8 } from './privateFiles.js'

const MAX_BYTES = 3 * 1024 * 1024
export function serveCredentialVault(broker: CredentialVaultBroker, token: string): Server {
  if (token.length < 32) throw new Error('密码库控制凭据格式无效')
  const expected = createHash('sha256').update(token).digest()
  const server = createServer((req, res) => { void (async () => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'POST' || req.url !== '/v1' || req.headers.origin) throw new HttpError(403, '密码库只接受私有控制请求', 'vault_control_forbidden')
    const received = createHash('sha256').update(String(req.headers.authorization ?? '').replace(/^Bearer /, '')).digest()
    if (!req.headers.authorization?.startsWith('Bearer ') || !timingSafeEqual(expected, received)) throw new HttpError(403, '密码库控制授权无效', 'vault_control_forbidden')
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) throw new HttpError(413, '密码库请求过大', 'vault_size_limit'); chunks.push(Buffer.from(chunk)) }
    const body = parse(z.object({ epoch: z.string().uuid(), owner: z.string().min(1).max(256), session: z.string().regex(/^[a-f0-9]{64}$/),
      command: z.string().max(64), value: z.unknown().optional() }).strict(), JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const result = body.command === 'hello' ? broker.hello(body.epoch) : body.command === 'execute'
      ? await (() => { const v=parse(z.object({id:z.string().uuid(),input:z.unknown()}).strict(),body.value); res.once('close',()=>{if(!res.writableEnded)broker.connectionClosed(body.owner,body.session,v.id)}); return broker.execute(body.epoch,body.owner,body.session,v.id,v.input as any) })()
      : broker.dispatch(body.epoch, body.owner, body.session, body.command, body.value)
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }))
  })().catch(error => {
    // Never forward parser, sodium, filesystem or executor exception messages.
    res.statusCode = error instanceof HttpError ? error.status : 400
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: error instanceof HttpError ? error.message : '密码库请求失败', code: error instanceof HttpError ? error.code : 'vault_request_failed' }))
  }) })
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000
  server.on('close', () => broker.close())
  server.on('clientError', (_e, socket) => socket.destroy())
  return server
}
/** Private IPC; no global fetch proxy, environment/argv secret or general Runner payload. */
export class CredentialVaultClient {
  private epoch = randomUUID()
  private hello?: Promise<unknown>
  onDisconnect = () => {}
  constructor(private config?: { socket: string; tokenFile: string; hermesUid: number }) {}
  get configured() { return !!this.config }
  private async send(owner: string, session: string, command: string, value?: unknown): Promise<any> {
    const c = this.config
    if (!c) throw new HttpError(503, '执行节点密码库尚未连接', 'vault_offline')
    if (!process.getuid || process.getuid() === 0 || !Number.isSafeInteger(c.hermesUid) || c.hermesUid < 1 || process.getuid() === c.hermesUid)
      throw new HttpError(503, '密码库控制面需要与 Hermes 分离的非 root OS 身份', 'vault_offline')
    if (!isAbsolute(c.socket) || !isAbsolute(c.tokenFile)) throw new HttpError(503, '密码库控制配置无效', 'vault_offline')
    let token: string
    try {
      const socket = lstatSync(c.socket)
      if (!socket.isSocket() || (socket.mode & 0o077) || socket.uid !== process.getuid?.()) throw new Error()
      token = readPrivateUtf8(c.tokenFile,4096).trim(); if (token.length < 32) throw new Error()
    } catch { throw new HttpError(503, '密码库私有连接不可用，请检查部署', 'vault_offline') }
    return new Promise((done, reject) => {
      const req = request({ socketPath: c.socket, path: '/v1', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, res => {
        const chunks: Buffer[] = []; let size = 0
        res.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) req.destroy(); else chunks.push(Buffer.from(chunk)) })
        res.on('error', () => reject(new HttpError(503, '密码库连接中断', 'vault_offline')))
        res.on('aborted', () => reject(new HttpError(503, '密码库连接中断', 'vault_offline')))
        res.on('end', () => {
          try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (res.statusCode !== 200) reject(new HttpError(res.statusCode ?? 503,
            '密码库操作未完成，请检查解锁和任务授权', typeof body.code === 'string' && /^vault_[a-z_]+$/.test(body.code) ? body.code : 'vault_request_failed')); else done(body.result) }
          catch { reject(new HttpError(503, '密码库响应无效', 'vault_offline')) }
        })
      })
      req.setTimeout(command==='execute'?40000:15000, () => req.destroy())
      req.on('error', () => reject(new HttpError(503, '密码库连接中断', 'vault_offline')))
      req.end(JSON.stringify({ epoch: this.epoch, owner, session, command, value }))
    })
  }
  async call(owner: string, session: string, command: string, value?: unknown): Promise<any> {
    try {
      this.hello ??= this.send(owner, session, 'hello')
      await this.hello
      return await this.send(owner, session, command, value)
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'vault_offline' || e.code === 'vault_control_changed')) {
        this.hello = undefined; this.epoch = randomUUID(); this.onDisconnect()
        if(command==='execute')throw new HttpError(409,'执行连接中断，结果不确定，禁止自动重试','vault_operation_uncertain')
      }
      throw e
    }
  }
}
