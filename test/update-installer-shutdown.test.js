const fs = require('fs');
const path = require('path');

describe('in-app installer launch', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  test('uses Electron native file opening instead of a platform-specific helper', () => {
    expect(main).toContain('async function openDownloadedInstaller(file)');
    expect(main).toContain('const openError = await shell.openPath(installerPath);');
    expect(main).toContain('Could not open downloaded installer:');
    expect(main).toContain("process.platform === 'linux' && /\\.AppImage$/i.test(installerPath)");
    expect(main).toContain('await fs.promises.chmod(installerPath, 0o755);');
    expect(main).toContain('setTimeout(() => quitForInstallerUpdate(), 300);');
    expect(main).not.toContain('Wait-Process -Id $parentPid');
    expect(main).not.toContain('liturgia-update-launch-');
    expect(main).not.toContain('tasklist /FI "PID eq %PARENT_PID%"');
  });

  test('selects the correct installer/package type for each desktop platform', () => {
    expect(renderer).toContain('function selectUpdateAssetForPlatform(assets)');
    expect(renderer).toContain("? ['.exe']");
    expect(renderer).toContain("? ['.dmg', '.pkg']");
    expect(renderer).toContain(": ['.appimage', '.deb']");
    expect(renderer.match(/selectUpdateAssetForPlatform\(info\.assets\)/g)).toHaveLength(2);
  });

  test('does not offer the installer until its download stream has finished writing', () => {
    expect(main).toContain("destStream.on('finish'");
    expect(main).toContain('Downloaded installer is incomplete');
    expect(main).toContain('Downloaded installer is empty');
  });
});
