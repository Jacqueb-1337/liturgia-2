// renderer.js

const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
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
  styleEl.textContent = css;
}

function setupPopover() {
  const popover = document.getElementById('css-popover');
  const textarea = document.getElementById('css-textarea');
  const cssSelect = document.getElementById('css-select');
  const saveBtn = document.getElementById('css-save');
  const cancelBtn = document.getElementById('css-cancel');
  const errorDiv = document.getElementById('css-error');
  let currentElement = null;

  // Click listeners for elements
  document.getElementById('verse-number').addEventListener('click', () => showPopover('Verse Number', 'verseNumber'));
  document.getElementById('verse-text').addEventListener('click', () => showPopover('Verse Text', 'verseText'));
  document.getElementById('verse-reference').addEventListener('click', () => showPopover('Verse Reference', 'verseReference'));

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

function applyPreviewStyles() {
  // Apply to preview elements
  Object.keys(previewStyles).forEach(key => {
    const el = document.getElementById(key.toLowerCase().replace('verse', ''));
    if (el && previewStyles[key]) {
      el.style.cssText = atob(previewStyles[key]);
    }
  });
  // Also apply to live elements
  Object.keys(previewStyles).forEach(key => {
    const liveEl = document.getElementById('live-' + key.toLowerCase().replace('verse', ''));
    if (liveEl && previewStyles[key]) {
      liveEl.style.cssText = atob(previewStyles[key]);
    }
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

ipcRenderer.on('default-bible-changed', async (event, bible) => {
  const userData = await ipcRenderer.invoke('get-user-data-path');
  const baseName = bible.endsWith('.json') ? bible.replace('.json','') : bible;
  const biblePath = path.join(userData, BIBLE_STORAGE_DIR, baseName);
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
  } catch (err) {
    console.error('Failed to restore last selection:', err);
  }
});

window.addEventListener('DOMContentLoaded', () => {
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

  loadAndApplySettings();

  const listContainer = document.getElementById('verse-list');
  if (!listContainer) return;

  // Initial render
  renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);

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
  // setupPopover(); // Disabled - not needed with canvas rendering
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

      // Clamp same as restore
      const clampedSchedule = Math.max(100, Math.min(scheduleWidthPx, Math.max(150, window.innerWidth - 400)));
      const clampedPreview = Math.max(10, Math.min(previewPercent, 90));
      const clampedVerse = Math.max(50, Math.min(verseHeightPx, Math.max(100, window.innerHeight - 100)));

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
        document.getElementById('top-section').style.flex = `0 0 ${Math.max(50, window.innerHeight - clampedVerse - 16)}px`;
        versePanel.style.flex = `0 0 ${clampedVerse}px`;
        changed = true;
      }

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
  renderWindow(allVerses, 0, selectedIndices, handleVerseClick);
  safeStatus(`Loaded ${allVerses.length} verses.`);
  
  // Render schedule now that allVerses is populated
  if (scheduleItems.length > 0) {
    renderSchedule();
  }

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
    ctx.fillText(content.number, padding, padding + baseFontSize * 0.3);
  }
  
  // Render verse text (center)
  if (content.text) {
    ctx.textAlign = 'center';
    const textY = displayHeight / 2;
    
    // Split text by explicit newlines first (for songs), then handle verse numbers
    const textLines = content.text.split('\n');
    const allLines = [];
    
    textLines.forEach(textLine => {
      // Parse text to handle verse numbers as subscripts
      const segments = parseVerseSegments(textLine);
      
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
      renderLineWithSubscripts(ctx, line, displayWidth / 2, startY + (i * lineHeight) + (baseFontSize / 2), baseFontSize);
    });
  }
  
  // Render reference (bottom right)
  if (content.reference) {
    ctx.font = `${baseFontSize * 0.7}px Arial`;
    ctx.textAlign = 'right';
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
      // Split text into words
      const words = seg.text.split(' ');
      words.forEach((word, idx) => {
        const testWord = word + (idx < words.length - 1 ? ' ' : '');
        const width = ctx.measureText(testWord).width;
        
        if (currentWidth + width > maxWidth && currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = [];
          currentWidth = 0;
        }
        
        currentLine.push({ isNumber: false, text: testWord });
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
function renderLineWithSubscripts(ctx, segments, centerX, y, baseFontSize) {
  // Calculate total width
  const subscriptSize = baseFontSize * 0.6;
  let totalWidth = 0;
  
  segments.forEach(seg => {
    if (seg.isNumber) {
      ctx.font = `${subscriptSize}px Arial`;
      totalWidth += ctx.measureText(seg.text + ' ').width;
    } else {
      ctx.font = `${baseFontSize}px Arial`;
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
      ctx.fillStyle = '#ddd';
      ctx.textAlign = 'left';
      ctx.fillText(seg.text + ' ', x, y + (baseFontSize * 0.2));
      x += ctx.measureText(seg.text + ' ').width;
      ctx.fillStyle = '#fff';
    } else {
      // Render normal text
      ctx.font = `${baseFontSize}px Arial`;
      ctx.textAlign = 'left';
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
    window.currentContent = {
      number: numberText,
      text: textContent,
      reference: refText,
      showHint: showHint,
      width: width,
      height: height,
      backgroundMedia: backgroundMedia
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
    
    // Text
    const text = document.createElement('div');
    text.className = 'schedule-item-text';
    
    let displayText = '';
    if (itemType === 'song') {
      const song = allSongs[item.songIndex];
      displayText = song ? song.title : 'Unknown Song';
    } else if (itemType === 'media') {
      const media = allMedia[item.mediaIndex];
      const iconSVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle; margin-right: 4px;"><path d="M15 12V6a2 2 0 0 0-2-2h-1.172a2 2 0 0 1-1.414-.586l-.828-.828A2 2 0 0 0 8.172 2H7.828a2 2 0 0 0-1.414.586l-.828.828A2 2 0 0 1 4.172 4H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2zM8 9a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>';
      const mediaName = media ? media.name : 'Unknown Media';
      displayText = mediaName.length > 35 ? mediaName.substring(0, 32) + '...' : mediaName;
      text.innerHTML = media ? iconSVG + displayText : 'Unknown Media';
    } else {
      displayText = getScheduleItemLabel(item.indices);
    }
    
    if (itemType !== 'media') {
      // Truncate text if too long (max 40 chars)
      if (displayText.length > 40) {
        text.textContent = displayText.substring(0, 37) + '...';
        text.title = displayText; // Show full text on hover
      } else {
        text.textContent = displayText;
      }
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
              
              // First line of verse as label
              const firstLine = verse.split('\\n')[0];
              const label = firstLine.length > 40 ? firstLine.substring(0, 40) + '...' : firstLine;
              verseItem.textContent = `${section.section} (${i + 1}): ${label}`;
              
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
          verseItem.textContent = match ? `${match[1]} ${match[2]}:${match[3]}` : verse.key;
        } else {
          verseItem.textContent = 'Unknown';
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
  if (!settings.dividerPositions) return;
  
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
  if (!verseHeightPx) verseHeightPx = 200;

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
    } else {
      songItem.textContent = song.title;
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
        const verseText = currentSearchQuery ? highlightText(verse, currentSearchQuery) : verse;
        html += `<p class="song-verse${isSelected ? ' selected' : ''}" data-verse-index="${globalVerseIndex}" style="white-space: pre-wrap; padding: 4px; margin: 2px 0; cursor: pointer; border-radius: 4px; ${isSelected ? 'background: #0078d4; color: #fff;' : ''}">${verseText}</p>`;
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
    renderToCanvas(previewCanvas, {
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null,
      backgroundMedia: backgroundMedia
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
    window.currentContent = {
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null,
      width: width,
      height: height,
      backgroundMedia: backgroundMedia
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
  
  // Show/hide edit option based on selection
  const editOption = document.getElementById('song-context-edit');
  if (editOption) {
    editOption.style.display = selectedSongIndices.length === 1 ? 'block' : 'none';
  }
  
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

function initSongContextMenu() {
  const editBtn = document.getElementById('song-context-edit');
  const deleteBtn = document.getElementById('song-context-delete');
  const exportBtn = document.getElementById('song-context-export');
  const importBtn = document.getElementById('song-context-import');
  
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      if (selectedSongIndices.length === 1) {
        editSong(selectedSongIndices[0]);
      }
    });
  }
  
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      deleteSongs(selectedSongIndices);
    });
  }
  
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportSongs(selectedSongIndices);
    });
  }
  
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      importSongs();
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
    updateInlineSongFormatting();
    
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
    
    // Check for tag at start of section: [Tag], {Tag}, or (Tag)
    const tagMatch = sectionContent.match(/^[\[\{\(](.+?)[\]\}\)]\s*\n?/);
    if (tagMatch) {
      sectionLabel = tagMatch[1].trim();
      sectionContent = sectionContent.substring(tagMatch[0].length).trim();
    } else {
      // Default to "Verse" if no tag
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
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>');
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
    
    // Check for tag at start of section: [Tag], {Tag}, or (Tag)
    const tagMatch = sectionContent.match(/^[\[\{\(](.+?)[\]\}\)]\s*\n?/);
    if (tagMatch) {
      sectionLabel = tagMatch[1].trim();
      sectionContent = sectionContent.substring(tagMatch[0].length).trim();
    } else {
      // Default to "Verse" if no tag
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
  // Convert Windows path to proper file URL
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
    
    // Thumbnail
    if (isColor) {
      html += `<div style="width: 100%; height: 60px; background: ${media.color}; border-radius: 3px; margin-bottom: 6px;"></div>`;
    } else {
      const fileURL = media.path ? media.path.replace(/\\/g, '/') : '';
      if (isImage) {
      html += `<div style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; overflow: hidden; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
        <img src="file:///${fileURL}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
      </div>`;
    } else if (isVideo) {
      html += `<div style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; overflow: hidden; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
        <video src="file:///${fileURL}" style="max-width: 100%; max-height: 100%; object-fit: contain;"></video>
      </div>`;
      } else {
        html += `<div style="width: 100%; height: 60px; background: #f0f0f0; border-radius: 3px; margin-bottom: 6px; display: flex; align-items: center; justify-content: center;">
          <svg width="30" height="30" viewBox="0 0 16 16" fill="#666"><path d="M5.5 7a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1h-5zM5 9.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"/><path d="M9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.5L9.5 0zm0 1v2A1.5 1.5 0 0 0 11 4.5h2V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5.5z"/></svg>
        </div>`;
      }
    }
    
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
        // Store entire media object, not just path
        defaultBackgrounds.songs = selectedMediaIndex;
        await saveMedia();
        menu.style.display = 'none';
      }
    });
    
    document.getElementById('media-context-bg-verses').addEventListener('click', async () => {
      if (selectedMediaIndex !== null) {
        // Store entire media object, not just path
        defaultBackgrounds.verses = selectedMediaIndex;
        await saveMedia();
        menu.style.display = 'none';
      }
    });
    
    document.getElementById('media-context-reset-songs').addEventListener('click', async () => {
      defaultBackgrounds.songs = null;
      await saveMedia();
      menu.style.display = 'none';
    });
    
    document.getElementById('media-context-reset-verses').addEventListener('click', async () => {
      defaultBackgrounds.verses = null;
      await saveMedia();
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


