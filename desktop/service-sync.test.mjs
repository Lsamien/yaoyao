import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, cp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { _electron as electron } from '@playwright/test'
import { LaunchAgentService, localRequest, synchronizeDesktop } from '../bin/lib/service-update.mjs'
import { sealRuntime, verifyRuntimePackage } from '../bin/lib/runtime-release.mjs'

const root = resolve(import.meta.dirname, '..')
const payloadRoot = process.env.DESKTOP_TEST_EXECUTABLE
  ? resolve(dirname(process.env.DESKTOP_TEST_EXECUTABLE), '../Resources/runtime/web-service')
  : join(root, '.desktop-build', 'web-service')
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port; await new Promise(done => server.close(done)); return port
}
async function until(read, accept, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value } catch {}
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error('等待同步服务状态超时')
}
async function nativeQuit(app, menu = false) {
  let exited=false;app.process().once('exit',()=>{exited=true})
  let output='';app.process().stdout.on('data',bytes=>{output+=bytes})
  await app.evaluate(({app,BrowserWindow})=>{
    const navigations=[]
    BrowserWindow.getAllWindows()[0].webContents.on('did-start-navigation',(_event,url)=>navigations.push(url))
    app.once('will-quit',()=>console.log('QUIT_TEST_NAVIGATIONS='+JSON.stringify(navigations)))
  })
  await app.evaluate(({app,Menu},menu)=>{if(menu)Menu.getApplicationMenu().getMenuItemById('desktop-quit').click();else app.quit()},menu)
  await until(()=>exited,Boolean,10000)
  const proof=output.match(/QUIT_TEST_NAVIGATIONS=(\[[^\n]*\])/)
  assert.ok(proof,'native will-quit must complete')
  assert.equal(JSON.parse(proof[1]).some(url=>url.includes('boot.html')),false,'native quit must not navigate to a stopped boot page')
  await app.close().catch(()=>{})
}

