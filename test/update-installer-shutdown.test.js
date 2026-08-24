const fs = require('fs');
const path = require('path');

describe('in-app installer shutdown', () => {
  test('waits for Liturgia to exit before starting NSIS and proves helper startup before quitting', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    expect(main).toContain('async function launchInstallerAfterAppExit(file)');
    expect(main).toContain('liturgia-update-launcher.log');
    expect(main).toContain('liturgia-update-launch-');
    expect(main).toContain('tasklist /FI "PID eq %PARENT_PID%"');
    expect(main).toContain('installer disappeared before launch');
    expect(main).toContain('const openError = await shell.openPath(helperPath);');
    expect(main).toContain('const readyDeadline = Date.now() + 2000;');
    expect(main).toContain('Installer helper confirmed running; safe to quit Liturgia');
    expect(main).toContain('Installer helper did not start; Liturgia was left open.');
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
