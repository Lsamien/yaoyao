// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, type ApplicationRuntime } from '../../src/server/app.js'
import type { ServerConfig } from '../../src/server/config.js'
import { createAuthenticatedApplication } from './authenticatedApplication.js'
import { saveFileAccess } from '../../src/server/fileAccess.js'

const HOST = '127.0.0.1:15300'
const IMAGE_NAME = 'openai_codex_gpt-image-2-high_20260902_194820_1d225f08.png'
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=', 'base64')
const homes: string[] = []
const runtimes: ApplicationRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface UpstreamCall {
  url: URL
  method: string
  headers: Headers
}

function config(): ServerConfig {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-hermes-media-'))
  homes.push(home)
  saveFileAccess(home, { mode: 'all', folders: [] })
  return {
    host: '127.0.0.1', port: 15300,
    upstream: new URL('http://10.10.1.200:9119'),
    upstreamUsername: 'fixture-service', upstreamPassword: 'fixture-password',
    allowedHosts: new Set(), home,
    mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
    mediaOwner: 'web-host-owner',
    allowInsecureLan: false, insecureLan: false, production: false,
  }
}

function gateway(response: () => Response = () => new Response(IMAGE, {
  headers: { 'content-type': 'image/png', 'content-disposition': `attachment; filename="${IMAGE_NAME}"` },
})) {
  const calls: UpstreamCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
    if (url.pathname === '/api/status') return Response.json({ auth_required: true }, {
      headers: { 'set-cookie': 'hermes_service=fixture-service-cookie; Path=/; HttpOnly' },
    })
    if (url.pathname === '/api/auth/me') return Response.json({ user_id: 'fixture-service' })
    if (url.pathname === '/api/auth/providers') return Response.json({ providers: [{ name: 'basic', supports_password: true }] })
    if (url.pathname === '/auth/password-login') return Response.json({ ok: true }, {
      headers: { 'set-cookie': 'hermes_service=fixture-service-cookie; Path=/; HttpOnly' },
    })
    if (url.pathname === '/api/files/download') return response()
    return Response.json({ error: 'Unexpected upstream route' }, { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl, downloads: () => calls.filter(call => call.url.pathname === '/api/files/download') }
}

function runtimeFor(fixture: ReturnType<typeof gateway>, authenticated = true): ApplicationRuntime {
  const runtime = (authenticated ? createAuthenticatedApplication : createApplication)({
    config: config(), fetchImpl: fixture.fetchImpl,
  })
  runtimes.push(runtime)
  return runtime
}

function bodyBytes(response: request.Response): Buffer {
  return Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text ?? '')
}

