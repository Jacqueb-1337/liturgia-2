// renderer.js

const fs = require('fs');
const path = require('path');
const { ipcRenderer, shell } = require('electron');
// Secure storage API using IPC to main (uses keytar in main if available)
const secure = {
  async getToken() { try { return await ipcRenderer.invoke('secure-get-token'); } catch (e) { console.error('secure get token error', e); return null; } },
  async setToken(token) { try { return await ipcRenderer.invoke('secure-set-token', token); } catch (e) { console.error('secure set token error', e); return false; } },
  async deleteToken() { try { return await ipcRenderer.invoke('secure-delete-token'); } catch (e) { console.error('secure delete token error', e); return false; } }
};
let fetch;
if (typeof window !== 'undefined' && window.fetch) {
  fetch = window.fetch.bind(window);
} else {
  try {
    fetch = require('node-fetch');
  } catch (e) {
    console.warn('node-fetch not available and no global fetch available');
    fetch = null;
  }
}
const {
  ensureBibleJson,
  loadAllVersesFromDisk,
  fetchChapter,
  downloadRemainingChapters
} = require('./scriptureData');
const { renderWindow } = require('./virtualList');
const { safeStatus } = require('./uiHelpers');
const {
  VERSION, CDN_BASE, ITEM_HEIGHT, WINDOW_SIZE, BUFFER, BOOKS, CHAPTER_COUNTS, VERSE_COUNTS, BIBLE_STORAGE_DIR
} = require('./constants');

let allVerses = [];
let allSongs = [];
let filteredSongs = []; // For search results

// Safety stub for showPopover: queues calls if popover isn't initialized yet
if (typeof window !== 'undefined' && !window.showPopover) {
  const _showPopoverStub = function(name, key) {
    console.warn('showPopover called before popover initialized:', name, key);
    document.addEventListener('DOMContentLoaded', () => {
      // If real showPopover replaced the stub, call it
      if (window.showPopover && window.showPopover !== _showPopoverStub) {
        try { window.showPopover(name, key); } catch (e) { console.warn('Deferred showPopover failed', e); }
      }
    }, { once: true });
  };
  window.showPopover = _showPopoverStub;
}

let currentSearchQuery = ''; // Track current search query for highlighting
let selectedSongVerseIndex = null; // Track selected verse within a song
let selectedIndices = [];
let selectedSongIndices = [];
let currentTab = 'verses'; // 'verses' or 'songs'
let songVerseViewMode = 'full'; // 'full' or 'blocks' - controls how song is displayed
let anchorIndex = null;
let currentBibleFile = null; // e.g. 'en_kjv.json'
let previewStyles = { verseNumber: '', verseText: '', verseReference: '' };
let liveMode = false;
let clearMode = false;
let blackMode = false;

// Listen for import notifications from main process
ipcRenderer.on('songs-imported', (event, info) => {
  const added = info && info.addedCount ? info.addedCount : 0;
  const total = info && info.totalFound ? info.totalFound : 0;
  alert(`EasyWorship import complete: found ${total} song(s), imported ${added} new song(s).`);
  // Refresh songs list from disk
  loadSongs();
});

ipcRenderer.on('easyworship-import-disabled', (event, info) => {
  if (info && info.reason === 'sql-missing') {
    alert('EasyWorship import is disabled: sql.js is not installed. Run "npm install" in the app directory and restart.');
  } else {
    alert('EasyWorship import is disabled.');
  }
});
let scheduleItems = []; // Array of { indices: [], expanded: false, selectedVerses: [] }
let selectedScheduleItems = []; // Indices of selected schedule items for multi-select
let anchorScheduleIndex = null; // For shift-click range selection
let focusedScheduleItem = null; // { type: 'header'|'verse', itemIndex: number, verseIndex?: number }
let allMedia = []; // Media files
let selectedMediaIndex = null; // Currently selected media item
let defaultBackgrounds = { songs: null, verses: null }; // Default background images

// Load settings on startup and apply dark theme if needed
async function loadAndApplySettings() {
  const settings = await ipcRenderer.invoke('load-settings');
  if (settings && settings.darkTheme) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
  if (settings && settings.previewStyles) {
    previewStyles = settings.previewStyles;
    applyPreviewStyles();
  }
}

function applyPreviewStyles() {
  // Create/update a style tag for global preview CSS
  const styleId = 'preview-styles';
  let styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  let css = '';
  if (previewStyles.verseNumber) css += `#verse-number { ${atob(previewStyles.verseNumber)} }\n`;
  if (previewStyles.verseText) css += `#verse-text { ${atob(previewStyles.verseText)} }\n`;
  if (previewStyles.verseReference) css += `#verse-reference { ${atob(previewStyles.verseReference)} }\n`;
  // Song preview styles
  if (previewStyles.songTitle) css += `#song-title { ${atob(previewStyles.songTitle)} }\n`;
  if (previewStyles.songText) css += `#song-text { ${atob(previewStyles.songText)} }\n`;
  if (previewStyles.songReference) css += `#song-reference { ${atob(previewStyles.songReference)} }\n`;
  styleEl.textContent = css;

  // Also apply inline styles to any existing preview/live elements (keeps both behaviors)
  Object.keys(previewStyles).forEach(key => {
    const el = document.getElementById(key.toLowerCase().replace('verse', ''));
    if (el && previewStyles[key]) {
      el.style.cssText = atob(previewStyles[key]);
    }
  });
  Object.keys(previewStyles).forEach(key => {
    const liveEl = document.getElementById('live-' + key.toLowerCase().replace('verse', ''));
    if (liveEl && previewStyles[key]) {
      liveEl.style.cssText = atob(previewStyles[key]);
    }
  });
}

// Parse base64-encoded CSS and return allowed canvas style properties
function parseCanvasStyleFromB64(b64) {
  if (!b64) return {};
  try {
    const css = atob(b64).toLowerCase();
    // Remove font-size/line-height/font shorthand (not allowed)
    const cleaned = css.replace(/font-size\s*:\s*[^;]+;?/gi, '').replace(/line-height\s*:\s*[^;]+;?/gi, '').replace(/font\s*:\s*[^;]+;?/gi, '');
    const res = {};
    const colorMatch = cleaned.match(/color\s*:\s*([^;]+)\s*;?/i);
    if (colorMatch) res.color = colorMatch[1].trim();
    const weightMatch = cleaned.match(/font-weight\s*:\s*(bold|[6-9]00)\s*;?/i);
    if (weightMatch) res.fontWeight = 'bold';
    const italicMatch = cleaned.match(/font-style\s*:\s*(italic)\s*;?/i);
    if (italicMatch) res.fontStyle = 'italic';
    return res;
  } catch (e) {
    return {};
  }
}

function getCanvasStylesFor(type) {
  // type: 'verse' or 'song'
  const map = {};
  if (type === 'verse') {
    map.text = parseCanvasStyleFromB64(previewStyles.verseText);
    map.number = parseCanvasStyleFromB64(previewStyles.verseNumber);
    map.reference = parseCanvasStyleFromB64(previewStyles.verseReference);
  } else {
    map.text = parseCanvasStyleFromB64(previewStyles.songText || previewStyles.verseText);
    map.title = parseCanvasStyleFromB64(previewStyles.songTitle || previewStyles.verseNumber);
    map.reference = parseCanvasStyleFromB64(previewStyles.songReference || previewStyles.verseReference);
  }
  return map;
}

function setupPopover() {
  // Ensure popover DOM elements exist; if not, defer initialization until DOMContentLoaded
  const popover = document.getElementById('css-popover');
  const textarea = document.getElementById('css-textarea');
  const cssSelect = document.getElementById('css-select');
  const saveBtn = document.getElementById('css-save');
  const cancelBtn = document.getElementById('css-cancel');
  const errorDiv = document.getElementById('css-error');

  if (!popover || !textarea || !cssSelect || !saveBtn || !cancelBtn || !errorDiv) {
    console.warn('setupPopover: popover elements missing, deferring until DOMContentLoaded');
    document.addEventListener('DOMContentLoaded', () => {
      try { setupPopover(); } catch (e) { console.warn('setupPopover retry failed', e); }
    }, { once: true });
    return;
  }

  let currentElement = null;
  let _triggersAttached = false;
  function attachPopoverTriggers(retries = 6) {
    if (_triggersAttached) return;
    const vn = document.getElementById('verse-number');
    const vt = document.getElementById('verse-text');
    const vr = document.getElementById('verse-reference');
    if (vn || vt || vr) {
      if (vn) vn.addEventListener('click', () => showPopover('Verse Number', 'verseNumber'));
      if (vt) vt.addEventListener('click', () => showPopover('Verse Text', 'verseText'));
      if (vr) vr.addEventListener('click', () => showPopover('Verse Reference', 'verseReference'));
      _triggersAttached = true;
      return;
    }
    if (retries > 0) {
      // Retry after a short delay to allow UI to render
      setTimeout(() => attachPopoverTriggers(retries - 1), 250);
    } else {
      console.warn('attachPopoverTriggers: could not find trigger elements after retries — falling back to MutationObserver');
      // Fallback: observe DOM mutations and attach listeners when elements appear
      try {
        const observer = new MutationObserver((mutations, obs) => {
          const vn2 = document.getElementById('verse-number');
          const vt2 = document.getElementById('verse-text');
          const vr2 = document.getElementById('verse-reference');
          if (vn2 || vt2 || vr2) {
            if (vn2) vn2.addEventListener('click', () => showPopover('Verse Number', 'verseNumber'));
            if (vt2) vt2.addEventListener('click', () => showPopover('Verse Text', 'verseText'));
            if (vr2) vr2.addEventListener('click', () => showPopover('Verse Reference', 'verseReference'));
            _triggersAttached = true;
            obs.disconnect();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      } catch (obsErr) {
        console.warn('attachPopoverTriggers: MutationObserver fallback failed', obsErr);
      }
    }
  }
  // Attempt to attach immediately
  attachPopoverTriggers();

  function showPopover(name, key) {
    currentElement = key;
    document.getElementById('css-element-name').textContent = name;
    if (key === 'verseReference') {
      textarea.style.display = 'none';
      cssSelect.style.display = 'block';
      const currentCSS = previewStyles[key] ? atob(previewStyles[key]) : '';
      const fontSizeMatch = currentCSS.match(/font-size:\s*(\d*\.?\d+)em/);
      if (fontSizeMatch) {
        const size = parseFloat(fontSizeMatch[1]);
        if (size <= 0.7) cssSelect.value = 'small';
        else if (size <= 0.9) cssSelect.value = 'medium';
        else cssSelect.value = 'large';
      } else {
        cssSelect.value = 'medium'; // default
      }
    } else {
      cssSelect.style.display = 'none';
      textarea.style.display = 'block';
      textarea.value = previewStyles[key] ? atob(previewStyles[key]) : '';
    }
    errorDiv.textContent = '';
    popover.style.display = 'block';
  }

  // Expose showPopover globally so external UI (menus/buttons) can call it
  window.showPopover = showPopover;

  saveBtn.addEventListener('click', async () => {
    let css = '';
    if (currentElement === 'verseReference') {
      const sizeMap = { small: '0.6em', medium: '0.8em', large: '1.0em' };
      css = `font-size: ${sizeMap[cssSelect.value]};`;
    } else {
      css = textarea.value.trim();
      if (!validateCSS(css)) {
        errorDiv.textContent = 'Invalid CSS syntax.';
        return;
      }
      // Remove font-size and related properties to prevent overriding scaling
      css = css.replace(/font-size\s*:\s*[^;]+;?/gi, '');
      css = css.replace(/font\s*:\s*[^;]+;?/gi, '');
      css = css.replace(/line-height\s*:\s*[^;]+;?/gi, '');
    }
    if (css.trim() === '') {
      delete previewStyles[currentElement];
    } else {
      previewStyles[currentElement] = btoa(css);
    }
    applyPreviewStyles();
    await ipcRenderer.invoke('update-settings', { previewStyles });
    popover.style.display = 'none';
  });

  cancelBtn.addEventListener('click', () => {
    popover.style.display = 'none';
  });
}

function validateCSS(css) {
  // Simple validation: check for balanced quotes, no invalid chars
  try {
    // Try to parse as CSS
    const testEl = document.createElement('div');
    testEl.style.cssText = css;
    return true;
  } catch {
    return false;
  }
}

function toggleClear() {
  // If black mode is active, switch directly to clear on the live window (avoid flashing normal)
  if (blackMode) {
    blackMode = false;
    clearMode = true;

    // Update preview to show background without text
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        const width = window.currentContent.width;
        const height = window.currentContent.height;
        const contentWithoutText = { ...window.currentContent, number: '', text: '', reference: '' };
        renderToCanvas(liveCanvas, contentWithoutText, width, height);
      }
    }

    // Directly instruct live window to enter clear mode
    ipcRenderer.send('set-live-mode', 'clear');
    return;
  }

  clearMode = !clearMode;

  if (clearMode) {
    // Update preview to show background without text
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        const width = window.currentContent.width;
        const height = window.currentContent.height;
        const contentWithoutText = { ...window.currentContent, number: '', text: '', reference: '' };
        renderToCanvas(liveCanvas, contentWithoutText, width, height);
      }
    }
    // Tell live window to enter clear mode
    ipcRenderer.send('set-live-mode', 'clear');
  } else {
    // Turn off clear: restore preview and tell live window to return to normal
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) renderToCanvas(liveCanvas, window.currentContent, window.currentContent.width, window.currentContent.height);
    }
    ipcRenderer.send('set-live-mode', 'normal');
  }
}

function clearLiveText() {
  const liveNumber = document.getElementById('live-number');
  const liveText = document.getElementById('live-text');
  const liveReference = document.getElementById('live-reference');
  if (liveNumber) liveNumber.style.display = 'none';
  if (liveText) liveText.style.display = 'none';
  if (liveReference) liveReference.style.display = 'none';
}

function showLiveText() {
  const liveNumber = document.getElementById('live-number');
  const liveText = document.getElementById('live-text');
  const liveReference = document.getElementById('live-reference');
  if (liveNumber) liveNumber.style.display = '';
  if (liveText) liveText.style.display = '';
  if (liveReference) liveReference.style.display = '';
}

function setLiveBackground(color) {
  const bg = color === 'black' ? '#000' : '#000'; // already black
  document.getElementById('live-container').style.background = bg;
}

function resetLiveCanvas() {
  showLiveText();
  setLiveBackground('default');
}

// Listen for dark theme changes from settings window
ipcRenderer.on('set-dark-theme', (event, enabled) => {
  if (enabled) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
});

