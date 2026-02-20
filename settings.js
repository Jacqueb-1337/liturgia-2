const { ipcRenderer } = require('electron');
const { CDN_BASE, BIBLE_STORAGE_DIR } = require('./constants');
const fs = require('fs');
const path = require('path');

// Secure storage API using IPC to main (same as in renderer.js)
const secure = {
  async getToken() { try { return await ipcRenderer.invoke('secure-get-token'); } catch (e) { console.error('secure get token error', e); return null; } },
  async setToken(token) { try { return await ipcRenderer.invoke('secure-set-token', token); } catch (e) { console.error('secure set token error', e); return false; } },
  async deleteToken() { try { return await ipcRenderer.invoke('secure-delete-token'); } catch (e) { console.error('secure delete token error', e); return false; } }
};

// Helper to get saved token (matches renderer.js logic)
async function getSavedToken() {
  try {
    console.log('[Cloud Relay] Getting token from secure storage...');
    const t = await secure.getToken();
    console.log('[Cloud Relay] Token from secure storage:', t ? 'exists (length: ' + t.length + ')' : 'null');
    if (t) return t;
    // Fallback to settings (legacy)
    console.log('[Cloud Relay] Trying fallback to settings...');
    try {
      const s = await ipcRenderer.invoke('load-settings');
      if (s && s.auth && s.auth.token) {
        console.log('[Cloud Relay] Fallback token exists (length: ' + s.auth.token.length + ')');
        return s.auth.token;
      }
    } catch (e) {
      console.error('[Cloud Relay] Fallback error:', e);
    }
    console.log('[Cloud Relay] No token found');
    return null;
  } catch (e) {
    console.error('[Cloud Relay] secure get error', e);
    return null;
  }
}

// Sidebar navigation logic
document.addEventListener('DOMContentLoaded', () => {
  const buttons = document.querySelectorAll('.sidebar button');
  const panels = document.querySelectorAll('.settings-panel, .tab-content');

  buttons.forEach(button => {
    button.addEventListener('click', () => {
      // Remove active class from all buttons and panels
      buttons.forEach(btn => btn.classList.remove('active'));
      panels.forEach(panel => panel.classList.remove('active'));

      // Add active class to the clicked button and corresponding panel
      button.classList.add('active');
      const panelId = button.getAttribute('data-panel') || 'bibles-tab';
      document.getElementById(`panel-${panelId}`).classList.add('active');
    });
  });

  // Load the Bibles list when the Bibles tab is clicked
  document.getElementById('bibles-tab-button').addEventListener('click', loadBiblesList);
});

// Apply dark theme
function applyDarkTheme(enabled) {
  if (enabled) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
  // Send to main window
  ipcRenderer.send('set-dark-theme', enabled);
}

