const { createOperatorNotifications, STORE_KEY } = require('../lib/operatorNotifications');

beforeEach(() => { document.body.innerHTML = ''; localStorage.clear(); });
afterEach(() => { delete window.matchMedia; delete window.ResizeObserver; });

function motionHarness(reduce = false) {
  const callbacks = new Set();
  const query = {
    matches: reduce,
    addEventListener: (_type, handler) => callbacks.add(handler),
    removeEventListener: (_type, handler) => callbacks.delete(handler),
    change(value) { this.matches = value; for (const handler of callbacks) handler(); }
  };
  window.matchMedia = jest.fn(() => query);
  const animations = [];
  const animateFn = jest.fn((node, options) => {
    const item = { node, options, reverted: false,
      revert() { this.reverted = true; },
      complete() { options.onComplete(); } };
    animations.push(item);
    return item;
  });
  return { query, animateFn, animations };
}

test('queues independent messages and supports severity, read and dismiss', () => {
  const center = createOperatorNotifications({ doc: document, storage: localStorage });
  center.add({ id: 'js-error', title: 'Error in renderer', severity: 'error', body: 'Unexpected failure', actions: [{ id: 'save-report', label: 'Save Report' }] });
  center.add({ id: 'network', title: 'Network access', severity: 'warning', body: 'Rule check failed', actions: [{ id: 'fix', label: 'Fix' }] });
  expect(center.getMessages()).toHaveLength(2);
  expect(document.querySelector('#liturgia-notification-button').getAttribute('aria-label')).toContain('2 unread notifications');
  document.querySelector('#liturgia-notification-button').click();
  expect(document.querySelectorAll('.liturgia-notification-entry')).toHaveLength(2);
  expect(center.getMessages().every(x => x.read)).toBe(true);
  document.querySelector('.lnt-dismiss').click();
  expect(center.getMessages().filter(x => x.dismissed)).toHaveLength(1);
  center.destroy();
});

test('notification pill shows unread count only in the badge', () => {
  const center = createOperatorNotifications({ doc: document, storage: localStorage });
  center.add({ id:'first', title:'One', severity:'warning' });
  const pill = center.root.querySelector('#liturgia-notification-button');
  const label = pill.querySelector('.lnt-pill-label');
  const badge = pill.querySelector('.lnt-pill-count');
  expect(label.textContent).toBe('Notifications');
  expect(badge.hidden).toBe(false);
  expect(badge.textContent).toBe('');
  center.add({ id:'second', title:'Two' });
  expect(label.textContent).toBe('Notifications');
  expect(pill.getAttribute('aria-label')).toContain('2 unread notifications');
  center.show();
  expect(badge.hidden).toBe(true);
  center.destroy();
});

test('persists read status and only alerts again for a new revision', () => {
  let center = createOperatorNotifications({ doc: document, storage: localStorage });
  center.add({ id: 'news', title: 'A message from Liturgia', body: 'Hello', origin: 'liturgia', revision: 'one' });
  expect(document.querySelector('#liturgia-notification-button').textContent).toContain('A message from Liturgia');
  center.show();
  center.dismiss('news');
  center.destroy();
  center = createOperatorNotifications({ doc: document, storage: localStorage });
  center.add({ id: 'news', title: 'A message from Liturgia', body: 'Hello', origin: 'liturgia', revision: 'one' });
  expect(document.querySelector('#liturgia-notification-button').hidden).toBe(true);
  center.add({ id: 'news', title: 'A message from Liturgia', body: 'New', origin: 'liturgia', revision: 'two' });
  expect(center.getMessages()[0].read).toBe(false);
  expect(JSON.parse(localStorage.getItem(STORE_KEY))).toHaveLength(1);
  center.destroy();
});

