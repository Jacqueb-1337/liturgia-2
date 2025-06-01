const VERSION     = 'en_kjv'; // Note the underscore, matches the file name
const CDN_BASE    = `https://raw.githubusercontent.com/thiagobodruk/bible/master/json`;
const BIBLE_JSON  = `${CDN_BASE}/${VERSION}.json`;
const ITEM_HEIGHT = 24;
const WINDOW_SIZE = 200;
const BUFFER      = 20;
const BIBLE_STORAGE_DIR = 'bibles'; // Directory for downloaded Bibles

const BOOKS = [
  "genesis","exodus","leviticus","numbers","deuteronomy",
  "joshua","judges","ruth","1 samuel","2 samuel",
  "1 kings","2 kings","1 chronicles","2 chronicles","ezra",
  "nehemiah","esther","job","psalms","proverbs",
  "ecclesiastes","song of solomon","isaiah","jeremiah",
  "lamentations","ezekiel","daniel","hosea","joel",
  "amos","obadiah","jonah","micah","nahum",
  "habakkuk","zephaniah","haggai","zechariah","malachi",
  "matthew","mark","luke","john","acts",
  "romans","1 corinthians","2 corinthians","galatians","ephesians",
  "philippians","colossians","1 thessalonians","2 thessalonians","1 timothy",
  "2 timothy","titus","philemon","hebrews","james",
  "1 peter","2 peter","1 john","2 john","3 john",
  "jude","revelation"
];

const CHAPTER_COUNTS = {
  "genesis": 50,
  "exodus": 40,
  "leviticus": 27,
  "numbers": 36,
  "deuteronomy": 34,
  "joshua": 24,
  "judges": 21,
  "ruth": 4,
  "1 samuel": 31,
  "2 samuel": 24,
  "1 kings": 22,
  "2 kings": 25,
  "1 chronicles": 29,
  "2 chronicles": 36,
  "ezra": 10,
  "nehemiah": 13,
  "esther": 10,
  "job": 42,
  "psalms": 150,
  "proverbs": 31,
  "ecclesiastes": 12,
  "song of solomon": 8,
  "isaiah": 66,
  "jeremiah": 52,
  "lamentations": 5,
  "ezekiel": 48,
  "daniel": 12,
  "hosea": 14,
  "joel": 3,
  "amos": 9,
  "obadiah": 1,
  "jonah": 4,
  "micah": 7,
  "nahum": 3,
  "habakkuk": 3,
  "zephaniah": 3,
  "haggai": 2,
  "zechariah": 14,
  "malachi": 4,
  "matthew": 28,
  "mark": 16,
  "luke": 24,
  "john": 21,
  "acts": 28,
  "romans": 16,
  "1 corinthians": 16,
  "2 corinthians": 13,
  "galatians": 6,
  "ephesians": 6,
  "philippians": 4,
  "colossians": 4,
  "1 thessalonians": 5,
  "2 thessalonians": 3,
  "1 timothy": 6,
  "2 timothy": 4,
  "titus": 3,
  "philemon": 1,
  "hebrews": 13,
  "james": 5,
  "1 peter": 5,
  "2 peter": 3,
  "1 john": 5,
  "2 john": 1,
  "3 john": 1,
  "jude": 1,
  "revelation": 22
};

module.exports = {
  VERSION, CDN_BASE, BIBLE_JSON, ITEM_HEIGHT, WINDOW_SIZE, BUFFER, BOOKS, CHAPTER_COUNTS, BIBLE_STORAGE_DIR
};