const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

class RelayClient extends EventEmitter {
  constructor(relayUrl, token) {
    super();
    this.phpBaseUrl = relayUrl || 'https://jacqueb.me/liturgia/relay';
    this.wsUrl = process.env.RELAY_WS_URL || 'ws://apiliturgia.jacqueb.me:41829';
    this.token = token;
    this.sessionId = null;
    this.clientType = 'desktop';
    this.deviceName = 'Liturgia Desktop';
    
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.useWebSocket = true;
    this.phpPollTimer = null;
    this.lastMessageId = 0;
    this.heartbeatInterval = null;
    this.pendingState = null;
  }

  async register(deviceName = 'Liturgia Desktop') {
    try {
      this.deviceName = deviceName;
      console.log('[relay] Attempting registration to:', this.phpBaseUrl);
      console.log('[relay] Device name:', deviceName);
      
      const result = await this.phpRequest('POST', '/register.php', {
        token: this.token,
        device_name: deviceName
      });
      
      if (result.ok) {
        this.sessionId = result.session_id;
        console.log('[relay] Registered session:', this.sessionId);
        
        if (this.useWebSocket) {
          this.connectWebSocket();
        } else {
          this.startPhpPolling();
        }
        
        this.startHeartbeat();
        this.emit('connected', { sessionId: this.sessionId });
        return true;
      } else {
        throw new Error(result.error || 'Registration failed');
      }
    } catch (err) {
      console.error('[relay] Registration error:', err);
      this.emit('error', err);
      return false;
    }
  }

