import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { _electron as electron, expect } from '@playwright/test'
const root=resolve(import.meta.dirname,'..')
test('desktop takeover opens a separate large viewer and returns its lease before native close',{timeout:90000},async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-viewer-')),port=18864,origin=`http://127.0.0.1:${port}`
 const server=spawn(process.execPath,['--import','tsx','tests/fixtures/workspace-server.ts'],{cwd:root,env:{...process.env,WORKSPACE_FIXTURE_HOME:home,WORKSPACE_FIXTURE_TEAM_TOOLS:'1',WORKSPACE_FIXTURE_PORT:String(port),WORKSPACE_FIXTURE_UPSTREAM_PORT:'19164'},stdio:'ignore'})
 let app
 try{
  await expect.poll(async()=>{try{return(await fetch(origin+'/healthz')).status}catch{return 0}},{timeout:30000}).toBe(200)
  const harness=join(home,'main.mjs')
  await writeFile(harness,`import {app,BrowserWindow} from '${pathToFileURL(join(root,'node_modules/electron/index.js')).href}';\nimport {installComputerViewer} from '${pathToFileURL(join(root,'desktop/computer-viewer.mjs')).href}';\napp.setPath('userData',${JSON.stringify(join(home,'chromium'))});app.whenReady().then(async()=>{let quitting=false;app.on('before-quit',()=>quitting=true);const owner=new BrowserWindow({width:1440,height:900,webPreferences:{preload:${JSON.stringify(join(root,'desktop/preload.cjs'))},sandbox:true,contextIsolation:true}});installComputerViewer({owner:()=>owner,origin:()=>${JSON.stringify(origin)},preload:${JSON.stringify(join(root,'desktop/preload.cjs'))},quitting:()=>quitting});await owner.loadURL(${JSON.stringify(origin+'/conversations')});});`)
  // Electron's built-in module must be resolved in its own process.
  const content=await (await import('node:fs/promises')).readFile(harness,'utf8');await writeFile(harness,content.replace(pathToFileURL(join(root,'node_modules/electron/index.js')).href,'electron'))
  app=await electron.launch({args:[harness],cwd:root})
  const page=await app.firstWindow();await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture');await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass');await page.getByRole('button',{name:'登录',exact:true}).click()
  await expect(page.locator('.desktop-sidebar .sidebar-create-trigger')).toBeVisible()
  const seed=await(await page.request.post(origin+'/__test/computer',{data:{}})).json()
  await page.goto(origin+'/conversations/'+seed.conversationId)
  const agents=(await(await page.request.get(origin+'/api/app/agents')).json()).agents
  const agent=agents.find(item=>item.id===seed.agentId)||agents.find(item=>item.execution==='computer')||agents[0]
  const opened=app.waitForEvent('window');await page.evaluate(id=>window.yaoyaoDesktop.openComputer(id),agent.id)
  const viewer=await opened;await expect(viewer.locator('.computer-panel.standalone')).toContainText('人工控制中')
  await expect(viewer.locator('.computer-screen img')).toBeVisible()
  await expect(viewer.locator('footer')).toBeHidden()
  const screen=await viewer.locator('.computer-screen').boundingBox();assert.ok(screen.height>650)
  await viewer.locator('.computer-screen img').click();await viewer.keyboard.type('takeover-'+Date.now())
  await expect.poll(async()=>(await(await page.request.get(origin+'/__test/computer')).json()).actions.filter(item=>item.kind==='text').length).toBeGreaterThan(0)
  await mkdir(join(root,'docs/verification/2026-09-10-v044'),{recursive:true});await viewer.screenshot({path:join(root,'docs/verification/2026-09-10-v044/computer-takeover.png')})
  await viewer.getByRole('button',{name:'键盘与操作',exact:true}).click();await expect(viewer.getByRole('textbox',{name:'交还说明'})).toBeVisible()
  await viewer.getByRole('textbox',{name:'交还说明'}).fill('已完成人工操作')
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('/conversations/computer/')).close())
  await expect.poll(()=>viewer.isClosed()).toBe(true)
  const status=await(await page.request.get(origin+`/api/app/agents/${agent.id}/computer`)).json();assert.notEqual(status.mode,'human')
  assert.equal(page.isClosed(),false)
 }finally{await app?.close().catch(()=>{});server.kill('SIGTERM');if(server.exitCode===null)await new Promise(done=>server.once('exit',done));await rm(home,{recursive:true,force:true})}
})
