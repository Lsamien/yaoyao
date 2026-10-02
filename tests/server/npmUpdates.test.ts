// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { SystemUpdateManager } from '../../src/server/updateManager.js'
import { loadServerConfig } from '../../src/server/config.js'
import { NPM_RELEASE_SOURCE, npmInstallationLocation, parseNpmRelease } from '../../bin/lib/npm-release.mjs'
import { writeNpmFixture } from '../fixtures/npm-release.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const archive = Buffer.from('fixture npm archive')
const npm = { version: '0.3.0', integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`, tarball: 'https://registry.npmjs.org/fixture.tgz' }
const target = { schemaVersion: 1 as const, releaseVersion: npm.version, webVersion: npm.version, gitTag: `v${npm.version}` }

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yaoyao-npm-manager-'))); roots.push(root)
  const projectRoot = join(root, 'global/lib/node_modules/@lsamien/yaoyao')
  writeNpmFixture(projectRoot, '0.2.0')
  const config = loadServerConfig({ HERMES_YAOYAO_HOME: join(root, 'data'), HERMES_YAOYAO_RELEASE_ROOT: join(root, 'programs') })
  const launchUpdater = vi.fn(), inspectRemote = vi.fn(async () => ({ npm, manifest: target }))
  const options = { projectRoot, platform: 'darwin' as const, launchUpdater, inspectRemote }
  const manager = new SystemUpdateManager(config, options)
  return { root, manager, config, options, launchUpdater, inspectRemote }
}

it('detects npm installs and queues an integrity-pinned download without activating', async () => {
  const f = fixture()
  expect(await f.manager.check()).toMatchObject({ installationMode: 'npm', updateMethod: 'npm', releaseSource: NPM_RELEASE_SOURCE, updateAvailable: true })
  const job = await f.manager.startUpdate(npm.version)
  const stored = JSON.parse(readFileSync(f.launchUpdater.mock.calls[0][0], 'utf8'))
  expect(stored.plan.npm).toEqual(npm)
  expect(stored.plan.prepared).toBeUndefined()
  expect(f.manager.job(job.id)).not.toHaveProperty('plan')
  expect(() => f.manager.startActivation(job.id)).toThrow('没有可生效')
  expect(f.launchUpdater).toHaveBeenCalledTimes(1)
})

it('restores a prepared update after manager recreation and activates offline only after an explicit request', async () => {
  const f = fixture(), job = await f.manager.startUpdate(npm.version)
  const path = f.launchUpdater.mock.calls[0][0], stored = JSON.parse(readFileSync(path, 'utf8'))
  const prepared = { archive: join(f.config.home, 'updates/npm', job.id, 'release.tgz') }
  mkdirSync(join(prepared.archive, '..'), { recursive: true }); writeFileSync(prepared.archive, archive)
  writeFileSync(path, JSON.stringify({ ...stored, state: 'prepared', plan: { ...stored.plan, prepared } }))
  rmSync(join(f.config.home, 'updates/active.lock'))
  f.inspectRemote.mockRejectedValue(new Error('npm offline'))
  const resumed = new SystemUpdateManager(f.config, f.options)
  expect(resumed.status().job?.state).toBe('prepared')
  expect(() => resumed.startActivation('wrong-job')).toThrow('没有可生效')
  const activate = resumed.startActivation(job.id)
  expect(activate.state).toBe('queued')
  const activationPlan = JSON.parse(readFileSync(f.launchUpdater.mock.calls[1][0], 'utf8')).plan
  expect(activationPlan.prepared).toEqual(prepared)
  expect(f.inspectRemote).toHaveBeenCalledTimes(1)
  expect(() => resumed.startActivation(job.id)).toThrow('没有可生效')
})

it('rejects a changed downloaded archive and retains explicit Git sources for npm installs', async () => {
  const f = fixture(), job = await f.manager.startUpdate(npm.version)
  const path = f.launchUpdater.mock.calls[0][0], stored = JSON.parse(readFileSync(path, 'utf8'))
  const prepared = { archive: join(f.config.home, 'updates/npm', job.id, 'release.tgz') }
  mkdirSync(join(prepared.archive, '..'), { recursive: true }); writeFileSync(prepared.archive, archive)
  writeFileSync(path, JSON.stringify({ ...stored, state: 'prepared', plan: { ...stored.plan, prepared } }))
  rmSync(join(f.config.home, 'updates/active.lock'))
  writeFileSync(prepared.archive, 'changed after verification')
  expect(() => f.manager.startActivation(job.id)).toThrow('文件已改变')
  expect(f.manager.status().job?.state).toBe('failed')
  expect(f.launchUpdater).toHaveBeenCalledTimes(1)
  const git = new SystemUpdateManager({ ...f.config, releaseSource: 'https://example.test/private.git' }, f.options)
  expect(git.status()).toMatchObject({ installationMode: 'source', updateMethod: 'git', releaseSource: 'https://example.test/private.git' })
})

it('disables npm rollback even with a legacy record and limits overwrites to npm installation layouts', () => {
  const f = fixture()
  mkdirSync(join(f.config.home, 'updates'), { recursive: true })
  writeFileSync(join(f.config.home, 'updates/last-success.json'), '{}')
  expect(f.manager.status().canRollback).toBe(false)
  expect(() => f.manager.startRollback()).toThrow('不支持回滚')
  expect(npmInstallationLocation(f.options.projectRoot)).toEqual({ prefix: join(f.root, 'global'), global: true })
  const local = join(f.root, 'local/node_modules/@lsamien/yaoyao')
  writeNpmFixture(local, '0.2.0')
  expect(npmInstallationLocation(local)).toEqual({ prefix: join(f.root, 'local'), global: false })
  const source = join(f.root, 'source'); writeNpmFixture(source, '0.2.0')
  expect(() => npmInstallationLocation(source)).toThrow('npm 安装目录')
})

it('validates npm metadata and restricts configured npm sources to the official package', () => {
  const value = { name: '@lsamien/yaoyao', version: npm.version, dist: npm }
  expect(parseNpmRelease(value)).toEqual(npm)
  expect(() => parseNpmRelease({ ...value, name: 'other-package' })).toThrow('名称或版本')
  expect(() => parseNpmRelease({ ...value, dist: { ...npm, integrity: 'sha1-weak' } })).toThrow('SHA-512')
  expect(loadServerConfig({ HERMES_YAOYAO_RELEASE_SOURCE: NPM_RELEASE_SOURCE }).releaseSource).toBe(NPM_RELEASE_SOURCE)
  expect(() => loadServerConfig({ HERMES_YAOYAO_RELEASE_SOURCE: 'npm:other-package' })).toThrow()
})
