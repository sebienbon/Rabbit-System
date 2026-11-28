// One list of people for every app (owner 28/11): UI_Users is the single place for accounts, roles, passwords and PINs.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeEnv } = require('./gas-shim');

function freshEnv() {
  const env = makeEnv({ sheets: {} });
  env.ctx.UI_setup();
  const u = env.book['UI_Users'];
  u.appendRow(['Iky', 'Muhammad Khalqi', 'Staff', 'r1@x', 'pw-iky', '', '', '', '', '1111']);
  u.appendRow(['sebastien', 'Sebastien', 'admin', 'seb@x', 'pw-seb', '', '', '', '', '2222']);
  u.appendRow(['manager', 'Manager', 'manager', 'm@x', 'pw-man', '', '', '', '', '3333']);
  u.appendRow(['Angga', 'Dewa Made Angga Sena', 'gear', '', 'pw-angga', '', '', '', '', '4444']);
  u.appendRow(['Mugeni', 'Pak Haji Mugeni', 'maintenance', '', 'pw-mug', '', '', '', '', '5555']);
  u.appendRow(['bar-pos', 'Bar POS', 'manager', 'Bar POS', 'pw-pos', '', '', '']);
  env.ctx.PropertiesService.getScriptProperties().setProperty('HK_FEED_KEY', 'feed-key-0123456789');
  return env;
}
const login = (env, u, p) => env.call({ action: 'login', username: u, password: p, deviceId: 'dev1' });
const row = (env, name) => env.book['UI_Users'].data.find(r => String(r[0]).toLowerCase() === name.toLowerCase());
// Same algorithm as hashPassword_ (and the staff app / the POS): SHA-256 `rounds` times, hex in between.
const hash = (plain, salt, rounds = 2000) => { let h = salt + ':' + plain; for (let i = 0; i < rounds; i++) h = crypto.createHash('sha256').update(h, 'utf8').digest('hex'); return h; };

test('a typed password and PIN are hashed; the staff\'s stay readable, never a manager\'s or an admin\'s', () => {
  const env = freshEnv();
  assert.ok(login(env, 'iky', 'pw-iky').ok);
  assert.deepStrictEqual(env.book['UI_Users'].data[0].slice(8, 13),
    ['Password (readable, not manager / admin)', 'Set new PIN here', 'PIN hash', 'PIN salt', 'PIN (readable, not manager / admin)']);
  for (const [name, pw, pin, readable] of [['iky', 'pw-iky', '1111', true], ['angga', 'pw-angga', '4444', true], ['mugeni', 'pw-mug', '5555', true],
    ['sebastien', 'pw-seb', '2222', false], ['manager', 'pw-man', '3333', false]]) {
    const r = row(env, name);
    assert.strictEqual(r[4], '', name + ': typed password cleared');
    assert.strictEqual(r[9], '', name + ': typed PIN cleared');
    assert.strictEqual(r[5], hash(pw, r[6]), name + ': password hash');
    assert.strictEqual(r[10], hash(pin, r[11]), name + ': PIN hash');
    assert.strictEqual(r[8] || '', readable ? pw : '', name + ': readable password');
    assert.strictEqual(String(r[12] || ''), readable ? pin : '', name + ': readable PIN');
  }
});

test('a PIN is 4 digits and belongs to one person; a refused one says why and is not taken', () => {
  const env = freshEnv();
  login(env, 'iky', 'pw-iky');
  const u = env.book['UI_Users'];
  const set = (name, pin) => { const i = u.data.findIndex(r => String(r[0]).toLowerCase() === name); u.getRange(i + 1, 10).setValue(pin); };
  const before = row(env, 'angga')[10];
  set('angga', '1111'); set('iky', '12ab'); login(env, 'iky', 'pw-iky');
  assert.match(String(row(env, 'angga')[9]), /^! already used/);
  assert.match(String(row(env, 'iky')[9]), /^! 4 digits/);
  assert.strictEqual(row(env, 'angga')[10], before, 'old PIN kept');
  login(env, 'iky', 'pw-iky');
  assert.match(String(row(env, 'angga')[9]), /^! already used/, 'a refused PIN is not tried again');
  set('angga', '7777'); login(env, 'iky', 'pw-iky');
  assert.strictEqual(row(env, 'angga')[9], '');
  assert.strictEqual(String(row(env, 'angga')[12]), '7777');
  // a new password replaces the readable one; a role changed to manager hides the next one
  const i = u.data.findIndex(r => r[0] === 'Angga');
  u.getRange(i + 1, 5).setValue('new-pw'); login(env, 'iky', 'pw-iky');
  assert.strictEqual(row(env, 'angga')[8], 'new-pw');
  u.getRange(i + 1, 3).setValue('manager'); u.getRange(i + 1, 5).setValue('boss-pw'); login(env, 'iky', 'pw-iky');
  assert.strictEqual(row(env, 'angga')[8], '');
});

