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
    const settings = await ipcRenderer.invoke('load-settings');
    settings.previewStyles = previewStyles;
    await ipcRenderer.invoke('save-settings', settings);
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
  if (blackMode) {
    blackMode = false;
    // Reset both canvases
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        renderToCanvas(liveCanvas, window.currentContent, window.currentContent.width, window.currentContent.height);
      }
    }
    ipcRenderer.send('reset-live-canvas');
  }
  clearMode = !clearMode;
  if (clearMode) {
    // Clear text from preview canvas (keep black background)
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
    // Clear text from live window (keep black background)
    ipcRenderer.send('clear-live-text');
  } else {
    // Restore text on both canvases
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        renderToCanvas(liveCanvas, window.currentContent, window.currentContent.width, window.currentContent.height);
      }
    }
    ipcRenderer.send('show-live-text');
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
  initTabs();
  // setupPopover(); // Disabled - not needed with canvas rendering
  initSchedule();
  initResizers();
  restoreDividerPositions();

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
    const isSongDisplayOpen = selectedSongIndices.length > 0 && document.querySelector('.song-display').style.display !== 'none';
    
    if (isInSongsTab && isSongDisplayOpen && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      // Song verse navigation
      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        selectPrevSongVerse();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        selectNextSongVerse();
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
 * Render verse content to a canvas at external display resolution
 * @param {HTMLCanvasElement} canvas - The canvas to render to
 * @param {Object} content - { number, text, reference, showHint }
 * @param {Number} displayWidth - External display width
 * @param {Number} displayHeight - External display height
 */
function renderToCanvas(canvas, content, displayWidth = 1920, displayHeight = 1080) {
  canvas.width = displayWidth;
  canvas.height = displayHeight;
  
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, displayWidth, displayHeight);
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
    
    // Parse text to handle verse numbers as subscripts
    const segments = parseVerseSegments(content.text);
    
    // Auto-size font to fill vertical space optimally
    ctx.font = `${baseFontSize}px Arial`;
    let lines = wrapTextWithSubscripts(ctx, segments, availableWidth, baseFontSize);
    
    // Grow font size to fill available vertical space
    while (lines.length * baseFontSize * 1.2 < availableHeight * 0.85 && baseFontSize < displayHeight * 0.15) {
      baseFontSize += 4;
      ctx.font = `${baseFontSize}px Arial`;
      lines = wrapTextWithSubscripts(ctx, segments, availableWidth, baseFontSize);
    }
    
    // If we overshot, shrink back down
    while (lines.length * baseFontSize * 1.2 > availableHeight && baseFontSize > 20) {
      baseFontSize -= 2;
      ctx.font = `${baseFontSize}px Arial`;
      lines = wrapTextWithSubscripts(ctx, segments, availableWidth, baseFontSize);
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
    renderToCanvas(previewCanvas, {
      number: numberText,
      text: textContent,
      reference: refText,
      showHint: showHint
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
    window.currentContent = {
      number: numberText,
      text: textContent,
      reference: refText,
      showHint: showHint,
      width: width,
      height: height
    };
    renderToCanvas(liveCanvas, window.currentContent, width, height);
  }

  // Send update to the external live window with plain text (canvas needs plain text, not HTML)
  ipcRenderer.send('update-live-window', {
    number: numberText,
    text: textContent,  // Send plain text with double-space format for canvas rendering
    reference: refText,
    showingCount: indicesToShow.length,
    totalSelected: indices.length
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
  await updatePreview(selectedIndices);
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
    if (selectedIndices.length > 0) {
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
    const settings = await ipcRenderer.invoke('load-settings') || {};
    if (!selectedIndices || selectedIndices.length === 0) {
      delete settings.lastSelected;
    } else {
      const start = selectedIndices[0];
      const end = selectedIndices[selectedIndices.length - 1];
      settings.lastSelected = {
        startKey: allVerses[start].key,
        endKey: (start === end) ? null : allVerses[end].key,
        bible: currentBibleFile
      };
    }
    await ipcRenderer.invoke('save-settings', settings);
  } catch (err) {
    console.error('Failed to save last selection to settings:', err);
  }
}

function toggleBlack() {
  if (clearMode) {
    clearMode = false;
  }
  blackMode = !blackMode;
  if (blackMode) {
    // Make preview canvas completely black
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
    // Make live window completely black
    ipcRenderer.send('set-live-black');
  } else {
    // Restore content on both canvases
    if (window.currentContent) {
      const liveCanvas = document.getElementById('live-canvas');
      if (liveCanvas) {
        renderToCanvas(liveCanvas, window.currentContent, window.currentContent.width, window.currentContent.height);
      }
    }
    ipcRenderer.send('reset-live-canvas');
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
    } else if (Array.isArray(dragData)) {
      // Verse indices (legacy format)
      addScheduleItem(dragData);
    }
  } catch (err) {
    console.error('Failed to parse dropped data:', err);
  }
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
    const itemLength = itemType === 'song' ? getSongVerseCount(item.songIndex) : item.indices.length;
    
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
    
    if (itemType === 'song') {
      const song = allSongs[item.songIndex];
      text.textContent = song ? song.title : 'Unknown Song';
    } else {
      text.textContent = getScheduleItemLabel(item.indices);
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
    const settings = await ipcRenderer.invoke('load-settings') || {};
    settings.schedule = scheduleItems;
    await ipcRenderer.invoke('save-settings', settings);
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
    const settings = await ipcRenderer.invoke('load-settings') || {};
    settings.songVerseViewMode = songVerseViewMode;
    await ipcRenderer.invoke('save-settings', settings);
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
  const versePanel = document.getElementById('verse-panel');
  
  const settings = await ipcRenderer.invoke('load-settings') || {};
  settings.dividerPositions = {
    scheduleWidth: scheduleSidebar.style.width || '250px',
    previewFlex: slidePreview.style.flex || '0 0 50%',
    verseHeight: versePanel.style.flex || '0 0 200px'
  };
  await ipcRenderer.invoke('save-settings', settings);
}

async function restoreDividerPositions() {
  const settings = await ipcRenderer.invoke('load-settings') || {};
  if (!settings.dividerPositions) return;
  
  const scheduleSidebar = document.getElementById('schedule-sidebar');
  const slidePreview = document.getElementById('slide-preview');
  const slideLive = document.getElementById('slide-live');
  const versePanel = document.getElementById('verse-panel');
  const topSection = document.getElementById('top-section');
  
  if (settings.dividerPositions.scheduleWidth) {
    scheduleSidebar.style.width = settings.dividerPositions.scheduleWidth;
  }
  
  if (settings.dividerPositions.previewFlex) {
    slidePreview.style.flex = settings.dividerPositions.previewFlex;
    // Calculate the opposite flex for slide-live
    const match = settings.dividerPositions.previewFlex.match(/(\d+\.?\d*)%/);
    if (match) {
      const percentage = parseFloat(match[1]);
      slideLive.style.flex = `0 0 ${100 - percentage}%`;
    }
  }
  
  if (settings.dividerPositions.verseHeight) {
    versePanel.style.flex = settings.dividerPositions.verseHeight;
    // Calculate top section height
    const match = settings.dividerPositions.verseHeight.match(/(\d+)px/);
    if (match) {
      const verseHeight = parseInt(match[1]);
      const topHeight = window.innerHeight - verseHeight - 16; // 16px for resizer
      topSection.style.flex = `0 0 ${topHeight}px`;
    }
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
}

// ========== SONGS MANAGEMENT ==========

async function loadSongs() {
  try {
    const songsPath = path.join(__dirname, 'songs.json');
    const data = fs.readFileSync(songsPath, 'utf8');
    allSongs = JSON.parse(data);
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
    const songItem = document.createElement('div');
    songItem.className = 'song-item';
    
    // Highlight matched text if there's a search query
    if (currentSearchQuery) {
      songItem.innerHTML = highlightText(song.title, currentSearchQuery);
    } else {
      songItem.textContent = song.title;
    }
    
    songItem.setAttribute('data-index', i);
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
    
    if (selectedSongIndices.includes(i)) {
      songItem.style.background = '#0078d4';
      songItem.style.color = '#fff';
    }
    
    songItem.addEventListener('click', (e) => {
      handleSongClick(i, e);
    });
    
    songItem.draggable = true;
    songItem.addEventListener('dragstart', (e) => {
      const dragData = {
        type: 'song',
        songIndex: i
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
  
  renderSongList(allSongs);
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
        html += `<p class="song-verse${isSelected ? ' selected' : ''}" data-verse-index="${globalVerseIndex}" style="white-space: pre-wrap; padding: 8px; margin: 4px 0; cursor: pointer; border-radius: 4px; ${isSelected ? 'background: #0078d4; color: #fff;' : ''}">${verseText}</p>`;
      });
    });
  }
  
  songDisplay.innerHTML = html;
  
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
    renderToCanvas(previewCanvas, {
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null
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
    window.currentContent = {
      number: '',
      text: verseData.text,
      reference: `${verseData.title} - ${verseData.section}`,
      showHint: null,
      width: width,
      height: height
    };
    renderToCanvas(liveCanvas, window.currentContent, width, height);
  }
  
  ipcRenderer.send('update-live-window', {
    number: '',
    text: verseData.text,
    reference: `${verseData.title} - ${verseData.section}`,
    showingCount: 1,
    totalSelected: 1
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
