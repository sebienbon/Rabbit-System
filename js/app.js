import { db } from './db.js';
import { CONFIG } from './config.js';
import { login, logout, currentUser, isRegistered } from './auth.js';
import { startSync, onStatus, pushNow, pullNow, dismissRejected } from './sync.js';
import { currentShift, cashInBoxBeforeOpening, expectedCash, openShift, closeShift, canClose, reconcile, money, parseMoney } from './shift.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
const dayTime = iso => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

const ui = { user: null, pickedUser: null, typedUser: false, closing: null, notice: null, busy: false };
const main = () => $('#main');

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
    (s.rejected ? `<a href="#attention" class="attn">${s.rejected} need${s.rejected === 1 ? 's' : ''} attention</a>` : '');
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
    const btn = f.querySelector('button.primary'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      ui.user = await login(u, p, { register: !!$('#reg')?.checked });
      ui.pickedUser = null; ui.typedUser = false;
      if (ui.user.mode === 'online') { btn.textContent = 'Loading…'; await pullNow(); await reconcile(); pushNow(); }
      render();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      btn.disabled = false; btn.textContent = 'Log in';
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

  if (ui.notice) html += `<div class="notice" role="status">${esc(ui.notice)}</div>`;
  ui.notice = null;

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
  html += `<section class="card shift">
    <div class="shifthead">
      <h2>${mine ? 'Your shift is open' : `${esc(shift.userName && shift.userName !== shift.user ? shift.userName : nameOf(shift.user))}'s shift is open`}</h2>
      <span class="since">since ${esc(dayTime(shift.openedAt))}</span>
    </div>
    <dl class="figures">
      <div><dt>Opening cash</dt><dd class="num">Rp ${money(shift.openingCash)}</dd></div>
      <div><dt>Cash sales and expenses</dt><dd class="num muted">Rp ${money(expected - shift.openingCash)}</dd></div>
      <div class="total"><dt>Should be in the box</dt><dd class="num">Rp ${money(expected)}</dd></div>
    </dl></section>`;

  if (!canClose(ui.user, shift)) {
    html += `<section class="card"><p>Only ${esc(nameOf(shift.user))} or a manager can close this shift.</p></section>`;
    main().innerHTML = html + attention(rejected);
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
    $('#cancelClose').onclick = () => { ui.closing = null; render(); };
    $('#confirmClose').onclick = async () => {
      $('#confirmClose').disabled = true;
      try {
        const closed = await closeShift(ui.user, shift, c);
        ui.closing = null;
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
      ${moneyField('cash', 'Cash counted in the box')}
      ${moneyField('cashout', 'Cash taken out', 'Money you remove from the box and hand over. Leave empty if none.')}
      <p class="diff" id="diff" hidden></p>
      <label class="field"><span>Comment <em>optional</em></span><input id="comment" maxlength="300"></label>
      <button class="primary" type="submit">Review and close</button>
    </form></section>`;
  main().innerHTML = html + attention(rejected);
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

function showError(root, err) {
  let p = root.querySelector('.error');
  if (!p) { p = document.createElement('p'); p.className = 'error'; p.setAttribute('role', 'alert'); root.appendChild(p); }
  p.textContent = err.message || String(err);
}

function attention(rejected) {
  if (!rejected.length) return '';
  const label = { shift_open: 'Open shift', shift_close: 'Close shift' };
  return `<section class="card attention" id="attention">
    <h2>Refused by the sheet</h2>
    <p class="muted">These were saved here but the sheet did not accept them. Tell a manager, then dismiss.</p>
    <ul>${rejected.map(r => `<li><div><b>${esc(label[r.type] || r.type)}</b> by ${esc(r.by)}, ${esc(dayTime(r.at))}<br><span class="why">${esc(r.message || r.error)}</span></div>
      <button class="ghost small" data-dismiss="${esc(r.id)}">Dismiss</button></li>`).join('')}</ul></section>`;
}
function bindAttention() {
  main().querySelectorAll('[data-dismiss]').forEach(b => b.onclick = async () => { await dismissRejected(b.dataset.dismiss); render(); });
}

// ---------- shell ----------
async function render() {
  if (!ui.user) { await renderLogin(); return; }
  $('#who').innerHTML = `<span>${esc(ui.user.name)}${ui.user.role !== 'staff' ? ` <em>${esc(ui.user.role)}</em>` : ''}</span>
    <button class="ghost small" id="logout">Log out</button>`;
  $('#logout').onclick = async () => { await logout(); ui.user = null; ui.closing = null; render(); };
  await renderShift();
}

// Refresh the screen after a sync, unless the person is halfway through typing.
async function afterSync() {
  await reconcile();
  if (!ui.user || ui.closing) return;
  const typing = [...document.querySelectorAll('main form input:not([type=hidden])')].some(i => i.value !== '');
  if (!typing) render();
}

async function boot() {
  onStatus(renderStrip);
  onStatus((s, evt) => { if (evt && (evt.pulled || evt.pushed)) afterSync(); });
  ui.user = await currentUser();
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
        if (typing || ui.closing) setTimeout(reloadWhenIdle, 10000); else location.reload();
      };
      reloadWhenIdle();
    });
  }
}
boot();