// Notify user when an update is available (sent from main on startup or when detected)
ipcRenderer.on('update-available', (event, res) => {
  try {

    // If the DOM isn't ready yet (rare), request any pending update from main
    function ensureAndHandle(info) {
      try {
        if (!info) return;
        function createInlineUpdateNotice(info, targetCard) {
          // Add a compact update notice into the given container (e.g., setup modal) to avoid overlapping UI
          const existing = targetCard.querySelector('.inline-update-notice');
          if (existing) return existing;
          const note = document.createElement('div');
          note.className = 'inline-update-notice';
          note.style.marginTop = '8px';
          note.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div style="flex:1">Update available: <strong>${info.latest||''}</strong></div>
              <div style="display:flex;gap:8px">
                <button class="btn small" data-action="open-release">Open Release</button>
                <button class="btn small primary" data-action="download">Download</button>
              </div>
            </div>
            <div class="inline-progress" style="margin-top:8px;display:none">
              <div class="progress"><div class="progress-inner" style="width:0%"></div></div>
              <div style="margin-top:6px;font-size:12px;color:var(--muted,#666);" class="inline-progress-text">0%</div>
            </div>
          `;
          targetCard.appendChild(note);

          note.querySelector('[data-action="open-release"]').onclick = () => { require('electron').shell.openExternal(info.html_url); };
          const downloadBtn = note.querySelector('[data-action="download"]');
          const inlineProgress = note.querySelector('.inline-progress');
          const progressInner = note.querySelector('.progress-inner');
          const progressText = note.querySelector('.inline-progress-text');
          let currentFile = null;
          let downloading = false;
          downloadBtn.onclick = async () => {
            if (downloading) return;
            const asset = (info.assets || []).find(a => a.name && a.name.endsWith('.exe')) || (info.assets && info.assets[0]);
            if (!asset || !asset.url) { alert('No downloadable installer found for this platform.'); return; }
            downloading = true;
            inlineProgress.style.display = 'block';
            downloadBtn.disabled = true;
            try {
              const res = await ipcRenderer.invoke('download-update', { url: asset.url });
              if (res && res.ok && res.file) {
                currentFile = res.file;
                progressInner.style.width = '100%';
                progressText.textContent = 'Download complete';
                downloadBtn.textContent = 'Run';
                downloadBtn.disabled = false;
                downloadBtn.onclick = async () => { await ipcRenderer.invoke('run-installer', currentFile); };
              } else {
                alert('Download failed: ' + (res && res.error));
                downloadBtn.disabled = false;
                downloading = false;
              }
            } catch (e) {
              alert('Download failed: ' + e);
              downloadBtn.disabled = false;
              downloading = false;
            }
          };

          ipcRenderer.on('update-download-progress', (ev, p) => {
            if (p && p.file) {
              const percent = p.percent || (p.total ? Math.round(p.downloaded / p.total * 100) : 0);
              progressInner.style.width = (percent || 0) + '%';
              progressText.textContent = (percent ? percent + '%' : `${Math.round((p.downloaded || 0) / 1024)} KB`);
            }
          });

          return note;
        }

        // If the setup/login modal is open, attach an inline update notice there instead of creating a new modal
        const setupModal = document.getElementById('setup-modal');
        if (setupModal) {
          const card = setupModal.querySelector('.setup-card');
          if (card) {
            createInlineUpdateNotice(info, card);
            return;
          }
        }

        function createUpdateModal(info) {
          if (document.getElementById('update-modal')) return;
          const modal = document.createElement('div');
          modal.id = 'update-modal';
          modal.className = 'update-overlay';
          const releaseNote = (info.body || '').split('\n')[0] || '';
          modal.innerHTML = `
            <div class="setup-card">
              <h2>Update available: ${info.latest || ''}</h2>
              <div style="margin:8px 0;color:var(--muted,#666);font-size:0.9em;">${releaseNote}</div>
              <div style="margin-top:12px;display:flex;gap:8px;">
                <button id="update-open-release" class="btn">Open Release Page</button>
                <button id="update-download" class="btn primary">Download & Install</button>
                <button id="update-dismiss" class="btn">Dismiss</button>
              </div>
              <div id="update-progress" style="margin-top:12px;display:none;">
                <div class="progress"><div class="progress-inner" style="width:0%"></div></div>
                <div style="display:flex;justify-content:space-between;margin-top:6px;"><span id="update-progress-text">0%</span><button id="update-cancel" class="btn">Cancel</button></div>
              </div>
            </div>
          `;
          document.body.appendChild(modal);
          document.getElementById('update-open-release').onclick = () => { require('electron').shell.openExternal(info.html_url); };
          document.getElementById('update-dismiss').onclick = () => { modal.remove(); };

          const downloadBtn = document.getElementById('update-download');
          const progressEl = document.getElementById('update-progress');
          const progressBar = modal.querySelector('.progress-inner');
          const progressText = document.getElementById('update-progress-text');
          let currentFile = null;
          let downloading = false;
          downloadBtn.onclick = async () => {
            if (downloading) return;
            const asset = (info.assets || []).find(a => a.name && a.name.endsWith('.exe')) || (info.assets && info.assets[0]);
            if (!asset || !asset.url) { alert('No downloadable installer found for this platform.'); return; }
            downloading = true;
            progressEl.style.display = 'block';
            downloadBtn.disabled = true;
            try {
              const res = await ipcRenderer.invoke('download-update', { url: asset.url });
              if (res && res.ok && res.file) {
                currentFile = res.file;
                progressBar.style.width = '100%';
                progressText.textContent = 'Download complete';
                downloadBtn.textContent = 'Run Installer';
                downloadBtn.disabled = false;
                downloadBtn.onclick = async () => {
                  await ipcRenderer.invoke('run-installer', currentFile);
                };
              } else {
                alert('Download failed: ' + (res && res.error));
                downloadBtn.disabled = false;
                downloading = false;
              }
            } catch (e) {
              alert('Download failed: ' + e);
              downloadBtn.disabled = false;
              downloading = false;
            }
          };

          ipcRenderer.on('update-download-progress', (ev, p) => {
            if (p && p.file) {
              const percent = p.percent || (p.total ? Math.round(p.downloaded / p.total * 100) : 0);
              progressBar.style.width = (percent || 0) + '%';
              progressText.textContent = (percent ? percent + '%' : `${Math.round((p.downloaded || 0) / 1024)} KB`);
            }
          });

          document.getElementById('update-cancel').onclick = async () => {
            if (currentFile) {
              await ipcRenderer.invoke('cancel-update-download', { file: currentFile });
            }
            modal.remove();
          };
        }
        createUpdateModal(info);
      } catch (e) { console.warn('update-available handler error', e); }
    }

    // If the DOM looks ready, handle immediately; otherwise we query main for pending update
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      ensureAndHandle(res);
    } else {
      ipcRenderer.invoke('get-pending-update').then(info => ensureAndHandle(info)).catch(()=>{});
    }
  } catch (e) { console.warn('update-available handler error', e); }
});
// Allow other windows (Settings) to request the setup modal
ipcRenderer.on('show-setup-modal', () => {
  try { createSetupModal(); } catch (e) { console.error('Failed to open setup modal from IPC', e); }
});

// Allow other windows (Settings) to request the setup modal
ipcRenderer.on('show-setup-modal', () => {
  try { createSetupModal(); } catch (e) { console.error('Failed to open setup modal from IPC', e); }
});
// Handle default-bible updates from main process
ipcRenderer.on('default-bible-changed', async (event, bible) => {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const baseName = bible.endsWith('.json') ? bible.replace('.json','') : bible;
    const biblePath = path.join(userData, 'bibles', baseName);
    const localBibleFile = path.join(biblePath, 'bible.json');
    const legacyFile = path.join(userData, BIBLE_STORAGE_DIR, bible);

    // Update current bible tracking
    currentBibleFile = bible;

    // Migrate legacy single-file download into the expected per-version folder
    if (!fs.existsSync(localBibleFile) && fs.existsSync(legacyFile)) {
      try {
        await fs.promises.mkdir(biblePath, { recursive: true });
        const txt = await fs.promises.readFile(legacyFile, 'utf8');
        await fs.promises.writeFile(localBibleFile, txt, 'utf8');
      } catch (err) {
        console.error('Failed to migrate legacy bible file:', err);
      }
    }

    try {
      allVerses = await loadAllVersesFromDisk(biblePath);
    } catch (err) {
      safeStatus('Failed to load selected Bible.');
      console.error('Failed to load selected bible:', err);
      return;
    }

    document.getElementById('virtual-list').style.height = `${allVerses.length * ITEM_HEIGHT}px`;
    renderWindow(allVerses, 0, selectedIndices, handleVerseClick);
    safeStatus(`Switched to ${baseName.replace('_', ' ')}.`);
    
    // Re-render schedule with new verse data
    if (scheduleItems.length > 0) {
      renderSchedule();
    }

    // Restore last selection if it belongs to this bible
    try {
      const settings = await ipcRenderer.invoke('load-settings');
      if (settings && settings.lastSelected && settings.lastSelected.bible === currentBibleFile) {
        const start = allVerses.findIndex(v => v.key === settings.lastSelected.startKey);
        const end = settings.lastSelected.endKey ? allVerses.findIndex(v => v.key === settings.lastSelected.endKey) : start;
        if (start !== -1) {
          const realEnd = (end !== -1) ? end : start;
          selectedIndices = [];
          for (let k = Math.min(start, realEnd); k <= Math.max(start, realEnd); k++) selectedIndices.push(k);
          anchorIndex = selectedIndices[0];
          updateVerseDisplay();
          updatePreview(allVerses[selectedIndices[0]]);
          jumpToVerse(selectedIndices[0]);
          renderWindow(allVerses, document.getElementById('verse-list').scrollTop, selectedIndices, handleVerseClick);
        }
      }
    } catch (err) { console.error('Failed to restore last selection after bible change:', err); }
  } catch (err) {
    console.error('Error handling default-bible-changed:', err);
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  // Install renderer-side logging buffer
  try {
    window.appLogs = window.appLogs || [];
    const _rlog = console.log;
    const _rwarn = console.warn;
    const _rerr = console.error;
    console.log = function(...args) { try { window.appLogs.push({ ts: new Date().toISOString(), level: 'log', msg: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') }); } catch (e) {} ; _rlog.apply(console, args); };
    console.warn = function(...args) { try { window.appLogs.push({ ts: new Date().toISOString(), level: 'warn', msg: args.join(' ') }); } catch (e) {} ; _rwarn.apply(console, args); };
    console.error = function(...args) { try { window.appLogs.push({ ts: new Date().toISOString(), level: 'error', msg: args.join(' ') }); } catch (e) {} ; _rerr.apply(console, args); };
  } catch (e) {}

  await loadAndApplySettings();

  // Check auth/license before showing main UI
  await ensureAuthSetup();
  
  // Continue with initial render
  loadCoreUI();

  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;

  // Track last known inner height so we can expand/shrink verse area proportionally on resize
  let _lastWindowInnerHeight = window.innerHeight;

  // Initial render
  renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  // Other UI initialization moved into loadCoreUI so it only runs after auth check

  // Scroll handler
  listContainer.addEventListener('scroll', () => {
    renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  });

  initScripture();
  loadSongs();
  loadMedia();
  initColorEditor();
  initImageEditor();
  initVideoEditor();
  initTabs();
  setupPopover(); // Enabled: required so style buttons and menus can open the CSS popover
  initSchedule();
  initResizers();
  restoreDividerPositions();

  // Re-validate divider positions after a window resize to avoid off-screen panels
  let _dividerResizeTimeout = null;
  window.addEventListener('resize', () => {
    clearTimeout(_dividerResizeTimeout);
    _dividerResizeTimeout = setTimeout(async () => {
      // Re-clamp and save if needed
      const scheduleSidebar = document.getElementById('schedule-sidebar');
      const slidePreview = document.getElementById('slide-preview');
      const slideContainer = document.getElementById('slide-container');
      const versePanel = document.getElementById('verse-panel');
      if (!scheduleSidebar || !slidePreview || !slideContainer || !versePanel) return;

      const scheduleWidthPx = Math.round(scheduleSidebar.getBoundingClientRect().width);
      const containerRect = slideContainer.getBoundingClientRect();
      const previewPercent = Math.round((slidePreview.getBoundingClientRect().width / (containerRect.width || 1)) * 100);
      const verseHeightPx = Math.round(versePanel.getBoundingClientRect().height);

      // Clamp same as restore for schedule/preview
      const clampedSchedule = Math.max(100, Math.min(scheduleWidthPx, Math.max(150, window.innerWidth - 400)));
      const clampedPreview = Math.max(10, Math.min(previewPercent, 90));

      // Allow verse panel to expand/shrink when window height changes.
      const heightDelta = window.innerHeight - (_lastWindowInnerHeight || window.innerHeight);
      const windowMaxVerse = Math.max(100, window.innerHeight - 100);
      let desiredVerse = verseHeightPx;
      if (heightDelta > 0) {
        // Window grew: add delta to verse height but don't exceed window available area
        desiredVerse = Math.min(windowMaxVerse, verseHeightPx + heightDelta);
      } else if (heightDelta < 0) {
        // Window shrunk: reduce verse height but respect minimums
        desiredVerse = Math.max(50, Math.min(verseHeightPx + heightDelta, windowMaxVerse));
      }
      const clampedVerse = Math.max(50, Math.min(desiredVerse, windowMaxVerse));

      let changed = false;
      if (clampedSchedule !== scheduleWidthPx) {
        scheduleSidebar.style.width = clampedSchedule + 'px';
        changed = true;
      }
      if (clampedPreview !== previewPercent) {
        slidePreview.style.flex = `0 0 ${clampedPreview}%`;
        document.getElementById('slide-live').style.flex = `0 0 ${100 - clampedPreview}%`;
        changed = true;
      }
      if (clampedVerse !== verseHeightPx) {
        const newTop = Math.max(50, window.innerHeight - clampedVerse - 16);
        document.getElementById('top-section').style.flex = `0 0 ${newTop}px`;
        versePanel.style.flex = `0 0 ${clampedVerse}px`;
        changed = true;
      }

      // Remember last window size for next resize calculation
      _lastWindowInnerHeight = window.innerHeight;

      if (changed) await saveDividerPositions();
    }, 150);
  });

  // Listen for report requests from main and prepare renderer payload
  ipcRenderer.on('prepare-renderer-report', async () => {
    try {
      const docHtml = document.documentElement.outerHTML;
      const previewCanvas = document.getElementById('preview-canvas');
      let previewDataUrl = null;
      let previewInfo = null;
      if (previewCanvas) {
        try {
          previewDataUrl = previewCanvas.toDataURL('image/png');
          previewInfo = { width: previewCanvas.width, height: previewCanvas.height };
        } catch (e) {
          previewInfo = { error: String(e) };
        }
      }

      const settingsSnapshot = {
        username: document.getElementById('username') ? document.getElementById('username').value : null,
        darkTheme: document.getElementById('dark-theme') ? document.getElementById('dark-theme').checked : null,
        theme: document.getElementById('theme') ? document.getElementById('theme').value : null,
        dividerPositions: {
          scheduleWidth: document.getElementById('schedule-sidebar') ? document.getElementById('schedule-sidebar').style.width : null,
          previewFlex: document.getElementById('slide-preview') ? document.getElementById('slide-preview').style.flex : null,
          verseHeight: document.getElementById('verse-panel') ? document.getElementById('verse-panel').style.flex : null
        }
      };

      const rendererLogs = window.appLogs || [];
      const settingsFile = await ipcRenderer.invoke('load-settings');

      ipcRenderer.send('renderer-report', {
        docHtml,
        previewDataUrl,
        previewInfo,
        settingsSnapshot,
        settingsFile,
        rendererLogs
      });
    } catch (err) {
      console.error('Failed to prepare renderer report:', err);
      ipcRenderer.send('renderer-report', { error: String(err) });
    }
  });

  // Keyboard navigation when the verse selection is focused (or body) — allow left/right arrows
  window.addEventListener('keydown', (e) => {
    // Ignore when typing in an input/textarea
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    
    // Check if we're on a schedule song verse
    const isSongScheduleVerse = active && active.classList.contains('schedule-verse-item') && 
                                  focusedScheduleItem && focusedScheduleItem.type === 'song-verse';
    
    if (isSongScheduleVerse && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      // Schedule song verse navigation
      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        navigateScheduleSongVerse(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        navigateScheduleSongVerse(1);
      }
      return;
    }
    
    // Ignore if focus is on schedule items (they have their own handlers)
    if (active && (active.closest('.schedule-item-header') || active.closest('.schedule-verse-item'))) return;
    
    // Check if we should handle song navigation
    const isInSongsTab = currentTab === 'songs';
    const songDisplay = document.getElementById('song-display');
    const isSongDisplayOpen = selectedSongIndices.length > 0 && songDisplay && songDisplay.style.display !== 'none';
    
    if (isInSongsTab && isSongDisplayOpen && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      // Song verse navigation
      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        selectPrevSongVerse();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        selectNextSongVerse();
      }
    } else if (isInSongsTab && isSongDisplayOpen && e.key === 'Enter') {
      // Go live with selected song verse
      e.preventDefault();
      if (selectedSongVerseIndex !== null) {
        handleSongVerseDoubleClick(selectedSongVerseIndex);
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Bible verse navigation
      e.preventDefault();
      if (e.key === 'ArrowLeft') {
        selectPrevVerse(e.shiftKey);
      } else {
        selectNextVerse(e.shiftKey);
      }
    }
  });
});

async function initScripture() {
  safeStatus('Initializing…');
  allVerses = [];
  selectedIndices = [];
  anchorIndex = null;

  const userData = await ipcRenderer.invoke('get-user-data-path');

  // Prefer saved default bible if present, otherwise fall back to constants.VERSION
  const savedDefault = await ipcRenderer.invoke('get-default-bible');
  const defaultBibleFile = savedDefault || `${VERSION}.json`;
  currentBibleFile = defaultBibleFile;
  const baseName = defaultBibleFile.endsWith('.json') ? defaultBibleFile.replace('.json','') : defaultBibleFile;
  const baseDir = path.join(userData, 'bibles', baseName);
  await fs.promises.mkdir(baseDir, { recursive: true });

  // Download bible.json if needed
  await ensureBibleJson(baseDir);

  allVerses = await loadAllVersesFromDisk(baseDir);

  document.getElementById('virtual-list').style.height = `${allVerses.length * ITEM_HEIGHT}px`;
  // Ensure left column is wide enough to show the longest verse reference (clamped to a sane maximum)
  try { adjustVerseListWidth(allVerses); } catch(e) { console.warn('adjustVerseListWidth failed', e); }
  renderWindow(allVerses, 0, selectedIndices, handleVerseClick);
  safeStatus(`Loaded ${allVerses.length} verses.`);
  
  // Render schedule now that allVerses is populated
  if (scheduleItems.length > 0) {
    renderSchedule();
  }

  // Compute and set verse-list width based on measured text (used above)
  function adjustVerseListWidth(allVersesList) {
    const listEl = document.getElementById('verse-list');
    if (!listEl || !allVersesList || allVersesList.length === 0) return;

    // Create a temporary element to pick up computed font styles
    const sample = document.createElement('div');
    sample.className = 'verse-item';
    sample.style.position = 'absolute'; sample.style.visibility = 'hidden'; sample.style.whiteSpace = 'nowrap';
    document.body.appendChild(sample);
    const computedFont = window.getComputedStyle(sample).font || '14px Arial';
    document.body.removeChild(sample);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = computedFont;

    // Measure the longest key
    let maxW = 0;
    for (let i = 0; i < allVersesList.length; i++) {
      const key = allVersesList[i] && allVersesList[i].key ? String(allVersesList[i].key) : '';
      const w = ctx.measureText(key).width;
      if (w > maxW) maxW = w;
    }

    // Add padding and clamp to reasonable bounds
    const padding = 16; // 8px left + 8px right (we already have those)
    const minW = 120;
    const maxAllowed = Math.min(420, Math.floor(window.innerWidth * 0.45));
    const desired = Math.ceil(maxW + padding);
    const final = Math.max(minW, Math.min(desired, maxAllowed));

    document.documentElement.style.setProperty('--verse-list-width', `${final}px`);
  }

  // Recompute on resize (debounced)
  let _verseListResizeTimer = null;
  window.addEventListener('resize', () => {
    if (_verseListResizeTimer) clearTimeout(_verseListResizeTimer);
    _verseListResizeTimer = setTimeout(() => adjustVerseListWidth(allVerses), 150);
  });
  // Try to restore last selection if it belongs to this bible
  try {
    const settings = await ipcRenderer.invoke('load-settings');
    if (settings && settings.lastSelected && settings.lastSelected.bible === currentBibleFile) {
      const start = allVerses.findIndex(v => v.key === settings.lastSelected.startKey);
      const end = settings.lastSelected.endKey ? allVerses.findIndex(v => v.key === settings.lastSelected.endKey) : start;
      if (start !== -1) {
        const realEnd = (end !== -1) ? end : start;
        selectedIndices = [];
        for (let k = Math.min(start, realEnd); k <= Math.max(start, realEnd); k++) selectedIndices.push(k);
        anchorIndex = selectedIndices[0];
        updateVerseDisplay();
        updatePreview(allVerses[selectedIndices[0]]);
        jumpToVerse(selectedIndices[0]);
        renderWindow(allVerses, document.getElementById('verse-list').scrollTop, selectedIndices, handleVerseClick);
      }
    }
  } catch (err) {
    console.error('Failed to restore last selection:', err);
  }

  // Set preview aspect ratio
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  if (defaultDisplayId) {
    const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
    if (display) {
      const aspect = (display.bounds.height / display.bounds.width) * 100;
      document.documentElement.style.setProperty('--preview-aspect', `${aspect}%`);
    }
  }

  // Setup the EasyWorship-style search box
  setupSearchBox({
    containerId: 'search-box-container',
    onReferenceSelected: async (ref) => {
      // Support ranges (e.g., John 3:16-18)
      const startKey = `${ref.book} ${ref.chapter}:${ref.verse}`;
      const startIdx = allVerses.findIndex(v => v.key && v.key.toLowerCase() === startKey.toLowerCase());
      if (ref.verseEnd) {
        const endKey = `${ref.book} ${ref.chapter}:${ref.verseEnd}`;
        const endIdx = allVerses.findIndex(v => v.key && v.key.toLowerCase() === endKey.toLowerCase());
        if (startIdx !== -1 && endIdx !== -1) {
          const a = Math.min(startIdx, endIdx);
          const b = Math.max(startIdx, endIdx);
          selectedIndices = [];
          for (let k = a; k <= b; k++) selectedIndices.push(k);
          anchorIndex = a;
          updateVerseDisplay(); // Show the verse content
          updatePreview(selectedIndices); // Also update preview with range
          jumpToVerse(selectedIndices[0]);     // Scroll to the verse
          // Also immediately highlight in the list
          const listContainer = document.getElementById('verse-list');
          if (listContainer) {
            renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
          }
          await saveLastSelectionToSettings();
          return;
        }
      }

      if (startIdx !== -1) {
        selectedIndices = [startIdx];
        anchorIndex = startIdx;
        updateVerseDisplay(); // Show the verse content
        updatePreview(startIdx); // Also update preview
        jumpToVerse(startIdx);     // Scroll to the verse
        // Also immediately highlight in the list
        const listContainer = document.getElementById('verse-list');
        if (listContainer) {
          renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
        }
        await saveLastSelectionToSettings();
      } else {
        safeStatus('Verse not found.');
      }
    },
    onNavigate: (direction) => {
      if (direction === 'prev') selectPrevVerse();
      else selectNextVerse();
    },
    onEnter: () => {
      // Go live using the current selection (supports multi-select); if a single
      // verse is focused/present it'll still work because selectedIndices will contain it.
      if (selectedIndices.length > 0) handleVerseDoubleClick();
    },
    onToggleLive: toggleLive,
    onToggleClear: toggleClear,
    onToggleBlack: toggleBlack,
    books: BOOKS
  });
}

// Jump to verse (e.g. after search)
function jumpToVerse(idx) {
  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;
  listContainer.scrollTop = idx * ITEM_HEIGHT;
  // renderWindow will be called by the scroll event
}

function updateVerseDisplay() {
  const disp = document.getElementById('verse-display');
  if (!disp) return;

  // For the right-side verse display, show the selected verses as a single passage
  const sorted = selectedIndices.slice().sort((a,b) => a-b);
  if (sorted.length === 0) {
    disp.innerHTML = '';
  } else {
    const combined = sorted.map(i => allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '')).join(' ');
    const ref = (sorted.length === 1) ? allVerses[sorted[0]].key : `${allVerses[sorted[0]].key} - ${allVerses[sorted[sorted.length-1]].key}`;
    disp.innerHTML = `<p><strong>${ref}</strong><br>${combined}</p>`;
  }
}

/**
 * Apply fade-in animation to canvas content
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Number} duration - Duration in seconds
 * @param {Function} callback - Called when animation completes
 */
function applyFadeInAnimation(canvas, duration = 1.0, callback = null) {
  const startTime = Date.now();
  const ctx = canvas.getContext('2d');
  
  // Save original canvas content
  const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  const animate = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Create a copy of the image data with adjusted alpha
    const imageData = ctx.createImageData(originalImageData);
    const data = imageData.data;
    const originalData = originalImageData.data;
    
    // Adjust alpha channel for all pixels
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.round(originalData[i] * progress);
    }
    
    // Clear canvas and redraw with faded image
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      ctx.putImageData(originalImageData, 0, 0);
      if (callback) callback();
    }
  };
  
  animate();
}

/**
 * Apply fade-out animation to canvas content
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Number} duration - Duration in seconds
 * @param {Function} callback - Called when animation completes
 */
function applyFadeOutAnimation(canvas, duration = 1.0, callback = null) {
  const startTime = Date.now();
  const ctx = canvas.getContext('2d');
  
  // Save original canvas content
  const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  const animate = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const progress = Math.min(elapsed / duration, 1);
    
    // Create a copy of the image data with adjusted alpha (reverse of fade-in)
    const imageData = ctx.createImageData(originalImageData);
    const data = imageData.data;
    const originalData = originalImageData.data;
    
    // Adjust alpha channel for all pixels (1 - progress for fade-out)
    const alpha = 1 - progress;
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.round(originalData[i] * alpha);
    }
    
    // Clear canvas and redraw with faded image
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      // Clear to black
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (callback) callback();
    }
  };
  
  animate();
}

/**
 * Render verse content to a canvas at external display resolution
 * @param {HTMLCanvasElement} canvas - The canvas to render to
 * @param {Object} content - { number, text, reference, showHint }
 * @param {Number} displayWidth - External display width
 * @param {Number} displayHeight - External display height
 * @param {Function} onRenderComplete - Callback when rendering is complete
 */
function renderToCanvas(canvas, content, displayWidth = 1920, displayHeight = 1080, onRenderComplete = null) {
  canvas.width = displayWidth;
  canvas.height = displayHeight;
  
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, displayWidth, displayHeight);
  
  // Styles passed via content.styles (optional)
  const styles = content && content.styles ? content.styles : null;
  const textStyle = styles && styles.text ? styles.text : null;
  const numberStyle = styles && (styles.number || styles.title) ? (styles.number || styles.title) : null;
  const referenceStyle = styles && styles.reference ? styles.reference : null;

  // Handle background media (object with type, path, color, and settings)
  if (content.backgroundMedia) {
    const media = content.backgroundMedia;
    
    if (media.type === 'COLOR') {
      // Apply color/gradient background
      applyColorToCanvas(ctx, media.color, displayWidth, displayHeight);
      // Add semi-transparent overlay for text readability
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(0, 0, displayWidth, displayHeight);
      renderTextContent();
      if (onRenderComplete) onRenderComplete();
    } else if (media.type === 'JPG' || media.type === 'PNG') {
      // Apply image background with settings
      const bgImg = new Image();
      bgImg.onload = () => {
        drawImageWithSettings(ctx, bgImg, displayWidth, displayHeight, {
          bgSize: media.bgSize || 'cover',
          bgRepeat: media.bgRepeat || 'no-repeat',
          bgPosition: media.bgPosition || 'center'
        });
        
        // Add semi-transparent overlay for text readability
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(0, 0, displayWidth, displayHeight);
        
        renderTextContent();
      };
      bgImg.onerror = () => {
        console.error('Failed to load background:', media.path);
        renderTextContent();
      };
      bgImg.src = pathToFileURL(media.path);
    } else {
      // Video or unknown type - just render text
      renderTextContent();
    }
  } else if (content.backgroundPath) {
    // Legacy path string support
    const bgImg = new Image();
    bgImg.onload = () => {
      const scale = Math.min(displayWidth / bgImg.width, displayHeight / bgImg.height);
      const w = bgImg.width * scale;
      const h = bgImg.height * scale;
      const x = (displayWidth - w) / 2;
      const y = (displayHeight - h) / 2;
      ctx.drawImage(bgImg, x, y, w, h);
      
      // Add semi-transparent overlay for text readability
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(0, 0, displayWidth, displayHeight);
      
      renderTextContent();
    };
    bgImg.onerror = () => {
      console.error('Failed to load background:', content.backgroundPath);
      renderTextContent();
    };
    bgImg.src = pathToFileURL(content.backgroundPath);
  } else {
    renderTextContent();
  }
  
  function renderTextContent() {
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  
  const padding = displayWidth * 0.02;
  const availableWidth = displayWidth - (padding * 2);
  const availableHeight = displayHeight - (padding * 2);
  
  // Calculate font sizes (scaled to display resolution)
  let baseFontSize = displayHeight * 0.08; // 8% of height
  
  // Render verse number (top left)
  if (content.number) {
    ctx.font = `${baseFontSize * 0.6}px Arial`;
    ctx.textAlign = 'left';
      ctx.fillStyle = (numberStyle && numberStyle.color) ? numberStyle.color : '#fff';
      ctx.fillText(content.number, padding, padding + baseFontSize * 0.3);
    }
    
    // Render verse text (center)
    if (content.text) {
      ctx.textAlign = 'center';
      const textY = displayHeight / 2;
      const textLines = content.text.split('\n');
      const allLines = [];
      // Default text color
      const normalTextColor = (textStyle && textStyle.color) ? textStyle.color : '#fff';
      // Subscript color uses a lighter tone or provided (derive if not given)
      const subscriptColor = (textStyle && textStyle.subscriptColor) ? textStyle.subscriptColor : (textStyle && textStyle.color ? textStyle.color : '#ddd');
    
    textLines.forEach(textLine => {
      // Parse text to handle verse numbers as subscripts
      const segments = parseVerseSegments(textLine);
      // For each non-number segment, parse inline Markdown to preserve bold/italic per word
      segments.forEach(s => {
        if (!s.isNumber) s.words = parseInlineMarkdownWords(s.text);
      });
      
      // Auto-size font to fill vertical space optimally
      ctx.font = `${baseFontSize}px Arial`;
      const wrappedLines = wrapTextWithSubscripts(ctx, segments, availableWidth, baseFontSize);
      allLines.push(...wrappedLines);
    });
    
    let lines = allLines;
    
    // Grow font size to fill available vertical space
    while (true) {
      const testSize = baseFontSize + 4;
      ctx.font = `${testSize}px Arial`;
      const testLines = [];
      textLines.forEach(textLine => {
        const segments = parseVerseSegments(textLine);
        // Ensure inline markdown is parsed for measurement
        segments.forEach(s => { if (!s.isNumber) s.words = parseInlineMarkdownWords(s.text); });
        const wrappedLines = wrapTextWithSubscripts(ctx, segments, availableWidth, testSize);
        testLines.push(...wrappedLines);
      });
      if (testLines.length * testSize * 1.2 < availableHeight * 0.85 && testSize < displayHeight * 0.15) {
        baseFontSize = testSize;
        lines = testLines;
      } else {
        break;
      }
    }
    
    // If we overshot, shrink back down
    while (lines.length * baseFontSize * 1.2 > availableHeight && baseFontSize > 20) {
      baseFontSize -= 2;
      ctx.font = `${baseFontSize}px Arial`;
      const testLines = [];
      textLines.forEach(textLine => {
        const segments = parseVerseSegments(textLine);
        // Ensure inline markdown is parsed for measurement
        segments.forEach(s => { if (!s.isNumber) s.words = parseInlineMarkdownWords(s.text); });
        const wrappedLines = wrapTextWithSubscripts(ctx, segments, availableWidth, baseFontSize);
        testLines.push(...wrappedLines);
      });
      lines = testLines;
    }
    
    // Render lines with subscript numbers
    const lineHeight = baseFontSize * 1.2;
    const totalHeight = lines.length * lineHeight;
    const startY = textY - (totalHeight / 2);
    
    lines.forEach((line, i) => {
      renderLineWithSubscripts(ctx, line, displayWidth / 2, startY + (i * lineHeight) + (baseFontSize / 2), baseFontSize, { textColor: normalTextColor, subscriptColor });
    });
  }
  
  // Render reference (bottom right)
  if (content.reference) {
    ctx.font = `${baseFontSize * 0.7}px Arial`;
    ctx.textAlign = 'right';
    ctx.fillStyle = (referenceStyle && referenceStyle.color) ? referenceStyle.color : '#fff';
    ctx.fillText(content.reference, displayWidth - padding, displayHeight - padding - baseFontSize * 0.3);
  }
  
  // Render hint (if provided)
  if (content.showHint) {
    ctx.font = `${baseFontSize * 0.6}px Arial`;
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'right';
    ctx.fillText(content.showHint, displayWidth - padding, displayHeight - padding - baseFontSize * 1.1);
  }
        
      // Call completion callback after rendering text
      if (onRenderComplete) onRenderComplete();
    } // end renderTextContent
}

/**
 * Parse text into segments of verse numbers and text
 * Format: "2  In the beginning... 3  And God said..."
 */
function parseVerseSegments(text) {
  const segments = [];
  const regex = /(\d+)\s{2}/g;
  let lastIndex = 0;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    // Add text before this verse number
    if (match.index > lastIndex) {
      const textBefore = text.substring(lastIndex, match.index).trim();
      if (textBefore) segments.push({ isNumber: false, text: textBefore });
    }
    // Add verse number
    segments.push({ isNumber: true, text: match[1] });
    lastIndex = regex.lastIndex;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex).trim();
    if (remaining) segments.push({ isNumber: false, text: remaining });
  }
  
  return segments;
}

/**
 * Wrap text with subscript segments
 */
function wrapTextWithSubscripts(ctx, segments, maxWidth, baseFontSize) {
  const lines = [];
  let currentLine = [];
  let currentWidth = 0;
  
  const subscriptSize = baseFontSize * 0.6;
  
  segments.forEach(seg => {
    if (seg.isNumber) {
      // Measure subscript number
      ctx.font = `${subscriptSize}px Arial`;
      const width = ctx.measureText(seg.text + ' ').width;
      
      if (currentWidth + width > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = [];
        currentWidth = 0;
      }
      
      currentLine.push(seg);
      currentWidth += width;
      ctx.font = `${baseFontSize}px Arial`;
    } else {
      // If seg.words exists (parsed with inline markdown), use those styled words
      const words = seg.words ? seg.words : seg.text.split(' ');
      words.forEach((wordObj, idx) => {
        const wordText = typeof wordObj === 'string' ? wordObj : wordObj.text;
        const testWord = wordText + (idx < words.length - 1 ? ' ' : '');
        // Set font according to inline style for accurate measurement
        if (typeof wordObj !== 'string') {
          const styleFont = `${wordObj.italic ? 'italic ' : ''}${wordObj.bold ? 'bold ' : ''}${baseFontSize}px Arial`;
          ctx.font = styleFont;
        } else {
          ctx.font = `${baseFontSize}px Arial`;
        }
        const width = ctx.measureText(testWord).width;
        
        if (currentWidth + width > maxWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [];
          currentWidth = 0;
        }
        
        // Preserve style info in pushed segment
        if (typeof wordObj === 'string') {
          currentLine.push({ isNumber: false, text: testWord });
        } else {
          currentLine.push({ isNumber: false, text: testWord, bold: !!wordObj.bold, italic: !!wordObj.italic });
        }
        currentWidth += width;
      });
    }
  });
  
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  
  return lines;
}

/**
 * Render a line with subscript verse numbers
 */
function renderLineWithSubscripts(ctx, segments, centerX, y, baseFontSize, colors = {}) {
  // Calculate total width
  const subscriptSize = baseFontSize * 0.6;
  let totalWidth = 0;
  
  segments.forEach(seg => {
    if (seg.isNumber) {
      ctx.font = `${subscriptSize}px Arial`;
      totalWidth += ctx.measureText(seg.text + ' ').width;
    } else {
      // Determine font for measurement if style flags exist
      const fontStr = `${seg && seg.italic ? 'italic ' : ''}${seg && seg.bold ? 'bold ' : ''}${baseFontSize}px Arial`;
      ctx.font = fontStr;
      totalWidth += ctx.measureText(seg.text).width;
    }
  });
  
  // Start from left of center
  let x = centerX - (totalWidth / 2);
  
  ctx.textBaseline = 'alphabetic';  // Use alphabetic baseline for consistent rendering
  
  segments.forEach(seg => {
    if (seg.isNumber) {
      // Render subscript (smaller, slightly lower)
      ctx.font = `${subscriptSize}px Arial`;
      ctx.fillStyle = (colors && colors.subscriptColor) ? colors.subscriptColor : '#ddd';
      ctx.textAlign = 'left';
      ctx.fillText(seg.text + ' ', x, y + (baseFontSize * 0.2));
      x += ctx.measureText(seg.text + ' ').width;
      ctx.fillStyle = (colors && colors.textColor) ? colors.textColor : '#fff';
    } else {
      // Render normal text, honoring bold/italic flags if present
      const fontStr = `${seg && seg.italic ? 'italic ' : ''}${seg && seg.bold ? 'bold ' : ''}${baseFontSize}px Arial`;
      ctx.font = fontStr;
      ctx.textAlign = 'left';
      ctx.fillStyle = (colors && colors.textColor) ? colors.textColor : '#fff';
      ctx.fillText(seg.text, x, y);
      x += ctx.measureText(seg.text).width;
    }
  });
  
  ctx.textBaseline = 'middle';  // Reset to middle
}

/**
 * Wrap text to fit within a given width
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (let word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Parse inline Markdown in a string into an array of word objects with style flags
 * Supports: **bold**, __bold__, *italic*, _italic_
 */
function parseInlineMarkdownWords(s) {
  const out = [];
  if (!s) return out;

  const tokenRegex = /(\*\*|__)([\s\S]+?)\1|(\*|_)([\s\S]+?)\3/g;
  let lastIndex = 0;
  let m;

  while ((m = tokenRegex.exec(s)) !== null) {
    if (m.index > lastIndex) {
      // Plain text before this token
      const plain = s.substring(lastIndex, m.index);
      plain.split(' ').forEach((w, i, arr) => {
        if (w === '') return;
        const add = i < arr.length - 1 ? w + ' ' : w;
        out.push({ text: add, bold: false, italic: false });
      });
    }

    if (m[1] && m[2]) {
      // Bold using ** or __
      m[2].split(' ').forEach((w, i, arr) => {
        if (w === '') return;
        const add = i < arr.length - 1 ? w + ' ' : w;
        out.push({ text: add, bold: true, italic: false });
      });
    } else if (m[3] && m[4]) {
      // Italic using * or _
      m[4].split(' ').forEach((w, i, arr) => {
        if (w === '') return;
        const add = i < arr.length - 1 ? w + ' ' : w;
        out.push({ text: add, bold: false, italic: true });
      });
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < s.length) {
    const rest = s.substring(lastIndex);
    rest.split(' ').forEach((w, i, arr) => {
      if (w === '') return;
      const add = i < arr.length - 1 ? w + ' ' : w;
      out.push({ text: add, bold: false, italic: false });
    });
  }

  // If nothing matched, but s has no spaces, ensure we return it
  if (out.length === 0 && s.trim() !== '') out.push({ text: s, bold: false, italic: false });

  return out;
}

async function updatePreview(verseOrIndices) {
  // verseOrIndices: either a single verse object, an index, or an array of indices into allVerses
  if (typeof verseOrIndices === 'number') verseOrIndices = [verseOrIndices];

  let numberText = '';
  let textContent = '';
  let refText = '';
  let showHint = null;
  
  if (Array.isArray(verseOrIndices)) {
    const originalCount = verseOrIndices.length;
    const indices = getFittableIndices(verseOrIndices, 800); // 800 char limit
    
    // Build concatenated passage
    const parts = indices.map(i => {
      const verseNum = allVerses[i].key.split(':')[1];
      const cleanText = allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '');
      return `${verseNum}  ${cleanText}`;
    });
    textContent = parts.join(' ');
    
    if (indices.length === 1) {
      numberText = allVerses[indices[0]].key.split(':')[1];
      refText = `${allVerses[indices[0]].key} (KJV)`;
    } else if (indices.length > 1) {
      refText = `${allVerses[indices[0]].key} - ${allVerses[indices[indices.length - 1]].key} (KJV)`;
      if (indices.length < originalCount) {
        showHint = `Showing ${indices.length} of ${originalCount} selected`;
      }
    }
  } else {
    const v = verseOrIndices;
    const clean = v.text.replace(/(\.\d+[\s\S]*)$/, '');
    textContent = clean;
    numberText = v.key.split(':')[1];
    refText = `${v.key} (KJV)`;
  }
  
  // Get external display dimensions
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  // Render to preview canvas
  const previewCanvas = document.getElementById('preview-canvas');
  if (previewCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.verses);
    renderToCanvas(previewCanvas, {
      number: numberText,
      text: textContent,
      reference: refText,
      showHint: showHint,
      backgroundMedia: backgroundMedia
    }, width, height);
  }

  // Persist selection preview as last selection (single or range)
  saveLastSelectionToSettings().catch(err => console.error('Failed to persist preview selection', err));
}

async function updateLive(verseOrIndices) {
  // Accept a single index, array of indices, or a verse object
  let indices = [];
  if (Array.isArray(verseOrIndices)) indices = verseOrIndices.slice();
  else if (typeof verseOrIndices === 'number') indices = [verseOrIndices];
  else if (verseOrIndices && verseOrIndices.key) {
    const idx = allVerses.findIndex(v => v.key === verseOrIndices.key);
    if (idx !== -1) indices = [idx];
  }
  if (indices.length === 0) return;

  // Fit verses to character limit
  const indicesToShow = getFittableIndices(indices, 800);
  const parts = indicesToShow.map(i => {
    const verseNum = allVerses[i].key.split(':')[1];
    const cleanText = allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '');
    return `${verseNum}  ${cleanText}`;
  });
  const textContent = parts.join(' ');
  
  const numberText = indicesToShow.length === 1 ? allVerses[indicesToShow[0]].key.split(':')[1] : '';
  const refText = indicesToShow.length === 1 ? `${allVerses[indicesToShow[0]].key} (KJV)` : `${allVerses[indicesToShow[0]].key} - ${allVerses[indicesToShow[indicesToShow.length-1]].key} (KJV)`;
  const showHint = indicesToShow.length < indices.length ? `Showing ${indicesToShow.length} of ${indices.length} selected` : null;
  
  // Get external display dimensions
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  // Render to live canvas (right preview - shows current live state)
  const liveCanvas = document.getElementById('live-canvas');
  if (liveCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.verses);
    const styles = getCanvasStylesFor('verse');
    window.currentContent = {
      number: numberText,
      text: textContent,
      reference: refText,
      showHint: showHint,
      width: width,
      height: height,
      backgroundMedia: backgroundMedia,
      styles
    };
    // If preview is in black or clear mode, reflect that in the preview canvas
    if (blackMode) {
      // Render solid black preview
      const ctx = liveCanvas.getContext('2d');
      liveCanvas.width = width;
      liveCanvas.height = height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    } else if (clearMode) {
      // Render background without text in preview
      const contentWithoutText = {
        ...window.currentContent,
        number: '',
        text: '',
        reference: ''
      };
      renderToCanvas(liveCanvas, contentWithoutText, width, height);
    } else {
      renderToCanvas(liveCanvas, window.currentContent, width, height);
    }
    
    // Text fade-in animation is applied only on external display (live.html)
    // Preview canvas shows instantly at full opacity
  }

  // Send update to the external live window with plain text (canvas needs plain text, not HTML)
  const backgroundMedia = getBackgroundMedia(defaultBackgrounds.verses);
  console.log('[DEBUG] Sending backgroundMedia to live window:', backgroundMedia);
  ipcRenderer.send('update-live-window', {
    number: numberText,
    text: textContent,  // Send plain text with double-space format for canvas rendering
    reference: refText,
    showingCount: indicesToShow.length,
    totalSelected: indices.length,
    backgroundMedia: backgroundMedia,
    styles: getCanvasStylesFor('verse'),
    transitionIn: transitionSettings['fade-in'],
    transitionOut: transitionSettings['fade-out']
  });
}

// Scaling is handled in scaleTextSize for both

function scaleTextSize(textLength) {
  const verseTextEl = document.getElementById('verse-text');
  const baseSize = 2; // em

  // Fit text to container height
  let fontSize = 2.5; // max
  verseTextEl.style.fontSize = `${fontSize}em`;

  // Return a promise that resolves when sizing has settled
  return new Promise((resolve) => {
    setTimeout(() => {
      while (verseTextEl.scrollHeight > verseTextEl.clientHeight && fontSize > 0.5) {
        fontSize -= 0.1;
        verseTextEl.style.fontSize = `${fontSize}em`;
      }
      // Scale other preview elements proportionally
      const ratio = fontSize / baseSize;
      document.getElementById('verse-number').style.fontSize = `${1.5 * ratio}em`;
      // document.getElementById('verse-reference').style.fontSize = `${0.8 * ratio}em`; // Keep fixed size

      // Note: Do NOT update live display from preview scaling
      // Live display sizing is handled independently when updateLive() is called
      
      resolve();
    }, 0);
  });
}

/**
 * Return the subset of selectedIndices that fit into the verse display area.
 * This function measures the rendered height in a hidden clone and returns
 * the largest prefix of the selection that fits.
 */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Return the subset of selectedIndices that fit within a character limit.
 * Verses are included in order until adding the next one would exceed the limit.
 * This ensures the preview/live display doesn't try to render excessively long passages.
 */
function getFittableIndices(indices, maxChars = 800) {
  if (!indices || indices.length === 0) return [];
  
  const sorted = indices.slice().sort((a,b) => a-b);
  const fittable = [];
  let totalChars = 0;

  for (let idx of sorted) {
    const verseNum = allVerses[idx].key.split(':')[1];
    const cleanText = allVerses[idx].text.replace(/(\.\d+[\s\S]*)$/, '');
    // Rough estimate: subscript markup + verse text
    const charCount = (`<sub>${verseNum}</sub> ${cleanText} `).length;
    
    if (totalChars + charCount > maxChars && fittable.length > 0) {
      // Adding this verse would exceed limit, stop here
      break;
    }
    
    fittable.push(idx);
    totalChars += charCount;
  }

  // If nothing fits, at least show the first selected verse
  if (fittable.length === 0 && sorted.length > 0) return [sorted[0]];
  return fittable;
}

async function handleVerseClick(i, e) {
  // Support shift-range selection
  if (e && e.shiftKey) {
    // If no anchor set, fall back to current selection or the clicked index
    if (anchorIndex === null) {
      if (selectedIndices && selectedIndices.length > 0) anchorIndex = selectedIndices[0];
      else anchorIndex = i;
    }
    const start = Math.min(anchorIndex, i);
    const end = Math.max(anchorIndex, i);
    selectedIndices = [];
    for (let k = start; k <= end; k++) selectedIndices.push(k);
  } else {
    selectedIndices = [i];
    anchorIndex = i;
  }

  console.debug('handleVerseClick selectedIndices', selectedIndices, 'anchor', anchorIndex, 'event.shiftKey', !!(e && e.shiftKey));

  updateVerseDisplay();
  // Only update preview if on verses tab
  if (currentTab === 'verses') {
    await updatePreview(selectedIndices);
  }
  const listContainer = document.getElementById('verse-list');
  const scrollTop = listContainer ? listContainer.scrollTop : 0;
  renderWindow(allVerses, scrollTop, selectedIndices, handleVerseClick);

  // Focus the clicked item after re-render so Enter will work
  const el = document.querySelector(`.verse-item[data-index="${i}"]`);
  if (el) setTimeout(() => el.focus(), 0);

  // Persist the selection
  try {
    await saveLastSelectionToSettings();
  } catch (err) {
    console.error('Failed to persist selection:', err);
  }
}

async function handleVerseDoubleClick(i) {
  // Check if we're in songs tab
  if (currentTab === 'songs') {
    if (selectedSongIndices.length > 0 && selectedSongVerseIndex !== null) {
      // Respect current clear/black mode when going live from songs - do not force exit here
      // (mode stays as user set it)
      
      await updateLiveFromSongVerse(selectedSongVerseIndex);
      
      // Turn on the live display when going live
      if (!liveMode) {
        toggleLive(true);
      }
      return;
    } else {
      return; // nothing to do in songs tab without selection
    }
  }
  
  // Verses tab logic
  // If an index is explicitly provided, treat as a single-verse go-live action.
  // If an array of indices is provided, use those.
  // Otherwise, use the current selection (useful for the Live toggle behavior).
  let indicesToGo = [];
  if (Array.isArray(i)) {
    indicesToGo = i.slice();
  } else if (typeof i === 'number') {
    indicesToGo = [i];
  } else if (selectedIndices && selectedIndices.length > 0) {
    indicesToGo = selectedIndices.slice();
  } else {
    return; // nothing to do
  }

  // Do not change clear/black mode here - respect user's current display mode

  await updateLive(indicesToGo);
  
  // Turn on the live display when going live
  if (!liveMode) {
    toggleLive(true);
  }

  // Persist live selection as the last selected verse (single or array)
  if (Array.isArray(i)) {
    // Don't change selectedIndices when coming from schedule
  } else if (typeof i === 'number') {
    selectedIndices = [i];
  }
  saveLastSelectionToSettings().catch(err => console.error('Failed to persist live selection', err));
}

function selectNextVerse(extendSelection = false) {
  if (!selectedIndices.length) {
    selectedIndices = [0];
    anchorIndex = 0;
  } else {
    const lastIndex = selectedIndices[selectedIndices.length - 1];
    if (lastIndex < allVerses.length - 1) {
      if (extendSelection) {
        // Extend selection from anchor
        if (anchorIndex === null) anchorIndex = selectedIndices[0];
        const newIndex = lastIndex + 1;
        
        // Build range from anchor to new index
        selectedIndices = [];
        const start = Math.min(anchorIndex, newIndex);
        const end = Math.max(anchorIndex, newIndex);
        for (let i = start; i <= end; i++) {
          selectedIndices.push(i);
        }
      } else {
        // Move selection to next verse
        selectedIndices = [lastIndex + 1];
        anchorIndex = selectedIndices[0];
      }
    }
  }
  
  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;
  
  // Scroll to make the last selected verse visible
  const targetIndex = selectedIndices[selectedIndices.length - 1];
  listContainer.scrollTop = targetIndex * ITEM_HEIGHT;
  
  updateVerseDisplay();
  updatePreview(selectedIndices);
  
  // Re-render after scroll to ensure the item is visible
  renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  
  // Focus the verse item - use a slightly longer timeout to ensure rendering is complete
  setTimeout(() => {
    const el = document.querySelector(`.verse-item[data-index="${targetIndex}"]`);
    if (el) el.focus();
  }, 5);
}

function selectPrevVerse(extendSelection = false) {
  if (!selectedIndices.length) {
    selectedIndices = [0];
    anchorIndex = 0;
  } else {
    const firstIndex = selectedIndices[0];
    if (firstIndex > 0) {
      if (extendSelection) {
        // Extend selection from anchor
        if (anchorIndex === null) anchorIndex = selectedIndices[0];
        const newIndex = firstIndex - 1;
        
        // Build range from anchor to new index
        selectedIndices = [];
        const start = Math.min(anchorIndex, newIndex);
        const end = Math.max(anchorIndex, newIndex);
        for (let i = start; i <= end; i++) {
          selectedIndices.push(i);
        }
      } else {
        // Move selection to previous verse
        selectedIndices = [firstIndex - 1];
        anchorIndex = selectedIndices[0];
      }
    }
  }
  
  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;
  
  // Scroll to make the first selected verse visible
  const targetIndex = selectedIndices[0];
  listContainer.scrollTop = targetIndex * ITEM_HEIGHT;
  
  updateVerseDisplay();
  updatePreview(selectedIndices);
  
  // Re-render after scroll to ensure the item is visible
  renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
  
  // Focus the verse item - use a slightly longer timeout to ensure rendering is complete
  setTimeout(() => {
    const el = document.querySelector(`.verse-item[data-index="${targetIndex}"]`);
    if (el) el.focus();
  }, 5);
}

function toggleLive(isActive) {
  liveMode = !!isActive;
  if (isActive) {
    ipcRenderer.invoke('create-live-window');
    
    // Display based on current tab and selection
    if (currentTab === 'media' && selectedMediaIndex !== null) {
      const media = allMedia[selectedMediaIndex];
      if (media) {
        displayMediaOnLive(media);
      }
    } else if (currentTab === 'songs' && selectedSongIndices.length > 0 && selectedSongVerseIndex !== null) {
      updateLiveFromSongVerse(selectedSongVerseIndex);
    } else if (selectedIndices.length > 0) {
      updateLive(selectedIndices);
    }
  } else {
    ipcRenderer.invoke('close-live-window');
  }
  // Update the Live button state in the UI
  updateLiveButtonState(isActive);
}

function updateLiveButtonState(isActive) {
  if (window.liveButton) {
    if (isActive) {
      window.liveButton.classList.add('active');
    } else {
      window.liveButton.classList.remove('active');
    }
  }
}

// ------------------ License / Auth Integration ------------------

async function getSavedToken() {
  try {
    const t = await secure.getToken();
    if (t) return t;
    // Fallback to settings (legacy)
    try {
      const s = await ipcRenderer.invoke('load-settings');
      if (s && s.auth && s.auth.token) return s.auth.token;
    } catch (e) {}
    return null;
  } catch (e) {
    console.error('secure get error', e);
    return null;
  }
}

async function saveToken(token) {
  try {
    let ok = false;
    try { ok = await secure.setToken(token); } catch (e) { console.error('secure.setToken exception', e); ok = false; }

    // Always mirror token in settings as a backup so restarts can recover reliably
    try { await ipcRenderer.invoke('update-settings', { auth: { token } }); } catch (e) { console.error('mirror settings save failed', e); }

    if (ok) {
      try { await ipcRenderer.invoke('update-settings', { lastAuthSavedAt: Date.now(), authStorage: 'keytar' }); } catch (e) {}
      return true;
    } else {
      // Keytar not available or failed — settings now contain token as fallback
      try { await ipcRenderer.invoke('update-settings', { lastAuthSavedAt: Date.now(), authStorage: 'settings' }); } catch (e) {}
      return true;
    }
  } catch (e) { console.error('secure set error', e); return false; }
}

async function clearToken() {
  try {
    await secure.deleteToken();
  } catch (e) { console.error('secure delete error', e); }
  try { await ipcRenderer.invoke('update-settings', { auth: null, lastAuthSavedAt: null, authStorage: null }); } catch (e) {}
}

async function createSetupModal() {
  // Create a full-screen overlay modal for initial setup
  if (document.getElementById('setup-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'setup-modal';
  modal.className = 'setup-overlay';
  // Inline fixed positioning as a fallback (ensures overlay centers correctly even if stylesheet is overridden)
  modal.style.position = 'fixed';
  modal.style.left = '0'; modal.style.top = '0'; modal.style.right = '0'; modal.style.bottom = '0';
  modal.style.display = 'flex'; modal.style.alignItems = 'center'; modal.style.justifyContent = 'center';
  modal.style.zIndex = '20000'; modal.style.background = 'rgba(0,0,0,0.6)';
  modal.innerHTML = `
    <div class="setup-card">
      <h2>Welcome to Liturgia</h2>
      <p id="setup-message">Sign in to validate ownership or subscribe.</p>
      <div class="form-row" style="margin-top:12px;">
        <input id="setup-email" class="input" type="email" placeholder="you@example.com" />
        <button id="btn-magic" class="btn">Send Magic Link</button>
      </div>
      <div class="form-row" style="margin-top:12px;">
        <button id="btn-enter-token" class="btn">Enter Token</button>
        <button id="btn-subscribe" class="btn primary">Subscribe / Purchase</button>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;">
        <button id="btn-continue-offline" class="btn">Continue Offline (grace)</button>
        <div id="setup-status" style="opacity:0.9;font-size:12px;color:var(--muted)"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  // Focus email input to let user start typing immediately
  const emailEl = document.getElementById('setup-email'); if (emailEl) setTimeout(()=>emailEl.focus(),50);

  // Resolve configured server (managed) up-front
  const _settings = await ipcRenderer.invoke('load-settings');
  const server = (_settings && _settings.licenseServer) ? _settings.licenseServer.replace(/\/$/, '') : 'https://jacqueb.me/liturgia';

  document.getElementById('btn-magic').onclick = async () => {
    const emailInput = document.getElementById('setup-email');
    const email = emailInput.value.trim();
    if (!email) { document.getElementById('setup-status').textContent = 'Enter an email'; emailInput.focus(); return; }    const btn = document.getElementById('btn-magic');
    btn.disabled = true;
    document.getElementById('setup-status').textContent = 'Sending magic link...';
    try {
      const res = await fetch(server.replace(/\/$/, '') + '/auth/magic-link.php', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(email)}`
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
      if (!res.ok) {
        const errMsg = (json && (json.error || json.message)) ? (json.error || json.message) : (res.status + ' ' + res.statusText);
        throw new Error('Network error: ' + errMsg);
      }
      if (json && json.ok) {
        // Persist chosen server so the app remembers it across restarts
        try { await ipcRenderer.invoke('update-settings', { licenseServer: server }); } catch (e) {}
        document.getElementById('setup-status').textContent = 'Magic link sent — check your email (and spam/junk folder) and paste the token via "Enter Token".';
      } else {
        document.getElementById('setup-status').textContent = 'Failed to send: ' + (json && (json.error || json.message) ? (json.error || json.message) : 'Unknown error');
      }
    } catch (e) {
      console.error('Magic link request failed', e);
      document.getElementById('setup-status').textContent = 'Error sending magic link: ' + (e && e.message ? e.message : 'Network/blocked by policy');
    } finally { btn.disabled = false; }
  };

  document.getElementById('btn-enter-token').onclick = async () => {
    // Server is resolved when the modal was created (hidden from user)
    if (!server) { document.getElementById('setup-status').textContent = 'Server not configured'; return; }
    // Show inline token modal instead of prompt
    if (document.getElementById('token-entry-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'token-entry-modal';
    modal.className = 'setup-overlay';
    // Inline fixed positioning fallback to ensure proper overlay behavior
    modal.style.position = 'fixed';
    modal.style.left = '0'; modal.style.top = '0'; modal.style.right = '0'; modal.style.bottom = '0';
    modal.style.display = 'flex'; modal.style.alignItems = 'center'; modal.style.justifyContent = 'center';
    modal.style.zIndex = '20000'; modal.style.background = 'rgba(0,0,0,0.6)';
    modal.innerHTML = `
      <div class="setup-card" style="width:420px;">
        <h3>Enter Sign-in Token</h3>
        <p>Paste the token from the magic link page or generated token below.</p>
        <textarea id="token-input" class="input" style="height:80px;font-size:12px;margin-top:8px;width:100%;"></textarea>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
          <button id="token-cancel" class="btn">Cancel</button>
          <button id="token-save" class="btn primary">Validate & Save</button>
        </div>
        <div id="token-status" style="margin-top:8px;color:var(--muted);font-size:12px;"></div>
      </div>
    `;
    document.body.appendChild(modal);
    // Focus the token input so users can paste immediately
    const tokenInput = document.getElementById('token-input'); if (tokenInput) setTimeout(()=>tokenInput.focus(),50);
    document.getElementById('token-cancel').onclick = () => { modal.remove(); };
    document.getElementById('token-save').onclick = async () => {
      const token = document.getElementById('token-input').value.trim();
      if (!token) { document.getElementById('token-status').textContent = 'Enter a token.'; return; }
      document.getElementById('token-status').textContent = 'Validating...';
      const result = await validateTokenAndActivate(token, server);
      if (result && result.ok) {
        const saved = await saveToken(token);
        // Persist the server we used so restarts keep it
        try { await ipcRenderer.invoke('update-settings', { licenseServer: server }); } catch (e) {}
        if (!saved) {
          document.getElementById('token-status').textContent = 'Signed in but failed to persist token to secure storage. It will be stored in settings as fallback.';
        } else if (result.active) {
          document.getElementById('token-status').textContent = 'Token validated and saved.';
        } else {
          document.getElementById('token-status').textContent = 'Signed in (license inactive). A watermark will be shown; activate to remove it.';
        }
        setTimeout(() => { modal.remove(); closeSetupModal(); }, 1200);
      } else {
        document.getElementById('token-status').textContent = 'Validation failed. Use admin/generate_token.php or the magic link.';
      }
    };
  };

  document.getElementById('btn-subscribe').onclick = async () => {
    // Ask for email to create checkout and open in external browser
    // 'server' variable is resolved when the modal was created (hidden from user)
    const emailInput = document.getElementById('setup-email');
    const email = emailInput.value.trim();
    if (!email) { document.getElementById('setup-status').textContent = 'Enter an email'; emailInput.focus(); return; }

    // Basic sanity check for email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { document.getElementById('setup-status').textContent = 'Enter a valid email address'; emailInput.focus(); return; }

    const btn = document.getElementById('btn-subscribe');
    btn.disabled = true;
    document.getElementById('setup-status').textContent = 'Creating checkout...';
    try {
      // Use application/x-www-form-urlencoded as Stripe expects
      const url = server.replace(/\/$/, '') + '/create-checkout-session.php';
      let res = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: `email=${encodeURIComponent(email)}&plan=monthly` });
      let j = null;
      let textBody = null;
      try { j = await res.json(); } catch (err) { textBody = await res.text().catch(()=>null); console.warn('create-checkout-session returned non-JSON'); }

      // If the server complains about content type, retry with JSON (works with newer servers)
      const errorMsg = (j && j.error) ? j.error : (textBody || '');
      if (errorMsg && /content type/i.test(errorMsg)) {
        console.warn('Server rejected urlencoded body, retrying with JSON');
        res = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:email, plan:'monthly'}) });
        try { j = await res.json(); } catch (err) { textBody = await res.text().catch(()=>null); }
      }

      if (j && j.url) { shell.openExternal(j.url); document.getElementById('setup-status').textContent = 'Checkout opened in browser.'; }
      else if (j && j.error) document.getElementById('setup-status').textContent = 'Failed to create checkout: ' + (j.error||'');
      else document.getElementById('setup-status').textContent = `Failed to create checkout: HTTP ${res.status} ${textBody||''}`;
    } catch (e) { console.error(e); document.getElementById('setup-status').textContent = 'Error creating checkout'; }
    finally { btn.disabled = false; }
  };

  document.getElementById('btn-continue-offline').onclick = async () => { closeSetupModal(); };
}

function closeSetupModal() { const m = document.getElementById('setup-modal'); if (m) m.remove(); }

// Helper: decode JWT payload without verification (UI-only)
function decodeJwtPayload(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = atob(b64);
    return JSON.parse(json);
  } catch (e) { return null; }
}

async function validateTokenAndActivate(token, serverUrl) {
  try {
    const settings = await ipcRenderer.invoke('load-settings') || {};
    const server = (serverUrl || settings.licenseServer || '').replace(/\/$/, '');
    if (!server) {
      ipcRenderer.send('license-status-update', { active: false, reason: 'no-server' });
      return { ok: false, reason: 'no-server' };
    }
    // Prefer query param first to avoid noisy 401s when Authorization header is stripped by proxies
    let res = null;
    try {
      res = await fetch(server + '/license-status.php?token=' + encodeURIComponent(token));
      if (res && res.status === 401) {
        try {
          console.warn('runCheck: license-status query-param rejected (401), trying Authorization header');
          res = await fetch(server + '/license-status.php', { headers: { 'Authorization': 'Bearer ' + token } });
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // network or URL error, try Authorization header as fallback
      try { res = await fetch(server + '/license-status.php', { headers: { 'Authorization': 'Bearer ' + token } }); } catch (e2) { /* ignore */ }
    }
    if (res && res.status && res.status !== 200) {
      try { console.warn('runCheck: license-status final response code', res.status); } catch(e) {}
    }

    if (res.status === 200) {
      const j = await res.json();
      try { console.info('runCheck: license-status response', j); } catch(e) {}
      // Mark as authoritative server response
      try { j.source = j.source || 'server'; } catch(e) {}
      // Broadcast license status to main->live window
      ipcRenderer.send('license-status-update', j);
      // Update fixed founder immediately in this renderer (avoid timing race)
      try { setFounderFixed(!!j.founder); } catch(e) { /* ignore */ }
      // Accept token if the server accepted it (200), even if not currently active.
      return { ok: true, active: !!j.active, status: j };
    }

    // If server rejects (401), allow device tokens validated via the sessions listing
    if (res.status === 401) {
      try {
        const li = await fetch(server + '/auth/list-tokens.php?token=' + encodeURIComponent(token));
        if (li && li.ok) {
          const lj = await li.json().catch(()=>null);
          if (lj && Array.isArray(lj.tokens) && lj.tokens.length > 0) {
              const email = lj.tokens[0].email || '';
            // Try to fetch richer account summary (plan & expiry) for this email
            try {
              const as = await fetch(server + '/license-status.php?token=' + encodeURIComponent(token));
              if (as && as.ok) {
                const aj = await as.json().catch(()=>null);
                if (aj && aj.ok && aj.status) {
                  const status = Object.assign({}, aj.status, { sessions: lj.tokens });
                  try { status.source = status.source || 'server'; } catch(e) {}
                  ipcRenderer.send('license-status-update', status);
                  try { setFounderFixed(!!status.founder); } catch(e) {}
                  return { ok: true, active: !!aj.status.active, status };
                }
              }
            } catch(e) { /* ignore */ }

            // If account-summary failed (500) or didn't return usable status, try to decode JWT payload locally as a fallback
            try {
              const payload = decodeJwtPayload(token);
              if (payload) {
                const pEmail = payload.email || payload.sub || '';
                const pExp = payload.exp ? payload.exp : null;
                const status = { email: pEmail || email, active: true, plan: 'token', sessions: lj.tokens };
                if (pExp) status.expires_at = pExp;
                try { status.source = 'jwt-fallback'; } catch(e) {}
                ipcRenderer.send('license-status-update', status);
                return { ok: true, active: true, status };
              }
            } catch (e) { /* ignore */ }

            const status = { email, active: true, plan: 'token', sessions: lj.tokens };
            try { status.source = 'session-fallback'; } catch(e) {}
            ipcRenderer.send('license-status-update', status);
            return { ok: true, active: true, status };
          }
        }
      } catch(e) { /* ignore */ }
    }

    ipcRenderer.send('license-status-update', { active: false, reason: 'http-' + res.status });
    return { ok: false, reason: 'http-' + res.status };
  } catch (e) {
    console.error('validate error', e);
    ipcRenderer.send('license-status-update', { active: false, reason: 'error', error: e.message });
    return { ok: false, reason: 'error', error: e.message };
  }
}

async function ensureAuthSetup() {
  // Called on startup. If no token, show setup modal.
  const token = await getSavedToken();
  const settings = await ipcRenderer.invoke('load-settings') || {};
  const server = settings.licenseServer || '';
  if (token) {
    const result = await validateTokenAndActivate(token, server);
    if (result && result.ok) {
      scheduleLicensePolling();
      return; // proceed
    }
    // invalid token: clear and show setup
    await clearToken();
    ipcRenderer.send('license-status-update', { active: false, reason: 'invalid-token' });
  } else {
    ipcRenderer.send('license-status-update', { active: false, reason: 'no-token' });
  }
  // Show setup modal
  createSetupModal();
  scheduleLicensePolling();

  // Ensure setup modal is shown after splash closes (splash might overlay it)
  ipcRenderer.on('splash-closed', async () => {
    try {
      const token = await getSavedToken();
      if (!token) {
        if (!document.getElementById('setup-modal')) createSetupModal();
        else {
          // Ensure it's visible and focused
          const m = document.getElementById('setup-modal'); if (m) { m.style.display='flex'; const el = document.getElementById('setup-email'); if (el) setTimeout(()=>el.focus(),50); }
        }
      } else {
        const settings = await ipcRenderer.invoke('load-settings') || {};
        const server = settings.licenseServer || '';
        const res = await validateTokenAndActivate(token, server);
        if (!res || !res.ok) {
          if (!document.getElementById('setup-modal')) createSetupModal();
          else { const m = document.getElementById('setup-modal'); if (m) { m.style.display='flex'; const el = document.getElementById('setup-email'); if (el) setTimeout(()=>el.focus(),50); }}
        }
      }
      try { window.focus(); } catch(e){}
      try { ipcRenderer.invoke('focus-main-window'); } catch(e){}
    } catch (e) { console.warn('splash-closed handler error', e); }
  });

  // If the splash already closed before this handler attached, show the setup modal now
  (async function(){
    try {
      const closed = await ipcRenderer.invoke('is-splash-closed');
      if (closed) {
        const token = await getSavedToken();
        if (!token) { if (!document.getElementById('setup-modal')) createSetupModal(); }
      }
    } catch(e) { /* ignore */ }

    // Create and manage a fixed founder subtext in the bottom-right for founder users
    try {


      // Apply initial state if there is already a license status cached in main
      try {
        const s = await ipcRenderer.invoke('get-current-license-status');
        if (s && (s.founder || (s.token_payload && s.token_payload.founder))) {
          try { setFounderFixed(true); console.info && console.info('founder-fixed initial visible via cached status', s); } catch(e) {}
        }
      } catch(e) { /* ignore */ }

      // Toggle on live updates
      ipcRenderer.on('license-status', (event, status) => {
        try {
          const isFounder = !!(status && (status.founder || status.is_founder || (status.token_payload && status.token_payload.founder)));
          try { console.info('founder-fixed toggle; isFounder=', isFounder, 'status=', status); } catch(e) {}
          try { setFounderFixed(isFounder); } catch(e) { console.warn('setFounderFixed failed in license-status handler', e); }
        } catch (e) { console.warn('founder fixed toggle failed', e); }
      });
    } catch(e) { console.warn('founder fixed init failed', e); }
  })();
}

// Poll license status periodically (runs immediately and every 15 minutes)
let _licensePollIntervalId = null;

// Helper to show/hide the fixed founder subtext immediately from renderer responses
function setFounderFixed(isFounder) {
  try {
    let el = document.getElementById('founder-fixed-msg');
    if (!el) {
      el = document.createElement('div');
      el.id = 'founder-fixed-msg';
      el.className = 'founder-subtext-fixed';
      el.textContent = 'You are a founding church — thank you for your support.';
      document.body.appendChild(el);
    }
    if (isFounder) { el.classList.add('visible'); el.style.display = ''; } else { el.classList.remove('visible'); el.style.display = ''; }
  } catch (e) { console.warn('setFounderFixed failed', e); }
}

function scheduleLicensePolling() {
  if (_licensePollIntervalId) clearInterval(_licensePollIntervalId);
  const runCheck = async () => {
    const token = await getSavedToken();
    if (token) await validateTokenAndActivate(token);
    else ipcRenderer.send('license-status-update', { active: false, reason: 'no-token' });
  };
  // Run immediately
  runCheck().catch(e => { console.error('license poll error', e); ipcRenderer.send('license-status-update', { active: false, reason: 'poll-error' }); });
  _licensePollIntervalId = setInterval(() => runCheck().catch(e => { console.error('license poll error', e); ipcRenderer.send('license-status-update', { active: false, reason: 'poll-error' }); }), 15 * 60 * 1000);
} 

async function loadCoreUI() {
  // This is where previous initiation code that expects license to be checked goes
  // For now, do nothing special; the rest of DOMContentLoaded will continue.
}


async function saveLastSelectionToSettings() {
  try {
    if (!selectedIndices || selectedIndices.length === 0) {
      // remove lastSelected by setting null (server will delete key)
      await ipcRenderer.invoke('update-settings', { lastSelected: null });
    } else {
      const start = selectedIndices[0];
      const end = selectedIndices[selectedIndices.length - 1];
      await ipcRenderer.invoke('update-settings', {
        lastSelected: {
          startKey: allVerses[start].key,
          endKey: (start === end) ? null : allVerses[end].key,
          bible: currentBibleFile
        }
      });
    }
  } catch (err) {
    console.error('Failed to save last selection to settings:', err);
  }
}

function toggleBlack() {
  // If clear mode is active, switch directly to black on the live window (avoid flashing normal)
  if (clearMode) {
    clearMode = false;
    blackMode = true;

    // Update preview to solid black
    const liveCanvas = document.getElementById('live-canvas');
    if (liveCanvas) {
      const width = window.currentContent ? window.currentContent.width : liveCanvas.width;
      const height = window.currentContent ? window.currentContent.height : liveCanvas.height;
      liveCanvas.width = width;
      liveCanvas.height = height;
      const ctx = liveCanvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }

    // Directly instruct live window to enter black mode
    ipcRenderer.send('set-live-mode', 'black');
    return;
  }

  blackMode = !blackMode;

  if (blackMode) {
    // Update preview to solid black
    const liveCanvas = document.getElementById('live-canvas');
    if (liveCanvas) {
      const width = window.currentContent ? window.currentContent.width : liveCanvas.width;
      const height = window.currentContent ? window.currentContent.height : liveCanvas.height;
      liveCanvas.width = width;
      liveCanvas.height = height;
      const ctx = liveCanvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }
    // Tell live window to enter black mode
    ipcRenderer.send('set-live-mode', 'black');
  } else {
    // Exit black: restore preview and tell live window to return to normal
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        renderToCanvas(liveCanvas, window.currentContent, window.currentContent.width, window.currentContent.height);
      }
    }
    ipcRenderer.send('set-live-mode', 'normal');
  }
}

// ========== SCHEDULE MANAGEMENT ==========

function initSchedule() {
  const scheduleList = document.getElementById('schedule-list');
  const verseList = document.getElementById('verse-list');
  
  // Load schedule from settings
  loadScheduleFromSettings();
  
  // Make verse items draggable
  verseList.addEventListener('dragstart', handleVerseDragStart);
  
  // Setup drop zone
  scheduleList.addEventListener('dragover', handleScheduleDragOver);
  scheduleList.addEventListener('dragleave', handleScheduleDragLeave);
  scheduleList.addEventListener('drop', handleScheduleDrop);
}

function handleVerseDragStart(e) {
  if (!e.target.classList.contains('verse-item')) return;
  
  // Store the current selection
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', JSON.stringify(selectedIndices));
}

function handleScheduleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.getElementById('schedule-list').classList.add('drag-over');
}

function handleScheduleDragLeave(e) {
  if (e.target.id === 'schedule-list') {
    document.getElementById('schedule-list').classList.remove('drag-over');
  }
}

function handleScheduleDrop(e) {
  e.preventDefault();
  document.getElementById('schedule-list').classList.remove('drag-over');
  
  const data = e.dataTransfer.getData('text/plain');
  if (!data) return;
  
  try {
    const dragData = JSON.parse(data);
    
    if (dragData.type === 'song') {
      // Song drop
      addSongToSchedule(dragData.songIndex);
    } else if (dragData.type === 'media') {
      // Media drop
      addMediaToSchedule(dragData.mediaIndex);
    } else if (Array.isArray(dragData)) {
      // Verse indices (legacy format)
      addScheduleItem(dragData);
    }
  } catch (err) {
    console.error('Failed to parse dropped data:', err);
  }
}

function addMediaToSchedule(mediaIndex) {
  const media = allMedia[mediaIndex];
  if (!media) return;
  
  const newItem = {
    type: 'media',
    mediaIndex: mediaIndex,
    expanded: false
  };
  
  scheduleItems.push(newItem);
  renderSchedule();
  saveScheduleToSettings();
}

function addSongToSchedule(songIndex) {
  const song = allSongs[songIndex];
  if (!song) return;
  
  const newItem = {
    type: 'song',
    songIndex: songIndex,
    expanded: false,
    selectedVerses: []
  };
  
  scheduleItems.push(newItem);
  renderSchedule();
  saveScheduleToSettings();
}

function addScheduleItem(indices) {
  const newItem = {
    type: 'verses',
    indices: [...indices],
    expanded: false,
    selectedVerses: [] // For shift-click selection within expanded group
  };
  
  scheduleItems.push(newItem);
  renderSchedule();
  saveScheduleToSettings();
}

function renderSchedule() {
  const scheduleList = document.getElementById('schedule-list');
  scheduleList.innerHTML = '';
  
  if (scheduleItems.length === 0) {
    scheduleList.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">Drag verses here to add to schedule</div>';
    return;
  }
  
  scheduleItems.forEach((item, itemIndex) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'schedule-item';
    itemDiv.setAttribute('draggable', 'true');
    itemDiv.setAttribute('data-schedule-index', itemIndex);
    
    // Drag handlers for reordering
    itemDiv.addEventListener('dragstart', handleScheduleItemDragStart);
    itemDiv.addEventListener('dragover', handleScheduleItemDragOver);
    itemDiv.addEventListener('drop', handleScheduleItemDrop);
    itemDiv.addEventListener('dragend', handleScheduleItemDragEnd);
    
    // Create header
    const header = document.createElement('div');
    header.className = 'schedule-item-header';
    
    const itemType = item.type || 'verses'; // Default to verses for backwards compatibility
    const itemLength = itemType === 'song' ? getSongVerseCount(item.songIndex) : 
                       itemType === 'media' ? 1 : 
                       item.indices.length;
    
    // Arrow icon (only show if more than 1 verse)
    if (itemLength > 1) {
      const arrow = document.createElement('div');
      arrow.className = 'expand-arrow' + (item.expanded ? ' expanded' : '');
      arrow.innerHTML = '▶';
      arrow.style.cssText = 'padding: 4px; margin: -4px; cursor: pointer;'; // Increase hitbox
      arrow.onclick = (e) => {
        e.stopPropagation();
        toggleScheduleItem(itemIndex);
      };
      header.appendChild(arrow);
    } else {
      // Spacer for single verses
      const spacer = document.createElement('div');
      spacer.style.width = '16px';
      spacer.style.marginRight = '6px';
      header.appendChild(spacer);
    }
    
    // Icon on header (song / verse / media)
    const iconDiv = document.createElement('div');
    iconDiv.className = 'schedule-item-icon';
    if (itemType === 'song') {
      iconDiv.innerHTML = '<i class="fa-solid fa-music" aria-hidden="true"></i>';
    } else if (itemType === 'media') {
      iconDiv.innerHTML = '<i class="fa-solid fa-image" aria-hidden="true"></i>';
    } else {
      iconDiv.innerHTML = '<i class="fa-solid fa-book" aria-hidden="true"></i>';
    }
    header.appendChild(iconDiv);

    // Text
    const text = document.createElement('div');
    text.className = 'schedule-item-text';
    
    let displayText = '';
    if (itemType === 'song') {
      const song = allSongs[item.songIndex];
      displayText = song ? song.title : 'Unknown Song';
      text.textContent = displayText;
      text.title = displayText;
    } else if (itemType === 'media') {
      const media = allMedia[item.mediaIndex];
      const mediaName = media ? media.name : 'Unknown Media';
      displayText = mediaName;
      text.textContent = displayText;
      text.title = displayText;
    } else {
      displayText = getScheduleItemLabel(item.indices);
      text.textContent = displayText;
      text.title = displayText;
    }
    
    header.appendChild(text);
    
    // Make header focusable and add selection state
    header.tabIndex = 0;
    if (selectedScheduleItems.includes(itemIndex)) {
      header.classList.add('selected');
    }
    
    // Delete button
    const deleteBtn = document.createElement('div');
    deleteBtn.innerHTML = '×';
    deleteBtn.style.cssText = 'width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 20px; color: #999; margin-left: 4px;';
    deleteBtn.onmouseover = () => deleteBtn.style.color = '#fff';
    deleteBtn.onmouseout = () => deleteBtn.style.color = '#999';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteScheduleItem(itemIndex);
    };
    header.appendChild(deleteBtn);
    
    // Click handlers for header
    header.onclick = (e) => {
      if (e.target === header || e.target === text) {
        focusedScheduleItem = { type: 'header', itemIndex: itemIndex };
        handleScheduleItemClick(itemIndex, e);
      }
    };
    header.ondblclick = (e) => {
      // Don't trigger double-click if user clicked delete button
      if (e.target === deleteBtn) return;
      handleScheduleItemDoubleClick(itemIndex);
    };
    header.addEventListener('keydown', (e) => {
      console.log('Schedule header key pressed:', e.key, 'itemIndex:', itemIndex);
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        console.log('Enter pressed on schedule header, calling handleScheduleItemDoubleClick');
        handleScheduleItemDoubleClick(itemIndex);
      }
    });
    
    itemDiv.appendChild(header);
    
    // Create expanded verse list (if multi-verse and expanded)
    if (itemLength > 1) {
      const versesDiv = document.createElement('div');
      versesDiv.className = 'schedule-item-verses' + (item.expanded ? ' expanded' : '');
      
      if (itemType === 'song') {
        // Render song verses
        const song = allSongs[item.songIndex];
        if (song) {
          let verseIndex = 0;
          song.lyrics.forEach(section => {
            const verses = section.text.split(/\\n\\n+/);
            verses.forEach((verse, i) => {
              const verseItem = document.createElement('div');
              verseItem.className = 'schedule-verse-item';
              verseItem.tabIndex = 0;
              // icon + text elements for song verse
              const verseIcon = document.createElement('span');
              verseIcon.className = 'schedule-verse-icon';
              verseIcon.innerHTML = '<i class="fa-solid fa-music" aria-hidden="true"></i>';
              const verseText = document.createElement('span');
              verseText.className = 'schedule-verse-text';
              
              // First line of verse as label
              const firstLine = verse.split('\\n')[0];
              const label = firstLine.length > 40 ? firstLine.substring(0, 40) + '...' : firstLine;
              verseText.textContent = `${section.section} (${i + 1}): ${label}`;
              verseItem.appendChild(verseIcon);
              verseItem.appendChild(verseText);
              
              if (item.selectedVerses && item.selectedVerses.includes(verseIndex)) {
                verseItem.classList.add('selected');
              }
              
              const currentVerseIndex = verseIndex;
              verseItem.onclick = (e) => {
                if (e.target === verseItem) {
                  focusedScheduleItem = { type: 'song-verse', itemIndex: itemIndex, verseIndex: currentVerseIndex };
                  handleScheduleSongVerseClick(itemIndex, currentVerseIndex, e);
                }
              };
              verseItem.ondblclick = () => handleScheduleSongVerseDoubleClick(itemIndex, currentVerseIndex);
              verseItem.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  handleScheduleSongVerseDoubleClick(itemIndex, currentVerseIndex);
                }
              });
              
              versesDiv.appendChild(verseItem);
              verseIndex++;
            });
          });
        }
      } else {
        // Render bible verses
        item.indices.forEach((verseIndex, i) => {
        const verseItem = document.createElement('div');
        verseItem.className = 'schedule-verse-item';
        verseItem.tabIndex = 0; // Make focusable for keyboard navigation
        verseItem.setAttribute('draggable', 'false'); // Prevent nested items from being draggable
        if (item.selectedVerses.includes(i)) {
          verseItem.classList.add('selected');
        }
        
        const verse = allVerses[verseIndex];
        if (verse) {
          const match = verse.key.match(/^(.+?)\s+(\d+):(\d+)$/);
          const verseLabel = match ? `${match[1]} ${match[2]}:${match[3]}` : verse.key;
          const verseIcon = document.createElement('span');
          verseIcon.className = 'schedule-verse-icon';
          verseIcon.innerHTML = '<i class="fa-solid fa-book" aria-hidden="true"></i>';
          const verseText = document.createElement('span');
          verseText.className = 'schedule-verse-text';
          verseText.textContent = verseLabel;
          verseItem.appendChild(verseIcon);
          verseItem.appendChild(verseText);
        } else {
          const verseIcon = document.createElement('span');
          verseIcon.className = 'schedule-verse-icon';
          verseIcon.innerHTML = '<i class="fa-solid fa-book" aria-hidden="true"></i>';
          const verseText = document.createElement('span');
          verseText.className = 'schedule-verse-text';
          verseText.textContent = 'Unknown';
          verseItem.appendChild(verseIcon);
          verseItem.appendChild(verseText);
        }
        
        verseItem.onclick = (e) => {
          e.stopPropagation(); // Prevent triggering parent drag
          focusedScheduleItem = { type: 'verse', itemIndex: itemIndex, verseIndex: i };
          handleScheduleVerseClick(itemIndex, i, e);
        };
        verseItem.ondblclick = () => handleScheduleVerseDoubleClick(itemIndex, i);
        verseItem.addEventListener('keydown', (e) => {
          console.log('Schedule verse key pressed:', e.key, 'itemIndex:', itemIndex, 'verseIndex:', i);
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            console.log('Enter pressed on schedule verse, calling handleScheduleVerseDoubleClick');
            handleScheduleVerseDoubleClick(itemIndex, i);
          }
        });
        
        versesDiv.appendChild(verseItem);
        });
      }
      
      itemDiv.appendChild(versesDiv);
    }
    
    scheduleList.appendChild(itemDiv);
  });
  
  // Re-focus the previously focused item after render
  if (focusedScheduleItem) {
    setTimeout(() => {
      if (focusedScheduleItem.type === 'header') {
        const headers = document.querySelectorAll('.schedule-item-header');
        if (headers[focusedScheduleItem.itemIndex]) {
          headers[focusedScheduleItem.itemIndex].focus();
        }
      } else if (focusedScheduleItem.type === 'verse') {
        const item = scheduleItems[focusedScheduleItem.itemIndex];
        if (item && item.expanded) {
          const allVerseItems = document.querySelectorAll('.schedule-verse-item');
          // Find the correct verse item by counting
          let count = 0;
          for (let i = 0; i < focusedScheduleItem.itemIndex; i++) {
            if (scheduleItems[i].indices.length > 1 && scheduleItems[i].expanded) {
              count += scheduleItems[i].indices.length;
            }
          }
          count += focusedScheduleItem.verseIndex;
          if (allVerseItems[count]) {
            allVerseItems[count].focus();
          }
        }
      }
    }, 10);
  }
}

function deleteScheduleItem(itemIndex) {
  scheduleItems.splice(itemIndex, 1);
  renderSchedule();
  saveScheduleToSettings();
}

function getSongVerseCount(songIndex) {
  const song = allSongs[songIndex];
  if (!song) return 0;
  
  let count = 0;
  song.lyrics.forEach(section => {
    count += section.text.split(/\n\n+/).length;
  });
  return count;
}

function getScheduleItemLabel(indices) {
  if (!allVerses || allVerses.length === 0) {
    return 'Loading...';
  }
  
  if (indices.length === 0) return 'Empty';
  
  // Helper to parse "Genesis 2:25" -> { book: "Genesis", chapter: 2, verse: 25 }
  const parseKey = (key) => {
    const match = key.match(/^(.+?)\s+(\d+):(\d+)$/);
    if (!match) return null;
    return { book: match[1], chapter: parseInt(match[2]), verse: parseInt(match[3]) };
  };
  
  if (indices.length === 1) {
    const verse = allVerses[indices[0]];
    if (!verse) return 'Unknown';
    const parsed = parseKey(verse.key);
    return parsed ? `${parsed.book} ${parsed.chapter}:${parsed.verse}` : verse.key;
  }
  
  const first = allVerses[indices[0]];
  const last = allVerses[indices[indices.length - 1]];
  
  if (!first || !last) return 'Unknown';
  
  const firstParsed = parseKey(first.key);
  const lastParsed = parseKey(last.key);
  
  if (!firstParsed || !lastParsed) return `${first.key} - ${last.key}`;
  
  if (firstParsed.book === lastParsed.book && firstParsed.chapter === lastParsed.chapter) {
    return `${firstParsed.book} ${firstParsed.chapter}:${firstParsed.verse}-${lastParsed.verse}`;
  } else if (firstParsed.book === lastParsed.book) {
    return `${firstParsed.book} ${firstParsed.chapter}:${firstParsed.verse} - ${lastParsed.chapter}:${lastParsed.verse}`;
  } else {
    return `${firstParsed.book} ${firstParsed.chapter}:${firstParsed.verse} - ${lastParsed.book} ${lastParsed.chapter}:${lastParsed.verse}`;
  }
}

function toggleScheduleItem(itemIndex) {
  scheduleItems[itemIndex].expanded = !scheduleItems[itemIndex].expanded;
  scheduleItems[itemIndex].selectedVerses = []; // Clear selection when toggling
  renderSchedule();
}

function handleScheduleItemClick(itemIndex, event) {
  const item = scheduleItems[itemIndex];
  const itemType = item.type || 'verses';
  
  // Handle multi-selection
  if (event.shiftKey && anchorScheduleIndex !== null) {
    // Shift-click: select range
    const start = Math.min(anchorScheduleIndex, itemIndex);
    const end = Math.max(anchorScheduleIndex, itemIndex);
    selectedScheduleItems = [];
    for (let i = start; i <= end; i++) {
      selectedScheduleItems.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Ctrl-click: toggle selection
    const idx = selectedScheduleItems.indexOf(itemIndex);
    if (idx >= 0) {
      selectedScheduleItems.splice(idx, 1);
      if (anchorScheduleIndex === itemIndex) {
        anchorScheduleIndex = selectedScheduleItems.length > 0 ? selectedScheduleItems[0] : null;
      }
    } else {
      selectedScheduleItems.push(itemIndex);
      anchorScheduleIndex = itemIndex;
    }
  } else {
    // Normal click: select only this item
    selectedScheduleItems = [itemIndex];
    anchorScheduleIndex = itemIndex;
    
    // If it's a song, switch to songs tab and select it
    if (itemType === 'song') {
      switchTab('songs');
      selectedSongIndices = [item.songIndex];
      renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
      displaySelectedSong();
      
      // Preview first verse (use first selected verse if expanded, otherwise verse 0)
      const firstVerseIndex = (item.expanded && item.selectedVerses.length > 0) ? item.selectedVerses[0] : 0;
      const verseData = getScheduleSongVerseText(item.songIndex, firstVerseIndex);
      if (verseData) {
        updatePreviewFromSongVerse(firstVerseIndex, verseData);
      }
    } else if (itemType === 'media') {
      // If it's media, display on preview canvas
      const media = allMedia[item.mediaIndex];
      console.log('Schedule media item clicked:', media);
      if (media) {
        displayMediaOnPreview(media);
      }
    }
  }
  
  renderSchedule();
  
  // Preview all verses from selected schedule items (only for bible verses)
  if (itemType === 'verses') {
    const allIndices = selectedScheduleItems.flatMap(i => scheduleItems[i].indices);
    if (allIndices.length > 0) {
      updatePreview(allIndices);
    }
  }
}

function handleScheduleItemDoubleClick(itemIndex) {
  const item = scheduleItems[itemIndex];
  const itemType = item.type || 'verses';
  
  // Disable clear/black mode when going live
  if (clearMode) clearMode = false;
  if (blackMode) blackMode = false;
  
  if (itemType === 'song') {
    // For songs, switch to songs tab and select the song
    switchTab('songs');
    selectedSongIndices = [item.songIndex];
    renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
    displaySelectedSong();
    
    // Go live with first verse (use first selected verse if expanded, otherwise verse 0)
    const firstVerseIndex = (item.expanded && item.selectedVerses.length > 0) ? item.selectedVerses[0] : 0;
    const verseData = getScheduleSongVerseText(item.songIndex, firstVerseIndex);
    if (verseData) {
      updateLiveFromSongVerse(firstVerseIndex, verseData);
    }
  } else if (itemType === 'media') {
    // For media, display the media file
    const media = allMedia[item.mediaIndex];
    if (media) {
      displayMediaOnLive(media);
    }
  } else {
    // For bible verses, go live with all selected schedule items (or just this one if not selected)
    let indicesToShow;
    if (selectedScheduleItems.includes(itemIndex)) {
      // Use all selected items
      indicesToShow = selectedScheduleItems.flatMap(i => scheduleItems[i].indices);
    } else {
      // Just this item
      indicesToShow = item.indices;
    }
    
    handleVerseDoubleClick(indicesToShow);
  }
}

function handleScheduleVerseClick(itemIndex, verseIndexInGroup, event) {
  const item = scheduleItems[itemIndex];
  
  if (event.shiftKey && item.selectedVerses.length > 0) {
    // Shift-click: select range
    const lastSelected = item.selectedVerses[item.selectedVerses.length - 1];
    const start = Math.min(lastSelected, verseIndexInGroup);
    const end = Math.max(lastSelected, verseIndexInGroup);
    
    item.selectedVerses = [];
    for (let i = start; i <= end; i++) {
      item.selectedVerses.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Ctrl-click: toggle selection
    const idx = item.selectedVerses.indexOf(verseIndexInGroup);
    if (idx >= 0) {
      item.selectedVerses.splice(idx, 1);
    } else {
      item.selectedVerses.push(verseIndexInGroup);
    }
  } else {
    // Normal click: select only this verse
    item.selectedVerses = [verseIndexInGroup];
  }
  
  renderSchedule();
  
  // Preview the selected verses
  const selectedIndices = item.selectedVerses.map(i => item.indices[i]);
  if (selectedIndices.length > 0) {
    updatePreview(selectedIndices);
  }
}

function handleScheduleVerseDoubleClick(itemIndex, verseIndexInGroup) {
  const item = scheduleItems[itemIndex];
  
  // Go live with selected verses (or just this one if none selected)
  let indicesToShow;
  if (item.selectedVerses.length > 0) {
    indicesToShow = item.selectedVerses.map(i => item.indices[i]);
  } else {
    indicesToShow = [item.indices[verseIndexInGroup]];
  }
  
  handleVerseDoubleClick(indicesToShow);
}

function handleScheduleSongVerseClick(itemIndex, verseIndex, event) {
  const item = scheduleItems[itemIndex];
  
  // Switch to songs tab and select the song
  switchTab('songs');
  selectedSongIndices = [item.songIndex];
  selectedSongVerseIndex = verseIndex;
  renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
  displaySelectedSong();
  
  // Handle multi-selection
  if (event.shiftKey && item.selectedVerses.length > 0) {
    const lastSelected = item.selectedVerses[item.selectedVerses.length - 1];
    const start = Math.min(lastSelected, verseIndex);
    const end = Math.max(lastSelected, verseIndex);
    
    item.selectedVerses = [];
    for (let i = start; i <= end; i++) {
      item.selectedVerses.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    const idx = item.selectedVerses.indexOf(verseIndex);
    if (idx >= 0) {
      item.selectedVerses.splice(idx, 1);
    } else {
      item.selectedVerses.push(verseIndex);
    }
  } else {
    item.selectedVerses = [verseIndex];
  }
  
  renderSchedule();
  
  // Preview the verse
  const song = allSongs[item.songIndex];
  if (song) {
    const verseData = getScheduleSongVerseText(item.songIndex, verseIndex);
    if (verseData) {
      updatePreviewFromSongVerse(verseIndex, verseData);
    }
  }
}

function handleScheduleSongVerseDoubleClick(itemIndex, verseIndex) {
  const item = scheduleItems[itemIndex];
  const song = allSongs[item.songIndex];
  if (!song) return;
  
  const verseData = getScheduleSongVerseText(item.songIndex, verseIndex);
  if (verseData) {
    updateLiveFromSongVerse(verseIndex, verseData);
  }
}

function getScheduleSongVerseText(songIndex, verseIndex) {
  const song = allSongs[songIndex];
  if (!song) return null;
  
  let currentIndex = 0;
  for (const section of song.lyrics) {
    const verses = section.text.split(/\\n\\n+/);
    for (const verse of verses) {
      if (currentIndex === verseIndex) {
        return {
          title: song.title,
          section: section.section,
          text: verse
        };
      }
      currentIndex++;
    }
  }
  return null;
}

function navigateScheduleSongVerse(direction) {
  if (!focusedScheduleItem || focusedScheduleItem.type !== 'song-verse') return;
  
  const { itemIndex, verseIndex } = focusedScheduleItem;
  const item = scheduleItems[itemIndex];
  if (!item || item.type !== 'song') return;
  
  const song = allSongs[item.songIndex];
  if (!song) return;
  
  // Count total verses
  let totalVerses = 0;
  song.lyrics.forEach(section => {
    totalVerses += section.text.split(/\\n\\n+/).length;
  });
  
  const newVerseIndex = verseIndex + direction;
  if (newVerseIndex < 0 || newVerseIndex >= totalVerses) return;
  
  // Update focused item
  focusedScheduleItem.verseIndex = newVerseIndex;
  
  // Simulate click on new verse
  handleScheduleSongVerseClick(itemIndex, newVerseIndex, { ctrlKey: false, shiftKey: false });
  
  // Focus the new verse element
  setTimeout(() => {
    const scheduleList = document.getElementById('schedule-list');
    const itemElements = scheduleList.children;
    if (itemElements[itemIndex]) {
      const versesDiv = itemElements[itemIndex].querySelector('.schedule-verses');
      if (versesDiv) {
        const verseElements = versesDiv.querySelectorAll('.schedule-verse-item');
        if (verseElements[newVerseIndex]) {
          verseElements[newVerseIndex].focus();
        }
      }
    }
  }, 50);
}

async function saveScheduleToSettings() {
  try {
    // Use atomic update to avoid overwriting other settings
    await ipcRenderer.invoke('update-settings', { schedule: scheduleItems });
  } catch (err) {
    console.error('Failed to save schedule to settings:', err);
  }
}

async function loadScheduleFromSettings() {
  try {
    const settings = await ipcRenderer.invoke('load-settings') || {};
    if (settings.schedule && Array.isArray(settings.schedule)) {
      scheduleItems = settings.schedule;
      // Only render if allVerses is populated, otherwise renderSchedule will be called after verses load
      if (allVerses && allVerses.length > 0) {
        renderSchedule();
      }
    }
  } catch (err) {
    console.error('Failed to load schedule from settings:', err);
  }
}

async function saveSongViewMode() {
  try {
    await ipcRenderer.invoke('update-settings', { songVerseViewMode });
  } catch (err) {
    console.error('Failed to save song view mode:', err);
  }
}

async function loadSongViewMode() {
  try {
    const settings = await ipcRenderer.invoke('load-settings') || {};
    if (settings.songVerseViewMode) {
      songVerseViewMode = settings.songVerseViewMode;
      const viewToggle = document.getElementById('song-view-toggle');
      if (viewToggle) {
        viewToggle.textContent = songVerseViewMode === 'full' ? 'Verse Blocks' : 'Full Song';
      }
    }
  } catch (err) {
    console.error('Failed to load song view mode:', err);
  }
}

let draggedScheduleIndex = null;

function handleScheduleItemDragStart(e) {
  draggedScheduleIndex = parseInt(e.currentTarget.getAttribute('data-schedule-index'));
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'schedule-reorder');
  e.currentTarget.style.opacity = '0.5';
}

function handleScheduleItemDragOver(e) {
  if (draggedScheduleIndex === null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  
  const targetIndex = parseInt(e.currentTarget.getAttribute('data-schedule-index'));
  if (targetIndex !== draggedScheduleIndex) {
    e.currentTarget.style.borderTop = '2px solid #0078d4';
  }
}

function handleScheduleItemDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  
  if (draggedScheduleIndex === null) return;
  
  const targetIndex = parseInt(e.currentTarget.getAttribute('data-schedule-index'));
  
  if (targetIndex !== draggedScheduleIndex) {
    // Reorder the items
    const item = scheduleItems.splice(draggedScheduleIndex, 1)[0];
    scheduleItems.splice(targetIndex, 0, item);
    saveScheduleToSettings();
    renderSchedule();
  }
  
  e.currentTarget.style.borderTop = '';
}

function handleScheduleItemDragEnd(e) {
  e.currentTarget.style.opacity = '';
  draggedScheduleIndex = null;
  
  // Clear all border highlights
  document.querySelectorAll('.schedule-item').forEach(item => {
    item.style.borderTop = '';
  });
}

// ========== RESIZABLE PANELS ==========

function initResizers() {
  // Schedule sidebar resizer
  const scheduleResizer = document.getElementById('schedule-resizer');
  const scheduleSidebar = document.getElementById('schedule-sidebar');
  const slideContainer = document.getElementById('slide-container');
  
  let isResizing = false;
  
  scheduleResizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  // Preview divider resizer
  const previewResizer = document.getElementById('preview-resizer');
  const slidePreview = document.getElementById('slide-preview');
  const slideLive = document.getElementById('slide-live');
  
  let isResizingPreview = false;
  
  previewResizer.addEventListener('mousedown', (e) => {
    isResizingPreview = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  // Verse panel resizer
  const verseResizer = document.getElementById('verse-resizer');
  const versePanel = document.getElementById('verse-panel');
  const topSection = document.getElementById('top-section');
  
  let isResizingVerse = false;
  
  verseResizer.addEventListener('mousedown', (e) => {
    isResizingVerse = true;
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });
  
  // Global mouse move and up handlers
  document.addEventListener('mousemove', (e) => {
    if (isResizing) {
      const newWidth = e.clientX;
      if (newWidth > 100 && newWidth < window.innerWidth - 400) {
        scheduleSidebar.style.width = newWidth + 'px';
      }
    } else if (isResizingPreview) {
      const containerRect = slideContainer.getBoundingClientRect();
      const offsetX = e.clientX - containerRect.left;
      const percentage = (offsetX / containerRect.width) * 100;
      
      if (percentage > 10 && percentage < 90) {
        slidePreview.style.flex = `0 0 ${percentage}%`;
        slideLive.style.flex = `0 0 ${100 - percentage}%`;
      }
    } else if (isResizingVerse) {
      const newHeight = window.innerHeight - e.clientY;
      const resizerHeight = 16; // height of the resizer
      const newTopHeight = e.clientY - resizerHeight / 2;
      
      if (newHeight > 30 && newTopHeight > 50) {
        topSection.style.flex = `0 0 ${newTopHeight}px`;
        versePanel.style.flex = `0 0 ${newHeight}px`;
      }
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isResizing || isResizingPreview || isResizingVerse) {
      document.body.style.cursor = '';
      isResizing = false;
      isResizingPreview = false;
      isResizingVerse = false;
      // Save divider positions
      saveDividerPositions();
    }
  });
}

async function saveDividerPositions() {
  const scheduleSidebar = document.getElementById('schedule-sidebar');
  const slidePreview = document.getElementById('slide-preview');
  const slideContainer = document.getElementById('slide-container');
  const versePanel = document.getElementById('verse-panel');
  
  const settings = await ipcRenderer.invoke('load-settings') || {};

  // Compute normalized numeric values
  const scheduleWidthPx = Math.round(scheduleSidebar.getBoundingClientRect().width || parseInt(scheduleSidebar.style.width) || 250);
  const containerRect = slideContainer.getBoundingClientRect();
  const previewWidth = slidePreview.getBoundingClientRect().width || 0;
  let previewPercent = containerRect.width > 0 ? Math.round((previewWidth / containerRect.width) * 100) : 50;
  const verseHeightPx = Math.round(versePanel.getBoundingClientRect().height || parseInt(versePanel.style.flex) || 200);

  // Clamp to sensible ranges
  const clampedSchedule = Math.max(100, Math.min(scheduleWidthPx, window.innerWidth - 400));
  previewPercent = Math.max(10, Math.min(90, previewPercent));
  const clampedVerse = Math.max(50, Math.min(verseHeightPx, Math.max(100, window.innerHeight - 100)));

  settings.dividerPositions = {
    // new numeric representation (preferred)
    scheduleWidthPx: clampedSchedule,
    previewPercent: previewPercent,
    verseHeightPx: clampedVerse,
    // keep legacy strings for backward-compatibility
    scheduleWidth: clampedSchedule + 'px',
    previewFlex: `0 0 ${previewPercent}%`,
    verseHeight: `0 0 ${clampedVerse}px`
  };

  // Use update-settings to avoid races
  await ipcRenderer.invoke('update-settings', { dividerPositions: settings.dividerPositions });
}

async function restoreDividerPositions() {
  const settings = await ipcRenderer.invoke('load-settings') || {};
  // Ensure defaults exist on fresh installs and persist them so restore sees explicit values
  if (!settings.dividerPositions) {
    settings.dividerPositions = {
      scheduleWidthPx: 250,
      previewPercent: 50,
      verseHeightPx: 350,
      scheduleWidth: '250px',
      previewFlex: '0 0 50%',
      verseHeight: '0 0 350px'
    };
    try { await ipcRenderer.invoke('update-settings', { dividerPositions: settings.dividerPositions }); } catch (e) { console.warn('Failed to persist default divider positions:', e); }
  }
  
  const scheduleSidebar = document.getElementById('schedule-sidebar');
  const slidePreview = document.getElementById('slide-preview');
  const slideLive = document.getElementById('slide-live');
  const versePanel = document.getElementById('verse-panel');
  const topSection = document.getElementById('top-section');

  // Read numeric values first (new format), fall back to legacy strings
  let scheduleWidthPx = settings.dividerPositions.scheduleWidthPx;
  if (!scheduleWidthPx && settings.dividerPositions.scheduleWidth) {
    scheduleWidthPx = parseInt(settings.dividerPositions.scheduleWidth, 10);
  }
  if (!scheduleWidthPx) scheduleWidthPx = 250;

  let previewPercent = settings.dividerPositions.previewPercent;
  if (!previewPercent && settings.dividerPositions.previewFlex) {
    const match = settings.dividerPositions.previewFlex.match(/(\d+\.?\d*)%/);
    if (match) previewPercent = parseFloat(match[1]);
  }
  if (!previewPercent) previewPercent = 50;

  let verseHeightPx = settings.dividerPositions.verseHeightPx;
  if (!verseHeightPx && settings.dividerPositions.verseHeight) {
    const m = settings.dividerPositions.verseHeight.match(/(\d+)px/);
    if (m) verseHeightPx = parseInt(m[1], 10);
  }
  if (!verseHeightPx) verseHeightPx = 350; // default moved up to give more top area on clean installs

  // Validate and clamp to safe ranges based on current window size
  scheduleWidthPx = Math.max(100, Math.min(scheduleWidthPx, Math.max(150, window.innerWidth - 400)));
  previewPercent = Math.max(10, Math.min(previewPercent, 90));
  verseHeightPx = Math.max(50, Math.min(verseHeightPx, Math.max(100, window.innerHeight - 100)));

  // Apply computed layout
  scheduleSidebar.style.width = scheduleWidthPx + 'px';
  slidePreview.style.flex = `0 0 ${previewPercent}%`;
  slideLive.style.flex = `0 0 ${100 - previewPercent}%`;

  versePanel.style.flex = `0 0 ${verseHeightPx}px`;
  const topHeight = Math.max(50, window.innerHeight - verseHeightPx - 16);
  topSection.style.flex = `0 0 ${topHeight}px`;

  // If any incoming values were out of bounds, warn and overwrite persisted values with clamped ones
  const { scheduleWidth, previewFlex, verseHeight } = settings.dividerPositions;
  if (parseInt(scheduleWidth, 10) !== scheduleWidthPx || (previewFlex && !previewFlex.includes(`${previewPercent}%`)) || (verseHeight && !verseHeight.includes(`${verseHeightPx}px`))) {
    console.warn('[restoreDividerPositions] Clamped persisted divider positions to safe ranges. Overwriting saved values.');
    await saveDividerPositions();
  }
}

// ========== TABS MANAGEMENT ==========

function initTabs() {
  const tabs = document.querySelectorAll('.bottom-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tab');
      switchTab(tabName);
    });
  });
  
  // Song view toggle button
  const viewToggle = document.getElementById('song-view-toggle');
  if (viewToggle) {
    viewToggle.addEventListener('click', () => {
      songVerseViewMode = songVerseViewMode === 'full' ? 'blocks' : 'full';
      viewToggle.textContent = songVerseViewMode === 'full' ? 'Verse Blocks' : 'Full Song';
      displaySelectedSong();
      saveSongViewMode();
    });
  }
  
  // Song add button
  const addBtn = document.getElementById('song-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openSongEditor();
    });
  }
  
  // Song editor event listeners
  initSongEditor();
  initSongContextMenu();
  
  // Load saved view mode
  loadSongViewMode();
}

function switchTab(tabName) {
  currentTab = tabName;
  
  // Update tab buttons
  document.querySelectorAll('.bottom-tab').forEach(tab => {
    if (tab.getAttribute('data-tab') === tabName) {
      tab.classList.add('active');
      tab.style.borderBottom = '2px solid #0078d4';
    } else {
      tab.classList.remove('active');
      tab.style.borderBottom = 'none';
    }
  });
  
  // Show/hide tab content
  document.getElementById('verses-tab-content').style.display = tabName === 'verses' ? 'flex' : 'none';
  document.getElementById('songs-tab-content').style.display = tabName === 'songs' ? 'flex' : 'none';
  document.getElementById('media-tab-content').style.display = tabName === 'media' ? 'flex' : 'none';
}

// ========== SONGS MANAGEMENT ==========

async function loadSongs() {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const songsPath = path.join(userData, 'songs.json');
    
    // Create songs.json with empty array if it doesn't exist
    if (!fs.existsSync(songsPath)) {
      fs.writeFileSync(songsPath, JSON.stringify([], null, 2), 'utf8');
      allSongs = [];
    } else {
      const data = fs.readFileSync(songsPath, 'utf8');
      allSongs = JSON.parse(data);
    }
    
    renderSongList(allSongs);
    
    // Add scroll handler for virtual scrolling
    const songListContainer = document.getElementById('song-list');
    if (songListContainer) {
      songListContainer.addEventListener('scroll', () => {
        renderSongList(allSongs);
      });
    }
  } catch (err) {
    console.error('Failed to load songs:', err);
    allSongs = [];
  }
}

function renderSongList(songs) {
  const songListContainer = document.getElementById('song-list');
  const wrapper = document.getElementById('song-virtual-list');
  if (!wrapper || !songListContainer) return;
  
  const SONG_ITEM_HEIGHT = 32; // Height of each song item
  const SONG_WINDOW_SIZE = 200; // Number of visible items
  const SONG_BUFFER = 20; // Buffer items above/below visible area
  
  // Set the total height for the spacer
  wrapper.style.height = `${songs.length * SONG_ITEM_HEIGHT}px`;
  
  // Remove any previous rendered items
  while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  
  // Calculate which songs to render
  const scrollTop = songListContainer.scrollTop;
  const total = songs.length;
  const firstIndex = Math.max(0, Math.floor(scrollTop / SONG_ITEM_HEIGHT) - SONG_BUFFER);
  const lastIndex = Math.min(
    total,
    Math.ceil((scrollTop + SONG_WINDOW_SIZE * SONG_ITEM_HEIGHT) / SONG_ITEM_HEIGHT) + SONG_BUFFER
  );
  
  // Render only the visible songs
  for (let i = firstIndex; i < lastIndex; i++) {
    const song = songs[i];
    // Find the actual index in allSongs
    const actualIndex = allSongs.findIndex(s => s.title === song.title && s.author === song.author);
    
    const songItem = document.createElement('div');
    songItem.className = 'song-item';
    
    // Highlight matched text if there's a search query
    if (currentSearchQuery) {
      songItem.innerHTML = highlightText(song.title, currentSearchQuery);
      // Also set title attribute so full text is visible on hover
      songItem.title = song.title;
    } else {
      songItem.textContent = song.title;
      songItem.title = song.title;
    }
    
    songItem.setAttribute('data-index', actualIndex);
    songItem.style.cssText = `
      position: absolute;
      top: ${i * SONG_ITEM_HEIGHT}px;
      left: 0;
      right: 0;
      height: ${SONG_ITEM_HEIGHT}px;
      padding: 8px;
      cursor: pointer;
      border-bottom: 1px solid #eee;
      box-sizing: border-box;
    `;
    
    if (selectedSongIndices.includes(actualIndex)) {
      songItem.style.background = '#0078d4';
      songItem.style.color = '#fff';
    }
    
    songItem.addEventListener('click', (e) => {
      handleSongClick(actualIndex, e);
    });
    
    songItem.addEventListener('dblclick', async (e) => {
      // Double-click to go live with first verse
      selectedSongIndices = [actualIndex];
      selectedSongVerseIndex = 0;
      displaySelectedSong();
      await updateLiveFromSongVerse(0);
      if (!liveMode) {
        toggleLive(true);
      }
    });
    
    songItem.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Select this song if not already selected
      if (!selectedSongIndices.includes(actualIndex)) {
        selectedSongIndices = [actualIndex];
        renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
        displaySelectedSong();
      }
      showSongContextMenu(e.clientX, e.clientY);
    });
    
    songItem.draggable = true;
    songItem.addEventListener('dragstart', (e) => {
      const dragData = {
        type: 'song',
        songIndex: actualIndex
      };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragData));
    });
    
    wrapper.appendChild(songItem);
  }
}

function highlightText(text, query) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(regex, '<span class="search-highlight">$1</span>');
}

function handleSongClick(index, event) {
  if (event.shiftKey && selectedSongIndices.length > 0) {
    // Range selection
    const lastSelected = selectedSongIndices[selectedSongIndices.length - 1];
    const start = Math.min(lastSelected, index);
    const end = Math.max(lastSelected, index);
    selectedSongIndices = [];
    for (let i = start; i <= end; i++) {
      selectedSongIndices.push(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Toggle selection
    const idx = selectedSongIndices.indexOf(index);
    if (idx > -1) {
      selectedSongIndices.splice(idx, 1);
    } else {
      selectedSongIndices.push(index);
    }
  } else {
    // Single selection
    selectedSongIndices = [index];
  }
  
  renderSongList(filteredSongs.length > 0 ? filteredSongs : allSongs);
  displaySelectedSong();
  
  // Preview first verse
  if (selectedSongIndices.length > 0) {
    selectedSongVerseIndex = 0;
    updatePreviewFromSongVerse(0);
  }
}

function displaySelectedSong() {
  const songDisplay = document.getElementById('song-display');
  if (!songDisplay) return;
  
  if (selectedSongIndices.length === 0) {
    songDisplay.innerHTML = '';
    return;
  }
  
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  let html = `<h2>${currentSearchQuery ? highlightText(song.title, currentSearchQuery) : song.title}</h2>`;
  if (song.author) {
    html += `<p class="song-author">${song.author}</p>`;
  }
  
  if (songVerseViewMode === 'blocks') {
    // Verse blocks view - similar to schedule expanded view
    song.lyrics.forEach((section, sectionIndex) => {
      const verses = section.text.split(/\n\n+/);
      verses.forEach((verse, verseIndex) => {
        const globalVerseIndex = song.lyrics.slice(0, sectionIndex).reduce((sum, s) => sum + s.text.split(/\n\n+/).length, 0) + verseIndex;
        const isSelected = selectedSongVerseIndex === globalVerseIndex;
        const firstLine = verse.split('\n')[0];
        const label = firstLine.length > 40 ? firstLine.substring(0, 40) + '...' : firstLine;
        html += `<div class="song-verse-block${isSelected ? ' selected' : ''}" data-verse-index="${globalVerseIndex}">${section.section} (${verseIndex + 1}): ${label}</div>`;
      });
    });
  } else {
    // Full view - show complete song text with clickable verses
    song.lyrics.forEach((section, sectionIndex) => {
      html += `<h3>${section.section}</h3>`;
      const verses = section.text.split(/\n\n+/);
      verses.forEach((verse, verseIndex) => {
        const globalVerseIndex = song.lyrics.slice(0, sectionIndex).reduce((sum, s) => sum + s.text.split(/\n\n+/).length, 0) + verseIndex;
        const isSelected = selectedSongVerseIndex === globalVerseIndex;
        const verseHtml = (currentSearchQuery && currentSearchQuery.trim()) ? renderSongVerse(verse, currentSearchQuery) : parseMarkdown(verse);
        html += `<p class="song-verse${isSelected ? ' selected' : ''}" data-verse-index="${globalVerseIndex}" style="white-space: pre-wrap; padding: 4px; margin: 2px 0; cursor: pointer; border-radius: 4px; ${isSelected ? 'background: #0078d4; color: #fff;' : ''}">${verseHtml}</p>`;
      });
    });
  }
  
  songDisplay.innerHTML = html;
  
  // Add double-click handler to song title
  const titleElement = songDisplay.querySelector('h2');
  if (titleElement) {
    titleElement.style.cursor = 'pointer';
    titleElement.addEventListener('dblclick', () => {
      handleSongVerseDoubleClick(0);
    });
  }
  
  // Add click handlers to verses (both full view and block view)
  songDisplay.querySelectorAll('.song-verse, .song-verse-block').forEach(verseEl => {
    const verseIndex = parseInt(verseEl.getAttribute('data-verse-index'));
    verseEl.addEventListener('click', () => {
      handleSongVerseClick(verseIndex);
    });
    verseEl.addEventListener('dblclick', () => {
      handleSongVerseDoubleClick(verseIndex);
    });
  });
}

function handleSongVerseClick(verseIndex) {
  selectedSongVerseIndex = verseIndex;
  displaySelectedSong();
  updatePreviewFromSongVerse(verseIndex);
}

function handleSongVerseDoubleClick(verseIndex) {
  selectedSongVerseIndex = verseIndex;
  displaySelectedSong();
  updateLiveFromSongVerse(verseIndex);
}

function getSongVerseText(verseIndex) {
  if (selectedSongIndices.length === 0) return null;
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return null;
  
  let currentIndex = 0;
  for (const section of song.lyrics) {
    const verses = section.text.split(/\n\n+/);
    for (const verse of verses) {
      if (currentIndex === verseIndex) {
        return {
          title: song.title,
          section: section.section,
          text: verse
        };
      }
      currentIndex++;
    }
  }
  return null;
}

async function updatePreviewFromSongVerse(verseIndex) {
  const verseData = getSongVerseText(verseIndex);
  if (!verseData) return;
  
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  const previewCanvas = document.getElementById('preview-canvas');
  if (previewCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
    const styles = getCanvasStylesFor('song');
    renderToCanvas(previewCanvas, {
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null,
      backgroundMedia: backgroundMedia,
      styles
    }, width, height);
  }
}

async function updateLiveFromSongVerse(verseIndex) {
  const verseData = getSongVerseText(verseIndex);
  if (!verseData) return;
  
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  const liveCanvas = document.getElementById('live-canvas');
  if (liveCanvas) {
    const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
    const styles = getCanvasStylesFor('song');
    window.currentContent = {
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null,
      width: width,
      height: height,
      backgroundMedia: backgroundMedia,
      styles
    };
    renderToCanvas(liveCanvas, window.currentContent, width, height);
  }
  
  const backgroundMedia = getBackgroundMedia(defaultBackgrounds.songs);
  ipcRenderer.send('update-live-window', {
    number: '',
    text: verseData.text,
    reference: `${verseData.title} - ${verseData.section}`,
    showingCount: 1,
    totalSelected: 1,
    backgroundMedia: backgroundMedia,
    styles: getCanvasStylesFor('song'),
    transitionIn: transitionSettings['fade-in'],
    transitionOut: transitionSettings['fade-out']
  });
}

function selectNextSongVerse() {
  if (selectedSongIndices.length === 0) return;
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  // Count total verses in song
  let totalVerses = 0;
  song.lyrics.forEach(section => {
    totalVerses += section.text.split(/\n\n+/).length;
  });
  
  if (selectedSongVerseIndex === null) {
    selectedSongVerseIndex = 0;
  } else if (selectedSongVerseIndex < totalVerses - 1) {
    selectedSongVerseIndex++;
  }
  
  displaySelectedSong();
  updatePreviewFromSongVerse(selectedSongVerseIndex);
}

function selectPrevSongVerse() {
  if (selectedSongIndices.length === 0) return;
  const song = allSongs[selectedSongIndices[0]];
  if (!song) return;
  
  if (selectedSongVerseIndex === null || selectedSongVerseIndex <= 0) {
    selectedSongVerseIndex = 0;
  } else {
    selectedSongVerseIndex--;
  }
  
  displaySelectedSong();
  updatePreviewFromSongVerse(selectedSongVerseIndex);
}

// Song search
document.addEventListener('DOMContentLoaded', () => {
  const songSearchInput = document.getElementById('song-search-input');
  if (songSearchInput) {
    songSearchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      currentSearchQuery = query;
      
      if (!query) {
        filteredSongs = allSongs;
        renderSongList(filteredSongs);
        displaySelectedSong(); // Refresh to remove highlights
        return;
      }
      
      // Search songs by title and lyrics
      const results = [];
      
      allSongs.forEach((song, index) => {
        let score = 0;
        const titleLower = song.title.toLowerCase();
        
        // Title match (higher priority)
        if (titleLower.includes(query)) {
          score += 1000;
          if (titleLower.startsWith(query)) {
            score += 500; // Even higher for starts-with
          }
        }
        
        // Lyrics match (lower priority)
        song.lyrics.forEach(section => {
          const textLower = section.text.toLowerCase();
          if (textLower.includes(query)) {
            score += 10;
          }
        });
        
        if (score > 0) {
          results.push({ song, index, score });
        }
      });
      
      // Sort by score (descending)
      results.sort((a, b) => b.score - a.score);
      
      // Render filtered results
      filteredSongs = results.map(r => r.song);
      renderSongList(filteredSongs);
      displaySelectedSong(); // Refresh to show highlights
    });
  }
});

// ========== SONG CONTEXT MENU ==========

function showSongContextMenu(x, y) {
  const menu = document.getElementById('song-context-menu');
  if (!menu) return;
  
  const editOption = document.getElementById('song-context-edit');
  const deleteOption = document.getElementById('song-context-delete');
  const exportOption = document.getElementById('song-context-export');
  const importOption = document.getElementById('song-context-import');

  // Configure options based on selection
  if (selectedSongIndices.length === 0) {
    if (editOption) editOption.style.display = 'none';
    if (deleteOption) deleteOption.style.display = 'none';
    if (exportOption) exportOption.style.display = 'none';
  } else if (selectedSongIndices.length === 1) {
    if (editOption) editOption.style.display = 'block';
    if (deleteOption) deleteOption.style.display = 'block';
    if (exportOption) exportOption.style.display = 'block';
  } else {
    if (editOption) editOption.style.display = 'none';
    if (deleteOption) deleteOption.style.display = 'block';
    if (exportOption) exportOption.style.display = 'block';
  }

  // Import should always be visible
  if (importOption) importOption.style.display = 'block';

  // Position menu initially to measure its size
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = 'block';
  
  // Adjust position if menu would go off screen
  const menuRect = menu.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  
  // Adjust horizontal position if needed
  if (menuRect.right > viewportWidth) {
    menu.style.left = `${viewportWidth - menuRect.width - 5}px`;
  }
  
  // Adjust vertical position if needed
  if (menuRect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(5, y - menuRect.height)}px`;
  }
  
  // Close menu when clicking outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.style.display = 'none';
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// Generic helper: close a context menu by id
function closeContextMenu(id) {
  const m = document.getElementById(id);
  if (m) m.style.display = 'none';
}

function initSongContextMenu() {
  const editBtn = document.getElementById('song-context-edit');
  const deleteBtn = document.getElementById('song-context-delete');
  const exportBtn = document.getElementById('song-context-export');
  const importBtn = document.getElementById('song-context-import');
  
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      if (selectedSongIndices.length === 1) {
        editSong(selectedSongIndices[0]);
      }
    });
  }
  
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      deleteSongs(selectedSongIndices);
    });
  }
  
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      exportSongs(selectedSongIndices);
    });
  }
  
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      closeContextMenu('song-context-menu');
      importSongs();
    });
  }

  // Allow right-click anywhere in the song list to open the context menu (useful when there are no songs)
  const songListEl = document.getElementById('song-list');
  if (songListEl) {
    songListEl.addEventListener('contextmenu', (e) => {
      // If user right-clicked on a specific song item, let that handler run instead
      if (e.target.closest('[data-index]')) return;
      e.preventDefault();
      // Don't change selection; show menu with import enabled
      showSongContextMenu(e.clientX, e.clientY);
    });

    // Ctrl/Cmd + A when the song list is focused should select all displayed songs
    songListEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const dataset = (filteredSongs && filteredSongs.length > 0) ? filteredSongs : allSongs;
        if (!dataset || dataset.length === 0) return;
        // Map the displayed songs back to their indices in allSongs
        const indices = dataset.map(s => allSongs.findIndex(x => x.title === s.title && x.author === s.author)).filter(i => i >= 0);
        if (indices.length === 0) return;
        selectedSongIndices = indices;
        renderSongList(dataset);
        displaySelectedSong();
      }
    });
  }
}

