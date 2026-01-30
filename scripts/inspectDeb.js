const fs = require('fs');
const p = process.argv[2];
if (!p) { console.error('usage: node inspectDeb.js <deb>'); process.exit(1); }
const b = fs.readFileSync(p);
if (!b.slice(0,8).toString().startsWith('!<arch>')) { console.error('not ar archive'); process.exit(2); }
let off = 8;
const entries = [];
while (off + 60 <= b.length) {
  const hdr = b.slice(off, off + 60).toString();
  const name = hdr.slice(0, 16).trim();
  const size = parseInt(hdr.slice(48, 58).trim()) || 0;
  entries.push({ name, size, offset: off + 60 });
  off = off + 60 + size;
  if (size % 2 === 1) off++;
}
console.log(entries.map(e => `${e.name} size=${e.size}`).join('\n'));