// Load settings on startup
window.addEventListener('DOMContentLoaded', async () => {
  // Load version from package.json
  try {
    const packageJson = require('./package.json');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = packageJson.version;
    }
  } catch (err) {
    console.error('Failed to load version:', err);
  }
  
  const settings = await ipcRenderer.invoke('load-settings');
  if (settings) {
    // Back-compat: only set username field if it exists
    const usernameEl = document.getElementById('username');
    if (usernameEl) usernameEl.value = settings.username || '';
    const themeEl = document.getElementById('theme');
    if (themeEl) themeEl.value = settings.theme || '';
    const darkEl = document.getElementById('dark-theme');
    if (darkEl) darkEl.checked = !!settings.darkTheme;
    applyDarkTheme(!!settings.darkTheme);
    // Auto-update setting (default true for new installs)
    const au = document.getElementById('auto-update-startup');
    if (au) au.checked = (typeof settings.autoCheckUpdates === 'boolean') ? settings.autoCheckUpdates : true;
  }

  // Populate account/subscription info
  try {
    let license = await ipcRenderer.invoke('get-current-license-status');
    // Double-check secure token presence - if no token exists treat as signed out to avoid stale _lastLicenseStatus
    try {
      const token = await ipcRenderer.invoke('secure-get-token');
      if (!token) license = null;
    } catch (e) { /* ignore secure errors */ }

    const ai = document.getElementById('account-info');
    const si = document.getElementById('subscription-info');
    const signInBtn = document.getElementById('btn-sign-in');
    const signOutBtn = document.getElementById('btn-sign-out');
    const viewSubBtn = document.getElementById('btn-view-subscription');
    const purchaseBtn = document.getElementById('btn-purchase-subscription');

    if (license) {
      // Prefer explicit email from token_payload or user_row if present
      const email = (license.email) || (license.token_payload && license.token_payload.email) || (license.user_row && license.user_row.email) || null;
      let displayEmail = email;
      if (!displayEmail) {
        // Try to read mirrored token from settings as a fallback
        try {
          const s = await ipcRenderer.invoke('load-settings');
          if (s && s.auth && s.auth.token) {
            const p = decodeJwtPayload(s.auth.token);
            if (p && p.email) displayEmail = p.email;
          }
        } catch (e) { /* ignore */ }
      }
      ai.textContent = displayEmail || 'Signed in';

      // If this is a 'no-token' trial (user continued without signing in), show only Sign in
      const isNoToken = (!license.active && (license.reason === 'no-token' || license.reason === 'no-token' || license.reason === 'no-token'));
      if (isNoToken) {
        si.textContent = `Not active (no-token).`; // keep short
        if (signInBtn) { signInBtn.style.display = ''; signInBtn.onclick = () => { try { ipcRenderer.send('show-setup-modal'); window.close(); } catch(e){} } }
        if (signOutBtn) signOutBtn.style.display = 'none';
        if (viewSubBtn) viewSubBtn.style.display = 'none';
        if (purchaseBtn) purchaseBtn.style.display = 'none';
      } else {
        if (license.active) {
          si.textContent = `Plan: ${license.plan || (license.user_row ? license.user_row.plan : 'unknown')} — Expires: ${license.expires_at ? new Date(license.expires_at * 1000).toLocaleString() : 'n/a'}`;
        } else {
          si.textContent = `Not active (${license.reason || 'inactive'}). Watermark may be shown.`;
        }

        // Toggle UI controls for normal signed-in flow
        if (signInBtn) signInBtn.style.display = 'none';
        if (signOutBtn) signOutBtn.style.display = '';
        if (viewSubBtn) viewSubBtn.style.display = '';
        if (purchaseBtn) purchaseBtn.style.display = license.active ? 'none' : '';
      }
    } else {
      document.getElementById('account-info').textContent = 'Not signed in';
      document.getElementById('subscription-info').textContent = '';
      if (signInBtn) { signInBtn.style.display = ''; signInBtn.onclick = () => { try { ipcRenderer.send('show-setup-modal'); window.close(); } catch(e){} } }
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (viewSubBtn) viewSubBtn.style.display = 'none';
      if (purchaseBtn) purchaseBtn.style.display = '';
    }
  } catch (e) {
    console.error('Failed to load license status for settings:', e);
  }
  await loadDisplays();

  // Manual check for updates button
  const checkBtn = document.getElementById('btn-check-updates');
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      const status = document.getElementById('update-status');
      try {
        status.textContent = 'Checking...';
        const res = await ipcRenderer.invoke('check-for-updates-manual');
        if (res && res.ok && res.updateAvailable) {
          status.innerHTML = `Update available: <strong>${res.latest}</strong> — <a href="${res.html_url}" target="_blank">Release</a>`;
        } else if (res && res.ok) {
          status.textContent = 'No updates available';
        } else {
          status.textContent = 'Update check failed';
        }
      } catch (e) { status.textContent = 'Error checking for updates'; }
      setTimeout(() => { const s = document.getElementById('update-status'); if (s) s.textContent = ''; }, 7000);
    });
  }

