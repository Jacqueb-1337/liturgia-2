const fs = require('fs');
const path = require('path');
const glob = require('glob');

const dist = path.join(__dirname, '..', 'dist');

function removeFiles(patterns) {
  patterns.forEach(pat => {
    const matches = glob.sync(pat, { cwd: dist, absolute: true });
    matches.forEach(f => {
      try {
        fs.unlinkSync(f);
        console.log('Removed old file:', f);
      } catch (e) {
        // ignore
      }
    });
  });
}

try {
  if (!fs.existsSync(dist)) {
    console.log('No dist directory to clean.');
    process.exit(0);
  }
  // Common installer names
  const patterns = ['*.exe', '*-setup-*.exe', '*Setup*.exe', 'Liturgia*.exe', 'liturgia.exe'];
  removeFiles(patterns);
} catch (e) {
  console.error('Failed to clean old exe files:', e);
  process.exit(1);
}

console.log('Clean complete.');
