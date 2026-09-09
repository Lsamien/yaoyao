const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('yaoyaoDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('desktop:status'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  logs: () => ipcRenderer.invoke('desktop:logs'),
}))
