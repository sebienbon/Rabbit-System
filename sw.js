// Keeps the interface itself available without Internet. Data lives in IndexedDB;
// calls to the Apps Script server are never cached.
//
// Cache first, from a set of files fixed per VERSION: the app opens instantly even
// when the router is up but the Internet is not, and never mixes old and new files.
// To ship an update: change VERSION. The page reloads itself once nobody is typing.
const VERSION = 'reception-2026-11-06a-shift-filter';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './js/app.js', './js/db.js', './js/api.js', './js/auth.js', './js/sync.js', './js/shift.js', './js/config.js',
  './js/ledger.js', './js/work.js', './js/sellextra.js', './js/bar.js', './js/gear.js', './js/gearcore.js',
  './gear.html', './gear.webmanifest', './js/gearapp.js',
  './fonts/nunito-latin-400-normal.woff2', './fonts/nunito-latin-700-normal.woff2', './fonts/nunito-latin-800-normal.woff2',
  './fonts/baloo-2-latin-700-normal.woff2', './fonts/baloo-2-latin-800-normal.woff2',
  './img/sales.webp', './img/bills.webp', './img/expenses.webp', './img/phantom.webp', './img/partners.webp', './img/edc.webp',
  './img/summary.webp', './img/gear.webp', './img/close.webp', './img/open.webp', './img/unpaid.webp',
  './img/logo-mark-white.png', './img/logo-name-white.png', './img/logo-mark-ink.png', './img/logo-name-ink.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' bypasses the HTTP cache so a new VERSION really gets new files.
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    if (e.request.mode === 'navigate') return (await c.match('./index.html')) || fetch(e.request);
    return fetch(e.request);
  }));
});
// A tap on a reminder (evening check, differences) brings its app to the front, or opens it.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './gear.html', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const norm = u => u.split(/[?#]/)[0].replace(/index\.html$/, '');
    const same = list.find(c => norm(c.url) === norm(url));
    if (same) return same.focus();
    return self.clients.openWindow ? self.clients.openWindow(url) : null;
  }));
});
