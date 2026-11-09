// Gear (masks & bikes): rentals, returns, Sunset Boat, blind evening check, differences, damages.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

const tsAt = ms => new Date(ms + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const ENTRIES_HEAD = ['Date', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Time stamp', 'month correction', 'Comment', 'Pouchnation time', 'Status', 'Seller'];
const MANUAL_HEAD = ['', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Author', 'Comment', 'Time stamp', 'Seller'];
const DA = [
  ['Activity', 'Selling Price', 'Purchase prices', '', '', '', '', '', '', '', 'Staff', 'Service', 'Transport', 'Tour', 'Other', 'Paid', 'Payment type'],
  ['Snorkeling Mask', '30,000Rp', '', '', '', '', '', '', '', '', '', 'Snorkeling Mask', '', '-Sunset Boat', 'Restaurant', '', 'Cash'],
  ['Rabbit bike', '50,000Rp', '', '', '', '', '', '', '', '', '', 'Rabbit bike', '', '', '', '', 'Unpaid'],
  ['-Sunset Boat', '200,000Rp', '100,000Rp'],
];
function freshEnv() {
  const manual = [MANUAL_HEAD];
  for (let i = 0; i < 10; i++) manual.push(['', '', '', '', '', '=f', '=g', '', '', '=j', '=k']);
  const sg = [['Num', 'Status', 'Last guest ', 'Last Time ', 'Num Days', 'Back Before']];
  for (let i = 1; i <= 6; i++) sg.push(['SG00' + i, 'OK', '', '', '', '']);
  sg.push(['B1', 'OK', '', '', '', '']);
  const env = makeEnv({ sheets: {
    'Cashouts&Cor': [['Column 1', 'Time ', 'Cashout', 'Difference', 'Cash in box', 'Change suply', 'Author', 'Comment', 'Type'], ['01/11/2026', '15:00:08', 0, 0, 1000000, '', 'r1@x', '', 'Closing']],
    'Entries': [ENTRIES_HEAD], 'Entries Manual': manual, 'Data activities': DA, 'SG': sg,
    '24datafeed': [['Guest Name', 'First Name', 'Full']], 'New guest': [['', '', '', '', '', 'Bob']],
  } });
  env.ctx.UI_setup();
  const users = env.book['UI_Users'];
  users.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw', '', '', '']);
  users.appendRow(['made', 'Made', 'gear', 'made@x', 'pw', '', '', '']);
  users.appendRow(['boss', 'Boss', 'manager', 'boss@x', 'pw', '', '', '']);
  // Prices for the damages.
  const gs = env.book['Gear_Settings'];
  gs.data.forEach(r => { if (r[0] === 'Snorkel') r[1] = 75000; if (r[0] === 'Manager WhatsApp') r[1] = '+62 812 000'; });
  return env;
}
const login = (env, u) => env.call({ action: 'login', username: u, password: 'pw', deviceId: 'dev-' + u }).token;
let n = 0;
const op = (type, payload, at = new Date().toISOString()) => ({ id: 'op' + (++n) + '-' + Math.random(), type, at, payload });
const push = (env, token, ...ops) => env.call({ action: 'push', token, deviceId: 'dev', ops });
let clock = Date.now();
const newTs = () => tsAt(clock = Math.max(Date.now(), clock + 1));
const id = p => p + (++n) + 'abcdefg';
const gearOf = (env, token) => env.call({ action: 'pull', token }).gear;
const item = (g, x) => g.items.find(i => i.id === x);
function openShift(env, token) { assert.strictEqual(push(env, token, op('shift_open', { shiftId: 'S' + (++n), cashCounted: 1000000 })).results[0].status, 'applied'); }
function rent(env, token, guest, numbers, days, payment = 'Unpaid', at) {
  let k = 0; // line ids near the operation time, like a real device
  const lines = numbers.map(g => ({ ts: at ? tsAt(Date.parse(at) + k++) : newTs(), guest, category: 'Service', object: g.startsWith('B') ? 'Rabbit bike' : 'Snorkeling Mask', qty: days, unit: 30000, unitCost: 0, comment: g, gear: g }));
  return push(env, token, op('sale', { saleId: 'V' + lines[0].ts, payment, lines }, at));
}

test('back-before rule: 24 h, out before noon → next day 12:00, from noon → next day 18:00', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  // 10:00 and 15:00 reception time (UTC+8) yesterday: always in the past (a time ahead of the sheet is refused).
  const day = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
  const morning = new Date(day + 'T02:00:00Z').toISOString(), afternoon = new Date(day + 'T07:00:00Z').toISOString();
  assert.strictEqual(rent(env, ayu, 'Ann', ['SG001'], 1, 'Unpaid', morning).results[0].status, 'applied');
  assert.strictEqual(rent(env, ayu, 'Ben', ['SG002'], 2, 'Unpaid', afternoon).results[0].status, 'applied');
  const g = gearOf(env, ayu);
  const back = x => new Date(new Date(item(g, x).back).getTime() + 8 * 3600000).toISOString().slice(0, 16);
  const next = d => new Date(new Date(day + 'T00:00:00Z').getTime() + d * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(back('SG001'), next(1) + 'T12:00');
  assert.strictEqual(back('SG002'), next(2) + 'T18:00');
  assert.deepStrictEqual(env.book['SG'].data[0].slice(0, 4), ['Number', 'Type', 'In use', 'Status (auto)']);
  assert.deepStrictEqual(env.book['SG'].data[1].slice(0, 5), ['SG001', 'Mask', true, 'Out', 'Ann']);
  assert.ok(env.book['SG'].data[1][6] instanceof Date, 'back before is a date');
});

test('a rental is a sale line per number; a number already out never refuses the money: it is returned first (resold)', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const r = rent(env, ayu, 'Ann', ['SG001', 'SG002'], 2, 'Cash');
  assert.strictEqual(r.results[0].status, 'applied');
  const lines = env.book['Entries'].data.slice(1);
  assert.deepStrictEqual(lines.map(l => [l[3], l[4], l[7], l[16]]), [['Snorkeling Mask', 2, 60000, 'SG001'], ['Snorkeling Mask', 2, 60000, 'SG002']]);
  const again = rent(env, ayu, 'Ben', ['SG002', 'SG003'], 1);
  assert.strictEqual(again.results[0].status, 'applied');
  assert.strictEqual(env.book['Entries'].data.length, 5, 'the sale is written');
  const g = gearOf(env, ayu);
  assert.deepStrictEqual(g.diffs, [], 'decision 6: no difference, the previous rental is closed');
  assert.ok(env.book['Gear_Log'].data.some(r => r[2] === 'return' && r[3] === 'SG002' && JSON.parse(r[7]).via === 'resold'));
  assert.strictEqual(item(g, 'SG002').last.guest, 'Ben');
  assert.strictEqual(rent(env, ayu, 'Ben', ['B1'], 1).results[0].status, 'applied', 'a bike');
});

test('return at the desk: late extension charged Unpaid, damage goes to the decisions', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001', 'SG002'], 1);
  // Due yesterday, still out at an evening check since: one extension day (decision 5).
  env.book['Gear_Log'].data.forEach(r => { if (r[2] === 'out') r[5] = new Date(Date.now() - 86400000); });
  push(env, made, op('gear_count', { cid: id('K'), items: [] }));
  const r = push(env, ayu, op('gear_return', { gid: id('G'), items: [
    { item: 'SG001', condition: 'OK', ext: { ts: newTs(), days: 1, unit: 30000 } },
    { item: 'SG002', condition: 'Snorkel missing' }] }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const ext = env.book['Entries'].data.find(l => l[16] === 'Extension SG001');
  assert.deepStrictEqual([ext[3], ext[4], ext[7], ext[12], ext[13]], ['Snorkeling Mask', 1, 30000, 'Ann', 'Unpaid']);
  const g = gearOf(env, ayu);
  assert.strictEqual(item(g, 'SG001').where, 'in');
  assert.strictEqual(item(g, 'SG002').condition, 'Snorkel missing');
  const dmg = g.damages.find(d => d.item === 'SG002');
  assert.ok(dmg && dmg.guest === 'Ann' && dmg.decision === 'pending');
  assert.strictEqual(g.prices['Snorkel missing'], 75000);
  // The broken one is not offered for rent (the Sell picker only lists OK numbers in the box).
  assert.notStrictEqual(item(g, 'SG002').condition, 'OK');
  const dec = push(env, ayu, op('gear_decide', { did: id('E'), damage: dmg.id, decision: 'charge', amount: 75000, ts: newTs() }));
  assert.strictEqual(dec.results[0].status, 'applied');
  assert.ok(env.book['Entries'].data.some(l => l[3] === 'Gear damage' && l[7] === 75000 && l[12] === 'Ann' && l[13] === 'Unpaid'));
  push(env, ayu, op('gear_service', { sid: id('R'), item: 'SG002' }));
  assert.strictEqual(rent(env, ayu, 'Ben', ['SG002'], 1).results[0].status, 'applied');
});

test('gear account: blind data only, Sunset Boat out and back, missing ones become differences', () => {
  const env = freshEnv();
  const made = login(env, 'made'), ayu = login(env, 'ayu');
  const g0 = gearOf(env, made);
  assert.deepStrictEqual(Object.keys(g0.items[0]).sort(), ['id', 'kind'], 'no state for the blind check');
  assert.strictEqual(g0.managerWa, '+62812000');
  assert.strictEqual(push(env, made, op('sale', { saleId: 'x', payment: 'Cash', lines: [] })).results[0].error, 'forbidden');
  const trip = id('T');
  assert.strictEqual(push(env, made, op('sunset_out', { trip, items: ['SG001', 'SG002', 'SG003'] })).results[0].status, 'applied');
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'sunset');
  assert.strictEqual(push(env, made, op('sunset_back', { trip, items: ['SG001', 'SG002'] })).results[0].status, 'applied');
  const g = gearOf(env, ayu);
  assert.strictEqual(item(g, 'SG001').where, 'in');
  const df = g.diffs.find(d => d.item === 'SG003');
  assert.ok(df && df.kind === 'sunset_missing' && df.last.kind === 'sunset');
  // Found later: both sides confirm, the mask is back in stock.
  push(env, made, op('gear_confirm', { cfid: id('F'), diff: df.id, action: 'found' }));
  assert.ok(gearOf(env, ayu).diffs.some(d => d.id === df.id && d.gear && !d.reception));
  openShift(env, ayu);
  push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: df.id, action: 'found' }));
  const g2 = gearOf(env, ayu);
  assert.ok(!g2.diffs.some(d => d.id === df.id), 'closed once both confirmed');
  assert.strictEqual(item(g2, 'SG003').where, 'in');
  assert.strictEqual(push(env, ayu, op('sunset_out', { trip: id('T'), items: ['SG004'] })).results[0].error, 'forbidden', 'reception does not run the Sunset Boat');
});

