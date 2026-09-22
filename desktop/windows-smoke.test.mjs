import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron, expect } from '@playwright/test'

test('packaged Windows client logs in, encrypts pairing, restores its session and never starts a server', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), '夭夭-windows-')), hostId = randomUUID(), token = 'windows-fixture-token-not-for-production'
  let exchanges = 0, app
  const server = createServer((req, res) => {
    const json = (body, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    if (req.url === '/api/app/bootstrap') {
      res.setHeader('set-cookie', 'csrf=fixture; Path=/; HttpOnly')
      return json({ authenticated: String(req.headers.cookie).includes('session=fixture'), setupRequired: false, csrfToken: 'fixture', serverKind: 'yaoyao-web' })
    }
    if (req.url === '/api/app/login') {
      req.resume(); res.setHeader('set-cookie', 'session=fixture; Path=/; HttpOnly; Max-Age=3600')
      return json({ user: { id: 'fixture', username: 'admin', role: 'admin' }, csrfToken: 'fixture' })
    }
    if (req.url === '/api/app/admin/desktop-hosts') { req.resume(); return json({ host: { id: hostId }, token }) }
    if (req.url === `/api/desktop-host/v1/${hostId}/exchange`) {
      let raw = ''; req.on('data', bytes => { raw += bytes }); req.on('end', () => {
        const body = JSON.parse(raw)
        assert.equal(body.host.platform, 'win32'); assert.equal(req.headers.authorization, `Bearer ${token}`)
        exchanges++; json({ commands: [], capabilities: { environmentMetadata: 1, desktopPlatforms: ['darwin', 'win32'] } })
      }); return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<title>Windows 登录验证</title><h1>远程工作区</h1>')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  const launch = () => electron.launch({ executablePath: process.env.DESKTOP_TEST_EXECUTABLE || resolve('desktop-release/windows-x64/win-unpacked/Yaoyao.exe'),
    args: [], env: { ...process.env, HERMES_YAOYAO_DESKTOP_TEST_HOME: home }, timeout: 30000 })
  const evidence = resolve('test-results/windows-client')
  try {
    app = await launch(); let page = await app.firstWindow()
    await expect(page.locator('#connection-form')).toBeVisible()
    await expect(page.locator('#choice-section')).toBeHidden()
    assert.deepEqual((await page.evaluate(() => window.yaoyaoDesktop.status())).supportedModes, ['client'])
    assert.equal(await page.evaluate(async () => { try { await window.yaoyaoDesktop.selectServer('local'); return false } catch { return true } }), true)
    await page.locator('#server').fill(url); await page.locator('#detect').click()
    await expect(page.locator('#login-form')).toBeVisible()
    await page.locator('#username').fill('admin'); await page.locator('#password').fill('fixture-password'); await page.locator('#remember').check(); await page.locator('#submit').click()
    await page.waitForURL(url + '/**')
    const state = await page.evaluate(() => window.yaoyaoDesktop.modeState())
    assert.equal(state.mode, 'client'); assert.deepEqual(state.supportedModes, ['client'])
    assert.equal((await page.evaluate(() => window.yaoyaoDesktop.switchMode('server'))).ok, false)
    await expect.poll(() => exchanges).toBeGreaterThan(0)
    const bytes = await readFile(join(home, 'desktop-host.enc'))
    assert.equal(bytes.includes(token), false); assert.equal(bytes.includes('fixture-password'), false)
    assert.equal(bytes.subarray(0, Buffer.byteLength('YAOYAO-WINDOWS-DPAPI-1\n')).toString(), 'YAOYAO-WINDOWS-DPAPI-1\n')
    assert.equal((await readdir(home)).includes('service-instance.json'), false)
    const menu = await app.evaluate(({ Menu }) => ['desktop-host-use-local', 'desktop-stop-and-quit', 'runner-import'].map(id => Boolean(Menu.getApplicationMenu().getMenuItemById(id))))
    assert.deepEqual(menu, [false, false, false])
    await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'remote-login.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    await app.close(); app = undefined
    const before = exchanges; app = await launch(); page = await app.firstWindow()
    await page.waitForURL(url + '/**'); await expect.poll(() => exchanges).toBeGreaterThan(before)
    await writeFile(join(evidence, 'smoke.json'), JSON.stringify({ platform: 'win32', login: true, encryptedPairing: true, sessionRestored: true,
      clientOnly: true, nativeDesktopControl: 'requires interactive Windows 10/11 acceptance', upgradeReplacement: 'requires two-version installed-app acceptance' }, null, 2))
  } finally { await app?.close().catch(() => {}); await new Promise(done => server.close(done)); await rm(home, { recursive: true, force: true }) }
})
