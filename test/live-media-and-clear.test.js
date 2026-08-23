const fs = require('fs');
const path = require('path');

describe('live clear and standalone media regressions', () => {
  const liveHtml = fs.readFileSync(path.join(__dirname, '..', 'live.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  test('Clear restores its background after a live-window resize instead of filling black', () => {
    expect(liveHtml).toContain("} else if (isClearMode) {");
    expect(liveHtml).toContain("setLiveMode('clear');");
  });

  test('Clear sends a neutral background payload rather than retaining song styles', () => {
    expect(renderer).toContain('function createClearPresentation(content)');
    expect(renderer).toContain('styles: {}');
    expect(renderer).toContain('clearPresentation: true');
    expect(renderer).toContain("ipcRenderer.send('update-live-window', clearPresentation);");
    expect(liveHtml).toContain('const _isClearPresentation = !!renderContent_content.clearPresentation;');
    expect(liveHtml).toContain('_isClearPresentation ? 0');
  });

  test('Clear immediately erases the separate live text canvas', () => {
    expect(liveHtml).toContain('if (_isClearPresentation) {');
    expect(liveHtml).toContain('textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);');
  });

  test('standalone media bypasses the old text/background crossfade and clears the text layer', () => {
    expect(liveHtml).toContain('if (!renderContent_content.isMedia && oldContent && !backgroundsEqual(oldContent, renderContent_content))');
    expect(liveHtml).toContain('textCtx.clearRect(0, 0, textCanvas.width, textCanvas.height);');
  });

  test('making non-web media live exits clear or black mode first', () => {
    expect(renderer).toContain('const wasMasked = clearMode || blackMode;');
    expect(renderer).toContain("if (wasMasked) ipcRenderer.send('set-live-mode', 'normal');");
  });
});
