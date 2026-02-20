const { app, BrowserWindow, session, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 3210;
const ROOT = path.resolve(__dirname, '..');
const SIDECAR_PORT = 8765;
const ALLOWED_MODEL_SIZES = new Set(['small', 'medium', 'large']);
const MODEL_DIR_BY_SIZE = {
  small: 'vosk-model-small-en-us-0.15',
  medium: 'vosk-model-en-us-0.22',
  large: 'vosk-model-en-us-0.42-gigaspeech',
};

function normalizeModelSize(value) {
  const next = String(value || '').trim().toLowerCase();
  return ALLOWED_MODEL_SIZES.has(next) ? next : 'small';
}

function getModelDownloadDir(modelSize) {
  const normalized = normalizeModelSize(modelSize);
  const modelDirName = MODEL_DIR_BY_SIZE[normalized] || MODEL_DIR_BY_SIZE.small;
  return path.join(ROOT, 'backend', 'models', modelDirName);
}

function getModelDownloadParentDir() {
  return path.join(ROOT, 'backend', 'models');
}

let sidecarProcess = null;
let sidecarWatchdog = null;
let mainWindow = null;
let expectedSidecarExitPid = null;
let appIsQuitting = false;
let sidecarRestartTimer = null;
const sidecarState = {
  processRunning: false,
  managedProcess: false,
  portOpen: false,
  modelReady: false,
  downloadProgress: null,
  downloadBytes: 0,
  downloadTotalBytes: 0,
  statusMessage: 'sidecar-not-started',
  lastError: '',
  runtimeCommand: '',
  modelSize: normalizeModelSize(process.env.VOSK_MODEL_SIZE || 'small'),
  modelDownloadDir: getModelDownloadDir(process.env.VOSK_MODEL_SIZE || 'small'),
  lastStartAt: 0,
  restarting: false,
};

function emitSidecarStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('sidecar:status', {
    ...sidecarState,
    sidecarWsUrl: `ws://${HOST}:${SIDECAR_PORT}/transcribe`,
  });
}

function updateSidecarStatus(patch) {
  Object.assign(sidecarState, patch);
  if (!sidecarState.modelDownloadDir) {
    sidecarState.modelDownloadDir = getModelDownloadDir(sidecarState.modelSize);
  }
  emitSidecarStatus();
}

