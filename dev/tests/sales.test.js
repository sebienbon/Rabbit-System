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
// Same columns as the live tab, A..X: ... Q Payment type, R Commission, S Rooms, T Payment type2, U Room Ids,
// V Commission exceptions, W Partner lines, X Expense buttons.
const DA_HEAD = ['Activity', 'Selling Price', 'Purchase prices', '', '', '', '', '', 'Category', 'Sub-category - Income', 'Staff', 'Service', 'Transport', 'Tour', 'Other', 'Paid', 'Payment type',
  'Commission', 'Rooms', 'Payment type2', 'Room Ids', 'Commission exceptions', 'Partner lines', 'Expense buttons'];
const DA = [
  DA_HEAD,
  ['Snorkeling Mask', '30,000Rp', '', '', '', '', '', '', 'Income', 'Room', 'Boss', 'Snorkeling Mask', '-Shuttle Bangsal / Kuta', '-Horse Riding', 'Rooms', 'To agent', 'Cash',
    'Boss', 'Double inside building', 'Cash', 353330, '-Gili T Night Boat', 'Payment to Partner', 'Restaurant'],
  ['Towel', '50,000Rp', '', '', '', '', '', '', 'Expense', 'Bar', 'Food', 'Towel', '', '', 'Restaurant', '', 'Credit / Debit Card',
    'Banu', 'Tree House', 'Credit / Debit Card', 460595, '', 'Payment From Partner', 'Laundry'],
  ['Laundry', '30,000Rp', '', '', '', '', '', '', '', '', '', 'Laundry', '', '', 'other', '', 'Transfer/Others', '', '', 'Transfer/Others', '', '', '', 'other'],
  ['-Horse Riding', '400,000Rp', '350,000Rp', '', '', '', '', '', '', '', '', 'Bar', '', '', '', '', 'Unpaid', '', '', 'Extern cash', '', '', '', 'Not listed in L..O'],
  ['-Shuttle Bangsal / Kuta', '160,000Rp', '90,000Rp', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Paid to Partner', '', '', 'Unpaid'],
  ['Bar'],
  ['Laundry', '99,000Rp'], // duplicate name: the first price wins, like the old dialog
];

function freshEnv(da = DA) {
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
    'Data activities': da.map(r => r.slice()),
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
/** How a cell was stored, found by the line id in column tsCol (1-based). */
const cellKind = (env, sheet, tsCol, ts, col) => {
  const sh = env.book[sheet];
  const r = sh.data.findIndex(row => row[tsCol - 1] === ts) + 1;
  return sh.kind(r, col);
};
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
  assert.strictEqual(findE(env, s.payload.lines[0].ts)[12], '=HYPERLINK("x")');
  assert.strictEqual(cellKind(env, 'Entries', 15, s.payload.lines[0].ts, 13), 'text');
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
  assert.strictEqual(r.results[0].error, 'forbidden', 'decision 9: staff without an open shift');
  r = push(env, login(env, 'boss'), op('settle', { payment: 'Credit / Debit Card', items: [{ oldTs: n1, newTs: newTs() }] }));
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

test('a refund can be paid back another way (card refund impossible after a day), with a reason', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu); // the sale RECENT was paid Cash
  let r = push(env, ayu, op('refund', { origTs: RECENT, newTs: newTs(), amount: 1000, payment: 'Transfer/Others' }));
  assert.strictEqual(r.results[0].error, 'bad_payload', 'another payment type needs a reason');
  r = push(env, ayu, op('refund', { origTs: RECENT, newTs: newTs(), amount: 1000, payment: 'Paid to Partner', reason: 'x' }));
  assert.strictEqual(r.results[0].error, 'bad_payment');
  const ok = op('refund', { origTs: RECENT, newTs: newTs(), amount: 1000, payment: 'Transfer/Others', reason: 'guest left, bank transfer' });
  r = push(env, ayu, ok);
  assert.strictEqual(r.results[0].status, 'applied');
  assert.strictEqual(env.book['Entries'].data.find(x => x[14] === ok.payload.newTs)[13], 'Transfer/Others');
  assert.match(env.book['UI_Log'].data.slice(-1)[0][8], /guest left, bank transfer/);
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

// ---------------------------------------------------------------- expenses
const expense = (object, amount, payment = 'Cash', extra = {}) => op('expense', { ts: newTs(), object, amount, payment, ...extra });

test('expense: written like the old Daily Expenses dialog, in both sheets, and New guest once', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const e1 = expense('Restaurant', 70000, 'Cash', { comment: 'telur 1 trai' });
  let r = push(env, ayu, e1);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const e = findE(env, e1.payload.ts);
  assert.deepStrictEqual(e.slice(1, 17), ['Expense', 'Other', 'Restaurant', '', '', '', '', 'r1@x', '', '', 70000, 'ExpenseRestaurant', 'Cash', e1.payload.ts, '', 'telur 1 trai']);
  assert.ok(e[0] instanceof Date);
  const m = findM(env, e1.payload.ts);
  assert.deepStrictEqual([m[1], m[2], m[3], m[11], m[12], m[13], m[14], m[15], m[5]], ['Expense', 'Other', 'Restaurant', 70000, 'ExpenseRestaurant', 'Cash', 'r1@x', 'telur 1 trai', '=f']);
  const ng = () => env.book['New guest'].data.filter(x => x[2] === 'ExpenseRestaurant');
  assert.strictEqual(ng().length, 1); assert.strictEqual(ng()[0][5], 'ExpenseRestaurant');
  push(env, ayu, expense('Restaurant', 1000));
  assert.strictEqual(ng().length, 1, 'added only once');
  // The pseudo-guest never shows up in the guest list.
  assert.ok(!env.call({ action: 'pull', token: ayu }).guests.some(g => /^Expense/.test(g)));
});

test('expense: "Others" maps to the item "other" (the old dialog lost these); unknown items refused', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const o = expense('other', 25000);
  assert.strictEqual(push(env, ayu, o).results[0].status, 'applied');
  assert.strictEqual(findE(env, o.payload.ts)[2], 'Other');
  const l = expense('Laundry', 10000);
  push(env, ayu, l);
  assert.strictEqual(findE(env, l.payload.ts)[2], 'Service', 'first column listing it, like the old dialog');
  assert.strictEqual(push(env, ayu, expense('Others', 1)).results[0].error, 'bad_payload');
  assert.strictEqual(push(env, ayu, expense('Restaurant', 1, 'Paid to Partner')).results[0].error, 'bad_payment');
  assert.strictEqual(push(env, ayu, expense('Restaurant', 0)).results[0].error, 'bad_amount');
});

