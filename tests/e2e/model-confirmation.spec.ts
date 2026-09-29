import { test, expect } from '@playwright/test'

test('model confirmation survives transcript reconnects and the Allow button completes the switch', async ({ page }) => {
  const modelCommands: Record<string, unknown>[] = []
  let nativeApprovals = 0
  await page.route('**/api/realtime/channels/*/commands', async route => {
    const command = route.request().postDataJSON()
    if (command.method === 'approval.respond') nativeApprovals++
    if (command.method !== 'config.set' || command.params.key !== 'model') return route.continue()
    modelCommands.push(command.params)
    const result = command.params.confirm_expensive_model === true
      ? { key: 'model', value: 'gpt-5.5', scope: 'session' }
      : { confirm_required: true, confirm_message: '长上下文切换验收：请确认重新读取缓存。' }
    await route.fulfill({ json: { state: 'confirmed', response: { result } } })
  })
  await page.goto('/chat/session-demo?profile=yaoyao')
  if (await page.getByRole('heading', { name: '登录夭夭' }).isVisible()) {
    await page.getByLabel('账号').fill('admin')
    await page.getByLabel('密码').fill('e2e-password')
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.goto('/chat/session-demo?profile=yaoyao')
  await expect(page.locator('.composer-tool--model')).toContainText('gpt-5.6')
  await page.locator('.composer-tool--model').click()
  await page.locator('.model-dialog__item').filter({ hasText: 'gpt-5.5' }).click()
  // History can be opened without resuming Hermes; sending applies the pending pick.
  await page.locator('.composer-textarea').fill('等待模型确认')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const confirmation = page.locator('.interaction-card--approval')
  await expect(confirmation).toContainText('长上下文切换验收')
  for (let i = 0; i < 2; i++) {
    const resumed = page.waitForResponse(response => response.url().includes('/api/app/chat/sessions/session-demo/events'))
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await resumed
    await expect(confirmation).toBeVisible()
  }
  await confirmation.getByRole('button', { name: '允许', exact: true }).click()
  await expect(confirmation).toBeHidden()
  expect(modelCommands).toHaveLength(2)
  expect(modelCommands[1]).toMatchObject({ confirm_expensive_model: true, value: 'gpt-5.5 --provider openai --session' })
  expect(nativeApprovals).toBe(0)
  await page.locator('.composer-textarea').fill('模型确认后发送')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message__content').filter({ hasText: '这是来自假 Gateway 的流式回复。' })).toHaveCount(1)
  expect(modelCommands).toHaveLength(2)
})
