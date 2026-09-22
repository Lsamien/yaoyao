import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
test('first launch, failed connection and remote login all stay in the only main window', { timeout: 60000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'yaoyao-onboarding-')))
  let loginCount = 0
  let registrationCount = 0
  let loginRole = 'user', enrollmentCount = 0
  let holdBootstrap = false, replyBootstrap, sessionValid = true
  const server = createServer((req, res) => {
    const json = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
    if (req.url === '/api/app/bootstrap') {
      res.setHeader('set-cookie', 'csrf=fixture; Path=/; HttpOnly')
      const reply = () => json({ authenticated: sessionValid && String(req.headers.cookie).includes('session=fixture'), setupRequired: false, registrationAvailable: true, csrfToken: 'fixture', serverKind: 'yaoyao-web' })
      if (holdBootstrap) { replyBootstrap = reply; return }
      return reply()
    }
    if (req.url === '/api/app/register') {
      let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
        registrationCount++
        assert.deepEqual(JSON.parse(raw), { username: 'new-child', password: 'child-password' })
        assert.equal(req.headers['x-csrf-token'], 'fixture')
        assert.ok(String(req.headers.cookie).includes('csrf=fixture'))
        assert.ok(!String(req.headers.cookie).includes('session='))
        json({ registrationStatus: 'pending', message: '注册成功，请等待管理员开通' }, 201)
      }); return
    }
    if (req.url === '/api/app/login') {
      let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
        loginCount++
        const body = JSON.parse(raw)
        assert.ok(!String(req.headers.cookie).includes('session='))
        if (body.username !== 'user' || body.password !== 'correct-password') return json({ error: 'wrong' }, 401)
        if (req.headers['x-csrf-token'] !== 'fixture' || !String(req.headers.cookie).includes('csrf=fixture')) return json({ error: 'csrf' }, 403)
        res.setHeader('set-cookie', 'session=fixture; Path=/; HttpOnly; Max-Age=3600; SameSite=Strict')
        json({ user: { id: 'fixture-user', username: 'user', role: loginRole }, csrfToken: 'fixture' })
      }); return
    }
    if (req.url === '/api/app/admin/desktop-hosts') {
      enrollmentCount++
      assert.equal(req.headers.origin, url)
      assert.equal(req.headers['x-csrf-token'], 'fixture')
      assert.ok(String(req.headers.cookie).includes('session=fixture'))
      // Exercise authorization without provisioning a real computer in the fixture.
      return json({ error: 'enrollment unavailable' }, 503)
    }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<title>已登录远程夭夭</title><h1>远程工作区</h1>')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  let app
  try {
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env,
      HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_TEST_MODE: 'ask', HERMES_YAOYAO_DESKTOP_TEST_SYNC: '0' } })
    const page = await app.firstWindow()
    // The connectivity check can succeed through Chromium while Node sockets
    // are unavailable (for example, after a macOS local-network permission change).
    await app.evaluate(({ session }, origin) => {
      globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'EHOSTUNREACH' } }) }
      return session.defaultSession.cookies.set({ url: origin, name: 'session', value: 'previous-account', httpOnly: true })
    }, url)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await expect(page.getByRole('heading', { name: '开始使用夭夭' })).toBeVisible()
    assert.equal(app.windows().length, 1)
    assert.equal((await page.evaluate(() => window.yaoyaoDesktop.status())).mode, null)
    await page.getByRole('radio', { name: /连接远程服务器/ }).check()
    await page.locator('#server').fill('http://127.0.0.1:1')
    await page.locator('#detect').click()
    await expect(page.locator('#status[role=alert]')).toBeVisible()
    await expect(page.locator('#login-form')).toBeHidden()
    await page.locator('#server').fill(url)
    await page.locator('#detect').click()
    await expect(page.locator('#status')).toHaveText('连接成功，服务器已就绪')
    await expect(page.locator('#login-form')).toBeVisible()
    assert.match(page.url(), /boot.html$/)
    await page.locator('#register-toggle').click()
    await page.locator('#username').fill('new-child')
    await page.locator('#password').fill('child-password')
    await page.locator('#confirmation').fill('child-password')
    await page.locator('#submit').click()
    await expect(page.locator('#registration-notice')).toContainText('注册成功，请等待管理员开通')
    await expect(page.locator('#confirmation-field')).toBeHidden()
    assert.equal(registrationCount, 1)
    assert.equal(loginCount, 0, 'registration never signs in or authorizes this computer')
    assert.equal(await app.evaluate(async ({ session }, origin) =>
      (await session.defaultSession.cookies.get({ url: origin, name: 'session' }))[0]?.value, url),
    'previous-account', 'registration does not replace the active browser session')
    assert.match(page.url(), /boot.html$/)
    await page.locator('#username').fill('user')
    await page.locator('#password').fill('wrong-password')
    await page.locator('#submit').click()
    await expect(page.locator('#login-error')).toContainText('用户名或密码不正确')
    assert.equal(await page.locator('#password').inputValue(), '')
    // Editing the address invalidates the checked target and hides credentials.
    await page.locator('#server').fill('http://another-server.test')
    await expect(page.locator('#login-form')).toBeHidden()
    await page.locator('#server').fill(url); await page.locator('#detect').click()
    assert.equal(await page.locator('#username').inputValue(), '')
    await page.locator('#username').fill('user')
    await page.locator('#password').fill('correct-password')
    await page.locator('#toggle-password').click()
    assert.equal(await page.locator('#password').getAttribute('type'), 'text')
    await page.locator('#toggle-password').click()
    await page.locator('#remember').check()
    await mkdir(join(root, 'docs/design/desktop-onboarding'), { recursive: true })
    await page.emulateMedia({ colorScheme: 'light' })
    assert.equal(await page.evaluate(() => document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight), true, 'default window shows its footer without scrolling')
    await page.screenshot({ path: join(root, 'docs/design/desktop-onboarding/remote-login.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: join(root, 'docs/design/desktop-onboarding/remote-dark.png') })
    await page.setViewportSize({ width: 720, height: 560 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(root, 'docs/design/desktop-onboarding/remote-narrow.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 832 })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.locator('#submit').click()
    await page.waitForURL(url + '/**')
    await expect(page.getByRole('heading', { name: '远程工作区' })).toBeVisible()
    assert.equal(app.windows().length, 1); assert.equal(loginCount, 2)
    const preferences = JSON.parse(await readFile(join(home, 'desktop-preferences.json'), 'utf8'))
    assert.equal(preferences.startupChoice, 'remote'); assert.equal(preferences.remoteServer, url)
    assert.deepEqual(errors, [])
    // The HTTP renderer cannot invoke privileged native setup/authentication.
    assert.deepEqual(await page.evaluate(() => Promise.all([
      window.yaoyaoDesktop.status(), window.yaoyaoDesktop.selectServer('local'),
      window.yaoyaoDesktop.prepareServer({}), window.yaoyaoDesktop.login({ username: 'x', password: 'y' }),
    ].map(promise => promise.then(() => false, () => true)))), [true, true, true, true])
    const firstProcess = app.process()
    const firstExit = firstProcess.exitCode === null ? new Promise(done => firstProcess.once('exit', done)) : Promise.resolve()
    await app.close(); await firstExit; app = undefined
    holdBootstrap = true
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env,
      HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_TEST_MODE: 'ask', HERMES_YAOYAO_DESKTOP_TEST_SYNC: '0' } })
    const reopened = await app.firstWindow()
    await expect.poll(() => Boolean(replyBootstrap)).toBe(true)
    await expect(reopened.locator('#session-loading')).toBeVisible()
    await expect(reopened.locator('#onboarding')).toBeHidden()
    await mkdir(join(root, 'test-results/desktop'), { recursive: true })
    await reopened.screenshot({ path: join(root, 'test-results/desktop/session-restoring.png') })
    let guideFlashed = false
    await reopened.exposeFunction('recordGuideVisibility', visible => { guideFlashed ||= visible })
    await reopened.evaluate(() => {
      const guide = document.getElementById('onboarding')
      new MutationObserver(() => { void window.recordGuideVisibility(!guide.hidden) }).observe(guide, { attributes: true, attributeFilter: ['hidden'] })
    })
    holdBootstrap = false; replyBootstrap()
    try { await reopened.waitForURL(url + '/**', { timeout: 8000 }) }
    catch (error) {
      console.log('Reopened fixture URL:', reopened.url())
      console.log('Reopened fixture state:', await reopened.evaluate(() => window.yaoyaoDesktop.status().catch(error => ({ error: error.message }))))
      console.log('Fixture cookie metadata:', await app.evaluate(async ({ session }, url) => (await session.defaultSession.cookies.get({ url })).map(({ name, expirationDate, sameSite, session }) => ({ name, expirationDate, sameSite, session })), url))
      throw error
    }
    assert.equal(loginCount, 2, 'a remembered session keeps the server-provided cookie expiry and is reused')
    assert.equal(guideFlashed, false, 'restoring a valid session never displays the guide')
    // An expired session still returns to the same page with usable login fields.
    sessionValid = false
    await reopened.evaluate(() => { void window.yaoyaoDesktop.openLogin() })
    await expect(reopened.locator('#login-form')).toBeVisible()
    await expect(reopened.locator('#session-loading')).toBeHidden()
    assert.equal(app.windows().length, 1)
    loginRole = 'admin'
    await app.evaluate(() => {
      globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'EHOSTUNREACH' } }) }
    })
    await reopened.locator('#username').fill('user')
    await reopened.locator('#password').fill('correct-password')
    await reopened.locator('#submit').click()
    await expect(reopened.locator('#login-error')).toContainText('账号已登录，但电脑授权未恢复')
    assert.equal(enrollmentCount, 1, 'computer authorization also uses the reachable Chromium transport')
    assert.equal((await reopened.evaluate(() => window.yaoyaoDesktop.status())).authenticated, true)
    await reopened.locator('#submit').click()
    await reopened.waitForURL(url + '/**')
  } finally {
    await app?.close().catch(() => {})
    await new Promise(done => { server.close(done); server.closeAllConnections() })
    await rm(home, { recursive: true, force: true })
  }
})
