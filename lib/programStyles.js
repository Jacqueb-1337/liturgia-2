'use strict';

const PROGRAM_STYLE_KEYS = Object.freeze([
  'verseText', 'verseNumber', 'verseSubscript', 'verseReference',
  'songText', 'songTitle', 'songReference', 'global'
]);

function decodeProgramStyles(styles) {
  const decoded = {};
  for (const key of PROGRAM_STYLE_KEYS) {
    const encoded = styles?.[key];
    decoded[key] = typeof encoded === 'string' ? Buffer.from(encoded, 'base64').toString('utf8') : '';
  }
  return decoded;
}

function applyProgramStylePatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid styles');
  const next = { ...current };
  for (const [key, css] of Object.entries(patch)) {
    if (!PROGRAM_STYLE_KEYS.includes(key)) throw new Error('Unknown style target');
    if (typeof css !== 'string' || css.length > 8192) throw new Error('Style must be under 8192 characters');
    if (css.trim()) next[key] = Buffer.from(css, 'utf8').toString('base64');
    else delete next[key];
  }
  return next;
}

module.exports = { PROGRAM_STYLE_KEYS, decodeProgramStyles, applyProgramStylePatch };
