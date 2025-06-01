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
  const settings = await ipcRenderer.invoke('load-settings');
  if (settings) {
    document.getElementById('username').value = settings.username || '';
    document.getElementById('theme').value = settings.theme || '';
    document.getElementById('dark-theme').checked = !!settings.darkTheme;
    applyDarkTheme(!!settings.darkTheme);
  }
});

// Save settings from any panel
document.querySelectorAll('.save-settings').forEach(btn => {
  btn.addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const theme = document.getElementById('theme').value;
    const darkTheme = document.getElementById('dark-theme').checked;
    await ipcRenderer.invoke('save-settings', { username, theme, darkTheme });
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

async function loadBiblesList() {
  const apiUrl = 'https://api.github.com/repos/thiagobodruk/bible/contents/json';
  const response = await fetch(apiUrl);
  if (!response.ok) {
    console.error('Failed to fetch Bible list:', response.statusText);
    return;
  }

  const files = await response.json();
  const biblesList = files.filter(file => file.name.endsWith('.json'));

  const biblesContainer = document.getElementById('bibles-list');
  biblesContainer.innerHTML = '';

  // Get the currently selected Bible
  const currentBible = await ipcRenderer.invoke('get-default-bible');

  biblesList.forEach(file => {
    const bibleName = file.name.replace('.json', '').replace('_', ' ');
    const isDownloaded = fs.existsSync(path.join(BIBLE_STORAGE_DIR, file.name));

    const bibleItem = document.createElement('div');
    bibleItem.className = 'bible-item';
    if (file.name === currentBible) {
      bibleItem.classList.add('selected'); // Highlight the selected Bible
    }

    bibleItem.innerHTML = `
      <span>${bibleName}</span>
      <button class="bible-action">${isDownloaded ? '✔' : '⬇'}</button>
    `;

    const actionButton = bibleItem.querySelector('.bible-action');
    actionButton.addEventListener('click', async () => {
      if (!isDownloaded) {
        await downloadBible(file.download_url, file.name);
        actionButton.textContent = '✔';
      }
      selectBible(file.name);
    });

    biblesContainer.appendChild(bibleItem);
  });
}

async function downloadBible(url, fileName) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error('Failed to download Bible:', response.statusText);
    return;
  }

  const data = await response.text();
  const userData = await ipcRenderer.invoke('get-user-data-path');
  const bibleDir = path.join(userData, BIBLE_STORAGE_DIR);
  await fs.promises.mkdir(bibleDir, { recursive: true });

  const biblePath = path.join(bibleDir, fileName);
  await fs.promises.writeFile(biblePath, data);
}

function selectBible(bible) {
  ipcRenderer.send('set-default-bible', bible);

  // Highlight the selected Bible
  const bibleItems = document.querySelectorAll('.bible-item');
  bibleItems.forEach(item => item.classList.remove('selected'));

  const selectedItem = Array.from(bibleItems).find(item =>
    item.querySelector('span').textContent.toLowerCase() === bible.replace('.json', '').replace('_', ' ').toLowerCase()
  );
  if (selectedItem) {
    selectedItem.classList.add('selected');
  }
}