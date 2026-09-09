import {expect,test,type Page} from '@playwright/test'
async function login(page:Page){await page.goto('/conversations');await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture');await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'设置与模式'}).first()).toBeVisible()}
async function settings(page:Page){await page.getByRole('button',{name:'设置与模式'}).first().click();await page.getByRole('menuitem',{name:'进入设置',exact:true}).click();await expect(page.locator('input[name=server-display-name]')).toBeVisible();await expect(page.locator('.settings-center-layer')).toHaveCSS('opacity','1')}
test('shares a server name across two clients without reloading',async({page,browser},testInfo)=>{
  await login(page);await settings(page)
  const observerContext=await browser.newContext({baseURL:'http://127.0.0.1:18804',viewport:{width:1100,height:850}})
  const observer=await observerContext.newPage();await login(observer);await settings(observer)
  if(await page.locator('input[name=server-display-name]').inputValue()==='Web 服务器') {
    await page.locator('input[name=server-display-name]').fill('临时同步验证')
    await page.getByRole('button',{name:'保存服务器名称',exact:true}).click()
    await expect(observer.locator('input[name=server-display-name]')).toHaveValue('临时同步验证')
  }
  await page.locator('input[name=server-display-name]').fill('Web 服务器')
  await page.getByRole('button',{name:'保存服务器名称',exact:true}).click()
  await expect(page.getByRole('status').filter({hasText:'服务器名称已保存'})).toBeVisible()
  await expect(observer.locator('input[name=server-display-name]')).toHaveValue('Web 服务器')
  await page.screenshot({path:testInfo.outputPath('web-server-name.png'),fullPage:true,animations:'disabled'})
  await observerContext.close()
})
test('reads the name saved by Android back through the Web settings',async({page},testInfo)=>{
  test.skip(process.env.SERVER_NAME_NATIVE_ROUNDTRIP!=='1','Run after the iOS and Android settings tests')
  await login(page);await settings(page)
  await expect(page.locator('input[name=server-display-name]')).toHaveValue('家里的 Mac')
  await page.screenshot({path:testInfo.outputPath('web-native-name-roundtrip.png'),fullPage:true,animations:'disabled'})
})
