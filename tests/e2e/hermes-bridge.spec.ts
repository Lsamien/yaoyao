import {test,expect} from '@playwright/test'
import {mkdirSync} from 'node:fs'
const evidence='docs/verification/2026-09-15-hermes-bridge'

test('checks and installs the selected Profile bridge and displays its actual activation state',async({page})=>{
  mkdirSync(evidence,{recursive:true})
  let phase=0,finishInstall!:(value:void)=>void
  const installations:unknown[]=[]
  const status=()=>({endpoint:'http://127.0.0.1:9119',local:true,bundledVersion:'1.2.0',checkedAt:Date.now(),profiles:[
    {profile:'default',state:'ready',message:'Hermes 已加载当前工具桥，可以使用',installedVersion:'1.2.0',loadedVersion:'1.2.0',canInstall:true},
    {profile:'server',state:phase===0?'missing':phase===1?'restart-required':'ready',message:phase===0?'尚未安装工具桥插件':phase===1?'插件文件已就位；请在空闲时重启 Hermes 后重新检查':'Hermes 已加载当前工具桥，可以使用',installedVersion:phase?'1.2.0':undefined,loadedVersion:phase===2?'1.2.0':undefined,canInstall:true},
  ]})
  await page.route('**/api/app/admin/hermes-bridge',route=>route.fulfill({json:status()}))
  await page.route('**/api/app/admin/hermes-bridge/install',async route=>{
    installations.push(route.request().postDataJSON())
    await new Promise<void>(done=>{finishInstall=done})
    phase=1
    await route.fulfill({json:{profile:'server',backup:'/Users/fixture/.hermes/profiles/server/backups/yaoyao-bridge-test',message:'工具桥已安装并启用。请在空闲时重启 Hermes，然后重新检查。',status:status()}})
  })
  await page.goto('/conversations')
  await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture')
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass')
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await page.locator('.desktop-sidebar .sidebar-account-switcher__main').click()
  await page.getByRole('menuitem',{name:'我的设置',exact:true}).click()
  await page.getByRole('button',{name:'Hermes 连接',exact:true}).click()
  const panel=page.getByRole('region',{name:'工具桥插件',exact:true})
  await expect(panel.getByText('未安装',{exact:true})).toBeVisible()
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({path:evidence+'/desktop-before.png'})
  await panel.getByRole('button',{name:/安装并启用：/}).click()
  await expect(panel.getByRole('button',{name:/安装并启用：/})).toBeDisabled()
  await expect(panel.getByText('安装中…',{exact:true})).toBeVisible()
  finishInstall()
  await expect(panel.getByText('待重启',{exact:true})).toBeVisible()
  expect(installations).toEqual([{profile:'server',enable:true}])
  await page.screenshot({path:evidence+'/desktop-installed.png'})
  phase=2
  await panel.getByRole('button',{name:'重新检查',exact:true}).click()
  await expect(panel.getByText('已就绪',{exact:true})).toHaveCount(2)
  await page.setViewportSize({width:375,height:812})
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({path:evidence+'/mobile-ready.png'})
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.setViewportSize({width:812,height:375})
  await panel.scrollIntoViewIfNeeded()
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  await page.screenshot({path:evidence+'/landscape-ready.png'})
  await page.setViewportSize({width:1440,height:1000})
  await page.evaluate(()=>document.documentElement.classList.add('dark'))
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({path:evidence+'/dark-ready.png'})
})
