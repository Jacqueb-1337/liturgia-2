'use strict';

const { execFile } = require('child_process');

const PROGRAM_TCP_RULE = 'LiturgiaWorshipStreamProgramTcp';
const DISCOVERY_UDP_RULE = 'LiturgiaWorshipStreamDiscoveryUdp';

function normalizePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new RangeError('Stream Program port must be between 1024 and 65535.');
  }
  return value;
}

function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function buildFirewallCheckScript(port, programPath) {
  const tcpPort = normalizePort(port);
  const program = psLiteral(programPath);
  return `$ErrorActionPreference = 'Stop'
try {
  $specs = @(
    @{ Name = '${PROGRAM_TCP_RULE}'; Protocol = 'TCP'; Port = '${tcpPort}' },
    @{ Name = '${DISCOVERY_UDP_RULE}'; Protocol = 'UDP'; Port = '5353' }
  )
  $allActive = $true
  $checks = @()
  foreach ($spec in $specs) {
    $ruleActive = $false
    $rules = @(Get-NetFirewallRule -Name $spec.Name -ErrorAction SilentlyContinue)
    if ($rules.Count -eq 0) {
      $checks += [PSCustomObject]@{ name = $spec.Name; exists = $false; valid = $false }
    }
    foreach ($rule in $rules) {
      $baseOk = $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and
        $rule.Enabled -eq 'True' -and [string]$rule.Profile -eq 'Private'
      $portOk = @($rule | Get-NetFirewallPortFilter | Where-Object {
        [string]$_.Protocol -eq $spec.Protocol -and [string]$_.LocalPort -eq $spec.Port
      }).Count -gt 0
      $appOk = @($rule | Get-NetFirewallApplicationFilter | Where-Object {
        [string]$_.Program -ieq ${program}
      }).Count -gt 0
      $addresses = @($rule | Get-NetFirewallAddressFilter | ForEach-Object { $_.RemoteAddress })
      $addressOk = $addresses.Count -eq 1 -and [string]$addresses[0] -eq 'LocalSubnet'
      $valid = $baseOk -and $portOk -and $appOk -and $addressOk
      $checks += [PSCustomObject]@{ name = $spec.Name; exists = $true;
        ruleSettings = $baseOk; port = $portOk; program = $appOk;
        localSubnet = $addressOk; valid = $valid }
      if ($valid) { $ruleActive = $true }
    }
    if (-not $ruleActive) { $allActive = $false }
  }
  [PSCustomObject]@{ checked = $true; active = $allActive; checks = @($checks) } | ConvertTo-Json -Compress -Depth 4
} catch {
  [PSCustomObject]@{ checked = $false; active = $null; error = $_.Exception.Message } | ConvertTo-Json -Compress
}`;
}

function buildFirewallInstallScript(port, programPath) {
  const tcpPort = normalizePort(port);
  const program = psLiteral(programPath);
  return `$ErrorActionPreference = 'Stop'
try {
  Get-NetFirewallRule -Name '${PROGRAM_TCP_RULE}','${DISCOVERY_UDP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Name '${PROGRAM_TCP_RULE}' -DisplayName 'Liturgia Worship Stream Program' -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort ${tcpPort} -RemoteAddress LocalSubnet -Profile Private -Program ${program} -ErrorAction Stop | Out-Null
  New-NetFirewallRule -Name '${DISCOVERY_UDP_RULE}' -DisplayName 'Liturgia Worship Stream Discovery' -Direction Inbound -Action Allow -Enabled True -Protocol UDP -LocalPort 5353 -RemoteAddress LocalSubnet -Profile Private -Program ${program} -ErrorAction Stop | Out-Null
  exit 0
} catch {
  exit 1
}`;
}

function runPowerShell(script, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      timeout: 10000
    }, (error, stdout) => {
      let result = null;
      try { result = JSON.parse(String(stdout || '').trim()); } catch (_) {}
      if (error || !result || result.checked !== true) {
        resolve({ checked: false, active: null, message: 'Liturgia could not verify the Windows Firewall rules.' });
        return;
      }
      const checks = Array.isArray(result.checks) ? result.checks : [];
      const failures = checks.filter(check => !check.valid).map(check => {
        const problems = !check.exists ? ['rule missing'] : [
          !check.ruleSettings && 'rule settings',
          !check.port && 'protocol/port',
          !check.program && 'executable path',
          !check.localSubnet && 'network scope'
        ].filter(Boolean);
        return String(check.name || 'Firewall rule') + ': ' + problems.join(', ');
      });
      resolve({
        checked: true,
        active: result.active === true,
        checks,
        message: result.active === true
          ? 'Windows allows Stream on this Private network.'
          : 'Windows Firewall rule verification failed' +
            (failures.length ? ' (' + failures.join('; ') + ').' : '.')
      });
    });
  });
}

function checkProgramFirewall(port, programPath, options = {}) {
  normalizePort(port);
  if (options.platform && options.platform !== 'win32') {
    return Promise.resolve({ checked: true, active: true, managed: false, message: 'The operating system manages local-network access.' });
  }
  return runPowerShell(buildFirewallCheckScript(port, programPath), options);
}

function addProgramFirewallRules(port, programPath, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const installScript = buildFirewallInstallScript(port, programPath);
  const installEncoded = Buffer.from(installScript, 'utf16le').toString('base64');
  const elevatedScript = `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${installEncoded}') -Verb RunAs -Wait -PassThru; exit $process.ExitCode`;
  const elevatedEncoded = Buffer.from(elevatedScript, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', elevatedEncoded], {
      windowsHide: true,
      timeout: 60000
    }, (error) => {
      resolve(error
        ? { success: false, active: false, managed: true, message: 'Windows permission was declined or the firewall rules could not be created.' }
        : { success: true, active: null, managed: true, message: 'Windows Firewall rules were added.' });
    });
  });
}

async function ensureProgramFirewall(port, programPath = process.execPath, options = {}) {
  normalizePort(port);
  // The unpackaged Electron development executable is shared by unrelated
  // Electron apps. Never broaden or overwrite packaged Liturgia firewall rules
  // to authorize electron.exe, and do not report a misleading path mismatch.
  if (options.development === true) {
    return { success: true, active: null, checked: false, managed: false,
      message: 'Development Electron runs under a different executable; packaged Liturgia firewall rules are not checked in this session.' };
  }
  if (options.platform && options.platform !== 'win32') {
    return { success: true, active: null, managed: false, message: 'The operating system manages local-network access.' };
  }

  const before = await checkProgramFirewall(port, programPath, options);
  if (before.active === true) return { success: true, active: true, managed: true, message: before.message };
  if (before.checked !== true) {
    return { success: false, active: null, managed: true, message: before.message };
  }

  // A failed verification is not permission to elevate at application
  // startup (or when a display is enabled). Never run an administrator
  // PowerShell process unless the user explicitly requested a repair.
  if (options.allowElevation !== true) {
    return {
      success: false,
      active: false,
      managed: true,
      message: before.message + ' Network output can still run; use Allow on this network in Display Settings to repair the rules if connections fail.'
    };
  }

  const added = await addProgramFirewallRules(port, programPath, options);
  if (!added.success) return added;

  const after = await checkProgramFirewall(port, programPath, options);
  return after.active === true
    ? { success: true, active: true, managed: true, message: after.message }
    : { success: false, active: false, managed: true, message: 'Windows added the firewall rules, but Liturgia could not verify them.' };
}

module.exports = {
  ensureProgramFirewall,
  normalizePort,
  buildFirewallCheckScript,
  buildFirewallInstallScript
};

