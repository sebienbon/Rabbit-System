import { db } from './db.js';
import { enqueue } from './sync.js';
import { money, parseMoney } from './shift.js';

// Two small screens opened from Sell, shown only when the server says it supports them
// (pull `features`): the commissions of the period, and the Tour / Transport editor.
// What is still waiting to be sent is shown as already done (with a "Waiting" badge).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = iso => { if (!iso) return ''; const x = new Date(new Date(iso).getTime() + 8 * 3600000); return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
const plain = n => String(n || '').replace(/^-/, '');
const lc = s => String(s || '').trim().toLowerCase();
const CATS = ['Tour', 'Transport'];

export const hasFeature = (features, f) => Array.isArray(features) && features.includes(f);

/** Operations of these kinds not yet in the last copy from the sheet (waiting, or sent but not pulled). */
async function pendingOps(type) {
  const [outbox, applied] = await Promise.all([db.all('outbox'), db.all('applied')]);
  return [...applied.map(a => ({ ...a.op, sent: true })), ...outbox.sort((a, b) => a.seq - b.seq)].filter(o => o.type === type);
}

/** Activities (or the Sell catalog) as they will be once the waiting changes are in the sheet. */
export function applyActivityOps(list, ops, shape = 'activity') {
  let out = list.map(x => ({ ...x }));
  for (const o of ops) {
    const p = o.payload || {}, cat = p.category;
    const nm = v => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.startsWith('-') ? t : '-' + t; };
    const price = parseMoney(String(p.price ?? '')) ?? 0, cost = p.cost === '' || p.cost == null ? null : parseMoney(String(p.cost));
    const at = out.findIndex(x => x.category === cat && x.name === p.name);
    if (p.do === 'add' && !out.some(x => x.category === cat && x.name === nm(p.name))) {
      out.push(shape === 'activity' ? { category: cat, name: nm(p.name), price, cost, inA: true, pending: !o.sent } : { category: cat, name: nm(p.name), price, cost: cost || 0 });
    } else if (p.do === 'update' && at >= 0) {
      const newName = p.newName ? (p.name.startsWith('-') ? nm(p.newName) : String(p.newName).trim()) : p.name;
      out[at] = { ...out[at], name: newName, price, cost: shape === 'activity' ? cost : cost || 0, inA: true, costText: '', ...(shape === 'activity' ? { pending: !o.sent } : {}) };
    } else if (p.do === 'delete' && at >= 0) out.splice(at, 1);
  }
  return out;
}
export async function catalogWithPending(catalog) {
  const ops = await pendingOps('activity');
  return ops.length ? applyActivityOps(catalog || [], ops, 'catalog') : catalog || [];
}

// ---------------------------------------------------------------- commissions
const COMM_RULES = [
  'Each line pays <b>20% of its margin</b> (price − cost) to its seller, like the <b>Commis.</b> tab.',
  'This period: the lines not marked <b>Past</b> in Entries.',
  'Not counted: the <b>commission exceptions</b> of Data activities and the partner payment lines.',
  '<b>Give to…</b> moves a tour or transport to the colleague who really sold it (not refunded, not the Sunset Boat). The sheet emails the change.',
  'Staff give away their own lines; a manager can move any line.'
];

