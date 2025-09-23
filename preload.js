
// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onStatus: (cb) => ipcRenderer.on('comment:status', (_e, data) => cb(data)),
  onComment: (cb) => ipcRenderer.on('comment:received', (_e, rec) => cb(rec)),
  onError: (cb) => ipcRenderer.on('comment:error', (_e, err) => cb(err)),
  getStore: () => ipcRenderer.invoke('store:get'),
  setIconPos: (pos) => ipcRenderer.invoke('store:setIconPos', pos),
  setOverlayPassthrough: (ignore) => ipcRenderer.send('overlay:passthrough', ignore),
  openInputAt: (rect) => ipcRenderer.invoke('input:open', rect),
  cancelInput: () => ipcRenderer.send('input:cancel'),
});