// Helper: decode JWT payload without verifying signature (base64url)
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = p + '='.repeat((4 - p.length % 4) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) { return null; }
}
  const defaultDisplaySelect = document.getElementById('default-display');
  if (settings && settings.defaultDisplay) {
    defaultDisplaySelect.value = settings.defaultDisplay;
  } else {
    defaultDisplaySelect.selectedIndex = 0; // Select first option if none saved
  }
});

// Save settings from any panel
document.querySelectorAll('.save-settings').forEach(btn => {
  btn.addEventListener('click', async () => {
    // Back-compat: username field might not exist anymore
    const usernameEl = document.getElementById('username');
    const username = usernameEl ? usernameEl.value : undefined;
    const themeEl = document.getElementById('theme');
    const theme = themeEl ? themeEl.value : '';
    const darkEl = document.getElementById('dark-theme');
    const darkTheme = darkEl ? !!darkEl.checked : false;
    const defaultDisplayEl = document.getElementById('default-display');
    const defaultDisplay = defaultDisplayEl ? defaultDisplayEl.value : '';
    
    // Use server-side atomic update to avoid races
    const patch = { theme, darkTheme, defaultDisplay };
    if (username !== undefined) patch.username = username;
    // Include auto-update preference
    const auEl = document.getElementById('auto-update-startup');
    if (auEl) patch.autoCheckUpdates = !!auEl.checked;
    await ipcRenderer.invoke('update-settings', patch);
    applyDarkTheme(darkTheme);
    // Show status only for the current panel
    const panel = btn.getAttribute('data-panel');
    const status = document.querySelector('.save-status[data-panel="' + panel + '"]');
    status.textContent = 'Saved!';
    setTimeout(() => status.textContent = '', 1500);
  });
});

