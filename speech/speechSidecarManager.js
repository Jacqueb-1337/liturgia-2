const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const WebSocket = require('ws');

const HOST = '127.0.0.1';
const PORT = 8765;
const ALLOWED_MODEL_SIZES = new Set(['small', 'medium', 'large']);
const MODEL_DIR_BY_SIZE = {
  small: 'vosk-model-small-en-us-0.15',
  medium: 'vosk-model-en-us-0.22',
  large: 'vosk-model-en-us-0.42-gigaspeech'
};

function normalizeModelSize(value) {
  const next = String(value || '').trim().toLowerCase();
  return ALLOWED_MODEL_SIZES.has(next) ? next : 'small';
}

function getModelDir(rootDir, size) {
  const modelDirName = MODEL_DIR_BY_SIZE[normalizeModelSize(size)] || MODEL_DIR_BY_SIZE.small;
  return path.join(rootDir, 'backend', 'models', modelDirName);
}

function resolvePythonCandidates(rootDir) {
  const candidates = [];
  const isWindows = process.platform === 'win32';
  
  // Check local venv first
  const winVenv = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  const posixVenv = path.join(rootDir, '.venv', 'bin', 'python');
  if (isWindows && fs.existsSync(winVenv)) candidates.push({ cmd: winVenv, args: [] });
  if (!isWindows && fs.existsSync(posixVenv)) candidates.push({ cmd: posixVenv, args: [] });
  
  // Fall back to system Python
  candidates.push({ cmd: 'python', args: [] });
  candidates.push({ cmd: 'python3', args: [] });
  if (isWindows) {
    candidates.push({ cmd: 'py', args: ['-3'] });
  }
  
  return candidates;
}

function safeTerminate(ws) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    else if (ws && ws.readyState === WebSocket.CONNECTING) ws.terminate();
  } catch (err) {
    console.warn('[speech-sidecar] ws cleanup failed', err.message || err);
  }
}

function execSync(cmd, args = [], options = {}) {
  const { execSync: nodeExecSync } = require('child_process');
  const cmdLine = [cmd, ...args].map(arg => {
    // Properly quote arguments on Windows if they contain spaces
    if (process.platform === 'win32' && arg.includes(' ')) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    return arg;
  }).join(' ');
  return nodeExecSync(cmdLine, { encoding: 'utf8', ...options }).trim();
}

async function checkAndInstallDependencies(pythonCmd) {
  try {
    // Check if required packages are installed
    const requiredPackages = ['vosk', 'websockets', 'numpy'];
    const missingPackages = [];
    
    for (const pkg of requiredPackages) {
      try {
        const { execSync: nodeExecSync } = require('child_process');
        nodeExecSync(`"${pythonCmd}" -m pip show ${pkg}`, { encoding: 'utf8', stdio: 'pipe' });
      } catch {
        missingPackages.push(pkg);
      }
    }
    
    if (missingPackages.length === 0) {
      console.log('[speech-sidecar] all dependencies already installed');
      return { success: true, message: 'All dependencies installed' };
    }
    
    console.log(`[speech-sidecar] installing missing packages: ${missingPackages.join(', ')}`);
    
    // Install missing packages - properly handle all platforms
    const { execSync: nodeExecSync } = require('child_process');
    const pkgList = missingPackages.join(' ');
    nodeExecSync(`"${pythonCmd}" -m pip install ${pkgList}`, { 
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
    });
    
    console.log('[speech-sidecar] dependency installation completed');
    return { success: true, message: `Installed: ${missingPackages.join(', ')}` };
  } catch (err) {
    const errorMsg = err.message || String(err);
    console.error('[speech-sidecar] dependency installation failed:', errorMsg);
    return { 
      success: false, 
      message: `Failed to install dependencies: ${errorMsg}. Please install manually: python -m pip install vosk websockets numpy` 
    };
  }
}

class SpeechSidecarManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || HOST;
    this.port = options.port || PORT;
    this.rootDir = options.rootDir || path.resolve(__dirname);
    this.modelSize = normalizeModelSize(options.modelSize || 'small');
    this.sidecarProcess = null;
    this.expectedExitPid = null;
    this.restartTimer = null;
    this.appQuitting = false;

    this.state = {
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
      modelSize: this.modelSize,
      modelDownloadDir: getModelDir(this.rootDir, this.modelSize),
      restarting: false,
      lastStartAt: 0
    };
  }

  getStatus() {
    return {
      ...this.state,
      modelSize: this.modelSize,
      modelDownloadDir: getModelDir(this.rootDir, this.modelSize),
      sidecarWsUrl: `ws://${this.host}:${this.port}/transcribe`
    };
  }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    if (!this.state.modelDownloadDir) {
      this.state.modelDownloadDir = getModelDir(this.rootDir, this.modelSize);
    }
    this.emit('status', this.getStatus());
  }

  async checkPortOpen(timeoutMs = 1500) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (value) => {
        if (resolved) return;
        resolved = true;
        try { safeTerminate(ws); } catch (_) {}
        resolve(value);
      };

      const ws = new WebSocket(`ws://${this.host}:${this.port}/transcribe`, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(() => done(false), timeoutMs);

      ws.once('open', () => {
        clearTimeout(timer);
        done(true);
      });

      ws.once('error', () => {
        clearTimeout(timer);
        done(false);
      });
    });
  }

  scheduleUnexpectedRestart() {
    if (this.appQuitting || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.appQuitting || this.sidecarProcess) return;
      this.startProcess();
    }, 1500);
  }

  parseSidecarLogLine(line) {
    const lower = String(line || '').toLowerCase();
    if (!lower) return;

    const totalMatch = lower.match(/downloading-vosk-model-total[^\r\n]*bytes=(\d+)/);
    if (totalMatch) {
      const downloadTotalBytes = Math.max(0, Number(totalMatch[1]));
      this.updateState({
        modelReady: false,
        statusMessage: 'downloading-vosk-model',
        downloadTotalBytes,
        lastError: ''
      });
      return;
    }

    const progressMatch = lower.match(/downloading-vosk-model-progress[^\r\n]*percent=(\d{1,3})(?:[^\r\n]*bytes=(\d+))?(?:[^\r\n]*total=(\d+))?/);
    if (progressMatch) {
      const progress = Math.max(0, Math.min(100, Number(progressMatch[1])));
      const parsedBytes = progressMatch[2] ? Math.max(0, Number(progressMatch[2])) : 0;
      const parsedTotal = progressMatch[3] ? Math.max(0, Number(progressMatch[3])) : 0;
      const effectiveTotal = parsedTotal || this.state.downloadTotalBytes || 0;
      const inferredBytes = effectiveTotal > 0 ? Math.round((progress / 100) * effectiveTotal) : this.state.downloadBytes;
      this.updateState({
        modelReady: false,
        statusMessage: 'downloading-vosk-model',
        downloadProgress: progress,
        downloadBytes: Math.max(this.state.downloadBytes || 0, parsedBytes || 0, inferredBytes || 0),
        downloadTotalBytes: effectiveTotal,
        lastError: ''
      });
      return;
    }

    const bytesMatch = lower.match(/downloading-vosk-model-bytes[^\r\n]*bytes=(\d+)/);
    if (bytesMatch) {
      const downloadBytes = Math.max(0, Number(bytesMatch[1]));
      this.updateState({
        modelReady: false,
        statusMessage: 'downloading-vosk-model',
        downloadProgress: null,
        downloadBytes,
        downloadTotalBytes: this.state.downloadTotalBytes || 0,
        lastError: ''
      });
      return;
    }

    if (lower.includes('vosk model loaded') || lower.includes('model-ready')) {
      this.updateState({
        modelReady: true,
        statusMessage: 'model-ready',
        downloadProgress: null,
        downloadBytes: 0,
        downloadTotalBytes: 0,
        lastError: ''
      });
      return;
    }

    if (lower.includes('loading-vosk-model') || lower.includes('initializing sidecar')) {
      this.updateState({
        modelReady: false,
        statusMessage: 'loading-vosk-model',
        downloadProgress: null,
        downloadBytes: 0,
        downloadTotalBytes: 0
      });
      return;
    }

    if (lower.includes('downloading-vosk-model')) {
      this.updateState({
        modelReady: false,
        statusMessage: 'downloading-vosk-model',
        downloadProgress: this.state.downloadProgress ?? 0,
        downloadBytes: this.state.downloadBytes ?? 0,
        downloadTotalBytes: this.state.downloadTotalBytes ?? 0
      });
      return;
    }

    if (lower.includes('vosk preload failed') || lower.includes('model-load-failed')) {
      this.updateState({
        modelReady: false,
        statusMessage: 'model-error',
        downloadProgress: null,
        downloadBytes: 0,
        downloadTotalBytes: 0,
        lastError: line
      });
    }
  }

  async startProcess() {
    if (this.sidecarProcess) {
      this.updateState({ processRunning: true, statusMessage: this.state.statusMessage || 'running' });
      return true;
    }

    const scriptPath = path.join(this.rootDir, 'backend', 'server.py');
    if (!fs.existsSync(scriptPath)) {
      console.warn('[speech-sidecar] server.py missing at', scriptPath);
      this.updateState({
        processRunning: false,
        managedProcess: false,
        modelReady: false,
        statusMessage: 'sidecar-script-missing',
        lastError: `Missing script: ${scriptPath}`
      });
      return false;
    }

    const candidates = resolvePythonCandidates(this.rootDir);
    for (const candidate of candidates) {
      try {
        // Fire off dependency check in background (don't block startup)
        setImmediate(async () => {
          const depCheck = await checkAndInstallDependencies(candidate.cmd);
          if (depCheck.success) {
            console.log('[speech-sidecar] dependencies ready');
          } else {
            console.warn('[speech-sidecar] dependency installation available but not critical for startup');
          }
        });
        
        const child = spawn(candidate.cmd, [...candidate.args, scriptPath, '--host', this.host, '--port', String(this.port)], {
          cwd: this.rootDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          env: { ...process.env, VOSK_MODEL_SIZE: this.modelSize }
        });

        child.on('error', (err) => {
          console.error(`[speech-sidecar] spawn error: ${err.message} (${err.code})`);
          this.updateState({
            processRunning: false,
            managedProcess: false,
            portOpen: false,
            modelReady: false,
            statusMessage: 'sidecar-spawn-error',
            lastError: err.code === 'ENOENT' 
              ? 'Python 3.7+ required for AI features. Install from https://python.org and restart Liturgia.'
              : `Failed to start speech engine: ${err.message}`,
            runtimeCommand: candidate.cmd,
            restarting: false
          });
        });

        child.stdout.on('data', (buf) => {
          const text = buf.toString();
          text.split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            if (trimmed) {
              console.log(`[sidecar:${child.pid}] ${trimmed}`);
              this.parseSidecarLogLine(trimmed);
            }
          });
        });

        child.stderr.on('data', (buf) => {
          const text = buf.toString();
          text.split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            if (trimmed) {
              console.error(`[sidecar:${child.pid}] ${trimmed}`);
              this.parseSidecarLogLine(trimmed);
            }
          });
        });

        child.on('exit', (code, signal) => {
          const expectedExit = this.expectedExitPid === child.pid;
          if (expectedExit) this.expectedExitPid = null;
          console.warn(`[sidecar:${child.pid}] exited code=${code} signal=${signal || 'none'} expected=${expectedExit}`);
          if (this.sidecarProcess === child) {
            this.sidecarProcess = null;
            this.updateState({
              processRunning: false,
              managedProcess: false,
              portOpen: false,
              modelReady: false,
              downloadProgress: null,
              downloadBytes: 0,
              downloadTotalBytes: 0,
              statusMessage: 'sidecar-exited',
              lastError: expectedExit ? '' : `sidecar-exited code=${code} signal=${signal || 'none'}`,
              restarting: false
            });
            if (!expectedExit) this.scheduleUnexpectedRestart();
          }
        });

        this.sidecarProcess = child;
        this.updateState({
          processRunning: true,
          managedProcess: true,
          portOpen: false,
          modelReady: false,
          downloadProgress: null,
          downloadBytes: 0,
          downloadTotalBytes: 0,
          modelDownloadDir: getModelDir(this.rootDir, this.modelSize),
          statusMessage: 'loading-vosk-model',
          lastError: '',
          runtimeCommand: candidate.cmd,
          lastStartAt: Date.now(),
          restarting: false
        });
        console.log(`[speech-sidecar] started python process ${child.pid} via ${candidate.cmd}`);
        return true;
      } catch (err) {
        console.warn('[speech-sidecar] spawn failed with', candidate.cmd, err.message || err);
      }
    }

    this.updateState({
      processRunning: false,
      managedProcess: false,
      portOpen: false,
      modelReady: false,
      statusMessage: 'sidecar-python-missing',
      lastError: 'Python 3.7+ is required for AI features. Please install from https://python.org and try again.',
      restarting: false
    });
    return false;
  }

  stopProcess() {
    if (!this.sidecarProcess) return;
    const pid = this.sidecarProcess.pid;
    this.expectedExitPid = pid;
    
    try {
      // Try graceful SIGTERM first
      this.sidecarProcess.kill('SIGTERM');
    } catch (err) {
      console.warn('[speech-sidecar] SIGTERM failed', err.message || err);
    }
    
    // On Windows, also try taskkill as backup if process is still running
    if (process.platform === 'win32' && this.sidecarProcess) {
      setTimeout(() => {
        if (this.sidecarProcess && !this.sidecarProcess.killed) {
          try {
            const { execSync } = require('child_process');
            execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe' });
            console.log('[speech-sidecar] force-killed via taskkill PID', pid);
          } catch (err) {
            console.warn('[speech-sidecar] taskkill failed', err.message || err);
          }
        }
      }, 500);
    }
    
    this.sidecarProcess = null;
    this.updateState({
      processRunning: false,
      managedProcess: false,
      portOpen: false,
      modelReady: false,
      downloadProgress: null,
      downloadBytes: 0,
      downloadTotalBytes: 0,
      statusMessage: 'sidecar-stopped',
      restarting: false
    });
  }

  async ensureRunning() {
    const portOpen = await this.checkPortOpen();
    if (portOpen) {
      this.updateState({ portOpen: true, processRunning: true, statusMessage: this.state.modelReady ? 'model-ready' : (this.state.statusMessage || 'sidecar-running') });
      return true;
    }
    this.updateState({ portOpen: false, modelReady: false });
    return await this.startProcess();
  }

  async restart() {
    this.updateState({ restarting: true, statusMessage: 'restarting-sidecar', modelReady: false, downloadProgress: null, downloadBytes: 0, downloadTotalBytes: 0, lastError: '' });
    this.stopProcess();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const started = await this.startProcess();
    if (!started) {
      this.updateState({ restarting: false, statusMessage: 'sidecar-restart-failed' });
      return false;
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const portOpen = await this.checkPortOpen(1200);
      if (portOpen) {
        this.updateState({ portOpen: true, restarting: false, statusMessage: this.state.modelReady ? 'model-ready' : 'sidecar-running' });
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    this.updateState({ portOpen: false, restarting: false, statusMessage: 'sidecar-restart-timeout' });
    return false;
  }

  async setModelSize(size, { restart = true } = {}) {
    const normalized = normalizeModelSize(size);
    if (normalized === this.modelSize) {
      this.updateState({ modelSize: normalized });
      return { ok: true, modelSize: normalized, restarted: false };
    }
    this.modelSize = normalized;
    this.updateState({ modelSize: normalized, modelDownloadDir: getModelDir(this.rootDir, normalized) });
    if (restart) {
      const ok = await this.restart();
      return { ok, modelSize: normalized, restarted: true };
    }
    return { ok: true, modelSize: normalized, restarted: false };
  }

  getModelFolder() {
    return getModelDir(this.rootDir, this.modelSize);
  }

  dispose() {
    this.appQuitting = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopProcess();
  }
}

module.exports = function createSpeechSidecarManager(options = {}) {
  return new SpeechSidecarManager(options);
};
module.exports.SpeechSidecarManager = SpeechSidecarManager;
