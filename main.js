// main.js

// Force production mode when running via npm start (not packaged)
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';

const { app, BrowserWindow, ipcMain, Menu, shell, screen, dialog, session } = require('electron');
const RtfParser = require('rtf-parser');

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
let _notifyError = null;     // Assigned after renderer is ready; fires debounced error-report-prompt IPC
let _errorNotifyTimer = null;
let _errorPromptShown = false;
let _errorBaseline = 0;      // Error count at arm-time; only errors above this trigger the prompt
console.log = function(...args) { _pushMainLog('log', args); _origConsoleLog.apply(console, args); };
console.warn = function(...args) { _pushMainLog('warn', args); _origConsoleWarn.apply(console, args); };
console.error = function(...args) { _pushMainLog('error', args); _origConsoleError.apply(console, args); try { if (_notifyError) _notifyError(); } catch(e) {} };
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const RemoteServer = require('./remote-server');
const RelayClient = require('./relay-ws-client');
const createSpeechSidecarManager = require('./speech/speechSidecarManager');

// --- Emergency crash report writer ---
// Writes a minimal diagnostic report to Documents synchronously.
// Safe to call before app is ready (falls back to os.homedir/Documents).
function _writeEmergencyCrashReport(source, err) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let docsDir;
    try { docsDir = app.getPath('documents'); } catch (e) {
      docsDir = path.join(os.homedir(), 'Documents');
    }
    const reportPath = path.join(docsDir, `liturgia-crash-${timestamp}.txt`);
    const parts = [];
    parts.push('=== REPORT: LITURGIA DIAGNOSTIC REPORT ===');
    parts.push('=== METADATA ===');
    parts.push(JSON.stringify({
      platform: process.platform, arch: process.arch, node: process.version,
      reportType: 'CRASH', source, 'Report Generated': new Date().toISOString()
    }, null, 2));
    parts.push('=== CRASH ERROR ===');
    parts.push(err ? (err.stack || String(err)) : 'Unknown error');
    parts.push('=== MAIN LOGS ===');
    parts.push(JSON.stringify(mainLogs, null, 2));
    parts.push('=== END OF REPORT ===');
    fs.writeFileSync(reportPath, parts.join('\n\n'), 'utf8');
    return reportPath;
  } catch (e) {
    try {
      const fallback = path.join(os.homedir(), `liturgia-crash-${Date.now()}.txt`);
      fs.writeFileSync(fallback, (err ? (err.stack || String(err)) : 'Unknown') + '\n\n---\n\n' + JSON.stringify(mainLogs), 'utf8');
      return fallback;
    } catch (e2) { return null; }
  }
}

// Shared fatal error handler for both uncaughtException and unhandledRejection.
// Always writes the crash report, shows a notification (whenever possible), and exits.
function _handleFatalError(source, err) {
  _origConsoleError(`[CRASH] ${source}:`, err && err.stack ? err.stack : String(err));
  const reportPath = _writeEmergencyCrashReport(source, err);

  const showAndExit = () => {
    try {
      // dialog.showMessageBoxSync works without a parent BrowserWindow
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'Liturgia • Worship crashed',
        message: 'Liturgia • Worship encountered an unexpected error and needs to close.',
        detail: `A crash report has been saved to:\n${reportPath || 'unknown location'}\n\nError: ${err && err.message ? err.message : String(err)}`,
        buttons: ['OK']
      });
    } catch (e) {}
    process.exit(1);
  };

  if (app.isReady()) {
    showAndExit();
  } else {
    // App not ready yet: wait for ready, then show dialog and exit.
    // Safety net ensures we always exit even if ready never fires.
    const exitTimer = setTimeout(() => process.exit(1), 6000);
    app.once('ready', () => { clearTimeout(exitTimer); showAndExit(); });
  }
}

process.on('uncaughtException', (err) => {
  _handleFatalError('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  _handleFatalError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

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
let remoteServer = null;
let relayClient = null;
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
const { getUserDataDir } = require('./lib/paths');

// Keytar IPC: store tokens securely in main process. Falls back to settings file if keytar not available.
let keytar = null;
try { keytar = require('keytar'); } catch (e) { console.warn('keytar not available in main process:', e.message || e); }
const KEYTAR_SERVICE = 'Liturgia';
const KEYTAR_ACCOUNT = 'auth-token';

ipcMain.handle('secure-get-token', async () => {
  try {
    if (keytar) return await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
    // fallback: read from settings
    const settingsFilePath = path.join(getUserDataDir(app), 'settings.json');
    try { const txt = await fs.promises.readFile(settingsFilePath, 'utf8'); const settings = JSON.parse(txt); if (settings.auth && settings.auth.token) return settings.auth.token; } catch { }
    return null; // Return null instead of test token - this isn't a relay testing scenario
  } catch (e) { console.error('secure-get-token error', e); return null; }
});

ipcMain.handle('secure-set-token', async (event, token) => {
  try {
    if (keytar) { await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, token); return true; }
    // fallback: write to settings.json
    const settingsFilePath = path.join(getUserDataDir(app), 'settings.json');
    let settings = {};
    try { const txt = await fs.promises.readFile(settingsFilePath, 'utf8'); settings = JSON.parse(txt); } catch {}
    settings.auth = settings.auth || {};
    settings.auth.token = token;
    // Write settings file safely
    try { await fs.promises.writeFile(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8'); } catch (e) { console.error('Failed to write token to settings', e); return false; }
    return true;
  } catch (e) { console.error('secure-set-token error', e); return false; }
});

ipcMain.handle('secure-delete-token', async () => {
  try {
    if (keytar) { await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT); return true; }
    const settingsFilePath = path.join(getUserDataDir(app), 'settings.json');
    let settings = {};
    try { const txt = await fs.promises.readFile(settingsFilePath, 'utf8'); settings = JSON.parse(txt); } catch {}
    if (settings.auth) delete settings.auth.token;
    // Write settings file safely
    try { await fs.promises.writeFile(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8'); } catch (e) { console.error('Failed to delete token from settings', e); return false; }
    return true;
  } catch (e) { console.error('secure-delete-token error', e); return false; }
});

app.setName('liturgia');

let mainWindow; // Add this at the top
let splashWindow = null;
let splashClosed = false;
let splashShownTime = 0;
let lastStatusUpdateTime = 0; // Track when status last changed
let settingsWindow = null; // Reference to settings window for IPC communication
let styleWindow = null;    // Reference to text-styling window
let mainWindowReady = false;
let mainWindowLoaded = false;
let pendingMaximize = false;
let pendingFullscreen = false;
let rendererReady = false; // Set when renderer finishes DOMContentLoaded initialization
let aiWorkerWindowReady = false;
let pendingScheduleFile = null; // Path to a .litsch file passed at launch before the window is ready
let pendingSongFile = null;     // Path to a .litsong file passed at launch before the window is ready
let pendingReportFile = null;   // Path to a .litrep file passed at launch before the window is ready
let sidecarInitialized = false;
let initialWindowX = 100;
let initialWindowY = 100;
let defaultBible = 'en_kjv.json'; // Default Bible
const liveWindows = new Map(); // keyed by display id
// Per-display network display servers
// Map<displayId, {server, clients:Set, port, lastPayload, lastMode, lastError}>
const displayNetServers = new Map();

// Merge per-display style overrides into a payload's styles object.
// override is { text, number, title, reference, subscript, global } — any field may be null/undefined.
function mergeStylesForDisplay(data, override) {
  if (!override || !data.styles) return data;
  const merged = { ...data.styles };
  for (const key of ['text', 'number', 'title', 'reference', 'subscript']) {
    if (override[key] != null) merged[key] = override[key];
  }
  if (override.global != null) merged.global = { ...data.styles.global, ...override.global };
  return { ...data, styles: merged };
}
let speechWindow = null;
let aiSpeechWorkerWindow = null;
let aiWorkerSuppressed = false;
const launchSpeechUi = process.argv.includes('--speech-ui');
let speechSidecarManager = null;
let speechSidecarWatchdog = null;
let latestSidecarStatus = null;
let latestAiSuggestions = null;
let currentDynamicBibleBooks = null;
let cachedAiSettings = { modelSize: 'small' };


// --- EasyWorship Import Helpers ---
// RTF Parser data structures
const destinations = new Set([
  'aftncn', 'aftnsep', 'aftnsepc', 'annotation', 'atnauthor', 'atndate', 'atnicn', 'atnid',
  'atnparent', 'atnref', 'atntime', 'atrfend', 'atrfstart', 'author', 'background', 'bkmkend',
  'bkmkstart', 'blipuid', 'buptim', 'category', 'colorschememapping', 'colortbl', 'comment',
  'company', 'creatim', 'datafield', 'datastore', 'defchp', 'defpap', 'do', 'doccomm', 'docvar',
  'dptxbxtext', 'ebcend', 'ebcstart', 'factoidname', 'falt', 'fchars', 'ffdeftext', 'ffentrymcr',
  'ffexitmcr', 'ffformat', 'ffhelptext', 'ffl', 'ffname', 'ffstattext', 'field', 'file', 'filetbl',
  'fldinst', 'fldrslt', 'fldtype', 'fname', 'fontemb', 'fontfile', 'fonttbl', 'footer', 'footerf',
  'footerl', 'footerr', 'footnote', 'formfield', 'ftncn', 'ftnsep', 'ftnsepc', 'g', 'generator',
  'gridtbl', 'header', 'headerf', 'headerl', 'headerr', 'hl', 'hlfr', 'hlinkbase', 'hlloc', 'hlsrc',
  'hsv', 'htmltag', 'info', 'keycode', 'keywords', 'latentstyles', 'lchars', 'levelnumbers',
  'leveltext', 'lfolevel', 'linkval', 'list', 'listlevel', 'listname', 'listoverride',
  'listoverridetable', 'listpicture', 'liststylename', 'listtable', 'listtext', 'lsdlockedexcept',
  'macc', 'maccPr', 'mailmerge', 'maln', 'malnScr', 'manager', 'margPr', 'mbar', 'mbarPr',
  'mbaseJc', 'mbegChr', 'mborderBox', 'mborderBoxPr', 'mbox', 'mboxPr', 'mchr', 'mcount', 'mctrlPr',
  'md', 'mdeg', 'mdegHide', 'mden', 'mdiff', 'mdPr', 'me', 'mendChr', 'meqArr', 'meqArrPr', 'mf',
  'mfName', 'mfPr', 'mfunc', 'mfuncPr', 'mgroupChr', 'mgroupChrPr', 'mgrow', 'mhideBot', 'mhideLeft',
  'mhideRight', 'mhideTop', 'mhtmltag', 'mlim', 'mlimloc', 'mlimlow', 'mlimlowPr', 'mlimupp',
  'mlimuppPr', 'mm', 'mmaddfieldname', 'mmath', 'mmathPict', 'mmathPr', 'mmaxdist', 'mmc', 'mmcJc',
  'mmconnectstr', 'mmconnectstrdata', 'mmcPr', 'mmcs', 'mmdatasource', 'mmheadersource', 'mmmailsubject',
  'mmodso', 'mmodsofilter', 'mmodsofldmpdata', 'mmodsomappedname', 'mmodsoname', 'mmodsorecipdata',
  'mmodsosort', 'mmodsosrc', 'mmodsotable', 'mmodsoudl', 'mmodsoudldata', 'mmodsouniquetag', 'mmPr',
  'mmquery', 'mmr', 'mnary', 'mnaryPr', 'mnoBreak', 'mnum', 'mobjDist', 'moMath', 'moMathPara',
  'moMathParaPr', 'mopEmu', 'mphant', 'mphantPr', 'mplcHide', 'mpos', 'mr', 'mrad', 'mradPr', 'mrPr',
  'msepChr', 'mshow', 'mshp', 'msPre', 'msPrePr', 'msSub', 'msSubPr', 'msSubSup', 'msSubSupPr', 'msSup',
  'msSupPr', 'mstrikeBLTR', 'mstrikeH', 'mstrikeTLBR', 'mstrikeV', 'msub', 'msubHide', 'msup', 'msupHide',
  'mtransp', 'mtype', 'mvertJc', 'mvfmf', 'mvfml', 'mvtof', 'mvtol', 'mzeroAsc', 'mzeroDesc', 'mzeroWid',
  'nesttableprops', 'nextfile', 'nonesttables', 'objalias', 'objclass', 'objdata', 'object', 'objname',
  'objsect', 'objtime', 'oldcprops', 'oldpprops', 'oldsprops', 'oldtprops', 'oleclsid', 'operator',
  'panose', 'password', 'passwordhash', 'pgp', 'pgptbl', 'picprop', 'pict', 'pn', 'pnseclvl', 'pntext',
  'pntxta', 'pntxtb', 'printim', 'private', 'propname', 'protend', 'protstart', 'protusertbl', 'pxe',
  'result', 'revtbl', 'revtim', 'rsidtbl', 'rxe', 'shp', 'shpgrp', 'shpinst', 'shppict', 'shprslt',
  'shptxt', 'sn', 'sp', 'staticval', 'stylesheet', 'subject', 'sv', 'svb', 'tc', 'template', 'themedata',
  'title', 'txe', 'ud', 'upr', 'userprops', 'wgrffmtfilter', 'windowcaption', 'writereservation',
  'writereservhash', 'xe', 'xform', 'xmlattrname', 'xmlattrvalue', 'xmlclose', 'xmlname', 'xmlnstbl',
  'xmlopen'
]);

const specialCharacters = {
  'par': '\n',
  'sect': '\n\n',
  'page': '\n\n',
  'line': '\n',
  'tab': '\t',
  'emdash': '\u2014',
  'endash': '\u2013',
  'emspace': '\u2003',
  'enspace': '\u2002',
  'qmspace': '\u2005',
  'bullet': '\u2022',
  'lquote': '\u2018',
  'rquote': '\u2019',
  'ldblquote': '\u201C',
  'rdblquote': '\u201D',
};

function normalizeVerseSpacing(text) {
  // Normalize all line endings to \n first (RTF source often yields \r\n)
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Collapse runs of blank lines within verse blocks down to a single blank line
  // (used as verse separator). Blank lines between section tags are intentional.
  text = text.replace(/\n{3,}/g, '\n\n');
  // Add double newline before verse/section tags (except the first one)
  // Match patterns like [Verse 1], [Chorus], etc.
  let lines = text.split('\n');
  let result = [];
  let firstTagFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isTag = line.startsWith('[') && line.endsWith(']');

    if (isTag) {
      if (firstTagFound) {
        // Add blank line before tag if not already there
        if (result.length > 0 && result[result.length - 1] !== '') {
          result.push('');
        }
      }
      firstTagFound = true;
    }

    result.push(lines[i]);
  }

  return result.join('\n');
}

function stripRtf(rtf) {
  if (!rtf) return '';
  
  let s = Buffer.isBuffer(rtf) || rtf instanceof Uint8Array
    ? rtf.toString('utf8')
    : String(rtf);

  let output = '';
  let stack = [];
  let ignorable = false;
  let ucskip = 1;
  let curskip = 0;
  let i = 0;

  while (i < s.length) {
    const c = s[i];

    if (c === '\\') {
      const next = s[i + 1];
      
      if (next === '\'') {
        // Hex: \'xx
        if (curskip > 0) {
          curskip--;
        } else if (!ignorable) {
          const hex = s.substr(i + 2, 2);
          output += String.fromCharCode(parseInt(hex, 16));
        }
        i += 4;
        continue;
      }
      
      if (next === '~') {
        // Non-breaking space
        if (curskip > 0) {
          curskip--;
        } else if (!ignorable) {
          output += '\xA0';
        }
        i += 2;
        continue;
      }
      
      if ('{}\\'.includes(next)) {
        // Escaped character
        curskip = 0;
        if (!ignorable) {
          output += next;
        }
        i += 2;
        continue;
      }
      
      if (/[a-z]/i.test(next)) {
        // Control word: \word or \word123
        let word = '';
        let j = i + 1;
        while (j < s.length && /[a-z]/i.test(s[j])) {
          word += s[j];
          j++;
        }
        
        // Get optional number
        let num = '';
        let hasNum = false;
        if (j < s.length && (s[j] === '-' || /\d/.test(s[j]))) {
          if (s[j] === '-') {
            num = '-';
            j++;
          }
          while (j < s.length && /\d/.test(s[j])) {
            num += s[j];
            j++;
          }
          hasNum = true;
        }
        
        // Skip space after control word
        if (j < s.length && s[j] === ' ') {
          j++;
        }
        
        curskip = 0;
        word_lower = word.toLowerCase();
        
        if (destinations.has(word_lower)) {
          ignorable = true;
        } else if (!ignorable) {
          if (specialCharacters[word_lower]) {
            output += specialCharacters[word_lower];
          } else if (word_lower === 'uc') {
            ucskip = parseInt(num) || 1;
          } else if (word_lower === 'u') {
            let code = parseInt(num) || 0;
            if (code < 0) code += 0x10000;
            output += String.fromCharCode(code);
            curskip = ucskip;
          }
        }
        
        i = j;
        continue;
      }
      
      i++;
      continue;
    }
    
    if (c === '{') {
      curskip = 0;
      stack.push({ ucskip, ignorable });
      i++;
      continue;
    }
    
    if (c === '}') {
      curskip = 0;
      if (stack.length > 0) {
        const entry = stack.pop();
        ucskip = entry.ucskip;
        ignorable = entry.ignorable;
      }
      i++;
      continue;
    }
    
    if (c === '*') {
      ignorable = true;
      i++;
      continue;
    }
    
    // Regular character
    if (curskip > 0) {
      curskip--;
    } else if (!ignorable) {
      output += c;
    }
    
    i++;
  }

  return output.trim();
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
      if (names.includes('databases')) {
        const dbDir = path.join(dir, 'Databases');
        // Check both Databases/ and Databases/Data/
        const dataDir = path.join(dbDir, 'Data');
        if (fs.existsSync(path.join(dataDir, 'Songs.db'))) return dataDir;
        if (fs.existsSync(path.join(dbDir, 'Songs.db'))) return dbDir;
        return dbDir;
      }
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
      out.push({ title, author, text: normalizeVerseSpacing(stripRtf(lyrics)) });
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
    
    // Parse lyrics into sections, detecting section headers like "Verse 1", "Chorus", etc.
    const lyrics = [];
    if (s.text) {
      const lines = s.text.split(/\r?\n/);
      let currentSection = '';
      let currentText = [];
      let hasDetectedSections = false;
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // Skip blank lines during section detection
        
        // Check if line is a section header (Verse 1, Chorus, Bridge, etc.) - with or without brackets
        const sectionMatch = trimmed.match(/^\[?(Verse|Chorus|Bridge|Intro|Outro|Pre-?Chorus|Tag|Refrain|Ending)\s*(\d*)\]?$/i);
        if (sectionMatch) {
          hasDetectedSections = true;
          // Save previous section if exists
          if (currentText.length > 0) {
            lyrics.push({ section: currentSection, text: currentText.join('\n') });
            currentText = [];
          }
          currentSection = trimmed;
        } else {
          // Regular lyrics line
          currentText.push(trimmed);
        }
      }
      
      // Save final section
      if (currentText.length > 0) {
        lyrics.push({ section: currentSection, text: currentText.join('\n') });
      }
      
      // If no sections were detected, try to auto-generate by splitting on blank lines
      if (!hasDetectedSections && lyrics.length === 1 && lyrics[0].section === '') {
        const text = (s.text || '').trim();
        const verses = text.split(/\n\n+/); // Split on one or more blank lines
        if (verses.length > 1) {
          // Multiple blank-line-separated blocks: auto-generate section headers
          lyrics.length = 0; // Clear the single un-sectioned block
          verses.forEach((verseText, idx) => {
            if (verseText.trim()) {
              lyrics.push({ section: `Verse ${idx + 1}`, text: verseText.trim() });
            }
          });
        }
      }
    }
    
    existing.push({ title: s.title, author: s.author, lyrics });
    added++;
  }

  try { fs.writeFileSync(songsPath, JSON.stringify(existing, null, 2), 'utf8'); } catch (e) { console.error('Failed to write songs.json', e); dialog.showMessageBox({ type: 'error', message: 'Failed to save songs', detail: e.message || String(e), buttons: ['OK'] }); return; }

  mainWindow && mainWindow.webContents.send('songs-imported', { addedCount: added, totalFound: songs.length });
}

// --- VideoPsalm Import ---
function parseVideoPsalmJson(raw) {
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  // VP JSON may contain literal (unescaped) newlines inside string values,
  // and sometimes unquoted object keys. Fix both before handing to JSON.parse.
  const result = [];
  let inString = false;
  let escaped  = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) { result.push(c); escaped = false; continue; }
    if (c === '\\') { result.push(c); escaped = true; continue; }
    if (c === '"') { inString = !inString; result.push(c); continue; }
    if (inString && (c === '\r' || c === '\n')) {
      if (c === '\r' && raw[i + 1] === '\n') i++;
      result.push('\\n');
      continue;
    }
    result.push(c);
  }
  let s = result.join('');
  // Fix unquoted keys: { SomeKey: -> { "SomeKey":
  s = s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  return JSON.parse(s);
}

