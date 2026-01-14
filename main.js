// main.js

const { app, BrowserWindow, ipcMain, Menu, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { BOOKS, CHAPTER_COUNTS, BIBLE_STORAGE_DIR } = require('./constants');

let mainWindow; // Add this at the top
let defaultBible = 'en_kjv.json'; // Default Bible
let liveWindow = null;

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('load-settings', async () => {
  try {
    const data = await fs.promises.readFile(settingsPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
});

ipcMain.handle('save-settings', async (event, settings) => {
  await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return true;
});

ipcMain.on('set-default-bible', (event, bible) => {
  defaultBible = bible;
  // Reply back to the sender
  event.reply('default-bible-changed', bible);
  // Also notify the main window so it can reload verses
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('default-bible-changed', bible);
  }

  // Persist chosen bible into settings.json
  (async () => {
    try {
      let settings = {};
      try {
        const txt = await fs.promises.readFile(settingsPath, 'utf8');
        settings = JSON.parse(txt);
      } catch (e) {
        settings = {};
      }
      settings.defaultBible = bible;
      await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save default bible to settings:', err);
    }
  })();
});

ipcMain.handle('get-default-bible', () => defaultBible);

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false   // allow require() in renderer
    }
  });

  mainWindow.loadFile('index.html');
  
  // Close live window when main window closes
  mainWindow.on('closed', () => {
    if (liveWindow) {
      liveWindow.close();
      liveWindow = null;
    }
    mainWindow = null;
  });

  // Define the menu template
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings',
          click: () => {
            const settingsWin = new BrowserWindow({
              width: 600,
              height: 400,
              parent: mainWindow,
              modal: true,
              webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
              }
            });
            settingsWin.setMenuBarVisibility(false);
            settingsWin.loadFile('settings.html');
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forcereload' },
        { type: 'separator' },
        { role: 'toggledevtools' }
      ]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://electronjs.org')
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Listen for dark theme changes from settings window
ipcMain.on('set-dark-theme', (event, enabled) => {
  if (mainWindow) {
    mainWindow.webContents.send('set-dark-theme', enabled);
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Expose userData path to renderer
ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

async function loadAllVersesFromDiskMain(baseDir) {
  const allVerses = [];
  const readPromises = [];

  for (const book of BOOKS) {
    const chapCount = CHAPTER_COUNTS[book];
    for (let chap = 1; chap <= chapCount; chap++) {
      const file = path.join(baseDir, 'books', book, 'chapters', `${chap}.json`);
      // Push a promise for each file read
      readPromises.push(
        fs.promises.readFile(file, 'utf8')
          .then(txt => {
            JSON.parse(txt).data.forEach(v => {
              allVerses.push({
                key:  `${v.book} ${v.chapter}:${v.verse}`,
                text: v.text
              });
            });
          })
          .catch(() => { /* File missing, skip */ })
      );
    }
  }

  await Promise.all(readPromises);
  return allVerses;
}

ipcMain.handle('load-all-verses', async (event, baseDir) => {
  return await loadAllVersesFromDiskMain(baseDir);
});

ipcMain.handle('create-live-window', async () => {
  if (liveWindow) {
    liveWindow.showInactive();
    return;
  }
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let settings = {};
  try {
    const data = await fs.promises.readFile(settingsPath, 'utf8');
    settings = JSON.parse(data);
  } catch {}
  const displays = screen.getAllDisplays();
  const defaultDisplayId = settings.defaultDisplay || (displays[0] ? displays[0].id : null);
  const display = displays.find(d => d.id == defaultDisplayId) || displays[0];
  if (display) {
    liveWindow = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      fullscreen: true,
      frame: false,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    liveWindow.loadFile('live.html');
    liveWindow.once('ready-to-show', () => {
      liveWindow.showInactive();
    });
    liveWindow.on('closed', () => {
      liveWindow = null;
    });
  }
});

ipcMain.handle('close-live-window', () => {
  if (liveWindow) {
    liveWindow.minimize();
  }
});

ipcMain.on('update-live-window', (event, data) => {
  if (liveWindow) {
    liveWindow.webContents.send('update-content', data);
  }
});

ipcMain.on('clear-live-text', () => {
  if (liveWindow) liveWindow.webContents.send('clear-live-text');
});

ipcMain.on('show-live-text', () => {
  if (liveWindow) liveWindow.webContents.send('show-live-text');
});

ipcMain.on('set-live-black', () => {
  if (liveWindow) liveWindow.webContents.send('set-live-black');
});

ipcMain.on('reset-live-canvas', () => {
  if (liveWindow) liveWindow.webContents.send('reset-live-canvas');
});
