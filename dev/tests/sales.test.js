// Sales, corrections, unpaid bills and refunds against a fake sheet laid out like the real one.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

// yyyyMMddHHmmssSSS in UTC+8, like the old dialogs (script timezone Asia/Singapore).
const tsAt = ms => new Date(ms + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const NOW = Date.now();
const OLD = tsAt(NOW - 40 * 86400000);   // an unpaid line from last month
const RECENT = tsAt(NOW - 2 * 86400000);  // a paid line two days ago

const ENTRIES_HEAD = ['Date', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Time stamp', 'month correction', 'Comment', 'Pouchnation time', 'Status', 'Seller'];
const MANUAL_HEAD = ['', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Author', 'Comment', 'Time stamp', 'Seller'];
const DA = [
  ['Activity', 'Selling Price', 'Purchase prices', '', '', '', '', '', 'Category', 'Sub-category - Income', 'Staff', 'Service', 'Transport', 'Tour', 'Other', 'Paid', 'Payment type'],
  ['Snorkeling Mask', '30,000Rp', '', '', '', '', '', '', 'Income', 'Room', 'Boss', 'Snorkeling Mask', '-Shuttle Bangsal / Kuta', '-Horse Riding', 'Rooms', 'To agent', 'Cash'],
  ['Towel', '50,000Rp', '', '', '', '', '', '', 'Expense', 'Bar', 'Food', 'Towel', '', '', 'Restaurant', '', 'Credit / Debit Card'],
  ['Laundry', '30,000Rp', '', '', '', '', '', '', '', '', '', 'Laundry', '', '', '', '', 'Transfer/Others'],
  ['-Horse Riding', '400,000Rp', '350,000Rp', '', '', '', '', '', '', '', '', 'Bar', '', '', '', '', 'Unpaid'],
  ['-Shuttle Bangsal / Kuta', '160,000Rp', '90,000Rp', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Paid to Partner'],
  ['Bar'],
  ['Laundry', '99,000Rp'], // duplicate name: the first price wins, like the old dialog
];

function freshEnv() {
  const d = new Date(NOW - 40 * 86400000);
  const entries = [ENTRIES_HEAD,
    [d, 'Income', 'Service', 'Towel', 1, 50000, 50000, 50000, 'r2@x', '', 0, 0, 'Old Guest', 'Unpaid', OLD, 'Past', ''],
    [new Date(NOW - 2 * 86400000), 'Income', 'Tour', '-Horse Riding', 2, 400000, 800000, 800000, 'r2@x', 350000, 700000, 700000, 'Paid Guest', 'Cash', RECENT, '', ''],
  ];
  const manual = [MANUAL_HEAD,
    [new Date(NOW - 2 * 86400000), 'Income', 'Tour', '-Horse Riding', 2, '=f', '=g', 800000, '', '=j', '=k', 700000, 'Paid Guest', 'Cash', 'r2@x', '', RECENT],
  ];
  for (let i = 0; i < 20; i++) manual.push(['', '', '', '', '', '=f', '=g', '', '', '=j', '=k']);
  const env = makeEnv({ sheets: {
    'Cashouts&Cor': [['Column 1', 'Time ', 'Cashout', 'Difference', 'Cash in box', 'Change suply', 'Author', 'Comment', 'Type'], ['01/11/2026', '15:00:08', 0, 0, 100000, '', 'r1@x', '', 'Closing']],
    'Entries': entries,
    'Entries Manual': manual,
    'Data activities': DA,
    '24datafeed': [['Guest Name', 'First Name', 'Full'], ['E', 'A', 'Alice Example']],
    'New guest': [['', '', '', '', '', 'Bob Sample']],
  } });
  env.ctx.UI_setup();
  const users = env.book['UI_Users'];
  users.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw', '', '', '']);
  users.appendRow(['dewa', 'Dewa', 'staff', 'r2@x', 'pw', '', '', '']);
  users.appendRow(['boss', 'Boss', 'manager', 'boss@x', 'pw', '', '', '']);
  return env;
}
const login = (env, u) => env.call({ action: 'login', username: u, password: 'pw', deviceId: 'dev1' }).token;
let n = 0;
const op = (type, payload, at = new Date().toISOString()) => ({ id: 'op' + (++n) + '-' + Math.random(), type, at, payload });
const push = (env, token, ...ops) => env.call({ action: 'push', token, deviceId: 'dev1', ops });
let tsClock = NOW;
const newTs = () => tsAt(tsClock = Math.max(Date.now(), tsClock + 1));
function openShift(env, token, id = 'S' + (++n)) {
  const r = push(env, token, op('shift_open', { shiftId: id, cashCounted: 100000 }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  return id;
}
const entriesRows = env => env.book['Entries'].data.slice(1).filter(r => r[14]);
const manualRows = env => env.book['Entries Manual'].data.slice(1).filter(r => r[16]);
const findE = (env, ts) => env.book['Entries'].data.find(r => r[14] === ts);
const findM = (env, ts) => env.book['Entries Manual'].data.find(r => r[16] === ts);

function sale(guests, items, payment = 'Cash') {
  const lines = [];
  for (const it of items) for (const g of guests) lines.push({ ts: newTs(), guest: g, ...it });
  return op('sale', { saleId: 'sale' + (++n), payment, lines });
}

test('pull: catalog by category with prices, payment types, unpaid and recent lines', () => {
  const env = freshEnv();
  const p = env.call({ action: 'pull', token: login(env, 'ayu') });
  assert.ok(p.ok, JSON.stringify(p));
  const byName = Object.fromEntries(p.catalog.map(c => [c.name + '/' + c.category, c]));
  assert.deepStrictEqual(byName['Towel/Service'], { name: 'Towel', category: 'Service', price: 50000, cost: 0 });
  assert.strictEqual(byName['Laundry/Service'].price, 30000, 'first price wins');
  assert.deepStrictEqual(byName['-Shuttle Bangsal / Kuta/Transport'], { name: '-Shuttle Bangsal / Kuta', category: 'Transport', price: 160000, cost: 90000 });
  assert.strictEqual(byName['-Horse Riding/Tour'].price, 400000);
  assert.strictEqual(byName['Bar/Service'].price, 0, 'Bar has no fixed price');
  assert.ok(!p.catalog.some(c => c.name === 'Rooms' || c.name === 'Snorkeling Mask' && c.category !== 'Service'));
  assert.deepStrictEqual(p.payments, ['Cash', 'Credit / Debit Card', 'Transfer/Others', 'Unpaid', 'Paid to Partner']);
  assert.deepStrictEqual(p.lines.map(l => l.ts).sort(), [OLD, RECENT].sort(), 'old unpaid + recent paid');
  const old = p.lines.find(l => l.ts === OLD);
  assert.strictEqual(old.payment, 'Unpaid'); assert.strictEqual(old.past, true); assert.strictEqual(old.total, 50000);
  assert.strictEqual(p.me.author, 'r1@x');
});

test('sale: one line per product and guest, same values in Entries and Entries Manual', () => {
  const env = freshEnv();
  const t = login(env, 'ayu'); openShift(env, t);
  const s = sale(['Alice Example', 'Bob Sample'], [
    { category: 'Service', object: 'Towel', qty: 2, unit: 50000, unitCost: 0 },
    { category: 'Tour', object: '-Horse Riding', qty: 1, unit: 380000, unitCost: 350000, comment: 'discount' },
  ]);
  const r = push(env, t, s);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.strictEqual(r.results[0].lines, 4);
  assert.strictEqual(r.results[0].warning, undefined);
  const lines = s.payload.lines;
  const e = findE(env, lines[0].ts);
  assert.deepStrictEqual(e.slice(1, 17), ['Income', 'Service', 'Towel', 2, 50000, 100000, 100000, 'r1@x', 0, 0, 0, 'Alice Example', 'Cash', lines[0].ts, '', '']);
  assert.ok(e[0] instanceof Date);
  const h = findE(env, lines[3].ts);
  assert.deepStrictEqual([h[3], h[4], h[6], h[10], h[11], h[12], h[16]], ['-Horse Riding', 1, 380000, 350000, 350000, 'Bob Sample', 'discount']);
  const m = findM(env, lines[3].ts);
  assert.deepStrictEqual([m[1], m[2], m[3], m[4], m[7], m[11], m[12], m[13], m[14], m[15]],
    ['Income', 'Tour', '-Horse Riding', 1, 380000, 350000, 'Bob Sample', 'Cash', 'r1@x', 'discount']);
  assert.strictEqual(m[5], '=f', 'formula columns untouched'); assert.strictEqual(m[9], '=j');
  assert.strictEqual(entriesRows(env).length, 6);
  assert.strictEqual(manualRows(env).length, 5);
  // Timestamps are forced to text so the 17 digits survive.
  assert.ok(env.book['Entries'].formats.some(([, c, f]) => c === 15 && f === '@'));
  assert.ok(env.book['Entries Manual'].formats.some(([, c, f]) => c === 17 && f === '@'));
});

test('sale rows match the old Entries <-> Entries Manual sync key, so the old sync adds nothing', () => {
  const env = freshEnv();
  const t = login(env, 'ayu'); openShift(env, t);
  push(env, t, sale(['Alice Example'], [{ category: 'Service', object: 'Laundry', qty: 3, unit: 30000, unitCost: 0 }], 'Credit / Debit Card'));
  const eCols = [0, 1, 2, 3, 4, 7, 8, 11, 12, 13, 14, 16], mCols = [0, 1, 2, 3, 4, 7, 14, 11, 12, 13, 16, 15];
  const key = (row, cols) => cols.map(c => row[c] instanceof Date ? row[c].getTime() : (row[c] === undefined ? '' : row[c])).join('|');
  const mKeys = new Set(env.book['Entries Manual'].data.slice(1).map(r => key(r, mCols)));
  const eKeys = new Set(env.book['Entries'].data.slice(1).filter(r => r[15] !== 'Past').map(r => key(r, eCols)));
  const ours = entriesRows(env).filter(r => r[8] === 'r1@x');
  assert.ok(ours.length === 1 && mKeys.has(key(ours[0], eCols)), 'Entries -> Manual: already present');
  const oursM = manualRows(env).filter(r => r[14] === 'r1@x');
  assert.ok(eKeys.has(key(oursM[0], mCols)), 'Manual -> Entries: already present');
});

test('sale: replay and Google failure halfway never duplicate a line', () => {
  const env = freshEnv();
  const t = login(env, 'ayu'); openShift(env, t);
  const s = sale(['Alice Example'], [{ category: 'Service', object: 'Towel', qty: 1, unit: 50000 }]);
  env.book['Entries Manual'].failNext = 'setValues';
  let r = push(env, t, s);
  assert.ok(r.partial, 'Google error: op kept for retry');
  assert.strictEqual(entriesRows(env).length, 3, 'Entries row was written before the failure');
  r = push(env, t, s);
  assert.strictEqual(r.results[0].status, 'applied');
  r = push(env, t, s);
  assert.strictEqual(r.results[0].status, 'duplicate');
  assert.strictEqual(entriesRows(env).length, 3);
  assert.strictEqual(manualRows(env).length, 2);
});

test('sale: refused cleanly on bad input, never half written', () => {
  const env = freshEnv();
  const t = login(env, 'ayu'); openShift(env, t);
  const bad = [
    [sale(['A'], [{ object: 'Towel', qty: 1, unit: 1 }], 'Bitcoin'), 'bad_payment'],
    [sale(['A'], [{ object: 'Towel', qty: 0, unit: 1 }]), 'bad_amount'],
    [sale(['A'], [{ object: 'Towel', qty: 1, unit: -5 }]), 'bad_amount'],
    [sale([''], [{ object: 'Towel', qty: 1, unit: 1 }]), 'bad_payload'],
    [op('sale', { payment: 'Cash', lines: [{ ts: tsAt(NOW - 5 * 86400000), guest: 'A', object: 'Towel', qty: 1, unit: 1 }] }), 'bad_time'],
    [op('sale', { payment: 'Cash', lines: [{ ts: RECENT.slice(0, 16) + '9', guest: 'Someone', object: 'Towel', qty: 1, unit: 1 }] }, new Date(NOW - 2 * 86400000).toISOString()), null],
  ];
  // Last case: an id equal to an existing line of a different guest is a collision.
  bad[5][0].payload.lines[0].ts = RECENT; bad[5][1] = 'ts_collision';
  for (const [o, code] of bad) {
    const r = push(env, t, o);
    assert.strictEqual(r.results[0].error, code, JSON.stringify(r.results[0]));
  }
  assert.strictEqual(entriesRows(env).length, 2, 'nothing written');
});

test('sale: a guest name that looks like a formula is stored as text', () => {
  const env = freshEnv();
  const t = login(env, 'ayu'); openShift(env, t);
  const s = sale(['=HYPERLINK("x")'], [{ object: 'Towel', qty: 1, unit: 1 }]);
  push(env, t, s);
  assert.strictEqual(findE(env, s.payload.lines[0].ts)[12], '\'=HYPERLINK("x")');
});

test('sale while no shift is open is still recorded, with a warning in the log', () => {
  const env = freshEnv();
  const t = login(env, 'ayu');
  const r = push(env, t, sale(['A'], [{ object: 'Towel', qty: 1, unit: 1 }]));
  assert.strictEqual(r.results[0].status, 'applied');
  assert.match(env.book['UI_Log'].data.at(-1)[8], /no shift was open/);
});

test('corrections: own open shift only for staff, managers anywhere, both sheets updated', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), dewa = login(env, 'dewa'), boss = login(env, 'boss');
  const shift = openShift(env, ayu);
  const s = sale(['Alice Example'], [{ category: 'Tour', object: '-Horse Riding', qty: 1, unit: 400000, unitCost: 350000 }]);
  push(env, ayu, s);
  const ts = s.payload.lines[0].ts;
  let r = push(env, ayu, op('line_update', { ts, qty: 2, unit: 380000, payment: 'Credit / Debit Card', comment: 'two people' }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const e = findE(env, ts);
  assert.deepStrictEqual([e[4], e[5], e[6], e[7], e[10], e[11], e[13], e[16]], [2, 380000, 760000, 760000, 700000, 700000, 'Credit / Debit Card', 'two people']);
  const m = findM(env, ts);
  assert.deepStrictEqual([m[4], m[7], m[11], m[13], m[15], m[5]], [2, 760000, 700000, 'Credit / Debit Card', 'two people', '=f']);
  assert.match(env.book['UI_Log'].data.at(-1)[8], /"before"/, 'old values kept in the log');
  // Someone else's line, or a line from an earlier shift: refused for staff.
  r = push(env, dewa, op('line_update', { ts, qty: 1 }));
  assert.strictEqual(r.results[0].error, 'forbidden');
  r = push(env, ayu, op('line_update', { ts: RECENT, qty: 1 }));
  assert.strictEqual(r.results[0].error, 'forbidden');
  // After closing the shift, no more changes for staff; a manager still can.
  push(env, ayu, op('shift_close', { shiftId: shift, cashCounted: 0, expectedCash: 0 }));
  r = push(env, ayu, op('line_update', { ts, qty: 3 }));
  assert.strictEqual(r.results[0].error, 'forbidden');
  r = push(env, boss, op('line_update', { ts, guest: 'Bob Sample' }));
  assert.strictEqual(r.results[0].status, 'applied');
  assert.strictEqual(findM(env, ts)[12], 'Bob Sample');
  r = push(env, boss, op('line_update', { ts: '20200101000000000', qty: 1 }));
  assert.strictEqual(r.results[0].error, 'line_not_found');
});

test('delete: removes the line from both sheets; sending it again changes nothing', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const s = sale(['Alice Example', 'Bob Sample'], [{ object: 'Towel', qty: 1, unit: 50000 }]);
  push(env, ayu, s);
  const [a, b] = s.payload.lines.map(l => l.ts);
  const del = op('line_delete', { ts: a });
  assert.strictEqual(push(env, ayu, del).results[0].status, 'applied');
  assert.ok(!findE(env, a) && !findM(env, a));
  assert.ok(findE(env, b) && findM(env, b), 'the other guest line stays');
  assert.strictEqual(push(env, ayu, op('line_delete', { ts: a })).results[0].status, 'applied', 'already gone');
  assert.strictEqual(push(env, ayu, op('line_delete', { ts: RECENT })).results[0].error, 'forbidden');
});

test('settle unpaid: payment, author and timestamp change in both sheets; never paid twice', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), dewa = login(env, 'dewa');
  openShift(env, ayu);
  // An unpaid line made today, mirrored in Entries Manual, plus last month's one (Entries only).
  const s = sale(['Alice Example'], [{ object: 'Laundry', qty: 1, unit: 30000 }], 'Unpaid');
  push(env, ayu, s);
  const today = s.payload.lines[0].ts;
  const n1 = newTs(), n2 = newTs();
  const pay = op('settle', { payment: 'Cash', items: [{ oldTs: today, newTs: n1 }, { oldTs: OLD, newTs: n2 }] });
  let r = push(env, ayu, pay);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.strictEqual(r.results[0].settled, 2);
  assert.ok(!findE(env, today) && !findE(env, OLD));
  const e = findE(env, n2);
  assert.deepStrictEqual([e[3], e[8], e[12], e[13], e[15]], ['Towel', 'r1@x', 'Old Guest', 'Cash', 'Past']);
  const m = findM(env, n1);
  assert.deepStrictEqual([m[13], m[14]], ['Cash', 'r1@x']);
  assert.strictEqual(push(env, ayu, pay).results[0].status, 'duplicate');
  // A second device tries to collect the same bill: refused, nothing changes.
  r = push(env, dewa, op('settle', { payment: 'Credit / Debit Card', items: [{ oldTs: n1, newTs: newTs() }] }));
  assert.strictEqual(r.results[0].error, 'already_paid');
  assert.strictEqual(findE(env, n1)[13], 'Cash');
  r = push(env, ayu, op('settle', { payment: 'Unpaid', items: [{ oldTs: n1, newTs: newTs() }] }));
  assert.strictEqual(r.results[0].error, 'bad_payment');
});

test('settle retried after the first attempt already moved the line: counted as done', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const nts = newTs();
  const pay = op('settle', { payment: 'Cash', items: [{ oldTs: OLD, newTs: nts }] });
  env.book['UI_Log'].failNext = 'appendRow'; // applied, then the log write fails
  let r;
  try { r = push(env, ayu, pay); } catch (e) { r = null; }
  r = push(env, ayu, pay);
  assert.strictEqual(r.results[0].status, 'applied');
  assert.strictEqual(r.results[0].settled, 0);
  assert.strictEqual(findE(env, nts)[13], 'Cash');
});

test('refund: one Expense line, original marked Refunded in both sheets, only once', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const nts = newTs();
  const ref = op('refund', { origTs: RECENT, newTs: nts, amount: 400000, payment: 'Cash', reason: 'horse sick' });
  let r = push(env, ayu, ref);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const e = findE(env, nts);
  assert.deepStrictEqual(e.slice(1, 17), ['Expense', 'Tour', '-Horse Riding', 2, '', '', '', 'r1@x', '', '', 400000, 'Paid Guest', 'Cash', nts, '', 'Refunding']);
  assert.strictEqual(findE(env, RECENT)[16], 'Refunded');
  assert.strictEqual(findM(env, RECENT)[15], 'Refunded');
  const m = findM(env, nts);
  assert.deepStrictEqual([m[1], m[11], m[13], m[14], m[15]], ['Expense', 400000, 'Cash', 'r1@x', 'Refunding']);
  assert.match(env.book['UI_Log'].data.at(-1)[8], /horse sick/);
  assert.strictEqual(push(env, ayu, ref).results[0].status, 'duplicate');
  r = push(env, ayu, op('refund', { origTs: RECENT, newTs: newTs(), amount: 1, payment: 'Cash' }));
  assert.strictEqual(r.results[0].error, 'already_refunded');
  r = push(env, ayu, op('refund', { origTs: OLD, newTs: newTs(), amount: 1, payment: 'Cash' }));
  assert.strictEqual(r.results[0].error, 'bad_payload', 'unpaid sale cannot be refunded');
});

test('refund cannot exceed what was paid', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const r = push(env, ayu, op('refund', { origTs: RECENT, newTs: newTs(), amount: 900000, payment: 'Cash' }));
  assert.strictEqual(r.results[0].error, 'bad_amount');
  assert.strictEqual(findE(env, RECENT)[16], '');
});

