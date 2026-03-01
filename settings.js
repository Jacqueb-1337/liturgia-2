const { ipcRenderer } = require('electron');
const { CDN_BASE, BIBLE_STORAGE_DIR } = require('./constants');
const fs = require('fs');
const path = require('path');
let cachedSettings = null;

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
    'select-chorus-1': 'Alt+c',
    'select-verse-1': 'Alt+1',
    'select-verse-2': 'Alt+2',
    'select-verse-3': 'Alt+3',
    'select-verse-4': 'Alt+4',
    'select-verse-5': 'Alt+5',
    'select-verse-6': 'Alt+6',
    'select-verse-7': 'Alt+7',
    'select-verse-8': 'Alt+8',
    'select-verse-9': 'Alt+9',
    'select-chorus-2': '',
    'select-chorus-3': '',
    'select-chorus-4': '',
    'select-chorus-5': '',
    'select-chorus-6': '',
    'select-chorus-7': '',
    'select-chorus-8': '',
    'select-chorus-9': ''
  };
  
  const saved = settings.keybinds || {};
  const keybinds = { ...defaultKeybinds, ...saved };
  
  // Organize keybinds by category for better UI
  const categories = {
    'Navigation': ['prev-verse', 'next-verse', 'go-live'],
    'Song Selection': ['select-verse-1', 'select-verse-2', 'select-verse-3', 'select-verse-4', 'select-verse-5', 'select-verse-6', 'select-verse-7', 'select-verse-8', 'select-verse-9', 'select-chorus-1', 'select-chorus-2', 'select-chorus-3', 'select-chorus-4', 'select-chorus-5', 'select-chorus-6', 'select-chorus-7', 'select-chorus-8', 'select-chorus-9']
  };
  
  // Display keybinds by category
  for (const [category, bindIds] of Object.entries(categories)) {
    const categoryDiv = document.createElement('div');
    categoryDiv.style.marginBottom = '2em';
    
    const categoryTitle = document.createElement('h3');
    categoryTitle.textContent = category;
    categoryTitle.style.marginBottom = '1em';
    categoryTitle.style.fontSize = '1.1em';
    categoryTitle.style.fontWeight = '600';
    categoryTitle.style.color = '#333';
    categoryDiv.appendChild(categoryTitle);
    
    const categoryBody = document.createElement('div');
    categoryBody.style.display = 'flex';
    categoryBody.style.flexDirection = 'column';
    categoryBody.style.gap = '0.75em';
    
    bindIds.forEach(bindId => {
      if (keybinds.hasOwnProperty(bindId)) {
        const row = document.createElement('div');
        row.className = 'keybind-row';
        row.setAttribute('data-bind-id', bindId);
        
        // Format label nicely
        const labelText = bindId
          .split('-')
          .map((word, i) => i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)
          .join(' ');
        
        const labelEl = document.createElement('div');
        labelEl.className = 'keybind-label';
        labelEl.textContent = labelText;
        
        const input = document.createElement('input');
        input.className = 'keybind-input';
        input.type = 'text';
        input.value = keybinds[bindId];
        input.placeholder = 'Click to set...';
        input.readOnly = true;
        input.setAttribute('data-bind-id', bindId);
        
        // Record keybind on click
        input.addEventListener('click', (e) => {
          e.stopPropagation();
          recordKeybind(input);
        });
        
        row.appendChild(labelEl);
        row.appendChild(input);
        categoryBody.appendChild(row);
      }
    });
    
    categoryDiv.appendChild(categoryBody);
    keybindsList.appendChild(categoryDiv);
  }
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

// Remote Control UI removed in favor of AI tab.

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

document.getElementById('add-display-entry').addEventListener('click', async () => {
  const ids = readCurrentIds();
  const defaultId = _allDisplays.length > 0 ? _allDisplays[0].id : 1;
  ids.push(defaultId);
  await ipcRenderer.invoke('update-settings', { liveDisplays: ids });
  renderDisplayEntries(ids);
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

let _allDisplays = [];

async function loadDisplays() {
  _allDisplays = await ipcRenderer.invoke('get-displays');
  const settings = await ipcRenderer.invoke('load-settings');
  const savedIds = (settings && Array.isArray(settings.liveDisplays)) ? settings.liveDisplays : [];
  renderDisplayEntries(savedIds);
}

function renderDisplayEntries(ids) {
  const container = document.getElementById('display-list');
  container.innerHTML = '';
  ids.forEach((displayId, index) => {
    container.appendChild(buildDisplayEntry(displayId, index, ids.length));
  });
}

function buildDisplayEntry(displayId, index, total) {
  const row = document.createElement('div');
  row.className = 'display-row';

  const numLabel = document.createElement('span');
  numLabel.className = 'display-row-num';
  numLabel.textContent = index + 1;
  row.appendChild(numLabel);

  const select = document.createElement('select');
  select.className = 'display-row-select';
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
    renderDisplayEntries(ids);
  });
  row.appendChild(select);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn display-row-remove';
  removeBtn.textContent = '\u2212'; // minus sign
  removeBtn.title = 'Remove this window';
  removeBtn.addEventListener('click', async () => {
    const ids = readCurrentIds();
    ids.splice(index, 1);
    await ipcRenderer.invoke('update-settings', { liveDisplays: ids });
    renderDisplayEntries(ids);
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