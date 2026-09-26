const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liturgiaStream', {
  discoverWorship: () => ipcRenderer.invoke('worship:discover'),
  refreshWorship: () => ipcRenderer.invoke('worship:refresh'),
  getWorshipInstances: () => ipcRenderer.invoke('worship:instances'),
  getConfig: () => ipcRenderer.invoke('stream:config:get'),
  getEncoderInfo: () => ipcRenderer.invoke('stream:encoder:info'),
  saveConfig: (config) => ipcRenderer.invoke('stream:config:save', config),
  saveScenes: (scenes, activeSceneId) => ipcRenderer.invoke('stream:scenes:save', scenes, activeSceneId),
  onWorshipInstances: (callback) => {
    const listener = (_event, instances) => callback(instances);
    ipcRenderer.on('worship:instances', listener);
    return () => ipcRenderer.removeListener('worship:instances', listener);
  }
});
