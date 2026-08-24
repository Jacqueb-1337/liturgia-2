const { ipcRenderer } = require('electron');
const { CDN_BASE, BIBLE_STORAGE_DIR } = require('./constants');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
let cachedSettings = null;
let _allDisplays = [];

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

function formatLicenseExpiry(status) {
  const value = status && (status.offlineUntil || status.expires_at);
  if (value === null || value === undefined || value === '') return 'n/a';
  let milliseconds = typeof value === 'number' ? (value < 100000000000 ? value * 1000 : value) : Number(value);
  if (!Number.isFinite(milliseconds)) milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString() : 'n/a';
}

function activateSettingsPanel(panelId) {
  const buttons = document.querySelectorAll('.sidebar button');
  const panels = document.querySelectorAll('.settings-panel, .tab-content');
  buttons.forEach(button => button.classList.toggle('active', button.getAttribute('data-panel') === panelId));
  panels.forEach(panel => panel.classList.remove('active'));
  const panel = document.getElementById(`panel-${panelId}`);
  if (panel) panel.classList.add('active');
  if (panelId === 'roles-permissions' && typeof window.refreshRolesAndPermissions === 'function') {
    window.refreshRolesAndPermissions();
  }
  return panel;
}
window.activateSettingsPanel = activateSettingsPanel;

// Sidebar navigation logic
document.addEventListener('DOMContentLoaded', () => {
  const buttons = document.querySelectorAll('.sidebar button');

  buttons.forEach(button => {
    button.addEventListener('click', () => {
      const panelId = button.getAttribute('data-panel') || 'bibles-tab';
      activateSettingsPanel(panelId);
    });
  });

  // Load the Bibles list when the Bibles tab is clicked
  document.getElementById('bibles-tab-button').addEventListener('click', loadBiblesList);

  // Import Bible from local file
  document.getElementById('bible-import-btn').addEventListener('click', handleBibleImport);
  const ebibleRefresh = document.getElementById('ebible-refresh');
  if (ebibleRefresh) ebibleRefresh.addEventListener('click', () => loadBiblesList(true));
  
  // Bible export format chooser
  const exportFormatPopover = document.getElementById('bible-export-format-popover');
  exportFormatPopover.addEventListener('click', async (e) => {
    const option = e.target.closest('.bible-export-format-option');
    if (!option) return;
    const format = option.dataset.format;
    const versionId = exportFormatPopover.dataset.currentVersion;
    if (!versionId) return;
    exportFormatPopover.classList.remove('active');
    const exportBtn = document.querySelector(`.bible-action.export[data-export-version="${versionId}"]`);
    if (!exportBtn) return;
    exportBtn.disabled = true;
    exportBtn.textContent = 'Saving...';
    try {
      const savedPath = await ipcRenderer.invoke('export-bible-file', versionId, format);
      if (savedPath) {
        exportBtn.textContent = 'Saved!';
        setTimeout(() => { exportBtn.textContent = 'Export'; exportBtn.disabled = false; }, 2000);
      } else {
        exportBtn.textContent = 'Export';
        exportBtn.disabled = false;
      }
    } catch (err) {
      console.error('Bible export failed:', err);
      exportBtn.textContent = 'Error';
      setTimeout(() => { exportBtn.textContent = 'Export'; exportBtn.disabled = false; }, 2000);
    }
  });
  
  // Refresh relay UI when the Cloud Relay tab is clicked (don't load on init to avoid freeze)
  const relayTabButton = document.querySelector('button[data-panel="relay"]');
  if (relayTabButton) {
    relayTabButton.addEventListener('click', () => {
      // Will be initialized after relay IIFE sets up refreshRelayUI function
      if (typeof refreshRelayUI === 'function') {
        refreshRelayUI();
      }
    });
  }

  const remoteTabButton = document.querySelector('button[data-panel="remote"]');
  if (remoteTabButton) {
    remoteTabButton.addEventListener('click', () => {
      if (typeof window.refreshRemoteUI === 'function') window.refreshRemoteUI();
    });
  }
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

// Load settings on startup - defer all async work to background
window.addEventListener('DOMContentLoaded', () => {
  // Load version from package.json - SYNC
  try {
    const packageJson = require('./package.json');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = packageJson.version;
    }
  } catch (err) {
    console.error('Failed to load version:', err);
  }

  // Defer all async initialization to background - don't block the event
  setImmediate(async () => {
    try {
      const settings = await ipcRenderer.invoke('load-settings');
      cachedSettings = settings || {};
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
        initAiTab(settings || {});
        initRemoteTab(settings || {});
        
        const ai = document.getElementById('account-info');
        const si = document.getElementById('subscription-info');
        const signInBtn = document.getElementById('btn-sign-in');
        const signOutBtn = document.getElementById('btn-sign-out');
        const viewSubBtn = document.getElementById('btn-view-subscription');
        const purchaseBtn = document.getElementById('btn-purchase-subscription');

        // Set initial state (not signed in) — will be updated in background
        ai.textContent = 'Not signed in';
        si.textContent = '';
        if (signInBtn) { signInBtn.style.display = ''; signInBtn.onclick = () => { try { ipcRenderer.send('show-setup-modal'); window.close(); } catch(e){} } }
        if (signOutBtn) signOutBtn.style.display = 'none';
        if (viewSubBtn) viewSubBtn.style.display = 'none';
        if (purchaseBtn) purchaseBtn.style.display = '';

        // Fetch license status in background with timeout to prevent indefinite freeze
        const licenseCheckTimeout = 3000; // 3 second timeout
        const fetchLicenseTimeout = new Promise((resolve) => setTimeout(() => resolve(null), licenseCheckTimeout));
        const fetchLicense = ipcRenderer.invoke('get-current-license-status').catch(() => null);
        
        Promise.race([fetchLicense, fetchLicenseTimeout]).then(async (license) => {
          // Double-check secure token presence - if no token exists treat as signed out to avoid stale _lastLicenseStatus
          if (license) {
            try {
              const token = await ipcRenderer.invoke('secure-get-token');
              if (!token) license = null;
            } catch (e) { /* ignore secure errors */ }
          }

          if (license) {
            // Prefer explicit email from token_payload or user_row if present
            const email = (license.email) || (license.token_payload && license.token_payload.email) || (license.user_row && license.user_row.email) || null;
            let displayEmail = email;
            if (!displayEmail) {
              // Try settings-mirrored token first, then secure storage
              try {
                const s = await ipcRenderer.invoke('load-settings');
                if (s && s.auth && s.auth.token) {
                  const p = decodeJwtPayload(s.auth.token);
                  if (p && p.email) displayEmail = p.email;
                }
                if (!displayEmail) {
                  const secTok = await ipcRenderer.invoke('secure-get-token');
                  if (secTok) {
                    const p = decodeJwtPayload(secTok);
                    if (p && (p.email || p.sub)) displayEmail = p.email || p.sub;
                  }
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
                si.textContent = `Plan: ${license.plan || (license.user_row ? license.user_row.plan : 'unknown')} — Expires: ${formatLicenseExpiry(license)}${license.offline ? ' (verified offline)' : ''}`;
              } else {
                si.textContent = `Not active (${license.reason || 'inactive'}). Watermark may be shown.`;
              }

              // Toggle UI controls for normal signed-in flow
              if (signInBtn) signInBtn.style.display = 'none';
              if (signOutBtn) signOutBtn.style.display = '';
              if (viewSubBtn) viewSubBtn.style.display = '';
              if (purchaseBtn) purchaseBtn.style.display = license.active ? 'none' : '';
            }
          }
        }).catch((e) => {
          console.error('Failed to load license status for settings:', e);
        });
      } catch (e) {
        console.error('Failed to initialize settings:', e);
      }
      
      // Load displays in background - don't block UI
      loadDisplays().catch((e) => console.error('Failed to load displays:', e));
    } catch (err) {
      console.error('Error in deferred settings initialization:', err);
    }
  });

  // Manual check for updates button - set up listener immediately (no await)
  const checkBtn = document.getElementById('btn-check-updates');
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      const status = document.getElementById('update-status');
      try {
        status.textContent = 'Checking...';
        const res = await ipcRenderer.invoke('check-for-updates-manual');
        if (res && res.ok && res.updateAvailable) {
          // Forward to the main window so it shows the full download/install modal
          ipcRenderer.send('show-update-modal', res);
          status.textContent = `Update available: ${res.latest}`;
        } else if (res && res.ok) {
          status.textContent = 'No updates available. You are on the latest version.';
        } else {
          status.textContent = 'Update check failed';
        }
      } catch (e) { status.textContent = 'Error checking for updates'; }
      setTimeout(() => { const s = document.getElementById('update-status'); if (s) s.textContent = ''; }, 7000);
    });
  }
});

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

// Save settings from any panel
// Save button now just provides feedback (actual saving is atomic and automatic)
document.querySelectorAll('.save-settings').forEach(btn => {
  btn.addEventListener('click', async () => {
    const panel = btn.getAttribute('data-panel');
    const status = document.querySelector('.save-status[data-panel="' + panel + '"]');
    
    // Just show saved status - actual saving is happening automatically via atomic save
    status.textContent = 'Saved!';
    setTimeout(() => status.textContent = '', 1500);
  });
});

// Initialize keybinds on settings load
async function loadKeybinds() {
  const settings = await ipcRenderer.invoke('load-settings');
  const keybindsList = document.getElementById('keybinds-list');
  keybindsList.innerHTML = '';
  
  // Default keybinds structure
  const defaultKeybinds = {
    'next-verse': 'ArrowRight',
    'prev-verse': 'ArrowLeft',
    'go-live': 'Enter',
    'focus-search': 'Ctrl+f',
    'toggle-clear': '',
    'toggle-black': '',
    'select-verse-1': 'Alt+1',
    'select-verse-2': 'Alt+2',
    'select-verse-3': 'Alt+3',
    'select-verse-4': 'Alt+4',
    'select-verse-5': 'Alt+5',
    'select-verse-6': 'Alt+6',
    'select-verse-7': 'Alt+7',
    'select-verse-8': 'Alt+8',
    'select-verse-9': 'Alt+9',
    'select-chorus-1': 'Alt+c',
    'select-chorus-2': '',
    'select-chorus-3': '',
    'select-chorus-4': '',
    'select-chorus-5': '',
    'select-chorus-6': '',
    'select-chorus-7': '',
    'select-chorus-8': '',
    'select-chorus-9': ''
  };

  const labelMap = {
    'prev-verse': 'Previous Verse',
    'next-verse': 'Next Verse',
    'go-live': 'Go Live',
    'focus-search': 'Focus Search Bar',
    'toggle-clear': 'Toggle Clear',
    'toggle-black': 'Toggle Black',
  };

  const saved = settings.keybinds || {};
  const keybinds = { ...defaultKeybinds, ...saved };

  function makeInput(bindId) {
    const input = document.createElement('input');
    input.className = 'keybind-input';
    input.type = 'text';
    input.value = keybinds[bindId] || '';
    input.placeholder = '—';
    input.readOnly = true;
    input.setAttribute('data-bind-id', bindId);
    input.addEventListener('click', (e) => { e.stopPropagation(); recordKeybind(input); });
    return input;
  }

  // Navigation & Controls section
  const navSection = document.createElement('div');
  navSection.className = 'keybind-section';
  const navTitle = document.createElement('div');
  navTitle.className = 'keybind-section-title';
  navTitle.textContent = 'Navigation & Controls';
  navSection.appendChild(navTitle);

  const navList = document.createElement('div');
  navList.className = 'keybind-list';
  ['prev-verse', 'next-verse', 'go-live', 'focus-search', 'toggle-clear', 'toggle-black'].forEach(bindId => {
    const row = document.createElement('div');
    row.className = 'keybind-row';
    row.setAttribute('data-bind-id', bindId);
    const label = document.createElement('span');
    label.className = 'keybind-label';
    label.textContent = labelMap[bindId] || bindId;
    row.appendChild(label);
    row.appendChild(makeInput(bindId));
    navList.appendChild(row);
  });
  navSection.appendChild(navList);
  keybindsList.appendChild(navSection);

  // Song Section Selection — grid layout
  const songSection = document.createElement('div');
  songSection.className = 'keybind-section';
  const songTitle = document.createElement('div');
  songTitle.className = 'keybind-section-title';
  songTitle.textContent = 'Song Section Selection';
  songSection.appendChild(songTitle);

  function makeGridGroup(label, ids) {
    const sub = document.createElement('div');
    sub.className = 'keybind-subsection-title';
    sub.textContent = label;
    songSection.appendChild(sub);
    const grid = document.createElement('div');
    grid.className = 'keybind-grid';
    ids.forEach(bindId => {
      const item = document.createElement('div');
      item.className = 'keybind-grid-item';
      item.setAttribute('data-bind-id', bindId);
      const lbl = document.createElement('span');
      lbl.className = 'keybind-grid-label';
      lbl.textContent = bindId.replace('select-verse-', 'V').replace('select-chorus-', 'C');
      item.appendChild(lbl);
      item.appendChild(makeInput(bindId));
      grid.appendChild(item);
    });
    songSection.appendChild(grid);
  }

  makeGridGroup('Verses', Array.from({length: 9}, (_, i) => `select-verse-${i + 1}`));
  makeGridGroup('Choruses', Array.from({length: 9}, (_, i) => `select-chorus-${i + 1}`));
  keybindsList.appendChild(songSection);
}

