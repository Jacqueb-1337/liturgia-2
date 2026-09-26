'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { buildWebmOutputArgs } = require('./ffmpegRuntime');

const RECONNECT_DELAYS_MS = [0, 2000, 5000, 10000];
const ENCODER_FAILURE = /unknown encoder|error while opening encoder|no capable devices found|device setup failed|cannot load lib(cuda|mfx|amfrt)/i;

class StreamOutputManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawnProcess = options.spawnProcess || spawn;
    this.setTimeoutImpl = options.setTimeout || setTimeout;
    this.clearTimeoutImpl = options.clearTimeout || clearTimeout;
    this.state = 'idle';
    this.child = null;
    this.config = null;
    this.encoders = [];
    this.encoderIndex = 0;
    this.retryIndex = 0;
    this.retryTimer = null;
    this.stopRequested = false;
    this.lastError = '';
    this.progressBuffer = '';
  }

  publish(state, detail = {}) {
    this.state = state;
    this.emit('status', { state, encoder: this.currentEncoder?.label || null, ...detail });
  }

  async start(config) {
    if (this.state !== 'idle' && this.state !== 'stopped') {
      throw new Error('A stream is already starting or running.');
    }
    if (!config?.runtime?.available || !config.runtime.executablePath) {
      throw new Error(config?.runtime?.error || 'FFmpeg is not available.');
    }
    if (!config.outputUrl) throw new Error('A stream destination is required.');
    const encoders = config.runtime.supported || [];
    if (!encoders.length) throw new Error('This FFmpeg build has no supported H.264 encoder.');

    this.config = config;
    this.encoders = encoders;
    this.encoderIndex = Math.max(0, encoders.findIndex((item) => item.id === config.runtime.encoder?.id));
    this.retryIndex = 0;
    this.stopRequested = false;
    this.lastError = '';
    try {
      await this.launch();
    } catch (error) {
      this.lastError = error.message;
      this.scheduleReconnect();
    }
    return { state: this.state, encoder: this.currentEncoder.id };
  }

  get currentEncoder() {
    return this.encoders[this.encoderIndex] || this.encoders[this.encoders.length - 1];
  }

  async launch() {
    if (this.stopRequested) return;
    const options = { ...this.config.output, encoder: this.currentEncoder.id, outputUrl: this.config.outputUrl };
    const args = buildWebmOutputArgs(options);
    this.publish('connecting', { message: 'Starting stream encoder…' });
    const child = this.spawnProcess(this.config.runtime.executablePath, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });
    this.child = child;
    this.lastError = '';
    this.progressBuffer = '';
    let handled = false;

    const finish = (error) => {
      if (handled) return;
      handled = true;
      if (error && !this.lastError) this.lastError = error.message || String(error);
      this.handleExit(child, error);
    };

    child.once('spawn', () => {
      if (this.child !== child || this.stopRequested) return;
      this.publish('awaiting-input', { message: 'Ready for composed video and audio.' });
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      if (/error|failed|cannot load|no capable devices/i.test(text)) {
        this.lastError = (this.lastError + text).slice(-4000);
      }
      this.handleProgress(chunk);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(code === 0 ? null : new Error(this.lastError || `FFmpeg exited with code ${code}.`)));
  }

  handleProgress(chunk) {
    this.progressBuffer += String(chunk);
    const lines = this.progressBuffer.split(/\r?\n/);
    this.progressBuffer = lines.pop() || '';
    const update = {};
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator < 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === 'frame') update.frame = Number(value) || 0;
      else if (key === 'fps') update.fps = Number(value) || 0;
      else if (key === 'bitrate') update.bitrate = value;
      else if (key === 'drop_frames') update.droppedFrames = Number(value) || 0;
      else if (key === 'progress' && value !== 'continue') update.progress = value;
    }
    if (Object.keys(update).length) {
      if (update.frame > 0) update.state = 'live';
      this.publish(update.state || this.state, update);
    }
  }

  writeChunk(data) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error('The stream encoder is reconnecting.'));
    }
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return new Promise((resolve, reject) => {
      child.stdin.write(buffer, (error) => error ? reject(error) : resolve());
    });
  }

  handleExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopRequested) return;
    if (error && !this.lastError) this.lastError = error.message || String(error);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopRequested) return;
    if (ENCODER_FAILURE.test(this.lastError) && this.encoderIndex < this.encoders.length - 1) {
      this.encoderIndex += 1;
      this.retryIndex = 0;
    }
    const delayMs = RECONNECT_DELAYS_MS[Math.min(this.retryIndex, RECONNECT_DELAYS_MS.length - 1)];
    this.retryIndex += 1;
    this.publish('reconnecting', {
      message: 'Connection lost. Reconnecting…',
      retryInMs: delayMs,
      error: this.lastError || null
    });
    this.retryTimer = this.setTimeoutImpl(() => {
      this.retryTimer = null;
      void this.launch().catch((launchError) => {
        this.child = null;
        this.lastError = launchError.message;
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  async stop() {
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.stopRequested = true;
    if (this.retryTimer !== null) {
      this.clearTimeoutImpl(this.retryTimer);
      this.retryTimer = null;
    }
    const child = this.child;
    this.publish('stopping');
    if (child?.stdin && child.stdin.writable) child.stdin.end();
    if (child) {
      await new Promise((resolve) => {
        let done = false;
        let killTimer = null;
        const finish = () => {
          if (done) return;
          done = true;
          if (killTimer !== null) this.clearTimeoutImpl(killTimer);
          resolve();
        };
        child.once('close', finish);
        killTimer = this.setTimeoutImpl(() => {
          if (!done) {
            try { child.kill(); } catch (_) {}
            finish();
          }
        }, 5000);
      });
    }
    this.child = null;
    this.publish('stopped');
  }
}

module.exports = { StreamOutputManager, RECONNECT_DELAYS_MS };
