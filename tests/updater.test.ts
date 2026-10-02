import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchAgentPlist } from '../bin/hermes-yaoyao.mjs'
import {
  currentTarget,
  formatCommandFailure,
  overwriteNpmRelease,
  restorePreviousService,
  serviceInstallInvocation,
  switchCurrent,
  validateManifest,
  verifyRuntime,
} from '../bin/hermes-yaoyao-updater.mjs'
import { writeNpmFixture } from './fixtures/npm-release.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('standalone updater primitives', () => {
  it.each([true, false])('protects data inside the npm installation and never restarts an old version after an overwrite failure (nested data: %s)', async (nestedData) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'npm-overwrite-'))); roots.push(root)
    const packageRoot = join(root, 'node_modules/@lsamien/yaoyao')
    writeNpmFixture(packageRoot, '0.2.0')
    const home = nestedData ? join(packageRoot, 'data') : join(root, 'data'), id = randomUUID()
    const archive = join(home, 'updates/npm', id, 'release.tgz'), contents = Buffer.from('verified archive')
    mkdirSync(join(archive, '..'), { recursive: true }); writeFileSync(archive, contents)
    writeFileSync(join(home, 'user.txt'), 'user data')
    const target = { schemaVersion: 1, releaseVersion: '0.3.0', webVersion: '0.3.0', gitTag: 'v0.3.0' }
    const job = { id, target, plan: { home, releaseRoot: join(root, 'releases'), previousServiceRoot: packageRoot, prepared: { archive },
      npm: { version: '0.3.0', integrity: `sha512-${createHash('sha512').update(contents).digest('base64')}`, tarball: 'https://example.test/release.tgz' } } }
    const jobPath = join(home, 'updates', `${id}.json`); writeFileSync(jobPath, JSON.stringify(job))
    const driver = { snapshot: () => ({ root: packageRoot, wasRunning: false }), quiesce: vi.fn(), stop: vi.fn(), resume: vi.fn(), start: vi.fn(), restore: vi.fn() }
    const install = vi.fn(async () => { writeFileSync(join(packageRoot, 'dist/index.html'), 'partly overwritten'); throw new Error('installation failed') })
    await expect(overwriteNpmRelease(job, jobPath, { driver, install })).rejects.toThrow(nestedData ? '用户数据目录' : '未保留旧版本')
    expect(readFileSync(join(home, 'user.txt'), 'utf8')).toBe('user data')
    expect(driver.start).not.toHaveBeenCalled(); expect(driver.restore).not.toHaveBeenCalled(); expect(driver.resume).not.toHaveBeenCalled()
    expect(install).toHaveBeenCalledTimes(nestedData ? 0 : 1)
    expect(driver.stop).toHaveBeenCalledTimes(nestedData ? 0 : 1)
    expect(existsSync(archive)).toBe(false)
  })

  it('accepts a healthy Web without probing 9119 or upstream-dependent readiness', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url !== 'http://127.0.0.1:15300/healthz') throw new Error('9119 offline')
      return Response.json({ ok: true })
    })
    await verifyRuntime(1_000, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:15300/healthz')
  })

  it('still fails an unhealthy Web and retries transient startup failures', async () => {
    vi.useFakeTimers()
    try {
      const unhealthy = vi.fn(async () => Response.json({ ok: false }))
      const check = expect(verifyRuntime(1_000, unhealthy)).rejects.toThrow('升级后健康检查失败')
      await vi.advanceTimersByTimeAsync(1_000)
      await check
      const recovering = vi.fn().mockRejectedValueOnce(new Error('starting'))
        .mockResolvedValueOnce(Response.json({ ok: true }))
      const recovered = verifyRuntime(1_000, recovering)
      await vi.advanceTimersByTimeAsync(500)
      await recovered
      expect(recovering).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('atomically switches the stable current symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-updater-'))
    roots.push(root)
    const first = join(root, 'releases', '0.2.0-a')
    const second = join(root, 'releases', '0.3.0-b')
    switchCurrent(root, first, 'first')
    expect(currentTarget(root)).toBe(first)
    switchCurrent(root, second, 'second')
    expect(currentTarget(root)).toBe(second)
    expect(lstatSync(join(root, 'current')).isSymbolicLink()).toBe(true)
  })

  it('rejects a mismatched release manifest before any service transition', () => {
    expect(() => validateManifest({
      schemaVersion: 1,
      releaseVersion: '0.3.0',
      webVersion: '0.3.1',
      gitTag: 'v0.3.0',
    })).toThrow('版本组合不一致')
  })

  it('keeps useful command output while redacting credentials', () => {
    const error = Object.assign(new Error('Command failed'), {
      status: 127,
      stdout: '\u001B[31m发布版本校验通过\u001B[0m',
      stderr: 'https://secret@example.test/release.git\nsh: vue-tsc: command not found',
    })

    const message = formatCommandFailure('npm', ['run', 'build'], error)
    expect(message).toContain('npm run build 失败，退出码 127')
    expect(message).toContain('发布版本校验通过')
    expect(message).toContain('https://***@example.test/release.git')
    expect(message).toContain('vue-tsc: command not found')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('\u001B')
  })

  it('uses the new lifecycle code while starting a rolled-back release', () => {
    const releaseRoot = '/Users/test/.local/share/hermes-yaoyao'
    const oldRelease = join(releaseRoot, 'releases', '0.2.11-old')
    const newRelease = join(releaseRoot, 'releases', '0.2.12-new')
    const invocation = serviceInstallInvocation(
      oldRelease,
      { releaseRoot, source: 'https://example.test/hermes-yaoyao.git' },
      true,
      newRelease,
    )

    expect(invocation.cli).toBe(join(newRelease, 'bin', 'hermes-yaoyao.mjs'))
    expect(invocation.env.HERMES_YAOYAO_SERVICE_ROOT).toBe(join(releaseRoot, 'current'))
    expect(invocation.env.HERMES_YAOYAO_RELEASE_SOURCE).toBe('https://example.test/hermes-yaoyao.git')
    expect(invocation.env.HERMES_YAOYAO_HOST).toBe('0.0.0.0')
    expect(invocation.env.HERMES_YAOYAO_ALLOW_INSECURE_LAN).toBe('1')

    const sourceRollback = serviceInstallInvocation(
      oldRelease,
      { releaseRoot, source: 'https://example.test/hermes-yaoyao.git' },
      false,
      newRelease,
    )
    expect(sourceRollback.cli).toBe(join(newRelease, 'bin', 'hermes-yaoyao.mjs'))
    expect(sourceRollback.env.HERMES_YAOYAO_SERVICE_ROOT).toBe(oldRelease)
    const rollbackPlist = launchAgentPlist({ serviceRoot: sourceRollback.env.HERMES_YAOYAO_SERVICE_ROOT })
    expect(rollbackPlist).toContain(`<string>${join(oldRelease, 'dist-server', 'server', 'index.js')}</string>`)
    expect(rollbackPlist).toContain(`<key>WorkingDirectory</key><string>${oldRelease}</string>`)
  })

  it('routes release and source rollbacks through the new lifecycle root', () => {
    const plan = {
      releaseRoot: '/Users/test/.local/share/hermes-yaoyao',
      source: 'https://example.test/hermes-yaoyao.git',
    }
    const lifecycleRoot = join(plan.releaseRoot, 'releases', '0.2.12-new')
    const previousRelease = join(plan.releaseRoot, 'releases', '0.2.11-old')
    const previousSource = '/Users/test/git/hermes-yaoyao'
    const switchCurrentCommand = vi.fn()
    const removeCurrentCommand = vi.fn()
    const startServiceCommand = vi.fn()

    restorePreviousService({
      plan,
      previousCurrentTarget: previousRelease,
      previousServiceRoot: previousSource,
      lifecycleRoot,
      token: 'release-rollback',
      switchCurrentCommand,
      removeCurrentCommand,
      startServiceCommand,
    })
    expect(switchCurrentCommand).toHaveBeenCalledWith(plan.releaseRoot, previousRelease, 'release-rollback')
    expect(removeCurrentCommand).not.toHaveBeenCalled()
    expect(startServiceCommand).toHaveBeenCalledWith(
      join(plan.releaseRoot, 'current'), plan, true, lifecycleRoot,
    )

    switchCurrentCommand.mockClear()
    startServiceCommand.mockClear()
    restorePreviousService({
      plan,
      previousCurrentTarget: undefined,
      previousServiceRoot: previousSource,
      lifecycleRoot,
      token: 'source-rollback',
      switchCurrentCommand,
      removeCurrentCommand,
      startServiceCommand,
    })
    expect(switchCurrentCommand).not.toHaveBeenCalled()
    expect(removeCurrentCommand).toHaveBeenCalledWith(plan.releaseRoot)
    expect(startServiceCommand).toHaveBeenCalledWith(previousSource, plan, false, lifecycleRoot)
  })

  it('refuses rollback without a usable lifecycle root', () => {
    expect(() => restorePreviousService({
      plan: { releaseRoot: '/tmp/releases', source: 'https://example.test/repo.git' },
      previousCurrentTarget: '/tmp/releases/old',
      previousServiceRoot: '/tmp/source',
      lifecycleRoot: undefined,
      token: 'missing-lifecycle',
    })).toThrow('当前发布版本不可用')
  })

})
