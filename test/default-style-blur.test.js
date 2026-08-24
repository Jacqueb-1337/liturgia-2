const fs = require('fs');
const path = require('path');

describe('default song and verse background blur', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const styleWindow = fs.readFileSync(path.join(__dirname, '..', 'style-window.html'), 'utf8');

  test('fresh installs start with the maximum 20px global background blur', () => {
    expect(styleWindow).toContain('id="ts-global-blur" min="0" max="20"');
    expect(main).toContain("if (e && e.code === 'ENOENT') {");
    expect(main).toContain("'bg-blur: 20'");
    expect(main).toContain("global: Buffer.from(freshGlobalStyle, 'utf8').toString('base64')");
  });

  test('existing saved styles keep the legacy zero-blur fallback', () => {
    expect(renderer).toContain('const def = { overlayOpacity: 0.4, bgBlur: 0, lineHeight: 1.2');
    expect(renderer).toContain('bgBlur:           getN(/bg-blur\\s*:\\s*([\\d.]+)/i, 0)');
    expect(styleWindow).toContain('const def = { overlayOpacity: 0.4, bgBlur: 0, lineHeight: 1.2');
    expect(styleWindow).toContain('bgBlur:           getN(/bg-blur\\s*:\\s*([\\d.]+)/i, 0)');
  });

  test('resetting global presentation style uses the new 20px default', () => {
    expect(styleWindow).toContain("global:         { overlayOpacity: 0.4, bgBlur: 20, lineHeight: 1.2");
  });
});
