const fs = require('fs');
const path = require('path');
const vm = require('vm');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

test('shared Go Live dispatches even when there is no Bible selection', async () => {
  const callback = renderer.slice(renderer.indexOf('    onEnter: () => {'), renderer.indexOf('    onToggleLive: toggleLive'));
  const dispatch = jest.fn().mockResolvedValue('presented');
  const config = vm.runInNewContext('({' + callback + '})', {
    selectedIndices: [], handleVerseDoubleClick: dispatch
  });
  expect(await config.onEnter()).toBe('presented');
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test.each([
  [{}, undefined, 'https://jacqueb.me/liturgia'],
  [{ licenseServer: '' }, undefined, 'https://jacqueb.me/liturgia'],
  [{ licenseServer: 'https://custom.example/' }, undefined, 'https://jacqueb.me/liturgia'],
  [{}, 'https://override.example/', 'https://jacqueb.me/liturgia']
])('startup resolves the license endpoint for %j', async (settings, override, expected) => {
  // Execute the real validation preflight, stopping before any HTTP request.
  const start = renderer.indexOf('async function validateTokenAndActivate(');
  const end = renderer.indexOf('    // Prefer query param first', start);
  const preflight = renderer.slice(start, end) + 'return server; } catch (error) { throw error; } }';
  const send = jest.fn();
  const validate = vm.runInNewContext(preflight + '; validateTokenAndActivate', {
    LICENSE_SERVER: require('../constants').LICENSE_SERVER,
    ipcRenderer: { invoke: async () => settings, send },
    restoreOfflineLicenseStatus: async () => null
  });
  expect(await validate('test-token', override)).toBe(expected);
  expect(send).not.toHaveBeenCalled();
});
