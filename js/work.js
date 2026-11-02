import { db } from './db.js';
import { enqueue } from './sync.js';
import { ledgerView, nextTs, shiftLines, totals, canChange, canRefund } from './ledger.js';
import { money, parseMoney } from './shift.js';

// The work area while a shift is open: Sell, Guest bills, This shift.
// Everything is written locally first (instant, works offline), then sent.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lineTime = ts => `${ts.slice(8, 10)}:${ts.slice(10, 12)}`;
const lineDay = ts => `${ts.slice(6, 8)}/${ts.slice(4, 6)}`;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const PAY_SHORT = { 'Credit / Debit Card': 'Card', 'Transfer/Others': 'Transfer' };
const payLabel = p => PAY_SHORT[p] || p;

// The ten buttons of the old Daily Expenses dialog, with the item it writes in column D.
// "Others" writes "other", the word listed in Data activities (the old dialog lost these).
export const EXPENSE_ITEMS = [
  { label: 'Restaurant', object: 'Restaurant', tone: 'food' }, { label: 'Bar', object: 'Bar', tone: 'food' },
  { label: 'Water Refill', object: 'Water Refill', tone: 'food' },
  { label: 'Maintenance', object: 'Maintenance', tone: 'house' }, { label: 'Cleaning', object: 'Cleaning', tone: 'house' },
  { label: "Guest's Amenities", object: "Guest's services", tone: 'house' },
  { label: 'Bike Maintenance', object: 'Rabbit bike', tone: 'serv' }, { label: 'Utilities', object: 'Utilities', tone: 'serv' },
  { label: 'Laundry', object: 'Laundry', tone: 'serv' },
  { label: 'Others', object: 'other', tone: 'other' },
];
const expenseLabel = obj => (EXPENSE_ITEMS.find(x => x.object === obj) || {}).label || obj;

export function newCart() { return { guests: [], items: [], payment: null, comment: '' }; }
export const cartBusy = ui => !!(ui.cart && (ui.cart.items.length || ui.cart.guests.length));

/** Shared data for one render. */
async function load(ctx) {
  const [lines, catalog, payments, guestList] = await Promise.all([
    ledgerView(), db.get('catalog'), db.get('payments'), db.get('guests')]);
  const names = new Map();
  for (const g of guestList || []) names.set(norm(g), g);
  for (const l of lines) if (l.guest && l.type === 'Income' && !names.has(norm(l.guest))) names.set(norm(l.guest), l.guest);
  const unpaid = new Map();
  for (const l of lines) if (l.type === 'Income' && l.payment === 'Unpaid') {
    const u = unpaid.get(l.guest) || { guest: l.guest, total: 0, count: 0, oldest: l.ts };
    u.total += l.total || 0; u.count++; if (l.ts < u.oldest) u.oldest = l.ts;
    unpaid.set(l.guest, u);
  }
  return { lines, catalog: catalog || [], payments: payments || ['Cash', 'Unpaid'], guests: [...names.values()], unpaid, ...ctx };
}

// ---------------------------------------------------------------- tabs
export async function workTabs(ctx) {
  const d = await load(ctx);
  const mine = shiftLines(d.lines, ctx.shift);
  const t = totals(mine);
  return { counts: { bills: d.unpaid.size, shift: mine.length, expenses: mine.filter(l => l.type === 'Expense' && l.comment !== 'Refunding').length }, totals: t };
}

export async function renderWork(root, ctx) {
  const d = await load(ctx);
  const tab = ctx.ui.tab || 'sell';
  if (tab === 'sell') renderSell(root, d);
  else if (tab === 'bills') renderBills(root, d);
  else if (tab === 'shift') renderShiftLines(root, d);
  else if (tab === 'expenses') renderExpenses(root, d);
}

