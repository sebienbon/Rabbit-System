// Guest page of the check-in (checkin.html), opened by the fixed QR code on the desk with the
// phone's camera. The phone keeps a random key in its browser: the reception links it to the guest
// when the check-in is validated, and the menu will later recognise the phone by it.
// Everything typed is saved at once, so the receptionist sees it live on the desk screen.
import { api } from './api.js';
import { parseMrz } from './mrz.js';

const T = {
  en: {
    loading: 'Loading…', hello: 'Welcome to The Rabbit Tree!',
    none: 'Please ask the reception to start your check-in, then scan the QR code again.',
    retry: 'Try again',
    removed: 'This phone was taken out of the check-in by the reception. Please ask the reception.',
    closed: 'This check-in was closed by the reception.',
    back: 'Welcome back, {name}!', backText: 'Your phone is registered for your stay{until}.', until: ' until {date}',
    longer: 'Want to stay longer? Ask the reception.',
    title: 'Check-in', booking: 'Booking', room: 'Room', dates: 'Dates',
    who: 'Who are you?', isMe: 'I am {name}', other: 'Another person in this booking', yourName: 'Your full name',
    passport: 'Passport', shoot: 'Take a photo of your passport', reshoot: 'Take the photo again',
    shootHelp: 'The page with your photo, flat and sharp, with the two lines at the bottom readable.',
    reading: 'Reading the passport number…', readOk: 'Number read from the photo. Please check it.',
    readFail: 'We could not read the number. Please type it, or take the photo again.',
    number: 'Passport number', sending: 'Sending…', saved: 'Saved', done: 'Done',
    missing: 'Still missing: {what}.', mName: 'your name', mPhoto: 'the passport photo', mNumber: 'the passport number',
    thanks: 'Thank you!', checking: 'The reception is checking your details.', edit: 'Change something',
    welcome: 'You are checked in!', welcomeText: 'Your phone is now registered for your stay: scan the QR code on the tables to see the menu.',
    offline: 'No connection — retrying…', photoErr: 'The photo could not be sent. Please try again.',
    inapp: 'Please open this page in Safari or Chrome: scan the QR code with your phone\'s camera app.',
  },
  id: {
    loading: 'Memuat…', hello: 'Selamat datang di The Rabbit Tree!',
    none: 'Silakan minta resepsionis untuk memulai check-in Anda, lalu pindai kode QR lagi.',
    retry: 'Coba lagi',
    removed: 'Ponsel ini dikeluarkan dari check-in oleh resepsionis. Silakan tanya resepsionis.',
    closed: 'Check-in ini sudah ditutup oleh resepsionis.',
    back: 'Selamat datang kembali, {name}!', backText: 'Ponsel Anda terdaftar untuk masa menginap Anda{until}.', until: ' sampai {date}',
    longer: 'Ingin menginap lebih lama? Tanyakan ke resepsionis.',
    title: 'Check-in', booking: 'Pemesanan', room: 'Kamar', dates: 'Tanggal',
    who: 'Siapa Anda?', isMe: 'Saya {name}', other: 'Orang lain dalam pemesanan ini', yourName: 'Nama lengkap Anda',
    passport: 'Paspor', shoot: 'Foto paspor Anda', reshoot: 'Foto ulang',
    shootHelp: 'Halaman dengan foto Anda, rata dan jelas, dua baris di bagian bawah harus terbaca.',
    reading: 'Membaca nomor paspor…', readOk: 'Nomor terbaca dari foto. Mohon periksa.',
    readFail: 'Nomor tidak terbaca. Silakan ketik, atau foto ulang.',
    number: 'Nomor paspor', sending: 'Mengirim…', saved: 'Tersimpan', done: 'Selesai',
    missing: 'Masih kurang: {what}.', mName: 'nama Anda', mPhoto: 'foto paspor', mNumber: 'nomor paspor',
    thanks: 'Terima kasih!', checking: 'Resepsionis sedang memeriksa data Anda.', edit: 'Ubah sesuatu',
    welcome: 'Check-in selesai!', welcomeText: 'Ponsel Anda sekarang terdaftar untuk masa menginap Anda: pindai kode QR di meja untuk melihat menu.',
    offline: 'Tidak ada koneksi — mencoba lagi…', photoErr: 'Foto tidak terkirim. Silakan coba lagi.',
    inapp: 'Buka halaman ini di Safari atau Chrome: pindai kode QR dengan aplikasi kamera ponsel Anda.',
  },
  fr: {
    loading: 'Chargement…', hello: 'Bienvenue au Rabbit Tree !',
    none: 'Demandez à la réception de lancer votre check-in, puis scannez à nouveau le QR code.',
    retry: 'Réessayer',
    removed: 'La réception a retiré ce téléphone du check-in. Merci de vous adresser à la réception.',
    closed: 'Ce check-in a été fermé par la réception.',
    back: 'Bon retour, {name} !', backText: 'Votre téléphone est enregistré pour votre séjour{until}.', until: ' jusqu\'au {date}',
    longer: 'Envie de rester plus longtemps ? Demandez à la réception.',
    title: 'Check-in', booking: 'Réservation', room: 'Chambre', dates: 'Dates',
    who: 'Qui êtes-vous ?', isMe: 'Je suis {name}', other: 'Une autre personne de cette réservation', yourName: 'Votre nom complet',
    passport: 'Passeport', shoot: 'Prendre en photo votre passeport', reshoot: 'Reprendre la photo',
    shootHelp: 'La page avec votre photo, à plat et nette, avec les deux lignes du bas lisibles.',
    reading: 'Lecture du numéro de passeport…', readOk: 'Numéro lu sur la photo. Vérifiez-le.',
    readFail: 'Impossible de lire le numéro. Tapez-le, ou reprenez la photo.',
    number: 'Numéro de passeport', sending: 'Envoi…', saved: 'Enregistré', done: 'Terminé',
    missing: 'Il manque encore : {what}.', mName: 'votre nom', mPhoto: 'la photo du passeport', mNumber: 'le numéro de passeport',
    thanks: 'Merci !', checking: 'La réception vérifie vos informations.', edit: 'Modifier',
    welcome: 'Check-in terminé !', welcomeText: 'Votre téléphone est enregistré pour votre séjour : scannez le QR code sur les tables pour voir le menu.',
    offline: 'Pas de connexion — nouvel essai…', photoErr: 'La photo n\'a pas pu être envoyée. Réessayez.',
    inapp: 'Ouvrez cette page dans Safari ou Chrome : scannez le QR code avec l\'appareil photo du téléphone.',
  },
  es: {
    loading: 'Cargando…', hello: '¡Bienvenido a The Rabbit Tree!',
    none: 'Pide a la recepción que inicie tu check-in y vuelve a escanear el código QR.',
    retry: 'Reintentar',
    removed: 'La recepción quitó este teléfono del check-in. Pregunta en recepción.',
    closed: 'La recepción cerró este check-in.',
    back: '¡Hola de nuevo, {name}!', backText: 'Tu teléfono está registrado para tu estancia{until}.', until: ' hasta el {date}',
    longer: '¿Quieres quedarte más tiempo? Pregunta en recepción.',
    title: 'Check-in', booking: 'Reserva', room: 'Habitación', dates: 'Fechas',
    who: '¿Quién eres?', isMe: 'Soy {name}', other: 'Otra persona de esta reserva', yourName: 'Tu nombre completo',
    passport: 'Pasaporte', shoot: 'Haz una foto de tu pasaporte', reshoot: 'Repetir la foto',
    shootHelp: 'La página con tu foto, plana y nítida, con las dos líneas de abajo legibles.',
    reading: 'Leyendo el número de pasaporte…', readOk: 'Número leído en la foto. Compruébalo.',
    readFail: 'No pudimos leer el número. Escríbelo o repite la foto.',
    number: 'Número de pasaporte', sending: 'Enviando…', saved: 'Guardado', done: 'Listo',
    missing: 'Falta: {what}.', mName: 'tu nombre', mPhoto: 'la foto del pasaporte', mNumber: 'el número de pasaporte',
    thanks: '¡Gracias!', checking: 'La recepción está revisando tus datos.', edit: 'Cambiar algo',
    welcome: '¡Check-in hecho!', welcomeText: 'Tu teléfono ya está registrado para tu estancia: escanea el código QR de las mesas para ver el menú.',
    offline: 'Sin conexión — reintentando…', photoErr: 'No se pudo enviar la foto. Inténtalo de nuevo.',
    inapp: 'Abre esta página en Safari o Chrome: escanea el código QR con la app de cámara del teléfono.',
  },
  zh: {
    loading: '加载中…', hello: '欢迎来到 The Rabbit Tree！',
    none: '请先请前台为您开始办理入住，然后再次扫描二维码。',
    retry: '重试',
    removed: '前台已将此手机从入住登记中移除。请联系前台。',
    closed: '前台已关闭此次入住登记。',
    back: '欢迎回来，{name}！', backText: '您的手机已登记，适用于本次住宿{until}。', until: '，至 {date}',
    longer: '想多住几晚？请联系前台。',
    title: '办理入住', booking: '预订', room: '房间', dates: '日期',
    who: '您是哪位？', isMe: '我是 {name}', other: '此预订中的另一位客人', yourName: '您的全名',
    passport: '护照', shoot: '拍摄护照照片', reshoot: '重新拍摄',
    shootHelp: '请拍摄带有您照片的那一页，平整清晰，底部两行文字要能看清。',
    reading: '正在读取护照号码…', readOk: '已从照片读取号码，请核对。',
    readFail: '无法读取号码。请手动输入，或重新拍摄。',
    number: '护照号码', sending: '发送中…', saved: '已保存', done: '完成',
    missing: '还缺少：{what}。', mName: '您的姓名', mPhoto: '护照照片', mNumber: '护照号码',
    thanks: '谢谢！', checking: '前台正在核对您的信息。', edit: '修改信息',
    welcome: '入住登记完成！', welcomeText: '您的手机已登记，适用于本次住宿：扫描桌上的二维码即可查看菜单。',
    offline: '无网络连接 — 正在重试…', photoErr: '照片发送失败，请重试。',
    inapp: '请在 Safari 或 Chrome 中打开此页面：用手机相机扫描二维码。',
  },
};
const LANGS = Object.keys(T);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);

