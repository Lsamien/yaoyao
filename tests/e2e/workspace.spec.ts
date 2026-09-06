import { expect, test } from '@playwright/test'

const WIDE_DOCX_BASE64 = 'UEsDBAoAAAAIAKwmFF15bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMECgAAAAAArCYUXQAAAAAAAAAAAAAAAAYAAABfcmVscy9QSwMECgAAAAgArCYUXZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBAoAAAAAAKwmFF0AAAAAAAAAAAAAAAAFAAAAd29yZC9QSwMECgAAAAgArCYUXalT+9hjAQAABwMAABEAAAB3b3JkL2RvY3VtZW50LnhtbKVSW0/CMBT+K03fpXMBJYRBFAaaYDSKwdeydluTrW3awsBfb7uVDYwmJr6cc75z+c6lHU8PZQH2VGkmeASvewEElCeCMJ5F8H29uBpCoA3mBBeC0wgeqYbTybgaEZHsSsoNsARcj6oI5sbIEUI6yWmJdU9Iym0sFarExkKVoUooIpVIqNaWvyxQGAQ3qMSMQ0e5FeTotHRCOWEmG0YomD/PPoBUdM9oNUbO7aSqZZ1stoVXL8obG1C5oa6DYWB3sq6jtOOTA4bIZ6zwUexMG0rZgRIXRJdES8WIMzOrZ6JoaAd9y4p+daOLStNQJY30xMnmrOT7fKhLPD/GKl6swfrufhWDeL6MfzgF6vr8u9vr4/Lhb+1QsyNqH0LTxHjC7O3Tv0QY9uveubUHw76/n8yesHITCRnB27DOUCzLTYu2whhRtrCgaRfLKSZURbAGqRCmBdnOeNBseBoJnf4Z6v7w5AtQSwECFAAKAAAACACsJhRdeW4z1+gAAACtAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAAKwmFF0AAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAABkBAABfcmVscy9QSwECFAAKAAAACACsJhRdm/036q0AAAApAQAACwAAAAAAAAAAAAAAAAA9AQAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAACsJhRdAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAAATAgAAd29yZC9QSwECFAAKAAAACACsJhRdqVP72GMBAAAHAwAAEQAAAAAAAAAAAAAAAAA2AgAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAUABQAgAQAAyAMAAAAA'

const E2E_PASSWORD = 'e2e-password'

test.beforeAll(async ({ request }) => {
  const initial = await request.get('/api/app/bootstrap')
  const initialBody = await initial.json() as { csrfToken: string; setupRequired?: boolean }
  const login = await request.post(initialBody.setupRequired ? '/api/app/setup' : '/api/app/login', {
    headers: { Origin: 'http://127.0.0.1:18801', 'X-CSRF-Token': initialBody.csrfToken },
    data: { username: 'admin', password: E2E_PASSWORD },
  })
  expect(login.ok()).toBe(true)
})

test.beforeEach(async ({ page }) => {
  await page.goto('/chat')
  if (await page.getByRole('heading', { name: '登录夭夭' }).isVisible()) {
    await page.getByLabel('账号').fill('admin')
    await page.getByLabel('密码').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: '登录' }).click()
  }
  await expect(page.getByRole('navigation')).toBeVisible()
})

test('separates writable Web chats from read-only Hermes history', async ({ page }) => {
  const sidebar = page.locator('.desktop-sidebar')
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toBeVisible()
  await expect(sidebar.getByText('Hermes 外部历史', { exact: true })).toHaveCount(0)
  await sidebar.getByRole('button', { name: '历史记录', exact: true }).click()
  await expect(page).toHaveURL(/\/history/)
  await expect(page.getByText('选择历史记录', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('Hermes 外部历史', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('夭夭 Web 验收会话', { exact: true })).toHaveCount(0)
  await sidebar.getByText('Hermes 外部历史', { exact: true }).click()
  await expect(page).toHaveURL(/\/history\/session-history-only/)
  await expect(page.locator('.composer-shell')).toHaveCount(0)
  await sidebar.getByRole('button', { name: '聊天', exact: true }).click()
  await expect(page).toHaveURL(/\/chat/)
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toBeVisible()
})

test('explains optional upstream credentials without blocking a ready connection', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: /^(打开设置中心|设置与模式)$/ }).first().click()
  if (await page.getByRole('menuitem', { name: '进入设置', exact: true }).isVisible()) await page.getByRole('menuitem', { name: '进入设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置中心' })
  await dialog.getByRole('button', { name: 'Hermes 连接', exact: true }).click()
  await expect(dialog.locator('[aria-label="Hermes 连接状态"]')).toBeVisible()
  await expect(dialog.getByText('9119 连接正常', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: '服务账号（按需配置）' })).toBeVisible()
  await expect(dialog.getByText(/无需配置用户名和密码/)).toBeVisible()
  await expect(dialog.locator('input[name="upstream-username"]')).toHaveValue('')
  await expect(dialog.locator('input[name="upstream-password"]')).toHaveValue('')
  await page.screenshot({ path: testInfo.outputPath('loopback-authorization.png') })
})