// ---------------------------------------------------------------- review findings
test('refund interrupted by a Google error: the retry finishes it, and it can never be refunded twice', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const ref = op('refund', { origTs: RECENT, newTs: newTs(), amount: 400000, payment: 'Cash' });
  env.book['Entries Manual'].failNext = 'setValues'; // expense in Entries, then Manual fails
  let r = push(env, ayu, ref);
  assert.ok(r.partial);
  r = push(env, ayu, ref);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.strictEqual(findE(env, RECENT)[16], 'Refunded');
  assert.strictEqual(findM(env, RECENT)[15], 'Refunded');
  assert.strictEqual(findM(env, ref.payload.newTs)[15], 'Refunding');
  assert.strictEqual(entriesRows(env).filter(x => x[1] === 'Expense').length, 1);
  r = push(env, ayu, op('refund', { origTs: RECENT, newTs: newTs(), amount: 1, payment: 'Cash' }));
  assert.strictEqual(r.results[0].error, 'already_refunded');
});

test('bill payment interrupted by a Google error: the retry finishes Entries Manual too', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const s = sale(['Alice Example'], [{ object: 'Laundry', qty: 1, unit: 30000 }], 'Unpaid');
  push(env, ayu, s);
  const oldTs = s.payload.lines[0].ts, nts = newTs();
  const pay = op('settle', { payment: 'Cash', items: [{ oldTs, newTs: nts }] });
  env.book['Entries Manual'].failNext = 'setValues';
  let r = push(env, ayu, pay);
  assert.ok(r.partial);
  assert.strictEqual(findE(env, nts)[13], 'Cash', 'Entries already moved');
  assert.strictEqual(findM(env, oldTs)[13], 'Unpaid', 'Manual not yet');
  r = push(env, ayu, pay);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const m = findM(env, nts);
  assert.ok(m && m[13] === 'Cash' && m[14] === 'r1@x', 'Manual finished');
  assert.ok(!findM(env, oldTs));
});

