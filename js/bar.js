// TEMPORARY: bar cash-out. The bar has its own cash; at the end of the day the desk records
// how much was taken out of it. Written in Entries Manual only ("BAR Cash-out"), never in the
// reception box. To remove: delete this file, its import and tab line in js/work.js and
// js/app.js, and the BAR CASH-OUT block in 30.UI_api.gs.
import { db } from './db.js';
import { enqueue } from './sync.js';
import { newerOps, nextTs } from './ledger.js';
import { money, parseMoney } from './shift.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = ts => `${ts.slice(6, 8)}/${ts.slice(4, 6)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`;

async function barView() {
  const [snap, ops] = await Promise.all([db.get('bar'), newerOps()]);
  const byTs = new Map((snap || []).map(b => [b.ts, b]));
  for (const { op, pending } of ops) {
    if (op.type !== 'bar_cashout' || byTs.has(op.payload.ts)) continue;
    byTs.set(op.payload.ts, { ts: op.payload.ts, amount: op.payload.amount, author: op.author, comment: op.payload.comment || '', pending });
  }
  return [...byTs.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

export async function renderBar(root, d) {
  const { ui } = d;
  const list = await barView();
  const allowed = d.user.role !== 'staff' || (d.shift && d.shift.user === d.user.username);
  const bc = ui.bar = ui.bar || { amount: null, comment: '', confirm: false };
  root.innerHTML = `<div class="cashbox">
    <div class="col"><section class="card">
      <h2>Bar cash-out</h2>
      <p class="muted">Cash taken out of the <b>bar</b> cash at the end of the day. It does not change the reception box.</p>
      ${allowed ? `<form id="barForm" novalidate>
        <label class="field money"><span>Amount taken out of the bar</span>
          <span class="moneybox"><span class="cur">Rp</span><input id="barAmount" inputmode="numeric" autocomplete="off" value="${bc.amount ? money(bc.amount) : ''}"></span></label>
        <label class="field"><span>Comment <em>optional</em></span><input id="barComment" maxlength="300" value="${esc(bc.comment)}"></label>
        ${bc.confirm ? `<div class="inline warn"><span>Record a bar cash-out of Rp ${money(bc.amount)}?</span>
          <button class="primary small" type="submit">Record</button><button class="ghost small" type="button" data-barcancel>Cancel</button></div>`
          : '<button class="primary wide" type="submit">Record bar cash-out</button>'}
        <p class="error" role="alert"></p>
      </form>` : '<p class="muted">Only the person on shift or a manager can record it.</p>'}
    </section></div>
    <div class="col"><section class="card">
      <h2>Last bar cash-outs</h2>
      ${list.length ? `<ul class="plain">${list.map(b => `<li><span>${esc(when(b.ts))}</span><span>${esc(b.comment)}</span><span class="num">${money(b.amount)}</span>${b.pending ? '<span class="badge wait">Waiting</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">None in the last two weeks.</p>'}
    </section></div>
  </div>`;
  const f = root.querySelector('#barForm');
  if (!f) return;
  const err = f.querySelector('.error');
  f.addEventListener('input', e => {
    if (e.target.id === 'barAmount') { const v = parseMoney(e.target.value); e.target.value = v === null ? '' : money(v); bc.amount = v; bc.confirm = false; }
    if (e.target.id === 'barComment') bc.comment = e.target.value;
  });
  f.addEventListener('click', e => { if (e.target.closest('[data-barcancel]')) { bc.confirm = false; d.render(); } });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    if (!bc.amount || bc.amount > 1e9) { err.textContent = 'Enter the amount.'; f.querySelector('#barAmount').focus(); return; }
    if (!bc.confirm) { bc.confirm = true; d.render(); return; }
    f.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await enqueue('bar_cashout', { ts: await nextTs(), amount: bc.amount, comment: bc.comment.trim() });
    } catch (x) { err.textContent = x.message; f.querySelectorAll('button').forEach(b => { b.disabled = false; }); return; }
    ui.notice = `Bar cash-out recorded: Rp ${money(bc.amount)}.`;
    ui.bar = null;
    d.render();
  });
}
export const barBusy = ui => ui.tab === 'bar' && !!(ui.bar && (ui.bar.amount || ui.bar.comment));
