import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { _electron as electron, expect } from '@playwright/test'
import { dataKey } from './service-manager.mjs'

for (const scenario of ['remote', 'local', 'remote-failure']) test(`${scenario} restart releases the lock, preserves independent servers and recovers on failure`, { timeout: 60000 }, async () => {
  const mode = scenario === 'local' ? 'local' : 'remote', fail = scenario === 'remote-failure'
  const root = resolve(import.meta.dirname, '..'), home = await realpath(await mkdtemp(join(tmpdir(), 'yaoyao-update-restart-')))
  const version = JSON.parse(await readFile(join(root, 'release.json'), 'utf8')).webVersion
  const identity = { protocol: 1, instanceId: 'update-restart', pid: process.pid, dataKey: dataKey(home), version }
  let releaseIdentity; const identityReady = new Promise(resolve => { releaseIdentity = resolve })
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/desktop/service') { await identityReady; res.end(JSON.stringify(identity)) }
    else if (req.url === '/api/app/bootstrap') res.end(JSON.stringify({ authenticated: true, csrfToken: 'fixture', user: { role: 'member' } }))
    else { res.setHeader('Content-Type', 'text/html'); res.end('<title>Connected server</title>') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(home, 'desktop-preferences.json'), JSON.stringify({ startupChoice: mode, remoteServer: origin }))
  if (mode === 'local') await writeFile(join(home, 'service-instance.json'), JSON.stringify({ ...identity, url: origin, token: 'fixture' }))
  let app
  try {
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, HERMES_YAOYAO_DESKTOP_TEST_HOME: home,
      HERMES_YAOYAO_DESKTOP_TEST_AUTO_UPDATE: '1', HERMES_YAOYAO_DESKTOP_TEST_SYNC: '0', HERMES_YAOYAO_DESKTOP_PORT: mode === 'local' ? String(server.address().port) : '1' } })
    const page = await app.firstWindow(); releaseIdentity(); await page.waitForURL(origin + '/**')
    await app.evaluate(async ({ app }, { root, home, fail }) => {
      const { createRequire } = process.getBuiltinModule('node:module'), { writeFileSync } = process.getBuiltinModule('node:fs')
      const { autoUpdater } = createRequire(root + '/package.json')(root + '/.desktop-build/electron-updater.cjs')
      autoUpdater.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: '99.0.0' } })
      autoUpdater.downloadUpdate = async () => { autoUpdater.emit('update-downloaded'); return [] }
      autoUpdater.quitAndInstall = () => {
        writeFileSync(home + '/restart-proof.json', JSON.stringify({ holdsAppLock: app.hasSingleInstanceLock() }))
        if (fail) throw new Error('fixture restart failed')
        app.quit()
      }
    }, { root, home, fail })
    const opened = app.waitForEvent('window'); await page.evaluate(() => window.yaoyaoDesktop.openUpdates())
    const updates = await opened
    await updates.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(updates.getByRole('button', { name: '重启更新', exact: true })).toBeEnabled()
    const closed = fail ? undefined : app.waitForEvent('close')
    await updates.getByRole('button', { name: '重启更新', exact: true }).click().catch(error => { if (!updates.isClosed()) throw error })
    if (fail) {
      await expect(updates.getByRole('alert')).toContainText('fixture restart failed')
      assert.equal(await app.evaluate(({ app }) => app.hasSingleInstanceLock()), true)
      assert.equal((await page.evaluate(() => window.yaoyaoDesktop.modeState())).mode, 'client')
    } else { await closed; app = undefined }
    assert.deepEqual(JSON.parse(await readFile(join(home, 'restart-proof.json'), 'utf8')), { holdsAppLock: false })
    assert.equal((await fetch(origin + '/api/app/bootstrap')).status, 200)
  } finally {
    releaseIdentity(); await app?.close().catch(() => {})
    await new Promise(done => { server.close(done); server.closeAllConnections() })
    await rm(home, { recursive: true, force: true })
  }
})
