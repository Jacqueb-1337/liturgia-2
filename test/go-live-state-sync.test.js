const fs = require('fs');
const path = require('path');

describe('go-live state synchronization', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  test('every text presentation reconciles the external live-window mode', () => {
    expect(renderer).toContain('function sendLivePresentation(payload)');
    expect(renderer).toContain("ipcRenderer.send('set-live-mode', mode);");
    expect(renderer).toContain('sendLivePresentation(livePayload);');
  });

  test('starting live for an exact selection does not send a competing initial selection', () => {
    expect(renderer).toContain("toggleLive(true, { skipInitialContent: true })");
    expect(renderer).toContain('const skipInitialContent = !!options.skipInitialContent;');
    expect(renderer).toContain('if (!skipInitialContent) {');
  });

  test('song double-click uses the same go-live dispatcher as Enter', () => {
    expect(renderer).toContain("songItem.addEventListener('dblclick', async () => {");
    expect(renderer).toContain('await handleVerseDoubleClick();');
  });

  test('mask button classes are derived from renderer state before each presentation', () => {
    expect(renderer).toContain('function syncLiveMaskButtons()');
    expect(renderer).toContain("window.clearButton.classList.toggle('active', clearMode && !blackMode)");
    expect(renderer).toContain("window.blackButton.classList.toggle('active', blackMode)");
  });
});
