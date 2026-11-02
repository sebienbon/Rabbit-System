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
  const lines = numbers.map(g => ({ ts: newTs(), guest, category: 'Service', object: g.startsWith('B') ? 'Rabbit bike' : 'Snorkeling Mask', qty: days, unit: 30000, unitCost: 0, comment: g, gear: g }));
  return push(env, token, op('sale', { saleId: 'V' + lines[0].ts, payment, lines }, at));
}

test('back-before rule: 24 h, out before noon → next day 12:00, from noon → next day 18:00', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  // 10:00 and 15:00 reception time (UTC+8) today.
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const morning = new Date(day + 'T02:00:00Z').toISOString(), afternoon = new Date(day + 'T07:00:00Z').toISOString();
  assert.strictEqual(rent(env, ayu, 'Ann', ['SG001'], 1, 'Unpaid', morning).results[0].status, 'applied');
  assert.strictEqual(rent(env, ayu, 'Ben', ['SG002'], 2, 'Unpaid', afternoon).results[0].status, 'applied');
  const g = gearOf(env, ayu);
  const back = x => new Date(new Date(item(g, x).back).getTime() + 8 * 3600000).toISOString().slice(0, 16);
  const next = d => new Date(new Date(day + 'T00:00:00Z').getTime() + d * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(back('SG001'), next(1) + 'T12:00');
  assert.strictEqual(back('SG002'), next(2) + 'T18:00');
  assert.strictEqual(env.book['SG'].data[1][1], 'Out');
  assert.strictEqual(env.book['SG'].data[1][2], 'Ann');
});

test('a rental is a sale line per number; an unavailable number refuses the whole sale', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const r = rent(env, ayu, 'Ann', ['SG001', 'SG002'], 2, 'Cash');
  assert.strictEqual(r.results[0].status, 'applied');
  const lines = env.book['Entries'].data.slice(1);
  assert.deepStrictEqual(lines.map(l => [l[3], l[4], l[7], l[16]]), [['Snorkeling Mask', 2, 60000, 'SG001'], ['Snorkeling Mask', 2, 60000, 'SG002']]);
  const again = rent(env, ayu, 'Ben', ['SG002', 'SG003'], 1);
  assert.strictEqual(again.results[0].error, 'gear_unavailable');
  assert.strictEqual(env.book['Entries'].data.length, 3, 'nothing written for the refused sale');
  assert.strictEqual(rent(env, ayu, 'Ben', ['B1'], 1).results[0].status, 'applied', 'a bike');
});

test('return at the desk: late extension charged Unpaid, damage goes to the decisions', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  rent(env, ayu, 'Ann', ['SG001', 'SG002'], 1);
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
  // The broken one can't be rented until back in service.
  assert.strictEqual(rent(env, ayu, 'Ben', ['SG002'], 1).results[0].error, 'gear_unavailable');
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