test('evening check: three kinds of differences, damage reported, the desk resolves "found on site"', () => {
  const env = freshEnv();
  const made = login(env, 'made'), ayu = login(env, 'ayu');
  openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001'], 1);            // out, but brought to the back room
  rent(env, ayu, 'Ben', ['SG002'], 1);
  push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG002', condition: 'OK' }] })); // returned, then lost in the hostel
  // Counted: SG001 (out!), SG003, SG004, SG005 broken, B1. Missing: SG002 (returned), SG006 (never out).
  const c = op('gear_count', { cid: id('K'), items: [{ item: 'SG001', condition: 'OK' }, { item: 'SG003', condition: 'OK' }, { item: 'SG004', condition: 'OK' },
    { item: 'SG005', condition: 'Broken' }, { item: 'B1', condition: 'OK' }] });
  assert.strictEqual(push(env, made, c).results[0].differences, 3);
  assert.strictEqual(push(env, made, c).results[0].status, 'duplicate');
  const g = gearOf(env, ayu);
  const kinds = Object.fromEntries(g.diffs.map(d => [d.item, d.kind]));
  assert.deepStrictEqual(kinds, { SG001: 'counted_but_out', SG002: 'returned_not_in_box', SG006: 'missing' });
  assert.ok(g.damages.some(d => d.item === 'SG005' && d.condition === 'Broken'));
  assert.ok(g.countedToday);
  assert.ok(gearOf(env, made).countedToday);
  // The desk: SG001 found on site (no extension), the checker confirms too.
  const d1 = g.diffs.find(d => d.item === 'SG001');
  push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: d1.id, action: 'onsite' }));
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'in');
  push(env, made, op('gear_confirm', { cfid: id('F'), diff: d1.id, action: 'here' }));
  assert.ok(!gearOf(env, ayu).diffs.some(d => d.id === d1.id));
  assert.ok(!env.book['Entries'].data.some(l => /Extension/.test(l[16] || '')), 'found on site: nothing charged');
  // SG006 given up as lost: a damage to decide, the number leaves the stock.
  const d6 = g.diffs.find(d => d.item === 'SG006');
  push(env, ayu, op('gear_lost', { lid: id('L'), diff: d6.id }));
  const g3 = gearOf(env, ayu);
  assert.strictEqual(item(g3, 'SG006').where, 'lost');
  assert.ok(g3.damages.some(d => d.item === 'SG006' && d.condition === 'Lost'));
  // A second check does not open the same difference twice.
  const r2 = push(env, made, op('gear_count', { cid: id('K'), items: [{ item: 'SG001', condition: 'OK' }, { item: 'SG003', condition: 'OK' }, { item: 'SG004', condition: 'OK' }, { item: 'SG005', condition: 'Broken' }, { item: 'B1', condition: 'OK' }] }));
  assert.strictEqual(r2.results[0].differences, 0);
});

