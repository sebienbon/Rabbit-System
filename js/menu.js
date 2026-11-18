// The table QR code (menu.html?t=5): recognises the phone by the key it got at check-in (only this
// site can read it), asks the server a one-time pass and sends the phone to the bar POS on the hostel
// Wi-Fi: <POS address>/guest?pass=…&table=…. The POS checks the pass (ci_menu_verify) and knows the guest.
import { api } from './api.js';

const T = {
  en: { opening: 'Opening the menu…', slow: 'Menu not opening? Connect your phone to the Wi-Fi of The Rabbit Tree, then scan the QR code again.',
    unknown: 'Your phone is not registered yet.', checkin: 'Please check in at the reception: scan the QR code on the desk with your phone camera.',
    off: 'The menu is not available right now. Please order at the bar.', retry: 'Try again', hi: 'Hello {name}!' },
  id: { opening: 'Membuka menu…', slow: 'Menu tidak terbuka? Sambungkan ponsel ke Wi-Fi The Rabbit Tree, lalu pindai kode QR lagi.',
    unknown: 'Ponsel Anda belum terdaftar.', checkin: 'Silakan check-in di resepsionis: pindai kode QR di meja resepsionis dengan kamera ponsel.',
    off: 'Menu belum tersedia saat ini. Silakan pesan di bar.', retry: 'Coba lagi', hi: 'Halo {name}!' },
  fr: { opening: 'Ouverture du menu…', slow: 'Le menu ne s\'ouvre pas ? Connectez votre téléphone au Wi-Fi du Rabbit Tree, puis scannez à nouveau le QR code.',
    unknown: 'Votre téléphone n\'est pas encore enregistré.', checkin: 'Faites votre check-in à la réception : scannez le QR code du comptoir avec l\'appareil photo.',
    off: 'Le menu n\'est pas disponible pour le moment. Commandez au bar.', retry: 'Réessayer', hi: 'Bonjour {name} !' },
  es: { opening: 'Abriendo el menú…', slow: '¿No se abre el menú? Conecta tu teléfono al Wi-Fi de The Rabbit Tree y vuelve a escanear el código QR.',
    unknown: 'Tu teléfono aún no está registrado.', checkin: 'Haz el check-in en recepción: escanea el código QR del mostrador con la cámara.',
    off: 'El menú no está disponible ahora. Pide en el bar.', retry: 'Reintentar', hi: '¡Hola, {name}!' },
  zh: { opening: '正在打开菜单…', slow: '菜单打不开？请将手机连接到 The Rabbit Tree 的 Wi-Fi，然后再次扫描二维码。',
    unknown: '您的手机尚未登记。', checkin: '请到前台办理入住：用手机相机扫描前台的二维码。',
    off: '菜单暂时不可用，请到吧台点单。', retry: '重试', hi: '{name}，您好！' },
};
const pick = () => {
  let saved = null; try { saved = localStorage.getItem('rt_lang'); } catch { /* ignore */ }
  const nav = (navigator.languages || [navigator.language || 'en']).map(l => String(l).slice(0, 2).toLowerCase());
  return [saved, ...nav].find(l => T[l]) || 'en';
};
let lang = pick();
const t = (k, v = {}) => (T[lang][k] || T.en[k]).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = document.querySelector('#main');
const table = (new URLSearchParams(location.search).get('t') || '').slice(0, 20);

/** The key given at check-in (never created here: an unknown phone stays unknown). */
function deviceKey() {
  let k = null;
  try { k = localStorage.getItem('rt_device_key'); } catch { /* private mode */ }
  if (!k) { const m = document.cookie.match(/(?:^|; )rt_device_key=([a-f0-9]{64})/); if (m) k = m[1]; }
  return k && /^[a-f0-9]{64}$/.test(k) ? k : null;
}
function screen(icon, title, text, retry) {
  main.innerHTML = `<div class="card big"><div class="icon">${icon}</div>${title ? `<h1>${esc(title)}</h1>` : ''}${text ? `<p>${esc(text)}</p>` : ''}
    ${retry ? `<button class="btn soft" id="retry" style="margin-top:14px">${esc(t('retry'))}</button>` : ''}</div>`;
  const r = document.querySelector('#retry'); if (r) r.onclick = go;
}
async function go() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.querySelector('#lang').value = lang;
  const key = deviceKey();
  if (!key) { screen('🐰', t('unknown'), t('checkin')); return; }
  screen('<span class="spin"></span>', '', t('opening'));
  try {
    const r = await api('ci_menu_pass', { key, table }, 20000);
    if (!r.posUrl) { screen('🍹', t('hi', { name: r.guest }), t('off'), true); return; }
    screen('<span class="spin"></span>', t('hi', { name: r.guest }), t('opening'));
    const q = new URLSearchParams({ pass: r.pass, lang }); if (r.table) q.set('table', r.table);
    location.replace(`${r.posUrl}/guest?${q}`);
    // still here after a few seconds: the POS is not reachable (not on the hostel Wi-Fi)
    setTimeout(() => screen('📶', t('hi', { name: r.guest }), t('slow'), true), 6000);
  } catch (e) {
    if (e.code === 'unknown_device' || e.code === 'bad_key') screen('🐰', t('unknown'), t('checkin'));
    else screen('📶', '', e.message, true);
  }
}
document.querySelector('#lang').onchange = e => { lang = e.target.value; try { localStorage.setItem('rt_lang', lang); } catch { /* ignore */ } go(); };
go();
