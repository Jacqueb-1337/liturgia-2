const fs = require('fs');
const path = require('path');
const { CDN_BASE, BOOKS, CHAPTER_COUNTS, BIBLE_JSON, VERSION } = require('./constants');

const LOCAL_BIBLE_FILE = 'bible.json';

// Canonical USFM/USFX book IDs for the standard 66-book Protestant canon.
// These let full legacy JSON Bibles interoperate safely with partial eBible
// packages instead of matching verses purely by array position.
const STANDARD_BOOK_IDS = [
  'GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO','ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL',
  'MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS','1PE','2PE','1JN','2JN','3JN','JUD','REV'
];

async function ensureBibleJson(baseDir) {
  const filePath = path.join(baseDir, LOCAL_BIBLE_FILE);
  if (fs.existsSync(filePath)) {
    // Already downloaded
    return filePath;
  }
  // Download the single JSON file
  const res = await fetch(BIBLE_JSON);
  if (!res.ok) throw new Error(`Failed to fetch ${BIBLE_JSON}`);
  const txt = await res.text();
  await fs.promises.writeFile(filePath, txt, 'utf8');
  return filePath;
}

async function loadAllVersesFromDisk(baseDir) {
  const filePath = path.join(baseDir, LOCAL_BIBLE_FILE);
  const txt = await fs.promises.readFile(filePath, 'utf8');
  const books = JSON.parse(txt);

  // Flatten to allVerses. Preserve canonical source book IDs when present so
  // dual translation can match partial Bibles by reference instead of position.
  const allVerses = [];
  const canUseStandardOrder = books.length === STANDARD_BOOK_IDS.length;
  for (let bookIndex = 0; bookIndex < books.length; bookIndex++) {
    const book = books[bookIndex];
    // Accept any of the common key names different Bible JSON sources use.
    const bookName = book.name || book.book || book.bookname || book.abbrev || 'Unknown';
    const explicitBookId = String(book.id || book.bookId || book.osisId || '').trim().toUpperCase();
    const bookId = explicitBookId || (canUseStandardOrder ? STANDARD_BOOK_IDS[bookIndex] : null);
    for (let c = 0; c < book.chapters.length; ++c) {
      const chapter = book.chapters[c];
      for (let v = 0; v < chapter.length; ++v) {
        allVerses.push({
          key: `${bookName} ${c + 1}:${v + 1}`,
          text: chapter[v],
          bookId,
          chapter: c + 1,
          verse: v + 1
        });
      }
    }
  }
  return allVerses;
}

async function fetchChapter(book, chap, baseDir) {
  const url = `${CDN_BASE}/books/${book}/chapters/${chap}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  const txt = await res.text();

  const dir = path.join(baseDir, 'books', book, 'chapters');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${chap}.json`), txt, 'utf8');

  return JSON.parse(txt).data;
}