// Remote Control initialization
(async () => {
  const settings = await ipcRenderer.invoke('load-settings');
  const remoteEnabledEl = document.getElementById('remote-enabled');
  const remotePortEl = document.getElementById('remote-port');
  const pairedDevicesList = document.getElementById('paired-devices-list');
  const remoteServerInfo = document.getElementById('remote-server-info');
  const remoteStatus = document.getElementById('remote-status');
  const remoteAddressesContainer = document.getElementById('remote-addresses-container');
  
  if (settings && settings.remote) {
    if (remoteEnabledEl) remoteEnabledEl.checked = !!settings.remote.enabled;
    if (remotePortEl) remotePortEl.value = settings.remote.port || 39847;
  }
  
  async function refreshServerInfo() {
    const info = await ipcRenderer.invoke('remote-get-info');
    
    if (!info.running) {
      if (remoteServerInfo) remoteServerInfo.style.display = 'none';
      return;
    }
    
    if (remoteServerInfo) remoteServerInfo.style.display = 'block';
    if (remoteStatus) remoteStatus.textContent = 'Running';
    
    if (remoteAddressesContainer && info.addresses && info.addresses.length > 0) {
      remoteAddressesContainer.innerHTML = `
        <div style="font-weight:500;margin-bottom:4px;">Connection Addresses:</div>
        ${info.addresses.map(addr => `
          <div class="remote-address-item" style="font-family:monospace;padding:4px 8px;margin:2px 0;border-radius:3px;display:flex;justify-content:space-between;align-items:center;">
            <span>${addr}:${info.port}</span>
            <button class="copy-address" data-address="${addr}:${info.port}" style="padding:2px 8px;font-size:0.8em;color:white;border:none;border-radius:2px;cursor:pointer;">Copy</button>
          </div>
        `).join('')}
      `;
      
      // Add copy handlers
      remoteAddressesContainer.querySelectorAll('.copy-address').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const address = e.target.getAttribute('data-address');
          navigator.clipboard.writeText(address);
          const originalText = e.target.textContent;
          e.target.textContent = 'Copied!';
          setTimeout(() => { e.target.textContent = originalText; }, 1500);
        });
      });
    }
  }
  
  async function refreshPairedDevices() {
    if (!pairedDevicesList) return;
    const devices = await ipcRenderer.invoke('remote-get-paired-devices');
    
    if (devices.length === 0) {
      pairedDevicesList.innerHTML = `
        <div style="padding:16px;text-align:center;color:#888;">
          No devices paired yet
        </div>
      `;
      return;
    }
    
    pairedDevicesList.innerHTML = devices.map(device => `
      <div style="padding:12px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:500;">${device.name}</div>
          <div style="font-size:0.85em;color:#888;">
            Paired ${new Date(device.paired).toLocaleDateString()} • 
            ${device.revoked ? '<span style="color:#c00;">Revoked</span>' : '<span style="color:#060;">Active</span>'}
          </div>
        </div>
        ${device.revoked ? '' : `
          <button class="revoke-device" data-device-id="${device.id}" style="padding:6px 12px;background:#c00;color:white;border:none;border-radius:4px;cursor:pointer;">
            Revoke
          </button>
        `}
      </div>
    `).join('');
    
    // Add revoke handlers
    pairedDevicesList.querySelectorAll('.revoke-device').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const deviceId = e.target.getAttribute('data-device-id');
        if (confirm('Revoke access for this device?')) {
          await ipcRenderer.invoke('remote-revoke-device', deviceId);
          refreshPairedDevices();
        }
      });
    });
  }
  
  refreshPairedDevices();
  refreshServerInfo();
  
  // Listen for device list changes
  ipcRenderer.on('remote-devices-changed', () => {
    refreshPairedDevices();
  });
  
  // Handle remote enable/disable
  if (remoteEnabledEl) {
    remoteEnabledEl.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      const port = remotePortEl ? parseInt(remotePortEl.value) : 39847;
      
      if (enabled) {
        const result = await ipcRenderer.invoke('remote-start', port);
        if (!result.success) {
          alert('Failed to start remote server: ' + result.error);
          e.target.checked = false;
        } else {
          refreshServerInfo();
        }
      } else {
        await ipcRenderer.invoke('remote-stop');
        refreshServerInfo();
      }
    });
  }
  
  // Fix Connection button
  const fixConnectionBtn = document.getElementById('fix-connection-btn');
  if (fixConnectionBtn) {
    fixConnectionBtn.addEventListener('click', async () => {
      const originalText = fixConnectionBtn.textContent;
      fixConnectionBtn.textContent = 'Fixing...';
      fixConnectionBtn.disabled = true;
      
      const result = await ipcRenderer.invoke('remote-fix-connection');
      
      if (result.success) {
        alert('✓ Firewall rules added successfully!\n\nTry connecting from your mobile device now.');
      } else {
        alert('⚠ Failed to add firewall rules:\n\n' + result.error + '\n\nYou may need to run Liturgia as Administrator to add firewall rules automatically.');
      }
      
      fixConnectionBtn.textContent = originalText;
      fixConnectionBtn.disabled = false;
    });
  }
})();

