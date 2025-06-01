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
    for (let c = 0; c < book.chapters.length; ++c) {
      const chapter = book.chapters[c];
      for (let v = 0; v < chapter.length; ++v) {
        allVerses.push({
          key: `${book.name} ${c + 1}:${v + 1}`,
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
  generateAllVerseKeys
};