test('App first launch installs an independent Web; Web remains up after quit and a newer Web is retained', { timeout: 150000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'yaoyao-sync-native-')))
  const port = await freePort(), upstreamPort = await freePort()
  const releaseRoot = join(home, 'updates', 'fixture-releases')
  const label = `cn.samien.yaoyao.sync-test.${createHash('sha256').update(home).digest('hex').slice(0, 16)}`
  const driver = new LaunchAgentService({ home, port, releaseRoot, label, plistPath: join(home, 'updates', 'fixture-service.plist') })
  const upstream = spawn(process.execPath, [join(root, 'tests/fixtures/fake-hermes.mjs')], {
    cwd: root, env: { ...process.env, FAKE_HERMES_PORT: String(upstreamPort), FAKE_HERMES_LOCAL_AUTH: '1' }, stdio: 'ignore',
  })
  let app
  const launch = () => electron.launch({
    ...(process.env.DESKTOP_TEST_EXECUTABLE ? { executablePath: process.env.DESKTOP_TEST_EXECUTABLE } : {}),
    args: process.env.DESKTOP_TEST_EXECUTABLE ? [] : [root], cwd: root,
    env: { ...process.env, HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_PORT: String(port),
      HERMES_YAOYAO_DESKTOP_TEST_SYNC: '1', HERMES_YAOYAO_UPSTREAM: `http://127.0.0.1:${upstreamPort}` }, timeout: 30000,
  })
  try {
    await until(() => localRequest(`http://127.0.0.1:${upstreamPort}/api/status`), value => value.status === 200)
    app = await launch()
    const page = await app.firstWindow()
    await page.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: 90000 })
    const record = JSON.parse(await readFile(join(home, 'service-instance.json'), 'utf8'))
    assert.equal(record.desktopOwned, false)
    const identity = await localRequest(`http://127.0.0.1:${port}/desktop/service`, record.token)
    const original = verifyRuntimePackage(payloadRoot)
    assert.equal(identity.body.build.artifactDigest, original.artifactDigest)
    assert.equal(identity.body.quiesced, false)
    const support = await page.evaluate(async () => {
      const bootstrap = await (await fetch('/api/app/bootstrap')).json()
      const setup = await fetch('/api/app/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken },
        body: JSON.stringify({ username: 'sync-fixture', password: 'sync-fixture-password' }) })
      if (!setup.ok) throw new Error('验收账号创建失败')
      return (await fetch('/api/app/system/update/status')).json()
    })
    assert.equal(support.installationMode, 'release'); assert.equal(support.supported, true)
    await nativeQuit(app); app = undefined
    assert.equal((await localRequest(`http://127.0.0.1:${port}/healthz`)).body.ok, true)
    assert.equal(driver.pid(), record.pid, 'quitting the App must leave the independent Web running')
    const saved = driver.snapshot().plist
    saved.EnvironmentVariables.YAOYAO_TEST_PRESERVE = 'keep-existing-settings'
    driver.writePlist(saved)

    // Install a later release through the same transaction engine used by Web's updater.
    const newer = join(home, 'updates', 'newer-package')
    const [major, minor, patch] = original.version.split('.').map(Number)
    const newerVersion = `${major}.${minor}.${patch + 1}`
    await cp(payloadRoot, newer, { recursive: true })
    await writeFile(join(newer, 'release.json'), JSON.stringify({ schemaVersion: 1, releaseVersion: newerVersion, webVersion: newerVersion, gitTag: `v${newerVersion}` }))
    const build = JSON.parse(await readFile(join(newer, 'build-info.json'), 'utf8'))
    await writeFile(join(newer, 'build-info.json'), JSON.stringify({ ...build, commit: 'c'.repeat(40), ancestors: [build.commit, ...build.ancestors], dirty: false }))
    sealRuntime(newer)
    await synchronizeDesktop({ home, runtimeRoot: newer, releaseRoot, driver })
    const updated = JSON.parse(await readFile(join(home, 'service-instance.json'), 'utf8'))
    assert.equal(updated.version, newerVersion); assert.notEqual(updated.pid, record.pid)
    assert.equal(driver.snapshot().plist.EnvironmentVariables.YAOYAO_TEST_PRESERVE, 'keep-existing-settings')
    app = await launch()
    const reopened = await app.firstWindow(); await reopened.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: 90000 })
    assert.equal(driver.pid(), updated.pid, 'older App must retain the newer Web without restarting it')
    const marker = JSON.parse(await readFile(join(home, 'updates', 'desktop-sync.json'), 'utf8'))
    assert.equal(marker.action, 'newer')
    assert.equal(marker.artifactDigest, original.artifactDigest)
    // Keep an authenticated event stream open. Stop-and-quit must close it,
    // unload launchd (not just kill its PID), and exit with one menu action.
    await reopened.evaluate(async()=>{
      const capabilities=await (await fetch('/api/realtime/capabilities')).json()
      const created=await fetch('/api/realtime/channels',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':capabilities.csrfToken},body:JSON.stringify({channel:'chat'})})
      if(!created.ok)throw new Error('fixture realtime channel unavailable')
      const channel=await created.json()
      const response=await fetch(`/api/realtime/channels/${channel.id}/events`)
      if(!response.ok)throw new Error('fixture event stream unavailable')
      if(!response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('expected a real SSE stream')
      window.stopTestStream=response.body.getReader()
      void window.stopTestStream.read()
    })
    let exited=false;app.process().once('exit',()=>{exited=true})
    await app.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('desktop-stop-and-quit').click())
    await until(()=>exited,Boolean,30000);app=undefined
    assert.equal(driver.pid(),undefined)
    assert.equal(driver.listeners().size,0)
    await new Promise(done=>setTimeout(done,1000))
    assert.equal(driver.pid(),undefined,'launchd must not relaunch a deliberately stopped service')
    app = await launch()
    const restarted = await app.firstWindow(); await restarted.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: 90000 })
    const resumed = JSON.parse(await readFile(join(home, 'service-instance.json'), 'utf8'))
    assert.equal(resumed.version, newerVersion); assert.equal(resumed.desktopOwned, false)
    assert.notEqual(resumed.pid, updated.pid)
    await nativeQuit(app,true); app = undefined
  } catch (error) {
    // Only this fixture's server log, which contains startup diagnostics.
    const log = await readFile(join(home, 'service.log'), 'utf8').catch(() => '')
    if (log) process.stderr.write(log.slice(-3000))
    throw error
  } finally {
    await app?.close().catch(() => {})
    await driver.stop()
    upstream.kill('SIGTERM')
    await rm(home, { recursive: true, force: true })
  }
})