async function downloadRemainingChapters(baseDir, onChapterDownloaded) {
  const MAX_CONCURRENT = 3;
  const downloadQueue = [];

  for (const book of BOOKS) {
    const chapCount = CHAPTER_COUNTS[book];
    for (let chap = 1; chap <= chapCount; chap++) {
      const file = path.join(baseDir, 'books', book, 'chapters', `${chap}.json`);
      let needsDownload = false;
      if (!fs.existsSync(file)) {
        needsDownload = true;
      } else {
        try {
          const txt = fs.readFileSync(file, 'utf8');
          const obj = JSON.parse(txt);
          if (!obj.data || !Array.isArray(obj.data) || obj.data.length === 0) {
            needsDownload = true;
          }
        } catch {
          needsDownload = true;
        }
      }
      if (needsDownload) {
        downloadQueue.push({ book, chap, file });
      }
    }
  }

  let active = 0;
  let idx = 0;

  return new Promise((resolve, reject) => {
    function next() {
      while (active < MAX_CONCURRENT && idx < downloadQueue.length) {
        const { book, chap, file } = downloadQueue[idx++];
        active++;
        fetchChapter(book, chap, baseDir)
          .then(data => {
            fs.promises.mkdir(path.dirname(file), { recursive: true })
              .then(() => fs.promises.writeFile(file, JSON.stringify({ data }, null, 2), 'utf8'))
              .then(async () => {
                if (typeof onChapterDownloaded === 'function') {
                  await onChapterDownloaded(book, chap); // Notify UI
                }
                active--;
                next();
              });
          })
          .catch(err => {
            active--;
            next();
          });
      }
      if (idx >= downloadQueue.length && active === 0) return resolve();
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Multi-format Bible importer
// ---------------------------------------------------------------------------

/**
 * Parse Zefania XML format into [{name, chapters: [[verseText]]}]
 * Supports both <VERS> and <V> tags used by different tools.
 */
function parseZefaniaXml(txt) {
  const books = [];
  // Match each BIBLEBOOK block
  const bbRe = /<BIBLEBOOK([^>]*)>([\s\S]*?)<\/BIBLEBOOK>/gi;
  let bbMatch;
  while ((bbMatch = bbRe.exec(txt)) !== null) {
    const attrs = bbMatch[1];
    const bbContent = bbMatch[2];
    const bname = (attrs.match(/\bbname="([^"]+)"/i) || attrs.match(/\bbsname="([^"]+)"/i) || [])[1] || '';

    const chapters = [];
    const chapRe = /<CHAPTER([^>]*)>([\s\S]*?)<\/CHAPTER>/gi;
    let chapMatch;
    while ((chapMatch = chapRe.exec(bbContent)) !== null) {
      const chapContent = chapMatch[2];
      const verses = [];
      // Accept both <VERS> and <V> tags
      const versRe = /<(?:VERS|V)\b[^>]*>([\s\S]*?)<\/(?:VERS|V)>/gi;
      let versMatch;
      while ((versMatch = versRe.exec(chapContent)) !== null) {
        verses.push(versMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      if (verses.length > 0) chapters.push(verses);
    }
    if (bname && chapters.length > 0) books.push({ name: bname, chapters });
  }
  return books;
}

/**
 * Parse plain text where each line is "BookName chapter:verse verse text"
 * e.g. "Genesis 1:1 In the beginning..."
 */
function parseVersePerLineTxt(txt) {
  const verseMap = new Map(); // bookName -> Map(chapNum -> Map(verseNum -> text))
  const bookOrder = [];

  for (const rawLine of txt.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s+(\d+):(\d+)\s+(.+)$/);
    if (!m) continue;
    const [, bookName, chap, verse, verseText] = m;
    const chapNum = parseInt(chap, 10);
    const verseNum = parseInt(verse, 10);

    if (!verseMap.has(bookName)) {
      verseMap.set(bookName, new Map());
      bookOrder.push(bookName);
    }
    const bookChaps = verseMap.get(bookName);
    if (!bookChaps.has(chapNum)) bookChaps.set(chapNum, new Map());
    bookChaps.get(chapNum).set(verseNum, verseText.trim());
  }

  return bookOrder.map(bookName => {
    const bookChaps = verseMap.get(bookName);
    const maxChap = Math.max(...bookChaps.keys());
    const chapters = [];
    for (let c = 1; c <= maxChap; c++) {
      const chapVerses = bookChaps.get(c) || new Map();
      const maxVerse = chapVerses.size > 0 ? Math.max(...chapVerses.keys()) : 0;
      const verses = [];
      for (let v = 1; v <= maxVerse; v++) {
        verses.push(chapVerses.get(v) || '');
      }
      chapters.push(verses);
    }
    return { name: bookName, chapters };
  });
}

/**
 * Parse USFX XML format (eBible.org primary download format).
 * Structure: <usfx><book id="GEN"><h>Genesis</h><c id="1"/><p><v id="1"/>text</p></book></usfx>
 */
function parseUsfxXml(txt) {
  const books = [];
  const bookRe = /<book\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/book>/gi;
  let bookMatch;
  while ((bookMatch = bookRe.exec(txt)) !== null) {
    const bookId = bookMatch[1];
    const bookContent = bookMatch[2];

    // Try to get a friendly name from <h>, <toc1>, or <id> tag
    const nameMatch = bookContent.match(/<h>([\s\S]*?)<\/h>/) ||
                      bookContent.match(/<toc1>([\s\S]*?)<\/toc1>/) ||
                      bookContent.match(/<id\b[^>]*>([\s\S]*?)<\/id>/);
    const bookName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, '').trim() : bookId;

    // Split content into chapters on <c id="N"/> markers
    const chapSplit = bookContent.split(/<c\s+id="\d+"[^>]*\/>/i);
    const chapters = [];
    for (let i = 1; i < chapSplit.length; i++) {
      const chapContent = chapSplit[i];
      const verses = [];
      // Collect verse text: everything after <v id="N"/> up to next <v id or end of chapter
      const verseRe = /<v\s+id="\d+"[^>]*\/>([\s\S]*?)(?=<v\s+id="|$)/gi;
      let vMatch;
      while ((vMatch = verseRe.exec(chapContent)) !== null) {
        verses.push(vMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      }
      if (verses.length > 0) chapters.push(verses);
    }
    if (bookName && chapters.length > 0) books.push({ id: bookId.toUpperCase(), name: bookName, chapters });
  }
  return books;
}

/**
 * Parse OSIS XML format.
 * Structure: <div type="book" osisID="Gen"><chapter osisID="Gen.1"><verse osisID="Gen.1.1">text</verse>
 */
function parseOsisXml(txt) {
  const books = [];
  // Match book divs
  const bookRe = /<div\b[^>]*\btype="book"[^>]*>([\s\S]*?)<\/div>/gi;
  let bookMatch;
  while ((bookMatch = bookRe.exec(txt)) !== null) {
    const bookContent = bookMatch[1];
    const titleMatch = bookContent.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const osisIdMatch = bookMatch[0].match(/osisID="([^".]+)/i);
    const bookName = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
      : (osisIdMatch ? osisIdMatch[1] : 'Unknown');

    const chapters = [];
    const chapRe = /<chapter\b[^>]*>([\s\S]*?)<\/chapter>/gi;
    let chapMatch;
    while ((chapMatch = chapRe.exec(bookContent)) !== null) {
      const chapContent = chapMatch[1];
      const verses = [];
      const verseRe = /<verse\b[^>]*>([\s\S]*?)<\/verse>/gi;
      let verseMatch;
      while ((verseMatch = verseRe.exec(chapContent)) !== null) {
        verses.push(verseMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      }
      if (verses.length > 0) chapters.push(verses);
    }
    if (bookName && chapters.length > 0) books.push({ id: osisIdMatch ? osisIdMatch[1].toUpperCase() : undefined, name: bookName, chapters });
  }
  return books;
}

/**
 * Parse USFM text format (common Bible translation format).
 * \id GEN ..., \c 1, \v 1 verse text
 */
function parseUsfm(txt) {
  const books = [];
  let currentBook = null;
  let currentChapter = null;
  let currentVerseText = '';
  let collectingVerse = false;

  function flushVerse() {
    if (collectingVerse && currentChapter && currentVerseText.trim()) {
      currentChapter.push(currentVerseText.replace(/\s+/g, ' ').trim());
    }
    currentVerseText = '';
    collectingVerse = false;
  }

  function flushChapter() {
    flushVerse();
    if (currentBook && currentChapter && currentChapter.length > 0) {
      currentBook.chapters.push(currentChapter);
    }
    currentChapter = null;
  }

  const lines = txt.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('\\id ')) {
      flushChapter();
      if (currentBook && currentBook.chapters.length > 0) books.push(currentBook);
      // Name comes from \h or \toc1 later; use id for now
      const sourceBookId = line.slice(4).split(/\s/)[0].toUpperCase();
      currentBook = { id: sourceBookId, name: sourceBookId, chapters: [] };
      currentChapter = null;
      collectingVerse = false;
    } else if (line.startsWith('\\h ') || line.startsWith('\\h\t')) {
      if (currentBook) {
        const name = line.slice(3).trim();
        if (name) currentBook.name = name;
      }
    } else if (line.startsWith('\\toc1 ')) {
      // Use \toc1 as book name only if \h was not found yet
      if (currentBook && /^[A-Z]{2,3}$/.test(currentBook.name)) {
        currentBook.name = line.slice(6).trim() || currentBook.name;
      }
    } else if (line.startsWith('\\c ')) {
      flushChapter();
      currentChapter = [];
    } else if (line.startsWith('\\v ')) {
      flushVerse();
      collectingVerse = true;
      // Remove the "\v N " prefix to get verse text
      currentVerseText = line.replace(/^\\v\s+\d+\s*/, '').replace(/\\[a-z]+\*?\s*/g, '').trim();
    } else if (collectingVerse && !line.startsWith('\\')) {
      // Continuation of verse text (no backslash marker)
      currentVerseText += ' ' + line;
    } else if (collectingVerse && line.startsWith('\\')) {
      // Inline style marker (e.g. \wj Jesus\wj*) — strip and continue if it's inline
      const inline = /^\\(?:wj|nd|bk|add|tl|dc|k|sls|sig|pb|qs|b|qr)\b/.test(line);
      if (inline) {
        currentVerseText += ' ' + line.replace(/\\[a-z]+\*?\s*/g, '').trim();
      } else {
        // Paragraph-level marker — flush current verse and stop collecting
        flushVerse();
      }
    }
  }
  flushChapter();
  if (currentBook && currentBook.chapters.length > 0) books.push(currentBook);
  return books;
}

/**
 * Parse TSV (tab-separated values) Bible format.
 * Expected columns: book_id/book  chapter  verse  text
 * Handles: with or without header row, 3 or 4 columns.
 */
function parseTsv(txt) {
  const verseMap = new Map();
  const bookOrder = [];
  let headerSkipped = false;

  for (const rawLine of txt.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;

    // Skip header row if it exists
    if (!headerSkipped && isNaN(parseInt(cols[1], 10))) {
      headerSkipped = true;
      continue;
    }
    headerSkipped = true;

    let bookId, chap, verse, verseText;
    if (cols.length >= 4) {
      [bookId, chap, verse, verseText] = cols;
    } else {
      // 3-column: "GEN 1:1" style in first column
      const m = cols[0].match(/^(.+?)\s+(\d+):(\d+)$/);
      if (!m) continue;
      bookId = m[1]; chap = m[2]; verse = m[3]; verseText = cols[1];
    }

    const chapNum = parseInt(chap, 10);
    const verseNum = parseInt(verse, 10);
    if (!bookId || isNaN(chapNum) || isNaN(verseNum)) continue;

    if (!verseMap.has(bookId)) {
      verseMap.set(bookId, new Map());
      bookOrder.push(bookId);
    }
    const bookChaps = verseMap.get(bookId);
    if (!bookChaps.has(chapNum)) bookChaps.set(chapNum, new Map());
    bookChaps.get(chapNum).set(verseNum, (verseText || '').trim());
  }

  return bookOrder.map(bookId => {
    const bookChaps = verseMap.get(bookId);
    const maxChap = Math.max(...bookChaps.keys());
    const chapters = [];
    for (let c = 1; c <= maxChap; c++) {
      const chapVerses = bookChaps.get(c) || new Map();
      const maxVerse = chapVerses.size > 0 ? Math.max(...chapVerses.keys()) : 0;
      const verses = [];
      for (let v = 1; v <= maxVerse; v++) {
        verses.push(chapVerses.get(v) || '');
      }
      chapters.push(verses);
    }
    return { name: bookId, chapters };
  });
}

/**
 * Normalize any supported Bible source format into [{name, chapters:[[]]}].
 * @param {string} txt    - raw file content
 * @param {string} filePath - original file path (used for extension hint)
 */
function normalizeBibleData(txt, filePath) {
  const ext = (filePath ? path.extname(filePath) : '').toLowerCase();

  // --- JSON (thiagobodruk and similar) ---
  if (ext === '.json' || ext === '') {
    try {
      const data = JSON.parse(txt);
      if (Array.isArray(data)) {
        return data.map(book => ({
          ...book,
          name: book.name || book.book || book.bookname || book.abbrev || 'Unknown'
        }));
      }
    } catch (_) { /* fall through to other parsers */ }
  }

  // --- USFX XML (eBible.org format) ---
  if (ext === '.usfx' || txt.includes('<usfx') || txt.includes('<USFX')) {
    const books = parseUsfxXml(txt);
    if (books.length > 0) return books;
  }

  // --- OSIS XML ---
  if (ext === '.osis' || txt.includes('<osis') || txt.includes('<OSIS')) {
    const books = parseOsisXml(txt);
    if (books.length > 0) return books;
  }

  // --- Zefania XML ---
  if (ext === '.xml' || txt.includes('<XMLBIBLE') || txt.includes('<ZEFANIA_XML') || txt.includes('<BIBLEBOOK')) {
    const books = parseZefaniaXml(txt);
    if (books.length > 0) return books;
  }

  // --- USFM text ---
  if (ext === '.usfm' || ext === '.sfm' || txt.includes('\\id ')) {
    const books = parseUsfm(txt);
    if (books.length > 0) return books;
  }

  // --- TSV (tab-separated) ---
  if (ext === '.tsv' || ext === '.csv') {
    const books = parseTsv(txt);
    if (books.length > 0) return books;
  }

  // --- Plain verse-per-line text ---
  const books = parseVersePerLineTxt(txt);
  if (books.length > 0) return books;

  throw new Error('Could not recognize Bible file format. Supported: JSON, Zefania XML, USFX XML, OSIS XML, USFM, TSV, or verse-per-line text.');
}

/**
 * Extract the primary Bible data file from a ZIP archive.
 * Priority: *_usfx.xml > any .xml (non-metadata) > .usfm/.sfm > .txt > .tsv > .json
 * @param {string} filePath - path to the .zip file
 * @returns {{ text: string, name: string }} extracted text and the entry filename
 */
async function extractBibleFromZip(filePath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries().filter(e => !e.isDirectory);

  const METADATA_RE = /metadata|booknames|parms|copr|vernacular|signature|readme|license/i;
  // eBible USFX packages normally contain one whole-Bible XML file. Prefer it.
  const usfxEntry = entries.find(e => /usfx[^/\\]*\.xml$/i.test(e.entryName));
  if (usfxEntry) return { text: usfxEntry.getData().toString('utf8'), name: usfxEntry.entryName };

  const xmlEntry = entries.find(e => /\.xml$/i.test(e.entryName) && !METADATA_RE.test(e.entryName));
  if (xmlEntry) return { text: xmlEntry.getData().toString('utf8'), name: xmlEntry.entryName };

  // USFM ZIPs commonly contain one file per book. Concatenate every book instead
  // of silently importing only the first file in the archive.
  const usfmEntries = entries.filter(e => /\.(usfm|sfm)$/i.test(e.entryName));
  if (usfmEntries.length > 0) {
    return {
      text: usfmEntries.map(entry => entry.getData().toString('utf8')).join('\n\n'),
      name: `${path.basename(filePath, path.extname(filePath))}.usfm`
    };
  }

  const priorities = [
    e => /\.txt$/i.test(e.entryName) && !METADATA_RE.test(e.entryName),
    e => /\.tsv$/i.test(e.entryName),
    e => /\.json$/i.test(e.entryName),
    e => /\.xml$/i.test(e.entryName),
  ];

  for (const test of priorities) {
    const entry = entries.find(test);
    if (entry) return { text: entry.getData().toString('utf8'), name: entry.entryName };
  }
  throw new Error('No recognizable Bible file found inside ZIP.');
}

/**
 * Parse a Bible file and return summary information without saving.
 * @param {string} filePath - source file path
 * @returns {{ books: Array, summary: Array<{name, chapters, verses}> }}
 */
async function parseBibleFile(filePath) {
  let txt, resolvedPath;
  if (path.extname(filePath).toLowerCase() === '.zip') {
    const { text, name } = await extractBibleFromZip(filePath);
    txt = text;
    resolvedPath = name;
  } else {
    txt = await fs.promises.readFile(filePath, 'utf8');
    resolvedPath = filePath;
  }
  const books = normalizeBibleData(txt, resolvedPath);
  if (!books || books.length === 0) throw new Error('No Bible books found in file.');
  const summary = books.map(b => ({
    name: b.name,
    chapters: b.chapters.length,
    verses: b.chapters.reduce((sum, ch) => sum + ch.length, 0)
  }));
  return { books, summary };
}

/**
 * Import a Bible file into the app's storage.
 * @param {string} filePath   - source file path
 * @param {string} versionId  - e.g. 'en_nasb' (used as folder name and bible identifier)
 * @param {string} storageDir - userData/bibles directory
 * @returns {string} path to saved bible.json
 */
async function importBibleFile(filePath, versionId, storageDir) {
  let txt, resolvedPath;
  if (path.extname(filePath).toLowerCase() === '.zip') {
    const { text, name } = await extractBibleFromZip(filePath);
    txt = text;
    resolvedPath = name;
  } else {
    txt = await fs.promises.readFile(filePath, 'utf8');
    resolvedPath = filePath;
  }
  const books = normalizeBibleData(txt, resolvedPath);
  if (!books || books.length === 0) throw new Error('No Bible books found in file.');

  const destDir = path.join(storageDir, versionId);
  await fs.promises.mkdir(destDir, { recursive: true });
  const destFile = path.join(destDir, 'bible.json');
  const tempFile = `${destFile}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempFile, JSON.stringify(books), 'utf8');
  try {
    await fs.promises.rename(tempFile, destFile);
  } catch (error) {
    try { await fs.promises.unlink(destFile); } catch (_) {}
    await fs.promises.rename(tempFile, destFile);
  }
  return destFile;
}

// If you have VERSE_COUNTS, use it. Otherwise, estimate (e.g., 50 verses per chapter)
function generateAllVerseKeys(VERSE_COUNTS) {
  const keys = [];
  for (const book of BOOKS) {
    const chapCount = CHAPTER_COUNTS[book];
    for (let chap = 1; chap <= chapCount; chap++) {
      const verseCount = VERSE_COUNTS?.[book]?.[chap] || 50; // fallback if not available
      for (let verse = 1; verse <= verseCount; verse++) {
        keys.push({
          key: `${book} ${chap}:${verse}`,
          book,
          chapter: chap,
          verse
        });
      }
    }
  }
  return keys;
}

module.exports = {
  ensureBibleJson,
  loadAllVersesFromDisk,
  fetchChapter,
  downloadRemainingChapters,
  generateAllVerseKeys,
  normalizeBibleData,
  parseBibleFile,
  importBibleFile
};