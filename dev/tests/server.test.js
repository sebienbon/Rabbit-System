// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

const CASH_HEADER = ['Column 1', 'Time ', 'Cashout', 'Difference', 'Cash in box', 'Change suply', 'Author', 'Comment', 'Type'];
const MANUAL_HEADER = ['', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Author', 'Comment', 'Time stamp', 'Seller'];

function freshEnv() {
  const manual = [MANUAL_HEADER, ['01/11/2026', 'Income', 'Service', 'Bar', 1, '', 0, 50000]];
  // Formulas fill column F/G far below the data, like the real sheet.
  for (let i = 0; i < 30; i++) manual.push(['', '', '', '', '', '=x', '=y']);
  const env = makeEnv({ sheets: {
    'Cashouts&Cor': [CASH_HEADER, ['01/11/2026', '15:00:08', 0, 0, 1387750, '', 'r1@x', '', 'Closing']],
    'Entries Manual': manual,
    'Data activities': [['Activity', 'Selling Price'], ['Towel', '50,000Rp'], ['Laundry', '30,000Rp'], ['', '']],
    '24datafeed': [['Guest Name', 'First Name', 'Full'], ['Example', 'Alice', 'Alice Example']],
    'New guest': [['', '', '', '', '', 'Alice Example'], ['', '', '', '', '', 'Bob Sample']],
  } });
  env.ctx.UI_setup();
  const users = env.book['UI_Users'];
  users.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw-ayu', '', '', '']);
  users.appendRow(['boss', 'Boss', 'manager', 'boss@x', 'pw-boss', '', '', '']);
  users.appendRow(['old', 'Old', 'staff', 'old@x', 'pw-old', '', '', false]);
  return env;
}
const login = (env, u, p, extra = {}) => env.call({ action: 'login', username: u, password: p, deviceId: 'dev1', ...extra });
let n = 0;
const op = (type, payload, at = new Date().toISOString()) => ({ id: 'op' + (++n) + Math.random(), type, at, payload });

test('passwords are hashed and cleared, wrong ones refused', () => {
  const env = freshEnv();
  const r = login(env, 'ayu', 'pw-ayu');
  assert.ok(r.ok, JSON.stringify(r));
  const row = env.book['UI_Users'].data[1];
  assert.strictEqual(row[4], '', 'plain password cleared');
  assert.match(row[5], /^[0-9a-f]{64}$/);
  assert.strictEqual(login(env, 'ayu', 'nope').error, 'bad_login');
  assert.strictEqual(login(env, 'AYU ', 'pw-ayu').ok, true, 'username case/space-insensitive');
  assert.strictEqual(login(env, 'old', 'pw-old').error, 'bad_login', 'inactive user refused');
});

test('pull requires a session and returns catalog, guests, users, shift', () => {
  const env = freshEnv();
  assert.strictEqual(env.call({ action: 'pull', token: 'zzz' }).error, 'no_session');
  const { token } = login(env, 'ayu', 'pw-ayu');
  const p = env.call({ action: 'pull', token });
  assert.ok(p.ok);
  assert.deepStrictEqual(p.catalog, [{ name: 'Towel', price: 50000 }, { name: 'Laundry', price: 30000 }]);
  assert.deepStrictEqual(p.guests, ['Alice Example', 'Bob Sample']);
  assert.strictEqual(p.users, undefined, 'unregistered device gets no password hashes');
  assert.strictEqual(p.shift.open, false);
  assert.strictEqual(p.shift.lastCashInBox, 1387750);
});

test('open then close a shift writes the same rows as the old dialogs', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  const at = '2026-11-01T23:30:05.123Z'; // 07:30:05 on 02/11 in Bali/Singapore time
  const o = op('shift_open', { shiftId: 'S1', cashCounted: 1387000 }, at);
  let r = env.call({ action: 'push', token, deviceId: 'dev1', ops: [o] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.results[0].status, 'applied');
  assert.strictEqual(r.results[0].difference, -750);
  assert.strictEqual(r.shift.open, true);
  const cash = env.book['Cashouts&Cor'].data;
  const openRow = cash[cash.length - 1];
  assert.strictEqual(openRow[1], '07:30:05');
  assert.strictEqual(openRow[8], 'Opening');
  assert.strictEqual(openRow[6], 'r1@x', 'author email kept for reports');
  assert.strictEqual(openRow[7], '[S1]', 'shift id tag in the comment');
  assert.ok(openRow[0] instanceof Date);

  const c = op('shift_close', { shiftId: 'S1', cashCounted: 1000000, cashout: 400000, expectedCash: 1387000, comment: 'ok' }, '2026-11-02T07:00:00.000Z');
  r = env.call({ action: 'push', token, deviceId: 'dev1', ops: [c] });
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.strictEqual(r.results[0].difference, 13000);
  assert.strictEqual(r.shift.open, false);
  assert.strictEqual(r.shift.lastCashInBox, 1000000);
  const closeRow = env.book['Cashouts&Cor'].data.at(-1);
  assert.deepStrictEqual([closeRow[1], closeRow[2], closeRow[3], closeRow[4], closeRow[8]], ['15:00:00', 400000, 13000, 1000000, 'Closing']);
  // Cash-out line lands right after the last real data row, not after the formulas.
  const manual = env.book['Entries Manual'].data;
  assert.strictEqual(manual[2][1], 'Cash-out');
  assert.strictEqual(manual[2][11], 400000);
  assert.strictEqual(manual[2][14], 'r1@x');
  assert.strictEqual(manual[2][16], '20261102150000000');
  assert.strictEqual(manual[2][5], '', 'formula column untouched only where we wrote blanks');
});

test('replayed ops are not applied twice (offline retry)', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  const o = op('shift_open', { shiftId: 'S1', cashCounted: 100 });
  env.call({ action: 'push', token, ops: [o] });
  const before = env.book['Cashouts&Cor'].data.length;
  const r = env.call({ action: 'push', token, ops: [o] });
  assert.strictEqual(r.results[0].status, 'duplicate');
  assert.strictEqual(env.book['Cashouts&Cor'].data.length, before);
});