// Record a keybind by listening for key/mouse events
function recordKeybind(inputElement) {
  inputElement.value = '';
  inputElement.placeholder = 'Press any key or button...';
  
  const pressedKeys = new Set();
  const pressedButtons = new Set();
  let recordingTimeout;
  
  // Track keyboard keys
  const keydownHandler = (e) => {
    // Allow ESC to cancel recording
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelRecording();
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    pressedKeys.add(e.key);
    updateInputDisplay();
  };
  
  const keyupHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    pressedKeys.delete(e.key);
    checkIfDone();
  };
  
  // Track mouse buttons
  const mousedownHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    let buttonName = '';
    switch (e.button) {
      case 0: buttonName = 'MouseLeft'; break;
      case 1: buttonName = 'MouseMiddle'; break;
      case 2: buttonName = 'MouseRight'; break;
      case 3: buttonName = 'MouseButton4'; break;
      case 4: buttonName = 'MouseButton5'; break;
      default: buttonName = `MouseButton${e.button}`;
    }
    
    pressedButtons.add(buttonName);
    updateInputDisplay();
  };
  
  const mouseupHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    let buttonName = '';
    switch (e.button) {
      case 0: buttonName = 'MouseLeft'; break;
      case 1: buttonName = 'MouseMiddle'; break;
      case 2: buttonName = 'MouseRight'; break;
      case 3: buttonName = 'MouseButton4'; break;
      case 4: buttonName = 'MouseButton5'; break;
      default: buttonName = `MouseButton${e.button}`;
    }
    
    pressedButtons.delete(buttonName);
    checkIfDone();
  };
  
  const updateInputDisplay = () => {
    const combo = buildKeybindString();
    inputElement.value = combo;
  };
  
  const buildKeybindString = () => {
    const parts = [];
    
    // Add modifier keys if pressed
    if (pressedKeys.has('Control') || pressedKeys.has('Meta')) {
      parts.push('Ctrl');
    }
    if (pressedKeys.has('Shift')) {
      parts.push('Shift');
    }
    if (pressedKeys.has('Alt')) {
      parts.push('Alt');
    }
    
    // Add mouse buttons
    pressedButtons.forEach(btn => parts.push(btn));
    
    // Add regular keys (filter out modifiers)
    const modifiers = ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock'];
    pressedKeys.forEach(key => {
      if (!modifiers.includes(key)) {
        const displayKey = key.length === 1 ? key.toUpperCase() : key;
        parts.push(displayKey);
      }
    });
    
    return parts.length > 0 ? parts.join('+') : '';
  };
  
  const checkIfDone = () => {
    // If all keys/buttons are released, save and stop recording
    if (pressedKeys.size === 0 && pressedButtons.size === 0) {
      clearTimeout(recordingTimeout);
      stopRecording();
    } else {
      // Reset timeout when keys are still pressed
      clearTimeout(recordingTimeout);
    }
  };
  
  const cancelRecording = () => {
    inputElement.value = '';
    stopRecording();
  };
  
  const stopRecording = () => {
    document.removeEventListener('keydown', keydownHandler, true);
    document.removeEventListener('keyup', keyupHandler, true);
    document.removeEventListener('mousedown', mousedownHandler, true);
    document.removeEventListener('mouseup', mouseupHandler, true);
    
    inputElement.placeholder = 'Click to set...';
    if (!inputElement.value) {
      inputElement.value = '';
    }
  };
  
  // Start listening
  document.addEventListener('keydown', keydownHandler, true);
  document.addEventListener('keyup', keyupHandler, true);
  document.addEventListener('mousedown', mousedownHandler, true);
  document.addEventListener('mouseup', mouseupHandler, true);
  
  // Auto-stop after 30 seconds of no activity
  recordingTimeout = setTimeout(stopRecording, 30000);
}

// Add keybinds button listener to load on tab switch
document.addEventListener('DOMContentLoaded', () => {
  const keybindsButton = document.querySelector('[data-panel="keybinds"]');
  if (keybindsButton) {
    keybindsButton.addEventListener('click', loadKeybinds);
  }
  
  // Setup atomic saving for all settings
  setupAtomicSaving();
});

// Setup immediate atomic saving for all settings
function setupAtomicSaving() {
  let savingTimeout = null;
  
  // Helper to save settings atomically
  const saveCurrentSettings = async () => {
    const patch = {};
    
    // Collect all current settings
    const usernameEl = document.getElementById('username');
    if (usernameEl) patch.username = usernameEl.value;
    
    const themeEl = document.getElementById('theme');
    if (themeEl) patch.theme = themeEl.value;
    
    const darkEl = document.getElementById('dark-theme');
    if (darkEl) {
      patch.darkTheme = !!darkEl.checked;
      applyDarkTheme(!!darkEl.checked);
    }
    
    const auEl = document.getElementById('auto-update-startup');
    if (auEl) patch.autoCheckUpdates = !!auEl.checked;
    
    // Collect keybinds
    const inputs = document.querySelectorAll('#keybinds-list .keybind-input');
    if (inputs.length > 0) {
      const keybinds = {};
      inputs.forEach(input => {
        const bindId = input.getAttribute('data-bind-id');
        if (bindId) keybinds[bindId] = input.value;
      });
      patch.keybinds = keybinds;
    }
    
    // Save atomically
    try {
      await ipcRenderer.invoke('update-settings', patch);
    } catch (err) {
      console.error('Failed to auto-save settings:', err);
    }
  };
  
  // Setup listeners for theme dropdown
  const themeEl = document.getElementById('theme');
  if (themeEl) {
    themeEl.addEventListener('change', () => {
      clearTimeout(savingTimeout);
      savingTimeout = setTimeout(saveCurrentSettings, 500);
    });
  }
  
  // Setup listeners for dark theme checkbox
  const darkEl = document.getElementById('dark-theme');
  if (darkEl) {
    darkEl.addEventListener('change', () => {
      clearTimeout(savingTimeout);
      savingTimeout = setTimeout(saveCurrentSettings, 500);
    });
  }
  
  // Setup listeners for auto-update checkbox
  const auEl = document.getElementById('auto-update-startup');
  if (auEl) {
    auEl.addEventListener('change', () => {
      clearTimeout(savingTimeout);
      savingTimeout = setTimeout(saveCurrentSettings, 500);
    });
  }
  
  // Setup listeners for keybind inputs (after they're loaded)
  const observeKeybindsTab = () => {
    const keybindInputs = document.querySelectorAll('#keybinds-list .keybind-input');
    if (keybindInputs.length > 0) {
      keybindInputs.forEach(input => {
        // Save when recording is done (value changes)
        input.addEventListener('blur', () => {
          clearTimeout(savingTimeout);
          savingTimeout = setTimeout(saveCurrentSettings, 500);
        });
      });
    } else {
      // Recheck in a moment if keybinds haven't loaded yet
      setTimeout(observeKeybindsTab, 100);
    }
  };
  observeKeybindsTab();
}

// Browser Remote: local-LAN WebSocket controller and Discord-style role editor.
const REMOTE_PERMISSION_FEATURES = [
  'songs.view', 'songs.edit', 'verses.view', 'verses.select',
  'presentation.view', 'presentation.goLiveSongs', 'presentation.goLiveVerses', 'presentation.clear', 'presentation.black',
  'bible.view', 'bible.changeTranslation', 'schedule.view', 'schedule.edit', 'schedule.goLive', 'settings.view', 'settings.open',
  'accounts.view', 'accounts.manageDelegates', 'accounts.manageRoles'
];
const remotePermissionId = (key) => key.replace(/([A-Z])/g, '-$1').replace(/\./g, '-').toLowerCase();
let remoteTabReady = false;