test('uses the yaoyao-webui grouped model picker without a mobile full-screen sheet', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await page.locator('.composer-tool--model').click()

  const dialog = page.getByRole('dialog', { name: '选择模型' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByPlaceholder('搜索模型名称或 ID')).toBeFocused()
  await expect(dialog.locator('.model-dialog__group-header')).toContainText('OpenAI')
  await expect(dialog.locator('.model-dialog__item--active')).toContainText('gpt-5.6')

  const desktopBox = await dialog.boundingBox()
  expect(desktopBox?.width).toBeGreaterThanOrEqual(450)
  expect(desktopBox?.width).toBeLessThanOrEqual(480)

  await dialog.getByPlaceholder('搜索模型名称或 ID').fill('gpt-5.5')
  await expect(dialog.locator('.model-dialog__item')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.composer-tool--model').click()
  const mobileBox = await dialog.boundingBox()
  expect(mobileBox?.x).toBeGreaterThanOrEqual(12)
  expect(mobileBox?.width).toBeLessThanOrEqual(366)
  expect(mobileBox?.height).toBeLessThan(820)
})

test.skip('navigates every 9119 workspace without blank transitions', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await expect(page.getByRole('option').first()).toContainText('夭夭 Web 验收会话')
  await expect(page.getByRole('option').first()).toContainText('夭夭')
  await expect(page.locator('.desktop-sidebar').getByText('已置顶 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '团队' }).click()
  await expect(page.getByRole('heading', { name: '设计验收' })).toBeVisible()
  await expect(page.getByRole('button', { name: '对话', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '团队', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '文件库', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新建团队' })).toBeVisible()
  await page.mouse.move(1200, 20)
  await expect(page.getByRole('button', { name: '新建团队' })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button', { name: '新建团队' })).toHaveCSS('font-weight', '650')
  await expect(page.getByRole('button', { name: '管理团队', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible()

  await page.goto('/files')
  await expect(page.getByRole('heading', { name: '文件库', exact: true }).last()).toBeVisible()
  const fileSidebar = page.locator('.desktop-sidebar')
  await expect(fileSidebar.getByRole('button', { name: '新建聊天' })).toBeVisible()
  await expect(fileSidebar.getByRole('button', { name: '搜索', exact: true })).toHaveCount(0)
  const compactControlHeights = await fileSidebar.locator('.sidebar-search-trigger, .sidebar-primary-action button, .sidebar-feature-nav button').evaluateAll(elements => (
    elements.map(element => element.getBoundingClientRect().height)
  ))
  expect(compactControlHeights.length).toBeGreaterThanOrEqual(3)
  expect(Math.max(...compactControlHeights)).toBeLessThanOrEqual(36)
  await expect(page.getByText('demo-report.pdf')).toBeVisible()
  const firstFileCard = page.locator('.library-grid article').first()
  const cardGeometry = await firstFileCard.evaluate(element => {
    const card = element.getBoundingClientRect()
    const preview = element.querySelector('.library-thumb')?.getBoundingClientRect()
    return { width: card.width, previewHeight: preview?.height || 0 }
  })
  expect(cardGeometry.width).toBeGreaterThanOrEqual(220)
  expect(cardGeometry.previewHeight).toBe(154)
  await page.getByText('demo-report.pdf').click()
  await expect(page.getByRole('dialog', { name: /预览 demo-report.pdf/ })).toBeVisible()
  await expect(page.locator('.preview-meta')).toHaveCount(0)
  const previewDialog = page.getByRole('dialog', { name: /预览 demo-report.pdf/ })
  await expect(previewDialog.getByRole('link', { name: '下载' })).toBeVisible()
  await expect(previewDialog.getByRole('button', { name: '加入输入框' })).toBeVisible()
  await expect(previewDialog.locator('.preview-close')).toBeVisible()
  const modalHeight = await page.locator('.preview-modal').evaluate(element => element.getBoundingClientRect().height)
  expect(modalHeight).toBeGreaterThan(600)
  await previewDialog.locator('.preview-close').click()
  await fileSidebar.getByRole('button', { name: '新建聊天' }).click()
  await expect(page).toHaveURL(/\/chat\/draft-[^?]+\?profile=yaoyao/)

  await page.goto('/artifacts')
  await expect(page).toHaveURL(/\/chat$/)
  await expect(page.getByRole('button', { name: '产物', exact: true })).toHaveCount(0)
  expect(consoleErrors).toEqual([])
})

test.skip('uses the active session or group title in the browser title', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  await expect(page).toHaveTitle('夭夭 Web 验收会话 · 夭夭')

  await page.goto('/groups/group-demo')
  await expect(page).toHaveTitle('设计与工程协作 · 夭夭')
})

test.skip('uses split search for topics, teams, and archived content', async ({ page }) => {
  await page.getByRole('button', { name: '团队' }).click()
  await expect(page.getByRole('heading', { name: '设计验收' })).toBeVisible()

  await page.locator('.desktop-sidebar').getByRole('button', { name: '搜索', exact: true }).click()
  const searchDialog = page.getByRole('dialog', { name: '搜索话题、团队或归档' })
  await expect(searchDialog).toBeVisible()
  await expect(searchDialog.getByRole('navigation', { name: '搜索范围' })).toContainText('设计与工程协作')
  await searchDialog.getByRole('searchbox', { name: '搜索全部' }).fill('发布检查')
  const topicResult = searchDialog.getByRole('option', { name: /发布检查/ })
  await expect(topicResult).toBeVisible()
  await topicResult.click()
  await expect(page).toHaveURL(/\/groups\/22222222-2222-4222-8222-222222222222\/88888888-8888-4888-8888-888888888888$/)
  await expect(searchDialog).toBeHidden()
})

test.skip('shows member mascot clusters in the list and during creation', async ({ page }) => {
  await page.getByRole('button', { name: '团队' }).click()

  const topicRow = page.locator('[data-sidebar-id="topic:22222222-2222-4222-8222-222222222222:77777777-7777-4777-8777-777777777777"]')
  const roomAvatar = topicRow.getByRole('img', { name: '设计验收团队头像' })
  await expect(roomAvatar).toBeVisible()
  await expect(roomAvatar.locator('.team-avatar__member')).toHaveCount(3)
  const releaseTopicAvatar = page.locator('[data-sidebar-id="topic:22222222-2222-4222-8222-222222222222:88888888-8888-4888-8888-888888888888"]').first().locator('.team-avatar__member')
  await expect(releaseTopicAvatar).toHaveCount(3)

  await page.getByRole('button', { name: '新建团队' }).click()
  const dialog = page.getByRole('dialog', { name: '新建团队' })
  await expect(dialog.getByRole('region', { name: '团队预设' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /信息收集团队/ })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /信息收集团队/ })).toContainText('还缺 2 人')
  await expect(dialog.getByText('由成员的动态角色自动组成')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '成员组合' })).toBeVisible()
  await expect(dialog.locator('.team-avatar__member')).toHaveCount(3)
  await expect(dialog.getByRole('button', { name: '上传图片' })).toBeVisible()
  await dialog.locator('input[type="file"]').setInputFiles('public/brand/AppIcon-1024.png')
  await expect(dialog.getByText('使用上传的图片')).toBeVisible()
  await expect(dialog.getByRole('img', { name: '团队团队头像' }).locator('img')).toBeVisible()
})

test.skip('updates an existing team avatar from the Web manager', async ({ page }) => {
  await page.getByRole('button', { name: '团队' }).click()
  await page.getByRole('button', { name: '管理团队', exact: true }).click()

  const manager = page.locator('.group-manager')
  const preview = manager.getByRole('img', { name: '设计与工程协作团队头像' })
  await expect(preview.locator('.team-avatar__member')).toHaveCount(3)
  const uploadRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/rooms/22222222-2222-4222-8222-222222222222'))
  await manager.locator('input[type="file"]').setInputFiles('public/brand/AppIcon-1024.png')
  expect((await uploadRequest).postDataJSON().avatar).toMatch(/^data:image\/png;base64,/)
  await expect(manager.getByText('使用上传的图片')).toBeVisible()
  await expect(preview.locator('img')).toBeVisible()

  const dynamicRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/rooms/22222222-2222-4222-8222-222222222222'))
  await manager.getByRole('button', { name: '成员组合' }).click()
  expect((await dynamicRequest).postDataJSON()).toMatchObject({ avatar: '' })
  await expect(manager.getByText('由成员的动态角色自动组成')).toBeVisible()
  await expect(preview.locator('.team-avatar__member')).toHaveCount(3)
})

test.skip('selects one protocol v5 host independently from no-mention replies', async ({ page }) => {
  await page.getByRole('button', { name: '团队' }).click()
  await expect(page.locator('.group-host-chip')).toHaveText('管理员 夭夭')

  await page.getByRole('button', { name: '新建团队' }).click()
  const createDialog = page.getByRole('dialog', { name: '新建团队' })
  await createDialog.getByRole('button', { name: /yaoer/ }).click()
  await createDialog.getByLabel('管理员').selectOption({ label: '瑶儿' })
  await expect(createDialog.getByLabel('所有成员无需 @ 也回复')).toBeChecked()
  await createDialog.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: '管理团队', exact: true }).click()
  const manager = page.locator('.group-manager')
  await expect(manager.getByLabel('管理员')).toHaveValue('33333333-3333-4333-8333-333333333333')
  const promoteRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/agents/34343434-3434-4434-8434-343434343434'))
  await manager.getByLabel('管理员').selectOption({ label: '瑶儿' })
  expect((await promoteRequest).postDataJSON()).toMatchObject({ isHost: true })
  await expect(manager.locator('article').filter({ hasText: '瑶儿' }).getByText('管理员', { exact: true })).toBeVisible()
  await expect(page.locator('.group-host-chip')).toHaveText('管理员 瑶儿')

  const restoreRequest = page.waitForRequest(request => request.method() === 'PATCH' && request.url().endsWith('/agents/33333333-3333-4333-8333-333333333333'))
  await manager.getByLabel('管理员').selectOption({ label: '夭夭' })
  expect((await restoreRequest).postDataJSON()).toMatchObject({ isHost: true })
  await expect(page.locator('.group-host-chip')).toHaveText('管理员 夭夭')
})

test.skip('edits every protocol v5 Agent setting with one inspector close control', async ({ page }) => {
  await page.getByRole('button', { name: '团队' }).click()
  await expect(page.getByRole('heading', { name: '设计验收' })).toBeVisible()
  await page.getByRole('button', { name: '管理团队', exact: true }).click()

  await expect(page.getByRole('button', { name: '关闭团队管理' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '关闭预览' })).toHaveCount(0)
  await expect(page.getByLabel('最多回复轮数')).toHaveValue('-1')
  await page.getByRole('button', { name: '设置瑶儿' }).click()

  const editor = page.getByRole('dialog', { name: '瑶儿 Agent 设置' })
  await expect(page.locator('.group-manager .agent-editor')).toHaveCount(0)
  await expect(editor.getByLabel('群内名称')).toHaveValue('瑶儿')
  await expect(editor.getByLabel('职责说明')).toHaveValue('评审 Agent')
  await expect(editor.getByLabel('模型')).toHaveValue(JSON.stringify(['openai', 'gpt-5.6']))
  await expect(editor.getByLabel('推理强度')).toHaveValue('medium')
  await expect(editor.getByLabel('快速模式')).toHaveValue('false')

  await editor.getByLabel('群内名称').fill('所有人')
  const rejectedResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/api\/app\/groups\/rooms\/[^/]+\/agents\/[^/]+$/.test(new URL(response.url()).pathname))
  await editor.getByRole('button', { name: '保存 Agent 设置' }).click()
  expect((await rejectedResponse).status()).toBe(409)
  await expect(editor.getByRole('alert')).toContainText('成员名称不能使用“所有人”')
  await editor.getByRole('button', { name: '关闭 Agent 设置' }).click()
  await page.getByRole('button', { name: '设置瑶儿' }).click()
  await expect(editor.getByLabel('群内名称')).toHaveValue('所有人')
  await editor.getByLabel('群内名称').fill('瑶儿')

  await editor.getByLabel('模型').selectOption(JSON.stringify(['openai', 'gpt-5.5']))
  await editor.getByLabel('推理强度').selectOption('xhigh')
  await editor.getByLabel('快速模式').selectOption('true')
  await editor.getByLabel('无需 @ 也回复').check()
  const updateRequest = page.waitForRequest(request => request.method() === 'PATCH' && /\/api\/app\/groups\/rooms\/[^/]+\/agents\/[^/]+$/.test(new URL(request.url()).pathname))
  await editor.getByRole('button', { name: '保存 Agent 设置' }).click()
  expect((await updateRequest).postDataJSON()).toMatchObject({
    model: 'gpt-5.5', provider: 'openai', reasoningEffort: 'xhigh', fastMode: true, replyWithoutMention: true,
  })
  await expect(editor.getByLabel('模型')).toHaveValue(JSON.stringify(['openai', 'gpt-5.5']))

  await editor.getByLabel('模型').selectOption(JSON.stringify(['openai', 'gpt-5.6']))
  await editor.getByLabel('推理强度').selectOption('medium')
  await editor.getByLabel('快速模式').selectOption('false')
  await editor.getByLabel('无需 @ 也回复').uncheck()
  const restoreResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && /\/api\/app\/groups\/rooms\/[^/]+\/agents\/[^/]+$/.test(new URL(response.url()).pathname))
  await editor.getByRole('button', { name: '保存 Agent 设置' }).click()
  expect((await restoreResponse).status()).toBe(200)
})

