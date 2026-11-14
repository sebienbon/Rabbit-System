import { db } from './db.js';
import { enqueue } from './sync.js';
import { ledgerView, nextTs, shiftLines, totals, canChange, canRefund, cashRight, cashboxView, shiftCash, partnerView, billNet, tsFromMs, lastSettlementView, cardLines, cardAmount } from './ledger.js';
import { money, parseMoney } from './shift.js';
import { renderBar } from './bar.js'; // TEMPORARY (bar cash-out)
import { gearView, backBefore, fmtWhen, sameName } from './gearcore.js';
import { renderGear } from './gear.js';
import { renderCommissions, renderActivities, catalogWithPending, hasFeature } from './sellextra.js';

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
// The buttons come from the sheet (Data activities "Expense buttons", sent by pull) when it lists
// any: a known item keeps its label and colour above, a new one shows its name in the "other" colour.
let expenseItems = EXPENSE_ITEMS;
export function expenseButtons(fromSheet) {
  const list = (fromSheet || []).map(x => String((x && x.object) || '').trim()).filter(Boolean);
  if (!list.length) return EXPENSE_ITEMS;
  return list.map(o => EXPENSE_ITEMS.find(x => x.object === o) || { label: o, object: o, tone: 'other' });
}
const expenseLabel = obj => (expenseItems.find(x => x.object === obj) || EXPENSE_ITEMS.find(x => x.object === obj) || {}).label || obj;

export function newCart() { return { guests: [], items: [], payment: null, comment: '' }; }
export const cartBusy = ui => !!(ui.cart && (ui.cart.items.length || ui.cart.guests.length));

/** Shared data for one render. */
async function load(ctx) {
  const [lines, rawCatalog, payments, guestList, gear, expenses, features] = await Promise.all([
    ledgerView(), db.get('catalog'), db.get('payments'), db.get('guests'), gearView(), db.get('expenses'), db.get('features')]);
  const catalog = await catalogWithPending(rawCatalog); // tours edited here show at once
  expenseItems = expenseButtons(expenses);
  const names = new Map();
  for (const g of guestList || []) names.set(norm(g), g);
  for (const l of lines) if (l.guest && l.type === 'Income' && l.object !== 'Cash Supply' && !names.has(norm(l.guest))) names.set(norm(l.guest), l.guest);
  const unpaid = new Map();
  for (const l of lines) if (l.type === 'Income' && l.payment === 'Unpaid') {
    const u = unpaid.get(l.guest) || { guest: l.guest, total: 0, count: 0, oldest: l.ts };
    u.total += l.total || 0; u.count++; if (l.ts < u.oldest) u.oldest = l.ts;
    if (isNoShow(l)) u.noShow = true;
    unpaid.set(l.guest, u);
  }
  return { lines, catalog: catalog || [], payments: payments || ['Cash', 'Unpaid'], guests: [...names.values()], unpaid, gear, features: features || [], ...ctx };
}

/** Beds24 status "Black" = the guest did not come: the sync starts the room line's comment with this. */
export const isNoShow = l => /^No-show\b/i.test(String(l.comment || ''));
const NOSHOW_BADGE = '<span class="badge noshow" title="Status Black in Beds24: the guest did not come">No-show</span>';

// ---------------------------------------------------------------- tabs
export async function workTabs(ctx) {
  const d = await load(ctx);
  const mine = shiftLines(d.lines, ctx.shift);
  const t = totals(mine);
  const open = (await cashboxView()).filter(e => e.type === 'Phantom').length;
  const pv = await partnerView();
  const bills = new Set(pv.lines.filter(l => l.bill).map(l => l.bill)).size;
  return { counts: { bills: d.unpaid.size, shift: mine.length, cash: open, partners: bills,
    expenses: mine.filter(l => l.type === 'Expense' && l.comment !== 'Refunding' && l.object !== 'Cash Supply').length }, totals: t };
}

export async function renderWork(root, ctx) {
  const d = await load(ctx);
  const tab = ctx.ui.tab || 'sell';
  if (tab === 'sell') {
    // Commissions and the activities editor: only with a server that supports them.
    const view = ctx.ui.sellView;
    if (view === 'comm' && hasFeature(d.features, 'commissions')) await renderCommissions(root, d, helpTip);
    else if (view === 'acts' && hasFeature(d.features, 'catalog_edit')) await renderActivities(root, d, helpTip);
    else { ctx.ui.sellView = null; renderSell(root, d); }
  }
  else if (tab === 'bills') renderBills(root, d);
  else if (tab === 'shift') renderShiftLines(root, d);
  else if (tab === 'expenses') renderExpenses(root, d);
  else if (tab === 'cash') await renderCash(root, d);
  else if (tab === 'partners') await renderPartners(root, d);
  else if (tab === 'card') await renderCard(root, d);
  else if (tab === 'bar') await renderBar(root, d); // TEMPORARY (bar cash-out)
  else if (tab === 'gear') await renderGear(root, d);
}