// ---------------------------------------------------------------- sell
function renderSell(root, d) {
  const { ui } = d;
  ui.cart = ui.cart || newCart();
  const cats = [];
  for (const p of d.catalog) {
    let c = cats.find(x => x.name === p.category);
    if (!c) cats.push(c = { name: p.category, items: [] });
    c.items.push(p);
  }
  root.innerHTML = `<div class="sell">
    <section class="card pick">
      <div class="field">
        <label for="guestIn">Guest</label>
        <div class="guestbox" id="guestBox"></div>
        <ul class="suggest" id="guestSug" role="listbox" hidden></ul>
      </div>
      <div class="field">
        <label for="prodIn">Products</label>
        <input id="prodIn" type="search" placeholder="Search products" autocomplete="off" value="${esc(ui.prodQuery || '')}">
      </div>
      <div id="prods"></div>
    </section>
    <aside class="card cart" id="cart" aria-label="Current sale"></aside>
  </div>`;

  const cart = ui.cart;
  const prodsEl = root.querySelector('#prods'), cartEl = root.querySelector('#cart'), boxEl = root.querySelector('#guestBox');
  const sugEl = root.querySelector('#guestSug');

  const renderProds = () => {
    const q = norm(ui.prodQuery);
    const html = cats.map(c => {
      const items = c.items.filter(p => !q || norm(p.name).includes(q));
      if (!items.length) return '';
      return `<h3 class="cat">${esc(c.name)}</h3><div class="prods">${items.map(p => {
        const i = d.catalog.indexOf(p);
        const n = cart.items.filter(x => x.name === p.name && x.category === p.category).reduce((s, x) => s + x.qty, 0);
        return `<button type="button" class="prod${n ? ' in' : ''}" data-add="${i}">
          <span class="pname">${esc(p.name.replace(/^-/, ''))}</span>
          <span class="pprice num">${p.price ? money(p.price) : 'Set price'}</span>${n ? `<span class="pcount" aria-label="${n} in sale">${n}</span>` : ''}</button>`;
      }).join('')}</div>`;
    }).join('');
    prodsEl.innerHTML = html || `<p class="muted">${d.catalog.length ? 'No product matches.' : 'The product list arrives with the first connection to the sheet.'}</p>`;
  };

  const renderGuests = () => {
    boxEl.innerHTML = cart.guests.map((g, i) => `<span class="chip">${esc(g)}<button type="button" data-grm="${i}" aria-label="Remove ${esc(g)}">×</button></span>`).join('') +
      `<input id="guestIn" autocomplete="off" placeholder="${cart.guests.length ? 'Add another guest' : 'Type a name'}" aria-controls="guestSug">`;
    const inp = boxEl.querySelector('#guestIn');
    inp.addEventListener('input', () => suggest(inp.value));
    inp.addEventListener('blur', () => setTimeout(() => { if (!sugEl.contains(document.activeElement)) sugEl.hidden = true; }, 150));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const first = sugEl.querySelector('[data-sug]'); addGuest(first ? first.dataset.sug : inp.value); }
      if (e.key === 'Backspace' && !inp.value && cart.guests.length) { cart.guests.pop(); renderGuests(); renderCart(); boxEl.querySelector('#guestIn').focus(); }
      if (e.key === 'Escape') sugEl.hidden = true;
    });
  };
  const suggest = q => {
    const n = norm(q);
    if (!n) { sugEl.hidden = true; return; }
    const hits = d.guests.filter(g => norm(g).includes(n) && !cart.guests.includes(g))
      .sort((a, b) => (norm(a).startsWith(n) ? 0 : 1) - (norm(b).startsWith(n) ? 0 : 1) || a.localeCompare(b)).slice(0, 8);
    const exact = hits.some(g => norm(g) === n);
    sugEl.innerHTML = hits.map(g => {
      const u = d.unpaid.get(g);
      return `<li><button type="button" data-sug="${esc(g)}">${esc(g)}${u ? `<span class="owes">owes Rp ${money(u.total)}</span>` : ''}</button></li>`;
    }).join('') + (exact ? '' : `<li><button type="button" class="newguest" data-sug="${esc(q.trim())}">New guest: “${esc(q.trim())}”</button></li>`);
    sugEl.hidden = false;
  };
  const addGuest = name => {
    name = String(name || '').replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (!cart.guests.some(g => norm(g) === norm(name))) cart.guests.push(name);
    sugEl.hidden = true;
    renderGuests(); renderCart();
    boxEl.querySelector('#guestIn').focus();
  };

  const lineSum = () => cart.items.reduce((s, it) => s + Math.round(it.qty * (it.unit || 0)), 0);
  const renderCart = () => {
    const g = Math.max(cart.guests.length, 1);
    const total = lineSum() * g;
    const payBtns = d.payments.map(p => `<button type="button" class="pay${cart.payment === p ? ' on' : ''}" data-pay="${esc(p)}" aria-pressed="${cart.payment === p}">${esc(payLabel(p))}</button>`).join('');
    cartEl.innerHTML = `<h2>Sale</h2>
      ${cart.items.length ? `<ul class="items">${cart.items.map((it, i) => `<li>
          <div class="iname">${esc(it.name.replace(/^-/, ''))}<small>${esc(it.category)}</small></div>
          <div class="qty" role="group" aria-label="Quantity">
            <button type="button" data-dec="${i}" aria-label="One less">−</button><span class="num">${it.qty}</span><button type="button" data-inc="${i}" aria-label="One more">+</button>
          </div>
          <label class="unit"><span class="sr">Price per unit</span><span class="cur">Rp</span><input inputmode="numeric" data-unit="${i}" value="${it.unit ? money(it.unit) : ''}" placeholder="price"></label>
          <span class="ltot num" data-ltot="${i}">${money(it.qty * (it.unit || 0))}</span>
          <button type="button" class="rm" data-rm="${i}" aria-label="Remove ${esc(it.name)}">×</button>
        </li>`).join('')}</ul>` : `<p class="muted empty">Tap products to add them.</p>`}
      ${cart.guests.length > 1 ? `<p class="each">Each of the ${cart.guests.length} guests gets these items.</p>` : ''}
      <div class="ctotal"><span>Total</span><b class="num" id="cartTotal">Rp ${money(total)}</b></div>
      <div class="pays" role="group" aria-label="Payment">${payBtns}</div>
      ${cart.payment === 'Credit / Debit Card' ? `<p class="muted small">Foreign card +3%: Rp <span id="fee">${money(Math.round(total * 1.03))}</span></p>` : ''}
      <label class="field"><span>Comment <em>optional</em></span><input id="saleComment" maxlength="300" value="${esc(cart.comment)}"></label>
      <button type="button" class="primary wide" id="recordSale">Record sale</button>
      <p class="error" id="saleErr" role="alert"></p>`;
  };
  const refreshTotals = () => {
    const total = lineSum() * Math.max(cart.guests.length, 1);
    cartEl.querySelector('#cartTotal').textContent = `Rp ${money(total)}`;
    const fee = cartEl.querySelector('#fee'); if (fee) fee.textContent = money(Math.round(total * 1.03));
    cart.items.forEach((it, i) => { const el = cartEl.querySelector(`[data-ltot="${i}"]`); if (el) el.textContent = money(it.qty * (it.unit || 0)); });
  };

  root.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.sug !== undefined) return addGuest(b.dataset.sug);
    if (b.dataset.grm !== undefined) { cart.guests.splice(+b.dataset.grm, 1); renderGuests(); renderCart(); return; }
    if (b.dataset.add !== undefined) {
      const p = d.catalog[+b.dataset.add];
      const ex = cart.items.find(x => x.name === p.name && x.category === p.category);
      if (ex) ex.qty++; else cart.items.push({ name: p.name, category: p.category, qty: 1, unit: p.price || 0, unitCost: p.cost || 0 });
      renderCart(); renderProds();
      if (!p.price) cartEl.querySelector(`[data-unit="${cart.items.length - 1}"]`)?.focus();
      return;
    }
    if (b.dataset.inc !== undefined) { cart.items[+b.dataset.inc].qty++; renderCart(); renderProds(); return; }
    if (b.dataset.dec !== undefined) { const it = cart.items[+b.dataset.dec]; if (it.qty > 1) it.qty--; renderCart(); renderProds(); return; }
    if (b.dataset.rm !== undefined) { cart.items.splice(+b.dataset.rm, 1); renderCart(); renderProds(); return; }
    if (b.dataset.pay !== undefined) { cart.payment = b.dataset.pay; renderCart(); return; }
    if (b.id === 'recordSale') return recordSale(b);
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'prodIn') { ui.prodQuery = t.value; renderProds(); }
    if (t.id === 'saleComment') cart.comment = t.value;
    if (t.dataset.unit !== undefined) {
      const v = parseMoney(t.value);
      t.value = v === null ? '' : money(v);
      cart.items[+t.dataset.unit].unit = v || 0;
      refreshTotals();
    }
  });

  async function recordSale(btn) {
    const err = cartEl.querySelector('#saleErr');
    const say = m => { err.textContent = m; };
    if (!cart.guests.length) { say('Add the guest first.'); boxEl.querySelector('#guestIn').focus(); return; }
    if (!cart.items.length) { say('Add at least one product.'); return; }
    const noPrice = cart.items.findIndex(it => !it.unit || it.unit > 1e9);
    if (noPrice >= 0) { say(`Enter a correct price for ${cart.items[noPrice].name.replace(/^-/, '')}.`); cartEl.querySelector(`[data-unit="${noPrice}"]`).focus(); return; }
    if (!cart.payment) { say('Choose how the guest pays.'); return; }
    btn.disabled = true;
    try {
      const lines = [];
      for (const it of cart.items) for (const g of cart.guests) {
        lines.push({ ts: await nextTs(), guest: g, category: it.category, object: it.name, qty: it.qty, unit: it.unit, unitCost: it.unitCost, comment: cart.comment.trim() });
      }
      const total = lines.reduce((s, l) => s + Math.round(l.qty * l.unit), 0);
      await enqueue('sale', { saleId: 'V' + lines[0].ts, payment: cart.payment, lines });
      d.ui.notice = `Sale recorded: Rp ${money(total)}, ${payLabel(cart.payment)}${cart.payment === 'Unpaid' ? ' (added to the guest bill)' : ''}.`;
      d.ui.cart = newCart(); d.ui.prodQuery = '';
      d.render();
    } catch (e2) { say(e2.message); btn.disabled = false; }
  }

  renderGuests(); renderProds(); renderCart();
}