test.skip('pins the named Agent typing status above the group composer', async ({ page }) => {
  await page.getByRole('button', { name: '团队' }).click()
  const composer = page.locator('.composer-area')
  await page.getByRole('textbox', { name: '发消息给团队，输入 @ 提及 Agent' }).fill('@夭夭 检查输入状态')
  await page.getByRole('button', { name: '发送消息' }).click()

  const typing = composer.getByRole('status', { name: 'Agent 输入状态' })
  await page.waitForTimeout(250)
  await expect(typing).toHaveCount(0)
  await expect(typing).toHaveText('夭夭正在输入…')
  await expect(page.locator('.message-stack .thinking-indicator')).toHaveCount(0)
  const typingBox = await typing.boundingBox()
  const shellBox = await composer.locator('.composer-shell').boundingBox()
  expect(typingBox?.y).toBeLessThan(shellBox?.y ?? 0)
  await expect(typing).toHaveCount(0, { timeout: 4_000 })
})

test.skip('reconnects the group event stream after an unexpected close', async ({ page }) => {
  await page.getByRole('button', { name: '团队' }).click()
  await expect(page.getByText('已同步', { exact: true })).toBeVisible()
  const before = await (await page.request.get('http://127.0.0.1:19119/__test/group-connections')).json() as { count: number }
  await page.request.post('http://127.0.0.1:19119/__test/groups/disconnect')
  await expect.poll(async () => {
    const value = await (await page.request.get('http://127.0.0.1:19119/__test/group-connections')).json() as { count: number }
    return value.count
  }, { timeout: 5_000 }).toBeGreaterThan(before.count)
  await expect(page.getByText('已同步', { exact: true })).toBeVisible()
})

test.skip('recovers the group page after its initial upstream connection fails', async ({ page }) => {
  await page.request.post('http://127.0.0.1:19119/__test/groups/availability', { data: { available: false } })
  await page.getByRole('button', { name: '团队' }).click()
  await expect(page.getByRole('heading', { name: '团队服务暂不可用' })).toBeVisible()
  await page.request.post('http://127.0.0.1:19119/__test/groups/availability', { data: { available: true } })
  await expect(page.getByRole('heading', { name: '设计验收' })).toBeVisible({ timeout: 5_000 })
})

test('previews an octet-stream Markdown file from the file library', async ({ page }) => {
  await page.route('**/api/app/files**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/app/files') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profile: 'yaoyao',
          items: [{
            id: 'markdown-file',
            path: '/tmp/版本说明.md',
            name: '版本说明.md',
            extension: '.md',
            mimeType: 'application/octet-stream',
            size: 48,
            modifiedAt: Date.now() / 1000,
            exists: true,
            origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 Web 验收会话' }],
          }, {
            id: 'empty-markdown-file',
            path: '/tmp/空白说明.md',
            name: '空白说明.md',
            extension: 'md',
            mimeType: 'application/octet-stream',
            size: 0,
            modifiedAt: Date.now() / 1000,
            exists: true,
            origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 Web 验收会话' }],
          }],
          nextCursor: null,
          total: 2,
        }),
      })
      return
    }
    if (url.pathname === '/api/app/files/markdown-file/preview') {
      await route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: '# 版本说明\n\n- Markdown 预览已恢复',
      })
      return
    }
    if (url.pathname === '/api/app/files/empty-markdown-file/preview') {
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '' })
      return
    }
    await route.continue()
  })

  await page.goto('/files')
  await page.getByText('版本说明.md', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览 版本说明.md' })
  await expect(dialog.locator('.preview-text h1')).toHaveText('版本说明')
  await expect(dialog.getByText('Markdown 预览已恢复', { exact: true })).toBeVisible()
  await dialog.locator('.preview-close').click()
  await page.getByText('空白说明.md', { exact: true }).click()
  const emptyDialog = page.getByRole('dialog', { name: '预览 空白说明.md' })
  await expect(emptyDialog.locator('.preview-text')).toBeVisible()
  await expect(emptyDialog.locator('.preview-unavailable')).toHaveCount(0)
})

