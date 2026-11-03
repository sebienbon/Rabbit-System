// Reception tab "Gear": differences found by the gear staff, what is out (late in orange),
// returns at the desk with the late extension, damages to decide, Volunteer outings and
// the day's Sunset Boat. Rentals themselves are made in Sell (the sale picks the numbers).
import { enqueue } from './sync.js';
import { nextTs } from './ledger.js';
import { money, parseMoney } from './shift.js';
import { daysLate, fmtWhen, lastUseText, backBefore } from './gearcore.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = p => p + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6);
const DIFF_TEXT = {
  counted_but_out: 'Counted in the box, but recorded as out',
  returned_not_in_box: 'Recorded as returned, but not in the box',
  missing: 'Never went out, but not in the box',
  sunset_missing: 'Not back from the Sunset Boat',
  rented_while_out: 'Rented at the desk while recorded elsewhere',
  returned_late: 'Returned late to the gear staff',
};
const waText = t => `https://wa.me/?text=${encodeURIComponent(t)}`;

const lateText = ms => { const h = Math.max(1, Math.round(ms / 3600000)); const d = Math.floor(h / 24), r = h % 24; return d ? `${d} day${d > 1 ? 's' : ''}${r ? ` ${r} h` : ''}` : `${h} h`; };

export function gearAlerts(g) {
  if (!g) return { diffs: 0, late: 0 };
  return { diffs: g.diffs.length, late: g.items.filter(i => i.where === 'out' && daysLate(i.back)).length };
}