function editSong(songIndex) {
  const song = allSongs[songIndex];
  if (!song) return;
  
  const modal = document.getElementById('song-editor-modal');
  const titleInput = document.getElementById('song-editor-title');
  const authorInput = document.getElementById('song-editor-author');
  const lyricsDiv = document.getElementById('song-editor-lyrics');
  
  if (modal && titleInput && authorInput && lyricsDiv) {
    // Store the index we're editing
    modal.setAttribute('data-editing-index', songIndex);
    
    modal.style.display = 'flex';
    titleInput.value = song.title;
    authorInput.value = song.author || '';
    
    // Convert song lyrics back to plain text with [Section] tags
    const lyricsText = song.lyrics.map(section => `[${section.section}]\n${section.text}`).join('\n\n');
    lyricsDiv.textContent = lyricsText;
    const previewEl = document.getElementById('song-editor-preview');
    if (previewEl) previewEl.style.display = 'none';
    
    titleInput.focus();
  }
}

async function deleteSongs(songIndices) {
  if (songIndices.length === 0) return;
  
  const count = songIndices.length;
  const message = count === 1 
    ? `Are you sure you want to delete "${allSongs[songIndices[0]].title}"?`
    : `Are you sure you want to delete ${count} songs?`;
  
  if (!confirm(message)) return;
  
  // Sort indices in descending order to avoid index shifting issues
  const sortedIndices = songIndices.slice().sort((a, b) => b - a);
  
  // Remove songs
  sortedIndices.forEach(index => {
    allSongs.splice(index, 1);
  });
  
  // Save to file
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const songsPath = path.join(userData, 'songs.json');
    fs.writeFileSync(songsPath, JSON.stringify(allSongs, null, 2), 'utf8');
    
    // Clear selection and refresh
    selectedSongIndices = [];
    selectedSongVerseIndex = null;
    filteredSongs = [];
    currentSearchQuery = '';
    const searchInput = document.getElementById('song-search-input');
    if (searchInput) searchInput.value = '';
    
    renderSongList(allSongs);
    displaySelectedSong();
  } catch (err) {
    console.error('Failed to delete songs:', err);
    alert('Failed to delete songs');
  }
}

