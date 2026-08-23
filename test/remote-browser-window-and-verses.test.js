const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('Browser Remote style window and verse state', () => {
  test('opens the desktop style editor in a separate browser window', () => {
    const html = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'remote-server.js'), 'utf8');

    expect(html).toContain("window.open('/remote-style-window.html'");
    expect(html).not.toContain('remote-style-editor-overlay');
    expect(server).toContain('window.opener');
    expect(server).toContain('LITURGIA_REMOTE_STYLES_SAVE');
  });

  test('preserves the verse catalog across incremental live updates', () => {
    const html = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

    expect(html).toContain('state = { ...state, ...(msg.data || {}) };');
    expect(renderer).toMatch(/case 'LOOKUP_VERSES':[\s\S]*?verseRefs: allVerses\.map/);
  });

  test('uses actual desktop canvas snapshots and desktop divider limits', () => {
    const html = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

    expect(renderer).toContain('function getRemoteCanvasSnapshots()');
    expect(html).toContain('state.remoteCanvases || {}');
    expect(html).toContain('bottomHeight > 30 && topHeight > 50');
    expect(html).not.toContain('Math.max(260, Math.min(doc.defaultView.innerHeight - 160');
    expect(main).toContain('const { remoteCanvases: _remoteCanvases, ...stateForRelay } = state;');
  });

  test('keeps a clicked virtual verse in place until the double-click can complete', () => {
    const html = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');

    expect(html).toContain('const needsWindowRender =');
    expect(html).toContain('list.querySelectorAll(\'.verse-item\').forEach');
    expect(html).not.toContain('listContainer.scrollTop = selectedIndex * 24');
  });

  test('uses a full-feature compact workspace below the desktop breakpoint', () => {
    const html = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'remote-desktop.css'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'remote-server.js'), 'utf8');

    expect(html).toContain('id="mobile-verse-reference"');
    expect(html).toContain('id="mobile-verse-results"');
    expect(html).toContain('id="mobile-overflow"');
    expect(html).toContain('function lookupMobileVerse()');
    expect(html).toContain("command('ADD_SONG_TO_SCHEDULE'");
    expect(css).toContain('#desktop-shell { display: none !important; }');
    expect(css).toContain('grid-template-columns: repeat(5, minmax(0, 1fr))');
    expect(renderer).toContain("case 'ADD_SONG_TO_SCHEDULE':");
    expect(server).toContain("ADD_SONG_TO_SCHEDULE: 'schedule.edit'");
  });

  test('keeps the narrow workspace visually consistent with the desktop remote', () => {
    const css = fs.readFileSync(path.join(root, 'remote-desktop.css'), 'utf8');

    expect(css).toContain('A narrow display is a compact continuation of the desktop workspace');
    expect(css).toContain(':root { color-scheme: light; }');
    expect(css).toContain('.shell > header { height: 42px;');
    expect(css).toContain('.nav { position: sticky; top: 42px;');
    expect(css).toContain('.mobile-overflow-sheet { padding: 9px 14px');
  });

  test('keeps the desktop bottom splitter responsive to touch drags', () => {
    const html = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

    expect(html).toContain("divider.style.touchAction = 'none';");
    expect(html).toContain("doc.addEventListener('pointermove', move, { passive: false });");
    expect(html).toContain("doc.removeEventListener('pointercancel', finish, true);");
    expect(css).toContain('touch-action: none;');
  });
});
