const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopRuntime', {
  platform: process.platform,
  versions: process.versions,
  sidecarWsUrl: 'ws://127.0.0.1:8765/transcribe',
  transcribeMode: 'vosk-sidecar',
  getSidecarStatus: () => ipcRenderer.invoke('sidecar:get-status'),
  restartSidecar: () => ipcRenderer.invoke('sidecar:restart'),
  setSidecarModelSize: (size) => ipcRenderer.invoke('sidecar:set-model-size', size),
  openSidecarModelFolder: () => ipcRenderer.invoke('sidecar:open-model-folder'),
  onSidecarStatus: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('sidecar:status', listener);
    return () => ipcRenderer.removeListener('sidecar:status', listener);
  },
  pushSuggestions: (payload) => ipcRenderer.send('ai:suggestions-from-renderer', payload),
  getLatestSuggestions: () => ipcRenderer.invoke('ai:get-latest-suggestions'),
  onSuggestions: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('ai:suggestions', listener);
    return () => ipcRenderer.removeListener('ai:suggestions', listener);
  },
  setAiEnabled: (enabled) => ipcRenderer.invoke('ai:set-enabled', !!enabled),
  getAiEnabled: () => ipcRenderer.invoke('ai:get-enabled'),
  onPrepareReport: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_e) => handler();
    ipcRenderer.on('prepare-speech-report', listener);
    return () => ipcRenderer.removeListener('prepare-speech-report', listener);
  },
  sendReport: (payload) => ipcRenderer.send('speech-report', payload)
});
