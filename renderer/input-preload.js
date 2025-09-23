// renderer/input-preload.js
const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('apiInput', {
submit: (text) => ipcRenderer.send('input:submit', text),
cancel: () => ipcRenderer.send('input:cancel'),
});