import { db } from './db.js';
import { CONFIG } from './config.js';
import { login, logout, currentUser, isRegistered } from './auth.js';
import { startSync, onStatus, pushNow, pullNow, dismissRejected } from './sync.js';
import { currentShift, cashInBoxBeforeOpening, expectedCash, cashMovements, openShift, closeShift, canClose, reconcile, money, parseMoney } from './shift.js';
import { renderWork, workTabs, cartBusy as saleBusy, expenseBusy, cashBusy, partnerBusy, cardBusy } from './work.js';
import { barBusy } from './bar.js'; // TEMPORARY (bar cash-out)
import { gearBusy, gearAlerts } from './gear.js';
import { gearView, checkDue, notifyOnce } from './gearcore.js';
const cartBusy = ui => saleBusy(ui) || expenseBusy(ui) || cashBusy(ui) || partnerBusy(ui) || cardBusy(ui) || barBusy(ui) || gearBusy(ui);

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
const dayTime = iso => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

const ui = { user: null, pickedUser: null, typedUser: false, closing: null, notice: null, busy: false, tab: 'sell' };
const main = () => $('#main');
let noticeShown = null; // { text, until }
function currentNotice() {
  if (ui.notice) { noticeShown = { text: ui.notice, until: Date.now() + 8000 }; ui.notice = null; setTimeout(() => { if (noticeShown && noticeShown.until <= Date.now()) main().querySelector('.notice')?.remove(); }, 8100); }
  return noticeShown && noticeShown.until > Date.now() ? noticeShown.text : null;
}

// ---------- sync strip ----------
function renderStrip(s) {
  const el = $('#sync');
  const n = s.pending;
  const ops = k => `${k} ${k === 1 ? 'operation' : 'operations'}`;
  let tone = 'ok', title, detail = '';
  if (!CONFIG.API_URL) { tone = 'warn'; title = 'Not connected to a sheet yet'; detail = 'Server address missing in config.js'; }
  else if (s.state === 'offline') { tone = 'off'; title = 'Offline'; detail = n ? `${ops(n)} kept on this computer. They will be sent when the Internet is back.` : 'You can keep working. Nothing is waiting.'; }
  else if (s.state === 'expired') { tone = 'warn'; title = 'Login needed to send'; detail = `${ops(n)} waiting. ${s.message}`; }
  else if (s.state === 'error') { tone = 'warn'; title = 'Sheet not reachable'; detail = `${s.message} Retrying automatically.`; }
  else if (s.state === 'sending' || n) { tone = 'busy'; title = 'Sending'; detail = `${ops(n)} on the way to the sheet.`; }
  else { title = 'Connected'; detail = s.lastSync ? `Everything is in the sheet. Last check ${time(s.lastSync)}.` : 'Everything is in the sheet.'; }
  el.dataset.tone = tone;
  el.innerHTML = `<span class="dot" aria-hidden="true"></span><strong>${esc(title)}</strong><span class="detail">${esc(detail)}</span>` +
    (s.rejected ? `<a href="#attention" class="attn">${s.rejected} need${s.rejected === 1 ? 's' : ''} attention</a>` : '') +
    (s.state === 'expired' && ui.user ? '<button type="button" class="ghost small relog" id="relog">Log in again to send</button>' : '');
  // After a restart during a cut, the sheet needs a password once the Internet is back:
  // logging in again keeps everything waiting on this computer and sends it.
  const relog = el.querySelector('#relog');
  if (relog) relog.onclick = async () => {
    const name = ui.user.username;
    await logout(ui.user); ui.user = null; ui.pickedUser = name; ui.typedUser = false;
    ui.notice = 'Type your password: what is waiting will be sent to the sheet.';
    render();
  };
}