// ---------------------------------------------------------------- sell
/** Two discreet links next to "Products" (rarely used), when the server supports them. */
function sellTools(d) {
  const t = [];
  if (hasFeature(d.features, 'commissions')) t.push('<button type="button" class="tool" data-sellview="comm">Commissions</button>');
  if (hasFeature(d.features, 'catalog_edit')) t.push('<button type="button" class="tool" data-sellview="acts">Edit tours &amp; transport</button>');
  return t.length ? `<span class="selltools">${t.join('')}</span>` : '';
}
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
        <div class="labelrow"><label for="prodIn">Products</label>${sellTools(d)}</div>
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
    if (cart.items.some(it => it.gear) && cart.guests.length && !cart.guests.some(g => norm(g) === norm(name))) {
      const er = cartEl.querySelector('#saleErr');
      if (er) er.textContent = 'Rent masks and bikes for one guest at a time: record this sale first.';
      sugEl.hidden = true; return;
    }
    if (!cart.guests.some(g => norm(g) === norm(name))) cart.guests.push(name);
    sugEl.hidden = true;
    renderGuests(); renderCart();
    boxEl.querySelector('#guestIn').focus();
  };

  // Gear rental (mask, bike): the quantity is the number of days, one line per number picked.
  const gearKind = name => d.gear && d.gear.product ? (sameName(name, d.gear.product.mask) ? 'mask' : sameName(name, d.gear.product.bike) ? 'bike' : null) : null;
  const pieces = it => (it.gear ? Math.max(it.gear.length, 1) : 1);
  const chosenNumbers = () => new Set(cart.items.flatMap(it => it.gear || []));
  const available = kind => (d.gear ? d.gear.items : []).filter(i => i.kind === kind && i.where === 'in' && i.condition === 'OK' && !chosenNumbers().has(i.id));
  const lineSum = () => cart.items.reduce((s, it) => s + Math.round(it.qty * (it.unit || 0)) * pieces(it), 0);
  const gearBox = (it, i) => `<div class="gearpick">
      <div class="gearbox">${it.gear.map(g => `<span class="chip">${esc(g)}<button type="button" data-gearrm="${i}:${esc(g)}" aria-label="Remove ${esc(g)}">×</button></span>`).join('')}
        <input data-gearin="${i}" autocomplete="off" placeholder="${it.gear.length ? 'Add number' : 'Type or pick a number'}" aria-label="${esc(it.name)} numbers"></div>
      <ul class="suggest gsug" data-gearsug="${i}" role="listbox" hidden></ul>
      <small>Back before ${esc(fmtWhen(new Date(backBefore(Date.now(), it.qty)).toISOString()))}</small>
    </div>`;
  const renderCart = () => {
    const g = Math.max(cart.guests.length, 1);
    const total = lineSum() * g;
    const payBtns = d.payments.map(p => `<button type="button" class="pay${cart.payment === p ? ' on' : ''}" data-pay="${esc(p)}" aria-pressed="${cart.payment === p}">${esc(payLabel(p))}</button>`).join('');
    cartEl.innerHTML = `<h2>Sale</h2>
      ${cart.items.length ? `<ul class="items">${cart.items.map((it, i) => `<li>
          <div class="iname">${esc(it.name.replace(/^-/, ''))}<small>${it.gear ? `${it.gear.length} × · days` : esc(it.category)}</small></div>
          <div class="qty" role="group" aria-label="${it.gear ? 'Days' : 'Quantity'}">
            <button type="button" data-dec="${i}" aria-label="One less">−</button><span class="num">${it.qty}</span><button type="button" data-inc="${i}" aria-label="One more">+</button>
          </div>
          <label class="unit"><span class="sr">Price per unit</span><span class="cur">Rp</span><input inputmode="numeric" data-unit="${i}" value="${it.unit ? money(it.unit) : ''}" placeholder="price"></label>
          <span class="ltot num" data-ltot="${i}">${money(it.qty * (it.unit || 0) * pieces(it))}</span>
          <button type="button" class="rm" data-rm="${i}" aria-label="Remove ${esc(it.name)}">×</button>
          ${it.gear ? gearBox(it, i) : ''}
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
    cart.items.forEach((it, i) => { const el = cartEl.querySelector(`[data-ltot="${i}"]`); if (el) el.textContent = money(it.qty * (it.unit || 0) * pieces(it)); });
  };

  root.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.sellview) { ui.sellView = b.dataset.sellview; ui.commMove = ui.actEdit = null; d.render(); return; }
    if (b.dataset.sug !== undefined) return addGuest(b.dataset.sug);
    if (b.dataset.grm !== undefined) { cart.guests.splice(+b.dataset.grm, 1); renderGuests(); renderCart(); return; }
    if (b.dataset.add !== undefined) {
      const p = d.catalog[+b.dataset.add];
      const ex = cart.items.find(x => x.name === p.name && x.category === p.category);
      const kind = gearKind(p.name);
      if (ex && kind) { cartEl.querySelector(`[data-gearin="${cart.items.indexOf(ex)}"]`)?.focus(); return; }
      if (kind && cart.guests.length > 1) { const er = cartEl.querySelector('#saleErr'); if (er) er.textContent = 'Rent masks and bikes for one guest at a time: keep one guest in this sale.'; return; }
      if (ex) ex.qty++; else cart.items.push({ name: p.name, category: p.category, qty: 1, unit: p.price || 0, unitCost: p.cost || 0, ...(kind ? { gear: [], kind } : {}) });
      renderCart(); renderProds();
      if (kind) cartEl.querySelector(`[data-gearin="${cart.items.length - 1}"]`)?.focus();
      else if (!p.price) cartEl.querySelector(`[data-unit="${cart.items.length - 1}"]`)?.focus();
      return;
    }
    if (b.dataset.inc !== undefined) { cart.items[+b.dataset.inc].qty++; renderCart(); renderProds(); return; }
    if (b.dataset.dec !== undefined) { const it = cart.items[+b.dataset.dec]; if (it.qty > 1) it.qty--; renderCart(); renderProds(); return; }
    if (b.dataset.rm !== undefined) { cart.items.splice(+b.dataset.rm, 1); renderCart(); renderProds(); return; }
    if (b.dataset.pay !== undefined) { cart.payment = b.dataset.pay; renderCart(); return; }
    if (b.dataset.gearpick !== undefined) { const [i, g] = b.dataset.gearpick.split(':'); addNumber(+i, g); return; }
    if (b.dataset.gearfix !== undefined) {
      // The gear staff forgot to say it was repaired: back in stock (as in Gear), then into this sale.
      const [i, g] = b.dataset.gearfix.split(':');
      b.disabled = true;
      await enqueue('gear_service', { sid: 'R' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6), item: g });
      d.gear = await gearView();
      addNumber(+i, g);
      const er = cartEl.querySelector('#saleErr'); if (er) er.textContent = `${g} marked repaired and back in stock.`;
      return;
    }
    if (b.dataset.gearrm !== undefined) { const [i, g] = b.dataset.gearrm.split(':'); const it = cart.items[+i]; it.gear = it.gear.filter(x => x !== g); renderCart(); return; }
    if (b.id === 'recordSale') return recordSale(b);
  });
  const showNumbers = (i, q) => {
    const it = cart.items[i], ul = cartEl.querySelector(`[data-gearsug="${i}"]`);
    if (!it || !ul) return;
    const n = String(q || '').trim().toUpperCase();
    const list = available(it.kind).filter(x => !n || x.id.includes(n)); // all of them; the list scrolls
    ul.innerHTML = list.length ? list.map(x => `<li><button type="button" data-gearpick="${i}:${esc(x.id)}">${esc(x.id)}</button></li>`).join('')
      : n ? '<li class="muted">No available number matches.</li>' : noneInStock(it.kind, i);
    ul.hidden = false;
  };
  // Nothing to rent: say which ones and why (12/11: "No bike in stock" while 3 bikes were in the box,
  // marked broken at the evening check). Already repaired? Back in stock here and picked at once.
  const noneInStock = (kind, i) => {
    const all = (d.gear ? d.gear.items : []).filter(x => x.kind === kind && !chosenNumbers().has(x.id));
    const word = kind === 'bike' ? 'bike' : 'mask';
    const broken = all.filter(x => x.where === 'in' && x.condition !== 'OK');
    const out = all.filter(x => x.where === 'out' || x.where === 'sunset');
    const note = id => { const dm = (d.gear.damages || []).filter(x => x.item === id && x.note).pop(); return dm ? ` “${esc(dm.note)}”` : ''; };
    const fix = d.user.role !== 'staff' || (d.shift && d.shift.user === d.user.username);
    return `<li class="muted">No ${word} ready to rent.</li>`
      + (broken.length ? `<li class="gbrokenh">${broken.length} ${word}${broken.length > 1 ? 's' : ''} out of service:</li>` + broken.map(x => `<li class="gbroken"><b>${esc(x.id)}</b> <span>${esc(x.condition)}${note(x.id)}</span>${fix ? `<button type="button" class="ghost small" data-gearfix="${i}:${esc(x.id)}">Repaired · rent it</button>` : ''}</li>`).join('') : '')
      + (out.length ? `<li class="muted small">Out now: ${out.map(x => esc(x.id) + (x.where === 'sunset' ? ' (Sunset Boat)' : x.last && x.last.guest ? ' (' + esc(x.last.guest) + ')' : '')).join(', ')}</li>` : '')
      + (!broken.length && !out.length ? `<li class="muted small">No ${word} in the SG tab of the sheet.</li>` : '');
  };
  const addNumber = (i, g) => {
    const it = cart.items[i];
    const id = String(g || '').trim().toUpperCase();
    const hit = available(it.kind).find(x => x.id === id);
    // Typed on purpose although recorded out (the guest left it in the box): it is returned first, no extension.
    const resold = !hit && (d.gear ? d.gear.items : []).find(x => x.id === id && x.kind === it.kind && (x.where === 'out' || x.where === 'sunset') && !chosenNumbers().has(x.id));
    const err = cartEl.querySelector('#saleErr');
    if (!hit && !resold) { err.textContent = `${id} is not available (broken, lost, unknown or already in this sale).`; return; }
    it.gear.push(id);
    renderCart(); renderProds();
    if (resold) cartEl.querySelector('#saleErr').textContent = `${id} was recorded out (${resold.where === 'sunset' ? 'Sunset Boat' : resold.last ? resold.last.guest : ''}): it will be marked returned first, without extension.`;
    cartEl.querySelector(`[data-gearin="${i}"]`)?.focus();
  };
  root.addEventListener('focusin', e => { if (e.target.dataset && e.target.dataset.gearin !== undefined) showNumbers(+e.target.dataset.gearin, e.target.value); });
  // A click in a field that already has the focus opens the list too.
  root.addEventListener('pointerup', e => { if (e.target.dataset && e.target.dataset.gearin !== undefined) showNumbers(+e.target.dataset.gearin, e.target.value); });
  root.addEventListener('focusout', e => {
    if (e.target.dataset && e.target.dataset.gearin !== undefined) setTimeout(() => { const ul = cartEl.querySelector(`[data-gearsug="${e.target.dataset.gearin}"]`); if (ul && !ul.contains(document.activeElement)) ul.hidden = true; }, 150);
  });
  root.addEventListener('keydown', e => {
    const t = e.target;
    if (t.dataset && t.dataset.gearin !== undefined && e.key === 'Enter') {
      e.preventDefault();
      const i = +t.dataset.gearin, typed = t.value.trim().toUpperCase();
      const first = cartEl.querySelector(`[data-gearsug="${i}"] [data-gearpick]`);
      addNumber(i, available(cart.items[i].kind).some(x => x.id === typed) ? typed : (first ? first.dataset.gearpick.split(':')[1] : typed));
    }
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset && t.dataset.gearin !== undefined) { showNumbers(+t.dataset.gearin, t.value); return; }
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
    const noNumbers = cart.items.find(it => it.gear && !it.gear.length);
    if (noNumbers) { say(`Pick the ${noNumbers.kind} number${noNumbers.kind === 'mask' ? 's' : ''} for ${noNumbers.name}.`); cartEl.querySelector(`[data-gearin="${cart.items.indexOf(noNumbers)}"]`)?.focus(); return; }
    if (cart.items.some(it => it.gear) && cart.guests.length > 1) { say('Rent masks and bikes for one guest at a time.'); return; }
    if (!cart.payment) { say('Choose how the guest pays.'); return; }
    btn.disabled = true;
    try {
      const lines = [];
      for (const it of cart.items) for (const g of cart.guests) {
        if (it.gear) {
          for (const num of it.gear) lines.push({ ts: await nextTs(), guest: g, category: it.category, object: it.name, qty: it.qty, unit: it.unit, unitCost: it.unitCost, gear: num, comment: [num, cart.comment.trim()].filter(Boolean).join(' · ') });
          continue;
        }
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
  const isSupply = l.object === 'Cash Supply';
  const isSpend = isExp && l.comment !== 'Refunding' && !isSupply; // a daily expense, not a refund
  const amount = isExp ? -(l.cost || 0) : (l.total || 0);
  const edit = canChange(l, d.user, d.shift) && !isSupply && (!isExp || isSpend); // refund lines and cash supply: delete only
  const del = canChange(l, d.user, d.shift);
  const ref = canRefund(l, d.user, d.shift);
  // A mask or bike rental: the quantity is a number of days (whole).
  const isGear = !!(d.gear && d.gear.product && l.type === 'Income' && [d.gear.product.mask, d.gear.product.bike].some(n => sameName(n, l.object)));
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
      <label>${isGear ? 'Days' : 'Qty'} <input name="qty" inputmode="${isGear ? 'numeric' : 'decimal'}"${isGear ? ' data-whole="1"' : ''} value="${esc(l.qty ?? '')}"${l.qty == null ? ' placeholder="—"' : ''}${l.bill ? ' disabled title="On a partner bill"' : ''}></label>
      <label>Price per unit <span class="moneyin"><span class="cur">Rp</span><input name="unit" inputmode="numeric" value="${money(l.unit || 0)}"${l.bill ? ' disabled title="On a partner bill"' : ''}></span></label>
      <label>Payment <select name="payment">${[...new Set([l.payment, ...d.payments])].map(p => `<option${p === l.payment ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label>Guest <input name="guest" value="${esc(l.guest)}"></label>
      <label class="grow">Comment <input name="comment" value="${esc(l.comment === 'Refunded' ? '' : l.comment)}"${l.comment === 'Refunded' ? ' disabled' : ''}></label>
      <div class="row"><button class="primary small" type="submit">Save</button><button class="ghost small" type="button" data-cancel>Cancel</button></div>
      <p class="error" role="alert"></p></form>`;
  } else if (ui.deleting === l.ts) {
    extra = `<div class="inline warn"><span>${isSupply ? 'Delete this cash supply (both of its lines) from the sheet?' : 'Delete this line from the sheet?'}</span>
      <button class="danger small" type="button" data-delok="${esc(l.ts)}">Delete</button><button class="ghost small" type="button" data-cancel>Keep</button></div>`;
  } else if (ui.refunding === l.ts) {
    extra = `<form class="inline" data-refform="${esc(l.ts)}">
      <label>Amount to give back <span class="moneyin"><span class="cur">Rp</span><input name="amount" inputmode="numeric" value="${money(l.total)}"></span></label>
      <label>Paid back by <select name="payment">${d.payments.filter(p => p !== 'Unpaid' && (p !== 'Paid to Partner' || l.payment === p)).map(p => `<option${p === l.payment ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label class="grow">Reason <em class="reqif">required if not paid back by ${esc(payLabel(l.payment))}</em><input name="reason" maxlength="300" placeholder="Why the refund"></label>
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
    <span class="what"><b>${esc(isSpend ? expenseLabel(l.object) : l.object.replace(/^-/, ''))}</b>${l.qty && l.qty !== 1 ? ` ×${esc(l.qty)}` : ''}<span class="who">${isSupply ? (isExp ? 'Taken from outside the desk' : 'Put in the box') : isSpend ? 'Expense' : esc(l.guest)}</span></span>
    <span class="tags">${tags}${status}</span>
    <span class="amt num">${amount < 0 ? '−' : ''}${money(Math.abs(amount))}</span>
    <span class="acts">${edit ? `<button class="link" type="button" data-edit="${esc(l.ts)}">Edit</button>` : ''}${del ? `<button class="link" type="button" data-del="${esc(l.ts)}">Delete</button>` : ''}${ref ? `<button class="link" type="button" data-refund="${esc(l.ts)}">Refund</button>` : ''}</span>
    ${l.comment && !['Refunded', 'Refunding'].includes(l.comment) ? `<span class="note">${esc(l.comment)}</span>` : ''}
    ${extra}</li>`;
}

/** The other line of a cash supply: same author, other side, recorded within the same second. */
function supplyPartner(lines, l) {
  return lines.find(x => x !== l && x.ts !== l.ts && x.object === 'Cash Supply' && x.type !== l.type && x.author === l.author &&
    Math.abs(Number(x.ts.slice(8)) - Number(l.ts.slice(8))) < 1000 && x.ts.slice(0, 8) === l.ts.slice(0, 8));
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
      // A cash supply is two lines (Cash in, Extern Cash out): they go together.
      const pair = l && l.object === 'Cash Supply' ? supplyPartner(d.lines, l) : null;
      if (pair) await enqueue('line_delete', { ts: pair.ts });
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
      const fixed = !!l.bill; // on a partner bill: quantity and price stay as billed
      if (!fixed && qty !== null && !(qty > 0 && qty <= 1000)) { err.textContent = 'Enter a quantity above 0 and up to 1000.'; return; }
      if (!fixed && f.qty.dataset.whole && qty !== null && !(Number.isInteger(qty) && qty >= 1)) { err.textContent = 'Days of a rental: a whole number (1, 2, 3…).'; return; }
      if (!fixed && (!unit || unit > 1e9)) { err.textContent = 'Enter the price.'; return; }
      if (!guest) { err.textContent = 'Enter the guest.'; return; }
      const change = {};
      if (!fixed && qty !== null && qty !== l.qty) change.qty = qty;
      if (!fixed && unit !== l.unit) change.unit = unit;
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
      const payBack = f.payment.value;
      if (payBack !== l.payment && !f.reason.value.trim()) { err.textContent = `Say why it is not paid back by ${payLabel(l.payment)} (e.g. card refund no longer possible).`; f.reason.focus(); return; }
      btn.disabled = true;
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
// Small "?" that shows the Beds24 rules on hover, focus or tap.
function helpTip(label, items) {
  return `<span class="help" tabindex="0" role="button" aria-label="${esc(label)}">?<span class="help-pop" role="tooltip"><b>${esc(label)}</b><ul>${items.map(t => `<li>${t}</li>`).join('')}</ul></span></span>`;
}
const BEDS24_RULES = [
  '<b>New night or extension</b> → always in Beds24.',
  '<b>Guest pays right away</b> (new night or extension) → record the payment in Beds24 only, and pick how they paid. It comes here by itself.',
  '<b>Guest pays later</b> → record it here only (Guest bills). It goes to Beds24 by itself.',
  'Room nights not paid appear here as <b>Unpaid</b> from the check-in day.',
  '<b>Walk-in guest</b> (food, sunset boat…) not in Beds24 → <b>+ New guest</b>, then sell in Sell.',
  'Just changed something in Beds24? Press <b>Refresh</b> at the top.',
  '<b>Never change a payment in Beds24.</b> A mistake is fixed here, with a correction.'
];
const PAY_RULES = [
  'Tick what the guest pays now, choose how, then <b>Record payment</b>.',
  'Room payments go to Beds24 by themselves: never record them in Beds24 too.',
  '<b>Never change or delete them in Beds24.</b> Fix mistakes here.'
];
function renderBills(root, d) {
  const { ui } = d;
  const guest = ui.billGuest;
  if (!guest) {
    root.innerHTML = `<section class="card">
      <div class="helprow"><button type="button" class="ghost small" data-newguest aria-expanded="${!!ui.newGuest}">+ New guest</button><span class="grow"></span>Rules with Beds24 ${helpTip('Rules with Beds24', BEDS24_RULES)}</div>
      ${ui.newGuest ? `<form id="newGuestForm" class="inline newguestform">
        <label class="field"><span>New guest (not in Beds24: walk-in, food, sunset boat…)</span><input id="ngName" autocomplete="off" maxlength="60" placeholder="First and last name" value="${esc(ui.newGuestName || '')}"></label>
        <div class="row"><button type="submit" class="primary small">Add guest</button><button type="button" class="ghost small" data-ngcancel>Cancel</button></div>
        <p class="error" role="alert"></p></form>` : ''}
      <label class="field"><span>Find a guest</span><input id="billQ" type="search" autocomplete="off" placeholder="Name" value="${esc(ui.billQuery || '')}"></label>
      <div id="billList"></div></section>`;
    const listEl = root.querySelector('#billList');
    const draw = () => { listEl.innerHTML = billList(d); };
    root.querySelector('#billQ').addEventListener('input', e => { ui.billQuery = e.target.value; draw(); });
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-open]');
      if (b) { ui.billGuest = b.dataset.open; ui.billSel = null; ui.billPay = null; d.render(); return; }
      if (e.target.closest('[data-newguest]')) { ui.newGuest = !ui.newGuest; ui.newGuestName = ''; d.render(); if (ui.newGuest) root.querySelector('#ngName')?.focus(); return; }
      if (e.target.closest('[data-ngcancel]')) { ui.newGuest = false; ui.newGuestName = ''; d.render(); }
    });
    root.querySelector('#ngName')?.addEventListener('input', e => { ui.newGuestName = e.target.value; });
    root.querySelector('#newGuestForm')?.addEventListener('submit', async e => {
      e.preventDefault();
      const err = e.target.querySelector('.error');
      const name = (ui.newGuestName || '').replace(/\s+/g, ' ').trim();
      if (name.length < 2) { err.textContent = 'Type the guest name.'; return; }
      const same = d.guests.find(g => norm(g) === norm(name));
      ui.newGuest = false; ui.newGuestName = '';
      if (same) { ui.billQuery = same; ui.notice = `${same} is already in the list.`; d.render(); return; }
      e.target.querySelector('button[type=submit]').disabled = true;
      await enqueue('guest_add', { name });
      const known = (await db.get('guests')) || [];
      if (!known.includes(name)) await db.set('guests', [...known, name].sort((a, b) => a.localeCompare(b)));
      ui.billQuery = name;
      ui.notice = `Guest added: ${name}. Sell to them in Sell; what they don't pay shows here.`;
      d.render();
    });
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
        return `<li><button type="button" data-open="${esc(g)}"><span>${esc(g)}${u && u.noShow ? ' ' + NOSHOW_BADGE : ''}</span>${u ? `<span class="owes">owes Rp ${money(u.total)}</span>` : ''}</button></li>`;
      }).join('')}</ul>` : '<p class="muted">No guest with that name.</p>';
    } else {
      const list = [...d.unpaid.values()].sort((a, b) => (a.oldest < b.oldest ? -1 : 1));
      body = list.length ? `<h3 class="sub">Open bills</h3><ul class="glist">${list.map(u => `<li><button type="button" data-open="${esc(u.guest)}">
          <span>${esc(u.guest)}${u.noShow ? ' ' + NOSHOW_BADGE : ''}<small>${u.count} item${u.count > 1 ? 's' : ''} since ${lineDay(u.oldest)}</small></span><span class="owes">Rp ${money(u.total)}</span></button></li>`).join('')}</ul>`
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
    ${unpaid.length && !cashRight(d.user, d.shift) ? '<p class="muted">Only the person on shift or a manager can record a payment.</p>' : ''}
    ${unpaid.length && cashRight(d.user, d.shift) ? `<form id="payForm">
      <h3 class="sub">To pay ${helpTip('How to record a payment', PAY_RULES)}</h3>
      <ul class="lines">${unpaid.map(l => `<li class="line sel"><label class="check"><input type="checkbox" data-sel="${esc(l.ts)}"${ui.billSel.has(l.ts) ? ' checked' : ''}>
        <span class="what"><b>${esc(l.object.replace(/^-/, ''))}</b>${isNoShow(l) ? ' ' + NOSHOW_BADGE : ''}${l.qty && l.qty !== 1 ? ` ×${esc(l.qty)}` : ''}<span class="who">${lineDay(l.ts)} ${lineTime(l.ts)}</span></span></label>
        <span style="grid-area: tags; display: flex; gap: 10px; align-items: center">${l.pending ? '<span class="badge wait">Waiting</span>' : ''}<button type="button" class="link" data-lsplit="${esc(l.ts)}" title="Two people pay this line, each their way">Split</button></span>
        <span class="amt num">${money(l.total)}</span></li>`).join('')}</ul>
      <div class="ctotal"><span>Selected</span><b class="num" id="selTotal">Rp ${money(selTotal())}</b></div>
      <div class="pays" role="group" aria-label="Payment">${d.payments.filter(p => p !== 'Unpaid').map(p => `<button type="button" class="pay${ui.billPay === p ? ' on' : ''}" data-bpay="${esc(p)}" aria-pressed="${ui.billPay === p}">${esc(payLabel(p))}</button>`).join('')}</div>
      <button type="submit" class="primary wide">Record payment</button>
      <p class="error" role="alert"></p>
    </form>` : unpaid.length ? '' : '<p class="ok-note">Nothing left to pay.</p>'}
    ${others.length ? `<h3 class="sub">Paid (last 3 weeks)</h3><ul class="lines">${others.map(l => lineRow(l, d, { showDay: true })).join('')}</ul>` : ''}
  </section>`;
  bindLineActions(root, d);
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.back !== undefined) { ui.billGuest = null; ui.billSel = null; ui.billPay = null; d.render(); }
    // owner 12/11: one line paid two ways (500 000 cash + 300 000 card): it becomes two unpaid lines, then each is paid
    if (b.dataset.lsplit) {
      const l = unpaid.find(x => x.ts === b.dataset.lsplit); if (!l) return;
      const typed = prompt(`Split ${l.object.replace(/^-/, '')} · ${money(l.total)}\nAmount of the new line (the rest stays on this line):`, String(Math.round(l.total / 2)));
      if (typed === null) return;
      const a = Math.round(Number(String(typed).replace(/[^\d]/g, '')) || 0);
      if (!(a > 0 && a < l.total)) { alert(`Type an amount between 1 and ${money(l.total - 1)}`); return; }
      (async () => { await enqueue('line_split', { ts: l.ts, newTs: await nextTs(), amount: a });
        ui.notice = `Line split: ${money(a)} + ${money(l.total - a)}. Tick each one and record its payment.`; ui.billSel = null; d.render(); })();
    }
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
const SHIFT_ICONS = ['Cash', 'Credit / Debit Card', 'Transfer/Others', 'Unpaid', 'Paid to Partner'];
function renderShiftLines(root, d) {
  const { ui } = d;
  const mine = shiftLines(d.lines, d.shift);
  const t = totals(mine);
  const rows = (obj, sign) => Object.entries(obj).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<div><dt>${esc(payLabel(k))}</dt><dd class="num">${sign}${money(v)}</dd></div>`).join('');
  // Filter by payment type: the list of Data activities (Payment type), plus any other type found in the lines.
  const types = [...d.payments];
  mine.forEach(l => { if (l.payment && !types.includes(l.payment)) types.push(l.payment); });
  if (ui.shiftPay && !types.includes(ui.shiftPay)) ui.shiftPay = null;
  const count = p => mine.filter(l => l.payment === p).length;
  const shown = ui.shiftPay ? mine.filter(l => l.payment === ui.shiftPay) : mine;
  const sum = obj => Object.values(obj).reduce((a, b) => a + b, 0);
  const ft = totals(shown);
  root.innerHTML = `<section class="card">
    <div class="split">
      <div><h3 class="sub">Sales</h3><dl class="figures compact">${rows(t.income, '') || '<p class="muted">None yet.</p>'}</dl></div>
      <div><h3 class="sub">Paid out</h3><dl class="figures compact">${rows(t.expense, '−') || '<p class="muted">None.</p>'}</dl></div>
    </div>
    <h3 class="sub">Lines in this shift</h3>
    ${mine.length ? `<div class="pays shiftfilter" role="group" aria-label="Show lines paid with">
        <button type="button" class="pay noicon${ui.shiftPay ? '' : ' on'}" data-sfpay="" aria-pressed="${!ui.shiftPay}">All <span class="cnt">${mine.length}</span></button>
        ${types.map(p => `<button type="button" class="pay${SHIFT_ICONS.includes(p) ? '' : ' noicon'}${ui.shiftPay === p ? ' on' : ''}" data-sfpay="${esc(p)}" aria-pressed="${ui.shiftPay === p}"${count(p) ? '' : ' disabled'}>${esc(payLabel(p))} <span class="cnt">${count(p)}</span></button>`).join('')}
      </div>
      ${ui.shiftPay ? `<p class="filtertotal">${esc(payLabel(ui.shiftPay))}: in <b class="num">Rp ${money(sum(ft.income))}</b> · out <b class="num">Rp ${money(sum(ft.expense))}</b></p>` : ''}
      <ul class="lines">${shown.map(l => lineRow(l, d)).join('')}</ul>` : '<p class="muted">Nothing recorded in this shift yet.</p>'}
  </section>`;
  root.querySelector('.shiftfilter')?.addEventListener('click', e => {
    const b = e.target.closest('[data-sfpay]');
    if (!b || b.disabled) return;
    ui.shiftPay = b.dataset.sfpay || null;
    renderShiftLines(root, d);
  });
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
  const mine = shiftLines(d.lines, d.shift).filter(l => l.type === 'Expense' && l.comment !== 'Refunding' && l.object !== 'Cash Supply');
  const minDate = new Date(Date.now() + 8 * 3600000 - 30 * 86400000).toISOString().slice(0, 10);
  const allowed = cashRight(d.user, d.shift);
  root.innerHTML = `<div class="expenses">
    <section class="card">
      <h2>New expense</h2>
      ${allowed ? '' : '<p class="muted">Only the person on shift or a manager can record an expense.</p>'}
      <form id="expForm" novalidate${allowed ? '' : ' hidden'}>
        <fieldset class="field"><legend>What for</legend>
          <div class="eitems">${expenseItems.map(it => `<button type="button" class="eitem ${it.tone}${ex.item === it.object ? ' on' : ''}" data-item="${esc(it.object)}" aria-pressed="${ex.item === it.object}">${esc(it.label)}</button>`).join('')}</div>
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
  if (!allowed) return;
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

// ---------------------------------------------------------------- cash box
// The old Phantom Cash window: phantom cash (change not given yet / money not received
// yet), the list of unsolved ones with "Solved", and Cash Supply.
const pidNew = () => 'P' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6);
const phantomWhen = e => e.ts ? `${lineDay(e.ts)} ${lineTime(e.ts)}` : '';
const signed = n => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;

async function renderCash(root, d) {
  const { ui } = d;
  const box = await cashboxView();
  const users = (await db.get('users')) || [];
  const nameOf = a => (users.find(u => u.author === a || u.username === a) || {}).name || a;
  const allowed = d.user.role !== 'staff' || (d.shift && d.shift.user === d.user.username);
  const ph = ui.phantom = ui.phantom || { kind: null, amount: null, comment: '' };
  const sup = ui.supply = ui.supply || { amount: null };
  const open = box.filter(e => e.type === 'Phantom').sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (ui.solving && !open.some(e => e.key === ui.solving)) ui.solving = null; // solved elsewhere meanwhile
  const inShift = shiftCash(box, d.shift);
  const supplies = shiftLines(d.lines, d.shift).filter(l => l.object === 'Cash Supply' && l.type === 'Income');
  const net = inShift.reduce((s, e) => s + e.diff, 0);
  const typeLabel = { 'Phantom': 'Phantom', 'Phantom Solved': 'Phantom, solved', 'Phantom Salvation': 'Solved' };
  const wait = e => e.pending ? '<span class="badge wait" title="Saved on this computer, not yet in the sheet">Waiting</span>' : '';
  root.innerHTML = `<div class="cashbox">
    <div class="col">
      <section class="card">
        <h2>Phantom cash</h2>
        <p class="muted">Money that is in the box, or missing from it, without a sale or an expense behind it yet.</p>
        ${allowed ? `<form id="phForm" novalidate>
          <div class="kinds">
            <button type="button" class="kind${ph.kind === 'given' ? ' on' : ''}" data-kind="given" aria-pressed="${ph.kind === 'given'}">
              <b>Cash not given</b><small>Change we still owe someone. The box has more.</small></button>
            <button type="button" class="kind${ph.kind === 'received' ? ' on' : ''}" data-kind="received" aria-pressed="${ph.kind === 'received'}">
              <b>Cash not received</b><small>Money someone still owes us. The box has less.</small></button>
          </div>
          <label class="field money"><span>Amount</span>
            <span class="moneybox"><span class="cur">Rp</span><input id="phAmount" inputmode="numeric" autocomplete="off" value="${ph.amount ? money(ph.amount) : ''}"></span></label>
          <label class="field"><span>Who and why</span><input id="phComment" maxlength="300" value="${esc(ph.comment)}" placeholder="e.g. change for Elias, room 3"></label>
          <button class="primary wide" type="submit">Record phantom cash</button>
          <p class="error" role="alert"></p>
        </form>` : '<p class="muted">Only the person on shift or a manager can record cash here.</p>'}
      </section>
      <section class="card">
        <h2>Cash supply</h2>
        <p class="muted">Cash brought to the desk from outside, for change.</p>
        ${allowed ? `<form id="supForm" novalidate>
          <label class="field money"><span>Amount put in the box</span>
            <span class="moneybox"><span class="cur">Rp</span><input id="supAmount" inputmode="numeric" autocomplete="off" value="${sup.amount ? money(sup.amount) : ''}"></span></label>
          ${ui.supplyConfirm ? `<div class="inline warn"><span>Add Rp ${money(sup.amount)} to the box?</span>
            <button class="primary small" type="submit">Add</button><button class="ghost small" type="button" data-supcancel>Cancel</button></div>`
          : '<button class="ghost wide" type="submit">Add cash supply</button>'}
          <p class="error" role="alert"></p>
        </form>` : ''}
        ${supplies.length ? `<ul class="plain">${supplies.map(l => `<li><span>${lineTime(l.ts)}</span><span class="num">+${money(l.total)}</span>${l.pending ? '<span class="badge wait">Waiting</span>' : ''}</li>`).join('')}</ul>` : ''}
      </section>
    </div>
    <div class="col">
      <section class="card">
        <h2>Not solved yet</h2>
        ${open.length ? `<ul class="phantoms">${open.map(e => `<li class="${ui.solving === e.key ? 'open' : ''}">
          <span class="when">${esc(phantomWhen(e))}</span>
          <span class="what"><b>${esc(e.comment || '—')}</b><span class="who">${e.diff > 0 ? 'Cash not given' : 'Cash not received'} · ${esc(nameOf(e.author))}</span></span>
          <span class="amt num">${signed(e.diff)}</span>
          <span class="acts">${wait(e)}${allowed ? `<button class="link" type="button" data-solve="${esc(e.key)}">Solved</button>` : ''}</span>
          ${ui.solving === e.key ? `<div class="inline warn"><span>${e.diff > 0 ? `Rp ${money(e.diff)} given back now?` : `Rp ${money(-e.diff)} received now?`} The box changes by ${signed(-e.diff)}.</span>
            <button class="primary small" type="button" data-solveok="${esc(e.key)}">Yes, solved</button><button class="ghost small" type="button" data-solvecancel>Cancel</button></div>` : ''}
        </li>`).join('')}</ul>` : '<p class="muted">Nothing waiting.</p>'}
      </section>
      <section class="card">
        <h2>In this shift</h2>
        ${inShift.length ? `<ul class="phantoms">${inShift.map(e => `<li>
          <span class="when">${esc(lineTime(e.ts))}</span>
          <span class="what"><b>${esc(e.comment || (e.type === 'Phantom Salvation' ? 'Phantom cash solved' : '—'))}</b><span class="who">${esc(typeLabel[e.type] || e.type)} · ${esc(nameOf(e.author))}</span></span>
          <span class="amt num">${signed(e.diff)}</span><span class="acts">${wait(e)}</span></li>`).join('')}</ul>
          <div class="ctotal"><span>Phantom cash in the box</span><b class="num">${signed(net)}</b></div>` : '<p class="muted">No phantom cash in this shift.</p>'}
      </section>
    </div>
  </div>`;

  root.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.kind) { ph.kind = b.dataset.kind; root.querySelectorAll('[data-kind]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); root.querySelector('#phAmount').focus(); }
    else if (b.dataset.solve) { ui.solving = b.dataset.solve; d.render(); }
    else if (b.dataset.solvecancel !== undefined) { ui.solving = null; d.render(); }
    else if (b.dataset.supcancel !== undefined) { ui.supplyConfirm = false; d.render(); }
    else if (b.dataset.solveok) {
      b.disabled = true;
      const target = open.find(x => x.key === b.dataset.solveok);
      if (target) {
        await enqueue('phantom_solve', { pid: pidNew(), target: target.key });
        ui.notice = `Phantom cash solved: ${target.comment}, box ${signed(-target.diff)}.`;
      }
      ui.solving = null;
      d.render();
    }
  });
  const phf = root.querySelector('#phForm');
  if (phf) {
    const err = phf.querySelector('.error');
    phf.addEventListener('input', e => {
      const t = e.target;
      if (t.id === 'phAmount') { const v = parseMoney(t.value); t.value = v === null ? '' : money(v); ph.amount = v; }
      if (t.id === 'phComment') ph.comment = t.value;
    });
    phf.addEventListener('submit', async e => {
      e.preventDefault();
      if (!ph.kind) { err.textContent = 'Choose cash not given or cash not received.'; return; }
      if (!ph.amount || ph.amount > 1e9) { err.textContent = 'Enter the amount.'; root.querySelector('#phAmount').focus(); return; }
      if (!ph.comment.trim()) { err.textContent = 'Say who it is for and why.'; root.querySelector('#phComment').focus(); return; }
      phf.querySelector('button[type=submit]').disabled = true;
      const payload = { pid: pidNew(), comment: ph.comment.trim() };
      payload[ph.kind === 'given' ? 'notGiven' : 'notReceived'] = ph.amount;
      await enqueue('phantom', payload);
      ui.notice = `Phantom cash recorded: ${ph.kind === 'given' ? 'cash not given' : 'cash not received'}, Rp ${money(ph.amount)}.`;
      ui.phantom = null;
      d.render();
    });
  }
  const sf = root.querySelector('#supForm');
  if (sf) {
    const err = sf.querySelector('.error');
    sf.addEventListener('input', e => {
      if (e.target.id === 'supAmount') { const v = parseMoney(e.target.value); e.target.value = v === null ? '' : money(v); sup.amount = v; ui.supplyConfirm = false; }
    });
    sf.addEventListener('submit', async e => {
      e.preventDefault();
      if (!sup.amount || sup.amount > 1e9) { err.textContent = 'Enter the amount.'; root.querySelector('#supAmount').focus(); return; }
      if (!ui.supplyConfirm) { ui.supplyConfirm = true; d.render(); return; }
      sf.querySelectorAll('button').forEach(x => { x.disabled = true; });
      await enqueue('cash_supply', { ts: await nextTs(), ts2: await nextTs(), amount: sup.amount });
      ui.notice = `Cash supply recorded: Rp ${money(sup.amount)} in the box.`;
      ui.supply = null; ui.supplyConfirm = false;
      d.render();
    });
  }
}

