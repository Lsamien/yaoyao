import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, utilityProcess, powerMonitor, systemPreferences, dialog, safeStorage, net, session as electronSession } from 'electron'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, hostname } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DesktopServiceManager } from './service-manager.mjs'
import { DesktopRunnerManager } from './runner-manager.mjs'
import { DesktopPreferences } from './preferences.mjs'
import { DesktopCredentials } from './credentials.mjs'
import { synchronizeLocalService, stopLocalService, migrateLocalData } from './service-sync.mjs'
import { resolveDataHome } from './data-home.mjs'
import { DesktopEnvironmentHost, DesktopHostCore } from './environment-host.mjs'
import { DesktopHostManager } from './host-manager.mjs'
import { remoteRegistration, remoteSession, enrollDesktopHost, inspectServer } from './remote-login.mjs'
import { DesktopOnboarding } from './onboarding.mjs'
import { DesktopUpdateManager } from './update-manager.mjs'
import { DesktopAutoUpdateManager } from './auto-update-manager.mjs'
import { createRequire } from 'node:module'
import { installComputerViewer } from './computer-viewer.mjs'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const fixtureHome = process.env.HERMES_YAOYAO_DESKTOP_TEST_HOME
// Fixture identity also isolates Chromium cookies, window state and the app lock.
if (fixtureHome) app.setPath('userData', join(fixtureHome, 'desktop'))
app.setName('夭夭')
if (!app.requestSingleInstanceLock()) { app.quit() }
else {
  let window, tray, manager, runnerManager, quitting = false, closing = false, timer
  let updateWindow, updater, environmentHost, hostManager, onboarding
  let remoteMode = false, remoteURL = '', serverModeActive = false, switchingMode = false
  let recoveringService = false
  const serviceURL = () => remoteMode ? remoteURL : manager?.state.url
  // Use the same Chromium networking as server detection/navigation. Auth owns
  // its cookie jar: do not send or overwrite another account's browser cookies.
  const authFetch = (url, options) => net.fetch(url, { ...options, credentials: 'omit' })
  const serviceOrigins = () => {
    try { return remoteMode && remoteURL ? [new URL(remoteURL).origin] : manager?.state.url ? [new URL(manager.state.url).origin] : [] }
    catch { return [] }
  }
  const closeComputerViewer = installComputerViewer({ owner: () => window, origin: () => serviceURL(),
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

  const trustedBoot = event => !closing && !quitting && event.sender === window?.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === bootURL
  ipcMain.handle('desktop:status', event => {
    if (!trustedBoot(event)) throw new Error('不允许此页面访问桌面服务')
    return onboarding.snapshot()
  })
  ipcMain.handle('desktop:retry', async event => {
    if (!trustedBoot(event)) throw new Error('不允许此页面启动桌面服务')
    manager.restarts = []
    return onboarding.prepare()
  })
  ipcMain.handle('desktop:logs', event => {
    if (!trustedBoot(event)) throw new Error('不允许此页面读取日志')
    shell.showItemInFolder(logFile)
  })
  ipcMain.handle('desktop:force-sync', async event => {
    if (!trustedBoot(event) || event.senderFrame !== window.webContents.mainFrame || closing || quitting || !manager?.canForceSynchronization)
      throw new Error('不允许此页面覆盖本机 Web')
    return onboarding.prepare({ force: true })
  })
  for (const action of ['select', 'prepare', 'submit']) {
    ipcMain.handle(`desktop:onboarding-${action}`, (event, input) => {
      if (!trustedBoot(event)) throw new Error('不允许此页面操作安装与登录')
      return onboarding[action](input)
    })
  }
  const trustedUpdate = event => event.sender === updateWindow?.webContents
    && event.senderFrame === updateWindow.webContents.mainFrame && event.senderFrame.url === updateURL
  ipcMain.handle('desktop:updates', async event => {
    let trusted = false
    try {
      trusted = event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame
        && serviceOrigins().includes(new URL(event.senderFrame.url).origin)
    } catch { /* Only the active server's main page may open the local updater. */ }
    if (!trusted || closing || quitting || !updater) throw new Error('不允许此页面打开 App 更新')
    await showUpdates()
  })
  for (const action of ['state', 'check', 'download', 'cancel', 'install', 'open', 'folder', 'release']) {
    ipcMain.handle(`desktop-update:${action}`, async event => {
      if (!trustedUpdate(event)) throw new Error('不允许此页面操作 App 更新')
      if (action === 'state') return updater.snapshot()
      if (closing || quitting) throw new Error('App 正在重启或退出')
      if (action === 'check') return updater.check()
      if (action === 'download') return updater.download()
      if (action === 'install') return updater.install()
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
    updateWindow.on('closed', () => { updateWindow = undefined })
    updateWindow.once('ready-to-show', () => updateWindow?.show())
    await updateWindow.loadURL(updateURL)
  }

  function show() {
    if (closing || quitting) return
    if (!window || window.isDestroyed()) createWindow()
    window.show(); window.focus()
    if (serverModeActive && manager) void manager.reconnect().then(() => stateChanged(manager.state)).catch(error => log(error.message))
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
        if (serviceOrigins().includes(new URL(url).origin)) void window.loadURL(url)
        else safeExternal(url)
      } catch { /* Invalid navigation is denied. */ }
      return { action: 'deny' }
    })
    const guardNavigation = (event, url) => {
      try { if (url === bootURL || serviceOrigins().includes(new URL(url).origin)) return }
      catch { /* Invalid navigation is denied. */ }
      event.preventDefault(); safeExternal(url)
    }
    window.webContents.on('will-navigate', guardNavigation)
    window.webContents.on('will-redirect', guardNavigation)
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    const trustedService = (contents, url) => {
      try { return contents === window?.webContents && serviceOrigins().includes(new URL(url).origin) }
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
    if (onboarding?.state.active) return window.loadURL(bootURL)
    if (remoteMode && remoteURL) return window.loadURL(remoteURL)
    if (manager?.state.phase === 'ready') return window.loadURL(manager.state.url)
    return window.loadFile(join(desktopRoot, 'boot.html'))
  }
  function stateChanged(state) {
    log(`${state.phase}: ${state.message}`)
    onboarding?.serviceChanged(state)
    // Quit owns the window from this point on. A detached connection is not a
    // stopped server and must never navigate the closing window to boot.html.
    if (closing || quitting || remoteMode) return
    const serviceStatus=Menu.getApplicationMenu()?.getMenuItemById('desktop-service-status')
    if(serviceStatus)serviceStatus.label=state.phase==='ready'?'后台服务运行中':state.message
    const localVmMenu=Menu.getApplicationMenu()?.getMenuItemById('desktop-local-vm')
    if(localVmMenu)localVmMenu.enabled=state.phase==='ready'
    const notice = Menu.getApplicationMenu()?.getMenuItemById('desktop-sync-notice')
    if (notice) notice.visible = Boolean(state.updateNotice)
    const retrySync = Menu.getApplicationMenu()?.getMenuItemById('desktop-sync-retry')
    if (retrySync) retrySync.enabled = state.phase === 'ready' && Boolean(manager?.options.synchronize)
    const forceSync = Menu.getApplicationMenu()?.getMenuItemById('desktop-sync-force')
    if (forceSync) forceSync.enabled = !closing && !quitting && manager?.canForceSynchronization === true
    tray?.setToolTip(`夭夭 · ${state.message}`)
    if (!window || window.isDestroyed()) return
    if (onboarding?.state.active) {
      if (recoveringService && state.phase === 'ready') {
        recoveringService = false
        if (!onboarding.busy) void onboarding.prepare({ autoEnter: true }).catch(error => log(error.message))
      }
      return
    }
    if (state.phase === 'ready') {
      const current = window.webContents.getURL()
      if (!current.startsWith(`${state.url}/`) && current !== state.url) void window.loadURL(state.url)
    } else if (window.webContents.getURL() !== bootURL) {
      recoveringService = true
      onboarding.open({ mode: 'local', remember: preferences.value.startupChoice === 'local', restoring: true })
      onboarding.serviceChanged(state)
      void window.loadURL(bootURL)
    }
  }
  app.on('second-instance', show)
  app.on('activate', show)
  app.on('window-all-closed', () => {})
  function requestQuit(stopBackground = false) {
    if (closing || quitting) return
    closing = true; clearInterval(timer)
    updater?.stopChecking?.(); updater?.cancel(); updateWindow?.close()
    window?.hide()
    // Native Cmd+Q can enter before-quit from Cocoa's termination callback.
    // Both cleanup and the final quit must run after that callback unwinds.
    setImmediate(() => { void (async()=>{
      try {
        await environmentHost?.close()
        await hostManager?.stop()
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
          if(remoteMode)await hostManager?.start().catch(error=>log(error.message))
          else{
            await manager?.reconnect().catch(error=>log(error.message))
            await runnerManager?.start().catch(error=>log(error.message))
          }
          stateChanged(manager.state)
          timer=setInterval(()=>{if(serverModeActive)void manager.check()},10000);timer.unref()
          updater?.startChecking?.()
          show()
        }
      }
    })() })
  }
  async function prepareUpdateRestart() {
    if (closing || quitting) throw new Error('App 正在退出，请稍后重试')
    closing = true; clearInterval(timer)
    await environmentHost?.close()
    await hostManager?.stop()
    await runnerManager?.stop()
    await manager?.stop()
    // Cleanup has completed before Squirrel begins quitting. Releasing the
    // single-instance lock lets the newly installed app start immediately.
    quitting = true
    app.releaseSingleInstanceLock()
  }
  async function recoverUpdateRestart() {
    quitting = false; closing = false
    if (!app.requestSingleInstanceLock()) { quitting = true; app.quit(); return }
    if (remoteMode) await hostManager?.start().catch(error => log(error.message))
    else if (serverModeActive) {
      await manager?.reconnect().catch(error => log(error.message))
      environmentHost?.start()
      await runnerManager?.start().catch(error => log(error.message))
    }
    clearInterval(timer)
    timer = setInterval(() => { if (serverModeActive) void manager?.check() }, 10000); timer.unref()
    window?.show(); updateWindow?.show()
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
    if ((app.isPackaged && !fixtureHome) || (fixtureHome && process.env.HERMES_YAOYAO_DESKTOP_TEST_AUTO_UPDATE === '1')) {
      const { autoUpdater } = createRequire(import.meta.url)(join(root, 'electron-updater.cjs'))
      autoUpdater.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (...values) => log(`[更新:${level}] ${values.join(' ')}`)]))
      updater = new DesktopAutoUpdateManager({ driver: autoUpdater, version: packageVersion,
        prepareInstall: prepareUpdateRestart, recoverInstall: recoverUpdateRestart })
      updater.startChecking()
    } else {
      updater = new DesktopUpdateManager({ version: packageVersion, cacheRoot: join(home, 'updates', 'desktop-downloads'),
        source: releases.DEFAULT_RELEASE_SOURCE, inspect: releases.inspectGitHubRelease, compare: releases.compareReleaseVersions,
        fetchImpl: (...args) => net.fetch(...args) })
    }
    app.setAboutPanelOptions({applicationName:'夭夭',applicationVersion:packageVersion,version:`${String(buildInfo.commit).slice(0,12)}${buildInfo.dirty?' · 工作区快照':''}`})
    manager = new DesktopServiceManager({ home, port, version: packageVersion, log, onState: stateChanged,
      prepareHome: !fixtureHome ? onProgress => migrateLocalData({ home, port, root, onProgress }) : undefined,
      stopBackground: (app.isPackaged && !fixtureHome) || (fixtureHome && process.env.HERMES_YAOYAO_DESKTOP_TEST_SYNC === '1')
        ? onProgress => stopLocalService({home,port,root,fixture:Boolean(fixtureHome),onProgress}) : undefined,
      synchronize: (app.isPackaged && !fixtureHome) || (fixtureHome && process.env.HERMES_YAOYAO_DESKTOP_TEST_SYNC === '1')
        ? (onProgress, { force = false } = {}) => synchronizeLocalService({ home, port, root, fixture: Boolean(fixtureHome), onProgress, force,
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
    hostManager=new DesktopHostManager({home,root,dataRoot:app.getPath('userData'),
      createCore:({root,dataRoot})=>new DesktopHostCore({root,dataRoot}),
      encrypt:value=>credentials.encrypt(value),
      decrypt:bytes=>credentials.decrypt(bytes),
      onState:message=>{log(`电脑: ${message}`);const item=Menu.getApplicationMenu()?.getMenuItemById('desktop-host-status');if(item)item.label=message}})
    ipcMain.handle('desktop:device-host', async event => {
      try {
        const trusted = event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame
          && serviceOrigins().includes(new URL(event.senderFrame.url).origin)
        if (!trusted || closing || quitting) throw new Error('不允许此页面读取设备身份')
      } catch (error) {
        if (error.message === '不允许此页面读取设备身份') throw error
        throw new Error('不允许此页面读取设备身份')
      }
      if (remoteMode) {
        const enrolled = await hostManager.read().catch(() => undefined)
        return { deviceHost: enrolled && new URL(enrolled.serverURL).origin === new URL(remoteURL).origin ? enrolled.hostId : null }
      }
      return { deviceHost: 'local' }
    })
    async function hostAction(action){try{await action()}catch(error){await dialog.showMessageBox(window,{type:'error',message:'电脑操作未完成',detail:error.message})}}
    const appDialog = options => window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
    async function authorizeComputer(server,session){
      const previous=await hostManager.read().catch(()=>undefined)
      const previousHostId=previous&&new URL(previous.serverURL).origin===new URL(server).origin?previous.hostId:undefined
      const registration=await enrollDesktopHost(session,{name:hostname(),installId:await hostManager.installIdentity(),previousHostId},authFetch)
      await hostManager.adopt({protocol:1,serverURL:server,hostId:registration.host.id,token:registration.token,...(server.startsWith('http://')?{allowInsecureLan:true}:{})})
      return registration
    }
    function requireModePage(event){
      let trusted=false
      try{trusted=event.sender===window?.webContents&&event.senderFrame===window.webContents.mainFrame
        &&serviceOrigins().includes(new URL(event.senderFrame.url).origin)}catch{}
      if(!trusted||closing||quitting)throw new Error('不允许此页面切换桌面运行模式')
    }
    ipcMain.handle('desktop:mode-state',event=>{
      requireModePage(event)
      return {mode:remoteMode?'client':'server',serverURL:serviceURL()||'',switching:switchingMode}
    })
    ipcMain.handle('desktop:mode-switch',async(event,mode)=>{
      requireModePage(event)
      if(mode!=='client'&&mode!=='server')throw new Error('运行模式无效')
      return switchMode(mode==='client'?'remote':'local')
    })
    ipcMain.handle('desktop:remote-login',event=>{
      requireModePage(event)
      if(switchingMode)throw new Error('正在切换运行模式，请稍候')
      return openRemoteLogin()
    })
    ipcMain.handle('desktop:computer-authorize',async(event,csrfToken)=>{
      requireModePage(event)
      if(!remoteMode||!remoteURL)return {registered:false}
      try{
        const token=String(csrfToken??'').trim()
        if(!token)throw new Error('登录状态缺少安全令牌，请重新登录')
        const cookies=await electronSession.defaultSession.cookies.get({url:remoteURL})
        const registration=await authorizeComputer(remoteURL,{origin:remoteURL,csrfToken:token,cookies:cookies.map(cookie=>[cookie.name,cookie.value])})
        return {registered:true,hostId:registration.host.id}
      }catch(error){
        const message=error instanceof Error?error.message:'电脑授权恢复失败'
        hostManager.publish(`电脑授权未恢复：${message}`)
        return {registered:false}
      }
    })
    async function importDesktopHost(){
      const selection=window&&!window.isDestroyed()
        ?await dialog.showOpenDialog(window,{title:'导入电脑配置',properties:['openFile'],filters:[{name:'电脑配置',extensions:['json']}]})
        :await dialog.showOpenDialog({title:'导入电脑配置',properties:['openFile'],filters:[{name:'电脑配置',extensions:['json']}]})
      if(!selection.canceled&&selection.filePaths[0]&&!closing)await hostAction(()=>hostManager.importFile(selection.filePaths[0]))
    }
    if (!preferences.value.remoteServer) {
      const enrolled = await hostManager.read().catch(() => undefined)
      if (enrolled?.serverURL) await preferences.setRemoteServer(enrolled.serverURL)
    }
    onboarding = new DesktopOnboarding({
      remoteServer: () => preferences.value.remoteServer,
      inspect: server => inspectServer(server, (...args) => net.fetch(...args)),
      prepareLocal: async ({ force }) => {
        serverModeActive = true; remoteMode = false; remoteURL = ''
        await hostManager.stop()
        manager.restarts = []
        if (force) await manager.retrySynchronization({ force: true })
        else await manager.start()
        if (manager.state.phase !== 'ready') throw new Error(manager.state.message)
        if (!closing) environmentHost.start()
        await runnerManager.start().catch(error => runnerManager.publish(error.message))
        return manager.state.url
      },
      register: ({ serverURL, username, password }) => remoteRegistration(serverURL, { username, password }, authFetch),
      authenticate: async ({ mode, serverURL, setup, username, password }) => {
        const auth = await remoteSession(serverURL, { setup, username, password }, authFetch)
        for (const cookie of auth.cookieDetails) {
          await electronSession.defaultSession.cookies.set({ url: serverURL, ...cookie,
            httpOnly: true, secure: cookie.secure || serverURL.startsWith('https://') })
        }
        await electronSession.defaultSession.cookies.flushStore()
        let warning
        if (mode === 'remote' && auth.user.role === 'admin') {
          try { await authorizeComputer(serverURL, auth) }
          catch (error) { warning = `账号已登录，但电脑授权未恢复：${error.message}。可先进入夭夭，稍后在“电脑”菜单重新授权。` }
        }
        return { username: auth.user.username, warning }
      },
      activate: async ({ mode, serverURL, remember }) => {
        if (closing || quitting) throw new Error('App 正在退出')
        if (mode === 'remote') {
          // Detach only; an independently installed local service keeps running.
          serverModeActive = false
          await environmentHost.close()
          await runnerManager.stop()
          await manager.stop()
          remoteMode = true; remoteURL = serverURL
          await preferences.setRemoteServer(serverURL)
          const enrolled = await hostManager.read().catch(error => { log(error.message); return undefined })
          if (enrolled && new URL(enrolled.serverURL).origin === new URL(serverURL).origin)
            await hostManager.start().catch(error => hostManager.publish(error.message))
        }
        await preferences.setStartupChoice(remember ? mode : 'ask')
        syncModeMenu()
        const status = Menu.getApplicationMenu()?.getMenuItemById('desktop-service-status')
        if (status) status.label = mode === 'remote' ? `已登录远程 · ${new URL(serverURL).host}` : '后台服务运行中'
        tray?.setToolTip(mode === 'remote' ? `夭夭 · 远程 ${new URL(serverURL).host}` : '夭夭 · 本机运行')
      },
      navigate: url => {
        if (closing || quitting) throw new Error('App 正在退出')
        return window.loadURL(url)
      },
    })
    async function openOnboarding(mode, { autoPrepare = false, remember = preferences.value.startupChoice !== 'ask', forceLogin = false } = {}) {
      if (closing || quitting) throw new Error('App 正在退出')
      const prepare = autoPrepare && (mode === 'local' || Boolean(preferences.value.remoteServer))
      onboarding.open({ mode, serverURL: preferences.value.remoteServer, remember, forceLogin, restoring: prepare && !forceLogin })
      if (!window || window.isDestroyed()) await createWindow()
      else if (window.webContents.getURL() !== bootURL) await window.loadURL(bootURL)
      window.show(); window.focus()
      if (prepare)
        await onboarding.prepare({ autoEnter: true })
      return onboarding.snapshot()
    }
    function openRemoteLogin() {
      return openOnboarding('remote', { forceLogin: true })
    }
    ipcMain.handle('desktop:open-login', event => {
      requireModePage(event)
      // A session expiry returns to the same main-page flow for the active server.
      return openOnboarding(remoteMode ? 'remote' : 'local', { autoPrepare: true })
    })
    function syncModeMenu(){
      const menu=Menu.getApplicationMenu()
      const useRemote=menu?.getMenuItemById('desktop-host-use-remote'),useLocal=menu?.getMenuItemById('desktop-host-use-local'),ask=menu?.getMenuItemById('desktop-host-ask')
      if(useRemote)useRemote.enabled=!switchingMode&&!remoteMode
      if(useLocal)useLocal.enabled=!switchingMode&&!serverModeActive
      const status=menu?.getMenuItemById('desktop-mode-status')
      if(status)status.label=switchingMode?'正在切换运行模式…':remoteMode?'当前：客户端模式':serverModeActive?'当前：服务器模式':'请选择运行模式'
      if(ask)ask.checked=preferences.value.startupChoice==='ask'
    }
    async function switchMode(mode) {
      if (closing || quitting) return { ok: false, error: 'App 正在退出' }
      if (switchingMode || onboarding.busy) return { ok: false, error: '当前步骤尚未完成，请稍候' }
      switchingMode = true; syncModeMenu()
      try {
        const state = await openOnboarding(mode, { autoPrepare: true, remember: true })
        return { ok: true, pendingLogin: state.active }
      } catch (error) {
        return { ok: false, error: error.message }
      } finally { switchingMode = false; syncModeMenu() }
    }
    async function importRunner(){
      const selection=await dialog.showOpenDialog(window,{title:'导入执行节点配置',properties:['openFile'],filters:[{name:'Runner 配置',extensions:['json']}]})
      if(!selection.canceled&&selection.filePaths[0]&&!closing)await runnerAction(()=>runnerManager.importFile(selection.filePaths[0]))
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '夭夭', submenu: [{ role: 'about', label: '关于夭夭' }, { type: 'separator' },
        { id:'desktop-service-status',label:'正在连接后台服务…',enabled:false },
        { label: '显示窗口', click: show }, { label: '在浏览器中打开', click: () => { const url = serviceURL(); if (url) safeExternal(url) } },
        { id:'desktop-local-vm',label:'本地虚拟机设置…',enabled:false,click:()=>{if(manager.state.phase==='ready'){show();void window.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('yaoyao:local-vm-settings'))")}} },
        { label: '查看服务日志', click: () => shell.showItemInFolder(logFile) },
        { id:'desktop-sync-notice', label:'Web 同步待完成：服务忙碌', enabled:false, visible:false },
        { id:'desktop-sync-retry', label:'重试同步本机 Web…', enabled:false,
          click:async()=>{try{await manager.retrySynchronization()}catch(error){log(error.message)}} },
        { id:'desktop-sync-force', label:'使用当前 App 覆盖同版本 Web', enabled:false,
          click:async()=>{if(closing||quitting||!manager.canForceSynchronization)return;try{await manager.retrySynchronization({force:true})}catch(error){log(error.message)}} },
        { id:'desktop-login', label:'登录 macOS 时启动', type:'checkbox', enabled:app.isPackaged, checked:app.getLoginItemSettings().openAtLogin,
          click:async item=>{try{app.setLoginItemSettings({openAtLogin:item.checked});item.checked=app.getLoginItemSettings().openAtLogin}catch(error){item.checked=app.getLoginItemSettings().openAtLogin;await dialog.showMessageBox(window,{type:'error',message:'无法修改登录启动设置',detail:error.message})}} },
        { id:'desktop-background', label:'登录启动时仅驻留菜单栏', type:'checkbox', checked:preferences.value.backgroundAtLogin,
          click:async item=>{try{await preferences.setBackgroundAtLogin(item.checked)}catch(error){item.checked=preferences.value.backgroundAtLogin;await dialog.showMessageBox(window,{type:'error',message:error.message})}} },
        { id:'desktop-update-check', label:'检查 App 更新…', click:showUpdates },
        { id:'desktop-update-help', label:'App 更新与回退…', click:()=>dialog.showMessageBox(window,{type:'info',message:`夭夭 App ${packageVersion}`,detail:`App 构建：${String(buildInfo.commit).slice(0,12)}\n\n通过“检查 App 更新”下载新版，准备完成后点击“重启更新”。此操作只更新当前电脑的 App，不升级远程服务器；独立后台服务继续运行。开发运行时提供手动安装包下载。\n\n服务器模式下，首次启动同步较旧的本机 Web，已有较新的 Web 保留。Web 降级通过服务器的回滚入口处理；数据库结构不兼容时不能直接降级。\n\n数据目录：${home}`,buttons:['知道了','打开数据目录']}).then(result=>{if(result.response===1)shell.showItemInFolder(home)}) },
        { type: 'separator' },
        { role: 'hide', label: '隐藏夭夭' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        {label:'撤销本机控制授权',click:()=>{void environmentHost.revoke();void hostManager?.revoke()}},
        { id:'desktop-quit',label:'退出夭夭（后台继续运行）',accelerator:'CommandOrControl+Q',click:()=>requestQuit() },
        { id:'desktop-stop-and-quit',label:'停止后台服务并退出',click:()=>requestQuit(true) }] },
      {label:'执行节点',submenu:[{id:'runner-status',label:'未配置执行节点',enabled:false},{type:'separator'},
        {id:'runner-import',label:'导入节点配置…',click:importRunner},
        {id:'runner-reconnect',label:'重新连接',click:()=>runnerAction(()=>runnerManager.start())},
        {id:'runner-forget',label:'断开并忘记配置',click:()=>runnerAction(()=>runnerManager.forget())}]},
      {label:'运行模式',submenu:[{id:'desktop-mode-status',label:'请选择运行模式',enabled:false},{type:'separator'},
        {id:'desktop-host-use-remote',label:'客户端模式（连接服务器）',enabled:!remoteMode,click:()=>void switchMode('remote')},
        {id:'desktop-host-use-local',label:'服务器模式（本机运行）',enabled:!serverModeActive,click:()=>void switchMode('local')},
        {label:'更换服务器…',click:()=>{void openRemoteLogin().catch(error=>log(error.message))}},{type:'separator'},
        {id:'desktop-host-ask',label:'启动时询问运行模式',type:'checkbox',checked:preferences.value.startupChoice==='ask',
          click:item=>{void preferences.setStartupChoice(item.checked?'ask':remoteMode?'remote':'local').catch(async error=>{item.checked=preferences.value.startupChoice==='ask';await appDialog({type:'error',message:'无法保存启动偏好',detail:error.message})})}}]},
      {label:'电脑',submenu:[{id:'desktop-host-status',label:'未配置电脑',enabled:false},{type:'separator'},
        {id:'desktop-host-authorize',label:'重新授权…',click:()=>{void openRemoteLogin().catch(error=>log(error.message))}},
        {id:'desktop-host-import',label:'导入电脑配置…',click:importDesktopHost},
        {id:'desktop-host-reconnect',label:'重新连接',click:()=>hostAction(()=>hostManager.start())},
        {id:'desktop-host-forget',label:'断开并忘记配置',click:()=>hostAction(()=>hostManager.forget())}]},
      { role: 'editMenu', label: '编辑' }, { role: 'viewMenu', label: '显示' }, { role: 'windowMenu', label: '窗口' },
    ]))
    const icon = nativeImage.createFromPath(join(desktopRoot, 'icon.png')).resize({ width: 20, height: 20 })
    icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.setToolTip('夭夭')
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开夭夭', click: show }, { label: '查看日志', click: () => shell.showItemInFolder(logFile) }, { type: 'separator' }, { label: '退出夭夭（后台继续运行）', click: () => requestQuit() }, { label: '停止后台服务并退出', click: () => requestQuit(true) }]))
    tray.on('click', show)
    // Restore a saved session behind neutral loading feedback. The guide only
    // becomes visible if a connection or account actually needs attention.
    const startupMode = preferences.value.startupChoice === 'ask'
      ? (fixtureHome && process.env.HERMES_YAOYAO_DESKTOP_TEST_MODE !== 'ask' ? 'local' : null)
      : preferences.value.startupChoice
    const restoreSession = Boolean(startupMode && (startupMode === 'local' || preferences.value.remoteServer))
    onboarding.open({ mode: startupMode, serverURL: preferences.value.remoteServer,
      remember: preferences.value.startupChoice !== 'ask', restoring: restoreSession })
    // Finish the initial navigation before a remembered session enters its server.
    await createWindow()
    powerMonitor.on('resume', () => { if (!closing && !quitting && serverModeActive) void manager.check() })
    timer = setInterval(() => { if (serverModeActive) void manager.check() }, 10_000); timer.unref()
    syncModeMenu()
    if (restoreSession)
      await onboarding.prepare({ autoEnter: true })
  }).catch(error => { log(error.stack || error.message); quitting = true; app.quit() })
}
