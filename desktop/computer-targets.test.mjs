import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {_electron as electron,expect} from '@playwright/test'

const root=resolve(import.meta.dirname,'..')
test('selected previews reach the matching native desktop and switch only after returning the old lease',{timeout:120000},async()=>{
 const home=await mkdtemp(join(tmpdir(),'yaoyao-computer-targets-')),origin='http://127.0.0.1:18865'
 const server=spawn(process.execPath,['--import','tsx','tests/fixtures/workspace-server.ts'],{cwd:root,
  env:{...process.env,WORKSPACE_FIXTURE_HOME:home,WORKSPACE_FIXTURE_TEAM_TOOLS:'1',WORKSPACE_FIXTURE_PORT:'18865',WORKSPACE_FIXTURE_UPSTREAM_PORT:'19165'},stdio:'ignore'})
 let app
 try{
  await expect.poll(async()=>{try{return(await fetch(origin+'/healthz')).status}catch{return 0}},{timeout:30000}).toBe(200)
  const harness=join(home,'main.mjs')
  await writeFile(harness,`import {app,BrowserWindow} from 'electron';
import {installComputerViewer} from '${pathToFileURL(join(root,'desktop/computer-viewer.mjs')).href}';
app.setPath('userData',${JSON.stringify(join(home,'chromium'))});
app.whenReady().then(async()=>{let quitting=false;app.on('before-quit',()=>quitting=true);
const owner=new BrowserWindow({width:1440,height:900,webPreferences:{preload:${JSON.stringify(join(root,'desktop/preload.cjs'))},sandbox:true,contextIsolation:true}});
installComputerViewer({owner:()=>owner,origin:()=>${JSON.stringify(origin)},preload:${JSON.stringify(join(root,'desktop/preload.cjs'))},quitting:()=>quitting});
await owner.loadURL(${JSON.stringify(origin+'/conversations')});});`)
  app=await electron.launch({args:[harness],cwd:root})
  const page=await app.firstWindow()
  await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture')
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass')
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await expect(page.locator('.desktop-sidebar .sidebar-create-trigger')).toBeVisible()
  const seed=await(await page.request.post(origin+'/__test/computer',{data:{}})).json()
  const targets=[
   {key:'desktop:local',backend:'desktop',host:'local',name:'服务器',color:'#263f59'},
   {key:'desktop:client-mac',backend:'desktop',host:'client-mac',name:'Mac Studio 客户端',color:'#245b49'},
   {key:'cloud',backend:'cloud',name:'Grok Bot 云端',color:'#6a405e'},
   {key:'managed-browser',backend:'managed-browser',name:'托管浏览器',color:'#264e60'},
   {key:'vm',backend:'vm',name:'独立虚拟机',color:'#65502c'},
  ]
  const images=await page.evaluate(targets=>Object.fromEntries(targets.map(target=>{
   const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=800
   const ctx=canvas.getContext('2d');ctx.fillStyle=target.color;ctx.fillRect(0,0,1280,800)
   ctx.fillStyle='#ffffff';ctx.font='52px sans-serif';ctx.fillText(target.name,70,180)
   ctx.font='28px sans-serif';ctx.fillText('验证桌面 · '+target.key,70,245)
   return [target.key,canvas.toDataURL('image/png').split(',')[1]]
  })),targets)
  const permission={supported:true,authorized:true,screen:true,accessibility:true,ready:true,fullAuthorized:true}
  const hosts=targets.filter(t=>t.backend==='desktop').map(t=>({id:t.host,name:t.name,online:true,local:permission,browser:{available:false}}))
  const calls=[],leases=new Set()
  let refuseGiveback=false
  await app.context().route('**/api/app/settings/host-tools',route=>route.fulfill({json:{scriptMachine:true,serverComputer:true,vm:true,cloud:true,managedBrowser:true}}))
  await app.context().route('**/api/app/agents/*/**',async route=>{
   const url=new URL(route.request().url()),path=url.pathname
   if(!path.startsWith(`/api/app/agents/${seed.agentId}/`))return route.continue()
   if(path.endsWith('/desktop-environment'))return route.fulfill({json:{hosts,online:true,local:permission}})
   if(path.endsWith('/cloud-computer')||path.endsWith('/cloud-computer/open'))return route.fulfill({json:{configured:true,running:true,connected:true}})
   if(path.endsWith('/local-vm'))return route.fulfill({json:{enabled:true,image:true,container:'running',ready:true,mode:'per-bot',fixedCapacity:true}})
   if(path.endsWith('/managed-browser'))return route.fulfill({json:{enabled:true,available:true,open:true,generation:1,profile:'temporary',tabs:[{id:'tab',title:'托管网页',url:'https://example.com/',active:true}],downloads:[]}})
   if(path.endsWith('/managed-browser/action')){calls.push({op:'browser-action',key:'managed-browser',body:route.request().postDataJSON()});return route.fulfill({json:{ok:true}})}
   if(!path.includes('/computer'))return route.continue()
   const backend=url.searchParams.get('backend'),host=url.searchParams.get('host')
   const key=backend==='desktop'?'desktop:'+host:backend
   const target=targets.find(t=>t.key===key)
   if(!target)return route.fulfill({status:409,json:{error:'Fixture requires an explicit computer target'}})
   if(path.endsWith('/frame'))return route.fulfill({json:{id:key,data:images[key],width:1280,height:800,generation:1}})
   if(route.request().method()==='POST'){
    const op=path.split('/').at(-1);calls.push({op,key})
    if(op==='giveback'&&refuseGiveback)return route.fulfill({status:409,json:{error:'Fixture giveback temporarily unavailable'}})
    if(op==='take')leases.add(key)
    if(op==='giveback')leases.delete(key)
   }
   return route.fulfill({json:{mode:leases.has(key)?'human':'idle',backend:backend==='desktop'?'local':backend==='cloud'?'grok':backend==='managed-browser'?'managed-browser':'docker',
    hostName:target.name,generation:1,controlId:leases.has(key)?key:undefined,token:'fixture-token'}})
  })
  await page.goto(origin+'/conversations/'+seed.conversationId)
  await page.getByRole('button',{name:'电脑与定时任务',exact:true}).click()
  const dock=page.getByRole('complementary',{name:'机器人电脑面板'})
  await expect(dock.getByRole('combobox',{name:'显示的桌面'})).toBeVisible()
  let viewer,previousKey
  for(const target of targets){
   await dock.getByRole('combobox',{name:'显示的桌面'}).selectOption(target.key)
   await expect(dock.locator('.preview img')).toHaveAttribute('src','data:image/png;base64,'+images[target.key])
   const opened=app.waitForEvent('window')
   await dock.locator('.preview').click()
   const oldViewer=viewer;viewer=await opened
   await expect(viewer.locator('.computer-panel.standalone')).toContainText('人工控制中')
   await expect(viewer.locator('.computer-screen img')).toHaveAttribute('src','data:image/png;base64,'+images[target.key])
   const url=new URL(viewer.url())
   assert.equal(url.searchParams.get('backend'),target.backend)
   assert.equal(url.searchParams.get('host'),target.host??null)
   if(oldViewer){
    assert.equal(oldViewer.isClosed(),true)
    assert.ok(calls.findIndex(c=>c.op==='giveback'&&c.key===previousKey)<calls.findIndex(c=>c.op==='take'&&c.key===target.key))
   }
   assert.deepEqual([...leases],[target.key])
   previousKey=target.key
   if(target.backend==='managed-browser'){
    await expect(viewer.getByRole('textbox',{name:'浏览器地址'})).toHaveValue('https://example.com/')
    await viewer.getByRole('textbox',{name:'浏览器地址'}).fill('https://example.org/')
    await viewer.getByRole('button',{name:'前往',exact:true}).click()
    await expect.poll(()=>calls.filter(c=>c.op==='browser-action').length).toBe(1)
    const navigation=calls.find(c=>c.op==='browser-action').body
    assert.equal(navigation.controlId,'managed-browser');assert.equal(navigation.generation,1)
    assert.deepEqual(navigation.action,{kind:'navigate',url:'https://example.org/'})
    const output=join(root,'test-results/managed-browser');await mkdir(output,{recursive:true})
    await viewer.screenshot({path:join(output,'desktop.png')})
    await page.setViewportSize({width:375,height:812});await page.screenshot({path:join(output,'mobile-preview.png')})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false)
    await page.setViewportSize({width:1440,height:900})
   }
   if(target.host==='client-mac'){
    const output=join(root,'test-results/computer-targets');await mkdir(output,{recursive:true})
    await viewer.screenshot({path:join(output,'client-desktop.png')})
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'selected-client-mobile.png')})
    await page.setViewportSize({width:1440,height:900})
   }
  }
  // Reopening an unchanged target focuses its existing window.
  await page.evaluate(({id,target})=>window.yaoyaoDesktop.openComputer(id,target),{id:seed.agentId,target:{backend:'vm'}})
  assert.equal(viewer.isClosed(),false);assert.equal(app.windows().length,2)
  const rejected=await page.evaluate(async id=>{try{await window.yaoyaoDesktop.openComputer(id,{backend:'vm',host:'client-mac'});return false}catch{return true}},seed.agentId)
  assert.equal(rejected,true);assert.equal(viewer.isClosed(),false)
  refuseGiveback=true
  const beforeFailedSwitch=calls.length
  const failedSwitch=await page.evaluate(async id=>{
   try{await window.yaoyaoDesktop.openComputer(id,{backend:'desktop',host:'local'});return ''}
   catch(error){return error.message}
  },seed.agentId)
  assert.match(failedSwitch,/尚未交还/)
  assert.equal(viewer.isClosed(),false);assert.deepEqual([...leases],['vm'])
  assert.equal(calls.slice(beforeFailedSwitch).some(c=>c.op==='take'),false)
  refuseGiveback=false
  // A manual change inside the viewer must update the identity used for reuse.
  await viewer.getByRole('button',{name:'键盘与操作',exact:true}).click()
  await viewer.getByRole('button',{name:'结束控制',exact:true}).click()
  await viewer.getByRole('combobox',{name:'切换电脑环境'}).selectOption('desktop:local')
  await expect(viewer.locator('.computer-screen img')).toHaveAttribute('src','data:image/png;base64,'+images['desktop:local'])
  const reopened=app.waitForEvent('window'),oldViewer=viewer
  await page.evaluate(id=>window.yaoyaoDesktop.openComputer(id,{backend:'vm'}),seed.agentId)
  viewer=await reopened
  await expect(viewer.locator('.computer-panel')).toContainText('人工控制中')
  assert.equal(oldViewer.isClosed(),true)
  await expect(viewer.locator('.computer-screen img')).toHaveAttribute('src','data:image/png;base64,'+images.vm)
  await viewer.getByRole('button',{name:'交还并关闭',exact:true}).click()
  await expect.poll(()=>viewer.isClosed()).toBe(true)
  assert.equal(leases.size,0)
 }finally{
  await app?.close().catch(()=>{})
  server.kill('SIGTERM');if(server.exitCode===null)await new Promise(done=>server.once('exit',done))
  await rm(home,{recursive:true,force:true})
 }
})