function parseSidecarLogLine(line) {
  const lower = String(line || '').toLowerCase();
  if (!lower) return;

  const totalMatch = lower.match(/downloading-vosk-model-total[^\n]*bytes=(\d+)/);
  if (totalMatch) {
    const downloadTotalBytes = Math.max(0, Number(totalMatch[1]));
    updateSidecarStatus({
      modelReady: false,
      statusMessage: 'downloading-vosk-model',
      downloadTotalBytes,
      lastError: '',
    });
    return;
  }

  const progressMatch = lower.match(/downloading-vosk-model-progress[^\n]*percent=(\d{1,3})(?:[^\n]*bytes=(\d+))?(?:[^\n]*total=(\d+))?/);
  if (progressMatch) {
    const progress = Math.max(0, Math.min(100, Number(progressMatch[1])));
    const parsedBytes = progressMatch[2] ? Math.max(0, Number(progressMatch[2])) : 0;
    const parsedTotal = progressMatch[3] ? Math.max(0, Number(progressMatch[3])) : 0;
    const effectiveTotal = parsedTotal || sidecarState.downloadTotalBytes || 0;
    const inferredBytes = effectiveTotal > 0
      ? Math.round((progress / 100) * effectiveTotal)
      : sidecarState.downloadBytes;
    updateSidecarStatus({
      modelReady: false,
      statusMessage: 'downloading-vosk-model',
      downloadProgress: progress,
      downloadBytes: Math.max(sidecarState.downloadBytes || 0, parsedBytes || 0, inferredBytes || 0),
      downloadTotalBytes: effectiveTotal,
      lastError: '',
    });
    return;
  }

  const bytesMatch = lower.match(/downloading-vosk-model-bytes[^\n]*bytes=(\d+)/);
  if (bytesMatch) {
    const downloadBytes = Math.max(0, Number(bytesMatch[1]));
    updateSidecarStatus({
      modelReady: false,
      statusMessage: 'downloading-vosk-model',
      downloadProgress: null,
      downloadBytes,
      downloadTotalBytes: sidecarState.downloadTotalBytes || 0,
      lastError: '',
    });
    return;
  }

  if (lower.includes('vosk model loaded') || lower.includes('model-ready')) {
    updateSidecarStatus({
      modelReady: true,
      statusMessage: 'model-ready',
      downloadProgress: null,
      downloadBytes: 0,
      downloadTotalBytes: 0,
      lastError: '',
    });
    return;
  }

  if (lower.includes('loading-vosk-model') || lower.includes('initializing sidecar')) {
    updateSidecarStatus({ modelReady: false, statusMessage: 'loading-vosk-model', downloadProgress: null, downloadBytes: 0, downloadTotalBytes: 0 });
    return;
  }

  if (lower.includes('downloading-vosk-model')) {
    updateSidecarStatus({
      modelReady: false,
      statusMessage: 'downloading-vosk-model',
      downloadProgress: sidecarState.downloadProgress ?? 0,
      downloadBytes: sidecarState.downloadBytes ?? 0,
      downloadTotalBytes: sidecarState.downloadTotalBytes ?? 0,
    });
    return;
  }

  if (lower.includes('vosk preload failed') || lower.includes('model-load-failed')) {
    updateSidecarStatus({ modelReady: false, statusMessage: 'model-error', downloadProgress: null, downloadBytes: 0, downloadTotalBytes: 0, lastError: line });
  }
}

function scheduleUnexpectedSidecarRestart() {
  if (appIsQuitting) return;
  if (sidecarRestartTimer) return;
  sidecarRestartTimer = setTimeout(() => {
    sidecarRestartTimer = null;
    if (appIsQuitting) return;
    if (sidecarProcess) return;
    startTranscriptionSidecar();
  }, 1200);
}

function checkPortOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const url = `ws://${host}:${port}/transcribe`;
    let done = false;
    let timer = null;
    let ws = null;

    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        if (timer) clearTimeout(timer);
        if (ws && (ws.readyState === ws.CONNECTING || ws.readyState === ws.OPEN)) {
          ws.close();
        }
      } catch (_) {
      }
      resolve(value);
    };

    if (typeof WebSocket !== 'function') {
      finish(!!sidecarProcess);
      return;
    }

    try {
      ws = new WebSocket(url);
    } catch (_) {
      finish(false);
      return;
    }

    timer = setTimeout(() => finish(false), timeoutMs);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
  });
}

async function getSidecarStatus() {
  const portOpen = await checkPortOpen(HOST, SIDECAR_PORT, 1500);
  updateSidecarStatus({ portOpen });
  return {
    ...sidecarState,
    sidecarWsUrl: `ws://${HOST}:${SIDECAR_PORT}/transcribe`,
  };
}

