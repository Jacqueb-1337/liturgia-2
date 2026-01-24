// main.js

const { app, BrowserWindow, ipcMain, Menu, shell, screen, dialog } = require('electron');

// Instrument dialog.showMessageBox during development to find stray native dialogs
if (process.env.NODE_ENV !== 'production') {
  try {
    const _origShow = dialog.showMessageBox;
    dialog.showMessageBox = async function(windowOrOptions, options) {
      // Normalize parameters
      const stack = new Error().stack;
      console.warn('dialog.showMessageBox called. Stack trace:\n', stack);
      // Forward call
      return await _origShow.apply(dialog, arguments);
    };
  } catch (e) { console.warn('Failed to instrument dialog.showMessageBox', e); }
}
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

// Helper to determine the best icon path for windows/taskbar (works in dev and packaged)
function getIconPath() {
  try {
    const devIco = path.join(__dirname, 'build', 'icon.ico');
    if (fs.existsSync(devIco)) return devIco;
    const { getIconPath } = require('./lib/paths');
    return getIconPath(app);
  } catch (e) { return path.join(__dirname, 'logo.png'); }
}
let SqlJsInit = null;
let SQL = null;
let pendingUpdate = null;
let lastUpdateCheck = null;
async function ensureSqlJs() {
  if (SQL) return SQL;
  if (SqlJsInit === null) {
    try { SqlJsInit = require('sql.js'); } catch (e) { console.warn('sql.js not available; EasyWorship import disabled. Run `npm install sql.js` to enable.', e); return null; }
  }
  try {
    // Provide a robust locateFile so sql.js can find the wasm in dev and packaged apps
    const locateFile = (file) => {
      // Dev path: node_modules inside project
      const devPath = path.join(__dirname, 'node_modules', 'sql.js', 'dist', file);
      if (fs.existsSync(devPath)) return devPath;

      // Packaged unpacked asar location (electron-builder unpacks specified files)
      const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', file);
      if (fs.existsSync(unpacked)) return unpacked;

      // If we placed the wasm explicitly via extraResources, it may appear at the root of resources
      const resRoot = path.join(process.resourcesPath, 'sql-wasm.wasm');
      if (fs.existsSync(resRoot)) return resRoot;

      // Alternative path inside resources
      const resAlt = path.join(process.resourcesPath, 'node_modules', 'sql.js', 'dist', file);
      if (fs.existsSync(resAlt)) return resAlt;

      // Fallback to the file name (let sql.js try relative fetch if supported)
      return file;
    };

    SQL = await SqlJsInit({ locateFile });
    return SQL;
  } catch (e) {
    console.warn('Failed to initialize sql.js', e);
    return null;
  }
}
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
let splashWindow = null;
let splashClosed = false;
let defaultBible = 'en_kjv.json'; // Default Bible
let liveWindow = null;


// --- EasyWorship Import Helpers ---
function stripRtf(rtf) {
  if (!rtf) return '';
  let s = rtf;
  s = s.replace(/\\par[d]?/gi, '\n');
  // Remove control words (e.g., \b0, \i, \fs24, etc.)
  s = s.replace(/\\[a-zA-Z]+-?\d*\b/g, '');
  // Remove groups/braces
  s = s.replace(/[{}]/g, '');
  // Remove stray backslashes
  s = s.replace(/\\/g, '');
  // Collapse multiple newlines
  s = s.replace(/\n\s*\n+/g, '\n\n');
  return s.trim();
}

