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
import { remoteSession, enrollDesktopHost, normalizeServerURL } from './remote-login.mjs'
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
  let updateWindow, updater, environmentHost, hostManager, loginWindow
  let remoteMode = false, remoteURL = '', serverModeActive = false, switchingMode = false
  const serviceURL = () => remoteMode ? remoteURL : manager?.state.url
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

  const trustedBoot = event => event.sender === window?.webContents && event.senderFrame?.url === bootURL
  ipcMain.handle('desktop:status', event => {
    if (!trustedBoot(event)) throw new Error('不允许此页面访问桌面服务')
    return { phase: manager?.state.phase || 'starting', message: manager?.state.message || '正在启动…', canForceSync: manager?.state.canForceSync === true }
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
  ipcMain.handle('desktop:force-sync', async event => {
    if (!trustedBoot(event) || event.senderFrame !== window.webContents.mainFrame || closing || quitting || !manager?.canForceSynchronization)
      throw new Error('不允许此页面覆盖本机 Web')
    try { await manager.retrySynchronization({ force: true }); return true }
    catch (error) { log(error.message); return false }
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
    if (remoteMode && remoteURL) void window.loadURL(remoteURL)
    else if (manager?.state.phase === 'ready') void window.loadURL(manager.state.url)
    else void window.loadFile(join(desktopRoot, 'boot.html'))
  }
  function stateChanged(state) {
    log(`${state.phase}: ${state.message}`)
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
    updater?.cancel(); updateWindow?.close(); loginWindow?.close()
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
      const registration=await enrollDesktopHost(session,{name:hostname(),installId:await hostManager.installIdentity(),previousHostId})
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
      return switchMode(mode==='client'?'remote':'local',false)
    })
    ipcMain.handle('desktop:remote-login',event=>{
      requireModePage(event)
      if(switchingMode)throw new Error('正在切换运行模式，请稍候')
      openRemoteLogin()
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
        await appDialog({type:'warning',message:'账号已登录，但电脑授权未恢复',detail:`${message}\n\n请在“电脑”菜单中选择“重新授权…”。`})
        return {registered:false}
      }
    })
    async function importDesktopHost(){
      const selection=window&&!window.isDestroyed()
        ?await dialog.showOpenDialog(window,{title:'导入电脑配置',properties:['openFile'],filters:[{name:'电脑配置',extensions:['json']}]})
        :await dialog.showOpenDialog({title:'导入电脑配置',properties:['openFile'],filters:[{name:'电脑配置',extensions:['json']}]})
      if(!selection.canceled&&selection.filePaths[0]&&!closing)await hostAction(()=>hostManager.importFile(selection.filePaths[0]))
    }
    function openRemoteLogin(){
      if(closing||quitting)return
      if(loginWindow&&!loginWindow.isDestroyed()){loginWindow.show();loginWindow.focus();return}
      loginWindow=new BrowserWindow({width:420,height:580,minWidth:360,minHeight:440,show:false,title:'登录远程',backgroundColor:'#f7f7f7',
        webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,preload:join(desktopRoot,'remote-login-preload.cjs')}})
      loginWindow.once('ready-to-show',()=>{if(loginWindow)loginWindow.show()})
      loginWindow.on('closed',()=>{loginWindow=undefined})
      const stored=preferences.value.remoteServer
      void loginWindow.loadFile(join(desktopRoot,'remote-login.html'),stored?{query:{server:stored}}:undefined)
    }
    async function enterRemoteMode(){
      const enrolled=await hostManager.read().catch(error=>{log(error.message);return undefined})
      let server=''
      const candidate=preferences.value.remoteServer||enrolled?.serverURL
      if(candidate){try{server=normalizeServerURL(candidate)}catch(error){log(error.message)}}
      if(!server){openRemoteLogin();return false}
      serverModeActive=false
      await environmentHost?.close().catch(error=>log(error.message))
      await runnerManager?.stop().catch(error=>log(error.message))
      await manager?.stop().catch(error=>log(error.message))
      remoteMode=true;remoteURL=server
      await preferences.setRemoteServer(server).catch(error=>log(error.message))
      await preferences.setStartupChoice('remote').catch(error=>log(error.message))
      if(enrolled&&new URL(enrolled.serverURL).origin===new URL(server).origin)await hostManager.start().catch(error=>{hostManager.publish(error.message)})
      const status=Menu.getApplicationMenu()?.getMenuItemById('desktop-service-status')
      if(status)status.label=`已登录远程 · ${new URL(server).host}`
      tray?.setToolTip(`夭夭 · 远程 ${new URL(server).host}`)
      syncModeMenu()
      log(`远程模式：${server}`)
      if(!fixtureHome){
        try{
          const probe=await net.fetch(new URL('/api/app/bootstrap',server),{headers:{accept:'application/json'},redirect:'error'})
          const info=await probe.json().catch(()=>undefined)
          if(info?.authenticated!==true)openRemoteLogin()
        }catch{openRemoteLogin()}
      }
      return true
    }
    function syncModeMenu(){
      const menu=Menu.getApplicationMenu()
      const useRemote=menu?.getMenuItemById('desktop-host-use-remote'),useLocal=menu?.getMenuItemById('desktop-host-use-local'),ask=menu?.getMenuItemById('desktop-host-ask')
      if(useRemote)useRemote.enabled=!switchingMode&&!remoteMode
      if(useLocal)useLocal.enabled=!switchingMode&&!serverModeActive
      const status=menu?.getMenuItemById('desktop-mode-status')
      if(status)status.label=switchingMode?'正在切换运行模式…':remoteMode?'当前：客户端模式':serverModeActive?'当前：服务器模式':'请选择运行模式'
      if(ask)ask.checked=preferences.value.startupChoice==='ask'
    }
    async function switchMode(mode,notify=true){
      if(closing||quitting)return {ok:false,error:'App 正在退出'}
      if(switchingMode)return {ok:false,error:'正在切换运行模式，请稍候'}
      if(mode==='remote'&&remoteMode||mode==='local'&&serverModeActive)return {ok:true}
      switchingMode=true;syncModeMenu()
      try{
        if(mode==='remote'){
          if(await enterRemoteMode()){
            if(window&&!window.isDestroyed())void window.loadURL(remoteURL)
          }else return {ok:true,pendingLogin:true}
        }else{
          loginWindow?.close()
          serverModeActive=true;remoteMode=false;remoteURL=''
          await hostManager?.stop().catch(error=>log(error.message))
          await preferences.setStartupChoice('local').catch(error=>log(error.message))
          if(window&&!window.isDestroyed())void window.loadFile(join(desktopRoot,'boot.html'))
          await manager?.start().catch(error=>log(error.message))
          if(!closing)environmentHost?.start()
        }
        return {ok:true}
      }catch(error){
        if(notify)await appDialog({type:'error',message:'切换使用方式未完成',detail:error.message})
        return {ok:false,error:error.message}
      }finally{switchingMode=false;syncModeMenu()}
    }
    ipcMain.handle('desktop-remote-login:submit',async(_event,value)=>{
      if(closing||quitting)return {ok:false,error:'App 正在退出'}
      try{
        const server=normalizeServerURL(value?.serverURL)
        const auth=await remoteSession(server,{username:value?.username,password:value?.password})
        let registered=false
        if(auth.user?.role==='admin'){
          await authorizeComputer(server,auth)
          registered=true
        }
        try{
          for(const [name,cookie] of auth.cookies)
            await electronSession.defaultSession.cookies.set({url:server,name,value:cookie,httpOnly:true,secure:server.startsWith('https://')})
        }catch(error){log(`远程会话 Cookie 写入失败：${error.message}`)}
        await preferences.setRemoteServer(server)
        await enterRemoteMode()
        if(!window||window.isDestroyed())createWindow()
        else void window.loadURL(server)
        loginWindow?.close()
        if(!registered)await appDialog({type:'info',message:'已登录远程服务器',detail:'当前账号不是管理员：窗口将使用远程夭夭。要把这台 Mac 注册为可远程控制的电脑，请使用管理员账号重新登录。'})
        return {ok:true,hostRegistered:registered,user:{username:auth.user.username,role:auth.user.role}}
      }catch(error){return {ok:false,error:error instanceof Error?error.message:'登录失败'}}
    })
    ipcMain.handle('desktop-remote-login:use-local',async()=>{
      loginWindow?.close()
      if(!serverModeActive){
        if(!window||window.isDestroyed())createWindow()
        await switchMode('local')
      }
      return {ok:true}
    })
    async function chooseStartupMode(){
      if(fixtureHome)return 'local'
      const stored=preferences.value.startupChoice
      if(stored==='local'||stored==='remote')return stored
      const choice=await dialog.showMessageBox({type:'question',title:'夭夭',message:'这台 Mac 如何使用夭夭？',
        detail:'「登录远程」用夭夭服务器的地址和账号密码登录另一台电脑上的夭夭：本机不运行 Web 服务，窗口直接使用远程夭夭；管理员账号还会把这台 Mac 注册为可远程控制的电脑。只有「作为服务器运行」会启动这台 Mac 的服务，并使用服务器上的 Hermes。客户端不需要安装 Hermes。',
        buttons:['连接服务器（客户端）','作为服务器运行'],defaultId:0,cancelId:0,checkboxLabel:'记住选择，之后启动不再询问',checkboxChecked:false,noLink:true})
      const mode=choice.response===0?'remote':'local'
      if(choice.checkboxChecked)await preferences.setStartupChoice(mode).catch(error=>log(error.message))
      return mode
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
        { id:'desktop-update-help', label:'App 更新与回退…', click:()=>dialog.showMessageBox(window,{type:'info',message:`夭夭 App ${packageVersion}`,detail:`App 构建：${String(buildInfo.commit).slice(0,12)}\n当前 Web：${manager.state.version||'尚未就绪'}${manager.state.build?.commit?' · '+manager.state.build.commit.slice(0,12):''}${manager.state.external?'（独立后台服务）':'（开发模式）'}\n\n通过“检查 App 更新”从 GitHub 下载并校验 DMG，手动拖入应用程序安装。开发签名包尚未公证，请遵循 macOS 的安装提示。\n\n安装后首次启动同步较旧的本机 Web，已有较新的 Web 保留。Web 可以独立升级，退出 App 保留独立后台服务。\n\n降级通过 Web 的回滚入口处理；数据库结构不兼容时不能直接降级。\n\n数据目录：${home}`,buttons:['知道了','打开数据目录']}).then(result=>{if(result.response===1)shell.showItemInFolder(home)}) },
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
        {label:'更换服务器…',click:openRemoteLogin},{type:'separator'},
        {id:'desktop-host-ask',label:'启动时询问运行模式',type:'checkbox',checked:preferences.value.startupChoice==='ask',
          click:item=>{void preferences.setStartupChoice(item.checked?'ask':remoteMode?'remote':'local').catch(async error=>{item.checked=preferences.value.startupChoice==='ask';await appDialog({type:'error',message:'无法保存启动偏好',detail:error.message})})}}]},
      {label:'电脑',submenu:[{id:'desktop-host-status',label:'未配置电脑',enabled:false},{type:'separator'},
        {id:'desktop-host-authorize',label:'重新授权…',click:openRemoteLogin},
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
    let startupRemote=false,startupLogin=false
    serverModeActive=(await chooseStartupMode())==='local'
    if(!serverModeActive){
      const enrolled=await hostManager.read().catch(()=>undefined)
      if(preferences.value.remoteServer||enrolled)startupRemote=await enterRemoteMode()
      startupLogin=!startupRemote
    }
    if(!startupLogin)createWindow()
    powerMonitor.on('resume', () => { if(!closing&&!quitting&&serverModeActive)void manager.check() })
    timer = setInterval(() => { if(serverModeActive)void manager.check() }, 10_000); timer.unref()
    if(startupLogin)openRemoteLogin()
    else if(serverModeActive){
      syncModeMenu()
      await manager.start().catch(error => log(error.message))
      if(!closing)environmentHost.start()
    }
    if(!startupLogin&&!startupRemote&&manager.state.phase==='ready')await runnerManager.start().catch(error=>{runnerManager.publish(error.message)})
  }).catch(error => { log(error.stack || error.message); quitting = true; app.quit() })
}
