const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.error('sharp not available. Run npm install'); process.exit(1); }

(async () => {
  const src = path.join(__dirname, '..', 'logo.png');
  const outDir = path.join(__dirname, '..', 'build');
  if (!fs.existsSync(src)) {
    console.error('Source logo.png not found at', src);
    process.exit(1);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const iconPng = path.join(outDir, 'icon.png');
  console.log('Creating', iconPng, 'from', src);
  await sharp(src).resize(512, 512).png().toFile(iconPng);
  const { size } = fs.statSync(iconPng);
  console.log('Wrote', iconPng, 'size', size);

  console.log('Generating ICO using scripts/make-icon.js');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'make-icon.js')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('make-icon.js failed, exit code', r.status);
    process.exit(r.status);
  }
  console.log('Icon generation complete.');
})();