// Cloud Relay initialization
(async () => {
  const settings = await ipcRenderer.invoke('load-settings');
  const relayEnabledEl = document.getElementById('relay-enabled');
  const relayAccountStatusEl = document.getElementById('relay-account-status');
  const relayNotSignedInEl = document.getElementById('relay-not-signed-in');
  const relaySignedInEl = document.getElementById('relay-signed-in');
  const relayAccountEmailEl = document.getElementById('relay-account-email');
  const relayConnectedInfoEl = document.getElementById('relay-connected-info');
  const relaySessionIdEl = document.getElementById('relay-session-id');
  
  let authToken = null;
  
  // Load saved relay settings
  if (settings && settings.relay) {
    if (relayEnabledEl) relayEnabledEl.checked = !!settings.relay.enabled;
  }
  
  async function refreshRelayUI() {
    // Get auth token from existing account login (using secure storage)
    authToken = await getSavedToken();
    console.log('[Cloud Relay] refreshRelayUI - authToken:', authToken ? 'exists (length: ' + authToken.length + ')' : 'null');
    
    // Get relay connection info
    const info = await ipcRenderer.invoke('relay-get-info');
    
    // Update account status
    if (authToken) {
      if (relayNotSignedInEl) relayNotSignedInEl.style.display = 'none';
      if (relaySignedInEl) relaySignedInEl.style.display = 'block';
      
      // Try to decode JWT to get email (only works for JWT tokens, not device tokens)
      try {
        const parts = authToken.split('.');
        console.log('[Cloud Relay] Token parts count:', parts.length);
        if (parts.length === 3) {
          // JWT token - decode to get email
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          console.log('[Cloud Relay] JWT payload:', payload);
          if (relayAccountEmailEl && payload.email) {
            relayAccountEmailEl.textContent = payload.email;
          }
        } else {
          // Device token (id.secret format) - can't decode email locally
          console.log('[Cloud Relay] Device token detected (not JWT)');
          if (relayAccountEmailEl) {
            relayAccountEmailEl.textContent = '(authenticated)';
          }
        }
      } catch (e) {
        console.error('[Cloud Relay] Token decode error:', e);
        if (relayAccountEmailEl) relayAccountEmailEl.textContent = '(authenticated)';
      }
      
      // Enable the checkbox
      if (relayEnabledEl) relayEnabledEl.disabled = false;
    } else {
      if (relayNotSignedInEl) relayNotSignedInEl.style.display = 'block';
      if (relaySignedInEl) relaySignedInEl.style.display = 'none';
      
      // Disable the checkbox
      if (relayEnabledEl) {
        relayEnabledEl.disabled = true;
        relayEnabledEl.checked = false;
      }
    }
    
    // Update connection info
    if (info.running && info.sessionId) {
      if (relayConnectedInfoEl) relayConnectedInfoEl.style.display = 'block';
      if (relaySessionIdEl) relaySessionIdEl.textContent = info.sessionId.substring(0, 16) + '...';
    } else {
      if (relayConnectedInfoEl) relayConnectedInfoEl.style.display = 'none';
    }
  }
  
  refreshRelayUI();
  
  // AUTO-START RELAY FOR TESTING
  setTimeout(async () => {
    const info = await ipcRenderer.invoke('relay-get-info');
    if (!info.running && authToken && relayEnabledEl && !relayEnabledEl.checked) {
      console.log('[Cloud Relay] Auto-starting relay for testing...');
      relayEnabledEl.checked = true;
      relayEnabledEl.dispatchEvent(new Event('change'));
    }
  }, 1000);
  
  // Enable/disable relay
  if (relayEnabledEl) {
    relayEnabledEl.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      
      if (enabled) {
        if (!authToken) {
          alert('Please sign in to your Liturgia account first (Account tab)');
          e.target.checked = false;
          return;
        }
        
        console.log('[Cloud Relay] Starting relay with token length:', authToken.length);
        const result = await ipcRenderer.invoke('relay-start', {
          token: authToken,
          deviceName: 'Liturgia Desktop'
        });
        console.log('[Cloud Relay] Relay start result:', result);
        
        if (!result.success) {
          alert('Failed to start cloud relay: ' + result.error);
          e.target.checked = false;
        } else {
          setTimeout(refreshRelayUI, 500);
        }
      } else {
        await ipcRenderer.invoke('relay-stop');
        setTimeout(refreshRelayUI, 500);
      }
    });
  }
})();

// Live toggle dark theme
document.getElementById('dark-theme').addEventListener('change', (e) => {
  applyDarkTheme(e.target.checked);
});

document.getElementById('reload-displays').addEventListener('click', loadDisplays);

