import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, utilityProcess, powerMonitor, systemPreferences, dialog, safeStorage, net } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DesktopServiceManager } from './service-manager.mjs'
import { DesktopRunnerManager } from './runner-manager.mjs'
import { DesktopPreferences } from './preferences.mjs'
import { DesktopCredentials } from './credentials.mjs'
import { synchronizeLocalService, stopLocalService, migrateLocalData } from './service-sync.mjs'
import { resolveDataHome } from './data-home.mjs'
import { DesktopEnvironmentHost } from './environment-host.mjs'
import { DesktopUpdateManager } from './update-manager.mjs'
import { installComputerViewer } from './computer-viewer.mjs'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const fixtureHome = process.env.HERMES_YAOYAO_DESKTOP_TEST_HOME
// Fixture identity also isolates Chromium cookies, window state and the app lock.
if (fixtureHome) app.setPath('userData', join(fixtureHome, 'desktop'))
app.setName('夭夭')
if (!app.requestSingleInstanceLock()) { app.quit() }
else {
  let window, tray, manager, runnerManager, quitting = false, closing = false, timer
  let updateWindow, updater, environmentHost
  const closeComputerViewer = installComputerViewer({ owner: () => window, origin: () => manager?.state.url,
    preload: join(desktopRoot, 'preload.cjs'), quitting: () => quitting })
  app.on('will-quit', closeComputerViewer)
  const updateURL = pathToFileURL(join(desktopRoot, 'update.html')).href
  const bootURL = pathToFileURL(join(desktopRoot, 'boot.html')).href
  const root = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(app.getAppPath(), '.desktop-build')
  const logRoot = join(app.getPath('logs'), fixtureHome ? 'verification' : 'service')
  mkdirSync(logRoot, { recursive: true })
  const logFile = join(logRoot, 'server.log')
  const log = text => appendFileSync(logFile, `${new Date().toISOString()} ${text.trim()}\n`, { mode: 0o600 })
  const home = fixtureHome || resolveDataHome(process.env.YAOYAO_HOME || process.env.HERMES_YAOYAO_HOME)
  const preferences = new DesktopPreferences(home)
  let startHidden = false
  const port = Number(process.env.HERMES_YAOYAO_DESKTOP_PORT || 15300)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('桌面服务端口无效')

  const trustedBoot = event => event.sender === window?.webContents && event.senderFrame?.url === bootURL
  ipcMain.handle('desktop:status', event => {
    if (!trustedBoot(event)) throw new Error('不允许此页面访问桌面服务')
    return { phase: manager?.state.phase || 'starting', message: manager?.state.message || '正在启动…' }
  })
  ipcMain.handle('desktop:retry', async event => {
    if (!trustedBoot(event)) throw new Error('不允许此页面启动桌面服务')
    manager.restarts = []
    try { await manager.start(); return true } catch { return false }
  })
  ipcMain.handle('desktop:logs', event => {
    if (!trustedBoot(event)) throw new Error('不允许此页面读取日志')
    shell.showItemInFolder(logFile)
  })
  const trustedUpdate = event => event.sender === updateWindow?.webContents
    && event.senderFrame === updateWindow.webContents.mainFrame && event.senderFrame.url === updateURL
  ipcMain.handle('desktop:updates', async event => {
    let trusted = false
    try {
      trusted = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame
        && manager?.state.phase === 'ready' && new URL(event.senderFrame.url).origin === manager.state.url
    } catch { /* Only the main local application page may open the updater. */ }
    if (!trusted || closing || quitting || !updater) throw new Error('不允许此页面打开 App 更新')
    await showUpdates()
  })
  for (const action of ['state', 'check', 'download', 'cancel', 'open', 'folder', 'release']) {
    ipcMain.handle(`desktop-update:${action}`, async event => {
      if (!trustedUpdate(event) || closing || quitting) throw new Error('不允许此页面操作 App 更新')
      if (action === 'state') return updater.snapshot()
      if (action === 'check') return updater.check()
      if (action === 'download') return updater.download()
      if (action === 'cancel') { updater.cancel(); return updater.snapshot() }
      if (action === 'release') { safeExternal(updater.snapshot().releasePageUrl || 'https://github.com/Lsamien/yaoyao/releases'); return }
      const path = await updater.verifiedFile()
      if (closing || quitting || !trustedUpdate(event)) return
      if (action === 'folder') shell.showItemInFolder(path)
      else { const error = await shell.openPath(path); if (error) throw new Error(error) }
    })
  }
  async function showUpdates() {
    if (closing || quitting) return
    if (updateWindow && !updateWindow.isDestroyed()) { updateWindow.show(); updateWindow.focus(); return }
    updateWindow = new BrowserWindow({ title: 'App 更新 · 夭夭', width: 640, height: 620, minWidth: 360, minHeight: 440, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        preload: join(desktopRoot, 'update-preload.cjs') } })
    updateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    updateWindow.webContents.on('will-navigate', event => event.preventDefault())
    updateWindow.webContents.on('will-redirect', event => event.preventDefault())
    updateWindow.webContents.on('will-attach-webview', event => event.preventDefault())
    updateWindow.on('closed', () => { updater.cancel(); updateWindow = undefined })
    updateWindow.once('ready-to-show', () => updateWindow?.show())
    await updateWindow.loadURL(updateURL)
  }

  function show() {
    if (closing || quitting) return
    if (!window || window.isDestroyed()) createWindow()
    window.show(); window.focus()
    if (manager) void manager.reconnect().then(() => stateChanged(manager.state)).catch(error => log(error.message))
  }
  function safeExternal(url) {
    try { const parsed = new URL(url); if (['https:', 'http:', 'mailto:'].includes(parsed.protocol)) void shell.openExternal(url) }
    catch { /* No arbitrary file, shell or custom URL dispatch. */ }
  }
  function createWindow() {
    window = new BrowserWindow({ width: 1280, height: 860, minWidth: 720, minHeight: 560, show: false,
      title: '夭夭', backgroundColor: '#f7f7f7',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, preload: join(desktopRoot, 'preload.cjs') } })
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (manager?.state.url && new URL(url).origin === manager.state.url) void window.loadURL(url)
        else safeExternal(url)
      } catch { /* Invalid navigation is denied. */ }
      return { action: 'deny' }
    })
    const guardNavigation = (event, url) => {
      if (url === bootURL || (manager?.state.url && new URL(url).origin === manager.state.url)) return
      event.preventDefault(); safeExternal(url)
    }
    window.webContents.on('will-navigate', guardNavigation)
    window.webContents.on('will-redirect', guardNavigation)
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    const trustedService = (contents, url) => {
      try { return contents === window?.webContents && !!manager?.state.url && new URL(url).origin === manager.state.url }
      catch { return false }
    }
    window.webContents.session.setPermissionCheckHandler((contents, permission, origin) =>
      closeComputerViewer.owns(contents) ? ['fullscreen', 'clipboard-sanitized-write'].includes(permission)
        : trustedService(contents, origin) && ['media', 'notifications', 'clipboard-sanitized-write'].includes(permission))
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (closeComputerViewer.owns(contents)) { callback(['fullscreen', 'clipboard-sanitized-write'].includes(permission)); return }
      if (!trustedService(contents, details.requestingUrl)) { callback(false); return }
      if (permission === 'media' && details.mediaTypes?.length && details.mediaTypes.every(type => type === 'audio')) {
        void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false))
      } else callback(['notifications', 'clipboard-sanitized-write', 'fullscreen'].includes(permission))
    })
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide() } })
    window.once('ready-to-show', () => { if (!startHidden) window.show() })
    if (manager?.state.phase === 'ready') void window.loadURL(manager.state.url)
    else void window.loadFile(join(desktopRoot, 'boot.html'))
  }
  function stateChanged(state) {
    log(`${state.phase}: ${state.message}`)
    // Quit owns the window from this point on. A detached connection is not a
    // stopped server and must never navigate the closing window to boot.html.
    if (closing || quitting) return
    const serviceStatus=Menu.getApplicationMenu()?.getMenuItemById('desktop-service-status')
    if(serviceStatus)serviceStatus.label=state.phase==='ready'?'后台服务运行中':state.message
    const localVmMenu=Menu.getApplicationMenu()?.getMenuItemById('desktop-local-vm')
    if(localVmMenu)localVmMenu.enabled=state.phase==='ready'
    const notice = Menu.getApplicationMenu()?.getMenuItemById('desktop-sync-notice')
    if (notice) notice.visible = Boolean(state.updateNotice)
    const retrySync = Menu.getApplicationMenu()?.getMenuItemById('desktop-sync-retry')
    if (retrySync) retrySync.enabled = state.phase === 'ready' && Boolean(manager?.options.synchronize)
    tray?.setToolTip(`夭夭 · ${state.message}`)
    if (!window || window.isDestroyed()) return
    if (state.phase === 'ready') {
      const current = window.webContents.getURL()
      if (!current.startsWith(`${state.url}/`) && current !== state.url) void window.loadURL(state.url)
    } else if (window.webContents.getURL() !== bootURL) void window.loadFile(join(desktopRoot, 'boot.html'))
  }
  app.on('second-instance', show)
  app.on('activate', show)
  app.on('window-all-closed', () => {})
  function requestQuit(stopBackground = false) {
    if (closing || quitting) return
    closing = true; clearInterval(timer)
    updater?.cancel(); updateWindow?.close()
    window?.hide()
    // Native Cmd+Q can enter before-quit from Cocoa's termination callback.
    // Both cleanup and the final quit must run after that callback unwinds.
    setImmediate(() => { void (async()=>{
      try {
        await environmentHost?.close()
        await runnerManager?.stop()
        if (stopBackground) await manager?.stopBackground()
        else await manager?.stop()
        quitting = true
        setImmediate(() => app.quit())
      } catch(error) {
        log(error.message)
        window?.show()
        const choice=await dialog.showMessageBox(window,{type:'warning',message:stopBackground?'后台服务停止未完成':'App 退出清理未完成',detail:error.message,buttons:['返回应用','仅退出 App'],defaultId:0,cancelId:0})
        if(choice.response===1){quitting=true;setImmediate(()=>app.quit())}
        else {
          closing=false
          await manager?.reconnect().catch(error=>log(error.message))
          await runnerManager?.start().catch(error=>log(error.message))
          stateChanged(manager.state)
          timer=setInterval(()=>{void manager.check()},10000);timer.unref()
          show()
        }
      }
    })() })
  }
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    requestQuit()
  })
  app.whenReady().then(async () => {
    await preferences.load()
    startHidden = preferences.value.backgroundAtLogin && app.getLoginItemSettings().wasOpenedAtLogin
    const packageVersion = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')).webVersion
    const buildInfo=JSON.parse(readFileSync(join(root,'build-info.json'),'utf8'))
    const releases = await import(pathToFileURL(join(root, 'github-release.mjs')).href)
    updater = new DesktopUpdateManager({ version: packageVersion, cacheRoot: join(home, 'updates', 'desktop-downloads'),
      source: releases.DEFAULT_RELEASE_SOURCE, inspect: releases.inspectGitHubRelease, compare: releases.compareReleaseVersions,
      fetchImpl: (...args) => net.fetch(...args) })
    app.setAboutPanelOptions({applicationName:'夭夭',applicationVersion:packageVersion,version:`${String(buildInfo.commit).slice(0,12)}${buildInfo.dirty?' · 工作区快照':''}`})
    manager = new DesktopServiceManager({ home, port, version: packageVersion, log, onState: stateChanged,
      prepareHome: !fixtureHome ? onProgress => migrateLocalData({ home, port, root, onProgress }) : undefined,
      stopBackground: (app.isPackaged && !fixtureHome) || (fixtureHome && process.env.HERMES_YAOYAO_DESKTOP_TEST_SYNC === '1')
        ? onProgress => stopLocalService({home,port,root,fixture:Boolean(fixtureHome),onProgress}) : undefined,
      synchronize: (app.isPackaged && !fixtureHome) || (fixtureHome && process.env.HERMES_YAOYAO_DESKTOP_TEST_SYNC === '1')
        ? onProgress => synchronizeLocalService({ home, port, root, fixture: Boolean(fixtureHome), onProgress,
          environment: { HERMES_YAOYAO_UPSTREAM: process.env.HERMES_YAOYAO_UPSTREAM || 'http://127.0.0.1:9119', HERMES_YAOYAO_SUPERVISE_DASHBOARD: fixtureHome ? '0' : '1' } })
        : undefined,
      fork: ({ home, port }) => {
        const env = { ...process.env, NODE_ENV: 'production', NODE_USE_ENV_PROXY: '0',
          PATH: [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':'),
          HERMES_YAOYAO_DESKTOP: '1', HERMES_YAOYAO_HOME: home, HERMES_YAOYAO_HOST: '127.0.0.1',
          HERMES_YAOYAO_PORT: String(port), HERMES_YAOYAO_STATIC_DIR: join(root, 'ui'),
          HERMES_YAOYAO_SUPERVISE_DASHBOARD: fixtureHome ? '0' : '1',
          HERMES_YAOYAO_UPSTREAM: process.env.HERMES_YAOYAO_UPSTREAM || 'http://127.0.0.1:9119' }
        delete env.ELECTRON_RUN_AS_NODE
        delete env.HERMES_YAOYAO_TLS_CERT; delete env.HERMES_YAOYAO_TLS_KEY
        return utilityProcess.fork(join(root, 'server.mjs'), [], { cwd: root, env, stdio: 'pipe' })
      },
    })
    environmentHost=new DesktopEnvironmentHost({manager,root,dataRoot:app.getPath('userData')})
    const { parseRunnerConfiguration } = await import(pathToFileURL(join(root,'runner-config.mjs')).href)
    const credentials=new DesktopCredentials({home,helper:join(root,app.isPackaged?'keychain-helper':'keychain-helper-dev'),legacyDecrypt:async bytes=>(await safeStorage.decryptStringAsync(bytes)).result})
    runnerManager = new DesktopRunnerManager({home,validate:parseRunnerConfiguration,
      encrypt:value=>credentials.encrypt(value),
      decrypt:bytes=>credentials.decrypt(bytes),
      onState:message=>{log(`Runner: ${message}`);const item=Menu.getApplicationMenu()?.getMenuItemById('runner-status');if(item)item.label=message},
      fork:()=>utilityProcess.fork(join(root,'runner.mjs'),['--desktop-ipc'],{cwd:root,stdio:'pipe',env:{HOME:homedir(),PATH:[join(homedir(),'.local/bin'),join(homedir(),'.orbstack/bin'),'/opt/homebrew/bin','/usr/local/bin',process.env.PATH||'/usr/bin:/bin'].join(':'),NODE_ENV:'production',NODE_USE_ENV_PROXY:'0'}}),
    })
    async function runnerAction(action){try{await action()}catch(error){await dialog.showMessageBox(window,{type:'error',message:'执行节点操作未完成',detail:error.message})}}
    async function importRunner(){
      const selection=await dialog.showOpenDialog(window,{title:'导入执行节点配置',properties:['openFile'],filters:[{name:'Runner 配置',extensions:['json']}]})
      if(!selection.canceled&&selection.filePaths[0]&&!closing)await runnerAction(()=>runnerManager.importFile(selection.filePaths[0]))
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '夭夭', submenu: [{ role: 'about', label: '关于夭夭' }, { type: 'separator' },
        { id:'desktop-service-status',label:'正在连接后台服务…',enabled:false },
        { label: '显示窗口', click: show }, { label: '在浏览器中打开', click: () => { if (manager.state.url) safeExternal(manager.state.url) } },
        { id:'desktop-local-vm',label:'本地虚拟机设置…',enabled:false,click:()=>{if(manager.state.phase==='ready'){show();void window.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('yaoyao:local-vm-settings'))")}} },
        { label: '查看服务日志', click: () => shell.showItemInFolder(logFile) },
        { id:'desktop-sync-notice', label:'Web 同步待完成：服务忙碌', enabled:false, visible:false },
        { id:'desktop-sync-retry', label:'重试同步本机 Web…', enabled:false,
          click:async()=>{try{await manager.retrySynchronization()}catch(error){log(error.message)}} },
        { id:'desktop-login', label:'登录 macOS 时启动', type:'checkbox', enabled:app.isPackaged, checked:app.getLoginItemSettings().openAtLogin,
          click:async item=>{try{app.setLoginItemSettings({openAtLogin:item.checked});item.checked=app.getLoginItemSettings().openAtLogin}catch(error){item.checked=app.getLoginItemSettings().openAtLogin;await dialog.showMessageBox(window,{type:'error',message:'无法修改登录启动设置',detail:error.message})}} },
        { id:'desktop-background', label:'登录启动时仅驻留菜单栏', type:'checkbox', checked:preferences.value.backgroundAtLogin,
          click:async item=>{try{await preferences.setBackgroundAtLogin(item.checked)}catch(error){item.checked=preferences.value.backgroundAtLogin;await dialog.showMessageBox(window,{type:'error',message:error.message})}} },
        { id:'desktop-update-check', label:'检查 App 更新…', click:showUpdates },
        { id:'desktop-update-help', label:'App 更新与回退…', click:()=>dialog.showMessageBox(window,{type:'info',message:`夭夭 App ${packageVersion}`,detail:`App 构建：${String(buildInfo.commit).slice(0,12)}\n当前 Web：${manager.state.version||'尚未就绪'}${manager.state.build?.commit?' · '+manager.state.build.commit.slice(0,12):''}${manager.state.external?'（独立后台服务）':'（开发模式）'}\n\n通过“检查 App 更新”从 GitHub 下载并校验 DMG，手动拖入应用程序安装。开发签名包尚未公证，请遵循 macOS 的安装提示。\n\n安装后首次启动同步较旧的本机 Web，已有较新的 Web 保留。Web 可以独立升级，退出 App 保留独立后台服务。\n\n降级通过 Web 的回滚入口处理；数据库结构不兼容时不能直接降级。\n\n数据目录：${home}`,buttons:['知道了','打开数据目录']}).then(result=>{if(result.response===1)shell.showItemInFolder(home)}) },
        { type: 'separator' },
        { role: 'hide', label: '隐藏夭夭' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        {label:'撤销本机控制授权',click:()=>environmentHost.revoke()},
        { id:'desktop-quit',label:'退出夭夭（后台继续运行）',accelerator:'CommandOrControl+Q',click:()=>requestQuit() },
        { id:'desktop-stop-and-quit',label:'停止后台服务并退出',click:()=>requestQuit(true) }] },
      {label:'执行节点',submenu:[{id:'runner-status',label:'未配置执行节点',enabled:false},{type:'separator'},
        {id:'runner-import',label:'导入节点配置…',click:importRunner},
        {id:'runner-reconnect',label:'重新连接',click:()=>runnerAction(()=>runnerManager.start())},
        {id:'runner-forget',label:'断开并忘记配置',click:()=>runnerAction(()=>runnerManager.forget())}]},
      { role: 'editMenu', label: '编辑' }, { role: 'viewMenu', label: '显示' }, { role: 'windowMenu', label: '窗口' },
    ]))
    const icon = nativeImage.createFromPath(join(desktopRoot, 'icon.png')).resize({ width: 20, height: 20 })
    icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.setToolTip('夭夭')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开夭夭', click: show }, { label: '查看日志', click: () => shell.showItemInFolder(logFile) }, { type: 'separator' }, { label: '退出夭夭（后台继续运行）', click: () => requestQuit() }, { label: '停止后台服务并退出', click: () => requestQuit(true) }]))
    tray.on('click', show)
    createWindow()
    powerMonitor.on('resume', () => { if(!closing&&!quitting)void manager.check() })
    timer = setInterval(() => { void manager.check() }, 10_000); timer.unref()
    await manager.start().catch(error => log(error.message))
    if(!closing)environmentHost.start()
    if(!closing&&manager.state.phase==='ready')await runnerManager.start().catch(error=>{runnerManager.publish(error.message)})
  }).catch(error => { log(error.stack || error.message); quitting = true; app.quit() })
}
