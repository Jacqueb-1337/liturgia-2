const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseBibleFile, importBibleFile } = require('../scriptureData');

const CATALOG_URL = 'https://ebible.org/Scriptures/copyright.php';
const SCRIPTURES_BASE = 'https://ebible.org/Scriptures';
const CATALOG_CACHE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45000;

let catalogCache = null;
let catalogCacheAt = 0;

function decodeHtml(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“'
  };
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return ''; }
    })
    .replace(/&#(\d+);/g, (_, num) => {
      try { return String.fromCodePoint(parseInt(num, 10)); } catch (_) { return ''; }
    })
    .replace(/&([a-z]+);/gi, (whole, name) => Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : whole);
}

function htmlText(value) {
  return decodeHtml(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function classifySection(heading) {
  if (/public domain/i.test(heading)) return { category: 'public-domain', label: 'Public Domain' };
  if (/open access license/i.test(heading)) return { category: 'open-access', label: 'Open Access' };
  return null;
}

function parseEbibleCatalogHtml(html) {
  const source = String(html || '');
  const headings = [...source.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  const entries = [];
  const seen = new Set();

  for (let i = 0; i < headings.length; i++) {
    const heading = htmlText(headings[i][1]);
    const classification = classifySection(heading);
    if (!classification) continue;

    const blockStart = headings[i].index + headings[i][0].length;
    const blockEnd = i + 1 < headings.length ? headings[i + 1].index : source.length;
    const block = source.slice(blockStart, blockEnd);

    for (const rowMatch of block.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
      if (cells.length < 10) continue;
      if (/language in english/i.test(htmlText(cells[0]))) continue;

      let id = htmlText(cells[9]);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) {
        const idHref = String(cells[9]).match(/https?:\/\/(?:www\.)?ebible\.org\/([^/'"?#]+)\/copyright\.htm/i);
        id = idHref ? decodeHtml(idHref[1]) : '';
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || seen.has(id)) continue;

      const language = htmlText(cells[0]);
      const nativeLanguage = htmlText(cells[1]);
      const dialect = htmlText(cells[2]);
      const vernacularTitle = htmlText(cells[3]);
      const shortTitle = htmlText(cells[4]) || vernacularTitle || id;
      const year = htmlText(cells[5]);
      const rightsHolder = htmlText(cells[6]);
      const translator = htmlText(cells[7]);
      const contributor = htmlText(cells[8]);

      seen.add(id);
      entries.push({
        id,
        title: shortTitle,
        vernacularTitle,
        language,
        nativeLanguage,
        dialect,
        year,
        category: classification.category,
        license: classification.label,
        rightsHolder,
        translator,
        contributor,
        detailsUrl: `https://ebible.org/find/show.php?id=${encodeURIComponent(id)}`,
        copyrightUrl: `https://ebible.org/${encodeURIComponent(id)}/copyright.htm`
      });
    }
  }

  return entries.sort((a, b) => {
    const lang = a.language.localeCompare(b.language, undefined, { sensitivity: 'base' });
    if (lang) return lang;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  });
}

function getFetch(fetchImpl) {
  const fn = fetchImpl || global.fetch;
  if (typeof fn !== 'function') throw new Error('This Liturgia runtime does not provide HTTP fetch support.');
  return fn;
}

async function fetchWithTimeout(url, options = {}, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const fetchFn = getFetch(fetchImpl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fetchFn(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Liturgia/eBible integration',
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`eBible request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEbibleCatalog(options = {}) {
  const now = Date.now();
  if (!options.force && catalogCache && now - catalogCacheAt < CATALOG_CACHE_MS) return catalogCache;

  const response = await fetchWithTimeout(CATALOG_URL, {}, options.fetchImpl, options.timeoutMs);
  if (!response.ok) throw new Error(`eBible catalog request failed with HTTP ${response.status}.`);
  const html = await response.text();
  const entries = parseEbibleCatalogHtml(html);
  if (entries.length < 50) throw new Error('eBible returned an unexpectedly small catalog. Please try again later.');

  catalogCache = entries;
  catalogCacheAt = now;
  return entries;
}

function validateBibleId(id) {
  const value = String(id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error('Invalid eBible translation ID.');
  return value;
}

async function responseToBuffer(response, maxBytes, onProgress) {
  const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0) || 0;
  if (declared > maxBytes) throw new Error(`eBible download is too large (${Math.ceil(declared / 1024 / 1024)} MB).`);

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('eBible download exceeded the allowed size.');
    if (onProgress) onProgress({ stage: 'download', loaded: buffer.length, total: declared || buffer.length, percent: 100 });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    loaded += chunk.length;
    if (loaded > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error('eBible download exceeded the allowed size.');
    }
    chunks.push(chunk);
    if (onProgress) {
      onProgress({
        stage: 'download',
        loaded,
        total: declared || null,
        percent: declared ? Math.min(99, Math.round((loaded / declared) * 100)) : null
      });
    }
  }
  if (onProgress) onProgress({ stage: 'download', loaded, total: declared || loaded, percent: 100 });
  return Buffer.concat(chunks);
}

async function downloadEbiblePackage(id, options = {}) {
  const safeId = validateBibleId(id);
  const formats = options.formats || ['usfx', 'usfm'];
  const maxBytes = options.maxBytes || DEFAULT_MAX_DOWNLOAD_BYTES;
  const failures = [];

  for (const format of formats) {
    const url = `${SCRIPTURES_BASE}/${encodeURIComponent(safeId)}_${format}.zip`;
    let response;
    try {
      response = await fetchWithTimeout(url, {}, options.fetchImpl, options.timeoutMs);
    } catch (error) {
      failures.push(`${format}: ${error.message || error}`);
      continue;
    }
    if (response.status === 404) {
      failures.push(`${format}: not available`);
      continue;
    }
    if (!response.ok) {
      failures.push(`${format}: HTTP ${response.status}`);
      continue;
    }

    const buffer = await responseToBuffer(response, maxBytes, options.onProgress);
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      failures.push(`${format}: response was not a ZIP archive`);
      continue;
    }

    const tempDir = options.tempDir || os.tmpdir();
    await fs.promises.mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, `liturgia-ebible-${safeId}-${process.pid}-${Date.now()}.zip`);
    await fs.promises.writeFile(tempPath, buffer);
    return { id: safeId, format, url, tempPath, bytes: buffer.length };
  }

  throw new Error(`No compatible eBible package could be downloaded for ${safeId}. ${failures.join('; ')}`);
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.promises.rename(tmp, filePath);
  } catch (error) {
    try { await fs.promises.unlink(filePath); } catch (_) {}
    await fs.promises.rename(tmp, filePath);
  }
}

async function installEbibleBible(entry, storageDir, options = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('Missing eBible translation metadata.');
  const id = validateBibleId(entry.id);
  const download = await downloadEbiblePackage(id, options);

  try {
    if (options.onProgress) options.onProgress({ stage: 'parse', percent: null });
    const parsed = await parseBibleFile(download.tempPath);
    const totalBooks = parsed.summary.length;
    const totalVerses = parsed.summary.reduce((sum, book) => sum + Number(book.verses || 0), 0);
    if (!totalBooks || !totalVerses) throw new Error('The downloaded package did not contain usable Bible verses.');

    if (options.onProgress) options.onProgress({ stage: 'import', percent: null });
    const destFile = await importBibleFile(download.tempPath, id, storageDir);
    const metadata = {
      source: 'ebible.org',
      id,
      title: String(entry.title || id),
      vernacularTitle: String(entry.vernacularTitle || ''),
      language: String(entry.language || ''),
      nativeLanguage: String(entry.nativeLanguage || ''),
      dialect: String(entry.dialect || ''),
      year: String(entry.year || ''),
      category: String(entry.category || ''),
      license: String(entry.license || ''),
      rightsHolder: String(entry.rightsHolder || ''),
      detailsUrl: String(entry.detailsUrl || `https://ebible.org/find/show.php?id=${encodeURIComponent(id)}`),
      copyrightUrl: String(entry.copyrightUrl || `https://ebible.org/${encodeURIComponent(id)}/copyright.htm`),
      packageFormat: download.format,
      installedAt: new Date().toISOString(),
      books: totalBooks,
      verses: totalVerses
    };
    await writeJsonAtomic(path.join(storageDir, id, 'metadata.json'), metadata);
    if (options.onProgress) options.onProgress({ stage: 'done', percent: 100 });
    return { id, destFile, metadata, books: totalBooks, verses: totalVerses, format: download.format, bytes: download.bytes };
  } finally {
    try { await fs.promises.unlink(download.tempPath); } catch (_) {}
  }
}

module.exports = {
  CATALOG_URL,
  SCRIPTURES_BASE,
  parseEbibleCatalogHtml,
  fetchEbibleCatalog,
  validateBibleId,
  downloadEbiblePackage,
  installEbibleBible,
  writeJsonAtomic
};
