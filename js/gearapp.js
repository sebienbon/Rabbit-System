// Gear staff app (Bahasa Indonesia): Sunset Boat out and back, the blind evening check,
// and the differences to solve with the reception. Runs on a phone, with its own local
// database (window.RABBIT_DB), and works offline: everything waits in the outbox.
import { login, logout, currentUser, outboxOwners, cleanupTokens } from './auth.js';
import { onStatus, startSync, enqueue as enqueueOp, pullNow, pushNow, waitingCount, dismissRejected, warnOtherOutboxes, opDetails, copyText, status as syncStatus, CLOCK_WARN_MS } from './sync.js';
import { db } from './db.js';
// Every operation says it comes from the gear app: reception accounts also work here.
const enqueue = (type, payload) => enqueueOp(type, { ...payload, app: 'gear' });
import { CONFIG } from './config.js';
import { gearView, checkDue, notifyOnce, fmtWhen } from './gearcore.js';
import { startTour, helpMenu, tourRunning } from './tour.js';

const $ = s => document.querySelector(s);
const main = () => $('#main');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = p => p + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6);
const hhmm = iso => (fmtWhen(iso).split(' ').pop() || '');
const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const dayText = (iso = new Date().toISOString()) => { const d = new Date(Date.parse(iso) + 8 * 3600000); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const COND = { OK: 'Baik', Broken: 'Rusak', 'Ring missing': 'Ring hilang', 'Snorkel missing': 'Snorkel hilang', 'Mask missing': 'Masker hilang', Other: 'Lainnya', 'Part missing': 'Ada bagian hilang' };
const DIFF = {
  counted_but_out: 'ada di kotak, tapi tercatat keluar',
  returned_not_in_box: 'tercatat kembali, tapi tidak ada',
  missing: 'tidak pernah keluar, tapi tidak ada di kotak',
  sunset_missing: 'belum kembali dari Sunset Boat',
  rented_while_out: 'disewa di resepsi, tapi tercatat di tempat lain',
  returned_late: 'dikembalikan terlambat — resepsionis memutuskan biaya',
  returned_not_out: 'dikembalikan, tapi tidak tercatat keluar',
  sale_unlinked: 'dijual di resepsi, tapi nomornya tidak bisa dicatat — cek bersama',
};
const OP = { sunset_out: 'Sunset Boat berangkat', sunset_back: 'Sunset Boat kembali', gear_count: 'Cek malam', gear_return: 'Pengembalian', gear_confirm: 'Konfirmasi selisih',
  gear_out: 'Volunteer', gear_lost: 'Hilang', gear_decide: 'Keputusan kerusakan', gear_service: 'Perbaikan' };
const WHY = { gear_not_out: 'nomor ini tidak tercatat keluar', gear_unavailable: 'nomor ini tidak tersedia', line_not_found: 'sudah selesai atau tidak ada lagi di sheet', forbidden: 'tidak diizinkan untuk akun ini', bad_payload: 'data tidak valid' };
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
  const attn = s.rejected + (s.stuck ? 1 : 0);
  const skew = Math.abs(s.clockSkew || 0) > CLOCK_WARN_MS ? `<span class="detail warnline clockwarn">Jam HP ini selisih ${Math.round(Math.abs(s.clockSkew) / 60000)} menit dari sheet: perbaiki tanggal dan jam HP.</span>` : '';
  el.innerHTML = `<span class="dot" aria-hidden="true"></span><strong>${esc(title)}</strong><span class="detail">${esc(detail)}</span>${skew}` +
    (attn && ui.user ? `<button type="button" class="ghost small attn" data-go="home">${attn} perlu perhatian</button>` : '') +
    (s.state === 'expired' && ui.user ? '<button type="button" class="ghost small" id="relog">Masuk lagi</button>' : '');
  const r = el.querySelector('#relog');
  if (r) r.onclick = async () => { await logout(ui.user); ui.user = null; ui.notice = 'Ketik kata sandi: catatan yang menunggu akan dikirim.'; render(); };
}