function exportSongs(songIndices) {
  if (songIndices.length === 0) return;
  
  const songsToExport = songIndices.map(i => allSongs[i]);
  const jsonData = JSON.stringify(songsToExport, null, 2);
  
  // Create a download
  const blob = new Blob([jsonData], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `songs-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSongs() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.txt,.rtf';
  input.multiple = true;
  
  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    let addedCount = 0;
    
    for (const file of files) {
      const fileName = file.name;
      const fileExt = path.extname(fileName).toLowerCase();
      
      try {
        const fileContent = await file.text();
        
        if (fileExt === '.json') {
          // JSON import - array of songs
          const importedSongs = JSON.parse(fileContent);
          
          if (!Array.isArray(importedSongs)) {
            console.warn(`Skipping ${fileName}: not an array`);
            continue;
          }
          
          importedSongs.forEach(song => {
            if (song.title && song.lyrics && Array.isArray(song.lyrics)) {
              const exists = allSongs.some(s => s.title === song.title && s.author === song.author);
              if (!exists) {
                allSongs.push(song);
                addedCount++;
              }
            }
          });
        } else if (fileExt === '.txt' || fileExt === '.rtf') {
          // Plain text or RTF import - one song per file
          let plainText = fileContent;
          
          // Strip RTF formatting if RTF file
          if (fileExt === '.rtf') {
            plainText = stripRTF(fileContent);
          }
          
          // Parse song using same logic as song editor
          const songTitle = path.basename(fileName, fileExt);
          const parsedSong = parseSongText(songTitle, plainText);
          
          if (parsedSong) {
            const exists = allSongs.some(s => s.title === parsedSong.title && s.author === parsedSong.author);
            if (!exists) {
              allSongs.push(parsedSong);
              addedCount++;
            }
          }
        } else {
          console.warn(`Skipping ${fileName}: unsupported file type`);
        }
      } catch (err) {
        console.error(`Failed to import ${fileName}:`, err);
      }
    }
    
    if (addedCount > 0) {
      // Save to file
      try {
        const userData = await ipcRenderer.invoke('get-user-data-path');
        const songsPath = path.join(userData, 'songs.json');
        fs.writeFileSync(songsPath, JSON.stringify(allSongs, null, 2), 'utf8');
        
        // Refresh display
        renderSongList(allSongs);
        alert(`Imported ${addedCount} song(s)`);
      } catch (err) {
        console.error('Failed to save imported songs:', err);
        alert('Failed to save imported songs');
      }
    } else {
      alert('No new songs to import (duplicates skipped or invalid files)');
    }
  };
  
  input.click();
}

// Helper function to strip RTF formatting and extract plain text
function stripRTF(rtfContent) {
  // Basic RTF stripper - removes control words and groups
  let text = rtfContent;
  
  // Remove RTF header and control groups
  text = text.replace(/\{\\rtf1[^}]*\}/g, '');
  
  // Remove control words like \par, \pard, \tab, etc.
  text = text.replace(/\\[a-z]+\d*/g, ' ');
  
  // Remove control symbols
  text = text.replace(/\\[^a-z\s]/g, '');
  
  // Remove curly braces
  text = text.replace(/[{}]/g, '');
  
  // Replace multiple spaces with single space
  text = text.replace(/\s+/g, ' ');
  
  // Replace \par and similar with newlines
  text = text.replace(/\\par\s*/g, '\n');
  
  // Clean up extra whitespace
  text = text.trim();
  
  return text;
}

// Helper function to parse song text using same logic as song editor
function parseSongText(title, lyricsText) {
  const trimmedLyrics = lyricsText.trim();
  
  if (!trimmedLyrics) {
    return null;
  }
  
  // Parse sections from plaintext (same as saveSongFromEditor)
  const sectionTexts = trimmedLyrics.split(/\n\n+/).filter(v => v.trim());
  const sections = [];
  
  sectionTexts.forEach((text) => {
    let sectionLabel = '';
    let sectionContent = text.trim();

    // Only treat a top-line that is exactly a tag as a section label
    const lines = sectionContent.split('\n');
    const firstLine = lines[0] ? lines[0].trim() : '';
    const tagLineMatch = firstLine.match(/^[\[\{\(](.+?)[\]\}\)]$/);
    if (tagLineMatch) {
      sectionLabel = tagLineMatch[1].trim();
      lines.shift();
      sectionContent = lines.join('\n').trim();
    } else {
      sectionLabel = 'Verse';
    }

    sections.push({
      section: sectionLabel,
      text: sectionContent
    });
  });
  
  if (sections.length === 0) {
    return null;
  }
  
  return {
    title: title,
    author: '',
    lyrics: sections
  };
}

// ========== SONG EDITOR ==========

function initSongEditor() {
  const modal = document.getElementById('song-editor-modal');
  const closeBtn = document.getElementById('song-editor-close');
  const cancelBtn = document.getElementById('song-editor-cancel');
  const saveBtn = document.getElementById('song-editor-save');
  const lyricsInput = document.getElementById('song-editor-lyrics');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSongEditor);
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeSongEditor);
  }
  
  if (saveBtn) {
    saveBtn.addEventListener('click', saveSongFromEditor);
  }

  // Preview toggle button (added dynamically if not present)
  let previewToggle = document.getElementById('song-editor-preview-toggle');
  if (!previewToggle) {
    previewToggle = document.createElement('button');
    previewToggle.id = 'song-editor-preview-toggle';
    previewToggle.textContent = 'Show Preview';
    previewToggle.style.padding = '8px 12px';
    previewToggle.style.cursor = 'pointer';
    previewToggle.style.marginRight = '8px';
    const footer = document.querySelector('.song-editor-footer');
    if (footer) footer.insertBefore(previewToggle, footer.firstChild);
  }

  previewToggle.addEventListener('click', () => {
    const previewEl = document.getElementById('song-editor-preview');
    if (!previewEl) return;
    if (previewEl.style.display === 'none' || previewEl.style.display === '') {
      updateSongPreview();
      previewEl.style.display = 'block';
      previewToggle.textContent = 'Hide Preview';
    } else {
      previewEl.style.display = 'none';
      previewToggle.textContent = 'Show Preview';
    }
  });

  // Edit Styles button (opens popover for editing song styles)
  let editStylesBtn = document.getElementById('song-editor-edit-styles');
  if (!editStylesBtn) {
    editStylesBtn = document.createElement('button');
    editStylesBtn.id = 'song-editor-edit-styles';
    editStylesBtn.textContent = 'Edit Styles';
    editStylesBtn.style.padding = '8px 12px';
    editStylesBtn.style.cursor = 'pointer';
    editStylesBtn.style.marginRight = '8px';
    const footer = document.querySelector('.song-editor-footer');
    if (footer) footer.insertBefore(editStylesBtn, footer.firstChild);
  }

  editStylesBtn.addEventListener('click', () => {
    // Simple menu to choose which song style to edit
    const menu = document.createElement('div');
    menu.style.position = 'absolute';
    menu.style.bottom = '60px';
    menu.style.left = '20px';
    menu.style.background = 'white';
    menu.style.border = '1px solid #ccc';
    menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
    menu.style.zIndex = 3000;
    menu.style.padding = '8px';
    menu.innerHTML = `<div style="padding:6px; cursor:pointer;">Edit Song Title Style</div>
                      <div style="padding:6px; cursor:pointer;">Edit Song Text Style</div>
                      <div style="padding:6px; cursor:pointer;">Edit Song Reference Style</div>`;
    document.body.appendChild(menu);

    const removeMenu = () => { if (menu && menu.parentNode) menu.parentNode.removeChild(menu); };

    menu.children[0].addEventListener('click', () => { removeMenu(); showPopover('Song Title', 'songTitle'); });
    menu.children[1].addEventListener('click', () => { removeMenu(); showPopover('Song Text', 'songText'); });
    menu.children[2].addEventListener('click', () => { removeMenu(); showPopover('Song Reference', 'songReference'); });

    // Close the menu on any click outside
    setTimeout(() => document.addEventListener('click', removeMenu, { once: true }), 0);
  });

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeSongEditor();
      }
    });
  }
}

function openSongEditor() {
  const modal = document.getElementById('song-editor-modal');
  const titleInput = document.getElementById('song-editor-title');
  const authorInput = document.getElementById('song-editor-author');
  const lyricsInput = document.getElementById('song-editor-lyrics');
  
  if (modal) {
    // Clear editing flag for new song
    modal.removeAttribute('data-editing-index');
    
    modal.style.display = 'flex';
    if (titleInput) titleInput.value = '';
    if (authorInput) authorInput.value = '';
    if (lyricsInput) {
      lyricsInput.textContent = '';
      const previewEl = document.getElementById('song-editor-preview');
      if (previewEl) previewEl.style.display = 'none';
      lyricsInput.focus();
    }
    if (titleInput) titleInput.focus();
  }
}

function closeSongEditor() {
  const modal = document.getElementById('song-editor-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}


function parseMarkdown(text) {
  // simple, safe Markdown for bold and italics
  let t = escapeHtml(text);
  // Bold: **text** or __text__
  t = t.replace(/(\*\*|__)([\s\S]+?)\1/g, '<strong>$2</strong>');
  // Italic: *text* or _text_
  t = t.replace(/(\*|_)([\s\S]+?)\1/g, '<em>$2</em>');
  // Preserve single line breaks as <br>
  t = t.replace(/\n/g, '<br>');
  return t;
}

// Render lyrics plain text into HTML for the contenteditable editor
function renderLyricsHtml(text) {
  const sections = text.split(/\n\n+/).filter(s => s.trim() !== '');
  const parts = sections.map(section => {
    const lines = section.split('\n');
    // detect tag only if the first line is exactly a tag on its own line
    const firstLine = lines[0] ? lines[0].trim() : '';
    const tagMatch = firstLine.match(/^[\[\{\(](.+?)[\]\}\)]$/);
    let html = '';
    if (tagMatch) {
      const label = escapeHtml(tagMatch[1].trim());
      html += `<div class="song-tag">[${label}]</div>`;
      lines.shift(); // remove tag line
    }
    const content = lines.join('\n').trim();
    if (content) {
      html += `<div class="song-section">${parseMarkdown(content)}</div>`;
    }
    return html;
  });
  return parts.join('<div class="song-section-sep"></div>');
}

function updateInlineSongFormatting() {
  // Deprecated: inline replacement caused editing issues. Use updateSongPreview() to render a preview instead.
}

function updateSongPreview() {
  const lyricsDiv = document.getElementById('song-editor-lyrics');
  const previewEl = document.getElementById('song-editor-preview');
  if (!lyricsDiv || !previewEl) return;
  const text = lyricsDiv.innerText || lyricsDiv.textContent || '';
  previewEl.innerHTML = renderLyricsHtml(text);
}
// Render a single verse with optional search highlighting
function renderSongVerse(verseText, query) {
  if (!query || !query.trim()) return parseMarkdown(verseText);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${q})`, 'gi');
  // Use safe markers that won't be interpreted by HTML escaping
  const START = '___HIGHLIGHT_START___';
  const END = '___HIGHLIGHT_END___';
  const marked = verseText.replace(regex, `${START}$1${END}`);
  // Parse markdown which will escape HTML and convert markdown
  let html = parseMarkdown(marked);
  // Now replace markers with actual span tags (escaped content inside is safe)
  html = html.replace(new RegExp(START, 'g'), '<span class="search-highlight">');
  html = html.replace(new RegExp(END, 'g'), '</span>');
  return html;
}