  connectWebSocket() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('[RelayWS] Already connected');
      return;
    }
    
    if (this.ws) {
      console.log('[RelayWS] Closing stale WebSocket');
      this.ws.close();
      this.ws = null;
    }

    const wsUrl = `${this.wsUrl}?token=${encodeURIComponent(this.token)}&session_id=${encodeURIComponent(this.sessionId)}&client_type=${this.clientType}`;
    
    console.log('[RelayWS] Connecting to WebSocket...');
    
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[RelayWS] Connected via WebSocket');
        this.reconnectDelay = 1000;
        this.emit('connection-method', 'WebSocket');
        if (this.pendingState) {
          console.log('[RelayWS] Flushing queued state after reconnect');
          this.ws.send(JSON.stringify(this.pendingState));
          this.pendingState = null;
        }
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log('[RelayWS] Received:', message.type);
          
          if (message.type === 'command' || message.type === 'state') {
            this.emit('message', message.data || message);
          } else if (message.type === 'connected') {
            console.log('[RelayWS] Server confirmed connection:', message.clientType);
          }
        } catch (err) {
          console.error('[RelayWS] Parse error:', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[RelayWS] Disconnected: ${code} ${reason}`);
        this.ws = null;
        
        if (code === 1008) {
          console.log('[RelayWS] Auth failed, falling back to PHP');
          this.fallbackToPhp();
        } else {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        console.error('[RelayWS] Error:', err.message);
        const fallbackCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT']);
        if (fallbackCodes.has(err.code) || /socket hang up/i.test(err.message || '')) {
          console.log('[RelayWS] Server unavailable, falling back to PHP');
          this.fallbackToPhp();
        }
      });
    } catch (err) {
      console.error('[RelayWS] Connection failed:', err);
      this.fallbackToPhp();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    console.log(`[RelayWS] Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connectWebSocket();
    }, this.reconnectDelay);
  }

  fallbackToPhp() {
    console.log('[RelayWS] Temporarily using PHP polling, will retry WebSocket');
    this.ws = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.startPhpPolling();
    
    setTimeout(() => {
      if (this.useWebSocket && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
        console.log('[RelayWS] Retrying WebSocket connection...');
        this.stopPhpPolling();
        this.connectWebSocket();
      }
    }, 60000);
  }

  stopPhpPolling() {
    if (this.phpPollTimer) {
      clearTimeout(this.phpPollTimer);
      this.phpPollTimer = null;
      console.log('[RelayWS] Stopped PHP polling');
    }
  }

  startPhpPolling() {
    if (this.phpPollTimer) return;
    
    console.log('[RelayWS] Starting PHP polling fallback');
    this.emit('connection-method', 'PHP Polling');
    
    const poll = () => {
      const direction = this.clientType === 'desktop' ? 'to_desktop' : 'to_mobile';
      const body = JSON.stringify({
        session_id: this.sessionId,
        direction: direction,
        last_id: this.lastMessageId,
        token: this.token
      });

      const req = https.request(`${this.phpBaseUrl}/poll.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': this.token,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.messages && result.messages.length > 0) {
              result.messages.forEach(msg => {
                this.lastMessageId = Math.max(this.lastMessageId, msg.id);
                this.emit('message', msg.message);
              });
            }
          } catch (err) {
            console.error('[RelayWS] PHP poll parse error:', err);
          }
          
          this.phpPollTimer = setTimeout(poll, 500);
        });
      });

      req.on('error', (err) => {
        console.error('[RelayWS] PHP poll error:', err.message);
        this.phpPollTimer = setTimeout(poll, 2000);
      });

      req.on('timeout', () => {
        req.destroy();
        this.phpPollTimer = setTimeout(poll, 2000);
      });

      req.write(body);
      req.end();
    };

    poll();
  }

  sendToMobile(message) {
    if (!this.sessionId) {
      console.warn('[relay] Not connected, cannot send message');
      return Promise.resolve(false);
    }

    const commandMessage = {
      type: 'command',
      data: message
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('[RelayWS] Sending via WebSocket:', message.command || 'message');
      this.ws.send(JSON.stringify(commandMessage));
      return Promise.resolve(true);
    } else {
      console.log('[RelayWS] Sending via PHP:', message.command || 'message');
      return this.sendViaPhp('to_mobile', message);
    }
  }

  async pushState(state) {
    if (!this.sessionId) {
      console.warn('[relay] Not connected, cannot push state');
      return false;
    }

    const stateMessage = {
      type: 'state',
      state: state
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(stateMessage));
      return true;
    } else {
      this.pendingState = stateMessage;
      console.log('[RelayWS] WS not connected — state queued, will send on reconnect');
      return false;
    }
  }

  stop() {
    console.log('[relay] Stopping relay client');
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.phpPollTimer) {
      clearTimeout(this.phpPollTimer);
      this.phpPollTimer = null;
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    if (this.sessionId) {
      this.phpRequest('POST', '/deregister.php', {
        token: this.token,
        session_id: this.sessionId
      }).catch(err => {
        console.warn('[relay] Deregister failed:', err.message);
      });
    }
    
    this.sessionId = null;
    this.emit('disconnected');
  }

  startHeartbeat() {
    if (this.heartbeatInterval) return;
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.log('[relay] Heartbeat skipped - WebSocket connected');
        return;
      }
      
      if (this.sessionId) {
        this.phpRequest('POST', '/heartbeat.php', {
          token: this.token,
          session_id: this.sessionId
        }).catch(err => {
          if (err.message && err.message.includes('Session not found')) {
            console.warn('[relay] Session expired, re-registering...');
            if (this.ws) {
              console.log('[relay] Closing old WebSocket before re-register');
              this.ws.close();
              this.ws = null;
            }
            this.sessionId = null;
            this.register(this.deviceName);
          }
        });
      }
    }, 30000);
  }

  sendViaPhp(direction, message) {
    if (!this.sessionId) {
      return Promise.resolve(false);
    }
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        session_id: this.sessionId,
        direction: direction,
        message: message
      });

      const req = https.request(`${this.phpBaseUrl}/send.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': this.token,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.ok) {
              resolve(result);
            } else {
              reject(new Error(result.error || 'Unknown error'));
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  updateState(state) {
    return this.phpRequest('POST', '/state.php', {
      token: this.token,
      session_id: this.sessionId,
      state: state
    });
  }

  async phpRequest(method, path, data = null, timeout = 10000, quiet = false) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.phpBaseUrl + path);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        method: method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        timeout: timeout
      };

      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              const log = quiet ? console.warn : console.error;
              log('[relay] Request failed:', {
                status: res.statusCode,
                path: path,
                response: json
              });
              reject(new Error(json.error || `HTTP ${res.statusCode}`));
            }
          } catch (err) {
            console.error('[relay] Invalid JSON response:', {
              status: res.statusCode,
              path: path,
              body: body.substring(0, 500)
            });
            reject(new Error('Invalid JSON response: ' + body.substring(0, 100)));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (data) {
        req.write(JSON.stringify(data));
      }
      
      req.end();
    });
  }

  disconnect() {
    this.stop();
  }
}

module.exports = RelayClient;
