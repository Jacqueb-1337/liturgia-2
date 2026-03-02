const fs = require('fs');
const path = require('path');
const { CDN_BASE, BOOKS, CHAPTER_COUNTS, BIBLE_JSON, VERSION } = require('./constants');

const LOCAL_BIBLE_FILE = 'bible.json';

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

  // Flatten to allVerses: {key, text}
  const allVerses = [];
  for (const book of books) {
    // Accept any of the common key names different Bible JSON sources use
    const bookName = book.name || book.book || book.bookname || book.abbrev || 'Unknown';
    for (let c = 0; c < book.chapters.length; ++c) {
      const chapter = book.chapters[c];
      for (let v = 0; v < chapter.length; ++v) {
        allVerses.push({
          key: `${bookName} ${c + 1}:${v + 1}`,
          text: chapter[v]
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

  // --- Zefania XML ---
  if (ext === '.xml' || txt.includes('<XMLBIBLE') || txt.includes('<ZEFANIA_XML') || txt.includes('<BIBLEBOOK')) {
    const books = parseZefaniaXml(txt);
    if (books.length > 0) return books;
  }

  // --- Plain verse-per-line text ---
  const books = parseVersePerLineTxt(txt);
  if (books.length > 0) return books;

  throw new Error('Could not recognize Bible file format. Expected JSON array, Zefania XML, or verse-per-line text.');
}

/**
 * Import a Bible file into the app's storage.
 * @param {string} filePath   - source file path
 * @param {string} versionId  - e.g. 'en_nasb' (used as folder name and bible identifier)
 * @param {string} storageDir - userData/bibles directory
 * @returns {string} path to saved bible.json
 */
async function importBibleFile(filePath, versionId, storageDir) {
  const txt = await fs.promises.readFile(filePath, 'utf8');
  const books = normalizeBibleData(txt, filePath);
  if (!books || books.length === 0) throw new Error('No Bible books found in file.');

  const destDir = path.join(storageDir, versionId);
  await fs.promises.mkdir(destDir, { recursive: true });
  const destFile = path.join(destDir, 'bible.json');
  await fs.promises.writeFile(destFile, JSON.stringify(books), 'utf8');
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
  importBibleFile
};