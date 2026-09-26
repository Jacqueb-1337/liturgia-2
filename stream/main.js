const { app, BrowserWindow, ipcMain, session, safeStorage } = require('electron');
const { createSettingsStore } = require('./settingsStore');

const { Bonjour } = require('bonjour-service');
const os = require('os');
const net = require('net');
const path = require('path');

let mainWindow = null;
let bonjour = null;
let browser = null;
const discovered = new Map();
let settingsStore = null;

function publishDiscovery() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worship:instances', [...discovered.values()]);
  }
}

function normalizeService(service) {
  const addresses = Array.isArray(service.addresses) ? service.addresses : [];
  const address = addresses.find((item) => net.isIPv4(item) && !item.startsWith('169.254.'))
    || service.host;
  if (!address || !Number.isInteger(service.port)) return null;

  const displayId = String((service.txt && service.txt.displayId) ?? '');
  const key = `${service.name}|${displayId}|${service.port}`;
  return {
    key,
    name: service.name || 'Liturgia Worship',
    displayId,
    address,
    port: service.port,
    version: String((service.txt && service.txt.version) || ''),
    url: `http://${address}:${service.port}/`
  };
}

function startDiscovery() {
  if (browser) browser.stop();
  if (bonjour) bonjour.destroy();
  discovered.clear();
  bonjour = new Bonjour((error) => console.warn('[discovery] mDNS error:', error.message));
  browser = bonjour.find({ type: 'liturgia-display', protocol: 'tcp' });
  browser.on('up', (service) => {
    const item = normalizeService(service);
    if (!item) return;
    discovered.set(item.key, item);
    publishDiscovery();
  });
  browser.on('down', (service) => {
    const item = normalizeService(service);
    if (item) discovered.delete(item.key);
    else {
      for (const [key, known] of discovered) {
        if (known.name === service.name) discovered.delete(key);
      }
    }
    publishDiscovery();
  });
  browser.start();
  publishDiscovery();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 840,
    minHeight: 600,
    backgroundColor: '#181a1b',
    title: 'Liturgia Stream',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  settingsStore = createSettingsStore(app.getPath('userData'), safeStorage);
  ipcMain.handle('stream:config:get', () => settingsStore.load());
  ipcMain.handle('stream:config:save', (_event, config) => settingsStore.save(config));
  ipcMain.handle('stream:scenes:save', (_event, scenes, activeSceneId) => settingsStore.saveScenes(scenes, activeSceneId));
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  ipcMain.handle('worship:discover', () => {
    startDiscovery();
    return [...discovered.values()];
  });
  ipcMain.handle('worship:refresh', () => {
    if (browser) browser.update();
    return [...discovered.values()];
  });
  ipcMain.handle('worship:instances', () => [...discovered.values()]);
  createWindow();
  startDiscovery();
});

app.on('before-quit', () => {
  if (browser) browser.stop();
  if (bonjour) bonjour.destroy();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
