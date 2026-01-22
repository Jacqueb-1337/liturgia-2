// main.js

const { app, BrowserWindow, ipcMain, Menu, shell, screen, dialog } = require('electron');
const os = require('os');

// Main process in-memory log buffer
const mainLogs = [];
function _pushMainLog(level, args) {
  try {
    const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    mainLogs.push({ ts: new Date().toISOString(), level, msg });
  } catch (e) {}
}
const _origConsoleLog = console.log;
const _origConsoleWarn = console.warn;
const _origConsoleError = console.error;
console.log = function(...args) { _pushMainLog('log', args); _origConsoleLog.apply(console, args); };
console.warn = function(...args) { _pushMainLog('warn', args); _origConsoleWarn.apply(console, args); };
console.error = function(...args) { _pushMainLog('error', args); _origConsoleError.apply(console, args); };
const path = require('path');
const fs = require('fs');
const { BOOKS, CHAPTER_COUNTS, BIBLE_STORAGE_DIR } = require('./constants');

// Keytar IPC: store tokens securely in main process. Falls back to settings file if keytar not available.
let keytar = null;
try { keytar = require('keytar'); } catch (e) { console.warn('keytar not available in main process:', e.message || e); }
const KEYTAR_SERVICE = 'Liturgia';
const KEYTAR_ACCOUNT = 'auth-token';

ipcMain.handle('secure-get-token', async () => {
  try {
    if (keytar) return await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    // fallback: read from settings
    try { const txt = await fs.promises.readFile(settingsPath, 'utf8'); const settings = JSON.parse(txt); return settings.auth && settings.auth.token ? settings.auth.token : null; } catch { return null; }
  } catch (e) { console.error('secure-get-token error', e); return null; }
});

ipcMain.handle('secure-set-token', async (event, token) => {
  try {
    if (keytar) { await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, token); return true; }
    // fallback: write to settings.json
    let settings = {};
    try { const txt = await fs.promises.readFile(settingsPath, 'utf8'); settings = JSON.parse(txt); } catch {}
    settings.auth = settings.auth || {};
    settings.auth.token = token;
    await writeSettingsSafe(settings);
    return true;
  } catch (e) { console.error('secure-set-token error', e); return false; }
});

ipcMain.handle('secure-delete-token', async () => {
  try {
    if (keytar) { await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT); return true; }
    let settings = {};
    try { const txt = await fs.promises.readFile(settingsPath, 'utf8'); settings = JSON.parse(txt); } catch {}
    if (settings.auth) delete settings.auth.token;
    await writeSettingsSafe(settings);
    return true;
  } catch (e) { console.error('secure-delete-token error', e); return false; }
});

app.setName('liturgia');

let mainWindow; // Add this at the top
let defaultBible = 'en_kjv.json'; // Default Bible
let liveWindow = null;

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// Atomic settings write with backup. Writes to a tmp file then renames to avoid truncation and
// copies the previous non-empty file to settings.json.bak so we can recover if something goes wrong.
async function writeSettingsSafe(obj) {
  try {
    const s = JSON.stringify(obj, null, 2);
    if (typeof s !== 'string') throw new Error('Settings serialization failed');
    // Backup previous settings if it exists and has content
    try {
      const st = await fs.promises.stat(settingsPath);
      if (st && st.size > 0) {
        await fs.promises.copyFile(settingsPath, settingsPath + '.bak');
      }
    } catch (e) { /* ignore if file doesn't exist */ }

    const tmp = settingsPath + '.tmp';
    await fs.promises.writeFile(tmp, s, 'utf8');
    await fs.promises.rename(tmp, settingsPath);
    return true;
  } catch (e) {
    console.error('writeSettingsSafe error:', e);
    return false;
  }
}

