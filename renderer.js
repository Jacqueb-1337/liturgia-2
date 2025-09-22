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
let selectedIndices = [];
let anchorIndex = null;
let previewStyles = { verseNumber: '', verseText: '', verseReference: '' };
let liveMode = false;
let clearMode = false;
let blackMode = false;

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

function toggleLive() {
  liveMode = !liveMode;
  if (liveMode) {
    ipcRenderer.invoke('create-live-window');
  } else {
    ipcRenderer.invoke('close-live-window');
  }
}

function toggleClear() {
  if (blackMode) {
    blackMode = false;
    resetLiveCanvas();
    ipcRenderer.send('reset-live-canvas');
  }
  clearMode = !clearMode;
  if (clearMode) {
    clearLiveText();
    ipcRenderer.send('clear-live-text');
  } else {
    showLiveText();
    ipcRenderer.send('show-live-text');
  }
}

function toggleBlack() {
  if (clearMode) {
    clearMode = false;
    resetLiveCanvas();
    ipcRenderer.send('reset-live-canvas');
  }
  blackMode = !blackMode;
  if (blackMode) {
    clearLiveText();
    setLiveBackground('black');
    ipcRenderer.send('set-live-black');
  } else {
    setLiveBackground('default');
    showLiveText();
    ipcRenderer.send('reset-live-canvas');
  }
}

function clearLiveText() {
  document.getElementById('live-number').style.display = 'none';
  document.getElementById('live-text').style.display = 'none';
  document.getElementById('live-reference').style.display = 'none';
}

function showLiveText() {
  document.getElementById('live-number').style.display = '';
  document.getElementById('live-text').style.display = '';
  document.getElementById('live-reference').style.display = '';
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
  const biblePath = path.join(userData, BIBLE_STORAGE_DIR, bible);

  allVerses = await loadAllVersesFromDisk(biblePath);
  document.getElementById('virtual-list').style.height = `${allVerses.length * ITEM_HEIGHT}px`;
  renderWindow(allVerses, 0, selectedIndices, handleVerseClick);
  safeStatus(`Switched to ${bible.replace('.json', '').replace('_', ' ')}.`);
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
  setupPopover();

  // Handle window resize to update text scaling
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      const verseTextEl = document.getElementById('verse-text');
      if (verseTextEl && verseTextEl.textContent && verseTextEl.textContent !== 'Select a verse to preview' && selectedIndices.length > 0) {
        updatePreview(allVerses[selectedIndices[0]]);
      }
    }, 100);
  });
});