async function importVideoPsalmFromFile(jsonPath) {
  let raw;
  if (jsonPath.toLowerCase().endsWith('.vpc')) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(jsonPath);
    const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.json'));
    if (!entry) throw new Error('No JSON found inside .vpc file');
    raw = entry.getData().toString('utf8');
  } else {
    raw = fs.readFileSync(jsonPath, 'utf8');
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = parseVideoPsalmJson(raw); }
  const vpSongs = data.Songs || data.songs || data.Items || data.items || [];
  if (!Array.isArray(vpSongs) || vpSongs.length === 0) return [];
  return vpSongs.map(vpSong => {
    const title  = vpSong.Text || vpSong.Title || vpSong.Name || 'Untitled';
    const author = [vpSong.Author, vpSong.Composer].filter(Boolean).join(', ') || '';
    const verses = vpSong.Verses || vpSong.Items || vpSong.Lines || [];
    const lyrics = verses.map(v => ({
      section: v.Section || v.Type || '',
      text: (v.Text || v.Content || v.Lyrics || '').replace(/\[[A-Ga-g][^\]]{0,10}\]/g, '').trim()
    })).filter(v => v.text);
    return { title, author, lyrics };
  }).filter(s => s.lyrics.length > 0);
}

// ---------------------------

const settingsPath = path.join(getUserDataDir(app), 'settings.json');
const SPEECH_WATCHDOG_INTERVAL_MS = 6000;

function loadAiSettingsFromDisk() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const ai = (parsed && typeof parsed === 'object') ? (parsed.ai || {}) : {};
    return {
      modelSize: ai.modelSize || 'small',
      enabled: typeof ai.enabled === 'boolean' ? ai.enabled : true,
      micDeviceId: ai.micDeviceId || 'default'
    };
  } catch (e) {
    return { modelSize: 'small', enabled: true, micDeviceId: 'default' };
  }
}

cachedAiSettings = loadAiSettingsFromDisk();
let aiEnabled = cachedAiSettings.enabled !== false;
speechSidecarManager = createSpeechSidecarManager({ modelSize: cachedAiSettings.modelSize, userDataDir: app.getPath('userData') });

// If AI is disabled, we don't need to wait for sidecar initialization
sidecarInitialized = !aiEnabled;

function decorateSidecarStatus(status) {
  return { ...(status || {}), aiDisabled: !aiEnabled };
}

function getCurrentSidecarStatus() {
  return latestSidecarStatus || decorateSidecarStatus(speechSidecarManager ? speechSidecarManager.getStatus() : { statusMessage: 'sidecar-disabled' });
}

function bindSidecarStatusEmitter(manager) {
  if (!manager || manager.__liturgiaStatusBound) return;
  manager.__liturgiaStatusBound = true;
  manager.on('status', (status) => {
    const decorated = decorateSidecarStatus(status);
    latestSidecarStatus = decorated;
    console.log('[sidecar-status] Received:', status ? status.statusMessage : 'null', '(sidecarInitialized=' + sidecarInitialized + ')');
    if (status && status.modelSize) {
      cachedAiSettings = { ...cachedAiSettings, modelSize: status.modelSize };
    }
    
    // Detect when sidecar has begun initializing (not just 'sidecar-not-started' initial state)
    if (!sidecarInitialized && status && status.statusMessage && status.statusMessage !== 'sidecar-not-started') {
      sidecarInitialized = true;
      console.log('[main] Sidecar initialization begun: ' + status.statusMessage);
      tryCloseSplashScreen();
    }
    
    broadcastToAllWindows('sidecar:status', decorated);
  });
}

function startSidecarWatchdog() {
  if (speechSidecarWatchdog || !speechSidecarManager || !aiEnabled) return;
  speechSidecarWatchdog = setInterval(() => {
    if (!aiEnabled || !speechSidecarManager) return;
    speechSidecarManager.ensureRunning().catch((err) => {
      console.warn('[speech-sidecar] watchdog ensure failed:', err && err.message ? err.message : err);
    });
  }, SPEECH_WATCHDOG_INTERVAL_MS);
}

function stopSidecarWatchdog() {
  if (!speechSidecarWatchdog) return;
  clearInterval(speechSidecarWatchdog);
  speechSidecarWatchdog = null;
}

function destroyAiSpeechWorkerWindow(options = {}) {
  if (options.suppressRestart) {
    aiWorkerSuppressed = true;
  }
  if (!aiSpeechWorkerWindow) return;
  const target = aiSpeechWorkerWindow;
  aiSpeechWorkerWindow = null;
  try { target.destroy(); } catch (err) { console.warn('[ai-worker] failed to destroy window', err && err.message ? err.message : err); }
}