test('maintenance and gear accounts do not get into the reception or the POS from here', () => {
  const env = freshEnv();
  assert.strictEqual(login(env, 'mugeni', 'pw-mug').error, 'wrong_app');
  assert.strictEqual(login(env, 'mugeni', 'nope').error, 'bad_login');
  const pos = login(env, 'bar-pos', 'pw-pos').token;
  assert.strictEqual(env.call({ action: 'rs_pass', token: pos, username: 'mugeni' }).error, 'forbidden');
  assert.strictEqual(env.call({ action: 'rs_pass', token: pos, username: 'angga' }).error, 'forbidden');
  assert.ok(env.call({ action: 'rs_pass', token: pos, username: 'iky' }).ok);
  // an unknown word in the role column is still plain staff, as before
  env.book['UI_Users'].appendRow(['zed', 'Zed', 'whatever', 'z@x', 'pw-z', '', '', '']);
  assert.strictEqual(login(env, 'zed', 'pw-z').user.role, 'staff');
});

test('the POS reads everybody with the PIN hash, never a password', () => {
  const env = freshEnv();
  const pos = login(env, 'bar-pos', 'pw-pos').token;
  const r = env.call({ action: 'pos_staff', token: pos });
  assert.ok(r.ok); assert.strictEqual(r.v, 2); assert.strictEqual(r.rounds, 2000);
  assert.deepStrictEqual(r.staff.map(s => `${s.username}:${s.role}`), ['iky:staff', 'sebastien:admin', 'manager:manager', 'angga:gear', 'mugeni:maintenance']);
  const a = r.staff.find(s => s.username === 'angga');
  assert.strictEqual(a.pinHash, hash('4444', a.pinSalt));
  assert.ok(!JSON.stringify(r).includes('pw-') && r.staff.every(s => s.hash === undefined && s.salt === undefined));
  assert.strictEqual(env.call({ action: 'pos_staff', token: login(env, 'iky', 'pw-iky').token }).error, 'forbidden');
});

test('the staff app copies the list with its key only; a password typed just before is already in it', () => {
  const env = freshEnv();
  assert.strictEqual(env.call({ action: 'directory' }).error, 'forbidden');
  assert.strictEqual(env.call({ action: 'directory', key: 'feed-key-012345678X' }).error, 'forbidden');
  const d = env.call({ action: 'directory', key: 'feed-key-0123456789' });
  assert.ok(d.ok, JSON.stringify(d)); assert.strictEqual(d.rounds, 2000);
  assert.strictEqual(d.users.length, 6);
  const m = d.users.find(u => u.username === 'mugeni');
  assert.strictEqual(m.role, 'maintenance'); assert.strictEqual(m.active, true);
  assert.strictEqual(m.hash, hash('pw-mug', m.salt)); assert.strictEqual(m.pinHash, hash('5555', m.pinSalt));
  assert.ok(!JSON.stringify(d).includes('pw-'), 'no readable code leaves the sheet');
  // its own key, when set, replaces the feed key
  env.ctx.PropertiesService.getScriptProperties().setProperty('DIRECTORY_KEY', 'directory-key-abcdef');
  assert.strictEqual(env.call({ action: 'directory', key: 'feed-key-0123456789' }).error, 'forbidden');
  assert.ok(env.call({ action: 'directory', key: 'directory-key-abcdef' }).ok);
  // someone switched off in the sheet is off in the list
  const u = env.book['UI_Users']; const i = u.data.findIndex(r => r[0] === 'Angga'); u.getRange(i + 1, 8).setValue(false);
  assert.strictEqual(env.call({ action: 'directory', key: 'directory-key-abcdef' }).users.find(x => x.username === 'angga').active, false);
});

test('a sheet made before 28/11 (8 columns) keeps working and gets its new columns', () => {
  const env = freshEnv();
  const u = env.book['UI_Users'];
  u.data[0] = u.data[0].slice(0, 8);   // the old title row
  assert.ok(login(env, 'iky', 'pw-iky').ok);
  assert.strictEqual(u.data[0][9], 'Set new PIN here');
});
