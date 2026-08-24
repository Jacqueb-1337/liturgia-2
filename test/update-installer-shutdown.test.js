const fs = require('fs');
const path = require('path');

describe('in-app installer shutdown', () => {
  test('waits for Liturgia to exit before starting NSIS', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    expect(main).toContain('function launchInstallerAfterAppExit(file)');
    expect(main).toContain('Wait-Process -Id $parentPid');
    expect(main).toContain('Start-Process -FilePath $installer');
    expect(main).toContain('-PassThru -ErrorAction Stop');
    expect(main).toContain('installer disappeared before launch');
    expect(main).toContain('ERROR starting installer:');
    expect(main).toContain("process.env.SystemRoot || process.env.WINDIR || 'C:\\\\Windows'");
    expect(main).toContain('liturgia-update-launcher.log');
    expect(main).toContain("launcher.once('spawn'");
    expect(main).toContain('function quitForInstallerUpdate()');
    expect(main).toContain('app.exit(0);');
    expect(main).toMatch(/await launchInstallerAfterAppExit\(file\);\s+console\.log\('\[update\] Installer handoff scheduled/);
  });

  test('does not offer the installer until its download stream has finished writing', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    expect(main).toContain("destStream.on('finish'");
    expect(main).toContain('Downloaded installer is incomplete');
    expect(main).toContain('Downloaded installer is empty');
  });
});