function initRemoteTab(settings = {}) {
  const enabledEl = document.getElementById('remote-enabled');
  if (!enabledEl || remoteTabReady) {
    if (typeof window.refreshRemoteUI === 'function') window.refreshRemoteUI();
    return;
  }
  remoteTabReady = true;
  const portEl = document.getElementById('remote-port');
  const accessEl = document.getElementById('remote-browser-access');
  const descriptionEl = document.getElementById('remote-access-description');
  const addressWrapEl = document.getElementById('remote-address-wrap');
  const addressEl = document.getElementById('remote-address');
  const qrCanvasEl = document.getElementById('remote-qr-code');
  const firewallStatusEl = document.getElementById('remote-firewall-status');
  const fixConnectionEl = document.getElementById('remote-fix-connection');
  const usersWrapEl = document.getElementById('remote-access-users');
  const usersEl = document.getElementById('remote-user-list');
  const usersHeadingEl = document.getElementById('remote-users-heading');
  const usersDescriptionEl = document.getElementById('remote-users-description');
  const editorEl = document.getElementById('remote-user-editor');
  const editorTitleEl = document.getElementById('remote-user-editor-title');
  const editorStatusEl = document.getElementById('remote-user-editor-status');
  const editorSaveEl = document.getElementById('remote-save-user');
  const rolesLiturgiaListEl = document.getElementById('roles-liturgia-user-list');
  const rolesCredentialListEl = document.getElementById('roles-credential-user-list');
  const rolesEditorMountEl = document.getElementById('roles-editor-mount');
  const saveStatusEl = document.getElementById('remote-save-status');
  let currentUsers = [];
  let currentUserKind = 'credentials';

  if (rolesEditorMountEl && editorEl.parentElement !== rolesEditorMountEl) rolesEditorMountEl.appendChild(editorEl);

  const renderQrCode = async (address) => {
    if (!qrCanvasEl || !address) return;
    try {
      await QRCode.toCanvas(qrCanvasEl, address, {
        width: 192,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#111827', light: '#ffffff' }
      });
    } catch (error) {
      console.error('[remote] Could not render Browser Remote QR code:', error);
    }
  };

  const readOverrides = () => Object.fromEntries(REMOTE_PERMISSION_FEATURES.map((feature) => [
    feature,
    document.getElementById(`remote-permission-${remotePermissionId(feature)}`).value
  ]));
  const applyOverrides = (overrides) => {
    const next = overrides || {};
    for (const feature of REMOTE_PERMISSION_FEATURES) {
      const el = document.getElementById(`remote-permission-${remotePermissionId(feature)}`);
      if (el) el.value = next[feature] || 'inherit';
    }
  };
  const setEditor = (user = null) => {
    const isLiturgia = user && user.kind === 'liturgia';
    const isOwner = !!(user && user.isOwner);
    currentUserKind = isLiturgia ? 'liturgia' : 'credentials';
    editorStatusEl.textContent = '';
    editorEl.style.display = 'block';
    editorTitleEl.textContent = isOwner ? `${user.email} · Force-op` : (isLiturgia ? `Edit ${user.email}` : (user ? `Edit ${user.username}` : 'New local user'));
    document.getElementById('remote-user-id').value = user ? user.id : '';
    document.getElementById('remote-user-name').value = user ? (isLiturgia ? user.email : user.username) : '';
    document.getElementById('remote-user-name').readOnly = isLiturgia || isOwner;
    document.getElementById('remote-user-name-label').textContent = isLiturgia ? 'Liturgia email' : 'Username';
    document.getElementById('remote-user-password-row').style.display = isLiturgia ? 'none' : '';
    document.getElementById('remote-user-password').value = '';
    document.getElementById('remote-user-role').value = isOwner ? 'admin' : (user ? user.role : 'guest');
    applyOverrides(isOwner ? Object.fromEntries(REMOTE_PERMISSION_FEATURES.map((feature) => [feature, 'allow'])) : (user ? user.overrides : {}));
    document.getElementById('remote-user-role').disabled = isOwner;
    for (const feature of REMOTE_PERMISSION_FEATURES) {
      const permissionEl = document.getElementById(`remote-permission-${remotePermissionId(feature)}`);
      if (permissionEl) permissionEl.disabled = isOwner;
    }
    editorSaveEl.style.display = isOwner ? 'none' : '';
    if (isOwner) editorStatusEl.textContent = 'The root Liturgia account always has every permission and cannot be changed.';
    editorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const hideEditor = () => { editorEl.style.display = 'none'; editorStatusEl.textContent = ''; };
  const updateAccessDescription = () => {
    const messages = {
      liturgia: 'Each browser signs into the same Liturgia account as this PC. Its browser session is remembered on that device.',
      credentials: 'Users sign in with local credentials that you create below. Their role is enforced by the desktop.',
      open: 'Anyone on this local network can control Liturgia. Use only on a network you trust.'
    };
    descriptionEl.textContent = messages[accessEl.value] || messages.liturgia;
    const usesRoles = accessEl.value === 'credentials' || accessEl.value === 'liturgia';
    usersWrapEl.style.display = usesRoles ? 'block' : 'none';
    usersHeadingEl.textContent = accessEl.value === 'liturgia' ? 'Liturgia account access roles' : 'Local access roles';
    usersDescriptionEl.textContent = accessEl.value === 'liturgia'
      ? 'The root account is force-op. Delegated addresses appear automatically from Account Access; choose a role and then fine-tune each permission.'
      : 'Choose a role, then fine-tune each permission just like a Discord role. Passwords are stored only as secure password hashes on this PC.';
    document.getElementById('remote-new-user').style.display = accessEl.value === 'credentials' ? '' : 'none';
  };
  const renderUsers = () => {
    usersEl.replaceChildren();
    if (!currentUsers.length) {
      const empty = document.createElement('div');
      empty.className = 'remote-note';
      empty.textContent = 'No local users yet. Add a user and assign a role preset.';
      usersEl.appendChild(empty);
      return;
    }
    currentUsers.forEach((user) => {
      const card = document.createElement('div');
      card.className = 'remote-user-card';
      const details = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'remote-user-title';
      title.textContent = user.email || user.username;
      const summary = document.createElement('div');
      summary.className = 'remote-user-summary';
      const overrideCount = REMOTE_PERMISSION_FEATURES.filter((feature) => user.overrides && user.overrides[feature] !== 'inherit').length;
      summary.textContent = `${user.role || 'guest'} role · ${overrideCount ? overrideCount + ' permission override' + (overrideCount === 1 ? '' : 's') : 'role defaults'}`;
      details.append(title, summary);
      const actions = document.createElement('div');
      actions.style.display = 'flex'; actions.style.gap = '6px'; actions.style.alignItems = 'center';
      const roles = document.createElement('button');
      roles.className = 'btn'; roles.textContent = 'Roles & permissions';
      roles.addEventListener('click', () => window.openRolesAndPermissions(user));
      actions.appendChild(roles);
      if (user.isOwner) {
        const forced = document.createElement('span'); forced.className = 'remote-note'; forced.textContent = 'Force-op'; actions.appendChild(forced);
      } else {
        const remove = document.createElement('button');
        remove.className = 'btn'; remove.textContent = user.kind === 'liturgia' ? 'Reset role' : 'Remove';
        remove.disabled = user.kind === 'liturgia' && !user.id;
        remove.addEventListener('click', async () => {
          const identity = user.email || user.username;
          const wording = user.kind === 'liturgia' ? `Reset the role for "${identity}" to Guest defaults? Their saved browser sessions will be signed out.` : `Remove local user "${identity}"? Their saved browser sessions will be signed out.`;
          if (!confirm(wording)) return;
          await ipcRenderer.invoke(user.kind === 'liturgia' ? 'remote-delete-liturgia-user' : 'remote-delete-credential-user', user.id);
          await refreshUsers();
        });
        actions.appendChild(remove);
      }
      card.append(details, actions); usersEl.appendChild(card);
    });
  };
  const refreshUsers = async () => {
    if (accessEl.value === 'liturgia') {
      const result = await ipcRenderer.invoke('remote-list-liturgia-users').catch(() => ({ ok: false }));
      currentUsers = result && result.ok ? (result.users || []).map((user) => ({ ...user, kind: 'liturgia' })) : [];
      if (!result || !result.ok) saveStatusEl.textContent = (result && result.error) || 'Sign in to Liturgia on this PC to manage delegated account roles.';
    } else {
      try { currentUsers = (await ipcRenderer.invoke('remote-list-credential-users')).map((user) => ({ ...user, kind: 'credentials' })); }
      catch (_) { currentUsers = []; }
    }
    renderUsers();
  };
  let rolesRefreshPromise = null;
  let roleDirectoryUsers = [];
  const renderRoleDirectoryList = (container, users, emptyText) => {
    if (!container) return;
    container.replaceChildren();
    if (!users.length) {
      const empty = document.createElement('div'); empty.className = 'remote-note'; empty.textContent = emptyText; container.appendChild(empty); return;
    }
    users.forEach((user) => {
      const card = document.createElement('div'); card.className = 'remote-user-card';
      const details = document.createElement('div');
      const title = document.createElement('div'); title.className = 'remote-user-title'; title.textContent = user.email || user.username;
      const summary = document.createElement('div'); summary.className = 'remote-user-summary';
      const overrideCount = REMOTE_PERMISSION_FEATURES.filter((feature) => user.overrides && user.overrides[feature] !== 'inherit').length;
      summary.textContent = user.isOwner ? 'Force-op · all permissions' : `${user.role || 'guest'} role · ${overrideCount ? `${overrideCount} override${overrideCount === 1 ? '' : 's'}` : 'role defaults'}`;
      details.append(title, summary);
      const open = document.createElement('button'); open.className = 'btn'; open.textContent = user.isOwner ? 'View permissions' : 'Roles & permissions';
      open.addEventListener('click', () => window.openRolesAndPermissions(user));
      card.append(details, open); container.appendChild(card);
    });
  };
  const refreshRolesAndPermissions = async () => {
    if (rolesRefreshPromise) return rolesRefreshPromise;
    rolesRefreshPromise = (async () => {
      const [liturgiaResult, credentialResult] = await Promise.all([
        ipcRenderer.invoke('remote-list-liturgia-users').catch(() => ({ ok: false, error: 'Could not load Liturgia account users.' })),
        ipcRenderer.invoke('remote-list-credential-users').catch(() => [])
      ]);
      const liturgiaUsers = liturgiaResult && liturgiaResult.ok ? (liturgiaResult.users || []).map((user) => ({ ...user, kind: 'liturgia' })) : [];
      const credentialUsers = (Array.isArray(credentialResult) ? credentialResult : []).map((user) => ({ ...user, kind: 'credentials' }));
      roleDirectoryUsers = [...liturgiaUsers, ...credentialUsers];
      renderRoleDirectoryList(rolesLiturgiaListEl, liturgiaUsers, (liturgiaResult && liturgiaResult.error) || 'No Liturgia account users are available.');
      renderRoleDirectoryList(rolesCredentialListEl, credentialUsers, 'No local Browser Remote users yet.');
      return roleDirectoryUsers;
    })().finally(() => { rolesRefreshPromise = null; });
    return rolesRefreshPromise;
  };
  window.refreshRolesAndPermissions = refreshRolesAndPermissions;
  window.openRolesAndPermissions = async (target = null) => {
    activateSettingsPanel('roles-permissions');
    const users = await refreshRolesAndPermissions();
    if (!target) { setEditor(); return; }
    const kind = target.kind || (target.email ? 'liturgia' : 'credentials');
    const identity = String(target.email || target.username || '').trim().toLowerCase();
    const user = users.find((entry) => entry.kind === kind && String(entry.email || entry.username || '').trim().toLowerCase() === identity) || target;
    setEditor({ ...user, kind });
  };
  const refresh = async () => {
    const latest = await ipcRenderer.invoke('load-settings').catch(() => ({}));
    cachedSettings = latest || {};
    const remote = cachedSettings.remote || {};
    enabledEl.checked = !!remote.enabled;
    portEl.value = remote.port || 39847;
    accessEl.value = remote.browserAccess || 'liturgia';
    updateAccessDescription();
    const info = await ipcRenderer.invoke('remote-get-info').catch(() => ({ running: false }));
    if (info && info.running && info.addresses && info.addresses.length) {
      const address = `http://${info.addresses[0]}:${info.httpPort}/`;
      addressEl.textContent = address;
      renderQrCode(address);
      addressWrapEl.style.display = 'block';
      if (firewallStatusEl) firewallStatusEl.textContent = info.error || (info.firewall && info.firewall.message) || 'Checking local firewall…';
    } else {
      addressWrapEl.style.display = 'none';
    }
    if (fixConnectionEl) fixConnectionEl.style.display = process.platform === 'win32' ? '' : 'none';
    if (accessEl.value === 'credentials' || accessEl.value === 'liturgia') await refreshUsers();
  };
  window.refreshRemoteUI = refresh;

  accessEl.addEventListener('change', async () => { updateAccessDescription(); hideEditor(); await refreshUsers(); });
  document.getElementById('remote-new-user').addEventListener('click', () => window.openRolesAndPermissions());
  document.getElementById('roles-new-local-user').addEventListener('click', () => window.openRolesAndPermissions());
  document.getElementById('remote-cancel-user').addEventListener('click', hideEditor);
  document.getElementById('remote-save-user').addEventListener('click', async () => {
    const data = {
      id: document.getElementById('remote-user-id').value || undefined,
      role: document.getElementById('remote-user-role').value,
      permissionOverrides: readOverrides()
    };
    if (currentUserKind === 'liturgia') data.email = document.getElementById('remote-user-name').value.trim();
    else { data.username = document.getElementById('remote-user-name').value.trim(); data.password = document.getElementById('remote-user-password').value; }
    const result = await ipcRenderer.invoke(currentUserKind === 'liturgia' ? 'remote-save-liturgia-user' : 'remote-save-credential-user', data);
    if (!result || !result.ok) { editorStatusEl.textContent = (result && result.error) || 'Could not save this user.'; return; }
    hideEditor();
    await Promise.all([refreshUsers(), refreshRolesAndPermissions()]);
  });
  document.getElementById('remote-save-settings').addEventListener('click', async () => {
    const port = Number(portEl.value);
    if (!Number.isInteger(port) || port < 1024 || port > 65534) { saveStatusEl.textContent = 'Choose a port from 1024 through 65534.'; return; }
    const remote = { ...(cachedSettings.remote || {}), enabled: enabledEl.checked, port, browserAccess: accessEl.value };
    await ipcRenderer.invoke('update-settings', { remote });
    const wasRunning = await ipcRenderer.invoke('remote-get-info').then((info) => !!info.running).catch(() => false);
    if (wasRunning) await ipcRenderer.invoke('remote-stop');
    const result = enabledEl.checked ? await ipcRenderer.invoke('remote-start', port) : { success: true };
    saveStatusEl.textContent = result && result.success ? ((result.firewall && result.firewall.success === false) ? `Started, but ${result.firewall.message}` : 'Saved.') : ((result && result.error) || 'Could not start browser remote.');
    setTimeout(() => { saveStatusEl.textContent = ''; }, 3500);
    await refresh();
  });
  document.getElementById('remote-copy-address').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(addressEl.textContent); } catch (_) {}
  });
  document.getElementById('remote-fix-connection').addEventListener('click', async () => {
    const result = await ipcRenderer.invoke('remote-fix-connection');
    saveStatusEl.textContent = result && result.success ? 'Firewall rule added.' : ((result && result.error) || 'Could not update the firewall.');
  });
  refresh();
}

async function mergeAiSettings(patch) {
  try {
    if (!cachedSettings) cachedSettings = await ipcRenderer.invoke('load-settings');
    const next = { ...(cachedSettings.ai || {}), ...patch };
    cachedSettings.ai = next;
    await ipcRenderer.invoke('update-settings', { ai: next });
    return next;
  } catch (err) {
    console.error('[AI] Failed to persist settings', err);
    return null;
  }
}