// ---------- the phone's key (kept in the browser; the server stores only its hash) ----------
const KEY_NAME = 'rt_device_key';
function deviceKey() {
  let k = null;
  try { k = localStorage.getItem(KEY_NAME); } catch { /* private mode */ }
  if (!k) { const m = document.cookie.match(/(?:^|; )rt_device_key=([a-f0-9]{64})/); if (m) k = m[1]; }
  if (!k || !/^[a-f0-9]{64}$/.test(k)) {
    const b = new Uint8Array(32); crypto.getRandomValues(b);
    k = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  try { localStorage.setItem(KEY_NAME, k); } catch { /* ignore */ }
  document.cookie = `${KEY_NAME}=${k}; max-age=34560000; path=/; SameSite=Lax; Secure`;
  return k;
}
const KEY = deviceKey();

// ---------- state ----------
const st = {
  lang: pickLang(), mode: 'loading', session: null, me: null, guest: null,
  who: null, name: '', passport: '', photoUrl: null, ocr: 'idle', sendingPhoto: false,
  finished: false, saved: '', error: '', offline: false, closedNotice: false,
};
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  let saved = null; try { saved = localStorage.getItem('rt_lang'); } catch { /* ignore */ }
  const nav = (navigator.languages || [navigator.language || 'en']).map(l => String(l).slice(0, 2).toLowerCase());
  return [q, saved, ...nav].find(l => LANGS.includes(l)) || 'en';
}
const t = (k, vars = {}) => (T[st.lang][k] ?? T.en[k]).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
const fmtDate = ymd => {
  if (!ymd) return '';
  const d = new Date(ymd + 'T12:00:00');
  try { return d.toLocaleDateString({ en: 'en-GB', id: 'id-ID', fr: 'fr-FR', es: 'es-ES', zh: 'zh-CN' }[st.lang], { day: 'numeric', month: 'short' }); } catch { return ymd; }
};

