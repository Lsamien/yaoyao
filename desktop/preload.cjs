const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('yaoyaoDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('desktop:status'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  forceSync: () => ipcRenderer.invoke('desktop:force-sync'),
  logs: () => ipcRenderer.invoke('desktop:logs'),
  openUpdates: () => ipcRenderer.invoke('desktop:updates'),
  modeState: () => ipcRenderer.invoke('desktop:mode-state'),
  switchMode: mode => ipcRenderer.invoke('desktop:mode-switch', mode),
  openRemoteLogin: () => ipcRenderer.invoke('desktop:remote-login'),
  authorizeComputer: csrfToken => ipcRenderer.invoke('desktop:computer-authorize', csrfToken),
  /** 'local' on the YaoYao server Mac; paired host uuid in remote mode; null if unknown. */
  deviceHost: () => ipcRenderer.invoke('desktop:device-host'),
  openComputer: (id, target) => ipcRenderer.invoke('desktop-computer:open', id, target),
  computerTargetChanged: target => ipcRenderer.invoke('desktop-computer:target', target),
  computerClosed: () => ipcRenderer.invoke('desktop-computer:closed'),
  onComputerClose: callback => {
    const listener = () => callback()
    ipcRenderer.on('desktop-computer:request-close', listener)
    return () => ipcRenderer.removeListener('desktop-computer:request-close', listener)
  },
}))
