import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { _electron as electron, expect } from '@playwright/test'
import { dataKey } from './service-manager.mjs'

test('the main local app checks updates in place and denies other renderers', { timeout: 60000 }, async () => {
  const root = resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'yaoyao-update-entry-')))
  const version = JSON.parse(await readFile(join(root, '.desktop-build/release.json'), 'utf8')).webVersion
  const identity = { protocol: 1, instanceId: 'update-entry', pid: process.pid, dataKey: dataKey(home), version }
  // Let Playwright attach to the boot renderer before the fixture changes its URL.
  let releaseIdentity
  const identityReady = new Promise(resolve => { releaseIdentity = resolve })
  const server = createServer(async (req, res) => {
    if (req.url === '/desktop/service/session') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({user:{role:'admin',localDesktop:true},setCookies:['hermes_yaoyao_session=fixture; Path=/; HttpOnly; Max-Age=31536000']})); return }
    if (req.url === '/api/app/desktop-session') { res.setHeader('Set-Cookie','hermes_yaoyao_session=fixture; Path=/; HttpOnly; Max-Age=31536000'); res.end('{}'); return }
    if (req.url === '/desktop/service') { await identityReady; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(identity)) }
    else if(req.url.split('?')[0]==='/api/app/bootstrap'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:true,csrfToken:'fixture'}))}
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<title>Update entry fixture</title><button onclick="window.yaoyaoDesktop.openUpdates()">检测更新</button>') }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(home, 'service-instance.json'), JSON.stringify({ ...identity, url: origin, token: 'fixture' }))
  let app
  try {
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_PORT: String(server.address().port), HERMES_YAOYAO_DESKTOP_TEST_SYNC: '0' } })
    const page = await app.firstWindow()
    releaseIdentity()
    await page.waitForURL(origin + '/**')
    await app.evaluate(({ net }) => { net.fetch = async () => new Response('', { status: 403 }) })
    await page.getByRole('button', { name: '检测更新', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.yaoyaoDesktop.updateState().then(state => state.error))).toContain('GitHub 请求受限')
    await expect(page.locator('#desktop-update-error')).toContainText('GitHub 请求受限')
    await page.evaluate(() => window.yaoyaoDesktop.openUpdates())
    assert.equal(app.windows().length, 1)
    const denied = await app.evaluate(async ({ BrowserWindow }, { origin, preload }) => {
      const outsider = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload } })
      try {
        await outsider.loadURL(origin)
        return await outsider.webContents.executeJavaScript('window.yaoyaoDesktop.openUpdates().then(() => false, () => true)')
      } finally { outsider.destroy() }
    }, { origin, preload: join(root, 'desktop/preload.cjs') })
    assert.equal(denied, true)
    assert.equal(server.listening, true)
  } finally {
    releaseIdentity()
    await app?.close().catch(() => {})
    await new Promise(done => server.close(done))
    await rm(home, { recursive: true, force: true })
  }
})

test('client mode checks local App updates in place without a local service or admin role', { timeout: 60000 }, async () => {
  const root = resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(join(tmpdir(), 'yaoyao-client-update-')))
  const remote = createServer((req, res) => {
    if (req.url === '/desktop/service/session') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({user:{role:'admin',localDesktop:true},setCookies:['hermes_yaoyao_session=fixture; Path=/; HttpOnly; Max-Age=31536000']})); return }
    if (req.url === '/api/app/desktop-session') { res.setHeader('Set-Cookie','hermes_yaoyao_session=fixture; Path=/; HttpOnly; Max-Age=31536000'); res.end('{}'); return }
    if (req.url.split('?')[0] === '/api/app/bootstrap') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ authenticated: true, csrfToken: 'fixture', user: { role: 'member' } })) }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<title>Remote member</title><button onclick="window.yaoyaoDesktop.openUpdates()">App update</button>') }
  })
  await new Promise(done => remote.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${remote.address().port}`
  await writeFile(join(home, 'desktop-preferences.json'), JSON.stringify({ startupChoice: 'remote', remoteServer: origin }))
  let app
  try {
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_PORT: '1', HERMES_YAOYAO_DESKTOP_TEST_SYNC: '0' } })
    const page = await app.firstWindow(); await page.waitForURL(origin + '/**')
    assert.equal((await page.evaluate(() => window.yaoyaoDesktop.modeState())).mode, 'client')
    assert.equal(await page.evaluate(() => typeof window.yaoyaoUpdate), 'undefined')
    await app.evaluate(({ net }) => { net.fetch = async () => new Response('', { status: 403 }) })
    await page.getByRole('button', { name: 'App update' }).click()
    await expect.poll(() => page.evaluate(() => window.yaoyaoDesktop.updateState().then(state => state.error))).toContain('GitHub 请求受限')
    await expect(page.locator('#desktop-update-error')).toContainText('GitHub 请求受限')
    assert.equal(app.windows().length, 1)
    const denied = await app.evaluate(async ({ BrowserWindow }, { origin, preload }) => {
      const outsider = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload } })
      try {
        await outsider.loadURL(origin)
        return await outsider.webContents.executeJavaScript("Promise.all([window.yaoyaoDesktop.updateState(),window.yaoyaoDesktop.updateAction('check'),window.yaoyaoDesktop.updateAction('download'),window.yaoyaoDesktop.updateAction('install')].map(p=>p.then(()=>false,()=>true)))")
      } finally { outsider.destroy() }
    }, { origin, preload: join(root, 'desktop/preload.cjs') })
    assert.deepEqual(denied, [true, true, true, true])
    assert.equal(remote.listening, true)
  } finally {
    await app?.close().catch(() => {})
    await new Promise(done => { remote.close(done); remote.closeAllConnections() })
    await rm(home, { recursive: true, force: true })
  }
})
