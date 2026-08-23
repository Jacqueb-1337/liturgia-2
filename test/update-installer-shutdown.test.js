const fs = require('fs');
const path = require('path');

describe('in-app installer shutdown', () => {
  test('waits for Liturgia to exit before starting NSIS', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    expect(main).toContain('function launchInstallerAfterAppExit(file)');
    expect(main).toContain('Wait-Process -Id $parentPid');
    expect(main).toContain('Start-Process -FilePath $installer');
    expect(main).toContain('function quitForInstallerUpdate()');
    expect(main).toContain('app.exit(0);');
    expect(main).toMatch(/launchInstallerAfterAppExit\(file\);\s+quitForInstallerUpdate\(\);/);
  });
});
