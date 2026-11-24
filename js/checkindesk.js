// Reception tab "Check-in" (owner 18/11): the day's arrivals from Beds24, then a live check-in
// session: the guest scans the QR code on the desk with the phone camera and fills in the page on
// the phone; this screen shows each phone as it fills (name, passport number, photo) every 2 s.
// Online only: nothing here is stored on the computer.
import { api } from './api.js';
import { tokenFor } from './auth.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = ymd => { if (!ymd) return ''; const [y, m, d] = ymd.split('-'); return `${d}/${m}`; };
const POLL_MS = 2000;
const hm = iso => { if (!iso) return ''; const t = new Date(iso); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
const STATUS = { filling: ['Filling in…', 'wait'], ready: ['Ready', 'ok'] };

export const checkinBusy = ui => ui.tab === 'checkin' && !!(ui.ci && (ui.ci.sid || ui.ci.walkin));

export async function renderCheckin(root, d) {
  const { ui } = d;
  const ci = ui.ci = ui.ci || { arrivals: null, loading: false, error: '', sid: null, people: [], photos: {}, walkin: '' };
  const token = await tokenFor(d.user.username);
  const call = (action, body = {}) => api(action, { token, ...body }, 30000);
  const rerender = () => { if (root.isConnected) renderCheckin(root, d); };

  if (ci.sid) return renderSession(root, d, ci, call, rerender);

  if (!ci.arrivals && !ci.loading && !ci.error) {
    ci.loading = true;
    call('ci_arrivals').then(r => { ci.arrivals = r.arrivals; ci.today = r.today; }).catch(e => { ci.error = e.message; })
      .finally(() => { ci.loading = false; rerender(); });
  }
  // Guests in and out (owner 24/11): In = arrived, Out = left (bags out). The housekeeping app reads it to
  // know which room to clean first. Asked with the arrivals; a failure here never hides the check-in list.
  if (!ci.hk && !ci.hkLoading && !ci.hkError) {
    ci.hkLoading = true;
    call('hk_day').then(r => { ci.hk = r; }).catch(e => { ci.hkError = e.code === 'unknown_action' ? 'off' : e.message; })
      .finally(() => { ci.hkLoading = false; rerender(); });
  }
  // a guest's answer (clean.html) shows by itself: looked for every minute while this list is on screen
  if (!ci.hkTimer) ci.hkTimer = setInterval(() => {
    if (ci.sid || !document.querySelector('.ci') || document.hidden || ci.waSent || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
    call('hk_day').then(r => { const k = JSON.stringify(r); if (k !== JSON.stringify(ci.hk)) { ci.hk = r; rerender(); } }).catch(() => {});
  }, 60000);
  const hk = ci.hk || { arrivals: [], departures: [] };
  const inOf = id => hk.arrivals.find(a => a.bookId === id);
  const where = x => `${esc(x.room)}${x.unit ? ' · ' + esc(x.unit) : ''}`;
  const markBtn = (x, type) => x.at
    ? `<span class="cidone">✓ ${type === 'in' ? 'In' : 'Out'} ${hm(x.at)}${x.by ? ' · ' + esc(x.by) : ''}</span> <button type="button" class="tool" data-hk="${type}" data-id="${esc(x.bookId)}" data-undo="1">Undo</button>`
    : `<button type="button" class="${type === 'out' ? 'primary' : 'ghost'} small" data-hk="${type}" data-id="${esc(x.bookId)}">${type === 'in' ? 'In' : 'Out'}</button>`;
  // Guests who stay: the cleaning of every 3 days is offered first (owner 24/11). The message leaves from the hostel's
  // own WhatsApp (wa.me link); the guest answers on his page (clean.html) or in WhatsApp, then the desk notes it.
  const stays = hk.stays || [];
  const waText = (x, link) => `Hello ${x.name.split(' ')[0]}! 🐇 This is The Rabbit Tree. Today we can clean your room (${/[a-z]/i.test(String(x.unit)) ? x.unit : x.room}). Would you like that? Please tap to answer: ${link}`;
  const stayState = x => x.answer === 'yes' ? `<span class="cidone">✓ Yes, clean${x.answerBy === 'guest' ? ' · the guest answered' : x.answerBy ? ' · ' + esc(x.answerBy) : ''}</span>`
    : x.answer === 'no' ? `<span class="badge noshow">No cleaning${x.answerBy === 'guest' ? ' · the guest answered' : ''}</span>`
    : x.askedAt ? `<span class="muted">Asked ${hm(x.askedAt)} · no answer yet</span>` : '';
  const stayRow = x => `<li><div><b>${esc(x.name)}</b> <span class="muted">· ${where(x)} · until ${day(x.departure)}</span>
      ${x.due ? ' <span class="badge">Cleaning day</span>' : ''} ${stayState(x)}
      ${ci.waSent === x.bookId ? `<div class="cinote">Did the message leave? <button type="button" class="primary small" data-wasent="${esc(x.bookId)}">Yes, sent</button>
        <button type="button" class="ghost small" data-wafail="1">No</button></div>` : ''}
      ${ci.waFail === x.bookId ? `<div class="cinote">WhatsApp Web is probably not connected on this computer. Open <b>web.whatsapp.com</b>, connect it with the hostel's phone (Linked devices), then tap WhatsApp again.</div>` : ''}</div>
    <span>${x.phones.length > 1 ? `<select class="tool" data-waphone="${esc(x.bookId)}">${x.phones.map(p => `<option value="${esc(p.number)}">${esc(p.label)}</option>`).join('')}</select> ` : ''}
      ${x.phones.length ? `<button type="button" class="${x.due && !x.askedAt && !x.answer ? 'primary' : 'ghost'} small" data-wa="${esc(x.bookId)}">WhatsApp</button>` : `<button type="button" class="ghost small" data-wanum="${esc(x.bookId)}">+ Number</button>`}
      ${x.answer ? `<button type="button" class="tool" data-clean="none" data-id="${esc(x.bookId)}">Undo</button>`
        : `<button type="button" class="ghost small" data-clean="yes" data-id="${esc(x.bookId)}">Yes</button> <button type="button" class="ghost small" data-clean="no" data-id="${esc(x.bookId)}">No</button>`}</span></li>`;
  const dueStays = stays.filter(x => x.due || x.askedAt || x.answer), otherStays = stays.filter(x => !(x.due || x.askedAt || x.answer));
  const staying = stays.length ? `<h3>Staying · room cleaning <span class="muted">· ask the guest before the cleaning of every 3 days</span></h3>
    ${dueStays.length ? `<ul class="cilist">${dueStays.map(stayRow).join('')}</ul>` : `<p class="muted">${hk.dueKnown ? 'No room is due for its cleaning today.' : 'The housekeeping app has not said yet which rooms are due.'}</p>`}
    ${otherStays.length ? `<details ${ci.staysOpen ? 'open' : ''} id="ciStays"><summary class="muted">Other guests staying · ${otherStays.length}</summary><ul class="cilist">${otherStays.map(stayRow).join('')}</ul></details>` : ''}` : '';
  const leaving = hk.departures.length ? `<h3>Leaving today <span class="muted">· tap Out when the guest has left with the bags${hk.late ? ' · check-out time has passed' : ''}</span></h3>
    <ul class="cilist">${hk.departures.map(x => `<li><div><b>${esc(x.name)}</b> <span class="muted">· ${where(x)} · ${x.guests} guest${x.guests > 1 ? 's' : ''}</span></div>
      <span>${markBtn(x, 'out')}</span></li>`).join('')}</ul>` : (ci.hk ? '<p class="muted">Nobody leaves today in Beds24.</p>' : '');
  const list = ci.arrivals || [];
  const groups = [['Arriving today', list.filter(b => b.arrival === ci.today)], ['Arrived yesterday', list.filter(b => b.arrival < ci.today)],
    ['Arriving tomorrow', list.filter(b => b.arrival > ci.today)]].filter(g => g[1].length);
  root.innerHTML = `<section class="card ci">
    <div class="cihead"><h2>Check-in</h2>
      <span class="citools"><a class="tool" href="checkin-qr.html" target="_blank" rel="noopener">Print the desk QR code</a>
      <button type="button" class="tool" id="ciReload">Refresh</button></span></div>
    <p class="muted">Pick the booking, then ask the guest to scan the QR code on the desk <b>with the phone camera</b>. Each person of the booking scans with their own phone.</p>
    ${ci.loading ? '<p class="muted">Loading the arrivals from Beds24…</p>' : ''}
    ${ci.error ? `<p class="cinote">${esc(ci.error)} <button type="button" class="ghost small" id="ciRetry">Try again</button></p>` : ''}
    ${ci.hkError && ci.hkError !== 'off' ? `<p class="cinote">In / Out: ${esc(ci.hkError)}</p>` : ''}
    ${leaving}
    ${staying}
    ${groups.map(([title, g]) => `<h3>${title}</h3><ul class="cilist">${g.map(b => `<li>
      <div><b>${esc(b.name)}</b> <span class="muted">· ${esc(b.room)} · ${day(b.arrival)} → ${day(b.departure)} · ${b.guests} guest${b.guests > 1 ? 's' : ''}${b.channel ? ' · ' + esc(b.channel) : ''}</span>
        ${b.noShow ? ' <span class="badge noshow">No-show</span>' : ''}
        ${b.checkedIn.length ? `<div class="cidone">✓ Checked in: ${b.checkedIn.map(esc).join(', ')}</div>` : ''}</div>
      <span>${inOf(b.bookId) ? markBtn(inOf(b.bookId), 'in') + ' ' : ''}<button type="button" class="${b.checkedIn.length ? 'ghost' : 'primary'} small" data-book="${esc(b.bookId)}">${b.checkedIn.length ? 'Add a person' : 'Start check-in'}</button></span>
    </li>`).join('')}</ul>`).join('')}
    ${ci.arrivals && !list.length ? '<p class="muted">No arrivals in Beds24 from yesterday to tomorrow.</p>' : ''}
    <h3>Guest without a booking in the list</h3>
    <form id="ciWalk" class="ciwalk"><input type="text" id="ciName" placeholder="Guest name" maxlength="60" value="${esc(ci.walkin)}">
      <button type="submit" class="ghost">Start check-in</button></form>
  </section>`;
  root.querySelector('#ciReload').onclick = () => { ci.arrivals = null; ci.error = ''; ci.hk = null; ci.hkError = ''; rerender(); };
  const sd = root.querySelector('#ciStays'); if (sd) sd.ontoggle = () => { ci.staysOpen = sd.open; };
  const hkCall = async (action, body) => { try { ci.hk = await call(action, body); ci.hkError = ''; } catch (e) { ci.hkError = e.message; } rerender(); };
  root.querySelectorAll('[data-wa]').forEach(b => b.onclick = async () => {
    const x = stays.find(s => s.bookId === b.dataset.wa);
    const sel = root.querySelector(`[data-waphone="${CSS.escape(x.bookId)}"]`);
    const number = (ci.waNum && ci.waNum[x.bookId]) || (sel ? sel.value : x.phones[0].number);
    b.disabled = true;
    try {
      const a = await call('hk_ask', { bookId: x.bookId });
      const link = new URL(`clean.html#b=${encodeURIComponent(a.bookId)}&d=${a.day}&t=${a.t}`, location.href).href;
      window.open(`https://wa.me/${number}?text=${encodeURIComponent(waText(x, link))}`, 'rabbitwhatsapp');
      ci.waSent = x.bookId; ci.waFail = null; ci.hkError = '';
    } catch (e) { ci.hkError = e.message; }
    rerender();
  });
  root.querySelectorAll('[data-wasent]').forEach(b => b.onclick = () => { const id = b.dataset.wasent; ci.waSent = null; hkCall('hk_asked', { bookId: id }); });
  root.querySelectorAll('[data-wafail]').forEach(b => b.onclick = () => { ci.waFail = ci.waSent; ci.waSent = null; rerender(); });
  root.querySelectorAll('[data-wanum]').forEach(b => b.onclick = () => {
    const v = prompt('WhatsApp number of the guest, with the country code (for example +33 6 12 34 56 78):', '');
    const d = String(v || '').replace(/[^0-9]/g, '').replace(/^00/, '');
    if (d.length < 8) return;
    const x = stays.find(s => s.bookId === b.dataset.wanum);
    x.phones = [{ label: 'typed', number: d }]; (ci.waNum = ci.waNum || {})[x.bookId] = d;
    rerender();
  });
  root.querySelectorAll('[data-clean]').forEach(b => b.onclick = () => { b.disabled = true; hkCall('hk_clean', { bookId: b.dataset.id, answer: b.dataset.clean }); });
  root.querySelectorAll('[data-hk]').forEach(b => b.onclick = async () => {
    const type = b.dataset.hk, undo = !!b.dataset.undo;
    if (undo && !confirm(`Undo this ${type === 'in' ? 'In' : 'Out'}?`)) return;
    b.disabled = true;
    try { ci.hk = await call('hk_mark', { bookId: b.dataset.id, type, undo }); ci.hkError = ''; } catch (e) { ci.hkError = e.message; }
    rerender();
  });
  const rt = root.querySelector('#ciRetry'); if (rt) rt.onclick = () => { ci.error = ''; rerender(); };
  const start = async (body, btn) => {
    if (btn) btn.disabled = true;
    try {
      let r;
      try { r = await call('ci_open', body); } catch (e) {
        if (e.code !== 'desk_busy' || !confirm(e.message + '.\n\nClose it and start this one?')) throw e;
        r = await call('ci_open', { ...body, replace: true });
      }
      ci.sid = r.session.sid; ci.session = r.session; ci.people = []; ci.photos = {}; ci.walkin = '';
      rerender();
    } catch (e) { ci.error = e.message; rerender(); }
  };
  root.querySelectorAll('[data-book]').forEach(b => b.onclick = () => {
    const x = list.find(a => a.bookId === b.dataset.book);
    start({ bookId: x.bookId, name: x.name, room: x.room, arrival: x.arrival, departure: x.departure, guests: x.guests }, b);
  });
  const nm = root.querySelector('#ciName');
  nm.oninput = () => { ci.walkin = nm.value; };
  root.querySelector('#ciWalk').onsubmit = e => {
    e.preventDefault();
    const name = nm.value.trim();
    if (name) start({ name }, e.submitter);
  };
}