test('runs only the action on user click', async () => {
  const action = jest.fn(async () => {});
  const center = createOperatorNotifications({ doc: document, storage: localStorage, onAction: action });
  center.add({ id: 'firewall', title: 'Network access', actions: [{ id: 'repair', label: 'Fix' }] });
  center.show();
  document.querySelector('.lnt-action').click();
  await new Promise(r => setTimeout(r, 0));
  expect(action).toHaveBeenCalledWith('repair', expect.objectContaining({ id: 'firewall' }));
  center.destroy();
});

test('unchanged cards retain identity, expanded details and animation state after new arrivals', () => {
  const { animateFn, animations } = motionHarness();
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  center.add({ id: 'old', title: 'Existing', details: 'Diagnostic stack' });
  center.show();
  const old = document.querySelector('[data-notification-id="old"]');
  const details = old.querySelector('details');
  details.open = true;
  const originalMotion = animations.filter(item => item.node === old).length;
  center.add({ id: 'new', title: 'New update', severity: 'success' });
  expect(document.querySelector('[data-notification-id="old"]')).toBe(old);
  expect(details.open).toBe(true);
  expect(animations.filter(item => item.node === old)).toHaveLength(originalMotion);
  expect(animations.some(item => item.node.dataset?.notificationId === 'new')).toBe(true);
  center.destroy();
});

test('rapid open/close/open cancels stale animation and keeps panel available', () => {
  const { animateFn, animations } = motionHarness();
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  center.add({ id: 'one', title: 'Single message' });
  const toggle = center.root.querySelector('#liturgia-notification-button');
  const panel = center.root.querySelector('#liturgia-notification-panel');
  toggle.click();
  toggle.click();
  toggle.click();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(panel.hidden).toBe(false);
  expect(panel.getAttribute('aria-hidden')).toBe('false');
  expect(animations.filter(a => a.node === panel).slice(0, 2).every(a => a.reverted)).toBe(true);
  // A previously cancelled leave callback must never hide a re-opened panel.
  animations.filter(a => a.node === panel)[1].complete();
  expect(panel.hidden).toBe(false);
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const close = animations.filter(a => a.node === panel).at(-1);
  close.complete();
  expect(panel.hidden).toBe(true);
  center.destroy();
});

test('dismissal persists immediately while exit completes, and leaves other cards intact', () => {
  const { animateFn, animations } = motionHarness();
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  center.add({ id: 'a', title: 'First' });
  center.add({ id: 'b', title: 'Second' });
  center.show();
  const first = center.root.querySelector('[data-notification-id="a"]');
  const second = center.root.querySelector('[data-notification-id="b"]');
  center.dismiss('a');
  expect(center.getMessages().find(m => m.id === 'a').dismissed).toBe(true);
  expect(JSON.parse(localStorage.getItem(STORE_KEY)).find(m => m.id === 'a').dismissed).toBe(true);
  expect(center.root.contains(first)).toBe(true);
  const exit = animations.filter(a => a.node === first).at(-1);
  exit.complete();
  expect(center.root.contains(first)).toBe(false);
  expect(center.root.querySelector('[data-notification-id="b"]')).toBe(second);
  center.destroy();
});

test('reduced motion settles synchronously and responds to preference changes', () => {
  const { query, animateFn } = motionHarness(true);
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  center.add({ id: 'one', title: 'Message' });
  center.show();
  const panel = center.root.querySelector('#liturgia-notification-panel');
  expect(panel.hidden).toBe(false);
  center.root.querySelector('.lnt-close').click();
  expect(panel.hidden).toBe(true);
  expect(animateFn).not.toHaveBeenCalled();
  query.change(false);
  center.show();
  expect(animateFn).toHaveBeenCalled();
  query.change(true);
  expect(panel.hidden).toBe(false);
  center.destroy();
});