test('keeps DOCX body at 36px inset with zero canvas margin', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 760 })
  await page.route('**/api/app/files**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/app/files') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profile: 'yaoyao',
          items: [{
            id: 'wide-docx-file',
            path: '/tmp/宽版文档.docx',
            name: '宽版文档.docx',
            extension: 'docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 1024,
            modifiedAt: Date.now() / 1000,
            exists: true,
            origins: [{ profile: 'yaoyao', sessionId: 'session-demo', sessionTitle: '夭夭 Web 验收会话' }],
          }],
          nextCursor: null,
          total: 1,
        }),
      })
      return
    }
    if (url.pathname === '/api/app/files/wide-docx-file/preview') {
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        body: Buffer.from(WIDE_DOCX_BASE64, 'base64'),
      })
      return
    }
    await route.continue()
  })

  await page.goto('/files')
  await page.getByText('宽版文档.docx', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '预览 宽版文档.docx' })
  const office = dialog.locator('.preview-office')
  await expect(office.locator('section.docx')).toBeVisible()
  const geometry = await office.evaluate(element => {
    const wrapper = element.querySelector<HTMLElement>('.docx-wrapper')!
    const pageElement = element.querySelector<HTMLElement>('section.docx')!
    const article = pageElement.querySelector<HTMLElement>('article')!
    const table = article.querySelector<HTMLElement>('table')!
    const officeRect = element.getBoundingClientRect()
    const pageRect = pageElement.getBoundingClientRect()
    const officeStyle = getComputedStyle(element)
    const wrapperStyle = getComputedStyle(wrapper)
    const articleStyle = getComputedStyle(article)
    return {
      officeLeft: officeRect.left,
      pageLeft: pageRect.left,
      pageWidth: pageRect.width,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      wrapperWidth: wrapper.getBoundingClientRect().width,
      articlePaddingTop: Number.parseFloat(articleStyle.paddingTop),
      articlePaddingLeft: Number.parseFloat(articleStyle.paddingLeft),
      articlePaddingRight: Number.parseFloat(articleStyle.paddingRight),
      tableLeft: table.getBoundingClientRect().left,
      tableRight: table.getBoundingClientRect().right,
      officeBackground: officeStyle.backgroundColor,
      wrapperBackground: wrapperStyle.backgroundColor,
      wrapperPaddingTop: Number.parseFloat(wrapperStyle.paddingTop),
      wrapperPaddingLeft: Number.parseFloat(wrapperStyle.paddingLeft),
      wrapperPaddingRight: Number.parseFloat(wrapperStyle.paddingRight),
    }
  })
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.clientWidth)
  expect(geometry.pageLeft).toBeGreaterThanOrEqual(geometry.officeLeft)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  expect(Math.abs(geometry.wrapperWidth - geometry.clientWidth)).toBeLessThan(1)
  expect(geometry.articlePaddingTop).toBe(36)
  expect(geometry.articlePaddingLeft).toBe(36)
  expect(geometry.articlePaddingRight).toBe(36)
  expect(geometry.tableLeft).toBeGreaterThanOrEqual(geometry.pageLeft - 1)
  expect(geometry.tableRight).toBeLessThanOrEqual(geometry.pageLeft + geometry.pageWidth + 1)
  expect(geometry.officeBackground).toBe('rgb(255, 255, 255)')
  expect(geometry.wrapperBackground).toBe('rgb(255, 255, 255)')
  expect(geometry.wrapperPaddingTop).toBe(0)
  expect(geometry.wrapperPaddingLeft).toBe(0)
  expect(geometry.wrapperPaddingRight).toBe(0)

  await page.setViewportSize({ width: 930, height: 760 })
  const centered = await office.evaluate(element => {
    const pageElement = element.querySelector<HTMLElement>('section.docx')!
    const officeRect = element.getBoundingClientRect()
    const pageRect = pageElement.getBoundingClientRect()
    return {
      pageWidth: pageRect.width,
      clientWidth: element.clientWidth,
      leftGap: pageRect.left - officeRect.left,
      rightGap: officeRect.right - pageRect.right,
    }
  })
  expect(centered.pageWidth).toBeLessThan(centered.clientWidth)
  expect(centered.leftGap).toBeGreaterThanOrEqual(18)
  expect(centered.rightGap).toBeGreaterThanOrEqual(18)
  expect(Math.abs(centered.leftGap - centered.rightGap)).toBeLessThanOrEqual(12)
})

test('keeps pins first and loads the next session page at the list bottom', async ({ page }) => {
  const sidebar = page.locator('.desktop-sidebar')
  const items = sidebar.locator('.sidebar-list [role="option"]')
  await expect(items).toHaveCount(100)
  await expect(items.first()).toContainText('夭夭 Web 验收会话')
  await expect(sidebar.getByRole('button', { name: '继续加载会话' })).toBeVisible()

  const list = sidebar.locator('.sidebar-list')
  await list.evaluate(element => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(items).toHaveCount(103)
  await expect(sidebar.getByRole('button', { name: '继续加载会话' })).toHaveCount(0)
})

test('switches the composer model to the selected historical session model', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  await expect(page.locator('.composer-tool--model')).toContainText('gpt-5.6')
  await page.getByRole('option', { name: /第二个会话/ }).click()
  await expect(page.locator('.composer-tool--model')).toContainText('gpt-5.5')
})

test('restores a routed conversation even when unread-count refresh fails', async ({ page }) => {
  await page.route('**/api/app/sessions/unread*', async route => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unread unavailable' }) })
  })

  await page.goto('/chat/session-demo')
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
  await page.reload()
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
})

test('opens a conversation even when marking it read is unsupported', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.route('**/api/app/sessions/unread/*', async route => {
    await route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: 'Method Not Allowed' }) })
  })

  await page.getByRole('option').filter({ hasText: '第二个会话' }).click()
  await expect(page).toHaveURL(/\/chat\/session-second\?profile=yaoyao/)
  await expect(page.getByText('已整理完成。下面是', { exact: false })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('syncs the blue fast-mode shortcut with the iOS-compatible session config', async ({ page }) => {
  await page.request.post('http://127.0.0.1:19119/__test/rpc-requests/reset')
  await page.goto('/chat/session-demo')
  const fast = page.getByRole('button', { name: '快速模式：已关闭' })
  await expect(fast).toHaveAttribute('aria-pressed', 'false')
  await fast.click()
  const enabled = page.getByRole('button', { name: '快速模式：已开启' })
  await expect(enabled).toHaveAttribute('aria-pressed', 'true')
  await expect(enabled).toHaveCSS('color', 'rgb(22, 119, 255)')

  await page.getByRole('textbox', { name: '输入消息，Enter 发送，Shift + Enter 换行' }).fill('使用快速模式')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByText('这是来自假 Gateway 的流式回复。', { exact: true })).toBeVisible()

  const payload = await (await page.request.get('http://127.0.0.1:19119/__test/rpc-requests')).json() as { requests: Array<{ method: string; params: Record<string, unknown> }> }
  const fastConfigIndex = payload.requests.findIndex(request => request.method === 'config.set' && request.params.key === 'fast')
  const promptIndex = payload.requests.findIndex(request => request.method === 'prompt.submit')
  expect(fastConfigIndex).toBeGreaterThanOrEqual(0)
  expect(promptIndex).toBeGreaterThan(fastConfigIndex)
  expect(payload.requests[fastConfigIndex]?.params).toMatchObject({ key: 'fast', value: 'fast', scope: 'session' })

  await enabled.click()
  await expect(page.getByRole('button', { name: '快速模式：已关闭' })).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => {
    const next = await (await page.request.get('http://127.0.0.1:19119/__test/rpc-requests')).json() as typeof payload
    return next.requests.filter(request => request.method === 'config.set' && request.params.key === 'fast').at(-1)?.params.value
  }).toBe('normal')
})

