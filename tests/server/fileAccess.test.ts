// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeFileRead, readFileAccess, saveFileAccess } from '../../src/server/fileAccess'
import { isSupportedFilePath, serverFilePath, serverFileUrl } from '../../src/shared/serverFiles'
import type { ServerConfig } from '../../src/server/config'
import type { UpstreamServiceSession } from '../../src/server/localAuth'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })))
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'file-access-')); homes.push(home)
  const cwd = { alpha: '/remote/work', beta: '/other/work' } as Record<string, string>
  const request = vi.fn(async (path: string, options: {search: URLSearchParams}) => {
    const folder = options.search.get('path') || '', profile = options.search.get('profile') || 'alpha'
    const canonical = folder === '/tmp' ? '/private/tmp' : folder
    const value = path === '/api/config' ? { terminal: { cwd: cwd[profile] } }
      : { path: canonical, entries: [{ name: 'hello.png', path: canonical + '/hello.png' }, { name: 'escape.png', path: '/secrets/escape.png' }] }
    return { status: 200, headers: new Headers(), body: Buffer.from(JSON.stringify(value)) }
  })
  return { home, cwd, request, upstream: { request } as unknown as UpstreamServiceSession,
    config: { home, upstream: new URL('http://127.0.0.1:9119') } as ServerConfig }
}
describe('server-owned file permissions', () => {
  it('defaults to cwd only and keeps cwd authorized when extra folders are configured', async () => {
    const f = fixture()
    expect(readFileAccess(f.home)).toEqual({ mode: 'folders', folders: [] })
    expect(await authorizeFileRead(f.config, f.upstream, '/remote/work/hello.png', 'alpha')).toBe('/remote/work/hello.png')
    expect(await authorizeFileRead(f.config, f.upstream, '/remote/work', 'alpha', true)).toBe('/remote/work')
    await expect(authorizeFileRead(f.config, f.upstream, '/tmp/hello.png', 'alpha')).rejects.toMatchObject({ status: 403 })
    saveFileAccess(f.home, { mode: 'folders', folders: ['/tmp'] })
    expect(await authorizeFileRead(f.config, f.upstream, '/remote/work/hello.png', 'alpha')).toBe('/remote/work/hello.png')
    expect(await authorizeFileRead(f.config, f.upstream, '/tmp/hello.png', 'alpha')).toBe('/private/tmp/hello.png')
  })
  it('uses each profile cwd, follows changed server config, and never uses the Web process cwd', async () => {
    const f = fixture()
    await expect(authorizeFileRead(f.config, f.upstream, '/remote/work/hello.png', 'beta')).rejects.toMatchObject({ status: 403 })
    f.cwd.alpha = '/new/work'
    await expect(authorizeFileRead(f.config, f.upstream, '/remote/work/hello.png', 'alpha')).rejects.toMatchObject({ status: 403 })
    expect(await authorizeFileRead(f.config, f.upstream, '/new/work/hello.png', 'alpha')).toBe('/new/work/hello.png')
  })
  it('persists global authorization, allows arbitrary directories only when enabled, and applies revocation immediately', async () => {
    const f = fixture()
    saveFileAccess(f.home, { mode: 'all', folders: [] })
    expect(readFileAccess(f.home).mode).toBe('all')
    expect(await authorizeFileRead(f.config, f.upstream, '/anything/hello.png', 'alpha')).toBe('/anything/hello.png')
    expect(f.request).not.toHaveBeenCalled()
    saveFileAccess(f.home, { mode: 'folders', folders: [] })
    await expect(authorizeFileRead(f.config, f.upstream, '/anything/hello.png', 'alpha')).rejects.toMatchObject({ status: 403 })
  })
  it('rejects symlink escapes and path traversal', async () => {
    const f = fixture()
    await expect(authorizeFileRead(f.config, f.upstream, '/remote/work/escape.png', 'alpha')).rejects.toMatchObject({ status: 403 })
    expect(() => saveFileAccess(f.home, { mode: 'folders', folders: ['/work/../secret'] })).toThrow()
    for (const path of ['/a/../secret', '//host/file', '/a/%2e%2e/file', 'file://remote/tmp/a.png']) expect(serverFilePath(path)).toBeUndefined()
  })
  it('resolves relative cwd on Hermes instead of the Web host', async () => {
    const f = fixture(); f.cwd.alpha = '.'
    f.request.mockImplementation(async (path, options) => ({ status: 200, headers: new Headers(), body: Buffer.from(JSON.stringify(
      path === '/api/config' ? { terminal: { cwd: '.' } } : path === '/api/fs/default-cwd' ? { cwd: '/remote/work' }
        : { path: options.search.get('path'), entries: [{ name: 'hello.png', path: '/remote/work/hello.png' }] },
    )) }))
    expect(await authorizeFileRead(f.config, f.upstream, '/remote/work/hello.png', 'alpha')).toBe('/remote/work/hello.png')
  })
  it('routes all absolute server reference forms with profile and filename escaping', () => {
    for (const path of ['/tmp/hello%20world.png', 'sandbox:/tmp/hello%20world.png', 'file:///tmp/hello%20world.png']) {
      const url = new URL(serverFileUrl(path, 'beta')!, 'https://web.test')
      expect(url.pathname).toBe('/api/files/download')
      expect(url.searchParams.get('path')).toBe('/tmp/hello world.png')
      expect(url.searchParams.get('profile')).toBe('beta')
    }
    expect(serverFileUrl('/api/app/files/id/preview')).toBeUndefined()
    expect(serverFileUrl('/files/report.pdf')).toBeUndefined()
    expect(serverFileUrl('/history/report.pdf')).toBeUndefined()
    expect(serverFileUrl('https://example.com/a.png')).toBeUndefined()
    expect(serverFilePath('/tmp/100%25.png', false)).toBe('/tmp/100%25.png')
    expect(isSupportedFilePath('/tmp/report.docx')).toBe(true)
    expect(isSupportedFilePath('/tmp/no-extension')).toBe(false)
    expect(isSupportedFilePath('/tmp/archive.exe')).toBe(false)
  })
})