function startTranscriptionSidecar() {
  if (sidecarProcess) {
    updateSidecarStatus({ processRunning: true, statusMessage: sidecarState.statusMessage || 'running' });
    return true;
  }

  const scriptPath = path.join(ROOT, 'backend', 'server.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn('Transcription sidecar script not found:', scriptPath);
    updateSidecarStatus({
      processRunning: false,
      managedProcess: false,
      modelReady: false,
      statusMessage: 'sidecar-script-missing',
      lastError: `Missing script: ${scriptPath}`,
    });
    return false;
  }

  const venvPython = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  const candidates = [
    { cmd: fs.existsSync(venvPython) ? venvPython : '', args: [] },
    { cmd: 'python', args: [] },
    { cmd: 'py', args: ['-3'] },
  ].filter((entry) => !!entry.cmd);

  for (const candidate of candidates) {
    try {
      const child = spawn(candidate.cmd, [...candidate.args, scriptPath, '--host', HOST, '--port', String(SIDECAR_PORT)], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, VOSK_MODEL_SIZE: sidecarState.modelSize },
      });

      child.stdout.on('data', (buf) => {
        const text = buf.toString();
        const lines = text.split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          console.log(`[sidecar:${child.pid}] ${line}`);
          parseSidecarLogLine(line);
        }
      });
      child.stderr.on('data', (buf) => {
        const text = buf.toString();
        const lines = text.split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          console.error(`[sidecar:${child.pid}] ${line}`);
          parseSidecarLogLine(line);
        }
      });

      child.on('exit', (code, signal) => {
        const expectedExit = expectedSidecarExitPid === child.pid;
        if (expectedExit) expectedSidecarExitPid = null;
        console.warn(`[sidecar:${child.pid}] exited with code ${code} signal ${signal || 'none'} expected=${expectedExit}`);
        if (sidecarProcess === child) {
          sidecarProcess = null;
          updateSidecarStatus({
            processRunning: false,
            managedProcess: false,
            portOpen: false,
            modelReady: false,
            downloadProgress: null,
            downloadBytes: 0,
            downloadTotalBytes: 0,
            statusMessage: 'sidecar-exited',
            lastError: expectedExit ? '' : `sidecar-exited code=${code} signal=${signal || 'none'}`,
            restarting: false,
          });

          if (!expectedExit) {
            scheduleUnexpectedSidecarRestart();
          }
        }
      });

      sidecarProcess = child;
      updateSidecarStatus({
        processRunning: true,
        managedProcess: true,
        portOpen: false,
        modelReady: false,
        downloadProgress: null,
        downloadBytes: 0,
        downloadTotalBytes: 0,
        modelDownloadDir: getModelDownloadDir(sidecarState.modelSize),
        statusMessage: 'loading-vosk-model',
        lastError: '',
        runtimeCommand: candidate.cmd,
        lastStartAt: Date.now(),
        restarting: false,
      });
      console.log(`[sidecar:${child.pid}] started with ${candidate.cmd}`);
      return true;
    } catch (err) {
      console.warn(`[sidecar] failed with ${candidate.cmd}:`, err.message);
    }
  }

  console.error('[sidecar] could not start python sidecar. Ensure Python and backend dependencies are installed.');
  updateSidecarStatus({
    processRunning: false,
    managedProcess: false,
    portOpen: false,
    modelReady: false,
    statusMessage: 'sidecar-start-failed',
    lastError: 'Could not spawn Python sidecar',
    restarting: false,
  });
  return false;
}

function stopTranscriptionSidecar() {
  if (!sidecarProcess) return;
  expectedSidecarExitPid = sidecarProcess.pid;
  try {
    sidecarProcess.kill();
  } catch (_) {
  }
  sidecarProcess = null;
  updateSidecarStatus({
    processRunning: false,
    managedProcess: false,
    portOpen: false,
    modelReady: false,
    downloadProgress: null,
    downloadBytes: 0,
    downloadTotalBytes: 0,
    statusMessage: 'sidecar-stopped',
    restarting: false,
  });
}

async function ensureSidecarRunning() {
  const portOpen = await checkPortOpen(HOST, SIDECAR_PORT);
  if (portOpen) {
    updateSidecarStatus({
      portOpen: true,
      processRunning: sidecarProcess ? true : sidecarState.processRunning,
      statusMessage: sidecarState.modelReady ? 'model-ready' : (sidecarState.statusMessage || 'sidecar-running'),
    });
    return true;
  }
  updateSidecarStatus({ portOpen: false, modelReady: false });
  return startTranscriptionSidecar();
}

