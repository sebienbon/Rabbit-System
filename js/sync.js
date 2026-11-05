import { db, otherOutboxes, shortHash } from './db.js';
import { api, ApiError } from './api.js';
import { CONFIG } from './config.js';
import { deviceId, reconnect, tokenFor, cleanupTokens } from './auth.js';

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
  stuck: null,          // the first waiting operation, when the sheet keeps failing on it
  clockSkew: 0,         // sheet time minus this device's time at the last pull (ms)
};
export const STUCK_AFTER = 5;          // "partial" answers in a row on the same operation
export const CLOCK_WARN_MS = 10 * 60000;
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
  const [outbox, rejected, stuck, skew] = await Promise.all([db.all('outbox'), db.all('rejected'), db.get('stuck'), db.get('clockSkew')]);
  const head = stuck && stuck.n >= STUCK_AFTER ? outbox.find(o => o.id === stuck.id) : null;
  emit({ pending: outbox.length, rejected: rejected.length, stuck: head ? { ...head, tries: stuck.n, message: stuck.message } : null, clockSkew: skew || 0 });
}
/** Operations still waiting on this device (logging out is refused until they are sent). */
export const waitingCount = async () => (await db.all('outbox')).length;

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
  if (err.code === 'no_session') emit({ state: 'expired', message: 'Your session ended: log in again to send them.' });
  else if (err.network) emit({ state: 'offline', message: err.message });
  else emit({ state: 'error', message: err.message });
}
const asApiError = e => e instanceof ApiError ? e : new ApiError('error', String(e && e.message || e), { network: true });

async function doPush() {
  const outbox = (await db.all('outbox')).sort((a, b) => a.seq - b.seq);
  if (!outbox.length) { if (status.state === 'sending') emit({ state: 'idle' }); return; }
  // Each person's operations go with that person's own session, oldest first: a session is
  // never replaced or revoked while its owner still has operations waiting (auth.takeToken).
  const owner = outbox[0].by;
  const cur = await db.get('currentUser');
  let token = await tokenFor(owner);
  if (!token && (!owner || (cur && cur.username === owner))) token = await reconnect(owner);
  if (!token) {
    // No session: while the Internet is still down this is just "offline"; once it is back, ask for the password.
    if (!navigator.onLine) emit({ state: 'offline', message: 'No Internet connection' });
    else emit({ state: 'expired', message: cur && owner && cur.username !== owner ? `${owner} must log in once to send them.` : 'Your password is needed once to send them.' });
    return;
  }
  emit({ state: 'sending' });
  try {
    const run = outbox.findIndex(o => o.by !== owner);
    const slice = outbox.slice(0, Math.min(BATCH, run < 0 ? outbox.length : run));
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
    // The same first operation failing again and again: shown in "needs attention" (kept, still retried).
    const done = new Set(r.results.map(x => x.id));
    const head = r.partial && !r.budget ? slice.find(o => !done.has(o.id)) : null;
    if (head) {
      const prev = await db.get('stuck');
      writes.push(['kv', 'put', { id: head.id, n: prev && prev.id === head.id ? prev.n + 1 : 1, message: r.message || 'The sheet had a temporary problem with it.', at: new Date().toISOString() }, 'stuck']);
    } else writes.push(['kv', 'delete', 'stuck']);
    await db.batch(writes);
    await refreshCounts();
    await cleanupTokens();
    if (r.partial && r.budget) {
      // The sheet stopped at its time budget, not on an error: the rest goes at once.
      emit({ state: 'sending' });
      nextPushAt = 0; setTimeout(tick, 50);
    } else if (r.partial) {
      // The server hit a Google error part-way; what was done is saved, the rest retries.
      fail(new ApiError('server_error', r.message || 'The sheet had a temporary problem.', { network: true }));
    } else {
      failures = 0;
      emit({ state: 'idle', message: '', lastSync: new Date().toISOString() });
      if (outbox.length > slice.length) { nextPushAt = 0; setTimeout(tick, 50); }
      // What the sheet worked out from it (differences, totals) comes back right away.
      nextPullAt = Math.min(nextPullAt, Date.now() + 2000);
    }
    emit({}, { pushed: r.results });
  } catch (e) {
    fail(asApiError(e));
  }
}