function findDatabasesDirUnder(root, maxDepth = 4) {
  try {
    const toVisit = [{ dir: root, depth: 0 }];
    while (toVisit.length) {
      const { dir, depth } = toVisit.shift();
      if (depth > maxDepth) continue;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      // Quick check: if this directory contains Songs.db and SongWords.db
      const names = entries.map(e => e.name.toLowerCase());
      if (names.includes('songs.db') && names.includes('songwords.db')) return dir;
      // Also accept `Databases` folder
      if (names.includes('databases')) return path.join(dir, 'Databases');
      for (const e of entries) {
        if (e.isDirectory()) toVisit.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  } catch (e) { console.warn('findDatabasesDirUnder error', e); }
  return null;
}

async function importEasyWorshipFromDir(databasesDir) {
  // Returns array of { title, author, text }
  const SQL = await ensureSqlJs();
  if (!SQL) throw new Error('sql.js not available');

  const songsDbPath = path.join(databasesDir, 'Songs.db');
  const songWordsDbPath = path.join(databasesDir, 'SongWords.db');
  if (!fs.existsSync(songsDbPath) || !fs.existsSync(songWordsDbPath)) {
    return [];
  }

  // Load DB files into sql.js (WASM) in-memory DBs
  const songsBuf = fs.readFileSync(songsDbPath);
  const wordsBuf = fs.readFileSync(songWordsDbPath);
  const dbSongs = new SQL.Database(new Uint8Array(songsBuf));
  const dbWords = new SQL.Database(new Uint8Array(wordsBuf));

  // Run queries
  const songsRes = dbSongs.exec('SELECT rowid, title, author FROM song;');
  const out = [];

  if (songsRes && songsRes.length > 0 && songsRes[0].values) {
    const cols = songsRes[0].columns;
    for (const vals of songsRes[0].values) {
      const row = {};
      for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i];
      const id = row.rowid || row.row_id || row.id || vals[0];
      const title = row.title || 'Untitled';
      const author = row.author || 'Unknown';
      let lyrics = '';
      try {
        const q = dbWords.exec(`SELECT words FROM word WHERE song_id = ${id} LIMIT 1;`);
        if (q && q.length && q[0].values && q[0].values[0]) lyrics = q[0].values[0][0] || '';
      } catch (e) {
        console.warn('Failed to retrieve lyrics for', id, e.message || e);
      }
      out.push({ title, author, text: stripRtf(lyrics) });
    }
  }

  try { dbSongs.close(); } catch (e) {}
  try { dbWords.close(); } catch (e) {}

  return out;
}

async function importEasyWorshipHandler() {
  const SQL = await ensureSqlJs();
  if (!SQL) {
    await dialog.showMessageBox({ type: 'error', message: 'Dependency missing', detail: 'The package "sql.js" (WASM) is required to import EasyWorship databases. Please run "npm install" in the app directory and restart the app.', buttons: ['OK'] });
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('easyworship-import-disabled', { reason: 'sql-missing' });
    return;
  }

  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Auto Scan', 'Select Folder', 'Cancel'],
    defaultId: 0,
    title: 'Import EasyWorship database',
    message: 'Import EasyWorship songs',
    detail: 'Auto Scan will try commonly used locations. Select Folder lets you pick the EasyWorship installation or Databases folder.'
  });

  let databasesDir = null;
  if (choice.response === 0) { // Auto Scan
    const candidates = [
      path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents', 'Softouch', 'Easyworship'),
      path.join('C:\\ProgramData', 'Softouch', 'Easyworship'),
      path.join(os.homedir(), 'Documents', 'Easyworship')
    ];
    for (const c of candidates) {
      const found = findDatabasesDirUnder(c);
      if (found) { databasesDir = found; break; }
    }
    if (!databasesDir) {
      dialog.showMessageBox({ type: 'info', message: 'No EasyWorship databases found in common locations. Please select a folder manually.', buttons: ['OK'] });
      // fall through to select folder
    }
  }

  if (!databasesDir && choice.response !== 2) {
    const sel = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select EasyWorship installation or Databases folder' });
    if (sel.canceled || !sel.filePaths || sel.filePaths.length === 0) return;
    // If user selected some folder, try to locate DBs under it
    const candidate = sel.filePaths[0];
    const found = findDatabasesDirUnder(candidate);
    databasesDir = found || candidate;
  }

  if (!databasesDir) return;

  const songs = await importEasyWorshipFromDir(databasesDir);
  if (!songs || songs.length === 0) {
    await dialog.showMessageBox({ type: 'info', message: 'No songs found', detail: `No Songs.db/SongWords.db data found under ${databasesDir}`, buttons: ['OK'] });
    return;
  }

  // Merge into songs.json in userData
  const { getUserDataDir } = require('./lib/paths');
  const songsPath = path.join(getUserDataDir(app), 'songs.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(songsPath, 'utf8') || '[]'); } catch { existing = []; }

  let added = 0;
  for (const s of songs) {
    const exists = existing.some(e => (e.title || '').trim() === (s.title || '').trim() && (e.author || '').trim() === (s.author || '').trim());
    if (exists) continue;
    // Convert text into lyrics sections (split on blank lines)
    const paragraphs = s.text ? s.text.split(/\r?\n\s*\r?\n/) : [];
    const lyrics = paragraphs.length ? paragraphs.map(p => ({ section: '', text: (p || '').trim().replace(/\r?\n/g, '\n') })) : [{ section: '', text: (s.text || '').trim() }];
    existing.push({ title: s.title, author: s.author, lyrics });
    added++;
  }

  try { fs.writeFileSync(songsPath, JSON.stringify(existing, null, 2), 'utf8'); } catch (e) { console.error('Failed to write songs.json', e); dialog.showMessageBox({ type: 'error', message: 'Failed to save songs', detail: e.message || String(e), buttons: ['OK'] }); return; }

  mainWindow && mainWindow.webContents.send('songs-imported', { addedCount: added, totalFound: songs.length });

  dialog.showMessageBox({ type: 'info', message: 'Import complete', detail: `Found ${songs.length} song(s). Imported ${added} new song(s).`, buttons: ['OK'] });
}

