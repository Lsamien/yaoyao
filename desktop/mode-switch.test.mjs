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
    else if(req.url.split('?')[0]==='/api/app/bootstrap'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:true,csrfToken:'fixture'}))}
    else {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>已登录的本机页面</title>')}
  })
  let enrollments = 0, exchanges = 0, enrollmentFails = true
  const deviceId = '99999999-9999-4999-8999-999999999999', deviceToken = 'fixture-machine-token-with-at-least-32-characters'
  const remote=createServer((_req,res)=>{
    if(_req.url.split('?')[0]==='/api/app/bootstrap'){
      res.setHeader('Content-Type','application/json')
      res.setHeader('Set-Cookie',['session=remembered; Path=/; HttpOnly','csrf=fixture; Path=/; HttpOnly'])
      res.end(JSON.stringify({authenticated:true,csrfToken:'fixture',user:{id:'admin',role:'admin',username:'管理员'}}));return
    }
    if(_req.url==='/api/app/admin/desktop-hosts'&&_req.method==='POST'){
      enrollments++
      assert.equal(_req.headers.origin,remoteURL)
      assert.equal(_req.headers['x-csrf-token'],'fixture')
      assert.match(_req.headers.cookie,/session=remembered/)
      res.setHeader('Content-Type','application/json')
      if(enrollmentFails){res.statusCode=503;res.end(JSON.stringify({error:'fixture enrollment unavailable'}));return}
      res.statusCode=201;res.end(JSON.stringify({host:{id:deviceId},token:deviceToken}));return
    }
    if(_req.url===`/api/desktop-host/v1/${deviceId}/exchange`){
      exchanges++
      assert.equal(_req.headers.authorization,`Bearer ${deviceToken}`)
      assert.equal(_req.headers.origin,undefined)
      assert.equal(_req.headers.cookie,undefined)
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({commands:[]}));return
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>已登录的服务器页面</title>')
  })
  await new Promise(done=>local.listen(0,'127.0.0.1',done))
  await new Promise(done=>remote.listen(0,'127.0.0.1',done))
  const origin=`http://127.0.0.1:${local.address().port}`,remoteURL=`http://127.0.0.1:${remote.address().port}`
  await writeFile(join(home,'service-instance.json'),JSON.stringify({...identity,url:origin,token:'fixture'}))
  await writeFile(join(home,'desktop-preferences.json'),JSON.stringify({startupChoice:'local',remoteServer:remoteURL,backgroundAtLogin:false}))
  let app
  try{
    app=await electron.launch({args:[root],cwd:root,env:{...process.env,HERMES_YAOYAO_DESKTOP_TEST_HOME:home,HERMES_YAOYAO_DESKTOP_PORT:String(local.address().port),HERMES_YAOYAO_DESKTOP_TEST_SYNC:'0'}})
    const page=await app.firstWindow();releaseIdentity();await page.waitForURL(origin+'/**')
    assert.deepEqual(await page.evaluate(()=>window.yaoyaoDesktop.modeState()),{mode:'server',serverURL:origin,switching:false,platform:'darwin',supportedModes:['client','server']})
    assert.deepEqual(await page.evaluate(()=>window.yaoyaoDesktop.authorizeComputer('csrf-test')),{registered:false})
    assert.equal(await page.evaluate(()=>window.yaoyaoDesktop.switchMode('invalid').then(()=>false,()=>true)),true)
    await page.evaluate(()=>{void window.yaoyaoDesktop.switchMode('client')})
    await page.waitForURL(remoteURL+'/**')
    assert.equal(enrollments,1,'entering an already signed-in remote session restores this computer authorization')
    assert.deepEqual(await page.evaluate(()=>window.yaoyaoDesktop.modeState()),{mode:'client',serverURL:remoteURL,switching:false,platform:'darwin',supportedModes:['client','server']})
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
    await expect.poll(()=>page.evaluate(()=>window.yaoyaoDesktop.modeState())).toEqual({mode:'server',serverURL:origin,switching:false,platform:'darwin',supportedModes:['client','server']})
    assert.equal(JSON.parse(await readFile(join(home,'desktop-preferences.json'),'utf8')).startupChoice,'local')
    assert.equal(local.listening,true,'switching must leave an independent service running')
    assert.equal(remote.listening,true)
    // Changing servers reuses the main page, including when opened repeatedly.
    await page.evaluate(()=>{void window.yaoyaoDesktop.openRemoteLogin()})
    await page.waitForURL('**/boot.html')
    assert.equal(app.windows().length,1)
    await page.getByRole('radio',{name:/本机运行/}).check()
    await page.locator('#prepare-local').click()
    await page.locator('#submit').click()
    await page.waitForURL(origin+'/**')
    enrollmentFails = false
    await app.evaluate(async (_electron, credentialsModule) => {
      // Fixture credentials stay in this temporary directory; do not access Keychain.
      const module = process.getBuiltinModule('module')
      const { DesktopCredentials } = module.createRequire(credentialsModule)(credentialsModule)
      DesktopCredentials.prototype.encrypt = async value => Buffer.from(value)
      DesktopCredentials.prototype.decrypt = async value => value.toString('utf8')
      globalThis.fetch = async () => { throw new Error('fixture Node transport is unavailable') }
      const http = process.getBuiltinModule('http')
      const originalRequest = http.request
      http.request = (url, ...args) => {
        if (url?.pathname?.startsWith('/api/desktop-host/')) throw new Error('fixture Node socket is unavailable')
        return originalRequest(url, ...args)
      }
      module.syncBuiltinESMExports()
    }, join(root, 'desktop/credentials.mjs'))
    await page.evaluate(()=>{void window.yaoyaoDesktop.switchMode('client')})
    await page.waitForURL(remoteURL+'/**')
    await expect.poll(() => exchanges).toBeGreaterThan(0)
    assert.equal(enrollments,2,'restoring the session retries device registration without a password login')
    await page.evaluate(()=>{void window.yaoyaoDesktop.openRemoteLogin()})
    await page.waitForURL('**/boot.html')
    assert.equal(app.windows().length,1)
    await page.getByRole('radio',{name:/本机运行/}).check()
    await page.locator('#prepare-local').click()
    await page.locator('#submit').click()
    await page.waitForURL(origin+'/**')
    await expect.poll(()=>page.evaluate(()=>window.yaoyaoDesktop.modeState())).toEqual({mode:'server',serverURL:origin,switching:false,platform:'darwin',supportedModes:['client','server']})
  }finally{
    releaseIdentity();await app?.close().catch(()=>{})
    await Promise.all([local,remote].map(server=>new Promise(done=>{server.close(done);server.closeAllConnections()})))
    await rm(home,{recursive:true,force:true})
  }
})