// Load settings, and attempt to recover from backup if the file is present but empty
ipcMain.handle('load-settings', async () => {
  try {
    try {
      const st = await fs.promises.stat(settingsPath);
      if (st && st.size === 0) {
        const bak = settingsPath + '.bak';
        try {
          const bakSt = await fs.promises.stat(bak);
          if (bakSt && bakSt.size > 0) {
            console.warn('[load-settings] settings.json empty, restoring from backup');
            await fs.promises.copyFile(bak, settingsPath);
          }
        } catch (e) {
          // no backup, ignore
        }
      }
    } catch (e) {
      // file missing or other stat error, ignore
    }
    const data = await fs.promises.readFile(settingsPath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.warn('[load-settings] returning default {}; error:', e && e.message);
    return {};
  }
});

// Basic save, kept for backwards compatibility
ipcMain.handle('save-settings', async (event, settings) => {
  try {
    console.log('[save-settings] Writing settings keys:', Object.keys(settings));
  } catch (e) {}
  if (!settings || typeof settings !== 'object') {
    console.error('[save-settings] invalid settings payload, aborting write');
    return false;
  }
  await writeSettingsSafe(settings);
  return true;
});

// Safe partial update API to avoid race conditions where multiple renderers
// load-modify-save concurrently and overwrite each other. Use this instead of
// client-side load->modify->save when updating individual settings.
let _settingsUpdateQueue = Promise.resolve();

// Shared helper to apply a patch to settings (used by IPC handler and internal callers)
function applySettingsPatch(patch) {
  // Serialize updates through a promise queue to avoid races
  _settingsUpdateQueue = _settingsUpdateQueue.then(async () => {
    console.log('[update-settings] patch keys:', Object.keys(patch));
    let current = {};
    try {
      const txt = await fs.promises.readFile(settingsPath, 'utf8');
      current = JSON.parse(txt);
    } catch (e) {
      current = {};
    }
    // Apply patch: null => delete key, undefined => leave unchanged
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) {
        delete current[k];
      } else if (v === undefined) {
        // skip
      } else {
        current[k] = v;
      }
    }
    await writeSettingsSafe(current);
    return current;
  }).catch((e) => { console.error('applySettingsPatch error:', e); });
  return _settingsUpdateQueue;
}

ipcMain.handle('update-settings', async (event, patch) => {
  return applySettingsPatch(patch);
});

ipcMain.on('set-default-bible', (event, bible) => {
  defaultBible = bible;
  // Reply back to the sender
  event.reply('default-bible-changed', bible);
  // Also notify the main window so it can reload verses
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('default-bible-changed', bible);
  }

  // Persist chosen bible into settings.json
  (async () => {
    try {
      let settings = {};
      try {
        const txt = await fs.promises.readFile(settingsPath, 'utf8');
        settings = JSON.parse(txt);
      } catch (e) {
        settings = {};
      }
      settings.defaultBible = bible;
      await writeSettingsSafe(settings);
    } catch (err) {
      console.error('Failed to save default bible to settings:', err);
    }
  })();
});

ipcMain.handle('get-default-bible', () => defaultBible);

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays();
});

let _lastLicenseStatus = null;
ipcMain.on('license-status-update', (event, status) => {
  try {
    _lastLicenseStatus = status || null;
    if (liveWindow && liveWindow.webContents) liveWindow.webContents.send('license-status', status);
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('license-status', status);
  } catch (e) {
    console.error('license-status-update forward error', e);
  }
});

ipcMain.handle('get-current-license-status', () => {
  return _lastLicenseStatus;
});

// Allow other windows to request opening the setup modal in the main window
ipcMain.on('show-setup-modal', () => {
  try {
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('show-setup-modal');
  } catch (e) {
    console.error('show-setup-modal forward error', e);
  }
});

