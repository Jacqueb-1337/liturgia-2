const { ipcRenderer } = require('electron');
const { CDN_BASE, BIBLE_STORAGE_DIR } = require('./constants');
const fs = require('fs');
const path = require('path');

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
    document.getElementById('username').value = settings.username || '';
    document.getElementById('theme').value = settings.theme || '';
    document.getElementById('dark-theme').checked = !!settings.darkTheme;
    applyDarkTheme(!!settings.darkTheme);
  }
  await loadDisplays();
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
    const username = document.getElementById('username').value;
    const theme = document.getElementById('theme').value;
    const darkTheme = document.getElementById('dark-theme').checked;
    const defaultDisplay = document.getElementById('default-display').value;
    
    // Load existing settings and merge to preserve other data like schedule
    const existingSettings = await ipcRenderer.invoke('load-settings') || {};
    const updatedSettings = { ...existingSettings, username, theme, darkTheme, defaultDisplay };
    await ipcRenderer.invoke('save-settings', updatedSettings);
    applyDarkTheme(darkTheme);
    // Show status only for the current panel
    const panel = btn.getAttribute('data-panel');
    const status = document.querySelector('.save-status[data-panel="' + panel + '"]');
    status.textContent = 'Saved!';
    setTimeout(() => status.textContent = '', 1500);
  });
});

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

let allBibleFiles = [];

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
    const settings = await ipcRenderer.invoke('load-settings') || {};
    settings.defaultBible = bible;
    await ipcRenderer.invoke('save-settings', settings);
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