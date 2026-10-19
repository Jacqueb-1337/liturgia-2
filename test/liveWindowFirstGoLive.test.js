const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

describe('first Go Live before output window creation', () => {
  test('retains the latest payload even when no live window exists yet', () => {
    expect(main).toMatch(/let latestLivePresentation = null/);
    expect(main).toMatch(/ipcMain\.on\('update-live-window',[\s\S]*?latestLivePresentation = data/);
  });

  test('hydrates newly created output with per-display routed presentation', () => {
    const create = main.slice(main.indexOf('function createLiveWindowForDisplay'), main.indexOf("ipcMain.on('live-window-ready'"));
    expect(create).toMatch(/win\._livePending = latestLivePresentation/);
    expect(create).toMatch(/routeWidgetForDisplay\(latestLivePresentation/);
  });

  test('replays buffered presentation and latest output mode after renderer readiness', () => {
    const ready = main.slice(main.indexOf("ipcMain.on('live-window-ready'"), main.indexOf("ipcMain.handle('create-live-window'"));
    expect(ready).toMatch(/win\.webContents\.send\('update-content', win\._livePending\)/);
    expect(ready).toMatch(/win\.webContents\.send\('set-live-mode', latestLiveMode\)/);
    expect(main).toMatch(/ipcMain\.on\('set-live-mode',[\s\S]*?latestLiveMode = mode/);
  });
});
