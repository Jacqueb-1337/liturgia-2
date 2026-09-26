const {
  ensureProgramFirewall,
  normalizePort,
  buildFirewallCheckScript,
  buildFirewallInstallScript
} = require('../lib/streamFirewall');

describe('Liturgia Stream Program firewall', () => {
  test('accepts only non-reserved TCP ports', () => {
    expect(normalizePort(7777)).toBe(7777);
    expect(() => normalizePort(80)).toThrow(RangeError);
    expect(() => normalizePort(65536)).toThrow(RangeError);
    expect(() => normalizePort('abc')).toThrow(RangeError);
  });

  test('limits both firewall rules to the app and local Private network', () => {
    const script = buildFirewallInstallScript(7777, 'C:\\Program Files\\Liturgia\\Liturgia.exe');
    expect(script).toContain('-Protocol TCP -LocalPort 7777');
    expect(script).toContain('-Protocol UDP -LocalPort 5353');
    expect(script.match(/-Profile Private/g)).toHaveLength(2);
    expect(script.match(/-RemoteAddress LocalSubnet/g)).toHaveLength(2);
    expect(script.match(/-Program 'C:\\Program Files\\Liturgia\\Liturgia.exe'/g)).toHaveLength(2);
  });

  test('verifies app, port, profile, and subnet scope before skipping elevation', async () => {
    const execFileImpl = jest.fn((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({ checked: true, active: true }), '');
    });
    const result = await ensureProgramFirewall(7777, 'C:\\Liturgia.exe', {
      platform: 'win32',
      execFileImpl
    });
    expect(result).toMatchObject({ success: true, active: true });
    expect(execFileImpl).toHaveBeenCalledTimes(1);
    expect(buildFirewallCheckScript(7777, 'C:\\Liturgia.exe')).toContain('LocalSubnet');
  });

  test('does not run Windows commands on other platforms', async () => {
    const execFileImpl = jest.fn();
    const result = await ensureProgramFirewall(7777, '/opt/liturgia', {
      platform: 'linux',
      execFileImpl
    });
    expect(result).toMatchObject({ success: true, managed: false });
    expect(execFileImpl).not.toHaveBeenCalled();
  });
});

