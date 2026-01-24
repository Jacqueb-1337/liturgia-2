const sharp = require('sharp');
const fs = require('fs');

(async () => {
  const p = 'build/icon.png';
  try {
    if (!fs.existsSync(p)) throw new Error('not found');
    const meta = await sharp(p).metadata();
    if (meta.width < 256 || meta.height < 256) {
      console.log('Icon too small', meta.width, 'x', meta.height, '— resizing to 512x512');
      await sharp(p).resize(512, 512, { fit: 'cover' }).png().toFile(p);
      console.log('Resized', p);
    } else {
      console.log('Icon size OK', meta.width, 'x', meta.height);
    }
  } catch (err) {
    console.log('Could not read icon; creating 512x512 placeholder. Error:', err.message);
    if (!fs.existsSync('build')) fs.mkdirSync('build', { recursive: true });
    await sharp({ create: { width: 512, height: 512, channels: 4, background: '#ff3366' } }).png().toFile(p);
    console.log('Wrote placeholder build/icon.png');
  }
})();
