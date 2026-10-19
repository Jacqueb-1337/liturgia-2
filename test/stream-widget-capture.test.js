const fs = require('fs');
const path = require('path');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
describe('local OBS widget live/stream rendering', () => {
  const renderer = read('renderer.js');
  const search = read('searchBox.js');
  const receiver = read('network-receiver.html');
  const live = read('live.html');
  const bridge = read('lib/streamReceiverBridge.js');
  const main = read('main.js');
  test('hide control is not shown before a widget is actually live', () => {
    expect(search).toContain('ltBtn.hidden = true;');
    expect(renderer).toContain('widget.visible === true');
    expect(renderer).toContain("widgetBtn.textContent = 'Hide Widget'");
    expect(renderer).toContain("window.onToggleLowerThird = () => hideActiveObsWidget()");
  });
  test('hide operates on the active widget and does not auto-show remembered widget', () => {
    expect(renderer).toContain('if (!widget?.url || widget.visible !== true) return;');
    expect(renderer).toContain('obsWidgetVisible: false');
    expect(renderer).toContain("setObsWidgetCanvasPreview('live', null);");
    expect(renderer).toContain('window.__activeObsWidget = widgetState;');
  });
  test('pending hide timers cannot clear a newer widget in either display renderer', () => {
    for (const html of [receiver, live]) {
      expect(html).toContain('if (_widgetHideTimer !== null) { clearTimeout(_widgetHideTimer); _widgetHideTimer = null; }');
      expect(html).toContain('if (hideToken !== _widgetLoadToken) return;');
      expect(html).toContain('incoming.onload = () => {');
    }
  });
  test('network stream receiver loads bundled client-side HTML rasterizer', () => {
    expect(main).toContain("'/stream-widget-capture.js'");
    expect(main).toContain('vendor');
    expect(main).toContain('html2canvas.min.js');
    expect(main).toContain('<script src="/stream-widget-capture.js"></script><script src="/stream-receiver-bridge.js"></script>');
    expect(fs.existsSync(path.join(__dirname, '..', 'vendor', 'html2canvas.min.js'))).toBe(true);
  });
  test('program frames include alpha-preserved widget over text at independent 10fps snapshots', () => {
    expect(bridge).toContain('window.html2canvas(documentElement');
    expect(bridge).toContain('paintWidget(context);');
    expect(bridge).toContain('context.drawImage(textCanvas, 0, 0);');
    expect(bridge.indexOf('paintWidget(context);')).toBeGreaterThan(bridge.indexOf('context.drawImage(textCanvas, 0, 0);'));
    expect(bridge).toContain('now - widgetCaptureTimestamp < 100');
    expect(bridge).toContain("backgroundColor: null");
    expect(bridge).toContain('window.parent.postMessage({ type: \'liturgia-stream-frame\', layerId, frame }');
  });
});