async function doPull(opts = {}) {
  const token = (await db.get('deviceToken')) || await reconnect((await db.get('currentUser') || {}).username);
  if (!token) return;
  try {
    const r = await api('pull', { token, beds24: !!opts.beds24 }, opts.beds24 ? 90000 : undefined);
    lastBeds24 = r.beds24 || null;
    const v = (r.shift && r.shift.v) || 0;
    const applied = await db.all('applied');
    const writes = [
      ['kv', 'put', r.catalog, 'catalog'],
      ['kv', 'put', r.payments, 'payments'],
      ['kv', 'put', r.expenses || [], 'expenses'],
      ['kv', 'put', r.partnerLabels || null, 'partnerLabels'],
      ['kv', 'put', r.guests, 'guests'],
      ['kv', 'put', r.lines || [], 'lines'],
      ['kv', 'put', r.cashbox || [], 'cashbox'],
      ['kv', 'put', r.partners || { items: [], lines: [] }, 'partners'],
      ['kv', 'put', r.settlement || null, 'settlement'],
      ['kv', 'put', r.bar || [], 'bar'], // TEMPORARY (bar cash-out)
      ['kv', 'put', r.gear || null, 'gear'],
      ['kv', 'put', v, 'linesV'],
      // Already in this copy, or older than two days (safety net if the version ever jumps).
      ...applied.filter(a => a.v <= v || Date.now() - new Date(a.op.at).getTime() > 2 * 86400000).map(a => ['applied', 'delete', a.id]),
      ['kv', 'put', r.serverTime, 'lastPull'],
      ['kv', 'put', r.serverTime ? Date.parse(r.serverTime) - Date.now() : 0, 'clockSkew'],
      ['kv', 'put', new Date().toISOString(), 'lastSync'],
      ...await shiftWrite(r.shift),
    ];
    // Offline login is for the reception staff only: no manager or gear hash is kept here.
    writes.push(r.users ? ['kv', 'put', r.users.filter(u => u.role === 'staff'), 'users'] : ['kv', 'delete', 'users']);
    if (r.me) {
      const cur = await db.get('currentUser');
      if (cur && cur.username === r.me.username) writes.push(['kv', 'put', { ...cur, ...r.me }, 'currentUser']);
    }
    await db.batch(writes);
    if (r.serverTime) status.clockSkew = Date.parse(r.serverTime) - Date.now();
    nextPullAt = Date.now() + (globalThis.RABBIT_PULL_MS || CONFIG.PULL_EVERY_MS);
    if (status.state === 'offline' || status.state === 'error') failures = 0;
    emit(status.pending ? { lastSync: new Date().toISOString() } : { state: 'idle', message: '', lastSync: new Date().toISOString() }, { pulled: true });
  } catch (e) {
    fail(asApiError(e));
  }
}

export const pushNow = () => serial(doPush);
/**
 * Is the sheet reachable now? Closing a shift is never queued offline (it needs the Internet).
 * An answer of any kind from the server (even an error) means the connection works.
 */
export async function sheetReachable(timeoutMs = 8000) {
  if (!CONFIG.API_URL || (typeof navigator !== 'undefined' && navigator.onLine === false)) return false;
  try { await api('ping', {}, timeoutMs); return true; } catch (e) { return e instanceof ApiError && !e.network; }
}
export const pullNow = () => serial(doPull);
/** Refresh button: send what is waiting, ask the server to read Beds24 now, then reload everything. */
let lastBeds24 = null;
export async function refreshNow() {
  emit({ state: 'sending', message: '' });
  await serial(doPush);
  await serial(() => doPull({ beds24: true }));
  return lastBeds24;
}

function tick() {
  const now = Date.now();
  if (now >= nextPushAt) { nextPushAt = now + CONFIG.PUSH_EVERY_MS; pushNow(); }
  if (now >= nextPullAt) { nextPullAt = now + (globalThis.RABBIT_PULL_MS || CONFIG.PULL_EVERY_MS); pullNow(); }
}

// A tab coming back to the screen (Chrome freezes hidden tabs) refreshes at once.
try { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { nextPullAt = 0; nextPushAt = 0; setTimeout(tick, 50); } }); } catch { /* not a page */ }