export async function renderCommissions(root, d, helpTip) {
  const { ui } = d;
  const data = await db.get('commissions');
  const ops = await pendingOps('seller_change');
  const me = lc(d.user.author || d.user.username);
  const manager = d.user.role !== 'staff';
  const staff = (data && data.staff) || [];
  const nameOf = e => (staff.find(s => lc(s.email) === lc(e)) || {}).name || e;
  let lines = ((data && data.lines) || []).map(l => ({ ...l }));
  for (const o of ops) { const l = lines.find(x => x.ts === o.payload.ts); if (l) { l.seller = o.payload.to; l.waiting = !o.sent; } }
  if (!manager) lines = lines.filter(l => lc(l.seller) === me); // a line given away leaves my list at once
  const people = [...new Set(lines.map(l => lc(l.seller)))];
  const sel = manager ? (ui.commWho && people.includes(ui.commWho) ? ui.commWho : '') : me;
  const shown = lines.filter(l => !sel || lc(l.seller) === sel).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const total = shown.reduce((s, l) => s + (l.amount || 0), 0);
  const sum = e => lines.filter(l => lc(l.seller) === e).reduce((s, l) => s + (l.amount || 0), 0);
  const move = ui.commMove;
  const canGive = l => l.canMove && !l.waiting && (manager || lc(l.seller) === me);
  const targets = l => staff.filter(s => lc(s.email) !== lc(l.seller));

  root.innerHTML = `<section class="card extra">
    <div class="extrahead"><button type="button" class="link back" data-sellback>Back to Sell</button><span class="grow"></span>How it works ${helpTip('Commissions', COMM_RULES)}</div>
    <h2>Commissions</h2>
    <p class="muted">${manager ? 'Everybody' : esc(d.user.name || d.user.username)} · this period · ${Math.round(((data && data.rate) || 0.2) * 100)}% of the margin</p>
    ${!data ? '<p class="muted">The commissions arrive with the next connection to the sheet.</p>' : `
    ${manager && people.length ? `<div class="pays commwho" role="group" aria-label="Seller">
      <button type="button" class="pay${!sel ? ' on' : ''}" data-commwho="">All<b class="num">${money(lines.reduce((s, l) => s + (l.amount || 0), 0))}</b></button>
      ${people.map(e => `<button type="button" class="pay${sel === e ? ' on' : ''}" data-commwho="${esc(e)}">${esc(nameOf(e))}<b class="num">${money(sum(e))}</b></button>`).join('')}</div>` : ''}
    <div class="figure commtotal"><span>${shown.length} line${shown.length === 1 ? '' : 's'}${sel ? ' · ' + esc(nameOf(sel)) : ''}</span><b class="num">Rp ${money(total)}</b></div>
    ${shown.length ? `<ul class="clines">${shown.map(l => `<li${l.waiting ? ' class="waiting"' : ''}>
        <span class="when">${esc(shortDate(l.date))}</span>
        <span class="what"><b>${esc(plain(l.object))}</b><span class="who">${esc(l.guest)} · ${money(l.price)} − ${money(l.cost)}${manager && !sel ? ' · ' + esc(nameOf(l.seller)) : ''}${l.waiting ? ' · <span class="badge wait">Waiting</span>' : ''}</span></span>
        <span class="amt num">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</span>
        <span class="act">${canGive(l) && targets(l).length ? `<button type="button" class="ghost small" data-give="${esc(l.ts)}" aria-expanded="${move === l.ts}">Give to…</button>` : ''}</span>
        ${move === l.ts ? `<div class="inline give">
          <label class="grow"><span>New seller of ${esc(plain(l.object))} (${esc(l.guest)})</span>
            <select data-giveto>${targets(l).map(s => `<option value="${esc(s.email)}">${esc(s.name)} — ${esc(s.email)}</option>`).join('')}</select></label>
          <div class="row"><button type="button" class="primary small" data-giveok="${esc(l.ts)}">Change seller</button><button type="button" class="ghost small" data-givecancel>Cancel</button></div>
          <p class="error" role="alert"></p></div>` : ''}
      </li>`).join('')}</ul>` : '<p class="muted">No commission line in this period.</p>'}`}
  </section>`;

  root.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sellback !== undefined) { ui.sellView = null; ui.commMove = null; d.render(); return; }
    if (b.dataset.commwho !== undefined) { ui.commWho = b.dataset.commwho; ui.commMove = null; d.render(); return; }
    if (b.dataset.give) { ui.commMove = ui.commMove === b.dataset.give ? null : b.dataset.give; d.render(); return; }
    if (b.dataset.givecancel !== undefined) { ui.commMove = null; d.render(); return; }
    if (b.dataset.giveok) {
      const l = lines.find(x => x.ts === b.dataset.giveok);
      const to = root.querySelector('[data-giveto]').value;
      if (!l || !to) return;
      b.disabled = true;
      await enqueue('seller_change', { ts: l.ts, from: l.seller, to });
      ui.commMove = null;
      ui.notice = `${plain(l.object)} (${l.guest}) now goes to ${nameOf(to)}.`;
      d.render();
    }
  });
}

// ---------------------------------------------------------------- activities editor
const ACT_RULES = [
  'The tours and transports sold in <b>Sell</b>, from the sheet (Data activities).',
  'A change is written in both places the old dialogs read: column <b>A</b> (name, price, cost) and the <b>Tour</b> or <b>Transport</b> list.',
  'Every change is kept in UI_Log with the old and new values.',
  'Partner products start with “-” in the sheet: it is added for you.'
];

