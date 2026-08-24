const fs = require('fs');
const path = require('path');

describe('live clear, media, and transition regressions', () => {
  const liveHtml = fs.readFileSync(path.join(__dirname, '..', 'live.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  test('Clear uses a neutral raw background but preserves user text transitions', () => {
    expect(renderer).toContain('function createClearPresentation(content)');
    expect(renderer).toContain('styles: {}');
    expect(renderer).toContain('transitionIn: content.transitionIn || null');
    expect(renderer).toContain('transitionOut: content.transitionOut || null');
    expect(renderer).toContain('clearPresentation: true');
  });

  test('renderer always sends canonical styled content and serializes output mode separately', () => {
    expect(renderer).toContain("ipcRenderer.send('update-live-window', { ...payload, _outputMode: mode });");
    expect(renderer).toContain("ipcRenderer.send('set-live-mode', mode);");
    expect(liveHtml).toContain('if (data && data._outputMode) return;');
  });

  test('Clear never replaces the canonical styled presentation', () => {
    expect(liveHtml).toContain('function createLiveClearPresentation(content)');
    expect(liveHtml).toContain('if (renderContent_content && !renderContent_content.clearPresentation)');
    expect(liveHtml).toContain('if (data && !data.clearPresentation)');
    expect(liveHtml).toContain('delete canonical._outputMode;');
    expect(liveHtml).toContain('const clearPresentation = createLiveClearPresentation(window.currentContent);');
  });

  test('Clear text follows configured text transition rather than disappearing immediately', () => {
    expect(liveHtml).toContain('function transitionTextLayer(oldContent, newContent, options = {})');
    expect(liveHtml).toContain('const transitionOut = oldContent.transitionOut || oldContent.transitionIn');
    expect(liveHtml).toContain("applyTextFadeOutAnimation(oldContent, transitionOut.duration, transitionOut.type || 'fade', fadeInNew);");
  });

  test('background transitions are independent simple fades with styled snapshots', () => {
    expect(liveHtml).toContain('let textAnimationFrameId = null;');
    expect(liveHtml).toContain('let backgroundAnimationFrameId = null;');
    expect(liveHtml).toContain('async function applyBackgroundCrossfade(oldContent, newContent, duration = 0.4, callback = null)');
    expect(liveHtml).toContain('const bgBlur = (isClearPresentation || isStandaloneMedia) ? 0');
    expect(liveHtml).toContain('finishStyledBackground();');
  });

  test('blur and overlay changes count as a background visual change', () => {
    expect(liveHtml).toContain('const styleState = (content) => {');
    expect(liveHtml).toContain('return as.blur === bs.blur && as.overlay === bs.overlay;');
  });

  test('background changes crossfade only when an old live frame exists', () => {
    expect(liveHtml).toContain('if (!renderOptions.skipBackgroundTransition && oldContent && !backgroundsEqual(oldContent, renderContent_content)) {');
    expect(liveHtml).toContain('transitionTextLayer(oldContent, renderContent_content, renderOptions);');
    expect(liveHtml).toContain('applyBackgroundCrossfade(oldContent, renderContent_content, duration');
  });

  test('completed static transitions preserve their final frame instead of flashing black', () => {
    expect(liveHtml).toContain('if (oldContent && backgroundsEqual(oldContent, renderContent_content) &&');
    expect(liveHtml).toContain("!(renderOptions.skipBackgroundTransition && ['GIF','MP4','WEBM','OGG','MOV','AVI'].includes(getBgMediaType(renderContent_content))))");
    expect(liveHtml).toContain('// the real animation after the snapshot crossfade completes.');
    expect(liveHtml).toContain('window.previousContent = renderContent_content;');
  });

  test('making non-web media live exits clear or black mode first', () => {
    expect(renderer).toContain('const wasMasked = clearMode || blackMode;');
    expect(renderer).toContain("if (wasMasked) ipcRenderer.send('set-live-mode', 'normal');");
  });
});