document.getElementById('open-live-window').addEventListener('click', async () => {
  await ipcRenderer.invoke('create-live-window');
});

document.getElementById('close-live-window').addEventListener('click', async () => {
  await ipcRenderer.invoke('close-live-window');
});

  // Sign-in / Sign-out buttons
  const signOutBtn = document.getElementById('btn-sign-out');
  const signInBtn = document.getElementById('btn-sign-in');
  const viewSubBtn = document.getElementById('btn-view-subscription');
  const purchaseBtn = document.getElementById('btn-purchase-subscription');

  if (signInBtn) {
    signInBtn.addEventListener('click', async () => {
      try {
        // Ask main window to show its setup popover/modal
        ipcRenderer.send('show-setup-modal');
        // Close the settings window so the setup modal is visible
        window.close();
      } catch (e) { console.error('Failed to request setup modal', e); }
    });
  }
  if (signOutBtn) {
    signOutBtn.addEventListener('click', async () => {
      try {
        await ipcRenderer.invoke('secure-delete-token');
      } catch (e) { console.error('Failed to delete secure token', e); }
      try { await ipcRenderer.invoke('update-settings', { auth: null }); } catch (e) {}
      ipcRenderer.send('license-status-update', { active: false, reason: 'signed-out' });
      document.getElementById('account-info').textContent = 'Not signed in';
      document.getElementById('subscription-info').textContent = '';
      // Toggle buttons
      if (signInBtn) signInBtn.style.display = '';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (viewSubBtn) viewSubBtn.style.display = 'none';
      if (purchaseBtn) purchaseBtn.style.display = '';
    });
  }

  // View subscription (open Stripe portal)
  if (viewSubBtn) {
    viewSubBtn.addEventListener('click', async () => {
      try {
        let token = await ipcRenderer.invoke('secure-get-token');
        if (!token) {
          // fallback to settings mirror
          const s = await ipcRenderer.invoke('load-settings');
          if (s && s.auth && s.auth.token) token = s.auth.token;
        }
        if (!token) { alert('Sign in first'); return; }
        const settings = await ipcRenderer.invoke('load-settings');
        const server = (settings && settings.licenseServer) ? settings.licenseServer.replace(/\/$/, '') : 'https://jacqueb.me/liturgia';
        // Send token in both Authorization header and JSON body to survive proxies that strip headers
        const res = await fetch(server + '/create-portal-session.php', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        let j = null;
        try { j = await res.json(); } catch (err) { j = null; }
        if (res.status === 401) {
          const msg = (j && j.error) ? j.error : 'Unauthorized';
          // As a last resort try query param fallback
          try {
            const qres = await fetch(server + '/create-portal-session.php?token=' + encodeURIComponent(token), { method: 'POST' });
            let qj = null;
            try { qj = await qres.json(); } catch (er) { qj = null; }
            if (qres.status === 200 && qj && qj.url) { window.open(qj.url, '_blank'); return; }
          } catch (e) { /* ignore */ }

          // If fallback didn't work, treat as invalid/expired token
          try { await ipcRenderer.invoke('secure-delete-token'); } catch (e) { console.error('Failed to delete token after 401', e); }
          try { await ipcRenderer.invoke('update-settings', { auth: null }); } catch (e) {}
          ipcRenderer.send('license-status-update', { active: false, reason: 'signed-out' });
          alert('Sign-in token invalid or expired. Please sign in again. (' + msg + ')');
          // Update buttons
          if (signInBtn) signInBtn.style.display = '';
          if (signOutBtn) signOutBtn.style.display = 'none';
          if (viewSubBtn) viewSubBtn.style.display = 'none';
          if (purchaseBtn) purchaseBtn.style.display = '';
          return;
        }
        if (j && j.url) { window.open(j.url, '_blank'); } else alert('Failed to open subscription portal: ' + (j && j.error ? j.error : 'Unknown error'));
      } catch (e) { console.error(e); alert('Failed to open subscription portal'); }
    });
  }

  // Purchase subscription
  if (purchaseBtn) {
    purchaseBtn.addEventListener('click', async () => {
      // Reuse setup modal flow to collect email and create checkout
      ipcRenderer.send('show-setup-modal');
    });
  }

  // Update account UI when license status changes
  ipcRenderer.on('license-status', async (event, status) => {
    const ai = document.getElementById('account-info');
    const si = document.getElementById('subscription-info');
    if (!ai || !si) return;
    if (status) {
      const email = (status.email) || (status.token_payload && status.token_payload.email) || (status.user_row && status.user_row.email) || null;
      let displayEmail = email;
      if (!displayEmail) {
        try {
          const s = await ipcRenderer.invoke('load-settings');
          if (s && s.auth && s.auth.token) {
            const p = decodeJwtPayload(s.auth.token);
            if (p && p.email) displayEmail = p.email;
          }
        } catch (e) {}
      }
      ai.textContent = displayEmail || 'Signed in';
      if (status.active) {
        si.textContent = `Plan: ${status.plan || (status.user_row ? status.user_row.plan : 'unknown')} — Expires: ${status.expires_at ? new Date(status.expires_at * 1000).toLocaleString() : 'n/a'}`;
      } else {
        si.textContent = `Not active (${status.reason || 'inactive'}).`;
      }

      // Toggle buttons
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = '';
      if (viewSubBtn) viewSubBtn.style.display = '';
      if (purchaseBtn) purchaseBtn.style.display = status.active ? 'none' : '';
    } else {
      ai.textContent = 'Not signed in';
      si.textContent = '';
      if (signInBtn) signInBtn.style.display = '';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (viewSubBtn) viewSubBtn.style.display = 'none';
      if (purchaseBtn) purchaseBtn.style.display = '';
    }
  });
// Load list of available Bibles from GitHub
async function loadBiblesList() {
  const apiUrl = 'https://api.github.com/repos/thiagobodruk/bible/contents/json';
  const biblesContainer = document.getElementById('bibles-list');
  try {
    const response = await fetch(apiUrl);
    if (!response.ok) {
      biblesContainer.innerHTML = '<div class="bible-loading" style="color: #f44336;">Failed to load Bible versions. Please check your connection.</div>';
      console.error('Failed to fetch Bible list:', response.statusText);
      return;
    }

    const files = await response.json();
    allBibleFiles = files.filter(file => file.name.endsWith('.json'));

    renderBiblesList(allBibleFiles);

    // Add search functionality
    const searchInput = document.getElementById('bible-search');
    searchInput.addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const filtered = allBibleFiles.filter(file => {
        const bibleName = file.name.replace('.json', '').replace(/_/g, ' ').toLowerCase();
        return bibleName.includes(searchTerm);
      });
      renderBiblesList(filtered);
    });
  } catch (error) {
    biblesContainer.innerHTML = '<div class="bible-loading" style="color: #f44336;">Error loading Bible versions: ' + error.message + '</div>';
    console.error('Error loading Bibles:', error);
  }
}

