import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DesktopAutoUpdateManager } from './auto-update-manager.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(t, options = {}) {
  const driver = new EventEmitter(), calls = []
  driver.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.4.63', releaseNotes: '<b>纯文本说明</b>' }, cancellationToken: { cancel() { calls.push('cancel') } } })
  driver.downloadUpdate = async () => { driver.emit('update-downloaded'); return ['update.zip'] }
  driver.quitAndInstall = () => calls.push('install')
  const manager = new DesktopAutoUpdateManager({ driver, version: '0.4.62', ...options })
  t.after(() => { manager.stopChecking(); clearTimeout(manager.stagingTimer); clearTimeout(manager.restartTimer) })
  return { manager, driver, calls }
}

test('checks app version, waits for native staging and installs only once after cleanup', async t => {
  const cleanup = deferred(), staged = deferred(), events = []
  const { manager, driver } = fixture(t, { prepareInstall: async () => { events.push('cleanup'); await cleanup.promise } })
  driver.downloadUpdate = () => { driver.emit('download-progress', { transferred: 10, total: 20 }); driver.emit('update-downloaded'); return staged.promise }
  driver.quitAndInstall = () => events.push('install')
  const checked = await manager.check()
  assert.equal(checked.available, true)
  assert.equal(checked.currentVersion, '0.4.62')
  assert.equal(driver.autoDownload, false)
  const download = manager.download()
  assert.equal(manager.snapshot().phase, 'preparing')
  assert.equal(manager.snapshot().canCancel, false)
  await manager.install(); await manager.check(); manager.cancel()
  assert.deepEqual(events, [])
  staged.resolve(['update.zip']); await download
  assert.equal(manager.snapshot().phase, 'ready')
  await manager.check(false)
  assert.equal(manager.snapshot().phase, 'ready')
  const install = manager.install()
  await manager.install()
  assert.deepEqual(events, ['cleanup'])
  cleanup.resolve(); await install
  assert.deepEqual(events, ['cleanup', 'install'])
  await manager.install(); assert.deepEqual(events, ['cleanup', 'install'])
})

test('no update and invalid environments never offer installation', async t => {
  const { manager, driver, calls } = fixture(t)
  driver.checkForUpdates = async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.4.62' } })
  assert.equal((await manager.check()).available, false)
  await manager.download(); await manager.install(); assert.deepEqual(calls, [])
  driver.checkForUpdates = async () => null
  assert.equal((await manager.check()).phase, 'failed')
})

test('check failures cannot masquerade as up-to-date or erase a manual error', async t => {
  const { manager, driver } = fixture(t)
  driver.checkForUpdates = async () => { throw new Error('HTTP 404 latest-mac.yml') }
  const failed = await manager.check()
  assert.equal(failed.phase, 'failed'); assert.equal(failed.available, false)
  assert.match(failed.error, /尚未提供完整/)
  await manager.check(false); assert.deepEqual(manager.snapshot(), failed)
  driver.checkForUpdates = async () => { driver.emit('error', new Error('network')); return { isUpdateAvailable: false } }
  assert.equal((await manager.check()).phase, 'failed')
})

test('background failures remain silent and checks are single-flight', async t => {
  const pending = deferred(); const { manager, driver } = fixture(t)
  let calls = 0
  driver.checkForUpdates = () => { calls++; return pending.promise }
  const checking = manager.check(false)
  await manager.check(false); assert.equal(calls, 1)
  pending.reject(new Error('ENOTFOUND'))
  assert.equal((await checking).phase, 'idle')
})

test('manual checking promotes a pending background error to a visible failure', async t => {
  const { manager, driver } = fixture(t), pending = deferred()
  driver.checkForUpdates = () => pending.promise
  const checking = manager.check(false)
  await manager.check(true)
  pending.reject(new Error('ENOTFOUND'))
  assert.equal((await checking).phase, 'failed')
})

