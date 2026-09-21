import { BrowserWindow, ipcMain } from 'electron'

/** Local authenticated viewer. Agent ownership and control leases remain server-authoritative. */
export function installComputerViewer({ owner, origin, preload, quitting = () => false }) {
  let viewer, viewerURL, currentTargetURL, approvedClose = false, opening = Promise.resolve()
  const trusted = event => event.sender === owner()?.webContents && event.senderFrame === event.sender.mainFrame
    && new URL(event.senderFrame.url).origin === origin()
  const targetURL = (id, target = {}) => {
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) throw new Error('电脑窗口请求无效')
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || Object.keys(target).some(key => !['backend', 'host'].includes(key))
      || (target.backend !== undefined && !['desktop', 'cloud', 'vm'].includes(target.backend))
      || (target.host !== undefined && (target.backend !== 'desktop' || typeof target.host !== 'string' || !/^[\w-]{1,128}$/.test(target.host))))
      throw new Error('所选电脑无效，请重新选择')
    const url = new URL(`/conversations/computer/${encodeURIComponent(id)}`, origin())
    if (target.backend) url.searchParams.set('backend', target.backend)
    if (target.backend === 'desktop') url.searchParams.set('host', target.host || 'local')
    return url.href
  }
  ipcMain.handle('desktop-computer:open', (event, id, target) => {
    if (!trusted(event)) throw new Error('电脑窗口请求无效')
    const requestedURL = targetURL(id, target)
    const pending = opening.catch(() => {}).then(() => open(requestedURL))
    opening = pending
    return pending
  })
  async function open(url) {
    if (quitting()) return false
    if (viewer && !viewer.isDestroyed()) {
      if (currentTargetURL === url) { viewer.show(); viewer.focus(); return true }
      // The old page must return its lease before another target can open.
      const previous = viewer
      await new Promise((resolve, reject) => {
        const closed = () => { clearTimeout(timeout); resolve() }
        const timeout = setTimeout(() => {
          previous.removeListener('closed', closed)
          if (!previous.isDestroyed()) { previous.show(); previous.focus() }
          reject(new Error('当前电脑尚未交还，请在电脑窗口交还并关闭后重试'))
        }, 15000)
        previous.once('closed', closed)
        previous.close()
      })
    }
    if (quitting()) return false
    viewerURL = url; currentTargetURL = url; approvedClose = false
    const current = viewer = new BrowserWindow({ parent: owner(), modal: false, width: 1220, height: 820,
      minWidth: 760, minHeight: 520, show: false, title: '电脑接管 · 夭夭 AI', backgroundColor: '#111315', autoHideMenuBar: true,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    current.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault() })
    current.webContents.on('will-redirect', event => event.preventDefault())
    current.webContents.on('will-attach-webview', event => event.preventDefault())
    current.on('close', event => {
      if (!approvedClose && !quitting() && !current.webContents.isCrashed()) {
        event.preventDefault(); current.webContents.send('desktop-computer:request-close')
      }
    })
    current.on('closed', () => { if (viewer === current) { viewer = undefined; viewerURL = undefined; currentTargetURL = undefined } })
    current.once('ready-to-show', () => { current.show(); current.focus() })
    try { await current.loadURL(url) } catch (error) { approvedClose = true; current.close(); throw error }
    return true
  }
  ipcMain.handle('desktop-computer:target', (event, target) => {
    if (event.sender !== viewer?.webContents || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== viewerURL) throw new Error('电脑窗口身份无效')
    currentTargetURL = targetURL(decodeURIComponent(new URL(viewerURL).pathname.split('/').at(-1)), target)
  })
  ipcMain.handle('desktop-computer:closed', event => {
    if (event.sender !== viewer?.webContents || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame.url !== viewerURL) throw new Error('电脑窗口身份无效')
    approvedClose = true; viewer.close()
  })
  const close = () => { approvedClose = true; viewer?.destroy() }
  close.owns = contents => contents === viewer?.webContents
  return close
}