test('Google failure in the middle of a rental: retry completes, the number goes out once', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const lines = [{ ts: newTs(), guest: 'Ann', category: 'Service', object: 'Snorkeling Mask', qty: 1, unit: 30000, unitCost: 0, comment: 'SG001', gear: 'SG001' }];
  const s = op('sale', { saleId: 'V' + lines[0].ts, payment: 'Cash', lines });
  env.book['Gear_Log'].failNext = 'setValues';
  assert.ok(push(env, ayu, s).partial);
  assert.strictEqual(push(env, ayu, s).results[0].status, 'applied');
  assert.strictEqual(env.book['Gear_Log'].data.slice(1).filter(r => r[2] === 'out').length, 1);
  assert.strictEqual(env.book['Entries'].data.slice(1).length, 1);
});

test('security: a gear account cannot register a device nor act for another user', () => {
  const env = freshEnv();
  const r = env.call({ action: 'login', username: 'made', password: 'pw', deviceId: 'phone', registerDevice: true });
  assert.ok(!r.registered);
  const res = env.call({ action: 'push', token: r.token, deviceId: 'phone', ops: [{ ...op('expense', { lines: [] }), by: 'ayu' }] });
  assert.strictEqual(res.results[0].error, 'forbidden');
});

test('Sunset Boat: a number still rented keeps its rental and is not on the boat; decisions only once', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001'], 1);
  const trip = id('T');
  assert.strictEqual(push(env, made, op('sunset_out', { trip, items: ['SG001', 'SG002', 'SG002'] })).results[0].status, 'applied');
  let g = gearOf(env, ayu);
  assert.deepStrictEqual(g.trips[0].items, ['SG002']);
  assert.strictEqual(item(g, 'SG001').last.guest, 'Ann');
  const df = g.diffs.find(d => d.item === 'SG001');
  assert.strictEqual(df.kind, 'counted_but_out');
  assert.strictEqual(push(env, ayu, op('gear_lost', { lid: id('L'), diff: df.id })).results[0].error, 'bad_payload', 'seen: not lost');
  // A damage decided once only.
  push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'Broken' }] }));
  g = gearOf(env, ayu);
  const dm = g.damages[0];
  const charge = () => push(env, ayu, op('gear_decide', { did: id('E'), damage: dm.id, decision: 'charge', amount: 50000, guest: 'Ann', ts: newTs() })).results[0];
  assert.strictEqual(charge().status, 'applied');
  assert.strictEqual(charge().error, 'bad_payload');
  assert.strictEqual(env.book['Entries'].data.filter(l => l[3] === 'Gear damage').length, 1);
  // Broken and away for repair: not "missing" at the evening check.
  push(env, made, op('sunset_back', { trip, items: ['SG002'] }));
  const all = gearOf(env, made).items.map(i => i.id).filter(x => x !== 'SG001');
  push(env, made, op('gear_count', { cid: id('K'), items: all.map(x => ({ item: x, condition: 'OK' })) }));
  assert.ok(!gearOf(env, ayu).diffs.some(d => d.item === 'SG001' && d.kind === 'missing'));
});

