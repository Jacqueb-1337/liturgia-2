const fs = require('fs');
const path = require('path');

function makeTransition(calls) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'live.html'), 'utf8');
  const start = html.indexOf('function transitionTextLayer(');
  const end = html.indexOf('function getBackgroundTransitionDuration(', start);
  if (start < 0 || end < 0) throw new Error('Could not find Worship text transition function');
  const source = html.slice(start, end).trim();
  const context = {
    clearRect: jest.fn(),
    drawImage: jest.fn()
  };
  const create = new Function(
    'applyTextFadeOutAnimation', 'applyTextFadeInAnimation', 'cancelTextAnimation',
    'textCtx', 'textCanvas', 'buildTextCanvas', 'currentRenderWidth',
    'currentRenderHeight', 'isClearMode', 'isBlackMode',
    `return (${source})`
  );
  return create(
    (_old, _duration, _type, done) => { calls.push('fade-out'); done(); },
    () => { calls.push('fade-in'); },
    () => { calls.push('cancel'); },
    context, { width: 1920, height: 1080 }, () => ({}),
    1920, 1080, false, false
  );
}

test('repeated identical verse/state does not restart transitions or clear the text', () => {
  const calls = [];
  const transition = makeTransition(calls);
  const same = { text: 'For God so loved the world', number: '16', reference: 'John 3:16', styles: { verse: { color: '#fff' } } };
  transition(same, JSON.parse(JSON.stringify(same)));
  expect(calls).toEqual([]);
});

test('a genuine verse change still uses normal fade-out and fade-in', () => {
  const calls = [];
  const transition = makeTransition(calls);
  const oldVerse = { text: 'In the beginning', number: '1', reference: 'Genesis 1:1', styles: {} };
  transition(oldVerse, { ...oldVerse, text: 'And the earth was without form', number: '2' });
  expect(calls).toEqual(['fade-out', 'fade-in']);
});
