import {test,expect} from '@playwright/test'
import {mkdirSync} from 'node:fs'
test('browser authorization completes, survives reload and never signs Yaoyao out on Grok rejection',async({page,context})=>{
 const evidence='docs/verification/2026-09-10-grok-auth';mkdirSync(evidence,{recursive:true})
 await context.route('https://cursor.com/loginDeepControl**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html lang="zh"><meta charset="utf-8"><title>Isolated authorization fixture</title><body><h1>Grok Bot 授权测试</h1><p>此页面仅用于隔离测试，不连接真实账号。</p><button onclick="this.textContent=\'已确认\'">完成本次授权</button></body></html>'}))
 await page.goto('/conversations');await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture');await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass');await page.getByRole('button',{name:'登录',exact:true}).click()
 await page.locator('.desktop-sidebar .sidebar-create-trigger').click();await page.getByRole('menuitem',{name:'新建 Bot',exact:true}).click()
 const editor=page.getByRole('dialog');await editor.getByRole('textbox',{name:'名称',exact:true}).fill('云端授权验收');await editor.getByRole('button',{name:'保存',exact:true}).click()
 await page.getByRole('button',{name:'电脑与定时任务',exact:true}).click();await page.getByRole('button',{name:'Grok Bot 云端连接',exact:true}).click()
 const auth=page.getByRole('region',{name:'Grok Bot 登录授权'})
 await expect(auth.getByText('尚未登录',{exact:true})).toBeVisible()
 expect((await page.request.post('/api/app/grok-cloud/auth/start',{data:{requestId:crypto.randomUUID()}})).status()).toBe(403)
 const popupPromise=context.waitForEvent('page');await auth.getByRole('button',{name:'使用 Cursor 账号登录',exact:true}).click();const popup=await popupPromise
 await expect(popup.getByRole('button',{name:'完成本次授权',exact:true})).toBeVisible()
 await expect(auth.getByText('等待浏览器授权',{exact:true})).toBeVisible();await auth.scrollIntoViewIfNeeded();await page.screenshot({path:evidence+'/desktop-waiting.png'})
 const pending=await(await page.request.get('/api/app/grok-cloud/auth')).json();expect(pending.attempt.status).toBe('pending');expect(JSON.stringify(pending)).not.toContain('verifier')
 await auth.getByRole('button',{name:'取消授权',exact:true}).click();await popup.close();await expect(auth.getByText('尚未登录',{exact:true})).toBeVisible()
 const nextPopup=context.waitForEvent('page');await auth.getByRole('button',{name:'使用 Cursor 账号登录',exact:true}).click();const authorize=await nextPopup
 await authorize.getByRole('button',{name:'完成本次授权',exact:true}).click()
 const bootstrap=await(await page.request.get('/api/app/bootstrap')).json(),headers={'X-CSRF-Token':bootstrap.csrfToken,Origin:'http://127.0.0.1:18842'}
 expect((await page.request.post('/__test/grok-auth/complete',{headers,data:{}})).ok()).toBe(true)
 await authorize.close();await page.bringToFront();await expect(auth.getByText('已授权',{exact:true})).toBeVisible({timeout:15000});await expect(auth.getByText('grok-fixture@example.test',{exact:true})).toBeVisible()
 await auth.scrollIntoViewIfNeeded();await page.screenshot({path:evidence+'/desktop-authorized.png'})
 const connected=await(await page.request.get('/api/app/grok-cloud/auth')).json();expect(connected.automaticRefresh).toBe(true);expect(JSON.stringify(connected)).not.toMatch(/accessToken|refreshToken|verifier/)
 await page.reload();await page.getByRole('button',{name:'电脑与定时任务',exact:true}).click();await page.getByRole('button',{name:'云端连接设置',exact:true}).click();await expect(auth.getByText('grok-fixture@example.test',{exact:true})).toBeVisible()
 const nextBootstrap=await(await page.request.get('/api/app/bootstrap')).json();headers['X-CSRF-Token']=nextBootstrap.csrfToken
 await page.request.post('/__test/grok-auth/reject',{headers,data:{}})
 await expect.poll(async()=>(await page.request.get('/api/app/grok-cloud')).status(),{timeout:12000}).toBe(409)
 expect((await(await page.request.get('/api/app/bootstrap')).json()).authenticated).toBe(true)
 await page.setViewportSize({width:375,height:812});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'})
 await auth.scrollIntoViewIfNeeded();await page.screenshot({path:evidence+'/phone-authorized.png'})
 await auth.getByRole('button',{name:'断开连接',exact:true}).click();await expect(auth.getByText('尚未登录',{exact:true})).toBeVisible()
 expect((await(await page.request.get('/api/app/grok-cloud/auth')).json()).configured).toBe(false)
})