test('the pill rings its bell and the center opens with a spring', () => {
  const { animateFn, animations } = motionHarness();
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  center.add({ id: 'incoming', title: 'New message', severity: 'warning' });
  expect(animations.some(a => a.node.classList?.contains('lnt-pill-icon') &&
    a.options.rotate[1] > 0)).toBe(true);
  expect(center.root.querySelector('.lnt-pill-shine')).not.toBeNull();
  const launcher = center.root.querySelector('#liturgia-notification-button');
  launcher.click();
  const panel = center.root.querySelector('#liturgia-notification-panel');
  const opening = animations.find(a => a.node === panel);
  expect(opening.options.scale).toEqual([.78, 1]);
  expect(opening.options.rotate).toEqual([-2.6, 0]);
  expect(center.root.querySelector('.lnt-entry-signal')).toBeNull();
  expect(animations.some(a => a.node.classList?.contains('lnt-entry-icon'))).toBe(true);
  center.destroy();
});

test('popover height animates when a card is removed and is clipped around the scrollbar', () => {
  const { animateFn, animations } = motionHarness();
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  center.add({ id:'first', title:'First' });
  center.add({ id:'second', title:'Second' });
  const content = center.root.querySelector('.lnt-panel-content');
  const viewport = center.root.querySelector('.lnt-panel-scroll');
  const panel = center.root.querySelector('#liturgia-notification-panel');
  let contentHeight = 450;
  Object.defineProperty(content, 'scrollHeight', { get: () => contentHeight });
  viewport.getBoundingClientRect = () => ({ height: parseFloat(viewport.style.height) || 0 });
  center.show();
  expect(viewport.style.height).toBe('450px');
  center.dismiss('first');
  contentHeight = 260;
  animations.filter(a => a.node.dataset?.notificationId === 'first').at(-1).complete();
  const heightChange = animations.filter(a => a.node === viewport).at(-1);
  expect(heightChange.options.height).toEqual([450, 260]);
  heightChange.complete();
  expect(viewport.style.height).toBe('260px');
  expect(viewport.parentElement).toBe(panel);
  center.destroy();
});

test('details expansion resizes the entire popover through its clipped viewport', () => {
  const { animateFn, animations } = motionHarness();
  let notifyResize;
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(element) {
      if (element.classList?.contains('lnt-panel-content')) notifyResize = this.callback;
    }
    disconnect() {}
  };
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  center.add({ id: 'one', title: 'Message', details: 'Expanded diagnostic details' });
  const content = center.root.querySelector('.lnt-panel-content');
  const viewport = center.root.querySelector('.lnt-panel-scroll');
  let measuredHeight = 220;
  Object.defineProperty(content, 'scrollHeight', { get: () => measuredHeight });
  viewport.getBoundingClientRect = () => ({ height: parseFloat(viewport.style.height) || 0 });
  center.show();
  expect(viewport.style.height).toBe('220px');
  measuredHeight = 375;
  notifyResize();
  const animated = animations.filter(a => a.node === viewport).at(-1);
  expect(animated.options.height).toEqual([220, 375]);
  animated.complete();
  expect(viewport.style.height).toBe('375px');
  center.destroy();
});

test('many messages do not restart existing cards, with mixed severity and new revisions', () => {
  const { animateFn, animations } = motionHarness();
  const center = createOperatorNotifications({ doc: document, storage: localStorage, animateFn });
  for (let i = 0; i < 30; i++) center.add({
    id: 'message-' + i, title: 'Message ' + i,
    severity: ['error', 'warning', 'success', 'info'][i % 4],
    details: 'Details ' + i
  });
  center.show();
  expect(center.root.querySelectorAll('.liturgia-notification-entry')).toHaveLength(30);
  const old = center.root.querySelector('[data-notification-id="message-0"]');
  const before = animations.length;
  center.add({ id: 'message-29', title: 'Message 29', revision: 'new' });
  expect(center.root.querySelector('[data-notification-id="message-0"]')).toBe(old);
  // Only the refreshed card and its icon animate, never the entire list.
  expect(animations.length - before).toBeLessThanOrEqual(3);
  expect(center.getMessages().find(x => x.id === 'message-29').read).toBe(false);
  center.destroy();
});