test('SG tab: own layout built from the old list; a retired number disappears; old statuses ignored', () => {
  const env = freshEnv();
  const sg = env.book['SG'];
  assert.strictEqual(sg.data.length, 8);
  assert.deepStrictEqual(sg.data[7].slice(0, 4), ['B1', 'Bike', true, 'In']);
  sg.data[2][2] = false; // SG002 retired
  const ayu = login(env, 'ayu');
  const g = gearOf(env, ayu);
  assert.ok(!g.items.some(i => i.id === 'SG002'));
  assert.strictEqual(item(g, 'B1').kind, 'bike');
});

test('QwenWork findings: manager number read from the Note column; a departure of numbers all out opens no trip', () => {
  const env = freshEnv();
  env.book['Gear_Settings'].data.forEach(r => { if (r[0] === 'Manager WhatsApp') { r[1] = ''; r[2] = '+62881011166142'; } });
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  assert.strictEqual(gearOf(env, made).managerWa, '+62881011166142');
  rent(env, ayu, 'Ann', ['SG001'], 1);
  const so = push(env, made, op('sunset_out', { trip: id('T'), items: ['SG001'] })).results[0];
  assert.strictEqual(so.status, 'applied');
  assert.deepStrictEqual(so.items, [], 'S7: nothing left on the boat');
  const g = gearOf(env, ayu);
  assert.deepStrictEqual(g.trips, []);
  assert.deepStrictEqual(g.diffs, [], 'S7: nothing written');
});

