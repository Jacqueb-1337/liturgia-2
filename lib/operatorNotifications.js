'use strict';

// A first-party, operator-only notification surface. Messages never interrupt
// presentation, manipulate focus, or navigate the live display.
const STORE_KEY = 'liturgia.operatorNotifications.v1';
const SEVERITIES = Object.freeze({
  error: { label: 'Error', color: '#db4545', symbol: '!' },
  warning: { label: 'Warning', color: '#e7a52a', symbol: '!' },
  success: { label: 'Success', color: '#278c5b', symbol: '\u2713' },
  info: { label: 'Information', color: '#2686cf', symbol: 'i' }
});
const clamp = value => String(value == null ? '' : value).slice(0, 9000);

function createOperatorNotifications({ doc, storage, onAction = () => {} }) {
  if (!doc?.body) throw Error('Notification center needs a document body');
  let entries = [];
  try { const saved = JSON.parse(storage?.getItem(STORE_KEY) || '[]'); if (Array.isArray(saved)) entries = saved.slice(-100); } catch (_) {}
  const persist = () => { try { storage?.setItem(STORE_KEY, JSON.stringify(entries.slice(-100))); } catch (_) {} };
  const bar = doc.createElement('div');
  bar.id = 'liturgia-notification-center';
  bar.innerHTML = `
    <button id="liturgia-notification-button" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Open notifications"></button>
    <section id="liturgia-notification-panel" role="dialog" aria-label="Notifications" hidden>
      <header><strong>Notifications</strong><button type="button" class="lnt-close" aria-label="Close notifications">×</button></header>
      <div id="liturgia-notification-list"></div>
    </section>`;
  doc.body.appendChild(bar);
  const button = bar.querySelector('#liturgia-notification-button');
  const panel = bar.querySelector('#liturgia-notification-panel');
  const list = bar.querySelector('#liturgia-notification-list');
  let open = false;

  function render() {
    const visible = entries.filter(e => !e.dismissed).sort((a,b) => b.createdAt - a.createdAt);
    const unread = visible.filter(e => !e.read).length;
    const serious = visible.some(e => !e.read && e.severity === 'error');
    const warning = visible.some(e => !e.read && e.severity === 'warning');
    const label = unread === 1 && visible.find(e => !e.read)?.origin === 'liturgia'
      ? 'A message from Liturgia' : unread ? `Notifications · ${unread}` : 'Notifications';
    button.textContent = (serious || warning ? '⚠ ' : '✉ ') + label;
    button.classList.toggle('has-unread', unread > 0);
    button.hidden = visible.length === 0;
    if (open) {
      panel.hidden = false;
      panel.classList.remove('is-closing');
    } else if (!panel.hidden && !panel.classList.contains('is-closing')) {
      panel.classList.add('is-closing');
      setTimeout(() => {
        if (!open) { panel.hidden = true; panel.classList.remove('is-closing'); }
      }, 180);
    }
    button.setAttribute('aria-expanded', String(open));
    list.replaceChildren();
    if (!visible.length) {
      const empty = doc.createElement('p'); empty.textContent = 'No messages.'; list.appendChild(empty); return;
    }
    for (const message of visible) {
      const style = SEVERITIES[message.severity] || SEVERITIES.info;
      const row = doc.createElement('article');
      row.className = 'liturgia-notification-entry';
      row.style.setProperty('--notice-accent', style.color);
      row.style.setProperty('--notice-index', String(visible.indexOf(message)));
      const heading = doc.createElement('div'); heading.className = 'lnt-heading';
      const title = doc.createElement('strong'); title.textContent = style.symbol + '  ' + message.title;
      const dismiss = doc.createElement('button'); dismiss.className = 'lnt-dismiss';
      dismiss.textContent = 'Dismiss'; dismiss.type = 'button';
      dismiss.onclick = () => dismissMessage(message.id);
      heading.append(title, dismiss);
      const body = doc.createElement('p'); body.textContent = message.body;
      row.append(heading, body);
      if (message.details) {
        const details = doc.createElement('details');
        const summary = doc.createElement('summary'); summary.textContent = 'Details';
        const pre = doc.createElement('pre'); pre.textContent = message.details;
        details.append(summary, pre); row.append(details);
      }
      if (message.actions?.length) {
        const actions = doc.createElement('div'); actions.className = 'lnt-actions';
        for (const action of message.actions) {
          const actionButton = doc.createElement('button'); actionButton.type = 'button';
          actionButton.textContent = action.label; actionButton.className = 'lnt-action';
          actionButton.onclick = async () => {
            actionButton.disabled = true;
            try { await onAction(action.id, message); } finally { actionButton.disabled = false; }
          };
          actions.append(actionButton);
        }
        row.append(actions);
      }
      list.append(row);
    }
  }
  function openPanel() {
    open = !open;
    if (open) { for (const e of entries) if (!e.dismissed) e.read = true; persist(); }
    render();
  }
  button.onclick = openPanel;
  bar.querySelector('.lnt-close').onclick = () => { open = false; render(); };
  function add(input) {
    if (!input?.id || !input.title) throw Error('A notification needs an id and title');
    const id = clamp(input.id).slice(0,160);
    const prior = entries.find(e => e.id === id);
    const changed = !prior || prior.revision !== (input.revision || '');
    const next = {
      id, revision: clamp(input.revision || ''), title: clamp(input.title).slice(0,180),
      body: clamp(input.body), details: clamp(input.details),
      severity: SEVERITIES[input.severity] ? input.severity : 'info',
      origin: input.origin === 'liturgia' ? 'liturgia' : 'local',
      actions: (input.actions || []).filter(a => a?.id && a?.label).slice(0,4).map(a => ({id:clamp(a.id),label:clamp(a.label).slice(0,60)})),
      createdAt: changed ? Date.now() : prior.createdAt,
      read: changed ? false : prior.read, dismissed: changed ? false : prior.dismissed
    };
    entries = [...entries.filter(e => e.id !== id),next].slice(-100);
    persist(); render(); return next;
  }
  function dismissMessage(id) { const item=entries.find(e=>e.id===id); if(item){item.dismissed=true;item.read=true;persist();render();} }
  function resolve(id) { entries=entries.filter(e=>e.id!==id); persist();render(); }
  render();
  return {add,dismiss:dismissMessage,resolve,show:()=>{open=true;for(const e of entries)e.read=true;persist();render();},getMessages:()=>entries.map(e=>({...e})),root:bar};
}

module.exports = {createOperatorNotifications,SEVERITIES,STORE_KEY};
