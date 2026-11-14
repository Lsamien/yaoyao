import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { HttpError } from '../errors.js'
import type { HermesServicePool, HermesScope } from './service.js'
import type { EmbeddedSessions } from './sessions.js'

export interface LocalResponse { status: number; headers: Headers; body: Buffer }
export interface LocalRequest { method: string; path: string; search?: URLSearchParams; body?: unknown; maxResponseBytes?: number }

/** Dashboard REST families served by Hermes' own handlers through `hermes_service.py dashboard.call`. */
const NATIVE = /^\/api\/(?:sessions(?:\/.*)?|profiles(?:\/.*)?|config(?:\/.*)?|env(?:\/.*)?|model\/.+|providers\/.+|files(?:\/.*)?|fs\/.+)$/
const SESSION_PATH = /^\/api\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/|$)/

function json(status: number, value: unknown, headers: Record<string, string> = {}): LocalResponse {
  return { status, headers: new Headers({ 'content-type': 'application/json', ...headers }), body: Buffer.from(JSON.stringify(value)) }
}

/**
 * Answers the Hermes dashboard paths Yaoyao used to call over HTTP (9119), in process.
 * There is no upstream account: Yaoyao's own Web login authorizes the caller before this point.
 */
export class HermesApi {
  /** Optional hooks for paths owned by other embedded components. */
  memoryExtract?: (profile: string, prompt: string) => Promise<unknown>

  /** Home the embedded copy was imported from; old transcripts still reference files under it. */
  private readonly legacyHome?: string

  constructor(readonly pool: HermesServicePool, readonly sessions: EmbeddedSessions, readonly version = '0.23.0') {
    const manifest = join(pool.systemHome, '.import.json')
    try { if (existsSync(manifest)) this.legacyHome = String(JSON.parse(readFileSync(manifest, 'utf8')).source || '') || undefined } catch { /* no remap */ }
  }

  /** `~/.hermes/cache/x.png` in an imported message → the same file in the embedded copy. */
  remapLegacyPath(path: string): string {
    const legacy = this.legacyHome
    if (!legacy || !path.startsWith(legacy + sep)) return path
    return join(this.pool.systemHome, path.slice(legacy.length + 1))
  }

  async handle(request: LocalRequest): Promise<LocalResponse> {
    const method = request.method.toUpperCase()
    const path = request.path
    const search = request.search ?? new URLSearchParams()
    if (path === '/api/status') return json(200, { auth_required: false, embedded: true, version: this.version, gateway_running: true })
    if (path === '/api/auth/me') return json(200, { authenticated: true, user: { id: 'yaoyao', name: 'yaoyao' }, provider: 'embedded' })
    if (path === '/api/auth/providers') return json(200, { providers: [] })
    if (path.startsWith('/api/auth/') || path.startsWith('/auth/'))
      return json(410, { error: '内置 Hermes 不使用独立账号，请使用夭夭账号登录。', code: 'embedded_hermes' })
    if (path === '/api/plugins/yaoyao-bot-bridge/capabilities')
      return json(200, { version: 1, ready: true, in_process: true, native_tools: true, embedded: true })
    if (path === '/api/plugins/yaoyao-bot-bridge/memory-extract' && method === 'POST') {
      if (!this.memoryExtract) return json(503, { ok: false, error: '记忆抽取不可用' })
      const body = (request.body ?? {}) as { profile?: unknown; prompt?: unknown }
      const result = await this.memoryExtract(typeof body.profile === 'string' ? body.profile : 'default', String(body.prompt ?? ''))
      return json(200, { ok: true, ...(result && typeof result === 'object' ? result : { text: result }) })
    }
    if (path === '/api/plugins/yaoyao-bot-bridge/model-options' || path === '/api/plugins/yaoyao-bot-bridge/model-settings/resolve') {
      const body = (request.body ?? {}) as { profile?: unknown; settings?: unknown }
      const profile = (typeof body.profile === 'string' ? body.profile : search.get('profile')) || 'default'
      const scope: HermesScope = profile === 'default' ? 'system' : { profile }
      try {
        const value = path.endsWith('/model-options')
          ? await this.pool.call(scope, 'botmodels.options', {}, { timeoutMs: 60_000 })
          : await this.pool.call(scope, 'botmodels.resolve', { settings: body.settings ?? null }, { timeoutMs: 60_000 })
        return json(200, value)
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) return json(400, { detail: error.message })
        throw error
      }
    }
    if (!NATIVE.test(path)) return json(404, { detail: 'Not Found' })
    return this.native(method, path, search, request.body, request.maxResponseBytes)
  }

  /** Hermes home that serves a dashboard path: the owning Bot home for its sessions, else the profile. */
  scopeFor(path: string, search: URLSearchParams): HermesScope {
    const profile = search.get('profile')?.trim() || 'default'
    if (path === '/api/profiles' || path.startsWith('/api/profiles/')) return 'system'
    const session = SESSION_PATH.exec(path)?.[1]
    return this.sessions.scope(session, profile)
  }

  private async native(method: string, path: string, search: URLSearchParams, body: unknown, maxBytes = 64 * 1024 * 1024): Promise<LocalResponse> {
    const scope = this.scopeFor(path, search)
    const query = Object.fromEntries(search.entries())
    if ((path.startsWith('/api/files') || path.startsWith('/api/fs/')) && typeof query.path === 'string') query.path = this.remapLegacyPath(query.path)
    const result = await this.pool.call<{ status: number; json?: unknown; text?: string; media_type?: string; file?: string; filename?: string; headers?: Record<string, string> }>(
      scope, 'dashboard.call', { method, path, query, ...(body === undefined ? {} : { body }) }, { timeoutMs: 120_000 })
    const deleted = method === 'DELETE' ? SESSION_PATH.exec(path)?.[1] : undefined
    if (deleted && result.status >= 200 && result.status < 300) this.sessions.delete(deleted)
    if (result.file) {
      const info = await stat(result.file).catch(() => undefined)
      if (!info?.isFile()) return json(404, { detail: 'File not found' })
      if (info.size > maxBytes) throw new HttpError(502, 'Hermes 文件超过本次读取上限', 'upstream_too_large')
      const name = result.filename || basename(result.file)
      return { status: result.status, body: await readFile(result.file), headers: new Headers({
        'content-type': result.media_type || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'content-length': String(info.size), ...(result.headers ?? {}),
      }) }
    }
    if (result.text !== undefined) return { status: result.status, headers: new Headers({ 'content-type': result.media_type || 'text/plain; charset=utf-8' }), body: Buffer.from(result.text) }
    return json(result.status, result.json ?? null)
  }
}
