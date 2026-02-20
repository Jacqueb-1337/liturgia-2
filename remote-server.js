// Remote Control Server for Liturgia
// Provides LAN discovery and WebSocket-based remote control

const WebSocket = require('ws');
const { Bonjour } = require('bonjour-service');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');
const sudo = require('sudo-prompt');

class RemoteServer {
  constructor(app, mainWindow, onPairRequest) {
    this.app = app;
    this.mainWindow = mainWindow;
    this.onPairRequest = onPairRequest; // Callback for pairing approval
    this.wss = null;
    this.httpServer = null;
    this.bonjour = null;
    this.bonjourService = null;
    this.port = 39847; // Default port
    this.httpPort = 39848; // HTTP discovery port
    this.pairedDevices = new Map(); // deviceId -> { name, paired, lastSeen }
    this.pendingPairs = new Map(); // deviceId -> { name, ws, resolve, reject }
    this.clients = new Map(); // ws -> { deviceId, deviceName, authed }
    
    this.loadPairedDevices();
  }
  
  static addFirewallRules(wsPort, httpPort) {
    if (process.platform !== 'win32') {
      console.log('[remote] Firewall rules only needed on Windows');
      return Promise.resolve({ success: true, message: 'Not needed on this platform' });
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
      
      const options = {
        name: 'Liturgia Remote Control'
      };
      
      sudo.exec(commandString, options, (error, stdout, stderr) => {
        if (error) {
          console.error('[remote] Failed to add firewall rules:', error.message);
          resolve({ success: false, error: error.message });
        } else {
          console.log('[remote] Firewall rules added successfully');
          resolve({ success: true, message: 'Firewall rules added' });
        }
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
  
  start(port) {
    if (this.wss) {
      console.log('[remote] Server already running');
      return;
    }
    
    this.port = port || this.port;
    
    // Start WebSocket server with error handling for EADDRINUSE
    try {
      this.wss = new WebSocket.Server({ port: this.port });
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(`[remote] Port ${this.port} is already in use. Another Liturgia instance may still be running.`);
        console.error('[remote] Waiting 2 seconds and retrying...');
        this.wss = null;
        // Retry after delay
        setTimeout(() => {
          try {
            this.wss = new WebSocket.Server({ port: this.port });
            this.setupWebSocketHandlers();
            this.startServices();
          } catch (retryErr) {
            console.error('[remote] Failed to start WebSocket server after retry:', retryErr.message);
            this.wss = null;
          }
        }, 2000);
        return;
      }
      throw err;
    }
    
    this.setupWebSocketHandlers();
    this.startServices();
  }
  
  setupWebSocketHandlers() {
    if (!this.wss) return;
    
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
  
  startServices() {
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
    
    // Add firewall rules automatically (async, don't wait)
    // Only prompt for UAC if we haven't added rules before
    this.checkAndAddFirewallRules().catch(err => {
      console.error('[remote] Firewall rule setup failed:', err);
    });
    
    // Start HTTP discovery server for mobile clients
    this.startHttpDiscovery();
  }
  
  async checkAndAddFirewallRules() {
    // Check if we've already added firewall rules
    try {
      const settingsPath = path.join(this.app.getPath('userData'), 'settings.json');
      let  settings = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      
      if (settings.firewallRulesAdded) {
        console.log('[remote] Firewall rules already added, skipping UAC prompt');
        return;
      }
      
      // Add firewall rules and mark as added
      const result = await RemoteServer.addFirewallRules(this.port, this.httpPort);
      if (result.success) {
        settings.firewallRulesAdded = true;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
        console.log('[remote] Firewall rules added and marked in settings');
      }
    } catch (err) {
      console.error('[remote] Error checking/adding firewall rules:', err);
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
    // Simple HTTP server for discovery (browsers can't use mDNS)
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
      
      if (req.url === '/discover') {
        const addresses = this.getLocalIpAddresses();
        const info = {
          name: 'Liturgia Remote',
          version: this.app.getVersion(),
          wsPort: this.port,
          addresses: addresses
        };
        console.log('[remote] Sending discovery response:', JSON.stringify(info));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    
    this.httpServer.listen(this.httpPort, '0.0.0.0', () => {
      const addresses = this.getLocalIpAddresses();
      console.log('[remote] HTTP discovery server started on port', this.httpPort);
      console.log('[remote] Available on:', addresses.map(ip => `http://${ip}:${this.httpPort}/discover`).join(', '));
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
  
  handleMessage(ws, data) {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case 'PAIR_REQUEST':
          this.handlePairRequest(ws, msg);
          break;
          
        case 'COMMAND':
          this.handleCommand(ws, msg);
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
  
  handleCommand(ws, msg) {
    const client = this.clients.get(ws);
    if (!client || !client.authed) {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Not authenticated' }));
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
          data
        }));
      }
    }
  }
  
  getPairedDevices() {
    return Array.from(this.pairedDevices.entries()).map(([id, device]) => ({
      id,
      ...device
    }));
  }
}

module.exports = RemoteServer;