async function renderBiblesList(biblesList) {
  const biblesContainer = document.getElementById('bibles-list');
  biblesContainer.innerHTML = '';

  if (biblesList.length === 0) {
    biblesContainer.innerHTML = '<div class="bible-loading">No Bible versions found.</div>';
    return;
  }

  // Get the currently selected Bible
  const currentBible = await ipcRenderer.invoke('get-default-bible');
  const userData = await ipcRenderer.invoke('get-user-data-path');

  biblesList.forEach(file => {
    const baseName = file.name.replace('.json','');
    const bibleName = baseName.replace(/_/g, ' ').toUpperCase();
    // Check both per-version folder and legacy file location
    const isDownloaded = fs.existsSync(path.join(userData, BIBLE_STORAGE_DIR, baseName, 'bible.json')) || fs.existsSync(path.join(userData, BIBLE_STORAGE_DIR, file.name));
    const isSelected = file.name === currentBible;

    const bibleItem = document.createElement('div');
    bibleItem.className = 'bible-item';
    if (isSelected) {
      bibleItem.classList.add('selected');
    }

    bibleItem.innerHTML = `
      <div class="bible-item-header">
        <span class="bible-name">${bibleName}</span>
        <span class="bible-status ${isDownloaded ? 'downloaded' : 'not-downloaded'}">
          ${isDownloaded ? '✓ Downloaded' : 'Not Downloaded'}
        </span>
      </div>
      <button class="bible-action ${isDownloaded ? (isSelected ? 'selected' : 'select') : 'download'}" 
              data-filename="${file.name}" 
              data-url="${file.download_url}"
              ${isSelected ? 'disabled' : ''}>
        ${isSelected ? '✓ Currently Active' : (isDownloaded ? 'Select' : 'Download')}
      </button>
    `;

    const actionButton = bibleItem.querySelector('.bible-action');
    actionButton.addEventListener('click', async (e) => {
      const button = e.target;
      const fileName = button.getAttribute('data-filename');
      const downloadUrl = button.getAttribute('data-url');
      const baseName = fileName.replace('.json','');
      const wasDownloaded = fs.existsSync(path.join(userData, BIBLE_STORAGE_DIR, baseName, 'bible.json')) || fs.existsSync(path.join(userData, BIBLE_STORAGE_DIR, fileName));

      if (!wasDownloaded) {
        button.disabled = true;
        button.textContent = 'Downloading...';

        try {
          await downloadBible(downloadUrl, fileName);
          button.textContent = 'Select';
          button.className = 'bible-action select';

          // Update status badge
          const statusBadge = bibleItem.querySelector('.bible-status');
          statusBadge.textContent = '✓ Downloaded';
          statusBadge.className = 'bible-status downloaded';
        } catch (error) {
          button.textContent = 'Download Failed';
          button.disabled = false;
          alert('Failed to download Bible: ' + error.message);
          return;
        }
      }

      // Select the Bible
      button.disabled = false;
      await selectBible(fileName);
      renderBiblesList(allBibleFiles); // Re-render to update UI
    });

    biblesContainer.appendChild(bibleItem);
  });
}

