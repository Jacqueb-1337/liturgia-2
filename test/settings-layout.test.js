const fs = require('fs');
const path = require('path');

describe('Settings window layout', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

  test('gives both settings panes flex shrink boundaries and independent scrolling', () => {
    expect(html).toContain('.settings-container { display: flex; width: 100vw; max-width: 100%; height: 100vh; height: 100dvh; min-width: 0; min-height: 0; overflow: hidden; }');
    expect(html).toContain('.sidebar { flex: 0 0 176px; min-width: 0; min-height: 0; height: 100%; overflow-y: auto;');
    expect(html).toContain('.settings-content { flex: 1 1 0; min-width: 0; min-height: 0;');
  });

  test('keeps the Browser Remote panel responsive inside the right pane', () => {
    expect(html).toContain('.settings-panel { width: 100%; max-width: 100%; min-width: 0; overflow-wrap: anywhere; }');
    expect(html).toContain('.remote-qr-wrap { display: flex; align-items: center; gap: 14px; margin: 10px 0; padding: 10px; min-width: 0; overflow: hidden;');
    expect(html).toContain('@media (max-width: 560px)');
    expect(html).toContain('.permission-grid { grid-template-columns: minmax(0, 1fr); }');
  });
});
