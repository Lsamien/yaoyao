import { enterLocal } from './test-support/onboarding.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, rm, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { _electron as electron } from '@playwright/test'
import { localJSON, DesktopServiceManager } from './service-manager.mjs'

const root = resolve(import.meta.dirname, '..')
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve));return port
}
async function until(read, accept, timeout = 30000) {
  const end = Date.now() + timeout;let value
  while (Date.now() < end) {
    try { value = await read(); if (accept(value)) return value } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('等待验收状态超时')
}

test('real desktop launches its bundled service, survives window close and recovers its own crashed child', { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'yaoyao-desktop-e2e-'))
  const port = await freePort(), upstreamPort = await freePort()
  const upstream = spawn(process.execPath, [join(root, 'tests/fixtures/fake-hermes.mjs')], {
    cwd: root, env: { ...process.env, FAKE_HERMES_PORT: String(upstreamPort), FAKE_HERMES_LOCAL_AUTH: '1' }, stdio: 'ignore',
  })
  let desktop
  let servicePID, runnerPID, runnerID
  try {
    await until(() => localJSON(`http://127.0.0.1:${upstreamPort}/api/status`), Boolean)
    desktop = await electron.launch({ ...(process.env.DESKTOP_TEST_EXECUTABLE ? { executablePath: process.env.DESKTOP_TEST_EXECUTABLE } : {}),
      args: process.env.DESKTOP_TEST_EXECUTABLE ? [] : [root], cwd: root, env: { ...process.env,
      HERMES_YAOYAO_DESKTOP_TEST_HOME: home, HERMES_YAOYAO_DESKTOP_PORT: String(port),
      HERMES_YAOYAO_UPSTREAM: `http://127.0.0.1:${upstreamPort}` }, timeout: 30000 })
    desktop.process().stderr.on('data', b => { if (process.env.DESKTOP_TEST_LOGS) process.stderr.write(b) })
    const page = await desktop.firstWindow()
    await enterLocal(page)
    await page.waitForURL(`http://127.0.0.1:${port}/**`, { timeout: 30000 })
    const owner = await until(async () => JSON.parse(await readFile(join(home, 'service-instance.json'), 'utf8')), r => r.url)
    servicePID = owner.pid
    const identity = await localJSON(`http://127.0.0.1:${port}/desktop/service`, { 'x-yaoyao-desktop-token': owner.token })
    assert.equal(identity.pid, owner.pid);assert.equal(identity.desktopOwned, true)
    assert.equal(identity.token, undefined)
    assert.ok((await localJSON(`http://127.0.0.1:${port}/healthz`)).ok)
    const denied = await page.evaluate(async () => {
      try { await window.yaoyaoDesktop.retry();return false } catch { return true }
    })
    assert.equal(denied, true, 'the web app must not have the boot screen native control privilege')
    const registration=await page.evaluate(async()=>{
      const bootstrap=await (await fetch('/api/app/bootstrap')).json()
      const headers={'Content-Type':'application/json','X-CSRF-Token':bootstrap.csrfToken}
      const setup=await fetch('/api/app/login',{method:'POST',headers,body:JSON.stringify({username:'desktop-fixture',password:'desktop-fixture-password'})})
      if(!setup.ok)throw new Error('fixture setup failed')
      headers['X-CSRF-Token']=(await (await fetch('/api/app/bootstrap')).json()).csrfToken
      const response=await fetch('/api/app/admin/runners',{method:'POST',headers,body:JSON.stringify({name:'桌面验收节点',allowedProfiles:['default']})})
      if(!response.ok)throw new Error(`fixture registration failed HTTP ${response.status}: ${(await response.json()).code}`)
      return response.json()
    })
    runnerID=registration.runner.id
    const configuration={protocol:1,runnerId:runnerID,token:registration.token,serverURL:`http://127.0.0.1:${port}`,hermesURL:`http://127.0.0.1:${upstreamPort}`,allowedProfiles:['default'],artifactRoots:[]}
    const imported=join(home,'downloaded-runner.json');await writeFile(imported,JSON.stringify(configuration),{mode:0o600})
    await desktop.evaluate(({dialog,Menu},path)=>{
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})
      Menu.getApplicationMenu().getMenuItemById('runner-import').click()
    },imported)
    await until(()=>page.evaluate(async()=>{const data=await (await fetch('/api/app/admin/runners')).json();return data.runners?.some(r=>r.online)}),Boolean)
    const encrypted=await readFile(join(home,'desktop-runner.enc'))
    assert.equal(encrypted.includes(registration.token),false)
    assert.equal((await stat(join(home,'desktop-runner.enc'))).mode&0o077,0)
    runnerPID=JSON.parse(await readFile(join(home,'runner-state',runnerID,'service-instance.json'),'utf8')).pid
    await rm(imported)

    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    assert.ok((await localJSON(`http://127.0.0.1:${port}/healthz`)).ok)
    await desktop.evaluate(({ app }) => app.emit('activate'))
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
    await mkdir(join(root, 'test-results/desktop'), { recursive: true })
    await page.screenshot({ path: join(root, 'test-results/desktop/first-launch.png') })
    process.kill(owner.pid, 'SIGKILL')
    const replacement = await until(async () => JSON.parse(await readFile(join(home, 'service-instance.json'), 'utf8')), r => r.pid !== owner.pid && r.url)
    servicePID = replacement.pid
    await until(() => localJSON(`http://127.0.0.1:${port}/healthz`), r => r.ok)
    assert.notEqual(replacement.instanceId, owner.instanceId)
    await until(()=>page.evaluate(async()=>{const data=await (await fetch('/api/app/admin/runners')).json();return data.runners?.some(r=>r.online)}),Boolean)
    const updateStatus=await page.evaluate(async()=>await (await fetch('/api/app/system/update/status')).json())
    assert.equal(updateStatus.installationMode,'desktop');assert.equal(updateStatus.supported,false)
    assert.equal(await desktop.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('desktop-background').checked),false)
    await desktop.evaluate(async({Menu})=>{const item=Menu.getApplicationMenu().getMenuItemById('desktop-background');await item.click(item)})
    assert.deepEqual(await until(async()=>JSON.parse(await readFile(join(home,'desktop-preferences.json'),'utf8')),value=>value.backgroundAtLogin===true,5000),{backgroundAtLogin:true,startupChoice:'ask',remoteServer:''})
    const external = new DesktopServiceManager({ home, port, fork: () => { throw new Error('must not fork a second service') } })
    assert.equal((await external.start()).external, true)
    await external.stop()
    assert.ok((await localJSON(`http://127.0.0.1:${port}/healthz`)).ok, 'a connected client must not stop the owned service')
    await desktop.close();desktop = null
    await until(async () => { try { process.kill(replacement.pid, 0);return false } catch { return true } }, Boolean, 10000)
    await until(async()=>{try{process.kill(runnerPID,0);return false}catch{return true}},Boolean,10000)
    desktop=await electron.launch({...(process.env.DESKTOP_TEST_EXECUTABLE?{executablePath:process.env.DESKTOP_TEST_EXECUTABLE}:{}),args:process.env.DESKTOP_TEST_EXECUTABLE?[]:[root],cwd:root,env:{...process.env,HERMES_YAOYAO_DESKTOP_TEST_HOME:home,HERMES_YAOYAO_DESKTOP_PORT:String(port),HERMES_YAOYAO_UPSTREAM:`http://127.0.0.1:${upstreamPort}`}})
    const reopened=await desktop.firstWindow();await reopened.waitForURL(`http://127.0.0.1:${port}/**`)
    await until(()=>reopened.evaluate(async()=>{const data=await (await fetch('/api/app/admin/runners')).json();return data.runners?.some(r=>r.online)}),Boolean)
    assert.equal(await desktop.evaluate(({Menu})=>Menu.getApplicationMenu().getMenuItemById('desktop-background').checked),true)
    assert.equal(await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true,'manual reopening still shows the window')
    servicePID=JSON.parse(await readFile(join(home,'service-instance.json'),'utf8')).pid
    runnerPID=JSON.parse(await readFile(join(home,'runner-state',runnerID,'service-instance.json'),'utf8')).pid
    await desktop.close();desktop=null
    await until(async()=>{try{process.kill(runnerPID,0);return false}catch{return true}},Boolean,10000)
  } finally {
    await desktop?.close().catch(() => {})
    if(runnerPID){try{process.kill(runnerPID,'SIGTERM')}catch{}}
    if (servicePID) { try { process.kill(servicePID, 'SIGTERM') } catch {} }
    upstream.kill('SIGTERM')
    const account=createHash('sha256').update(await realpath(home)).digest('hex')
    await promisify(execFile)('/usr/bin/security',['delete-generic-password','-s','cn.samien.yaoyao.runner-key.v1','-a',account]).catch(()=>{})
    await rm(home, { recursive: true, force: true })
  }
})