// IPC helper to write a combined diagnostic report
async function startSaveReport() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultName = `liturgia-report-${timestamp}.txt`;

  // Ask renderers (main window) to prepare their payload
  let rendererPayload = null;
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('prepare-renderer-report');
    // wait for renderer to reply (with a timeout)
    rendererPayload = await new Promise((resolve) => {
      const t = setTimeout(() => { resolve({ timedOut: true }); }, 8000);
      ipcMain.once('renderer-report', (event, payload) => {
        clearTimeout(t);
        resolve(payload);
      });
    });
  }

  // Capture live window snapshot if available
  let liveScreenshotBase64 = null;
  try {
    if (liveWindow && liveWindow.webContents && !liveWindow.isDestroyed()) {
      const image = await liveWindow.webContents.capturePage();
      const png = image.toPNG();
      liveScreenshotBase64 = 'data:image/png;base64,' + png.toString('base64');
    }
  } catch (e) {
    console.error('Failed to capture live window:', e);
  }

  // Read files and settings
  let indexHtml = '';
  let liveHtml = '';
  let settingsFile = '';
  try { indexHtml = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8'); } catch (e) {}
  try { liveHtml = await fs.promises.readFile(path.join(__dirname, 'live.html'), 'utf8'); } catch (e) {}
  try { settingsFile = await fs.promises.readFile(settingsPath, 'utf8'); } catch (e) {}

  // Collect system info
  const sysInfo = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    electron: process.versions.electron || null,
    cpu: os.cpus ? os.cpus()[0].model : null,
    memory: { total: os.totalmem(), free: os.freemem() }
  };

  // Join everything into a delimited report
  const parts = [];
  parts.push('=== REPORT: LITURGIA DIAGNOSTIC REPORT ===');
  parts.push(`Generated: ${new Date().toISOString()}`);
  parts.push('=== METADATA ===');
  parts.push(JSON.stringify(sysInfo, null, 2));

  parts.push('=== MAIN LOGS ===');
  parts.push(JSON.stringify(mainLogs, null, 2));

  parts.push('=== INDEX.HTML FILE ===');
  parts.push(indexHtml);

  parts.push('=== LIVE.HTML FILE ===');
  parts.push(liveHtml);

  parts.push('=== SETTINGS FILE (on disk) ===');
  parts.push(settingsFile);

  parts.push('=== RENDERER PAYLOAD ===');
  parts.push(JSON.stringify(rendererPayload || {}, null, 2));

  parts.push('=== LIVE WINDOW SCREENSHOT (base64 PNG) ===');
  parts.push(liveScreenshotBase64 || '');

  // If renderer included base64 images for preview canvas, include them too
  if (rendererPayload && rendererPayload.previewDataUrl) {
    parts.push('=== PREVIEW CANVAS (base64 PNG) ===');
    parts.push(rendererPayload.previewDataUrl);
  }

  parts.push('=== END OF REPORT ===');
  const reportContent = parts.join('\n\n');

  // Ask user where to save
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Save diagnostic report',
    defaultPath: path.join(app.getPath('desktop'), defaultName),
    filters: [{ name: 'Report', extensions: ['txt'] }]
  });

  if (canceled || !filePath) {
    return;
  }

  try {
    await fs.promises.writeFile(filePath, reportContent, 'utf8');
    if (mainWindow) mainWindow.webContents.send('show-status', `Report saved to ${filePath}`);
    console.log('[startSaveReport] Report written to', filePath);
  } catch (err) {
    console.error('[startSaveReport] Failed to write report:', err);
    if (mainWindow) mainWindow.webContents.send('show-status', 'Failed to save report: ' + err.message);
  }
}

// Helpers for persisting window state (bounds, maximized, fullscreen)
let _windowStateSaveTimer = null;
async function saveWindowState() {
  try {
    if (!mainWindow) return;
    const isMax = mainWindow.isMaximized();
    const isFull = mainWindow.isFullScreen();

    // If maximized/fullscreen, only persist state flags — do NOT overwrite normal bounds
    if (isMax || isFull) {
      const patch = { window: { maximized: !!isMax, fullscreen: !!isFull } };
      return applySettingsPatch(patch);
    }

    // Normal window: persist its current bounds so they can be restored after unmaximize/leave-fullscreen
    const bounds = mainWindow.getBounds();
    const patch = { window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized: false, fullscreen: false } };
    return applySettingsPatch(patch);
  } catch (e) {
    console.error('Failed to save window state:', e);
  }
}

function saveWindowStateDebounced() {
  if (_windowStateSaveTimer) clearTimeout(_windowStateSaveTimer);
  _windowStateSaveTimer = setTimeout(() => { saveWindowState(); _windowStateSaveTimer = null; }, 300);
}

function loadWindowState() {
  try {
    try {
      const st = fs.statSync(settingsPath);
      if (st && st.size === 0) {
        const bak = settingsPath + '.bak';
        try {
          const bakSt = fs.statSync(bak);
          if (bakSt && bakSt.size > 0) {
            console.warn('[loadWindowState] settings.json empty, restoring from backup');
            fs.copyFileSync(bak, settingsPath);
          }
        } catch (e) {
          // no backup
        }
      }
    } catch (e) {
      // settings file may not exist yet
    }

    const txt = fs.readFileSync(settingsPath, 'utf8');
    const s = JSON.parse(txt);
    return (s && s.window) ? s.window : {};
  } catch (e) {
    return {};
  }
}