test('reconciles an iOS fast-mode selection from the resumed 9119 session', async ({ page }) => {
  await page.request.post('http://127.0.0.1:19119/__test/rpc-requests/reset')
  await page.goto('/chat/session-yaoer?profile=yaoer')
  await expect(page.getByRole('button', { name: '快速模式：已关闭' })).toBeVisible()
  await page.getByRole('textbox', { name: '输入消息，Enter 发送，Shift + Enter 换行' }).fill('读取 iOS 快速模式')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByRole('button', { name: '快速模式：已开启' })).toHaveCSS('color', 'rgb(22, 119, 255)')

  const payload = await (await page.request.get('http://127.0.0.1:19119/__test/rpc-requests')).json() as { requests: Array<{ method: string; params: Record<string, unknown> }> }
  expect(payload.requests.some(request => request.method === 'session.resume' && request.params.session_id === 'session-yaoer')).toBe(true)
  expect(payload.requests.some(request => request.method === 'config.set' && request.params.key === 'fast')).toBe(false)
})

test('keeps the show-thinking preference across sessions of the same Agent', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await expect(page.locator('.turn-trace')).toHaveCount(1)
  await page.locator('.composer-tool[aria-label="设置"]').click()
  const setting = page.getByRole('switch', { name: /显示思考/ })
  await expect(setting).toHaveAttribute('aria-checked', 'true')
  await setting.click()
  await expect(page.locator('.turn-trace')).toHaveCount(0)
  await page.getByRole('option').filter({ hasText: '第二个会话' }).click()
  await expect(page.locator('.turn-trace')).toHaveCount(0)
  await page.locator('.composer-tool[aria-label="设置"]').click()
  await page.getByRole('switch', { name: /显示思考/ }).click()
  await expect(page.locator('.turn-trace')).toHaveCount(1)
})

test('restores a legacy session link under its owning Agent profile', async ({ page }) => {
  await page.goto('/chat/session-yaoer')
  await expect(page.getByText('瑶儿历史消息', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/chat\/session-yaoer\?profile=yaoer/)
  await page.reload()
  await expect(page.getByText('瑶儿历史消息', { exact: true })).toBeVisible()
})

test.skip('renders historical assistant MEDIA as Markdown in chat and group chat', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const image = page.locator('.markdown img[alt="夭夭 Logo"]')
  await expect(image).toBeVisible()
  await image.click()
  const mediaDialog = page.getByRole('dialog', { name: /预览 AppIcon-1024.png/ })
  await expect(mediaDialog).toBeVisible()
  await expect(mediaDialog.getByRole('button', { name: '下一张媒体' })).toBeVisible()
  await mediaDialog.getByRole('button', { name: '下一张媒体' }).click()
  await expect(mediaDialog.locator('img')).toHaveAttribute('src', /variant=2/)
  await page.keyboard.press('ArrowLeft')
  await expect(mediaDialog.locator('img')).not.toHaveAttribute('src', /variant=2/)
  await expect(mediaDialog.getByRole('link', { name: /下载 AppIcon-1024\.png/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /预览 AppIcon-1024.png/ })).toBeHidden()

  await image.click()
  const reopenedMediaDialog = page.getByRole('dialog', { name: /预览 AppIcon-1024.png/ })
  await reopenedMediaDialog.getByRole('button', { name: '添加到聊天' }).click()
  await expect(reopenedMediaDialog).toBeHidden()
  await expect(page.locator('.composer-attachments img[alt="AppIcon-1024.png"]')).toBeVisible()

  await page.getByRole('button', { name: '团队' }).click()
  await expect(page.locator('.markdown img[alt="AppIcon-1024.png"]')).toBeVisible()
})

test.skip('selects existing group topics and creates a new protocol v4 topic on first send', async ({ page }) => {
  const roomId = '22222222-2222-4222-8222-222222222222'
  const existingTopicId = '88888888-8888-4888-8888-888888888888'
  const existingTopicSidebarId = `topic:${roomId}:${existingTopicId}`

  await page.getByRole('button', { name: '团队' }).click()
  const sidebar = page.locator('.desktop-sidebar')
  const existingTopic = sidebar.locator(`[data-sidebar-id="${existingTopicSidebarId}"]`)
  await expect(sidebar.getByRole('button', { name: '返回对话' })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: '折叠侧边栏' })).toBeVisible()
  await expect(sidebar.getByText('话题列表', { exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: '新建话题' })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: '新建团队' })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: '对话', exact: true })).toBeVisible()
  await expect(sidebar.locator('.sidebar-footer')).toBeVisible()
  await expect(existingTopic).toContainText('发布检查')
  await expect(existingTopic).toHaveClass(/sidebar-item--topic/)

  const existingTopicRequest = page.waitForRequest(request => {
    const url = new URL(request.url())
    return request.method() === 'GET'
      && url.pathname === `/api/app/groups/rooms/${roomId}/messages`
      && url.searchParams.get('topicId') === existingTopicId
  })
  const existingTopicRead = page.waitForRequest(request => {
    const url = new URL(request.url())
    return request.method() === 'PATCH'
      && url.pathname === `/api/app/groups/rooms/${roomId}/topics/${existingTopicId}/read`
  })
  await existingTopic.click()
  await existingTopicRequest
  expect((await existingTopicRead).postDataJSON()).toMatchObject({ throughSeq: 3 })
  await expect(page).toHaveURL(new RegExp(`/groups/${roomId}/${existingTopicId}$`))
  const timeline = page.locator('.message-stack')
  await expect(timeline.getByText('请核对发布话题的独立历史。', { exact: true })).toBeVisible()
  await expect(timeline.getByText('大家好，检查一下群聊输入框。', { exact: true })).toHaveCount(0)

  await sidebar.getByRole('button', { name: '新建话题' }).click()
  const teamPicker = page.getByRole('dialog', { name: '选择团队' })
  await expect(teamPicker).toBeVisible()
  await teamPicker.locator('.topic-team-picker__choose').filter({ hasText: '设计与工程协作' }).click()
  const draftTopic = sidebar.locator('.sidebar-item--topic').filter({ hasText: '新话题' })
  await expect(draftTopic).toBeVisible()
  const draftSidebarId = await draftTopic.getAttribute('data-sidebar-id')
  const newTopicId = draftSidebarId?.split(':').at(-1) || ''
  expect(newTopicId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  expect(newTopicId).not.toBe(existingTopicId)
  await expect(page).toHaveURL(new RegExp(`/groups/${roomId}/${newTopicId}$`))

  const content = '新的发布验收话题'
  const sendRequestPromise = page.waitForRequest(request => {
    const url = new URL(request.url())
    return request.method() === 'POST' && url.pathname === `/api/app/groups/rooms/${roomId}/messages`
  })
  await page.getByRole('textbox', { name: '发消息给团队，输入 @ 提及 Agent' }).fill(content)
  await page.getByRole('button', { name: '发送消息' }).click()
  const sendRequest = await sendRequestPromise
  const sentPayload = sendRequest.postDataJSON() as { topicId: string; content: string; clientMessageId: string }
  expect(sentPayload).toMatchObject({ topicId: newTopicId, content })

  const createdTopic = sidebar.locator(`[data-sidebar-id="topic:${roomId}:${newTopicId}"]`)
  const sentMessage = page.locator(`[data-message-id="${sentPayload.clientMessageId}"]`)
  await expect(createdTopic).toContainText(content)
  await expect(sentMessage).toContainText(content)

  await page.reload()
  await expect(createdTopic).toContainText(content)
  await expect(sentMessage).toContainText(content)
})