// ---------------------------


const { getUserDataDir } = require('./lib/paths');
const settingsPath = path.join(getUserDataDir(app), 'settings.json');

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
    if (mainWindow) {
      // Ensure the main window is visible and focused before forwarding the request
      try { mainWindow.show(); mainWindow.focus(); } catch(e){}
      if (mainWindow.webContents) mainWindow.webContents.send('show-setup-modal');
    }
  } catch (e) {
    console.error('show-setup-modal forward error', e);
  }
});

ipcMain.handle('focus-main-window', async () => {
  try { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } return true; } catch (e) { return false; }
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
  const { resolveProjectPath } = require('./lib/paths');
  let indexHtml = '';
  let liveHtml = '';
  let settingsFile = '';
  try { indexHtml = await fs.promises.readFile(resolveProjectPath('index.html'), 'utf8'); } catch (e) {}
  try { liveHtml = await fs.promises.readFile(resolveProjectPath('live.html'), 'utf8'); } catch (e) {}
  try { settingsFile = await fs.promises.readFile(settingsPath, 'utf8'); } catch (e) {}

  // Collect system info
  const packageJson = (() => { try { return require('./package.json'); } catch (e) { return {}; } })();
  const sysInfo = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
    cpuModel: os.cpus ? (os.cpus()[0] ? os.cpus()[0].model : null) : null,
    cpuCores: os.cpus ? os.cpus().length : null,
    memory: { total: os.totalmem(), free: os.freemem() },
    appVersion: packageJson.version || null
  };

  // Join everything into a delimited report
  const parts = [];
  parts.push('=== REPORT: LITURGIA DIAGNOSTIC REPORT ===');
  // Add generated timestamp into metadata
  sysInfo['Report Generated'] = new Date().toISOString();
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

  // Include global styles so the viewer can render index/live HTML accurately
  let globalCss = '';
  try { globalCss = await fs.promises.readFile(path.join(__dirname, 'style.css'), 'utf8'); } catch (e) { globalCss = ''; }
  if (globalCss) {
    parts.push('=== GLOBAL CSS (styles.css) ===');
    parts.push(globalCss);
  }

  // Include renderer in-memory payload as a named section for the viewer
  parts.push('=== RENDERER SETTINGS (in-memory) ===');
  parts.push(JSON.stringify(rendererPayload || {}, null, 2));

  parts.push('=== END OF REPORT ===');
  const reportContent = parts.join('\n\n');

  // Ask user where to save
  const { getDesktopPath } = require('./lib/paths');
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Save diagnostic report',
    defaultPath: path.join(getDesktopPath(app), defaultName),
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

