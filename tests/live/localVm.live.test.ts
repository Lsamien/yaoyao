// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createServer} from 'node:http'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {chromium} from '@playwright/test'
import serve from 'koa-static'
import request from 'supertest'
import {createApplication,createNodeServer} from '../../src/server/app'
import {loadServerConfig} from '../../src/server/config'

it.skipIf(!process.env.YAOYAO_HERMES_PYTHON||!process.env.YAOYAO_COMPUTER_IMAGE)('prepares the local runner automatically and operates a real desktop from the Agent chat panel',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yaoyao-local-vm-ui-')),hermes=join(root,'hermes'),evidence=resolve(process.env.YAOYAO_VM_EVIDENCE??'test-results/local-vm-live')
 await mkdir(hermes)
 const upstream=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json')
  const path=new URL(req.url!,'http://fixture').pathname
  res.end(JSON.stringify(path==='/api/profiles'?{profiles:[{name:'default'}]}:path==='/api/config'?{terminal:{cwd:'.'}}:{ok:true}))
 })
 await new Promise<void>(done=>upstream.listen(0,'127.0.0.1',done))
 const upstreamURL=`http://127.0.0.1:${(upstream.address() as any).port}`
 // Match fresh real installations: placeholder cwd and no usable model.
 // Desktop creation and human control must not resolve provider credentials.
 await writeFile(join(hermes,'config.yaml'),`model:\n  provider: nonexistent-fixture-provider\n  default: fixture-model\nterminal:\n  cwd: .\n`,{mode:0o600})
 const app=createApplication({config:loadServerConfig({HERMES_YAOYAO_HOME:join(root,'web'),HERMES_YAOYAO_UPSTREAM:upstreamURL})})
 vi.spyOn(app.localVm as any,'installation').mockReturnValue({hermesHome:hermes,hermesSource:process.env.YAOYAO_HERMES_SOURCE,python:process.env.YAOYAO_HERMES_PYTHON})
 app.app.use(serve(resolve('dist')))
 app.app.use(ctx=>{if(!ctx.path.startsWith('/api/')){ctx.type='html';ctx.body=readFileSync(resolve('dist/index.html'))}})
 const node=createNodeServer(app)
 await new Promise<void>(done=>node.server.listen(0,'127.0.0.1',done))
 app.config.port=(node.server.address() as any).port
 const address=`http://127.0.0.1:${app.config.port}`
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
 try{
  const bootstrap=await request(address).get('/api/app/bootstrap').expect(200)
  const setup=await request(address).post('/api/app/setup').set('Origin',address).set('Cookie',bootstrap.headers['set-cookie'].map((s:string)=>s.split(';')[0]).join('; ')).set('X-CSRF-Token',bootstrap.body.csrfToken).send({username:'vm-ui-fixture',password:'vm-ui-fixture-password'}).expect(200)
  const owner=setup.body.user.id
  const agent=app.workspace.createAgent(owner,{name:'本地虚拟机验收',profile:'default'})
  const conversation=app.workspace.list<any>(owner,'conversation').find(c=>c.memberIds[0]===agent.id)!
  browser=await chromium.launch({headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:960},locale:'zh-CN'})
  const page=await context.newPage()
  const inputs:unknown[]=[],failures:unknown[]=[]
  page.on('request',r=>{if(r.url().endsWith('/computer/input'))inputs.push(r.postDataJSON()?.action)})
  page.on('response',r=>{if((r.url().includes('/computer')||r.url().includes('/local-vm'))&&r.status()>=400)void r.json().then(value=>failures.push(value))})
  await page.goto(address+'/conversations')
  await page.getByRole('textbox',{name:'账号',exact:true}).fill('vm-ui-fixture')
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('vm-ui-fixture-password')
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await page.getByRole('button',{name:'设置与模式',exact:true}).first().click()
  await page.getByRole('menuitem',{name:'进入设置',exact:true}).click()
  const settings=page.getByRole('dialog',{name:'设置中心'})
  await settings.getByRole('button',{name:'本地虚拟机',exact:true}).click()
  await settings.getByRole('button',{name:'准备本地虚拟机',exact:true}).click()
  await expect.poll(async()=>await settings.innerText(),{timeout:120000}).toContain('虚拟机环境已就绪')
  expect(app.runners.records()).toHaveLength(1)
  expect(app.runners.records()[0]?.name).toBe('本机虚拟机')
  await mkdir(evidence,{recursive:true})
  await page.screenshot({path:join(evidence,'settings.png')})
  await settings.getByRole('button',{name:'关闭设置中心'}).click()
  await page.goto(address+`/conversations/${conversation.id}`)
  await page.getByRole('button',{name:'电脑',exact:true}).click()
  const dock=page.getByRole('complementary',{name:'Agent 电脑面板'})
  await dock.getByRole('combobox',{name:'此 Agent 使用的电脑'}).selectOption('vm')
  await dock.getByRole('button',{name:/创建.*的虚拟机/}).click()
  await expect.poll(async()=>await dock.getByRole('img').count(),{timeout:60000}).toBe(1)
  await page.screenshot({path:join(evidence,'agent-panel.png')})
  await dock.getByRole('button',{name:'打开桌面',exact:true}).click()
  const viewer=page.getByRole('dialog',{name:'隔离电脑',exact:true}),screen=viewer.getByRole('img')
  await expect.poll(async()=>await viewer.innerText(),{timeout:30000}).toContain('人工控制中')
  await expect.poll(()=>viewer.locator('.computer-screen.controlling').count(),{timeout:15000}).toBe(1)
  await expect.poll(()=>screen.evaluate(e=>(e as HTMLImageElement).naturalWidth),{timeout:10000}).toBeGreaterThan(1000)
  const box=(await screen.boundingBox())!
  await screen.click({position:{x:box.width*568/1280,y:box.height*875/900}})
  await page.waitForTimeout(1500)
  await screen.focus()
  await page.keyboard.type('printf vm-ui-proof > /home/cua/workspace/proof.txt',{delay:25})
  await page.keyboard.press('Enter')
  const workspace=join(root,'web','runner-state','local-vm',app.runners.records()[0]!.id,'computer-workspaces',agent.id)
  try {await expect.poll(()=>readFile(join(workspace,'proof.txt'),'utf8').catch(()=>''),{timeout:30000}).toBe('vm-ui-proof')}
  catch(error){await page.screenshot({path:join(evidence,'input-failed.png')});throw new Error(`${String(error)}\n${JSON.stringify({inputs,failures,text:await viewer.innerText()})}`)}
  await screen.focus()
  await page.keyboard.type('erase-this',{delay:20});await page.keyboard.press('Control+u')
  await page.keyboard.type('printf hotkey-proof > /home/cua/workspace/hotkey.txt',{delay:20});await page.keyboard.press('Enter')
  await expect.poll(()=>readFile(join(workspace,'hotkey.txt'),'utf8').catch(()=>''),{timeout:30000}).toBe('hotkey-proof')
  await page.screenshot({path:join(evidence,'interactive-desktop.png')})
  await viewer.getByRole('button',{name:'交还并关闭',exact:true}).click()
  await dock.getByRole('button',{name:'停止虚拟机',exact:true}).click()
  await expect.poll(async()=>await dock.innerText(),{timeout:20000}).toContain('虚拟机已停止')
  await dock.getByRole('button',{name:'启动虚拟机',exact:true}).click()
  await expect.poll(async()=>await dock.getByRole('img').count(),{timeout:60000}).toBe(1)
  expect(await readFile(join(workspace,'proof.txt'),'utf8')).toBe('vm-ui-proof')
  const second=app.workspace.createAgent(owner,{name:'第二台本地虚拟机',profile:'default',execution:'computer'})
  const cookies=setup.headers['set-cookie'].map((s:string)=>s.split(';')[0]).join('; ')
  const fresh=await request(address).get('/api/app/bootstrap').set('Cookie',cookies).expect(200)
  await request(address).post(`/api/app/agents/${second.id}/local-vm/create`).set('Origin',address).set('Cookie',cookies).set('X-CSRF-Token',fresh.body.csrfToken).send({}).expect(200)
  await expect.poll(async()=>(await request(address).get(`/api/app/agents/${second.id}/local-vm`).set('Cookie',cookies)).body.ready,{timeout:30000}).toBe(true)
  await page.reload();await page.getByRole('button',{name:'电脑',exact:true}).click()
  await dock.getByRole('button',{name:'打开双桌面',exact:true}).click()
  const desktops=page.getByRole('main',{name:'双桌面工作区'})
  await desktops.getByRole('combobox',{name:'选择桌面 2'}).selectOption(second.id)
  await expect.poll(()=>desktops.getByRole('img').count(),{timeout:30000}).toBe(2)
  await desktops.locator('.pane').first().getByRole('button',{name:'接管电脑',exact:true}).click()
  await expect.poll(async()=>await desktops.locator('.pane').first().innerText(),{timeout:15000}).toContain('人工控制中')
  await desktops.locator('.pane').last().getByRole('button',{name:'接管电脑',exact:true}).click()
  await expect.poll(async()=>await desktops.locator('.pane').last().innerText(),{timeout:15000}).toContain('人工控制中')
  await expect.poll(async()=>await desktops.locator('.pane').first().innerText(),{timeout:15000}).toContain('仅查看')
  await expect.poll(()=>desktops.getByRole('img').count(),{timeout:15000}).toBe(2)
  await expect.poll(()=>desktops.locator('.pane').last().locator('.computer-screen.controlling').count(),{timeout:15000}).toBe(1)
  await page.screenshot({path:join(evidence,'two-desktops.png')})
  await desktops.getByRole('button',{name:'交还并关闭',exact:true}).click()
  await expect.poll(()=>desktops.count(),{timeout:15000}).toBe(0)
  expect(app.workspace.list<any>('_system','computer-control').some(g=>g.expiresAt>Date.now())).toBe(false)
  // A Profile chat must not prevent switching idle VMs between shared and
  // per-Agent mode. Keep this synthetic busy marker inside the isolated DB.
  const chatting=app.workspace.createAgent(owner,{name:'普通聊天进行中',profile:'default'})
  const ordinaryWorkId='sharing-policy-ordinary-chat'
  app.workspace.put(owner,'turn',ordinaryWorkId,{agentId:chatting.id,status:'running'})
  try{
    await page.getByRole('button',{name:'设置与模式',exact:true}).first().click()
    await page.getByRole('menuitem',{name:'进入设置',exact:true}).click()
    await settings.getByRole('button',{name:'本地虚拟机',exact:true}).click()
    page.once('dialog',dialog=>{void dialog.accept()})
    await settings.getByRole('button',{name:'共享虚拟机',exact:true}).click()
    try{await expect.poll(()=>settings.getByRole('button',{name:'共享虚拟机',exact:true}).getAttribute('aria-pressed'),{timeout:15000}).toBe('true')}
    catch(error){await page.screenshot({path:join(evidence,'sharing-failed.png')});throw new Error(`${String(error)}\n${JSON.stringify({failures,settings:await settings.innerText(),vm:await app.localVm.status(owner)})}`)}
    const group=app.workspace.require<any>(owner,'agent',agent.id).computerEnvironmentId
    expect(group).toBeTruthy()
    expect(app.workspace.require<any>(owner,'agent',second.id).computerEnvironmentId).toBe(group)
    expect(app.workspace.require(owner,'agent',chatting.id)).toEqual(chatting)
    await settings.getByRole('button',{name:'每个 Agent 独立',exact:true}).click()
    await expect.poll(()=>settings.getByRole('button',{name:'每个 Agent 独立',exact:true}).getAttribute('aria-pressed'),{timeout:15000}).toBe('true')
    expect(app.workspace.require<any>(owner,'agent',agent.id).computerEnvironmentId).toBeUndefined()
    expect(app.workspace.require(owner,'agent',chatting.id)).toEqual(chatting)
    expect(await readFile(join(workspace,'proof.txt'),'utf8')).toBe('vm-ui-proof')
    await page.screenshot({path:join(evidence,'sharing-policy.png')})
  }finally{app.workspace.remove(owner,'turn',ordinaryWorkId)}
 }finally{
  const runnerId=app.runners.records()[0]?.id
  // Shut down while the browser is still attached. All owned desktops must
  // actually stop before the server reports completion.
  await node.close(true)
  if(runnerId){const result=await promisify(execFile)('docker',['ps','-q','--filter',`label=cn.samien.yaoyao.runner=${runnerId}`]);expect(result.stdout.trim()).toBe('')}
  await browser?.close()
  await new Promise<void>(done=>{upstream.close(()=>done());upstream.closeAllConnections()})
  await rm(root,{recursive:true,force:true})
 }
},240000)
