// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncDecision, sealRuntime, verifyRuntimePackage } from '../../bin/lib/runtime-release.mjs'
import { assertRollbackCompatible, backupData, databaseSchema } from '../../bin/lib/service-data.mjs'
import { currentRelease, reserveUpdate, switchRelease, synchronizeDesktop, stopDesktopService, transitionService, updateMutex, writeJSON, recoverTransition, LaunchAgentService } from '../../bin/lib/service-update.mjs'
import { execFileSync } from 'node:child_process'
import { RunnerHub } from '../../src/server/runnerHub'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const temporary = () => { const home = realpathSync(mkdtempSync(join(tmpdir(), 'yaoyao-sync-unit-'))); homes.push(home); return home }
function runtime(root: string, commit = 'b'.repeat(40), version = '0.3.32', ancestors = ['a'.repeat(40)]) {
  mkdirSync(join(root, 'bin'), { recursive: true }); mkdirSync(join(root, 'ui'))
  for (const file of ['node', 'server.mjs', 'ui/index.html', 'bin/hermes-yaoyao.mjs', 'bin/hermes-yaoyao-updater.mjs']) writeFileSync(join(root, file), file)
  writeJSON(join(root, 'release.json'), { schemaVersion: 1, releaseVersion: version, webVersion: version, gitTag: `v${version}` })
  writeJSON(join(root, 'build-info.json'), { commit, ancestors, buildNumber: ancestors.length + 1, dirty: false })
  sealRuntime(root); return verifyRuntimePackage(root)
}
const clean = (commit: string, ancestors: string[] = [], version = '0.3.32') => ({ commit, ancestors, version, dirty: false })

it.skipIf(process.platform !== 'darwin')('persists official source migration while preserving custom sources and other service settings', () => {
  const home = temporary(), plistPath = join(home, 'fixture.plist')
  const driver = new LaunchAgentService({ home, port: 18899, releaseRoot: join(home, 'releases'), label: 'fixture', plistPath })
  for (const [source, expected] of [['https://git.samien.cn/samien/hermes-yaoyao.git', 'https://github.com/Lsamien/hermes-yaoyao.git'], ['https://private.example/fork.git', 'https://private.example/fork.git']]) {
    driver.writePlist({ Label: 'fixture', EnvironmentVariables: { HERMES_YAOYAO_RELEASE_SOURCE: source, HERMES_YAOYAO_TLS_CERT: '/fixture/cert', CUSTOM_SETTING: 'preserve' } })
    const restored = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' }))
    expect(restored.EnvironmentVariables).toEqual({ HERMES_YAOYAO_RELEASE_SOURCE: expected, HERMES_YAOYAO_TLS_CERT: '/fixture/cert', CUSTOM_SETTING: 'preserve' })
  }
})

it('stops only a verified managed service and refuses to race an update',async()=>{
 const home=temporary(),calls:string[]=[]
 const driver={snapshot:()=>({wasRunning:true}),verify:async()=>{calls.push('verify')},stop:async()=>{calls.push('stop')}}
 const unlock=updateMutex(home)
 try{await expect(stopDesktopService({home,driver})).rejects.toThrow('更新');expect(calls).toEqual([])}finally{unlock()}
 writeJSON(join(home,'updates','transition.json'),{})
 await expect(stopDesktopService({home,driver})).rejects.toThrow('更新尚未完成');expect(calls).toEqual([])
 rmSync(join(home,'updates','transition.json'))
 await expect(stopDesktopService({home,driver:{...driver,snapshot:()=>{throw new Error('wrong owner')}}})).rejects.toThrow('wrong owner')
 expect(calls).toEqual([])
 expect(await stopDesktopService({home,driver})).toEqual({action:'stopped'})
 expect(calls).toEqual(['verify','stop'])
 await expect(stopDesktopService({home,driver:{...driver,stop:async()=>{throw new Error('still running')}}})).rejects.toThrow('still running')
})

