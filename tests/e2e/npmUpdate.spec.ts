import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import serve from 'koa-static'
import send from 'koa-send'
import { writeNpmFixture } from '../fixtures/npm-release.mjs'

test('npm update downloads in place, survives reopening, and refreshes only after explicit server restart', async ({ page }, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'yaoyao-npm-ui-')), home = join(root, 'data'), projectRoot = join(root, 'initial')
  const current = JSON.parse(readFileSync('release.json', 'utf8'))
  const version = current.webVersion.split('.').map((value: string, index: number) => index === 2 ? String(Number(value) + 1) : value).join('.')
  writeNpmFixture(projectRoot, current.webVersion)
  const releaseRoot = join(root, 'programs')
  const target = { ...current, releaseVersion: version, webVersion: version, gitTag: `v${version}` }
  const archive = Buffer.from('fixture npm archive')
  const { createApplication, createNodeServer } = await import(pathToFileURL(join(process.cwd(), 'dist-server/server/app.js')).href)
  const { SystemUpdateManager } = await import(pathToFileURL(join(process.cwd(), 'dist-server/server/updateManager.js')).href)
  const config = { host: '127.0.0.1', port: 0, upstream: new URL('http://127.0.0.1:1'), allowedHosts: new Set(['127.0.0.1']),
    home, mediaRoot: home, attachmentsRoot: home, imagesRoot: home, mediaOwner: 'test', allowInsecureLan: false, insecureLan: false, production: true,
    releaseRoot, releaseSource: 'npm:@lsamien/yaoyao' }
  let finishDownload!: () => void, downloads = 0, restarts = 0, confirmations = 0
  const updates = new SystemUpdateManager(config, { projectRoot, platform: 'darwin',
    inspectRemote: async () => ({ manifest: target, npm: { version, tarball: 'https://registry.npmjs.org/fixture.tgz', integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` } }),
    // Native archive installation and actual process replacement are covered by
    // verify-npm-update.mjs; this fixture exercises the real UI/API/state flow.
    launchUpdater: (path: string) => {
      const job = JSON.parse(readFileSync(path, 'utf8'))
      if (job.plan.prepared) {
        restarts++
        writeFileSync(join(projectRoot, 'release.json'), JSON.stringify(target))
        writeFileSync(path, JSON.stringify({ ...job, state: 'succeeded', message: '服务器更新完成' }))
        rmSync(join(home, 'updates/active.lock'))
      } else {
        downloads++
        writeFileSync(path, JSON.stringify({ ...job, state: 'downloading', received: 37, total: 100, message: '正在下载服务器更新 · 37%' }))
        finishDownload = () => {
          const prepared = { archive: join(home, 'updates/npm', job.id, 'release.tgz') }
          mkdirSync(join(prepared.archive, '..'), { recursive: true }); writeFileSync(prepared.archive, archive)
          writeFileSync(path, JSON.stringify({ ...job, state: 'prepared', message: '新版本已下载完成，点击重启服务器覆盖更新', plan: { ...job.plan, prepared } }))
          rmSync(join(home, 'updates/active.lock'))
        }
      }
    },
  })
  const runtime = createApplication({ config, updates })
  runtime.app.use(serve(join(process.cwd(), 'dist')))
  runtime.app.use(async (ctx: Parameters<ReturnType<typeof serve>>[0]) => {
    if (ctx.method === 'GET' && ctx.accepts('html')) await send(ctx, 'index.html', { root: join(process.cwd(), 'dist') })
  })
  const node = createNodeServer(runtime); node.server.listen(0, '127.0.0.1'); await once(node.server, 'listening')
  const origin = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`
  async function openUpdates() {
    await page.getByRole('button', { name: /^(打开我的设置|设置与模式)$/ }).click()
    await page.getByRole('menuitem', { name: '我的设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '我的设置' })
    await dialog.getByRole('button', { name: '更新与回滚', exact: true }).click()
    return dialog
  }
  try {
    const boot = await (await page.request.get(origin + '/api/app/bootstrap')).json()
    const signedIn = await page.request.post(origin + '/api/app/setup', { headers: { Origin: origin, 'X-CSRF-Token': boot.csrfToken }, data: { username: 'admin', password: 'npm-e2e-password' } })
    expect(signedIn.ok()).toBe(true)
    page.on('dialog', dialog => { confirmations++; void dialog.dismiss() })
    await page.goto(origin + '/chat')
    let dialog = await openUpdates()
    await expect(dialog).toContainText('不保留旧版本')
    await expect(dialog.getByRole('button', { name: '回滚上一版本', exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37')
    expect(downloads).toBe(1); expect(restarts).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('npm-downloading.png') })
    finishDownload()
    await expect(dialog.getByRole('button', { name: '重启服务器', exact: true })).toBeEnabled()
    await expect(dialog.locator('.version-grid')).toContainText(version)
    await page.screenshot({ path: testInfo.outputPath('npm-ready.png') })
    await page.reload()
    dialog = await openUpdates()
    await expect(dialog.getByRole('button', { name: '重启服务器', exact: true })).toBeEnabled()
    expect(restarts).toBe(0)
    const refreshed = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() })
    await dialog.getByRole('button', { name: '重启服务器', exact: true }).click()
    await refreshed
    expect(restarts).toBe(1); expect(confirmations).toBe(0)
    const status = await (await page.request.get(origin + '/api/app/system/update/status')).json()
    expect(status.current.webVersion).toBe(version)
    expect(status.job.state).toBe('succeeded')
  } finally {
    await page.goto('about:blank')
    node.server.closeAllConnections(); await node.close()
    rmSync(root, { recursive: true, force: true })
  }
})
