const BOOKS = [
  { key: 'genesis', name: 'Genesis', aliases: ['genesis', 'gen'] },
  { key: 'exodus', name: 'Exodus', aliases: ['exodus', 'exo'] },
  { key: 'leviticus', name: 'Leviticus', aliases: ['leviticus', 'lev'] },
  { key: 'numbers', name: 'Numbers', aliases: ['numbers', 'num'] },
  { key: 'deuteronomy', name: 'Deuteronomy', aliases: ['deuteronomy', 'deut', 'deu'] },
  { key: 'joshua', name: 'Joshua', aliases: ['joshua', 'josh'] },
  { key: 'judges', name: 'Judges', aliases: ['judges', 'judg'] },
  { key: 'ruth', name: 'Ruth', aliases: ['ruth'] },
  { key: '1samuel', name: '1 Samuel', aliases: ['1 samuel', 'first samuel', 'one samuel'] },
  { key: '2samuel', name: '2 Samuel', aliases: ['2 samuel', 'second samuel', 'two samuel'] },
  { key: '1kings', name: '1 Kings', aliases: ['1 kings', 'first kings', 'one kings'] },
  { key: '2kings', name: '2 Kings', aliases: ['2 kings', 'second kings', 'two kings'] },
  { key: '1chronicles', name: '1 Chronicles', aliases: ['1 chronicles', 'first chronicles', 'one chronicles'] },
  { key: '2chronicles', name: '2 Chronicles', aliases: ['2 chronicles', 'second chronicles', 'two chronicles'] },
  { key: 'ezra', name: 'Ezra', aliases: ['ezra'] },
  { key: 'nehemiah', name: 'Nehemiah', aliases: ['nehemiah', 'neh'] },
  { key: 'esther', name: 'Esther', aliases: ['esther'] },
  { key: 'job', name: 'Job', aliases: ['job'] },
  { key: 'psalms', name: 'Psalms', aliases: ['psalms', 'psalm', 'ps'] },
  { key: 'proverbs', name: 'Proverbs', aliases: ['proverbs', 'prov'] },
  { key: 'ecclesiastes', name: 'Ecclesiastes', aliases: ['ecclesiastes', 'eccl'] },
  { key: 'songofsongs', name: 'Song of Songs', aliases: ['song of songs', 'song of solomon', 'songs'] },
  { key: 'isaiah', name: 'Isaiah', aliases: ['isaiah', 'isa'] },
  { key: 'jeremiah', name: 'Jeremiah', aliases: ['jeremiah', 'jer'] },
  { key: 'lamentations', name: 'Lamentations', aliases: ['lamentations', 'lam'] },
  { key: 'ezekiel', name: 'Ezekiel', aliases: ['ezekiel', 'ezek'] },
  { key: 'daniel', name: 'Daniel', aliases: ['daniel', 'dan'] },
  { key: 'hosea', name: 'Hosea', aliases: ['hosea', 'hos'] },
  { key: 'joel', name: 'Joel', aliases: ['joel'] },
  { key: 'amos', name: 'Amos', aliases: ['amos'] },
  { key: 'obadiah', name: 'Obadiah', aliases: ['obadiah'] },
  { key: 'jonah', name: 'Jonah', aliases: ['jonah'] },
  { key: 'micah', name: 'Micah', aliases: ['micah'] },
  { key: 'nahum', name: 'Nahum', aliases: ['nahum'] },
  { key: 'habakkuk', name: 'Habakkuk', aliases: ['habakkuk', 'hab'] },
  { key: 'zephaniah', name: 'Zephaniah', aliases: ['zephaniah', 'zeph'] },
  { key: 'haggai', name: 'Haggai', aliases: ['haggai'] },
  { key: 'zechariah', name: 'Zechariah', aliases: ['zechariah', 'zech'] },
  { key: 'malachi', name: 'Malachi', aliases: ['malachi', 'mal'] },
  { key: 'matthew', name: 'Matthew', aliases: ['matthew', 'matt', 'mt'] },
  { key: 'mark', name: 'Mark', aliases: ['mark', 'mk'] },
  { key: 'luke', name: 'Luke', aliases: ['luke', 'lk'] },
  { key: 'john', name: 'John', aliases: ['john', 'jn'] },
  { key: 'acts', name: 'Acts', aliases: ['acts'] },
  { key: 'romans', name: 'Romans', aliases: ['romans', 'rom'] },
  { key: '1corinthians', name: '1 Corinthians', aliases: ['1 corinthians', 'first corinthians', 'one corinthians'] },
  { key: '2corinthians', name: '2 Corinthians', aliases: ['2 corinthians', 'second corinthians', 'two corinthians'] },
  { key: 'galatians', name: 'Galatians', aliases: ['galatians', 'gal'] },
  { key: 'ephesians', name: 'Ephesians', aliases: ['ephesians', 'eph'] },
  { key: 'philippians', name: 'Philippians', aliases: ['philippians', 'phil'] },
  { key: 'colossians', name: 'Colossians', aliases: ['colossians', 'col'] },
  { key: '1thessalonians', name: '1 Thessalonians', aliases: ['1 thessalonians', 'first thessalonians', 'one thessalonians'] },
  { key: '2thessalonians', name: '2 Thessalonians', aliases: ['2 thessalonians', 'second thessalonians', 'two thessalonians'] },
  { key: '1timothy', name: '1 Timothy', aliases: ['1 timothy', 'first timothy', 'one timothy'] },
  { key: '2timothy', name: '2 Timothy', aliases: ['2 timothy', 'second timothy', 'two timothy'] },
  { key: 'titus', name: 'Titus', aliases: ['titus'] },
  { key: 'philemon', name: 'Philemon', aliases: ['philemon'] },
  { key: 'hebrews', name: 'Hebrews', aliases: ['hebrews', 'heb'] },
  { key: 'james', name: 'James', aliases: ['james', 'jas'] },
  { key: '1peter', name: '1 Peter', aliases: ['1 peter', 'first peter', 'one peter'] },
  { key: '2peter', name: '2 Peter', aliases: ['2 peter', 'second peter', 'two peter'] },
  { key: '1john', name: '1 John', aliases: ['1 john', 'first john', 'one john'] },
  { key: '2john', name: '2 John', aliases: ['2 john', 'second john', 'two john'] },
  { key: '3john', name: '3 John', aliases: ['3 john', 'third john', 'three john'] },
  { key: 'jude', name: 'Jude', aliases: ['jude'] },
  { key: 'revelation', name: 'Revelation', aliases: ['revelation', 'rev', 'revelations'] }
];

