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
export async function login(username, password, { register = false } = {}) {
  username = username.trim().toLowerCase();
  try {
    const r = await api('login', {
      username, password, deviceId: await deviceId(),
      deviceSecret: (await db.get('deviceSecret')) || undefined,
      registerDevice: register || undefined,
    });
    if (register && !r.registered) throw new ApiError('not_allowed', 'Only a manager can register this computer.');
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
    const user = { username: u.username, name: u.name, role: u.role, mode: 'offline' };
    await db.set('currentUser', user);
    return user;
  }
}

export async function logout() { await db.del('currentUser'); }
export const currentUser = () => db.get('currentUser');
