const fs = require('fs');
const path = require('path');

describe('live website mirror contract', () => {
  const liveHtml = fs.readFileSync(path.join(__dirname, '..', 'live.html'), 'utf8');
  const rendererJs = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const networkHtml = fs.readFileSync(path.join(__dirname, '..', 'network-receiver.html'), 'utf8');

  test('keeps the mirror surface and IPC receiver wired', () => {
    expect(liveHtml).toContain('id="live-mirror-img"');
    expect(liveHtml).toContain("ipcRenderer.on('mirror-frame'");
    expect(liveHtml).toContain("ipcRenderer.on('website-mirror-stop'");
  });

  test('enables ordinary websites without treating widgets as mirror content', () => {
    expect(liveHtml).toMatch(/if \(data\.obsWidgetUrl \|\| data\.obsWidgetPath\)[\s\S]*?_mirrorEnabled = false;/);
    expect(liveHtml).toMatch(/else \{[\s\S]*?_mirrorEnabled = true;[\s\S]*?_fadeMirrorIn\(fadeDuration\);/);
  });

  test('captures website output at 24 FPS and crops video without mutating the preview page', () => {
    expect(rendererJs).toContain('const WEBSITE_MIRROR_FPS = 24;');
    expect(rendererJs).toContain('await wv.capturePage(crop)');
    expect(rendererJs).not.toContain("'_liturgia_vid_overlay'");
  });

  test('relays binary website frames to custom network displays', () => {
    expect(mainJs).toContain('broadcastMirrorFrameToDisplayClients(ns, jpegBuffer)');
    expect(mainJs).toContain('encodeWsFrame(Buffer.from(jpegBuffer), 0x2)');
    expect(networkHtml).toContain('id="mirror-img"');
    expect(networkHtml).toContain("ws.binaryType = 'arraybuffer'");
    expect(networkHtml).toContain("msg.type === 'mirror-stop'");
  });
});