export const cashBusy = ui => !!((ui.phantom && (ui.phantom.amount || ui.phantom.comment)) || (ui.supply && ui.supply.amount) || ui.solving);

// ---------------------------------------------------------------- partners
// The old partner dialogs: pick a partner, tick its sales not billed yet, check the costs,
// create the bill (sent as PDF by the sheet); later "Paid" records the payment to (or from)
// the partner, or the bill is deleted and its lines go back to "not billed".
const shortDate = iso => { if (!iso) return ''; const x = new Date(new Date(iso).getTime() + 8 * 3600000); return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
const partnerName = o => o.replace(/^-/, '');
/** Bill id in the old format, B_dd/MM-HH:mm (reception time), moved on a minute if already used. */
function newBillId(used) {
  let ms = Date.now();
  for (;;) {
    const t = tsFromMs(ms);
    const id = `B_${t.slice(6, 8)}/${t.slice(4, 6)}-${t.slice(8, 10)}:${t.slice(10, 12)}`;
    if (!used.has(id)) return id;
    ms += 60000;
  }
}
function billSections(lines) {
  return [['Paid at the Rabbit Tree', lines.filter(l => l.payment !== 'Paid to Partner')],
    ['Paid by the guest to the partner', lines.filter(l => l.payment === 'Paid to Partner')]].filter(x => x[1].length);
}

async function renderPartners(root, d) {
  const { ui } = d;
  const pv = await partnerView();
  const allowed = d.user.role !== 'staff' || (d.shift && d.shift.user === d.user.username);
  const pending = pv.lines.filter(l => !l.bill);
  const byObj = new Map();
  for (const l of pending) byObj.set(l.object, (byObj.get(l.object) || 0) + 1);
  const groups = new Map();
  for (const it of pv.items) { if (!groups.has(it.group)) groups.set(it.group, []); groups.get(it.group).push(it.object); }
  const bills = new Map();
  for (const l of pv.lines) if (l.bill) { if (!bills.has(l.bill)) bills.set(l.bill, []); bills.get(l.bill).push(l); }
  // One bill can group several partners (e.g. several Wijaya objects): tap each one to add it.
  const pt = ui.partner = ui.partner && ui.partner.objects ? ui.partner : { objects: [], sel: new Set(), cost: {}, confirm: false };
  if (ui.billOpen && !bills.has(ui.billOpen)) ui.billOpen = null;
  pt.objects = pt.objects.filter(o => byObj.has(o));
  const lines = pending.filter(l => pt.objects.includes(l.object));
  const names = pt.objects.map(partnerName).join(' + ');
  const costOf = l => (l.ts in pt.cost ? pt.cost[l.ts] : l.cost); // null while the box is empty
  const chosen = lines.filter(l => pt.sel && pt.sel.has(l.ts));
  const total = chosen.reduce((s, l) => s + billNet({ ...l, cost: costOf(l) || 0 }), 0);
  const missing = chosen.some(l => costOf(l) === null);
  const payTypes = d.payments.filter(p => p !== 'Unpaid' && p !== 'Paid to Partner');
  const lineTable = (ls, editable) => billSections(ls).map(([title, sec]) => `<h4 class="sub">${title}</h4>
    <ul class="plines">${sec.map(l => `<li>
      ${editable ? `<input type="checkbox" data-psel="${esc(l.ts)}"${pt.sel.has(l.ts) ? ' checked' : ''} aria-label="Include ${esc(l.guest)}">` : '<span></span>'}
      <span class="when">${esc(shortDate(l.date))}</span>
      <span class="what"><b>${esc(l.guest)}</b><span class="who">${l.qty && l.qty !== 1 ? `×${esc(l.qty)} · ` : ''}sold ${money(l.price)}${l.payment === 'Paid to Partner' ? ' · guest paid the partner' : ''}${l.pending ? ' · <span class="badge wait">Waiting</span>' : ''}</span></span>
      ${editable ? `<label class="pcost"><span>Cost</span><span class="moneyin"><span class="cur">Rp</span><input inputmode="numeric" data-pcost="${esc(l.ts)}" value="${money(costOf(l))}"></span></label>`
        : `<span class="num">${money(l.cost)}</span>`}
      <span class="amt num">${billNet({ ...l, cost: costOf(l) }) < 0 ? '−' : ''}${money(Math.abs(billNet({ ...l, cost: costOf(l) })))}</span>
    </li>`).join('')}</ul>`).join('');
  const billTotal = ls => ls.reduce((s, l) => s + billNet(l), 0);
  const owe = t => t >= 0 ? `We pay Rp ${money(t)}` : `Partner pays us Rp ${money(-t)}`;

  root.innerHTML = `<div class="partners">
    <section class="card plist">
      <h2>Partners</h2>
      ${[...groups].map(([g, objs]) => `<h3 class="sub">${esc(g)}</h3><div class="pbtns">${objs.map(o => `<button type="button" class="pbtn${pt.objects.includes(o) ? ' on' : ''}" data-pobj="${esc(o)}" aria-pressed="${pt.objects.includes(o)}"${byObj.has(o) ? '' : ' disabled'}>
        <span>${esc(partnerName(o))}</span>${byObj.has(o) ? `<span class="count">${byObj.get(o)}</span>` : ''}</button>`).join('')}</div>`).join('')}
    </section>
    <div class="col">
      <section class="card">
        ${pt.objects.length ? `<h2>${esc(names)} — not billed yet</h2>
          <p class="muted small">${pt.objects.length > 1 ? 'One bill for these partners.' : 'Tap other partners to put them on the same bill.'}</p>
          <div class="row"><button class="link" type="button" data-pall>Select all</button><button class="link" type="button" data-pnone>Unselect all</button></div>
          ${pt.objects.length > 1 ? pt.objects.map(o => `<h3 class="sub pgroup">${esc(partnerName(o))}</h3>${lineTable(lines.filter(l => l.object === o), true)}`).join('') : lineTable(lines, true)}
          <div class="ctotal"><span>${chosen.length} line${chosen.length === 1 ? '' : 's'} · ${total >= 0 ? 'we owe the partner' : 'the partner owes us'}</span><b class="num">Rp ${money(Math.abs(total))}</b></div>
          ${pt.confirm ? `<div class="inline warn"><span>Create the bill for ${esc(names)}: ${chosen.length} line${chosen.length === 1 ? '' : 's'}, ${esc(owe(total))}? The PDF is emailed as before.</span>
            <button class="primary small" type="button" data-pcreate>Create bill</button><button class="ghost small" type="button" data-pcancel>Cancel</button></div>`
            : `<button class="primary wide" type="button" data-preview${chosen.length ? '' : ' disabled'}>Create bill</button>`}
          <p class="error" role="alert"></p>`
        : '<h2>Choose a partner</h2><p class="muted">Partners with sales not billed yet have a number.</p>'}
      </section>
      <section class="card">
        <h2>Bills waiting for payment</h2>
        ${bills.size ? `<ul class="billlist">${[...bills].sort((a, b) => (a[1][0].ts < b[1][0].ts ? -1 : 1)).map(([id, ls]) => {
          const t = billTotal(ls), objs = [...new Set(ls.map(l => partnerName(l.object)))].join(', '), open = ui.billOpen === id;
          return `<li class="${open ? 'open' : ''}">
            <button type="button" class="billhead" data-bopen="${esc(id)}" aria-expanded="${open}"><span><b>${esc(objs)}</b><span class="who">${esc(id)} · ${ls.length} line${ls.length === 1 ? '' : 's'}${ls.some(l => l.pending) ? ' · waiting' : ''}</span></span><span class="num">${esc(owe(t))}</span></button>
            ${open ? `<div class="billbody">${lineTable(ls, false)}
              ${ui.billPay === id ? `<div class="inline warn"><span>${esc(owe(t))} — paid with:</span>
                <div class="pays">${payTypes.map(p => `<button type="button" class="pay${ui.billPayType === p ? ' on' : ''}" data-bptype="${esc(p)}">${esc(payLabel(p))}</button>`).join('')}</div>
                <button class="primary small" type="button" data-bpaid="${esc(id)}"${ui.billPayType ? '' : ' disabled'}>Confirm payment</button><button class="ghost small" type="button" data-bcancel>Cancel</button></div>`
              : ui.billDel === id ? `<div class="inline warn"><span>Delete this bill? Its lines go back to “not billed”.</span>
                <button class="danger small" type="button" data-bdelok="${esc(id)}">Delete bill</button><button class="ghost small" type="button" data-bcancel>Keep</button></div>`
              : `<div class="row">${allowed ? `<button class="primary small" type="button" data-bpay="${esc(id)}"${ls.some(l => l.pending) ? ' disabled title="Wait until the bill is in the sheet"' : ''}>Paid…</button>` : ''}
                  <button class="ghost small" type="button" data-bprint="${esc(id)}">Print</button>
                  <button class="link" type="button" data-bdel="${esc(id)}">Delete bill</button></div>`}
            </div>` : ''}
          </li>`;
        }).join('')}</ul>` : '<p class="muted">No bill waiting.</p>'}
      </section>
    </div>
  </div>`;

  const err = root.querySelector('.error');
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.pcost) { const v = parseMoney(t.value); t.value = v === null ? '' : money(v); pt.cost[t.dataset.pcost] = v; pt.confirm = false; }
  });
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.psel) { if (t.checked) pt.sel.add(t.dataset.psel); else pt.sel.delete(t.dataset.psel); pt.confirm = false; d.render(); }
    else if (t.dataset.pcost) d.render();
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pobj) {
      const o = b.dataset.pobj, objLines = pending.filter(l => l.object === o);
      if (pt.objects.includes(o)) { pt.objects = pt.objects.filter(x => x !== o); objLines.forEach(l => pt.sel.delete(l.ts)); }
      else { pt.objects.push(o); objLines.forEach(l => pt.sel.add(l.ts)); }
      pt.confirm = false; d.render();
    }
    else if (b.dataset.pall !== undefined) { pt.sel = new Set(lines.map(l => l.ts)); d.render(); }
    else if (b.dataset.pnone !== undefined) { pt.sel = new Set(); d.render(); }
    else if (b.dataset.preview !== undefined) {
      if (missing) { err.textContent = 'Enter the cost of every ticked line.'; return; }
      pt.confirm = true; d.render();
    }
    else if (b.dataset.pcancel !== undefined) { pt.confirm = false; d.render(); }
    else if (b.dataset.pcreate !== undefined) {
      if (missing) { err.textContent = 'Enter the cost of every ticked line.'; return; }
      b.disabled = true;
      const bill = newBillId(new Set(pv.lines.map(l => l.bill).filter(Boolean)));
      await enqueue('partner_bill', { bill, items: chosen.map(l => ({ ts: l.ts, cost: costOf(l) })) });
      ui.notice = `Bill created for ${names}: ${owe(total)}. The PDF is emailed by the sheet.`;
      ui.partner = null; ui.billOpen = bill;
      d.render();
    }
    else if (b.dataset.bopen) { ui.billOpen = ui.billOpen === b.dataset.bopen ? null : b.dataset.bopen; ui.billPay = ui.billDel = ui.billPayType = null; d.render(); }
    else if (b.dataset.bpay) { ui.billPay = b.dataset.bpay; ui.billPayType = null; d.render(); }
    else if (b.dataset.bptype) { ui.billPayType = b.dataset.bptype; d.render(); }
    else if (b.dataset.bdel) { ui.billDel = b.dataset.bdel; d.render(); }
    else if (b.dataset.bcancel !== undefined) { ui.billPay = ui.billDel = ui.billPayType = null; d.render(); }
    else if (b.dataset.bdelok) {
      b.disabled = true;
      await enqueue('partner_bill_delete', { bill: b.dataset.bdelok });
      ui.notice = `Bill ${b.dataset.bdelok} deleted; its lines are back in “not billed”.`;
      ui.billDel = null; ui.billOpen = null;
      d.render();
    }
    else if (b.dataset.bpaid) {
      b.disabled = true;
      const id = b.dataset.bpaid, ls = bills.get(id);
      const nets = new Map();
      for (const l of ls) nets.set(l.object, (nets.get(l.object) || 0) + billNet(l));
      const rows = [];
      for (const [object, net] of nets) rows.push({ object, ts: await nextTs(), net });
      await enqueue('partner_settle', { bill: id, payment: ui.billPayType, rows });
      ui.notice = `Bill ${id} paid: ${owe(billTotal(ls))}, ${payLabel(ui.billPayType)}.`;
      ui.billPay = ui.billPayType = null; ui.billOpen = null;
      d.render();
    }
    else if (b.dataset.bprint) printBill(b.dataset.bprint, bills.get(b.dataset.bprint), d.user);
  });
}

