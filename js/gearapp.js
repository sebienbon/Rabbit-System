// Gear staff app (Bahasa Indonesia): Sunset Boat out and back, the blind evening check,
// and the differences to solve with the reception. Runs on a phone, with its own local
// database (window.RABBIT_DB), and works offline: everything waits in the outbox.
import { login, logout, currentUser } from './auth.js';
import { onStatus, startSync, enqueue, pullNow, pushNow } from './sync.js';
import { CONFIG } from './config.js';
import { gearView, checkDue, notifyOnce, fmtWhen } from './gearcore.js';

const $ = s => document.querySelector(s);
const main = () => $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = p => p + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6);
const hhmm = iso => (fmtWhen(iso).split(' ').pop() || '');
const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const dayText = (iso = new Date().toISOString()) => { const d = new Date(Date.parse(iso) + 8 * 3600000); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const COND = { OK: 'Baik', 'Snorkel missing': 'Snorkel hilang', 'Ring missing': 'Ring hilang', Broken: 'Rusak' };
const DIFF = {
  counted_but_out: 'ada di kotak, tapi tercatat keluar',
  returned_not_in_box: 'tercatat kembali, tapi tidak ada',
  missing: 'tidak pernah keluar, tapi tidak ada di kotak',
  sunset_missing: 'belum kembali dari Sunset Boat',
  rented_while_out: 'disewa di resepsi, tapi tercatat di tempat lain',
};
const lastUse = l => !l ? 'Belum pernah dipakai' : l.kind === 'sunset' ? `Sunset Boat, ${dayText(l.from)}`
  : `${l.kind === 'volunteer' ? 'Volunteer' : 'sewa'}, ${l.guest}, ${dayText(l.from)}${l.returned ? ' → kembali ' + dayText(l.returned) + ' ' + hhmm(l.returned) : ''}`;
const waLink = (num, text) => `https://wa.me/${String(num || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

const ui = { user: null, screen: 'home', sel: new Set(), count: null, later: {}, sure: false, notice: '' };

// ---------- sync strip ----------
function renderStrip(s) {
  const el = $('#sync'), n = s.pending;
  let tone = 'ok', title, detail = '';
  if (!CONFIG.API_URL) { tone = 'warn'; title = 'Belum terhubung ke sheet'; }
  else if (s.state === 'offline') { tone = 'off'; title = 'Tidak ada internet'; detail = n ? `${n} catatan disimpan di HP ini, dikirim otomatis nanti.` : 'Anda tetap bisa bekerja.'; }
  else if (s.state === 'expired') { tone = 'warn'; title = 'Perlu masuk lagi'; detail = `${n} catatan menunggu.`; }
  else if (s.state === 'error') { tone = 'warn'; title = 'Sheet tidak terjangkau'; detail = 'Dicoba lagi otomatis.'; }
  else if (s.state === 'sending' || n) { tone = 'busy'; title = 'Mengirim'; detail = `${n} catatan.`; }
  else { title = 'Terhubung'; detail = 'Semua sudah terkirim.'; }
  el.dataset.tone = tone;
  el.innerHTML = `<span class="dot" aria-hidden="true"></span><strong>${esc(title)}</strong><span class="detail">${esc(detail)}</span>` +
    (s.state === 'expired' && ui.user ? '<button type="button" class="ghost small" id="relog">Masuk lagi</button>' : '');
  const r = el.querySelector('#relog');
  if (r) r.onclick = async () => { await logout(ui.user); ui.user = null; ui.notice = 'Ketik kata sandi: catatan yang menunggu akan dikirim.'; render(); };
}

// ---------- login ----------
function renderLogin() {
  $('#who').innerHTML = '';
  main().innerHTML = `<form class="card login" id="lf" novalidate>
    <h1>Masuk</h1>
    <p class="error" id="le" role="alert">${esc(ui.notice)}</p>
    <label class="field"><span>Nama pengguna</span><input id="u" autocomplete="username" autocapitalize="none" autofocus></label>
    <label class="field"><span>Kata sandi</span><input id="p" type="password" autocomplete="current-password"></label>
    <button class="primary wide" type="submit">Masuk</button>
    <p class="muted small">Perlu internet untuk masuk pertama kali.</p>
  </form>`;
  $('#lf').addEventListener('submit', async e => {
    e.preventDefault();
    const u = $('#u').value, p = $('#p').value, b = $('#lf button');
    if (!u.trim() || !p) { $('#le').textContent = 'Isi nama pengguna dan kata sandi.'; return; }
    b.disabled = true; b.textContent = 'Memeriksa…';
    try {
      const user = await login(u, p, { gearApp: true });
      ui.user = user; ui.notice = '';
      b.textContent = 'Memuat…'; await pullNow(); pushNow();
      render();
    } catch (err) {
      $('#le').textContent = /wrong|bad_login/i.test(err.message) ? 'Nama pengguna atau kata sandi salah.' : /server|offline|connection/i.test(err.message) ? 'Tidak ada koneksi ke sheet. Coba lagi saat ada internet.' : err.message;
      b.disabled = false; b.textContent = 'Masuk'; $('#p').value = '';
    }
  });
}

// ---------- screens ----------
const bar = title => `<div class="gabar"><button type="button" class="ghost small" data-go="home">‹ Menu</button><b>${esc(title)}</b></div>`;
const grid = (items, cls, on, extra = () => '') => `<div class="gagrid ${cls}">${items.map(it => {
  const st = on(it);
  return `<button type="button" class="gacell${st ? ' ' + st : ''}" data-cell="${esc(it.id)}" aria-pressed="${!!st}">${esc(it.id)}${extra(it)}</button>`;
}).join('')}</div>`;

function home(g) {
  const open = g.trips.find(t => !t.closed);
  const doneTrips = g.trips.filter(t => t.closed);
  const dayOut = doneTrips.reduce((n, t) => n + t.items.length, 0), dayBack = doneTrips.reduce((n, t) => n + t.back.length, 0);
  const due = checkDue(g);
  const diffs = g.diffs.length;
  const ask = 'Notification' in window && Notification.permission === 'default';
  return `<div class="gahome">
    <h1>${esc(dayText())}</h1>
    ${due ? '<div class="phwarn">Cek malam belum dilakukan hari ini.</div>' : ''}
    <button type="button" class="gatile" data-go="sunset"><b>Sunset Boat</b>
      <span>${open ? `Berangkat ${hhmm(open.at)} · ${open.items.length} masker · <em>belum kembali</em>` : doneTrips.length ? `Hari ini: ${dayOut} berangkat, ${dayBack} kembali` : 'Belum berangkat hari ini'}</span>
      <small>Penjualan hari ini: ${g.sunsetSales} tamu</small></button>
    <button type="button" class="gatile${due ? ' due' : ''}" data-go="count"><b>Cek malam</b>
      <span>${g.countedToday ? `Sudah dilakukan ${hhmm(g.lastCount.at)}${g.lastCount.pending ? ' · menunggu dikirim' : ''}` : 'Belum dilakukan · sekitar jam 20:00'}</span></button>
    <button type="button" class="gatile${diffs ? ' bad' : ''}" data-go="diffs"><b>Selisih</b>
      <span>${diffs ? `${diffs} perlu dicek bersama resepsionis` : 'Tidak ada selisih'}</span></button>
    ${g.managerWa ? `<a class="ghost wide gawa" target="_blank" rel="noopener" href="${waLink(g.managerWa, 'Halo, ini staf gear Rabbit Tree. ')}">WhatsApp manajer</a>` : ''}
    ${ask ? '<button type="button" class="ghost wide" data-notify>Aktifkan pengingat jam 20:00</button>' : ''}
    <p class="muted small center">Pengingat jam 20:00 hanya muncul jika aplikasi ini tetap terbuka di HP.</p>
  </div>`;
}

function sunset(g) {
  const open = g.trips.find(t => !t.closed);
  const byId = new Map(g.items.map(i => [i.id, i]));
  if (open) {
    const its = open.items.map(id => byId.get(id) || { id, kind: 'mask' });
    const missing = open.items.filter(id => !ui.sel.has(id));
    return `${bar('Sunset Boat')}<div class="gabody">
      <h1>Kembali</h1>
      <p class="muted">Berangkat ${hhmm(open.at)} · ${open.items.length} masker. Sentuh masker yang sudah kembali.</p>
      ${grid(its, 'six', it => ui.sel.has(it.id) ? 'on' : '')}
      ${missing.length && (ui.sel.size || ui.sure) ? `<div class="phwarn">${missing.length} belum kembali: ${esc(missing.join(', '))}. Jika disimpan sekarang, menjadi selisih untuk resepsionis.</div>` : ''}
      <button type="button" class="primary wide" data-save="back">${ui.sure ? `Ya, simpan: ${missing.length} jadi selisih` : `Simpan kembali (${ui.sel.size}/${open.items.length})`}</button>
    </div>`;
  }
  const masks = g.items.filter(i => i.kind === 'mask' && !(g.unavailable || []).includes(i.id));
  const n = ui.sel.size;
  return `${bar('Sunset Boat')}<div class="gabody">
    <h1>Berangkat</h1>
    <p class="muted">Penjualan Sunset Boat hari ini: <b>${g.sunsetSales} tamu</b> (termasuk Unpaid). Sentuh masker yang naik perahu.</p>
    ${grid(masks, 'six', it => ui.sel.has(it.id) ? 'on' : '')}
    ${n && n !== g.sunsetSales ? `<div class="phwarn">${n} masker, tapi ${g.sunsetSales} tamu tercatat. Beri tahu resepsionis jika ada tamu yang belum dicatat.</div>` : ''}
    <button type="button" class="primary wide" data-save="out"${n ? '' : ' disabled'}>Simpan berangkat (${n})</button>
    <p class="muted small center">Tanggal dan jam dicatat otomatis. Kembali sebelum 21:30.</p>
  </div>`;
}

function count(g) {
  if (g.countedToday && !ui.count) {
    return `${bar('Cek malam')}<div class="gabody">
      <h1>Cek terkirim, ${hhmm(g.lastCount.at)}</h1>
      <p class="muted">${g.lastCount.n || ''} barang dihitung. ${g.lastCount.pending ? 'Hasil muncul setelah terkirim ke sheet.' : 'Resepsionis sudah diberi tahu.'}</p>
      ${g.lastCount.pending ? '' : g.diffs.length ? `<button type="button" class="primary wide" data-go="diffs">Lihat ${g.diffs.length} selisih</button>` : '<div class="notice">Semua sesuai dengan catatan resepsionis.</div>'}
      <button type="button" class="ghost wide" data-recount>Cek lagi</button>
    </div>`;
  }
  const c = ui.count = ui.count || { items: {}, sel: null };
  const masks = g.items.filter(i => i.kind === 'mask'), bikes = g.items.filter(i => i.kind === 'bike');
  const st = it => c.items[it.id] === undefined ? '' : c.items[it.id] === 'OK' ? 'on' : 'warn';
  const mark = it => (c.items[it.id] && c.items[it.id] !== 'OK' ? ' !' : '');
  const touched = list => list.filter(i => c.items[i.id] !== undefined).length;
  const sel = c.sel && g.items.find(i => i.id === c.sel);
  const conds = sel && (sel.kind === 'bike' ? ['OK', 'Broken'] : ['OK', 'Snorkel missing', 'Ring missing', 'Broken']);
  const panel = sel ? `<div class="card gapanel"><b>${esc(sel.id)} — kondisi</b>
      <div class="gaconds">${conds.map(k => `<button type="button" class="${c.items[sel.id] === k ? 'on' : ''}" data-cond="${k}">${COND[k]}</button>`).join('')}</div>
      ${c.items[sel.id] && c.items[sel.id] !== 'OK' && g.managerWa ? `<a class="ghost wide gawa" target="_blank" rel="noopener" href="${waLink(g.managerWa, `Cek malam ${dayText()}: ${sel.id} — ${COND[c.items[sel.id]]}. Foto terlampir.`)}">Kirim foto ke manajer (WhatsApp)</a>` : ''}
      <button type="button" class="ghost small" data-uncount>Tidak ada di depan saya</button></div>` : '';
  const total = Object.keys(c.items).length;
  return `${bar('Cek malam')}<div class="gabody">
    <p class="muted">Sentuh semua barang yang <b>benar-benar ada di depan Anda</b>. Sentuh lagi untuk memilih kondisi. Anda tidak melihat barang mana yang seharusnya keluar.</p>
    <h2>Masker <span class="muted">· ${touched(masks)} disentuh</span></h2>
    ${grid(masks, 'six', st, mark)}
    ${sel && sel.kind === 'mask' ? panel : ''}
    ${bikes.length ? `<h2>Sepeda <span class="muted">· ${touched(bikes)} disentuh</span></h2>${grid(bikes, 'three', st, it => c.items[it.id] && c.items[it.id] !== 'OK' ? ' · Rusak' : '')}` : ''}
    ${sel && sel.kind === 'bike' ? panel : ''}
    <button type="button" class="primary wide" data-save="count"${total ? '' : ' disabled'}>${ui.sure ? `Ya, kirim (${total} barang)` : 'Kirim hasil cek'}</button>
    <p class="muted small center">${ui.sure ? 'Sentuh lagi untuk mengirim. ' : ''}Setelah dikirim, hitungan tidak bisa diubah.</p>
  </div>`;
}

function diffs(g) {
  const list = g.diffs;
  return `${bar('Selisih')}<div class="gabody">
    ${list.length ? list.map(d => {
      const later = ui.later[d.id];
      return `<div class="card gadiff${d.gear ? ' done' : ''}">
        <b>${esc(d.item)} — ${esc(DIFF[d.kind] || d.kind)}</b>
        <span class="muted small">${d.last ? 'Terakhir dipakai: ' : ''}${esc(lastUse(d.last))}</span>
        ${d.gear ? `<span class="small">Anda sudah konfirmasi${d.pending ? ' (menunggu dikirim)' : ''} · menunggu resepsionis.</span>`
          : later ? `<span class="small">Belum selesai · tetap terbuka. <button type="button" class="ghost small" data-unlater="${esc(d.id)}">Ubah</button></span>`
          : `<div class="garow"><button type="button" class="primary" data-confirm="${esc(d.id)}">${d.kind === 'counted_but_out' ? 'Konfirmasi: ada di sini' : 'Ketemu'}</button>
             <button type="button" class="ghost" data-later="${esc(d.id)}">Belum selesai</button></div>`}
      </div>`;
    }).join('') : '<div class="notice">Tidak ada selisih.</div>'}
    <p class="muted small">Selisih ditutup jika Anda dan resepsionis sama-sama konfirmasi. “Belum selesai” = tetap terbuka.</p>
  </div>`;
}

// ---------- shell ----------
let rendering = null, again = false;
function render() {
  if (rendering) { again = true; return rendering; }
  rendering = (async () => { do { again = false; await renderNow(); } while (again); })().catch(e => console.error(e)).finally(() => { rendering = null; });
  return rendering;
}
async function renderNow() {
  if (!ui.user) return renderLogin();
  $('#who').innerHTML = `<span>${esc(ui.user.name)}</span>`;
  const g = await gearView('gear');
  if (!g) { main().innerHTML = '<section class="card"><p class="muted">Daftar barang (sheet SG) datang saat terhubung ke internet.</p></section>'; return; }
  if (checkDue(g)) notifyOnce('gearcheck', 'Cek malam', 'Masker dan sepeda belum dicek hari ini.');
  if (g.diffs.length) notifyOnce('geardiff:' + g.diffs.length, 'Selisih gear', `${g.diffs.length} selisih perlu dicek bersama resepsionis.`);
  const s = ui.screen;
  main().innerHTML = (ui.notice ? `<div class="notice" role="status">${esc(ui.notice)}</div>` : '') +
    (s === 'sunset' ? sunset(g) : s === 'count' ? count(g) : s === 'diffs' ? diffs(g) : home(g)) +
    (s === 'home' ? '<p class="center"><button type="button" class="ghost small" data-logout>Keluar</button></p>' : '');
  ui.notice = '';
  ui.g = g;
}
const busy = () => ui.sel.size || (ui.count && Object.keys(ui.count.items).length);

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !ui.user) return;
  const ds = b.dataset, g = ui.g;
  if (ds.go) { ui.screen = ds.go; ui.sel = new Set(); ui.sure = false; if (ds.go !== 'count') ui.count = null; render(); scrollTo(0, 0); return; }
  if (ds.notify !== undefined) { try { await Notification.requestPermission(); } catch { /* unsupported */ } render(); return; }
  if (ds.logout !== undefined) { await pushNow(); await logout(ui.user); ui.user = null; render(); return; }
  if (ds.cell) {
    const id = ds.cell;
    ui.sure = false;
    if (ui.screen === 'count') {
      const c = ui.count;
      if (c.items[id] === undefined) { c.items[id] = 'OK'; c.sel = null; } else c.sel = c.sel === id ? null : id;
    } else if (ui.sel.has(id)) ui.sel.delete(id); else ui.sel.add(id);
    render(); return;
  }
  if (ds.cond) { ui.count.items[ui.count.sel] = ds.cond; render(); return; }
  if (ds.uncount !== undefined) { delete ui.count.items[ui.count.sel]; ui.count.sel = null; render(); return; }
  if (ds.recount !== undefined) { ui.count = { items: {}, sel: null }; render(); return; }
  if (ds.later) { ui.later[ds.later] = true; render(); return; }
  if (ds.unlater) { delete ui.later[ds.unlater]; render(); return; }
  if (ds.confirm) {
    b.disabled = true;
    const d = g.diffs.find(x => x.id === ds.confirm);
    await enqueue('gear_confirm', { cfid: newId('F'), diff: ds.confirm, action: d && d.kind === 'counted_but_out' ? 'here' : 'found' });
    ui.notice = 'Dikonfirmasi. Menunggu resepsionis.'; render(); return;
  }
  if (ds.save === 'out') {
    b.disabled = true;
    await enqueue('sunset_out', { trip: newId('T'), items: [...ui.sel] });
    ui.notice = `Berangkat: ${ui.sel.size} masker.`; ui.sel = new Set(); ui.screen = 'home'; render(); return;
  }
  if (ds.save === 'back') {
    const open = g.trips.find(t => !t.closed);
    if (!open) { ui.screen = 'home'; render(); return; }
    const missing = open.items.filter(id => !ui.sel.has(id));
    if (missing.length && !ui.sure) { ui.sure = true; render(); return; }
    b.disabled = true;
    await enqueue('sunset_back', { trip: open.trip, items: [...ui.sel] });
    ui.notice = missing.length ? `Disimpan. ${missing.length} belum kembali → selisih untuk resepsionis.` : 'Semua masker kembali.';
    ui.sel = new Set(); ui.sure = false; ui.screen = 'home'; render(); return;
  }
  if (ds.save === 'count') {
    if (!ui.sure) { ui.sure = true; render(); return; }
    b.disabled = true;
    const items = Object.entries(ui.count.items).map(([item, condition]) => ({ item, condition }));
    await enqueue('gear_count', { cid: newId('K'), items });
    ui.count = null; ui.sure = false;
    ui.notice = 'Cek terkirim. Hasilnya muncul di sini setelah sampai di sheet.'; render(); return;
  }
});

async function boot() {
  onStatus(renderStrip);
  onStatus((s, evt) => {
    if (evt && evt.pushed) pullNow(); // the differences of a check are worked out by the sheet
    if (evt && (evt.pulled || evt.pushed) && !busy()) render();
  });
  ui.user = await currentUser();
  if (ui.user && ui.user.role !== 'gear') { await logout(ui.user); ui.user = null; }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* not supported */ }
  await render();
  startSync();
  setInterval(() => { if (!busy()) render(); }, 5 * 60000); // the 20:00 reminder without touching the screen
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').then(reg => setInterval(() => reg.update().catch(() => {}), 30 * 60000)).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!had) return;
      const reloadWhenIdle = () => (busy() ? setTimeout(reloadWhenIdle, 10000) : location.reload());
      reloadWhenIdle();
    });
  }
}
boot();
