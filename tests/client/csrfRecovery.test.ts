import { afterEach, describe, expect, it, vi } from 'vitest'
import type Koa from 'koa'
import { CsrfProtection } from '../../src/server/security'
import { apiRequest, clearApiSecurityContext, onApiUnauthorized, setApiCsrfToken } from '@/api/client'

const refreshPath = '/api/app/bootstrap?csrfOnly=1'
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
const invalid = () => response({ code: 'invalid_csrf', message: 'CSRF token is invalid or missing' }, 403)
afterEach(() => { clearApiSecurityContext(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('long-lived desktop CSRF recovery', () => {
  it('renews an expired eight-hour signed cookie and executes the original action exactly once', async () => {
    const csrf = new CsrfProtection()
    let clock = 1000, cookie = '', expiresAt = 0, executed = 0
    const renew = () => {
      const headers: Record<string, unknown> = {}
      const ctx = { response: { headers }, get: () => clock < expiresAt ? cookie : '',
        set: (key: string, value: unknown) => { headers[key.toLowerCase()] = value } } as unknown as Koa.Context
      const token = csrf.issue(ctx)
      if (headers['set-cookie']) {
        const value = (headers['set-cookie'] as string[])[0]!
        expect(value).toContain('Max-Age=28800')
        cookie = value.split(';')[0]!; expiresAt = clock + 28_800_000
      }
      return token
    }
    const old = renew()
    setApiCsrfToken(old, 'account-a')
    clock += 28_800_001
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === refreshPath) return response({ csrfToken: renew(), userId: 'account-a' })
      if (!csrf.verify(clock < expiresAt ? cookie : '', new Headers(init?.headers).get('X-CSRF-Token') ?? undefined)) return invalid()
      executed += 1
      return response({ accepted: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    const body = { requestId: 'original-send-id', content: '只发送一次' }
    await expect(apiRequest('/api/app/conversations/session/messages', {
      method: 'POST', body, headers: { 'Idempotency-Key': 'original-send-id' },
    })).resolves.toEqual({ accepted: true })
    expect(executed).toBe(1)
    const mutations = fetchMock.mock.calls.filter(([path]) => path !== refreshPath)
    expect(mutations).toHaveLength(2)
    expect(mutations.map(([, init]) => init?.body)).toEqual([JSON.stringify(body), JSON.stringify(body)])
    expect(mutations.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual(['original-send-id', 'original-send-id'])
    expect(new Headers(mutations[0]![1]?.headers).get('X-CSRF-Token')).toBe(old)
    expect(new Headers(mutations[1]![1]?.headers).get('X-CSRF-Token')).not.toBe(old)
  })

  it('shares one refresh across concurrent ordinary-chat and Bot requests', async () => {
    setApiCsrfToken('expired', 'account-a')
    let release!: (value: Response) => void
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === refreshPath) return new Promise<Response>(resolve => { release = resolve })
      return new Headers(init?.headers).get('X-CSRF-Token') === 'renewed' ? response({ ok: true }) : invalid()
    })
    vi.stubGlobal('fetch', fetchMock)
    const paths = ['/api/realtime/channels/chat/commands', '/api/app/conversations/bot/messages', '/api/app/account/avatar']
    const jobs = paths.map(path => apiRequest(path, { method: 'POST', body: { requestId: path } }))
    await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path === refreshPath)).toHaveLength(1))
    release(response({ csrfToken: 'renewed', userId: 'account-a' }))
    await Promise.all(jobs)
    expect(fetchMock.mock.calls.filter(([path]) => path === refreshPath)).toHaveLength(1)
    for (const path of paths) expect(fetchMock.mock.calls.filter(([value]) => value === path)).toHaveLength(2)
  })

  it('prepares a missing token and accepts a full bootstrap from an older server', async () => {
    const fetchMock = vi.fn(async (path: string) => path === refreshPath
      ? response({ csrfToken: 'legacy-token', user: { id: 'account-a' }, authRequired: true, profiles: [] })
      : response({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('/api/app/account/avatar', { method: 'PUT', body: {} })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([refreshPath, '/api/app/account/avatar'])
  })

  it.each([['invalid_origin', 403], ['permission_denied', 403], ['upstream_failure', 500]])(
    'does not retry %s failures', async (code, status) => {
      setApiCsrfToken('valid', 'account-a')
      const fetchMock = vi.fn(async () => response({ code }, Number(status)))
      vi.stubGlobal('fetch', fetchMock)
      await expect(apiRequest('/api/app/action', { method: 'POST', body: {} })).rejects.toMatchObject({ code })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('does not retry network failures with an unknown submission result', async () => {
    setApiCsrfToken('valid', 'account-a')
    const fetchMock = vi.fn(async () => { throw new TypeError('Connection lost') })
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('/api/app/action', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops after one retry when the refreshed token is still rejected', async () => {
    setApiCsrfToken('expired', 'account-a')
    const fetchMock = vi.fn(async (path: string) => path === refreshPath
      ? response({ csrfToken: 'new-token', userId: 'account-a' }) : invalid())
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('/api/app/action', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'invalid_csrf' })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(['/api/app/action', refreshPath, '/api/app/action'])
  })

  it('does not replay an old account action after a cookie account change', async () => {
    setApiCsrfToken('expired', 'account-a')
    const expired = vi.fn(), unsubscribe = onApiUnauthorized(expired)
    const fetchMock = vi.fn(async (path: string) => path === refreshPath
      ? response({ csrfToken: 'account-b-token', userId: 'account-b' }) : invalid())
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(apiRequest('/api/app/action', { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'SECURITY_CONTEXT_CHANGED' })
      expect(fetchMock.mock.calls.filter(([path]) => path !== refreshPath)).toHaveLength(1)
      expect(expired).toHaveBeenCalledTimes(1)
    } finally { unsubscribe() }
  })

  it('discards a refresh completed after local logout', async () => {
    setApiCsrfToken('expired', 'account-a')
    let release!: (value: Response) => void
    const fetchMock = vi.fn(async (path: string) => path === refreshPath
      ? new Promise<Response>(resolve => { release = resolve }) : invalid())
    vi.stubGlobal('fetch', fetchMock)
    const sending = apiRequest('/api/app/action', { method: 'POST', body: {} }).catch(error => error)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    clearApiSecurityContext(); setApiCsrfToken('account-b-token', 'account-b')
    release(response({ csrfToken: 'late-a-token', userId: 'account-a' }))
    expect(await sending).toMatchObject({ code: 'SECURITY_CONTEXT_CHANGED' })
    expect(fetchMock.mock.calls.filter(([path]) => path !== refreshPath)).toHaveLength(1)
  })

  it('cancels one waiting request without cancelling another request sharing the refresh', async () => {
    setApiCsrfToken('expired', 'account-a')
    let release!: (value: Response) => void
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => path === refreshPath
      ? new Promise<Response>(resolve => { release = resolve })
      : new Headers(init?.headers).get('X-CSRF-Token') === 'renewed' ? response({ ok: true }) : invalid())
    vi.stubGlobal('fetch', fetchMock)
    const abort = new AbortController()
    const cancelled = apiRequest('/api/app/cancelled', { method: 'POST', signal: abort.signal }).catch(error => error)
    const retained = apiRequest('/api/app/retained', { method: 'POST' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    abort.abort()
    expect(await cancelled).toMatchObject({ code: 'REQUEST_ABORTED' })
    release(response({ csrfToken: 'renewed', userId: 'account-a' }))
    await expect(retained).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/app/cancelled')).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/app/retained')).toHaveLength(2)
  })

  it('does not send an already cancelled action', async () => {
    const fetchMock = vi.fn(), abort = new AbortController(); abort.abort()
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('/api/app/action', { method: 'POST', signal: abort.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors the original request deadline while renewal is pending', async () => {
    setApiCsrfToken('expired', 'account-a')
    let release!: (value: Response) => void
    const fetchMock = vi.fn(async (path: string) => path === refreshPath
      ? new Promise<Response>(resolve => { release = resolve }) : invalid())
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiRequest('/api/app/action', { method: 'POST', timeoutMs: 20 })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    release(response({ csrfToken: 'renewed', userId: 'account-a' }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls.filter(([path]) => path !== refreshPath)).toHaveLength(1)
  })

  it('uses an already renewed token for a late CSRF rejection without renewing twice', async () => {
    setApiCsrfToken('expired', 'account-a')
    let rejectLate!: (value: Response) => void
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === refreshPath) return response({ csrfToken: 'renewed', userId: 'account-a' })
      if (new Headers(init?.headers).get('X-CSRF-Token') === 'renewed') return response({ ok: true })
      return path.endsWith('/late') ? new Promise<Response>(resolve => { rejectLate = resolve }) : invalid()
    })
    vi.stubGlobal('fetch', fetchMock)
    const late = apiRequest('/api/app/late', { method: 'POST' })
    await apiRequest('/api/app/first', { method: 'POST' })
    rejectLate(invalid())
    await late
    expect(fetchMock.mock.calls.filter(([path]) => path === refreshPath)).toHaveLength(1)
  })

  it('keeps the login context when renewal returns malformed data and allows a later retry', async () => {
    setApiCsrfToken('expired', 'account-a')
    const expired = vi.fn(), unsubscribe = onApiUnauthorized(expired)
    const fetchMock = vi.fn(async (path: string) => path === refreshPath ? response({}) : invalid())
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(apiRequest('/api/app/action', { method: 'POST' })).rejects.toMatchObject({ code: 'CSRF_REFRESH_FAILED' })
      expect(expired).not.toHaveBeenCalled()
      fetchMock.mockImplementation(async (path: string, init?: RequestInit) => path === refreshPath
        ? response({ csrfToken: 'valid-again', userId: 'account-a' })
        : new Headers(init?.headers).get('X-CSRF-Token') === 'valid-again' ? response({ ok: true }) : invalid())
      await expect(apiRequest('/api/app/action', { method: 'POST' })).resolves.toEqual({ ok: true })
    } finally { unsubscribe() }
  })

  it('preserves the original upload body while renewing its token', async () => {
    setApiCsrfToken('expired', 'account-a')
    const body = new FormData(); body.set('caption', '原始内容'); body.set('file', new Blob(['original']), 'original.txt')
    const snapshots: Array<[string | null, string]> = []
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === refreshPath) {
        body.set('caption', '后续编辑'); body.set('file', new Blob(['new']), 'new.txt')
        return response({ csrfToken: 'new-token', userId: 'account-a' })
      }
      const sent = init?.body as FormData
      snapshots.push([sent.get('caption') as string | null, (sent.get('file') as File).name])
      return snapshots.length === 1 ? invalid() : response({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    await apiRequest('/api/app/uploads', { method: 'POST', body })
    expect(snapshots).toEqual([['原始内容', 'original.txt'], ['原始内容', 'original.txt']])
  })

  it('revalidates another window token instead of silently executing under its account', async () => {
    let receive!: (event: { data: unknown }) => void
    vi.stubGlobal('BroadcastChannel', class {
      addEventListener(_type: string, handler: typeof receive) { receive = handler }
      postMessage() {}
    })
    vi.resetModules()
    const client = await import('@/api/client')
    client.setApiCsrfToken('account-a-token', 'account-a')
    receive({ data: 'account-b-token' })
    const fetchMock = vi.fn(async () => response({ csrfToken: 'account-b-token', userId: 'account-b' }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(client.apiRequest('/api/app/action', { method: 'POST' })).rejects.toMatchObject({ code: 'SECURITY_CONTEXT_CHANGED' })
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(refreshPath, expect.objectContaining({ credentials: 'include' }))
    } finally { client.clearApiSecurityContext() }
  })

  it('serializes expired-cookie renewal across windows using the origin lock', async () => {
    let tail = Promise.resolve(), cookie = '', issued = 0
    const lock = vi.fn((_name: string, action: () => Promise<void>) => {
      const job = tail.then(action); tail = job.catch(() => {}); return job
    })
    vi.stubGlobal('navigator', { locks: { request: lock } })
    vi.resetModules()
    const otherWindow = await import('@/api/client')
    setApiCsrfToken('expired', 'account-a'); otherWindow.setApiCsrfToken('expired', 'account-a')
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === refreshPath) {
        const token = cookie || `renewed-${++issued}`
        await Promise.resolve(); cookie = token
        return response({ csrfToken: token, userId: 'account-a' })
      }
      return new Headers(init?.headers).get('X-CSRF-Token') === cookie ? response({ ok: true }) : invalid()
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await Promise.all([apiRequest('/api/app/first-window', { method: 'POST' }), otherWindow.apiRequest('/api/app/second-window', { method: 'POST' })])
      expect(issued).toBe(1)
      expect(lock).toHaveBeenCalledTimes(2)
    } finally { otherWindow.clearApiSecurityContext() }
  })
})