test('business rules: no double open, only owner or manager closes, bad amounts refused', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu', 'pw-ayu').token;
  const boss = login(env, 'boss', 'pw-boss').token;
  env.call({ action: 'push', token: boss, ops: [op('shift_open', { shiftId: 'B1', cashCounted: 100 })] });
  let r = env.call({ action: 'push', token: ayu, ops: [op('shift_open', { shiftId: 'A1', cashCounted: 100 })] });
  assert.strictEqual(r.results[0].status, 'rejected');
  assert.strictEqual(r.results[0].error, 'shift_already_open');
  r = env.call({ action: 'push', token: ayu, ops: [op('shift_close', { shiftId: 'B1', cashCounted: 1, expectedCash: 1 })] });
  assert.strictEqual(r.results[0].error, 'forbidden');
  r = env.call({ action: 'push', token: boss, ops: [op('shift_close', { shiftId: 'B1', cashCounted: -5, expectedCash: 1 })] });
  assert.strictEqual(r.results[0].error, 'bad_amount');
  r = env.call({ action: 'push', token: boss, ops: [op('shift_close', { shiftId: 'B1', cashCounted: '1.250.000', expectedCash: 1250000 })] });
  assert.strictEqual(r.results[0].status, 'applied');
  assert.strictEqual(r.results[0].difference, 0, 'thousand separators understood');
  // Manager closing another user's shift is allowed; staff closing their own is too.
  env.call({ action: 'push', token: ayu, ops: [op('shift_open', { shiftId: 'A2', cashCounted: 0 })] });
  r = env.call({ action: 'push', token: boss, ops: [op('shift_close', { shiftId: 'A2', cashCounted: 0, expectedCash: 0 })] });
  assert.strictEqual(r.results[0].status, 'applied');
});

test('every op is written to UI_Log, including rejections', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  env.call({ action: 'push', token, ops: [op('nope', {}), op('shift_open', { shiftId: 'S', cashCounted: 1 })] });
  const log = env.book['UI_Log'].data.slice(1);
  assert.deepStrictEqual(log.map(r => r[7]), ['rejected', 'applied']);
  assert.match(log[0][8], /unknown_type/);
});

test('ops from a device clock far in the future are refused', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  const r = env.call({ action: 'push', token, ops: [op('shift_open', { shiftId: 'S', cashCounted: 1 }, '2030-01-01T00:00:00Z')] });
  assert.strictEqual(r.results[0].error, 'bad_time');
});