async function saveSongFromEditor() {
  const modal = document.getElementById('song-editor-modal');
  const editingIndex = modal ? modal.getAttribute('data-editing-index') : null;
  
  const title = document.getElementById('song-editor-title').value.trim();
  const author = document.getElementById('song-editor-author').value.trim();
  const lyricsDiv = document.getElementById('song-editor-lyrics');
  
  // Use innerText instead of textContent to preserve newlines from contenteditable
  const lyricsText = lyricsDiv ? lyricsDiv.innerText.trim() : '';
  
  if (!title) {
    alert('Please enter a song title');
    return;
  }
  
  if (!lyricsText) {
    alert('Please enter song lyrics');
    return;
  }
  
  // Parse sections from plaintext
  const sectionTexts = lyricsText.split(/\n\n+/).filter(v => v.trim());
  const sections = [];
  let verseCount = 0;
  
  sectionTexts.forEach((text, index) => {
    let sectionLabel = '';
    let sectionContent = text.trim();
    
    // Only treat a top-line that is exactly a tag as a section label
    const lines = sectionContent.split('\n');
    const firstLine = lines[0] ? lines[0].trim() : '';
    const tagLineMatch = firstLine.match(/^[\[\{\(](.+?)[\]\}\)]$/);
    if (tagLineMatch) {
      sectionLabel = tagLineMatch[1].trim();
      lines.shift();
      sectionContent = lines.join('\n').trim();
    } else {
      sectionLabel = 'Verse';
    }

    sections.push({
      section: sectionLabel,
      text: sectionContent
    });
  });
  
  if (sections.length === 0) {
    alert('Please enter song lyrics with at least one section');
    return;
  }
  
  const songData = {
    title,
    author: author || '',
    lyrics: sections
  };
  
  // Check if we're editing or creating new
  if (editingIndex !== null && editingIndex !== '') {
    // Update existing song
    allSongs[parseInt(editingIndex)] = songData;
  } else {
    // Add new song
    allSongs.push(songData);
  }
  
  // Save to file
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const songsPath = path.join(userData, 'songs.json');
    fs.writeFileSync(songsPath, JSON.stringify(allSongs, null, 2), 'utf8');
    
    // Clear editing flag
    if (modal) modal.removeAttribute('data-editing-index');
    
    // Refresh song list
    renderSongList(allSongs);
    closeSongEditor();
    
    // Select the song
    selectedSongIndices = [allSongs.length - 1];
    displaySelectedSong();
    renderSongList(allSongs);
  } catch (err) {
    console.error('Failed to save song:', err);
    alert('Failed to save song. Check console for details.');
  }
}