function initAiTab(settings) {
  const panel = document.getElementById('panel-ai');
  if (!panel) return;
  const runtime = window.desktopRuntime;
  const runtimeMissingEl = document.getElementById('ai-runtime-missing');
  const defaultRunningContext = 'Say a verse aloud to see the rolling transcript.';
  const ui = {
    statusPill: document.getElementById('ai-sidecar-pill'),
    statusText: document.getElementById('ai-model-status-text'),
    endpoint: document.getElementById('ai-sidecar-endpoint'),
    ensureButton: document.getElementById('ai-ensure-running'),
    restartButton: document.getElementById('ai-restart-sidecar'),
    actionStatus: document.getElementById('ai-action-status'),
    modelSelect: document.getElementById('ai-model-select'),
    modelApply: document.getElementById('ai-model-apply'),
    openFolder: document.getElementById('ai-open-model-folder'),
    downloadRow: document.getElementById('ai-model-download-row'),
    downloadBar: document.getElementById('ai-model-download-bar'),
    downloadLabel: document.getElementById('ai-model-download-label'),
    deviceSelect: document.getElementById('ai-device-select'),
    refreshDevices: document.getElementById('ai-refresh-devices'),
    meterCanvas: document.getElementById('ai-meter'),
    waveformCanvas: document.getElementById('ai-waveform'),
    meterLabel: document.getElementById('ai-meter-label'),
    meterToggle: document.getElementById('ai-meter-toggle'),
    levelHint: document.getElementById('ai-level-hint'),
    suggestionsList: document.getElementById('ai-suggestions-list'),
    suggestionsEmpty: document.getElementById('ai-suggestions-empty'),
    log: document.getElementById('ai-status-log'),
    runningContext: document.getElementById('ai-running-context'),
    enableToggle: document.getElementById('ai-enable-toggle'),
    enableStatus: document.getElementById('ai-enable-status')
  };

  if (ui.runningContext && !ui.runningContext.textContent.trim()) {
    ui.runningContext.textContent = defaultRunningContext;
  }

  if (!runtime || typeof runtime.getSidecarStatus !== 'function') {
    if (runtimeMissingEl) runtimeMissingEl.style.display = 'block';
    if (ui.statusPill) ui.statusPill.textContent = 'Unavailable';
    if (ui.statusPill) ui.statusPill.classList.add('tone-err');
    if (ui.meterToggle) ui.meterToggle.disabled = true;
    if (ui.refreshDevices) ui.refreshDevices.disabled = true;
    if (ui.enableToggle) ui.enableToggle.disabled = true;
    if (ui.enableStatus) ui.enableStatus.textContent = 'Unavailable';
    return;
  }
  if (runtimeMissingEl) runtimeMissingEl.style.display = 'none';
  const state = {
    status: null,
    modelTouched: false,
    preferredDeviceId: (settings.ai && settings.ai.micDeviceId) || 'default',
    meter: {
      stream: null,
      audioCtx: null,
      analyser: null,
      source: null,
      rafId: 0,
      buffer: new Float32Array(1024)
    },
    disposers: [],
    runningContext: '',
    aiEnabled: settings.ai && typeof settings.ai.enabled === 'boolean' ? settings.ai.enabled : true,
    pendingToggle: false
  };

  handleAiEnabledChanged(state.aiEnabled, { silent: true });

  if (ui.modelSelect && settings.ai && settings.ai.modelSize) {
    ui.modelSelect.value = settings.ai.modelSize;
  }

  function logAi(message) {
    if (!ui.log) return;
    const entry = document.createElement('div');
    const stamp = new Date().toLocaleTimeString();
    entry.textContent = `[${stamp}] ${message}`;
    ui.log.prepend(entry);
    while (ui.log.childElementCount > 80) {
      ui.log.removeChild(ui.log.lastChild);
    }
  }

  function setActionStatus(message, tone = 'info') {
    if (!ui.actionStatus) return;
    ui.actionStatus.textContent = message || '';
    ui.actionStatus.classList.remove('tone-ok', 'tone-warn', 'tone-err');
    if (tone === 'ok') ui.actionStatus.classList.add('tone-ok');
    else if (tone === 'warn') ui.actionStatus.classList.add('tone-warn');
    else if (tone === 'err') ui.actionStatus.classList.add('tone-err');
  }

  function applyAiEnabledState(enabled, { silent } = {}) {
    const next = !!enabled;
    state.aiEnabled = next;
    if (ui.enableToggle && ui.enableToggle.checked !== next) {
      ui.enableToggle.checked = next;
    }
    if (ui.enableStatus) {
      ui.enableStatus.textContent = next ? 'Enabled' : 'Disabled';
      ui.enableStatus.classList.remove('tone-ok', 'tone-warn');
      ui.enableStatus.classList.add(next ? 'tone-ok' : 'tone-warn');
    }
    const disableControls = !next;
    [ui.ensureButton, ui.restartButton, ui.modelSelect, ui.modelApply, ui.openFolder, ui.deviceSelect, ui.refreshDevices, ui.meterToggle].forEach((el) => {
      if (el) el.disabled = disableControls;
    });
    if (!next) {
      stopMeter();
      if (!silent) setActionStatus('AI disabled — enable to resume the speech backend.', 'warn');
      renderRunningContext({ clearContext: true });
      if (ui.suggestionsList) ui.suggestionsList.innerHTML = '';
      if (ui.suggestionsEmpty) {
        ui.suggestionsEmpty.style.display = 'block';
        ui.suggestionsEmpty.textContent = 'Enable AI to see live suggestions.';
      }
      if (ui.levelHint) ui.levelHint.textContent = 'Enable AI to monitor microphone levels.';
    } else {
      if (ui.suggestionsEmpty) {
        ui.suggestionsEmpty.textContent = 'No live suggestions yet.';
      }
      if (!silent) {
        refreshDevices({ preserveSelection: true }).catch(() => {});
      }
      if (!state.meter.stream) {
        startMeter();
      }
      if (!silent && ui.actionStatus && !ui.actionStatus.textContent) {
        setActionStatus('AI enabled', 'ok');
      }
    }
  }

  function handleAiEnabledChanged(nextEnabled, opts = {}) {
    applyAiEnabledState(nextEnabled, opts);
  }

  function formatBytesShort(bytes) {
    if (!Number.isFinite(bytes)) return '0 B';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function extractRunningContext(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    const candidates = ['context', 'runningContext', 'transcript', 'text', 'rollingText'];
    for (const key of candidates) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (Array.isArray(payload.contextChunks) && payload.contextChunks.length) {
      return payload.contextChunks.join(' ').trim();
    }
    return '';
  }

  function formatRunningContextSnippet(text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 420) return normalized;
    return `…${normalized.slice(-420)}`;
  }

  function renderRunningContext(payload) {
    if (!ui.runningContext) return;
    if (!state.aiEnabled) {
      ui.runningContext.textContent = defaultRunningContext;
      ui.runningContext.classList.add('muted-text');
      state.runningContext = '';
      return;
    }
    if (payload && payload.clearContext) {
      state.runningContext = '';
      ui.runningContext.textContent = defaultRunningContext;
      ui.runningContext.classList.add('muted-text');
      return;
    }
    const next = extractRunningContext(payload);
    if (!next) {
      if (!state.runningContext) {
        ui.runningContext.textContent = defaultRunningContext;
        ui.runningContext.classList.add('muted-text');
      }
      return;
    }
    state.runningContext = next;
    ui.runningContext.textContent = formatRunningContextSnippet(next);
    ui.runningContext.classList.remove('muted-text');
  }

  function renderSidecarStatus(payload = {}) {
    const status = payload && payload.status ? payload.status : (payload || {});
    state.status = status;
    if (typeof status.aiDisabled === 'boolean') {
      handleAiEnabledChanged(!status.aiDisabled, { silent: true });
    }
    if (ui.statusPill) {
      ui.statusPill.classList.remove('tone-ok', 'tone-warn', 'tone-err');
      const online = !!status.portOpen;
      const ready = !!status.modelReady;
      let tone = 'tone-warn';
      let label = 'Starting';
      if (status.aiDisabled) {
        tone = 'tone-warn';
        label = 'Disabled';
      } else if (!online) {
        tone = 'tone-err';
        label = 'Offline';
      } else if (ready) {
        tone = 'tone-ok';
        label = 'Ready';
      }
      ui.statusPill.textContent = label;
      ui.statusPill.classList.add(tone);
    }

    if (ui.statusText) {
      if (status.aiDisabled) {
        ui.statusText.textContent = 'AI disabled';
      } else {
        const base = status.statusMessage ? status.statusMessage.replace(/-/g, ' ') : 'Idle';
        ui.statusText.textContent = status.lastError ? `${base} — ${status.lastError}` : base;
      }
    }

    if (ui.endpoint) {
      ui.endpoint.textContent = status.sidecarWsUrl || 'ws://127.0.0.1:8765/transcribe';
    }

    if (ui.log && status.diagnosticLog) {
      ui.log.innerHTML = '';
      const lines = status.diagnosticLog.split('\n').filter(l => l.trim());
      lines.forEach(line => {
        const entry = document.createElement('div');
        entry.textContent = line;
        ui.log.appendChild(entry);
      });
    }

    if (!state.modelTouched && status.modelSize && ui.modelSelect) {
      ui.modelSelect.value = status.modelSize;
    }

    if (ui.downloadRow) {
      const downloading = status.statusMessage === 'downloading-vosk-model' || status.downloadProgress != null || (status.downloadBytes || 0) > 0;
      if (downloading) {
        ui.downloadRow.classList.add('active');
        const percent = typeof status.downloadProgress === 'number'
          ? Math.max(0, Math.min(100, Math.round(status.downloadProgress)))
          : (status.downloadTotalBytes ? Math.round((status.downloadBytes || 0) / status.downloadTotalBytes * 100) : 0);
        if (ui.downloadBar) ui.downloadBar.value = percent;
        if (ui.downloadLabel) {
          const bytesText = status.downloadTotalBytes
            ? `${formatBytesShort(status.downloadBytes || 0)} / ${formatBytesShort(status.downloadTotalBytes)}`
            : formatBytesShort(status.downloadBytes || 0);
          ui.downloadLabel.textContent = `${percent}% (${bytesText})`;
        }
      } else {
        ui.downloadRow.classList.remove('active');
        if (ui.downloadLabel) ui.downloadLabel.textContent = '';
        if (ui.downloadBar) ui.downloadBar.value = 0;
      }
    }
  }

  function normalizeSuggestions(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.suggestions)) return payload.suggestions;
    return [];
  }

  function renderSuggestions(payload) {
    if (!ui.suggestionsList || !ui.suggestionsEmpty) return;
    if (!state.aiEnabled) {
      ui.suggestionsList.innerHTML = '';
      ui.suggestionsEmpty.style.display = 'block';
      ui.suggestionsEmpty.textContent = 'Enable AI to see live suggestions.';
      renderRunningContext({ clearContext: true });
      return;
    }
    renderRunningContext(payload);
    const items = normalizeSuggestions(payload).slice(0, 6);
    ui.suggestionsList.innerHTML = '';
    if (!items.length) {
      ui.suggestionsEmpty.style.display = 'block';
      return;
    }
    ui.suggestionsEmpty.style.display = 'none';
    items.forEach((item) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'ai-suggestion';
      const ref = document.createElement('div');
      ref.className = 'ai-suggestion-ref';
      ref.textContent = item.ref || item.reference || 'Reference';
      const why = document.createElement('div');
      why.className = 'ai-suggestion-why';
      const reasons = Array.isArray(item.reasons) ? item.reasons.join(' • ') : (item.reason || 'Confidence signal');
      why.textContent = reasons;
      wrapper.appendChild(ref);
      wrapper.appendChild(why);
      if (typeof item.score === 'number') {
        const score = document.createElement('div');
        score.className = 'ai-suggestion-why';
        score.textContent = `Score ${Math.round(item.score)} / 100`;
        wrapper.appendChild(score);
      }
      ui.suggestionsList.appendChild(wrapper);
    });
  }

  async function refreshDevices({ preserveSelection = true } = {}) {
    if (!ui.deviceSelect) return;
    if (!state.aiEnabled) {
      ui.deviceSelect.disabled = true;
      return;
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      ui.deviceSelect.innerHTML = '<option value="default">Audio APIs unavailable</option>';
      ui.deviceSelect.disabled = true;
      if (ui.refreshDevices) ui.refreshDevices.disabled = true;
      if (ui.meterToggle) ui.meterToggle.disabled = true;
      if (ui.levelHint) ui.levelHint.textContent = 'Audio APIs unavailable in this environment.';
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      ui.deviceSelect.innerHTML = '';
      const defaultOpt = document.createElement('option');
      defaultOpt.value = 'default';
      defaultOpt.textContent = 'System default microphone';
      ui.deviceSelect.appendChild(defaultOpt);
      if (!inputs.length) {
        defaultOpt.textContent = 'No microphones detected';
        ui.deviceSelect.disabled = true;
        if (ui.meterToggle) ui.meterToggle.disabled = true;
        if (ui.levelHint) ui.levelHint.textContent = 'Connect a microphone to test levels.';
        return;
      }
      ui.deviceSelect.disabled = false;
      inputs.forEach((dev, index) => {
        const opt = document.createElement('option');
        opt.value = dev.deviceId || `device-${index}`;
        opt.textContent = dev.label || `Microphone ${index + 1}`;
        ui.deviceSelect.appendChild(opt);
      });
      let target = preserveSelection ? (ui.deviceSelect.dataset.currentDevice || state.preferredDeviceId) : state.preferredDeviceId;
      const hasTarget = target === 'default' || inputs.some((d) => d.deviceId === target);
      if (!hasTarget) {
        target = inputs[0].deviceId || 'default';
      }
      ui.deviceSelect.value = target;
      ui.deviceSelect.dataset.currentDevice = target;
      state.preferredDeviceId = target;
      if (ui.meterToggle) ui.meterToggle.disabled = false;
    } catch (err) {
      console.error('Failed to enumerate devices', err);
      setActionStatus('Unable to enumerate microphones', 'err');
    }
  }

  function clearCanvasSurface(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function resetMeterVisuals() {
    clearCanvasSurface(ui.meterCanvas);
    clearCanvasSurface(ui.waveformCanvas);
  }

  function stopMeter() {
    const meter = state.meter;
    const wasRunning = !!(meter.stream || meter.audioCtx || meter.rafId);
    if (meter.rafId) cancelAnimationFrame(meter.rafId);
    if (meter.source) {
      try { meter.source.disconnect(); } catch (_) {}
    }
    if (meter.audioCtx) {
      try { meter.audioCtx.close(); } catch (_) {}
    }
    if (meter.stream) {
      meter.stream.getTracks().forEach((track) => track.stop());
    }
    state.meter = { stream: null, audioCtx: null, analyser: null, source: null, rafId: 0, buffer: new Float32Array(1024) };
    if (ui.meterToggle) ui.meterToggle.textContent = 'Resume meter';
    if (ui.levelHint) ui.levelHint.textContent = 'Meter paused.';
    if (ui.meterLabel) ui.meterLabel.textContent = 'Level 0%';
    resetMeterVisuals();
    if (wasRunning) logAi('Microphone meter stopped');
  }

  function drawMeterFrame() {
    const meter = state.meter;
    if (!meter.analyser || !ui.meterCanvas) return;
    meter.analyser.getFloatTimeDomainData(meter.buffer);
    let sum = 0;
    for (let i = 0; i < meter.buffer.length; i++) {
      sum += meter.buffer[i] * meter.buffer[i];
    }
    const rms = Math.sqrt(sum / meter.buffer.length);
    const level = Math.min(1, rms * 8);
    if (ui.meterLabel) ui.meterLabel.textContent = `Level ${Math.round(level * 100)}%`;

    const meterCtx = ui.meterCanvas.getContext('2d');
    if (!meterCtx) return;
    const width = ui.meterCanvas.width;
    const height = ui.meterCanvas.height;
    meterCtx.fillStyle = '#05070d';
    meterCtx.fillRect(0, 0, width, height);
    const color = level > 0.65 ? '#57d37d' : (level > 0.35 ? '#f3c767' : '#71a8ff');
    meterCtx.fillStyle = color;
    meterCtx.fillRect(0, height - height * 0.85, width * level, height * 0.85);

    if (ui.waveformCanvas) {
      const waveformCtx = ui.waveformCanvas.getContext('2d');
      if (waveformCtx) {
        const w = ui.waveformCanvas.width;
        const h = ui.waveformCanvas.height;
        waveformCtx.fillStyle = '#05070d';
        waveformCtx.fillRect(0, 0, w, h);
        waveformCtx.lineWidth = 2;
        waveformCtx.strokeStyle = '#5cc4ff';
        waveformCtx.beginPath();
        const sliceWidth = w / meter.buffer.length;
        let x = 0;
        for (let i = 0; i < meter.buffer.length; i++) {
          const v = meter.buffer[i] * 0.5 + 0.5;
          const y = Math.min(h, Math.max(0, v * h));
          if (i === 0) waveformCtx.moveTo(x, y);
          else waveformCtx.lineTo(x, y);
          x += sliceWidth;
        }
        waveformCtx.stroke();
        waveformCtx.strokeStyle = 'rgba(255,255,255,0.15)';
        waveformCtx.beginPath();
        waveformCtx.moveTo(0, h / 2);
        waveformCtx.lineTo(w, h / 2);
        waveformCtx.stroke();
      }
    }

    meter.rafId = requestAnimationFrame(drawMeterFrame);
  }

  async function startMeter() {
    if (!state.aiEnabled) {
      if (ui.levelHint) ui.levelHint.textContent = 'Enable AI to monitor microphone levels.';
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || state.meter.stream || !ui.meterCanvas) return;
    if (ui.meterToggle) ui.meterToggle.disabled = true;
    setActionStatus('Starting meter…', 'warn');
    try {
      const constraints = (state.preferredDeviceId && state.preferredDeviceId !== 'default')
        ? { audio: { deviceId: { exact: state.preferredDeviceId } } }
        : { audio: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      state.meter = {
        stream,
        audioCtx,
        analyser,
        source,
        rafId: 0,
        buffer: new Float32Array(analyser.fftSize)
      };
      if (ui.meterToggle) ui.meterToggle.textContent = 'Pause meter';
      if (ui.levelHint) ui.levelHint.textContent = 'Listening… speak to view live levels.';
      setActionStatus('Meter running', 'ok');
      logAi('Microphone meter started');
      drawMeterFrame();
    } catch (err) {
      console.error('Failed to start meter', err);
      setActionStatus(err?.message || 'Unable to access microphone', 'err');
      if (ui.levelHint) ui.levelHint.textContent = 'Microphone permission denied or unavailable.';
    } finally {
      if (ui.meterToggle) ui.meterToggle.disabled = false;
    }
  }

  if (ui.modelSelect) {
    ui.modelSelect.addEventListener('change', () => {
      state.modelTouched = true;
    });
  }

  if (ui.modelApply) {
    ui.modelApply.addEventListener('click', async () => {
      if (!runtime.setSidecarModelSize) return;
      ui.modelApply.disabled = true;
      const size = ui.modelSelect ? ui.modelSelect.value : 'small';
      setActionStatus('Applying model…', 'warn');
      try {
        const result = await runtime.setSidecarModelSize(size);
        if (result && result.ok) {
          if (result.status) renderSidecarStatus(result.status);
          await mergeAiSettings({ modelSize: size });
          setActionStatus(`Model switched to ${size}`, 'ok');
          logAi(`Requested model switch to ${size}`);
        } else {
          setActionStatus((result && result.error) || 'Failed to apply model', 'err');
        }
      } catch (err) {
        setActionStatus(err?.message || 'Failed to apply model', 'err');
      } finally {
        ui.modelApply.disabled = false;
      }
    });
  }

  if (ui.openFolder) {
    ui.openFolder.addEventListener('click', async () => {
      if (!runtime.openSidecarModelFolder) return;
      setActionStatus('Opening model folder…', 'info');
      try {
        const res = await runtime.openSidecarModelFolder();
        if (res && res.ok) {
          setActionStatus('Model folder opened', 'ok');
          logAi('Opened model folder');
        } else {
          setActionStatus((res && res.error) || 'Failed to open folder', 'err');
        }
      } catch (err) {
        setActionStatus(err?.message || 'Failed to open folder', 'err');
      }
    });
  }

  if (ui.ensureButton) {
    ui.ensureButton.addEventListener('click', async () => {
      if (!runtime.ensureSidecarRunning) return;
      setActionStatus('Ensuring backend is running…', 'warn');
      try {
        const res = await runtime.ensureSidecarRunning();
        if (res) renderSidecarStatus(res);
        setActionStatus('Backend check complete', 'ok');
        logAi('Ensured sidecar is running');
      } catch (err) {
        setActionStatus(err?.message || 'Failed to contact backend', 'err');
      }
    });
  }

  if (ui.restartButton) {
    ui.restartButton.addEventListener('click', async () => {
      if (!runtime.restartSidecar) return;
      setActionStatus('Restarting backend…', 'warn');
      ui.restartButton.disabled = true;
      try {
        const res = await runtime.restartSidecar();
        if (res && res.ok && res.status) renderSidecarStatus(res.status);
        setActionStatus('Backend restarted', 'ok');
        logAi('Sidecar restart requested');
      } catch (err) {
        setActionStatus(err?.message || 'Failed to restart backend', 'err');
      } finally {
        ui.restartButton.disabled = false;
      }
    });
  }

  if (ui.deviceSelect) {
    ui.deviceSelect.addEventListener('change', async (event) => {
      const value = event.target.value;
      ui.deviceSelect.dataset.currentDevice = value;
      state.preferredDeviceId = value;
      await mergeAiSettings({ micDeviceId: value });
      if (state.meter.stream) {
        stopMeter();
        startMeter();
      }
    });
  }

  if (ui.refreshDevices) {
    ui.refreshDevices.addEventListener('click', () => refreshDevices({ preserveSelection: false }));
  }

  if (ui.meterToggle) {
    ui.meterToggle.addEventListener('click', () => {
      if (state.meter.stream) {
        stopMeter();
      } else {
        startMeter();
      }
    });
  }

  if (ui.enableToggle) {
    if (!runtime.setAiEnabled) {
      ui.enableToggle.disabled = true;
      if (ui.enableStatus) ui.enableStatus.textContent = 'Unavailable';
    } else {
      ui.enableToggle.addEventListener('change', async () => {
        if (state.pendingToggle) return;
        const desired = !!ui.enableToggle.checked;
        state.pendingToggle = true;
        ui.enableToggle.disabled = true;
        setActionStatus(desired ? 'Enabling AI…' : 'Disabling AI…', 'warn');
        try {
          const result = await runtime.setAiEnabled(desired);
          if (result && typeof result.enabled === 'boolean') {
            handleAiEnabledChanged(result.enabled, { silent: false });
          } else {
            handleAiEnabledChanged(desired, { silent: false });
          }
          if (result && result.status) renderSidecarStatus(result.status);
          setActionStatus(desired ? 'AI enabled' : 'AI disabled', 'ok');
        } catch (err) {
          ui.enableToggle.checked = !desired;
          handleAiEnabledChanged(!desired, { silent: true });
          setActionStatus(err?.message || 'Failed to update AI toggle', 'err');
        } finally {
          state.pendingToggle = false;
          ui.enableToggle.disabled = false;
        }
      });
    }
  }

  resetMeterVisuals();
  refreshDevices()
    .catch(() => {})
    .finally(() => {
      if (state.aiEnabled && !state.meter.stream) {
        startMeter();
      }
    });

  if (typeof runtime.getAiEnabled === 'function') {
    runtime.getAiEnabled().then((res) => {
      const enabled = (res && typeof res.enabled === 'boolean') ? res.enabled : !!res;
      handleAiEnabledChanged(enabled, { silent: true });
      if (res && res.status) {
        renderSidecarStatus(res.status);
      }
    }).catch(() => {});
  }

  runtime.getSidecarStatus().then(renderSidecarStatus).catch(() => {});

  // Check and display Python availability
  const pythonMissingEl = document.getElementById('ai-python-missing');
  const pythonStatusEl = document.getElementById('ai-python-status');
  
  async function checkAndDisplayPythonStatus() {
    if (!pythonMissingEl) return;
    try {
      console.log('[Python check] Starting check...');
      
      // Add a timeout wrapper - if check takes > 5s, assume Python missing
      const checkPromise = ipcRenderer.invoke('check-python-available');
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => {
          console.log('[Python check] Check timed out after 5s');
          resolve({ available: false, pythonFound: false, timeout: true });
        }, 5000);
      });
      
      const result = await Promise.race([checkPromise, timeoutPromise]);
      console.log('[Python check] Result:', result);
      
      if (result && result.available) {
        // Python and dependencies are available
        console.log('[Python check] Python available, hiding warning');
        pythonMissingEl.style.display = 'none';
      } else {
        // Python missing, not found, has missing packages, or timed out
        console.log('[Python check] Python NOT available, showing warning');
        pythonMissingEl.style.display = 'block';
        
        if (result && result.timeout) {
          if (pythonStatusEl) pythonStatusEl.textContent = 'Python check timed out. Click "Download Python" to install.';
        } else if (result && !result.pythonFound) {
          if (pythonStatusEl) pythonStatusEl.textContent = 'Python not found. Click "Download Python" above to install it.';
        } else if (result && result.missingPackages) {
          if (pythonStatusEl) pythonStatusEl.textContent = `Missing packages: ${result.missingPackages.join(', ')}. Try the recheck button after installing Python.`;
        } else {
          if (pythonStatusEl) pythonStatusEl.textContent = 'Unable to determine Python status. Click "Download Python" to install.';
        }
      }
    } catch (err) {
      console.error('[Python check] Exception:', err);
      // On error, show the warning so user can try downloading
      pythonMissingEl.style.display = 'block';
      if (pythonStatusEl) {
        pythonStatusEl.textContent = `Could not check Python: ${err.message}. Try the download button above.`;
      }
    }
  }

  // Check Python status automatically when settings first opens (not just when AI tab clicked)
  checkAndDisplayPythonStatus();

  // Check Python status when AI tab is opened, not during init
  const aiTabButton = document.querySelector('button[data-panel="ai"]');
  if (aiTabButton && !aiTabButton._pythonCheckSetup) {
    aiTabButton._pythonCheckSetup = true;
    aiTabButton.addEventListener('click', () => {
      // Show loading state immediately
      if (pythonStatusEl) pythonStatusEl.textContent = 'Checking Python…';
      // Check asynchronously in background
      checkAndDisplayPythonStatus();
    });
  }

  // Button to download Python (auto-detects platform and downloads)
  const downloadPythonBtn = document.getElementById('ai-download-python');
  if (downloadPythonBtn) {
    downloadPythonBtn.addEventListener('click', async () => {
      downloadPythonBtn.disabled = true;
      const originalText = downloadPythonBtn.textContent;
      downloadPythonBtn.textContent = 'Downloading Python (0%)...';
      
      if (pythonStatusEl) pythonStatusEl.textContent = 'Downloading Python installer...';
      
      try {
        // Request Python download - this will report progress
        const result = await ipcRenderer.invoke('download-python');
        
        if (result.success) {
          downloadPythonBtn.textContent = 'Python Downloaded';
          if (pythonStatusEl) pythonStatusEl.textContent = result.message;
        } else {
          downloadPythonBtn.textContent = originalText;
          if (pythonStatusEl) pythonStatusEl.textContent = result.message;
        }
      } catch (err) {
        console.error('Python download failed:', err);
        downloadPythonBtn.textContent = originalText;
        if (pythonStatusEl) pythonStatusEl.textContent = `Download failed: ${err.message}`;
      } finally {
        downloadPythonBtn.disabled = false;
      }
    });
    
    // Listen for download progress updates from main process
    ipcRenderer.on('python-download-progress', (event, { percent }) => {
      downloadPythonBtn.textContent = `Downloading Python (${percent}%)...`;
    });
  }

  // Button to recheck Python/dependencies
  const recheckPythonBtn = document.getElementById('ai-recheck-python');
  if (recheckPythonBtn) {
    recheckPythonBtn.addEventListener('click', async () => {
      recheckPythonBtn.disabled = true;
      if (pythonStatusEl) pythonStatusEl.textContent = 'Checking…';
      try {
        await checkAndDisplayPythonStatus();
        if (pythonStatusEl && pythonMissingEl.style.display === 'none') {
          pythonStatusEl.textContent = 'Re-checking dependencies…';
          setTimeout(() => {
            if (pythonStatusEl) pythonStatusEl.textContent = '';
          }, 2000);
        }
      } finally {
        recheckPythonBtn.disabled = false;
      }
    });
  }

  if (typeof runtime.onSidecarStatus === 'function') {
    const dispose = runtime.onSidecarStatus(renderSidecarStatus);
    if (typeof dispose === 'function') state.disposers.push(dispose);
  }
  if (runtime.getLatestSuggestions) {
    runtime.getLatestSuggestions().then(renderSuggestions).catch(() => {});
  }
  if (typeof runtime.onSuggestions === 'function') {
    const disposeSuggestions = runtime.onSuggestions(renderSuggestions);
    if (typeof disposeSuggestions === 'function') state.disposers.push(disposeSuggestions);
  }

  if (typeof runtime.onAiEnabledChanged === 'function') {
    const disposeToggle = runtime.onAiEnabledChanged((enabled) => {
      handleAiEnabledChanged(enabled);
    });
    if (typeof disposeToggle === 'function') state.disposers.push(disposeToggle);
  }

  window.addEventListener('beforeunload', () => {
    stopMeter();
    state.disposers.forEach((dispose) => {
      try { dispose && dispose(); } catch (_) {}
    });
    state.disposers = [];
  }, { once: true });
}

