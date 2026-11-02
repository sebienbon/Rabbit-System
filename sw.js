// Keeps the interface itself available without Internet. Data lives in IndexedDB;
// calls to the Apps Script server are never cached.
//
// Cache first, from a set of files fixed per VERSION: the app opens instantly even
// when the router is up but the Internet is not, and never mixes old and new files.
// To ship an update: change VERSION. The page reloads itself once nobody is typing.
const VERSION = 'reception-2026-11-02i';
const SHELL = [
  './', './index.html', './app.css', './manifest.webmanifest', './icon.svg',
  './js/app.js', './js/db.js', './js/api.js', './js/auth.js', './js/sync.js', './js/shift.js', './js/config.js',
  './js/ledger.js', './js/work.js',
  './fonts/atkinson-hyperlegible-latin-400-normal.woff2', './fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  './fonts/bricolage-grotesque-latin-600-normal.woff2', './fonts/bricolage-grotesque-latin-800-normal.woff2',
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