/** The bill as the old PDF laid it out, printed from the browser. */
function printBill(id, ls, user) {
  const objs = [...new Set(ls.map(l => l.object))];
  let invoiced = 0;
  const body = objs.map(o => {
    let cat = 0;
    const secs = billSections(ls.filter(l => l.object === o)).map(([title, sec]) => {
      const sub = sec.reduce((s, l) => s + billNet(l), 0); cat += sub;
      return `<tr><th colspan="6"><i>${title}</i></th></tr><tr><th>Date</th><th>Qty</th><th>Cost</th><th>Price sold</th><th>Commission</th><th>Guest</th></tr>
        ${sec.map(l => `<tr><td>${esc(shortDate(l.date))}</td><td>${esc(l.qty ?? '')}</td><td>${money(l.cost)}</td><td>${money(l.price)}</td><td>${l.payment === 'Paid to Partner' ? money(billNet(l)) : ''}</td><td>${esc(l.guest)}</td></tr>`).join('')}
        <tr class="sub"><td colspan="6">${title === 'Paid at the Rabbit Tree' ? 'Total cost' : 'Total commission'}: ${money(sub)}</td></tr>`;
    }).join('');
    invoiced += cat;
    return `<tr><th colspan="6">${esc(o)}</th></tr>${secs}<tr class="tot"><td colspan="6">Total of category: ${money(cat)}</td></tr>`;
  }).join('');
  let el = document.getElementById('printArea');
  if (!el) { el = document.createElement('div'); el.id = 'printArea'; document.body.appendChild(el); }
  el.innerHTML = `<h1>Bill (${esc(objs.join(', '))})</h1><p>${esc(id)} · printed by ${esc(user.name)}</p>
    <table>${body}<tr class="inv"><td colspan="6">Total invoiced: Rp ${money(invoiced)}</td></tr></table>
    <p><b><i>Best regards from The Rabbit Tree team!</i></b></p>`;
  window.print();
}

