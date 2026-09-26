const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liturgiaStream', {
  discoverWorship: () => ipcRenderer.invoke('worship:discover'),
  refreshWorship: () => ipcRenderer.invoke('worship:refresh'),
  getWorshipInstances: () => ipcRenderer.invoke('worship:instances'),
  getConfig: () => ipcRenderer.invoke('stream:config:get'),
  getEncoderInfo: () => ipcRenderer.invoke('stream:encoder:info'),
  saveConfig: (config) => ipcRenderer.invoke('stream:config:save', config),
  startOutput: () => ipcRenderer.invoke('stream:output:start'),
  sendOutputChunk: (data) => ipcRenderer.invoke('stream:output:chunk', data),
  stopOutput: () => ipcRenderer.invoke('stream:output:stop'),
  onOutputStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('stream:output:status', listener);
    return () => ipcRenderer.removeListener('stream:output:status', listener);
  },
  saveScenes: (scenes, activeSceneId) => ipcRenderer.invoke('stream:scenes:save', scenes, activeSceneId),
  saveDevices: (devices) => ipcRenderer.invoke('stream:devices:save', devices),
  onWorshipInstances: (callback) => {
    const listener = (_event, instances) => callback(instances);
    ipcRenderer.on('worship:instances', listener);
    return () => ipcRenderer.removeListener('worship:instances', listener);
  }
});