// ---------- login ----------
async function renderLogin() {
  const users = (await db.get('users')) || [];
  $('#who').innerHTML = '';
  const picked = ui.pickedUser;
  let body;
  if (!users.length || ui.typedUser) {
    body = `
      <label class="field"><span>Username</span><input id="u" autocomplete="username" autocapitalize="none" required></label>
      <label class="field"><span>Password</span><input id="p" type="password" autocomplete="current-password" required></label>
      <button class="primary" type="submit">Log in</button>
      ${users.length ? '<button type="button" class="link" data-act="tiles">Back to the list</button>' : ''}`;
  } else if (!picked) {
    body = `<p class="lead">Who is at the desk?</p>
      <div class="tiles">${users.map(u => `<button type="button" class="tile" data-user="${esc(u.username)}">
        <span class="initial" aria-hidden="true">${esc(u.name.slice(0, 1).toUpperCase())}</span>
        <span class="tname">${esc(u.name)}</span>${u.role !== 'staff' ? `<span class="trole">${esc(u.role)}</span>` : ''}</button>`).join('')}</div>
      <button type="button" class="link" data-act="typed">Someone else</button>`;
  } else {
    const u = users.find(x => x.username === picked);
    body = `<p class="lead">Hello ${esc(u ? u.name : picked)}</p>
      <input type="hidden" id="u" value="${esc(picked)}">
      <label class="field"><span>Password</span><input id="p" type="password" autocomplete="current-password" required autofocus></label>
      <button class="primary" type="submit">Log in</button>
      <button type="button" class="link" data-act="tiles">Not ${esc(u ? u.name : picked)}?</button>`;
  }
  const registered = await isRegistered();
  const regBox = (!registered && (ui.typedUser || !users.length || picked)) ? `<label class="check"><input type="checkbox" id="reg">
      <span>Make this the reception computer <small>Manager only. Lets the team log in here during Internet cuts.</small></span></label>` : '';
  main().innerHTML = `<form class="card login" id="loginForm" novalidate>
      <h1>Reception</h1>${body.replace('<button class="primary"', regBox + '<button class="primary"')}
      <p class="error" id="loginErr" role="alert">${esc(ui.notice || '')}</p>
    </form>`;
  ui.notice = null;
  const f = $('#loginForm');
  f.addEventListener('click', e => {
    const t = e.target.closest('[data-user],[data-act]');
    if (!t) return;
    if (t.dataset.user) ui.pickedUser = t.dataset.user;
    if (t.dataset.act === 'tiles') { ui.pickedUser = null; ui.typedUser = false; }
    if (t.dataset.act === 'typed') ui.typedUser = true;
    render();
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('#u').value, p = $('#p').value;
    if (!u || !p) { $('#loginErr').textContent = 'Enter your username and password.'; return; }
    const btn = f.querySelector('button.primary');
    // Registering the reception computer is a manager's decision: ask once more.
    if ($('#reg')?.checked && btn.dataset.sure !== '1') {
      btn.dataset.sure = '1'; btn.textContent = 'Yes, make this the reception computer';
      $('#loginErr').textContent = 'This computer will keep the team’s login data for Internet cuts. Untick the box if this is not the reception computer.';
      return;
    }
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      ui.user = await login(u, p, { register: !!$('#reg')?.checked });
      ui.pickedUser = null; ui.typedUser = false;
      if (ui.user.mode === 'online') { btn.textContent = 'Loading…'; await pullNow(); await reconcile(); pushNow(); }
      render();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      btn.disabled = false; btn.textContent = 'Log in'; btn.dataset.sure = '';
      $('#p').value = ''; $('#p').focus();
    }
  });
  (f.querySelector('[autofocus]') || f.querySelector('input:not([type=hidden])'))?.focus();
}

// ---------- shift ----------
function moneyField(id, label, hint = '') {
  return `<label class="field money"><span>${label}</span>
    <span class="moneybox"><span class="cur">Rp</span><input id="${id}" inputmode="numeric" autocomplete="off"></span>
    ${hint ? `<small>${hint}</small>` : ''}</label>`;
}
function bindMoney(root, onChange) {
  root.querySelectorAll('.money input').forEach(inp => inp.addEventListener('input', () => {
    const v = parseMoney(inp.value);
    inp.value = v === null ? '' : money(v);
    onChange();
  }));
}
const diffText = d => d === 0 ? 'Exact' : (d > 0 ? `${money(d)} more than expected` : `${money(-d)} missing`);
const diffTone = d => d === 0 ? 'ok' : (d > 0 ? 'more' : 'less');