test('expense: chosen date kept (yesterday), refused if older than a month', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const y = new Date(Date.now() - 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const e1 = expense('Restaurant', 5000, 'Cash', { date: y });
  push(env, ayu, e1);
  const d = findE(env, e1.payload.ts)[0];
  assert.strictEqual(new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10), y);
  const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(push(env, ayu, expense('Restaurant', 5000, 'Cash', { date: old })).results[0].error, 'bad_time');
});

test('expense: Google failure halfway, retry completes without a second line', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const e1 = expense('Restaurant', 9000);
  env.book['Entries Manual'].failNext = 'setValues';
  assert.ok(push(env, ayu, e1).partial);
  assert.strictEqual(push(env, ayu, e1).results[0].status, 'applied');
  assert.strictEqual(entriesRows(env).filter(x => x[14] === e1.payload.ts).length, 1);
  assert.strictEqual(manualRows(env).filter(x => x[16] === e1.payload.ts).length, 1);
});

test('expense: counts against the cash in the box; its author can fix the amount, a colleague cannot', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), dewa = login(env, 'dewa');
  const id = openShift(env, ayu); // opening 100000
  const e1 = expense('Restaurant', 30000);
  push(env, ayu, e1);
  push(env, ayu, expense('Restaurant', 20000, 'Credit / Debit Card')); // not from the box
  assert.strictEqual(push(env, dewa, op('line_update', { ts: e1.payload.ts, amount: 1 })).results[0].error, 'forbidden');
  let r = push(env, ayu, op('line_update', { ts: e1.payload.ts, amount: 35000, comment: 'with drinks' }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.deepStrictEqual([findE(env, e1.payload.ts)[11], findM(env, e1.payload.ts)[11], findM(env, e1.payload.ts)[15]], [35000, 35000, 'with drinks']);
  assert.strictEqual(push(env, ayu, op('line_update', { ts: RECENT, amount: 1 })).results[0].error, 'forbidden');
  r = push(env, ayu, op('shift_close', { shiftId: id, cashCounted: 65000, expectedCash: 65000 }));
  assert.strictEqual(r.results[0].expected, 65000);
  assert.strictEqual(r.results[0].difference, 0);
  assert.strictEqual(env.call({ action: 'pull', token: ayu }).lines.find(l => l.ts === e1.payload.ts).soldBy, 'ayu');
});

