const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('yaoyaoRemoteLogin', Object.freeze({
  submit: value => ipcRenderer.invoke('desktop-remote-login:submit', value),
  useLocal: () => ipcRenderer.invoke('desktop-remote-login:use-local'),
}))
