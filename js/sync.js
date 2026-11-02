import { db } from './db.js';
import { api, ApiError } from './api.js';
import { CONFIG } from './config.js';
import { deviceId, reconnect } from './auth.js';

// Everything the receptionist does becomes an "operation" stored locally first
// (instant, works offline), then sent to the spreadsheet in the background.
// Push and pull never run at the same time, and an older server answer never
// overwrites a newer one (the server sends a version number that only grows).

const listeners = new Set();
export const status = {
  state: 'idle',        // idle | sending | offline | expired | error
  pending: 0,
  rejected: 0,
  lastSync: null,
  message: '',
};
export function onStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); }
function emit(patch, evt) { Object.assign(status, patch); listeners.forEach(fn => fn(status, evt)); }

const BATCH = 50;
let chain = Promise.resolve();          // one network job at a time
const serial = job => (chain = chain.then(job, job));
let failures = 0;
let nextPushAt = 0;
let nextPullAt = 0;

export async function enqueue(type, payload) {
  const user = await db.get('currentUser');
  if (!user) throw new Error('Not logged in');
  const dev = await deviceId();
  const op = {
    id: `${dev}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`,
    type, at: new Date().toISOString(), by: user.username, author: user.author || user.username, payload,
  };
  await db.put('outbox', op);
  await refreshCounts();
  nextPushAt = 0;
  setTimeout(tick, 50);
  return op;
}

export async function refreshCounts() {
  const [outbox, rejected] = await Promise.all([db.all('outbox'), db.all('rejected')]);
  emit({ pending: outbox.length, rejected: rejected.length });
}

/** Keeps the newest server view of the shift; returns the batch write for it if newer. */
async function shiftWrite(shift) {
  if (!shift) return [];
  const cur = await db.get('serverShift');
  if (cur && typeof cur.v === 'number' && typeof shift.v === 'number' && shift.v < cur.v) return [];
  return [['kv', 'put', shift, 'serverShift']];
}

function fail(err) {
  failures++;
  const wait = Math.min(5 * 60000, 5000 * 2 ** Math.min(failures, 6));
  nextPushAt = Date.now() + wait;
  nextPullAt = Math.max(nextPullAt, Date.now() + wait);
  if (err.code === 'no_session') emit({ state: 'expired', message: 'Log in while connected to send the waiting operations.' });
  else if (err.network) emit({ state: 'offline', message: err.message });
  else emit({ state: 'error', message: err.message });
}
const asApiError = e => e instanceof ApiError ? e : new ApiError('error', String(e && e.message || e), { network: true });

async function doPush() {
  const outbox = (await db.all('outbox')).sort((a, b) => a.seq - b.seq);
  if (!outbox.length) { if (status.state === 'sending') emit({ state: 'idle' }); return; }
  let token = await db.get('deviceToken');
  if (!token) token = await reconnect();
  if (!token) { emit({ state: 'expired', message: 'Log in while connected to send the waiting operations.' }); return; }
  emit({ state: 'sending' });
  try {
    const slice = outbox.slice(0, BATCH);
    const r = await api('push', { token, deviceId: await deviceId(), ops: slice.map(({ seq, ...op }) => op) });
    const byId = new Map(slice.map(o => [o.id, o]));
    const writes = [];
    for (const res of r.results) {
      const o = byId.get(res.id);
      if (!o) continue;
      writes.push(['outbox', 'delete', o.seq]);
      if (res.status !== 'rejected') writes.push(['applied', 'put', { id: o.id, seq: o.seq, v: (r.shift && r.shift.v) || 0, op: o }]);
      if (res.status === 'rejected') {
        writes.push(['rejected', 'put', { ...o, error: res.error, message: res.message, rejectedAt: new Date().toISOString() }]);
      }
    }
    writes.push(...await shiftWrite(r.shift));
    writes.push(['kv', 'put', new Date().toISOString(), 'lastSync']);
    await db.batch(writes);
    await refreshCounts();
    if (r.partial) {
      // The server hit a Google error part-way; what was done is saved, the rest retries.
      fail(new ApiError('server_error', 'The sheet had a temporary problem.', { network: true }));
    } else {
      failures = 0;
      emit({ state: 'idle', message: '', lastSync: new Date().toISOString() });
      if (outbox.length > BATCH) nextPushAt = 0;
    }
    emit({}, { pushed: r.results });
  } catch (e) {
    fail(asApiError(e));
  }
}

async function doPull() {
  const token = (await db.get('deviceToken')) || await reconnect();
  if (!token) return;
  try {
    const r = await api('pull', { token });
    const v = (r.shift && r.shift.v) || 0;
    const applied = await db.all('applied');
    const writes = [
      ['kv', 'put', r.catalog, 'catalog'],
      ['kv', 'put', r.payments, 'payments'],
      ['kv', 'put', r.guests, 'guests'],
      ['kv', 'put', r.lines || [], 'lines'],
      ['kv', 'put', r.cashbox || [], 'cashbox'],
      ['kv', 'put', v, 'linesV'],
      // Already in this copy, or older than two days (safety net if the version ever jumps).
      ...applied.filter(a => a.v <= v || Date.now() - new Date(a.op.at).getTime() > 2 * 86400000).map(a => ['applied', 'delete', a.id]),
      ['kv', 'put', r.serverTime, 'lastPull'],
      ['kv', 'put', new Date().toISOString(), 'lastSync'],
      ...await shiftWrite(r.shift),
    ];
    writes.push(r.users ? ['kv', 'put', r.users, 'users'] : ['kv', 'delete', 'users']);
    if (r.me) {
      const cur = await db.get('currentUser');
      if (cur && cur.username === r.me.username) writes.push(['kv', 'put', { ...cur, ...r.me }, 'currentUser']);
    }
    await db.batch(writes);
    nextPullAt = Date.now() + CONFIG.PULL_EVERY_MS;
    if (status.state === 'offline' || status.state === 'error') failures = 0;
    emit(status.pending ? { lastSync: new Date().toISOString() } : { state: 'idle', message: '', lastSync: new Date().toISOString() }, { pulled: true });
  } catch (e) {
    fail(asApiError(e));
  }
}

export const pushNow = () => serial(doPush);
export const pullNow = () => serial(doPull);

function tick() {
  const now = Date.now();
  if (now >= nextPushAt) { nextPushAt = now + CONFIG.PUSH_EVERY_MS; pushNow(); }
  if (now >= nextPullAt) { nextPullAt = now + CONFIG.PULL_EVERY_MS; pullNow(); }
}

export function startSync() {
  refreshCounts();
  setInterval(tick, 3000);
  window.addEventListener('online', () => { failures = 0; nextPushAt = 0; nextPullAt = 0; tick(); });
  window.addEventListener('offline', () => emit({ state: 'offline', message: 'No Internet connection' }));
  tick();
}

export async function dismissRejected(id) { await db.remove('rejected', id); await refreshCounts(); }