// ========== MEDIA MANAGEMENT ==========

async function loadMedia() {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const mediaPath = path.join(userData, 'media.json');
    
    if (fs.existsSync(mediaPath)) {
      const data = fs.readFileSync(mediaPath, 'utf8');
      const mediaData = JSON.parse(data);
      allMedia = mediaData.files || [];
      defaultBackgrounds = mediaData.defaultBackgrounds || { songs: null, verses: null };
    }
    
    renderMediaGrid();
    initMediaHandlers();
  } catch (err) {
    console.error('Failed to load media:', err);
    allMedia = [];
  }
}

async function saveMedia() {
  try {
    const userData = await ipcRenderer.invoke('get-user-data-path');
    const mediaPath = path.join(userData, 'media.json');
    const mediaData = {
      files: allMedia,
      defaultBackgrounds: defaultBackgrounds
    };
    fs.writeFileSync(mediaPath, JSON.stringify(mediaData, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save media:', err);
  }
}

function initMediaHandlers() {
  const addBtn = document.getElementById('media-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', importMediaFiles);
  }
  
  const searchInput = document.getElementById('media-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', renderMediaGrid);
  }
  
  // Context menu
  document.addEventListener('click', () => {
    const menu = document.getElementById('media-context-menu');
    if (menu) menu.style.display = 'none';
  });
}