test('review: a comment that looks like a formula survives a retry as text in Entries Manual', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const e1 = expense('Restaurant', 9000, 'Cash', { comment: '+62 812 3456 (supplier)' });
  env.book['Entries Manual'].failNext = 'setValues';
  assert.ok(push(env, ayu, e1).partial);
  findE(env, e1.payload.ts)[16] = '+62 812 3456 (supplier)'; // what the sheet gives back: apostrophe gone
  assert.strictEqual(push(env, ayu, e1).results[0].status, 'applied');
  assert.strictEqual(findM(env, e1.payload.ts)[15], '+62 812 3456 (supplier)');
  assert.strictEqual(cellKind(env, 'Entries Manual', 17, e1.payload.ts, 16), 'text');
  const m = findM(env, e1.payload.ts);
  assert.deepStrictEqual([m[5], m[6], m[9], m[10]], ['=f', '=g', '=j', '=k'], 'formulas of the row kept');
});

test('review: an expense line accepts only amount, payment and comment changes', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), boss = login(env, 'boss'); openShift(env, ayu);
  const e1 = expense('Restaurant', 9000);
  push(env, ayu, e1);
  for (const change of [{ unit: 1e9 }, { qty: 2 }, { guest: 'X' }]) {
    assert.strictEqual(push(env, boss, op('line_update', { ts: e1.payload.ts, ...change })).results[0].error, 'bad_payload');
  }
  assert.strictEqual(push(env, boss, op('line_update', { ts: e1.payload.ts, payment: 'Paid to Partner' })).results[0].error, 'bad_payment');
  assert.strictEqual(findE(env, e1.payload.ts)[7], '', 'no income written on the expense');
});

test('review: an expense id reused with another amount is a collision, not a takeover', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), dewa = login(env, 'dewa'); openShift(env, ayu);
  const e1 = expense('Restaurant', 9000);
  push(env, ayu, e1);
  const fake = { ...e1, id: 'other-op', payload: { ...e1.payload, amount: 1 } };
  assert.strictEqual(push(env, dewa, fake).results[0].error, 'forbidden', 'decision 9: no open shift');
  assert.strictEqual(push(env, login(env, 'boss'), { ...fake, id: 'other-op2' }).results[0].error, 'ts_collision');
});

test('review: expense dates are checked as calendar days', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const tomorrow = new Date(Date.now() + 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  assert.strictEqual(push(env, ayu, expense('Restaurant', 1, 'Cash', { date: tomorrow })).results[0].error, 'bad_time');
  assert.strictEqual(push(env, ayu, expense('Restaurant', 1, 'Cash', { date: '2026-02-31' })).results[0].error, 'bad_time');
});