export const partnerBusy = ui => ui.tab === 'partners' && !!((ui.partner && ui.partner.confirm) || ui.billPay || ui.billDel);

// ---------------------------------------------------------------- card terminal
// The old Card Trans. sheet: the terminal's settlement totals against the card payments
// recorded since the previous settlement, minus the bank fee.
const FEE_KEEP = 0.970875, BIG_DIFF = 5000;
const tsLabel = ts => ts ? `${ts.slice(6, 8)}/${ts.slice(4, 6)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}` : '';

async function renderCard(root, d) {
  const { ui } = d;
  const last = await lastSettlementView();
  const lines = cardLines(d.lines, last && last.ts);
  const card = lines.reduce((s, l) => s + cardAmount(l), 0);
  const allowed = d.user.role !== 'staff' || (d.shift && d.shift.user === d.user.username);
  const cs = ui.card = ui.card || { s1: null, s2: null, local: null, comment: '', sure: false };
  const calc = () => {
    const total = (cs.s1 || 0) + (cs.s2 || 0);
    const net = total * FEE_KEEP + (cs.local || 0);
    return { total, net, diff: card - net };
  };
  const field = (id, label, v, hint = '') => `<label class="field money"><span>${label}</span>
    <span class="moneybox"><span class="cur">Rp</span><input id="${id}" inputmode="numeric" autocomplete="off" value="${v ? money(v) : ''}"></span>${hint ? `<small>${hint}</small>` : ''}</label>`;
  root.innerHTML = `<div class="cashbox">
    <div class="col">
      <section class="card">
        <h2>Card terminal settlement</h2>
        <p class="muted">${last ? `Previous settlement ${esc(tsLabel(last.ts))}${last.pending ? ' (waiting to be sent)' : ''}.` : 'No previous settlement found.'} Settle the terminal, then type its totals.</p>
        ${allowed ? `<form id="cardForm" novalidate>
          ${field('cs1', 'Settlement 1', cs.s1)}
          ${field('cs2', 'Settlement 2', cs.s2, 'Only if the terminal printed a second settlement.')}
          ${field('clocal', 'Local card transactions', cs.local, 'Local cards have no 3% fee: name the guests in the comment.')}
          <label class="field"><span>Comment <em>optional</em></span><input id="ccomment" maxlength="300" value="${esc(cs.comment)}"></label>
          <dl class="figures compact" id="cardFig"></dl>
          <p class="diff" id="cardDiff" hidden></p>
          <button class="primary wide" type="submit">Send settlement</button>
          <p class="error" role="alert"></p>
        </form>` : '<p class="muted">Only the person on shift or a manager can send the settlement.</p>'}
      </section>
    </div>
    <div class="col">
      <section class="card">
        <h2>Card payments since then</h2>
        ${lines.length ? `<ul class="plain">${lines.map(l => `<li><span>${esc(tsLabel(l.ts))}</span><span>${esc(l.type === 'Income' ? l.guest : 'Expense ' + l.object)}</span><span class="num">${cardAmount(l) < 0 ? '−' : ''}${money(Math.abs(cardAmount(l)))}</span>${l.pending ? '<span class="badge wait">Waiting</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">No card payment since the previous settlement.</p>'}
        <div class="ctotal"><span>Card total in the sheet</span><b class="num">Rp ${money(card)}</b></div>
      </section>
    </div>
  </div>`;
  const f = root.querySelector('#cardForm');
  if (!f) return;
  const err = f.querySelector('.error');
  const show = () => {
    const c = calc();
    f.querySelector('#cardFig').innerHTML = `<div><dt>Total settlement</dt><dd class="num">${money(c.total)}</dd></div>
      <div><dt>Minus 3% fee${cs.local ? ' + local cards' : ''}</dt><dd class="num">${money(c.net)}</dd></div>`;
    const el = f.querySelector('#cardDiff');
    el.hidden = !(cs.s1 || cs.s2 || cs.local);
    const r = Math.round(c.diff);
    el.textContent = Math.abs(r) <= BIG_DIFF ? `Difference ${r < 0 ? '−' : ''}${money(Math.abs(r))}: OK` : `Difference ${r < 0 ? '−' : ''}${money(Math.abs(r))}: more than 5.000. Check your operations first.`;
    el.dataset.tone = Math.abs(r) <= BIG_DIFF ? 'ok' : 'less';
    const btn = f.querySelector('button[type=submit]');
    btn.textContent = cs.sure ? 'Send anyway (manager agreed)' : 'Send settlement';
  };
  show();
  f.addEventListener('input', e => {
    const t = e.target, key = { cs1: 's1', cs2: 's2', clocal: 'local' }[t.id];
    if (key) { const v = parseMoney(t.value); t.value = v === null ? '' : money(v); cs[key] = v; cs.sure = false; }
    if (t.id === 'ccomment') cs.comment = t.value;
    err.textContent = '';
    show();
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const c = calc();
    if (!cs.s1 && !cs.s2 && !cs.local && card) { err.textContent = 'Type the settlement total printed by the terminal.'; return; }
    if (Math.abs(c.diff) > BIG_DIFF && !cs.sure) {
      cs.sure = true; show();
      err.textContent = 'The difference is over 5.000. Send anyway only if you decided it with your manager: the managers get an alert.';
      return;
    }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await enqueue('card_settlement', { cid: 'C' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6),
        s1: cs.s1 || 0, s2: cs.s2 || 0, local: cs.local || 0, comment: cs.comment.trim(), cardTotal: card });
    } catch (x) { err.textContent = x.message; btn.disabled = false; return; }
    ui.notice = `Card settlement sent: difference ${money(Math.round(c.diff))}.`;
    ui.card = null;
    d.render();
  });
}
export const cardBusy = ui => ui.tab === 'card' && !!(ui.card && (ui.card.s1 || ui.card.s2 || ui.card.local || ui.card.comment));
