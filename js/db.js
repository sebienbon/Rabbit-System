// Tiny promise wrapper around IndexedDB. Everything the interface knows lives here,
// so it keeps working during an Internet outage and survives a browser restart.
import { CONFIG } from './config.js';

/** Short stable hash (FNV-1a, base 36) of a text. */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (const c of String(text || '')) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
// One database per sheet (server address): switching from the test copy to the real sheet
// starts empty and never sends test operations to it. The gear app uses its own database.
const DB_BASE = globalThis.RABBIT_DB || 'rabbit-reception';
export const DB_NAME = DB_BASE + '-' + shortHash(CONFIG.API_URL);
/** A localStorage key tied to this database (same sheet, same app). */
export const localKey = k => DB_NAME + ':' + k;
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

/**
 * Operations still waiting in another database of this app (an older server address, or the
 * database from before it was tied to one). Only read, never sent: they belong to another sheet.
 * Returns [{ name, ops }] for each such database with a non-empty outbox.
 */
export async function otherOutboxes() {
  let list = [];
  try { if (indexedDB.databases) list = await indexedDB.databases(); } catch { return []; }
  const names = list.map(d => d.name).filter(n => n && n !== DB_NAME && (n === DB_BASE || (n.startsWith(DB_BASE + '-') && /^[0-9a-z]+$/.test(n.slice(DB_BASE.length + 1)))));
  const out = [];
  for (const name of names) {
    try {
      const ops = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name); // no version: never upgrades (or empties) it
        req.onupgradeneeded = () => { req.transaction.abort(); resolve([]); }; // vanished meanwhile: do not create it
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('outbox')) { d.close(); resolve([]); return; }
          const r = d.transaction('outbox', 'readonly').objectStore('outbox').getAll();
          r.onsuccess = () => { d.close(); resolve(r.result || []); };
          r.onerror = () => { d.close(); reject(r.error); };
        };
      });
      if (ops.length) out.push({ name, ops: ops.sort((a, b) => a.seq - b.seq) });
    } catch { /* unreadable: nothing to show */ }
  }
  return out;
}
