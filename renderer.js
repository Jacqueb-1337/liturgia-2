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
const {
  setupSearchBox,
  parseReference
} = require('./searchBox');
const { safeStatus } = require('./uiHelpers');
const {
  VERSION, CDN_BASE, ITEM_HEIGHT, WINDOW_SIZE, BUFFER, BOOKS, CHAPTER_COUNTS, VERSE_COUNTS, BIBLE_STORAGE_DIR
} = require('./constants');

let allVerses = [];
let selectedIndices = [];
let anchorIndex = null;

// Load settings on startup and apply dark theme if needed
async function loadAndApplySettings() {
  const settings = await ipcRenderer.invoke('load-settings');
  if (settings && settings.darkTheme) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
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
        jumpToVerse(idx);     // Scroll to the verse
        // Also immediately highlight in the list
        const listContainer = document.getElementById('verse-list');
        if (listContainer) {
          renderWindow(allVerses, listContainer.scrollTop, selectedIndices, handleVerseClick);
        }
      } else {
        safeStatus('Verse not found.');
      }
    }
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

async function handleVerseClick(i) {
  selectedIndices = [i];
  anchorIndex = i;
  updateVerseDisplay();
  const listContainer = document.getElementById('verse-list');
  const scrollTop = listContainer ? listContainer.scrollTop : 0;
  renderWindow(allVerses, scrollTop, selectedIndices, handleVerseClick);
}