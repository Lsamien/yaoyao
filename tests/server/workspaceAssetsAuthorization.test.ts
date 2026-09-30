// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Koa from 'koa'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceAssets, type StoredWorkspaceFile } from '../../src/server/workspaceAssets'
import { WorkspaceStore } from '../../src/server/workspaceStore'
import { workspaceRouter } from '../../src/server/workspaceRoutes'
import { saveFileAccess } from '../../src/server/fileAccess'
import { HttpError } from '../../src/server/errors'
import type { WorkspaceNodes } from '../../src/server/workspaceGateway'
import type { WorkspaceRuntime } from '../../src/server/workspaceRuntime'
import type { UploadStore } from '../../src/server/uploads'
import type { LocalAuthStore } from '../../src/server/localAuth'
import type { PushCoordinator } from '../../src/server/pushCoordinator'

const fixtures: Array<{ home: string; store: WorkspaceStore; assets: WorkspaceAssets }> = []
afterEach(() => {
  for (const { home, store, assets } of fixtures.splice(0)) {
    assets.close(); store.close(); rmSync(home, { recursive: true, force: true })
  }
})
const response = (value: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(value)), headers: new Headers() })
const downloaded = () => ({ status: 200, body: Buffer.from('fixture-report'), headers: new Headers({ 'content-type': 'text/plain' }) })
const keyFor = (nodeId: string) => createHash('sha256').update(JSON.stringify([nodeId, 'alpha', 'message', '/remote/work/report.txt'])).digest('hex')
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-assets-auth-')), store = new WorkspaceStore(home)
  let allowed = true
  const request = vi.fn(async (route: string, options: { search?: URLSearchParams }) => {
    if (route === '/api/config') return response({ terminal: { cwd: '/remote/work' } })
    if (route === '/api/files') {
      const path = options.search!.get('path')!
      return response({ path, entries: [{ name: 'report.txt', path: path + '/report.txt' }, { name: 'escape.txt', path: '/private/escape.txt' }] })
    }
    if (route === '/api/files/download') return downloaded()
    throw new Error('Unexpected mocked request: ' + route)
  })
  const requireSource = vi.fn((owner: string, _source: { nodeId: string; profile: string }) => {
    if (owner !== 'owner' || !allowed) throw new HttpError(403, 'Fixture source revoked', 'agent_source_forbidden')
  })
  const nodes = { requireSource, target: () => ({ session: { request } }) } as unknown as WorkspaceNodes
  const assets = new WorkspaceAssets(store, nodes, home)
  const router = workspaceRouter(store, {} as WorkspaceRuntime, nodes, assets, {} as UploadStore,
    { require: () => ({ id: 'owner' }) } as LocalAuthStore, {} as PushCoordinator)
  const handler = router.stack.find(layer => layer.path === '/api/app/files/:id/download')!.stack[0]!
  const download = async (id: string) => {
    const ctx = { params: { id }, get: () => '', set() {} } as unknown as Koa.Context
    await handler(ctx, async () => {})
    const bytes: Buffer[] = []
    for await (const chunk of ctx.body as NodeJS.ReadableStream) bytes.push(Buffer.from(chunk))
    return Buffer.concat(bytes).toString()
  }
  fixtures.push({ home, store, assets })
  return { home, store, assets, request, requireSource, download, revoke: () => { allowed = false },
    files: () => store.list<StoredWorkspaceFile>('owner', 'file'),
    archive: (path = '/remote/work/report.txt', messageId = 'message') =>
      assets.archiveText('owner', `[report](${path})`, 'local', 'alpha', 'conversation', messageId) }
}

it('archives authorized references with their source and checks it for UUID and library-row downloads', async () => {
  const f = fixture()
  await f.archive()
  const file = f.files()[0]!
  expect(file).toMatchObject({ sourceNodeId: 'local', profile: 'alpha', sourcePath: '/remote/work/report.txt' })
  expect(await f.download(file.id)).toBe('fixture-report')
  const row = f.store.db.prepare("SELECT rowid AS n FROM workspace_entities WHERE owner='owner' AND kind='file' AND id=?").get(file.id)!
  f.revoke()
  for (const id of [file.id, String(row.n)]) await expect(f.download(id)).rejects.toMatchObject({ status: 403, code: 'agent_source_forbidden' })
})

