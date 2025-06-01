const { ITEM_HEIGHT, WINDOW_SIZE, BUFFER } = require('./constants');

function renderWindow(allVerses, windowStart, selectedIndices, handleVerseClick) {
  const wrapper = document.getElementById('virtual-list');
  wrapper.innerHTML = '';
  wrapper.style.height = `${allVerses.length * ITEM_HEIGHT}px`;

  // Create an inner container for visible items
  let inner = document.createElement('div');
  inner.style.position = 'absolute';
  inner.style.left = '0';
  inner.style.right = '0';
  inner.style.top = `${windowStart * ITEM_HEIGHT}px`;

  const start = Math.max(0, windowStart - BUFFER);
  const end   = Math.min(allVerses.length, windowStart + WINDOW_SIZE + BUFFER);

  for (let i = start; i < end; i++) {
    const verse = allVerses[i];
    const div = document.createElement('div');
    div.className = 'verse-item' + (selectedIndices.includes(i) ? ' selected' : '');
    div.textContent = verse.key;
    div.style.height = `${ITEM_HEIGHT}px`;
    div.addEventListener('click', () => handleVerseClick(i));
    inner.appendChild(div);
  }
  wrapper.appendChild(inner);
}

module.exports = { renderWindow };