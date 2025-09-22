const { ITEM_HEIGHT, WINDOW_SIZE, BUFFER } = require('./constants');

/**
 * Renders the visible verses in the virtual list.
 * @param {Array} allVerses - All verse objects.
 * @param {number} scrollTop - Current scrollTop of the container.
 * @param {Array} selectedIndices - Indices of selected verses.
 * @param {Function} handleVerseClick - Click handler.
 */
function renderWindow(allVerses, scrollTop, selectedIndices, handleVerseClick) {
  const wrapper = document.getElementById('virtual-list');
  if (!wrapper) return;

  // Set the total height for the spacer
  wrapper.style.height = `${allVerses.length * ITEM_HEIGHT}px`;

  // Remove any previous rendered items
  while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);

  // Calculate which verses to render
  const total = allVerses.length;
  const firstIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER);
  const lastIndex = Math.min(
    total,
    Math.ceil((scrollTop + WINDOW_SIZE * ITEM_HEIGHT) / ITEM_HEIGHT) + BUFFER
  );

  // Render only the visible verses
  for (let i = firstIndex; i < lastIndex; i++) {
    const verse = allVerses[i];
    const div = document.createElement('div');
    div.className = 'verse-item' + (selectedIndices.includes(i) ? ' selected' : '');
    div.textContent = verse.key;
    div.style.position = 'absolute';
    div.style.top = `${i * ITEM_HEIGHT}px`;
    div.style.left = '0';
    div.style.right = '0';
    div.style.width = '100%';
    div.style.height = `${ITEM_HEIGHT}px`;
    div.addEventListener('click', () => handleVerseClick(i));
    div.addEventListener('dblclick', () => handleVerseDoubleClick(i));
    wrapper.appendChild(div);
  }
}

module.exports = { renderWindow };