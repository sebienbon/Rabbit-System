import { db } from './db.js';
import { api, ApiError } from './api.js';

// Must match hashPassword_ in 30.UI_api.gs: SHA-256 applied `rounds` times, hex in between.
export async function hashPassword(password, salt, rounds = 2000) {
  const enc = new TextEncoder();
  let h = salt + ':' + password;
  for (let i = 0; i < rounds; i++) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(h));
    h = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  return h;
}

export async function deviceId() {
  let id = await db.get('deviceId');
  if (!id) { id = 'D' + crypto.randomUUID().slice(0, 8); await db.set('deviceId', id); }
  return id;
}
export const isRegistered = async () => !!(await db.get('deviceSecret'));

/** Who has operations still waiting on this device, in queue order. */
export async function outboxOwners() {
  const outbox = (await db.all('outbox')).sort((a, b) => a.seq - b.seq);
  return [...new Set(outbox.map(o => o.by).filter(Boolean))];
}
/**
 * No hand-over: while operations wait on this device, only the person who made them can log in
 * (the reception computer and the gear phones alike). Refused before anything else.
 */
async function assertMayLogIn(username, gearApp) {
  const outbox = await db.all('outbox');
  if (!outbox.length) return;
  const owners = await outboxOwners();
  if (!owners.length || owners.includes(username)) return;
  const n = outbox.length, who = owners[0];
  throw new ApiError('outbox_waiting', gearApp
    ? `${n} catatan dari ${who} masih menunggu dikirim: hanya ${who} yang bisa masuk sampai terkirim. (${n} operation${n === 1 ? '' : 's'} of ${who} still waiting to be sent: only ${who} can log in.)`
    : `${n} operation${n === 1 ? '' : 's'} of ${who} still waiting to be sent: only ${who} can log in until ${n === 1 ? 'it reaches' : 'they reach'} the sheet. Connect to the internet first.`);
}

const revoke = token => { if (token) api('logout', { token }, 8000).catch(() => {}); };
/**
 * Keeps a new session token for `username`. The token it replaces is revoked, except when its
 * owner still has operations waiting: it is then kept aside (heldTokens) to send them first.
 */
async function takeToken(token, username, role) {
  const [old, oldUser, held, owners] = await Promise.all([db.get('deviceToken'), db.get('tokenUser'), db.get('heldTokens'), outboxOwners()]);
  const h = { ...(held || {}) };
  if (h[username] && h[username] !== token) revoke(h[username]);
  delete h[username];
  if (old && old !== token) {
    if (oldUser && oldUser !== username && owners.includes(oldUser)) h[oldUser] = old;
    else revoke(old); // the previous session of this device is closed on the sheet
  }
  return [['kv', 'put', token, 'deviceToken'], ['kv', 'put', username, 'tokenUser'], ['kv', 'put', role || '', 'tokenRole'], ['kv', 'put', h, 'heldTokens']];
}
/** The session that sends the operations of `username` (each person's operations go with their own session). */
export async function tokenFor(username) {
  const [token, tokenUser, held] = await Promise.all([db.get('deviceToken'), db.get('tokenUser'), db.get('heldTokens')]);
  if (!username || !tokenUser || tokenUser === username) return token || null;
  return (held && held[username]) || null;
}
/**
 * Sessions nobody needs any more are revoked: one kept aside once its operations are sent, and
 * a manager's session left behind (app restarted, no one logged in) once the outbox is empty.
 */
export async function cleanupTokens() {
  const [owners, cur, held, token, tokenUser, tokenRole] = await Promise.all([outboxOwners(), db.get('currentUser'), db.get('heldTokens'), db.get('deviceToken'), db.get('tokenUser'), db.get('tokenRole')]);
  const writes = [];
  if (held && Object.keys(held).length) {
    const h = { ...held };
    for (const [u, t] of Object.entries(held)) if (!owners.includes(u) && !(cur && cur.username === u)) { revoke(t); delete h[u]; }
    if (Object.keys(h).length !== Object.keys(held).length) writes.push(['kv', 'put', h, 'heldTokens']);
  }
  if (token && !cur && tokenRole && tokenRole !== 'staff' && !owners.includes(tokenUser)) {
    revoke(token);
    writes.push(['kv', 'delete', 'deviceToken'], ['kv', 'delete', 'tokenUser'], ['kv', 'delete', 'tokenRole']);
  }
  if (writes.length) await db.batch(writes);
}

/**
 * Online: the server checks the password and gives a session token.
 * Offline (or server unreachable): only on the registered reception computer,
 * checked against the password hashes from the last sync.
 * `register`: a manager makes this computer the reception computer (offline-capable).
 */