test('renders persisted user file markers as attachment cards', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  const userMessage = page.locator('[data-message-id="message-user-file"]')
  await expect(userMessage).toContainText('查看附件')
  await expect(userMessage.getByRole('button', { name: /测试报告\.docx/ })).toBeVisible()
  await expect(userMessage).not.toContainText('@file:')
  await expect(userMessage).not.toContainText('用户附加文件')
})

test('renders persisted user image markers as direct images instead of file cards', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  const userMessage = page.locator('[data-message-id="message-user-image"]')
  const imageAttachment = userMessage.locator('.message__attachment--image')
  await expect(imageAttachment).toBeVisible()
  await expect(imageAttachment.locator('img[alt="测试图片.png"]')).toBeVisible()
  await expect(imageAttachment.locator('strong')).toHaveCount(0)
  await expect(imageAttachment).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(userMessage).not.toContainText('@image:')
  await expect(userMessage).not.toContainText('[screenshot]')
  await imageAttachment.click()
  await expect(page.getByRole('dialog', { name: '预览 测试图片.png' })).toBeVisible()
})

test('folds tool result rows into their expandable tool call', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const trace = page.locator('.turn-trace').first()
  await expect(trace).not.toHaveAttribute('open', '')
  await expect(trace).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(trace.locator('summary')).toContainText('思考与工具')
  await expect(trace.locator('summary')).toContainText('2 段思考 · 2 个工具')
  await expect(trace.locator('summary > :last-child')).toHaveClass(/turn-trace__caret/)
  await trace.locator('summary').click()
  await expect(trace).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(trace.locator('.turn-trace__reasoning')).toHaveCount(2)
  await expect(trace.locator('.tool-trace')).toHaveCount(2)
  await expect(trace.locator('.tool-trace > button > :last-child.tool-trace__caret')).toHaveCount(2)
  await expect(trace.locator('.tool-trace__details')).toHaveCount(2)
  await expect(trace.locator('.tool-trace__details').filter({ hasText: '/tmp/demo-report.pdf' })).toBeVisible()
  await expect(trace.locator('.tool-trace__details pre').first()).toHaveCSS('max-height', 'none')
  await expect(trace.locator('.tool-trace__details pre').first()).toHaveCSS('overflow-y', 'visible')
  const traceContent = trace.locator('.turn-trace__content')
  await expect(traceContent).toHaveCSS('overflow-y', 'auto')
  await expect(traceContent.locator(':scope > .turn-trace__item')).toHaveCount(4)
  const layout = await traceContent.evaluate(element => {
    const items = [...element.children] as HTMLElement[]
    return {
      maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
      leftOffsets: items.map(item => item.offsetLeft),
    }
  })
  expect(layout.maxHeight).toBeLessThanOrEqual(420)
  expect(new Set(layout.leftOffsets).size).toBe(1)
  const toolAlignment = await trace.locator('.tool-trace').first().evaluate(element => {
    const tool = element as HTMLElement
    const button = tool.querySelector<HTMLElement>(':scope > button')
    const detail = tool.querySelector<HTMLElement>('.tool-trace__details > section')
    return {
      toolLeft: tool.getBoundingClientRect().left,
      buttonLeft: button?.getBoundingClientRect().left,
      detailLeft: detail?.getBoundingClientRect().left,
    }
  })
  expect(toolAlignment.buttonLeft).toBeCloseTo(toolAlignment.toolLeft, 0)
  expect(toolAlignment.detailLeft).toBeCloseTo(toolAlignment.toolLeft, 0)
  await expect(page.locator('[data-message-id="message-tool-call"]')).toHaveCount(0)
  await expect(page.locator('.message--tool')).toHaveCount(0)
})

test('renders subtask completion as a collapsed timeline event', async ({ page }) => {
  await page.goto('/chat/session-demo')
  await expect(page.getByText('子任务已完成', { exact: true })).toBeVisible()
  const delegation = page.locator('.delegation-event').filter({ hasText: '子任务已完成' })
  await expect(delegation).toContainText('2 个子任务 · 2 已完成')
  await expect(delegation).not.toHaveAttribute('open', '')
})

test('renders background process exits as collapsed system events', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const event = page.locator('[data-message-id="message-background-process"] .background-process-event')
  const detail = event.locator('.markdown')
  await expect(event).toContainText('后台子任务已终止 · SIGTERM')
  await expect(event).not.toHaveAttribute('open', '')
  await expect(detail).toBeHidden()
  await event.locator('summary').click()
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('Command: ./run_mac.sh')
  await expect(page.locator('[data-message-id="message-background-process"]')).toHaveClass(/message--system/)
})

test('renders context compaction as a collapsed timeline event', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const compaction = page.locator('[data-message-id="message-compaction"] .compaction-event')
  await expect(compaction).toContainText('上下文已压缩')
  await expect(compaction).toContainText('压缩摘要已归档 · 点击查看')
  await expect(compaction).not.toHaveAttribute('open', '')
  await expect(compaction.getByText('Historical Task Snapshot', { exact: true })).toBeHidden()
  await compaction.locator('summary').click()
  await expect(compaction.getByText('Historical Task Snapshot', { exact: true })).toBeVisible()
  await expect(page.locator('[data-message-id="message-compaction"]')).toHaveClass(/message--system/)
})

test('renders model changes as a collapsed system event', async ({ page }) => {
  await page.goto('/chat/session-demo')
  const modelEvent = page.locator('.system-event').filter({ hasText: '模型已切换：gpt-5.6-terra' })
  await expect(modelEvent.getByText('模型已切换：gpt-5.6-terra', { exact: true })).toBeVisible()
  await expect(modelEvent).not.toHaveAttribute('open', '')
})

test('opens a local message file link as a floating preview card', async ({ page }) => {
  await page.route('**/Users/samien/Agents/%E6%96%B9%E6%A1%88%E8%8D%89%E7%A8%BF.md', route => route.fulfill({
    status: 200,
    contentType: 'text/markdown',
    body: '# 会话文件\n\n这是会话中的文本文件。',
  }))
  await page.goto('/chat/session-demo')
  const card = page.getByRole('link', { name: '预览文件 方案草稿.md' })
  await expect(card).toHaveClass(/file-link-card/)
  await card.click()
  const dialog = page.getByRole('dialog', { name: '预览 方案草稿.md' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.preview-text')).toBeVisible()
  const textPadding = await dialog.locator('.preview-text').evaluate(element => {
    const style = getComputedStyle(element)
    return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) }
  })
  expect(textPadding.left).toBeGreaterThanOrEqual(24)
  expect(textPadding.right).toBeGreaterThanOrEqual(24)
  const stageHeight = await dialog.locator('.preview-stage').evaluate(stage => stage.getBoundingClientRect().height)
  expect(stageHeight).toBeGreaterThan(500)
})