describe('historical Hermes media routes', () => {
  it.each([
    '/Users/samien/.hermes/workspace/gpt-6-astra-report.md',
    '/Users/samien/.hermes/profiles/yaoer/workspace/详细 文档.md',
  ])('serves generated workspace documents for preview and download: %s', async path => {
    const document = '# GPT-6\n\n文档正文'
    const fixture = gateway(() => new Response(document, {
      headers: { 'content-type': 'text/markdown', 'content-disposition': 'attachment; filename="report.md"' },
    }))
    const runtime = runtimeFor(fixture)
    const response = await request(runtime.app.callback()).get(encodeURI(path)).set('Host', HOST).expect(200)
    expect(response.text).toBe(document)
    expect(response.headers['content-type']).toMatch(/^text\/markdown/)
    expect(response.headers['content-disposition']).toBeUndefined()
    expect(response.headers['cache-control']).toContain('private, no-store')
    expect([...fixture.downloads()[0]!.url.searchParams]).toEqual([['path', path]])
  })

  it.each([
    `/Users/samien/.hermes/cache/images/${IMAGE_NAME}`,
    `/Users/samien/.hermes/profiles/yaoer/cache/images/${IMAGE_NAME}`,
  ])('serves the original generated-image URL through the remote Hermes service: %s', async path => {
    const fixture = gateway()
    const runtime = runtimeFor(fixture)
    const response = await request(runtime.app.callback()).get(path)
      .set('Host', HOST).set('Cookie', 'browser_only=must-not-forward').expect(200)

    expect(bodyBytes(response)).toEqual(IMAGE)
    expect(response.headers['content-type']).toMatch(/^image\/png/)
    expect(response.headers['content-disposition'] ?? '').not.toMatch(/^attachment/i)
    expect(response.headers['cache-control']).toContain('private')
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(fixture.downloads()).toHaveLength(1)
    const download = fixture.downloads()[0]!
    expect(download.url.origin).toBe('http://10.10.1.200:9119')
    expect([...download.url.searchParams]).toEqual([['path', path]])
    expect(download.method).toBe('GET')
    expect(download.headers.get('cookie')).toContain('hermes_service=fixture-service-cookie')
    expect(download.headers.get('cookie')).not.toContain('browser_only')
  })

  it('decodes nested Chinese filenames once and ignores browser query overrides', async () => {
    const fixture = gateway()
    const runtime = runtimeFor(fixture)
    const path = '/Users/远端用户/.hermes/profiles/yaoer/cache/images/三视图/角色 图.png'
    const encodedPath = path.split('/').map(encodeURIComponent).join('/')
    await request(runtime.app.callback())
      .get(`${encodedPath}?path=%2Fetc%2Fpasswd&profile=forged&token=browser-secret`)
      .set('Host', HOST).expect(200)

    expect([...fixture.downloads()[0]!.url.searchParams]).toEqual([['path', path]])
  })

  it.each(['images', 'screenshots', 'attachments'])('supports the profile %s media directory', async directory => {
    const fixture = gateway()
    const runtime = runtimeFor(fixture)
    const path = `/Users/remote/.hermes/profiles/yaoer/${directory}/nested/result.png`
    await request(runtime.app.callback()).get(path).set('Host', HOST).expect(200)
    expect(fixture.downloads()[0]!.url.searchParams.get('path')).toBe(path)
  })

  it('preserves range requests and partial image responses', async () => {
    const partial = IMAGE.subarray(2, 8)
    const fixture = gateway(() => new Response(partial, {
      status: 206,
      headers: {
        'content-type': 'image/png', 'content-disposition': 'attachment; filename="result.png"',
        'accept-ranges': 'bytes', 'content-range': `bytes 2-7/${IMAGE.length}`, 'content-length': '6',
      },
    }))
    const runtime = runtimeFor(fixture)
    const response = await request(runtime.app.callback())
      .get('/Users/samien/.hermes/profiles/yaoer/cache/images/result.png')
      .set('Host', HOST).set('Range', 'bytes=2-7').expect(206)

    expect(bodyBytes(response)).toEqual(partial)
    expect(fixture.downloads()[0]!.headers.get('range')).toBe('bytes=2-7')
    expect(response.headers['content-range']).toBe(`bytes 2-7/${IMAGE.length}`)
    expect(response.headers['accept-ranges']).toBe('bytes')
    expect(response.headers['content-disposition'] ?? '').not.toMatch(/^attachment/i)
  })

  it.each([
    '/Users/samien/.hermes/profiles/yaoer/cache/images/result.png',
    '/Users/samien/.hermes/workspace/report.md',
  ])('requires a local login before contacting Hermes: %s', async path => {
    const fixture = gateway()
    const runtime = runtimeFor(fixture, false)
    await request(runtime.app.callback())
      .get(path)
      .set('Host', HOST).expect(401)
    expect(fixture.calls).toHaveLength(0)
  })

  it.each([401, 403, 404])('preserves upstream %s without a broader file-read fallback', async status => {
    const fixture = gateway(() => Response.json({ detail: `upstream-${status}` }, { status }))
    const runtime = runtimeFor(fixture)
    const response = await request(runtime.app.callback())
      .get('/Users/samien/.hermes/profiles/yaoer/cache/images/result.png')
      .set('Host', HOST).expect(status)

    expect(response.body).toEqual({ detail: `upstream-${status}` })
    expect(fixture.downloads().length).toBeGreaterThan(0)
    expect(fixture.calls.some(call => call.url.pathname === '/api/fs/read-data-url' || call.url.pathname === '/api/media')).toBe(false)
  })

  it('keeps active content as an attachment even beneath a media directory', async () => {
    const fixture = gateway(() => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      headers: { 'content-type': 'image/svg+xml', 'content-disposition': 'inline; filename="result.svg"' },
    }))
    const runtime = runtimeFor(fixture)
    const response = await request(runtime.app.callback())
      .get('/Users/samien/.hermes/profiles/yaoer/cache/images/result.svg')
      .set('Host', HOST).expect(200)

    expect(response.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(response.headers['content-disposition']).toMatch(/^attachment/i)
    expect(response.headers['cache-control']).toContain('no-store')
  })

  it.each([
    '/Users/samien/.hermes/workspace/nested%2F..%2Fconfig.yaml',
    '/Users/samien/.hermes/workspace/result%5C.md',
    '/Users/samien/.hermes/workspace/result%00.md',
    '/Users/samien/.hermes/profiles/yaoer/config/result.png',
    '/Users/samien/.hermes/profiles/yaoer/cache/images/nested%2F..%2Fresult.png',
    '/Users/samien/.hermes/profiles/yaoer/cache/images/result%5C.png',
    '/Users/samien/.hermes/profiles/yaoer/cache/images/result%00.png',
    '/Users/samien/.hermes/profiles/yaoer%2Fother/cache/images/result.png',
    '/Users/samien%2Fother/.hermes/cache/images/result.png',
  ])('rejects unsupported directories and invalid decoded path segments: %s', async path => {
    const fixture = gateway()
    const runtime = runtimeFor(fixture)
    const response = await request(runtime.app.callback()).get(path).set('Host', HOST)
    expect([400, 404]).toContain(response.status)
    expect(fixture.calls).toHaveLength(0)
  })
})