// Cloud Relay initialization
(async () => {
  const settings = await ipcRenderer.invoke('load-settings');
  const relayEnabledEl = document.getElementById('relay-enabled');
  const relayDeviceNameEl = document.getElementById('relay-device-name');
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
    if (relayDeviceNameEl) relayDeviceNameEl.value = settings.relay.deviceName || '';
  }

  // Auto-save device name on change
  if (relayDeviceNameEl) {
    relayDeviceNameEl.addEventListener('input', async () => {
      const name = relayDeviceNameEl.value.trim();
      const s = await ipcRenderer.invoke('load-settings');
      const relay = (s && s.relay) || {};
      relay.deviceName = name;
      await ipcRenderer.invoke('update-settings', { relay });
    });
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
      
      const methodEl = document.getElementById('relay-connection-method');
      if (methodEl && info.connectionMethod) {
        methodEl.textContent = info.connectionMethod;
      }
    } else {
      if (relayConnectedInfoEl) relayConnectedInfoEl.style.display = 'none';
    }
  }
  
  // Expose refreshRelayUI to global scope so it can be called from tab click listener
  window.refreshRelayUI = refreshRelayUI;
  
  // Don't call refreshRelayUI() on init - instead set up listener for tab click
  // This prevents blocking the settings window from opening

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
        const deviceName = (relayDeviceNameEl && relayDeviceNameEl.value.trim()) || 'Liturgia Desktop';
        const result = await ipcRenderer.invoke('relay-start', {
          token: authToken,
          deviceName
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

ipcRenderer.on('relay-connection-method', (event, method) => {
  const methodEl = document.getElementById('relay-connection-method');
  if (methodEl) {
    methodEl.textContent = method;
  }
});

// Live toggle dark theme
document.getElementById('dark-theme').addEventListener('change', (e) => {
  applyDarkTheme(e.target.checked);
});

document.getElementById('reload-displays').addEventListener('click', loadDisplays);

document.getElementById('add-display-entry').addEventListener('click', async () => {
  const ids = readCurrentIds();
  const defaultId = _allDisplays.length > 0 ? _allDisplays[0].id : 1;
  ids.push(defaultId);
  await ipcRenderer.invoke('update-settings', { liveDisplays: ids });
  loadDisplays();
});

document.getElementById('open-live-window').addEventListener('click', async () => {
  await ipcRenderer.invoke('create-live-window');
  setTimeout(loadDisplays, 400);
});

document.getElementById('close-live-window').addEventListener('click', async () => {
  await ipcRenderer.invoke('close-live-window');
  setTimeout(loadDisplays, 400);
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
      if (signInBtn) signInBtn.style.display = '';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (viewSubBtn) viewSubBtn.style.display = 'none';
      if (purchaseBtn) { purchaseBtn.style.display = ''; purchaseBtn.disabled = false; purchaseBtn.title = ''; }
      refreshAccountAccess();
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

  // Subscribe — plan chooser modal
  if (purchaseBtn) {
    let _subscribePlan = null;
    const overlay = document.getElementById('subscribe-modal-overlay');
    const stepPlan = document.getElementById('subscribe-modal-step-plan');
    const stepEmail = document.getElementById('subscribe-modal-step-email');
    const planTitle = document.getElementById('subscribe-modal-plan-title');
    const emailInput = document.getElementById('subscribe-modal-email');
    const statusEl = document.getElementById('subscribe-modal-status');

    function _openSubscribeModal() {
      _subscribePlan = null;
      stepPlan.style.display = '';
      stepEmail.style.display = 'none';
      if (statusEl) statusEl.textContent = '';
      overlay.style.display = 'flex';
    }
    function _closeSubscribeModal() {
      overlay.style.display = 'none';
    }

    purchaseBtn.addEventListener('click', _openSubscribeModal);

    if (overlay) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeSubscribeModal(); });
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay && overlay.style.display === 'flex') _closeSubscribeModal(); });

    document.getElementById('subscribe-modal-cancel-plan').addEventListener('click', _closeSubscribeModal);

    stepPlan.querySelectorAll('button[data-plan]').forEach(btn => {
      btn.addEventListener('click', async () => {
        _subscribePlan = btn.dataset.plan;
        planTitle.textContent = `Subscribe — ${_subscribePlan === 'yearly' ? 'Yearly' : 'Monthly'}`;
        if (statusEl) statusEl.textContent = '';
        let prefillEmail = '';
        try {
          const tok = await ipcRenderer.invoke('secure-get-token');
          if (tok) { const p = decodeJwtPayload(tok); if (p && (p.email || p.sub)) prefillEmail = p.email || p.sub; }
        } catch (e) {}
        emailInput.value = prefillEmail;
        stepPlan.style.display = 'none';
        stepEmail.style.display = '';
        emailInput.focus();
      });
    });

    document.getElementById('subscribe-modal-back').addEventListener('click', () => {
      stepEmail.style.display = 'none';
      stepPlan.style.display = '';
    });

    document.getElementById('subscribe-modal-confirm').addEventListener('click', async () => {
      const email = emailInput.value.trim();
      if (!email || !email.includes('@')) { if (statusEl) statusEl.textContent = 'Enter a valid email address.'; return; }
      if (statusEl) statusEl.textContent = 'Creating checkout...';
      const confirmBtn = document.getElementById('subscribe-modal-confirm');
      confirmBtn.disabled = true;
      try {
        const settings = await ipcRenderer.invoke('load-settings');
        const server = (settings && settings.licenseServer) ? settings.licenseServer.replace(/\/$/, '') : 'https://jacqueb.me/liturgia';
        const body = new URLSearchParams({ email, plan: _subscribePlan }).toString();
        const res = await fetch(server + '/create-checkout-session.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
        let j = null;
        try { j = await res.json(); } catch (e) { j = null; }
        if (j && j.url) {
          _closeSubscribeModal();
          require('electron').shell.openExternal(j.url);
        } else {
          if (statusEl) statusEl.textContent = (j && j.error) ? j.error : 'Server error. Please try again.';
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Request failed. Check your connection.';
      } finally {
        confirmBtn.disabled = false;
      }
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
          if (!displayEmail) {
            const secTok = await ipcRenderer.invoke('secure-get-token');
            if (secTok) {
              const p = decodeJwtPayload(secTok);
              if (p && (p.email || p.sub)) displayEmail = p.email || p.sub;
            }
          }
        } catch (e) {}
      }
      ai.textContent = displayEmail || 'Signed in';
      if (status.active) {
        si.textContent = `Plan: ${status.plan || (status.user_row ? status.user_row.plan : 'unknown')} — Expires: ${formatLicenseExpiry(status)}${status.offline ? ' (verified offline)' : ''}`;
      } else {
        si.textContent = `Not active (${status.reason || 'inactive'}).`;
      }

      // Toggle buttons
      const hasCustomerId = !!(status.user_row && status.user_row.stripe_customer_id);
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = '';
      if (hasCustomerId && status.active) {
        if (viewSubBtn) viewSubBtn.style.display = '';
        if (purchaseBtn) { purchaseBtn.style.display = 'none'; purchaseBtn.disabled = false; purchaseBtn.title = ''; }
      } else {
        if (viewSubBtn) viewSubBtn.style.display = 'none';
        if (purchaseBtn) {
          purchaseBtn.style.display = '';
          purchaseBtn.disabled = !!status.active;
          purchaseBtn.title = status.active ? 'You already have an active subscription' : '';
        }
      }
    } else {
      ai.textContent = 'Not signed in';
      si.textContent = '';
      if (signInBtn) signInBtn.style.display = '';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (viewSubBtn) viewSubBtn.style.display = 'none';
      if (purchaseBtn) { purchaseBtn.style.display = ''; purchaseBtn.disabled = false; purchaseBtn.title = ''; }
    }
  });