test('Seb 03/11: a Sunset Boat mask can be returned at the desk, and is then not "missing" at the boat return', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  const trip = id('T');
  push(env, made, op('sunset_out', { trip, items: ['SG001', 'SG002'] }));
  const r = push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'OK' }] }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.strictEqual(item(gearOf(env, ayu), 'SG001').where, 'in');
  push(env, made, op('sunset_back', { trip, items: ['SG002'] }));
  const g = gearOf(env, ayu);
  assert.deepStrictEqual(g.diffs, []);
  assert.strictEqual(item(g, 'SG002').where, 'in');
  assert.strictEqual(env.book['SG'].data[1][3], 'In');
});

test('Seb 03/11: quantity = days on a rental line; correcting it moves the return time, deleting the line puts the number back', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001', 'SG002'], 1);
  const lines = env.book['Entries'].data.slice(1);
  assert.deepStrictEqual(lines.map(l => [l[4], l[16]]), [[1, 'SG001'], [1, 'SG002']], 'one line per number, qty = days');
  const ts1 = String(lines[0][14]), ts2 = String(lines[1][14]);
  const before = item(gearOf(env, ayu), 'SG001').back;
  let r = push(env, ayu, op('line_update', { ts: ts1, qty: 3, guest: 'Ann B' }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  let g = gearOf(env, ayu);
  assert.strictEqual(Date.parse(item(g, 'SG001').back) - Date.parse(before), 2 * 86400000, 'two more days');
  assert.strictEqual(item(g, 'SG001').last.guest, 'Ann B');
  assert.strictEqual(env.book['Entries'].data[1][6], 90000);
  r = push(env, ayu, op('line_delete', { ts: ts2 }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  g = gearOf(env, ayu);
  assert.strictEqual(item(g, 'SG002').where, 'in');
  assert.strictEqual(item(g, 'SG001').where, 'out');
  assert.strictEqual(env.book['SG'].data[2][3], 'In');
});

test('QwenWork v11 K1/K2: a repaired damage does not come back; a trip returned at the desk is over', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001'], 1);
  push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG001', condition: 'Broken' }] }));
  let dm = gearOf(env, ayu).damages[0];
  push(env, ayu, op('gear_decide', { did: id('E'), damage: dm.id, decision: 'nocharge' }));
  push(env, ayu, op('gear_service', { sid: id('R'), item: 'SG001' }));
  assert.deepStrictEqual(gearOf(env, ayu).damages, []);
  // broken again at the evening check: only the new case shows
  const all = gearOf(env, made).items.map(i => i.id);
  push(env, made, op('gear_count', { cid: id('K'), items: all.map(x => ({ item: x, condition: x === 'SG001' ? 'Broken' : 'OK' })) }));
  const ds = gearOf(env, ayu).damages;
  assert.strictEqual(ds.length, 1);
  assert.strictEqual(ds[0].decision, 'pending');
  // K2
  const trip = id('T');
  push(env, made, op('sunset_out', { trip, items: ['SG002'] }));
  push(env, ayu, op('gear_return', { gid: id('G'), items: [{ item: 'SG002', condition: 'OK' }] }));
  const t = gearOf(env, made).trips.find(x => x.trip === trip);
  assert.ok(t.closed, 'trip over');
});

test('Seb 03/11: gear staff record returns (blind, late ones to the reception) and damage off the Sunset Boat', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001'], 1, 'Unpaid');
  env.book['Gear_Log'].data.forEach(r => { if (r[2] === 'out' && r[3] === 'SG001') r[5] = new Date(Date.now() - 2 * 86400000); }); // was due 2 days ago
  push(env, made, op('gear_count', { cid: id('K'), items: [] }));  // the evening check did not find it
  rent(env, ayu, 'Ben', ['SG002'], 2);                         // on time
  const r = push(env, made, op('gear_return', { gid: id('G'), items: [
    { item: 'SG001', condition: 'OK' }, { item: 'SG002', condition: 'Ring missing' }, { item: 'SG003', condition: 'OK' }] }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  let g = gearOf(env, ayu);
  assert.ok(['SG001', 'SG002', 'SG003'].every(x => item(g, x).where === 'in'), 'returned; SG003 (in) is not an error');
  const late = g.diffs.find(d => d.kind === 'returned_late');
  assert.ok(late && late.item === 'SG001' && late.gear && !late.reception && late.late >= 1);
  assert.ok(g.damages.some(d => d.item === 'SG002' && d.condition === 'Ring missing'));
  // reception charges the extension
  const c = push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: late.id, action: 'returned', ext: { ts: newTs() } }));
  assert.strictEqual(c.results[0].status, 'applied', JSON.stringify(c));
  const ext = env.book['Entries'].data.find(l => l[16] === 'Extension SG001');
  assert.ok(ext && ext[12] === 'Ann' && ext[13] === 'Unpaid' && ext[4] === late.late);
  assert.ok(!gearOf(env, ayu).diffs.some(d => d.id === late.id), 'closed');
  // Sunset Boat: one mask broken on the way back
  const trip = id('T');
  push(env, made, op('sunset_out', { trip, items: ['SG004', 'SG005'] }));
  push(env, made, op('sunset_back', { trip, items: ['SG004', 'SG005'], conditions: { SG005: 'Broken' } }));
  g = gearOf(env, ayu);
  assert.ok(g.damages.some(d => d.item === 'SG005' && d.condition === 'Broken' && d.guest === 'Sunset Boat'));
  assert.strictEqual(item(g, 'SG005').condition, 'Broken');
});

