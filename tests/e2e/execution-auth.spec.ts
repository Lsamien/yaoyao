import {test,expect} from '@playwright/test'
import {rmSync,writeFileSync} from 'node:fs'

test('authorizes in a separate window, persists the login and retains file import on mobile',async({page,context},testInfo)=>{
  const marker=process.env.YAOYAO_CODEX_FIXTURE_COMPLETE!
  rmSync(marker,{force:true})
  try{
    await context.route('https://auth.openai.com/codex/device',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html lang="zh"><title>模拟账号授权</title><h1>模拟账号授权</h1><p>仅用于测试，不连接真实账号。</p><button>完成授权</button></html>'}))
    await page.goto('/conversations')
    await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture');await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass');await page.getByRole('button',{name:'登录',exact:true}).click()
    await page.locator('.desktop-sidebar').getByRole('button',{name:'工具',exact:true}).click();await page.getByRole('menuitem',{name:'Bot 设置',exact:true}).click()
    const settings=page.getByRole('dialog',{name:'Bot 设置',exact:true})
    await settings.getByRole('button',{name:'环境与授权',exact:true}).click();await settings.getByRole('button',{name:'添加授权或变量',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'添加授权',exact:true})
    await expect(dialog.getByRole('button',{name:'浏览器授权（推荐）',exact:true})).toHaveAttribute('aria-pressed','true')
    await expect(dialog.getByRole('button',{name:'保存授权',exact:true})).toBeDisabled()
    const popupPromise=context.waitForEvent('page');await dialog.getByRole('button',{name:'打开浏览器授权',exact:true}).click();const popup=await popupPromise
    await expect(popup.getByRole('heading',{name:'模拟账号授权'})).toBeVisible()
    await expect(dialog.getByText('TEST-12345',{exact:true})).toBeVisible()
    await page.screenshot({path:testInfo.outputPath('browser-authorization.png')})
    await popup.getByRole('button',{name:'完成授权',exact:true}).click();writeFileSync(marker,'complete');await popup.close();await page.bringToFront()
    await expect(dialog.getByText('浏览器授权成功。选择允许使用的 Bot，然后保存授权。',{exact:true})).toBeVisible()
    await dialog.getByRole('textbox',{name:'名称',exact:true}).fill('浏览器授权验收')
    await dialog.getByRole('button',{name:'保存授权',exact:true}).click();await expect(dialog).toBeHidden()
    await expect(settings.getByRole('button',{name:'编辑 浏览器授权验收',exact:true})).toBeVisible()
    const resources=await(await page.request.get('/api/app/admin/execution')).json()
    expect(resources.resources[0]).toMatchObject({name:'浏览器授权验收',kind:'codex',agentIds:[],configured:true})
    expect(JSON.stringify(resources)).not.toContain('codex-browser-fixture-token')
    await settings.getByRole('button',{name:'编辑 浏览器授权验收',exact:true}).click()
    const edit=page.getByRole('dialog',{name:'编辑授权',exact:true});await expect(edit.getByText('已有登录会保留；完成新授权并保存后才会替换。',{exact:true})).toBeVisible()
    await page.setViewportSize({width:390,height:844})
    await edit.getByRole('button',{name:'导入授权文件',exact:true}).click()
    await edit.getByLabel('选择授权文件').setInputFiles({name:'auth.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({tokens:{access_token:'file-fixture-token'}}))})
    await expect(edit.getByText('已读取 auth.json',{exact:true})).toBeVisible()
    await page.screenshot({path:testInfo.outputPath('file-import-mobile.png')})
    expect(await edit.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
    await edit.getByRole('button',{name:'保存授权',exact:true}).click();await expect(edit).toBeHidden()
    const updated=await(await page.request.get('/api/app/admin/execution')).json();expect(updated.resources[0].revision).toBe(2)
  }finally{rmSync(marker,{force:true})}
})