export async function renderGear(root, d) {
  const { ui } = d;
  const g = d.gear;
  if (!g) { root.innerHTML = '<section class="card"><p class="muted">The gear list (SG sheet) arrives with the next connection to the sheet.</p></section>'; return; }
  const allowed = d.user.role !== 'staff' || (d.shift && d.shift.user === d.user.username);
  const gr = ui.gearRet = ui.gearRet || { items: [], cond: {}, noExt: {} };
  const vol = ui.gearVol = ui.gearVol || { items: [], days: 1 };
  const byId = new Map(g.items.map(i => [i.id, i]));
  const out = g.items.filter(i => i.where === 'out' || i.where === 'sunset').sort((a, b) => (a.back || '') < (b.back || '') ? -1 : 1);
  const extPrice = it => (it.kind === 'mask' ? g.ext.mask : g.ext.bike);
  const damagePrice = dm => { const it = byId.get(dm.item); return it && it.kind === 'bike' ? g.prices.Bike : g.prices[dm.condition]; };
  const sunsetOut = g.items.filter(i => i.where === 'sunset').length; // on the boat now
  const sunsetDay = g.trips.reduce((s, t) => s + t.items.length, 0);
  const chips = (list, key) => list.map(id => `<span class="chip">${esc(id)}<button type="button" data-${key}rm="${esc(id)}" aria-label="Remove ${esc(id)}">×</button></span>`).join('');
  const numBox = (key, list, ph) => `<div class="gearpick"><div class="gearbox">${chips(list, key)}<input data-${key}in autocomplete="off" placeholder="${ph}" aria-label="${ph}"></div>
    <ul class="suggest gsug" data-${key}sug role="listbox" hidden></ul></div>`;

  const diffRow = df => {
    const it = byId.get(df.item) || {};
    const late = it.last && it.last.kind === 'rental' ? daysLate(it.back) : 0;
    let acts = '';
    if (df.reception) acts = `<span class="muted">You confirmed · waiting for the gear staff</span>`;
    else if (!allowed) acts = '';
    else if (df.kind === 'returned_late') {
      const unit = extPrice(it), days = df.late || 1;
      // Waive first: the gear staff often record it hours after the guest handed it back.
      const span = df.due && df.returned ? lateText(Date.parse(df.returned) - Date.parse(df.due)) : `${days} day${days > 1 ? 's' : ''}`;
      acts = `<span class="small">Due ${esc(fmtWhen(df.due))} · recorded ${esc(fmtWhen(df.returned))} · <b>${esc(span)} late</b></span>
        <button type="button" class="primary small" data-dfwaive="${esc(df.id)}">Waive it</button>
        ${unit ? `<button type="button" class="ghost small" data-dflate="${esc(df.id)}">Charge ${days} day${days > 1 ? 's' : ''} extension · ${money(days * unit)}</button>` : '<span class="small warnline">No extension price in Gear_Settings</span>'}`
      ;
    } else if (df.kind === 'rented_while_out') {
      acts = `<button type="button" class="primary small" data-dffound="${esc(df.id)}">Checked · it is with the guest</button>`;
    } else if (df.kind === 'counted_but_out') {
      acts = `${late && extPrice(it) ? `<label class="check small"><input type="checkbox" data-dfext="${esc(df.id)}"${ui.dfNoExt && ui.dfNoExt[df.id] ? '' : ' checked'}> charge ${late} day${late > 1 ? 's' : ''} extension · ${money(late * extPrice(it))}</label>` : ''}
        <button type="button" class="primary small" data-dfret="${esc(df.id)}">Returned by guest</button>
        <button type="button" class="ghost small" data-dfsite="${esc(df.id)}">Found on site · no extension</button>`;
    } else if (ui.dfLost === df.id) {
      acts = `<span>Give ${esc(df.item)} up as lost? It leaves the stock and goes to “Damage to decide”.</span>
        <button type="button" class="danger small" data-dflostok="${esc(df.id)}">Lost</button><button type="button" class="ghost small" data-dfcancel>Cancel</button>`;
    } else {
      acts = `<button type="button" class="primary small" data-dffound="${esc(df.id)}">Found it</button>
        <button type="button" class="ghost small" data-dflost="${esc(df.id)}">Still missing → lost</button>
        <span class="muted small">Not solved yet? Leave it: it stays here.</span>`;
    }
    return `<li class="gdiff"><b class="gnum">${esc(df.item)}</b>
      <div><b>${esc(DIFF_TEXT[df.kind] || df.kind)}</b>${df.pending ? ' <span class="badge wait">Waiting</span>' : ''}
        <div class="muted small">Last use: ${esc(lastUseText(df.last))}${df.gear ? ' · gear staff confirmed' : ''}</div></div>
      <div class="gacts">${acts}</div></li>`;
  };
  const dmgRow = dm => {
    const it = byId.get(dm.item) || {};
    const price = damagePrice(dm);
    const f = (ui.dmg = ui.dmg || {})[dm.id] = (ui.dmg[dm.id] || { amount: price || null, guest: dm.guest });
    return `<li class="gdiff"><b class="gnum">${esc(dm.item)}</b>
      <div><b>${esc(dm.condition)}</b>${dm.note ? ` <span class="small">“${esc(dm.note)}”</span>` : ''} <span class="muted small">· ${dm.decision === 'pending' ? 'to decide' : dm.decision === 'charge' ? 'charged' : 'not charged'}</span>${dm.pending ? ' <span class="badge wait">Waiting</span>' : ''}
        <div class="muted small">Last use: ${esc(lastUseText(it.last))}</div></div>
      <div class="gacts">${dm.pending ? '<span class="muted small">Decide once it reached the sheet.</span>' : dm.decision === 'pending' && allowed ? `
        <label class="small">Guest <input data-dmgguest="${esc(dm.id)}" value="${esc(f.guest || '')}" size="12"></label>
        <label class="small">Rp <input data-dmgamt="${esc(dm.id)}" inputmode="numeric" value="${f.amount ? money(f.amount) : ''}" size="8" placeholder="${price ? '' : 'price'}"></label>
        <button type="button" class="primary small" data-dmgcharge="${esc(dm.id)}">Charge guest</button>
        <button type="button" class="ghost small" data-dmgno="${esc(dm.id)}">Don’t charge</button>
        <span class="muted small">or leave it pending</span>`
        : allowed && it.condition !== 'OK' ? `<button type="button" class="ghost small" data-gservice="${esc(dm.item)}">Repaired · back in stock</button>` : ''}</div></li>`;
  };

  const retRows = gr.items.map(id => {
    const it = byId.get(id); if (!it) return '';
    const late = it.last && it.last.kind === 'rental' ? daysLate(it.back) : 0;
    const conds = it.kind === 'bike' ? ['OK', 'Part missing', 'Broken', 'Lost'] : ['OK', 'Snorkel missing', 'Ring missing', 'Broken', 'Lost'];
    return `<div class="gret"><b>${esc(id)}</b><span class="muted small">${esc(it.last ? it.last.guest : '')}</span>
      <select data-retcond="${esc(id)}" aria-label="Condition of ${esc(id)}">${conds.map(c => `<option${(gr.cond[id] || 'OK') === c ? ' selected' : ''}>${c}</option>`).join('')}</select>
      ${late ? (extPrice(it) ? `<label class="check small warnline"><input type="checkbox" data-retext="${esc(id)}"${gr.noExt[id] ? '' : ' checked'}> late ${late} day${late > 1 ? 's' : ''}: extension ${money(late * extPrice(it))} (Unpaid)</label>`
        : '<span class="small warnline">late — no extension price in Gear_Settings</span>') : ''}</div>`;
  }).join('');

  root.innerHTML = `<div class="gearpage">
    ${g.diffs.length ? `<section class="card gcard bad"><h2>Differences to solve together</h2><ul class="gl">${g.diffs.map(diffRow).join('')}</ul>
      <p class="muted small">Closed when the reception and the gear staff both confirm.</p></section>` : ''}
    <div class="ggrid">
      <div class="col">
        <section class="card gcard"><h2>Out now <span class="muted">· ${out.filter(i => i.kind === 'mask').length} masks · ${out.filter(i => i.kind === 'bike').length} bikes</span></h2>
          ${out.length ? `<ul class="gl">${out.map(i => {
            const late = i.where === 'out' ? daysLate(i.back) : 0;
            return `<li class="gout${late ? ' late' : ''}"><b class="gnum">${esc(i.id)}</b>
              <div><b>${esc(i.last ? i.last.guest : '')}</b>${i.pending ? ' <span class="badge wait">Waiting</span>' : ''}
                <div class="small ${late ? 'warnline' : 'muted'}">${i.where === 'sunset' ? 'Sunset Boat · back 21:30' : late ? `Late since ${esc(fmtWhen(i.back))}` : `Back before ${esc(fmtWhen(i.back))}`}</div></div>
              ${late && i.last && i.last.kind === 'rental' ? `<a class="ghost small walink" target="_blank" rel="noopener" href="${waText(`Hello ${i.last.guest}, this is The Rabbit Tree reception. Your ${i.kind === 'mask' ? 'snorkeling mask' : 'bike'} ${i.id} was due back ${fmtWhen(i.back)}. Could you bring it back to the reception? Thank you!`)}">WhatsApp guest</a>` : '<span></span>'}</li>`;
          }).join('')}</ul>` : '<p class="muted">Nothing out.</p>'}
          ${g.trips.length ? `<div class="gsunset"><b>Sunset Boat today</b> · ${sunsetOut} mask${sunsetOut === 1 ? '' : 's'} on the boat now · ${sunsetDay} taken today · ${g.sunsetSales} Sunset Boat guest${g.sunsetSales === 1 ? '' : 's'} in the sales
            ${sunsetDay !== g.sunsetSales ? `<span class="muted small"> · ${Math.abs(sunsetDay - g.sunsetSales)} ${sunsetDay > g.sunsetSales ? 'more' : 'fewer'} mask${Math.abs(sunsetDay - g.sunsetSales) === 1 ? '' : 's'} taken than guests recorded</span>` : ''}</div>` : ''}
        </section>
        ${g.damages.length ? `<section class="card gcard"><h2>Damage to decide</h2><ul class="gl">${g.damages.map(dmgRow).join('')}</ul>
          <p class="muted small">Prices come from the Gear_Settings sheet. Charging adds an Unpaid line to the guest’s bill.</p></section>` : ''}
      </div>
      <div class="col">
        ${allowed ? `<section class="card gcard"><h2>Return</h2>
          ${numBox('ret', gr.items, 'Number returned (mask or bike)')}
          ${retRows}
          <button type="button" class="primary wide" data-retsave${gr.items.length ? '' : ' disabled'}>Record return</button>
          <p class="error" data-reterr role="alert"></p>
        </section>
        <section class="card gcard"><h2>Volunteer</h2>
          <p class="muted small">Free outing without a sale. Back before ${esc(fmtWhen(new Date(backBefore(Date.now(), vol.days)).toISOString()))}.</p>
          ${numBox('vol', vol.items, 'Number going out')}
          <button type="button" class="ghost wide" data-volsave${vol.items.length ? '' : ' disabled'}>Record Volunteer outing</button>
        </section>` : '<section class="card"><p class="muted">Only the person on shift or a manager can record returns.</p></section>'}
        <section class="card gcard"><h2>Evening check</h2>
          <p class="small ${g.countedToday ? 'muted' : 'warnline'}">${g.countedToday ? `Done today${g.lastCount ? ' at ' + esc(fmtWhen(g.lastCount.at).split(' ').pop()) : ''}.` : 'Not done yet today: the gear staff do it in their app around 20:00.'}</p>
        </section>
      </div>
    </div>
  </div>`;

  // ---- number boxes (type or pick from a short list)
  const pools = {
    ret: () => g.items.filter(i => (i.where === 'out' || i.where === 'sunset') && !gr.items.includes(i.id)), // rentals, Volunteer and Sunset Boat
    vol: () => g.items.filter(i => i.where === 'in' && i.condition === 'OK' && !vol.items.includes(i.id)),
  };
  const show = (key, q) => {
    const ul = root.querySelector(`[data-${key}sug]`); if (!ul) return;
    const n = String(q || '').trim().toUpperCase();
    const list = pools[key]().filter(i => !n || i.id.includes(n)).slice(0, 8);
    ul.innerHTML = list.length ? list.map(i => `<li><button type="button" data-${key}pick="${esc(i.id)}">${esc(i.id)} <span class="muted">${esc(key === 'ret' ? (i.where === 'sunset' ? 'Sunset Boat' : i.last ? i.last.guest : '') : i.kind)}</span></button></li>`).join('') : `<li class="muted">${pools[key]().length ? 'No number matches.' : key === 'ret' ? 'Nothing is out right now.' : 'No mask or bike free.'}</li>`;
    ul.hidden = false;
  };
  const add = (key, id) => {
    const hit = pools[key]().find(i => i.id === String(id || '').trim().toUpperCase());
    if (!hit) return;
    (key === 'ret' ? gr : vol).items.push(hit.id);
    d.render();
  };
  for (const key of ['ret', 'vol']) {
    const inp = root.querySelector(`[data-${key}in]`); if (!inp) continue;
    inp.addEventListener('focus', () => show(key, inp.value));
    inp.addEventListener('click', () => show(key, inp.value)); // already focused: open the list again
    inp.addEventListener('input', () => show(key, inp.value));
    inp.addEventListener('blur', () => setTimeout(() => { const ul = root.querySelector(`[data-${key}sug]`); if (ul && !ul.contains(document.activeElement)) ul.hidden = true; }, 150));
    inp.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const typed = inp.value.trim().toUpperCase();
      const first = root.querySelector(`[data-${key}sug] [data-${key}pick]`);
      add(key, pools[key]().some(i => i.id === typed) ? typed : first && first.getAttribute(`data-${key}pick`));
    });
  }

  root.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.retcond) gr.cond[t.dataset.retcond] = t.value;
    if (t.dataset.retext) gr.noExt[t.dataset.retext] = !t.checked;
    if (t.dataset.dfext) (ui.dfNoExt = ui.dfNoExt || {})[t.dataset.dfext] = !t.checked;
  });
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.dmgamt) { const v = parseMoney(t.value); t.value = v === null ? '' : money(v); ui.dmg[t.dataset.dmgamt].amount = v; }
    if (t.dataset.dmgguest) ui.dmg[t.dataset.dmgguest].guest = t.value;
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const ds = b.dataset;
    if (ds.retpick) return add('ret', ds.retpick);
    if (ds.volpick) return add('vol', ds.volpick);
    if (ds.retrm) { gr.items = gr.items.filter(x => x !== ds.retrm); d.render(); return; }
    if (ds.volrm) { vol.items = vol.items.filter(x => x !== ds.volrm); d.render(); return; }
    if (ds.retsave !== undefined) {
      b.disabled = true;
      const items = [];
      for (const id of gr.items) {
        const it = byId.get(id), late = it && it.last && it.last.kind === 'rental' ? daysLate(it.back) : 0;
        const x = { item: id, condition: gr.cond[id] || 'OK' };
        if (late && extPrice(it) && !gr.noExt[id]) x.ext = { ts: await nextTs(), days: late, unit: extPrice(it) };
        items.push(x);
      }
      await enqueue('gear_return', { gid: newId('G'), items });
      ui.notice = `Returned: ${gr.items.join(', ')}.`;
      ui.gearRet = null; d.render(); return;
    }
    if (ds.volsave !== undefined) {
      b.disabled = true;
      await enqueue('gear_out', { gid: newId('G'), items: vol.items, guest: 'Volunteer', days: vol.days });
      ui.notice = `Volunteer outing: ${vol.items.join(', ')}.`;
      ui.gearVol = null; d.render(); return;
    }
    if (ds.dfret || ds.dfsite) {
      b.disabled = true;
      const df = g.diffs.find(x => x.id === (ds.dfret || ds.dfsite)); if (!df) { d.render(); return; }
      const it = byId.get(df.item);
      const p = { cfid: newId('F'), diff: df.id, action: ds.dfret ? 'returned' : 'onsite' };
      const late = it && it.last && it.last.kind === 'rental' ? daysLate(it.back) : 0;
      if (ds.dfret && late && extPrice(it) && !(ui.dfNoExt && ui.dfNoExt[df.id])) p.ext = { ts: await nextTs(), days: late, unit: extPrice(it) };
      await enqueue('gear_confirm', p);
      ui.notice = `${df.item}: ${ds.dfret ? 'returned by the guest' : 'found on site'}. Waiting for the gear staff to confirm.`;
      d.render(); return;
    }
    if (ds.dflate) { b.disabled = true; await enqueue('gear_confirm', { cfid: newId('F'), diff: ds.dflate, action: 'returned', ext: { ts: await nextTs() } }); ui.notice = 'Extension charged (Unpaid).'; d.render(); return; }
    if (ds.dfwaive) { b.disabled = true; await enqueue('gear_confirm', { cfid: newId('F'), diff: ds.dfwaive, action: 'waived' }); ui.notice = 'Extension waived.'; d.render(); return; }
    if (ds.dffound) { b.disabled = true; await enqueue('gear_confirm', { cfid: newId('F'), diff: ds.dffound, action: 'found' }); ui.notice = 'Confirmed: found.'; d.render(); return; }
    if (ds.dflost) { ui.dfLost = ds.dflost; d.render(); return; }
    if (ds.dfcancel !== undefined) { ui.dfLost = null; d.render(); return; }
    if (ds.dflostok) { b.disabled = true; await enqueue('gear_lost', { lid: newId('L'), diff: ds.dflostok }); ui.dfLost = null; ui.notice = 'Marked lost: decide below whether to charge the guest.'; d.render(); return; }
    if (ds.dmgcharge) {
      const f = ui.dmg[ds.dmgcharge];
      const err = root.querySelector('[data-reterr]');
      if (!f.amount) { if (err) err.textContent = 'Enter the amount to charge.'; return; }
      if (!String(f.guest || '').trim() || /^(sunset boat|volunteer)$/i.test(f.guest)) { if (err) err.textContent = 'Type the guest to charge.'; return; }
      b.disabled = true;
      await enqueue('gear_decide', { did: newId('E'), damage: ds.dmgcharge, decision: 'charge', amount: f.amount, guest: f.guest.trim(), ts: await nextTs() });
      ui.notice = `Charged Rp ${money(f.amount)} to ${f.guest} (Unpaid).`; d.render(); return;
    }
    if (ds.dmgno) { b.disabled = true; await enqueue('gear_decide', { did: newId('E'), damage: ds.dmgno, decision: 'nocharge' }); ui.notice = 'Not charged.'; d.render(); return; }
    if (ds.gservice) { b.disabled = true; await enqueue('gear_service', { sid: newId('R'), item: ds.gservice }); ui.notice = `${ds.gservice} is back in stock.`; d.render(); return; }
  });
}

export const gearBusy = ui => ui.tab === 'gear' && !!((ui.gearRet && ui.gearRet.items.length) || (ui.gearVol && ui.gearVol.items.length) || ui.dfLost);