// ---------------------------------------------------------------- cash box (step 3b)
const cashRows = env => env.book['Cashouts&Cor'].data.slice(1).filter(r => r[8]);
const pid = () => 'P' + (++n) + 'abcdef';

test('phantom: written like the old dialog (difference, cash in box chained, type Phantom) and counted at closing', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  const id = openShift(env, ayu); // box 100000
  const p1 = op('phantom', { pid: pid(), notGiven: 20000, comment: 'change for room 3' });
  const r = push(env, ayu, p1);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const row = cashRows(env).pop();
  assert.strictEqual(row[3], 20000);
  assert.strictEqual(row[4], 120000);
  assert.strictEqual(row[6], 'r1@x');
  assert.strictEqual(row[7], 'change for room 3 [' + p1.payload.pid + ']');
  assert.strictEqual(row[8], 'Phantom');
  push(env, ayu, op('phantom', { pid: pid(), notReceived: 5000, comment: 'guest pays tomorrow' }));
  assert.strictEqual(cashRows(env).pop()[4], 115000);
  // Opening 100000 + 20000 change kept − 5000 not received = 115000 expected.
  const c = push(env, ayu, op('shift_close', { shiftId: id, cashCounted: 115000, expectedCash: 115000 }));
  assert.strictEqual(c.results[0].expected, 115000);
  assert.strictEqual(c.results[0].difference, 0);
});

test('phantom: one amount and a comment required; staff need their own open shift; replay writes once', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'), boss = login(env, 'boss');
  assert.strictEqual(push(env, ayu, op('phantom', { pid: pid(), notGiven: 1000, comment: 'x' })).results[0].error, 'forbidden');
  openShift(env, ayu);
  assert.strictEqual(push(env, ayu, op('phantom', { pid: pid(), notGiven: 1000, notReceived: 1000, comment: 'x' })).results[0].error, 'bad_amount');
  assert.strictEqual(push(env, ayu, op('phantom', { pid: pid(), comment: 'x' })).results[0].error, 'bad_amount');
  assert.strictEqual(push(env, ayu, op('phantom', { pid: pid(), notGiven: 1000, comment: '  ' })).results[0].error, 'bad_payload');
  const dewa = login(env, 'dewa');
  assert.strictEqual(push(env, dewa, op('phantom', { pid: pid(), notGiven: 1000, comment: 'x' })).results[0].error, 'forbidden');
  const p = op('phantom', { pid: pid(), notGiven: 1000, comment: 'x' });
  env.book['UI_Log'].failNext = 'appendRow';
  assert.strictEqual(push(env, ayu, p).error, 'server_error', 'log write failed after the row was written');
  assert.strictEqual(push(env, ayu, p).results[0].status, 'applied');
  assert.strictEqual(cashRows(env).filter(r => String(r[7]).includes(p.payload.pid)).length, 1);
  assert.strictEqual(push(env, boss, op('phantom', { pid: pid(), notReceived: 500, comment: 'boss' })).results[0].status, 'applied');
});

test('phantom solve: salvation row with the opposite difference, original marked solved, only once', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  openShift(env, ayu);
  const p1 = op('phantom', { pid: pid(), notGiven: 20000, comment: 'change' });
  push(env, ayu, p1);
  const pulled = env.call({ action: 'pull', token: ayu }).cashbox;
  const ph = pulled.find(c => c.pid === p1.payload.pid);
  assert.ok(ph && ph.type === 'Phantom' && ph.diff === 20000 && ph.comment === 'change', JSON.stringify(pulled));
  const s1 = op('phantom_solve', { pid: pid(), target: ph.key });
  env.book['Cashouts&Cor'].failNext = 'setValue';
  assert.ok(push(env, ayu, s1).partial, 'Google failure after the salvation row');
  assert.strictEqual(push(env, ayu, s1).results[0].status, 'applied');
  const rows = cashRows(env);
  assert.strictEqual(rows.filter(r => r[8] === 'Phantom Salvation').length, 1);
  const salv = rows.find(r => r[8] === 'Phantom Salvation');
  assert.strictEqual(salv[3], -20000);
  assert.strictEqual(salv[4], 100000);
  assert.strictEqual(rows.find(r => String(r[7]).includes(p1.payload.pid))[8], 'Phantom Solved');
  assert.strictEqual(push(env, ayu, op('phantom_solve', { pid: pid(), target: ph.key })).results[0].error, 'already_solved');
});

