// Cloud relay client for desktop app
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

class RelayClient extends EventEmitter {
  constructor(relayUrl, token) {
    super();
    this.relayUrl = relayUrl || 'https://jacqueb.me/liturgia/relay';
    this.token = token;
    this.sessionId = null;
    this.lastMessageId = 0;
    this.polling = false;
    this.heartbeatInterval = null;
    this.pollAbortController = null;
    this.deviceName = 'Liturgia Desktop';
  }

  async register(deviceName = 'Liturgia Desktop') {
    try {
      this.deviceName = deviceName;
      console.log('[relay] Attempting registration to:', this.relayUrl);
      console.log('[relay] Device name:', deviceName);
      console.log('[relay] Token length:', this.token ? this.token.length : 0);
      console.log('[relay] Token format:', this.token ? (this.token.split('.').length + ' parts') : 'none');
      
      const result = await this.request('POST', '/register.php', {
        token: this.token,
        device_name: deviceName
      });
      
      if (result.ok) {
        this.sessionId = result.session_id;
        console.log('[relay] Registered session:', this.sessionId);
        
        // Start polling and heartbeat
        this.startPolling();
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

  async sendToMobile(message) {
    if (!this.sessionId) {
      console.warn('[relay] Not connected, cannot send message');
      return false;
    }

    try {
      const result = await this.request('POST', '/send.php', {
        token: this.token,
        session_id: this.sessionId,
        direction: 'to_mobile',
        message: message
      });
      
      return result.ok;
    } catch (err) {
      console.error('[relay] Send error:', err);
      return false;
    }
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    this.poll();
  }

  async poll() {
    if (!this.polling || !this.sessionId) return;

    try {
      const result = await this.request('POST', '/poll.php', {
        token: this.token,
        session_id: this.sessionId,
        direction: 'to_desktop',
        last_id: this.lastMessageId
      }, 5000); // 5s timeout for faster response

      if (result.ok && result.messages && result.messages.length > 0) {
        for (const msg of result.messages) {
          this.lastMessageId = Math.max(this.lastMessageId, msg.id);
          console.log('[relay] Received message:', msg.message.command || msg.message);
          this.emit('message', msg.message);
        }
      }
    } catch (err) {
      // Timeout or network error, just retry
      if (err.code !== 'ETIMEDOUT' && err.code !== 'ECONNRESET') {
        console.error('[relay] Poll error:', err.message);
      }
    }

    // Re-poll with 500ms delay for responsive command execution
    if (this.polling) {
      setTimeout(() => this.poll(), 500);
    }
  }

  startHeartbeat() {
    if (this.heartbeatInterval) return;
    
    // Send heartbeat every 30 seconds to keep session alive
    this.heartbeatInterval = setInterval(() => {
      if (this.sessionId) {
        console.log('[relay] Sending heartbeat for session:', this.sessionId.substring(0, 8) + '...');
        this.request('POST', '/heartbeat.php', {
          token: this.token,
          session_id: this.sessionId
        }, 10000, true).catch(err => {
          // If session expired on the server, re-register to get a new session
          if (err.message && (err.message.includes('Session not found') || err.message.includes('HTTP 404'))) {
            console.warn('[relay] Session expired, re-registering...');
            this.sessionId = null;
            this.register(this.deviceName).catch(e => console.warn('[relay] Re-registration failed:', e.message));
          } else {
            console.warn('[relay] Heartbeat failed:', err.message);
          }
        });
      }
    }, 30000);
  }

  async pushState(state) {
    if (!this.sessionId) {
      console.warn('[relay] Not connected, cannot push state');
      return false;
    }

    try {
      const result = await this.request('POST', '/update-state.php', {
        token: this.token,
        session_id: this.sessionId,
        state: state
      });
      
      if (result.ok) {
        console.log('[relay] State pushed successfully');
        return true;
      } else {
        console.error('[relay] State push failed:', result.error);
        return false;
      }
    } catch (err) {
      console.error('[relay] State push error:', err);
      return false;
    }
  }

  stop() {
    this.polling = false;
    console.log('[relay] Stopping relay client, deregistering session:', this.sessionId);
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Attempt to deregister before stopping (this may fail if network is already down)
    if (this.sessionId) {
      this.request('POST', '/deregister.php', {
        token: this.token,
        session_id: this.sessionId
      }).catch(err => {
        console.warn('[relay] Deregister failed (may be network issue):', err.message);
      });
    }
    
    this.sessionId = null;
    this.lastMessageId = 0;
    
    console.log('[relay] Client stopped');
    this.emit('disconnected');
  }

  async request(method, path, data = null, timeout = 10000, quiet = false) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.relayUrl + path);
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
              // Use warn (not error) for quiet callers like heartbeat so these
              // expected failures don't trigger the error-report-prompt toast.
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
}

module.exports = RelayClient;
