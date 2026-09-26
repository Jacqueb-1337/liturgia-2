// Loaded by the existing Worship network receiver only for Liturgia Stream sources.
// The receiver owns the presentation state and media. Stream receives a transferable
// frame with alpha preserved, while per-source CSS stays local to this receiver.
(() => {
  const query = new URLSearchParams(location.search);
  const layerId = query.get('layer') || '';
  if (!layerId || window.parent === window) return;

  const FRAME_INTERVAL = 1000 / 30;
  const composite = document.createElement('canvas');
  composite.width = bgCanvas.width;
  composite.height = bgCanvas.height;
  const context = composite.getContext('2d', { alpha: true });
  let overrides = {};
  let pending = false;
  let lastFrame = 0;

  function parseText(css) {
    const get = (re) => css.match(re)?.[1]?.trim();
    const number = (re) => Number.parseFloat(get(re) || '0') || 0;
    const parsed = {};
    if (get(/(?:^|;)\s*color\s*:\s*([^;]+)/i)) parsed.color = get(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    if (get(/font-size\s*:\s*([\d.]+)em/i)) parsed.sizeMultiplier = Number.parseFloat(get(/font-size\s*:\s*([\d.]+)em/i));
    else if (get(/font-size\s*:\s*([\d.]+)px/i)) parsed.sizeMultiplier = Number.parseFloat(get(/font-size\s*:\s*([\d.]+)px/i)) / 86.4;
    if (get(/font-family\s*:\s*([^;]+)/i)) parsed.fontFamily = get(/font-family\s*:\s*([^;]+)/i);
    if (get(/font-weight\s*:\s*(bold)/i)) parsed.fontWeight = 'bold';
    if (get(/font-style\s*:\s*(italic)/i)) parsed.fontStyle = 'italic';
    if (get(/text-align\s*:\s*(left|center|right)/i)) parsed.textAlign = get(/text-align\s*:\s*(left|center|right)/i);
    for (const [name, regex] of Object.entries({
      letterSpacing: /letter-spacing\s*:\s*([\d.]+)/i,
      shadowBlur: /shadow-blur\s*:\s*([\d.]+)/i,
      shadowX: /shadow-x\s*:\s*(-?[\d.]+)/i,
      shadowY: /shadow-y\s*:\s*(-?[\d.]+)/i,
      strokeWidth: /stroke-width\s*:\s*([\d.]+)/i
    })) if (get(regex) !== undefined) parsed[name] = number(regex);
    for (const [name, regex] of Object.entries({
      shadowColor: /shadow-color\s*:\s*([^;]+)/i,
      strokeColor: /stroke-color\s*:\s*([^;]+)/i
    })) if (get(regex)) parsed[name] = get(regex);
    return parsed;
  }

  function parseGlobal(css) {
    const value = (name) => css.match(new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'i'))?.[1]?.trim();
    const parsed = {};
    for (const [name, property] of Object.entries({
      'overlay-opacity': 'overlayOpacity', 'bg-blur': 'bgBlur', 'line-height': 'lineHeight'
    })) if (value(name) !== undefined && Number.isFinite(Number(value(name)))) parsed[property] = Number(value(name));
    if (value('vertical-position')) parsed.verticalPosition = value('vertical-position');
    if (value('song-inline') !== undefined) parsed.songInline = value('song-inline') === '1';
    const safe = { ...(currentContent?.styles?.global?.safeArea || { x: .04, y: .04, w: .92, h: .92 }) };
    for (const [name, key] of Object.entries({
      'safe-area-x': 'x', 'safe-area-y': 'y', 'safe-area-w': 'w', 'safe-area-h': 'h'
    })) if (value(name) !== undefined && Number.isFinite(Number(value(name)))) safe[key] = Number(value(name));
    parsed.safeArea = safe;
    return parsed;
  }

  const originalRender = renderContent;
  renderContent = (content) => {
    if (!content || !Object.keys(overrides).length) return originalRender(content);
    const styles = { ...(content.styles || {}) };
    const isSong = content.type === 'song';
    const mapping = isSong ? {
      songText: 'text', songTitle: 'title', songReference: 'reference', verseSubscript: 'subscript'
    } : {
      verseText: 'text', verseNumber: 'number', verseReference: 'reference', verseSubscript: 'subscript'
    };
    for (const [key, target] of Object.entries(mapping)) {
      if (overrides[key]) styles[target] = { ...styles[target], ...parseText(overrides[key]) };
    }
    if (overrides.global) styles.global = { ...styles.global, ...parseGlobal(overrides.global) };
    return originalRender({ ...content, styles });
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'liturgia-stream-styles' ||
        event.data.layerId !== layerId) return;
    overrides = event.data.styles && typeof event.data.styles === 'object' ? event.data.styles : {};
    if (lastContentPayload && !isBlack && !isClear) renderContent(lastContentPayload);
  });
  window.parent.postMessage({ type: 'liturgia-stream-ready', layerId }, '*');

  async function sendFrame() {
    if (pending || document.visibilityState === 'hidden' || !bgCanvas.width || !bgCanvas.height) return;
    pending = true;
    try {
      if (composite.width !== bgCanvas.width || composite.height !== bgCanvas.height) {
        composite.width = bgCanvas.width;
        composite.height = bgCanvas.height;
      }
      context.clearRect(0, 0, composite.width, composite.height);
      if (gifBg.style.display !== 'none' && gifBg.complete && !transparentMode) {
        try { context.drawImage(gifBg, 0, 0, composite.width, composite.height); } catch (_) {}
      }
      context.drawImage(bgCanvas, 0, 0);
      context.drawImage(textCanvas, 0, 0);
      if (mirrorImg.style.display !== 'none' && mirrorImg.complete && !transparentMode) {
        context.drawImage(mirrorImg, 0, 0, composite.width, composite.height);
      }
      const frame = await createImageBitmap(composite);
      window.parent.postMessage({ type: 'liturgia-stream-frame', layerId, frame }, '*', [frame]);
    } catch (error) {
      window.parent.postMessage({ type: 'liturgia-stream-error', layerId, message: error.message }, '*');
    } finally {
      pending = false;
    }
  }

  function tick(now) {
    if (now - lastFrame >= FRAME_INTERVAL) {
      lastFrame = now;
      void sendFrame();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