describe('desktop release selection and integrity', () => {
  it('orders same-version builds by ancestry, preserves newer Web, and refuses unrelated builds', () => {
    expect(syncDecision(clean('b', ['a']), clean('a'))).toBe('upgrade')
    expect(syncDecision(clean('a'), clean('b', ['a']))).toBe('newer')
    expect(syncDecision(clean('b'), clean('b'))).toBe('same')
    expect(syncDecision(clean('a', [], '0.3.32'), clean('b', [], '0.3.33'))).toBe('newer')
    expect(syncDecision(clean('z'), clean('a'))).toBe('unknown')
    expect(syncDecision({ ...clean('a'), dirty: true }, clean('a'))).toBe('unknown')
    expect(syncDecision(clean('a', [], '0.4.0-10'), clean('b', [], '0.4.0-2'))).toBe('upgrade')
  })
  it('detects changed, added, removed and symlinked payload files before touching a service', () => {
    const root = join(temporary(), 'runtime'); runtime(root)
    writeFileSync(join(root, 'server.mjs'), 'tampered')
    expect(() => verifyRuntimePackage(root)).toThrow('校验失败')
    sealRuntime(root); writeFileSync(join(root, 'unexpected'), 'extra')
    expect(() => verifyRuntimePackage(root)).toThrow('校验失败')
    rmSync(join(root, 'unexpected')); sealRuntime(root); rmSync(join(root, 'node'))
    expect(() => verifyRuntimePackage(root)).toThrow('校验失败')
    symlinkSync('/etc/hosts', join(root, 'node'))
    expect(() => verifyRuntimePackage(root)).toThrow('符号链接')
  })
  it('excludes competing desktop and Web updaters using the same OS lock and file reservation', () => {
    const home = temporary(), unlock = updateMutex(home)
    expect(() => updateMutex(home)).toThrow('正在执行')
    const release = reserveUpdate(home, 'first')
    expect(() => reserveUpdate(home, 'second')).toThrow('正在执行')
    release(); unlock()
    const next = updateMutex(home); next()
  })
  it('waits for Local VM preparation even after its command has returned', async () => {
    const store = { list: () => [], require: () => ({ enabled: true }), get: () => ({ enabled: true }) }
    const auth = { pushAuthorizationVersion: () => 1, isAdminActive: () => true }
    const hub = new RunnerHub(store as any, auth as any, {} as any)
    try {
      ;(hub as any).online.set('runner', { features: ['local-vm-v1'], seen: Date.now() })
      ;(hub as any).request = async (_id: string, _kind: string, body: any) => body.op === 'prepare' ? { job: { state: 'running' } } : { busy: false }
      expect(hub.idleForUpdate).toBe(true)
      await hub.localVm('owner', 'runner', { op: 'prepare' })
      expect(hub.idleForUpdate).toBe(false)
      await hub.localVm('owner', 'runner', { op: 'status' })
      expect(hub.idleForUpdate).toBe(true)
    } finally { hub.close() }
  })
})