async function restartTranscriptionSidecar() {
  updateSidecarStatus({
    restarting: true,
    modelReady: false,
    downloadProgress: null,
    downloadBytes: 0,
    downloadTotalBytes: 0,
    statusMessage: 'restarting-sidecar',
    lastError: '',
  });
  stopTranscriptionSidecar();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const started = startTranscriptionSidecar();
  if (!started) {
    updateSidecarStatus({ restarting: false, statusMessage: 'sidecar-restart-failed' });
    return false;
  }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const portOpen = await checkPortOpen(HOST, SIDECAR_PORT, 1500);
    if (portOpen) {
      updateSidecarStatus({ portOpen: true, restarting: false, statusMessage: 'sidecar-running' });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  updateSidecarStatus({ portOpen: false, restarting: false, statusMessage: 'sidecar-restart-timeout' });
  return false;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

function safeJoin(base, target) {
  const normalized = path.normalize(target).replace(/^([\\/])+/, '');
  const candidate = path.join(base, normalized);
  if (!candidate.startsWith(base)) return null;
  return candidate;
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requested = req.url && req.url !== '/' ? decodeURIComponent(req.url.split('?')[0]) : '/index.html';
      const filePath = safeJoin(ROOT, requested);

      if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Resource-Policy': 'cross-origin',
          });
          res.end('Not found');
          return;
        }

        res.writeHead(200, {
          'Content-Type': contentType(filePath),
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        res.end(data);
      });
    });

    server.on('error', reject);
    server.listen(PORT, HOST, () => resolve(server));
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Speech Desktop Demo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(`http://${HOST}:${PORT}/index.html`);
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

async function bootstrap() {
  await app.whenReady();
  await ensureSidecarRunning();

  sidecarWatchdog = setInterval(() => {
    ensureSidecarRunning().catch((err) => {
      updateSidecarStatus({ statusMessage: 'sidecar-watchdog-error', lastError: String(err?.message || err || 'unknown') });
    });
  }, 5000);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
      return;
    }
    callback(false);
  });

  await startStaticServer();
  createWindow();

  ipcMain.handle('sidecar:get-status', async () => getSidecarStatus());
  ipcMain.handle('sidecar:restart', async () => {
    const ok = await restartTranscriptionSidecar();
    return {
      ok,
      status: await getSidecarStatus(),
    };
  });

  ipcMain.handle('sidecar:set-model-size', async (_event, requestedSize) => {
    const nextSize = normalizeModelSize(requestedSize);
    updateSidecarStatus({
      modelSize: nextSize,
      modelDownloadDir: getModelDownloadDir(nextSize),
      downloadProgress: null,
      downloadBytes: 0,
      downloadTotalBytes: 0,
    });
    return {
      ok: true,
      modelSize: nextSize,
      status: await getSidecarStatus(),
    };
  });

  ipcMain.handle('sidecar:open-model-folder', async () => {
    const modelDir = sidecarState.modelDownloadDir || getModelDownloadDir(sidecarState.modelSize);
    const modelsParent = getModelDownloadParentDir();
    const targetDir = fs.existsSync(modelDir) ? modelDir : modelsParent;

    try {
      fs.mkdirSync(targetDir, { recursive: true });
      const result = await shell.openPath(targetDir);
      if (result) {
        return { ok: false, error: result, path: targetDir };
      }
      return { ok: true, path: targetDir };
    } catch (err) {
      return { ok: false, error: String(err?.message || err || 'failed to open folder'), path: targetDir };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start desktop app:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  appIsQuitting = true;
  if (sidecarWatchdog) {
    clearInterval(sidecarWatchdog);
    sidecarWatchdog = null;
  }
  if (sidecarRestartTimer) {
    clearTimeout(sidecarRestartTimer);
    sidecarRestartTimer = null;
  }
  stopTranscriptionSidecar();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  appIsQuitting = true;
  if (sidecarWatchdog) {
    clearInterval(sidecarWatchdog);
    sidecarWatchdog = null;
  }
  if (sidecarRestartTimer) {
    clearTimeout(sidecarRestartTimer);
    sidecarRestartTimer = null;
  }
  stopTranscriptionSidecar();
});