// In-app browsers (Instagram, Facebook, WeChat…) keep their own storage: the menu would not find the key.
const IN_APP = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|musical_ly|; wv\)/i.test(navigator.userAgent);

// ---------- server ----------
async function call(action, body = {}) {
  try {
    const r = await api(action, { key: KEY, lang: st.lang, ...body }, 30000);
    if (st.offline) { st.offline = false; showNet(); }
    return r;
  } catch (e) {
    if (e.network) { st.offline = true; showNet(); }
    throw e;
  }
}
function showNet() { const n = $('#net'); n.hidden = !st.offline; n.textContent = t('offline'); }

async function hello(join = false) {
  try {
    const r = await call('ci_hello', { join });
    const was = st.mode;
    st.mode = r.mode; st.session = r.session || st.session; st.guest = r.guest || null;
    if (r.me) {
      const first = !st.me || st.me.pid !== r.me.pid;
      st.me = r.me;
      if (first) { st.who = r.me.who === 'booking' && r.me.name ? 'booking' : r.me.name ? 'other' : null; st.name = r.me.who === 'other' ? r.me.name : ''; st.passport = r.me.passport || ''; }
    }
    if (was === 'session' && r.mode === 'none') st.closedNotice = true;
    if (r.mode === 'known' && was === 'session') st.justDone = true;
    if (r.mode !== was || r.mode !== 'session' || !document.querySelector('#form')) render();
    else updateStatus();
  } catch (e) {
    if (!e.network) { st.error = e.message; if (st.mode === 'loading') { st.mode = 'error'; render(); } }
  }
}