test('canceling a download requires a fresh check and can then recover', async t => {
  const { manager, driver } = fixture(t), pending = deferred()
  const normal = driver.downloadUpdate
  driver.downloadUpdate = () => pending.promise
  await manager.check()
  manager.token.cancel = () => pending.reject(new Error('cancelled'))
  const downloading = manager.download()
  assert.equal(manager.snapshot().canCancel, true)
  manager.cancel(); assert.equal((await downloading).phase, 'cancelled')
  driver.downloadUpdate = normal
  await manager.check(); assert.equal((await manager.download()).phase, 'ready')
})

test('download errors reset availability and allow a new check', async t => {
  const { manager, driver } = fixture(t)
  driver.downloadUpdate = async () => { const error = new Error('sha512 mismatch'); driver.emit('error', error); throw error }
  await manager.check(); const failed = await manager.download()
  assert.equal(failed.phase, 'failed'); assert.match(failed.error, /完整性/)
  assert.equal(failed.retryable, true)
  assert.equal((await manager.check()).available, true)
})

test('native failures and late ready events never offer retry or installation', async t => {
  const { manager, driver, calls } = fixture(t), pending = deferred()
  driver.downloadUpdate = () => { driver.emit('update-downloaded'); return pending.promise }
  await manager.check(); const downloading = manager.download()
  driver.emit('error', new Error('signature validation failed'))
  assert.equal(manager.snapshot().retryable, false)
  assert.match(manager.snapshot().error, /签名验证失败.*重新打开/)
  pending.resolve([]); await downloading
  driver.emit('update-downloaded'); driver.emit('download-progress', { transferred: 100, total: 100 })
  await manager.install(); await manager.check(); await manager.download()
  assert.equal(manager.snapshot().phase, 'failed'); assert.deepEqual(calls, [])
})

test('staging timeout stays failed after a late native completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { manager, driver } = fixture(t, { stagingTimeout: 50 }), pending = deferred()
  driver.downloadUpdate = () => { driver.emit('update-downloaded'); return pending.promise }
  await manager.check(); const downloading = manager.download()
  t.mock.timers.tick(51)
  assert.equal(manager.snapshot().phase, 'failed')
  pending.resolve([]); await downloading
  assert.equal(manager.snapshot().phase, 'failed')
})

test('cleanup failure restores the app and never dispatches install', async t => {
  let restored = 0
  const { manager, calls } = fixture(t, { prepareInstall: async () => { throw new Error('cleanup failed') }, recoverInstall: async () => { restored++ } })
  await manager.check(); await manager.download(); await manager.install()
  assert.deepEqual(calls, []); assert.equal(restored, 1)
  assert.equal(manager.snapshot().phase, 'failed')
})

test('a native error during cleanup waits for cleanup before restoring', async t => {
  const pending = deferred(); let restored = 0
  const { manager, driver, calls } = fixture(t, { prepareInstall: () => pending.promise, recoverInstall: async () => { restored++ } })
  await manager.check(); await manager.download()
  const installing = manager.install()
  driver.emit('error', new Error('native staging lost'))
  assert.equal(restored, 0)
  pending.resolve(); await installing
  assert.equal(restored, 1); assert.deepEqual(calls, [])
})

test('quit dispatch failure restores app access and keeps installation locked', async t => {
  let restored = 0
  const { manager, driver } = fixture(t, { recoverInstall: async () => { restored++ } })
  driver.quitAndInstall = () => { throw new Error('native restart failed') }
  await manager.check(); await manager.download(); await manager.install()
  assert.equal(restored, 1); assert.equal(manager.snapshot().retryable, false)
})

test('automatic checks start once and stop cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, driver } = fixture(t); let checks = 0
  driver.checkForUpdates = async () => { checks++; return { isUpdateAvailable: false, updateInfo: { version: '0.4.62' } } }
  manager.startChecking(); manager.startChecking()
  t.mock.timers.tick(15000); await Promise.resolve(); assert.equal(checks, 1)
  t.mock.timers.tick(3600000); await Promise.resolve(); assert.equal(checks, 2)
  manager.stopChecking(); t.mock.timers.tick(3600000); assert.equal(checks, 2)
})
