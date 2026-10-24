'use strict';

// All movement is confined to the operator window. No live display or global
// shortcut state is touched by this notification center.
const { animate, spring } = require('animejs');
const STORE_KEY = 'liturgia.operatorNotifications.v1';
const SEVERITIES = Object.freeze({
  error: { label: 'Error', color: '#db4545', symbol: '!' },
  warning: { label: 'Warning', color: '#e7a52a', symbol: '!' },
  success: { label: 'Success', color: '#278c5b', symbol: '\u2713' },
  info: { label: 'Information', color: '#2686cf', symbol: 'i' }
});
const clamp = value => String(value == null ? '' : value).slice(0, 9000);

function createOperatorNotifications({ doc, storage, onAction = () => {}, animateFn = animate }) {
  if (!doc?.body) throw Error('Notification center needs a document body');
  let entries = [];
  try {
    const saved = JSON.parse(storage?.getItem(STORE_KEY) || '[]');
    if (Array.isArray(saved)) entries = saved.slice(-100);
  } catch (_) {}
  const persist = () => {
    try { storage?.setItem(STORE_KEY, JSON.stringify(entries.slice(-100))); } catch (_) {}
  };

  const bar = doc.createElement('div');
  bar.id = 'liturgia-notification-center';
  bar.innerHTML = [
    '<button id="liturgia-notification-button" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Open notifications">',
    '  <span class="lnt-pill-icon" aria-hidden="true"><span class="lnt-icon-halo"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></span>',
    '  <span class="lnt-pill-label">Notifications</span><span class="lnt-pill-count" hidden></span>',
    '</button>',
    '<section id="liturgia-notification-panel" role="dialog" aria-label="Notifications" aria-hidden="true" hidden>',
    '  <span class="lnt-panel-sheen" aria-hidden="true"></span>',
    '  <header><div class="lnt-header-text"><span class="lnt-eyebrow">LITURGIA</span><strong>Notification center</strong><span class="lnt-header-subtitle">Messages &amp; activity</span></div>',
    '  <button type="button" class="lnt-close" aria-label="Close notifications">×</button></header>',
    '  <div id="liturgia-notification-list"></div>',
    '  <div class="lnt-panel-footer"><span class="lnt-footer-dot"></span><span class="lnt-footer-label">All caught up</span></div>',
    '</section>'
  ].join('');
  doc.body.appendChild(bar);
  const button = bar.querySelector('#liturgia-notification-button');
  const panel = bar.querySelector('#liturgia-notification-panel');
  const list = bar.querySelector('#liturgia-notification-list');
  const closeButton = panel.querySelector('.lnt-close');
  const pillIcon = button.querySelector('.lnt-pill-icon');
  const halo = button.querySelector('.lnt-icon-halo');
  const pillLabel = button.querySelector('.lnt-pill-label');
  const pillCount = button.querySelector('.lnt-pill-count');
  const header = panel.querySelector('header');
  const headerTitle = panel.querySelector('.lnt-header-text');
  const sheen = panel.querySelector('.lnt-panel-sheen');
  const footerDot = panel.querySelector('.lnt-footer-dot');
  const footerLabel = panel.querySelector('.lnt-footer-label');
  const view = doc.defaultView;
  const motionQuery = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const canAnimate = () => !!motionQuery && !motionQuery.matches && !!view && !!animateFn;
  const activeAnimations = new Map();
  const rows = new Map();
  const leaving = new Set();
  let open = false;
  let panelWasOpen = false;
  let destroyed = false;

  function clearMotionStyles(node) {
    for (const property of ['opacity', 'transform', 'translate', 'scale']) node.style.removeProperty(property);
  }
  function stopMotion(node) {
    const active = activeAnimations.get(node);
    if (active) {
      activeAnimations.delete(node);
      try { active.revert(); } catch (_) { try { active.cancel(); } catch (_) {} }
    }
    clearMotionStyles(node);
  }
  function play(node, properties, complete) {
    stopMotion(node);
    if (!canAnimate()) { complete?.(); return; }
    try {
      const animation = animateFn(node, {
        ...properties,
        onComplete: () => {
          if (activeAnimations.get(node) !== animation || destroyed) return;
          activeAnimations.delete(node);
          clearMotionStyles(node);
          complete?.();
        }
      });
      if (!animation) { clearMotionStyles(node); complete?.(); return; }
      activeAnimations.set(node, animation);
    } catch (_) {
      clearMotionStyles(node);
      complete?.();
    }
  }
  function settleAllMotion() {
    for (const node of [...activeAnimations.keys()]) stopMotion(node);
    for (const node of leaving) node.remove();
    leaving.clear();
    panel.hidden = !open;
    panel.classList.toggle('is-closing', false);
    panel.inert = !open;
    if (!open && !rows.size) button.hidden = true;
  }
  function handleMotionChange() {
    if (motionQuery?.matches) settleAllMotion();
  }
  motionQuery?.addEventListener?.('change', handleMotionChange);

  function buildRow(message) {
    const style = SEVERITIES[message.severity] || SEVERITIES.info;
    const row = doc.createElement('article');
    row.className = 'liturgia-notification-entry';
    row.dataset.notificationId = message.id;
    row.style.setProperty('--notice-accent', style.color);
    const signal = doc.createElement('span');
    signal.className = 'lnt-entry-signal';
    signal.setAttribute('aria-hidden', 'true');
    row.append(signal);
    const heading = doc.createElement('div');
    heading.className = 'lnt-heading';
    const identity = doc.createElement('div');
    identity.className = 'lnt-entry-identity';
    const icon = doc.createElement('span');
    icon.className = 'lnt-entry-icon';
    icon.textContent = style.symbol;
    icon.setAttribute('aria-hidden', 'true');
    const title = doc.createElement('strong');
    title.textContent = message.title;
    identity.append(icon, title);
    const dismiss = doc.createElement('button');
    dismiss.className = 'lnt-dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss ' + message.title);
    dismiss.onclick = () => dismissMessage(message.id);
    heading.append(identity, dismiss);
    const body = doc.createElement('p');
    body.textContent = message.body;
    row.append(heading, body);
    if (message.details) {
      const details = doc.createElement('details');
      const summary = doc.createElement('summary');
      summary.textContent = 'Details';
      const pre = doc.createElement('pre');
      pre.textContent = message.details;
      details.append(summary, pre);
      row.append(details);
    }
    if (message.actions?.length) {
      const actions = doc.createElement('div');
      actions.className = 'lnt-actions';
      for (const action of message.actions) {
        const actionButton = doc.createElement('button');
        actionButton.type = 'button';
        actionButton.textContent = action.label;
        actionButton.className = 'lnt-action';
        actionButton.onclick = async () => {
          actionButton.disabled = true;
          try { await onAction(action.id, message); }
          finally { actionButton.disabled = false; }
        };
        actions.append(actionButton);
      }
      row.append(actions);
    }
    return row;
  }
  function rowSignature(message) {
    return JSON.stringify([message.revision, message.title, message.body, message.details,
      message.severity, message.actions]);
  }
  // FLIP: surviving cards glide into their new positions with a short spring,
  // instead of jumping when another card arrives or gets dismissed.
  function positions() {
    const before = new Map();
    if (!open || panel.hidden || !canAnimate()) return before;
    for (const [id, record] of rows) {
      const rect = record.node.getBoundingClientRect();
      before.set(id, rect.top);
    }
    return before;
  }
  function reflow(before) {
    if (!before.size) return;
    for (const [id, record] of rows) {
      if (!before.has(id)) continue;
      const delta = before.get(id) - record.node.getBoundingClientRect().top;
      if (Math.abs(delta) < 3 || Math.abs(delta) > 1200) continue;
      play(record.node, {
        y: [delta, 0], duration: 430,
        ease: spring({ duration: 430, bounce: .12 })
      });
    }
  }
  function revealCard(record, index, initial = false) {
    const node = record.node;
    const delay = initial ? 100 + Math.min(index, 7) * 58 : Math.min(index, 5) * 25;
    play(node, {
      opacity: [0, 1], x: [initial ? 46 : 28, 0],
      y: [initial ? 20 : 12, 0], rotate: [initial ? 2.4 : 1.4, 0],
      scale: [initial ? .87 : .93, 1],
      duration: 520, delay,
      ease: spring({ duration: 520, bounce: .19 })
    });
    const signal = node.querySelector('.lnt-entry-signal');
    const icon = node.querySelector('.lnt-entry-icon');
    if (signal) play(signal, {
      scaleY: [.12, 1], opacity: [.2, 1], duration: 390,
      delay: delay + 105, ease: 'out(4)'
    });
    if (icon) play(icon, {
      scale: [.5, 1.18, 1], rotate: [-24, 12, 0],
      opacity: [0, 1], duration: 410, delay: delay + 125,
      ease: 'out(3)'
    });
  }
  function animateRemoval(node) {
    leaving.add(node);
    node.classList.add('is-leaving');
    play(node, {
      opacity: [1, 0], x: [0, 115], y: [0, -9], rotate: [0, 5],
      scale: [1, .77], duration: 315, ease: 'in(4)'
    }, () => {
      const before = positions();
      leaving.delete(node);
      node.remove();
      reflow(before);
    });
  }
  function syncPanel() {
    if (panelWasOpen === open) return;
    panelWasOpen = open;
    stopMotion(panel);
    stopMotion(headerTitle);
    stopMotion(sheen);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    if (open) {
      panel.hidden = false;
      panel.classList.remove('is-closing');
      // Unfold upward from the pill: a springy, bottom-right origin gives
      // the center a sense of physical continuity with its launcher.
      play(panel, {
        opacity: [0, 1], x: [16, 0], y: [35, 0],
        scale: [.78, 1], rotate: [-2.6, 0],
        duration: 550, ease: spring({ duration: 550, bounce: .16 })
      });
      play(headerTitle, {
        opacity: [0, 1], x: [24, 0], y: [12, 0],
        duration: 390, delay: 125,
        ease: spring({ duration: 390, bounce: .14 })
      });
      play(sheen, {
        opacity: [0, .58, 0], x: [-170, 480],
        duration: 770, delay: 70, ease: 'inOut(2)'
      });
      play(button, { scale: [1, .94, 1], duration: 310,
        ease: spring({ duration: 310, bounce: .12 }) });
      [...rows.values()].slice(0, 8).forEach((record, index) =>
        revealCard(record, index, true));
    } else {
      if (panel.contains(doc.activeElement) && !button.hidden) button.focus();
      panel.classList.add('is-closing');
      play(panel, {
        opacity: [1, 0], x: [0, 13], y: [0, 25],
        scale: [1, .86], rotate: [0, -1.6],
        duration: 250, ease: 'in(3)'
      }, () => {
        if (open || destroyed) return;
        panel.hidden = true;
        panel.classList.remove('is-closing');
        if (!rows.size) button.hidden = true;
      });
    }
  }

  function render() {
    if (destroyed) return;
    const before = positions();
    const visible = entries.filter(e => !e.dismissed).sort((a, b) => b.createdAt - a.createdAt);
    const ids = new Set(visible.map(e => e.id));
    const unread = visible.filter(e => !e.read).length;
    const serious = visible.some(e => !e.read && e.severity === 'error');
    const warning = visible.some(e => !e.read && e.severity === 'warning');
    const label = unread === 1 && visible.find(e => !e.read)?.origin === 'liturgia'
      ? 'A message from Liturgia' : unread ? 'Notifications · ' + unread : 'Notifications';
    pillLabel.textContent = label;
    pillCount.textContent = String(unread);
    pillCount.hidden = unread === 0;
    pillIcon.classList.toggle('is-urgent', serious || warning);
    button.classList.toggle('has-unread', unread > 0);
    button.hidden = !visible.length && !open && panel.hidden;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close notifications' : 'Open notifications');
    footerLabel.textContent = visible.length
      ? visible.length + (visible.length === 1 ? ' message' : ' messages') + ' in your center'
      : 'All caught up';
    footerDot.classList.toggle('is-urgent', serious || warning);

    for (const [id, record] of rows) {
      if (ids.has(id)) continue;
      rows.delete(id);
      if (open) animateRemoval(record.node);
      else { stopMotion(record.node); record.node.remove(); }
    }
    for (const [index, message] of visible.entries()) {
      const signature = rowSignature(message);
      let record = rows.get(message.id);
      if (record && record.signature !== signature) {
        rows.delete(message.id);
        stopMotion(record.node);
        record.node.remove();
        record = null;
      }
      if (!record) {
        record = { node: buildRow(message), signature };
        rows.set(message.id, record);
        list.append(record.node);
        if (open && panelWasOpen && !panel.hidden)
          revealCard(record, index);
      }
      // Moving an existing node preserves focus, Details state and action state.
      if (record.node !== list.children[index]) list.insertBefore(record.node, list.children[index] || null);
    }
    const empty = list.querySelector('.lnt-empty');
    if (!visible.length && !empty) {
      const p = doc.createElement('p');
      p.className = 'lnt-empty';
      p.textContent = 'No messages.';
      list.append(p);
    } else if (visible.length && empty) empty.remove();
    reflow(before);
    syncPanel();
  }

  function openPanel() {
    open = !open;
    if (open) {
      for (const e of entries) if (!e.dismissed) e.read = true;
      persist();
    }
    render();
  }
  function dismissMessage(id) {
    const item = entries.find(e => e.id === id);
    if (!item || item.dismissed) return;
    const active = rows.get(id)?.node;
    if (active?.contains(doc.activeElement)) {
      const fallback = [...rows.values()].find(r => r.node !== active)?.node.querySelector('.lnt-dismiss');
      (fallback || closeButton).focus();
    }
    item.dismissed = true;
    item.read = true;
    persist();
    render();
  }
  function resolve(id) {
    entries = entries.filter(e => e.id !== id);
    persist();
    render();
  }
  function add(input) {
    if (!input?.id || !input.title) throw Error('A notification needs an id and title');
    // New arrivals use a beacon ripple, icon flourish and a springy count.
    const id = clamp(input.id).slice(0, 160);
    const prior = entries.find(e => e.id === id);
    const changed = !prior || prior.revision !== (input.revision || '');
    const next = {
      id, revision: clamp(input.revision || ''), title: clamp(input.title).slice(0, 180),
      body: clamp(input.body), details: clamp(input.details),
      severity: SEVERITIES[input.severity] ? input.severity : 'info',
      origin: input.origin === 'liturgia' ? 'liturgia' : 'local',
      actions: (input.actions || []).filter(a => a?.id && a?.label).slice(0, 4)
        .map(a => ({ id: clamp(a.id), label: clamp(a.label).slice(0, 60) })),
      createdAt: changed ? Date.now() : prior.createdAt,
      read: changed ? false : prior.read,
      dismissed: changed ? false : prior.dismissed
    };
    const wasHidden = button.hidden;
    entries = [...entries.filter(e => e.id !== id), next].slice(-100);
    persist();
    render();
    if (!open && changed && !button.hidden && canAnimate()) {
      play(button, {
        opacity: wasHidden ? [0, 1] : [1, 1],
        y: wasHidden ? [20, 0] : [0, -7, 0],
        scale: wasHidden ? [.72, 1] : [1, 1.065, 1],
        rotate: wasHidden ? [-4, 0] : [0, -1.2, 0],
        duration: 500, ease: spring({ duration: 500, bounce: .22 })
      });
      play(pillIcon, { rotate: [-23, 19, -6, 0], scale: [.8, 1.22, .94, 1],
        duration: 480, delay: 60, ease: 'out(3)' });
      play(halo, { opacity: [.8, 0], scale: [.6, 3.1],
        duration: 690, ease: 'out(3)' });
      if (!pillCount.hidden)
        play(pillCount, { opacity: [0, 1], scale: [.35, 1.16, 1],
          duration: 380, delay: 125,
          ease: spring({ duration: 380, bounce: .2 }) });
    }
    return next;
  }
  function handleKeydown(event) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      open = false;
      render();
    }
  }
  panel.addEventListener('keydown', handleKeydown);
  button.onclick = openPanel;
  closeButton.onclick = () => { open = false; render(); };

  function destroy() {
    if (destroyed) return;
    settleAllMotion();
    destroyed = true;
    motionQuery?.removeEventListener?.('change', handleMotionChange);
    panel.removeEventListener('keydown', handleKeydown);
    view?.removeEventListener?.('pagehide', destroy);
    bar.remove();
  }
  view?.addEventListener?.('pagehide', destroy);
  render();
  return {
    add, dismiss: dismissMessage, resolve,
    show: () => { open = true; for (const e of entries) if (!e.dismissed) e.read = true; persist(); render(); },
    getMessages: () => entries.map(e => ({ ...e })), root: bar, destroy
  };
}

module.exports = { createOperatorNotifications, SEVERITIES, STORE_KEY };
