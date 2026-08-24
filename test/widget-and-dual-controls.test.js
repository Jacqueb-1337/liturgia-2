const fs = require('fs');
const path = require('path');

describe('widget and dual translation controls', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const searchBox = fs.readFileSync(path.join(__dirname, '..', 'searchBox.js'), 'utf8');

  test('Widget control opens widget creation instead of silently doing nothing on a fresh install', () => {
    expect(renderer).toContain('widgetBtn.style.display = \'\';');
    expect(renderer).toContain('openLocalWidgetModal();');
  });

  test('Dual translation controls are explicit non-submit buttons with guarded async handlers', () => {
    expect(searchBox).toContain("dualPickerBtn.type = 'button';");
    expect(searchBox).toContain('try { await onPickDual(); }');
    expect(searchBox).toContain("dualBtn.type = 'button';");
    expect(searchBox).toContain('try { await onToggleDual(); }');
  });

  test('Dual picker always opens visible feedback even when no second Bible is installed', () => {
    expect(renderer).toContain("document.querySelectorAll('.dual-bible-picker-overlay').forEach(node => node.remove());");
    expect(renderer).toContain("empty.textContent = 'No other installed translation is available. Download another Bible in Settings > Bibles first.';");
    expect(renderer).toContain("document.body.appendChild(overlay);");
  });

  test('Dual translation matches partial Bibles by canonical reference before positional fallback', () => {
    expect(renderer).toContain('const primaryCanonicalKeys = new Map();');
    expect(renderer).toContain('primaryCanonicalKeys.get(`${sv.bookId}:${sv.chapter}:${sv.verse}`)');
    expect(renderer).toContain('verses.length === allVerses.length');
  });
});
