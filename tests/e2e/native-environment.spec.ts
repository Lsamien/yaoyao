import {test,expect} from '@playwright/test'
import {mkdirSync} from 'node:fs'
test('Web shows native desktop permissions',async({page})=>{
 const evidence='test-results/native-environment';mkdirSync(evidence,{recursive:true})
 await page.goto('/conversations');await page.getByRole('textbox',{name:'账号',exact:true}).fill('fixture');await page.getByRole('textbox',{name:'密码',exact:true}).fill('fixture-pass');await page.getByRole('button',{name:'登录',exact:true}).click()
 await page.locator('.desktop-sidebar .sidebar-create-trigger').click();await page.getByRole('menuitem',{name:'新建 Bot',exact:true}).click();const editor=page.getByRole('dialog');await editor.getByRole('textbox',{name:'名称',exact:true}).fill('本机控制验收');await editor.getByRole('button',{name:'保存',exact:true}).click()
 await page.getByRole('button',{name:'电脑与定时任务',exact:true}).click()
 const panel=page.getByRole('complementary',{name:'机器人电脑面板'})
 const desktop=panel.getByRole('combobox',{name:'显示的桌面'})
 await expect(desktop).toBeEnabled({timeout:15000});await desktop.selectOption('desktop:local')
 await expect(panel.getByRole('button',{name:'在桌面端授权',exact:true})).toBeVisible();await expect(panel.getByText(/服务器是运行夭夭服务的电脑；电脑是连接这台服务器的 Mac/)).toBeVisible();await page.screenshot({path:evidence+'/desktop-native-permissions.png'})
 await expect(panel.getByRole('tab',{name:'仅浏览器',exact:true})).toHaveCount(0)
 await expect(panel.getByRole('checkbox',{name:'电脑浏览器',exact:true})).toHaveCount(0)
})
