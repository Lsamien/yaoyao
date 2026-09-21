import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

test('native updater shows preparation, preserves staged state on reopen and restarts once', { timeout: 60000 }, async () => {
  const root = resolve(import.meta.dirname, '..'), home = await mkdtemp(join(tmpdir(), 'yaoyao-update-ui-'))
  const entry = join(home, 'main.mjs')
  // The real view/preload/controller run in disposable Electron; only the
  // downloader and native installer are fake, so no installed app is changed.
  await writeFile(entry, `
import {app,BrowserWindow,ipcMain} from 'electron';
import {EventEmitter} from 'node:events';
import {DesktopAutoUpdateManager} from ${JSON.stringify(pathToFileURL(join(root, 'desktop/auto-update-manager.mjs')).href)};
app.setPath('userData',${JSON.stringify(join(home, 'user-data'))});
const driver=new EventEmitter();let ready,win;
globalThis.fixture={checks:0,installs:0};
driver.checkForUpdates=async()=>{fixture.checks++;return {isUpdateAvailable:true,updateInfo:{version:'0.4.63',releaseNotes:'<b>原样显示</b>'}}};
driver.downloadUpdate=()=>new Promise(resolve=>{ready=resolve;driver.emit('download-progress',{transferred:50,total:100});driver.emit('update-downloaded')});
driver.quitAndInstall=()=>{fixture.installs++};
const manager=new DesktopAutoUpdateManager({driver,version:'0.4.62'});
fixture.ready=()=>ready([]);fixture.fail=()=>driver.emit('error',new Error('signature failed'));
fixture.state=()=>manager.snapshot();
const open=async()=>{win=new BrowserWindow({width:640,height:620,webPreferences:{contextIsolation:true,sandbox:true,preload:${JSON.stringify(join(root, 'desktop/update-preload.cjs'))}}});await win.loadFile(${JSON.stringify(join(root, 'desktop/update.html'))})};
fixture.open=open;
for(const action of ['state','check','download','cancel','install'])ipcMain.handle('desktop-update:'+action,()=>action==='state'?manager.snapshot():manager[action]());
app.on('window-all-closed',()=>{});app.whenReady().then(open);
`)
  let app
  try {
    app = await electron.launch({ args: [entry], cwd: root })
    let page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '下载更新', exact: true })).toBeEnabled()
    await expect(page.locator('#current')).toContainText('0.4.62')
    await page.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(page.locator('#status')).toContainText('准备安装')
    await expect(page.getByRole('button', { name: '重启更新', exact: true })).toBeHidden()
    await expect(page.locator('#cancel')).toBeHidden()
    await page.evaluate(() => window.close())
    const opened = app.waitForEvent('window'); await app.evaluate(() => fixture.open()); page = await opened
    await expect(page.locator('#status')).toContainText('准备安装')
    assert.equal(await app.evaluate(() => fixture.checks), 1)
    await app.evaluate(() => fixture.ready())
    const install = page.getByRole('button', { name: '重启更新', exact: true })
    await expect(install).toBeEnabled()
    await expect(page.locator('#check')).toBeDisabled()
    await page.locator('summary').click()
    await expect(page.locator('#notes')).toHaveText('<b>原样显示</b>')
    assert.equal(await page.locator('#notes b').count(), 0)
    await mkdir(join(root, 'test-results/desktop'), { recursive: true })
    await page.screenshot({ path: join(root, 'test-results/desktop/auto-update-ready.png') })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 380, height: 620 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(root, 'test-results/desktop/auto-update-ready-dark.png') })
    await install.click()
    await expect(page.getByRole('button', { name: '正在重启…' })).toBeDisabled()
    assert.equal(await app.evaluate(() => fixture.installs), 1)
    await app.evaluate(() => fixture.fail())
    await expect(page.getByRole('alert')).toContainText('签名验证失败')
    await expect(page.locator('#install')).toBeHidden()
    await expect(page.locator('#check')).toBeDisabled()
  } finally { await app?.close().catch(() => {}); await rm(home, { recursive: true, force: true }) }
})
