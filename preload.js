// Preload script - expose safe APIs in both context-isolated and legacy modes
const { ipcRenderer } = require('electron');
const { fileUrlFor } = require('./lib/paths');

function exposeGlobal(name, value) {
  try {
    // Use contextBridge when available (contextIsolation enabled)
    const { contextBridge } = require('electron');
    if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
      contextBridge.exposeInMainWorld(name, value);
      return;
    }
  } catch (e) {
    // contextBridge not available — fall back to direct global assignment
  }
  try { globalThis[name] = value; } catch (e) {}
}

exposeGlobal('paths', { fileUrlFor: (p) => fileUrlFor(p) });
exposeGlobal('ipc', { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });

function subscribeToChannel(channel, handler, preprocess) {
  if (typeof handler !== 'function') return () => {};
  const wrapped = (_event, payload) => {
    if (typeof preprocess === 'function') {
      try { preprocess(payload); } catch (_) {}
    }
    handler(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

let cachedSidecarStatus = null;
let cachedAiSuggestions = null;
let cachedAiEnabled = true;

ipcRenderer.on('ai:suggestions', (_event, payload) => {
  cachedAiSuggestions = payload || null;
});

ipcRenderer.on('ai:enabled-changed', (_event, enabled) => {
  cachedAiEnabled = !!enabled;
});

const desktopRuntimeBridge = {
  platform: process.platform,
  versions: process.versions,
  transcribeMode: 'vosk-sidecar',
  sidecarWsUrl: 'ws://127.0.0.1:8765/transcribe',
  getSidecarStatus: () => ipcRenderer.invoke('sidecar:get-status'),
  ensureSidecarRunning: () => ipcRenderer.invoke('sidecar:ensure-running'),
  restartSidecar: () => ipcRenderer.invoke('sidecar:restart'),
  setSidecarModelSize: (size) => ipcRenderer.invoke('sidecar:set-model-size', size),
  openSidecarModelFolder: () => ipcRenderer.invoke('sidecar:open-model-folder'),
  onSidecarStatus: (handler) => subscribeToChannel('sidecar:status', handler, (payload) => {
    if (payload && payload.sidecarWsUrl) desktopRuntimeBridge.sidecarWsUrl = payload.sidecarWsUrl;
    cachedSidecarStatus = payload || null;
  }),
  getCachedSidecarStatus: () => cachedSidecarStatus,
  getLatestSuggestions: () => ipcRenderer.invoke('ai:get-latest-suggestions'),
  onSuggestions: (handler) => subscribeToChannel('ai:suggestions', handler),
  getCachedSuggestions: () => cachedAiSuggestions,
  pushSuggestions: (payload) => ipcRenderer.send('ai:suggestions-from-renderer', payload),
  getAiEnabled: () => ipcRenderer.invoke('ai:get-enabled'),
  setAiEnabled: (enabled) => ipcRenderer.invoke('ai:set-enabled', !!enabled),
  onAiEnabledChanged: (handler) => subscribeToChannel('ai:enabled-changed', handler),
  getCachedAiEnabled: () => cachedAiEnabled,
  // Notifies listeners when the active Bible's book list changes (bible switch, initial load).
  onBibleBooksUpdated: (handler) => subscribeToChannel('bible-books-updated', handler)
};

ipcRenderer.on('sidecar:status', (_event, payload) => {
  cachedSidecarStatus = payload || null;
  if (payload && payload.sidecarWsUrl) {
    desktopRuntimeBridge.sidecarWsUrl = payload.sidecarWsUrl;
  }
});

ipcRenderer.invoke('sidecar:get-status').then((status) => {
  cachedSidecarStatus = status || null;
  if (status && status.sidecarWsUrl) desktopRuntimeBridge.sidecarWsUrl = status.sidecarWsUrl;
}).catch(() => {});

ipcRenderer.invoke('ai:get-latest-suggestions').then((payload) => {
  cachedAiSuggestions = payload || null;
}).catch(() => {});

ipcRenderer.invoke('ai:get-enabled').then((payload) => {
  if (payload && typeof payload.enabled === 'boolean') {
    cachedAiEnabled = payload.enabled;
  }
  if (payload && payload.status) {
    cachedSidecarStatus = payload.status;
    if (payload.status.sidecarWsUrl) {
      desktopRuntimeBridge.sidecarWsUrl = payload.status.sidecarWsUrl;
    }
  }
}).catch(() => {});

exposeGlobal('desktopRuntime', desktopRuntimeBridge);

// Provide a minimal window.require and module when running without contextIsolation
// This keeps legacy renderer scripts (using require/module.exports) working during migration.
exposeGlobal('require', (m) => {
  if (typeof m !== 'string') throw new Error('Module name must be a string');
  const path = require('path');
  // Allow local relative requires (e.g., ./scriptureData) and absolute file paths
  if (m.startsWith('./') || m.startsWith('../') || m.startsWith('/')) {
    const resolved = path.join(__dirname, m);
    return require(resolved);
  }
  // Allow a short whitelist of core modules
  const allowed = ['fs', 'path', 'os', 'util', 'events', 'electron'];
  if (allowed.includes(m)) return require(m);
  // Try to require from node_modules (e.g., sql.js, node-fetch). If it fails, deny.
  try { return require(m); } catch (e) { throw new Error(`Module '${m}' not allowed in renderer`); }
});

// Expose module object so scripts that set module.exports don't crash when loaded via <script>
exposeGlobal('module', {});

