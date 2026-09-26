'use strict';

const DEFAULT_FRAME_INTERVAL_MS = 1000 / 30;
const DEFAULT_JPEG_QUALITY = 82;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function createProgramFramePublisher(options) {
  const getWindow = options.getWindow;
  const getClients = options.getClients;
  const encodeFrame = options.encodeFrame;
  const intervalMs = options.intervalMs || DEFAULT_FRAME_INTERVAL_MS;
  const jpegQuality = options.jpegQuality || DEFAULT_JPEG_QUALITY;
  const maxBufferedBytes = options.maxBufferedBytes || DEFAULT_MAX_BUFFERED_BYTES;
  const setIntervalImpl = options.setInterval || setInterval;
  const clearIntervalImpl = options.clearInterval || clearInterval;
  const onError = options.onError || (() => {});
  let timer = null;
  let captureInProgress = false;

  async function captureOnce() {
    const clients = getClients();
    if (!clients.size || captureInProgress) return false;
    const window = getWindow();
    if (!window || window.isDestroyed() || window.webContents.isLoading()) return false;

    captureInProgress = true;
    try {
      const image = await window.webContents.capturePage();
      if (!image || image.isEmpty()) return false;
      const encoded = encodeFrame(image.toJPEG(jpegQuality));
      for (const client of [...getClients()]) {
        if (client.destroyed || client.writableLength > maxBufferedBytes) continue;
        try {
          client.write(encoded);
        } catch (error) {
          onError(error);
        }
      }
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      captureInProgress = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setIntervalImpl(() => captureOnce(), intervalMs);
    },
    stop() {
      if (timer === null) return;
      clearIntervalImpl(timer);
      timer = null;
    },
    captureOnce,
    isRunning() {
      return timer !== null;
    }
  };
}

module.exports = {
  createProgramFramePublisher,
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_MAX_BUFFERED_BYTES
};
