const fs = require('fs');
const path = require('path');

describe('desktop search focus safety', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const searchBox = fs.readFileSync(path.join(__dirname, '..', 'searchBox.js'), 'utf8');

  test('global presentation shortcuts do not consume keys from editable fields', () => {
    expect(renderer).toContain('function isTextEntryElement(element)');
    expect(renderer).toContain('const isTextInput = isTextEntryElement(e.target) || isTextEntryElement(document.activeElement);');
    expect(renderer).toContain('if (isTextInput) {');
  });

  test('Bible search keeps focus while its arrow navigation changes the selected verse', () => {
    expect(renderer).toContain('const preserveTextFocus = isTextEntryElement(document.activeElement);');
    expect(renderer).toContain('if (!preserveTextFocus) {');
  });

  test('both search inputs stop key events from bubbling into presentation controls', () => {
    expect(renderer).toContain("songSearchInput.addEventListener('keydown', (event) => event.stopPropagation());");
    expect(searchBox).toContain('e.stopPropagation();');
    expect(searchBox).toContain("input.addEventListener('pointerdown'");
  });
});
