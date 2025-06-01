const { BOOKS } = require('./constants');

// --- Helpers ---

function normalizeBookName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function prettyBookName(name) {
  return name.replace(/^(\d)/, '$1 ').replace(/\b\w/g, c => c.toUpperCase());
}

// --- UI Rendering ---

function parseReference(input) {
  // Accepts: "1ch 11 4", "1 chronicles 11:4", "1chronicles11:4", etc.
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  // Split into parts: book, chapter, verse
  const match = trimmed.match(/^([1-3]?\s*[a-zA-Z ]+)\s*(\d+)?[:\s]?(\d+)?$/);
  if (!match) return null;

  let [ , bookPart, chapter, verse ] = match;
  // Normalize: remove all non-alphanumerics (including spaces)
  bookPart = bookPart.replace(/[^a-z0-9]/gi, '').toLowerCase();

  // Find best matching book
  let book = null;
  let bookIndex = -1;
  for (let i = 0; i < BOOKS.length; ++i) {
    const norm = BOOKS[i].replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (norm.startsWith(bookPart)) {
      book = BOOKS[i];
      bookIndex = i;
      break;
    }
  }
  if (!book) return null;

  chapter = chapter ? parseInt(chapter, 10) : null;
  verse = verse ? parseInt(verse, 10) : null;

  return { book, bookIndex, chapter, verse };
}

function updateSearchBox(searchState) {
  const { containerId, onReferenceSelected } = searchState;
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';
  container.style.paddingTop = '1em'; // Add padding above the search box

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

  container.appendChild(input);
  container.appendChild(matchBox);

  function updateMatchAndJump() {
    const value = input.value;
    const ref = parseReference(value);
    const scriptureSearch = document.getElementById('scripture-search');
    if (ref && ref.book) {
      let display = ref.book;
      if (ref.chapter) display += ` ${ref.chapter}`;
      if (ref.verse) display += `:${ref.verse}`;
      matchBox.textContent = `Closest match: ${display}`;
      // Animate only padding-bottom when match appears
      if (scriptureSearch) scriptureSearch.style.paddingBottom = '8px';
      if (typeof onReferenceSelected === 'function') {
        onReferenceSelected({
          book: ref.book,
          bookIndex: ref.bookIndex,
          chapter: ref.chapter || 1,
          verse: ref.verse || 1
        });
      }
    } else {
      matchBox.textContent = '';
      // Animate only padding-bottom when match disappears
      if (scriptureSearch) scriptureSearch.style.paddingBottom = '0px';
    }
  }

  input.addEventListener('input', updateMatchAndJump);

  // Also jump on Enter
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      updateMatchAndJump();
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