const Jimp = require('jimp');

(async () => {
  try {
    const path = 'build/icon.png';
    let img = await Jimp.read(path);
    if (img.bitmap.width < 256 || img.bitmap.height < 256) {
      console.log('Icon too small', img.bitmap.width, 'x', img.bitmap.height, '— creating 512x512 placeholder.');
      const n = new Jimp(512, 512, 0xff3366ff);
      const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
      n.print(font, 20, 20, 'Liturgia');
      await n.writeAsync(path);
      console.log('Wrote placeholder', path);
    } else {
      console.log('Icon size OK', img.bitmap.width, 'x', img.bitmap.height);
    }
  } catch (err) {
    console.log('Could not read icon; creating 512x512 placeholder. Error:', err.message);
    const n = new Jimp(512, 512, 0xff3366ff);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    n.print(font, 20, 20, 'Liturgia');
    await n.writeAsync('build/icon.png');
    console.log('Wrote placeholder build/icon.png');
  }
})();
