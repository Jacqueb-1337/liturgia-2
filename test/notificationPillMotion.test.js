const { createNotificationPillMotion, POSITION_KEY } = require('../lib/notificationPillMotion');

beforeEach(() => { document.body.innerHTML=''; localStorage.clear(); });
afterEach(() => { delete window.PointerEvent; jest.useRealTimers(); });

function harness() {
  jest.useFakeTimers();
  window.PointerEvent = class {};
  const bar=document.createElement('div');
  const button=document.createElement('button');
  const badge=document.createElement('span');
  const icon=document.createElement('span');
  const shine=document.createElement('span');
  const panel=document.createElement('section');
  button.append(icon,badge,shine);
  bar.append(button,panel);
  document.body.append(bar);
  Object.defineProperty(button,'offsetWidth',{get:()=>badge.hidden?120:142});
  button.getBoundingClientRect=()=>({left:500,right:500+(badge.hidden?120:142),width:badge.hidden?120:142});
  bar.getBoundingClientRect=()=>({left:500,right:500+button.offsetWidth,width:button.offsetWidth});
  const moves=[];
  const dragFn=jest.fn((_el,opts)=>{moves.push(opts);return jest.fn();});
  const plays=[];
  const play=jest.fn((node,options,complete)=>plays.push({node,options,complete}));
  const stopMotion=jest.fn();
  const obj=createNotificationPillMotion({
    view:window,storage:localStorage,bar,button,panel,pillIcon:icon,pillCount:badge,
    shine,canAnimate:()=>true,play,stopMotion,dragFn
  });
  return {bar,button,badge,shine,panel,icon,obj,plays,moves,dragFn};
}

test('Motion drag stays horizontal, constrained to the bottom, and is disabled when open', () => {
  const t=harness();
  expect(t.dragFn).toHaveBeenCalledTimes(1);
  expect(t.moves[0]).toMatchObject({axis:'x',momentum:true,elastic:.12});
  expect(t.moves[0].constraints.right).toBe(0);
  expect(t.moves[0].constraints.left).toBeLessThan(0);
  t.obj.setOpen(true);
  expect(t.bar.classList.contains('is-dragging')).toBe(false);
  t.obj.setOpen(false);
  expect(t.dragFn).toHaveBeenCalledTimes(2);
  t.obj.destroy();
});

test('first unread notification expands pill before the red dot pops in', () => {
  const t=harness();
  t.obj.syncUnread(0);
  expect(t.badge.hidden).toBe(true);
  t.obj.syncUnread(1);
  expect(t.badge.hidden).toBe(false);
  const width=t.plays.find(p=>p.node===t.button && p.options.width);
  const dot=t.plays.find(p=>p.node===t.badge && p.options.opacity);
  expect(width.options.width).toEqual([120,142]);
  expect(dot.options.delay).toBeGreaterThan(0);
  expect(t.button.getAttribute('aria-label')).toContain('1 unread notification');
  t.obj.destroy();
});

test('reading notifications shrinks and removes badge and stops periodic shine', () => {
  const t=harness();
  t.obj.syncUnread(0);
  t.obj.syncUnread(1);
  t.plays.filter(p=>p.node===t.badge).at(-1).complete();
  jest.advanceTimersByTime(8500);
  expect(t.plays.some(p=>p.node===t.shine)).toBe(true);
  t.obj.syncUnread(0);
  const exit=t.plays.filter(p=>p.node===t.badge).at(-1);
  expect(exit.options.opacity).toEqual([1,0]);
  exit.complete();
  expect(t.badge.hidden).toBe(true);
  jest.advanceTimersByTime(25000);
  expect(t.button.getAttribute('aria-label')).toBe('Open notifications');
  t.obj.destroy();
});

test('saved horizontal position is honored and panel follows launcher', () => {
  localStorage.setItem(POSITION_KEY,'0.25');
  const t=harness();
  expect(t.obj.getPositionFraction()).toBe(.25);
  t.obj.setOpen(true);
  expect(t.panel.style.left).not.toBe('');
  expect(t.panel.style.right).toBe('auto');
  t.obj.destroy();
});
