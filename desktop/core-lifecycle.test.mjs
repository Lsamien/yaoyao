import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:net'
import {spawn} from 'node:child_process'
import {_electron as electron} from '@playwright/test'
import {localJSON,DesktopServiceManager} from './service-manager.mjs'
const root=resolve(import.meta.dirname,'..')
const release=JSON.parse(await readFile(join(root,'release.json'),'utf8'))
async function freePort(){const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));return port}
async function until(read,accept,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{const value=await read();if(accept(value))return value}catch{}await new Promise(done=>setTimeout(done,100))}throw new Error('等待桌面状态超时')}
test('packaged core service starts, preserves window-close work, recovers, and stops only its own service',{timeout:60000},async()=>{
  const home=await mkdtemp(join(tmpdir(),'yaoyao-app-core-')),port=await freePort(),upstreamPort=await freePort()
  const upstream=spawn(process.execPath,[join(root,'tests/fixtures/fake-hermes.mjs')],{cwd:root,env:{...process.env,FAKE_HERMES_PORT:String(upstreamPort),FAKE_HERMES_LOCAL_AUTH:'1'},stdio:'ignore'})
  let app,pid
  try{
    await until(()=>localJSON(`http://127.0.0.1:${upstreamPort}/api/status`),Boolean)
    app=await electron.launch({...(process.env.DESKTOP_TEST_EXECUTABLE?{executablePath:process.env.DESKTOP_TEST_EXECUTABLE}:{}),args:process.env.DESKTOP_TEST_EXECUTABLE?[]:[root],cwd:root,env:{...process.env,HERMES_YAOYAO_DESKTOP_TEST_HOME:home,HERMES_YAOYAO_DESKTOP_PORT:String(port),HERMES_YAOYAO_UPSTREAM:`http://127.0.0.1:${upstreamPort}`},timeout:30000})
    const page=await app.firstWindow();await page.waitForURL(`http://127.0.0.1:${port}/**`)
    const initial=JSON.parse(await readFile(join(home,'service-instance.json'),'utf8'));pid=initial.pid
    const identity=await localJSON(`http://127.0.0.1:${port}/desktop/service`,{'x-yaoyao-desktop-token':initial.token})
    assert.equal(identity.desktopOwned,true);assert.equal(identity.pid,pid);assert.equal(identity.version,release.webVersion)
    assert.equal(await page.evaluate(async()=>{try{await window.yaoyaoDesktop.retry();return false}catch{return true}}),true)
    await mkdir(join(root,'test-results/desktop'),{recursive:true});await page.screenshot({path:join(root,'test-results/desktop/packaged-core.png')})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false)
    assert.equal((await localJSON(`http://127.0.0.1:${port}/healthz`)).ok,true)
    await app.evaluate(({app})=>app.emit('activate'))
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true)
    process.kill(pid,'SIGKILL')
    const replacement=await until(async()=>JSON.parse(await readFile(join(home,'service-instance.json'),'utf8')),value=>value.pid!==initial.pid&&value.url)
    pid=replacement.pid;assert.notEqual(replacement.instanceId,initial.instanceId)
    await until(()=>localJSON(`http://127.0.0.1:${port}/healthz`),value=>value.ok)
    const attached=new DesktopServiceManager({home,port,fork:()=>{throw new Error('必须复用已有服务')}})
    assert.equal((await attached.start()).external,true);await attached.stop()
    assert.equal((await localJSON(`http://127.0.0.1:${port}/healthz`)).ok,true)
    await app.close();app=undefined
    await until(()=>{try{process.kill(pid,0);return false}catch{return true}},Boolean,10000)
  }finally{await app?.close().catch(()=>{});if(pid)try{process.kill(pid,'SIGTERM')}catch{}upstream.kill('SIGTERM');await rm(home,{recursive:true,force:true})}
})