function ensureAiSpeechWorkerWindow() {
  if (launchSpeechUi) return;
  if (!aiEnabled) return;
  if (aiWorkerSuppressed) return;
  if (aiSpeechWorkerWindow) return;
  if (!app.isReady()) {
    app.once('ready', ensureAiSpeechWorkerWindow);
    return;
  }

  try {
    aiSpeechWorkerWindow = new BrowserWindow({
      width: 480,
      height: 320,
      show: false,
      resizable: false,
      focusable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
        devTools: false
      }
    });

    aiWorkerSuppressed = false;
    aiSpeechWorkerWindow.setMenuBarVisibility(false);
    const workerEntry = path.join(__dirname, 'speech', 'index.html');
    aiSpeechWorkerWindow.loadFile(workerEntry, { query: { headless: '1', autostart: '1' } }).catch((err) => {
      console.warn('[ai-worker] failed to load speech worker', err && err.message ? err.message : err);
      aiWorkerWindowReady = true;
    });

    // Start sidecar manager to begin emitting status updates
    if (speechSidecarManager) {
      speechSidecarManager.ensureRunning().catch((err) => {
        console.warn('[ai-worker] speechSidecarManager.ensureRunning failed:', err && err.message ? err.message : err);
      });
    }

    aiSpeechWorkerWindow.on('closed', () => {
      aiSpeechWorkerWindow = null;
      if (aiEnabled && !launchSpeechUi && !aiWorkerSuppressed) {
        setTimeout(() => ensureAiSpeechWorkerWindow(), 1200);
      }
    });
  } catch (err) {
    console.warn('[ai-worker] creation failed', err && err.message ? err.message : err);
    aiSpeechWorkerWindow = null;
    aiWorkerWindowReady = true;
  }
}

// Keep track of when splash was first shown
// Check if both windows are ready and close splash if so (with minimum display time)
function tryCloseSplashScreen() {
  const sidecarReadyOrNotNeeded = sidecarInitialized || !aiEnabled || aiWorkerSuppressed || launchSpeechUi;
  const allConditionsMet = mainWindowLoaded && rendererReady && sidecarReadyOrNotNeeded;
  
  // Update progress based on what's completed
  if (allConditionsMet && splashWindow && !splashWindow.isDestroyed()) {
    try { 
      splashWindow.webContents.send('splash:update-status', { message: 'Ready', progress: 100 }); 
      lastStatusUpdateTime = Date.now();
      console.log('[main] All ready, showing final status');
    } catch(e){ console.error('[main] Error sending ready status:', e); }
  }
  
  // Only close splash when ALL conditions are met
  if (allConditionsMet) {
    if (splashWindow && !splashWindow.isDestroyed()) {
      // Enforce minimum times:
      // 1. Ensure splash visible for at least 800ms total
      const timeShown = splashShownTime > 0 ? Date.now() - splashShownTime : 0;
      const minTotalDisplayTime = 800;
      
      // 2. Ensure final "Ready" message visible for 1.5s
      const timeSinceLastStatus = Date.now() - lastStatusUpdateTime;
      const minStatusDisplayTime = 1500;
      
      const totalDelayNeeded = Math.max(0, minTotalDisplayTime - timeShown);
      const statusDelayNeeded = Math.max(0, minStatusDisplayTime - timeSinceLastStatus);
      const finalDelay = Math.max(totalDelayNeeded, statusDelayNeeded);
      
      console.log('[main] Closing splash after ' + finalDelay + 'ms (total: ' + timeShown + 'ms, status: ' + timeSinceLastStatus + 'ms)');
      
      setTimeout(() => {
        splashClosed = true;
        console.log('[splash-close] Destroying splash window');
        try { splashWindow.destroy(); splashWindow = null; } catch(e){ console.error('[main] Error destroying splash:', e); }
        
        setTimeout(() => {
          try { 
            if (mainWindow && !mainWindow.isDestroyed()) { 
              if (pendingMaximize) {
                mainWindow.show();
                mainWindow.maximize();
              } else if (pendingFullscreen) {
                mainWindow.show();
                mainWindow.setFullScreen(true);
              } else {
                mainWindow.setPosition(initialWindowX, initialWindowY);
                mainWindow.show();
              }
              mainWindow.focus(); 
            } 
          } catch(e){ console.error('[main] Error showing main window:', e); }
          try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('splash-closed'); } catch(e){}
          // If a .litsch file was queued before the window was ready, open it now
          if (pendingScheduleFile) {
            const p = pendingScheduleFile;
            pendingScheduleFile = null;
            setTimeout(() => sendScheduleFileToRenderer(p), 300);
          }
          // If a .litsong file was queued before the window was ready, open it now
          if (pendingSongFile) {
            const p = pendingSongFile;
            pendingSongFile = null;
            setTimeout(() => sendSongFileToRenderer(p), 300);
          }
          // If a .litrep report file was queued before the window was ready, open the report viewer
          if (pendingReportFile) {
            const p = pendingReportFile;
            pendingReportFile = null;
            setTimeout(() => openReportViewerWindow(p), 300);
          }
        }, 50);
      }, finalDelay);
    }
  }
}

function sendScheduleFileToRenderer(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('schedule:open-file', data);
      mainWindow.focus();
    }
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, { type: 'error', message: 'Failed to open schedule file', detail: e.message || String(e), buttons: ['OK'] });
    }
  }
}

function sendSongFileToRenderer(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('songs:open-file', data);
      mainWindow.focus();
    }
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, { type: 'error', message: 'Failed to open song file', detail: e.message || String(e), buttons: ['OK'] });
    }
  }
}


async function setAiEnabled(nextEnabled) {
  const desired = !!nextEnabled;
  if (desired === aiEnabled) {
    return { ok: true, enabled: aiEnabled, status: latestSidecarStatus };
  }

  aiEnabled = desired;
  await persistAiSettings({ enabled: aiEnabled });

  if (!aiEnabled) {
    stopSidecarWatchdog();
    destroyAiSpeechWorkerWindow();
    if (speechSidecarManager) {
      try { await speechSidecarManager.stopProcess(); } catch (err) { console.warn('[speech-sidecar] stop failed', err && err.message ? err.message : err); }
    }
    latestSidecarStatus = decorateSidecarStatus(speechSidecarManager ? speechSidecarManager.getStatus() : { statusMessage: 'sidecar-disabled' });
    broadcastToAllWindows('sidecar:status', latestSidecarStatus);
    latestAiSuggestions = { clearContext: true, suggestions: [] };
    broadcastToAllWindows('ai:suggestions', latestAiSuggestions);
  } else {
    if (!speechSidecarManager) {
      speechSidecarManager = createSpeechSidecarManager({ modelSize: cachedAiSettings.modelSize, userDataDir: app.getPath('userData') });
      bindSidecarStatusEmitter(speechSidecarManager);
    }
    try {
      await speechSidecarManager.ensureRunning();
    } catch (err) {
      console.warn('[speech-sidecar] failed to start after enabling AI:', err && err.message ? err.message : err);
    }
    latestSidecarStatus = decorateSidecarStatus(speechSidecarManager ? speechSidecarManager.getStatus() : { statusMessage: 'sidecar-disabled' });
    broadcastToAllWindows('sidecar:status', latestSidecarStatus);
    startSidecarWatchdog();
    ensureAiSpeechWorkerWindow();
  }

  broadcastToAllWindows('ai:enabled-changed', aiEnabled);

  return { ok: true, enabled: aiEnabled, status: latestSidecarStatus };
}

bindSidecarStatusEmitter(speechSidecarManager);
latestSidecarStatus = decorateSidecarStatus(speechSidecarManager.getStatus());

function broadcastToAllWindows(channel, payload, { skipWebContentsId } = {}) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win || win.isDestroyed()) return;
    if (skipWebContentsId && win.webContents && win.webContents.id === skipWebContentsId) return;
    try { win.webContents.send(channel, payload); } catch (err) { console.warn(`[broadcast ${channel}] failed`, err && err.message ? err.message : err); }
  });
}

function sendLatestSidecarStatusToWindow(win) {
  if (!latestSidecarStatus || !win || win.isDestroyed()) return;
  try { win.webContents.send('sidecar:status', latestSidecarStatus); } catch (err) {}
}

function sendLatestAiSuggestionsToWindow(win) {
  if (!latestAiSuggestions || !win || win.isDestroyed()) return;
  try { win.webContents.send('ai:suggestions', latestAiSuggestions); } catch (err) {}
}

function hydrateWindowWithAiRuntime(win) {
  sendLatestSidecarStatusToWindow(win);
  sendLatestAiSuggestionsToWindow(win);
  // Send the current Bible book list to newly opened windows (e.g. speech worker).
  if (currentDynamicBibleBooks) {
    try { win.webContents.send('bible-books-updated', currentDynamicBibleBooks); } catch (err) {}
  }
}



app.on('browser-window-created', (_event, win) => {
  if (!win || !win.webContents) return;
  win.webContents.once('did-finish-load', () => hydrateWindowWithAiRuntime(win));
});

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

ipcMain.handle('schedule:save-to-file', async () => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Schedule',
    defaultPath: 'schedule.litsch',
    filters: [{ name: 'Liturgia Schedule', extensions: ['litsch'] }]
  });
  return filePath || null;
});

ipcMain.handle('schedule:load-from-file', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Schedule',
    filters: [{ name: 'Liturgia Schedule', extensions: ['litsch'] }],
    properties: ['openFile']
  });
  if (!filePaths || !filePaths.length) return null;
  try {
    const raw = await fs.promises.readFile(filePaths[0], 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    await dialog.showMessageBox(mainWindow, { type: 'error', message: 'Failed to load schedule', detail: e.message || String(e), buttons: ['OK'] });
    return null;
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
  const result = await applySettingsPatch(patch);
  // Notify the main renderer so it can refresh live state (e.g. keybinds)
  if (patch.keybinds && mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('settings-updated', { keybinds: patch.keybinds });
  }
  return result;
});

async function persistAiSettings(patch = {}) {
  cachedAiSettings = { ...cachedAiSettings, ...patch };
  await applySettingsPatch({ ai: { ...cachedAiSettings } });
  return cachedAiSettings;
}

ipcMain.handle('sidecar:get-status', async () => {
  return getCurrentSidecarStatus();
});

ipcMain.handle('sidecar:ensure-running', async () => {
  if (!speechSidecarManager) {
    return decorateSidecarStatus({ statusMessage: 'sidecar-disabled' });
  }
  if (!aiEnabled) {
    return getCurrentSidecarStatus();
  }
  await speechSidecarManager.ensureRunning();
  return getCurrentSidecarStatus();
});

ipcMain.handle('sidecar:restart', async () => {
  if (!speechSidecarManager) return { ok: false, error: 'sidecar-disabled' };
  if (!aiEnabled) return { ok: false, error: 'ai-disabled', status: getCurrentSidecarStatus() };
  const ok = await speechSidecarManager.restart();
  return { ok, status: getCurrentSidecarStatus() };
});

ipcMain.handle('sidecar:set-model-size', async (_event, requestedSize) => {
  if (!speechSidecarManager) return { ok: false, error: 'sidecar-disabled' };
  const result = await speechSidecarManager.setModelSize(requestedSize, { restart: aiEnabled });
  if (result && result.ok && result.modelSize) {
    await persistAiSettings({ modelSize: result.modelSize });
  }
  return { ...result, status: getCurrentSidecarStatus() };
});

ipcMain.handle('sidecar:open-model-folder', async () => {
  if (!speechSidecarManager) return { ok: false, error: 'sidecar-disabled' };
  const targetDir = speechSidecarManager.getModelFolder();
  try {
    await fs.promises.mkdir(targetDir, { recursive: true });
    const openResult = await shell.openPath(targetDir);
    if (openResult) {
      return { ok: false, error: openResult, path: targetDir };
    }
    return { ok: true, path: targetDir };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), path: targetDir };
  }
});

ipcMain.on('ai:suggestions-from-renderer', (event, payload) => {
  latestAiSuggestions = payload;
  broadcastToAllWindows('ai:suggestions', payload, { skipWebContentsId: event && event.sender ? event.sender.id : undefined });
});

// Renderer sends updated book list whenever the active Bible changes.
// Broadcast to all other windows so the speech worker stays in sync.
ipcMain.on('bible-books-updated', (event, bookNames) => {
  currentDynamicBibleBooks = Array.isArray(bookNames) ? bookNames : null;
  broadcastToAllWindows('bible-books-updated', currentDynamicBibleBooks, { skipWebContentsId: event && event.sender ? event.sender.id : undefined });
});

ipcMain.handle('ai:get-latest-suggestions', async () => {
  return latestAiSuggestions || null;
});

ipcMain.handle('ai:get-enabled', async () => {
  return { enabled: aiEnabled, status: getCurrentSidecarStatus() };
});

ipcMain.handle('ai:set-enabled', async (_event, desiredState) => {
  if (typeof desiredState !== 'boolean') {
    return { ok: false, error: 'invalid-input', enabled: aiEnabled, status: getCurrentSidecarStatus() };
  }
  const result = await setAiEnabled(desiredState);
  return { ...result, status: getCurrentSidecarStatus() };
});