function createWindow() {
  // Restore previous window bounds/state when available
  const winState = loadWindowState();
  const opts = {
    width: winState.width || 1000,
    height: winState.height || 700,
    x: typeof winState.x === 'number' ? winState.x : undefined,
    y: typeof winState.y === 'number' ? winState.y : undefined,
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false   // allow require() in renderer
    }
  };

  mainWindow = new BrowserWindow(opts);

  if (winState.maximized) mainWindow.maximize();
  if (winState.fullscreen) mainWindow.setFullScreen(true);

  mainWindow.loadFile('index.html');
  
  // Save window state on move/resize/maximize/unmaximize/fullscreen changes
  mainWindow.on('resize', saveWindowStateDebounced);
  mainWindow.on('move', saveWindowStateDebounced);
  mainWindow.on('maximize', () => { applySettingsPatch({ window: { maximized: true } }); });
  mainWindow.on('unmaximize', () => { applySettingsPatch({ window: { maximized: false } }); saveWindowStateDebounced(); });
  mainWindow.on('enter-full-screen', () => { applySettingsPatch({ window: { fullscreen: true } }); });
  mainWindow.on('leave-full-screen', () => { applySettingsPatch({ window: { fullscreen: false } }); saveWindowStateDebounced(); });
  mainWindow.on('close', saveWindowState);

  // Close live window when main window closes
  mainWindow.on('closed', () => {
    if (liveWindow) {
      liveWindow.close();
      liveWindow = null;
    }
    mainWindow = null;
  });

  // Define the menu template
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          click: () => {
            const settingsWin = new BrowserWindow({
              width: 600,
              height: 400,
              parent: mainWindow,
              modal: true,
              icon: path.join(__dirname, 'logo.png'),
              webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
              }
            });
            settingsWin.setMenuBarVisibility(false);
            settingsWin.loadFile('settings.html');
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forcereload' },
        { type: 'separator' },
        // Toggle fullscreen (explicit so we can control accelerator)
        {
          label: 'Toggle Full Screen',
          accelerator: process.platform === 'darwin' ? 'Ctrl+Command+F' : 'F11',
          click: () => {
            if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
          }
        },
        { type: 'separator' },
        { role: 'toggledevtools' }
      ]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Save report...',
          click: async () => {
            try {
              await startSaveReport();
            } catch (err) {
              console.error('Save report failed:', err);
              if (mainWindow) mainWindow.webContents.send('show-status', 'Save report failed: ' + err.message);
            }
          }
        },
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://electronjs.org')
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Listen for dark theme changes from settings window
ipcMain.on('set-dark-theme', (event, enabled) => {
  if (mainWindow) {
    mainWindow.webContents.send('set-dark-theme', enabled);
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Expose userData path to renderer
ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

async function loadAllVersesFromDiskMain(baseDir) {
  const allVerses = [];
  const readPromises = [];

  for (const book of BOOKS) {
    const chapCount = CHAPTER_COUNTS[book];
    for (let chap = 1; chap <= chapCount; chap++) {
      const file = path.join(baseDir, 'books', book, 'chapters', `${chap}.json`);
      // Push a promise for each file read
      readPromises.push(
        fs.promises.readFile(file, 'utf8')
          .then(txt => {
            JSON.parse(txt).data.forEach(v => {
              allVerses.push({
                key:  `${v.book} ${v.chapter}:${v.verse}`,
                text: v.text
              });
            });
          })
          .catch(() => { /* File missing, skip */ })
      );
    }
  }

  await Promise.all(readPromises);
  return allVerses;
}

ipcMain.handle('load-all-verses', async (event, baseDir) => {
  return await loadAllVersesFromDiskMain(baseDir);
});

ipcMain.handle('create-live-window', async () => {
  if (liveWindow) {
    liveWindow.show();
    liveWindow.focus();
    return;
  }
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let settings = {};
  try {
    const data = await fs.promises.readFile(settingsPath, 'utf8');
    settings = JSON.parse(data);
  } catch {}
  const displays = screen.getAllDisplays();
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  if (display) {
    liveWindow = new BrowserWindow({
      parent: null,
      title: 'Liturgia Live',
      icon: path.join(__dirname, 'logo.png'),
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      frame: false,
      show: false,
      skipTaskbar: false,
      alwaysOnTop: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    
    // Set a different app user model ID for Windows to force separate taskbar icon
    if (process.platform === 'win32') {
      liveWindow.setAppDetails({
        appId: 'com.liturgia.live'
      });
    }
    
    liveWindow.loadFile('live.html');
    liveWindow.once('ready-to-show', () => {
      liveWindow.show();
    });
    liveWindow.on('closed', () => {
      liveWindow = null;
    });
  }
});

ipcMain.handle('close-live-window', () => {
  if (liveWindow) {
    liveWindow.minimize();
  }
});

ipcMain.on('update-live-window', (event, data) => {
  if (liveWindow) {
    liveWindow.webContents.send('update-content', data);
  }
});

ipcMain.on('clear-live-text', () => {
  if (liveWindow) liveWindow.webContents.send('clear-live-text');
});

ipcMain.on('show-live-text', () => {
  if (liveWindow) liveWindow.webContents.send('show-live-text');
});

ipcMain.on('set-live-black', () => {
  if (liveWindow) liveWindow.webContents.send('set-live-black');
});

ipcMain.on('reset-live-canvas', () => {
  if (liveWindow) liveWindow.webContents.send('reset-live-canvas');
});

// Forward unified mode messages to live window
ipcMain.on('set-live-mode', (event, mode) => {
  if (liveWindow) liveWindow.webContents.send('set-live-mode', mode);
});