// ---------- rendering ----------
function render() {
  document.documentElement.lang = st.lang === 'zh' ? 'zh-CN' : st.lang;
  $('#lang').value = st.lang;
  showNet();
  const m = $('#main');
  const inapp = IN_APP ? `<div class="note warn">${esc(t('inapp'))}</div>` : '';
  if (st.mode === 'loading') { m.innerHTML = `<p class="muted"><span class="spin"></span> ${esc(t('loading'))}</p>`; return; }
  if (st.mode === 'error') { m.innerHTML = `${inapp}<div class="card big"><p>${esc(st.error)}</p><button class="btn soft" id="retry">${esc(t('retry'))}</button></div>`; $('#retry').onclick = () => location.reload(); return; }
  if (st.mode === 'none' || st.mode === 'removed') {
    m.innerHTML = `${inapp}<div class="card big"><div class="icon">🐰</div><h1>${esc(t('hello'))}</h1>
      ${st.closedNotice && st.mode === 'none' ? `<p class="note warn">${esc(t('closed'))}</p>` : ''}
      <p>${esc(t(st.mode === 'removed' ? 'removed' : 'none'))}</p>
      <button class="btn soft" id="retry" style="margin-top:14px">${esc(t('retry'))}</button></div>`;
    $('#retry').onclick = () => { st.closedNotice = false; hello(true); };
    return;
  }
  if (st.mode === 'known') {
    const g = st.guest || {};
    m.innerHTML = `${inapp}<div class="card big"><div class="icon">${st.justDone ? '🎉' : '🐰'}</div>
      <h1>${esc(st.justDone ? t('welcome') : t('back', { name: g.name }))}</h1>
      <p>${esc(st.justDone ? t('welcomeText') : t('backText', { until: g.departure ? t('until', { date: fmtDate(g.departure) }) : '' }))}</p>
      ${st.justDone ? '' : `<p class="muted">${esc(t('longer'))}</p>`}</div>`;
    return;
  }
  // session
  const s = st.session || {};
  if (st.finished && st.me && st.me.status === 'ready') {
    m.innerHTML = `${inapp}<div class="card big"><div class="icon">⏳</div><h1>${esc(t('thanks'))}</h1><p>${esc(t('checking'))}</p>
      <button class="btn soft" id="edit" style="margin-top:14px">${esc(t('edit'))}</button></div>`;
    $('#edit').onclick = () => { st.finished = false; render(); };
    return;
  }
  const dates = s.arrival ? `${fmtDate(s.arrival)} → ${fmtDate(s.departure)}` : '';
  m.innerHTML = `${inapp}<h1>${esc(t('title'))}</h1>
    <div class="card"><dl class="stay"><dt>${esc(t('booking'))}</dt><dd>${esc(s.name)}</dd>
      ${s.room ? `<dt>${esc(t('room'))}</dt><dd>${esc(s.room)}</dd>` : ''}${dates ? `<dt>${esc(t('dates'))}</dt><dd>${esc(dates)}</dd>` : ''}</dl></div>
    <form id="form" autocomplete="off" onsubmit="return false">
      <div class="card"><h2>${esc(t('who'))}</h2>
        <label class="choice"><input type="radio" name="who" value="booking" ${st.who === 'booking' ? 'checked' : ''}> <span>${esc(t('isMe', { name: s.name }))}</span></label>
        <label class="choice"><input type="radio" name="who" value="other" ${st.who === 'other' ? 'checked' : ''}> <span>${esc(t('other'))}</span></label>
        <div id="otherBox" ${st.who === 'other' ? '' : 'hidden'}><input type="text" id="name" autocomplete="name" placeholder="${esc(t('yourName'))}" value="${esc(st.name)}" maxlength="60"></div>
      </div>
      <div class="card"><h2>${esc(t('passport'))}</h2>
        <p class="muted" style="font-size:.95rem">${esc(t('shootHelp'))}</p>
        <input type="file" id="file" accept="image/*" hidden>
        <button type="button" class="btn ${st.photoUrl || (st.me && st.me.photo) ? 'soft' : 'go'}" id="shoot">📷 ${esc(st.photoUrl || (st.me && st.me.photo) ? t('reshoot') : t('shoot'))}</button>
        <div class="shot" ${st.photoUrl ? '' : 'hidden'}><img id="preview" alt="" src="${st.photoUrl || ''}"></div>
        <div id="ocr"></div>
        <label class="field">${esc(t('number'))}<input type="text" id="passport" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="20" value="${esc(st.passport)}"></label>
      </div>
      <div id="missing"></div>
      <button type="button" class="btn go" id="done">${esc(t('done'))}</button>
      <div class="saved" id="saved"></div>
    </form>`;
  bindForm();
  updateStatus();
}
function updateStatus() {
  const o = $('#ocr');
  if (o) {
    o.innerHTML = st.sendingPhoto ? `<div class="note busy"><span class="spin"></span> ${esc(t('sending'))}</div>`
      : st.ocr === 'reading' ? `<div class="note busy"><span class="spin"></span> ${esc(t('reading'))}</div>`
      : st.ocr === 'ok' ? `<div class="note ok">${esc(t('readOk'))}</div>`
      : st.ocr === 'fail' ? `<div class="note warn">${esc(t('readFail'))}</div>`
      : st.photoErr ? `<div class="note bad">${esc(t('photoErr'))}</div>` : '';
  }
  const sv = $('#saved'); if (sv) sv.textContent = st.saved;
  if (st.finished && st.me && st.me.status === 'ready' && $('#form')) render();
}

