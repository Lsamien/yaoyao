import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { stageNpmRelease, overwriteNpmRelease } from '../bin/hermes-yaoyao-updater.mjs'
import { currentRelease, LaunchAgentService, localRequest, switchRelease } from '../bin/lib/service-update.mjs'
import { writeNpmFixture } from '../tests/fixtures/npm-release.mjs'

for (const global of [true, false]) {
  test(`real npm ${global ? 'global' : 'managed local'} updates overwrite the same installation without rollback or retained copies`, { skip: process.platform !== 'darwin', timeout: 90000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'yaoyao-npm-live-'))), home = join(root, 'data'), releaseRoot = join(root, 'programs')
    mkdirSync(home); mkdirSync(join(home, 'updates')); mkdirSync(releaseRoot)
    const prefix = global ? join(root, 'global') : join(releaseRoot, 'releases', `0.2.0-npm-${randomUUID()}`)
    const packageRoot = join(prefix, ...(global ? ['lib'] : []), 'node_modules/@lsamien/yaoyao')
    let archive
    const registry = createServer((req, res) => {
      if (req.url !== '/release.tgz') { res.statusCode = 404; res.end(); return }
      res.setHeader('Content-Length', archive.length); res.end(archive)
    })
    await new Promise(done => registry.listen(0, '127.0.0.1', done))
    const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done))
    const port = probe.address().port; await new Promise(done => probe.close(done))
    const label = `cn.samien.yaoyao.npm-test.${randomUUID()}`
    class FixtureService extends LaunchAgentService {
      verify(expected) { return super.verify(expected, expected?.version === '0.3.2' ? 1500 : 10000) }
    }
    const driver = new FixtureService({ home, releaseRoot, port, label, plistPath: join(home, 'updates/service.plist') })
    function packageJob(version, broken = false) {
      const source = join(root, `package-${version}`), target = writeNpmFixture(source, version, broken)
      if (version === '0.2.0') writeFileSync(join(source, 'old-only.txt'), 'must disappear on overwrite')
      const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: source, encoding: 'utf8' }))
      const packedPath = join(root, packed.filename)
      archive = readFileSync(packedPath)
      const npm = { version, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`, tarball: `http://127.0.0.1:${registry.address().port}/release.tgz` }
      const id = randomUUID(), jobPath = join(home, 'updates', `${id}.json`)
      const job = { id, operation: 'update', state: 'queued', target, plan: { home, releaseRoot, port, previousServiceRoot: packageRoot, source: 'npm:@lsamien/yaoyao', npm, target } }
      writeFileSync(jobPath, JSON.stringify(job))
      return { job, jobPath, packedPath }
    }
    const readVersion = () => JSON.parse(readFileSync(join(packageRoot, 'package.json'))).version
    const apply = (next, prepared) => overwriteNpmRelease({ ...next.job, plan: { ...next.job.plan, prepared } }, next.jobPath, { driver })
    try {
      const initial = packageJob('0.2.0')
      mkdirSync(prefix, { recursive: true })
      execFileSync('npm', ['install', ...(global ? ['--global'] : []), '--prefix', prefix, '--no-save', '--package-lock=false', '--no-audit', '--no-fund', '--allow-file=all', initial.packedPath], { cwd: prefix, stdio: 'pipe' })
      const unrelated = join(prefix, ...(global ? ['lib'] : []), 'node_modules/other-tool')
      if (global) {
        mkdirSync(unrelated); writeFileSync(join(unrelated, 'package.json'), '{"name":"other-tool","version":"1.0.0"}')
        writeFileSync(join(unrelated, 'keep.txt'), 'unrelated tool')
      }
      switchRelease(releaseRoot, packageRoot); await driver.start(packageRoot); await driver.verify()
      writeFileSync(join(home, 'user.txt'), 'original data')
      const oldDownload = join(home, 'updates/npm', randomUUID()); mkdirSync(oldDownload, { recursive: true }); writeFileSync(join(oldDownload, 'release.tgz'), 'obsolete download')
      for (const version of ['0.3.0', '0.3.1']) {
        const next = packageJob(version), previousVersion = readVersion(), previousPID = driver.pid()
        const prepared = await stageNpmRelease(next.job, next.jobPath)
        assert.equal(JSON.parse(readFileSync(next.jobPath)).state, 'prepared')
        assert.equal(driver.pid(), previousPID, 'download must leave the old service running')
        assert.equal(readVersion(), previousVersion)
        assert.equal(readdirSync(join(home, 'updates/npm')).length, 1, 'keep only the current temporary archive')
        await apply(next, prepared)
        assert.notEqual(driver.pid(), previousPID)
        assert.equal(currentRelease(releaseRoot), packageRoot, 'reuse the same installation path')
        assert.equal((await localRequest(`http://127.0.0.1:${port}/api/status`)).body.version, version)
        assert.equal(readFileSync(join(home, 'user.txt'), 'utf8'), 'original data')
        assert.equal(existsSync(join(packageRoot, 'old-only.txt')), false, 'remove obsolete program files')
        assert.deepEqual(readdirSync(join(home, 'updates/npm')), [], 'clean the downloaded archive')
        assert.equal(existsSync(join(home, 'updates/backups')), false)
        assert.equal(existsSync(join(home, 'updates/last-success.json')), false)
        assert.equal(existsSync(join(home, 'updates/transition.json')), false)
        if (global) assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'unrelated tool')
        assert.equal(global ? existsSync(join(releaseRoot, 'releases')) : readdirSync(join(releaseRoot, 'releases')).length > 1, false, 'do not create additional release directories')
      }

      const broken = packageJob('0.3.2', true), healthyPID = driver.pid()
      const bad = await stageNpmRelease(broken.job, broken.jobPath)
      assert.equal(driver.pid(), healthyPID)
      await assert.rejects(apply(broken, bad), /未保留旧版本/)
      assert.equal(currentRelease(releaseRoot), packageRoot)
      assert.equal(readVersion(), '0.3.2', 'a failed health check must not restore old code')
      assert.equal((await localRequest(`http://127.0.0.1:${port}/api/status`)).body.version, '0.3.2')
      assert.equal(readFileSync(join(home, 'user.txt'), 'utf8'), 'failed update', 'do not restore an old data snapshot')
      assert.equal(existsSync(join(home, 'updates/backups')), false)
      assert.deepEqual(readdirSync(join(home, 'updates/npm')), [])

      const invalid = packageJob('0.3.3'), survivingPID = driver.pid()
      invalid.job.plan.npm.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
      await assert.rejects(stageNpmRelease(invalid.job, invalid.jobPath), /完整性校验失败/)
      assert.equal(driver.pid(), survivingPID)
      assert.equal(readVersion(), '0.3.2')
      assert.deepEqual(readdirSync(join(home, 'updates/npm')), [])
      console.log(`Verified ${global ? 'global' : 'managed local'} npm overwrite, repeat updates, archive cleanup and failed startup without rollback in an isolated LaunchAgent.`)
    } finally {
      await driver.stop().catch(() => {})
      await new Promise(done => { registry.close(done); registry.closeAllConnections() })
      rmSync(root, { recursive: true, force: true })
    }
  })
}