// ---------- login ----------
async function renderLogin() {
  $('#who').innerHTML = '';
  // Phones are swapped between staff, but never with notes waiting: only their author can log in.
  const owner = (await outboxOwners())[0] || null, n = owner ? await waitingCount() : 0;
  // Redrawn by a sync in the background: what is being typed stays (and the cursor).
  const was = $('#lf') ? { u: $('#u').value, p: $('#p').value, le: $('#le').textContent, focus: document.activeElement && document.activeElement.id } : null;
  main().innerHTML = `<form class="card login" id="lf" novalidate>
    <h1>Masuk</h1>
    <p class="error" id="le" role="alert">${esc(ui.notice)}</p>
    ${owner ? `<p class="phwarn waitowner">${n} catatan dari ${esc(owner)} masih menunggu dikirim: hanya ${esc(owner)} yang bisa masuk sampai terkirim.</p>` : ''}
    <label class="field"><span>Nama pengguna</span><input id="u" autocomplete="username" autocapitalize="none" ${owner ? `value="${esc(owner)}" readonly` : 'autofocus'}></label>
    <label class="field"><span>Kata sandi</span><input id="p" type="password" autocomplete="current-password"></label>
    <button class="primary wide" type="submit">Masuk</button>
    <p class="muted small">Perlu internet untuk masuk pertama kali.</p>
  </form>`;
  if (was) {
    if (!owner) $('#u').value = was.u;
    if (!ui.notice) $('#le').textContent = was.le;
    if (!owner || was.u.trim().toLowerCase() === owner) $('#p').value = was.p;
    if (was.focus === 'u' || was.focus === 'p') $('#' + was.focus).focus();
  }
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

// 1) Touch the numbers (here / back). 2) "Lanjut": each one is listed with its condition, Baik
// by default; any other choice asks a comment and offers the photo to the manager on WhatsApp.
const CONDS = kind => (kind === 'bike' ? ['OK', 'Broken', 'Other'] : ['OK', 'Broken', 'Ring missing', 'Snorkel missing', 'Mask missing', 'Other']);
const newPick = () => ({ items: {}, notes: {}, review: false });
function touchGrids(g, c, list) {
  const masks = list.filter(i => i.kind === 'mask'), bikes = list.filter(i => i.kind === 'bike');
  const on = it => (c.items[it.id] !== undefined ? 'on' : '');
  const n = l => l.filter(i => c.items[i.id] !== undefined).length;
  return `${masks.length ? `<h2>Masker <span class="muted">· ${n(masks)} disentuh</span></h2>${grid(masks, 'six', on)}` : ''}
    ${bikes.length ? `<h2>Sepeda <span class="muted">· ${n(bikes)} disentuh</span></h2>${grid(bikes, 'three', on)}` : ''}`;
}
function reviewList(g, c, what) {
  const byId = new Map(g.items.map(i => [i.id, i]));
  return `<p class="muted">Semua <b>Baik</b>? Simpan. Rusak atau ada yang hilang? Tekan <b>Ada masalah?</b> di nomornya.</p>
    <div class="garev">${Object.keys(c.items).map(id => {
      const it = byId.get(id) || { id, kind: 'mask' }, cur = c.items[id];
      if (cur === 'OK' && !(c.open || {})[id]) return `<div class="garowmin"><b class="gnum">${esc(id)}</b><span class="gaok">Baik</span>
        <button type="button" class="ghost small" data-problem="${esc(id)}">Ada masalah?</button></div>`;
      return `<div class="card garow1${cur !== 'OK' ? ' bad' : ''}"><b class="gnum">${esc(id)}</b>
        <div class="gaconds">${CONDS(it.kind).map(k => `<button type="button" class="${cur === k ? 'on' : ''}" data-rc="${esc(id)}|${k}">${COND[k]}</button>`).join('')}</div>
        ${cur !== 'OK' ? `<label class="field ganote"><span>Komentar ${cur === 'Other' ? '<em>wajib</em>' : '<em>opsional</em>'}</span><textarea data-note="${esc(id)}" rows="2" maxlength="300" placeholder="Apa yang rusak atau hilang?">${esc(c.notes[id] || '')}</textarea></label>
          ${g.managerWa ? `<button type="button" class="ghost wide gawa" data-wa="${esc(id)}" data-what="${esc(what)}">Kirim foto ke manajer (WhatsApp)</button>` : ''}` : ''}
      </div>`;
    }).join('')}</div>
    <p class="error" data-err role="alert"></p>
    <button type="button" class="ghost small" data-edit>‹ Ubah pilihan</button>`;
}
const checkNotes = c => Object.keys(c.items).find(id => c.items[id] === 'Other' && !String(c.notes[id] || '').trim());
const itemsOf = c => Object.keys(c.items).map(id => ({ item: id, condition: c.items[id], note: String(c.notes[id] || '').trim() }));

// Refused by the sheet (kept until dismissed), and an operation the sheet keeps failing on.
function attention(rejected) {
  const stuck = syncStatus.stuck;
  if (!rejected.length && !stuck) return '';
  const what = r => (r.payload && Array.isArray(r.payload.items) ? r.payload.items.map(x => (typeof x === 'string' ? x : x.item)).join(', ') : '');
  const row = (r, why, dismiss) => `<div class="card gadiff bad"><b>${esc(OP[r.type] || r.type)} · ${esc(dayText(r.at))} ${esc(hhmm(r.at))}</b>
      ${what(r) ? `<span class="small">${esc(what(r))}</span>` : ''}<span class="small warnline">${esc(why)}</span>
      <div class="garow"><button type="button" class="ghost" data-copyop="${esc(r.id)}">Salin detail</button>${dismiss ? `<button type="button" class="ghost" data-dismiss="${esc(r.id)}">Tutup</button>` : ''}</div></div>`;
  ui.listed = new Map([...rejected.map(r => [r.id, r]), ...(stuck ? [[stuck.id, stuck]] : [])]);
  return `<section class="gaattn" id="attention">
    ${stuck ? `<h2>Belum bisa terkirim</h2><p class="muted small">Sheet gagal ${stuck.tries} kali berturut-turut. Tetap disimpan dan dicoba lagi. Beri tahu manajer.</p>${row(stuck, stuck.message || '', false)}` : ''}
    ${rejected.length ? `<h2>Ditolak oleh sheet</h2><p class="muted small">Tersimpan di HP ini, tapi sheet tidak menerimanya. Beri tahu manajer, lalu tutup.</p>
      ${rejected.map(r => row(r, [WHY[r.error], r.message || r.error].filter(Boolean).join(' — '), true)).join('')}` : ''}
  </section>`;
}

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
    <button type="button" class="gatile" data-go="ret"><b>Pengembalian</b>
      <span>Tamu mengembalikan masker atau sepeda kepada Anda</span></button>
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
    const c = ui.count = ui.count || newPick();
    const backN = open.items.filter(id => c.items[id] !== undefined).length;
    const missing = open.items.filter(id => c.items[id] === undefined);
    const warn = missing.length ? `<div class="phwarn">${missing.length} belum kembali: ${esc(missing.join(', '))}. Jika disimpan sekarang, menjadi selisih untuk resepsionis.</div>` : '';
    if (c.review) return `${bar('Sunset Boat')}<div class="gabody"><h1>Kembali · kondisi</h1>${reviewList(g, c, 'Sunset Boat')}${warn}
      <button type="button" class="primary wide" data-save="back">${missing.length ? `Simpan: ${backN} kembali, ${missing.length} jadi selisih` : `Simpan kembali (${backN})`}</button></div>`;
    return `${bar('Sunset Boat')}<div class="gabody">
      <h1>Kembali</h1>
      <p class="muted">Berangkat ${hhmm(open.at)} · ${open.items.length} masker. Sentuh masker yang sudah kembali, lalu Lanjut untuk kondisinya.</p>
      ${touchGrids(g, c, its)}
      <button type="button" class="primary wide" data-next>Lanjut (${backN}/${open.items.length})</button>
    </div>`;
  }
  const masks = g.items.filter(i => i.kind === 'mask' && !(g.unavailable || []).includes(i.id));
  const n = ui.sel.size;
  return `${bar('Sunset Boat')}<div class="gabody">
    <h1>Berangkat</h1>
    <p class="muted">Penjualan Sunset Boat hari ini: <b>${g.sunsetSales} tamu</b> (termasuk Unpaid). Sentuh masker yang naik perahu.</p>
    ${grid(masks, 'six', it => ui.sel.has(it.id) ? 'on' : '')}
    ${n && n !== g.sunsetSales ? `<p class="muted small">${n} masker untuk ${g.sunsetSales} tamu tercatat (${n > g.sunsetSales ? '+' : '−'}${Math.abs(n - g.sunsetSales)}).</p>` : ''}
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
  const c = ui.count = ui.count || newPick();
  const total = Object.keys(c.items).length;
  if (c.review) return `${bar('Cek malam')}<div class="gabody"><h1>Cek malam · kondisi</h1>${reviewList(g, c, 'Cek malam')}
    <button type="button" class="primary wide" data-save="count">${ui.sure ? `Ya, kirim (${total} barang)` : 'Kirim hasil cek'}</button>
    <p class="muted small center">${ui.sure ? 'Sentuh lagi untuk mengirim. ' : ''}Setelah dikirim, hitungan tidak bisa diubah.</p></div>`;
  return `${bar('Cek malam')}<div class="gabody">
    <p class="muted">Sentuh semua barang yang <b>benar-benar ada di depan Anda</b>, lalu Lanjut untuk kondisinya. Anda tidak melihat barang mana yang seharusnya keluar.</p>
    ${touchGrids(g, c, g.items)}
    <button type="button" class="primary wide" data-next${total ? '' : ' disabled'}>Lanjut (${total})</button>
  </div>`;
}

function ret(g) {
  const c = ui.count = ui.count || newPick();
  const total = Object.keys(c.items).length;
  if (c.bulkAsk) return `${bar('Pengembalian')}<div class="gabody">
    <h1>${total} barang?</h1>
    <div class="phwarn">Pengembalian hanya untuk barang yang <b>dikembalikan tamu</b> kepada Anda. Kalau Anda sedang <b>menghitung semua barang</b> (inventaris), pakai <b>Cek malam</b>.</div>
    <button type="button" class="primary wide" data-tocount>Ini inventaris → Cek malam</button>
    <button type="button" class="ghost wide" data-bulkok>Tidak, semua ini dikembalikan tamu</button></div>`;
  if (c.review) return `${bar('Pengembalian')}<div class="gabody"><h1>Pengembalian · kondisi</h1>${reviewList(g, c, 'Pengembalian')}
    <button type="button" class="primary wide" data-save="ret">Simpan pengembalian (${total})</button>
    <p class="muted small center">Biaya keterlambatan atau kerusakan diputuskan oleh resepsionis.</p></div>`;
  return `${bar('Pengembalian')}<div class="gabody">
    <p class="muted">Tamu mengembalikan masker atau sepeda kepada Anda? Sentuh nomornya, lalu Lanjut untuk kondisinya.</p>
    <p class="gahint">Bukan untuk inventaris. Menghitung semua barang? <button type="button" class="ghost small" data-go="count">Cek malam</button></p>
    ${touchGrids(g, c, g.items)}
    <button type="button" class="primary wide" data-next${total ? '' : ' disabled'}>Lanjut (${total})</button>
  </div>`;
}

function diffs(g) {
  const list = ui.tourDiffs || g.diffs;
  return `${bar('Selisih')}<div class="gabody">
    ${list.length ? list.map(d => {
      const later = ui.later[d.id];
      return `<div class="card gadiff${d.gear ? ' done' : ''}">
        <b>${esc(d.item)} — ${esc(DIFF[d.kind] || d.kind)}</b>
        <span class="muted small">${d.last ? 'Terakhir dipakai: ' : ''}${esc(lastUse(d.last))}</span>
        ${d.reception && !d.gear ? '<span class="small warnline">Resepsionis sudah konfirmasi — tinggal Anda.</span>' : ''}
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
  $('#who').innerHTML = `<span>${esc(ui.user.name)}</span><button type="button" class="helpq" data-help aria-label="Panduan" title="Panduan">?</button>`;
  const g = await gearView('gear');
  if (!g) { main().innerHTML = '<section class="card"><p class="muted">Daftar barang (sheet SG) datang saat terhubung ke internet.</p></section>'; return; }
  if (checkDue(g)) notifyOnce('gearcheck', 'Cek malam', 'Masker dan sepeda belum dicek hari ini.', './gear.html');
  if (g.diffs.length) notifyOnce('geardiff:' + g.diffs.length, 'Selisih gear', `${g.diffs.length} selisih perlu dicek bersama resepsionis.`, './gear.html');
  const s = ui.screen;
  const rejected = s === 'home' ? await db.all('rejected') : [];
  main().innerHTML = (ui.notice ? `<div class="notice" role="status">${esc(ui.notice)}</div>` : '') +
    (s === 'home' ? attention(rejected) : '') +
    (s === 'sunset' ? sunset(g) : s === 'count' ? count(g) : s === 'ret' ? ret(g) : s === 'diffs' ? diffs(g) : home(g)) +
    (s === 'home' ? '<p class="center"><button type="button" class="ghost small" data-logout>Keluar</button></p>' : '');
  ui.notice = '';
  ui.g = g;
}
const busy = () => tourRunning() || ui.sel.size || (ui.count && Object.keys(ui.count.items).length);

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || !ui.user) return;
  const ds = b.dataset, g = ui.g;
  if (ds.help !== undefined) {
    helpMenu(b, { title: 'Panduan', text: 'Penjelasan setiap layar, langkah demi langkah. Selama panduan, tidak ada yang tersimpan.', startLabel: 'Mulai panduan ›', closeLabel: 'Tutup', start: runTour });
    return;
  }
  if (ds.go) { ui.screen = ds.go; ui.sel = new Set(); ui.sure = false; ui.count = null; render(); scrollTo(0, 0); return; }
  if (ds.notify !== undefined) { try { await Notification.requestPermission(); } catch { /* unsupported */ } render(); return; }
  if (ds.logout !== undefined) {
    b.disabled = true;
    await pushNow();
    // The phones are swapped between staff: never leave with notes only on this phone.
    const n = await waitingCount();
    if (n) { ui.notice = `${n} catatan masih menunggu dikirim — sambungkan ke internet dulu, lalu keluar. (${n} operation${n === 1 ? '' : 's'} still waiting to be sent — connect to the internet first.)`; render(); return; }
    await logout(ui.user); ui.user = null; render(); return;
  }
  if (ds.dismiss) { await dismissRejected(ds.dismiss); render(); return; }
  if (ds.copyop) {
    const r = ui.listed && ui.listed.get(ds.copyop); if (!r) return;
    if (await copyText(opDetails(r, OP[r.type] || r.type), b)) { b.textContent = 'Tersalin'; setTimeout(() => { b.textContent = 'Salin detail'; }, 2000); }
    return;
  }
  if (ds.cell) {
    const id = ds.cell;
    ui.sure = false;
    const touch = ui.screen === 'count' || ui.screen === 'ret' || (ui.screen === 'sunset' && g.trips.some(t => !t.closed));
    if (touch) {
      const c = ui.count = ui.count || newPick();
      if (c.items[id] === undefined) c.items[id] = 'OK'; else { delete c.items[id]; delete c.notes[id]; }
    } else if (ui.sel.has(id)) ui.sel.delete(id); else ui.sel.add(id);
    render(); return;
  }
  if (ds.next !== undefined) {
    const c = ui.count = ui.count || newPick();
    // Many numbers at once in "Pengembalian" is almost always an inventory done in the wrong place (09/11).
    if (ui.screen === 'ret' && Object.keys(c.items).length >= 5 && !c.bulkOk) { c.bulkAsk = true; render(); scrollTo(0, 0); return; }
    c.review = true; ui.sure = false; render(); scrollTo(0, 0); return;
  }
  if (ds.bulkok !== undefined) { ui.count.bulkAsk = false; ui.count.bulkOk = true; ui.count.review = true; render(); return; }
  if (ds.tocount !== undefined) { const c = ui.count; c.bulkAsk = false; c.review = false; ui.screen = 'count'; ui.sure = false; render(); scrollTo(0, 0); return; }
  if (ds.edit !== undefined) { ui.count.review = false; ui.sure = false; render(); return; }
  if (ds.problem) { (ui.count.open = ui.count.open || {})[ds.problem] = true; render(); return; }
  if (ds.rc) { const [id, k] = ds.rc.split('|'); ui.count.items[id] = k; ui.sure = false; render(); return; }
  if (ds.wa) {
    const c = ui.count || newPick();
    const note = String(c.notes[ds.wa] || '').trim();
    window.open(waLink(g.managerWa, `${ds.what} ${dayText()}: ${ds.wa} — ${COND[c.items[ds.wa]] || ''}.${note ? ' ' + note + '.' : ''} Foto terlampir.`), '_blank', 'noopener');
    return;
  }
  if (ds.recount !== undefined) { ui.count = newPick(); render(); return; }
  if (ds.save === 'back' || ds.save === 'ret' || ds.save === 'count') {
    const miss = checkNotes(ui.count);
    if (miss) { const er = document.querySelector('[data-err]'); if (er) er.textContent = `${miss}: tulis komentar untuk “Lainnya”.`; document.querySelector(`[data-note="${miss}"]`)?.focus(); return; }
  }
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
    const c = ui.count || newPick();
    const missing = open.items.filter(id => c.items[id] === undefined);
    b.disabled = true;
    const items = open.items.filter(id => c.items[id] !== undefined);
    const conditions = Object.fromEntries(items.filter(id => c.items[id] !== 'OK').map(id => [id, c.items[id]]));
    const notes = Object.fromEntries(Object.keys(conditions).filter(id => c.notes[id]).map(id => [id, String(c.notes[id]).trim()]));
    await enqueue('sunset_back', { trip: open.trip, items, conditions, notes });
    const broken = Object.keys(conditions).length;
    ui.notice = (missing.length ? `Disimpan. ${missing.length} belum kembali → selisih untuk resepsionis.` : 'Semua masker kembali.') + (broken ? ` ${broken} bermasalah → resepsionis memutuskan.` : '');
    ui.count = null; ui.sure = false; ui.screen = 'home'; render(); return;
  }
  if (ds.save === 'ret') {
    b.disabled = true;
    const items = itemsOf(ui.count);
    await enqueue('gear_return', { gid: newId('G'), items });
    ui.notice = `Pengembalian disimpan: ${items.map(x => x.item).join(', ')}.`;
    ui.count = null; ui.screen = 'home'; render(); return;
  }
  if (ds.save === 'count') {
    if (!ui.sure) { ui.sure = true; render(); return; }
    b.disabled = true;
    const items = itemsOf(ui.count);
    await enqueue('gear_count', { cid: newId('K'), items });
    ui.count = null; ui.sure = false;
    ui.notice = 'Cek terkirim. Hasilnya muncul di sini setelah sampai di sheet.'; render(); return;
  }
});

// A comment is kept as it is typed (no redraw, the keyboard stays open).
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset && t.dataset.note !== undefined && ui.count) ui.count.notes[t.dataset.note] = t.value;
});

// ---------- guided tour (the "?" in the header) ----------
// Each step shows a screen with example choices (nothing is sent: the tour blocks every tap),
// then points at one thing. Texts are for staff who are new to the app.
function runTour() {
  const g0 = ui.g || { items: [], trips: [] };
  const masks = g0.items.filter(i => i.kind === 'mask').map(i => i.id), bikes = g0.items.filter(i => i.kind === 'bike').map(i => i.id);
  const m = k => masks[k] || 'SG00' + (k + 1);
  const screen = async (name, setup) => {
    ui.screen = name; ui.sel = new Set(); ui.sure = false; ui.count = null; ui.tourDiffs = null; ui.notice = '';
    if (setup) setup();
    await render(); scrollTo(0, 0);
  };
  const pick = (ids, review) => { const c = newPick(); ids.forEach(id => { c.items[id] = 'OK'; }); c.review = !!review; ui.count = c; return c; };
  const reviewDemo = () => {
    const c = pick([m(0), m(1), m(2), ...(bikes[0] ? [bikes[0]] : [])], true);
    c.items[m(1)] = 'Snorkel missing'; c.open = { [m(1)]: true }; c.notes[m(1)] = 'contoh: snorkel tidak ada';
  };
  const openTrip = (ui.g?.trips || []).some(t => !t.closed);
  const steps = [
    { show: () => screen('home'), title: 'Selamat datang 👋',
      text: 'Panduan ini menunjukkan semua layar aplikasi gear.\nTekan *Lanjut ›* untuk lanjut.\nSelama panduan, tidak ada yang tersimpan: Anda bisa melihat dengan tenang.' },
    { show: () => screen('home'), el: '#sync', title: 'Koneksi',
      text: 'Status internet. Kalau internet mati, aplikasi tetap bisa dipakai: semua tersimpan di HP dan dikirim otomatis nanti.' },
    { show: () => screen('home'), el: '[data-go="sunset"]', title: 'Sunset Boat',
      text: 'Untuk masker yang *naik perahu*: catat waktu berangkat, lalu catat yang kembali.' },
    { show: () => screen('home'), el: '[data-go="ret"]', title: 'Pengembalian',
      text: 'HANYA kalau *tamu mengembalikan* masker atau sepeda langsung kepada Anda.\n⚠️ Bukan untuk inventaris!' },
    { show: () => screen('home'), el: '[data-go="count"]', title: 'Cek malam = inventaris',
      text: 'Setiap malam sekitar jam *20:00*, hitung semua masker dan sepeda di sini. *Cukup 1 kali* per malam.' },
    { show: () => screen('home'), el: '[data-go="diffs"]', title: 'Selisih',
      text: 'Barang yang tidak cocok antara hitungan Anda dan catatan resepsionis. Diselesaikan bersama resepsionis.' },
    { show: () => screen('home'), el: '.gahome .gawa', title: 'WhatsApp manajer',
      text: 'Ada masalah atau tidak yakin? Hubungi manajer langsung dari sini.' },

    ...(openTrip ? [
      { show: () => screen('sunset'), el: '.gabody > .muted', title: 'Sunset Boat · kembali',
        text: 'Perahu sedang di laut. Saat kembali, sentuh setiap masker yang sudah dikembalikan.' },
      { show: () => screen('sunset', () => pick([m(0), m(1)])), el: '.gagrid', title: 'Sentuh nomornya',
        text: 'Nomor yang disentuh jadi berwarna. Sentuh lagi untuk membatalkan.' },
      { show: () => screen('sunset', () => pick([m(0), m(1)])), el: '[data-next]', title: 'Lanjut',
        text: 'Lalu *Lanjut*: Anda cek kondisi setiap masker, lalu simpan. Masker yang tidak kembali menjadi selisih untuk resepsionis.' },
    ] : [
      { show: () => screen('sunset'), el: '.gabody > .muted', title: 'Sunset Boat · berangkat',
        text: 'Jumlah tamu Sunset Boat hari ini, dari penjualan resepsionis.\nSOP: bawa *2 masker tambahan*.' },
      { show: () => screen('sunset', () => { ui.sel = new Set([m(0), m(1)]); }), el: '.gagrid', title: 'Sentuh masker yang naik perahu',
        text: 'Sentuh nomor setiap masker yang dibawa. Nomor yang dipilih jadi berwarna. Sentuh lagi untuk membatalkan.' },
      { show: () => screen('sunset', () => { ui.sel = new Set([m(0), m(1)]); }), el: '[data-save="out"]', title: 'Simpan berangkat',
        text: 'Tanggal dan jam dicatat otomatis. Saat perahu kembali (sebelum 21:30), buka lagi *Sunset Boat* dan sentuh masker yang kembali.' },
    ]),

    { show: () => screen('count'), el: '.gabody > .muted', title: 'Cek malam',
      text: 'Sentuh semua barang yang *benar-benar ada di depan Anda*.\nAnda tidak melihat barang mana yang sedang disewa: itu disengaja. Sistem yang membandingkan.' },
    { show: () => screen('count', () => pick([m(0), m(1), m(2)])), el: '.gagrid.six', title: 'Masker',
      text: 'Sentuh = ada di sini. Sentuh lagi = batal.\nJangan sentuh nomor yang tidak ada.' },
    { show: () => screen('count', () => pick([m(0), m(1), m(2), ...(bikes[0] ? [bikes[0]] : [])])), el: '.gagrid.three', title: 'Sepeda',
      text: 'Sama untuk sepeda: sentuh yang ada di sini.' },
    { show: () => screen('count', () => pick([m(0), m(1), m(2)])), el: '[data-next]', title: 'Lanjut',
      text: 'Setelah semua yang ada disentuh, tekan *Lanjut* untuk kondisinya.' },
    { show: () => screen('count', reviewDemo), el: '.garowmin', title: 'Kondisi',
      text: 'Setiap barang *Baik*. Kalau rusak atau ada bagian yang hilang, tekan *Ada masalah?* di nomornya.' },
    { show: () => screen('count', reviewDemo), el: '.garow1 .gaconds', title: 'Pilih masalahnya',
      text: 'Rusak, Ring hilang, Snorkel hilang, Masker hilang, atau Lainnya.' },
    { show: () => screen('count', reviewDemo), el: ['.garow1 .ganote', '.garow1'], title: 'Komentar dan foto',
      text: 'Tulis apa yang terjadi (*wajib* untuk Lainnya). Tombol WhatsApp mengirim foto ke manajer. Resepsionis yang memutuskan biaya.' },
    { show: () => screen('count', reviewDemo), el: '[data-save="count"]', title: 'Kirim hasil cek',
      text: 'Sentuh *2 kali* untuk mengirim. Setelah dikirim, hitungan tidak bisa diubah.\nSistem membandingkan dengan catatan resepsionis dan membuat *Selisih* jika ada yang tidak cocok.' },

    { show: () => screen('ret'), el: '.gahint', title: 'Pengembalian',
      text: 'Ingat: hanya untuk barang yang *dikembalikan tamu* kepada Anda. Untuk menghitung semua barang → *Cek malam*.' },
    { show: () => screen('ret', () => pick([m(3)])), el: '.gagrid.six', title: 'Sentuh yang dikembalikan',
      text: 'Sentuh nomor yang dikembalikan tamu, *Lanjut*, cek kondisinya, lalu simpan. Keterlambatan atau kerusakan diputuskan oleh resepsionis.' },

    { show: () => screen('diffs', () => { ui.tourDiffs = [{ id: 'tour-demo', item: m(4), kind: 'missing', last: null }]; }), el: '.gadiff', title: 'Selisih (contoh)',
      text: 'Untuk setiap selisih: cari barangnya.\nKetemu → *Ketemu*. Belum ketemu → *Belum selesai* (tetap terbuka).\nSelisih tertutup jika *Anda dan resepsionis* sama-sama konfirmasi.' },

    { show: () => screen('home'), el: '[data-help]', title: 'Selesai 🎉',
      text: 'Tekan *?* kapan saja untuk melihat panduan ini lagi.\nRingkas:\n• Tamu mengembalikan → *Pengembalian*\n• Inventaris malam → *Cek malam* (1 kali)\n• Perahu → *Sunset Boat*' },
  ];
  startTour(steps, {
    labels: { next: 'Lanjut ›', back: '‹ Kembali', done: 'Selesai', close: 'Tutup', of: 'dari' },
    onEnd: () => { ui.screen = 'home'; ui.sel = new Set(); ui.count = null; ui.sure = false; ui.tourDiffs = null; render(); scrollTo(0, 0); },
  });
}

async function boot() {
  onStatus(renderStrip);
  onStatus((s, evt) => {
    if (evt && evt.pushed) pullNow(); // the differences of a check are worked out by the sheet
    if (evt && (evt.pulled || evt.pushed) && !busy()) render();
  });
  ui.user = await currentUser();
  await cleanupTokens().catch(() => {}); // a session nobody needs any more (nothing waiting) is revoked
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch { /* not supported */ }
  await render();
  startSync();
  // Left from a previous connection (another sheet): shown, never sent.
  warnOtherOutboxes({ labels: OP, gear: true }).catch(() => {});
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
