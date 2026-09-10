import {test,expect} from '@playwright/test'

test('ordinary SSE replies remain readable from Web without a second history source',async({page})=>{
  await page.goto('/chat')
  if(await page.getByRole('heading',{name:'登录夭夭'}).isVisible()){
    await page.getByLabel('账号').fill('admin');await page.getByLabel('密码').fill('e2e-password')
    await page.getByRole('button',{name:'登录',exact:true}).click()
  }
  await expect(page.getByRole('navigation')).toBeVisible()
  await page.getByRole('button',{name:'新建聊天',exact:true}).click()
  const prompt=`本地落盘验收 ${Date.now()}`
  await page.locator('.composer-textarea').fill(prompt)
  await page.getByRole('button',{name:'发送消息'}).click()
  await expect(page.locator('.message__content').filter({hasText:'这是来自假 Gateway 的流式回复。'})).toHaveCount(1,{timeout:15000})
  const result=await page.evaluate(async()=>{
    const response=await fetch('/api/app/sessions/session-new/messages?profile=yaoyao&limit=100')
    return{status:response.status,source:response.headers.get('X-Yaoyao-Data-Source'),body:await response.json()}
  })
  expect(result.status).toBe(200);expect(result.source).toBe('local')
  expect(result.body.messages.filter((m:any)=>m.role==='user').map((m:any)=>m.content)).toEqual([prompt])
  expect(result.body.messages.filter((m:any)=>m.role==='assistant').map((m:any)=>m.content)).toEqual(['这是来自假 Gateway 的流式回复。'])
  await page.reload()
  await expect(page.locator('.message__content').filter({hasText:'这是来自假 Gateway 的流式回复。'})).toHaveCount(1)
  await page.screenshot({path:'/tmp/yaoyao-ordinary-local-browser.png',fullPage:true})
})