// Account Access settings: require a saved token and keep network failures
// readable. No account mutation is attempted while the service is unreachable.
function setAccountAccessStatus(message, tone) {
  const status = document.getElementById('account-access-status');
  if (!status) return;
  status.textContent = message;
  status.style.color = tone === 'error' ? '#b42318' : (tone === 'success' ? '#157347' : 'var(--muted)');
}

function showAccountAccessContent(show) {
  const content = document.getElementById('account-access-content');
  if (content) content.style.display = show ? '' : 'none';
}

function accountAccessErrorMessage(error) {
  if (error && error.code === 'no-token') return 'Sign in first to manage tokens and delegated email addresses.';
  if (error && error.code === 'network') return 'Could not reach Liturgia. Your saved token remains unchanged, but account changes need a connection.';
  if (error && error.code === 401) return 'Your saved token could not be authenticated right now. Account changes are disabled until it can be verified online.';
  return (error && error.message) || 'Could not load account access. Please try again.';
}

async function getAccountAccessContext() {
  const token = await getSavedToken();
  if (!token) {
    const error = new Error('Sign in first.'); error.code = 'no-token'; throw error;
  }
  const settings = await ipcRenderer.invoke('load-settings').catch(() => ({}));
  const server = ((settings && settings.licenseServer) || 'https://jacqueb.me/liturgia').replace(/\/$/, '');
  return { token, server };
}

async function accountApiRequest(path, options = {}) {
  const { token, server } = await getAccountAccessContext();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = { Authorization: 'Bearer ' + token };
    const request = { method: options.method || 'GET', headers, signal: controller.signal };
    if (options.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      request.body = new URLSearchParams(options.form).toString();
    }
    let response;
    try {
      response = await fetch(server + '/' + path, request);
    } catch (cause) {
      const error = new Error('Network request failed.'); error.code = 'network'; error.cause = cause; throw error;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || ('Request failed (' + response.status + ').'));
      error.code = response.status; error.body = body; throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function makeAccessRow(primaryText, secondaryText, actions) {
  const row = document.createElement('div');
  row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.alignItems = 'center'; row.style.gap = '8px'; row.style.padding = '7px 0';
  const details = document.createElement('div');
  const primary = document.createElement('div'); primary.style.fontWeight = '600'; primary.textContent = primaryText;
  const secondary = document.createElement('div'); secondary.className = 'muted-text'; secondary.style.fontSize = '0.85em'; secondary.textContent = secondaryText || '';
  details.appendChild(primary); details.appendChild(secondary);
  const controls = document.createElement('div'); controls.style.display = 'flex'; controls.style.gap = '6px';
  actions.forEach(action => {
    const button = document.createElement('button'); button.className = 'btn'; button.textContent = action.label; button.onclick = action.onClick;
    controls.appendChild(button);
  });
  row.appendChild(details); row.appendChild(controls);
  return row;
}

function renderAccountTokens(tokens) {
  const list = document.getElementById('account-token-list');
  const count = document.getElementById('account-token-count');
  if (!list) return;
  if (count) count.textContent = '(' + tokens.length + ')';
  list.textContent = '';
  if (!tokens.length) { list.textContent = 'No active tokens.'; return; }
  tokens.forEach(token => {
    const created = token.created_at ? ('Created ' + new Date(token.created_at).toLocaleString()) : 'Created date unavailable';
    list.appendChild(makeAccessRow(token.label || token.device || 'Unnamed device', created, [
      { label: 'Copy', onClick: () => copyAccountToken(token.id) },
      { label: 'Revoke', onClick: () => revokeAccountToken(token.id) }
    ]));
  });
}

function renderAccountDelegates(delegates, limit) {
  const list = document.getElementById('account-delegate-list');
  const count = document.getElementById('account-delegate-count');
  if (!list) return;
  if (count) count.textContent = '(' + delegates.length + '/' + (limit || 10) + ')';
  list.textContent = '';
  if (!delegates.length) { list.textContent = 'No delegated email addresses.'; return; }
  delegates.forEach(delegate => {
    const created = delegate.created_at ? ('Added ' + new Date(delegate.created_at).toLocaleString()) : '';
    list.appendChild(makeAccessRow(delegate.delegate_email, created, [
      { label: 'Roles & permissions', onClick: () => window.openRolesAndPermissions({ kind: 'liturgia', email: delegate.delegate_email }) },
      { label: 'Remove', onClick: () => updateAccountDelegate('remove', delegate.delegate_email) }
    ]));
  });
}

async function refreshAccountAccess() {
  setAccountAccessStatus('Checking account access…');
  try {
    const [tokenData, delegateData] = await Promise.all([
      accountApiRequest('auth/list-tokens.php'),
      accountApiRequest('auth/delegated-emails.php')
    ]);
    renderAccountTokens(tokenData.tokens || []);
    renderAccountDelegates(delegateData.delegates || [], delegateData.limit || 10);
    showAccountAccessContent(true);
    setAccountAccessStatus('Account access is ready.', 'success');
  } catch (error) {
    showAccountAccessContent(false);
    setAccountAccessStatus(accountAccessErrorMessage(error), 'error');
  }
}

async function copyAccountToken(id) {
  try {
    const data = await accountApiRequest('auth/show-token.php?id=' + encodeURIComponent(id));
    if (!data.token) throw new Error('The token could not be retrieved.');
    await navigator.clipboard.writeText(data.token);
    setAccountAccessStatus('Token copied to the clipboard.', 'success');
  } catch (error) { setAccountAccessStatus(accountAccessErrorMessage(error), 'error'); }
}

async function revokeAccountToken(id) {
  if (!confirm('Revoke this token? The device using it will need to sign in again.')) return;
  try {
    await accountApiRequest('auth/revoke-token.php', { method: 'POST', form: { id } });
    setAccountAccessStatus('Token revoked.', 'success');
    refreshAccountAccess();
  } catch (error) { setAccountAccessStatus(accountAccessErrorMessage(error), 'error'); }
}

async function createAccountToken() {
  const input = document.getElementById('account-token-label');
  try {
    const data = await accountApiRequest('auth/generate-token.php', { method: 'POST', form: { label: input ? input.value.trim() : '', device: 'Liturgia desktop settings' } });
    if (!data.token) throw new Error('The server did not return a token.');
    const output = document.getElementById('account-created-token');
    const copy = document.getElementById('account-copy-created-token');
    if (output) { output.value = data.token; output.style.display = ''; }
    if (copy) copy.style.display = '';
    if (input) input.value = '';
    setAccountAccessStatus('New token created. Copy it before closing Settings.', 'success');
    refreshAccountAccess();
  } catch (error) { setAccountAccessStatus(accountAccessErrorMessage(error), 'error'); }
}

async function updateAccountDelegate(action, email) {
  try {
    const data = await accountApiRequest('auth/delegated-emails.php', { method: 'POST', form: { action, email } });
    if (!data.ok) throw new Error(data.error || 'Delegated email update failed.');
    const input = document.getElementById('account-delegate-email'); if (input) input.value = '';
    setAccountAccessStatus(action === 'add' ? 'Delegated email added.' : 'Delegated email removed.', 'success');
    refreshAccountAccess();
  } catch (error) {
    const messages = { invalid_email: 'Enter a valid email address.', owner_email: 'Your account email is already included.', already_delegated: 'That email belongs to another shared account.', email_has_own_account: 'That email already has its own account and cannot be merged.', delegate_limit: 'You can delegate access to up to 10 email addresses.' };
    setAccountAccessStatus(messages[error && error.body && error.body.error] || accountAccessErrorMessage(error), 'error');
  }
}

const accessRefreshButton = document.getElementById('account-refresh-access');
if (accessRefreshButton) accessRefreshButton.addEventListener('click', refreshAccountAccess);
const accessCreateTokenButton = document.getElementById('account-create-token');
if (accessCreateTokenButton) accessCreateTokenButton.addEventListener('click', createAccountToken);
const accessAddDelegateButton = document.getElementById('account-add-delegate');
if (accessAddDelegateButton) accessAddDelegateButton.addEventListener('click', () => {
  const input = document.getElementById('account-delegate-email');
  updateAccountDelegate('add', input ? input.value.trim() : '');
});
const accessCopyCreatedButton = document.getElementById('account-copy-created-token');
if (accessCopyCreatedButton) accessCopyCreatedButton.addEventListener('click', async () => {
  const output = document.getElementById('account-created-token');
  if (!output || !output.value) return;
  try { await navigator.clipboard.writeText(output.value); setAccountAccessStatus('New token copied to the clipboard.', 'success'); }
  catch (error) { setAccountAccessStatus('Could not copy the token. Select and copy it manually.', 'error'); }
});
refreshAccountAccess();

// Load list of available local (imported) Bibles from userData
async function loadLocalBibles() {
  const userData = await ipcRenderer.invoke('get-user-data-path');
  const biblesBase = path.join(userData, 'bibles');
  if (!fs.existsSync(biblesBase)) return [];
  const entries = fs.readdirSync(biblesBase, { withFileTypes: true });
  const local = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const bibleFile = path.join(biblesBase, entry.name, 'bible.json');
      if (fs.existsSync(bibleFile)) {
        local.push(entry.name); // e.g. 'en_kjv', 'my_bible'
      }
    }
  }
  return local;
}