test('Seb 03/11: a damage carries the comment typed by the gear staff; bikes can miss a part; late return shows its times', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['B1'], 1);
  env.book['Gear_Log'].data.forEach(r => { if (r[2] === 'out' && r[3] === 'B1') r[5] = new Date(Date.now() - 5 * 3600000); });
  push(env, made, op('gear_count', { cid: id('K'), items: [] }));
  push(env, made, op('gear_return', { gid: id('G'), items: [{ item: 'B1', condition: 'Part missing', note: 'pedale gauche' }] }));
  const g = gearOf(env, ayu);
  const dm = g.damages.find(d => d.item === 'B1');
  assert.ok(dm && dm.condition === 'Part missing' && dm.note === 'pedale gauche');
  const late = g.diffs.find(d => d.kind === 'returned_late');
  assert.ok(late.due && late.returned && Date.parse(late.returned) - Date.parse(late.due) > 4 * 3600000);
});

test('Seb 03/11: a number handed to the gear staff but not out is checked by the reception (hidden from the staff); mask missing keeps it out of rental', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  push(env, made, op('gear_return', { gid: id('G'), items: [{ item: 'SG004', condition: 'Mask missing', note: 'snorkel only' }] }));
  const g = gearOf(env, ayu);
  const d = g.diffs.find(x => x.kind === 'returned_not_out');
  assert.ok(d && d.item === 'SG004' && d.gear);
  assert.ok(!gearOf(env, made).diffs.some(x => x.kind === 'returned_not_out'), 'blind: not shown to the gear staff');
  assert.strictEqual(item(g, 'SG004').condition, 'Mask missing');
  assert.ok(g.damages.some(x => x.item === 'SG004' && x.note === 'snorkel only'));
  assert.ok(gearOf(env, made).unavailable.includes('SG004'));
  const c = push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: d.id, action: 'found' }));
  assert.strictEqual(c.results[0].status, 'applied');
  assert.ok(!gearOf(env, ayu).diffs.some(x => x.id === d.id));
});