// ---------------------------------------------------------------- line rows (bills + shift)
function lineRow(l, d, { showDay = false } = {}) {
  const { ui } = d;
  const isExp = l.type === 'Expense';
  const isSpend = isExp && l.comment !== 'Refunding'; // a daily expense, not a refund
  const amount = isExp ? -(l.cost || 0) : (l.total || 0);
  const edit = canChange(l, d.user, d.shift) && (!isExp || isSpend); // refund lines: delete only
  const del = canChange(l, d.user, d.shift);
  const ref = canRefund(l);
  let extra = '';
  if (ui.editing === l.ts && isSpend) {
    extra = `<form class="inline" data-expform="${esc(l.ts)}">
      <label>Amount <span class="moneyin"><span class="cur">Rp</span><input name="amount" inputmode="numeric" value="${money(l.cost || 0)}"></span></label>
      <label>Paid with <select name="payment">${[...new Set([l.payment, ...d.payments.filter(p => p !== 'Paid to Partner')])].map(p => `<option${p === l.payment ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="grow">Comment <input name="comment" maxlength="300" value="${esc(l.comment)}"></label>
      <div class="row"><button class="primary small" type="submit">Save</button><button class="ghost small" type="button" data-cancel>Cancel</button></div>
      <p class="error" role="alert"></p></form>`;
  } else if (ui.editing === l.ts) {
    extra = `<form class="inline" data-editform="${esc(l.ts)}">
      <label>Qty <input name="qty" inputmode="decimal" value="${esc(l.qty ?? '')}"${l.qty == null ? ' placeholder="—"' : ''}></label>
      <label>Price per unit <span class="moneyin"><span class="cur">Rp</span><input name="unit" inputmode="numeric" value="${money(l.unit || 0)}"></span></label>
      <label>Payment <select name="payment">${[...new Set([l.payment, ...d.payments])].map(p => `<option${p === l.payment ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label>Guest <input name="guest" value="${esc(l.guest)}"></label>
      <label class="grow">Comment <input name="comment" value="${esc(l.comment === 'Refunded' ? '' : l.comment)}"${l.comment === 'Refunded' ? ' disabled' : ''}></label>
      <div class="row"><button class="primary small" type="submit">Save</button><button class="ghost small" type="button" data-cancel>Cancel</button></div>
      <p class="error" role="alert"></p></form>`;
  } else if (ui.deleting === l.ts) {
    extra = `<div class="inline warn"><span>Delete this line from the sheet?</span>
      <button class="danger small" type="button" data-delok="${esc(l.ts)}">Delete</button><button class="ghost small" type="button" data-cancel>Keep</button></div>`;
  } else if (ui.refunding === l.ts) {
    extra = `<form class="inline" data-refform="${esc(l.ts)}">
      <label>Amount to give back <span class="moneyin"><span class="cur">Rp</span><input name="amount" inputmode="numeric" value="${money(l.total)}"></span></label>
      <label>Paid back by <select name="payment"${d.user.role === 'staff' ? ' disabled title="Same as the sale. A manager can choose another."' : ''}>${d.payments.filter(p => p !== 'Unpaid').map(p => `<option${p === l.payment ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="grow">Reason <input name="reason" maxlength="300" placeholder="Why the refund"></label>
      <div class="row"><button class="primary small" type="submit">Refund</button><button class="ghost small" type="button" data-cancel>Cancel</button></div>
      <p class="error" role="alert"></p></form>`;
  }
  const status = l.pending ? '<span class="badge wait" title="Saved on this computer, not yet in the sheet">Waiting</span>' : '';
  const tags = [
    l.payment === 'Unpaid' ? '<span class="badge unpaid">Unpaid</span>' : `<span class="pm">${esc(payLabel(l.payment))}</span>`,
    l.comment === 'Refunded' ? '<span class="badge">Refunded</span>' : '',
    isExp && l.comment === 'Refunding' ? '<span class="badge">Refund</span>' : '',
  ].join('');
  return `<li class="line${isExp ? ' exp' : ''}${ui.editing === l.ts || ui.refunding === l.ts ? ' open' : ''}">
    <span class="when">${showDay ? lineDay(l.ts) + ' ' : ''}${lineTime(l.ts)}</span>
    <span class="what"><b>${esc(isSpend ? expenseLabel(l.object) : l.object.replace(/^-/, ''))}</b>${l.qty && l.qty !== 1 ? ` ×${esc(l.qty)}` : ''}<span class="who">${isSpend ? 'Expense' : esc(l.guest)}</span></span>
    <span class="tags">${tags}${status}</span>
    <span class="amt num">${amount < 0 ? '−' : ''}${money(Math.abs(amount))}</span>
    <span class="acts">${edit ? `<button class="link" type="button" data-edit="${esc(l.ts)}">Edit</button>` : ''}${del ? `<button class="link" type="button" data-del="${esc(l.ts)}">Delete</button>` : ''}${ref ? `<button class="link" type="button" data-refund="${esc(l.ts)}">Refund</button>` : ''}</span>
    ${l.comment && !['Refunded', 'Refunding'].includes(l.comment) ? `<span class="note">${esc(l.comment)}</span>` : ''}
    ${extra}</li>`;
}

/** Edit / delete / refund handlers shared by the bills and shift tabs. */
function bindLineActions(root, d) {
  const { ui } = d;
  const byTs = ts => d.lines.find(l => l.ts === ts);
  root.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.edit) { ui.editing = b.dataset.edit; ui.deleting = ui.refunding = null; d.render(); }
    else if (b.dataset.del) { ui.deleting = b.dataset.del; ui.editing = ui.refunding = null; d.render(); }
    else if (b.dataset.refund) { ui.refunding = b.dataset.refund; ui.editing = ui.deleting = null; d.render(); }
    else if (b.dataset.cancel !== undefined) { ui.editing = ui.deleting = ui.refunding = null; d.render(); }
    else if (b.dataset.delok) {
      b.disabled = true;
      const l = byTs(b.dataset.delok);
      await enqueue('line_delete', { ts: b.dataset.delok });
      ui.deleting = null;
      ui.notice = !l ? 'Line deleted.' : l.type === 'Expense' ? `Deleted: ${expenseLabel(l.object)} expense of Rp ${money(l.cost)}.` : `Deleted: ${l.object.replace(/^-/, '')} for ${l.guest}.`;
      d.render();
    }
  });
  root.addEventListener('submit', async e => {
    const f = e.target;
    e.preventDefault();
    const err = f.querySelector('.error');
    const btn = f.querySelector('button[type=submit]');
    if (f.dataset.editform) {
      const l = byTs(f.dataset.editform);
      if (!l) return;
      const qtyText = String(f.qty.value).trim();
      const qty = qtyText === '' ? null : Math.round(Number(qtyText.replace(',', '.')) * 100) / 100;
      const unit = parseMoney(f.unit.value);
      const guest = f.guest.value.replace(/\s+/g, ' ').trim();
      if (qty !== null && !(qty > 0 && qty <= 1000)) { err.textContent = 'Enter a quantity above 0 and up to 1000.'; return; }
      if (!unit || unit > 1e9) { err.textContent = 'Enter the price.'; return; }
      if (!guest) { err.textContent = 'Enter the guest.'; return; }
      const change = {};
      if (qty !== null && qty !== l.qty) change.qty = qty;
      if (unit !== l.unit) change.unit = unit;
      if (f.payment.value !== l.payment) change.payment = f.payment.value;
      if (guest !== l.guest) change.guest = guest;
      if (!f.comment.disabled && f.comment.value.trim() !== (l.comment || '')) change.comment = f.comment.value.trim();
      btn.disabled = true;
      if (Object.keys(change).length) await enqueue('line_update', { ts: l.ts, ...change });
      ui.editing = null; ui.notice = Object.keys(change).length ? 'Line updated.' : null;
      d.render();
    } else if (f.dataset.expform) {
      const l = byTs(f.dataset.expform);
      if (!l) return;
      const amount = parseMoney(f.amount.value);
      if (!amount || amount > 1e9) { err.textContent = 'Enter the amount.'; return; }
      const change = {};
      if (amount !== l.cost) change.amount = amount;
      if (f.payment.value !== l.payment) change.payment = f.payment.value;
      if (f.comment.value.trim() !== (l.comment || '')) change.comment = f.comment.value.trim();
      btn.disabled = true;
      if (Object.keys(change).length) await enqueue('line_update', { ts: l.ts, ...change });
      ui.editing = null; ui.notice = Object.keys(change).length ? 'Expense updated.' : null;
      d.render();
    } else if (f.dataset.refform) {
      const l = byTs(f.dataset.refform);
      if (!l) return;
      const amount = parseMoney(f.amount.value);
      if (!amount || amount > l.total) { err.textContent = `Enter an amount between 1 and ${money(l.total)}.`; return; }
      btn.disabled = true;
      const payBack = d.user.role === 'staff' ? l.payment : f.payment.value;
      await enqueue('refund', { origTs: l.ts, newTs: await nextTs(), amount, payment: payBack, reason: f.reason.value.trim() });
      ui.refunding = null; ui.notice = `Refund recorded: Rp ${money(amount)} to ${l.guest}, ${payLabel(payBack)}.`;
      d.render();
    }
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.name === 'unit' || t.name === 'amount') { const v = parseMoney(t.value); t.value = v === null ? '' : money(v); }
  });
}

// ---------------------------------------------------------------- guest bills
function renderBills(root, d) {
  const { ui } = d;
  const guest = ui.billGuest;
  if (!guest) {
    root.innerHTML = `<section class="card">
      <label class="field"><span>Find a guest</span><input id="billQ" type="search" autocomplete="off" placeholder="Name" value="${esc(ui.billQuery || '')}"></label>
      <div id="billList"></div></section>`;
    const listEl = root.querySelector('#billList');
    const draw = () => { listEl.innerHTML = billList(d); };
    root.querySelector('#billQ').addEventListener('input', e => { ui.billQuery = e.target.value; draw(); });
    root.addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) { ui.billGuest = b.dataset.open; ui.billSel = null; ui.billPay = null; d.render(); } });
    draw();
    return;
  }
  renderBill(root, d, guest);
}

function billList(d) {
  {
    const q = norm(d.ui.billQuery);
    let body;
    if (q) {
      const hits = d.guests.filter(g => norm(g).includes(q)).sort((a, b) => a.localeCompare(b)).slice(0, 30);
      body = hits.length ? `<ul class="glist">${hits.map(g => {
        const u = d.unpaid.get(g);
        return `<li><button type="button" data-open="${esc(g)}"><span>${esc(g)}</span>${u ? `<span class="owes">owes Rp ${money(u.total)}</span>` : ''}</button></li>`;
      }).join('')}</ul>` : '<p class="muted">No guest with that name.</p>';
    } else {
      const list = [...d.unpaid.values()].sort((a, b) => (a.oldest < b.oldest ? -1 : 1));
      body = list.length ? `<h3 class="sub">Open bills</h3><ul class="glist">${list.map(u => `<li><button type="button" data-open="${esc(u.guest)}">
          <span>${esc(u.guest)}<small>${u.count} item${u.count > 1 ? 's' : ''} since ${lineDay(u.oldest)}</small></span><span class="owes">Rp ${money(u.total)}</span></button></li>`).join('')}</ul>`
        : '<p class="muted">No open bills. Every sale is paid.</p>';
    }
    return body;
  }
}

function renderBill(root, d, guest) {
  const { ui } = d;
  const lines = d.lines.filter(l => l.guest === guest);
  const unpaid = lines.filter(l => l.type === 'Income' && l.payment === 'Unpaid');
  if (!ui.billSel) ui.billSel = new Set(unpaid.map(l => l.ts));
  for (const ts of [...ui.billSel]) if (!unpaid.some(l => l.ts === ts)) ui.billSel.delete(ts);
  const others = lines.filter(l => !(l.type === 'Income' && l.payment === 'Unpaid'));
  const selTotal = () => unpaid.filter(l => ui.billSel.has(l.ts)).reduce((s, l) => s + (l.total || 0), 0);
  root.innerHTML = `<section class="card bill">
    <button type="button" class="link back" data-back>All bills</button>
    <h2>${esc(guest)}</h2>
    ${unpaid.length ? `<form id="payForm">
      <h3 class="sub">To pay</h3>
      <ul class="lines">${unpaid.map(l => `<li class="line sel"><label class="check"><input type="checkbox" data-sel="${esc(l.ts)}"${ui.billSel.has(l.ts) ? ' checked' : ''}>
        <span class="what"><b>${esc(l.object.replace(/^-/, ''))}</b>${l.qty && l.qty !== 1 ? ` ×${esc(l.qty)}` : ''}<span class="who">${lineDay(l.ts)} ${lineTime(l.ts)}</span></span></label>
        <span class="amt num">${money(l.total)}</span>${l.pending ? '<span class="badge wait">Waiting</span>' : ''}</li>`).join('')}</ul>
      <div class="ctotal"><span>Selected</span><b class="num" id="selTotal">Rp ${money(selTotal())}</b></div>
      <div class="pays" role="group" aria-label="Payment">${d.payments.filter(p => p !== 'Unpaid').map(p => `<button type="button" class="pay${ui.billPay === p ? ' on' : ''}" data-bpay="${esc(p)}" aria-pressed="${ui.billPay === p}">${esc(payLabel(p))}</button>`).join('')}</div>
      <button type="submit" class="primary wide">Record payment</button>
      <p class="error" role="alert"></p>
    </form>` : '<p class="ok-note">Nothing left to pay.</p>'}
    ${others.length ? `<h3 class="sub">Paid (last 3 weeks)</h3><ul class="lines">${others.map(l => lineRow(l, d, { showDay: true })).join('')}</ul>` : ''}
  </section>`;
  bindLineActions(root, d);
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.back !== undefined) { ui.billGuest = null; ui.billSel = null; ui.billPay = null; d.render(); }
    if (b.dataset.bpay) { ui.billPay = b.dataset.bpay; root.querySelectorAll('[data-bpay]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); }
  });
  root.addEventListener('change', e => {
    const c = e.target.closest('[data-sel]');
    if (!c) return;
    if (c.checked) ui.billSel.add(c.dataset.sel); else ui.billSel.delete(c.dataset.sel);
    root.querySelector('#selTotal').textContent = `Rp ${money(selTotal())}`;
  });
  root.querySelector('#payForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = f.querySelector('.error');
    const chosen = unpaid.filter(l => ui.billSel.has(l.ts));
    if (!chosen.length) { err.textContent = 'Tick what the guest pays now.'; return; }
    if (!ui.billPay) { err.textContent = 'Choose how the guest pays.'; return; }
    f.querySelector('button[type=submit]').disabled = true;
    const items = [];
    for (const l of chosen) items.push({ oldTs: l.ts, newTs: await nextTs() });
    const total = chosen.reduce((s, l) => s + (l.total || 0), 0);
    await enqueue('settle', { payment: ui.billPay, items });
    ui.notice = `Payment recorded: Rp ${money(total)} from ${guest}, ${payLabel(ui.billPay)}.`;
    ui.billSel = null; ui.billPay = null;
    d.render();
  });
}

// ---------------------------------------------------------------- this shift
function renderShiftLines(root, d) {
  const mine = shiftLines(d.lines, d.shift);
  const t = totals(mine);
  const rows = (obj, sign) => Object.entries(obj).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<div><dt>${esc(payLabel(k))}</dt><dd class="num">${sign}${money(v)}</dd></div>`).join('');
  root.innerHTML = `<section class="card">
    <div class="split">
      <div><h3 class="sub">Sales</h3><dl class="figures compact">${rows(t.income, '') || '<p class="muted">None yet.</p>'}</dl></div>
      <div><h3 class="sub">Paid out</h3><dl class="figures compact">${rows(t.expense, '−') || '<p class="muted">None.</p>'}</dl></div>
    </div>
    <h3 class="sub">Lines in this shift</h3>
    ${mine.length ? `<ul class="lines">${mine.map(l => lineRow(l, d)).join('')}</ul>` : '<p class="muted">Nothing recorded in this shift yet.</p>'}
  </section>`;
  bindLineActions(root, d);
}

// ---------------------------------------------------------------- expenses
function todayLocal() {
  const d = new Date(Date.now() + 8 * 3600000); // reception time (UTC+8)
  return d.toISOString().slice(0, 10);
}

function renderExpenses(root, d) {
  const { ui } = d;
  // date stays empty unless changed: "today" is decided when the expense is recorded.
  const ex = ui.expense = ui.expense || { item: null, payment: null, amount: null, date: '', comment: '' };
  const pays = d.payments.filter(p => p !== 'Paid to Partner');
  const mine = shiftLines(d.lines, d.shift).filter(l => l.type === 'Expense' && l.comment !== 'Refunding');
  const minDate = new Date(Date.now() + 8 * 3600000 - 30 * 86400000).toISOString().slice(0, 10);
  root.innerHTML = `<div class="expenses">
    <section class="card">
      <h2>New expense</h2>
      <form id="expForm" novalidate>
        <fieldset class="field"><legend>What for</legend>
          <div class="eitems">${EXPENSE_ITEMS.map(it => `<button type="button" class="eitem ${it.tone}${ex.item === it.object ? ' on' : ''}" data-item="${esc(it.object)}" aria-pressed="${ex.item === it.object}">${esc(it.label)}</button>`).join('')}</div>
        </fieldset>
        <label class="field money"><span>Amount</span>
          <span class="moneybox"><span class="cur">Rp</span><input id="expAmount" inputmode="numeric" autocomplete="off" value="${ex.amount ? money(ex.amount) : ''}"></span></label>
        <fieldset class="field"><legend>Paid with</legend>
          <div class="pays">${pays.map(p => `<button type="button" class="pay${ex.payment === p ? ' on' : ''}" data-epay="${esc(p)}" aria-pressed="${ex.payment === p}">${esc(payLabel(p))}</button>`).join('')}</div>
        </fieldset>
        <div class="row2">
          <label class="field"><span>Date</span><input id="expDate" type="date" min="${minDate}" max="${todayLocal()}" value="${esc(ex.date || todayLocal())}"></label>
          <label class="field grow"><span>Comment <em>optional</em></span><input id="expComment" maxlength="300" value="${esc(ex.comment)}" placeholder="What exactly, for whom"></label>
        </div>
        <button class="primary wide" type="submit">Record expense</button>
        <p class="error" role="alert"></p>
      </form>
    </section>
    <section class="card">
      <h2>Expenses in this shift</h2>
      ${mine.length ? `<ul class="lines">${mine.map(l => lineRow(l, d)).join('')}</ul>
        <div class="ctotal"><span>Total</span><b class="num">Rp ${money(mine.reduce((s, l) => s + (l.cost || 0), 0))}</b></div>`
        : '<p class="muted">No expense in this shift yet.</p>'}
    </section>
  </div>`;
  bindLineActions(root, d);
  const f = root.querySelector('#expForm');
  const err = f.querySelector('.error');
  f.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.item) { ex.item = b.dataset.item; f.querySelectorAll('[data-item]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); root.querySelector('#expAmount').focus(); }
    if (b.dataset.epay) { ex.payment = b.dataset.epay; f.querySelectorAll('[data-epay]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); }
  });
  f.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'expAmount') { const v = parseMoney(t.value); t.value = v === null ? '' : money(v); ex.amount = v; }
    if (t.id === 'expComment') ex.comment = t.value;
    if (t.id === 'expDate') ex.date = t.value === todayLocal() ? '' : t.value;
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    if (!ex.item) { err.textContent = 'Choose what the expense is for.'; return; }
    if (!ex.amount || ex.amount > 1e9) { err.textContent = 'Enter the amount.'; root.querySelector('#expAmount').focus(); return; }
    if (!ex.payment) { err.textContent = 'Choose how it was paid.'; return; }
    const date = ex.date || todayLocal();
    if (date > todayLocal() || date < minDate) { err.textContent = 'Choose a date within the last month.'; return; }
    f.querySelector('button[type=submit]').disabled = true;
    await enqueue('expense', { ts: await nextTs(), object: ex.item, amount: ex.amount, payment: ex.payment, date, comment: ex.comment.trim() });
    ui.notice = `Expense recorded: ${expenseLabel(ex.item)}, Rp ${money(ex.amount)}, ${payLabel(ex.payment)}.`;
    ui.expense = null;
    d.render();
  });
}

export const expenseBusy = ui => !!(ui.expense && (ui.expense.amount || ui.expense.comment));