describe('transactional service switching', () => {
  function fixture() {
    const home = temporary(), releaseRoot = join(home, 'updates', 'releases')
    mkdirSync(releaseRoot, { recursive: true })
    const old = join(releaseRoot, 'old'), target = join(releaseRoot, 'new')
    runtime(old, 'a'.repeat(40), '0.3.31'); runtime(target)
    switchRelease(releaseRoot, old)
    const db = new DatabaseSync(join(home, 'workspace.sqlite3'))
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(value TEXT); INSERT INTO messages VALUES('before')"); db.close()
    writeFileSync(join(home, 'settings.json'), 'original')
    let stops = 0, starts = 0, fail = false
    const driver = {
      snapshot: () => ({ root: currentRelease(releaseRoot), wasRunning: true }),
      quiesce: async () => {}, resume: async () => {},
      stop: async () => { stops++ },
      start: async () => {
        starts++
        if (fail) {
          const database = new DatabaseSync(join(home, 'workspace.sqlite3'))
          database.exec("ALTER TABLE messages ADD COLUMN extra TEXT; UPDATE messages SET value='migrated'"); database.close()
          writeFileSync(join(home, 'settings.json'), 'migrated'); writeFileSync(join(home, 'new-migration-file'), 'new')
        }
      },
      verify: async (expected?: unknown) => { if (expected && fail) throw new Error('wrong running build') },
      restore: async () => {},
    }
    return { home, releaseRoot, target, old, driver, counts: () => ({ stops, starts }), fail: () => { fail = true } }
  }
  it('restores both schema and data after a failed startup; preserves independent Runner state', async () => {
    const f = fixture(), schema = databaseSchema(f.home)
    mkdirSync(join(f.home, 'runner-state')); writeFileSync(join(f.home, 'runner-state', 'preserve'), 'runner')
    f.fail()
    await expect(transitionService({ ...f, finalRoot: f.target })).rejects.toThrow('wrong running build')
    expect(currentRelease(f.releaseRoot)).toBe(f.old)
    expect(databaseSchema(f.home)).toBe(schema)
    const db = new DatabaseSync(join(f.home, 'workspace.sqlite3'), { readOnly: true })
    expect(db.prepare('SELECT value FROM messages').get()?.value).toBe('before'); db.close()
    expect(readFileSync(join(f.home, 'settings.json'), 'utf8')).toBe('original')
    expect(existsSync(join(f.home, 'new-migration-file'))).toBe(false)
    expect(readFileSync(join(f.home, 'runner-state', 'preserve'), 'utf8')).toBe('runner')
    expect(existsSync(join(f.home, 'updates', 'last-success.json'))).toBe(false)
  })
  it('does not stop or mark a busy service as synchronized', async () => {
    const f = fixture(); f.driver.quiesce = async () => { throw new Error('busy') }
    await expect(synchronizeDesktop({ ...f, runtimeRoot: f.target })).rejects.toThrow('busy')
    expect(f.counts()).toEqual({ stops: 0, starts: 0 })
    expect(existsSync(join(f.home, 'updates', 'desktop-sync.json'))).toBe(false)
  })
  it('synchronizes an App build once, allowing Web to move independently afterwards', async () => {
    const f = fixture()
    await synchronizeDesktop({ ...f, runtimeRoot: f.target })
    expect(f.counts()).toEqual({ stops: 1, starts: 1 })
    switchRelease(f.releaseRoot, f.old)
    const result = await synchronizeDesktop({ ...f, runtimeRoot: f.target })
    expect(result.action).toBe('already-synced')
    expect(f.counts()).toEqual({ stops: 1, starts: 1 })
  })
  it('recovers an interrupted migration before another update and restores the previous rollback record', async () => {
    const f = fixture(), snapshot = join(f.home, 'updates', 'backups', 'interrupted')
    backupData(f.home, snapshot)
    writeJSON(join(f.home, 'updates', 'transition.json'), { home: f.home, releaseRoot: f.releaseRoot, previousCurrent: f.old,
      previous: { root: f.old, wasRunning: true }, snapshot, previousSuccess: { jobId: 'older-success' } })
    switchRelease(f.releaseRoot, f.target)
    writeFileSync(join(f.home, 'settings.json'), 'partial migration')
    await recoverTransition(f)
    expect(currentRelease(f.releaseRoot)).toBe(f.old)
    expect(readFileSync(join(f.home, 'settings.json'), 'utf8')).toBe('original')
    expect(JSON.parse(readFileSync(join(f.home, 'updates', 'last-success.json'), 'utf8')).jobId).toBe('older-success')
    expect(existsSync(join(f.home, 'updates', 'transition.json'))).toBe(false)
  })
  it('allows data-preserving rollback only when the schema remains compatible', () => {
    const f = fixture(), schema = databaseSchema(f.home)
    const record = { beforeSchema: schema, afterSchema: schema }
    const db = new DatabaseSync(join(f.home, 'workspace.sqlite3'))
    db.exec("INSERT INTO messages VALUES('new message after upgrade')")
    expect(() => assertRollbackCompatible(f.home, record)).not.toThrow()
    db.exec('ALTER TABLE messages ADD COLUMN migrated TEXT')
    expect(() => assertRollbackCompatible(f.home, record)).toThrow('数据库结构')
    expect(() => assertRollbackCompatible(f.home, {})).toThrow('兼容性记录')
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()?.count).toBe(2)
    db.close()
  })
  it('does not restore data twice when restarting the restored service needs another attempt', async () => {
    const f = fixture(), snapshot = join(f.home, 'updates', 'backups', 'retry')
    backupData(f.home, snapshot)
    writeJSON(join(f.home, 'updates', 'transition.json'), { home: f.home, releaseRoot: f.releaseRoot, previousCurrent: f.old,
      previous: { root: f.old, wasRunning: true }, snapshot })
    f.driver.restore = async () => { throw new Error('restart pending') }
    await expect(recoverTransition(f)).rejects.toThrow('restart pending')
    writeFileSync(join(f.home, 'settings.json'), 'data after restore')
    f.driver.restore = async () => {}
    await recoverTransition(f)
    expect(readFileSync(join(f.home, 'settings.json'), 'utf8')).toBe('data after restore')
    expect(f.counts().stops).toBe(1)
  })
})