async function renderLocalBiblesList(localIds) {
  const section = document.getElementById('bibles-local-section');
  const container = document.getElementById('bibles-local-list');
  if (!localIds || localIds.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  container.innerHTML = '';

  const currentBible = await ipcRenderer.invoke('get-default-bible');

  for (const versionId of localIds) {
    const isSelected = `${versionId}.json` === currentBible || versionId === currentBible;
    const displayName = versionId.replace(/_/g, ' ').toUpperCase();

    const item = document.createElement('div');
    item.className = 'bible-item' + (isSelected ? ' selected' : '');
    item.innerHTML = `
      <div class="bible-item-header">
        <span class="bible-name">${displayName}<span class="bible-local-tag">local</span></span>
        <span class="bible-status downloaded">Downloaded</span>
      </div>
      <div class="bible-item-actions">
        <button class="bible-action ${isSelected ? 'selected' : 'select'}" data-version="${versionId}"
                ${isSelected ? 'disabled' : ''}>
          ${isSelected ? 'Currently Active' : 'Select'}
        </button>
        <button class="bible-action export" data-export-version="${versionId}">Export</button>
      </div>
    `;

    const btn = item.querySelector('.bible-action[data-version]');
    btn.addEventListener('click', async () => {
      const fileName = `${versionId}.json`;
      await selectBible(fileName);
      // Re-render both sections
      const localIds2 = await loadLocalBibles();
      await renderLocalBiblesList(localIds2);
      if (allBibleFiles && allBibleFiles.length > 0) renderBiblesList(allBibleFiles);
    });

    const exportBtn = item.querySelector('.bible-action.export');
    exportBtn.addEventListener('click', async (e) => {
      const popover = document.getElementById('bible-export-format-popover');
      const rect = exportBtn.getBoundingClientRect();
      popover.style.top = `${rect.bottom + 4}px`;
      popover.style.left = `${rect.left}px`;
      popover.classList.add('active');
      popover.dataset.currentVersion = versionId;
      popover.dataset.currentButton = 'true';

      const closePopover = () => {
        popover.classList.remove('active');
        document.removeEventListener('click', outsideClick);
      };
      const outsideClick = (evt) => {
        if (!popover.contains(evt.target) && evt.target !== exportBtn) closePopover();
      };
      setTimeout(() => document.addEventListener('click', outsideClick), 0);
    });

    container.appendChild(item);
  }
}

async function handleBibleImport() {
  const statusEl = document.getElementById('bible-import-status');
  statusEl.textContent = '';

  const formatsOverlay = document.getElementById('bible-formats-modal-overlay');
  formatsOverlay.style.display = 'flex';

  const shouldContinue = await new Promise(resolve => {
    const continueBtn = document.getElementById('bible-formats-modal-continue');
    const cancelBtn = document.getElementById('bible-formats-modal-cancel');
    function doContinue() { cleanup(); resolve(true); }
    function doCancel() { cleanup(); resolve(false); }
    function onOverlayClick(e) { if (e.target === formatsOverlay) { cleanup(); resolve(false); } }
    function onKeyDown(e) { if (e.key === 'Escape') doCancel(); }
    function cleanup() {
      continueBtn.removeEventListener('click', doContinue);
      cancelBtn.removeEventListener('click', doCancel);
      formatsOverlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeyDown);
      formatsOverlay.style.display = 'none';
    }
    continueBtn.addEventListener('click', doContinue);
    cancelBtn.addEventListener('click', doCancel);
    formatsOverlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);
  });

  if (!shouldContinue) return;

  // Step 1: Open file dialog
  const filePath = await ipcRenderer.invoke('show-bible-import-dialog');
  if (!filePath) return;

  // Step 2: Parse the file
  const btn = document.getElementById('bible-import-btn');
  btn.disabled = true;
  btn.textContent = 'Parsing...';
  let parseResult;
  try {
    parseResult = await ipcRenderer.invoke('parse-bible-file', filePath);
  } catch (err) {
    statusEl.style.color = '#f44336';
    statusEl.textContent = `Parse failed: ${err.message}`;
    btn.disabled = false;
    btn.textContent = 'Import from file...';
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Import from file...';

  // Step 3: Populate and show confirmation modal
  const { summary } = parseResult;
  const totalVerses = summary.reduce((s, b) => s + b.verses, 0);
  const overlay = document.getElementById('bible-import-modal-overlay');
  document.getElementById('bible-import-modal-subtitle').textContent =
    `${summary.length} book${summary.length !== 1 ? 's' : ''} found, ${totalVerses.toLocaleString()} verses total.`;
  document.getElementById('bible-import-modal-list').innerHTML = summary.map(b =>
    `<div class="book-row">
       <span class="book-row-name">${b.name}</span>
       <span class="book-row-stats">${b.chapters} ch, ${b.verses.toLocaleString()} v</span>
     </div>`
  ).join('');

  // Pre-fill version ID from filename
  const baseName = path.basename(filePath, path.extname(filePath))
    .replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase();
  const idInput = document.getElementById('bible-import-modal-id');
  idInput.value = baseName;
  overlay.style.display = 'flex';
  setTimeout(() => idInput.select(), 60);

  // Step 4: Wait for confirm or cancel
  const confirmed = await new Promise(resolve => {
    const confirmBtn = document.getElementById('bible-import-modal-confirm');
    const cancelBtn = document.getElementById('bible-import-modal-cancel');
    function doConfirm() { cleanup(); resolve(true); }
    function doCancel() { cleanup(); resolve(false); }
    function onOverlayClick(e) { if (e.target === overlay) { cleanup(); resolve(false); } }
    function onKeyDown(e) { if (e.key === 'Escape') doCancel(); }
    function cleanup() {
      confirmBtn.removeEventListener('click', doConfirm);
      cancelBtn.removeEventListener('click', doCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeyDown);
      overlay.style.display = 'none';
    }
    confirmBtn.addEventListener('click', doConfirm);
    cancelBtn.addEventListener('click', doCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeyDown);
  });

  if (!confirmed) return;

  // Step 5: Validate version ID from the modal input
  const rawId = idInput.value.trim();
  if (!rawId) {
    statusEl.style.color = '#f44336';
    statusEl.textContent = 'Version ID is required.';
    return;
  }
  const cleanId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_');

  // Step 6: Import and refresh list
  btn.disabled = true;
  btn.textContent = 'Importing...';
  try {
    await ipcRenderer.invoke('import-bible-file', filePath, cleanId);
    statusEl.style.color = '';
    statusEl.textContent = `Imported as "${cleanId}" successfully.`;
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
    const localIds = await loadLocalBibles();
    await renderLocalBiblesList(localIds);
  } catch (err) {
    statusEl.style.color = '#f44336';
    statusEl.textContent = `Import failed: ${err.message}`;
    console.error('Bible import failed:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import from file...';
  }
}

// eBible.org catalog. Liturgia intentionally lists only eBible's Public Domain
// and Open Access sections; traditional restricted-copyright entries are not
// offered for automatic download.
let allBibleFiles = [];
let _bibleSearchBound = false;
const _ebibleInstallButtons = new Map();

function bibleSearchText(bible) {
  return [
    bible.id,
    bible.title,
    bible.vernacularTitle,
    bible.language,
    bible.nativeLanguage,
    bible.dialect,
    bible.year,
    bible.license
  ].filter(Boolean).join(' ').toLowerCase();
}

function renderEbibleStatus(message = '', tone = '') {
  const status = document.getElementById('ebible-status');
  if (!status) return;
  status.textContent = message;
  status.className = `ebible-status${tone ? ` ${tone}` : ''}`;
}

async function loadBiblesList(force = false) {
  const localIds = await loadLocalBibles();
  await renderLocalBiblesList(localIds);

  const biblesContainer = document.getElementById('bibles-list');
  if (!biblesContainer) return;
  biblesContainer.innerHTML = '<div class="bible-loading">Loading eBible.org library...</div>';
  renderEbibleStatus('Loading Public Domain and Open Access translations from eBible.org...');

  try {
    const result = await ipcRenderer.invoke('ebible:list', { force: !!force });
    if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Could not load the eBible catalog.');
    allBibleFiles = Array.isArray(result.bibles) ? result.bibles : [];
    renderEbibleStatus(`${allBibleFiles.length.toLocaleString()} downloadable translations available from eBible.org.`, 'success');

    const searchInput = document.getElementById('bible-search');
    if (searchInput && !_bibleSearchBound) {
      _bibleSearchBound = true;
      searchInput.addEventListener('input', () => {
        const term = searchInput.value.trim().toLowerCase();
        const filtered = term ? allBibleFiles.filter(bible => bibleSearchText(bible).includes(term)) : allBibleFiles;
        renderBiblesList(filtered);
      });
    }
    const term = searchInput ? searchInput.value.trim().toLowerCase() : '';
    await renderBiblesList(term ? allBibleFiles.filter(bible => bibleSearchText(bible).includes(term)) : allBibleFiles);
  } catch (error) {
    biblesContainer.innerHTML = '';
    const failure = document.createElement('div');
    failure.className = 'bible-loading';
    failure.style.color = '#f44336';
    failure.textContent = `Could not load eBible.org: ${error.message || error}`;
    biblesContainer.appendChild(failure);
    renderEbibleStatus('The eBible library could not be loaded. Check your connection and try Refresh.', 'error');
    console.error('Error loading eBible catalog:', error);
  }
}

async function renderBiblesList(biblesList) {
  const biblesContainer = document.getElementById('bibles-list');
  if (!biblesContainer) return;
  biblesContainer.innerHTML = '';

  if (!biblesList || biblesList.length === 0) {
    biblesContainer.innerHTML = '<div class="bible-loading">No matching Bible versions found.</div>';
    return;
  }

  const currentBible = await ipcRenderer.invoke('get-default-bible');
  const userData = await ipcRenderer.invoke('get-user-data-path');
  const storageBase = path.join(userData, BIBLE_STORAGE_DIR);

  for (const bible of biblesList) {
    const fileName = `${bible.id}.json`;
    const installedPath = path.join(storageBase, bible.id, 'bible.json');
    const isDownloaded = fs.existsSync(installedPath);
    const isSelected = currentBible === fileName || currentBible === bible.id;

    const bibleItem = document.createElement('div');
    bibleItem.className = `bible-item${isSelected ? ' selected' : ''}`;

    const header = document.createElement('div');
    header.className = 'bible-item-header';
    const name = document.createElement('span');
    name.className = 'bible-name';
    name.textContent = bible.title || bible.id;
    const sourceTag = document.createElement('span');
    sourceTag.className = 'bible-local-tag';
    sourceTag.textContent = 'eBible';
    name.appendChild(sourceTag);
    const status = document.createElement('span');
    status.className = `bible-status ${isDownloaded ? 'downloaded' : 'not-downloaded'}`;
    status.textContent = isDownloaded ? 'Downloaded' : bible.license;
    header.appendChild(name);
    header.appendChild(status);
    bibleItem.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'bible-meta';
    const languageParts = [bible.language];
    if (bible.nativeLanguage && bible.nativeLanguage.toLowerCase() !== String(bible.language || '').toLowerCase()) languageParts.push(bible.nativeLanguage);
    if (bible.dialect) languageParts.push(bible.dialect);
    if (bible.year) languageParts.push(bible.year);
    meta.textContent = languageParts.filter(Boolean).join(' · ') || bible.id;
    bibleItem.appendChild(meta);

    if (bible.vernacularTitle && bible.vernacularTitle !== bible.title) {
      const vernacular = document.createElement('div');
      vernacular.className = 'bible-vernacular-title';
      vernacular.textContent = bible.vernacularTitle;
      bibleItem.appendChild(vernacular);
    }

    const license = document.createElement('div');
    license.className = 'bible-license-line';
    license.textContent = bible.category === 'public-domain'
      ? 'Public Domain'
      : `Open Access${bible.rightsHolder ? ` · ${bible.rightsHolder}` : ''}`;
    bibleItem.appendChild(license);

    const actions = document.createElement('div');
    actions.className = 'bible-item-actions';
    const actionButton = document.createElement('button');
    actionButton.className = `bible-action ${isDownloaded ? (isSelected ? 'selected' : 'select') : 'download'}`;
    actionButton.dataset.ebibleId = bible.id;
    actionButton.disabled = isSelected;
    actionButton.textContent = isSelected ? 'Currently Active' : (isDownloaded ? 'Select' : 'Download & Use');
    actions.appendChild(actionButton);

    const detailsButton = document.createElement('button');
    detailsButton.className = 'bible-action export';
    detailsButton.textContent = 'License / Details';
    detailsButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const url = bible.copyrightUrl || bible.detailsUrl;
      if (url) await ipcRenderer.invoke('open-external-url', { url });
    });
    actions.appendChild(detailsButton);
    bibleItem.appendChild(actions);

    actionButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      const alreadyInstalled = fs.existsSync(installedPath);
      actionButton.disabled = true;
      _ebibleInstallButtons.set(bible.id, actionButton);
      try {
        if (!alreadyInstalled) {
          actionButton.textContent = 'Starting download...';
          renderEbibleStatus(`Downloading ${bible.title || bible.id} from eBible.org...`);
          const result = await ipcRenderer.invoke('ebible:install', bible.id);
          if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'Download/import failed.');
          renderEbibleStatus(`Imported ${bible.title || bible.id}: ${result.books} books, ${Number(result.verses || 0).toLocaleString()} verses.`, 'success');
        }

        await selectBible(fileName);
        const localIds = await loadLocalBibles();
        await renderLocalBiblesList(localIds);
        const searchInput = document.getElementById('bible-search');
        const term = searchInput ? searchInput.value.trim().toLowerCase() : '';
        await renderBiblesList(term ? allBibleFiles.filter(item => bibleSearchText(item).includes(term)) : allBibleFiles);
      } catch (error) {
        actionButton.disabled = false;
        actionButton.textContent = alreadyInstalled ? 'Select' : 'Retry Download';
        renderEbibleStatus(`Could not install ${bible.title || bible.id}: ${error.message || error}`, 'error');
        console.error('eBible install failed:', error);
      } finally {
        _ebibleInstallButtons.delete(bible.id);
      }
    });

    biblesContainer.appendChild(bibleItem);
  }
}