test('staff cannot take over a colleague\'s unpaid line by settling it, then change or delete it', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const nts = newTs();
  push(env, ayu, op('settle', { payment: 'Cash', items: [{ oldTs: OLD, newTs: nts }] }));
  let r = push(env, ayu, op('line_delete', { ts: nts }));
  assert.strictEqual(r.results[0].error, 'forbidden');
  r = push(env, ayu, op('line_update', { ts: nts, unit: 1 }));
  assert.strictEqual(r.results[0].error, 'forbidden');
  assert.ok(findE(env, nts), 'still there');
  // Her own sale stays editable, and pull tells the device who sold what.
  const s = sale(['Bob Sample'], [{ object: 'Towel', qty: 1, unit: 50000 }]);
  push(env, ayu, s);
  assert.strictEqual(push(env, ayu, op('line_update', { ts: s.payload.lines[0].ts, qty: 2 })).results[0].status, 'applied');
  const lines = env.call({ action: 'pull', token: ayu }).lines;
  assert.strictEqual(lines.find(l => l.ts === s.payload.lines[0].ts).soldBy, 'ayu');
  assert.strictEqual(lines.find(l => l.ts === nts).soldBy, undefined);
});

test('refunded sales and refund lines are locked for staff; a manager edit keeps the Refunded mark', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), boss = login(env, 'boss'); openShift(env, ayu);
  const s = sale(['Bob Sample'], [{ object: 'Towel', qty: 1, unit: 50000 }]);
  push(env, ayu, s);
  const ts = s.payload.lines[0].ts, rts = newTs();
  push(env, ayu, op('refund', { origTs: ts, newTs: rts, amount: 50000, payment: 'Cash' }));
  assert.strictEqual(push(env, ayu, op('line_update', { ts, unit: 0 })).results[0].error, 'forbidden');
  assert.strictEqual(push(env, ayu, op('line_delete', { ts: rts })).results[0].error, 'forbidden');
  assert.strictEqual(push(env, boss, op('line_update', { ts, comment: '' })).results[0].status, 'applied');
  assert.strictEqual(findE(env, ts)[16], 'Refunded');
});