// ---------- form ----------
let saveTimer = null;
function save(fields, now = false) {
  clearTimeout(saveTimer);
  st.pending = { ...(st.pending || {}), ...fields };
  const go = async () => {
    const p = st.pending; st.pending = null;
    if (!p) return;
    try {
      const r = await call('ci_set', { sid: st.session.sid, ...p });
      st.me = r.me; st.saved = t('saved'); updateStatus();
    } catch (e) {
      if (e.code === 'session_closed' || e.code === 'not_joined' || e.code === 'already_done') { hello(); return; }
      st.pending = { ...p, ...(st.pending || {}) }; saveTimer = setTimeout(go, 3000); // offline: try again
    }
  };
  if (now) return go();
  saveTimer = setTimeout(go, 700);
}
function bindForm() {
  document.querySelectorAll('input[name=who]').forEach(r => r.onchange = () => {
    st.who = r.value;
    $('#otherBox').hidden = st.who !== 'other';
    if (st.who === 'booking') save({ who: 'booking' }, true);
    else { $('#name').focus(); if (st.name) save({ who: 'other', name: st.name }); }
  });
  const nm = $('#name');
  if (nm) nm.oninput = () => { st.name = nm.value; if (st.name.trim()) save({ who: 'other', name: st.name.trim() }); };
  const pp = $('#passport');
  pp.oninput = () => { st.passport = pp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); save({ passport: st.passport }); };
  $('#shoot').onclick = () => $('#file').click();
  $('#file').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) takePhoto(f); };
  $('#done').onclick = finish;
}
async function finish() {
  clearTimeout(saveTimer);
  if (st.pending) await save({}, true);
  const miss = [];
  if (!st.who || (st.who === 'other' && !st.name.trim())) miss.push(t('mName'));
  if (!(st.me && st.me.photo)) miss.push(t('mPhoto'));
  if (!st.passport) miss.push(t('mNumber'));
  if (miss.length) { $('#missing').innerHTML = `<div class="note warn">${esc(t('missing', { what: miss.join(', ') }))}</div>`; return; }
  st.finished = true;
  if (st.me && st.me.status === 'ready') render(); else await hello();
}