test('Seb 06/11: reception staff accounts work in the gear app (blind there); two different people confirm a difference', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  const pull = env.call({ action: 'pull', token: ayu, app: 'gear' });
  assert.ok(pull.ok !== false && pull.gear && pull.gear.items.every(i => Object.keys(i).join() === 'id,kind'), 'blind view');
  assert.strictEqual(pull.catalog, undefined, 'only the gear part');
  rent(env, ayu, 'Ann', ['SG001'], 1);
  const all = gearOf(env, made).items.map(i => i.id);
  const r = push(env, ayu, op('gear_count', { cid: id('K'), items: all.map(x => ({ item: x, condition: 'OK' })), app: 'gear' }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const df = gearOf(env, made).diffs.find(d => d.item === 'SG001');
  assert.ok(df && df.kind === 'counted_but_out', JSON.stringify(gearOf(env, made).diffs));
  assert.strictEqual(push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: df.id, action: 'here', app: 'gear' })).results[0].status, 'applied');
  const same = push(env, ayu, op('gear_confirm', { cfid: id('F'), diff: df.id, action: 'onsite' })).results[0];
  assert.strictEqual(same.error, 'bad_payload', 'the same person cannot confirm both sides');
  assert.strictEqual(push(env, ayu, op('gear_count', { cid: id('K'), items: [] })).results[0].error, 'forbidden', 'without the gear app flag');
});

test('Seb 09/11: an inventory done in "Pengembalian" does not pile up the same difference for each number', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), made = login(env, 'made'); openShift(env, ayu);
  const all = gearOf(env, made).items.map(i => ({ item: i.id, condition: 'OK' }));
  for (let k = 0; k < 3; k++) assert.strictEqual(push(env, made, op('gear_return', { gid: id('G'), items: all })).results[0].status, 'applied');
  const nout = gearOf(env, ayu).diffs.filter(d => d.kind === 'returned_not_out');
  assert.strictEqual(nout.length, all.length, 'one per number, not one per try');
});