async function downloadBible(url, fileName) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error('Failed to download Bible:', response.statusText);
    throw new Error('Failed to download Bible');
  }

  const data = await response.text();
  const userData = await ipcRenderer.invoke('get-user-data-path');
  const baseName = fileName.replace('.json','');
  const bibleDir = path.join(userData, BIBLE_STORAGE_DIR, baseName);
  await fs.promises.mkdir(bibleDir, { recursive: true });

  const biblePath = path.join(bibleDir, 'bible.json');
  await fs.promises.writeFile(biblePath, data, 'utf8');
}

async function selectBible(bible) {
  ipcRenderer.send('set-default-bible', bible);

  // Persist the selection in the settings so it survives restarts
  try {
    await ipcRenderer.invoke('update-settings', { defaultBible: bible });
  } catch (err) {
    console.error('Failed to persist selected bible:', err);
  }

  // Show brief success message
  const searchInput = document.getElementById('bible-search');
  const originalPlaceholder = searchInput.placeholder;
  searchInput.placeholder = '✓ Bible selected successfully!';
  setTimeout(() => {
    searchInput.placeholder = originalPlaceholder;
  }, 2000);
}

async function loadDisplays() {
  const displays = await ipcRenderer.invoke('get-displays');
  const select = document.getElementById('default-display');
  select.innerHTML = '';
  displays.forEach((display, i) => {
    const index = i + 1;
    const option = document.createElement('option');
    option.value = display.id;
    option.textContent = `Display ${index} (${display.bounds.width}x${display.bounds.height})`;
    select.appendChild(option);
  });
}