async function importMediaFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*';
  
  input.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    try {
      const userData = await ipcRenderer.invoke('get-user-data-path');
      const mediaDir = path.join(userData, 'media');
      
      // Create media directory if it doesn't exist
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
      }
      
      for (const file of files) {
        const fileName = file.name;
        const destPath = path.join(mediaDir, fileName);
        
        // Copy file
        const buffer = await file.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(buffer));
        
        // Add to media list
        const stats = fs.statSync(destPath);
        const fileType = path.extname(fileName).substring(1).toUpperCase();
        const fileSize = formatFileSize(stats.size);
        
        allMedia.push({
          name: fileName,
          path: destPath,
          type: fileType,
          size: fileSize,
          addedDate: new Date().toISOString()
        });
      }
      
      await saveMedia();
      renderMediaGrid();
    } catch (err) {
      console.error('Failed to import media:', err);
      alert('Failed to import media files');
    }
  };
  
  input.click();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  else return (bytes / 1048576).toFixed(1) + ' MB';
}

function pathToFileURL(filePath) {
  // delegate to preload-exposed helper (ensures consistent behavior cross-platform)
  if (window && window.paths && typeof window.paths.fileUrlFor === 'function') {
    return window.paths.fileUrlFor(filePath);
  }
  const normalized = filePath.replace(/\\/g, '/');
  return 'file:///' + normalized;
}

function renderMediaGrid() {
  const display = document.getElementById('media-display');
  if (!display) return;
  
  const searchInput = document.getElementById('media-search-input');
  const query = searchInput ? searchInput.value.toLowerCase() : '';
  
  const filteredMedia = query ? 
    allMedia.filter(m => m.name.toLowerCase().includes(query)) : 
    allMedia;
  
  let html = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 12px; padding: 10px;">';
  
  // Always show "Create Color/Gradient" as first item (unless searching)
  if (!query) {
    html += `<div class="media-item media-create-color" data-index="-1" tabindex="0" style="cursor: pointer; border: 1px solid transparent; border-radius: 6px; padding: 6px; text-align: center;">`;
    html += `<div style="width: 100%; height: 60px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center; font-size: 30px; color: white;">
      <svg width="30" height="30" viewBox="0 0 16 16" fill="white"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
    </div>`;
    html += `<div style="font-size: 10px; font-weight: 500; margin-bottom: 3px;">New Color</div>`;
    html += `<div style="font-size: 8px; color: #666;">Create</div>`;
    html += `</div>`;
  }
  
  if (filteredMedia.length === 0 && query) {
    display.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">No media files</div>';
    return;
  }
  
  filteredMedia.forEach((media, index) => {
    const actualIndex = allMedia.indexOf(media);
    const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
    const isVideo = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
    const isColor = media.type === 'COLOR';
    
    const displayName = media.name.length > 20 ? media.name.substring(0, 17) + '...' : media.name;
    const isSelected = selectedMediaIndex === actualIndex;
    
    html += `<div class="media-item${isSelected ? ' selected' : ''}" data-index="${actualIndex}" draggable="true" tabindex="0" style="cursor: pointer; border: 1px solid ${isSelected ? '#0078d4' : 'transparent'}; border-radius: 6px; padding: 6px; text-align: center;">`;
    
    // Thumbnail (wrap in media-thumb container to allow badge overlays)
    // Thumbnail (wrap in media-thumb container to allow badge overlays)
    let thumbHtml = '';
    if (isColor) {
      thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: ${media.color}; border-radius: 3px; margin-bottom: 6px;"></div>`;
    } else {
      const fileURL = media.path ? media.path : ''; // will be converted to file URL by pathToFileURL() when used
      if (isImage) {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; overflow: hidden; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
          <img src="${pathToFileURL(fileURL)}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
        </div>`;
      } else if (isVideo) {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; overflow: hidden; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
          <video src="${pathToFileURL(fileURL)}" style="max-width: 100%; max-height: 100%; object-fit: contain;"></video>
        </div>`;
      } else {
        thumbHtml = `<div class="media-thumb" style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
            <svg width="30" height="30" viewBox="0 0 16 16" fill="#666"><path d="M5.5 7a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5zM5 9.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"/><path d="M9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5L9.5 0zm0 1v2A1.5 1.5 0 0 0 11 4.5h2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5.5z"/></svg>
        </div>`;
      }
    }

    // Badges for defaults
    if (defaultBackgrounds.songs === actualIndex) {
      // music icon (FontAwesome 'music' SVG)
      thumbHtml = thumbHtml.replace(/<\/div>\s*$/, '<div class="fa-badge fa-bottom-right" title="Default background for songs">'+
        '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M499.1 6.3c8.1 6 12.9 15.6 12.9 25.7l0 72 0 264c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6L448 147 192 223.8 192 432c0 44.2-43 80-96 80s-96-35.8-96-80s43-80 96-80c11.2 0 22 1.6 32 4.6L128 200l0-72c0-14.1 9.3-26.6 22.8-30.7l320-96c9.7-2.9 20.2-1.1 28.3 5z"/></svg></div></div>');
    }
    if (defaultBackgrounds.verses === actualIndex) {
      // book icon (FontAwesome 'book-open' SVG)
      thumbHtml = thumbHtml.replace(/<\/div>\s*$/, '<div class="fa-badge fa-bottom-left" title="Default background for verses">'+
        '<svg viewBox="0 0 576 512" xmlns="http://www.w3.org/2000/svg"><path d="M249.6 471.5c10.8 3.8 22.4-4.1 22.4-15.5l0-377.4c0-4.2-1.6-8.4-5-11C247.4 52 202.4 32 144 32C93.5 32 46.3 45.3 18.1 56.1C6.8 60.5 0 71.7 0 83.8L0 454.1c0 11.9 12.8 20.2 24.1 16.5C55.6 460.1 105.5 448 144 448c33.9 0 79 14 105.6 23.5zm76.8 0C353 462 398.1 448 432 448c38.5 0 88.4 12.1 119.9 22.6c11.3 3.8 24.1-4.6 24.1-16.5l0-370.3c0-12.1-6.8-23.3-18.1-27.6C529.7 45.3 482.5 32 432 32c-58.4 0-103.4 20-123 35.6c-3.3 2.6-5 6.8-5 11L304 456c0 11.4 11.7 19.3 22.4 15.5z"/></svg></div></div>');
    }

    html += thumbHtml;
    
    // Labels
    html += `<div style="font-size: 10px; font-weight: 500; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${media.name}">${displayName}</div>`;
    html += `<div style="font-size: 8px; color: #666;">${media.type} • ${media.size}</div>`;
    html += `</div>`;
  });
  
  html += '</div>';
  display.innerHTML = html;
  
  // Add event listeners
  document.querySelectorAll('.media-item').forEach(item => {
    const index = parseInt(item.getAttribute('data-index'));
    
    // Special handling for create color button
    if (index === -1) {
      item.addEventListener('click', () => {
        openColorEditor();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openColorEditor();
        }
      });
      return; // Skip other handlers for create button
    }
    
    item.addEventListener('click', () => {
      selectedMediaIndex = index;
      const media = allMedia[index];
      console.log('Media item clicked:', media);
      if (media) {
        displayMediaOnPreview(media);
        renderMediaGrid(); // Re-render to show selection
      }
    });
    
    item.addEventListener('dblclick', () => {
      selectedMediaIndex = index;
      const media = allMedia[index];
      if (media) {
        displayMediaOnLive(media);
      }
    });
    
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const media = allMedia[index];
        if (media) {
          displayMediaOnLive(media);
        }
      }
    });
    
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      selectedMediaIndex = index;
      showMediaContextMenu(e.clientX, e.clientY);
    });
    
    item.addEventListener('dragstart', (e) => {
      const dragData = {
        type: 'media',
        mediaIndex: index
      };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragData));
    });
  });
}

function showMediaContextMenu(x, y) {
  let menu = document.getElementById('media-context-menu');
  
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'media-context-menu';
    menu.innerHTML = `
      <div class="context-menu-item" id="media-context-edit">Edit</div>
      <div class="context-menu-item" id="media-context-bg-songs">Set as Default Background for Songs</div>
      <div class="context-menu-item" id="media-context-bg-verses">Set as Default Background for Verses</div>
      <div class="context-menu-item" id="media-context-reset-songs">Reset Song Background to Default</div>
      <div class="context-menu-item" id="media-context-reset-verses">Reset Verse Background to Default</div>
      <div class="context-menu-item" id="media-context-delete">Delete</div>
    `;
    document.body.appendChild(menu);
    
    // Add Edit handler
    document.getElementById('media-context-edit').addEventListener('click', () => {
      if (selectedMediaIndex !== null) {
        const media = allMedia[selectedMediaIndex];
        const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
        const isVideo = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
        const isColor = media.type === 'COLOR';
        
        if (isImage) {
          openImageEditor(selectedMediaIndex);
        } else if (isVideo) {
          openVideoEditor(selectedMediaIndex);
        } else if (isColor) {
          openColorEditor(selectedMediaIndex);
        }
        menu.style.display = 'none';
      }
    });
    
    // Add handlers
    document.getElementById('media-context-bg-songs').addEventListener('click', async () => {
      if (selectedMediaIndex !== null) {
        // Store index of default background
        defaultBackgrounds.songs = selectedMediaIndex;
        await saveMedia();
        renderMediaGrid();
        menu.style.display = 'none';
      }
    });
    
    document.getElementById('media-context-bg-verses').addEventListener('click', async () => {
      if (selectedMediaIndex !== null) {
        // Store index of default background
        defaultBackgrounds.verses = selectedMediaIndex;
        await saveMedia();
        renderMediaGrid();
        menu.style.display = 'none';
      }
    });
    
    document.getElementById('media-context-reset-songs').addEventListener('click', async () => {
      defaultBackgrounds.songs = null;
      await saveMedia();
      renderMediaGrid();
      menu.style.display = 'none';
    });
    
    document.getElementById('media-context-reset-verses').addEventListener('click', async () => {
      defaultBackgrounds.verses = null;
      await saveMedia();
      renderMediaGrid();
      menu.style.display = 'none';
    });
    
    document.getElementById('media-context-delete').addEventListener('click', async () => {
      if (selectedMediaIndex !== null) {
        const media = allMedia[selectedMediaIndex];
        if (confirm(`Delete "${media.name}"?`)) {
          // Delete file
          try {
            if (fs.existsSync(media.path)) {
              fs.unlinkSync(media.path);
            }
          } catch (err) {
            console.error('Failed to delete file:', err);
          }
          
          // Remove from list
          allMedia.splice(selectedMediaIndex, 1);
          await saveMedia();
          renderMediaGrid();
        }
        menu.style.display = 'none';
      }
    });
  }
  
  // Position menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = 'block';
  
  // Adjust if off-screen
  setTimeout(() => {
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - menuRect.width - 5}px`;
    }
    if (menuRect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(5, y - menuRect.height)}px`;
    }
  }, 0);
}

function openColorEditor(mediaIndex = null) {
  editingMediaIndex = mediaIndex;
  const modal = document.getElementById('color-editor-modal');
  if (!modal) return;
  
  if (mediaIndex !== null) {
    // Editing existing color item
    const media = allMedia[mediaIndex];
    const colorCSS = media.color;
    
    // Parse the color/gradient to populate form
    if (colorCSS.startsWith('linear-gradient')) {
      document.getElementById('bg-type').value = 'gradient';
      document.getElementById('gradient-type').value = 'linear';
      document.getElementById('solid-color-options').style.display = 'none';
      document.getElementById('gradient-options').style.display = 'block';
      
      const match = colorCSS.match(/linear-gradient\((\d+)deg,\s*([^,]+),\s*(.+)\)/);
      if (match) {
        document.getElementById('gradient-angle').value = match[1];
        document.getElementById('angle-value').textContent = match[1];
        document.getElementById('gradient-color1').value = match[2].trim();
        document.getElementById('gradient-color2').value = match[3].trim();
      }
    } else if (colorCSS.startsWith('radial-gradient')) {
      document.getElementById('bg-type').value = 'gradient';
      document.getElementById('gradient-type').value = 'radial';
      document.getElementById('solid-color-options').style.display = 'none';
      document.getElementById('gradient-options').style.display = 'block';
      
      const match = colorCSS.match(/radial-gradient\(circle,\s*([^,]+),\s*(.+)\)/);
      if (match) {
        document.getElementById('gradient-color1').value = match[1].trim();
        document.getElementById('gradient-color2').value = match[2].trim();
      }
    } else {
      // Solid color
      document.getElementById('bg-type').value = 'solid';
      document.getElementById('solid-color-options').style.display = 'block';
      document.getElementById('gradient-options').style.display = 'none';
      document.getElementById('bg-color').value = colorCSS;
    }
  } else {
    // Creating new color - reset to defaults
    document.getElementById('bg-type').value = 'solid';
    document.getElementById('bg-color').value = '#000000';
    document.getElementById('solid-color-options').style.display = 'block';
    document.getElementById('gradient-options').style.display = 'none';
  }
  
  modal.classList.add('active');
  updateColorPreview();
}

function closeColorEditor() {
  const modal = document.getElementById('color-editor-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

function applyColorToCanvas(ctx, colorCSS, width, height) {
  console.log('applyColorToCanvas called with:', colorCSS, 'size:', width, 'x', height);
  // Check if it's a gradient
  if (colorCSS.startsWith('linear-gradient')) {
    // Parse linear-gradient(135deg, #667eea, #764ba2)
    const match = colorCSS.match(/linear-gradient\((\d+)deg,\s*([^,]+),\s*(.+)\)/);
    console.log('Linear gradient match:', match);
    if (match) {
      const angle = parseInt(match[1]);
      const color1 = match[2].trim();
      const color2 = match[3].trim();
      console.log('Creating linear gradient:', angle, 'deg from', color1, 'to', color2);
      
      // Convert angle to radians and calculate gradient direction
      const angleRad = (angle - 90) * Math.PI / 180;
      const x1 = width / 2 + Math.cos(angleRad) * width / 2;
      const y1 = height / 2 + Math.sin(angleRad) * height / 2;
      const x2 = width / 2 - Math.cos(angleRad) * width / 2;
      const y2 = height / 2 - Math.sin(angleRad) * height / 2;
      
      const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
      gradient.addColorStop(0, color1);
      gradient.addColorStop(1, color2);
      ctx.fillStyle = gradient;
    }
  } else if (colorCSS.startsWith('radial-gradient')) {
    // Parse radial-gradient(circle, #667eea, #764ba2)
    const match = colorCSS.match(/radial-gradient\(circle,\s*([^,]+),\s*(.+)\)/);
    console.log('Radial gradient match:', match);
    if (match) {
      const color1 = match[1].trim();
      const color2 = match[2].trim();
      console.log('Creating radial gradient from', color1, 'to', color2);
      
      const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) / 2);
      gradient.addColorStop(0, color1);
      gradient.addColorStop(1, color2);
      ctx.fillStyle = gradient;
    }
  } else {
    // Solid color
    console.log('Setting solid color:', colorCSS);
    ctx.fillStyle = colorCSS;
  }
  ctx.fillRect(0, 0, width, height);
  console.log('Color/gradient applied to canvas');
}