export async function login(username, password, { register = false, gearApp = false } = {}) {
  username = username.trim().toLowerCase();
  await assertMayLogIn(username, gearApp);
  try {
    const r = await api('login', {
      username, password, deviceId: await deviceId(),
      deviceSecret: (await db.get('deviceSecret')) || undefined,
      registerDevice: register || undefined,
    });
    if (register && !r.registered) throw new ApiError('not_allowed', 'Only a manager can register this computer.');
    // Each app has its own accounts: refused before anything is stored on this device.
    if (r.user.role === 'gear' && !gearApp) { // gear accounts only in the gear app; any other account may use both
      api('logout', { token: r.token }, 8000).catch(() => {});
      throw new ApiError('wrong_app', gearApp ? 'Akun ini untuk resepsi. Gunakan akun staf gear.' : 'Gear staff accounts use the gear app (gear.html), not the reception.');
    }
    const user = { ...r.user, mode: 'online' };
    const writes = [...await takeToken(r.token, user.username, user.role), ['kv', 'put', user, 'currentUser']];
    if (r.deviceSecret) writes.push(['kv', 'put', r.deviceSecret, 'deviceSecret']);
    if (!r.registered) writes.push(['kv', 'delete', 'users']); // never keep hashes on an unregistered computer
    await db.batch(writes);
    return user;
  } catch (e) {
    if (e instanceof ApiError && !e.network) throw e; // wrong password etc. — the server said no
    if (!(await isRegistered())) throw new ApiError('offline', 'No connection to the server. This computer is not set up to work offline.');
    const users = (await db.get('users')) || [];
    const u = users.find(x => x.username === username);
    if (!u) throw new ApiError('offline_unknown', 'No connection, and this user is not known on this computer yet.');
    const h = await hashPassword(password, u.salt, u.rounds || 2000);
    if (h !== u.hash) throw new ApiError('bad_login', 'Wrong username or password');
    if (u.role === 'gear') throw new ApiError('wrong_app', 'Gear staff accounts use the gear app (gear.html), not the reception.');
    if (u.role !== 'staff') throw new ApiError('offline_unknown', 'No connection: a manager needs the Internet to log in.');
    const user = { username: u.username, name: u.name, role: u.role, author: u.author || u.username, mode: 'offline' };
    await db.set('currentUser', user);
    pendingOnline = { username, password };
    return user;
  }
}

/**
 * Opened by the POS ("Reception" button, owner 09/11) with a one-time pass in the address: logs in the person the
 * POS asked for, like a password would (online only, never registers this computer).
 */
export async function loginWithPass(pass) {
  const r = await api('pass_login', { pass, deviceId: await deviceId(), deviceSecret: (await db.get('deviceSecret')) || undefined });
  try {
    if (r.user.role === 'gear') throw new ApiError('wrong_app', 'Gear staff accounts use the gear app (gear.html), not the reception.');
    await assertMayLogIn(r.user.username, false);
  } catch (e) { revoke(r.token); throw e; }
  const user = { ...r.user, mode: 'online' };
  const writes = [...await takeToken(r.token, user.username, user.role), ['kv', 'put', user, 'currentUser']];
  if (!r.registered) writes.push(['kv', 'delete', 'users']); // never keep hashes on an unregistered computer
  await db.batch(writes);
  return user;
}

// Password of the person logged in offline, kept in memory only, to get a session
// from the sheet as soon as the connection is back (never written anywhere).
let pendingOnline = null;

/**
 * Called by the sync when there is no session for the person logged in offline (`forUser`:
 * only for the operations of that person).
 */
export async function reconnect(forUser) {
  if (!pendingOnline || (forUser && pendingOnline.username !== forUser)) return null;
  try {
    const r = await api('login', { username: pendingOnline.username, password: pendingOnline.password, deviceId: await deviceId(),
      deviceSecret: (await db.get('deviceSecret')) || undefined });
    pendingOnline = null;
    await db.batch(await takeToken(r.token, r.user.username, r.user.role));
    return r.token;
  } catch (e) {
    if (!(e instanceof ApiError && e.network)) pendingOnline = null;
    return null;
  }
}

/**
 * A manager leaving the desk: the session that carries manager rights is revoked and
 * forgotten by this computer (call after sending what is waiting). Never while its own
 * operations still wait: then it is revoked as soon as they are sent.
 */
export async function logout(user) {
  pendingOnline = null;
  if (user && user.role !== 'staff') {
    const [token, tokenUser, owners] = await Promise.all([db.get('deviceToken'), db.get('tokenUser'), outboxOwners()]);
    if (token && owners.includes(tokenUser || user.username)) {
      // Its operations still wait: the session stays to send them, revoked right after (cleanupTokens).
      await db.batch([['kv', 'put', tokenUser === user.username ? user.role : ((await db.get('tokenRole')) || ''), 'tokenRole'], ['kv', 'delete', 'currentUser']]);
      return;
    }
    await db.batch([['kv', 'delete', 'deviceToken'], ['kv', 'delete', 'tokenUser'], ['kv', 'delete', 'tokenRole']]);
    revoke(token);
  }
  await db.del('currentUser');
  await cleanupTokens();
}
export const currentUser = () => db.get('currentUser');