// Renderer signals it's ready to display (after DOMContentLoaded initialization)
ipcMain.handle('renderer-ready', async () => {
  console.log('[main] Renderer initialization complete');
  rendererReady = true;

  // Arm the error notifier now that the renderer is ready.
  // Record a baseline so that console.error calls made during the rest of the
  // startup sequence (relay, speech sidecar, etc.) are ignored — only new
  // errors occurring after full startup are surfaced to the user.
  // We delay arming by 15 s so all normal boot-time errors are absorbed.
  setTimeout(() => {
    _errorBaseline = mainLogs.filter(l => l.level === 'error').length;
    _notifyError = () => {
      if (_errorPromptShown || !mainWindow || mainWindow.isDestroyed()) return;
      const newErrors = mainLogs.filter(l => l.level === 'error').slice(_errorBaseline);
      if (newErrors.length === 0) return;
      clearTimeout(_errorNotifyTimer);
      _errorNotifyTimer = setTimeout(() => {
        try {
          if (!_errorPromptShown && mainWindow && !mainWindow.isDestroyed()) {
            _errorPromptShown = true;
            const payload = newErrors.map(l => `[${l.ts}] ${l.msg}`);
            mainWindow.webContents.send('error-report-prompt', { errors: payload });
          }
        } catch (e) {}
      }, 3000);
    };
  }, 15000);

  // Send next stage message
  try {
    splashWindow.webContents.send('splash:update-status', { message: 'Initializing speech...', progress: 65 });
    lastStatusUpdateTime = Date.now();
  } catch (err) {
    console.warn('[main] Failed to send initialization message', err);
  }
  
  tryCloseSplashScreen();
  return { success: true };
});

ipcMain.handle('import-easyworship', async () => {
  await importEasyWorshipHandler();
});

ipcMain.handle('vp-collect-songbooks', async () => {
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Auto Scan', 'Select File', 'Cancel'],
    defaultId: 0,
    title: 'Import VideoPsalm',
    message: 'Import VideoPsalm songs',
    detail: 'Auto Scan checks common VideoPsalm locations. Select File lets you pick one or more songbook files.'
  });
  if (choice.response === 2) return { cancelled: true, songbooks: [] };

  let filePaths = [];
  if (choice.response === 0) {
    const VP_EXCLUDE = ['settings', 'fontstyles', 'themes', 'options', 'config', 'prefs', 'preferences', 'layout', 'style'];
    const isVpSongbook = f => (f.toLowerCase().endsWith('.vpc') || f.toLowerCase().endsWith('.json')) && !VP_EXCLUDE.some(x => f.toLowerCase().startsWith(x));
    const candidates = [
      path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents', 'VideoPsalm', 'SongBooks'),
      path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents', 'VideoPsalm'),
      path.join(os.homedir(), 'Documents', 'VideoPsalm', 'SongBooks'),
      path.join(os.homedir(), 'Documents', 'VideoPsalm'),
      path.join('C:\\ProgramData', 'VideoPsalm', 'SongBooks'),
      path.join('C:\\ProgramData', 'VideoPsalm'),
    ];
    const seen = new Set();
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      try {
        const entries = fs.readdirSync(c);
        for (const f of entries) {
          if (isVpSongbook(f)) { const p = path.join(c, f); if (!seen.has(p)) { seen.add(p); filePaths.push(p); } }
        }
        for (const entry of entries) {
          const sub = path.join(c, entry);
          try {
            const subEntries = fs.readdirSync(sub);
            for (const f of subEntries) {
              if (isVpSongbook(f)) { const p = path.join(sub, f); if (!seen.has(p)) { seen.add(p); filePaths.push(p); } }
            }
          } catch {}
        }
      } catch {}
    }
    if (filePaths.length === 0) {
      await dialog.showMessageBox({ type: 'info', message: 'No VideoPsalm songbooks found', detail: 'No songbook found in common VideoPsalm locations. Please select files manually.', buttons: ['OK'] });
    }
  }
  if (filePaths.length === 0) {
    const sel = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Select VideoPsalm songbook file(s)',
      filters: [{ name: 'VideoPsalm Files', extensions: ['vpc', 'json'] }, { name: 'All Files', extensions: ['*'] }]
    });
    if (sel.canceled || !sel.filePaths || sel.filePaths.length === 0) return { cancelled: true, songbooks: [] };
    filePaths = sel.filePaths;
  }

  const songbooks = [];
  for (const p of filePaths) {
    try {
      const songs = await importVideoPsalmFromFile(p);
      if (songs && songs.length > 0) {
        songbooks.push({ path: p, name: path.basename(p), songCount: songs.length });
      }
    } catch {}
  }
  return { cancelled: false, songbooks };
});

