import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,readFile,rm,mkdir,cp,writeFile,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {_electron as electron} from '@playwright/test'
import {LaunchAgentService,localRequest,synchronizeDesktop} from '../bin/lib/service-update.mjs'
import {sealRuntime,verifyRuntimePackage} from '../bin/lib/runtime-release.mjs'

const root=resolve(import.meta.dirname,'..')
test('built startup page shows a real helper error and Retry recovers into the Web',{timeout:90000},async()=>{
  // The production packaging filter previously omitted this file entirely.
  assert.ok((await readFile(join(root,'.desktop-build/shell/boot.js'),'utf8')).includes('yaoyaoDesktop.status'))
  const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-startup-feedback-')))
  const blocker=createServer((_request,response)=>{response.setHeader('Content-Type','application/json');response.end('{"ok":true}')})
  await new Promise(done=>blocker.listen(0,'127.0.0.1',done))
  const port=blocker.address().port
  const driver=new LaunchAgentService({home,port,releaseRoot:join(home,'updates','fixture-releases'),
    label:`cn.samien.yaoyao.sync-test.${createHash('sha256').update(home).digest('hex').slice(0,16)}`,
    plistPath:join(home,'updates','fixture-service.plist')})
  let app
  try{
    app=await electron.launch({...(process.env.DESKTOP_TEST_EXECUTABLE?{executablePath:process.env.DESKTOP_TEST_EXECUTABLE}:{}),
      args:process.env.DESKTOP_TEST_EXECUTABLE?[]:[root],cwd:root,
      env:{...process.env,HERMES_YAOYAO_DESKTOP_TEST_HOME:home,HERMES_YAOYAO_DESKTOP_PORT:String(port),HERMES_YAOYAO_DESKTOP_TEST_SYNC:'1',HERMES_YAOYAO_UPSTREAM:'http://127.0.0.1:1'},timeout:30000})
    const page=await app.firstWindow()
    await page.locator('#status[role="alert"]').waitFor({timeout:30000})
    assert.match(await page.locator('#status').textContent(),/已有服务未注册/)
    assert.equal(await page.getByRole('button',{name:'重试',exact:true}).isVisible(),true)
    assert.equal(await page.getByRole('button',{name:'查看日志',exact:true}).isVisible(),true)
    await mkdir(join(root,'test-results/desktop'),{recursive:true})
    await page.screenshot({path:join(root,'test-results/desktop/startup-error-retry.png')})
    await new Promise(done=>blocker.close(done))
    await page.getByRole('button',{name:'重试',exact:true}).click()
    await page.waitForURL(`http://127.0.0.1:${port}/**`,{timeout:45000})
    assert.equal((await localRequest(`http://127.0.0.1:${port}/healthz`)).body.ok,true)
    await page.screenshot({path:join(root,'test-results/desktop/startup-recovered.png')})
  }finally{
    await app?.close().catch(()=>{})
    if(blocker.listening)await new Promise(done=>blocker.close(done))
    await driver.stop();await rm(home,{recursive:true,force:true})
  }
})
test('same-version unknown ancestry offers an explicit overwrite and preserves existing user data',{timeout:90000},async()=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),'yaoyao-force-overwrite-')))
 const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done))
 const port=reservation.address().port;await new Promise(done=>reservation.close(done))
 const payload=process.env.DESKTOP_TEST_EXECUTABLE?resolve(process.env.DESKTOP_TEST_EXECUTABLE,'../../Resources/runtime/web-service'):join(root,'.desktop-build/web-service')
 const original=verifyRuntimePackage(payload),old=join(home,'updates/old-runtime')
 await cp(payload,old,{recursive:true})
 await writeFile(join(old,'build-info.json'),JSON.stringify({commit:'f'.repeat(40),ancestors:[],buildNumber:1,dirty:false}))
 sealRuntime(old)
 const releaseRoot=join(home,'updates','fixture-releases')
 const driver=new LaunchAgentService({home,port,releaseRoot,label:`cn.samien.yaoyao.sync-test.${createHash('sha256').update(home).digest('hex').slice(0,16)}`,plistPath:join(home,'updates','fixture-service.plist'),environment:{HERMES_YAOYAO_UPSTREAM:'http://127.0.0.1:1',HERMES_YAOYAO_SUPERVISE_DASHBOARD:'0'}})
 let app
 try{
  await synchronizeDesktop({home,runtimeRoot:old,releaseRoot,driver})
  await writeFile(join(home,'user-proof.txt'),'preserve existing user files')
  app=await electron.launch({...(process.env.DESKTOP_TEST_EXECUTABLE?{executablePath:process.env.DESKTOP_TEST_EXECUTABLE}:{}),args:process.env.DESKTOP_TEST_EXECUTABLE?[]:[root],cwd:root,
   env:{...process.env,HERMES_YAOYAO_DESKTOP_TEST_HOME:home,HERMES_YAOYAO_DESKTOP_PORT:String(port),HERMES_YAOYAO_DESKTOP_TEST_SYNC:'1',HERMES_YAOYAO_UPSTREAM:'http://127.0.0.1:1'},timeout:30000})
  const page=await app.firstWindow(),button=page.getByRole('button',{name:'使用当前 App 覆盖同版本 Web',exact:true})
  await button.waitFor({timeout:30000})
  assert.match(await page.locator('#status').textContent(),/构建先后关系无法确定/)
  assert.equal(verifyRuntimePackage(driver.snapshot().root).commit,'f'.repeat(40))
  await mkdir(join(root,'test-results/desktop'),{recursive:true});await page.screenshot({path:join(root,'test-results/desktop/same-version-force.png')})
  await button.click();await page.waitForURL(`http://127.0.0.1:${port}/**`,{timeout:45000})
  const record=JSON.parse(await readFile(join(home,'service-instance.json'),'utf8'))
  const identity=await localRequest(`http://127.0.0.1:${port}/desktop/service`,record.token)
  assert.equal(identity.body.build.artifactDigest,original.artifactDigest)
  assert.equal(await readFile(join(home,'user-proof.txt'),'utf8'),'preserve existing user files')
  assert.equal(JSON.parse(await readFile(join(home,'updates/desktop-sync.json'),'utf8')).action,'overwrite')
  assert.ok((await readdir(join(home,'updates/backups'))).length>=2)
  const denied=await page.evaluate(()=>window.yaoyaoDesktop.forceSync().then(()=>false,()=>true))
  assert.equal(denied,true,'the Web renderer cannot invoke the boot-only overwrite channel')
  await page.screenshot({path:join(root,'test-results/desktop/same-version-recovered.png')})
 }finally{await app?.close().catch(()=>{});await driver.stop();await rm(home,{recursive:true,force:true})}
})
