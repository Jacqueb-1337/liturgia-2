// const { BOOKS } = require('./constants');

// --- Helpers ---

function normalizeBookName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function prettyBookName(name) {
  return name.replace(/^(\d)/, '$1 ').replace(/\b\w/g, c => c.toUpperCase());
}

// --- UI Rendering ---

function parseReference(input, books) {
  // Accepts: "1ch 11 4", "1 chronicles 11:4", "1chronicles11:4", etc.
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  // Split into parts: book, chapter, verse
  // Allow optional spaces around the range hyphen (e.g., '2-4' or '2 - 4')
  const match = trimmed.match(/^([1-3]?\s*[a-zA-Z ]+)\s*(\d+)?[:\s]?(\d+)?(?:\s*-\s*(\d+))?$/);
  if (!match) return null;

  let [ , bookPart, chapter, verse, verseEnd ] = match;
  // Normalize: remove all non-alphanumerics (including spaces)
  bookPart = bookPart.replace(/[^a-z0-9]/gi, '').toLowerCase();

  // Find best matching book
  let book = null;
  let bookIndex = -1;
  for (let i = 0; i < books.length; ++i) {
    const norm = books[i].replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (norm.startsWith(bookPart)) {
      book = books[i];
      bookIndex = i;
      break;
    }
  }
  if (!book) return null;

  chapter = chapter ? parseInt(chapter, 10) : null;
  verse = verse ? parseInt(verse, 10) : null;
  verseEnd = verseEnd ? parseInt(verseEnd, 10) : null;

  return { book, bookIndex, chapter, verse, verseEnd };
}