test('shows a thinking animation after submit until output starts', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  await page.locator('.composer-textarea').fill('请开始思考')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.locator('.thinking-indicator')).toBeVisible()
  await expect(page.getByText('这是来自假 Gateway 的流式回复。', { exact: true })).toBeVisible()
  await expect(page.locator('.thinking-indicator')).toHaveCount(0)
})

test.skip('uses HTTP commands and SSE for chat and team events without opening client WebSockets', async ({ page }, testInfo) => {
  const sockets: string[] = [], paths: string[] = []
  page.on('websocket', socket => sockets.push(socket.url()))
  page.on('request', request => paths.push(new URL(request.url()).pathname))
  await page.goto('/chat/session-demo?profile=yaoyao')
  await page.locator('.composer-textarea').fill('验证 HTTP SSE 入口')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByText('这是来自假 Gateway 的流式回复。', { exact: true })).toBeVisible()
  expect(paths.some(path => /^\/api\/realtime\/channels\/[^/]+\/commands$/.test(path))).toBe(true)
  expect(paths.some(path => /^\/api\/realtime\/channels\/[^/]+\/events$/.test(path))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('http-sse-chat.png'), fullPage: true })
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('option').filter({ hasText: '设计验收' }).click()
  await expect(page.getByRole('heading', { name: '设计验收' })).toBeVisible()
  expect(sockets).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('http-sse-team.png'), fullPage: true })
})

test('keeps streamed text below sealed interim commentary and its tool trace', async ({ page }) => {
  await page.goto('/chat/session-demo?profile=yaoyao')
  await page.locator('.composer-textarea').fill('验证流式分段')
  await page.getByRole('button', { name: '发送消息' }).click()

  const interim = page.locator('.message--assistant').filter({ hasText: '我先检查配置。' }).last()
  const current = page.locator('.message--assistant').filter({ hasText: '配置检查完成。' }).last()
  const trace = page.locator('.turn-trace').last()
  await expect(interim).toBeVisible()
  await expect(trace).toHaveClass(/turn-trace--running/)
  await expect(page.locator('.thinking-indicator')).toBeVisible()
  await expect(current).toBeVisible()

  const [interimBox, traceBox, currentBox] = await Promise.all([
    interim.boundingBox(), trace.boundingBox(), current.boundingBox(),
  ])
  expect(interimBox?.y).toBeLessThan(traceBox?.y ?? 0)
  expect(traceBox?.y).toBeLessThan(currentBox?.y ?? 0)

  await expect(trace).toHaveClass(/turn-trace--success/)
  await expect(page.getByText('配置检查完成。', { exact: true })).toHaveCount(1)
})

test('keeps the canonical logo and yaoyao-webui composer geometry', async ({ page }) => {
  const logo = page.locator('.rail__brand img')
  await expect(logo).toHaveAttribute('src', '/brand/AppIcon-1024.png')
  const emptyLogo = page.locator('.new-chat-empty__logo')
  await expect(emptyLogo).toHaveAttribute('src', '/brand/AppIcon-1024.png')
  await expect(page.getByText('聊点什么', { exact: true })).toBeVisible()
  await expect(page.locator('.timeline-header')).toHaveClass(/timeline-header--transparent/)
  await expect(page.locator('.composer-context')).toContainText('剩余 256.0k')
  await page.getByRole('button', { name: '推理强度：默认' }).click()
  await expect(page.locator('.composer-popover--reasoning')).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.locator('.composer-popover--settings')).toBeVisible()
  await expect(page.getByText('语音输入设置', { exact: true })).toBeVisible()
  await page.locator('.composer-shell').click()
  await page.getByRole('option').first().click()
  await expect(page.locator('.timeline')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.message--assistant .message__avatar')).toHaveCount(0)
  await expect(page.locator('.message--assistant .message__meta')).toHaveCount(0)
  const assistantMessage = page.locator('.message--assistant-anonymous:not(.message--tool-only)').first()
  await page.mouse.move(1200, 20)
  await expect(assistantMessage.locator('.message__actions')).toHaveCSS('opacity', '0')
  await assistantMessage.hover()
  await expect(assistantMessage.locator('.message__actions')).toHaveCSS('opacity', '1')
  await expect(page.locator('.message--tool-only .message__actions')).toHaveCount(0)
  await expect(page.locator('[data-message-id="message-thinking-tool"]')).toHaveCount(0)
  await expect(page.locator('.turn-trace')).toHaveCount(1)
  const userMessageMeta = page.locator('.message--user .message__meta')
  await expect(userMessageMeta).not.toHaveCount(0)
  expect(await userMessageMeta.evaluateAll(elements => elements.every(element => getComputedStyle(element).display === 'none'))).toBe(true)
  await expect(page.getByRole('button', { name: '会话操作' })).toBeVisible()
  await page.getByRole('button', { name: '会话操作' }).click()
  const sessionMenu = page.getByRole('menu', { name: '会话操作' })
  await expect(sessionMenu.getByText('会话大纲', { exact: true })).toBeVisible()
  await sessionMenu.getByText('会话大纲', { exact: true }).click()
  const outline = page.getByRole('navigation', { name: '会话大纲' })
  await expect(outline).toBeVisible()
  await expect(outline.getByText('请检查今天生成的产物。MEDIA:/brand/AppIcon-1024.png', { exact: true })).toBeVisible()
  await expect(outline.getByText('验收摘要', { exact: true })).toBeVisible()
  await outline.getByRole('button', { name: '跳转到 验收摘要' }).click()
  await expect(page.locator('[data-message-id="message-assistant"]')).toHaveClass(/message--revealed/)
  await page.getByRole('button', { name: '关闭会话大纲' }).click()
  await expect(outline).toBeHidden()
  await page.getByRole('button', { name: '会话操作' }).click()
  await expect(sessionMenu.getByText('取消置顶', { exact: true })).toBeVisible()
  const unpinIcon = sessionMenu.getByRole('menuitem', { name: '取消置顶' }).locator('.app-icon')
  await expect(unpinIcon.locator('path')).toHaveCount(2)
  await expect(unpinIcon.locator('path').last()).toHaveAttribute('d', 'M4 4l16 16')
  await expect(page.locator('.desktop-sidebar .sidebar-item--single-line').first().locator('.app-icon path')).toHaveAttribute('fill', 'currentColor')
  await expect(sessionMenu.getByText('重命名', { exact: true })).toBeVisible()
  await expect(sessionMenu.getByText('删除会话', { exact: true })).toBeVisible()
  await expect(sessionMenu.getByRole('menuitem', { name: '强制刷新历史' })).toBeVisible()
  await expect(page.getByText('置顶会话', { exact: true })).toHaveCount(0)
  const menuBox = await sessionMenu.evaluate(element => element.getBoundingClientRect().toJSON())
  expect(menuBox.width).toBeLessThanOrEqual(220)
  expect(menuBox.height).toBeLessThan(200)
  await expect(page.locator('.session-action-layer')).toHaveCount(0)
  await sessionMenu.getByText('取消置顶', { exact: true }).click()
  await expect(page.locator('.desktop-sidebar').getByText('已置顶 1', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '会话操作' }).click()
  await sessionMenu.getByText('置顶会话', { exact: true }).click()
  await expect(page.locator('.desktop-sidebar').getByText('已置顶 1', { exact: true })).toBeVisible()

  const compactSession = page.locator('.desktop-sidebar .sidebar-item--single-line').first()
  const compactMetrics = await compactSession.evaluate(element => {
    const title = element.querySelector('strong')
    return {
      height: element.getBoundingClientRect().height,
      weight: title ? Number(getComputedStyle(title).fontWeight) : 0,
    }
  })
  expect(compactMetrics.height).toBeLessThanOrEqual(31)
  expect(compactMetrics.weight).toBeLessThan(500)
  await compactSession.click({ button: 'right' })
  await expect(sessionMenu).toBeVisible()
  await page.keyboard.press('Escape')
  const composer = page.locator('.composer-shell')
  await expect(composer).toBeVisible()
  const geometry = await composer.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { width: rect.width, minHeight: style.minHeight, radius: style.borderRadius }
  })
  expect(geometry.width).toBeLessThanOrEqual(760)
  expect(geometry.minHeight).toBe('72px')
  expect(geometry.radius).toBe('18px')
  const send = page.getByRole('button', { name: '发送消息' })
  await expect(send).toHaveCSS('width', '34px')
  await expect(send).toHaveCSS('height', '34px')
})