async function createWindow() {
  // Restore previous window bounds/state when available
  const winState = loadWindowState();
  const opts = {
    width: winState.width || 1000,
    height: winState.height || 700,
    x: typeof winState.x === 'number' ? winState.x : undefined,
    y: typeof winState.y === 'number' ? winState.y : undefined,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false   // keep legacy behavior (renderer scripts rely on require/module)
    }
  };

  // Create the main window instance
  mainWindow = new BrowserWindow(opts);

  // Ensure fresh installs default to dark theme so UI is initialized in dark mode
  try {
    let settings = {};
    try { settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')); } catch (e) { settings = {}; }
    if (typeof settings.darkTheme !== 'boolean') { settings.darkTheme = true; try { await writeSettingsSafe(settings); } catch (e) { console.warn('Failed to persist default darkTheme in createWindow', e); } }
  } catch (e) { console.warn('Default dark theme check failed', e); }

  if (winState.maximized) mainWindow.maximize();
  if (winState.fullscreen) mainWindow.setFullScreen(true);

  mainWindow.loadFile('index.html');
  
  // Create a splash overlay that covers the main window until the splash animation finishes
  try {
    const b = mainWindow.getBounds();
    splashWindow = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: false,
      backgroundColor: '#141923',
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      parent: mainWindow,
      modal: false,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    splashWindow.setMenuBarVisibility(false);
    splashWindow.loadFile('splash.html').catch(()=>{});
    splashWindow.once('ready-to-show', () => { try { splashWindow.show(); } catch(e){} });

    // Keep splash window bounds in sync while present
    const syncSplashBounds = () => { try { if (splashWindow && mainWindow) splashWindow.setBounds(mainWindow.getBounds()); } catch(e){} };
    mainWindow.on('move', syncSplashBounds);
    mainWindow.on('resize', syncSplashBounds);

    // Remove splash when renderer signals done
    const splashCloser = () => {
      try { if (splashWindow) { splashWindow.destroy(); splashWindow = null; } } catch(e){}
      try { mainWindow.focus(); } catch(e){}
    };

    // Listen for splash finished message
    const { ipcMain } = require('electron');
    ipcMain.once('splash-finished', () => { splashClosed = true; splashCloser(); try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('splash-closed'); } catch(e){} });

    // IPC to let renderer query splash state if it missed the event
    ipcMain.handle('is-splash-closed', () => splashClosed);

    // Fallback close in case IPC doesn't arrive
    setTimeout(() => { if (splashWindow) { splashClosed = true; splashCloser(); } }, 8000);
  } catch (e) { console.warn('Failed to create splash window', e); }

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
              icon: getIconPath(),
              webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
              }
            });
            settingsWin.setMenuBarVisibility(false);
            settingsWin.loadFile('settings.html');
          }
        },
        {
          label: 'Import EasyWorship database...',
          click: async () => { await importEasyWorshipHandler(); }
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

// On Windows set AppUserModelID so taskbar and notifications use the app icon
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.jacqueb.liturgia'); } catch (e) { console.warn('Failed to set AppUserModelId', e); }
}

