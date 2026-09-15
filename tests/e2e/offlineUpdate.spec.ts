import { expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import serve from 'koa-static'
import send from 'koa-send'

test('opens settings and schedules an independent Web update while all 9119 requests fail', async ({ page }, testInfo) => {
  const home = mkdtempSync(join(tmpdir(), 'yaoyao-offline-ui-'))
  const { createApplication, createNodeServer } = await import(pathToFileURL(join(process.cwd(), 'dist-server/server/app.js')).href)
  const { SystemUpdateManager } = await import(pathToFileURL(join(process.cwd(), 'dist-server/server/updateManager.js')).href)
  const current = JSON.parse(readFileSync('release.json', 'utf8'))
  const [major, minor, patch] = current.webVersion.split('.').map(Number)
  const version = `${major}.${minor}.${patch + 1}`
  const latest = { ...current, releaseVersion: version, webVersion: version, gitTag: `v${version}` }
  const config = {
    host: '127.0.0.1', port: 0, upstream: new URL('http://127.0.0.1:1'),
    allowedHosts: new Set(['127.0.0.1']), home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home,
    mediaOwner: 'test', allowInsecureLan: false, insecureLan: false, production: true,
  }
  const launched: string[] = []
  const completedJobs: string[] = []
  const updates = new SystemUpdateManager(config, {
    projectRoot: process.cwd(), platform: 'darwin',
    inspectRemote: async () => ({ manifest: latest, commit: 'b'.repeat(40) }),
    // Exercise scheduling and polling only; never install or stop a real service.
    launchUpdater: (path: string) => {
      const job = JSON.parse(readFileSync(path, 'utf8'))
      launched.push(job.target.releaseVersion)
      writeFileSync(path, JSON.stringify({ ...job, state: 'succeeded', message: '离线 Web 升级任务验收完成' }))
      completedJobs.push(path)
      rmSync(join(home, 'updates', 'active.lock'))
    },
  })
  const runtime = createApplication({ config, updates })
  runtime.app.use(serve(join(process.cwd(), 'dist')))
  runtime.app.use(async (ctx: Parameters<ReturnType<typeof serve>>[0]) => {
    if (ctx.method === 'GET' && ctx.accepts('html')) await send(ctx, 'index.html', { root: join(process.cwd(), 'dist') })
  })
  const node = createNodeServer(runtime)
  node.server.listen(0, '127.0.0.1'); await once(node.server, 'listening')
  const origin = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`
  try {
    const bootstrap = await (await page.request.get(origin + '/api/app/bootstrap')).json()
    const login = await page.request.post(origin + '/api/app/setup', {
      headers: { Origin: origin, 'X-CSRF-Token': bootstrap.csrfToken }, data: { username: 'admin', password: 'offline-e2e-password' },
    })
    const signedIn = await login.json()
    expect(login.ok(), `${login.status()} ${signedIn.error || ''}`).toBe(true)
    expect((await page.request.get(origin + '/readyz')).status()).toBe(503)
    await page.goto(origin + '/chat', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /^(打开我的设置|设置与模式)$/ }).click()
    await page.getByRole('menuitem', { name: '我的设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '我的设置' })
    await dialog.getByRole('button', { name: '系统概览', exact: true }).click()
    await expect(dialog.getByText(`Web ${current.webVersion} · 可独立升级与回滚`)).toBeVisible()
    await dialog.getByRole('button', { name: '更新与回滚', exact: true }).click()
    await expect(dialog.getByText(version, { exact: true })).toBeVisible()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.settings-center-layer')).toHaveCSS('opacity', '1')
    await page.screenshot({ path: testInfo.outputPath('offline-web-update.png') })
    page.once('dialog', confirmation => confirmation.accept())
    await dialog.getByRole('button', { name: '升级 Web', exact: true }).click()
    await expect.poll(() => completedJobs.length).toBe(1)
    expect(JSON.parse(readFileSync(completedJobs[0]!, 'utf8'))).toMatchObject({ state: 'succeeded', target: { webVersion: version } })
    await expect(dialog.getByRole('region', { name: '更新与回滚', exact: true })).toBeVisible()
    expect(launched).toEqual([version])
  } finally {
    await page.goto('about:blank')
    node.server.closeAllConnections()
    await node.close()
    rmSync(home, { recursive: true, force: true })
  }
})