ipcMain.handle('vp-do-import', async (_event, selectedPaths) => {
  const { getUserDataDir } = require('./lib/paths');
  const songsPath = path.join(getUserDataDir(app), 'songs.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(songsPath, 'utf8') || '[]'); } catch { existing = []; }
  let added = 0;
  let total = 0;
  for (const p of selectedPaths) {
    let songs;
    try { songs = await importVideoPsalmFromFile(p); } catch { continue; }
    if (!songs || songs.length === 0) continue;
    total += songs.length;
    for (const s of songs) {
      const dup = existing.some(e => (e.title || '').trim() === (s.title || '').trim());
      if (dup) continue;
      existing.push(s);
      added++;
    }
  }
  try {
    fs.writeFileSync(songsPath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (e) {
    dialog.showMessageBox({ type: 'error', message: 'Failed to save songs', detail: e.message || String(e), buttons: ['OK'] });
    return { added: 0, total: 0 };
  }
  return { added, total };
});

ipcMain.handle('import-ew-db-file', async (_event, dbFilePath) => {
  try {
    const dir   = path.dirname(dbFilePath);
    const songs = await importEasyWorshipFromDir(dir);
    if (!songs || songs.length === 0) return { added: 0, total: 0 };
    const { getUserDataDir } = require('./lib/paths');
    const songsPath = path.join(getUserDataDir(app), 'songs.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(songsPath, 'utf8') || '[]'); } catch { existing = []; }
    let added = 0;
    for (const s of songs) {
      const dup = existing.some(e =>
        (e.title  || '').trim() === (s.title  || '').trim() &&
        (e.author || '').trim() === (s.author || '').trim()
      );
      if (dup) continue;
      const lyrics = [];
      if (s.text) {
        const verses = s.text.split(/\n\n+/);
        if (verses.length > 1) {
          verses.forEach((v, i) => { if (v.trim()) lyrics.push({ section: `Verse ${i + 1}`, text: v.trim() }); });
        } else {
          lyrics.push({ section: '', text: s.text.trim() });
        }
      }
      existing.push({ title: s.title, author: s.author, lyrics });
      added++;
    }
    try { fs.writeFileSync(songsPath, JSON.stringify(existing, null, 2), 'utf8'); } catch {}
    return { added, total: songs.length };
  } catch (e) {
    console.error('[import-ew-db-file]', e);
    return { added: 0, total: 0, error: e.message };
  }
});

// Remote control pairing callback
function handlePairRequest(deviceId, deviceName) {
  dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Approve', 'Reject'],
    defaultId: 0,
    title: 'Remote Control Pairing Request',
    message: `"${deviceName}" wants to connect to Liturgia • Worship.`,
    detail: 'Do you want to allow this device to control Liturgia • Worship?'
  }).then(({ response }) => {
    if (response === 0) {
      // Approved
      if (remoteServer) {
        remoteServer.approvePairing(deviceId);
        // Notify settings windows to refresh
        BrowserWindow.getAllWindows().forEach(win => {
          win.webContents.send('remote-devices-changed');
        });
      }
    } else {
      // Rejected
      if (remoteServer) {
        remoteServer.rejectPairing(deviceId);
      }
    }
  }).catch(err => {
    console.error('[remote] Dialog error:', err);
    if (remoteServer) {
      remoteServer.rejectPairing(deviceId);
    }
  });
}

// Remote control server IPC handlers
ipcMain.handle('remote-start', async (event, port) => {
  try {
    if (!remoteServer) {
      remoteServer = new RemoteServer(app, mainWindow, handlePairRequest);
    }
    remoteServer.start(port);
    await applySettingsPatch({ remote: { enabled: true, port } });
    return { success: true };
  } catch (e) {
    console.error('[remote] Failed to start:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('remote-stop', async () => {
  try {
    if (remoteServer) {
      remoteServer.stop();
    }
    await applySettingsPatch({ remote: { enabled: false } });
    return { success: true };
  } catch (e) {
    console.error('[remote] Failed to stop:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('remote-get-paired-devices', async () => {
  if (!remoteServer) return [];
  return remoteServer.getPairedDevices();
});

ipcMain.handle('remote-revoke-device', async (event, deviceId) => {
  if (!remoteServer) return false;
  const result = remoteServer.revokeDevice(deviceId);
  if (result) {
    // Notify all windows to refresh
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('remote-devices-changed');
    });
  }
  return result;
});

ipcMain.handle('remote-approve-pairing', async (event, deviceId) => {
  if (!remoteServer) return false;
  return remoteServer.approvePairing(deviceId);
});

ipcMain.handle('remote-reject-pairing', async (event, deviceId) => {
  if (!remoteServer) return false;
  return remoteServer.rejectPairing(deviceId);
});

ipcMain.handle('remote-get-info', async () => {
  if (!remoteServer || !remoteServer.wss) {
    return { running: false };
  }
  return {
    running: true,
    port: remoteServer.port,
    httpPort: remoteServer.httpPort,
    addresses: remoteServer.getLocalIpAddresses()
  };
});

ipcMain.handle('remote-fix-connection', async () => {
  try {
    const port = remoteServer ? remoteServer.port : 39847;
    const httpPort = remoteServer ? remoteServer.httpPort : 39848;
    const result = await RemoteServer.addFirewallRules(port, httpPort);
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Cloud Relay IPC handlers
ipcMain.handle('relay-start', async (event, { token, deviceName }) => {
  try {
    if (relayClient) {
      relayClient.stop();
    }
    
    relayClient = new RelayClient('https://jacqueb.me/liturgia/relay', token);
    
    relayClient.on('connection-method', (method) => {
      console.log('[relay] Connection method:', method);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('relay-connection-method', method);
        mainWindow.webContents.send('relay-push-state-request');
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('relay-connection-method', method);
      }
    });
    
    relayClient.on('message', (message) => {
      console.log('[relay] Received message from mobile:', message);
      // Forward to RemoteServer's command handler logic
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('remote-command', message);
      }
    });
    
    relayClient.on('error', (err) => {
      console.error('[relay] Error:', err);
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('relay-error', err.message);
      }
    });
    
    relayClient.on('disconnected', () => {
      console.log('[relay] Disconnected');
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('relay-disconnected');
      }
    });
    
    const success = await relayClient.register(deviceName);
    
    if (success) {
      await applySettingsPatch({ relay: { enabled: true } });
      return { success: true, sessionId: relayClient.sessionId };
    } else {
      console.error('[relay] Registration returned false (check relay-client logs above for details)');
      throw new Error('Failed to register with relay server');
    }
  } catch (e) {
    console.error('[relay] Failed to start:', e);
    console.error('[relay] Error stack:', e.stack);
    if (relayClient) {
      relayClient.stop();
      relayClient = null;
    }
    return { success: false, error: e.message };
  }
});

ipcMain.handle('relay-stop', async () => {
  try {
    if (relayClient) {
      relayClient.stop();
      relayClient = null;
    }
    await applySettingsPatch({ relay: { enabled: false } });
    return { success: true };
  } catch (e) {
    console.error('[relay] Failed to stop:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('relay-get-info', async () => {
  if (!relayClient || !relayClient.sessionId) {
    return { running: false };
  }
  return {
    running: true,
    sessionId: relayClient.sessionId,
    connectionMethod: relayClient.useWebSocket ? 'WebSocket' : 'PHP Polling'
  };
});

ipcMain.handle('relay-send-response', async (event, message) => {
  if (!relayClient) {
    return { success: false, error: 'Not connected' };
  }
  const success = await relayClient.sendToMobile(message);
  return { success };
});

ipcMain.handle('relay-push-state', async (event, state) => {
  if (!relayClient) {
    return { success: false, error: 'Not connected' };
  }
  console.log('[relay] Pushing state to mobile:', state);
  const success = await relayClient.pushState(state);
  return { success };
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

ipcMain.handle('show-bible-import-dialog', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import Bible',
    filters: [
      { name: 'Bible Files', extensions: ['json', 'xml', 'usfx', 'osis', 'usfm', 'sfm', 'txt', 'tsv', 'zip'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('parse-bible-file', async (event, filePath) => {
  const { parseBibleFile } = require('./scriptureData');
  return await parseBibleFile(filePath);
});

ipcMain.handle('import-bible-file', async (event, filePath, versionId) => {
  const { importBibleFile } = require('./scriptureData');
  const storageDir = path.join(app.getPath('userData'), 'bibles');
  return await importBibleFile(filePath, versionId, storageDir);
});

ipcMain.handle('export-bible-file', async (event, versionId, format = 'json') => {
  try {
    const storageDir = path.join(app.getPath('userData'), 'bibles');
    const srcFile = path.join(storageDir, versionId, 'bible.json');
    if (!fs.existsSync(srcFile)) throw new Error(`Bible file not found for version: ${versionId}`);
    
    const isXml = format === 'xml';
    const result = await dialog.showSaveDialog({
      title: isXml ? 'Export Bible as XML' : 'Export Bible as JSON',
      defaultPath: `${versionId}.${isXml ? 'xml' : 'json'}`,
      filters: isXml 
        ? [{ name: 'XML Files', extensions: ['xml'] }, { name: 'All Files', extensions: ['*'] }]
        : [{ name: 'JSON Files', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }]
    });
    
    if (result.canceled || !result.filePath) return null;
    
    if (isXml) {
      const bibleData = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
      const xmlContent = convertBibleJsonToXml(bibleData);
      fs.writeFileSync(result.filePath, xmlContent, 'utf8');
    } else {
      fs.copyFileSync(srcFile, result.filePath);
    }
    
    return result.filePath;
  } catch (err) {
    console.error('Export Bible error:', err);
    throw err;
  }
});

function convertBibleJsonToXml(bibleData) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<bible>\n';
  
  for (const book of bibleData) {
    const bookAbbrev = book.abbrev || '';
    const bookName = book.name || book.book || '';
    xml += `  <b id="${escapeXml(bookAbbrev)}" n="${escapeXml(bookName)}">\n`;
    
    for (let chapterIdx = 0; chapterIdx < book.chapters.length; chapterIdx++) {
      const chapterNum = chapterIdx + 1;
      const verses = book.chapters[chapterIdx];
      xml += `    <c n="${chapterNum}">\n`;
      
      for (let verseIdx = 0; verseIdx < verses.length; verseIdx++) {
        const verseNum = verseIdx + 1;
        const verseText = verses[verseIdx];
        xml += `      <v n="${verseNum}">${escapeXml(verseText)}</v>\n`;
      }
      
      xml += `    </c>\n`;
    }
    
    xml += `  </b>\n`;
  }
  
  xml += '</bible>';
  return xml;
}

function escapeXml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

ipcMain.handle('download-python', async (event) => {
  try {
    const { platform } = process;
    const path = require('path');
    const fs = require('fs');
    
    let downloadUrl = '';
    let filename = '';
    
    // Detect platform and get the right Python installer
    if (platform === 'win32') {
      downloadUrl = 'https://www.python.org/ftp/python/3.12.0/python-3.12.0-amd64.exe';
      filename = 'python-3.12.0-amd64.exe';
    } else if (platform === 'darwin') {
      // macOS - determine if Intel or Apple Silicon
      const cpuArch = require('os').arch();
      if (cpuArch === 'arm64') {
        downloadUrl = 'https://www.python.org/ftp/python/3.12.0/python-3.12.0-macos11.0-arm64.pkg';
        filename = 'python-3.12.0-macos11.0-arm64.pkg';
      } else {
        downloadUrl = 'https://www.python.org/ftp/python/3.12.0/python-3.12.0-macos10.9.x86_64.pkg';
        filename = 'python-3.12.0-macos10.9.x86_64.pkg';
      }
    } else if (platform === 'linux') {
      // Linux - direct user to python.org as installation varies by distro
      await shell.openExternal('https://www.python.org/downloads/');
      return { success: false, message: 'Please follow the instructions on python.org for your Linux distribution' };
    }
    
    if (!downloadUrl) {
      return { success: false, message: 'Unsupported platform' };
    }
    
    // Get downloads directory
    const downloadsDir = require('electron').app.getPath('downloads');
    const savePath = path.join(downloadsDir, filename);
    
    console.log(`[Python] Downloading ${filename} from ${downloadUrl}`);
    
    // Download with progress reporting
    let lastReportedPercent = 0;
    const downloadPromise = new Promise((resolve, reject) => {
      const https = downloadUrl.startsWith('https') ? require('https') : require('http');
      const file = require('fs').createWriteStream(savePath);
      
      https.get(downloadUrl, (response) => {
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;
        
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const percentComplete = Math.round((downloadedSize / totalSize) * 100);
          
          // Report progress every 5%
          if (percentComplete - lastReportedPercent >= 5) {
            lastReportedPercent = percentComplete;
            // Send to settings window if it's open
            if (settingsWindow && !settingsWindow.isDestroyed()) {
              settingsWindow.webContents.send('python-download-progress', { percent: percentComplete, size: downloadedSize, total: totalSize });
            }
          }
        });
        
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(savePath);
        });
        file.on('error', (err) => {
          file.close();
          fs.unlink(savePath, () => {}); // Delete partial file
          reject(err);
        });
      }).on('error', reject);
    });
    
    const finalPath = await downloadPromise;
    console.log(`[Python] Download complete: ${finalPath}`);
    
    // Open the installer
    await shell.openPath(finalPath);
    
    return { success: true, path: finalPath, message: 'Python installer downloaded and opened. Please follow the installation wizard.' };
  } catch (err) {
    console.error('[Python] Download failed:', err);
    return { success: false, message: `Download failed: ${err.message}` };
  }
});

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays();
});

let _lastLicenseStatus = null;
ipcMain.on('license-status-update', (event, status) => {
  try {
    _lastLicenseStatus = status || null;
    for (const win of liveWindows.values()) { if (!win.isDestroyed()) win.webContents.send('license-status', status); }
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
    if (mainWindow && !splashClosed) {
      console.log('[show-setup-modal] Splash still active, deferring window show');
      return; // Don't show window while splash is active
    }
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
  try { 
    if (splashClosed && mainWindow) { 
      console.log('[focus-main-window] Showing window');
      mainWindow.show(); 
      mainWindow.focus(); 
    } else if (!splashClosed) {
      console.log('[focus-main-window] Splash still active, not showing window');
    }
    return true; 
  } catch (e) { 
    console.error('[focus-main-window] error:', e);
    return false; 
  }
});

// Allow renderer to invoke Save Report (used by the error-report-prompt toast)
ipcMain.handle('trigger-save-report', async () => {
  try { await startSaveReport(); } catch (err) { console.error('trigger-save-report failed:', err); }
});

// Open the standalone report viewer window, optionally pre-loading a .litrep file
let reportViewerWindow = null;
async function openReportViewerWindow(filePath) {
  if (reportViewerWindow && !reportViewerWindow.isDestroyed()) {
    reportViewerWindow.focus();
    if (filePath) reportViewerWindow.webContents.send('load-report-file', filePath);
    return;
  }
  const { resolveProjectPath } = require('./lib/paths');
  reportViewerWindow = new BrowserWindow({
    width: 1280, height: 800,
    title: 'Liturgia Report Viewer',
    icon: getIconPath(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  await reportViewerWindow.loadFile(resolveProjectPath('report-viewer.html'));
  if (filePath) reportViewerWindow.webContents.send('load-report-file', filePath);
  reportViewerWindow.on('closed', () => { reportViewerWindow = null; });
}

ipcMain.handle('open-report-viewer', async (event, filePath) => {
  await openReportViewerWindow(filePath || null);
});

// IPC helper to write a combined diagnostic report
async function startSaveReport() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultName = `liturgia-report-${timestamp}.litrep`;

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

  // Capture live window snapshots for all active displays
  const liveScreenshots = []; // [{displayId, dataUrl}]

  // Collect sidecar diagnostic log
  let sidecarDiagLog = '';
  try {
    if (speechSidecarManager) sidecarDiagLog = speechSidecarManager.getStatus().diagnosticLog || '';
  } catch (e) {}

  // Ask AI speech worker window for its in-page logs and rolling context
  let speechWorkerPayload = null;
  try {
    if (aiSpeechWorkerWindow && !aiSpeechWorkerWindow.isDestroyed()) {
      aiSpeechWorkerWindow.webContents.send('prepare-speech-report');
      speechWorkerPayload = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timedOut: true }), 5000);
        ipcMain.once('speech-report', (_e, payload) => { clearTimeout(t); resolve(payload); });
      });
    }
  } catch (e) {}
  for (const [displayId, win] of liveWindows.entries()) {
    if (win.isDestroyed()) continue;
    try {
      const image = await win.webContents.capturePage();
      const png = image.toPNG();
      liveScreenshots.push({ displayId, dataUrl: 'data:image/png;base64,' + png.toString('base64') });
    } catch (e) {
      console.error(`Failed to capture live window for display ${displayId}:`, e);
    }
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

  parts.push('=== MAIN PROCESS LOGS ===');
  parts.push(JSON.stringify(mainLogs, null, 2));

  parts.push('=== INDEX.HTML FILE ===');
  parts.push(indexHtml);

  parts.push('=== LIVE.HTML FILE ===');
  parts.push(liveHtml);

  parts.push('=== SETTINGS FILE (on disk) ===');
  parts.push(settingsFile);

  parts.push('=== RENDERER PROCESS LOGS ===');
  parts.push(JSON.stringify((rendererPayload && rendererPayload.rendererLogs) || [], null, 2));

  parts.push('=== RENDERER PAYLOAD ===');
  parts.push(JSON.stringify(rendererPayload || {}, null, 2));

  for (const { displayId, dataUrl } of liveScreenshots) {
    parts.push(`=== LIVE WINDOW SCREENSHOT (display ${displayId}) ===`);
    parts.push(dataUrl);
  }

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

  // Sidecar diagnostic log
  parts.push('=== SIDECAR DIAGNOSTIC LOG ===');
  parts.push(sidecarDiagLog || '(sidecar not running or no logs)');

  // Speech worker in-page logs, rolling context, etc.
  if (speechWorkerPayload && !speechWorkerPayload.timedOut) {
    parts.push('=== SPEECH WORKER LOGS ===');
    parts.push(speechWorkerPayload.logs || '(none)');
    parts.push('=== ROLLING CONTEXT ===');
    parts.push(speechWorkerPayload.rollingContext || '(empty)');
    if (speechWorkerPayload.finalText) {
      parts.push('=== SPEECH FINAL TEXT ===');
      parts.push(speechWorkerPayload.finalText);
    }
  }

  parts.push('=== END OF REPORT ===');
  const reportContent = parts.join('\n\n');

  // Ask user where to save
  const { getDesktopPath } = require('./lib/paths');
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Save diagnostic report',
    defaultPath: path.join(getDesktopPath(app), defaultName),
    filters: [{ name: 'Liturgia Report', extensions: ['litrep'] }]
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
    show: false, // Don't show until splash is ready to close
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,   // keep legacy behavior (renderer scripts rely on require/module)
      webviewTag: true
    }
  };
  
  // Save initial position for moving window back on-screen after splash closes
  initialWindowX = opts.x || 100;
  initialWindowY = opts.y || 100;

  // Create the main window instance (hidden but at proper position initially)
  mainWindow = new BrowserWindow(opts);
  
  // Create and show splash FIRST before loading any HTML and moving main window off-screen
  try {
    const b = mainWindow.getBounds();
    console.log('[splash-init] Creating splash at position:', b.x, b.y, 'size:', b.width, 'x', b.height);
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
      modal: false,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    console.log('[splash-init] Splash window created');
    splashWindow.setMenuBarVisibility(false);
    
    // Load splash and wait for it to be ready before loading main window
    console.log('[splash-init] Loading splash.html');
    await splashWindow.loadFile('splash.html');
    console.log('[splash-init] splash.html loaded');
    
    // Send current sidecar status to splash window once it's loaded
    if (latestSidecarStatus) {
      try { splashWindow.webContents.send('sidecar:status', latestSidecarStatus); } catch (err) { console.warn('[splash] Failed to send initial status', err); }
    }
    
    console.log('[splash-init] Calling splashWindow.show()');
    splashWindow.show();
    splashShownTime = Date.now();  // Record when splash becomes visible
    lastStatusUpdateTime = Date.now();  // Start tracking status update timing
    console.log('[splash-init] Splash shown, splashShownTime set');
    
    // Send initial status message immediately
    try {
      splashWindow.webContents.send('splash:update-status', { message: 'Starting up...', progress: 5 });
      console.log('[splash-init] Sent initial status message');
    } catch (err) {
      console.warn('[splash-init] Failed to send initial status', err);
    }
    
    // Start sidecar initialization immediately (model download happens in background)
    ensureAiSpeechWorkerWindow();
  } catch (e) { console.warn('Failed to create/show splash window', e); }

  // NOW move main window off-screen until splash closes
  console.log('[main-init] Moving main window off-screen');
  mainWindow.setPosition(-10000, -10000);
  
  // Send message BEFORE loading main window
  try {
    splashWindow.webContents.send('splash:update-status', { message: 'Loading interface...', progress: 10 });
    lastStatusUpdateTime = Date.now();
  } catch (err) {
    console.warn('[main-init] Failed to send loading message', err);
  }
  
  // Intercept all show() calls to prevent showing before splash closes
  const originalShow = mainWindow.show.bind(mainWindow);
  mainWindow.show = function() {
    const stack = new Error().stack.split('\n');
    const caller = stack[2] ? stack[2].trim() : 'unknown';
    
    // If splash is still active, move window off-screen if it somehow got shown
    if (!splashClosed) {
      const pos = mainWindow.getPosition();
      if (pos[0] !== -10000) {
        console.log('[mainWindow.show] BLOCKED (splash active) - moving back off-screen from', pos);
        mainWindow.setPosition(-10000, -10000);
      }
      return;
    }
    
    // Splash is closed, restore position if off-screen
    const pos = mainWindow.getPosition();
    if (pos[0] === -10000) {
      console.log('[mainWindow.show] Restoring to:', [initialWindowX, initialWindowY]);
      mainWindow.setPosition(initialWindowX, initialWindowY);
    }
    
    console.log('[mainWindow.show] Showing - called from:', caller);
    return originalShow();
  };

  // Block DevTools shortcuts in production builds
  if (process.env.NODE_ENV === 'production') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      // Block F12 and Ctrl+Shift+I
      if ((input.key.toLowerCase() === 'f12') || 
          (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        event.preventDefault();
      }
    });
  }

  // NOW load the main window HTML (will stay hidden behind visible splash)
  console.log('[main-init] Calling mainWindow.loadFile');
  mainWindow.loadFile('index.html');
  console.log('[main-init] loadFile called (window still hidden)');
  
  // Ensure fresh installs default to dark theme so UI is initialized in dark mode
  try {
    let settings = {};
    try { settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')); } catch (e) { settings = {}; }
    if (typeof settings.darkTheme !== 'boolean') { settings.darkTheme = true; try { await writeSettingsSafe(settings); } catch (e) { console.warn('Failed to persist default darkTheme in createWindow', e); } }
  } catch (e) { console.warn('Default dark theme check failed', e); }

  // Defer maximize/fullscreen until after splash closes — calling maximize() on a hidden
  // window causes Electron to make it visible through the native OS API, bypassing show: false.
  pendingMaximize = !!winState.maximized;
  pendingFullscreen = !!winState.fullscreen;

  // Keep splash window bounds in sync while present
  const syncSplashBounds = () => { try { if (splashWindow && mainWindow) splashWindow.setBounds(mainWindow.getBounds()); } catch(e){} };
  mainWindow.on('move', syncSplashBounds);
  mainWindow.on('resize', syncSplashBounds);

  // Mark main window as ready when it's ready to show
  mainWindow.once('ready-to-show', () => {
    console.log('[main] Main window ready-to-show (off-screen until splash closes)');
    mainWindowReady = true;
    
    // Start sidecar if AI is enabled so splash can detect initialization
    if (aiEnabled && !aiWorkerSuppressed && !launchSpeechUi) {
      console.log('[main] Calling ensureAiSpeechWorkerWindow from ready-to-show');
      ensureAiSpeechWorkerWindow();
    } else {
      console.log('[main] Not starting sidecar: aiEnabled=' + aiEnabled + ' suppressed=' + aiWorkerSuppressed + ' launchSpeech=' + launchSpeechUi);
    }
    
    // Don't call tryCloseSplashScreen here - wait for content to load
  });

  // Listen for when the window content finishes loading
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Main window content loaded');
    mainWindowLoaded = true;
    
    // Send next stage message BEFORE renderer processes things
    try {
      splashWindow.webContents.send('splash:update-status', { message: 'Rendering interface...', progress: 35 });
      lastStatusUpdateTime = Date.now();
    } catch (err) {
      console.warn('[main] Failed to send rendering message', err);
    }
    
    tryCloseSplashScreen();
  });

  // Catch renderer crashes
  mainWindow.webContents.on('crashed', () => {
    console.error('[main] Renderer process crashed');
  });

  // Log when window closes
  mainWindow.on('close', () => {
    console.log('[main] Main window closing');
  });

  // IPC to let renderer query splash state if it missed the event
  const { ipcMain } = require('electron');
  ipcMain.handle('is-splash-closed', () => splashClosed);

  // Fallback close in case dependencies aren't met within 15 seconds
  setTimeout(() => { 
    console.log('[main] 15-second fallback timeout firing');
    if (splashWindow) { 
      console.log('[main] Force closing splash due to timeout');
      splashClosed = true;
      try { if (splashWindow) { splashWindow.destroy(); splashWindow = null; } } catch(e){ console.error('[main] Error destroying splash in fallback:', e); }
      try { if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('splash-closed'); } catch(e){};
      try { if (mainWindow) { console.log('[main] Showing main window from fallback'); mainWindow.show(); mainWindow.focus(); } } catch(e){ console.error('[main] Error showing main from fallback:', e); }
    }
  }, 15000);

  // Save window state on move/resize/maximize/unmaximize/fullscreen changes
  mainWindow.on('resize', saveWindowStateDebounced);
  mainWindow.on('move', saveWindowStateDebounced);
  mainWindow.on('maximize', () => { applySettingsPatch({ window: { maximized: true } }); });
  mainWindow.on('unmaximize', () => { applySettingsPatch({ window: { maximized: false } }); saveWindowStateDebounced(); });
  mainWindow.on('enter-full-screen', () => { applySettingsPatch({ window: { fullscreen: true } }); });
  mainWindow.on('leave-full-screen', () => { applySettingsPatch({ window: { fullscreen: false } }); saveWindowStateDebounced(); });
  mainWindow.on('close', saveWindowState);

  // Close live windows when main window closes
  mainWindow.on('closed', () => {
    for (const win of liveWindows.values()) {
      if (!win.isDestroyed()) win.close();
    }
    liveWindows.clear();
    if (aiSpeechWorkerWindow) {
      aiSpeechWorkerWindow.destroy();
      aiSpeechWorkerWindow = null;
    }
    mainWindow = null;
    // Explicitly quit the app when main window closes (ensures window-all-closed fires)
    app.quit();
  });

  // Define the menu template
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          click: () => {
            settingsWindow = new BrowserWindow({
              width: 600,
              height: 400,
              parent: mainWindow,
              modal: true,
              icon: getIconPath(),
              webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                nodeIntegration: true,
                contextIsolation: false
              }
            });
            settingsWindow.setMenuBarVisibility(false);
            settingsWindow.loadFile('settings.html');
            settingsWindow.on('closed', () => {
              settingsWindow = null;
            });
          }
        },
        {
          label: 'Import EasyWorship database...',
          click: async () => { await importEasyWorshipHandler(); }
        },
        {
          label: 'Import VideoPsalm database...',
          click: () => { mainWindow && mainWindow.webContents.send('vp-start-import'); }
        },
        { type: 'separator' },
        {
          label: 'Save Schedule...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => { if (mainWindow) mainWindow.webContents.send('schedule:save'); }
        },
        {
          label: 'Load Schedule...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => { if (mainWindow) mainWindow.webContents.send('schedule:load'); }
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
        ...(process.env.NODE_ENV !== 'production' ? [
          { role: 'toggledevtools' },
          {
            label: 'Open Speech Debugger',
            click: () => { openSpeechDebuggerWindow(); }
          }
        ] : [])
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
          label: 'Open Report Viewer',
          click: async () => {
            await openReportViewerWindow();
          }
        },
        {
          label: 'Open Report File...',
          click: async () => {
            const { filePath } = await dialog.showOpenDialog({
              title: 'Open Liturgia Report',
              filters: [{ name: 'Liturgia Report', extensions: ['litrep'] }],
              properties: ['openFile']
            });
            if (filePath) await openReportViewerWindow(filePath);
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

async function openSpeechDebuggerWindow() {
  if (speechWindow && !speechWindow.isDestroyed()) {
    speechWindow.show();
    speechWindow.focus();
    return speechWindow;
  }

  destroyAiSpeechWorkerWindow({ suppressRestart: true });

  speechWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    title: 'Liturgia Speech Debugger',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'speech', 'desktop', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  speechWindow.setMenuBarVisibility(false);
  speechWindow.on('closed', () => {
    speechWindow = null;
    aiWorkerSuppressed = false;
    if (aiEnabled && !launchSpeechUi) {
      setTimeout(() => ensureAiSpeechWorkerWindow(), 800);
    }
  });
  const entryPoint = path.join(__dirname, 'speech', 'index.html');
  try {
    await speechWindow.loadFile(entryPoint);
  } catch (err) {
    console.error('[speech-window] failed to load UI:', err);
  }

  if (speechWindow && speechWindow.webContents) {
    speechWindow.webContents.once('did-finish-load', () => hydrateWindowWithAiRuntime(speechWindow));
  }

  return speechWindow;
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

// Handle multiple instance attempts - prevent duplicate instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running - just quit silently
  // (we can't show a dialog here because app isn't ready yet)
  console.log('[main] Another instance is already running, exiting');
  app.quit();
  process.exit(0);
} else {
  // Handle deep link URLs like liturgia://auth?token=xyz
  function handleDeepLink(url) {
    try {
      const urlObj = new URL(url);
      const token = urlObj.searchParams.get('token');
      if (token && mainWindow && !mainWindow.isDestroyed()) {
        console.log('[main] Handling deep link with token');
        // Send token to renderer via IPC
        try {
          mainWindow.webContents.send('deep-link:auth-token', { token });
        } catch (err) {
          console.warn('[main] Failed to send deep link token to renderer', err);
        }
      }
    } catch (err) {
      console.warn('[main] Failed to parse deep link', url, err);
    }
  }

  // This is the primary instance
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    console.log('[main] Second instance attempt, bringing main window to front');
    // Check for deep link in commandLine (Windows)
    const deepLink = commandLine.find(arg => arg.startsWith('liturgia://'));
    if (deepLink) {
      handleDeepLink(deepLink);
    }
    // Check for .litsch schedule file in commandLine (Windows - file association)
    const scheduleFile = commandLine.find(arg => arg.endsWith('.litsch'));
    if (scheduleFile && fs.existsSync(scheduleFile)) {
      sendScheduleFileToRenderer(scheduleFile);
    }
    // Check for .litsong song file in commandLine (Windows - file association)
    const songFile = commandLine.find(arg => arg.endsWith('.litsong'));
    if (songFile && fs.existsSync(songFile)) {
      sendSongFileToRenderer(songFile);
    }
    // Check for .litrep report file in commandLine (Windows - file association)
    const repFile = commandLine.find(arg => arg.endsWith('.litrep'));
    if (repFile && fs.existsSync(repFile)) {
      openReportViewerWindow(repFile);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Handle open-url event (macOS - when app is running)
  app.on('open-url', (event, url) => {
    event.preventDefault();
    console.log('[main] open-url event:', url);
    if (url.startsWith('liturgia://')) {
      handleDeepLink(url);
    }
  });

  // Handle open-file event (macOS - when a .litsch, .litsong, or .litrep file is opened)
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (filePath.endsWith('.litsch')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendScheduleFileToRenderer(filePath);
      } else {
        pendingScheduleFile = filePath;
      }
    } else if (filePath.endsWith('.litsong')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendSongFileToRenderer(filePath);
      } else {
        pendingSongFile = filePath;
      }
    } else if (filePath.endsWith('.litrep')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        openReportViewerWindow(filePath);
      } else {
        pendingReportFile = filePath;
      }
    }
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') { callback(true); return; }
    callback(false);
  });

  // Sanitize songs.json before the window opens: strip \r chars introduced by
  // old EasyWorship imports (stored as \n\r\n instead of plain \n)
  try {
    const songsPath = path.join(getUserDataDir(app), 'songs.json');
    if (fs.existsSync(songsPath)) {
      const raw = fs.readFileSync(songsPath, 'utf8');
      const songs = JSON.parse(raw);
      let dirty = false;
      for (const song of songs) {
        if (!Array.isArray(song.lyrics)) continue;
        for (const section of song.lyrics) {
          if (!section.text) continue;
          const original = section.text;
          // 1. Normalize all line endings to \n
          let text = section.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          // 2. Collapse runs of blank lines within a section down to a single \n
          //    (EW import produced \n\r\n between lines; after \r removal → \n\n)
          text = text.replace(/\n{2,}/g, '\n');
          // 3. Trim leading/trailing whitespace from the whole block and each line
          text = text.split('\n').map(l => l.trim()).filter((l, i, arr) => {
            // Remove leading/trailing blank lines but keep internal ones that
            // survive (none should after step 2, but be safe)
            if (i === 0 || i === arr.length - 1) return l !== '';
            return true;
          }).join('\n');
          if (text !== original) {
            section.text = text;
            dirty = true;
          }
        }
        // Also clean title / author whitespace anomalies from EW
        for (const key of ['title', 'author']) {
          if (typeof song[key] === 'string') {
            const cleaned = song[key].replace(/\r/g, '').trim();
            if (cleaned !== song[key]) { song[key] = cleaned; dirty = true; }
          }
        }
      }
      if (dirty) {
        const tmp = songsPath + '.bak';
        fs.copyFileSync(songsPath, tmp); // keep one backup just in case
        fs.writeFileSync(songsPath, JSON.stringify(songs, null, 2), 'utf8');
        console.log('[startup] songs.json sanitized (CRLF / blank lines fixed)');
      }
    }
  } catch (e) {
    console.warn('[startup] songs.json sanitize failed (non-fatal):', e.message || e);
  }

  // Register custom protocol handler for deep links (magic link from email)
  if (process.defaultApp) {
    // Development mode: register the protocol handler
    if (process.platform === 'win32') {
      app.setAsDefaultProtocolClient('liturgia', process.execPath, [path.resolve(process.argv[1])]);
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      app.setAsDefaultProtocolClient('liturgia');
    }
  } else {
    // Production mode (packaged)
    app.setAsDefaultProtocolClient('liturgia');
  }

  // Check if a .litsch schedule file was passed as a command-line argument (Windows, first launch)
  if (!pendingScheduleFile) {
    const scheduleArg = process.argv.find(a => a.endsWith('.litsch'));
    if (scheduleArg && fs.existsSync(scheduleArg)) {
      pendingScheduleFile = scheduleArg;
    }
  }
  // Check if a .litsong song file was passed as a command-line argument (Windows, first launch)
  if (!pendingSongFile) {
    const songArg = process.argv.find(a => a.endsWith('.litsong'));
    if (songArg && fs.existsSync(songArg)) {
      pendingSongFile = songArg;
    }
  }
  // Check if a .litrep report file was passed as a command-line argument (Windows, first launch)
  if (!pendingReportFile) {
    const repArg = process.argv.find(a => a.endsWith('.litrep'));
    if (repArg && fs.existsSync(repArg)) {
      pendingReportFile = repArg;
    }
  }

  await createWindow();

  if (speechSidecarManager) {
    if (aiEnabled) {
      try {
        await speechSidecarManager.ensureRunning();
      } catch (err) {
        console.warn('[speech-sidecar] ensure running failed:', err && err.message ? err.message : err);
      }
      // If the sidecar still isn't running (e.g., Python --version timed out on a cold
      // Windows start due to Defender scanning), queue a retry that bypasses backoff.
      // This mirrors what the "restart" button in settings does automatically.
      if (!speechSidecarManager.getStatus().processRunning) {
        setTimeout(() => {
          if (speechSidecarManager && aiEnabled) {
            console.log('[speech-sidecar] Startup retry: process not running after initial attempt, retrying...');
            speechSidecarManager.clearSpawnBackoff();
            speechSidecarManager.ensureRunning().catch(err => {
              console.warn('[speech-sidecar] startup retry failed:', err && err.message ? err.message : err);
            });
          }
        }, 4000);
      }
      startSidecarWatchdog();
    } else {
      latestSidecarStatus = decorateSidecarStatus(speechSidecarManager.getStatus());
    }
  }

  if (aiEnabled && !launchSpeechUi) {
    ensureAiSpeechWorkerWindow();
  }

  if (launchSpeechUi) {
    setTimeout(() => { openSpeechDebuggerWindow(); }, 500);
  }
  
  // Start remote control server if enabled (UAC prompt only on first time)
  try {
    let settings = {};
    try { settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')); } catch {}
    
    // Start local remote server if enabled
    if (settings.remote && settings.remote.enabled) {
      try {
        remoteServer = new RemoteServer(app, mainWindow, handlePairRequest);
        // Delay start slightly to avoid Bonjour service name conflicts
        setTimeout(() => {
          try {
            remoteServer.start(settings.remote.port || 39847);
          } catch (e) {
            console.error('[remote] Failed to start:', e.message);
          }
        }, 500);
      } catch (e) {
        console.error('[remote] Failed to initialize:', e.message);
      }
    }
    
    // Start cloud relay if enabled (uses existing account auth token from secure storage)
    if (settings.relay && settings.relay.enabled) {
      try {
        // Get token from secure storage (same as renderer.js does)
        let token = null;
        try {
          if (keytar) {
            token = await keytar.getPassword('Liturgia', 'auth-token');
          }
        } catch (e) {
          console.warn('[relay] Keytar error, trying settings fallback:', e.message);
        }
        // Fallback to settings.auth.token if keytar fails
        if (!token && settings.auth && settings.auth.token) {
          token = settings.auth.token;
        }
        
        if (token) {
          relayClient = new RelayClient('https://jacqueb.me/liturgia/relay', token);
          
          relayClient.on('message', (message) => {
            if (mainWindow && mainWindow.webContents) {
              mainWindow.webContents.send('remote-command', message);
            }
          });
          
          const deviceName = (settings.relay && settings.relay.deviceName && settings.relay.deviceName.trim()) || 'Liturgia Desktop';
          const success = await relayClient.register(deviceName);
          if (success) {
            console.log('[relay] Auto-started from settings');
          } else {
            console.warn('[relay] Auto-start registration failed');
          }
        } else {
          console.warn('[relay] Enabled but no auth token found');
        }
      } catch (e) {
        console.error('[relay] Failed to auto-start:', e.message);
        // Don't crash the app if relay fails to start
      }
    }

    // Auto-start per-display network servers if enabled
    if (settings.displaySettings) {
      setTimeout(() => {
        for (const [displayIdStr, ds] of Object.entries(settings.displaySettings)) {
          const nd = ds && ds.networkDisplay;
          if (nd && nd.enabled) {
            const displayId = parseInt(displayIdStr, 10);
            const port = nd.port || 7777;
            try { startDisplayNetServer(displayId, port); }
            catch (e) { console.error('[network-display] Failed to auto-start for display', displayId, ':', e.message); }
          }
        }
      }, 600);
    }
  } catch (e) { console.warn('Failed to start remote/relay:', e); }
  
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
        // Always defer through did-finish-load so the renderer's ipcRenderer.on('update-available')
        // listener is guaranteed to be registered before we deliver the message.
        // (The renderer JS runs after did-finish-load, so sending immediately risks losing the event.)
        pendingUpdate = res;
        if (mainWindow.webContents.isLoading()) {
          mainWindow.webContents.once('did-finish-load', () => {
            setTimeout(() => {
              try { if (pendingUpdate && mainWindow && mainWindow.webContents) { mainWindow.webContents.send('update-available', pendingUpdate); pendingUpdate = null; } } catch(e) {}
            }, 500); // small delay so renderer scripts fully initialise
          });
        } else {
          // Window already loaded — still use a short timeout so any deferred renderer
          // setup (e.g. dynamic ipcRenderer.on calls) finishes before we send.
          setTimeout(() => {
            try { if (pendingUpdate && mainWindow && mainWindow.webContents) { mainWindow.webContents.send('update-available', pendingUpdate); pendingUpdate = null; } } catch(e) {}
          }, 500);
        }
      }
    }
  } catch (e) { console.warn('Startup update check failed', e); }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  console.log('[main] before-quit: starting cleanup');
  destroyAiSpeechWorkerWindow();
  // Stop per-display network servers
  if (displayNetServers.size) {
    console.log('[main] Stopping display network servers on app quit');
    stopAllDisplayNetServers();
  }
  // Clean up remote server
  if (remoteServer) {
    console.log('[main] Stopping remote server on app quit');
    remoteServer.stop();
    remoteServer = null;
  }
  // Clean up relay client (give it 500ms to deregister)
  if (relayClient) {
    console.log('[main] Stopping relay client on app quit');
    relayClient.stop();
    relayClient = null;
    // Small delay to allow deregister to complete
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (speechSidecarWatchdog) {
    clearInterval(speechSidecarWatchdog);
    speechSidecarWatchdog = null;
  }
  if (speechSidecarManager) {
    try { 
      console.log('[main] Disposing speech sidecar manager');
      speechSidecarManager.dispose(); 
      console.log('[main] Speech sidecar disposed');
      // Give the process time to actually die (especially on Windows with taskkill)
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) { 
      console.warn('[speech-sidecar] dispose failed', err && err.message ? err.message : err); 
    }
  }
  console.log('[main] before-quit: cleanup complete');
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

    // Fetch all releases and collect changelog entries for every version newer than current.
    let changelog = [];
    try {
      const allApi = 'https://api.github.com/repos/Jacqueb-1337/liturgia-2/releases?per_page=100';
      const ra = await fetchFn(allApi, { headers: { 'User-Agent': 'Liturgia-Updater' } });
      if (ra.ok) {
        const all = await ra.json();
        changelog = all
          .filter(rel => semverCompare((rel.tag_name || rel.name || '').toString(), current) > 0)
          .sort((a, b) => semverCompare(
            (b.tag_name || b.name || '').toString(),
            (a.tag_name || a.name || '').toString()
          ))
          .map(rel => ({ version: (rel.tag_name || rel.name || '').toString(), body: rel.body || '' }));
      }
    } catch (e) { console.warn('checkForUpdates: failed to fetch all releases', e); }

    const result = { ok:true, updateAvailable, latest, current, html_url: j.html_url, body: j.body, assets, changelog };
    // Also cache the last check result (useful if renderer requests it later before another check)
    lastUpdateCheck = result;
    return result;
  } catch (e) { console.warn('checkForUpdates error', e); return { ok:false, error: String(e) }; }
}

