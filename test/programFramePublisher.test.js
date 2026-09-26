const { createProgramFramePublisher, selectProgramWindow } = require('../lib/programFramePublisher');

describe('Program frame publisher', () => {
  let capturePage;
  let window;
  let client;
  let clients;
  let intervalCallback;
  let clearIntervalImpl;

  beforeEach(() => {
    capturePage = jest.fn(async () => ({
      isEmpty: () => false,
      toJPEG: (quality) => Buffer.from(`jpeg:${quality}`)
    }));
    window = {
      isDestroyed: () => false,
      webContents: { isLoading: () => false, capturePage }
    };
    client = { destroyed: false, writableLength: 0, write: jest.fn() };
    clients = new Set([client]);
    intervalCallback = null;
    clearIntervalImpl = jest.fn();
  });

  function createPublisher(overrides = {}) {
    return createProgramFramePublisher({
      getWindow: () => window,
      getClients: () => clients,
      encodeFrame: (jpeg) => Buffer.concat([Buffer.from('frame:'), jpeg]),
      setInterval: (callback, delay) => {
        intervalCallback = callback;
        expect(delay).toBeCloseTo(1000 / 30);
        return 42;
      },
      clearInterval: clearIntervalImpl,
      ...overrides
    });
  }

  test('captures the Worship window only while a Program client is connected', async () => {
    clients.clear();
    const publisher = createPublisher();
    publisher.start();
    expect(publisher.isRunning()).toBe(true);
    await intervalCallback();
    expect(capturePage).not.toHaveBeenCalled();

    clients.add(client);
    await intervalCallback();
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(client.write).toHaveBeenCalledWith(Buffer.from('frame:jpeg:82'));
  });

  test('drops a frame rather than building a queue for a slow client', async () => {
    client.writableLength = 3 * 1024 * 1024;
    const publisher = createPublisher();
    await publisher.captureOnce();
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(client.write).not.toHaveBeenCalled();
  });

  test('stops its interval cleanly', () => {
    const publisher = createPublisher();
    publisher.start();
    publisher.start();
    publisher.stop();
    publisher.stop();
    expect(clearIntervalImpl).toHaveBeenCalledTimes(1);
    expect(publisher.isRunning()).toBe(false);
  });

  test('captures a live physical display when Program uses the logical network output', async () => {
    const other = { isDestroyed: () => false };
    const windows = new Map([[123, window], [456, other]]);
    expect(selectProgramWindow(windows, 456)).toBe(other);

    const publisher = createPublisher({ getWindow: () => selectProgramWindow(windows, 0) });
    await publisher.captureOnce();
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(client.write).toHaveBeenCalledWith(Buffer.from('frame:jpeg:82'));

    window.isDestroyed = () => true;
    expect(selectProgramWindow(windows, 123)).toBe(other);
  });

  test('does not start capture while the Program window is loading', async () => {
    window.webContents.isLoading = () => true;
    const publisher = createPublisher();
    await publisher.captureOnce();
    expect(capturePage).not.toHaveBeenCalled();
  });
});