function drawImageWithSettings(ctx, img, canvasWidth, canvasHeight, settings = {}) {
  const bgSize = settings.bgSize || 'cover';
  const bgRepeat = settings.bgRepeat || 'no-repeat';
  const bgPosition = settings.bgPosition || 'center';
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  
  let drawWidth, drawHeight, scale;
  
  // Calculate dimensions based on background-size
  if (bgSize === 'cover') {
    scale = Math.max(canvasWidth / img.width, canvasHeight / img.height);
    drawWidth = img.width * scale;
    drawHeight = img.height * scale;
  } else if (bgSize === 'contain') {
    scale = Math.min(canvasWidth / img.width, canvasHeight / img.height);
    drawWidth = img.width * scale;
    drawHeight = img.height * scale;
  } else if (bgSize === '100% 100%') {
    drawWidth = canvasWidth;
    drawHeight = canvasHeight;
  } else { // 'auto' - original size
    drawWidth = img.width;
    drawHeight = img.height;
  }
  
  // Calculate position
  let startX = 0, startY = 0;
  if (bgPosition.includes('center') || bgPosition === 'center') {
    startX = (canvasWidth - drawWidth) / 2;
    startY = (canvasHeight - drawHeight) / 2;
  } else {
    const positions = bgPosition.split(' ');
    const posX = positions[0] || 'center';
    const posY = positions[1] || 'center';
    
    if (posX === 'left') startX = 0;
    else if (posX === 'right') startX = canvasWidth - drawWidth;
    else if (posX === 'center') startX = (canvasWidth - drawWidth) / 2;
    
    if (posY === 'top') startY = 0;
    else if (posY === 'bottom') startY = canvasHeight - drawHeight;
    else if (posY === 'center') startY = (canvasHeight - drawHeight) / 2;
  }
  
  // Handle repeat
  if (bgRepeat === 'no-repeat') {
    ctx.drawImage(img, startX, startY, drawWidth, drawHeight);
  } else if (bgRepeat === 'repeat') {
    for (let x = startX % drawWidth - drawWidth; x < canvasWidth; x += drawWidth) {
      for (let y = startY % drawHeight - drawHeight; y < canvasHeight; y += drawHeight) {
        ctx.drawImage(img, x, y, drawWidth, drawHeight);
      }
    }
  } else if (bgRepeat === 'repeat-x') {
    for (let x = startX % drawWidth - drawWidth; x < canvasWidth; x += drawWidth) {
      ctx.drawImage(img, x, startY, drawWidth, drawHeight);
    }
  } else if (bgRepeat === 'repeat-y') {
    for (let y = startY % drawHeight - drawHeight; y < canvasHeight; y += drawHeight) {
      ctx.drawImage(img, startX, y, drawWidth, drawHeight);
    }
  }
}

function updateColorPreview() {
  const preview = document.getElementById('bg-preview');
  if (!preview) return;
  
  const type = document.getElementById('bg-type').value;
  
  if (type === 'solid') {
    const color = document.getElementById('bg-color').value;
    preview.style.background = color;
  } else {
    const gradType = document.getElementById('gradient-type').value;
    const color1 = document.getElementById('gradient-color1').value;
    const color2 = document.getElementById('gradient-color2').value;
    const angle = document.getElementById('gradient-angle').value;
    
    if (gradType === 'linear') {
      preview.style.background = `linear-gradient(${angle}deg, ${color1}, ${color2})`;
    } else {
      preview.style.background = `radial-gradient(circle, ${color1}, ${color2})`;
    }
  }
}

function saveColorBackground() {
  const type = document.getElementById('bg-type').value;
  let colorCSS;
  let name;
  
  if (type === 'solid') {
    const color = document.getElementById('bg-color').value;
    colorCSS = color;
    name = `Solid ${color}`;
  } else {
    const gradType = document.getElementById('gradient-type').value;
    const color1 = document.getElementById('gradient-color1').value;
    const color2 = document.getElementById('gradient-color2').value;
    const angle = document.getElementById('gradient-angle').value;
    
    if (gradType === 'linear') {
      colorCSS = `linear-gradient(${angle}deg, ${color1}, ${color2})`;
      name = `Linear Gradient ${color1}-${color2}`;
    } else {
      colorCSS = `radial-gradient(circle, ${color1}, ${color2})`;
      name = `Radial Gradient ${color1}-${color2}`;
    }
  }
  
  if (editingMediaIndex !== null) {
    // Update existing color item
    const media = allMedia[editingMediaIndex];
    media.color = colorCSS;
    media.name = name;
    
    saveMedia();
    renderMediaGrid();
    
    // Refresh display if this media is currently shown
    if (selectedMediaIndex === editingMediaIndex) {
      displayMediaOnPreview(media);
    }
  } else {
    // Add new color item
    allMedia.push({
      name: name,
      path: null,
      type: 'COLOR',
      color: colorCSS,
      size: '0 B',
      addedDate: new Date().toISOString()
    });
    
    saveMedia();
    renderMediaGrid();
  }
  
  closeColorEditor();
  editingMediaIndex = null;
}

function initColorEditor() {
  const modal = document.getElementById('color-editor-modal');
  if (!modal) return;
  
  document.getElementById('color-editor-close').addEventListener('click', closeColorEditor);
  document.getElementById('color-editor-cancel').addEventListener('click', closeColorEditor);
  document.getElementById('color-editor-save').addEventListener('click', saveColorBackground);
  
  document.getElementById('bg-type').addEventListener('change', (e) => {
    const solidOptions = document.getElementById('solid-color-options');
    const gradientOptions = document.getElementById('gradient-options');
    
    if (e.target.value === 'solid') {
      solidOptions.style.display = 'block';
      gradientOptions.style.display = 'none';
    } else {
      solidOptions.style.display = 'none';
      gradientOptions.style.display = 'block';
    }
    updateColorPreview();
  });
  
  document.getElementById('gradient-type').addEventListener('change', (e) => {
    const angleControl = document.getElementById('linear-angle');
    angleControl.style.display = e.target.value === 'linear' ? 'block' : 'none';
    updateColorPreview();
  });
  
  document.getElementById('bg-color').addEventListener('input', updateColorPreview);
  document.getElementById('gradient-color1').addEventListener('input', updateColorPreview);
  document.getElementById('gradient-color2').addEventListener('input', updateColorPreview);
  document.getElementById('gradient-angle').addEventListener('input', (e) => {
    document.getElementById('angle-value').textContent = e.target.value;
    updateColorPreview();
  });
  
  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeColorEditor();
    }
  });
}

let editingMediaIndex = null;
let imagePreviewImg = null;

function getBackgroundMedia(backgroundIndex) {
  if (backgroundIndex === null || backgroundIndex === undefined) return null;
  if (typeof backgroundIndex === 'number') {
    return allMedia[backgroundIndex] || null;
  }
  // Legacy: if it's a string path, try to find the media
  if (typeof backgroundIndex === 'string') {
    return allMedia.find(m => m.path === backgroundIndex) || null;
  }
  return null;
}

function updateImagePreview() {
  if (editingMediaIndex === null || !imagePreviewImg) return;
  
  const canvas = document.getElementById('image-preview-canvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const bgSize = document.getElementById('image-bg-size').value;
  const bgRepeat = document.getElementById('image-bg-repeat').value;
  const bgPosition = document.getElementById('image-bg-position').value;
  
  drawImageWithSettings(ctx, imagePreviewImg, canvas.width, canvas.height, {
    bgSize: bgSize,
    bgRepeat: bgRepeat,
    bgPosition: bgPosition
  });
}

function openImageEditor(mediaIndex) {
  editingMediaIndex = mediaIndex;
  const media = allMedia[mediaIndex];
  const modal = document.getElementById('image-editor-modal');
  if (!modal) return;
  
  // Load existing settings or defaults
  document.getElementById('image-bg-size').value = media.bgSize || 'cover';
  document.getElementById('image-bg-repeat').value = media.bgRepeat || 'no-repeat';
  document.getElementById('image-bg-position').value = media.bgPosition || 'center';
  
  // Load image for preview
  imagePreviewImg = new Image();
  imagePreviewImg.onload = () => {
    updateImagePreview();
  };
  imagePreviewImg.src = pathToFileURL(media.path);
  
  modal.classList.add('active');
}

function closeImageEditor() {
  const modal = document.getElementById('image-editor-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  editingMediaIndex = null;
  imagePreviewImg = null;
}

let videoPreviewElement = null;
let videoPreviewAnimationId = null;

function updateVideoPreview() {
  if (editingMediaIndex === null || !videoPreviewElement) return;
  
  const canvas = document.getElementById('video-preview-canvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const objectFit = document.getElementById('video-object-fit').value;
  
  const drawFrame = () => {
    if (!videoPreviewElement || videoPreviewElement.readyState < 2) {
      videoPreviewAnimationId = requestAnimationFrame(drawFrame);
      return;
    }
    
    const width = canvas.width;
    const height = canvas.height;
    let scale, w, h, x, y;
    
    if (objectFit === 'fill') {
      w = width;
      h = height;
      x = 0;
      y = 0;
    } else if (objectFit === 'cover') {
      scale = Math.max(width / videoPreviewElement.videoWidth, height / videoPreviewElement.videoHeight);
      w = videoPreviewElement.videoWidth * scale;
      h = videoPreviewElement.videoHeight * scale;
      x = (width - w) / 2;
      y = (height - h) / 2;
    } else if (objectFit === 'none') {
      w = videoPreviewElement.videoWidth;
      h = videoPreviewElement.videoHeight;
      x = (width - w) / 2;
      y = (height - h) / 2;
    } else { // contain (default)
      scale = Math.min(width / videoPreviewElement.videoWidth, height / videoPreviewElement.videoHeight);
      w = videoPreviewElement.videoWidth * scale;
      h = videoPreviewElement.videoHeight * scale;
      x = (width - w) / 2;
      y = (height - h) / 2;
    }
    
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(videoPreviewElement, x, y, w, h);
    
    videoPreviewAnimationId = requestAnimationFrame(drawFrame);
  };
  
  // Cancel previous animation if any
  if (videoPreviewAnimationId) {
    cancelAnimationFrame(videoPreviewAnimationId);
  }
  
  drawFrame();
  imagePreviewImg = null;
}

function saveImageSettings() {
  if (editingMediaIndex === null) return;
  
  const media = allMedia[editingMediaIndex];
  media.bgSize = document.getElementById('image-bg-size').value;
  media.bgRepeat = document.getElementById('image-bg-repeat').value;
  media.bgPosition = document.getElementById('image-bg-position').value;
  
  saveMedia();
  closeImageEditor();
  
  // Refresh display if this media is currently shown
  if (selectedMediaIndex === editingMediaIndex) {
    displayMediaOnPreview(media);
  }
}

function openVideoEditor(mediaIndex) {
  editingMediaIndex = mediaIndex;
  const media = allMedia[mediaIndex];
  const modal = document.getElementById('video-editor-modal');
  if (!modal) return;
  
  // Load existing settings or defaults
  document.getElementById('video-object-fit').value = media.objectFit || 'contain';
  document.getElementById('video-loop').checked = media.loop !== false; // default true
  document.getElementById('video-muted').checked = media.muted !== false; // default true
  
  // Load video for preview
  videoPreviewElement = document.createElement('video');
  videoPreviewElement.src = pathToFileURL(media.path);
  videoPreviewElement.loop = true;
  videoPreviewElement.muted = true;
  videoPreviewElement.play();
  
  // Start preview rendering
  updateVideoPreview();
  
  modal.classList.add('active');
}

function closeVideoEditor() {
  const modal = document.getElementById('video-editor-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  
  // Clean up video preview
  if (videoPreviewElement) {
    videoPreviewElement.pause();
    videoPreviewElement = null;
  }
  if (videoPreviewAnimationId) {
    cancelAnimationFrame(videoPreviewAnimationId);
    videoPreviewAnimationId = null;
  }
  
  editingMediaIndex = null;
}

function saveVideoSettings() {
  if (editingMediaIndex === null) return;
  
  const media = allMedia[editingMediaIndex];
  media.objectFit = document.getElementById('video-object-fit').value;
  media.loop = document.getElementById('video-loop').checked;
  media.muted = document.getElementById('video-muted').checked;
  
  saveMedia();
  closeVideoEditor();
  
  // Refresh display if this media is currently shown
  if (selectedMediaIndex === editingMediaIndex) {
    displayMediaOnLive(media);
  }
}

function initImageEditor() {
  const modal = document.getElementById('image-editor-modal');
  if (!modal) return;
  
  document.getElementById('image-editor-close').addEventListener('click', closeImageEditor);
  document.getElementById('image-editor-cancel').addEventListener('click', closeImageEditor);
  document.getElementById('image-editor-save').addEventListener('click', saveImageSettings);
  
  // Update preview on setting changes
  document.getElementById('image-bg-size').addEventListener('change', updateImagePreview);
  document.getElementById('image-bg-repeat').addEventListener('change', updateImagePreview);
  document.getElementById('image-bg-position').addEventListener('change', updateImagePreview);
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeImageEditor();
    }
  });
}

function initVideoEditor() {
  const modal = document.getElementById('video-editor-modal');
  if (!modal) return;
  
  document.getElementById('video-editor-close').addEventListener('click', closeVideoEditor);
  document.getElementById('video-editor-cancel').addEventListener('click', closeVideoEditor);
  document.getElementById('video-editor-save').addEventListener('click', saveVideoSettings);
  
  // Update preview on setting changes
  document.getElementById('video-object-fit').addEventListener('change', updateVideoPreview);
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeVideoEditor();
    }
  });
}

function displayMediaOnPreview(media) {
  console.log('displayMediaOnPreview called with:', media);
  const canvas = document.getElementById('preview-canvas');
  console.log('Preview canvas element:', canvas);
  if (!canvas) {
    console.error('Preview canvas not found!');
    return;
  }
  
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  console.log('Canvas cleared, size:', canvas.width, 'x', canvas.height);
  
  const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
  const isVideo = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
  const isColor = media.type === 'COLOR';
  console.log('Media type:', media.type, 'isImage:', isImage, 'isVideo:', isVideo, 'isColor:', isColor);
  
  if (isColor) {
    applyColorToCanvas(ctx, media.color, canvas.width, canvas.height);
    console.log('Color background drawn to preview canvas');
  } else if (isImage) {
    const img = new Image();
    const fileURL = pathToFileURL(media.path);
    console.log('Loading image from:', fileURL);
    img.onload = () => {
      console.log('Image loaded successfully, dimensions:', img.width, 'x', img.height);
      drawImageWithSettings(ctx, img, canvas.width, canvas.height, {
        bgSize: media.bgSize,
        bgRepeat: media.bgRepeat,
        bgPosition: media.bgPosition
      });
      console.log('Image drawn to preview canvas');
    };
    img.onerror = (e) => {
      console.error('Failed to load image for preview:', media.path, e);
    };
    img.src = fileURL;
  } else if (isVideo) {
    const video = document.createElement('video');
    video.src = pathToFileURL(media.path);
    video.muted = true;
    video.loop = true;
    video.play();
    
    const drawFrame = () => {
      if (video.readyState >= 2) {
        const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, x, y, w, h);
      }
      requestAnimationFrame(drawFrame);
    };
    drawFrame();
  }
}

async function displayMediaOnLive(media) {
  // Get external display dimensions
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const width = display ? display.bounds.width : 1920;
  const height = display ? display.bounds.height : 1080;
  
  // Set window.currentContent for media type
  window.currentContent = {
    mediaPath: media.path,
    mediaType: media.type,
    mediaColor: media.color, // For color/gradient backgrounds
    width: width,
    height: height,
    isMedia: true
  };
  
  // Send to external live window
  ipcRenderer.send('update-live-window', {
    mediaPath: media.path,
    mediaType: media.type,
    mediaColor: media.color,
    bgSize: media.bgSize,
    bgRepeat: media.bgRepeat,
    bgPosition: media.bgPosition,
    objectFit: media.objectFit,
    loop: media.loop,
    muted: media.muted,
    transitionIn: transitionSettings['fade-in'],
    transitionOut: transitionSettings['fade-out'],
    isMedia: true
  });
  
  const previewCanvas = document.getElementById('preview-canvas');
  const liveCanvas = document.getElementById('live-canvas');
  
  const isImage = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'BMP'].includes(media.type);
  const isVideo = ['MP4', 'WEBM', 'OGG', 'MOV', 'AVI'].includes(media.type);
  const isColor = media.type === 'COLOR';
  
  [previewCanvas, liveCanvas].forEach(canvas => {
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    if (isColor) {
      // Render color/gradient
      applyColorToCanvas(ctx, media.color, canvas.width, canvas.height);
    } else if (isImage) {
      const img = new Image();
      img.onload = () => {
        drawImageWithSettings(ctx, img, canvas.width, canvas.height, {
          bgSize: media.bgSize,
          bgRepeat: media.bgRepeat,
          bgPosition: media.bgPosition
        });
      };
      img.onerror = (e) => console.error('Failed to load image for live:', media.path, e);
      img.src = pathToFileURL(media.path);
    } else if (isVideo) {
      const video = document.createElement('video');
      video.src = pathToFileURL(media.path);
      video.muted = media.muted !== false; // default true
      video.loop = media.loop !== false; // default true
      video.play();
      
      const objectFit = media.objectFit || 'contain';
      
      const drawFrame = () => {
        if (video.readyState >= 2) {
          let scale, w, h, x, y;
          
          if (objectFit === 'fill') {
            w = canvas.width;
            h = canvas.height;
            x = 0;
            y = 0;
          } else if (objectFit === 'cover') {
            scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
            w = video.videoWidth * scale;
            h = video.videoHeight * scale;
            x = (canvas.width - w) / 2;
            y = (canvas.height - h) / 2;
          } else if (objectFit === 'none') {
            w = video.videoWidth;
            h = video.videoHeight;
            x = (canvas.width - w) / 2;
            y = (canvas.height - h) / 2;
          } else { // contain (default)
            scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
            w = video.videoWidth * scale;
            h = video.videoHeight * scale;
            x = (canvas.width - w) / 2;
            y = (canvas.height - h) / 2;
          }
          
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(video, x, y, w, h);
        }
        requestAnimationFrame(drawFrame);
      };
      drawFrame();
    }
  });
}

// ========== TRANSITION SYSTEM ==========

let transitionSettings = {
  'fade-in': { type: 'fade', duration: 0.4 },
  'fade-out': { type: 'fade', duration: 0.4 }
};

// Load transition settings from config
async function loadTransitionSettings() {
  try {
    const settings = await ipcRenderer.invoke('load-settings');
    if (settings && settings.transitions) {
      transitionSettings = { ...transitionSettings, ...settings.transitions };
    }
  } catch (err) {
    console.error('Failed to load transition settings:', err);
  }
}

function setupTransitionButtons() {
  const fadeInBtn = document.getElementById('transition-in-btn');
  const fadeOutBtn = document.getElementById('transition-out-btn');
  
  if (fadeInBtn) {
    fadeInBtn.addEventListener('click', () => openTransitionEditor('fade-in'));
  }
  if (fadeOutBtn) {
    fadeOutBtn.addEventListener('click', () => openTransitionEditor('fade-out'));
  }
}

function openTransitionEditor(transitionType) {
  const modal = document.getElementById('transition-editor-modal');
  const titleEl = document.getElementById('transition-modal-title');
  const durationInput = document.getElementById('transition-duration');
  const typeSelect = document.getElementById('transition-type');
  const previewCanvas = document.getElementById('transition-preview-canvas');
  
  if (!modal) return;
  
  const isIn = transitionType === 'fade-in';
  titleEl.textContent = isIn ? 'Fade In Transition' : 'Fade Out Transition';
  
  const settings = transitionSettings[transitionType];
  durationInput.value = settings.duration;
  typeSelect.value = settings.type;
  
  modal.style.display = 'flex';
  
  // Start preview animation loop
  let animationFrameId = null;
  let startTime = Date.now();
  
  const ctx = previewCanvas.getContext('2d');
  const previewWidth = previewCanvas.width;
  const previewHeight = previewCanvas.height;
  
  const animatePreview = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const duration = parseFloat(durationInput.value) || 1.0;
    const cycleProgress = (elapsed % (duration * 2)) / (duration * 2);
    const isSecondHalf = cycleProgress > 0.5;
    const progress = isSecondHalf ? 2 - (cycleProgress * 2) : cycleProgress * 2;
    
    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, previewWidth, previewHeight);
    
    // Draw sample text with transition based on selected type
    const sampleText = 'Sample Text';
    ctx.font = 'bold 72px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    
    const animType = typeSelect.value;
    
    if (animType === 'fade') {
      // Fade in first half, fade out second half
      if (isSecondHalf) {
        ctx.globalAlpha = 1 - progress;
      } else {
        ctx.globalAlpha = progress;
      }
      ctx.fillText(sampleText, previewWidth / 2, previewHeight / 2);
    } else if (animType === 'slide-left') {
      // Slide in from right to left: start at +width, end at 0
      const xOffset = isSecondHalf ? -previewWidth * (1 - progress) : previewWidth * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2 + xOffset, previewHeight / 2);
    } else if (animType === 'slide-right') {
      // Slide in from left to right: start at -width, end at 0
      const xOffset = isSecondHalf ? previewWidth * (1 - progress) : -previewWidth * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2 + xOffset, previewHeight / 2);
    } else if (animType === 'slide-up') {
      // Slide in from bottom to top: start at +height, end at 0
      const yOffset = isSecondHalf ? -previewHeight * (1 - progress) : previewHeight * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2, previewHeight / 2 + yOffset);
    } else if (animType === 'slide-down') {
      // Slide in from top to bottom: start at -height, end at 0
      const yOffset = isSecondHalf ? previewHeight * (1 - progress) : -previewHeight * (1 - progress);
      ctx.globalAlpha = 1;
      ctx.fillText(sampleText, previewWidth / 2, previewHeight / 2 + yOffset);
    }
    
    ctx.globalAlpha = 1;
    
    animationFrameId = requestAnimationFrame(animatePreview);
  };
  
  animatePreview();
  
  // Update animation when type or duration changes
  typeSelect.addEventListener('change', () => {
    // Restart animation when type changes
    startTime = Date.now();
  });
  
  durationInput.addEventListener('input', () => {
    // Restart animation when duration changes
    startTime = Date.now();
  });
  
  // Close handler
  const closeHandler = () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    modal.style.display = 'none';
    typeSelect.removeEventListener('change', () => {});
    durationInput.removeEventListener('input', () => {});
  };
  
  const closeBtn = document.getElementById('transition-editor-close');
  const cancelBtn = document.getElementById('transition-editor-cancel');
  const saveBtn = document.getElementById('transition-editor-save');
  
  const cleanup = () => {
    closeBtn.removeEventListener('click', closeHandler);
    cancelBtn.removeEventListener('click', closeHandler);
    saveBtn.removeEventListener('click', saveHandler);
    modal.removeEventListener('click', backdropHandler);
  };
  
  const saveHandler = async () => {
    transitionSettings[transitionType] = {
      type: typeSelect.value,
      duration: parseFloat(durationInput.value) || 1.0
    };
    
    // Save to config
    try {
      const settings = await ipcRenderer.invoke('load-settings') || {};
      const newTransitions = { ...(settings.transitions || {}), [transitionType]: transitionSettings[transitionType] };
      await ipcRenderer.invoke('update-settings', { transitions: newTransitions });
    } catch (err) {
      console.error('Failed to save transition settings:', err);
    }
    
    cleanup();
    closeHandler();
  };
  
  const backdropHandler = (e) => {
    if (e.target === modal) {
      cleanup();
      closeHandler();
    }
  };
  
  closeBtn.addEventListener('click', closeHandler);
  cancelBtn.addEventListener('click', () => {
    cleanup();
    closeHandler();
  });
  saveBtn.addEventListener('click', saveHandler);
  modal.addEventListener('click', backdropHandler);
}

// Initialize transition buttons when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  await loadTransitionSettings();
  setupTransitionButtons();
});

// Export test hooks for unit tests (if running under Node)
if (typeof module !== 'undefined' && module.exports) {
  module.exports._renderMediaGrid = renderMediaGrid;
  module.exports._setAllMedia = (m) => { allMedia = m; };
  module.exports._setDefaultBackgrounds = (d) => { defaultBackgrounds = d; };
}



