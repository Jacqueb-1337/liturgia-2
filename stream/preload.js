const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liturgiaStream', {
  discoverWorship: () => ipcRenderer.invoke('worship:discover'),
  refreshWorship: () => ipcRenderer.invoke('worship:refresh'),
  getWorshipInstances: () => ipcRenderer.invoke('worship:instances'),
  onWorshipInstances: (callback) => {
    const listener = (_event, instances) => callback(instances);
    ipcRenderer.on('worship:instances', listener);
    return () => ipcRenderer.removeListener('worship:instances', listener);
  }
});