test('phantom solve: works on a phantom written by the old dialog (no tag)', () => {
  const env = freshEnv();
  const cash = env.book['Cashouts&Cor'];
  cash.appendRow(['19/10/2026', '10:52:17', '', -25000, 75000, '', 'r2@x', 'kembalian water refill', 'Phantom']);
  const ayu = login(env, 'ayu');
  openShift(env, ayu); // reference box is now 75000
  const ph = env.call({ action: 'pull', token: ayu }).cashbox.find(c => c.comment === 'kembalian water refill');
  assert.ok(ph, 'unsolved phantoms are always sent, however old');
  assert.match(ph.key, /^K20261019105217\|-25000\|r2@x$/);
  assert.strictEqual(push(env, ayu, op('phantom_solve', { pid: pid(), target: ph.key })).results[0].status, 'applied');
  assert.strictEqual(cash.data.find(r => r[7] === 'kembalian water refill')[8], 'Phantom Solved');
  assert.strictEqual(cashRows(env).pop()[3], 25000);
});

test('cash supply: income Cash + expense Extern Cash like the old dialog, New guest column F once, not editable', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  const id = openShift(env, ayu);
  const cs = op('cash_supply', { ts: newTs(), ts2: newTs(), amount: 500000 });
  env.book['Entries Manual'].failNext = 'setValues';
  assert.ok(push(env, ayu, cs).partial);
  assert.strictEqual(push(env, ayu, cs).results[0].status, 'applied');
  const inc = findE(env, cs.payload.ts), exp = findE(env, cs.payload.ts2);
  assert.deepStrictEqual([inc[1], inc[2], inc[3], inc[7], inc[8], inc[12], inc[13]], ['Income', 'Other', 'Cash Supply', 500000, 'r1@x', 'Cash Supply', 'Cash']);
  assert.deepStrictEqual([exp[1], exp[2], exp[3], exp[11], exp[12], exp[13]], ['Expense', 'Other', 'Cash Supply', 500000, 'Cash Supply', 'Extern Cash']);
  assert.strictEqual(manualRows(env).filter(r => r[3] === 'Cash Supply').length, 2);
  assert.strictEqual(findM(env, cs.payload.ts)[14], 'r1@x');
  push(env, ayu, op('cash_supply', { ts: newTs(), ts2: newTs(), amount: 1000 }));
  assert.strictEqual(env.book['New guest'].data.filter(r => r[5] === 'Cash Supply').length, 1);
  assert.ok(!env.call({ action: 'pull', token: ayu }).guests.includes('Cash Supply'));
  assert.strictEqual(push(env, login(env, 'boss'), op('line_update', { ts: cs.payload.ts, comment: 'x' })).results[0].error, 'bad_payload');
  assert.strictEqual(push(env, ayu, op('line_delete', { ts: cs.payload.ts })).results[0].error, 'forbidden');
  assert.strictEqual(push(env, ayu, op('refund', { origTs: cs.payload.ts, newTs: newTs(), amount: 1000, payment: 'Cash' })).results[0].error, 'bad_payload');
  // The supply is cash put in the box: 100000 + 500000 + 1000.
  const c = push(env, ayu, op('shift_close', { shiftId: id, cashCounted: 601000, expectedCash: 601000 }));
  assert.strictEqual(c.results[0].difference, 0);
});