ipcRenderer.on('ebible:install-progress', (event, progress) => {
  if (!progress || !progress.id) return;
  const button = _ebibleInstallButtons.get(progress.id);
  if (!button) return;
  if (progress.stage === 'download') {
    button.textContent = Number.isFinite(progress.percent) ? `Downloading ${progress.percent}%...` : 'Downloading...';
  } else if (progress.stage === 'parse') {
    button.textContent = 'Checking Bible...';
  } else if (progress.stage === 'import') {
    button.textContent = 'Importing...';
  } else if (progress.stage === 'done') {
    button.textContent = 'Finishing...';
  }
});

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
  _allDisplays = await ipcRenderer.invoke('get-displays');
  const settings = await ipcRenderer.invoke('load-settings');
  const savedIds = (settings && Array.isArray(settings.liveDisplays)) ? settings.liveDisplays : [];
  const displaySettings = (settings && settings.displaySettings) || {};
  renderDisplayEntries(savedIds, displaySettings);
}

function renderDisplayEntries(ids, displaySettings) {
  const container = document.getElementById('display-list');
  container.innerHTML = '';
  ids.forEach((displayId, index) => {
    container.appendChild(buildDisplayEntry(displayId, index, ids.length, (displaySettings || {})[String(displayId)] || {}));
  });
}

function buildDisplayEntry(displayId, index, total, perDisplaySettings) {
  const row = document.createElement('div');
  row.className = 'display-row';

  const numLabel = document.createElement('span');
  numLabel.className = 'display-row-num';
  numLabel.textContent = index + 1;
  row.appendChild(numLabel);

  const select = document.createElement('select');
  select.className = 'display-row-select';

  // Special "Network only" sentinel — value 0, no physical window opened
  const netOnlyOpt = document.createElement('option');
  netOnlyOpt.value = 0;
  netOnlyOpt.textContent = 'Network only (no screen)';
  if (displayId == 0) netOnlyOpt.selected = true;
  select.appendChild(netOnlyOpt);

  // If this display ID is not currently detected (and is not the special 0 sentinel),
  // show a placeholder so the saved assignment is never silently dropped or reassigned.
  const isDetected = displayId == 0 || _allDisplays.some(d => d.id == displayId);
  if (!isDetected) {
    const opt = document.createElement('option');
    opt.value = displayId;
    opt.textContent = `Display ${index + 1} (disconnected)`;
    opt.selected = true;
    select.appendChild(opt);
  }
  _allDisplays.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `Display ${i + 1}  (${d.bounds.width}\u00d7${d.bounds.height})`;
    if (d.id == displayId) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener('change', async () => {
    const ids = readCurrentIds();
    ids[index] = parseInt(select.value, 10);
    await ipcRenderer.invoke('update-settings', { liveDisplays: ids });
    loadDisplays();
  });
  row.appendChild(select);

  // Edit button — opens per-display settings modal
  const editBtn = document.createElement('button');
  editBtn.className = 'btn display-row-edit';
  editBtn.textContent = '...';
  editBtn.title = 'Window settings';
  editBtn.addEventListener('click', () => openDisplayEditModal(displayId, index + 1, perDisplaySettings || {}));
  row.appendChild(editBtn);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn display-row-remove';
  removeBtn.textContent = '\u2212';
  removeBtn.title = 'Remove this window';
  removeBtn.addEventListener('click', async () => {
    const ids = readCurrentIds();
    ids.splice(index, 1);
    await ipcRenderer.invoke('update-settings', { liveDisplays: ids });
    loadDisplays();
  });
  row.appendChild(removeBtn);

  return row;
}

function readCurrentIds() {
  const rows = document.querySelectorAll('#display-list .display-row');
  return [...rows].map(row => {
    const sel = row.querySelector('.display-row-select');
    return sel ? parseInt(sel.value, 10) : null;
  }).filter(id => id !== null);
}

function openDisplayEditModal(displayId, displayIndex, initialSettings) {
  // Remove any existing modal
  const existing = document.getElementById('dp-modal-backdrop');
  if (existing) existing.remove();

  const nd = (initialSettings && initialSettings.networkDisplay) || {};
  const perDisplayStylesEnabled = !!(initialSettings && initialSettings.perDisplayStylesEnabled);

  const backdrop = document.createElement('div');
  backdrop.id = 'dp-modal-backdrop';
  backdrop.className = 'dp-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'dp-modal';
  modal.innerHTML = `
    <div class="dp-modal-header">
      <span class="dp-modal-title">Window ${displayIndex} Settings</span>
      <button class="dp-modal-close" title="Close">&#x2715;</button>
    </div>
    <div class="dp-modal-body">
      <div class="dp-modal-section">Network Display</div>
      <label class="toggle-label">
        <input id="dp-nd-enable" type="checkbox" />
        <span class="toggle-ui"></span>
        Enable network display server
      </label>
      <div class="dp-nd-port-row">
        <span class="dp-nd-label">Port</span>
        <input id="dp-nd-port" type="number" min="1024" max="65535" value="${nd.port || 7777}" />
      </div>
      <div class="dp-nd-url-row">
        <span id="dp-nd-url" class="muted-text">Not running</span>
        <button id="dp-nd-copy" class="btn">Copy URL</button>
      </div>
      <div id="dp-nd-error" class="nd-error" style="display:none;"></div>
      <label class="toggle-label">
        <input id="dp-nd-transparent" type="checkbox" />
        <span class="toggle-ui"></span>
        Transparent background (for OBS lower-thirds)
      </label>
      <label class="toggle-label">
        <input id="dp-nd-black-clear" type="checkbox" />
        <span class="toggle-ui"></span>
        Treat black mode as clear
      </label>
      <div class="muted-text" style="font-size:0.85em;margin-top:2px;">Open this URL in a browser or OBS browser source on any device on your network.</div>
      <div class="dp-modal-section" style="margin-top:10px;">Custom Styles</div>
      <label class="toggle-label">
        <input id="dp-styles-enable" type="checkbox" />
        <span class="toggle-ui"></span>
        Use custom text styles for this display
      </label>
      <div style="margin-top:6px;">
        <button id="dp-styles-edit-btn" class="btn">Edit Styles</button>
      </div>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const enableEl      = modal.querySelector('#dp-nd-enable');
  const portEl        = modal.querySelector('#dp-nd-port');
  const urlEl         = modal.querySelector('#dp-nd-url');
  const errEl         = modal.querySelector('#dp-nd-error');
  const transparentEl = modal.querySelector('#dp-nd-transparent');
  const blackClearEl  = modal.querySelector('#dp-nd-black-clear');
  const copyBtn       = modal.querySelector('#dp-nd-copy');
  const closeBtn      = modal.querySelector('.dp-modal-close');
  const stylesEnableEl = modal.querySelector('#dp-styles-enable');
  const stylesEditBtn  = modal.querySelector('#dp-styles-edit-btn');

  // Restore saved checkbox states
  enableEl.checked      = !!nd.enabled;
  transparentEl.checked = !!nd.transparent;
  blackClearEl.checked  = !!nd.blackAsClear;
  stylesEnableEl.checked = perDisplayStylesEnabled;

  function buildUrl(baseUrl) {
    if (!baseUrl) return null;
    const params = [];
    if (transparentEl.checked) params.push('t=1');
    if (blackClearEl.checked)  params.push('c=1');
    return params.length ? `${baseUrl}?${params.join('&')}` : baseUrl;
  }

  async function refreshStatus() {
    try {
      const status = await ipcRenderer.invoke('get-display-net-status', displayId);
      urlEl.textContent = status.running ? (buildUrl(status.url) || 'Running') : 'Not running';
      if (status.lastError) { errEl.textContent = status.lastError; errEl.style.display = ''; }
      else                  { errEl.style.display = 'none'; }
    } catch (_) {}
  }

  async function saveAndApply() {
    const enabled     = enableEl.checked;
    const port        = parseInt(portEl.value, 10) || 7777;
    const transparent = transparentEl.checked;
    const blackAsClear = blackClearEl.checked;
    const stylesEnabled = stylesEnableEl.checked;
    const s = await ipcRenderer.invoke('load-settings');
    const displaySettings = (s && s.displaySettings) || {};
    displaySettings[String(displayId)] = displaySettings[String(displayId)] || {};
    displaySettings[String(displayId)].networkDisplay = { enabled, port, transparent, blackAsClear };
    displaySettings[String(displayId)].perDisplayStylesEnabled = stylesEnabled;
    await ipcRenderer.invoke('update-settings', { displaySettings });
    ipcRenderer.send('display-setting-changed', { displayId, key: 'perDisplayStylesEnabled', value: stylesEnabled });
    if (enabled) {
      await ipcRenderer.invoke('display-net-start', displayId, port);
    } else {
      await ipcRenderer.invoke('display-net-stop', displayId);
    }
    setTimeout(refreshStatus, 300);
  }

  const errorListener = (_event, { displayId: eid, error }) => {
    if (eid !== displayId) return;
    if (error) { errEl.textContent = error; errEl.style.display = ''; }
    else        { errEl.style.display = 'none'; }
    refreshStatus();
  };
  ipcRenderer.on('display-net-error', errorListener);

  enableEl.addEventListener('change', saveAndApply);
  portEl.addEventListener('change', saveAndApply);
  transparentEl.addEventListener('change', saveAndApply);
  blackClearEl.addEventListener('change', saveAndApply);
  stylesEnableEl.addEventListener('change', saveAndApply);

  stylesEditBtn.addEventListener('click', async () => {
    const s = await ipcRenderer.invoke('load-settings');
    const ds = (s && s.displaySettings && s.displaySettings[String(displayId)]) || {};
    const content = null; // No preview content from settings context
    const isDark = document.body.classList.contains('dark-theme');
    ipcRenderer.send('open-style-window', {
      previewStyles: ds.perDisplayStyles ? { ...ds.perDisplayStyles } : (s && s.previewStyles ? { ...s.previewStyles } : {}),
      globalStyles: s && s.previewStyles ? { ...s.previewStyles } : {},
      content: content,
      darkMode: isDark,
      bgSnapshot: null,
      displayId: displayId,
      displayIndex: displayIndex,
    });
  });

  copyBtn.addEventListener('click', () => {
    const text = urlEl.textContent;
    if (text && text !== 'Not running') try { navigator.clipboard.writeText(text); } catch (_) {}
  });

  function closeModal() {
    ipcRenderer.removeListener('display-net-error', errorListener);
    backdrop.remove();
  }

  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); }
  });

  refreshStatus();
}