function renderSession(root, d, ci, call, rerender) {
  const s = ci.session || {};
  const ready = ci.people.filter(p => p.status === 'ready');
  root.innerHTML = `<section class="card ci">
    <div class="cihead"><h2>Check-in · ${esc(s.name)}</h2><span class="citools"><button type="button" class="tool" id="ciCancel">Cancel</button></span></div>
    <p class="muted">${esc(s.room || '')}${s.arrival ? ` · ${day(s.arrival)} → ${day(s.departure)}` : ''}${s.guests ? ` · ${s.guests} guest${s.guests > 1 ? 's' : ''}` : ''}</p>
    <div class="ciscan">📷 Ask ${s.guests > 1 ? 'each guest' : 'the guest'} to scan the QR code on the desk <b>with the phone camera</b> (not from WhatsApp or Instagram).</div>
    ${ci.state && ci.state !== 'open' ? `<p class="cinote">This check-in is ${esc(ci.state)}.</p>` : ''}
    ${ci.error ? `<p class="cinote">${esc(ci.error)}</p>` : ''}
    <ul class="cipeople">${ci.people.length ? ci.people.map(p => {
      const [label, tone] = STATUS[p.status] || [p.status, 'wait'];
      return `<li><div class="ciphoto">${ci.photos[p.pid] ? `<a href="${ci.photos[p.pid]}" target="_blank" rel="noopener"><img src="${ci.photos[p.pid]}" alt="Passport of ${esc(p.name)}"></a>` : p.photo ? '<span class="muted">Loading the photo…</span>' : '<span class="muted">No photo yet</span>'}</div>
        <div class="ciwho"><b>${esc(p.name || 'Name not chosen yet')}</b>${p.who === 'other' && p.name ? ' <span class="muted">(another person)</span>' : ''}
          <div>WhatsApp: <b class="num">${p.whatsapp ? '+' + esc(p.whatsapp) : '—'}</b></div>
          <div>Passport: <b class="num">${esc(p.passport || '—')}</b> <button type="button" class="tool" data-fix="${esc(p.pid)}" title="Compare with the photo and correct">Correct</button></div>
          <span class="state ${tone}">${label}</span>
          <button type="button" class="ghost small" data-remove="${esc(p.pid)}">Remove</button></div></li>`;
    }).join('') : '<li class="muted">Waiting for the first phone…</li>'}</ul>
    <button type="button" class="primary wide" id="ciValidate" ${ready.length ? '' : 'disabled'}>Check in ${ready.length ? ready.map(p => esc(p.name)).join(', ') : ''}</button>
    <p class="muted small">Check that each photo matches the person in front of you. A companion gets their own bill.</p>
  </section>`;
  root.querySelector('#ciCancel').onclick = async () => {
    if (!confirm('Cancel this check-in? Photos already sent are deleted.')) return;
    try { await call('ci_cancel', { sid: ci.sid }); } catch { /* closed anyway */ }
    stop(ci); ui0(ci); rerender();
  };
  root.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    if (!confirm('Take this phone out of the check-in?')) return;
    try { const r = await call('ci_remove', { sid: ci.sid, pid: b.dataset.remove }); ci.people = r.people; } catch (e) { ci.error = e.message; }
    rerender();
  });
  root.querySelectorAll('[data-fix]').forEach(b => b.onclick = async () => {
    const p = ci.people.find(x => x.pid === b.dataset.fix);
    const v = prompt('Passport number as printed on the photo (an L read as 1, an O read as 0…):', p ? p.passport : '');
    if (v === null) return;
    try { const r = await call('ci_edit', { sid: ci.sid, pid: b.dataset.fix, passport: v }); ci.people = r.people; } catch (e) { ci.error = e.message; }
    rerender();
  });
  root.querySelector('#ciValidate').onclick = async e => {
    const notReady = ci.people.filter(p => p.status !== 'ready');
    if (notReady.length && !confirm(`${notReady.length} person(s) not finished. Check in only the others?`)) return;
    e.target.disabled = true;
    try {
      const r = await call('ci_validate', { sid: ci.sid, partial: notReady.length > 0 });
      stop(ci);
      d.ui.notice = `Checked in: ${r.checkedIn.join(', ')}.`;
      ui0(ci); ci.arrivals = null;
      if (d.render) d.render(); else rerender(); // full render: shows the notice
    } catch (err) { ci.error = err.message; rerender(); }
  };
  if (!ci.polling) poll(ci, call, rerender);
}
function ui0(ci) { Object.assign(ci, { sid: null, session: null, people: [], photos: {}, state: null, error: '' }); }
function stop(ci) { clearTimeout(ci.timer); ci.timer = null; ci.polling = false; }
/** Every 2 s while this screen is open: who joined, what they filled in; a new photo is fetched once. */
function poll(ci, call, rerender) {
  ci.polling = true;
  const tick = async () => {
    ci.timer = null;
    if (!ci.sid || !document.querySelector('.ci')) { ci.polling = false; return; } // left the tab: the next render starts again
    try {
      const r = await call('ci_status', { sid: ci.sid });
      const key = JSON.stringify([r.people, r.state]);
      ci.state = r.state; ci.error = '';
      for (const p of r.people) {
        if (p.photo && ci.photoIds?.[p.pid] !== p.photo) {
          (ci.photoIds = ci.photoIds || {})[p.pid] = p.photo;
          call('ci_photo_get', { sid: ci.sid, pid: p.pid }).then(x => { ci.photos[p.pid] = x.data; rerender(); }).catch(() => { delete ci.photoIds[p.pid]; });
        }
      }
      if (key !== ci.last) { ci.last = key; ci.people = r.people; rerender(); }
    } catch (e) { if (!e.network) { ci.error = e.message; rerender(); } }
    if (ci.sid && ci.polling && ci.state !== 'checked in' && ci.state !== 'cancelled' && ci.state !== 'replaced') ci.timer = setTimeout(tick, POLL_MS);
    else ci.polling = false;
  };
  ci.timer = setTimeout(tick, 300);
}
