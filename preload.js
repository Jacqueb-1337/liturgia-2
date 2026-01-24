// Preload script - expose safe APIs
const { contextBridge, ipcRenderer } = require('electron');
const { fileUrlFor } = require('./lib/paths');

contextBridge.exposeInMainWorld('paths', {
  fileUrlFor: (p) => fileUrlFor(p)
});

// Re-export ipcRenderer invoke for convenience in renderer (minimal surface)
contextBridge.exposeInMainWorld('ipc', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)
});
