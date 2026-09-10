import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../../src/server/config.js'
import { compareReleaseVersions, parseReleaseManifest } from '../../src/server/releases.js'
import { inspectGitRemote, releaseManifestURL, SystemUpdateManager } from '../../src/server/updateManager.js'

const roots: string[] = []
const current = {
  schemaVersion: 1 as const,
  releaseVersion: '0.2.0',
  webVersion: '0.2.0',
  gitTag: 'v0.2.0',
}
const latest = {
  schemaVersion: 1 as const,
  releaseVersion: '0.3.0',
  webVersion: '0.3.0',
  gitTag: 'v0.3.0',
}
const latestRemote = { manifest: latest, commit: 'a'.repeat(40) }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-update-manager-'))
  roots.push(root)
  writeFileSync(join(root, 'release.json'), JSON.stringify(current))
  const config: ServerConfig = {
    host: '127.0.0.1', port: 15300, upstream: new URL('http://127.0.0.1:9119'),
    allowedHosts: new Set(), home: join(root, 'data'), mediaRoot: join(root, 'media'),
    attachmentsRoot: join(root, 'attachments'), imagesRoot: join(root, 'images'),
    mediaOwner: 'tester', allowInsecureLan: false, insecureLan: false, production: false,
    releaseRoot: join(root, 'installed'), releaseSource: 'https://example.test/hermes-yaoyao.git',
  }
  const launched: string[] = []
  const manager = new SystemUpdateManager(config, {
    projectRoot: root,
    inspectRemote: async () => latestRemote,
    launchUpdater: path => { launched.push(path) },
    platform: 'darwin',
  })
  return { root, config, manager, launched }
}

describe('system release contract', () => {
  it('keeps packaged App updates outside the source service updater', async () => {
    const {root,config}=fixture()
    let inspected=false,launched=false
    const manager=new SystemUpdateManager(config,{projectRoot:root,platform:'darwin',desktopOwned:true,inspectRemote:async()=>{inspected=true;return latestRemote},launchUpdater:()=>{launched=true}})
    expect(await manager.check()).toMatchObject({installationMode:'desktop',supported:false,canRollback:false})
    await expect(manager.startUpdate(latest.releaseVersion)).rejects.toThrow('App')
    expect(()=>manager.startRollback()).toThrow('App')
    expect(inspected).toBe(false);expect(launched).toBe(false)
  })

  it('maps an HTTPS Git source to the lightweight tagged release manifest', () => {
    expect(releaseManifestURL(
      'https://git.samien.cn/samien/hermes-yaoyao.git',
      'v0.2.1',
    )?.href).toBe('https://git.samien.cn/samien/hermes-yaoyao/raw/v0.2.1/release.json')
    expect(releaseManifestURL('/srv/git/hermes-yaoyao.git', 'v0.2.1')).toBeUndefined()
  })

  it('validates Web versions and semantic ordering', () => {
    expect(parseReleaseManifest(current)).toEqual(current)
    expect(compareReleaseVersions('0.3.0', '0.2.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0)
    expect(parseReleaseManifest(current)).not.toHaveProperty('pluginVersion')
  })

  it('locks an annotated remote tag to its peeled Git commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-update-remote-'))
    roots.push(root)
    const repository = join(root, 'repository')
    execFileSync('git', ['init', '-q', repository])
    writeFileSync(join(repository, 'release.json'), JSON.stringify(latest))
    execFileSync('git', ['-C', repository, 'add', 'release.json'])
    execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'release'])
    execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'tag', '-am', 'release', 'v0.3.0'])
    const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    await expect(inspectGitRemote(repository, current)).resolves.toEqual({ manifest: latest, commit })
  })
})

describe('SystemUpdateManager', () => {
  it('keeps old completed job history without showing it as the current upgrade', async () => {
    const { manager, launched, root } = fixture()
    const job = await manager.startUpdate(latest.releaseVersion)
    const stored = JSON.parse(readFileSync(launched[0]!, 'utf8'))
    writeFileSync(launched[0]!, JSON.stringify({ ...stored, state: 'succeeded', message: '已升级 Web 0.3.0' }))
    expect(manager.status().job).toBeUndefined()
    expect(manager.job(job.id)?.state).toBe('succeeded')
    writeFileSync(join(root, 'release.json'), JSON.stringify(latest))
    expect(manager.status().job?.id).toBe(job.id)
  })
  it('uses the migrated source and compares versions rather than mirror commit identities', async () => {
    const { root, config } = fixture()
    let sourceSeen = ''
    const manager = new SystemUpdateManager({ ...config, releaseSource: 'https://git.samien.cn/samien/hermes-yaoyao.git' }, {
      projectRoot: root, platform: 'darwin', inspectRemote: async source => {
        sourceSeen = source; return { manifest: current, commit: 'd'.repeat(40) }
      },
    })
    expect(await manager.check()).toMatchObject({ updateAvailable: false, releaseSource: 'https://github.com/Lsamien/yaoyao.git' })
    expect(sourceSeen).toBe('https://github.com/Lsamien/yaoyao.git')
    await expect(manager.startUpdate(current.releaseVersion)).rejects.toThrow('最新版本')
  })
  it('reports the current Web release and discovers a newer fixed release', async () => {
    const { manager } = fixture()
    const status = await manager.check()

    expect(status.current).toEqual(current)
    expect(status.latest).toEqual(latest)
    expect(status.updateAvailable).toBe(true)
    expect(status).not.toHaveProperty('installedPluginVersion')
    expect(status.installationMode).toBe('source')
  })

  it('creates a durable updater job without exposing its internal plan', async () => {
    const { manager, launched } = fixture()
    const job = await manager.startUpdate('0.3.0')

    expect(job).toMatchObject({ operation: 'update', state: 'queued', target: latest })
    expect(launched).toHaveLength(1)
    expect(existsSync(launched[0]!)).toBe(true)
    const stored = JSON.parse(readFileSync(launched[0]!, 'utf8')) as Record<string, unknown>
    expect(stored.plan).toBeTruthy()
    expect(manager.job(job.id)).not.toHaveProperty('plan')
    await expect(manager.startUpdate('0.3.0')).rejects.toThrow('正在执行')
  })

  it('rejects arbitrary target versions and rollback without a recovery record', async () => {
    const { manager } = fixture()

    await expect(manager.startUpdate('9.9.9')).rejects.toThrow('不是当前发布源')
    expect(() => manager.startRollback()).toThrow('没有可回滚')
  })
})
