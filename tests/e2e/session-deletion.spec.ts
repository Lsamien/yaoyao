import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/chat')
  await page.getByLabel('账号').fill('admin')
  await page.getByLabel('密码').fill('e2e-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('navigation').first()).toBeVisible()
}

async function openDeleteDialog(page: Page) {
  await page.getByRole('button', { name: '会话操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除会话', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除会话', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

for (const mobile of [false, true]) {
  test.describe(mobile ? 'mobile ordinary chat deletion' : 'desktop ordinary chat deletion', () => {
    test.use({ hasTouch: mobile })

    test('cancels safely and deletes a locally retained session missing from Hermes', async ({ page }, testInfo) => {
      await login(page)
      await page.getByRole('button', { name: '新建聊天', exact: true }).click()
      await page.locator('.composer-textarea').fill('删除流程验收')
      await page.getByRole('button', { name: '发送消息' }).click()
      await expect(page).toHaveURL(/\/chat\/session-new/)
      await expect(page.locator('.message__content').filter({ hasText: '这是来自假 Gateway 的流式回复。' })).toHaveCount(1)
      if (mobile) await page.setViewportSize({ width: 375, height: 812 })
      const originalURL = page.url()
      const deletions: string[] = []
      page.on('request', request => {
        if (request.method() === 'DELETE') deletions.push(request.url())
      })

      let dialog = await openDeleteDialog(page)
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath('delete-confirmation.png') })
      if (mobile) await dialog.getByRole('button', { name: '取消', exact: true }).tap()
      else await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).toBeHidden()
      expect(page.url()).toBe(originalURL)
      expect(deletions).toEqual([])
      await expect(page.getByRole('button', { name: '会话操作', exact: true })).toBeFocused()

      dialog = await openDeleteDialog(page)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      expect(deletions).toEqual([])

      dialog = await openDeleteDialog(page)
      const removed = page.waitForResponse(response => response.request().method() === 'DELETE')
      if (mobile) await dialog.getByRole('button', { name: '删除', exact: true }).tap()
      else await dialog.getByRole('button', { name: '删除', exact: true }).click()
      expect((await removed).ok()).toBe(true)
      await expect(dialog).toBeHidden()
      await expect(page).toHaveURL(/\/chat\?profile=yaoyao$/)
      expect(deletions).toHaveLength(1)
      await page.reload()
      const exists = await page.evaluate(async () => {
        const response = await fetch('/api/app/sessions?view=chat&profile=yaoyao')
        const body = await response.json()
        return body.sessions.some((session: { id: string }) => session.id === 'session-new')
      })
      expect(exists).toBe(false)
    })

    test('shows a failure, blocks duplicate requests, and lets the user cancel or retry', async ({ page }) => {
      await login(page)
      await page.goto('/chat/session-demo?profile=yaoyao')
      if (mobile) await page.setViewportSize({ width: 375, height: 812 })
      const originalURL = page.url()
      let finish!: () => void
      let attempts = 0
      await page.route('**/api/app/sessions/session-demo?profile=yaoyao', async route => {
        if (route.request().method() !== 'DELETE') return route.continue()
        attempts++
        await new Promise<void>(resolve => { finish = resolve })
        await route.fulfill({ status: 503, json: { error: '删除服务暂时不可用，请重试' } })
      })

      const dialog = await openDeleteDialog(page)
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await expect(dialog.getByRole('button', { name: '删除中…', exact: true })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await expect.poll(() => attempts).toBe(1)
      finish()
      await expect(dialog.getByRole('alert')).toHaveText('删除服务暂时不可用，请重试')
      expect(page.url()).toBe(originalURL)
      await dialog.getByRole('button', { name: '删除', exact: true }).click()
      await expect.poll(() => attempts).toBe(2)
      finish()
      await expect(dialog.getByRole('alert')).toBeVisible()
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).toBeHidden()
      expect(page.url()).toBe(originalURL)
    })
  })
}