test('offline login: colleague ops accepted only from the registered computer', () => {
  const env = freshEnv();
  const plain = login(env, 'ayu', 'pw-ayu').token;   // not registered
  let r0 = env.call({ action: 'push', token: plain, deviceId: 'dev1', ops: [{ ...op('shift_open', { shiftId: 'Z', cashCounted: 1 }), by: 'boss' }] });
  assert.strictEqual(r0.results[0].error, 'forbidden', 'unregistered device cannot sign as someone else');
  assert.strictEqual(login(env, 'ayu', 'pw-ayu', { registerDevice: true }).registered, false, 'staff cannot register a device');
  const reg = login(env, 'boss', 'pw-boss', { registerDevice: true });
  assert.ok(reg.registered && reg.deviceSecret);
  const p = env.call({ action: 'pull', token: reg.token });
  assert.strictEqual(p.users.length, 2, 'registered device gets hashes for offline login');
  assert.ok(p.users.every(u => u.hash && u.salt && !('author' in u)));
  assert.strictEqual(login(env, 'ayu', 'pw-ayu', { deviceSecret: 'wrong' }).registered, false);
  const { token } = login(env, 'ayu', 'pw-ayu', { deviceSecret: reg.deviceSecret });
  const o = { ...op('shift_open', { shiftId: 'X1', cashCounted: 5 }), by: 'boss' };
  let r = env.call({ action: 'push', token, deviceId: 'dev2', ops: [o] });
  assert.strictEqual(r.results[0].error, 'forbidden', 'other device refused');
  const o2 = { ...op('shift_open', { shiftId: 'X1', cashCounted: 5 }), by: 'boss' };
  r = env.call({ action: 'push', token, deviceId: 'dev1', ops: [o2] });
  assert.strictEqual(r.results[0].status, 'applied');
  assert.strictEqual(env.book['UI_Shifts'].data.at(-1)[1], 'boss', 'shift owned by the person who signed it');
  assert.match(env.book['UI_Log'].data.at(-1)[3], /^boss \(offline-login/);
  const o3 = { ...op('shift_close', { shiftId: 'X1', cashCounted: 5, expectedCash: 5 }), by: 'ghost' };
  r = env.call({ action: 'push', token, deviceId: 'dev1', ops: [o3] });
  assert.strictEqual(r.results[0].error, 'forbidden', 'unknown user refused');
});


test('Google failure mid-open: nothing marked seen, retry completes without duplicates', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  const o = op('shift_open', { shiftId: 'S9', cashCounted: 10 });
  env.book['UI_Shifts'].failNext = 'appendRow'; // Cashouts&Cor row written, then Google fails
  let r = env.call({ action: 'push', token, ops: [o] });
  assert.ok(r.ok && r.partial && r.results.length === 0, JSON.stringify(r));
  assert.strictEqual(env.book['UI_Log'].getLastRow(), 1, 'not logged, so it will be retried');
  r = env.call({ action: 'push', token, ops: [o] });
  assert.strictEqual(r.results[0].status, 'applied');
  const openings = env.book['Cashouts&Cor'].data.filter(x => x[8] === 'Opening');
  assert.strictEqual(openings.length, 1, 'one Opening row only');
  assert.strictEqual(r.shift.open, true);
});

test('Google failure mid-close: retry finishes the close, one row of each', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  env.call({ action: 'push', token, ops: [op('shift_open', { shiftId: 'S5', cashCounted: 100 })] });
  const c = op('shift_close', { shiftId: 'S5', cashCounted: 50, cashout: 50, expectedCash: 100 });
  env.book['Entries Manual'].failNext = 'setValues';
  let r = env.call({ action: 'push', token, ops: [c] });
  assert.ok(r.partial);
  assert.strictEqual(r.shift.open, true, 'still open on the server: UI_Shifts not yet marked');
  r = env.call({ action: 'push', token, ops: [c] });
  assert.strictEqual(r.results[0].status, 'applied');
  assert.strictEqual(env.book['Cashouts&Cor'].data.filter(x => x[8] === 'Closing').length, 2, 'seed row + ours');
  assert.strictEqual(env.book['Entries Manual'].data.filter(x => x[1] === 'Cash-out').length, 1);
  // A third replay (response lost) is recognised.
  r = env.call({ action: 'push', token, ops: [c] });
  assert.strictEqual(r.results[0].status, 'duplicate');
});

test('a refusal is repeated identically when the same op is sent again', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  const bad = op('shift_close', { shiftId: 'nope', cashCounted: 1, expectedCash: 1 });
  env.call({ action: 'push', token, ops: [bad] });
  const r = env.call({ action: 'push', token, ops: [bad] });
  assert.strictEqual(r.results[0].status, 'rejected');
  assert.strictEqual(r.results[0].error, 'unknown_shift');
});

test('dates follow the spreadsheet timezone, and the state version only grows', () => {
  const env = freshEnv();
  env.ctx.SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone = () => 'Asia/Jakarta';
  const { token } = login(env, 'ayu', 'pw-ayu');
  const r = env.call({ action: 'push', token, ops: [op('shift_open', { shiftId: 'J', cashCounted: 1 }, '2026-11-01T17:30:00.000Z')] });
  const row = env.book['Cashouts&Cor'].data.at(-1);
  assert.strictEqual(row[1], '00:30:00', '17:30 UTC = 00:30 in Jakarta');
  assert.strictEqual(row[0].toISOString(), '2026-11-01T17:00:00.000Z', 'midnight 2 Nov in Jakarta');
  const r2 = env.call({ action: 'push', token, ops: [op('shift_close', { shiftId: 'J', cashCounted: 1, expectedCash: 1 })] });
  assert.ok(r2.shift.v > r.shift.v);
  assert.strictEqual(r2.shift.recent.J, 'Closed');
});

test('device clock too far in the past is refused', () => {
  const env = freshEnv();
  const { token } = login(env, 'ayu', 'pw-ayu');
  const r = env.call({ action: 'push', token, ops: [op('shift_open', { shiftId: 'S', cashCounted: 1 }, '2020-01-01T00:00:00Z')] });
  assert.strictEqual(r.results[0].error, 'bad_time');
});

module.exports = { freshEnv };
