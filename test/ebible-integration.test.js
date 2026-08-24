/** @jest-environment node */
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseBibleFile, normalizeBibleData } = require('../scriptureData');
const { parseEbibleCatalogHtml, downloadEbiblePackage } = require('../lib/ebible');

describe('eBible.org integration', () => {
  test('catalog exposes Public Domain and Open Access entries but not restricted copyrighted entries', () => {
    const html = `
      <h2>Public Domain Bibles</h2>
      <table>
        <tr><td>Language in English</td><td>Language</td><td>Dialect</td><td>Vernacular Title</td><td>Short Title</td><td>Year</td><td>no copyright</td><td>by</td><td>contributor</td><td>ID</td></tr>
        <tr><td>English</td><td>English</td><td></td><td>Test Public Bible</td><td>Public Bible</td><td>1901</td><td>Public Domain</td><td></td><td></td><td><a href="https://ebible.org/test-pd/copyright.htm">test-pd</a></td></tr>
      </table>
      <h2>Open Access License Bibles</h2>
      <table>
        <tr><td>Spanish</td><td>Español</td><td></td><td>Biblia Abierta</td><td>Open Bible</td><td>2024</td><td>CC BY</td><td>Example</td><td></td><td><a href="https://ebible.org/test-oa/copyright.htm">test-oa</a></td></tr>
      </table>
      <h2>Copyrighted Bibles without licenses that promote open sharing</h2>
      <table>
        <tr><td>English</td><td>English</td><td></td><td>Restricted</td><td>Restricted Bible</td><td>2020</td><td>Copyrighted</td><td></td><td></td><td><a href="https://ebible.org/test-no/copyright.htm">test-no</a></td></tr>
      </table>`;

    const catalog = parseEbibleCatalogHtml(html);
    expect(catalog.map(item => item.id)).toEqual(['test-pd', 'test-oa']);
    expect(catalog.find(item => item.id === 'test-pd').category).toBe('public-domain');
    expect(catalog.find(item => item.id === 'test-oa').category).toBe('open-access');
  });

  test('multi-file USFM ZIP imports every book rather than only the first file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liturgia-ebible-unit-'));
    const zipPath = path.join(dir, 'two-books.zip');
    try {
      const zip = new AdmZip();
      const genesis = ['\\id GEN Genesis', '\\c 1', '\\v 1 In the beginning.', '\\v 2 The earth was without form.'].join('\n');
      const exodus = ['\\id EXO Exodus', '\\c 1', '\\v 1 These are the names.', '\\v 2 Reuben, Simeon, Levi, and Judah.'].join('\n');
      expect(genesis.charCodeAt(0)).toBe(92);
      zip.addFile('01-GEN.usfm', Buffer.from(genesis));
      zip.addFile('02-EXO.usfm', Buffer.from(exodus));
      zip.writeZip(zipPath);

      const readBack = new AdmZip(zipPath).getEntries().filter(entry => !entry.isDirectory);
      const joined = readBack.map(entry => entry.getData().toString('utf8')).join('\n\n');
      expect(joined).toContain('\\id GEN Genesis');
      expect(joined).toContain('\\id EXO Exodus');
      expect(normalizeBibleData(joined, 'combined.usfm')).toHaveLength(2);

      const parsed = await parseBibleFile(zipPath);
      expect(parsed.summary).toHaveLength(2);
      expect(parsed.books.map(book => book.id)).toEqual(['GEN', 'EXO']);
      expect(parsed.summary.map(book => book.name)).toEqual(['GEN', 'EXO']);
      expect(parsed.summary.reduce((sum, book) => sum + book.verses, 0)).toBe(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('download falls back from unavailable USFX to USFM', async () => {
    const zip = new AdmZip();
    zip.addFile('MAT.usfm', Buffer.from('\\id MAT Matthew\n\\c 1\n\\v 1 Test verse.'));
    const zipBuffer = zip.toBuffer();
    const requests = [];
    const fakeFetch = async (url) => {
      requests.push(url);
      if (url.endsWith('_usfx.zip')) return { ok: false, status: 404, headers: { get: () => null } };
      return {
        ok: true,
        status: 200,
        headers: { get: name => name === 'content-length' ? String(zipBuffer.length) : null },
        body: null,
        arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength)
      };
    };

    const result = await downloadEbiblePackage('test-id', { fetchImpl: fakeFetch });
    try {
      expect(result.format).toBe('usfm');
      expect(requests[0]).toContain('test-id_usfx.zip');
      expect(requests[1]).toContain('test-id_usfm.zip');
      expect(fs.existsSync(result.tempPath)).toBe(true);
    } finally {
      fs.rmSync(result.tempPath, { force: true });
    }
  });

  test('Settings uses main-process eBible catalog and automatic install flow', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const settings = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');

    expect(main).toContain("ipcMain.handle('ebible:list'");
    expect(main).toContain("ipcMain.handle('ebible:install'");
    expect(settings).toContain("ipcRenderer.invoke('ebible:list'");
    expect(settings).toContain("ipcRenderer.invoke('ebible:install'");
    expect(settings).toContain("ipcRenderer.invoke('open-external-url', { url })");
    expect(html).toContain('eBible.org library');
    expect(html).toContain('id="ebible-refresh"');
  });
});
