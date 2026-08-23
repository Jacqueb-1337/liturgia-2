// Remote Control Server for Liturgia
// Provides LAN discovery and WebSocket-based remote control

const WebSocket = require('ws');
const { Bonjour } = require('bonjour-service');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const fetch = require('node-fetch');
const { execFile } = require('child_process');

class RemoteServer {
  constructor(app, mainWindow, onPairRequest, getDesktopAuthToken = null) {
    this.app = app;
    this.mainWindow = mainWindow;
    this.onPairRequest = onPairRequest; // Callback for pairing approval
    this.getDesktopAuthToken = getDesktopAuthToken;
    this.wss = null;
    this.httpServer = null;
    this.bonjour = null;
    this.bonjourService = null;
    this.port = 39847; // Default port
    this.httpPort = 39848; // HTTP discovery port
    this.lastError = null;
    this.pairedDevices = new Map(); // deviceId -> { name, paired, lastSeen }
    this.pendingPairs = new Map(); // deviceId -> { name, ws, resolve, reject }
    this.clients = new Map(); // ws -> { deviceId, deviceName, authed }
    
    this.loadPairedDevices();
  }

  static accessStorePath(app) {
    return path.join(app.getPath('userData'), 'remote-access.json');
  }

  static permissionFeatures() {
    return ['live', 'verses', 'songs', 'bible', 'schedule', 'settings'];
  }

  static normalizePermissions(input, fallback = 'none') {
    const source = input && typeof input === 'object' ? input : {};
    const permissions = {};
    for (const feature of RemoteServer.permissionFeatures()) {
      const value = source[feature];
      permissions[feature] = value === 'change' || value === 'view' || value === 'none' ? value : fallback;
    }
    return permissions;
  }

  static fullPermissions() {
    return RemoteServer.normalizePermissions({}, 'change');
  }

  static permissionDefinitions() {
    return [
      'songs.view', 'songs.edit',
      'verses.view', 'verses.select',
      'presentation.view', 'presentation.goLiveSongs', 'presentation.goLiveVerses', 'presentation.clear', 'presentation.black',
      'bible.view', 'bible.changeTranslation',
      'schedule.view', 'schedule.edit', 'schedule.goLive',
      'settings.view', 'settings.open',
      'accounts.view', 'accounts.manageDelegates', 'accounts.manageRoles'
    ];
  }

  static roleGrants(role) {
    const grants = Object.fromEntries(RemoteServer.permissionDefinitions().map((key) => [key, false]));
    const allow = (...keys) => keys.forEach((key) => { grants[key] = true; });
    if (role === 'admin') {
      allow(...RemoteServer.permissionDefinitions());
    } else if (role === 'moderator') {
      allow('songs.view', 'verses.view', 'verses.select', 'presentation.view', 'presentation.goLiveSongs', 'presentation.goLiveVerses', 'presentation.clear', 'presentation.black', 'bible.view', 'schedule.view', 'schedule.edit', 'schedule.goLive');
    } else if (role === 'operator') {
      allow('songs.view', 'verses.view', 'verses.select', 'presentation.view', 'presentation.goLiveSongs', 'presentation.goLiveVerses', 'presentation.clear', 'presentation.black', 'bible.view', 'schedule.view', 'schedule.goLive');
    } else {
      allow('songs.view', 'verses.view', 'presentation.view', 'bible.view', 'schedule.view', 'settings.view');
    }
    return grants;
  }

  static normalizeGrantOverrides(input) {
    const source = input && typeof input === 'object' ? input : {};
    return Object.fromEntries(RemoteServer.permissionDefinitions().map((key) => [
      key,
      source[key] === 'allow' || source[key] === 'deny' ? source[key] : 'inherit'
    ]));
  }

  static effectiveGrants(user) {
    if (user && user.permissionOverrides) {
      const grants = RemoteServer.roleGrants(user.role || 'guest');
      const overrides = RemoteServer.normalizeGrantOverrides(user.permissionOverrides);
      for (const key of RemoteServer.permissionDefinitions()) {
        if (overrides[key] === 'allow') grants[key] = true;
        if (overrides[key] === 'deny') grants[key] = false;
      }
      return grants;
    }
    // Backward compatibility for early role records that used broad levels.
    const legacy = RemoteServer.effectivePermissions(user || {});
    return {
      'songs.view': legacy.songs !== 'none', 'songs.edit': legacy.songs === 'change',
      'verses.view': legacy.verses !== 'none', 'verses.select': legacy.verses === 'change',
      'presentation.view': legacy.live !== 'none', 'presentation.goLiveSongs': legacy.live === 'change', 'presentation.goLiveVerses': legacy.live === 'change', 'presentation.clear': legacy.live === 'change', 'presentation.black': legacy.live === 'change',
      'bible.view': legacy.bible !== 'none', 'bible.changeTranslation': legacy.bible === 'change',
      'schedule.view': legacy.schedule !== 'none', 'schedule.edit': legacy.schedule === 'change', 'schedule.goLive': legacy.schedule === 'change',
      'settings.view': legacy.settings !== 'none', 'settings.open': legacy.settings === 'change'
    };
  }

  static presentationPermissionsFromGrants(grants) {
    const viewOrNone = (key) => grants[key] ? 'view' : 'none';
    const changeOrView = (viewKey, changeKey) => grants[changeKey] ? 'change' : viewOrNone(viewKey);
    return {
      live: changeOrView('presentation.view', 'presentation.goLiveVerses') || viewOrNone('presentation.view'),
      verses: changeOrView('verses.view', 'verses.select'),
      songs: changeOrView('songs.view', 'songs.edit'),
      bible: grants['bible.changeTranslation'] ? 'change' : viewOrNone('bible.view'),
      schedule: grants['schedule.edit'] || grants['schedule.goLive'] ? 'change' : viewOrNone('schedule.view'),
      settings: grants['settings.open'] ? 'change' : viewOrNone('settings.view'),
      accounts: grants['accounts.manageDelegates'] || grants['accounts.manageRoles'] ? 'change' : viewOrNone('accounts.view')
    };
  }

  static rolePermissions(role) {
    const roles = {
      admin:     { live: 'change', verses: 'change', songs: 'change', bible: 'change', schedule: 'change', settings: 'change' },
      moderator: { live: 'change', verses: 'change', songs: 'change', bible: 'view',   schedule: 'change', settings: 'none' },
      operator:  { live: 'change', verses: 'change', songs: 'change', bible: 'view',   schedule: 'view',   settings: 'none' },
      guest:     { live: 'view',   verses: 'view',   songs: 'view',   bible: 'view',   schedule: 'view',   settings: 'none' }
    };
    return RemoteServer.normalizePermissions(roles[role] || roles.guest);
  }

  static normalizePermissionOverrides(input) {
    const source = input && typeof input === 'object' ? input : {};
    const overrides = {};
    for (const feature of RemoteServer.permissionFeatures()) {
      const value = source[feature];
      overrides[feature] = value === 'none' || value === 'view' || value === 'change' ? value : 'inherit';
    }
    return overrides;
  }

