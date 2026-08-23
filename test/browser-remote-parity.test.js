const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('browser remote parity safeguards', () => {
  test('does not request UAC when firewall status cannot be verified', () => {
    const server = fs.readFileSync(path.join(root, 'remote-server.js'), 'utf8');

    expect(server).toContain('checked: false');
    expect(server).toContain('if (existing.active === null)');
    expect(server).toContain('Do not show UAC merely because Windows could not answer');
  });

  test('keeps preview state and canvas snapshots separate from live state', () => {
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const browser = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');

    expect(renderer).toContain('function getCurrentPreviewFields()');
    expect(renderer).toContain('preview: getCurrentPreviewFields()');
    expect(renderer).toContain('await pushBrowserRemoteState();');
    expect(browser).toContain("const preview = describe(state.preview, 'Preview');");
    expect(browser).toContain('canvases.preview');
    expect(browser).toContain('canvases.live');
  });

  test('allows a song viewer to select and preview without granting song editing', () => {
    const server = fs.readFileSync(path.join(root, 'remote-server.js'), 'utf8');
    const browser = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');

    expect(server).toContain("SELECT_SONG: 'songs.view'");
    expect(server).toContain("SELECT_SONG_VERSE: 'songs.view'");
    expect(browser).toContain("if(canGrant('songs.view'))command('SELECT_SONG'");
  });

  test('supports touch drag, saved splitters, and song actions in desktop mode', () => {
    const browser = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');

    expect(browser).toContain("const desktopLayoutStorageKey = 'liturgia-remote-desktop-layout-v2';");
    expect(browser).toContain('function installPointerDrag(doc, node, payload)');
    expect(browser).toContain("command('REORDER_SCHEDULE'");
    expect(browser).toContain("command('ADD_SONG_TO_SCHEDULE'");
    expect(browser).toContain("node.dataset.remoteSuppressClick = 'true'");
    expect(browser).toContain('[data-remote-schedule-index], [data-remote-schedule-drop]');
    expect(browser).toContain("const songAdd = doc.getElementById('song-add-btn');");
    expect(browser).toContain("more.textContent = '⋯'");
    expect(browser).toContain('function openDesktopSongEditor(doc, song = null)');
  });

  test('keeps live Preview and Live canvas thumbnails available in compact mode', () => {
    const browser = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'remote-desktop.css'), 'utf8');

    expect(browser).toContain('id="mobile-canvas-dock"');
    expect(browser).toContain('function renderMobileCanvasDock()');
    expect(browser).toContain('function toggleMobileCanvas(kind)');
    expect(browser).toContain('state.remoteCanvases');
    expect(css).toContain('.mobile-canvas-dock');
    expect(css).toContain('.mobile-canvas-thumb.expanded');
  });
});