test('review: phantom comment like a phone number stays text; solving it writes a Salvation with no comment, once, even after a failure', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const p1 = op('phantom', { pid: pid(), notReceived: 30000, comment: '+62 812 3456 pays tonight' });
  push(env, ayu, p1);
  const cash = env.book['Cashouts&Cor'];
  const r1 = cash.data.findIndex(r => String(r[7]).includes(p1.payload.pid)) + 1;
  assert.strictEqual(cash.kind(r1, 8), 'text');
  const ph = env.call({ action: 'pull', token: ayu }).cashbox.find(c => c.pid === p1.payload.pid);
  assert.strictEqual(ph.comment, '+62 812 3456 pays tonight');
  const s1 = op('phantom_solve', { pid: pid(), target: ph.key });
  cash.failNext = 'setValue';
  assert.ok(push(env, ayu, s1).partial);
  assert.strictEqual(push(env, ayu, s1).results[0].status, 'applied');
  const salv = cashRows(env).filter(r => r[8] === 'Phantom Salvation');
  assert.strictEqual(salv.length, 1);
  assert.strictEqual(salv[0][7], '[' + s1.payload.pid + ']');
  assert.strictEqual(salv[0][3], 30000);
});

test('review: a solve reusing the phantom\'s own id is refused; a phantom whose row changed is not marked', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const p1 = op('phantom', { pid: pid(), notGiven: 1000, comment: 'a' });
  push(env, ayu, p1);
  assert.strictEqual(push(env, ayu, op('phantom_solve', { pid: p1.payload.pid, target: p1.payload.pid })).results[0].error, 'bad_payload');
  assert.strictEqual(cashRows(env).find(r => String(r[7]).includes(p1.payload.pid))[8], 'Phantom');
  assert.strictEqual(cashRows(env).filter(r => r[8] === 'Phantom Salvation').length, 0);
});

test('TEMPORARY bar cash-out: one Entries Manual row like the old sheet, not in Entries, not in the box', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  const b = op('bar_cashout', { ts: newTs(), amount: 600000, comment: '' });
  assert.strictEqual(push(env, ayu, b).results[0].error, 'forbidden');
  const id = openShift(env, ayu);
  const b2 = op('bar_cashout', { ts: newTs(), amount: 600000, comment: 'night' });
  assert.strictEqual(push(env, ayu, b2).results[0].status, 'applied');
  const m = findM(env, b2.payload.ts);
  assert.deepStrictEqual([m[1], m[7], m[13], m[14], m[15], m[16]], ['BAR Cash-out', 600000, 'Extern cash', 'r1@x', 'night', b2.payload.ts]);
  assert.ok(!findE(env, b2.payload.ts), 'not in Entries');
  assert.strictEqual(env.call({ action: 'pull', token: ayu }).bar[0].amount, 600000);
  const c = push(env, ayu, op('shift_close', { shiftId: id, cashCounted: 100000, expectedCash: 100000 }));
  assert.strictEqual(c.results[0].difference, 0, 'the reception box is unchanged');
});

test('guest_add: a walk-in guest goes to New guest (C and F) once, then shows in the guest list', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const add = name => ({ id: 'ng-' + name + Math.random(), type: 'guest_add', at: new Date().toISOString(), payload: { name } });
  let r = push(env, ayu, add('Maya Walkin'));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  const rows = () => env.book['New guest'].data.filter(x => x[2] === 'Maya Walkin');
  assert.strictEqual(rows().length, 1); assert.strictEqual(rows()[0][5], 'Maya Walkin');
  push(env, ayu, add('  maya   walkin '));
  assert.strictEqual(env.book['New guest'].data.filter(x => String(x[2]).toLowerCase().replace(/\s+/g, ' ').trim() === 'maya walkin').length, 1, 'added only once');
  assert.ok(env.call({ action: 'pull', token: ayu }).guests.includes('Maya Walkin'));
  r = push(env, ayu, add(''));
  assert.strictEqual(r.results[0].status, 'rejected');
});

