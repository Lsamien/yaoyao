const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('yaoyaoDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('desktop:status'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  logs: () => ipcRenderer.invoke('desktop:logs'),
  openUpdates: () => ipcRenderer.invoke('desktop:updates'),
  openComputer: id => ipcRenderer.invoke('desktop-computer:open', id),
  computerClosed: () => ipcRenderer.invoke('desktop-computer:closed'),
  onComputerClose: callback => {
    const listener = () => callback()
    ipcRenderer.on('desktop-computer:request-close', listener)
    return () => ipcRenderer.removeListener('desktop-computer:request-close', listener)
  },
}))
