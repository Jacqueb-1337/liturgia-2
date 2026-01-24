const path = require('path');
const os = require('os');
const { URL, pathToFileURL } = require('url');

function isPackaged(app) {
  if (!app) return process.env.NODE_ENV === 'production';
  return app.isPackaged;
}

function getResourcesPath(app) {
  if (app && app.isPackaged) return process.resourcesPath;
  // In dev, resources are project root
  return path.resolve(__dirname, '..');
}

function getUserDataDir(app) {
  if (!app) return path.join(os.homedir(), '.config', 'liturgia');
  return app.getPath('userData');
}

function getConfigDir(app) {
  if (process.platform === 'linux') {
    return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config', app ? app.getName() : 'liturgia');
  }
  return getUserDataDir(app);
}

function getIconPath(app) {
  const r = getResourcesPath(app);
  if (process.platform === 'darwin') return path.join(r, 'build', 'icon.icns');
  if (process.platform === 'win32') return path.join(r, 'build', 'icon.ico');
  return path.join(r, 'build', 'icon.png');
}

function getSqlWasmPath(app) {
  // try packaged locations first
  const r = getResourcesPath(app);
  const alt = path.join(process.resourcesPath || r, 'sql-wasm.wasm');
  return alt;
}

function fileUrlFor(filePath) {
  if (!filePath) return '';
  try {
    // If it's already a file URL, return as-is
    if (filePath.startsWith('file://')) return filePath;
    return pathToFileURL(path.resolve(filePath)).toString();
  } catch (e) {
    return 'file:///' + filePath.replace(/\\/g, '/');
  }
}

function resolveProjectPath(...segments) {
  return path.resolve(__dirname, '..', ...segments);
}

function getDesktopPath(app) {
  if (!app) return path.join(os.homedir(), 'Desktop');
  return app.getPath('desktop');
}

function getTempPath(app) {
  if (!app) return os.tmpdir();
  return app.getPath('temp');
}

module.exports = {
  isPackaged,
  getResourcesPath,
  getUserDataDir,
  getConfigDir,
  getIconPath,
  getSqlWasmPath,
  fileUrlFor,
  resolveProjectPath,
  getDesktopPath,
  getTempPath
};
