'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  destination: null,
  output: { width: 1920, height: 1080, fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 160, audioSampleRate: 48000 },
  scenes: [
    { id: 'camera', name: 'Camera', cameraVisible: true, programVisible: false },
    { id: 'camera-program', name: 'Camera + Liturgia', cameraVisible: true, programVisible: true },
    { id: 'program', name: 'Liturgia Fullscreen', cameraVisible: false, programVisible: true }
  ],
  activeSceneId: 'camera-program'
};

function createSettingsStore(userDataPath, safeStorage, fileSystem = fs) {
  const filePath = path.join(userDataPath, 'settings.json');

  async function readRaw() {
    try {
      return JSON.parse(await fileSystem.promises.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeRaw(document) {
    await fileSystem.promises.mkdir(userDataPath, { recursive: true });
    const temporaryPath = filePath + '.tmp';
    await fileSystem.promises.writeFile(temporaryPath, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fileSystem.promises.rename(temporaryPath, filePath);
  }

  return {
    async load() {
      const stored = await readRaw();
      let destination = null;
      if (stored.destination && typeof stored.destination === 'object') {
        const { name, server, encryptedKey } = stored.destination;
        let keySaved = false;
        if (typeof encryptedKey === 'string' && safeStorage.isEncryptionAvailable()) {
          try {
            safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
            keySaved = true;
          } catch (_) {}
        }
        destination = { name: String(name || ''), server: String(server || ''), keySaved };
      }
      return {
        destination,
        output: { ...DEFAULT_CONFIG.output, ...(stored.output || {}) },
        devices: { cameraId: String(stored.devices?.cameraId || ''), microphoneId: String(stored.devices?.microphoneId || '') },
        scenes: Array.isArray(stored.scenes) ? stored.scenes : DEFAULT_CONFIG.scenes,
        activeSceneId: stored.activeSceneId || DEFAULT_CONFIG.activeSceneId
      };
    },

    async save(config) {
      const name = String(config?.destination?.name || '').trim();
      const server = String(config?.destination?.server || '').trim();
      const streamKey = String(config?.destination?.streamKey || '');
      if (!name) throw new Error('Enter a destination name.');
      if (!/^rtmps?:\/\//i.test(server)) throw new Error('Enter an RTMP or RTMPS server address.');
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows secure storage is not available, so Liturgia Stream cannot save the stream key safely.');
      }

      const previous = await readRaw();
      const existingEncryptedKey = previous.destination && previous.destination.encryptedKey;
      let existingKeyAvailable = false;
      if (typeof existingEncryptedKey === 'string') {
        try {
          safeStorage.decryptString(Buffer.from(existingEncryptedKey, 'base64'));
          existingKeyAvailable = true;
        } catch (_) {}
      }
      if (!streamKey.trim() && !existingKeyAvailable) throw new Error('Enter a stream key.');
      const output = { ...DEFAULT_CONFIG.output, ...(config.output || {}) };
      const encryptedKey = streamKey.trim()
        ? safeStorage.encryptString(streamKey).toString('base64')
        : existingEncryptedKey;
      const document = {
        ...previous,
        destination: { name, server, encryptedKey },
        output
      };
      await writeRaw(document);
      return { destination: { name, server, keySaved: true }, output };
    },

    async getDestinationCredentials() {
      const stored = await readRaw();
      const destination = stored.destination || {};
      if (typeof destination.encryptedKey !== 'string' || !safeStorage.isEncryptionAvailable()) {
        throw new Error('Save a destination and stream key before going live.');
      }
      let streamKey;
      try {
        streamKey = safeStorage.decryptString(Buffer.from(destination.encryptedKey, 'base64'));
      } catch (_) {
        throw new Error('The saved stream key cannot be opened. Enter it again in Stream Setup.');
      }
      return {
        name: String(destination.name || ''),
        server: String(destination.server || ''),
        streamKey
      };
    },

    async saveDevices(devices) {
      const previous = await readRaw();
      const selected = {
        cameraId: String(devices?.cameraId || '').slice(0, 512),
        microphoneId: String(devices?.microphoneId || '').slice(0, 512)
      };
      await writeRaw({ ...previous, devices: selected });
      return selected;
    },

    async saveScenes(scenes, activeSceneId) {
      if (!Array.isArray(scenes) || !scenes.length) throw new Error('At least one scene is required.');
      const normalized = scenes.slice(0, 20).map((scene, index) => ({
        id: String(scene.id || `scene-${index + 1}`).slice(0, 64),
        name: String(scene.name || `Scene ${index + 1}`).trim().slice(0, 48),
        cameraVisible: scene.cameraVisible === true,
        programVisible: scene.programVisible === true
      }));
      if (normalized.some((scene) => !scene.name)) throw new Error('Scene names cannot be blank.');
      const selected = normalized.some((scene) => scene.id === activeSceneId) ? activeSceneId : normalized[0].id;
      const previous = await readRaw();
      await writeRaw({ ...previous, scenes: normalized, activeSceneId: selected });
      return { scenes: normalized, activeSceneId: selected };
    }
  };
}

module.exports = { createSettingsStore, DEFAULT_CONFIG };
