import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

test('the desktop update icon appears beside the bell only for updates and waits for an explicit restart', { timeout: 60000 }, async () => {
  const root = resolve(import.meta.dirname, '..'), home = await mkdtemp(join(tmpdir(), 'yaoyao-inline-update-'))
  const port = await freePort(), upstream = await freePort(), origin = `http://127.0.0.1:${port}`
  await mkdir(join(home, 'server'))
  const server = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/workspace-server.ts'], {
    cwd: root, env: { ...process.env, WORKSPACE_FIXTURE_HOME: join(home, 'server'), WORKSPACE_FIXTURE_PORT: String(port), WORKSPACE_FIXTURE_UPSTREAM_PORT: String(upstream) }, stdio: 'ignore',
  })
  const desktopHome = join(home, 'desktop'); await mkdir(desktopHome)
  await writeFile(join(desktopHome, 'desktop-preferences.json'), JSON.stringify({ startupChoice: 'remote', remoteServer: origin }))
  let app
  try {
    await expect.poll(async () => { try { return (await fetch(origin + '/healthz')).status } catch { return 0 } }, { timeout: 30000 }).toBe(200)
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, HERMES_YAOYAO_DESKTOP_CLIENT_ONLY: '1', HERMES_YAOYAO_DESKTOP_TEST_HOME: desktopHome, HERMES_YAOYAO_DESKTOP_TEST_AUTO_UPDATE: '1' } })
    const page = await app.firstWindow()
    await app.evaluate(({ app }, root) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const { autoUpdater } = createRequire(root + '/package.json')(root + '/.desktop-build-client/electron-updater.cjs')
      globalThis.inlineFixture = { installs: 0, available: false }
      autoUpdater.checkForUpdates = async () => ({ isUpdateAvailable: inlineFixture.available, updateInfo: { version: '99.0.0' } })
      autoUpdater.downloadUpdate = () => new Promise(resolve => {
        inlineFixture.ready = () => resolve([])
        inlineFixture.stage = () => autoUpdater.emit('update-downloaded')
        autoUpdater.emit('download-progress', { transferred: 37, total: 100 })
      })
      autoUpdater.quitAndInstall = () => { inlineFixture.installs++ }
    }, root)
    await expect.poll(() => page.evaluate(() => window.yaoyaoDesktop.status().then(state => state.phase))).toBe('ready')
    await page.reload()
    await page.locator('#username').fill('fixture')
    await page.locator('#password').fill('fixture-pass')
    await page.locator('#submit').click()
    await page.waitForURL(origin + '/**')
    await page.goto(origin + '/conversations')
    await expect(page.locator('.desktop-sidebar .sidebar-account-switcher__main')).toBeVisible()
    const entry = page.locator('.desktop-sidebar .desktop-update-entry')
    await page.evaluate(() => window.yaoyaoDesktop.openUpdates())
    await expect(entry).toHaveCount(0)
    await expect(page.locator('#desktop-update-entry')).toHaveCount(0)
    // Older servers receive the local updater script through the real main
    // process. Its entry must follow the same bell placement and visibility.
    await page.route(origin + '/legacy-update', route => route.fulfill({ contentType: 'text/html', body: '<aside class="desktop-sidebar"><div class="bot-list-header"><button class="unread-entry">铃铛</button><button>搜索</button></div></aside>' }))
    await page.goto(origin + '/legacy-update')
    await expect(page.locator('#desktop-update-entry')).toBeHidden()
    await page.evaluate(() => window.yaoyaoDesktop.openUpdates())
    await expect(page.locator('#desktop-update-entry')).toBeHidden()
    await app.evaluate(() => { inlineFixture.available = true })
    await page.evaluate(() => window.yaoyaoDesktop.updateAction('check'))
    await expect(page.locator('.unread-entry + #desktop-update-entry').getByRole('button', { name: '可更新', exact: true })).toBeVisible()
    await page.goto(origin + '/conversations')
    await expect(entry.getByRole('button', { name: '可更新', exact: true })).toBeVisible()
    await expect(page.locator('#desktop-update-entry')).toHaveCount(0)
    assert.equal(await entry.evaluate(element => element.previousElementSibling.classList.contains('unread-entry')), true)
    await expect(page.locator('.sidebar-footer .desktop-update-entry')).toHaveCount(0)
    assert.equal(app.windows().length, 1)
    const output = join(root, 'test-results/desktop/inline-workspace'); await mkdir(output, { recursive: true })
    await page.screenshot({ path: join(output, 'available.png') })
    await entry.getByRole('button', { name: '可更新', exact: true }).click()
    await expect(entry.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37')
    await expect(page.locator('#desktop-update-entry')).toHaveCount(0)
    await page.screenshot({ path: join(output, 'downloading.png') })
    await page.locator('.desktop-sidebar .sidebar-account-switcher__main').click()
    await expect(page.locator('.workspace-settings-menu .desktop-update-entry')).toHaveCount(0)
    await expect(page.locator('.desktop-update-check')).toBeDisabled()
    await page.keyboard.press('Escape')
    await app.evaluate(() => inlineFixture.stage())
    await expect(entry).toContainText('正在准备…')
    await page.reload()
    await expect(entry).toContainText('正在准备…')
    await expect(entry.getByRole('button')).toBeDisabled()
    await app.evaluate(() => inlineFixture.ready())
    await expect(entry.getByRole('button', { name: '重新启动', exact: true })).toBeEnabled()
    await expect(entry).toHaveClass(/desktop-update-entry--ready/)
    assert.equal(await app.evaluate(() => inlineFixture.installs), 0)
    assert.equal(app.windows().length, 1)
    await page.screenshot({ path: join(output, 'ready.png') })
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.screenshot({ path: join(output, 'ready-dark.png') })
    await page.goto(origin + '/legacy-update')
    await expect(page.locator('.unread-entry + #desktop-update-entry').getByRole('button', { name: '重新启动', exact: true })).toBeVisible()
    await expect(page.locator('#desktop-update-icon')).toBeVisible()
    await expect(page.locator('#desktop-update-ring')).toBeHidden()
    await page.goto(origin + '/chat')
    await expect(page.locator('.sidebar-status-actions .desktop-update-entry')).toBeVisible()
    await expect(page.locator('#desktop-update-entry')).toHaveCount(0)
    await page.screenshot({ path: join(output, 'ready-chat.png') })
    await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click()
    await expect(entry.getByRole('button', { name: '重新启动', exact: true })).toBeVisible()
    await page.screenshot({ path: join(output, 'ready-collapsed.png') })
    await entry.getByRole('button', { name: '重新启动', exact: true }).click()
    await expect.poll(() => app.evaluate(() => inlineFixture.installs)).toBe(1)
    await expect(entry.getByRole('button', { name: '正在重启…', exact: true })).toBeDisabled()
    assert.equal((await fetch(origin + '/healthz')).status, 200)
  } finally {
    await app?.close().catch(() => {})
    server.kill('SIGTERM')
    await new Promise(done => {
      if (server.exitCode !== null) return done()
      const timer = setTimeout(() => { server.kill('SIGKILL'); done() }, 3000)
      server.once('exit', () => { clearTimeout(timer); done() })
    })
    await rm(home, { recursive: true, force: true })
  }
})
