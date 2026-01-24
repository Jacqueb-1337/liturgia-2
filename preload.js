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

