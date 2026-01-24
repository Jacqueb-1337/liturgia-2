const fs = require('fs');
const path = require('path');
let pngToIcoModule = null;
try {
  pngToIcoModule = require('png-to-ico');
} catch (e) {
  console.error('png-to-ico module not found. Please run npm install in devDependencies.');
  process.exit(1);
}
const pngToIco = pngToIcoModule.default ? pngToIcoModule.default : pngToIcoModule;

const src = path.join(__dirname, '..', 'logo.png');
const outDir = path.join(__dirname, '..', 'build');
const outFile = path.join(outDir, 'icon.ico');

if (!fs.existsSync(src)) {
  console.error('Source logo.png not found at', src);
  process.exit(1);
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// To satisfy NSIS we need several icon sizes (16,32,48,256). Use sharp to create resized PNGs and feed them to png-to-ico.
let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.error('sharp not available, run npm install sharp'); process.exit(1); }

(async () => {
  try {
    const sizes = [16, 32, 48, 256];
    const tmpFiles = [];
    for (const s of sizes) {
      const tmpPath = path.join(outDir, `icon_${s}.png`);
      await sharp(src).resize(s, s).png().toFile(tmpPath);
      tmpFiles.push(tmpPath);
    }
    const buf = await pngToIco(tmpFiles);
    fs.writeFileSync(outFile, buf);
    console.log('Icon created at', outFile);
    // cleanup tmp pngs
    for (const f of tmpFiles) try { fs.unlinkSync(f); } catch (e) {}
  } catch (err) {
    console.error('Failed to create icon:', err);
    process.exit(1);
  }
})();