function updateSearchBox({ containerId, onReferenceSelected, onNavigate, onEnter, books, onToggleLive, onToggleClear, onToggleBlack, onToggleDual, onPickDual }) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const existingInput = document.getElementById('search-autocomplete-input');
  if (existingInput && container.contains(existingInput)) {
    existingInput._books = books;
    return;
  }

  container.innerHTML = '';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.gap = '0.25em';

  // Input box
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Book Chapter:Verse';
  input.autocomplete = 'off';
  input.id = 'search-autocomplete-input';
  input.spellcheck = false;
  input.style.width = '14em';

  // Closest match display
  const matchBox = document.createElement('div');
  matchBox.style.marginTop = '0.25em';
  matchBox.style.fontSize = '0.95em';
  matchBox.style.color = '#0074d9';
  matchBox.style.minHeight = '1.2em'; // Reserve space so layout doesn't shift

  // Get the control buttons container (outside tabs)
  const buttonsContainer = document.getElementById('control-buttons-container');
  if (buttonsContainer) {
    buttonsContainer.innerHTML = ''; // Clear any existing buttons
  }

  // Widget toggle button
  const ltBtn = document.createElement('button');
  ltBtn.id = 'lower-third-btn';
  ltBtn.textContent = 'Widget';
  ltBtn.style.padding = '4px 8px';
  ltBtn.style.borderRadius = '6px';
  ltBtn.style.marginRight = '6px';
  ltBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.onToggleLowerThird) window.onToggleLowerThird();
  });
  window.lowerThirdButton = ltBtn;

  // Go Live button
  const goLiveBtn = document.createElement('button');
  goLiveBtn.textContent = 'Go Live';
  goLiveBtn.style.padding = '4px 8px';
  goLiveBtn.style.borderRadius = '6px 0 0 6px';
  goLiveBtn.style.borderRight = 'none';
  goLiveBtn.addEventListener('click', () => {
    if (onEnter) onEnter();
  });

  // Live button
  const liveBtn = document.createElement('button');
  liveBtn.textContent = 'Live';
  liveBtn.style.padding = '4px 8px';
  liveBtn.style.borderRadius = '0';
  liveBtn.style.borderRight = 'none';
  liveBtn.addEventListener('click', () => {
    const willBeActive = !liveBtn.classList.contains('active');
    if (onToggleLive) onToggleLive(willBeActive);
    // Don't toggle here - let updateLiveButtonState handle it
  });
  
  // Store reference globally so renderer.js can update it
  window.liveButton = liveBtn;

  // Clear button
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear';
  clearBtn.style.padding = '4px 8px';
  clearBtn.style.borderRadius = '0';
  clearBtn.style.borderRight = 'none';
  clearBtn.addEventListener('click', () => {
    if (onToggleClear) onToggleClear();
    // Don't manually toggle button state - let toggleClear() in renderer.js handle it
  });
  
  // Store reference globally so renderer.js can update it
  window.clearButton = clearBtn;

  // Black button
  const blackBtn = document.createElement('button');
  blackBtn.textContent = 'Black';
  blackBtn.style.padding = '4px 8px';
  blackBtn.style.borderRadius = '0 6px 6px 0';
  blackBtn.addEventListener('click', () => {
    if (onToggleBlack) onToggleBlack();
    // Don't manually toggle button state - let toggleBlack() in renderer.js handle it
  });
  
  // Store reference globally so renderer.js can update it
  window.blackButton = blackBtn;

  // Dual picker button — always opens the bible selection dialog
  const dualPickerBtn = document.createElement('button');
  dualPickerBtn.title = 'Select secondary translation';
  dualPickerBtn.className = 'dual-picker-btn';
  const dualIcon = document.createElement('img');
  dualIcon.src = 'dual.svg';
  dualIcon.alt = 'Dual';
  dualIcon.className = 'dual-svg-icon';
  dualPickerBtn.appendChild(dualIcon);
  dualPickerBtn.addEventListener('click', () => {
    if (onPickDual) onPickDual();
  });
  window.dualPickerButton = dualPickerBtn;

  // Dual toggle button — shows selected translation name, toggles active class (like Clear button)
  const dualBtn = document.createElement('button');
  dualBtn.title = 'Toggle dual translation on/off';
  dualBtn.style.display = 'none'; // hidden until a secondary is selected
  dualBtn.addEventListener('click', () => {
    if (onToggleDual) onToggleDual();
  });

  // Store reference globally so renderer.js can update it
  window.dualButton = dualBtn;

  if (buttonsContainer) {
    buttonsContainer.appendChild(ltBtn);
    buttonsContainer.appendChild(goLiveBtn);
    buttonsContainer.appendChild(liveBtn);
    buttonsContainer.appendChild(clearBtn);
    buttonsContainer.appendChild(blackBtn);
  }

  // Dual button lives next to the scripture search bar (verses tab only)
  const dualBtnContainer = document.getElementById('dual-btn-container');
  if (dualBtnContainer) {
    dualBtnContainer.innerHTML = '';
    dualBtnContainer.appendChild(dualPickerBtn);
    dualBtnContainer.appendChild(dualBtn);
  }

  container.appendChild(input);
  container.appendChild(matchBox);

  function updateMatchAndJump() {
    const value = input.value;
    const ref = parseReference(value, input._books || books);
    const scriptureSearch = document.getElementById('scripture-search');
    if (ref && ref.book) {
      let display = ref.book;
      if (ref.chapter) display += ` ${ref.chapter}`;
      if (ref.verse) display += `:${ref.verse}`;
      if (ref.verseEnd) display += `-${ref.verseEnd}`;
      matchBox.textContent = `Closest match: ${display}`;
      // Animate only padding-bottom when match appears
      if (scriptureSearch) scriptureSearch.style.paddingBottom = '8px';
      if (typeof onReferenceSelected === 'function') {
        onReferenceSelected({
          book: ref.book,
          bookIndex: ref.bookIndex,
          chapter: ref.chapter || 1,
          verse: ref.verse || 1,
          verseEnd: ref.verseEnd || null
        });
      }
    } else {
      matchBox.textContent = '';
      // Animate only padding-bottom when match disappears
      if (scriptureSearch) scriptureSearch.style.paddingBottom = '0px';
    }
  }

  input.addEventListener('input', updateMatchAndJump);

  // Also handle navigation and enter
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (onNavigate) onNavigate('prev');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (onNavigate) onNavigate('next');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (onEnter) onEnter();
    }
  });

  input.focus();
}

// --- Main Search Logic ---

function setupSearchBox(searchState) {
  updateSearchBox(searchState);
}

function setSearchByString() {}
function scrollToSearch() {}
function selectSegmentText() {}
function focusSearchSegment() {}

module.exports = {
  updateSearchBox,
  focusSearchSegment,
  setSearchByString,
  scrollToSearch,
  setupSearchBox,
  selectSegmentText,
  normalizeBookName,
  prettyBookName,
  parseReference
};
