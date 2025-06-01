// renderer.js

const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');
const {
  loadAllVersesFromDisk,
  fetchChapter,
  downloadRemainingChapters
} = require('./scriptureData');
const { renderWindow } = require('./virtualList');
const {
  updateSearchBox,
  focusSearchSegment,
  setSearchByString,
  scrollToSearch,
  handleSearchInput,
  setupSearchBox,
  selectSegmentText
} = require('./searchBox');
const { safeStatus } = require('./uiHelpers');
const {
  VERSION, CDN_BASE, ITEM_HEIGHT, WINDOW_SIZE, BUFFER, BOOKS, CHAPTER_COUNTS, VERSE_COUNTS
} = require('./constants');

let allVerses = [];
let windowStart = 0;
let selectedIndices = [];
let anchorIndex = null;
let searchState = {
  book: 0,
  chapter: 1,
  verse: 1,
  segment: 0
};

document.addEventListener('DOMContentLoaded', () => {
  const listContainer = document.getElementById('verse-list');
  if (!listContainer) {
    console.error('Missing #verse-list in HTML');
    return;
  }
  listContainer.style.position = 'relative';
  listContainer.style.overflowY = 'auto';

  const wrapper = document.createElement('div');
  wrapper.id = 'virtual-list';
  wrapper.style.position = 'relative';
  listContainer.appendChild(wrapper);

  listContainer.addEventListener('scroll', () => {
    const ratio = listContainer.scrollTop / (listContainer.scrollHeight - listContainer.clientHeight);
    windowStart = Math.floor(ratio * (allVerses.length - WINDOW_SIZE));
    renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick);
  });

  initScripture();
});

async function initScripture() {
  safeStatus('Initializing…');
  allVerses = [];
  windowStart = 0;
  selectedIndices = [];
  anchorIndex = null;

  const userData = await ipcRenderer.invoke('get-user-data-path');
  const baseDir = path.join(userData, 'bibles', VERSION);
  await fs.promises.mkdir(path.join(baseDir, 'books'), { recursive: true });

  let fullyOnDisk = true;
  for (const book of BOOKS) {
    const chapDir = path.join(baseDir, 'books', book, 'chapters');
    try {
      const files = await fs.promises.readdir(chapDir);
      const count = files.filter(f => /^\d+\.json$/.test(f)).length;
      if (count < CHAPTER_COUNTS[book]) {
        fullyOnDisk = false;
        break;
      }
    } catch {
      fullyOnDisk = false;
      break;
    }
  }

  allVerses = await loadAllVersesFromDisk(baseDir);

  document.getElementById('virtual-list').style.height = `${allVerses.length * ITEM_HEIGHT}px`;
  renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick);
  safeStatus(`Loaded ${allVerses.length} verses.`);
  updateSearchBox(searchState);
  scrollToSearch(searchState, allVerses, { windowStart, selectedIndices, anchorIndex }, () => renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick), updateVerseDisplay);

  if (!fullyOnDisk) {
    safeStatus('Downloading missing chapters…');
    await downloadRemainingChapters(baseDir, async () => {
      allVerses = await loadAllVersesFromDisk(baseDir);
      renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick);
      updateSearchBox(searchState);
    });
  }

  setupSearchBox(
    searchState,
    allVerses,
    { windowStart, selectedIndices, anchorIndex },
    () => renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick),
    updateVerseDisplay,
    handleVerseClick
  );
}

function updateVerseDisplay() {
  const disp = document.getElementById('verse-display');
  if (!disp) return;
  disp.innerHTML = selectedIndices
    .sort((a, b) => a - b)
    .map(i => `<p><strong>${allVerses[i].key}</strong><br>${allVerses[i].text}</p>`)
    .join('');
}

async function handleVerseClick(i) {
  selectedIndices = [i];
  anchorIndex = i;
  const match = allVerses[i].key.match(/^(.+?)\s(\d+):(\d+)$/);
  if (!match) return; // or handle error
  const [b, c, vnum] = match.slice(1);
  searchState.book = BOOKS.indexOf(b.toLowerCase());
  searchState.chapter = Number(c);
  searchState.verse = Number(vnum);
  updateSearchBox(searchState);
  updateVerseDisplay();
  renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick);
}

document.getElementById('verse-list').addEventListener('keydown', (e) => {
  handleSearchInput(
    e,
    searchState,
    allVerses,
    { windowStart, selectedIndices, anchorIndex },
    () => renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick),
    updateVerseDisplay,
    handleVerseClick
  );
});