// Expose manual check via IPC
ipcMain.handle('check-for-updates-manual', async () => {
  return await checkForUpdates();
});

// Settings window can ask main window to show the full update/download modal
ipcMain.on('show-update-modal', (event, res) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      mainWindow.webContents.send('update-available', res);
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (e) { console.warn('show-update-modal relay error', e); }
});

// Renderer can ask for any pending update that was found before it was ready
ipcMain.handle('get-pending-update', async () => {
  return pendingUpdate || lastUpdateCheck || { ok:false };
});

// Check if Python and AI dependencies are available
ipcMain.handle('check-python-available', async () => {
  try {
    // If sidecar is running, Python is definitely available
    if (speechSidecarManager && speechSidecarManager.getStatus && speechSidecarManager.getStatus().processRunning && speechSidecarManager.getStatus().modelReady) {
      console.log('[check-python-available] Sidecar is running, Python is available');
      return { available: true, pythonFound: true };
    }
    
    // Otherwise, run a quick Python version check
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const isWindows = process.platform === 'win32';
    const candidates = ['python', 'python3'];
    if (isWindows) candidates.push('py');
    
    for (const cmd of candidates) {
      try {
        const { stdout } = await execAsync(`"${cmd}" --version`, { timeout: 1000, encoding: 'utf8' });
        console.log(`[check-python-available] Found ${cmd}: ${stdout.trim()}`);
        return { available: true, pythonFound: true, pythonVersion: stdout.trim() };
      } catch {}
    }
    
    return { available: false, pythonFound: false };
  } catch (e) {
    console.error('[check-python-available] error:', e);
    return { available: false, pythonFound: false, error: String(e) };
  }
});