const BOOK_ALIAS_ENTRIES = BOOKS.flatMap((book) => book.aliases.map((alias) => ({
  key: book.key,
  alias,
  name: book.name
}))).sort((a, b) => b.alias.length - a.alias.length);

const STOP_WORDS = new Set(['chapter', 'chapters', 'verse', 'verses', 'and', 'the', 'book', 'of']);

const NUMBER_WORDS = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60],
  ['seventy', 70], ['eighty', 80], ['ninety', 90], ['hundred', 100]
]);

const NUMBER_HOMOPHONES = new Map([
  ['won', 1], ['too', 2], ['to', 2], ['tree', 3], ['for', 4], ['fore', 4], ['ate', 8], ['nein', 9]
]);

function normalizeForSearch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9:\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rollingWindowText(text, tokenLimit = 320) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  if (tokens.length <= tokenLimit) return tokens.join(' ');
  return tokens.slice(tokens.length - tokenLimit).join(' ');
}

function wordToNumber(token) {
  if (!token) return null;
  const lower = token.toLowerCase();
  if (/^\d{1,3}$/.test(lower)) return parseInt(lower, 10);
  if (NUMBER_WORDS.has(lower)) return NUMBER_WORDS.get(lower);
  if (NUMBER_HOMOPHONES.has(lower)) return NUMBER_HOMOPHONES.get(lower);
  return null;
}

function combineNumberTokens(tokens) {
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = wordToNumber(tokens[i]);
    if (current == null) continue;

    const next = i + 1 < tokens.length ? wordToNumber(tokens[i + 1]) : null;
    if (current >= 20 && current % 10 === 0 && next != null && next < 10) {
      values.push(current + next);
      i += 1;
      continue;
    }

    if (current < 10 && next === 100) {
      let total = current * 100;
      const after = i + 2 < tokens.length ? wordToNumber(tokens[i + 2]) : null;
      if (after != null) {
        total += after;
        i += 2;
      } else {
        i += 1;
      }
      values.push(total);
      continue;
    }

    values.push(current);
  }
  return values;
}