test('pull with beds24: runs the Beds24 sync first when it is installed, never fails the pull', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  assert.strictEqual(env.call({ action: 'pull', token: ayu, beds24: true }).beds24, null, 'no sync installed: nothing');
});

test('sale writes Seller (T) = author email for commissions; an expense does not', () => {
  const env = freshEnv();
  const t = login(env, 'ayu'); openShift(env, t);
  const s = sale(['Alice Example'], [{ category: 'Tour', object: '-Horse Riding', qty: 1, unit: 400000, unitCost: 350000 }]);
  assert.strictEqual(push(env, t, s).results[0].status, 'applied');
  const row = findE(env, s.payload.lines[0].ts);
  assert.strictEqual(row[19], 'r1@x', 'Seller = the staff email the Commis. formulas compare');
  assert.strictEqual(row[19], row[8]);
  const ex = op('expense', { ts: newTs(), category: 'Other', object: 'Restaurant', amount: 20000, payment: 'Cash', comment: 'x' });
  assert.strictEqual(push(env, t, ex).results[0].status, 'applied', 'expense applied');
  assert.ok(!findE(env, ex.payload.ts)[19], 'no Seller on an expense');
});

test('pull: expense buttons from the sheet (Data activities "Expense buttons"), partner words from "Partner lines"', () => {
  const env = freshEnv();
  const p = env.call({ action: 'pull', token: login(env, 'ayu') });
  assert.deepStrictEqual(p.expenses, [{ object: 'Restaurant', category: 'Other' }, { object: 'Laundry', category: 'Service' }, { object: 'other', category: 'Other' }],
    'in sheet order; an item not listed in L..O is left out (it could not be written)');
  assert.deepStrictEqual(p.partnerLabels, { to: 'Payment to Partner', from: 'Payment From Partner' });
  assert.ok(!p.payments.includes('Payment to Partner') && !p.payments.includes('Payment From Partner'), 'not in the payment picker');
  // Without those columns: no list (the app keeps its own), the usual words.
  const bare = freshEnv(DA.map(r => r.slice(0, 17)));
  const q = bare.call({ action: 'pull', token: login(bare, 'ayu') });
  assert.deepStrictEqual(q.expenses, []);
  assert.deepStrictEqual(q.partnerLabels, { to: 'Payment to Partner', from: 'Payment From Partner' });
});

test('Data activities lists are read to the last row: payment types, expense items, partner products, expense buttons', () => {
  const da = DA.map(r => r.slice());
  const put = (row, col, v) => { while (da.length < row) da.push([]); const r = da[row - 1]; while (r.length < col) r.push(''); r[col - 1] = v; };
  put(30, 17, 'QRIS');                 // Q30: a payment type far below Q20
  put(45, 15, 'Pajak');                // O45: an expense item below row 30
  put(45, 24, 'Pajak');                // X45: and its button
  put(70, 14, '-Far Tour');            // N70: a partner product below row 50
  put(70, 1, '-Far Tour'); put(70, 2, '100,000Rp'); put(70, 3, '60,000Rp');
  const env = freshEnv(da);
  const t = login(env, 'ayu');
  const p = env.call({ action: 'pull', token: t });
  assert.ok(p.payments.includes('QRIS'), JSON.stringify(p.payments));
  assert.deepStrictEqual(p.expenses.map(x => x.object), ['Restaurant', 'Laundry', 'other', 'Pajak']);
  assert.ok(p.partners.items.some(it => it.object === '-Far Tour' && it.group === 'Tour'), 'partner product far down');
  openShift(env, t);
  const ts = newTs();
  assert.strictEqual(push(env, t, op('expense', { ts, object: 'Pajak', amount: 10000, payment: 'QRIS' })).results[0].status, 'applied');
  const r = findE(env, ts);
  assert.deepStrictEqual([r[1], r[2], r[3], r[11], r[13]], ['Expense', 'Other', 'Pajak', 10000, 'QRIS']);
});
