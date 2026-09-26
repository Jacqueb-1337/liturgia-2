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

  test('keeps mobile live controls visible and refreshes canvas snapshots promptly', () => {
    const browser = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'remote-desktop.css'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

    expect(browser).toContain('class="mobile-quick-controls"');
    expect(browser).toContain('data-command="CLEAR_LIVE"');
    expect(browser).toContain('data-command="BLACK_SCREEN"');
    expect(css).toContain('.mobile-quick-controls');
    expect(css).toContain('#remote-app > main { padding-bottom: 86px; }');
    expect(renderer).toContain('function scheduleBrowserRemoteCanvasRefresh(delay = 250)');
    expect(renderer).toContain('This path bypasses the normal desktop song-live handler.');
  });

  test('desktop remote keeps touch scrolling, schedule navigation, and presentation controls wired', () => {
    const browser = fs.readFileSync(path.join(root, 'remote-browser.html'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'remote-desktop.css'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const server = fs.readFileSync(path.join(root, 'remote-server.js'), 'utf8');

    expect(browser).toContain("node.style.touchAction = 'pan-y'");
    expect(browser).toContain('#schedule-list,#verse-list,#song-virtual-list,#song-display{touch-action:pan-y');
    expect(css).toContain('touch-action: pan-y;');
    expect(browser).toContain('function navigateScheduleItem(item)');
    expect(browser).toContain('function navigateDesktopScheduleItem(doc, item, subItem = null)');
    expect(browser).toContain("activateTab('verses')");
    expect(browser).toContain("activateTab('songs')");
    expect(browser).toContain('function goLiveDesktopSelection()');
    expect(browser).toContain("command('SET_LIVE_MODE', { enabled: false");
    expect(browser).toContain('selectedDesktopSongVerseIndex');
    expect(renderer).toContain("case 'SET_LIVE_MODE':");
    expect(renderer).toContain('presentationModes: { live: !!liveMode, clear: !!clearMode, black: !!blackMode }');
    expect(renderer).toContain('lyricIndex: firstLyricIndex');
    expect(server).toContain("command === 'GO_LIVE' || command === 'SET_LIVE_MODE'");
    expect(browser).toContain("const mediaTab = doc.querySelector('.bottom-tab[data-tab=\"media\"]')");
    expect(browser).toContain("const dualControls = doc.getElementById('dual-btn-container')");
  });
});
