// @vitest-environment node
import { expect, it } from 'vitest'
import { chromium, expect as browserExpect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function freePort(){const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port}

// Uses a built client and isolated authentication fixture; no model, VM or
// installation is started. Run after `vite build` with YAOYAO_BROWSER_UI_SMOKE=1.
it.runIf(process.env.YAOYAO_BROWSER_UI_SMOKE==='1')('opens the structured chat card in the existing native/Web viewer and fits small screens',async()=>{
  const root=resolve(import.meta.dirname,'../..'),home=await mkdtemp(join(tmpdir(),'yaoyao-browser-ui-'))
  const port=await freePort(),upstream=await freePort(),origin=`http://127.0.0.1:${port}`
  const server=spawn(process.execPath,['--import','tsx','tests/fixtures/workspace-server.ts'],{cwd:root,env:{...process.env,WORKSPACE_FIXTURE_HOME:home,WORKSPACE_FIXTURE_TEAM_TOOLS:'1',WORKSPACE_FIXTURE_PORT:String(port),WORKSPACE_FIXTURE_UPSTREAM_PORT:String(upstream)},stdio:'ignore'})
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined
  try{
    await browserExpect.poll(async()=>{try{return(await fetch(origin+'/healthz')).status}catch{return 0}},{timeout:30000}).toBe(200)
    browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1100,height:850}})
    await page.goto(origin+'/conversations')
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture')
    await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass')
    await page.getByRole('button',{name:'登录',exact:true}).click()
    await browserExpect(page.locator('.desktop-sidebar .sidebar-create-trigger')).toBeVisible()
    const seed=await(await page.request.post(origin+'/__test/computer',{data:{}})).json()
    const calls:{op:string;body?:any}[]=[]
    let available=false,installing=false,human=false,online=true,browserReads=0,browserOpen=false,canResume=true
    let historyStatus:'idle'|'closed'|undefined
    const installation=()=>({status:available?'ready':installing?'installing':'missing',message:available?'浏览器已准备':installing?'正在下载 Chromium · 45%':'首次使用将自动准备 Chromium',...(installing&&!available?{progress:45}:{}),updatedAt:Date.now()})
    const card=()=>({id:'real-server-card',agentId:seed.agentId,agentName:'电脑面板验收 1',status:historyStatus??(available?'active':'preparing'),title:'产品文档 · 浏览器接管验证',url:'https://example.com/docs/browser/session-with-long-title-and-path',installation:installation(),updatedAt:Date.now()})
    const inject=(data:any)=>{if(data.conversation?.id===seed.conversationId)data.messages=[{id:'browser-message',conversationId:seed.conversationId,agentId:seed.agentId,agentName:'电脑面板验收 1',seq:1,role:'assistant',content:'',reasoning:'',status:'complete',attachments:[],tools:[],browserCard:card(),createdAt:Date.now()},{id:'service-warning',conversationId:seed.conversationId,agentId:seed.agentId,agentName:'电脑面板验收 1',seq:2,role:'assistant',content:'',reasoning:'',status:'complete',attachments:[],tools:[],serviceWarnings:[{code:'plugin_unavailable',service:'天气插件',message:'MCP 服务暂不可用，本次任务继续使用其余能力。'}],createdAt:Date.now()}];return data}
    await page.route('**/api/app/conversations/'+seed.conversationId+'?*',async route=>{const response=await route.fetch();await route.fulfill({response,json:inject(await response.json())})})
    await page.route('**/api/app/workspace/snapshot*',async route=>{const response=await route.fetch(),data=await response.json();data.details=data.details.map(inject);await route.fulfill({response,json:data})})
    await page.route('**/api/app/settings/host-tools',route=>route.fulfill({json:{scriptMachine:false,serverComputer:false,vm:false,cloud:false,managedBrowser:true}}))
    const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=650;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#f4f6f8';ctx.fillRect(0,0,1000,650);ctx.fillStyle='#27313f';ctx.font='32px sans-serif';ctx.fillText('Browser control preview',50,95);ctx.font='20px sans-serif';ctx.fillText('The same page continues after handoff.',50,145);return canvas.toDataURL('image/png').split(',')[1]})
    await page.route('**/api/app/agents/'+seed.agentId+'/**',async route=>{
      const url=new URL(route.request().url()),path=url.pathname
      if(path.endsWith('/managed-browser/prepare')){calls.push({op:'prepare',body:route.request().postDataJSON()});installing=true}
      if(path.endsWith('/managed-browser')||path.endsWith('/managed-browser/prepare')){browserReads++;return route.fulfill({json:{enabled:true,available:online&&available,supportsRetention:true,...(online?{installation:installation()}:{reason:'执行节点离线，请恢复节点连接'}),open:browserOpen,generation:4,profile:'persistent',tabs:browserOpen?[{id:'retained-tab',title:'产品文档',url:'https://example.com/docs',active:true}]:[],downloads:[]}})}
      if(path.endsWith('/managed-browser/close')){
        expect(human).toBe(true);expect(canResume).toBe(false)
        calls.push({op:'close-browser',body:route.request().postDataJSON()});human=false;browserOpen=false;historyStatus='closed'
        return route.fulfill({json:{mode:'off',backend:'managed-browser',generation:4,canResume:false}})
      }
      if(!path.includes('/computer'))return route.continue()
      expect(url.searchParams.get('backend')).toBe('managed-browser')
      if(path.endsWith('/frame'))return route.fulfill({json:{id:'frame',generation:4,width:1000,height:650,data:image}})
      if(route.request().method()==='POST'){
        const op=path.split('/').at(-1)!;calls.push({op,body:route.request().postDataJSON()})
        if(op==='take'){expect(available).toBe(true);human=true;browserOpen=true}
        if(op==='giveback')human=false
      }
      return route.fulfill({json:{mode:human?'human':browserOpen?'idle':'off',backend:'managed-browser',hostName:'托管浏览器',generation:4,canResume,...(human?{controlId:'control',token:'fixture-token'}:{})}})
    })
    await page.goto(origin+'/conversations/'+seed.conversationId)
    const element=page.getByRole('region',{name:'托管浏览器会话'})
    await browserExpect(element).toContainText('产品文档 · 浏览器接管验证')
    const warnings=page.getByLabel('服务状态提示')
    await browserExpect(warnings.getByRole('status')).toHaveText('天气插件：MCP 服务暂不可用，本次任务继续使用其余能力。')
    await browserExpect(warnings.getByRole('alert')).toHaveCount(0)
    const output=join(root,'test-results/managed-browser-cards');await mkdir(output,{recursive:true})
    await page.setViewportSize({width:375,height:812})
    await browserExpect(element.getByRole('button',{name:'接管浏览器',exact:true})).toBeVisible()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false)
    await page.screenshot({path:join(output,'chat-375.png')})
    // The native bridge receives exactly the trusted card's Bot and backend.
    await page.evaluate(()=>{(window as any).__native=[];(window as any).yaoyaoDesktop={openComputer:async(...args:unknown[])=>{(window as any).__native.push(args);return true}}})
    await element.getByRole('button',{name:'接管浏览器',exact:true}).click()
    await browserExpect.poll(()=>page.evaluate(()=>(window as any).__native)).toEqual([[seed.agentId,{backend:'managed-browser'}]])
    await page.evaluate(()=>delete (window as any).yaoyaoDesktop)
    await element.getByRole('button',{name:'接管浏览器',exact:true}).click()
    const panel=page.locator('dialog.computer-panel')
    await browserExpect(panel.getByRole('status')).toContainText('正在下载 Chromium')
    expect(calls.filter(call=>call.op==='prepare')).toHaveLength(1)
    expect(calls.some(call=>call.op==='take')).toBe(false)
    await page.screenshot({path:join(output,'preparing-375.png')})
    available=true
    await browserExpect(panel).toContainText('人工控制中')
    await browserExpect(panel.locator('.computer-screen img')).toBeVisible()
    expect(calls.filter(call=>call.op==='take')).toHaveLength(1)
    await browserExpect(panel.getByRole('button',{name:'关闭浏览器',exact:true})).toHaveCount(0)
    expect(await panel.evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(false)
    await page.screenshot({path:join(output,'control-375.png')})
    await panel.getByRole('button',{name:'交还并收起',exact:true}).click()
    await browserExpect(panel).toHaveCount(0)
    expect(calls.filter(call=>call.op==='giveback')).toHaveLength(1)
    expect(browserOpen).toBe(true)
    expect(calls.some(call=>call.op==='close-browser')).toBe(false)
    expect(page.url()).toContain('/conversations/'+seed.conversationId)
    // Offline is a connection state, never a synthetic installation. Rechecking
    // must recover the same browser with read-only requests before another take.
    online=false
    const writesBeforeRecheck=calls.length
    await element.getByRole('button',{name:'接管浏览器',exact:true}).click()
    await browserExpect(panel).toContainText('执行节点离线，请恢复节点连接')
    await browserExpect(panel.getByRole('button',{name:'打开并控制',exact:true})).toBeDisabled()
    await browserExpect(panel.locator('progress')).toHaveCount(0)
    await page.screenshot({path:join(output,'offline-recheck-375.png')})
    online=true
    const readsBeforeRecheck=browserReads
    await panel.getByRole('button',{name:'重新检测',exact:true}).click()
    await browserExpect(panel.getByRole('button',{name:'接管电脑',exact:true})).toBeEnabled()
    expect(browserReads).toBeGreaterThan(readsBeforeRecheck)
    expect(calls).toHaveLength(writesBeforeRecheck)
    await panel.getByRole('button',{name:'收起窗口',exact:true}).click()
    await browserExpect(panel).toHaveCount(0)
    canResume=false;historyStatus='idle'
    await page.reload();await browserExpect(element).toContainText('产品文档 · 浏览器接管验证')
    await browserExpect(element).toContainText('页面已保留')
    await page.screenshot({path:join(output,'idle-375.png')})
    await element.getByRole('button',{name:'接管浏览器',exact:true}).click()
    await browserExpect(panel.getByRole('tab',{name:'产品文档',exact:true})).toBeVisible()
    await browserExpect(panel.getByRole('button',{name:'关闭浏览器',exact:true})).toBeVisible()
    await page.screenshot({path:join(output,'close-browser-375.png')})
    await panel.getByRole('button',{name:'关闭浏览器',exact:true}).click()
    await browserExpect(panel).toContainText('浏览器尚未打开')
    expect(calls.filter(call=>call.op==='close-browser')).toEqual([{op:'close-browser',body:{controlId:'control',token:'fixture-token'}}])
    expect(browserOpen).toBe(false)
    await panel.getByRole('button',{name:'收起窗口',exact:true}).click()
    await browserExpect(panel).toHaveCount(0)
    await page.reload()
    await browserExpect(element).toContainText('会话已结束')
    await browserExpect(element).toContainText('已关闭或回收的页面不会自动恢复')
    await element.getByRole('button',{name:'打开此 Bot 的浏览器',exact:true}).click()
    await browserExpect(panel).toContainText('人工控制中')
    expect(calls.filter(call=>call.op==='take')).toHaveLength(3)
    await panel.getByRole('button',{name:'交还并收起',exact:true}).click()
    await browserExpect(panel).toHaveCount(0)
    expect(browserOpen).toBe(true)
    await browserExpect(warnings).toContainText('MCP 服务暂不可用，本次任务继续使用其余能力。')
    await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'})
    await browserExpect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({path:join(output,'chat-dark-375.png')})
    await page.setViewportSize({width:812,height:375})
    await element.getByRole('button',{name:'打开此 Bot 的浏览器',exact:true}).scrollIntoViewIfNeeded()
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false)
    await page.screenshot({path:join(output,'chat-landscape-dark.png')})
  }finally{
    await browser?.close();server.kill('SIGTERM')
    await new Promise<void>(done=>{if(server.exitCode!==null)return done();const timer=setTimeout(()=>{server.kill('SIGKILL');done()},3000);server.once('exit',()=>{clearTimeout(timer);done()})})
    await rm(home,{recursive:true,force:true})
  }
},60000)
