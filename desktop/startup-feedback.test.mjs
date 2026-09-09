import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,readFile,rm,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {_electron as electron} from '@playwright/test'
import {LaunchAgentService,localRequest} from '../bin/lib/service-update.mjs'

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
