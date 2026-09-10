import { BrowserWindow, ipcMain } from 'electron'

/** Local authenticated viewer. Agent ownership and control leases remain server-authoritative. */
export function installComputerViewer({ owner, origin, preload, quitting = () => false }) {
  let viewer, agentId, approvedClose = false
  const trusted = event => event.sender === owner()?.webContents && event.senderFrame === event.sender.mainFrame
    && new URL(event.senderFrame.url).origin === origin()
  ipcMain.handle('desktop-computer:open', async (event, id) => {
    if (!trusted(event) || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) throw new Error('电脑窗口请求无效')
    if (viewer && !viewer.isDestroyed()) {
      viewer.show(); viewer.focus()
      if (agentId !== id) throw new Error('请先交还并关闭当前电脑，再接管另一台电脑')
      return true
    }
    const url = new URL(`/conversations/computer/${encodeURIComponent(id)}`, origin()).href
    agentId = id; approvedClose = false
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
    current.on('closed', () => { if (viewer === current) { viewer = undefined; agentId = undefined } })
    current.once('ready-to-show', () => { current.show(); current.focus() })
    try { await current.loadURL(url) } catch (error) { approvedClose = true; current.close(); throw error }
    return true
  })
  ipcMain.handle('desktop-computer:closed', event => {
    if (event.sender !== viewer?.webContents || event.senderFrame !== event.sender.mainFrame
      || new URL(event.senderFrame.url).pathname !== `/conversations/computer/${agentId}`) throw new Error('电脑窗口身份无效')
    approvedClose = true; viewer.close()
  })
  const close = () => { approvedClose = true; viewer?.destroy() }
  close.owns = contents => contents === viewer?.webContents
  return close
}