function findBookCandidate(normalizedText, lastBookKey = null) {
  if (!normalizedText) {
    if (!lastBookKey) return null;
    const prev = BOOKS.find((b) => b.key === lastBookKey);
    if (!prev) return null;
    return { bookKey: prev.key, alias: prev.aliases[0], index: -1, carried: true, reason: 'Using previous book context' };
  }

  let best = null;
  for (const entry of BOOK_ALIAS_ENTRIES) {
    const idx = normalizedText.lastIndexOf(entry.alias);
    if (idx === -1) continue;
    if (!best || idx > best.index) {
      best = { bookKey: entry.key, alias: entry.alias, index: idx, carried: false, reason: `Detected ${entry.name}` };
    }
  }

  if (best) return best;
  if (lastBookKey) {
    const prev = BOOKS.find((b) => b.key === lastBookKey);
    if (prev) return { bookKey: prev.key, alias: prev.aliases[0], index: -1, carried: true, reason: 'Using previous book context' };
  }
  return null;
}

function extractChapterVerse(normalizedText, aliasInfo) {
  if (!normalizedText) return null;

  const colonPattern = /(?<chap>\d{1,3})\s*:\s*(?<verse>\d{1,3})/g;
  let colonMatch = null;
  let match;
  while ((match = colonPattern.exec(normalizedText))) {
    colonMatch = match;
  }

  if (aliasInfo && aliasInfo.index !== -1) {
    const tail = normalizedText.slice(aliasInfo.index + aliasInfo.alias.length).trim();
    if (tail) {
      const aliasTokens = tail.split(/\s+/).filter((token) => token && !STOP_WORDS.has(token));
      const colonLocal = aliasTokens.find((token) => /\d{1,3}:\d{1,3}/.test(token));
      if (colonLocal) {
        const [chap, verse] = colonLocal.split(':').map((v) => parseInt(v, 10));
        return { chapter: chap, verse, reason: 'Numbers detected right after the book mention' };
      }
      const numbers = combineNumberTokens(aliasTokens).slice(0, 3);
      if (numbers.length >= 2) {
        return { chapter: numbers[0], verse: numbers[1], reason: 'Two numbers detected after the book mention' };
      }
      if (numbers.length === 1) {
        return { chapter: numbers[0], verse: null, reason: 'Single number detected after the book mention' };
      }
    }
  }

  if (colonMatch) {
    return {
      chapter: parseInt(colonMatch.groups.chap, 10),
      verse: parseInt(colonMatch.groups.verse, 10),
      reason: 'Detected chapter:verse pattern'
    };
  }

  const tailNumbers = combineNumberTokens(normalizedText.split(/\s+/).slice(-6));
  if (tailNumbers.length >= 2) {
    return {
      chapter: tailNumbers[tailNumbers.length - 2],
      verse: tailNumbers[tailNumbers.length - 1],
      reason: 'Interpreted last two numbers as chapter and verse'
    };
  }
  if (tailNumbers.length === 1) {
    return {
      chapter: tailNumbers[0],
      verse: null,
      reason: 'Detected single number acting as chapter'
    };
  }
  return null;
}

function bookDisplay(key) {
  const match = BOOKS.find((b) => b.key === key);
  return match ? match.name : key;
}

function buildSuggestions(text, options = {}) {
  const normalized = normalizeForSearch(text);
  const candidate = findBookCandidate(normalized, options.lastBookKey || null);
  if (!candidate) return [];

  const location = extractChapterVerse(normalized, candidate);
  const reasons = [];
  if (candidate.reason) reasons.push(candidate.reason);
  if (location && location.reason) reasons.push(location.reason);

  const bookName = bookDisplay(candidate.bookKey);
  let ref = bookName;
  if (location?.chapter != null) ref += ` ${location.chapter}`;
  if (location?.verse != null) ref += `:${location.verse}`;

  const suggestion = {
    bookKey: candidate.bookKey,
    chapter: location?.chapter ?? null,
    verse: location?.verse ?? null,
    ref,
    reference: ref,
    reasons: reasons.length ? reasons : ['Listening for scripture phrases'],
    score: 60 + (location?.chapter ? 10 : 0) + (location?.verse ? 15 : 0)
  };

  const extras = [];
  if (location?.chapter != null && location?.verse == null) {
    extras.push({
      bookKey: candidate.bookKey,
      chapter: location.chapter,
      verse: null,
      ref: `${bookName} ${location.chapter}`,
      reference: `${bookName} ${location.chapter}`,
      reasons: ['Awaiting verse number'],
      score: suggestion.score - 8
    });
  }

  return [suggestion, ...extras].slice(0, 4);
}

module.exports = {
  BOOKS,
  buildSuggestions,
  rollingWindowText
};