// In-memory map of active downloads
const downloads = global.downloads = global.downloads || {};

// Download an update asset (renderer requests with a browser_download_url)
ipcMain.handle('download-update', async (event, { url }) => {
  try {
    const fetch = require('node-fetch');
    const { getTempPath } = require('./lib/paths');
    const tmpDir = getTempPath(app);
    const originalName = path.basename((url || '').split('?')[0]) || 'liturgia-update.exe';
    const timestamp = Date.now();
    const ext = path.extname(originalName);
    const nameWithoutExt = path.basename(originalName, ext);
    const name = `${nameWithoutExt}-${timestamp}${ext}`;
    const dest = path.join(tmpDir, name);
    
    try {
      const files = fs.readdirSync(tmpDir);
      const oldInstallers = files.filter(f => 
        f.startsWith('liturgia') && 
        f.endsWith('.exe') && 
        /liturgia.*-\d+\.exe$/.test(f)
      );
      oldInstallers.forEach(f => {
        try {
          const filePath = path.join(tmpDir, f);
          fs.unlinkSync(filePath);
          console.log(`[update] Cleaned up old installer: ${f}`);
        } catch (e) {
          console.log(`[update] Could not delete ${f}:`, e.message);
        }
      });
    } catch (e) {
      console.log('[update] Could not clean old installers:', e.message);
    }
    
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

// Run the downloaded installer (spawn and quit app)
ipcMain.handle('run-installer', async (event, file) => {
  try {
    if (!fs.existsSync(file)) return { ok:false, error:'File not found' };
    
    const { spawn } = require('child_process');
    spawn(file, [], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    
    setTimeout(() => {
      app.quit();
    }, 500);
    
    return { ok:true };
  } catch (e) { return { ok:false, error: String(e) }; }
});

// Open external URLs
ipcMain.handle('open-external-url', async (event, { url }) => {
  try {
    if (!url || typeof url !== 'string') return { ok:false, error:'Invalid URL' };
    await shell.openExternal(url);
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

function createLiveWindowForDisplay(display) {
  if (liveWindows.has(display.id)) {
    const existing = liveWindows.get(display.id);
    if (!existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
  }
  const win = new BrowserWindow({
    parent: null,
    title: 'Liturgia • Worship Live',
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
      contextIsolation: false,
      webviewTag: true
    }
  });
  win._liveReady = false;
  win._livePending = null; // buffers the last update-content payload before ready
  liveWindows.set(display.id, win);
  win.loadFile('live.html');
  win.once('ready-to-show', () => { win.show(); });
  win.on('closed', () => { liveWindows.delete(display.id); });
}

// When live.html has finished registering all its IPC listeners, flush any buffered content
ipcMain.on('live-window-ready', (event) => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed() && win.webContents === event.sender) {
      win._liveReady = true;
      if (win._livePending) {
        win.webContents.send('update-content', win._livePending);
        win._livePending = null;
      }
      break;
    }
  }
});

ipcMain.handle('create-live-window', async () => {
  const settingsPath = path.join(getUserDataDir(app), 'settings.json');
  let settings = {};
  try {
    const data = await fs.promises.readFile(settingsPath, 'utf8');
    settings = JSON.parse(data);
  } catch {}
  const displays = screen.getAllDisplays();
  // Support liveDisplays array; fall back to defaultDisplay or first display
  let targetIds = settings.liveDisplays;
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    const fallbackId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
    targetIds = fallbackId ? [fallbackId] : [];
  }
  for (const id of targetIds) {
    if (id <= 0) continue; // 0 = network-only entry, no physical window
    const display = displays.find(d => d.id == id) || displays[0];
    if (display) createLiveWindowForDisplay(display);
  }
});

ipcMain.handle('open-live-window-on-display', async (event, displayId) => {
  const displays = screen.getAllDisplays();
  const display = displays.find(d => d.id == displayId);
  if (display) createLiveWindowForDisplay(display);
});

ipcMain.handle('close-live-window-on-display', async (event, displayId) => {
  const win = liveWindows.get(displayId);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('get-live-window-display-ids', () => {
  return [...liveWindows.keys()];
});

ipcMain.handle('close-live-window', () => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
});

ipcMain.on('update-live-window', (event, data) => {
  const overrides = data._displayStyleOverrides || {};
  for (const [displayId, win] of liveWindows.entries()) {
    if (win.isDestroyed()) continue;
    const displayData = overrides[String(displayId)]
      ? mergeStylesForDisplay(data, overrides[String(displayId)])
      : data;
    if (win._liveReady) {
      win.webContents.send('update-content', displayData);
    } else {
      // Window is still loading — buffer so it gets the content the moment it's ready
      win._livePending = displayData;
    }
  }
  // Relay to per-display network clients
  for (const [displayId, ns] of displayNetServers.entries()) {
    const displayData = overrides[String(displayId)]
      ? mergeStylesForDisplay(data, overrides[String(displayId)])
      : data;
    ns.lastPayload = displayData;
    ns.lastMode = 'normal';
    if (ns.server) broadcastToDisplayClients(ns, { type: 'content', data: displayData });
  }
});

ipcMain.on('clear-live-text', () => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('clear-live-text');
  }
});

ipcMain.on('show-live-text', () => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('show-live-text');
  }
});

