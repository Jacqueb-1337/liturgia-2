const { BOOKS, CHAPTER_COUNTS, VERSE_COUNTS, ITEM_HEIGHT, WINDOW_SIZE } = require('./constants');

// --- Helpers ---

function normalizeBookName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function prettyBookName(name) {
  return name.replace(/^(\d)/, '$1 ').replace(/\b\w/g, c => c.toUpperCase());
}

// --- UI Rendering ---

/**
 * Renders a single search box that autocompletes and jumps to the first matching element in the target div.
 * Highlights the autocompleted portion in the input.
 * @param {Object} searchState - { containerId: string, targetDivId: string }
 */
function updateSearchBox(searchState) {
  const { containerId, targetDivId } = searchState;
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Search...';
  input.autocomplete = 'off';
  input.id = 'search-autocomplete-input';

  input.addEventListener('input', () => {
    handleSearchInput({ input, targetDivId });
  });

  input.addEventListener('keydown', (e) => {
    // Allow user to accept autocomplete with right arrow or End
    if (e.key === 'ArrowRight' || e.key === 'End') {
      const selectionEnd = input.selectionEnd;
      if (selectionEnd !== null && selectionEnd < input.value.length) {
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      }
    }
  });

  container.appendChild(input);
}

// --- Main Search Logic ---

/**
 * Handles input and autocompletes/jumps to the first matching element.
 * Highlights the autocompleted portion in the input.
 */
function handleSearchInput({ input, targetDivId }) {
  const value = input.value;
  if (!value) {
    clearSelection(targetDivId);
    return;
  }

  const targetDiv = document.getElementById(targetDivId);
  if (!targetDiv) return;

  let found = false;
  let matchText = '';
  Array.from(targetDiv.children).forEach(child => {
    child.classList.remove('search-selected');
    const text = child.textContent.trim();
    if (!found && text.toLowerCase().startsWith(value.toLowerCase())) {
      child.classList.add('search-selected');
      child.scrollIntoView({ behavior: 'smooth', block: 'center' });
      found = true;
      matchText = text;
    }
  });

  // Autocomplete in input: fill in the rest and select the autocompleted part
  if (found && matchText.toLowerCase() !== value.toLowerCase()) {
    input.value = matchText;
    input.setSelectionRange(value.length, matchText.length);
  }
}

function clearSelection(targetDivId) {
  const targetDiv = document.getElementById(targetDivId);
  if (!targetDiv) return;
  Array.from(targetDiv.children).forEach(child => {
    child.classList.remove('search-selected');
  });
}

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
  handleSearchInput,
  setupSearchBox,
  selectSegmentText,
  normalizeBookName,
  prettyBookName
};