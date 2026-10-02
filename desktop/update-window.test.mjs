import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { _electron as electron, expect } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
test('inline boot updater works without a Web service, verifies a real DMG and denies other renderers', { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'yaoyao-update-window-'))
  const blocked = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}') })
  await new Promise(done => blocked.listen(0, '127.0.0.1', done))
  let app
  try {
    const folder = join(home, 'image-source'); await mkdir(folder); await writeFile(join(folder, 'fixture.txt'), 'DMG integrity fixture')
    const image = join(home, 'fixture.dmg')
    await promisify(execFile)('/usr/bin/hdiutil', ['create', '-srcfolder', folder, '-volname', 'YaoYao Update Test', '-format', 'UDZO', image])
    const bytes = await readFile(image), digest = createHash('sha256').update(bytes).digest('hex')
    const current = JSON.parse(await readFile(join(root, 'release.json'), 'utf8')).webVersion
    const version = current.split('.').map((part, i) => i === 2 ? String(Number(part) + 1) : part).join('.')
    const name = `Yaoyao-${version}-arm64.dmg`, sums = `${digest}  ${name}\n`
    app = await electron.launch({ ...(process.env.DESKTOP_TEST_EXECUTABLE ? { executablePath: process.env.DESKTOP_TEST_EXECUTABLE } : {}),
      args: process.env.DESKTOP_TEST_EXECUTABLE ? [] : [root], cwd: root,
      env: { ...process.env, HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_TEST_SYNC: '1', HERMES_YAOYAO_DESKTOP_PORT: String(blocked.address().port), HERMES_YAOYAO_UPSTREAM: 'http://127.0.0.1:1' } })
    const boot = await app.firstWindow()
    await expect.poll(() => boot.evaluate(() => window.yaoyaoDesktop.status().then(state => state.phase))).toBe('error')
    await boot.reload()
    assert.equal(await boot.evaluate(() => typeof window.yaoyaoUpdate), 'undefined')
    assert.equal(await boot.evaluate(() => typeof window.yaoyaoDesktop.updateState), 'function')
    // Even another renderer carrying the real bridge cannot acquire update privileges.
    const denied = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const outsider = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload } })
      try {
        await outsider.loadURL('data:text/html,<html><body>Untrusted renderer</body></html>')
        return await outsider.webContents.executeJavaScript("window.yaoyaoDesktop.updateAction('check').then(()=>false,()=>true)")
      } finally { outsider.destroy() }
    }, join(root, 'desktop/preload.cjs'))
    assert.equal(denied, true)
    await app.evaluate(({ net, shell, Menu }, fixture) => {
      const tag = `v${fixture.version}`, api = 'https://api.github.com/repos/Lsamien/yaoyao'
      const prefix = `https://github.com/Lsamien/yaoyao/releases/download/${tag}/`
      const commit = 'a'.repeat(40)
      net.fetch = async url => {
        const path = String(url)
        if (path === `${api}/releases/latest`) return Response.json({ draft: false, prerelease: false, tag_name: tag, body: '下载、校验、手动安装。', assets: [
          { name: fixture.name, size: fixture.size, state: 'uploaded', digest: `sha256:${fixture.digest}`, browser_download_url: prefix + fixture.name },
          { name: 'SHA256SUMS.txt', size: fixture.sums.length, state: 'uploaded', browser_download_url: prefix + 'SHA256SUMS.txt' },
        ] })
        if (path === `${api}/git/ref/tags/${tag}`) return Response.json({ object: { type: 'commit', sha: commit } })
        if (path === `https://raw.githubusercontent.com/Lsamien/yaoyao/${commit}/release.json`) return Response.json({ schemaVersion: 1, releaseVersion: fixture.version, webVersion: fixture.version, gitTag: tag })
        if (path === prefix + 'SHA256SUMS.txt') return new Response(fixture.sums)
        if (path === prefix + fixture.name) return new Response(Buffer.from(fixture.data, 'base64'))
        throw new Error('Unexpected update request')
      }
      shell.openPath = async path => { process.env.YAOYAO_TEST_OPENED_UPDATE = path; return '' }
      Menu.getApplicationMenu().getMenuItemById('desktop-update-check').click()
    }, { version, name, sums, data: bytes.toString('base64'), size: bytes.length, digest })
    const page = boot
    await page.getByRole('button', { name: '可更新', exact: true }).click()
    assert.equal(app.windows().length, 1)
    await page.getByRole('button', { name: '打开安装包', exact: true }).waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: '打开安装包', exact: true }).focus()
    await expect(page.getByRole('button', { name: '打开安装包', exact: true })).toBeFocused()
    assert.equal(await app.evaluate(() => process.env.YAOYAO_TEST_OPENED_UPDATE), undefined)
    await mkdir(join(root, 'test-results/desktop'), { recursive: true })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.screenshot({ path: join(root, 'test-results/desktop/github-update-light.png') })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 380, height: 620 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(root, 'test-results/desktop/github-update-dark.png') })
    await page.getByRole('button', { name: '打开安装包', exact: true }).click()
    await expect.poll(() => app.evaluate(() => process.env.YAOYAO_TEST_OPENED_UPDATE)).toBe(join(home, 'updates', 'desktop-downloads', version, name))
    await app.evaluate(({ net }) => { net.fetch = async () => new Response('', { status: 403 }) })
    await page.evaluate(() => window.yaoyaoDesktop.updateAction('check'))
    await expect(page.locator('#desktop-update-error')).toContainText('GitHub 请求受限')
    await expect(page.getByRole('button', { name: '打开安装包', exact: true })).toBeHidden()
    assert.equal(blocked.listening, true)
    assert.equal(app.windows().length, 1)
  } finally {
    await app?.close().catch(() => {})
    await new Promise(done => blocked.close(done))
    await rm(home, { recursive: true, force: true })
  }
})
