import {expect,test} from '@playwright/test'
import {readFileSync} from 'node:fs'

test('reads the Android edit and preserves the iOS photo through the Web UI',async({page},testInfo)=>{
  await page.goto('/conversations')
  await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture')
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass')
  await page.getByRole('button',{name:'登录',exact:true}).click()
  await expect(page.getByText('跨端造型',{exact:true}).first()).toBeVisible()
  const response=await page.request.get('/api/app/agents',{headers:{Origin:'http://127.0.0.1:18804'}})
  expect(response.ok(),await response.text()).toBe(true)
  const agents=(await response.json()).agents
  const edited=agents.find((a:{name:string})=>a.name==='跨端造型')
  const identity=JSON.parse(edited.avatar.slice('yaoyao-avatar:v2:'.length))
  expect(identity).toMatchObject({shape:'cloud',bodyId:null,color:'#ff6b00',expression:'happy'})
  const photo=JSON.parse(agents.find((a:{name:string})=>a.name==='跨端照片').avatar.slice('yaoyao-avatar:v2:'.length))
  expect(photo.imageCrop).toBe('rounded')
  expect(photo.imageDataURL).toBe('data:image/png;base64,'+readFileSync(new URL('../../public/brand/AppIcon-1024.png',import.meta.url)).toString('base64'))
  await expect(page.getByText('跨端造型',{exact:true}).first()).toBeVisible()
  const avatar=page.locator('.desktop-sidebar .agent-avatar[aria-label="跨端造型 的头像"]')
  await expect(avatar.locator('[data-part=outline] path')).toHaveAttribute('fill','#ff6b00')
  await expect(avatar.locator('[data-part=mouth]')).toHaveCount(0)
  await page.screenshot({path:testInfo.outputPath('web-workspace-roundtrip.png'),fullPage:true})
  await page.setViewportSize({width:375,height:812})
  const openNavigation=page.getByRole('button',{name:'打开导航',exact:true})
  if(await openNavigation.isVisible())await openNavigation.click()
  await page.screenshot({path:testInfo.outputPath('web-workspace-mobile.png'),fullPage:true})
})
