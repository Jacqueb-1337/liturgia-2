const { decodeProgramStyles, applyProgramStylePatch } = require('../lib/programStyles');

test('saves one Worship style without replacing other styles, and resets only that target', () => {
  const current = { verseText: Buffer.from('color: red').toString('base64'), customElement: 'saved' };
  const next = applyProgramStylePatch(current, { songText: 'font-size: 56px; color: #fff' });
  expect(next.verseText).toBe(current.verseText);
  expect(next.customElement).toBe('saved');
  expect(decodeProgramStyles(next).songText).toBe('font-size: 56px; color: #fff');
  const reset = applyProgramStylePatch(next, { verseText: '' });
  expect(reset.verseText).toBeUndefined();
  expect(decodeProgramStyles(reset).songText).toBe('font-size: 56px; color: #fff');
});

test('rejects unsupported or oversized styles', () => {
  expect(() => applyProgramStylePatch({}, { settings: 'color: red' })).toThrow('Unknown style target');
  expect(() => applyProgramStylePatch({}, { verseText: 'x'.repeat(8193) })).toThrow('under 8192');
});