app.whenReady().then(async () => {
  await createWindow();
  // After window creation, load settings and, if enabled, check for updates on startup
  try {
    let settings = {};
    try { settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')); } catch {}
    // Back-compat and registry fallback on Windows
    if (typeof settings.autoCheckUpdates !== 'boolean' && process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const out = execSync('reg query "HKCU\\Software\\Liturgia" /v AutoCheckForUpdates', { stdio: ['pipe','pipe','ignore'] }).toString();
        const m = out.match(/AutoCheckForUpdates\s+REG_\w+\s+(\d+)/i);
        if (m) settings.autoCheckUpdates = (m[1] === '1');
      } catch (e) { /* ignore */ }
    }
    // Default to true if not present
    if (typeof settings.autoCheckUpdates !== 'boolean') settings.autoCheckUpdates = true;

    // Default dark theme for fresh installs
    if (typeof settings.darkTheme !== 'boolean') {
      settings.darkTheme = true;
      try { await writeSettingsSafe(settings); } catch (e) { console.warn('Failed to persist default darkTheme:', e); }
    }

    if (settings.autoCheckUpdates) {
      const res = await checkForUpdates();
      if (res && res.updateAvailable && mainWindow) {
        // Send update info to renderer. If the renderer isn't ready yet (still loading), store
        // the update info and deliver it when the window finishes loading so the user sees the
        // in-app modal on startup reliably.
        if (mainWindow.webContents && mainWindow.webContents.isLoading && mainWindow.webContents.isLoading()) {
          pendingUpdate = res;
          // Ensure we send it once the renderer finishes loading
          mainWindow.webContents.once('did-finish-load', () => {
            try { if (pendingUpdate && mainWindow && mainWindow.webContents) { mainWindow.webContents.send('update-available', pendingUpdate); pendingUpdate = null; } } catch(e) {}
          });
        } else {
          try { mainWindow.webContents.send('update-available', res); } catch(e) {}
        }

      }
    }
  } catch (e) { console.warn('Startup update check failed', e); }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Expose userData path to renderer
ipcMain.handle('get-user-data-path', () => {
  const { getUserDataDir } = require('./lib/paths');
  return getUserDataDir(app);
});

// Semantic version compare: returns 1 if a>b, -1 if a<b, 0 if equal
function semverCompare(a, b) {
  if (!a || !b) return 0;
  const pa = a.replace(/^v/i,'').split(/[-+]/)[0].split('.').map(x => parseInt(x,10)||0);
  const pb = b.replace(/^v/i,'').split(/[-+]/)[0].split('.').map(x => parseInt(x,10)||0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Check for updates against GitHub releases
async function checkForUpdates() {
  try {
    // Prefer global fetch (Node 18+). Fall back to node-fetch when available.
    let fetchFn = (typeof fetch === 'function') ? fetch : null;
    if (!fetchFn) {
      try { fetchFn = require('node-fetch'); } catch (e) {
        console.warn('checkForUpdates disabled: fetch not available', e);
        return { ok:false, error: 'fetch not available' };
      }
    }
    const api = 'https://api.github.com/repos/Jacqueb-1337/liturgia-2/releases/latest';
    const r = await fetchFn(api, { headers: { 'User-Agent': 'Liturgia-Updater' } });
    if (!r.ok) return { ok:false, error: `GitHub API returned ${r.status}` };
    const j = await r.json();
    const latest = (j.tag_name || j.name || '').toString();
    const current = app.getVersion();
    const cmp = semverCompare(latest, current);
    const updateAvailable = (cmp === 1);
    const assets = (j.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }));
    const result = { ok:true, updateAvailable, latest, current, html_url: j.html_url, body: j.body, assets };
    // Also cache the last check result (useful if renderer requests it later before another check)
    lastUpdateCheck = result;
    return result;
  } catch (e) { console.warn('checkForUpdates error', e); return { ok:false, error: String(e) }; }
}

// Expose manual check via IPC
ipcMain.handle('check-for-updates-manual', async () => {
  return await checkForUpdates();
});

// Renderer can ask for any pending update that was found before it was ready
ipcMain.handle('get-pending-update', async () => {
  return pendingUpdate || lastUpdateCheck || { ok:false };
});

// In-memory map of active downloads
const downloads = {};

// Download an update asset (renderer requests with a browser_download_url)
ipcMain.handle('download-update', async (event, { url }) => {
  try {
    const fetch = require('node-fetch');
    const { getTempPath } = require('./lib/paths');
    const tmpDir = getTempPath(app);
    const name = path.basename((url || '').split('?')[0]) || `liturgia-update-${Date.now()}.exe`;
    const dest = path.join(tmpDir, name);
    const r = await fetch(url);
    if (!r.ok) return { ok:false, error: `Download failed ${r.status}` };
    const total = parseInt(r.headers.get('content-length') || '0', 10);
    const destStream = fs.createWriteStream(dest);
    let downloaded = 0;

    downloads[dest] = { res: r };

    return await new Promise((resolve, reject) => {
      r.body.on('data', (chunk) => {
        downloaded += chunk.length;
        destStream.write(chunk);
        const percent = total ? Math.round(downloaded / total * 100) : null;
        try { event.sender.send('update-download-progress', { file: dest, downloaded, total, percent }); } catch (e) {}
      });
      r.body.on('end', () => {
        destStream.end();
        try { event.sender.send('update-download-complete', { file: dest }); } catch (e) {}
        delete downloads[dest];
        resolve({ ok:true, file: dest });
      });
      r.body.on('error', (err) => {
        try { destStream.close(); fs.unlinkSync(dest); } catch (e) {}
        delete downloads[dest];
        reject({ ok:false, error: String(err) });
      });
    });
  } catch (e) { return { ok:false, error: String(e) }; }
});

// Cancel an ongoing download and remove partial file
ipcMain.handle('cancel-update-download', async (event, { file }) => {
  try {
    if (downloads[file] && downloads[file].res && downloads[file].res.body) {
      try { downloads[file].res.body.destroy(); } catch (e) {}
    }
    try { fs.unlinkSync(file); } catch (e) {}
    delete downloads[file];
    return { ok:true };
  } catch (e) { return { ok:false, error: String(e) }; }
});

// Run the downloaded installer (open file with default handler)
ipcMain.handle('run-installer', async (event, file) => {
  try {
    if (!fs.existsSync(file)) return { ok:false, error:'File not found' };
    await shell.openPath(file);
    return { ok:true };
  } catch (e) { return { ok:false, error: String(e) }; }
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
  const settingsPath = path.join(getUserDataDir(app), 'settings.json');
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
      icon: getIconPath(),
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
