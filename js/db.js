// Tiny promise wrapper around IndexedDB. Everything the interface knows lives here,
// so it keeps working during an Internet outage and survives a browser restart.
const DB_NAME = globalThis.RABBIT_DB || 'rabbit-reception'; // the gear app uses its own database
const DB_VERSION = 2;
const STORES = ['kv', 'outbox', 'shifts', 'rejected', 'applied'];

let dbPromise;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains('shifts')) db.createObjectStore('shifts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('rejected')) db.createObjectStore('rejected', { keyPath: 'id' });
        // Operations the sheet accepted but that are not yet in the last copy of the lines.
        if (!db.objectStoreNames.contains('applied')) db.createObjectStore('applied', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  get: (key) => tx('kv', 'readonly', s => req2p(s.get(key))),
  set: (key, value) => tx('kv', 'readwrite', s => { s.put(value, key); }),
  del: (key) => tx('kv', 'readwrite', s => { s.delete(key); }),
  all: (store) => tx(store, 'readonly', s => req2p(s.getAll())),
  put: (store, value) => tx(store, 'readwrite', s => { s.put(value); }),
  remove: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
  /** Writes several things atomically: [[store, 'put'|'delete', valueOrKey, kvKey?], ...] */
  batch: (ops) => open().then(d => new Promise((resolve, reject) => {
    const stores = [...new Set(ops.map(o => o[0]))];
    const t = d.transaction(stores, 'readwrite');
    for (const [store, kind, value, key] of ops) {
      const s = t.objectStore(store);
      if (kind === 'put') key !== undefined ? s.put(value, key) : s.put(value);
      else s.delete(value);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  })),
  STORES,
};
