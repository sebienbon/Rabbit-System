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

/**
 * Online: the server checks the password and gives a session token.
 * Offline (or server unreachable): only on the registered reception computer,
 * checked against the password hashes from the last sync.
 * `register`: a manager makes this computer the reception computer (offline-capable).
 */
export async function login(username, password, { register = false, gearApp = false } = {}) {
  username = username.trim().toLowerCase();
  try {
    const r = await api('login', {
      username, password, deviceId: await deviceId(),
      deviceSecret: (await db.get('deviceSecret')) || undefined,
      registerDevice: register || undefined,
    });
    if (register && !r.registered) throw new ApiError('not_allowed', 'Only a manager can register this computer.');
    // Each app has its own accounts: refused before anything is stored on this device.
    if ((r.user.role === 'gear') !== gearApp) {
      api('logout', { token: r.token }, 8000).catch(() => {});
      throw new ApiError('wrong_app', gearApp ? 'Akun ini untuk resepsi. Gunakan akun staf gear.' : 'Gear staff accounts use the gear app (gear.html), not the reception.');
    }
    const user = { ...r.user, mode: 'online' };
    const writes = [['kv', 'put', r.token, 'deviceToken'], ['kv', 'put', user, 'currentUser']];
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
    const user = { username: u.username, name: u.name, role: u.role, author: u.author || u.username, mode: 'offline' };
    await db.set('currentUser', user);
    pendingOnline = { username, password };
    return user;
  }
}

// Password of the person logged in offline, kept in memory only, to get a session
// from the sheet as soon as the connection is back (never written anywhere).
let pendingOnline = null;

/** Called by the sync when there is no session on this computer. */
export async function reconnect() {
  if (!pendingOnline) return null;
  try {
    const r = await api('login', { username: pendingOnline.username, password: pendingOnline.password, deviceId: await deviceId(),
      deviceSecret: (await db.get('deviceSecret')) || undefined });
    pendingOnline = null;
    await db.set('deviceToken', r.token);
    return r.token;
  } catch (e) {
    if (!(e instanceof ApiError && e.network)) pendingOnline = null;
    return null;
  }
}

/**
 * A manager leaving the desk: the session that carries manager rights is revoked and
 * forgotten by this computer (call after sending what is waiting).
 */
export async function logout(user) {
  pendingOnline = null;
  if (user && user.role !== 'staff') {
    const token = await db.get('deviceToken');
    await db.del('deviceToken');
    if (token) api('logout', { token }, 8000).catch(() => {});
  }
  await db.del('currentUser');
}
export const currentUser = () => db.get('currentUser');
