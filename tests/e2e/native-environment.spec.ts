import { test, expect } from '@playwright/test'

test('shows device permissions only in Bot settings and keeps Web authorization read-only', async ({ page }, testInfo) => {
  await page.goto('/conversations')
  await page.getByRole('textbox', { name: '账号', exact: true }).fill('fixture')
  await page.getByRole('textbox', { name: '密码', exact: true }).fill('fixture-pass')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.locator('.desktop-sidebar .sidebar-create-trigger')).toBeVisible()
  const seed = await (await page.request.post('/__test/computer', { data: {} })).json()
  await page.goto(`/conversations/${seed.conversationId}`)
  await page.getByRole('button', { name: '电脑与定时任务', exact: true }).click()
  const panel = page.getByRole('complementary', { name: '机器人电脑面板' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.host-permission')).toHaveCount(0)
  await expect(panel.locator('option[value^="desktop:"]')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /授权/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('computer-panel.png') })
  await page.locator('.desktop-sidebar').getByRole('button', { name: '工具', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Bot 设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Bot 设置', exact: true })
  await settings.getByRole('button', { name: '环境与授权', exact: true }).click()
  const devices = settings.locator('.device-authorization')
  await expect(devices.locator('article').first()).toBeVisible()
  await expect(devices).toContainText('屏幕控制')
  await expect(devices).toContainText('浏览器和手机端仅可查看设备状态')
  await expect(devices.locator('article button')).toHaveCount(0)
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
    await page.screenshot({ path: testInfo.outputPath(`device-status-${theme}.png`) })
  }
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport)
    await devices.locator('article').first().scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    expect(await devices.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    await page.screenshot({ path: testInfo.outputPath(`device-status-${viewport.width}.png`) })
  }
})
