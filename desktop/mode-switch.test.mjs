import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {_electron as electron,expect} from '@playwright/test'
import {dataKey} from './service-manager.mjs'

test('signed-in desktop pages can switch both ways; other windows cannot control the runtime',{timeout:60000},async()=>{
  const root=resolve(import.meta.dirname,'..'),home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-mode-switch-')))
  const version=JSON.parse(await readFile(join(root,'.desktop-build/release.json'),'utf8')).webVersion
  const identity={protocol:1,instanceId:'mode-switch',pid:process.pid,dataKey:dataKey(home),version}
  let releaseIdentity
  const identityReady=new Promise(resolve=>{releaseIdentity=resolve})
  const local=createServer(async(req,res)=>{
    if(req.url==='/desktop/service'){await identityReady;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(identity))}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>已登录的本机页面</title>')}
  })
  const remote=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>已登录的服务器页面</title>')})
  await new Promise(done=>local.listen(0,'127.0.0.1',done))
  await new Promise(done=>remote.listen(0,'127.0.0.1',done))
  const origin=`http://127.0.0.1:${local.address().port}`,remoteURL=`http://127.0.0.1:${remote.address().port}`
  await writeFile(join(home,'service-instance.json'),JSON.stringify({...identity,url:origin,token:'fixture'}))
  await writeFile(join(home,'desktop-preferences.json'),JSON.stringify({startupChoice:'local',remoteServer:remoteURL,backgroundAtLogin:false}))
  let app
  try{
    app=await electron.launch({args:[root],cwd:root,env:{...process.env,HERMES_YAOYAO_DESKTOP_TEST_HOME:home,HERMES_YAOYAO_DESKTOP_PORT:String(local.address().port),HERMES_YAOYAO_DESKTOP_TEST_SYNC:'0'}})
    const page=await app.firstWindow();releaseIdentity();await page.waitForURL(origin+'/**')
    assert.deepEqual(await page.evaluate(()=>window.yaoyaoDesktop.modeState()),{mode:'server',serverURL:origin,switching:false})
    assert.deepEqual(await page.evaluate(()=>window.yaoyaoDesktop.authorizeComputer('csrf-test')),{registered:false})
    assert.equal(await page.evaluate(()=>window.yaoyaoDesktop.switchMode('invalid').then(()=>false,()=>true)),true)
    await page.evaluate(()=>{void window.yaoyaoDesktop.switchMode('client')})
    await page.waitForURL(remoteURL+'/**')
    assert.deepEqual(await page.evaluate(()=>window.yaoyaoDesktop.modeState()),{mode:'client',serverURL:remoteURL,switching:false})
    await expect.poll(async()=>JSON.parse(await readFile(join(home,'desktop-preferences.json'),'utf8')).startupChoice).toBe('remote')
    // Unchecking "ask at startup" must retain the active client role.
    await app.evaluate(({Menu})=>{const item=Menu.getApplicationMenu().getMenuItemById('desktop-host-ask');item.click(item)})
    await expect.poll(async()=>JSON.parse(await readFile(join(home,'desktop-preferences.json'),'utf8')).startupChoice).toBe('ask')
    await app.evaluate(({Menu})=>{const item=Menu.getApplicationMenu().getMenuItemById('desktop-host-ask');item.click(item)})
    await expect.poll(async()=>JSON.parse(await readFile(join(home,'desktop-preferences.json'),'utf8')).startupChoice).toBe('remote')
    const denied=await app.evaluate(async({BrowserWindow},{origin,preload})=>{
      const outsider=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,preload}})
      try{
        await outsider.loadURL(origin)
        return await outsider.webContents.executeJavaScript('Promise.all([window.yaoyaoDesktop.modeState(),window.yaoyaoDesktop.switchMode("server"),window.yaoyaoDesktop.openRemoteLogin(),window.yaoyaoDesktop.authorizeComputer("csrf-test")].map(p=>p.then(()=>false,()=>true)))')
      }finally{outsider.destroy()}
    },{origin:remoteURL,preload:join(root,'desktop/preload.cjs')})
    assert.deepEqual(denied,[true,true,true,true])
    await page.evaluate(()=>{void window.yaoyaoDesktop.switchMode('server')})
    await page.waitForURL(origin+'/**')
    await expect.poll(()=>page.evaluate(()=>window.yaoyaoDesktop.modeState())).toEqual({mode:'server',serverURL:origin,switching:false})
    assert.equal(JSON.parse(await readFile(join(home,'desktop-preferences.json'),'utf8')).startupChoice,'local')
    assert.equal(local.listening,true,'switching must leave an independent service running')
    assert.equal(remote.listening,true)
    // The server picker remains available after either login/mode selection.
    const opened=app.waitForEvent('window');await page.evaluate(()=>window.yaoyaoDesktop.openRemoteLogin())
    const login=await opened;await login.waitForLoadState()
    assert.equal(app.windows().length,2)
    await page.evaluate(()=>window.yaoyaoDesktop.openRemoteLogin())
    assert.equal(app.windows().length,2)
    await login.evaluate(()=>{void window.yaoyaoRemoteLogin.useLocal()})
    await expect.poll(()=>app.windows().length).toBe(1)
    await page.evaluate(()=>{void window.yaoyaoDesktop.switchMode('client')})
    await page.waitForURL(remoteURL+'/**')
    const pickerOpened=app.waitForEvent('window');await page.evaluate(()=>window.yaoyaoDesktop.openRemoteLogin())
    const picker=await pickerOpened;await picker.waitForLoadState()
    await picker.evaluate(()=>{void window.yaoyaoRemoteLogin.useLocal()})
    await page.waitForURL(origin+'/**')
    await expect.poll(()=>page.evaluate(()=>window.yaoyaoDesktop.modeState())).toEqual({mode:'server',serverURL:origin,switching:false})
  }finally{
    releaseIdentity();await app?.close().catch(()=>{})
    await Promise.all([local,remote].map(server=>new Promise(done=>{server.close(done);server.closeAllConnections()})))
    await rm(home,{recursive:true,force:true})
  }
})