it('refuses directory and symlink escapes before making a download request', async () => {
  const f = fixture()
  await f.archive('/outside/report.txt')
  await f.archive('/remote/work/escape.txt')
  expect(f.request.mock.calls.some(([route]) => route === '/api/files/download')).toBe(false)
  expect(f.files()).toEqual([])
  expect(existsSync(join(f.home, 'workspace-files'))).toBe(false)
})

it('refuses an unassigned source before any upstream request', async () => {
  const f = fixture(); f.revoke()
  await f.archive()
  expect(f.request).not.toHaveBeenCalled()
  expect(f.files()).toEqual([])
})

it.each(['source', 'directory', 'quota'] as const)('does not persist bytes if %s authorization changes during a download', async change => {
  const f = fixture()
  saveFileAccess(f.home, { mode: 'folders', folders: ['/extra'] })
  let finish!: (value: ReturnType<typeof downloaded>) => void
  let started!: () => void
  const pending = new Promise<ReturnType<typeof downloaded>>(resolve => { finish = resolve })
  const downloading = new Promise<void>(resolve => { started = resolve })
  const original = f.request.getMockImplementation()!
  f.request.mockImplementation((route, options) => {
    if (route === '/api/files/download') { started(); return pending }
    return original(route, options)
  })
  const archive = f.archive('/extra/report.txt')
  await downloading
  if (change === 'source') f.revoke()
  else if (change === 'directory') saveFileAccess(f.home, { mode: 'folders', folders: [] })
  else f.store.put('owner', 'file', 'full-quota', { id: 'full-quota', size: 2 * 1024 * 1024 * 1024 })
  finish(downloaded()); await archive
  expect(f.files()).toHaveLength(change === 'quota' ? 1 : 0)
  expect(existsSync(join(f.home, 'workspace-files'))).toBe(false)
  expect(f.store.list('owner', 'archived-path')).toEqual([])
})

it.each(['quota', 'message-files'] as const)('enforces the existing %s limit for automatic archives', async limit => {
  const f = fixture()
  for (let i = 0; i < (limit === 'quota' ? 1 : 8); i++)
    f.store.put('owner', 'file', `existing-${i}`, { id: `existing-${i}`, messageId: limit === 'quota' ? 'older-message' : 'message', size: limit === 'quota' ? 2 * 1024 * 1024 * 1024 : 1 })
  await f.archive()
  expect(f.files()).toHaveLength(limit === 'quota' ? 1 : 8)
  expect(existsSync(join(f.home, 'workspace-files'))).toBe(false)
})

it('recovers a uniquely authorized legacy source from its archive key without downloading again', async () => {
  const f = fixture(); await f.archive()
  const file = f.files()[0]!
  delete file.sourceNodeId; f.store.put('owner', 'file', file.id, file)
  f.request.mockClear()
  expect(await f.download(file.id)).toBe('fixture-report')
  expect(f.files()[0]!.sourceNodeId).toBe('local')
  expect(f.request).not.toHaveBeenCalled()
})

it.each(['unknown', 'ambiguous', 'ambiguous-revoked', 'duplicate-record', 'revoked'] as const)('denies a %s legacy archive instead of guessing its source', async reason => {
  const f = fixture(); await f.archive()
  const file = f.files()[0]!
  delete file.sourceNodeId; f.store.put('owner', 'file', file.id, file)
  if (reason === 'unknown') f.store.remove('owner', 'archived-path', keyFor('local'))
  if (reason === 'ambiguous' || reason === 'ambiguous-revoked') {
    f.store.put('owner', 'node', 'other-node', { id: 'other-node' })
    f.store.put('owner', 'archived-path', keyFor('other-node'), true)
    if (reason === 'ambiguous-revoked') f.requireSource.mockImplementation((owner, source: { nodeId: string }) => {
      if (owner !== 'owner' || source.nodeId !== 'local') throw new HttpError(403, 'Fixture source revoked', 'agent_source_forbidden')
    })
  }
  if (reason === 'duplicate-record') f.store.put('owner', 'file', 'duplicate', { ...file, id: 'duplicate' })
  if (reason === 'revoked') f.revoke()
  f.request.mockClear()
  await expect(f.download(file.id)).rejects.toMatchObject({ status: 403, code: 'archived_file_source_unknown' })
  expect(f.files()[0]!.sourceNodeId).toBeUndefined()
  expect(f.request).not.toHaveBeenCalled()
})
