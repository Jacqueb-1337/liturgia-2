const fs = require('fs');

(async () => {
  const p = 'build/icon.png';
  try {
    if (!fs.existsSync(p)) throw new Error('not found');

    let sharp;
    try { sharp = require('sharp'); } catch (e) { sharp = null; }

    if (sharp) {
      const meta = await sharp(p).metadata();
      if (meta.width < 256 || meta.height < 256) {
        console.log('Icon too small', meta.width, 'x', meta.height, '— resizing to 512x512');
        await sharp(p).resize(512, 512, { fit: 'cover' }).png().toFile(p);
        console.log('Resized', p);
      } else {
        console.log('Icon size OK', meta.width, 'x', meta.height);
      }
    } else {
      // Sharp not available in this environment; just verify the file exists and continue.
      const st = fs.statSync(p);
      console.log('Sharp not available; found build/icon.png size', st.size, 'bytes — assuming OK');
    }
  } catch (err) {
    try {
      console.log('Could not read icon; creating 512x512 placeholder. Error:', err.message);
      const sharp = require('sharp');
      if (!fs.existsSync('build')) fs.mkdirSync('build', { recursive: true });
      await sharp({ create: { width: 512, height: 512, channels: 4, background: '#ff3366' } }).png().toFile(p);
      console.log('Wrote placeholder build/icon.png');
    } catch (err2) {
      // Give up but do not fail the step; log the error and continue.
      console.warn('Failed to create or resize icon, but continuing. Error:', err2.message);
    }
  }
})();