export async function renderActivities(root, d, helpTip) {
  const { ui } = d;
  const acts = applyActivityOps((await db.get('activities')) || [], await pendingOps('activity'));
  const ed = ui.actEdit; // { category, name (null: new), confirmDelete }
  const form = (a, cat) => `<form class="inline actform" data-actform>
      <label class="grow"><span>Name</span><input name="name" maxlength="100" autocomplete="off" value="${esc(a ? plain(a.name) : '')}" placeholder="${cat === 'Tour' ? 'e.g. Waterfall trip' : 'e.g. Taxi Bangsal / Kuta'}"></label>
      <label><span>Price</span><span class="moneyin"><span class="cur">Rp</span><input name="price" inputmode="numeric" value="${a && a.price != null ? money(a.price) : ''}"></span></label>
      <label><span>Cost <em>partner</em></span><span class="moneyin"><span class="cur">Rp</span><input name="cost" inputmode="numeric" value="${a && a.cost != null ? money(a.cost) : ''}" placeholder="${a && a.costText ? esc(a.costText) : ''}"></span></label>
      <div class="row"><button type="submit" class="primary small">${a ? 'Save' : 'Add ' + cat.toLowerCase()}</button><button type="button" class="ghost small" data-actcancel>Cancel</button>
        ${a ? '<button type="button" class="link danger-link" data-actdel>Delete…</button>' : ''}</div>
      ${a && ed.confirmDelete ? `<div class="inline warn"><span>Delete ${esc(plain(a.name))}? It disappears from Sell (lines already sold stay).</span>
        <button type="button" class="danger small" data-actdelok>Delete</button><button type="button" class="ghost small" data-actdelno>Keep</button></div>` : ''}
      <p class="error" role="alert"></p></form>`;
  const row = a => {
    const open = ed && ed.category === a.category && ed.name === a.name;
    const margin = a.price != null && a.cost != null ? a.price - a.cost : null;
    return `<li class="${open ? 'open' : ''}">
      <span class="what"><b>${esc(plain(a.name))}</b>${a.pending ? ' <span class="badge wait">Waiting</span>' : ''}${!a.inA ? ' <span class="badge unpaid">No price row</span>' : ''}</span>
      <span class="num">${a.price != null ? money(a.price) : '—'}</span>
      <span class="num soft">${a.cost != null ? money(a.cost) : esc(a.costText || '—')}</span>
      <span class="num soft">${margin != null ? money(margin) : ''}</span>
      <span class="act">${open ? '' : `<button type="button" class="ghost small" data-actedit="${esc(a.category)}|${esc(a.name)}">Edit</button>`}</span>
      ${open ? form(a, a.category) : ''}</li>`;
  };
  root.innerHTML = `<section class="card extra">
    <div class="extrahead"><button type="button" class="link back" data-sellback>Back to Sell</button><span class="grow"></span>How it works ${helpTip('Tours and transport', ACT_RULES)}</div>
    <h2>Tours &amp; transport</h2>
    ${CATS.map(cat => {
      const list = acts.filter(a => a.category === cat);
      return `<h3 class="cat">${cat}</h3>
      <ul class="alist"><li class="ahead"><span>Name</span><span>Price</span><span>Cost</span><span>Margin</span><span></span></li>${list.map(row).join('')}</ul>
      ${ed && ed.category === cat && ed.name === null ? form(null, cat) : `<button type="button" class="ghost small addact" data-actadd="${cat}">+ Add ${cat.toLowerCase()}</button>`}`;
    }).join('')}
  </section>`;
  root.querySelector('[data-actform] input[name=name]')?.focus();

  const cur = () => ed && ed.name ? acts.find(a => a.category === ed.category && a.name === ed.name) : null;
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.name === 'price' || t.name === 'cost') { const v = parseMoney(t.value); t.value = v === null ? '' : money(v); }
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.sellback !== undefined) { ui.sellView = null; ui.actEdit = null; d.render(); return; }
    if (b.dataset.actedit) { const [category, ...n] = b.dataset.actedit.split('|'); ui.actEdit = { category, name: n.join('|') }; d.render(); return; }
    if (b.dataset.actadd) { ui.actEdit = { category: b.dataset.actadd, name: null }; d.render(); return; }
    if (b.dataset.actcancel !== undefined || b.dataset.actdelno !== undefined) { ui.actEdit = b.dataset.actdelno !== undefined ? { ...ed, confirmDelete: false } : null; d.render(); return; }
    if (b.dataset.actdel !== undefined) { ui.actEdit = { ...ed, confirmDelete: true }; d.render(); return; }
    if (b.dataset.actdelok !== undefined) {
      const a = cur(); if (!a) return;
      b.disabled = true;
      await enqueue('activity', { do: 'delete', category: a.category, name: a.name });
      ui.actEdit = null; ui.notice = `${plain(a.name)} deleted from ${a.category}.`;
      d.render();
    }
  });
  root.querySelector('[data-actform]')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = f.querySelector('.error');
    const name = f.elements.name.value.replace(/\s+/g, ' ').trim().replace(/^-+\s*/, '');
    const price = parseMoney(f.elements.price.value), cost = f.elements.cost.value.trim() === '' ? '' : parseMoney(f.elements.cost.value);
    if (name.length < 2) { err.textContent = 'Type the name.'; f.elements.name.focus(); return; }
    if (/^[=+@]/.test(name)) { err.textContent = 'A name cannot start with = + or @.'; return; }
    if (price === null) { err.textContent = 'Type the selling price.'; f.elements.price.focus(); return; }
    if (cost === null) { err.textContent = 'The cost is a number (or leave it empty).'; return; }
    const a = cur(), full = (a && !a.name.startsWith('-')) ? name : '-' + name;
    const clash = acts.find(x => x !== a && lc(x.name) === lc(full));
    if (clash) { err.textContent = `${plain(clash.name)} is already in ${clash.category}.`; return; }
    f.querySelector('button[type=submit]').disabled = true;
    if (a) {
      if (a.name === full && a.price === price && (a.cost ?? '') === cost) { ui.actEdit = null; d.render(); return; }
      await enqueue('activity', { do: 'update', category: a.category, name: a.name, newName: a.name === full ? '' : name, price, cost, before: { price: a.price, cost: a.cost } });
      ui.notice = `${name} saved: Rp ${money(price)}${cost !== '' ? `, cost Rp ${money(cost)}` : ''}.`;
    } else {
      await enqueue('activity', { do: 'add', category: ed.category, name, price, cost });
      ui.notice = `${name} added to ${ed.category}.`;
    }
    ui.actEdit = null;
    d.render();
  });
}