async function initScripture() {
  safeStatus('Initializing…');
  allVerses = [];
  selectedIndices = [];
  anchorIndex = null;

  const userData = await ipcRenderer.invoke('get-user-data-path');
  const baseDir = path.join(userData, 'bibles', VERSION);
  await fs.promises.mkdir(baseDir, { recursive: true });

  // Download bible.json if needed
  await ensureBibleJson(baseDir);

  allVerses = await loadAllVersesFromDisk(baseDir);

  document.getElementById('virtual-list').style.height = `${allVerses.length * ITEM_HEIGHT}px`;
  renderWindow(allVerses, 0, selectedIndices, handleVerseClick);
  safeStatus(`Loaded ${allVerses.length} verses.`);

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
    onReferenceSelected: (ref) => {
      const key = `${ref.book} ${ref.chapter}:${ref.verse}`;
      const idx = allVerses.findIndex(v => v.key && v.key.toLowerCase() === key.toLowerCase());
      if (idx !== -1) {
        selectedIndices = [idx];
        anchorIndex = idx;
        updateVerseDisplay(); // Show the verse content
        updatePreview(allVerses[idx]); // Also update preview
        jumpToVerse(idx);     // Scroll to the verse
        // Also immediately highlight in the list
        const listContainer = document.getElementById('verse-list');
        if (listContainer) {
          renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
        }
      } else {
        safeStatus('Verse not found.');
      }
    },
    onNavigate: (direction) => {
      if (direction === 'prev') selectPrevVerse();
      else selectNextVerse();
    },
    onEnter: () => {
      if (selectedIndices.length > 0) handleVerseDoubleClick(selectedIndices[0]);
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
  disp.innerHTML = selectedIndices
    .sort((a, b) => a - b)
    .map(i => {
      // Remove extra info after the main verse text
      // This regex removes: .[number][anything] at the end of the verse
      const cleanText = allVerses[i].text.replace(/(\.\d+[\s\S]*)$/, '');
      return `<p><strong>${allVerses[i].key}</strong><br>${cleanText}</p>`;
    })
    .join('');
}

function updatePreview(verse) {
  const parts = verse.key.split(' ');
  const book = parts.slice(0, -1).join(' ');
  const last = parts[parts.length - 1].split(':');
  const chapter = last[0];
  const verseNum = last[1];

  document.getElementById('verse-number').textContent = verseNum;
  document.getElementById('verse-text').textContent = verse.text;
  document.getElementById('verse-reference').textContent = `${verse.key} (KJV)`;

  // Scale text size based on content length
  scaleTextSize(verse.text.length);
}

async function updateLive(verse) {
  const parts = verse.key.split(' ');
  const book = parts.slice(0, -1).join(' ');
  const last = parts[parts.length - 1].split(':');
  const chapter = last[0];
  const verseNum = last[1];

  document.getElementById('live-number').textContent = verseNum;
  document.getElementById('live-text').textContent = verse.text;
  document.getElementById('live-reference').textContent = `${verse.key} (KJV)`;

  // Send to live window
  const numberFontSizePx = parseFloat(window.getComputedStyle(document.getElementById('live-number')).fontSize);
  const textFontSizePx = parseFloat(window.getComputedStyle(document.getElementById('live-text')).fontSize);
  const referenceFontSizePx = parseFloat(window.getComputedStyle(document.getElementById('live-reference')).fontSize);

  // Scale for external display
  const settings = await ipcRenderer.invoke('load-settings');
  const displays = await ipcRenderer.invoke('get-displays');
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  const mainContent = document.getElementById('live-content');
  const mainWidth = mainContent.clientWidth;
  const externalWidth = display ? display.bounds.width : mainWidth;
  const scale = (mainWidth > 0 && externalWidth > 0) ? externalWidth / mainWidth : 1;

  // Modify styles for scaling
  const modifiedStyles = { ...previewStyles };
  if (modifiedStyles.verseReference) {
    const css = atob(modifiedStyles.verseReference);
    const newCss = css.replace(/font-size:\s*([\d.]+)em/g, (match, num) => `font-size: ${parseFloat(num) * scale}em`);
    modifiedStyles.verseReference = btoa(newCss);
  }

  const scaledNumberFontSize = (numberFontSizePx * scale) + 'px';
  const scaledTextFontSize = (textFontSizePx * scale) + 'px';

  ipcRenderer.send('update-live-window', {
    number: verseNum,
    text: verse.text,
    reference: `${verse.key} (KJV)`,
    styles: modifiedStyles,
    numberFontSize: scaledNumberFontSize,
    textFontSize: scaledTextFontSize
  });

  // Scaling is handled in scaleTextSize for both
}

function scaleTextSize(textLength) {
  const verseTextEl = document.getElementById('verse-text');
  const baseSize = 2; // em

  // Fit text to container height
  let fontSize = 2.5; // max
  verseTextEl.style.fontSize = `${fontSize}em`;
  // Allow layout to update
  setTimeout(() => {
    while (verseTextEl.scrollHeight > verseTextEl.clientHeight && fontSize > 0.5) {
      fontSize -= 0.1;
      verseTextEl.style.fontSize = `${fontSize}em`;
    }
    // Scale other elements proportionally
    const ratio = fontSize / baseSize;
    document.getElementById('verse-number').style.fontSize = `${1.5 * ratio}em`;
    // document.getElementById('verse-reference').style.fontSize = `${0.8 * ratio}em`; // Keep fixed size

    // Update live with same scaling
    document.getElementById('live-text').style.fontSize = `${fontSize}em`;
    document.getElementById('live-number').style.fontSize = `${1.5 * ratio}em`;
    // document.getElementById('live-reference').style.fontSize = `${0.8 * ratio}em`; // Keep fixed size
  }, 0);
}

async function handleVerseClick(i) {
  selectedIndices = [i];
  anchorIndex = i;
  updateVerseDisplay();
  updatePreview(allVerses[i]);
  const listContainer = document.getElementById('verse-list');
  const scrollTop = listContainer ? listContainer.scrollTop : 0;
  renderWindow(allVerses, scrollTop, selectedIndices, handleVerseClick);
}

function handleVerseDoubleClick(i) {
  updateLive(allVerses[i]);
}

function selectNextVerse() {
  if (selectedIndices[0] < allVerses.length - 1) {
    selectedIndices = [selectedIndices[0] + 1];
    updateVerseDisplay();
    updatePreview(allVerses[selectedIndices[0]]);
    jumpToVerse(selectedIndices[0]);
    renderWindow(allVerses, document.getElementById('verse-list').scrollTop, selectedIndices, handleVerseClick);
  }
}

function selectPrevVerse() {
  if (selectedIndices[0] > 0) {
    selectedIndices = [selectedIndices[0] - 1];
    updateVerseDisplay();
    updatePreview(allVerses[selectedIndices[0]]);
    jumpToVerse(selectedIndices[0]);
    renderWindow(allVerses, document.getElementById('verse-list').scrollTop, selectedIndices, handleVerseClick);
  }
}

function toggleLive(isActive) {
  if (isActive) {
    ipcRenderer.invoke('create-live-window');
    if (selectedIndices.length > 0) {
      updateLive(allVerses[selectedIndices[0]]);
    }
  } else {
    ipcRenderer.invoke('close-live-window');
  }
}

function toggleClear() {
  clearMode = !clearMode;
  if (clearMode) {
    clearLiveText();
    ipcRenderer.send('clear-live-text');
  } else {
    showLiveText();
    ipcRenderer.send('show-live-text');
  }
}

function toggleBlack() {
  if (clearMode) {
    clearMode = false;
    showLiveText();
    ipcRenderer.send('show-live-text');
  }
  blackMode = !blackMode;
  if (blackMode) {
    clearLiveText();
    ipcRenderer.send('set-live-black');
  } else {
    showLiveText();
    ipcRenderer.send('reset-live-canvas');
  }
}