test('uses the unified Grok-style sidebar, search trigger, and persistent collapse', async ({ page }) => {
  const sidebar = page.locator('.desktop-sidebar')
  await expect(sidebar).toBeVisible()
  await expect(sidebar).toHaveCSS('width', '264px')
  await expect(sidebar.locator('.brand-mark__name')).toHaveCount(0)
  await expect(sidebar.locator('.profile-switcher')).toHaveCount(0)
  await expect(sidebar.locator('.sidebar-account-switcher')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toHaveCSS('font-weight', '650')
  await expect(sidebar.getByText('历史记录', { exact: true })).toBeVisible()

  const searchTrigger = page.getByRole('button', { name: '搜索', exact: true })
  await searchTrigger.click()
  const searchDialog = page.getByRole('dialog', { name: '搜索会话' })
  await expect(searchDialog).toBeVisible()
  const search = searchDialog.getByPlaceholder('搜索会话')
  await expect(search).toBeVisible()
  await expect(sidebar.locator('.sidebar-search')).toHaveCount(0)
  const originalSessionCount = await sidebar.getByRole('option').count()
  await search.fill('验收')
  const sessionResult = searchDialog.getByRole('option', { name: /夭夭 Web 验收会话/ })
  await expect(sessionResult).toBeVisible()
  await expect(sidebar.getByRole('option')).toHaveCount(originalSessionCount)
  await sessionResult.click()
  await expect(page).toHaveURL(/\/chat\/session-demo\?profile=yaoyao/)
  await expect(searchDialog).toBeHidden()
  await expect(searchTrigger).toBeVisible()
  await expect(searchTrigger).toHaveAttribute('aria-expanded', 'false')

  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await expect(sidebar).toHaveCSS('width', '68px')
  const collapseBox = await page.getByRole('button', { name: '展开侧边栏' }).boundingBox()
  const accountBox = await sidebar.locator('.sidebar-account-switcher__main').boundingBox()
  expect(collapseBox?.y).toBeLessThan(accountBox?.y ?? 0)
  await expect(sidebar.getByText('历史记录', { exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toBeVisible()
  await page.reload()
  await expect(sidebar).toHaveCSS('width', '68px')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(sidebar).toHaveCSS('width', '264px')
  await expect(page.getByRole('dialog', { name: '搜索会话' })).toBeVisible()
})

test('uses the mobile composer and keeps the closed drawer inert', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole('navigation')).not.toBeVisible()
  const drawer = page.locator('.mobile-drawer')
  await expect(drawer).toHaveAttribute('aria-hidden', 'true')
  await expect(drawer).toHaveAttribute('inert', '')
  await expect(page.locator('.mobile-header .brand-mark__plate')).toBeVisible()
  await expect(page.locator('.mobile-header .brand-mark__name')).toHaveCount(0)
  await page.getByRole('button', { name: '打开导航' }).click()
  await expect(drawer.locator('.brand-mark__plate')).toBeVisible()
  await expect(drawer.locator('.brand-mark__name')).toHaveCount(0)
  await expect(page.locator('.composer-shell')).toHaveCSS('min-height', '118px')
  await expect(page.locator('.composer-textarea')).toHaveCSS('font-size', '16px')
})

test('renders the Kanban snapshot and mobile status control without page overflow', async ({ page }) => {
  await page.getByRole('button', { name: '看板', exact: true }).click()
  await expect(page).toHaveURL(/\/kanban\/default$/)
  await expect(page).toHaveTitle('产品研发 · 夭夭')
  await expect(page.getByRole('heading', { name: '产品研发', exact: true })).toBeVisible()
  await expect(page.getByRole('article', { name: /完成 Web 看板验收/ })).toBeVisible()
  await expect(page.locator('.kanban-column')).toHaveCount(8)

  await page.getByRole('article', { name: /完成 Web 看板验收/ }).click()
  await expect(page.getByRole('heading', { name: '完成 Web 看板验收', exact: true })).toBeVisible()
  await expect(page.getByText('请保留真实浏览器验收证据。', { exact: true })).toBeVisible()
  await expect(page.locator('.kanban-task-drawer').getByText('正在执行浏览器验收', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '关闭任务详情' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expect(page.getByRole('button', { name: '立即调度', exact: true })).toBeVisible()
  const card = page.getByRole('article', { name: /完成 Web 看板验收/ })
  await expect(card).toBeVisible()
  await expect(card.locator('.kanban-card__mobile-status select')).toBeVisible()
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    page: document.documentElement.scrollWidth,
    board: document.querySelector('.kanban-columns')?.scrollWidth || 0,
  }))
  expect(geometry.page).toBe(geometry.viewport)
  expect(geometry.board).toBeGreaterThan(geometry.viewport)
})

test('serves cached chat history locally and refreshes upstream only on explicit action', async ({ page }, testInfo) => {
  const messagesURL = (url: string) => url.includes('/api/app/sessions/session-demo/messages')
  const initial = page.waitForResponse(response => messagesURL(response.url()))
  await page.goto('/chat/session-demo?profile=yaoyao')
  expect((await initial).ok()).toBe(true)
  await expect(page.getByRole('button', { name: '会话操作', exact: true })).toBeVisible()
  const restored = page.waitForResponse(response => messagesURL(response.url()))
  await page.reload()
  expect((await restored).headers()['x-yaoyao-data-source']).toBe('local')
  await page.getByRole('button', { name: '会话操作', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '强制刷新历史' })).toBeVisible()
  await expect(page.getByRole('menu', { name: '会话操作' })).toHaveCSS('opacity', '1')
  await page.screenshot({ path: testInfo.outputPath('force-history-refresh.png') })
  const forced = page.waitForResponse(response => messagesURL(response.url()) && response.request().headers()['x-yaoyao-cache'] === 'bypass')
  await page.getByRole('menuitem', { name: '强制刷新历史' }).click()
  const refreshed = await forced
  expect(refreshed.ok()).toBe(true)
  expect(refreshed.headers()['x-yaoyao-data-source']).toBe('upstream')
  await expect(page.locator('.message--assistant').filter({ hasText: '验收摘要' })).toBeVisible()
})
