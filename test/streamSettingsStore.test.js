const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettingsStore } = require('../stream/settingsStore');

describe('Liturgia Stream settings store', () => {
  let directory;
  let store;
  const safeStorage = {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((value) => Buffer.from(`protected:${value}`)),
    decryptString: jest.fn((value) => value.toString().replace(/^protected:/, ''))
  };

  beforeEach(async () => {
    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'liturgia-stream-settings-'));
    store = createSettingsStore(directory, safeStorage);
    jest.clearAllMocks();
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
  });

  afterEach(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });

  test('stores the stream key encrypted and never returns it to the renderer', async () => {
    const result = await store.save({
      destination: { name: 'Church YouTube', server: 'rtmps://example.test/live', streamKey: 'top-secret-key' },
      output: { width: 1920, height: 1080, fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 160 }
    });
    const fileText = await fs.promises.readFile(path.join(directory, 'settings.json'), 'utf8');
    const loaded = await store.load();

    expect(fileText).not.toContain('top-secret-key');
    expect(JSON.parse(fileText).destination.encryptedKey).toBe(Buffer.from('protected:top-secret-key').toString('base64'));
    expect(result.destination).toEqual({ name: 'Church YouTube', server: 'rtmps://example.test/live', keySaved: true });
    expect(loaded.destination).toEqual({ name: 'Church YouTube', server: 'rtmps://example.test/live', keySaved: true });
  });

  test('makes destination credentials available only to the main process', async () => {
    await store.save({ destination: { name: 'Test', server: 'rtmps://example.test/live', streamKey: 'main-only-secret' } });
    await expect(store.getDestinationCredentials()).resolves.toEqual({
      name: 'Test', server: 'rtmps://example.test/live', streamKey: 'main-only-secret'
    });
    const fileText = await fs.promises.readFile(path.join(directory, 'settings.json'), 'utf8');
    expect(fileText).not.toContain('main-only-secret');
  });

  test('keeps an existing encrypted key when editing the destination without re-entering it', async () => {
    await store.save({ destination: { name: 'Test', server: 'rtmp://example.test/live', streamKey: 'retain-me' } });
    await store.save({ destination: { name: 'Updated', server: 'rtmps://example.test/live', streamKey: '' } });
    const saved = JSON.parse(await fs.promises.readFile(path.join(directory, 'settings.json'), 'utf8'));

    expect(saved.destination.encryptedKey).toBe(Buffer.from('protected:retain-me').toString('base64'));
    expect(saved.destination.name).toBe('Updated');
  });

  test('persists scene selection without changing encrypted destination data', async () => {
    await store.save({ destination: { name: 'Test', server: 'rtmps://example.test/live', streamKey: 'keep-private' } });
    await store.saveScenes([
      { id: 'camera', name: 'Camera', cameraVisible: true, programVisible: false },
      { id: 'program', name: 'Liturgia Fullscreen', cameraVisible: false, programVisible: true }
    ], 'program');
    const saved = JSON.parse(await fs.promises.readFile(path.join(directory, 'settings.json'), 'utf8'));
    const loaded = await store.load();

    expect(saved.destination.encryptedKey).toBe(Buffer.from('protected:keep-private').toString('base64'));
    expect(loaded.activeSceneId).toBe('program');
    expect(loaded.scenes).toHaveLength(2);
  });

  test('keeps independent ordered custom layers with bounded geometry across restart', async () => {
    await store.saveScenes([{
      id: 'custom', name: 'Custom', custom: true, layers: [
        { id: 'background', type: 'program', name: 'Program', x: 0, y: 0, width: 1920, height: 1080 },
        { id: 'foreground', type: 'program', name: 'Second view', x: 200, y: 300, width: -10, height: 300,
          cropLeft: .2, panX: 50, zoom: 2, opacity: .6, brightness: 140, contrast: 125 }
      ]
    }], 'custom');
    const reloaded = createSettingsStore(directory, safeStorage);
    const { scenes } = await reloaded.load();
    expect(scenes[0].layers.map((layer) => layer.id)).toEqual(['background', 'foreground']);
    expect(scenes[0].layers[0].cropLeft).toBe(0);
    expect(scenes[0].layers[0].brightness).toBe(100);
    expect(scenes[0].layers[1]).toMatchObject({
      x: 200, y: 300, width: 20, height: 300, cropLeft: .2, panX: 50, zoom: 2, opacity: .6,
      brightness: 140, contrast: 125
    });
  });

  test('persists camera and microphone selections without exposing stream keys', async () => {
    await store.save({ destination: { name: 'Test', server: 'rtmps://example.test/live', streamKey: 'secret-device-key' } });
    await store.saveDevices({ cameraId: 'camera-id', microphoneId: 'mic-id' });
    const saved = JSON.parse(await fs.promises.readFile(path.join(directory, 'settings.json'), 'utf8'));
    const loaded = await store.load();

    expect(saved.devices).toEqual({ cameraId: 'camera-id', microphoneId: 'mic-id' });
    expect(JSON.stringify(saved)).not.toContain('secret-device-key');
    expect(loaded.devices).toEqual({ cameraId: 'camera-id', microphoneId: 'mic-id' });
  });

  test('refuses to save a stream key if secure storage is unavailable', async () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await expect(store.save({
      destination: { name: 'Test', server: 'rtmps://example.test/live', streamKey: 'secret' }
    })).rejects.toThrow('cannot save the stream key safely');
  });
});