  static effectivePermissions(user) {
    if (user && user.permissionOverrides) {
      return RemoteServer.presentationPermissionsFromGrants(RemoteServer.effectiveGrants(user));
    }
    // Migrate early local-user records that predate role inheritance without
    // silently changing the permissions that were already assigned.
    if (user && !user.role && user.permissions && !user.overrides) {
      return RemoteServer.normalizePermissions(user.permissions);
    }
    const base = RemoteServer.rolePermissions(user && user.role);
    const overrides = RemoteServer.normalizePermissionOverrides(user && user.overrides);
    for (const feature of RemoteServer.permissionFeatures()) {
      if (overrides[feature] !== 'inherit') base[feature] = overrides[feature];
    }
    return base;
  }

  static readAccessStore(app) {
    try {
      const raw = fs.readFileSync(RemoteServer.accessStorePath(app), 'utf8');
      const parsed = JSON.parse(raw);
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        accountUsers: Array.isArray(parsed.accountUsers) ? parsed.accountUsers : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
      };
    } catch (_) {
      return { users: [], accountUsers: [], sessions: [] };
    }
  }

  static writeAccessStore(app, store) {
    const file = RemoteServer.accessStorePath(app);
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(temp, file);
  }

  static listCredentialUsers(app) {
    return RemoteServer.readAccessStore(app).users.map((user) => ({
      id: user.id,
      username: user.username,
      role: ['admin', 'moderator', 'operator', 'guest'].includes(user.role) ? user.role : 'guest',
      overrides: RemoteServer.normalizeGrantOverrides(user.permissionOverrides),
      grants: RemoteServer.effectiveGrants(user),
      permissions: RemoteServer.effectivePermissions(user),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }));
  }

  static listLiturgiaUsers(app) {
    return RemoteServer.readAccessStore(app).accountUsers.map((user) => ({
      id: user.id,
      email: user.email,
      role: ['admin', 'moderator', 'operator', 'guest'].includes(user.role) ? user.role : 'guest',
      overrides: RemoteServer.normalizeGrantOverrides(user.permissionOverrides),
      grants: RemoteServer.effectiveGrants(user),
      permissions: RemoteServer.effectivePermissions(user),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }));
  }

  static saveLiturgiaUser(app, input = {}, allowedEmails = [], ownerEmail = '') {
    const email = String(input.email || '').trim().toLowerCase();
    const id = input.id ? String(input.id) : null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid Liturgia email address.');
    const allowed = new Set((allowedEmails || []).map((value) => String(value || '').trim().toLowerCase()));
    if (!allowed.has(email)) throw new Error('This email is not part of this Liturgia account. Add it under Account Access first.');
    if (email === String(ownerEmail || '').trim().toLowerCase()) throw new Error('The root Liturgia account is always full access and cannot be changed.');
    const store = RemoteServer.readAccessStore(app);
    const existing = id ? store.accountUsers.find((user) => user.id === id) : store.accountUsers.find((user) => user.email === email);
    const now = new Date().toISOString();
    const user = existing || { id: crypto.randomUUID(), createdAt: now };
    user.email = email;
    user.role = ['admin', 'moderator', 'operator', 'guest'].includes(input.role) ? input.role : (existing && existing.role) || 'guest';
    user.permissionOverrides = RemoteServer.normalizeGrantOverrides(input.permissionOverrides || input.overrides);
    delete user.overrides;
    delete user.permissions;
    user.updatedAt = now;
    if (!existing) store.accountUsers.push(user);
    RemoteServer.writeAccessStore(app, store);
    return { id: user.id, email: user.email, role: user.role, overrides: user.permissionOverrides, grants: RemoteServer.effectiveGrants(user), permissions: RemoteServer.effectivePermissions(user), createdAt: user.createdAt, updatedAt: user.updatedAt };
  }

  static deleteLiturgiaUser(app, id) {
    const store = RemoteServer.readAccessStore(app);
    const originalLength = store.accountUsers.length;
    store.accountUsers = store.accountUsers.filter((user) => user.id !== id);
    if (store.accountUsers.length === originalLength) return false;
    store.sessions = store.sessions.filter((session) => session.accountUserId !== id);
    RemoteServer.writeAccessStore(app, store);
    return true;
  }

  static saveCredentialUser(app, input = {}) {
    const username = String(input.username || '').trim();
    const password = typeof input.password === 'string' ? input.password : '';
    const id = input.id ? String(input.id) : null;
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
      throw new Error('Username must be 3–64 characters using letters, numbers, periods, underscores, or hyphens.');
    }
    const store = RemoteServer.readAccessStore(app);
    const existing = id ? store.users.find((user) => user.id === id) : null;
    if (!existing && password.length < 10) {
      throw new Error('New users need a password of at least 10 characters.');
    }
    if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase() && user.id !== id)) {
      throw new Error('That username is already in use.');
    }
    const now = new Date().toISOString();
    const user = existing || { id: crypto.randomUUID(), createdAt: now };
    user.username = username;
    user.role = ['admin', 'moderator', 'operator', 'guest'].includes(input.role) ? input.role : (existing && existing.role) || 'guest';
    user.permissionOverrides = RemoteServer.normalizeGrantOverrides(input.permissionOverrides || input.overrides);
    delete user.overrides;
    delete user.permissions;
    user.updatedAt = now;
    if (password) {
      const salt = crypto.randomBytes(16).toString('hex');
      user.password = {
        salt,
        hash: crypto.scryptSync(password, salt, 64).toString('hex')
      };
    }
    if (!user.password) throw new Error('A password is required.');
    if (!existing) store.users.push(user);
    RemoteServer.writeAccessStore(app, store);
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      overrides: user.permissionOverrides,
      grants: RemoteServer.effectiveGrants(user),
      permissions: RemoteServer.effectivePermissions(user),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    };
  }

  static deleteCredentialUser(app, id) {
    const store = RemoteServer.readAccessStore(app);
    const originalLength = store.users.length;
    store.users = store.users.filter((user) => user.id !== id);
    if (store.users.length === originalLength) return false;
    store.sessions = store.sessions.filter((session) => session.userId !== id);
    RemoteServer.writeAccessStore(app, store);
    return true;
  }
  
  static addFirewallRules(wsPort, httpPort) {
    if (process.platform !== 'win32') {
      return Promise.resolve({ success: false, managed: false, message: `Liturgia cannot automatically change the ${process.platform === 'darwin' ? 'macOS' : 'Linux'} firewall. Allow inbound TCP ports ${wsPort} and ${httpPort} in the operating system firewall if it is enabled.` });
    }
    
    return new Promise((resolve) => {
      console.log('[remote] Adding Windows Firewall rules...');
      
      const commands = [
        `netsh advfirewall firewall delete rule name="Liturgia Remote WebSocket"`,
        `netsh advfirewall firewall delete rule name="Liturgia Remote Discovery"`,
        `netsh advfirewall firewall add rule name="Liturgia Remote WebSocket" dir=in action=allow protocol=TCP localport=${wsPort}`,
        `netsh advfirewall firewall add rule name="Liturgia Remote Discovery" dir=in action=allow protocol=TCP localport=${httpPort}`
      ];
      
      const commandString = commands.join(' & ');
      
      // Use Windows' native UAC mechanism instead of sudo-prompt. The latter
      // is not compatible with current Node releases used by Liturgia.
      const escapedCommand = commandString.replace(/'/g, "''");
      const script = `$process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c','${escapedCommand}') -Verb RunAs -Wait -PassThru; exit $process.ExitCode`;
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          const message = 'Windows permission was declined or the firewall rule could not be created.';
          console.error('[remote] Failed to add firewall rules:', error.message);
          resolve({ success: false, error: message });
        } else {
          console.log('[remote] Firewall rules added successfully');
          resolve({ success: true, message: 'Firewall rules added' });
        }
      });
    });
  }

  static firewallRulesActive(wsPort, httpPort) {
    if (process.platform !== 'win32') return Promise.resolve({ active: null, managed: false, message: `Firewall status is managed by ${process.platform === 'darwin' ? 'macOS' : 'Linux'}. If its firewall is enabled, allow inbound TCP ports ${wsPort} and ${httpPort}.` });
    // Return structured output and distinguish a confirmed missing rule from a
    // failed status check.  The old string comparison treated a PowerShell
    // access/module error as "missing", causing a UAC prompt on every launch.
    const script = "$ErrorActionPreference = 'Stop'; try { $names = @('Liturgia Remote WebSocket','Liturgia Remote Discovery'); $ports = @('" + wsPort + "','" + httpPort + "'); $ok = $true; for ($i = 0; $i -lt $names.Count; $i++) { $rule = @(Get-NetFirewallRule -DisplayName $names[$i] -ErrorAction Stop | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and ('' + $_.Enabled) -eq 'True' } | Select-Object -First 1); if (-not $rule) { $ok = $false; continue }; $filter = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop | Where-Object { ('' + $_.Protocol) -in @('TCP','6') -and ('' + $_.LocalPort) -eq $ports[$i] }); if (-not $filter) { $ok = $false } }; [PSCustomObject]@{ checked = $true; active = $ok } | ConvertTo-Json -Compress } catch { [PSCustomObject]@{ checked = $false; active = $null; error = $_.Exception.Message } | ConvertTo-Json -Compress }";
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        let result = null;
        try { result = JSON.parse(String(stdout || '').trim()); } catch (_) {}
        if (error || !result || result.checked !== true) {
          resolve({ active: null, checked: false, message: 'Liturgia could not verify the Windows Firewall rules. Use “Allow through Windows Firewall” if devices cannot connect.' });
          return;
        }
        const active = result.active === true;
        resolve({ active, checked: true, message: active ? 'Windows Firewall rules are active.' : 'Windows Firewall does not yet allow the browser remote ports.' });
      });
    });
  }
  
  loadPairedDevices() {
    try {
      const settingsPath = path.join(this.app.getPath('userData'), 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.remote && settings.remote.pairedDevices) {
          this.pairedDevices = new Map(Object.entries(settings.remote.pairedDevices));
          console.log('[remote] Loaded', this.pairedDevices.size, 'paired devices');
        }
      }
    } catch (e) {
      console.error('[remote] Error loading paired devices:', e);
    }
  }
  
  savePairedDevices() {
    try {
      const settingsPath = path.join(this.app.getPath('userData'), 'settings.json');
      let settings = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      if (!settings.remote) settings.remote = {};
      settings.remote.pairedDevices = Object.fromEntries(this.pairedDevices);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e) {
      console.error('[remote] Error saving paired devices:', e);
    }
  }
  
  async start(port) {
    if (this.wss) {
      console.log('[remote] Server already running');
      return { success: true, port: this.port, httpPort: this.httpPort, firewall: this.firewallStatus || null };
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('Choose a WebSocket port from 1024 through 65534.');
    this.port = port;
    this.httpPort = this.port + 1;
    try {
      await new Promise((resolve, reject) => {
        let server;
        const fail = (error) => {
          server.close();
          const prefix = error && error.code === 'EADDRINUSE' ? `Port ${this.port} is already in use.` : (error && error.code === 'EACCES' ? `Permission was denied for port ${this.port}.` : 'Could not open the WebSocket port.');
          reject(new Error(`${prefix} Choose a different Browser Remote port and try again.`));
        };
        server = new WebSocket.Server({ port: this.port, host: '0.0.0.0' }, () => {
          server.removeListener('error', fail);
          this.wss = server;
          resolve();
        });
        server.once('error', fail);
      });
      this.setupWebSocketHandlers();
      await this.startServices();
      this.lastError = null;
      return { success: true, port: this.port, httpPort: this.httpPort, firewall: this.firewallStatus };
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  
  setupWebSocketHandlers() {
    if (!this.wss) return;
    this.wss.on('error', (err) => {
      this.lastError = `Browser Remote WebSocket error: ${err.message}`;
      console.error('[remote]', this.lastError);
    });
    
    this.wss.on('connection', (ws) => {
      console.log('[remote] New WebSocket connection from', ws._socket.remoteAddress);
      
      ws.on('message', (data) => {
        console.log('[remote] Received message:', data.toString());
        this.handleMessage(ws, data);
      });
      
      ws.on('close', () => {
        const client = this.clients.get(ws);
        if (client) {
          console.log('[remote] Client disconnected:', client.deviceName);
          this.clients.delete(ws);
        }
      });
      
      ws.on('error', (err) => {
        console.error('[remote] WebSocket error:', err);
      });
    });
    
    console.log('[remote] WebSocket server started on port', this.port);
  }
  
  async startServices() {
    // Start mDNS advertisement
    this.bonjour = new Bonjour();
    this.bonjourService = this.bonjour.publish({
      name: 'Liturgia Remote',
      type: 'liturgia-remote',
      port: this.port,
      txt: {
        version: this.app.getVersion()
      }
    });
    
    console.log('[remote] mDNS service published');
    
    // Start HTTP discovery server for mobile clients
    await this.startHttpDiscovery();
    this.firewallStatus = await this.checkAndAddFirewallRules();
  }
  
  async checkAndAddFirewallRules() {
    try {
      const existing = await RemoteServer.firewallRulesActive(this.port, this.httpPort);
      if (existing.managed === false) return { success: true, active: null, managed: false, message: existing.message };
      if (existing.active) return { success: true, active: true, message: existing.message };
      if (existing.active === null) {
        // Do not show UAC merely because Windows could not answer the read-only
        // status query. The user can still request an explicit repair in Settings.
        return { success: false, active: null, managed: true, message: existing.message };
      }
      // Rules are checked against the active ports every time. This is vital
      // when the user changes the customizable Browser Remote port.
      const result = await RemoteServer.addFirewallRules(this.port, this.httpPort);
      if (result.success) {
        const verified = await RemoteServer.firewallRulesActive(this.port, this.httpPort);
        return { success: verified.active, active: verified.active, message: verified.active ? verified.message : 'Windows Firewall rules were added but could not be verified.' };
      }
      return { success: false, active: false, managed: true, message: result.error || result.message || 'Windows Firewall permission was not granted.' };
    } catch (err) {
      console.error('[remote] Error checking/adding firewall rules:', err);
      return { success: false, active: false, managed: process.platform === 'win32', message: err.message || 'Could not check the local firewall.' };
    }
  }
  
  getLocalIpAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal (loopback) and IPv6 addresses
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push(iface.address);
        }
      }
    }
    
    return addresses;
  }
  
  startHttpDiscovery() {
    // The browser remote is served locally so its WebSocket connection stays on
    // the LAN and never has to make a round trip through the cloud relay.
    const browserClientPath = path.join(__dirname, 'remote-browser.html');
    const desktopTemplatePath = path.join(__dirname, 'index.html');
    const manifestPath = path.join(__dirname, 'remote-web-manifest.json');
    const serviceWorkerPath = path.join(__dirname, 'remote-service-worker.js');
    const desktopStylesPath = path.join(__dirname, 'style.css');
    const remoteDesktopStylesPath = path.join(__dirname, 'remote-desktop.css');
    const searchBoxScriptPath = path.join(__dirname, 'searchBox.js');
    const styleWindowPath = path.join(__dirname, 'style-window.html');
    const dualIconPath = path.join(__dirname, 'dual.svg');
    const iconPath = path.join(__dirname, 'logo.png');
    this.httpServer = http.createServer((req, res) => {
      const clientIp = req.socket.remoteAddress;
      console.log('[remote] HTTP discovery request from:', clientIp);
      
      // Enable CORS for browser clients
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        fs.readFile(browserClientPath, 'utf8', (err, html) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Liturgia browser remote is not installed.');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY'
          });
          res.end(html);
        });
      } else if (url.pathname === '/desktop-template.html') {
        fs.readFile(desktopTemplatePath, 'utf8', (err, html) => {
          if (err) { res.writeHead(404); res.end(); return; }
          // Use the actual desktop DOM and styles, but omit Electron renderer code.
          const themeClass = this.getDarkThemeEnabled() ? 'dark-theme' : '';
          const browserHtml = html
            .replace(/<script\s+src="renderer\.js"><\/script>/i, '')
            .replace(/<body>/i, `<body class="${themeClass}">`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' });
          res.end(browserHtml);
        });
      } else if (url.pathname === '/searchBox.js') {
        fs.readFile(searchBoxScriptPath, 'utf8', (err, script) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          res.end(`const module = { exports: {} };\n${script}`);
        });
      } else if (url.pathname === '/remote-style-window.html') {
        fs.readFile(styleWindowPath, 'utf8', (err, html) => {
          if (err) { res.writeHead(404); res.end(); return; }
          const browserStyleWindow = html.replace(
            "const { ipcRenderer } = require('electron');",
            `const _remoteIpcListeners = {};
const _remoteOwnerWindow = () => window.opener && !window.opener.closed ? window.opener : null;
const _postToRemoteOwner = (message) => {
  const owner = _remoteOwnerWindow();
  if (owner) owner.postMessage(message, location.origin);
};
const ipcRenderer = {
  on(channel, handler) { _remoteIpcListeners[channel] = handler; },
  async invoke() { return {}; },
  send(channel, data) {
    if (channel === 'styles-changed') _postToRemoteOwner({ type: 'LITURGIA_REMOTE_STYLES_SAVE', styles: data });
  }
};
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || !event.data || event.data.type !== 'LITURGIA_REMOTE_STYLE_INIT') return;
  const handler = _remoteIpcListeners['style-window-init'];
  if (handler) handler({}, event.data.data || {});
});
window.addEventListener('pagehide', () => _postToRemoteOwner({ type: 'LITURGIA_REMOTE_STYLE_CLOSE' }));`
          );
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' });
          res.end(browserStyleWindow);
        });
      } else if (url.pathname === '/dual.svg') {
        fs.readFile(dualIconPath, (err, icon) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
          res.end(icon);
        });
      } else if (url.pathname === '/style.css' || url.pathname === '/remote-desktop.css') {
        const stylesheetPath = url.pathname === '/style.css' ? desktopStylesPath : remoteDesktopStylesPath;
        fs.readFile(stylesheetPath, 'utf8', (err, stylesheet) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          res.end(stylesheet);
        });
      } else if (url.pathname === '/remote-web-manifest.json') {
        fs.readFile(manifestPath, 'utf8', (err, manifest) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          res.end(manifest);
        });
      } else if (url.pathname === '/remote-service-worker.js') {
        fs.readFile(serviceWorkerPath, 'utf8', (err, script) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/', 'X-Content-Type-Options': 'nosniff' });
          res.end(script);
        });
      } else if (url.pathname === '/remote-icon.png') {
        fs.readFile(iconPath, (err, icon) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
          res.end(icon);
        });
      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, service: 'Liturgia Remote', wsPort: this.port }));
      } else if (url.pathname === '/discover') {
        const addresses = this.getLocalIpAddresses();
        const mode = this.getBrowserAccessMode();
        const info = {
          name: 'Liturgia Remote',
          version: this.app.getVersion(),
          wsPort: this.port,
          addresses,
          browserUrl: `http://${req.headers.host || 'localhost'}/`,
          browserAccess: mode
        };
        console.log('[remote] Sending discovery response:', JSON.stringify(info));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        this.httpServer = null;
        const prefix = error && error.code === 'EADDRINUSE' ? `Browser page port ${this.httpPort} is already in use.` : (error && error.code === 'EACCES' ? `Permission was denied for browser page port ${this.httpPort}.` : 'Could not open the browser page port.');
        reject(new Error(`${prefix} Choose a different Browser Remote port and try again.`));
      };
      this.httpServer.once('error', fail);
      this.httpServer.listen(this.httpPort, '0.0.0.0', () => {
        this.httpServer.removeListener('error', fail);
        this.httpServer.on('error', (error) => {
          this.lastError = `Browser Remote HTTP error: ${error.message}`;
          console.error('[remote]', this.lastError);
        });
        const addresses = this.getLocalIpAddresses();
        console.log('[remote] HTTP discovery server started on port', this.httpPort);
        console.log('[remote] Available on:', addresses.map(ip => `http://${ip}:${this.httpPort}/discover`).join(', '));
        resolve();
      });
    });
  }
  
  stop() {
    if (this.bonjourService) {
      this.bonjourService.stop();
      this.bonjourService = null;
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
    if (this.httpServer) {
      // A browser can keep an HTTP keep-alive connection open after loading
      // the remote page. Close it too so changing ports or stopping Liturgia
      // never leaves the old listener hanging around.
      if (typeof this.httpServer.closeIdleConnections === 'function') this.httpServer.closeIdleConnections();
      if (typeof this.httpServer.closeAllConnections === 'function') this.httpServer.closeAllConnections();
      this.httpServer.close();
      this.httpServer = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
    console.log('[remote] Server stopped');
  }
  
  async handleMessage(ws, data) {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case 'PAIR_REQUEST':
          await this.handlePairRequest(ws, msg);
          break;

        case 'AUTHENTICATE':
          await this.handleBrowserAuthentication(ws, msg);
          break;
          
        case 'COMMAND':
          await this.handleCommand(ws, msg);
          break;
          
        case 'SUBSCRIBE':
          this.handleSubscribe(ws, msg);
          break;
          
        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG' }));
          break;
          
        default:
          console.warn('[remote] Unknown message type:', msg.type);
      }
    } catch (e) {
      console.error('[remote] Error handling message:', e);
      ws.send(JSON.stringify({ type: 'ERROR', error: e.message }));
    }
  }
  
  async handlePairRequest(ws, msg) {
    const deviceId = msg.deviceId || crypto.randomUUID();
    const deviceName = msg.deviceName || 'Unknown Device';
    console.log('[remote] Pairing request from:', deviceName, 'ID:', deviceId);

    // Browsers use a separate, intentionally explicit access policy. The
    // legacy mobile client keeps its current desktop-approved pairing flow.
    if (msg.clientType === 'browser') {
      if (this.getBrowserAccessMode() === 'open') {
        this.authorizeClient(ws, deviceId, deviceName, 'open');
      } else {
        const restored = await this.authorizeStoredSession(ws, deviceId, deviceName, msg.sessionToken);
        if (!restored) ws.send(JSON.stringify({ type: 'AUTH_REQUIRED', deviceId, method: this.getBrowserAccessMode() }));
      }
      return;
    }
    
    // Check if already paired
    if (this.pairedDevices.has(deviceId)) {
      const device = this.pairedDevices.get(deviceId);
      if (device.revoked) {
        console.log('[remote] Device revoked:', deviceName);
        ws.send(JSON.stringify({ type: 'PAIR_REJECTED', reason: 'Device revoked' }));
        return;
      }
      
      // Already paired, auto-approve
      console.log('[remote] Auto-approving already paired device:', deviceName);
      // Already paired, auto-approve
      this.clients.set(ws, { deviceId, deviceName, authed: true });
      device.lastSeen = Date.now();
      ws.send(JSON.stringify({ 
        type: 'PAIR_APPROVED', 
        deviceId,
        alreadyPaired: true
      }));
      console.log('[remote] Known device reconnected:', deviceName);
      return;
    }
    
    // New device - show pairing request dialog
    console.log('[remote] Pairing request from:', deviceName);
    
    // Store pending pair and request approval via callback
    const pairPromise = new Promise((resolve, reject) => {
      this.pendingPairs.set(deviceId, { name: deviceName, ws, resolve, reject });
      
      // Call the pairing callback
      if (this.onPairRequest) {
        this.onPairRequest(deviceId, deviceName);
      }
      
      // Timeout after 60 seconds
      setTimeout(() => {
        if (this.pendingPairs.has(deviceId)) {
          reject(new Error('Pairing timeout'));
          this.pendingPairs.delete(deviceId);
        }
      }, 60000);
    });
    
    try {
      await pairPromise;
      // Approved!
      this.pairedDevices.set(deviceId, {
        name: deviceName,
        paired: Date.now(),
        lastSeen: Date.now(),
        revoked: false
      });
      this.savePairedDevices();
      this.clients.set(ws, { deviceId, deviceName, authed: true });
      ws.send(JSON.stringify({ type: 'PAIR_APPROVED', deviceId }));
      console.log('[remote] Device paired:', deviceName);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'PAIR_REJECTED', reason: e.message }));
      console.log('[remote] Pairing rejected:', deviceName);
    }
  }

  getBrowserAccessMode() {
    try {
      const settingsPath = path.join(this.app.getPath('userData'), 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const value = settings && settings.remote && settings.remote.browserAccess;
      if (value === 'open' || value === 'credentials' || value === 'liturgia') return value;
      return 'liturgia';
    } catch (_) {
      // Keep the safe, existing pairing-like behavior as the default.
      return 'liturgia';
    }
  }

  getDarkThemeEnabled() {
    try {
      const settingsPath = path.join(this.app.getPath('userData'), 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return typeof settings.darkTheme === 'boolean' ? settings.darkTheme : true;
    } catch (_) {
      // This matches the desktop's fresh-install default in main.js.
      return true;
    }
  }

  async handleBrowserAuthentication(ws, msg) {
    const deviceId = msg.deviceId || crypto.randomUUID();
    const deviceName = String(msg.deviceName || 'Browser remote').slice(0, 96);

    const mode = this.getBrowserAccessMode();
    if (mode === 'open') {
      this.authorizeClient(ws, deviceId, deviceName, 'open');
      return;
    }

    if (await this.authorizeStoredSession(ws, deviceId, deviceName, msg.sessionToken)) return;

    if (mode === 'credentials') {
      this.authenticateCredentials(ws, deviceId, deviceName, msg);
      return;
    }

    const suppliedToken = typeof msg.token === 'string' ? msg.token.trim() : '';
    if (!suppliedToken) {
      ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'A Liturgia sign-in token is required.' }));
      return;
    }

    try {
      const desktopToken = this.getDesktopAuthToken ? await this.getDesktopAuthToken() : null;
      if (!desktopToken) {
        ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'Sign in to Liturgia on this PC before requiring browser sign-in.' }));
        return;
      }

      const [browserAccount, desktopAccount] = await Promise.all([
        this.getAccountForToken(suppliedToken),
        this.getAccountForToken(desktopToken)
      ]);

      if (!browserAccount || !desktopAccount || browserAccount.accountEmail !== desktopAccount.accountEmail) {
        ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'This browser is not signed in to the same Liturgia account as this PC.' }));
        return;
      }

      const browserIdentity = browserAccount.identityEmail || (suppliedToken === desktopToken ? desktopAccount.accountEmail : null);
      if (!browserIdentity) {
        ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'This token was created before delegated roles were available. Request a new Liturgia sign-in link for this email, then try again.' }));
        return;
      }
      const roster = await this.listLiturgiaAccountUsers();
      const accountUser = roster.users.find((user) => user.email === browserIdentity);
      if (!accountUser) {
        ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'This Liturgia email no longer has access to this account.' }));
        return;
      }
      const isOwner = !!accountUser.isOwner;
      this.authorizeClient(ws, deviceId, deviceName, 'liturgia', browserIdentity, accountUser.grants, null, browserIdentity, null, accountUser.id, isOwner);
    } catch (err) {
      console.warn('[remote] Browser account authentication failed:', err.message || err);
      ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'Could not verify the Liturgia account. Check the connection and try again.' }));
    }
  }

  async getAccountForToken(token) {
    const response = await fetch('https://jacqueb.me/liturgia/auth/account-summary.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `token=${encodeURIComponent(token)}`,
      timeout: 8000
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const accountEmail = payload && payload.ok && payload.status && payload.status.email;
    const identityEmail = payload && payload.ok && (payload.identity_email || (payload.status && payload.status.identity_email));
    const normalizedAccount = accountEmail ? String(accountEmail).trim().toLowerCase() : null;
    if (!normalizedAccount) return null;
    return { accountEmail: normalizedAccount, identityEmail: identityEmail ? String(identityEmail).trim().toLowerCase() : null };
  }

  async listLiturgiaAccountUsers() {
    const desktopToken = this.getDesktopAuthToken ? await this.getDesktopAuthToken() : null;
    if (!desktopToken) throw new Error('Sign in to Liturgia on this PC first.');
    const owner = await this.getAccountForToken(desktopToken);
    if (!owner) throw new Error('Could not verify the Liturgia account.');
    const response = await fetch('https://jacqueb.me/liturgia/auth/delegated-emails.php', {
      headers: { Authorization: `Bearer ${desktopToken}` },
      timeout: 8000
    });
    if (!response.ok) throw new Error('Could not load delegated email addresses.');
    const payload = await response.json();
    let delegates = Array.isArray(payload && payload.delegates) ? payload.delegates : [];

    // One-time migration: preserve roles created by older desktop builds, but
    // only while the online record has never been edited.
    const localConfigured = new Map(RemoteServer.listLiturgiaUsers(this.app).map((user) => [user.email, user]));
    for (let index = 0; index < delegates.length; index++) {
      const remoteUser = delegates[index];
      const email = String(remoteUser.delegate_email || '').trim().toLowerCase();
      const localUser = localConfigured.get(email);
      if (!localUser || remoteUser.updated_at) continue;
      try {
        const migrated = await this.saveLiturgiaAccountUser({ email, role: localUser.role, permissionOverrides: localUser.overrides });
        delegates[index] = { ...remoteUser, ...migrated, delegate_email: email, permission_overrides: migrated.overrides, updated_at: migrated.updatedAt };
        const store = RemoteServer.readAccessStore(this.app);
        store.accountUsers = store.accountUsers.filter((entry) => entry.email !== email);
        RemoteServer.writeAccessStore(this.app, store);
      } catch (error) {
        console.warn('[remote] Could not migrate local delegated role for', email, error.message || error);
      }
    }

    const ownerGrants = RemoteServer.roleGrants('admin');
    const users = [{
      id: owner.accountEmail,
      email: owner.accountEmail,
      role: 'admin',
      overrides: RemoteServer.normalizeGrantOverrides({}),
      permissionOverrides: RemoteServer.normalizeGrantOverrides({}),
      grants: ownerGrants,
      permissions: RemoteServer.presentationPermissionsFromGrants(ownerGrants),
      isOwner: true
    }];
    delegates.forEach((entry) => {
      const email = String(entry.delegate_email || entry.email || '').trim().toLowerCase();
      if (!email) return;
      const role = ['admin', 'moderator', 'operator', 'guest'].includes(entry.role) ? entry.role : 'guest';
      const overrides = RemoteServer.normalizeGrantOverrides(entry.permission_overrides || entry.overrides);
      const grants = entry.grants && typeof entry.grants === 'object' ? entry.grants : RemoteServer.effectiveGrants({ role, permissionOverrides: overrides });
      users.push({ id: email, email, role, overrides, permissionOverrides: overrides, grants, permissions: RemoteServer.presentationPermissionsFromGrants(grants), isOwner: false, updatedAt: entry.updated_at || null });
    });
    return {
      ownerEmail: owner.accountEmail,
      users
    };
  }

  async saveLiturgiaAccountUser(input = {}) {
    const desktopToken = this.getDesktopAuthToken ? await this.getDesktopAuthToken() : null;
    if (!desktopToken) throw new Error('Sign in to Liturgia on this PC first.');
    const email = String(input.email || '').trim().toLowerCase();
    const role = ['admin', 'moderator', 'operator', 'guest'].includes(input.role) ? input.role : 'guest';
    const overrides = RemoteServer.normalizeGrantOverrides(input.permissionOverrides || input.overrides);
    const body = new URLSearchParams({ action: 'save_role', email, role, permission_overrides: JSON.stringify(overrides) });
    const response = await fetch('https://jacqueb.me/liturgia/auth/delegated-emails.php', {
      method: 'POST', headers: { Authorization: `Bearer ${desktopToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), timeout: 8000
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || !payload.user) throw new Error(payload.error || 'Could not save the delegated account role.');
    const user = payload.user;
    const normalizedOverrides = RemoteServer.normalizeGrantOverrides(user.permission_overrides || user.overrides);
    const grants = user.grants || RemoteServer.effectiveGrants({ role: user.role || role, permissionOverrides: normalizedOverrides });
    return { id: email, email, role: user.role || role, overrides: normalizedOverrides, permissionOverrides: normalizedOverrides, grants, permissions: RemoteServer.presentationPermissionsFromGrants(grants), isOwner: false, updatedAt: user.updated_at || null };
  }

  async resetLiturgiaAccountUser(email) {
    const desktopToken = this.getDesktopAuthToken ? await this.getDesktopAuthToken() : null;
    if (!desktopToken) throw new Error('Sign in to Liturgia on this PC first.');
    const normalized = String(email || '').trim().toLowerCase();
    const response = await fetch('https://jacqueb.me/liturgia/auth/delegated-emails.php', {
      method: 'POST', headers: { Authorization: `Bearer ${desktopToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'reset_role', email: normalized }).toString(), timeout: 8000
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'Could not reset the delegated account role.');
    return payload.user;
  }

  async updateLiturgiaDelegate(action, email) {
    const desktopToken = this.getDesktopAuthToken ? await this.getDesktopAuthToken() : null;
    if (!desktopToken) throw new Error('Sign in to Liturgia on this PC first.');
    const normalized = String(email || '').trim().toLowerCase();
    const response = await fetch('https://jacqueb.me/liturgia/auth/delegated-emails.php', {
      method: 'POST',
      headers: { Authorization: `Bearer ${desktopToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `action=${encodeURIComponent(action)}&email=${encodeURIComponent(normalized)}`,
      timeout: 8000
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'Could not update delegated email access.');
    if (action === 'remove') this.invalidateLiturgiaEmail(normalized);
    return this.listLiturgiaAccountUsers();
  }

  invalidateLiturgiaEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    const store = RemoteServer.readAccessStore(this.app);
    store.sessions = store.sessions.filter((session) => !(session.mode === 'liturgia' && session.email === normalized));
    RemoteServer.writeAccessStore(this.app, store);
    for (const [socket, client] of this.clients.entries()) {
      if (client.access === 'liturgia' && client.email === normalized) {
        socket.send(JSON.stringify({ type: 'REVOKED' }));
        socket.close();
      }
    }
  }

  authenticateCredentials(ws, deviceId, deviceName, msg) {
    const username = String(msg.username || '').trim();
    const password = typeof msg.password === 'string' ? msg.password : '';
    const store = RemoteServer.readAccessStore(this.app);
    const user = store.users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
    if (!user || !user.password || !password) {
      ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'Incorrect username or password.' }));
      return;
    }
    const expected = Buffer.from(user.password.hash, 'hex');
    const actual = crypto.scryptSync(password, user.password.salt, 64);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      ws.send(JSON.stringify({ type: 'AUTH_FAILED', error: 'Incorrect username or password.' }));
      return;
    }
    this.authorizeClient(ws, deviceId, deviceName, 'credentials', null, RemoteServer.effectiveGrants(user), user.id, user.username);
  }

  async authorizeStoredSession(ws, deviceId, deviceName, sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') return false;
    const mode = this.getBrowserAccessMode();
    const store = RemoteServer.readAccessStore(this.app);
    const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
    const session = store.sessions.find((candidate) =>
      candidate.deviceId === deviceId && candidate.tokenHash === tokenHash && candidate.mode === mode
    );
    if (!session) return false;
    const user = session.userId ? store.users.find((candidate) => candidate.id === session.userId) : null;
    if (session.userId && !user) return false;
    let clientGrants;
    let accountUserId = session.accountUserId || null;
    let isAccountOwner = !!session.isAccountOwner;
    if (user) {
      clientGrants = RemoteServer.effectiveGrants(user);
    } else if (mode === 'liturgia') {
      try {
        const roster = await this.listLiturgiaAccountUsers();
        const accountUser = roster.users.find((entry) => entry.email === session.email);
        if (!accountUser) return false;
        clientGrants = accountUser.grants;
        accountUserId = accountUser.id;
        isAccountOwner = !!accountUser.isOwner;
      } catch (error) {
        // Preserve an already-authorized LAN session during a temporary
        // Internet outage, using the last online permission snapshot.
        clientGrants = session.grants && typeof session.grants === 'object' ? session.grants : RemoteServer.roleGrants('guest');
      }
    } else {
      clientGrants = RemoteServer.roleGrants('admin');
    }
    session.lastSeen = new Date().toISOString();
    session.grants = clientGrants;
    session.accountUserId = accountUserId;
    session.isAccountOwner = isAccountOwner;
    RemoteServer.writeAccessStore(this.app, store);
    this.authorizeClient(
      ws,
      deviceId,
      deviceName,
      mode,
      session.email || null,
      clientGrants,
      session.userId || null,
      user ? user.username : null,
      sessionToken,
      accountUserId,
      isAccountOwner
    );
    return true;
  }

  createBrowserSession(deviceId, mode, email, userId, accountUserId = null, isAccountOwner = false, grants = null) {
    const token = crypto.randomBytes(32).toString('base64url');
    const store = RemoteServer.readAccessStore(this.app);
    store.sessions = store.sessions.filter((session) => session.deviceId !== deviceId);
    store.sessions.push({
      deviceId,
      mode,
      email: email || null,
      userId: userId || null,
      accountUserId: accountUserId || null,
      isAccountOwner: !!isAccountOwner,
      grants: grants && typeof grants === 'object' ? grants : null,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    });
    RemoteServer.writeAccessStore(this.app, store);
    return token;
  }

  authorizeClient(ws, deviceId, deviceName, access, email = null, grants = null, userId = null, username = null, existingSessionToken = null, accountUserId = null, isAccountOwner = false) {
    const now = Date.now();
    const existing = this.pairedDevices.get(deviceId) || {};
    const device = {
      ...existing,
      name: deviceName,
      paired: existing.paired || now,
      lastSeen: now,
      revoked: false,
      access,
      ...(email ? { email } : {}),
      ...(username ? { username } : {})
    };
    this.pairedDevices.set(deviceId, device);
    this.savePairedDevices();
    const clientGrants = grants || RemoteServer.roleGrants('admin');
    const clientPermissions = RemoteServer.presentationPermissionsFromGrants(clientGrants);
    const sessionToken = existingSessionToken || this.createBrowserSession(deviceId, access, email, userId, accountUserId, isAccountOwner, clientGrants);
    this.clients.set(ws, { deviceId, deviceName, authed: true, access, email, username, userId, accountUserId, isAccountOwner, grants: clientGrants, permissions: clientPermissions, subscriptions: [], lastRoleSync: Date.now() });
    ws.send(JSON.stringify({ type: 'AUTHENTICATED', deviceId, access, email, username, grants: clientGrants, permissions: clientPermissions, sessionToken }));
    console.log(`[remote] Browser authenticated (${access}):`, deviceName);
  }
  
  approvePairing(deviceId) {
    const pending = this.pendingPairs.get(deviceId);
    if (pending) {
      pending.resolve();
      this.pendingPairs.delete(deviceId);
      return true;
    }
    return false;
  }
  
  rejectPairing(deviceId) {
    const pending = this.pendingPairs.get(deviceId);
    if (pending) {
      pending.reject(new Error('User rejected pairing'));
      this.pendingPairs.delete(deviceId);
      return true;
    }
    return false;
  }
  
  revokeDevice(deviceId) {
    const device = this.pairedDevices.get(deviceId);
    if (device) {
      device.revoked = true;
      this.savePairedDevices();
      const store = RemoteServer.readAccessStore(this.app);
      store.sessions = store.sessions.filter((session) => session.deviceId !== deviceId);
      RemoteServer.writeAccessStore(this.app, store);
      
      // Disconnect if currently connected
      for (const [ws, client] of this.clients.entries()) {
        if (client.deviceId === deviceId) {
          ws.send(JSON.stringify({ type: 'REVOKED' }));
          ws.close();
        }
      }
      return true;
    }
    return false;
  }
  
  async handleCommand(ws, msg) {
    const client = this.clients.get(ws);
    if (!client || !client.authed) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Not authenticated' }));
      return;
    }
    if (!(await this.refreshLiturgiaClientGrants(ws, client))) return;
    
    const required = this.requiredPermissionForCommand(msg.command, msg.data);
    if (required && !this.hasPermission(client, required)) {
      ws.send(JSON.stringify({ type: 'FORBIDDEN', feature: required, command: msg.command }));
      return;
    }

    if (String(msg.command || '').startsWith('ACCOUNT_')) {
      try {
        await this.handleAccountCommand(ws, msg);
        ws.send(JSON.stringify({ type: 'COMMAND_ACK', commandId: msg.commandId }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'ACCOUNT_ERROR', error: err.message || 'Account action failed.' }));
      }
      return;
    }

    // Forward command to main window
    if (this.mainWindow && this.mainWindow.webContents) {
      this.mainWindow.webContents.send('remote-command', {
        deviceId: client.deviceId,
        deviceName: client.deviceName,
        command: msg.command,
        data: msg.data
      });
    }
    
    ws.send(JSON.stringify({ type: 'COMMAND_ACK', commandId: msg.commandId }));
  }

  async refreshLiturgiaClientGrants(ws, client) {
    if (!client || client.access !== 'liturgia' || client.isAccountOwner) return true;
    if (Date.now() - Number(client.lastRoleSync || 0) < 30000) return true;
    try {
      const roster = await this.listLiturgiaAccountUsers();
      const user = roster.users.find((entry) => entry.email === client.email);
      if (!user) {
        ws.send(JSON.stringify({ type: 'REVOKED' }));
        ws.close();
        return false;
      }
      client.grants = user.grants;
      client.permissions = user.permissions;
      client.accountUserId = user.id;
      client.lastRoleSync = Date.now();
      return true;
    } catch (error) {
      // The last online snapshot remains usable while the account service is
      // temporarily unreachable; retry on the next command.
      return true;
    }
  }

  async handleAccountCommand(ws, msg) {
    if (msg.command === 'ACCOUNT_GET') {
      ws.send(JSON.stringify({ type: 'ACCOUNT_ACCESS', ...(await this.listLiturgiaAccountUsers()) }));
      return;
    }
    if (msg.command === 'ACCOUNT_SAVE_ROLE') {
      const user = await this.saveLiturgiaAccountUser(msg.data || {});
      this.invalidateLiturgiaEmail(user.email);
      ws.send(JSON.stringify({ type: 'ACCOUNT_ACCESS', ...(await this.listLiturgiaAccountUsers()) }));
      return;
    }
    if (msg.command === 'ACCOUNT_RESET_ROLE') {
      const email = String(msg.data && (msg.data.email || msg.data.id) || '').trim().toLowerCase();
      if (!email) throw new Error('That role no longer exists.');
      await this.resetLiturgiaAccountUser(email);
      this.invalidateLiturgiaEmail(email);
      ws.send(JSON.stringify({ type: 'ACCOUNT_ACCESS', ...(await this.listLiturgiaAccountUsers()) }));
      return;
    }
    if (msg.command === 'ACCOUNT_UPDATE_DELEGATE') {
      const data = msg.data || {};
      const roster = await this.updateLiturgiaDelegate(data.action, data.email);
      ws.send(JSON.stringify({ type: 'ACCOUNT_ACCESS', ...roster }));
      return;
    }
    throw new Error('Unknown account action.');
  }
  
  handleSubscribe(ws, msg) {
    const client = this.clients.get(ws);
    if (!client || !client.authed) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Not authenticated' }));
      return;
    }
    
    client.subscriptions = msg.events || [];
    ws.send(JSON.stringify({ type: 'SUBSCRIBED', events: client.subscriptions }));
  }
  
  broadcastState(event, data) {
    for (const [ws, client] of this.clients.entries()) {
      if (client.authed && client.subscriptions && client.subscriptions.includes(event)) {
        ws.send(JSON.stringify({
          type: 'STATE_UPDATE',
          event,
          data: this.filterStateForClient(data, client)
        }));
      }
    }
  }

  hasPermission(client, permission) {
    if (permission && permission.includes('.')) return !!(client && client.grants && client.grants[permission]);
    const value = client && client.permissions && client.permissions[permission];
    return value === 'change' || value === 'view';
  }

  requiredPermissionForCommand(command, data = {}) {
    const permissions = {
      SELECT_VERSE: 'verses.select',
      LOOKUP_VERSES: 'verses.view',
      // Selection/preview is read-only.  Editing a song remains separately
      // protected by songs.edit, and sending it live by presentation.goLiveSongs.
      SELECT_SONG: 'songs.view',
      SELECT_SONG_VERSE: 'songs.view',
      DISPLAY_SONG_VERSE: 'presentation.goLiveSongs',
      UPSERT_SONG: 'songs.edit',
      DELETE_SONG: 'songs.edit',
      IMPORT_SONGS: 'songs.edit',
      CLEAR_LIVE: 'presentation.clear',
      BLACK_SCREEN: 'presentation.black',
      TOGGLE_WIDGET: 'presentation.goLiveSongs',
      NEXT_VERSE: 'verses.select',
      PREV_VERSE: 'verses.select',
      NEXT_SCHEDULE_ITEM: 'schedule.goLive',
      PREV_SCHEDULE_ITEM: 'schedule.goLive',
      ADD_TO_SCHEDULE: 'schedule.edit',
      ADD_SONG_TO_SCHEDULE: 'schedule.edit',
      GO_LIVE_SCHEDULE_ITEM: 'schedule.goLive',
      REORDER_SCHEDULE: 'schedule.edit',
      DELETE_SCHEDULE_ITEM: 'schedule.edit',
      CLEAR_SCHEDULE: 'schedule.edit',
      SET_BIBLE_TRANSLATION: 'bible.changeTranslation',
      OPEN_SETTINGS: 'settings.open',
      OPEN_STYLE_EDITOR: 'settings.open',
      UPDATE_STYLES: 'settings.open',
      ACCOUNT_GET: 'accounts.view',
      ACCOUNT_SAVE_ROLE: 'accounts.manageRoles',
      ACCOUNT_RESET_ROLE: 'accounts.manageRoles',
      ACCOUNT_UPDATE_DELEGATE: 'accounts.manageDelegates'
    };
    if (command === 'GO_LIVE') return data && data.contentType === 'song' ? 'presentation.goLiveSongs' : 'presentation.goLiveVerses';
    if (command === 'SELECT_VERSE' && data && data.goLive) return 'presentation.goLiveVerses';
    return permissions[command] || null;
  }

  filterStateForClient(data, client) {
    const state = data && typeof data === 'object' ? { ...data } : {};
    if (!this.hasPermission(client, 'verses.view')) {
      state.bible = [];
      state.verseRefs = [];
      state.verseResults = [];
      if (state.preview) state.preview.bible = [];
    }
    if (!this.hasPermission(client, 'songs.view')) {
      state.songs = [];
      state.allSongs = [];
      if (state.preview) state.preview.songs = [];
    }
    if (!this.hasPermission(client, 'schedule.view')) {
      state.schedule = [];
      state.allScheduleItems = [];
      state.scheduling = { totalItems: 0, currentItem: null, hasSchedule: false };
    }
    if (!this.hasPermission(client, 'bible.view') && !this.hasPermission(client, 'verses.view')) {
      state.verseMeta = { verseCounts: {}, bookNames: [] };
      state.bibleInfo = { current: null, available: [] };
    }
    if (!this.hasPermission(client, 'settings.open')) delete state.previewStyles;
    if (!this.hasPermission(client, 'presentation.view')) delete state.remoteCanvases;
    return state;
  }
  
  getPairedDevices() {
    return Array.from(this.pairedDevices.entries()).map(([id, device]) => ({
      id,
      ...device
    }));
  }
}

module.exports = RemoteServer;
