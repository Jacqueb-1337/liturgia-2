const { app, BrowserWindow, ipcMain, session, safeStorage, dialog } = require('electron');
const { createSettingsStore } = require('./settingsStore');
const { executableCandidates, probeFirstAvailable, buildRtmpUrl } = require('./ffmpegRuntime');
const { StreamOutputManager } = require('./outputManager');

const { Bonjour } = require('bonjour-service');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let bonjour = null;
let browser = null;
const discovered = new Map();
const publicInstances = () => [...discovered.values()].map(({ styleToken, ...instance }) => instance);
let settingsStore = null;
let encoderProbe = null;
let outputManager = null;
let quitAfterOutputStopped = false;

function getEncoderInfo() {
  if (!encoderProbe) {
    encoderProbe = probeFirstAvailable(executableCandidates({
      platform: process.platform,
      configuredPath: process.env.LITURGIA_FFMPEG_PATH,
      resourcesPath: process.resourcesPath,
      appPath: __dirname
    }));
  }
  return encoderProbe;
}

function publishDiscovery() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('worship:instances', publicInstances());
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
    url: `http://${address}:${service.port}/`,
    programStreamUrl: displayId === '0' ? `ws://${address}:${service.port}/program-stream` : null,
    styleAvailable: displayId === '0' && !!service.txt?.styleToken,
    styleToken: displayId === '0' ? String(service.txt?.styleToken || '') : ''
  };
}

function requestWorshipStyles(key, method, styles) {
  const instance = discovered.get(key);
  if (!instance?.styleToken || instance.displayId !== '0') {
    return Promise.reject(new Error('This Worship instance does not support LAN style editing.'));
  }
  const body = styles ? JSON.stringify(styles) : '';
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: instance.address,
      port: instance.port,
      path: '/program-styles',
      method,
      timeout: 5000,
      headers: {
        'X-Liturgia-Stream-Token': instance.styleToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      let result = '';
      response.on('data', (chunk) => {
        result += chunk;
        if (result.length > 32768) response.destroy(new Error('Worship style response is too large.'));
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(result);
          if (response.statusCode !== 200) throw new Error(parsed.error || 'Could not edit Worship styles.');
          resolve(parsed.styles);
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Worship did not respond.')));
    request.on('error', reject);
    request.end(body);
  });
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
      sandbox: true,
      backgroundThrottling: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  settingsStore = createSettingsStore(app.getPath('userData'), safeStorage);
  outputManager = new StreamOutputManager();
  outputManager.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('stream:output:status', status);
  });
  ipcMain.handle('stream:config:get', () => settingsStore.load());
  ipcMain.handle('stream:output:start', async () => {
    const [destination, config, runtime] = await Promise.all([
      settingsStore.getDestinationCredentials(),
      settingsStore.load(),
      getEncoderInfo()
    ]);
    return outputManager.start({
      runtime,
      output: config.output,
      outputUrl: buildRtmpUrl(destination.server, destination.streamKey)
    });
  });
  ipcMain.handle('stream:output:chunk', (_event, data) => outputManager.writeChunk(data));
  ipcMain.handle('stream:output:stop', () => outputManager.stop());
  ipcMain.handle('stream:encoder:info', async () => {
    const info = await getEncoderInfo();
    return {
      available: info.available,
      encoder: info.encoder ? info.encoder.label : null,
      supported: info.supported.map((item) => item.label),
      error: info.error
    };
  });
  ipcMain.handle('stream:config:save', (_event, config) => settingsStore.save(config));
  ipcMain.handle('stream:scenes:save', (_event, scenes, activeSceneId) => settingsStore.saveScenes(scenes, activeSceneId));
  ipcMain.handle('stream:devices:save', (_event, devices) => settingsStore.saveDevices(devices));
  ipcMain.handle('stream:image:choose', async () => {
    const selection = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    return selection.canceled ? null : selection.filePaths[0];
  });
  ipcMain.handle('stream:image:read', async (_event, imagePath) => {
    if (typeof imagePath !== 'string' || !/\.(png|jpe?g|webp|gif)$/i.test(imagePath)) throw new Error('Choose a supported image.');
    const stat = await fs.promises.stat(imagePath);
    if (stat.size > 12 * 1024 * 1024) throw new Error('Choose an image smaller than 12 MB.');
    const mime = /\.png$/i.test(imagePath) ? 'image/png' : /\.webp$/i.test(imagePath) ? 'image/webp' : /\.gif$/i.test(imagePath) ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${(await fs.promises.readFile(imagePath)).toString('base64')}`;
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  ipcMain.handle('worship:discover', () => {
    startDiscovery();
    return publicInstances();
  });
  ipcMain.handle('worship:refresh', () => {
    if (browser) browser.update();
    return publicInstances();
  });
  ipcMain.handle('worship:instances', () => publicInstances());
  ipcMain.handle('worship:styles:get', (_event, key) => requestWorshipStyles(key, 'GET'));
  ipcMain.handle('worship:styles:save', (_event, key, styles) => requestWorshipStyles(key, 'PUT', styles));
  createWindow();
  startDiscovery();
});

app.on('before-quit', (event) => {
  if (!quitAfterOutputStopped && outputManager && !['idle', 'stopped'].includes(outputManager.state)) {
    event.preventDefault();
    void outputManager.stop().finally(() => {
      quitAfterOutputStopped = true;
      app.quit();
    });
    return;
  }
  if (browser) browser.stop();
  if (bonjour) bonjour.destroy();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
