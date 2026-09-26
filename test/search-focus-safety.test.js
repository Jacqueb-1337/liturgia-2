const fs = require('fs');
const path = require('path');

describe('desktop search focus safety', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const searchBox = fs.readFileSync(path.join(__dirname, '..', 'searchBox.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const styleCss = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

  test('editable fields block presentation shortcuts except the Songs and Bible searches', () => {
    expect(renderer).toContain('function isTextEntryElement(element)');
    expect(renderer).toContain('function isPresentationSearchInput(element)');
    expect(renderer).toContain("element.id === 'search-autocomplete-input'");
    expect(renderer).toContain("element.id === 'song-search-input'");
    expect(renderer).toContain('if (isTextInput && !allowPresentationShortcuts) {');
  });

  test('Bible search keeps focus while its arrow navigation changes the selected verse', () => {
    expect(renderer).toContain('const preserveTextFocus = isTextEntryElement(document.activeElement);');
    expect(renderer).toContain('if (!preserveTextFocus) {');
  });

  test('both search inputs let configured presentation shortcuts reach the global handler', () => {
    expect(renderer).not.toContain("songSearchInput.addEventListener('keydown', (event) => event.stopPropagation());");
    expect(searchBox).toContain('Let configured presentation shortcuts bubble to the global handler.');
    expect(renderer).toContain('if (e.defaultPrevented) return;');
    expect(searchBox).toContain("input.addEventListener('pointerdown'");
  });

  test('song editor validation stays non-blocking and restores the invalid field', () => {
    expect(renderer).toContain("window.alert = (message) => showAppToast(String(message), 'error');");
    expect(renderer).toContain('function focusSongEditorField(field)');
    expect(renderer).toContain("focusSongEditorField(document.getElementById('song-editor-title'));");
  });

  test('song editor owns pointer focus above normal application popovers', () => {
    expect(indexHtml).toContain('id="song-editor-modal"');
    expect(indexHtml).toMatch(/id="song-editor-modal"[^>]*z-index:\s*20000/);
    expect(styleCss).toMatch(/\.song-editor-ctx-menu\s*\{[\s\S]*?z-index:\s*21000;/);
    expect(renderer).toContain("modal.addEventListener('pointerdown', (e) => {");
    expect(renderer).toContain("#song-editor-title, #song-editor-author, #song-editor-hymnal, #song-editor-page, #song-editor-lyrics");
  });
});
