const { spawn, exec, execFile } = require('child_process');
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

function getModelDir(rootDir, size, userDataDir) {
  const modelDirName = MODEL_DIR_BY_SIZE[normalizeModelSize(size)] || MODEL_DIR_BY_SIZE.small;
  
  // If app is installed in Program Files, use AppData for models (writable)
  const isWindows = process.platform === 'win32';
  if (isWindows && rootDir.includes('Program Files')) {
    if (!userDataDir) {
      // Fallback to environment variable if userDataDir not provided
      userDataDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'), 'Liturgia');
    }
    return path.join(userDataDir, 'speech', 'models', modelDirName);
  }
  
  // Default: models in installation directory (or AppData on new installs)
  return path.join(rootDir, 'backend', 'models', modelDirName);
}

function resolvePythonCandidates(rootDir) {
  const candidates = [];
  const isWindows = process.platform === 'win32';
  
  // Diagnostic: log PATH for troubleshooting
  const pathEnv = process.env.PATH || '';
  console.log(`[python-candidate] Platform: ${process.platform}, PATH length: ${pathEnv.length} chars`);
  
  // Try local venv only if it clearly exists (for dev/npm start scenario)
  const winVenv = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  const posixVenv = path.join(rootDir, '.venv', 'bin', 'python');
  if (isWindows && fs.existsSync(winVenv)) {
    console.log(`[python-candidate] Found local .venv: ${winVenv}`);
    candidates.push({ cmd: winVenv, args: [] });
  }
  
  if (!isWindows && fs.existsSync(posixVenv)) {
    console.log(`[python-candidate] Found local .venv: ${posixVenv}`);
    candidates.push({ cmd: posixVenv, args: [] });
  }
  
  // Fall back to system Python (primary method for production)
  candidates.push({ cmd: 'python', args: [] });
  candidates.push({ cmd: 'python3', args: [] });
  if (isWindows) {
    candidates.push({ cmd: 'py', args: ['-3'] });
  }
  
  console.log(`[python-candidate] Trying candidates: ${candidates.map(c => c.cmd).join(', ')}`);
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
    
    // Handle ASAR unpacking - if __dirname is inside app.asar, redirect to app.asar.unpacked
    let rootDir = options.rootDir || path.resolve(__dirname);
    if (rootDir.includes('.asar' + path.sep)) {
      rootDir = rootDir.replace(path.sep + 'app.asar' + path.sep, path.sep + 'app.asar.unpacked' + path.sep);
    }
    this.rootDir = rootDir;
    this.userDataDir = options.userDataDir; // Optional: for redirecting models in Program Files
    this.modelSize = normalizeModelSize(options.modelSize || 'small');
    this.sidecarProcess = null;
    this.expectedExitPid = null;
    this.restartTimer = null;
    this.appQuitting = false;
    this.isStartingProcess = false; // Prevent concurrent startProcess calls
    // Backoff tracking (prevent thrashing when spawn keeps failing)
    this.consecutiveSpawnFailures = 0;
    this.spawnFailureBackoffUntil = 0;
    // Diagnostic log buffer
    this.logBuffer = [];
    this.maxLogSize = 200;

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
      modelDownloadDir: getModelDir(this.rootDir, this.modelSize, this.userDataDir),
      restarting: false,
      lastStartAt: 0
    };
  }

  getStatus() {
    return {
      ...this.state,
      modelSize: this.modelSize,
      modelDownloadDir: getModelDir(this.rootDir, this.modelSize, this.userDataDir),
      sidecarWsUrl: `ws://${this.host}:${this.port}/transcribe`,
      diagnosticLog: this.logBuffer.join('\n')
    };
  }

  addLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${message}`;
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogSize) {
      this.logBuffer.shift();
    }
    console.log(entry);
  }

  updateState(patch) {
    this.state = { ...this.state, ...patch };
    if (!this.state.modelDownloadDir) {
      this.state.modelDownloadDir = getModelDir(this.rootDir, this.modelSize, this.userDataDir);
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

  async cleanupPortIfNeeded() {
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      if (process.platform === 'win32') {
        // On Windows, use netstat to find and kill process using port
        // Need to wrap in cmd /c to make pipes work
        try {
          const { stdout } = await execAsync(`cmd /c netstat -ano | findstr :${this.port}`, { 
            timeout: 3000,
            encoding: 'utf8',
            shell: 'cmd.exe'
          });
          
          if (stdout && stdout.trim()) {
            // Extract PID from netstat output (last column)
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              const matches = line.match(/\s+(\d+)\s*$/);
              if (matches && matches[1]) {
                const pid = parseInt(matches[1], 10);
                // Validate: PID must be > 0 and not our own process
                if (pid > 0 && pid !== process.pid) {
                  this.addLog(`Found process ${pid} using port ${this.port}, terminating...`);
                  try {
                    await execAsync(`taskkill /PID ${pid} /F /T`, { timeout: 2000 });
                    this.addLog(`Successfully terminated process ${pid}`);
                    await new Promise(resolve => setTimeout(resolve, 300));
                  } catch (killErr) {
                    this.addLog(`Failed to kill process ${pid}: ${killErr.message}`);
                  }
                }
              }
            }
          }
        } catch (netErr) {
          // netstat might fail if nothing is using the port, that's okay
          this.addLog(`netstat check (port may be free or netstat failed)`);
        }
      } else {
        // On macOS/Linux, use lsof
        try {
          const { stdout } = await execAsync(`lsof -i :${this.port} -t`, { 
            timeout: 3000,
            encoding: 'utf8'
          });
          
          if (stdout && stdout.trim()) {
            const pids = stdout.trim().split('\n').filter(p => p && p !== process.pid.toString());
            for (const pid of pids) {
              const pidNum = parseInt(pid, 10);
              // Validate: PID must be > 0
              if (pidNum > 0) {
                this.addLog(`Found process ${pidNum} using port ${this.port}, terminating...`);
                try {
                  await execAsync(`kill -9 ${pidNum}`, { timeout: 2000 });
                  this.addLog(`Successfully terminated process ${pidNum}`);
                  await new Promise(resolve => setTimeout(resolve, 300));
                } catch (killErr) {
                  this.addLog(`Failed to kill process ${pidNum}: ${killErr.message}`);
                }
              }
            }
          }
        } catch (lsofErr) {
          // lsof might fail, that's okay - port may be free
          this.addLog(`lsof check (port may be free or lsof failed)`);
        }
      }
    } catch (err) {
      this.addLog(`Port cleanup check error: ${err.message}`);
      // Don't fail startup, just proceed
    }
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
    if (this.isStartingProcess) {
      this.addLog('startProcess already in progress, skipping concurrent call');
      return false;
    }
    
    if (this.sidecarProcess) {
      this.updateState({ processRunning: true, statusMessage: this.state.statusMessage || 'running' });
      return true;
    }

    this.isStartingProcess = true;
    try {
      return await this._doStartProcess();
    } finally {
      this.isStartingProcess = false;
    }
  }

  async _doStartProcess() {
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
    const errors = [];
    
    // Use exec to verify Python candidates work BEFORE attempting to spawn
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    let verifiedPythonCmd = null;
    for (const candidate of candidates) {
      try {
        this.addLog(`Verifying Python candidate: ${candidate.cmd}`);
        const { stdout } = await execAsync(`"${candidate.cmd}" --version`, { timeout: 1000, encoding: 'utf8' });
        this.addLog(`Verified Python: ${candidate.cmd} → ${stdout.trim()}`);
        
        // Get the full path to Python - this is what actually works for spawn
        const baseName = candidate.cmd.split('\\').pop().split('/').pop();
        const findCmd = process.platform === 'win32' ? `where ${baseName}` : `which ${baseName}`;
        try {
          const { stdout: pathOutput } = await execAsync(findCmd, { timeout: 1000, encoding: 'utf8' });
          const fullPath = pathOutput.trim().split('\n')[0];
          this.addLog(`Full path: ${fullPath}`);
          verifiedPythonCmd = { ...candidate, cmd: fullPath };
        } catch (pathErr) {
          this.addLog(`Could not resolve full path, using candidate as-is: ${candidate.cmd}`);
          verifiedPythonCmd = candidate;
        }
        break;
      } catch (err) {
        this.addLog(`Python candidate failed: ${candidate.cmd} - ${err.message}`);
        errors.push({ cmd: candidate.cmd, message: err.message });
      }
    }
    
    // If no Python found, fail immediately
    if (!verifiedPythonCmd) {
      const triedCandidates = candidates.map(c => c.cmd).join(', ');
      const errorSummary = errors.map(e => `${e.cmd} (${e.message})`).join('; ');
      this.addLog(`Python verification failed. Tried: ${triedCandidates}`);
      this.addLog(`Errors: ${errorSummary}`);
      
      // Exponential backoff
      this.consecutiveSpawnFailures++;
      const backoffSeconds = Math.min(15 * Math.pow(2, this.consecutiveSpawnFailures - 1), 120);
      this.spawnFailureBackoffUntil = Date.now() + (backoffSeconds * 1000);
      this.addLog(`Spawn failed ${this.consecutiveSpawnFailures} time(s). Backing off for ${backoffSeconds}s`);
      
      const errorMsg = `Python 3.7+ not found in PATH. Install from https://python.org and restart Liturgia.`;
      this.updateState({
        processRunning: false,
        managedProcess: false,
        portOpen: false,
        modelReady: false,
        statusMessage: 'sidecar-spawn-error',
        lastError: errorMsg,
        runtimeCommand: '',
        restarting: false
      });
      return false;
    }
    
    const candidate = verifiedPythonCmd;
    try {
      // BEFORE spawning, try to clean up any existing process using the port
      await this.cleanupPortIfNeeded();
      
      // Fire off dependency check in background
      setImmediate(async () => {
        const depCheck = await checkAndInstallDependencies(candidate.cmd);
        if (depCheck.success) {
          console.log('[speech-sidecar] dependencies installed with ' + candidate.cmd);
        } else {
          console.warn('[speech-sidecar] dependency installation attempted with ' + candidate.cmd + ': ' + depCheck.message);
        }
      });
      
      const pythonCmd = candidate.cmd.trim();
      const pythonArgs = [...candidate.args, scriptPath, '--host', this.host, '--port', String(this.port)];
      
      this.addLog(`Spawning: "${pythonCmd}" with ${pythonArgs.length} args (cwd: ${this.rootDir})`);
      
      // Spawn Python directly - rootDir is now correctly outside ASAR
      const child = spawn(pythonCmd, pythonArgs, {
        cwd: this.rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VOSK_MODEL_SIZE: this.modelSize },
        windowsHide: true
      });

      // Set up error handler
      let spawnError = null;
      child.on('error', (err) => {
        spawnError = err;
        const errorDesc = err.code === 'ENOENT' ? 'not found on disk' : err.code === 'EACCES' ? 'permission denied' : err.code;
        this.addLog(`Spawn error: "${pythonCmd}" (${err.code}: ${errorDesc}) - ${err.message}`);
      });

      // Wait briefly to see if spawn fails immediately
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (spawnError) {
        throw spawnError;
      }
      
      this.addLog(`Spawn executed (detached process)`);


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
        modelDownloadDir: getModelDir(this.rootDir, this.modelSize, this.userDataDir),
        statusMessage: 'loading-vosk-model',
        lastError: '',
        runtimeCommand: pythonCmd,
        lastStartAt: Date.now(),
        restarting: false
      });
      console.log(`[speech-sidecar] started python process ${child.pid} via ${pythonCmd}`);
      return true;
      } catch (err) {
        console.warn('[speech-sidecar] spawn failed with exception:', err.message || err);
        this.updateState({
          processRunning: false,
          managedProcess: false,
          portOpen: false,
          modelReady: false,
          statusMessage: 'sidecar-spawn-error',
          lastError: `Spawn error: ${err.message}`,
          runtimeCommand: '',
          restarting: false
        });
        return false;
      }
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
      this.consecutiveSpawnFailures = 0;
      this.updateState({ portOpen: true, processRunning: true, statusMessage: this.state.modelReady ? 'model-ready' : (this.state.statusMessage || 'sidecar-running') });
      return true;
    }
    this.updateState({ portOpen: false, modelReady: false });
    
    // Backoff: if spawn keeps failing, don't hammer it every 6 seconds
    if (Date.now() < this.spawnFailureBackoffUntil) {
      console.log(`[speech-sidecar] still in backoff period, skipping spawn attempt (${Math.ceil((this.spawnFailureBackoffUntil - Date.now()) / 1000)}s remaining)`);
      return false;
    }
    
    return await this.startProcess();
  }

  async restart() {
    this.updateState({ restarting: true, statusMessage: 'restarting-sidecar', modelReady: false, downloadProgress: null, downloadBytes: 0, downloadTotalBytes: 0, lastError: '' });
    this.stopProcess();
    this.consecutiveSpawnFailures = 0;
    this.spawnFailureBackoffUntil = 0;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const started = await this.startProcess();
    if (!started) {
      this.updateState({ restarting: false, statusMessage: 'sidecar-restart-failed' });
      return false;
    }
    const deadline = Date.now() + 120000;
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
    this.updateState({ modelSize: normalized, modelDownloadDir: getModelDir(this.rootDir, normalized, this.userDataDir) });
    if (restart) {
      const ok = await this.restart();
      return { ok, modelSize: normalized, restarted: true };
    }
    return { ok: true, modelSize: normalized, restarted: false };
  }

  getModelFolder() {
    return getModelDir(this.rootDir, this.modelSize, this.userDataDir);
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