ipcMain.on('set-live-black', () => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('set-live-black');
  }
});

ipcMain.on('reset-live-canvas', () => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('reset-live-canvas');
  }
});

// Forward unified mode messages to live window
ipcMain.on('set-live-mode', (event, mode) => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('set-live-mode', mode);
  }
  // Relay to per-display network clients
  for (const ns of displayNetServers.values()) { ns.lastMode = mode; }
  broadcastToAllNetDisplays({ type: 'mode', mode });
});

// Forward captured JPEG frames from preview webview to all live windows
ipcMain.on('mirror-frame', (event, jpegBuffer) => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('mirror-frame', jpegBuffer);
  }
});

// Tell all live windows to hide the mirror (e.g. switching to another item)
ipcMain.on('website-mirror-stop', () => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('website-mirror-stop');
  }
});

// Legacy — no-ops so no errors if old sends arrive
ipcMain.on('website-navigate', () => {});
ipcMain.on('website-clear', () => {});

// Forward video live control commands (pause/play/seek/speed) to live windows
ipcMain.on('video-live-control', (event, data) => {
  for (const win of liveWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('video-live-control', data);
  }
});

// Move the live window to a different display (close all existing, open on new display)
ipcMain.handle('set-live-display', async (event, displayId) => {
  // Close all existing live windows
  for (const [id, win] of liveWindows.entries()) {
    if (!win.isDestroyed()) win.close();
  }
  liveWindows.clear();
  // Open a new live window on the requested display
  const displays = screen.getAllDisplays();
  const display = displays.find(d => d.id == displayId) || displays[0];
  if (display) {
    createLiveWindowForDisplay(display);
    // Persist the chosen display as default using atomic write
    try {
      const data = await fs.promises.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(data);
      settings.defaultDisplay = display.id;
      await writeSettingsSafe(settings);
    } catch (e) { /* ignore settings save error */ }
  }
  return { ok: true };
});

// Text Styling Window
ipcMain.on('open-style-window', (event, data) => {
  if (styleWindow && !styleWindow.isDestroyed()) {
    // Bring existing window to front and re-send init data
    styleWindow.focus();
    styleWindow.webContents.send('style-window-init', data);
    return;
  }
  styleWindow = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 360,
    minHeight: 500,
    title: 'Text Styling',
    parent: mainWindow,
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  styleWindow.setMenuBarVisibility(false);
  styleWindow.loadFile('style-window.html');
  styleWindow.once('ready-to-show', () => {
    styleWindow.show();
    styleWindow.webContents.send('style-window-init', data);
  });
  styleWindow.on('closed', () => { styleWindow = null; });
});

// Forward style changes from style-window back to main renderer
ipcMain.on('styles-changed', (event, newStyles) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('styles-updated', newStyles);
  }
});

// Forward per-display style changes back to main renderer
ipcMain.on('styles-changed-display', (event, { displayId, styles }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('display-styles-updated', { displayId, styles });
  }
});

// Forward per-display setting changes (e.g. perDisplayStylesEnabled) to main renderer
ipcMain.on('display-setting-changed', (event, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('display-setting-changed', data);
  }
});

// ── Network Display WebSocket Server ────────────────────────────────────────

/**
 * Encode a text string as a WebSocket frame (server→client, unmasked, opcode 0x1).
 */
function encodeWsFrame(data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x81; // FIN + text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Handle inbound WebSocket frames from a browser client.
 * We only need to handle ping→pong and close→close; all other frames are ignored.
 */
function handleWsInbound(socket, buf) {
  try {
    let offset = 0;
    while (offset + 2 <= buf.length) {
      const b0 = buf[offset], b1 = buf[offset + 1];
      const opcode = b0 & 0x0f;
      const masked  = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      offset += 2;
      if (payloadLen === 126) {
        if (offset + 2 > buf.length) break;
        payloadLen = buf.readUInt16BE(offset); offset += 2;
      } else if (payloadLen === 127) {
        if (offset + 8 > buf.length) break;
        // Only read the lower 32 bits (payloads ≤ 4 GB)
        payloadLen = buf.readUInt32BE(offset + 4); offset += 8;
      }
      const maskKey = masked ? buf.slice(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (offset + payloadLen > buf.length) break;
      const payload = Buffer.from(buf.slice(offset, offset + payloadLen));
      offset += payloadLen;
      if (masked && maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      if (opcode === 0x9) {
        // Ping → reply with Pong
        const pong = Buffer.allocUnsafe(2 + payload.length);
        pong[0] = 0x8a; pong[1] = payload.length;
        payload.copy(pong, 2);
        try { socket.write(pong); } catch (_) {}
      } else if (opcode === 0x8) {
        // Close → echo close frame and destroy
        try { socket.write(Buffer.from([0x88, 0x00])); } catch (_) {}
        socket.destroy();
      }
    }
  } catch (_) {}
}

/**
 * Broadcast to all WebSocket clients of one display server.
 */
function broadcastToDisplayClients(ns, obj) {
  if (!ns.clients.size) return;
  const frame = encodeWsFrame(JSON.stringify(obj));
  for (const socket of [...ns.clients]) {
    try { socket.write(frame); }
    catch (_) { try { socket.destroy(); } catch (__) {} ns.clients.delete(socket); }
  }
}

/**
 * Broadcast to all active per-display network servers.
 */
function broadcastToAllNetDisplays(obj) {
  for (const ns of displayNetServers.values()) {
    if (ns.server) broadcastToDisplayClients(ns, obj);
  }
}

/**
 * Start (or restart) the HTTP + WebSocket network display server.
 * @param {number} port
 */
function startDisplayNetServer(displayId, port) {
  if (displayNetServers.has(displayId)) stopDisplayNetServer(displayId);

  const ns = { server: null, clients: new Set(), port, lastPayload: null, lastMode: 'normal', lastError: null };
  displayNetServers.set(displayId, ns);

  const receiverHtmlPath = path.join(__dirname, 'network-receiver.html');

  const server = http.createServer((req, res) => {
    let pathname = '/';
    let searchParams = new URLSearchParams();
    try {
      const u = new URL(req.url, 'http://localhost');
      pathname = u.pathname;
      searchParams = u.searchParams;
    } catch (_) {}

    if (pathname === '/' || pathname === '/index.html') {
      fs.readFile(receiverHtmlPath, 'utf8', (err, data) => {
        if (err) { res.writeHead(404); res.end('Receiver page not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
      return;
    }

    if (pathname === '/media') {
      const filePath = searchParams.get('path');
      if (!filePath) { res.writeHead(400); res.end('Missing path parameter'); return; }

      // Resolve and validate the path
      const resolved = path.resolve(filePath);

      // Block directory traversal by ensuring the resolved path is absolute
      // and ends with a known media extension
      const ext = path.extname(resolved).toLowerCase().slice(1);
      const allowedExts = ['jpg','jpeg','png','gif','webp','bmp','mp4','webm','ogg','mov','avi'];
      if (!allowedExts.includes(ext)) {
        res.writeHead(403); res.end('Forbidden file type'); return;
      }

      fs.stat(resolved, (err, stat) => {
        if (err || !stat.isFile()) { res.writeHead(404); res.end('File not found'); return; }

        const mimeMap = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
          mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
          mov: 'video/quicktime', avi: 'video/x-msvideo'
        };
        const mime = mimeMap[ext] || 'application/octet-stream';

        // Support Range requests so video seeking works in the browser
        const rangeHeader = req.headers['range'];
        if (rangeHeader) {
          const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const start     = parseInt(m[1], 10);
            const end       = m[2] ? parseInt(m[2], 10) : stat.size - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
              'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges':  'bytes',
              'Content-Length': chunkSize,
              'Content-Type':   mime,
            });
            fs.createReadStream(resolved, { start, end }).pipe(res);
            return;
          }
        }

        res.writeHead(200, {
          'Content-Type':   mime,
          'Content-Length': stat.size,
          'Accept-Ranges':  'bytes',
          'Cache-Control':  'no-cache',
        });
        fs.createReadStream(resolved).pipe(res);
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.on('upgrade', (req, socket, _head) => {
    // Only accept WebSocket upgrades on the root path
    if (req.url !== '/' && req.url !== '') { socket.destroy(); return; }

    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey) { socket.destroy(); return; }

    const acceptKey = crypto
      .createHash('sha1')
      .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ].join('\r\n'));

    socket.setKeepAlive(true, 30000);
    ns.clients.add(socket);

    // Immediately sync new client to current state
    if (ns.lastPayload) {
      try {
        socket.write(encodeWsFrame(JSON.stringify({
          type: 'sync', payload: ns.lastPayload, mode: ns.lastMode
        })));
      } catch (_) {}
    }

    socket.on('close', () => ns.clients.delete(socket));
    socket.on('error', () => {
      try { socket.destroy(); } catch (_) {}
      ns.clients.delete(socket);
    });
    socket.on('data', (buf) => handleWsInbound(socket, buf));
  });

  server.on('error', (e) => {
    let msg;
    if (e.code === 'EADDRINUSE')      msg = `Port ${port} is already in use. Choose a different port in Settings > Display.`;
    else if (e.code === 'EACCES')     msg = `Permission denied for port ${port}. Use a port above 1023.`;
    else                              msg = `Network display error: ${e.message}`;
    console.error('[network-display]', msg);
    ns.lastError = msg;
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('display-net-error', { displayId, error: msg });
  });

  server.listen(port, '0.0.0.0', () => {
    ns.port      = port;
    ns.server    = server;
    ns.lastError = null;
    console.log(`[network-display] Display ${displayId} listening on port ${port}`);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('display-net-error', { displayId, error: null });
  });
}

/**
 * Gracefully close the network display server for a specific display.
 */
function stopDisplayNetServer(displayId) {
  const ns = displayNetServers.get(displayId);
  if (!ns) return;
  for (const socket of [...ns.clients]) {
    try { socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])); socket.destroy(); } catch (_) {}
  }
  ns.clients.clear();
  if (ns.server) {
    try { ns.server.close(); } catch (_) {}
    try { if (ns.server.closeAllConnections) ns.server.closeAllConnections(); } catch (_) {}
    ns.server = null;
  }
  displayNetServers.delete(displayId);
}

function stopAllDisplayNetServers() {
  for (const displayId of [...displayNetServers.keys()]) {
    stopDisplayNetServer(displayId);
  }
}

// IPC: per-display network display start/stop/status
ipcMain.handle('display-net-start', async (_event, displayId, port) => {
  const p = (typeof port === 'number' && port > 0) ? port : 7777;
  startDisplayNetServer(displayId, p);
  return { ok: true, port: p };
});

ipcMain.handle('display-net-stop', async (_event, displayId) => {
  stopDisplayNetServer(displayId);
  return { ok: true };
});

ipcMain.handle('get-display-net-status', async (_event, displayId) => {
  let localIp = '127.0.0.1';
  try {
    const ifaces = os.networkInterfaces();
    outer: for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break outer; }
      }
    }
  } catch (_) {}
  const ns = displayNetServers.get(displayId);
  const running = !!(ns && ns.server);
  const port = ns ? ns.port : 7777;
  return { running, port, url: running ? `http://${localIp}:${port}` : null, lastError: ns ? (ns.lastError || null) : null };
});
