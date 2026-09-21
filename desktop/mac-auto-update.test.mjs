import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Module, { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { get } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bundleDesktopUpdater } from '../scripts/bundle-desktop-updater.mjs'
import { DesktopAutoUpdateManager } from './auto-update-manager.mjs'

const directory = mkdtempSync(join(tmpdir(), 'yaoyao-native-update-'))
const bundle = join(directory, 'electron-updater.cjs')
before(async () => bundleDesktopUpdater(bundle))
after(() => rmSync(directory, { recursive: true, force: true }))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const httpGet = (url, headers) => new Promise((resolve, reject) => {
  get(url, { headers, agent: false }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject)
    response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }))
  }).on('error', reject)
})

function fixture(t) {
  const native = new EventEmitter(), transferred = deferred(), calls = []
  let feed
  native.setFeedURL = value => { feed = value }
  native.quitAndInstall = () => calls.push('install')
  native.checkForUpdates = () => {
    void (async () => {
      assert.equal((await httpGet(feed.url)).status, 401)
      const metadata = await httpGet(feed.url, feed.headers)
      assert.equal(metadata.status, 200)
      const zip = await httpGet(JSON.parse(metadata.text).url)
      assert.equal(zip.text, 'fixture ZIP bytes')
      transferred.resolve()
    })().catch(transferred.reject)
  }
  const load = Module._load
  let driver
  try {
    Module._load = (name, ...args) => name === 'electron' ? { autoUpdater: native } : load(name, ...args)
    const { MacUpdater } = createRequire(import.meta.url)(bundle)
    driver = new MacUpdater(null, { version: '0.4.62', quit: () => assert.fail('unexpected quit') })
  } finally { Module._load = load }
  driver.logger = { info() {}, warn() {}, error() {}, debug() {} }
  const file = join(directory, 'update.zip'); writeFileSync(file, 'fixture ZIP bytes')
  driver.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.4.63' } })
  driver.downloadUpdate = () => driver.updateDownloaded({ info: { size: 17 }, url: new URL('https://fixture.invalid/update.zip') }, { version: '0.4.63', downloadedFile: file })
  const manager = new DesktopAutoUpdateManager({ driver, version: '0.4.62', prepareInstall: async () => calls.push('cleanup') })
  t.after(async () => {
    clearTimeout(manager.stagingTimer); clearTimeout(manager.restartTimer); manager.stopChecking()
    if (driver.server?.listening) await new Promise(done => driver.server.close(done))
    native.removeAllListeners()
  })
  return { native, driver, manager, transferred, calls }
}

test('bundled Mac updater waits for native validation after the real ZIP proxy transfer', async t => {
  const h = fixture(t)
  await h.manager.check(); const downloading = h.manager.download()
  await h.transferred.promise
  assert.equal(h.manager.snapshot().phase, 'preparing')
  assert.equal(h.driver.squirrelDownloadedUpdate, false)
  await h.manager.install(); assert.deepEqual(h.calls, [])
  assert.throws(() => h.driver.quitAndInstall(), /not ready/)
  h.native.emit('update-downloaded'); await downloading
  assert.equal(h.manager.snapshot().phase, 'ready')
  assert.equal(h.native.listenerCount('update-downloaded'), 1)
  await h.manager.install(); await h.manager.install()
  assert.deepEqual(h.calls, ['cleanup', 'install'])
})

test('native signature rejection leaves no restart action and cleans temporary listeners', async t => {
  const h = fixture(t)
  await h.manager.check(); const downloading = h.manager.download()
  await h.transferred.promise
  h.native.emit('error', new Error('signature validation failed'))
  await downloading
  assert.equal(h.manager.snapshot().phase, 'failed')
  assert.equal(h.manager.snapshot().retryable, false)
  assert.equal(h.native.listenerCount('update-downloaded'), 1)
  h.native.emit('update-downloaded'); await h.manager.install()
  assert.deepEqual(h.calls, [])
})
