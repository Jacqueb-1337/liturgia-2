const { EventEmitter } = require('events');
const { StreamOutputManager, RECONNECT_DELAYS_MS } = require('../stream/outputManager');

function makeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    destroyed: false,
    writable: true,
    write: jest.fn((_buffer, callback) => callback()),
    end: jest.fn(() => setTimeout(() => child.emit('close', 0), 0))
  };
  child.kill = jest.fn(() => child.emit('close', 1));
  return child;
}

function createConfig() {
  return {
    runtime: {
      available: true,
      executablePath: 'ffmpeg.exe',
      encoder: { id: 'h264_nvenc', label: 'NVIDIA NVENC' },
      supported: [
        { id: 'h264_nvenc', label: 'NVIDIA NVENC' },
        { id: 'libx264', label: 'Software H.264' }
      ]
    },
    output: { width: 1920, height: 1080, fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 160, audioSampleRate: 48000 },
    outputUrl: 'rtmps://example.test/live/key'
  };
}

describe('Liturgia Stream output manager', () => {
  test('starts FFmpeg with browser WebM input and reports live progress', async () => {
    const child = makeChild();
    const spawnProcess = jest.fn(() => child);
    const manager = new StreamOutputManager({ spawnProcess });
    const states = [];
    manager.on('status', (status) => states.push(status.state));

    await manager.start(createConfig());
    expect(spawnProcess).toHaveBeenCalledWith('ffmpeg.exe', expect.arrayContaining(['-f', 'webm', '-i', 'pipe:0']), expect.any(Object));
    child.emit('spawn');
    await manager.writeChunk(Buffer.from('webm-data'));
    expect(child.stdin.write).toHaveBeenCalledWith(Buffer.from('webm-data'), expect.any(Function));

    child.stderr.emit('data', Buffer.from('frame=30\nfps=29.9\nbitrate=6100.0kbits/s\ndrop_frames=0\nprogress=continue\n'));
    expect(states).toContain('awaiting-input');
    expect(states).toContain('live');
    await manager.stop();
    expect(states.at(-1)).toBe('stopped');
  });

  test('retries after connection loss using the requested first delay', async () => {
    const firstChild = makeChild();
    const secondChild = makeChild();
    const children = [firstChild, secondChild];
    let retryCallback;
    const manager = new StreamOutputManager({
      spawnProcess: jest.fn(() => children.shift()),
      setTimeout: (callback, delay) => {
        if (delay === RECONNECT_DELAYS_MS[0] && !retryCallback) retryCallback = callback;
        return 42;
      },
      clearTimeout: jest.fn()
    });
    const states = [];
    manager.on('status', (status) => states.push(status));

    await manager.start(createConfig());
    firstChild.emit('spawn');
    firstChild.emit('close', 1);
    expect(states.at(-1)).toMatchObject({ state: 'reconnecting', retryInMs: 0 });
    retryCallback();
    secondChild.emit('spawn');
    expect(states.at(-1).state).toBe('awaiting-input');
    await manager.stop();
  });

  test('drops closed-pipe chunks and hides stream credentials in reconnect errors', async () => {
    const child = makeChild();
    const manager = new StreamOutputManager({
      spawnProcess: () => child,
      setTimeout: () => 1,
      clearTimeout: jest.fn()
    });
    const states = [];
    manager.on('status', (status) => states.push(status));
    await manager.start(createConfig());
    child.emit('spawn');
    child.stdin.write.mockImplementation((_buffer, callback) => {
      callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    });
    expect(await manager.writeChunk(Buffer.from('frame'))).toBe(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      child.stderr.emit('data', Buffer.from('Error opening output rtmps://example.test/live/key: I/O error\\n'));
      child.emit('close', 1);
      expect(states.at(-1).state).toBe('reconnecting');
      expect(states.at(-1).error).toContain('[stream destination]');
      expect(states.at(-1).error).not.toContain('/live/key');
      expect(await manager.writeChunk(Buffer.from('late-frame'))).toBe(false);
    } finally {
      warn.mockRestore();
      await manager.stop();
    }
  });

  test('falls back to software when a hardware encoder cannot initialize', async () => {
    const child = makeChild();
    let retryCallback;
    const manager = new StreamOutputManager({
      spawnProcess: jest.fn(() => child),
      setTimeout: (callback) => { retryCallback = callback; return 1; }
    });

    await manager.start(createConfig());
    child.emit('spawn');
    child.stderr.emit('data', Buffer.from('No capable devices found\n'));
    child.emit('close', 1);
    expect(manager.currentEncoder.id).toBe('libx264');
    retryCallback();
    expect(manager.state).toBe('connecting');
    await manager.stop();
  });
});