export function startSync() {
  refreshCounts();
  setInterval(tick, 3000);
  window.addEventListener('online', () => { failures = 0; nextPushAt = 0; nextPullAt = 0; tick(); });
  window.addEventListener('offline', () => emit({ state: 'offline', message: 'No Internet connection' }));
  tick();
}

export async function dismissRejected(id) { await db.remove('rejected', id); await refreshCounts(); }

/** A waiting or refused operation as plain text, to type it again by hand if needed. */
export function opDetails(op, label = op.type) {
  const when = new Date(op.at).toLocaleString('en-GB', { timeZone: 'Asia/Makassar', dateStyle: 'medium', timeStyle: 'short' });
  const val = v => (v && typeof v === 'object' ? Object.entries(v).filter(([, x]) => x !== '' && x != null).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(', ') : String(v));
  const out = [`${label} (${op.type})`, `When: ${when} (Bali time)`, `By: ${op.by}`];
  if (op.error) out.push(`Refused: ${op.message || op.error} [${op.error}]`);
  else if (op.message) out.push(`Not sent yet: ${op.message}`);
  for (const [k, v] of Object.entries(op.payload || {})) {
    if (Array.isArray(v)) { out.push(`${k}:`); v.forEach((x, i) => out.push(`  ${i + 1}. ${val(x)}`)); } else out.push(`${k}: ${val(v)}`);
  }
  out.push(`Id: ${op.id}`);
  return out.join('\n');
}
/** Copies a text; where the browser refuses, shows it selected next to `anchor` to copy by hand. */
export async function copyText(text, anchor) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not allowed here */ }
  const ta = document.createElement('textarea');
  ta.readOnly = true; ta.rows = Math.min(12, text.split('\n').length + 1); ta.className = 'copybox'; ta.value = text;
  anchor.after(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch { /* manual copy */ }
  return false;
}

/**
 * At start: operations left in the database of a previous connection (another sheet) are
 * never sent here. A blocking message lists them, with their details to copy and type again.
 * Shown again only when new ones appear. `labels`: operation names; `gear`: Indonesian too.
 */
export async function warnOtherOutboxes({ labels = {}, gear = false } = {}) {
  const found = await otherOutboxes();
  const ops = found.flatMap(f => f.ops);
  if (!ops.length) return false;
  const sig = shortHash(ops.map(o => o.id).sort().join('|'));
  if ((await db.get('otherOutboxSeen')) === sig) return false;
  const n = ops.length;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = ops.map(o => opDetails(o, labels[o.type] || o.type)).join('\n\n');
  const box = document.createElement('div');
  box.className = 'oldoutbox';
  box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true');
  box.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px';
  box.innerHTML = `<section class="card" style="max-width:560px;width:100%;max-height:90vh;overflow:auto">
    <h2>${n} operation${n === 1 ? '' : 's'} from a previous connection ${n === 1 ? 'was' : 'were'} not sent</h2>
    ${gear ? `<p><b>${n} catatan dari koneksi sebelumnya tidak terkirim.</b></p>` : ''}
    <p class="muted">${n === 1 ? 'It was' : 'They were'} made on this ${gear ? 'phone' : 'computer'} for another sheet and will never be sent to this one. Copy the details, give them to a manager to type again by hand if needed, then continue.</p>
    <ul>${ops.slice(0, 20).map(o => `<li><b>${esc(labels[o.type] || o.type)}</b> by ${esc(o.by)}, ${esc(new Date(o.at).toLocaleString('en-GB', { timeZone: 'Asia/Makassar', dateStyle: 'medium', timeStyle: 'short' }))}</li>`).join('')}${n > 20 ? `<li>… and ${n - 20} more (in the details)</li>` : ''}</ul>
    <div class="row"><button type="button" class="primary" data-oldcopy>Copy details</button><button type="button" class="ghost" data-oldok>I have copied them, continue</button></div>
  </section>`;
  document.body.appendChild(box);
  return new Promise(resolve => {
    box.querySelector('[data-oldcopy]').onclick = async e => {
      const b = e.currentTarget;
      if (await copyText(text, b.parentElement)) { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy details'; }, 2000); }
    };
    box.querySelector('[data-oldok]').onclick = async () => { await db.set('otherOutboxSeen', sig); box.remove(); resolve(true); };
  });
}
