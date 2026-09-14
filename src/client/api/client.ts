import type { JsonValue } from '@shared/types'
import { bool, normalizeUser, record, string } from '@/utils/normalize'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: JsonValue

  constructor(message: string, status = 0, code?: string, details?: JsonValue) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

let csrfToken = ''
let csrfAccountId: string | null | undefined
let securityGeneration = 0
let csrfRefresh: { generation: number; promise: Promise<void> } | undefined
const unauthorizedListeners = new Set<() => void>()
const securityChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel !== 'undefined'
  ? new window.BroadcastChannel('hermes-yaoyao-security')
  : undefined
securityChannel?.addEventListener('message', event => {
  // Another window shares cookies, but may now belong to another account.
  // Revalidate that identity before using its token for a pending action.
  if (typeof event.data === 'string' && event.data !== csrfToken) csrfToken = ''
})

export function setApiCsrfToken(token?: string | null, accountId?: string | null): void {
  if (accountId !== undefined) {
    if (csrfAccountId !== undefined && csrfAccountId !== accountId) securityGeneration += 1
    csrfAccountId = accountId
  }
  csrfToken = token?.trim() ?? ''
  securityChannel?.postMessage(csrfToken)
}

export function clearApiSecurityContext(): void {
  securityGeneration += 1
  csrfToken = ''
  csrfAccountId = undefined
  csrfRefresh = undefined
}

function requireSecurityGeneration(generation: number): void {
  if (generation !== securityGeneration) throw new ApiError('登录状态已变化，请重新操作', 0, 'SECURITY_CONTEXT_CHANGED')
}

function refreshCsrfToken(rejectedToken: string): Promise<void> {
  if (csrfToken && csrfToken !== rejectedToken) return Promise.resolve()
  const generation = securityGeneration, accountId = csrfAccountId
  if (csrfRefresh?.generation === generation) return csrfRefresh.promise
  const renew = async () => {
    requireSecurityGeneration(generation)
    const payload = await apiRequest<unknown>('/api/app/bootstrap?csrfOnly=1', {
      csrf: false, notifyUnauthorized: false, timeoutMs: 10_000,
    })
    requireSecurityGeneration(generation)
    const root = record(unwrapData(payload)), status = record(root.status)
    const user = root.user ?? root.identity
    const token = string(root.csrfToken ?? root.csrf_token ?? root.csrf).trim()
    const authRequired = root.authRequired ?? root.auth_required ?? status.authRequired ?? status.auth_required
    if (!token || (!('userId' in root) && !user && authRequired === undefined)
      || ('userId' in root && root.userId !== null && typeof root.userId !== 'string'))
      throw new ApiError('无法更新安全令牌，请稍后重试', 0, 'CSRF_REFRESH_FAILED')
    // Older servers ignore csrfOnly and return a complete bootstrap response.
    const currentAccount = 'userId' in root ? (typeof root.userId === 'string' ? root.userId : null)
      : user ? normalizeUser(user).id
        : bool(authRequired) ? null : 'local'
    if (accountId !== undefined && currentAccount !== accountId) {
      clearApiSecurityContext()
      for (const listener of unauthorizedListeners) listener()
      throw new ApiError('登录账号已变化，请重新登录后操作', 401, 'SECURITY_CONTEXT_CHANGED')
    }
    setApiCsrfToken(token, currentAccount)
  }
  // Cookie issuance must also be serialized across windows when supported;
  // otherwise two expired-cookie responses can replace one another's token.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  const promise = (locks ? locks.request('hermes-yaoyao-csrf-refresh', renew) : renew())
    .finally(() => { if (csrfRefresh?.promise === promise) csrfRefresh = undefined })
  csrfRefresh = { generation, promise }
  return promise
}

function waitForCsrfRefresh(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('Request aborted', 'AbortError')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
  })
}

export function onApiUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: JsonValue | FormData | Blob
  csrf?: boolean
  timeoutMs?: number
  notifyUnauthorized?: boolean
}

function isBodyInit(value: ApiRequestOptions['body']): value is FormData | Blob {
  return (typeof FormData !== 'undefined' && value instanceof FormData)
    || (typeof Blob !== 'undefined' && value instanceof Blob)
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const nested = record.error && typeof record.error === 'object'
      ? record.error as Record<string, unknown>
      : undefined
    for (const candidate of [record.message, record.error, nested?.message, record.detail]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
    if (Array.isArray(record.detail)) {
      const validation = record.detail.find(item => item && typeof item === 'object') as Record<string, unknown> | undefined
      if (validation && typeof validation.msg === 'string' && validation.msg.trim()) {
        const location = Array.isArray(validation.loc)
          ? validation.loc.filter(item => typeof item === 'string' || typeof item === 'number').join('.')
          : ''
        return location ? `${location}：${validation.msg.trim()}` : validation.msg.trim()
      }
    }
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim()
  return fallback
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  if (!path.startsWith('/api/app/') && !path.startsWith('/api/realtime/')) throw new ApiError('客户端仅允许访问应用接口', 0, 'INVALID_PATH')

  const method = (options.method ?? 'GET').toUpperCase()
  const requiresCsrf = options.csrf !== false && !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const generation = securityGeneration
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')

  let body: BodyInit | undefined
  if (options.body !== undefined) {
    if (isBodyInit(options.body)) {
      if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
        const snapshot = new FormData()
        options.body.forEach((value, key) => snapshot.append(key, value))
        body = snapshot
      } else body = options.body
    } else {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(options.body)
    }
  }

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError')
    if (requiresCsrf && !csrfToken) await waitForCsrfRefresh(refreshCsrfToken(''), controller.signal)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestHeaders = new Headers(headers)
      if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError')
      if (requiresCsrf) {
        requireSecurityGeneration(generation)
        requestHeaders.set('X-CSRF-Token', csrfToken)
      }
      const sentToken = requestHeaders.get('X-CSRF-Token') ?? ''
      const response = await fetch(path, {
        ...options,
        method,
        headers: requestHeaders,
        body,
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      })
      const contentType = response.headers.get('content-type') ?? ''
      const payload = response.status === 204
        ? undefined
        : contentType.includes('application/json')
          ? await response.json().catch(() => undefined)
          : await response.text().catch(() => undefined)
      if (!response.ok) {
        const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
        const code = typeof record?.code === 'string' ? record.code : undefined
        if (requiresCsrf && attempt === 0 && response.status === 403 && code === 'invalid_csrf') {
          requireSecurityGeneration(generation)
          // This explicit rejection occurs before the server executes the action.
          // Preserve the original body and idempotency key; never retry timeouts.
          await waitForCsrfRefresh(refreshCsrfToken(sentToken), controller.signal)
          continue
        }
        if (response.status === 401
          && options.notifyUnauthorized !== false) {
          for (const listener of unauthorizedListeners) listener()
        }
        throw new ApiError(
          errorMessage(payload, `请求失败（${response.status}）`),
          response.status,
          code,
          payload as JsonValue,
        )
      }
      return payload as T
    }
    throw new ApiError('安全令牌校验失败，请稍后重试', 403, 'invalid_csrf')
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (controller.signal.aborted) throw new ApiError('请求已取消或超时', 0, 'REQUEST_ABORTED')
    throw new ApiError(error instanceof Error ? error.message : '网络请求失败', 0, 'NETWORK_ERROR')
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function apiUrl(path: string, query: Record<string, string | number | boolean | null | undefined> = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `${path}?${encoded}` : path
}

export function unwrapData<T>(payload: T | { data: T }): T {
  return payload && typeof payload === 'object' && 'data' in payload
    ? (payload as { data: T }).data
    : payload as T
}