test('staff refund must use the payment type of the sale', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), boss = login(env, 'boss'); openShift(env, ayu);
  let r = push(env, ayu, op('refund', { origTs: RECENT, newTs: newTs(), amount: 1000, payment: 'Credit / Debit Card' }));
  assert.strictEqual(r.results[0].error, 'forbidden');
  r = push(env, boss, op('refund', { origTs: RECENT, newTs: newTs(), amount: 1000, payment: 'Credit / Debit Card' }));
  assert.strictEqual(r.results[0].status, 'applied');
});

test('an operation signed offline by a manager on the reception computer only gets staff rights', () => {
  const env = freshEnv();
  const reg = env.call({ action: 'login', username: 'boss', password: 'pw', deviceId: 'dev1', registerDevice: true });
  const ayu = env.call({ action: 'login', username: 'ayu', password: 'pw', deviceId: 'dev1', deviceSecret: reg.deviceSecret }).token;
  const r = env.call({ action: 'push', token: ayu, deviceId: 'dev1', ops: [{ ...op('line_delete', { ts: RECENT }), by: 'boss' }] });
  assert.strictEqual(r.results[0].error, 'forbidden');
  assert.ok(findE(env, RECENT));
});

test('logout revokes the session', () => {
  const env = freshEnv();
  const t = login(env, 'boss');
  assert.ok(env.call({ action: 'logout', token: t }).ok);
  assert.strictEqual(env.call({ action: 'pull', token: t }).error, 'no_session');
});

