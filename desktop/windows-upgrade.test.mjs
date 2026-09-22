import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron, expect } from '@playwright/test'
import { powershellArguments } from './windows-shell.mjs'
const execute = promisify(execFile)

test('installed NSIS client rejects a corrupt update, upgrades and preserves settings and cookies', {
  skip: process.platform !== 'win32' || process.env.DESKTOP_TEST_UPGRADE !== '1', timeout: 600000,
}, async () => {
  const root = resolve(import.meta.dirname, '..'), output = join(root, 'desktop-release/windows-x64')
  const evidence = join(root, 'test-results/windows-client'), sandbox = await mkdtemp(join(tmpdir(), 'yaoyao-upgrade-'))
  const home = join(sandbox, '中文配置'), installed = join(sandbox, 'app'), feed = join(sandbox, 'feed')
  const executablePath = join(installed, 'Yaoyao.exe'), cacheName = 'yaoyao-upgrade-' + randomUUID()
  const originalManifest = await readFile(join(root, '.desktop-build/release.json'), 'utf8')
  const originalPackage = await readFile(join(root, '.desktop-build/shell/package.json'), 'utf8')
  const version = JSON.parse(originalPackage).version, nextVersion = version.replace(/\d+$/, value => String(Number(value) + 1))
  let application, corrupt = true, requireCookie = false, restored = 0
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname
      if (path === '/api/app/bootstrap') {
        const authenticated = !requireCookie || String(req.headers.cookie).includes('session=upgrade-fixture')
        if (requireCookie && authenticated) restored++
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ authenticated, csrfToken: 'fixture', user: { role: 'member' }, serverKind: 'yaoyao-web' })); return
      }
      if (path.startsWith('/feed/')) {
        const name = decodeURIComponent(path.slice(6))
        if (basename(name) !== name) { res.writeHead(404).end(); return }
        const bytes = corrupt && name.endsWith('.exe') ? Buffer.from('damaged-installer') : await readFile(join(feed, name))
        res.setHeader('content-length', bytes.length); res.end(bytes); return
      }
      res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<title>升级验收</title><h1>远程工作区</h1>')
    } catch { res.writeHead(404).end() }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const stopInstalled = async () => {
    // Only stop this test's executable, never another Yaoyao installation.
    const literal = executablePath.replaceAll("'", "''")
    await execute(shell, powershellArguments(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${literal}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`), { windowsHide: true }).catch(() => {})
  }
  try {
    await mkdir(home, { recursive: true }); await mkdir(evidence, { recursive: true })
    const { build, Platform, Arch } = await import('electron-builder')
    try {
      await writeFile(join(root, '.desktop-build/release.json'), JSON.stringify({ ...JSON.parse(originalManifest), webVersion: nextVersion }))
      await writeFile(join(root, '.desktop-build/shell/package.json'), JSON.stringify({ ...JSON.parse(originalPackage), version: nextVersion }))
      process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
      await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
        config: { directories: { output: feed }, forceCodeSigning: false } })
    } finally {
      await writeFile(join(root, '.desktop-build/release.json'), originalManifest)
      await writeFile(join(root, '.desktop-build/shell/package.json'), originalPackage)
    }
    await execute(join(output, `Yaoyao-${version}-win-x64-setup.exe`), ['/S', `/D=${installed}`], { timeout: 120000 })
    const preferences = { startupChoice: 'remote', remoteServer: origin, backgroundAtLogin: true }
    await writeFile(join(home, 'desktop-preferences.json'), JSON.stringify(preferences))
    // This installed test copy alone uses the isolated HTTP update source.
    await writeFile(join(installed, 'resources/app-update.yml'), JSON.stringify({ provider: 'generic', url: origin + '/feed/', updaterCacheDirName: cacheName }))
    const launch = () => electron.launch({ executablePath, env: { ...process.env,
      HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_TEST_AUTO_UPDATE: '1' } })
    application = await launch(); let page = await application.firstWindow(); await page.waitForURL(origin + '/**')
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), version)
    await application.evaluate(async ({ session, safeStorage }, { origin, home }) => {
      await session.defaultSession.cookies.set({ url: origin, name: 'session', value: 'upgrade-fixture', expirationDate: Date.now() / 1000 + 3600 })
      await session.defaultSession.cookies.flushStore()
      const fs = process.getBuiltinModule('node:fs')
      fs.writeFileSync(home + '/upgrade-token.enc', await safeStorage.encryptStringAsync('upgrade-device-identity'))
    }, { origin, home })
    requireCookie = true
    const opened = application.waitForEvent('window'); await page.evaluate(() => window.yaoyaoDesktop.openUpdates())
    const updates = await opened
    await expect(updates.locator('#download')).toBeEnabled({ timeout: 30000 })
    await updates.locator('#download').click()
    await expect(updates.locator('#error')).toBeVisible({ timeout: 120000 })
    assert.equal(await updates.evaluate(async () => (await window.yaoyaoUpdate.state()).phase), 'failed')
    corrupt = false
    await updates.locator('#check').click(); await expect(updates.locator('#download')).toBeEnabled()
    await updates.locator('#download').click(); await expect(updates.locator('#install')).toBeEnabled({ timeout: 120000 })
    await updates.screenshot({ path: join(evidence, 'upgrade-ready.png') })
    const closed = application.waitForEvent('close'); await updates.locator('#install').click().catch(error => { if (!updates.isClosed()) throw error })
    await closed; application = undefined
    await expect.poll(async () => JSON.parse(await readFile(join(installed, 'resources/runtime/release.json'), 'utf8')).webVersion,
      { timeout: 120000 }).toBe(nextVersion)
    await expect.poll(() => restored, { timeout: 60000 }).toBeGreaterThan(0)
    await stopInstalled()
    application = await launch(); page = await application.firstWindow(); await page.waitForURL(origin + '/**')
    assert.equal(await application.evaluate(({ app }) => app.getVersion()), nextVersion)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'desktop-preferences.json'), 'utf8')), preferences)
    assert.equal(await application.evaluate(async ({ safeStorage }, home) => {
      const fs = process.getBuiltinModule('node:fs'); return (await safeStorage.decryptStringAsync(fs.readFileSync(home + '/upgrade-token.enc'))).result
    }, home), 'upgrade-device-identity')
    await page.screenshot({ path: join(evidence, 'upgrade-restored.png') })
    await application.close(); application = undefined
    const uninstaller = (await readdir(installed)).find(name => /^Uninstall .*\.exe$/.test(name))
    assert.ok(uninstaller)
    await execute(join(installed, uninstaller), ['/S'], { timeout: 120000 })
    await expect.poll(async () => (await readdir(installed).catch(() => [])).includes('Yaoyao.exe'), { timeout: 30000 }).toBe(false)
    assert.deepEqual(JSON.parse(await readFile(join(home, 'desktop-preferences.json'), 'utf8')), preferences)
    await writeFile(join(evidence, 'upgrade.json'), JSON.stringify({ platform: 'win32', from: version, to: nextVersion,
      installed: true, corruptDownloadRejected: true, nsisReplacement: true, automaticRestart: true,
      cookieRestored: true, settingsPreserved: true, dpapiPreserved: true, uninstalled: true, dataRetained: true }, null, 2))
  } finally {
    await application?.close().catch(() => {}); await stopInstalled()
    server.closeAllConnections(); await new Promise(done => server.close(done))
    await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    await rm(join(process.env.LOCALAPPDATA, cacheName), { recursive: true, force: true }).catch(() => {})
  }
})