async function renderShift() {
  const users = (await db.get('users')) || [];
  const nameOf = un => (users.find(u => u.username === un) || {}).name || un;
  const shift = await currentShift();
  const rejected = await db.all('rejected');
  let html = '';

  const note = currentNotice();
  if (note) html += `<div class="notice" role="status">${esc(note)}</div>`;

  if (!shift) {
    const ref = await cashInBoxBeforeOpening();
    html += `<section class="card">
      <h2>No shift open</h2>
      <p class="muted">Count the cash box before you start.</p>
      <div class="figure"><span>Last recorded in the box</span><b class="num">Rp ${money(ref)}</b></div>
      <form id="openForm" novalidate>
        ${moneyField('cash', 'Cash counted now')}
        <p class="diff" id="diff" hidden></p>
        <label class="field"><span>Comment <em>optional</em></span><input id="comment" maxlength="300"></label>
        <button class="primary" type="submit">Open my shift</button>
      </form></section>`;
    main().innerHTML = html + attention(rejected);
    const f = $('#openForm');
    bindMoney(f, () => {
      const v = parseMoney($('#cash').value), d = $('#diff');
      d.hidden = v === null; if (v === null) return;
      d.textContent = diffText(v - ref); d.dataset.tone = diffTone(v - ref);
    });
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const v = parseMoney($('#cash').value);
      if (v === null) { $('#cash').focus(); $('#diff').hidden = false; $('#diff').textContent = 'Enter the cash you counted.'; $('#diff').dataset.tone = 'less'; return; }
      const btn = f.querySelector('button.primary'); btn.disabled = true;
      try {
        await openShift(ui.user, v, $('#comment').value.trim());
        ui.notice = `Shift opened at ${time(new Date().toISOString())}.`;
        render();
      } catch (err) { showError(f, err); btn.disabled = false; }
    });
    $('#cash').focus();
    bindAttention();
    return;
  }

  const mine = shift.user === ui.user.username;
  const expected = await expectedCash(shift);
  const { phantom } = await cashMovements(shift);
  const wt = await workTabs({ ui, user: ui.user, shift });
  const gear = await gearView();
  const ga = gearAlerts(gear);
  const tabs = [['sell', 'Sell'], ['bills', 'Guest bills', wt.counts.bills], ['expenses', 'Expenses', wt.counts.expenses], ['cash', 'Cash box', wt.counts.cash], ['partners', 'Partners', wt.counts.partners], ['card', 'Card'], ['bar', 'Bar cash-out'], /* TEMPORARY (bar cash-out) */ ['gear', 'Gear', ga.diffs + ga.late], ['shift', 'This shift', wt.counts.shift], ['close', 'Close shift']];
  html += `<section class="card shift">
    <div class="shifthead">
      <h2>${mine ? 'Your shift' : `${esc(shift.userName && shift.userName !== shift.user ? shift.userName : nameOf(shift.user))}'s shift`}</h2>
      <span class="since">since ${esc(dayTime(shift.openedAt))}</span>
    </div>
    <dl class="figures row4">
      <div><dt>Opening cash</dt><dd class="num">${money(shift.openingCash)}</dd></div>
      <div><dt>Cash in</dt><dd class="num">${money(wt.totals.cashIn)}</dd></div>
      <div><dt>Cash paid out</dt><dd class="num">${money(wt.totals.cashOut)}</dd></div>
      <div class="total"><dt>Should be in the box</dt><dd class="num">Rp ${money(expected)}</dd>${phantom ? `<small class="muted phnote">incl. phantom cash ${phantom < 0 ? '−' : '+'}${money(Math.abs(phantom))}</small>` : ''}</div>
    </dl>
    <nav class="tabs" role="tablist">${tabs.map(([k, label, n]) => `<button type="button" role="tab" aria-selected="${ui.tab === k}" data-tab="${k}">${label}${n ? `<span class="count">${n}</span>` : ''}</button>`).join('')}</nav>
  </section>`;
  html += gearBanner(gear, ga);

  if (ui.tab !== 'close') {
    // Built off-screen first, so the tab never shows empty while its data loads.
    const work = document.createElement('div');
    work.id = 'work';
    await renderWork(work, { ui, user: ui.user, shift, render });
    main().innerHTML = html + '<div id="work"></div>' + attention(rejected);
    $('#work').replaceWith(work);
    bindTabs();
    bindAttention();
    (work.querySelector('[autofocus]'))?.focus();
    return;
  }

  if (!canClose(ui.user, shift)) {
    html += `<section class="card"><p>Only ${esc(nameOf(shift.user))} or a manager can close this shift.</p></section>`;
    main().innerHTML = html + attention(rejected);
    bindTabs();
    bindAttention();
    return;
  }

  if (ui.closing) {
    const c = ui.closing;
    html += `<section class="card confirm">
      <h2>Close the shift?</h2>
      <dl class="figures">
        <div><dt>Counted in the box</dt><dd class="num">Rp ${money(c.cashCounted)}</dd></div>
        <div><dt>Taken out (cashout)</dt><dd class="num">Rp ${money(c.cashout)}</dd></div>
        <div class="total"><dt>Difference</dt><dd class="num" data-tone="${diffTone(c.diff)}">${esc(diffText(c.diff))}</dd></div>
      </dl>
      ${c.comment ? `<p class="muted">Comment: ${esc(c.comment)}</p>` : ''}
      <div class="row"><button class="primary" id="confirmClose">Close shift</button><button class="ghost" id="cancelClose">Change the numbers</button></div>
    </section>`;
    main().innerHTML = html + attention(rejected);
    bindTabs();
    $('#cancelClose').onclick = () => { ui.closing = null; render(); };
    $('#confirmClose').onclick = async () => {
      $('#confirmClose').disabled = true;
      try {
        const closed = await closeShift(ui.user, shift, c);
        ui.closing = null; ui.tab = 'sell';
        ui.notice = `Shift closed. ${diffText(closed.difference)}.`;
        render();
      } catch (err) { showError($('.confirm'), err); $('#confirmClose').disabled = false; }
    };
    $('#confirmClose').focus();
    bindAttention();
    return;
  }

  html += `<section class="card"><h2>Close the shift</h2>
    <form id="closeForm" novalidate>
      ${gear && !gear.countedToday && new Date(Date.now() + 8 * 3600000).getUTCHours() >= 17 ? `<p class="phwarn">The gear evening check is not done today. Ask the gear staff to do it in their app before you leave.</p>` : ''}
      ${phantom ? `<p class="phwarn">Phantom cash of this shift is included: ${phantom < 0 ? '−' : '+'}${money(Math.abs(phantom))}. Count only the cash really in the box.</p>` : ''}
      ${moneyField('cash', 'Cash counted in the box')}
      ${moneyField('cashout', 'Cash taken out', 'Money you remove from the box and hand over. Leave empty if none.')}
      <p class="diff" id="diff" hidden></p>
      <label class="field"><span>Comment <em>optional</em></span><input id="comment" maxlength="300"></label>
      <button class="primary" type="submit">Review and close</button>
    </form></section>`;
  main().innerHTML = html + attention(rejected);
  bindTabs();
  const f = $('#closeForm');
  const calc = () => {
    const v = parseMoney($('#cash').value), out = parseMoney($('#cashout').value) || 0, d = $('#diff');
    d.hidden = v === null; if (v === null) return null;
    const diff = v + out - expected;
    d.textContent = diffText(diff); d.dataset.tone = diffTone(diff);
    return { cashCounted: v, cashout: out, diff };
  };
  bindMoney(f, calc);
  f.addEventListener('submit', e => {
    e.preventDefault();
    const r = calc();
    if (!r) { $('#cash').focus(); return; }
    ui.closing = { ...r, comment: $('#comment').value.trim() };
    render();
  });
  bindAttention();
}

function bindTabs() {
  main().querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    ui.tab = b.dataset.tab; ui.closing = null; ui.editing = ui.deleting = ui.refunding = ui.solving = null; ui.supplyConfirm = false; ui.billPay = ui.billDel = ui.billPayType = null;
    if (!expenseBusy(ui)) ui.expense = null;
    render();
  });
}

function showError(root, err) {
  let p = root.querySelector('.error');
  if (!p) { p = document.createElement('p'); p.className = 'error'; p.setAttribute('role', 'alert'); root.appendChild(p); }
  p.textContent = err.message || String(err);
}

function attention(rejected) {
  if (!rejected.length) return '';
  const label = { shift_open: 'Open shift', shift_close: 'Close shift', sale: 'Sale', line_update: 'Change', line_delete: 'Delete', settle: 'Bill payment', refund: 'Refund', expense: 'Expense' };
  const what = r => {
    const p = r.payload || {};
    if (r.type === 'sale') return (p.lines || []).map(l => `${l.object.replace(/^-/, '')} for ${l.guest}`).slice(0, 3).join(', ') + ` (${p.payment})`;
    if (r.type === 'expense') return `${p.object}: Rp ${money(p.amount)} (${p.payment})`;
    return '';
  };
  return `<section class="card attention" id="attention">
    <h2>Refused by the sheet</h2>
    <p class="muted">These were saved here but the sheet did not accept them. Tell a manager, then dismiss.</p>
    <ul>${rejected.map(r => `<li><div><b>${esc(label[r.type] || r.type)}</b> by ${esc(r.by)}, ${esc(dayTime(r.at))}${what(r) ? `<br>${esc(what(r))}` : ''}<br><span class="why">${esc(r.message || r.error)}</span></div>
      <button class="ghost small" data-dismiss="${esc(r.id)}">Dismiss</button></li>`).join('')}</ul></section>`;
}
function bindAttention() {
  main().querySelectorAll('[data-dismiss]').forEach(b => b.onclick = async () => { await dismissRejected(b.dataset.dismiss); render(); });
}

// ---------- gear reminders ----------
function gearBanner(g, ga) {
  if (!g) return '';
  const due = checkDue(g);
  if (due) notifyOnce('gearcheck', 'Gear evening check', 'The masks and bikes have not been checked today.');
  if (ga.diffs) notifyOnce('geardiff:' + ga.diffs, 'Gear differences', `${ga.diffs} difference${ga.diffs > 1 ? 's' : ''} to solve with the gear staff.`);
  if (!due && !ga.diffs) return '';
  const ask = 'Notification' in window && Notification.permission === 'default'
    ? ' <button type="button" class="ghost small" data-notifyon>Turn on reminders</button>' : '';
  return `<div class="notice gearnote" role="status">${due ? 'Gear evening check not done yet today. ' : ''}${ga.diffs ? `${ga.diffs} gear difference${ga.diffs > 1 ? 's' : ''} to solve. ` : ''}<button type="button" class="ghost small" data-tab="gear">Open Gear</button>${ask}</div>`;
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-notifyon]')) { try { Notification.requestPermission().then(() => render()); } catch { /* unsupported */ } }
});
// The reminder must appear around 20:00 even when nobody touches the screen.
setInterval(() => { if (ui.user && !cartBusy(ui) && !ui.closing) afterSync(); }, 10 * 60000);

// ---------- shell ----------
let rendering = null, renderAgain = false;
function render() {
  if (rendering) { renderAgain = true; return rendering; }
  rendering = (async () => {
    do { renderAgain = false; await renderNow(); } while (renderAgain);
  })().catch(e => console.error(e)).finally(() => { rendering = null; });
  return rendering;
}
async function renderNow() {
  if (!ui.user) { await renderLogin(); return; }
  if (ui.user.role === 'gear') {
    await logout(ui.user); ui.user = null;
    ui.notice = 'Gear staff accounts use the gear app (gear.html), not the reception.';
    await renderLogin(); return;
  }
  $('#who').innerHTML = `<span>${esc(ui.user.name)}${ui.user.role !== 'staff' ? ` <em>${esc(ui.user.role)}</em>` : ''}</span>
    <button class="ghost small" id="logout">Log out</button>`;
  $('#logout').onclick = async () => {
    $('#logout').disabled = true;
    if (ui.user.role !== 'staff') await pushNow(); // send what is waiting before the manager session goes
    await logout(ui.user); ui.user = null; ui.closing = null; ui.cart = null; ui.expense = ui.phantom = ui.supply = ui.solving = ui.partner = ui.billOpen = ui.billPay = ui.billDel = ui.card = ui.bar = null; ui.supplyConfirm = false; ui.tab = 'sell'; ui.billGuest = null; noticeShown = null; render(); };
  const shiftOpen = !!(await currentShift());
  main().classList.toggle('wide', shiftOpen);
  await renderShift();
}

// Refresh the screen after a sync, unless the person is halfway through typing.
async function afterSync() {
  await reconcile();
  if (!ui.user || ui.closing || ui.editing || ui.refunding || ui.deleting) return;
  const active = document.activeElement;
  const typing = (active && active.matches && active.matches('main input, main select, main textarea')) ||
    [...document.querySelectorAll('main form input:not([type=hidden]):not([type=checkbox]):not([type=search])')].some(i => i.value !== '');
  if (typing || cartBusy(ui) || (ui.tab === 'bills' && ui.billGuest)) { refreshFigures(); return; }
  render();
}
/** Only the numbers at the top, when a full refresh would disturb someone mid-task. */
async function refreshFigures() {
  const shift = await currentShift();
  if (!shift) return;
  const wt = await workTabs({ ui, user: ui.user, shift });
  const fig = main().querySelectorAll('.figures.row4 dd');
  if (fig.length === 4) {
    fig[1].textContent = money(wt.totals.cashIn);
    fig[2].textContent = money(wt.totals.cashOut);
    fig[3].textContent = `Rp ${money(await expectedCash(shift))}`;
  }
}

async function boot() {
  onStatus(renderStrip);
  onStatus((s, evt) => { if (evt && (evt.pulled || evt.pushed)) afterSync(); });
  ui.user = await currentUser();
  // Ask the browser to keep this computer's data even when the disk gets full.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* not supported */ }
  await render();
  startSync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(reg => setInterval(() => reg.update().catch(() => {}), 30 * 60000)).catch(() => {});
    // A new version took over: reload once nobody is in the middle of something.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const reloadWhenIdle = () => {
        const typing = [...document.querySelectorAll('main form input:not([type=hidden])')].some(i => i.value !== '');
        if (typing || ui.closing || cartBusy(ui) || ui.editing || ui.refunding) setTimeout(reloadWhenIdle, 10000); else location.reload();
      };
      reloadWhenIdle();
    });
  }
}
boot();