test('the version keeps growing even if rows are removed from UI_Log', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  openShift(env, ayu);
  const v1 = push(env, ayu, sale(['A'], [{ object: 'Towel', qty: 1, unit: 1 }])).shift.v;
  env.book['UI_Log'].data.splice(1, 2); // someone archives the log
  const v2 = push(env, ayu, sale(['B'], [{ object: 'Towel', qty: 1, unit: 1 }])).shift.v;
  assert.ok(v2 > v1, `${v2} > ${v1}`);
});

test('a line copied twice by the old sync is deleted everywhere', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  env.book['Entries'].appendRow(findE(env, RECENT).slice());
  env.book['Entries Manual'].appendRow(findM(env, RECENT).slice());
  assert.strictEqual(push(env, boss, op('line_delete', { ts: RECENT })).results[0].status, 'applied');
  assert.ok(!findE(env, RECENT) && !findM(env, RECENT));
});

test('closing uses the cash recorded in the sheet during the shift', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  const id = openShift(env, ayu); // opening cash 100000
  push(env, ayu, sale(['A'], [{ object: 'Towel', qty: 2, unit: 50000 }]));               // +100000 cash
  push(env, ayu, sale(['B'], [{ object: 'Towel', qty: 1, unit: 50000 }], 'Credit / Debit Card')); // card: not in the box
  const r = push(env, ayu, op('shift_close', { shiftId: id, cashCounted: 200000, expectedCash: 200000 }));
  assert.strictEqual(r.results[0].expected, 200000);
  assert.strictEqual(r.results[0].difference, 0);
});

test('a staff member\'s own unpaid sale, paid later in the shift, stays hers to correct', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const s = sale(['Bob Sample'], [{ object: 'Towel', qty: 1, unit: 50000 }], 'Unpaid');
  push(env, ayu, s);
  const nts = newTs();
  push(env, ayu, op('settle', { payment: 'Cash', items: [{ oldTs: s.payload.lines[0].ts, newTs: nts }] }));
  assert.strictEqual(push(env, ayu, op('line_update', { ts: nts, qty: 2 })).results[0].status, 'applied');
  assert.strictEqual(env.call({ action: 'pull', token: ayu }).lines.find(l => l.ts === nts).soldBy, 'ayu');
});
