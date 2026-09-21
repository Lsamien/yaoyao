const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('yaoyaoUpdate', Object.freeze(Object.fromEntries(
  ['state', 'check', 'download', 'cancel', 'install', 'open', 'folder', 'release'].map(action => [action, () => ipcRenderer.invoke(`desktop-update:${action}`)]),
)))