// ---------- passport photo ----------
async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older Safari */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url; await img.decode(); return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
/** The photo kept: ~1000 px wide JPEG (~100 KB), enough to read the passport. */
function shrink(img, maxW = 1000) {
  const w = img.width, h = img.height, k = Math.min(1, maxW / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
async function takePhoto(file) {
  st.photoErr = false; st.ocr = 'idle';
  let img;
  try { img = await loadImage(file); } catch { st.photoErr = true; updateStatus(); return; }
  const data = shrink(img);
  st.photoUrl = data; render();
  // send first (the desk sees it at once), then read the number on the full-size picture
  st.sendingPhoto = true; updateStatus();
  const send = (async () => {
    for (let i = 0; i < 3; i++) {
      try { const r = await call('ci_photo', { sid: st.session.sid, data }); st.me = r.me; st.saved = t('saved'); return true; } catch (e) {
        if (!e.network) break;
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    st.photoErr = true; return false;
  })();
  await send; st.sendingPhoto = false; render();
  if (st.photoErr) return;
  st.ocr = 'reading'; updateStatus();
  let found = null;
  try { found = await readNumber(img); } catch (e) { console.warn('OCR', e); }
  if (found) {
    st.ocr = 'ok'; st.passport = found.number;
    const pp = $('#passport'); if (pp) { pp.value = found.number; pp.classList.add('check'); }
    save({ passport: found.number }, true);
  } else st.ocr = st.passport ? 'idle' : 'fail';
  updateStatus();
}

// ---------- reading the MRZ on the phone (Tesseract, loaded the first time, kept by the browser) ----------
let tesseract = null;
function loadScript(src) {
  return new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });
}
async function ocrWorker() {
  if (tesseract) return tesseract;
  const base = new URL('vendor/tesseract/', location.href).href;
  if (!window.Tesseract) await loadScript(base + 'tesseract.min.js');
  tesseract = await window.Tesseract.createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base + 'lang' });
  await tesseract.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', tessedit_pageseg_mode: '6' });
  return tesseract;
}
/** The bottom of the page, grey and contrasted, about 1600 px wide: where the two MRZ lines are. */
function mrzCrop(img, from, rotate) {
  const W = img.width, H = img.height, top = Math.round(H * from), h = H - top;
  const k = Math.min(2, 1600 / W), c = document.createElement('canvas');
  c.width = Math.round(W * k); c.height = Math.round(h * k);
  const g = c.getContext('2d');
  if (rotate) { g.translate(c.width, c.height); g.rotate(Math.PI); g.drawImage(img, 0, 0, W, h, 0, 0, c.width, c.height); }
  else g.drawImage(img, 0, top, W, h, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height), d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    const v = y < 110 ? 0 : y > 170 ? 255 : (y - 110) * 255 / 60;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(px, 0, 0);
  return c;
}
async function readNumber(img) {
  const w = await ocrWorker();
  // bottom 35 %, then bottom 55 %, then the photo upside down (top 35 % turned around)
  for (const [from, rot] of [[0.65, false], [0.45, false], [0, true]]) {
    const src = rot ? (() => { const c = document.createElement('canvas'); c.width = img.width; c.height = Math.round(img.height * 0.35); c.getContext('2d').drawImage(img, 0, 0, img.width, c.height, 0, 0, c.width, c.height); return c; })() : img;
    const { data } = await w.recognize(mrzCrop(src, rot ? 0 : from, rot));
    const r = parseMrz(data.text);
    if (r) return r;
  }
  return null;
}

// ---------- start ----------
$('#lang').onchange = e => {
  st.lang = e.target.value;
  try { localStorage.setItem('rt_lang', st.lang); } catch { /* ignore */ }
  render();
  if (st.mode === 'session' && st.session) save({ lang: st.lang });
};
render();
hello(true); // opening the page (the scan) joins the check-in open at the desk
setInterval(() => { if (document.visibilityState === 'visible' && !st.sendingPhoto) hello(); }, 3000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') hello(); });
