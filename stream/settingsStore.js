'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  destination: null,
  output: { width: 1920, height: 1080, fps: 30, videoBitrateKbps: 6000, audioBitrateKbps: 160, audioSampleRate: 48000 }
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
        output: { ...DEFAULT_CONFIG.output, ...(stored.output || {}) }
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
        destination: { name, server, encryptedKey },
        output
      };
      await fileSystem.promises.mkdir(userDataPath, { recursive: true });
      const temporaryPath = filePath + '.tmp';
      await fileSystem.promises.writeFile(temporaryPath, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fileSystem.promises.rename(temporaryPath, filePath);
      return { destination: { name, server, keySaved: true }, output };
    }
  };
}

module.exports = { createSettingsStore, DEFAULT_CONFIG };
