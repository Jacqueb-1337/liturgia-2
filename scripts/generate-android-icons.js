const fs = require('fs');
const path = require('path');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { console.error('sharp not available. Run npm install'); process.exit(1); }

const ICON_SIZES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

(async () => {
  const srcIcon = path.join(__dirname, '..', 'build', 'icon.png');
  const androidResDir = path.join(__dirname, '..', 'liturgia-remote-app', 'android', 'app', 'src', 'main', 'res');
  
  if (!fs.existsSync(srcIcon)) {
    console.error('Source icon.png not found at', srcIcon);
    console.error('Run npm run generate-icons first');
    process.exit(1);
  }
  
  if (!fs.existsSync(androidResDir)) {
    console.error('Android res directory not found at', androidResDir);
    process.exit(1);
  }
  
  console.log('Generating Android app icons from', srcIcon);
  
  for (const [folder, size] of Object.entries(ICON_SIZES)) {
    const targetDir = path.join(androidResDir, folder);
    if (!fs.existsSync(targetDir)) {
      console.log('Creating directory', targetDir);
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    const iconPath = path.join(targetDir, 'ic_launcher.png');
    const iconRoundPath = path.join(targetDir, 'ic_launcher_round.png');
    const iconForegroundPath = path.join(targetDir, 'ic_launcher_foreground.png');
    
    console.log(`Generating ${folder} icons (${size}x${size})...`);
    await sharp(srcIcon).resize(size, size).png().toFile(iconPath);
    await sharp(srcIcon).resize(size, size).png().toFile(iconRoundPath);
    await sharp(srcIcon).resize(size, size).png().toFile(iconForegroundPath);
  }
  
  console.log('Android icons generated successfully!');
})();
