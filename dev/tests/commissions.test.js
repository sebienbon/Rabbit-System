// Commissions summary + seller change, and the Tour / Transport activities editor, against a
// fake sheet laid out like the live one (Data activities A..X, Entries A..T, Entries Manual A..R).
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

const tsAt = ms => new Date(ms + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const NOW = Date.now();
const ts = k => tsAt(NOW - 3 * 86400000 + k * 1000);

const ENTRIES_HEAD = ['Date', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Time stamp', 'month correction', 'Comment', 'Pouchnation time', 'Status', 'Seller'];
const MANUAL_HEAD = ['', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Author', 'Comment', 'Time stamp', 'Seller'];
const DA_HEAD = ['Activity', 'Selling Price', 'Purchase prices', '', '', '', '', '', 'Category', 'Sub-category - Income', 'Staff', 'Service', 'Transport', 'Tour', 'Other', 'Paid', 'Payment type',
  'Commission', 'Rooms', 'Payment type2', 'Room Ids', 'Commission exceptions', 'Partner lines', 'Expense buttons'];
// Like the live tab: N has a gap (row 6), M lists one shuttle twice, A lists Laundry twice.
const DA = [
  DA_HEAD,
  ['Snorkeling Mask', 30000, '', '', '', '', '', '', 'Income', 'Room', 'Boss', 'Snorkeling Mask', '-Shuttle Bangsal / Kuta', '-Horse Riding', 'Rooms', 'To agent', 'Cash', 'Boss', 'Double', 'Cash', 353330, '-Gili T Night Boat', 'Payment to Partner', 'Restaurant'],
  ['Towel', 50000, '', '', '', '', '', '', 'Expense', 'Bar', 'Food', 'Towel', '-Shuttle Senggigi', '-Snorkeling Trip', 'Restaurant', 'From agent', 'Credit / Debit Card', 'Banu', 'Tree House', 'Credit / Debit Card', 460595, '', 'Payment From Partner', 'Bar'],
  ['Laundry', 30000, '', '', '', '', '', '', '', '', '', 'Laundry', '-Taxi Airport', '-Gili T Night Boat', 'other', '', 'Transfer/Others'],
  ['-Horse Riding', 400000, 350000, '', '', '', '', '', '', '', '', '-Bike suma', '-Shuttle Senggigi', '-Sunset Boat', '', '', 'Unpaid'],
  ['-Shuttle Bangsal / Kuta', 160000, 90000, '', '', '', '', '', '', '', '', '', '', '', '', '', 'Paid to Partner'],
  ['-Snorkeling Trip', 150000, 100000, '', '', '', '', '', '', '', '', '', '', '-Komodo'],
  ['-Shuttle Senggigi', 115000, 50000],
  ['-Taxi Airport', 500000, 350000],
  ['-Gili T Night Boat', 170000, 100000],
  ['-Sunset Boat', 250000, 80000],
  ['-Bike suma', 50000, 35000],
  ['Laundry', 30000],
  ['-Komodo', 3700000, 'To complete'],
];

function entry(k, obj, price, cost, seller, extra = {}) {
  const r = [new Date(NOW - 3 * 86400000), 'Income', /Shuttle|Taxi/.test(obj) ? 'Transport' : 'Tour', obj, 1, price, price, price, 'r1@x', cost, cost, cost,
    extra.guest || 'Guest ' + k, 'Cash', ts(k), extra.past || '', extra.comment || '', '', extra.status || '', seller];
  if (extra.noReal) { r[7] = ''; r[11] = ''; }
  return r;
}
function freshEnv({ da = DA } = {}) {
  const entries = [ENTRIES_HEAD,
    entry(1, '-Horse Riding', 400000, 350000, 'r1@x'),                                   // 10 000
    entry(2, '-Snorkeling Trip', 150000, 100000, 'r1@x', { noReal: true }),                // G and K: 10 000
    entry(3, '-Gili T Night Boat', 170000, 100000, 'r1@x'),                                // commission exception
    entry(4, '-Horse Riding', 400000, 350000, 'r1@x', { past: 'Past' }),                   // last period
    entry(5, '-Shuttle Bangsal / Kuta', 90000, 0, 'r1@x', { guest: 'Payment to Partner', status: 'Settled' }), // partner payment row
    entry(6, 'Towel', 50000, 0, 'r1@x'),                                                    // counts, cannot move (not a "-" product)
    entry(7, '-Sunset Boat', 250000, 80000, 'r1@x'),                                        // counts, never moved by the old dialog
    entry(8, '-Taxi Airport', 500000, 350000, 'r2@x'),                                      // Dewa's
    entry(9, '-Horse Riding', 400000, 350000, 'r1@x', { comment: 'Refunded' }),
    entry(10, '-Horse Riding', 400000, 350000, 'Paid'),                                     // junk in T: not a seller
  ];
  const manual = [MANUAL_HEAD, ...entries.slice(1).map(e => [e[0], e[1], e[2], e[3], e[4], '=f', '=g', e[7], '', '=j', '=k', e[11], e[12], e[13], e[8], e[16], e[14], e[19]])];
  const env = makeEnv({ sheets: {
    'Cashouts&Cor': [['Column 1', 'Time ', 'Cashout', 'Difference', 'Cash in box', 'Change suply', 'Author', 'Comment', 'Type'], ['01/11/2026', '15:00:08', 0, 0, 100000, '', 'r1@x', '', 'Closing']],
    'Entries': entries,
    'Entries Manual': manual,
    'Data activities': da.map(r => r.slice()),
    'Protect': [['Tabs Locked', 'Auth Base'], ['Entries', 'owner@x'], ['', 'r1@x']],
    '24datafeed': [['Guest Name', 'First Name', 'Full'], ['E', 'A', 'Alice Example']],
    'New guest': [['', '', '', '', '', 'Bob Sample']],
  } });
  env.ctx.UI_setup();
  const users = env.book['UI_Users'];
  users.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw', '', '', '']);
  users.appendRow(['dewa', 'Dewa', 'staff', 'r2@x', 'pw', '', '', '']);
  users.appendRow(['boss', 'Boss', 'manager', 'boss@x', 'pw', '', '', '']);
  users.appendRow(['old', 'Old', 'staff', 'old@x', 'pw', '', '', false]);
  users.appendRow(['made', 'Made', 'gear', 'made@x', 'pw', '', '', '']);
  return env;
}
const login = (env, u) => env.call({ action: 'login', username: u, password: 'pw', deviceId: 'dev1' }).token;
let n = 0;
const op = (type, payload, at = new Date().toISOString()) => ({ id: 'op' + (++n) + '-' + Math.random(), type, at, payload });
const push = (env, token, ...ops) => env.call({ action: 'push', token, deviceId: 'dev1', ops });
const one = (env, token, type, payload) => push(env, token, op(type, payload)).results[0];
const rowE = (env, k) => env.book['Entries'].data.find(r => r[14] === ts(k));
const rowM = (env, k) => env.book['Entries Manual'].data.find(r => r[16] === ts(k));
const col = (env, c) => env.book['Data activities'].data.slice(1).map(r => r[c - 1] === undefined ? '' : r[c - 1]);
const lastLog = env => env.book['UI_Log'].data[env.book['UI_Log'].data.length - 1];

// ------------------------------------------------------------------ commissions
test('pull: features, and my commission lines of the period as Commis. counts them', () => {
  const env = freshEnv();
  const p = env.call({ action: 'pull', token: login(env, 'ayu') });
  assert.deepStrictEqual(p.features, ['commissions', 'catalog_edit']);
  const c = p.commissions;
  assert.strictEqual(c.rate, 0.2); assert.strictEqual(c.all, false);
  const byTs = Object.fromEntries(c.lines.map(l => [l.ts, l]));
  assert.deepStrictEqual(Object.keys(byTs).sort(), [ts(1), ts(2), ts(6), ts(7), ts(9)].sort(),
    'not the exception, not Past, not the partner payment row, not Dewa\'s, not junk in T');
  assert.strictEqual(byTs[ts(1)].amount, 10000);
  assert.strictEqual(byTs[ts(2)].amount, 10000, 'G and K when H and L are empty');
  assert.strictEqual(byTs[ts(6)].amount, 10000);
  assert.deepStrictEqual(c.lines.filter(l => l.canMove).map(l => l.ts), [ts(1), ts(2)], 'old dialog rule: "-" product, not Sunset Boat, not refunded');
  assert.deepStrictEqual(c.staff.map(s => s.email), ['r1@x', 'r2@x', 'boss@x'], 'active, not gear');
  const m = env.call({ action: 'pull', token: login(env, 'boss') }).commissions;
  assert.strictEqual(m.all, true);
  assert.ok(m.lines.some(l => l.ts === ts(8) && l.seller === 'r2@x'), 'a manager sees every seller');
});

test('pull: exceptions come from the whole "Commission exceptions" column, found by its header', () => {
  const da = DA.map(r => r.slice());
  // V moved to Z, and an exception far down.
  da.forEach(r => { while (r.length < 26) r.push(''); r[25] = r[21]; r[21] = ''; });
  da[0][21] = 'Other header'; da[0][25] = 'Commission exceptions';
  while (da.length < 60) da.push([]);
  da[59][25] = '-Horse Riding';
  const env = freshEnv({ da });
  const c = env.call({ action: 'pull', token: login(env, 'ayu') }).commissions;
  assert.ok(!c.lines.some(l => l.object === '-Horse Riding' || l.object === '-Gili T Night Boat'), JSON.stringify(c.lines.map(l => l.object)));
});

test('seller_change: staff give their own line to a colleague; T and Entries Manual R change, logged, emailed, idempotent', () => {
  const env = freshEnv();
  const t = login(env, 'ayu');
  const o = op('seller_change', { ts: ts(1), from: 'r1@x', to: 'r2@x' });
  const r = push(env, t, o).results[0];
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
  assert.strictEqual(rowE(env, 1)[19], 'r2@x');
  assert.strictEqual(rowM(env, 1)[17], 'r2@x');
  const log = lastLog(env);
  assert.strictEqual(log[4], 'seller_change'); assert.strictEqual(log[5], ts(1));
  assert.deepStrictEqual(JSON.parse(log[8]).audit, { before: 'r1@x', after: 'r2@x', object: '-Horse Riding', guest: 'Guest 1' });
  assert.strictEqual(env.mails.length, 1); assert.strictEqual(env.mails[0].subject, 'Seller Modified');
  assert.strictEqual(env.mails[0].to, 'owner@x, r1@x', 'old dialog recipients: Protect B2:B10');
  // Same op again (lost answer): duplicate, nothing more written or sent.
  assert.strictEqual(push(env, t, o).results[0].status, 'duplicate');
  // Sent twice from the device (new id): already done.
  const again = one(env, t, 'seller_change', { ts: ts(1), from: 'r1@x', to: 'r2@x' });
  assert.strictEqual(again.status, 'applied'); assert.strictEqual(again.already, true);
  assert.strictEqual(env.mails.length, 1);
  // Now Dewa's: Ayu can no longer move it back.
  const back = one(env, t, 'seller_change', { ts: ts(1), from: 'r2@x', to: 'r1@x' });
  assert.strictEqual(back.status, 'rejected'); assert.strictEqual(back.error, 'forbidden');
  assert.ok(env.call({ action: 'pull', token: login(env, 'dewa') }).commissions.lines.some(l => l.ts === ts(1)), 'in Dewa\'s summary');
});

test('seller_change: refusals (not eligible, other seller, stale view, unknown or disabled target); managers move any line', () => {
  const env = freshEnv();
  const t = login(env, 'ayu');
  const ref = (k, to = 'r2@x', from = 'r1@x', tok = t) => one(env, tok, 'seller_change', { ts: ts(k), from, to });
  for (const k of [3, 4, 5, 6, 7, 9]) { const r = ref(k); assert.strictEqual(r.status, 'rejected', 'line ' + k); assert.strictEqual(r.error, 'not_eligible', 'line ' + k + ' ' + r.message); }
  assert.strictEqual(ref(8, 'r1@x', 'r2@x').error, 'forbidden', 'a colleague\'s line');
  assert.strictEqual(ref(1, 'r2@x', 'boss@x').error, 'changed', 'the device saw another seller');
  assert.strictEqual(ref(1, 'nobody@x').error, 'bad_payload');
  assert.strictEqual(ref(1, 'old@x').error, 'bad_payload', 'disabled user');
  assert.strictEqual(ref(1, 'made@x').error, 'bad_payload', 'gear account');
  assert.strictEqual(one(env, t, 'seller_change', { ts: '2026', from: 'r1@x', to: 'r2@x' }).error, 'bad_payload');
  assert.strictEqual(rowE(env, 1)[19], 'r1@x', 'nothing written');
  const b = login(env, 'boss');
  assert.strictEqual(ref(8, 'r1@x', 'r2@x', b).status, 'applied');
  assert.strictEqual(rowE(env, 8)[19], 'r1@x');
  assert.strictEqual(ref(3, 'r2@x', 'r1@x', b).error, 'not_eligible', 'exceptions hold for managers too');
  const g = login(env, 'made');
  assert.strictEqual(ref(2, 'r2@x', 'r1@x', g).error, 'forbidden', 'gear account');
});

test('seller_change: a missing "Commission exceptions" column is created (header in row 1)', () => {
  const da = DA.map(r => r.slice(0, 21));
  const env = freshEnv({ da });
  assert.strictEqual(one(env, login(env, 'ayu'), 'seller_change', { ts: ts(3), from: 'r1@x', to: 'r2@x' }).status, 'applied', 'no exception list: Gili T counts');
  assert.ok(env.book['Data activities'].data[0].includes('Commission exceptions'));
});

// ------------------------------------------------------------------ activities editor
const A = 1, B = 2, C = 3, M_ = 13, N_ = 14;
test('pull: Tour and Transport activities with price and cost from A..C', () => {
  const env = freshEnv();
  const acts = env.call({ action: 'pull', token: login(env, 'ayu') }).activities;
  assert.deepStrictEqual(acts.filter(a => a.category === 'Tour').map(a => a.name), ['-Horse Riding', '-Snorkeling Trip', '-Gili T Night Boat', '-Sunset Boat', '-Komodo']);
  assert.deepStrictEqual(acts.filter(a => a.category === 'Transport').map(a => a.name), ['-Shuttle Bangsal / Kuta', '-Shuttle Senggigi', '-Taxi Airport'], 'listed twice: once');
  const k = acts.find(a => a.name === '-Komodo');
  assert.deepStrictEqual([k.price, k.cost, k.costText, k.inA], [3700000, null, 'To complete', true]);
});

test('activity add: column A (name, price, cost) and the Tour list, formats copied from the row above; catalog follows; retry', () => {
  const env = freshEnv();
  const t = login(env, 'dewa'); // any reception user
  const before = env.book['Data activities'].data.map(r => r.slice());
  const o = op('activity', { do: 'add', category: 'Tour', name: 'Waterfall Trip', price: '450.000', cost: 300000 });
  const r = push(env, t, o).results[0];
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
  const d = env.book['Data activities'].data;
  assert.deepStrictEqual(d[14].slice(0, 3), ['-Waterfall Trip', 450000, 300000], 'A15:C15, after the last row of A, "-" added');
  assert.strictEqual(d[7][N_ - 1], '-Waterfall Trip', 'N8: right after the last value of N');
  // Nothing else moved.
  before.forEach((row, i) => row.forEach((v, j) => { if (!(i === 14 && j < 3) && !(i === 7 && j === N_ - 1)) assert.deepStrictEqual(d[i][j] ?? '', v ?? '', `cell ${i + 1},${j + 1}`); }));
  const copies = env.book['Data activities'].copies;
  assert.deepStrictEqual(copies.map(c => [c.from, c.to, c.type]), [[[14, 1, 1, 3], [15, 1, 1, 3], 'PASTE_FORMAT'], [[7, 14, 1, 1], [8, 14, 1, 1], 'PASTE_FORMAT']]);
  const log = lastLog(env);
  assert.strictEqual(log[4], 'activity'); assert.strictEqual(log[5], 'Waterfall Trip');
  assert.deepStrictEqual(JSON.parse(log[8]).audit.after, { category: 'Tour', name: '-Waterfall Trip', price: 450000, cost: 300000 });
  const cat = env.call({ action: 'pull', token: t }).catalog;
  assert.ok(cat.some(p => p.name === '-Waterfall Trip' && p.category === 'Tour' && p.price === 450000 && p.cost === 300000));
  // Retries: same op id → duplicate; a new id with the same values → already; other values → refused.
  assert.strictEqual(push(env, t, o).results[0].status, 'duplicate');
  assert.strictEqual(one(env, t, 'activity', { do: 'add', category: 'Tour', name: '-Waterfall Trip', price: 450000, cost: 300000 }).already, true);
  assert.strictEqual(one(env, t, 'activity', { do: 'add', category: 'Tour', name: 'Waterfall Trip', price: 1, cost: 1 }).error, 'exists');
  assert.strictEqual(one(env, t, 'activity', { do: 'add', category: 'Transport', name: 'Horse Riding', price: 1 }).error, 'exists', 'listed under Tour');
  assert.strictEqual(d.filter(r => r[0] === '-Waterfall Trip').length, 1);
  assert.strictEqual(one(env, t, 'activity', { do: 'add', category: 'Service', name: 'x', price: 1 }).error, 'bad_payload', 'only Tour and Transport');
  assert.strictEqual(one(env, t, 'activity', { do: 'add', category: 'Tour', name: '=HACK()', price: 1 }).error, 'bad_payload');
  assert.strictEqual(one(env, t, 'activity', { do: 'add', category: 'Tour', name: 'Free', price: '' }).error, 'bad_amount');
});

test('activity update: price and cost in A only; a rename changes A and the list cells (every copy) and nothing else', () => {
  const env = freshEnv();
  const t = login(env, 'ayu');
  const snap = () => env.book['Data activities'].data.map(r => r.slice());
  let before = snap();
  assert.strictEqual(one(env, t, 'activity', { do: 'update', category: 'Tour', name: '-Horse Riding', price: 420000, cost: 360000 }).status, 'applied');
  let d = env.book['Data activities'].data;
  assert.deepStrictEqual(d[4].slice(0, 3), ['-Horse Riding', 420000, 360000]);
  before.forEach((row, i) => row.forEach((v, j) => { if (!(i === 4 && j < 3)) assert.deepStrictEqual(d[i][j] ?? '', v ?? '', `cell ${i + 1},${j + 1}`); }));
  assert.deepStrictEqual(JSON.parse(lastLog(env)[8]).audit.before, { name: '-Horse Riding', price: 400000, cost: 350000 }, 'old values logged');
  // Rename a transport listed twice in M.
  before = snap();
  const o = op('activity', { do: 'update', category: 'Transport', name: '-Shuttle Senggigi', newName: 'Shuttle Senggigi / Mataram', price: 115000, cost: '' });
  assert.strictEqual(push(env, t, o).results[0].status, 'applied');
  d = env.book['Data activities'].data;
  const changed = [[7, 0], [7, 1], [7, 2], [2, M_ - 1], [4, M_ - 1]];
  assert.deepStrictEqual(d[7].slice(0, 3), ['-Shuttle Senggigi / Mataram', 115000, '']);
  assert.strictEqual(d[2][M_ - 1], '-Shuttle Senggigi / Mataram'); assert.strictEqual(d[4][M_ - 1], '-Shuttle Senggigi / Mataram');
  before.forEach((row, i) => row.forEach((v, j) => { if (!changed.some(([a, b]) => a === i && b === j)) assert.deepStrictEqual(d[i][j] ?? '', v ?? '', `cell ${i + 1},${j + 1}`); }));
  // Retry with a new id after it went through: already.
  assert.strictEqual(one(env, t, 'activity', { do: 'update', category: 'Transport', name: '-Shuttle Senggigi', newName: 'Shuttle Senggigi / Mataram', price: 115000, cost: '' }).already, true);
  assert.strictEqual(one(env, t, 'activity', { do: 'update', category: 'Tour', name: '-Snorkeling Trip', newName: 'Horse Riding', price: 1 }).error, 'exists');
  assert.strictEqual(one(env, t, 'activity', { do: 'update', category: 'Tour', name: '-Nope', price: 1 }).error, 'not_found');
  // Renaming a commission exception warns (V keeps the old name).
  const w = one(env, t, 'activity', { do: 'update', category: 'Tour', name: '-Gili T Night Boat', newName: 'Gili T Night Boat (new)', price: 170000, cost: 100000 });
  assert.strictEqual(w.status, 'applied'); assert.match(w.warning, /Commission exceptions/);
  assert.strictEqual(col(env, 22)[0], '-Gili T Night Boat');
  const cat = env.call({ action: 'pull', token: t }).catalog;
  assert.ok(cat.some(p => p.name === '-Shuttle Senggigi / Mataram' && p.price === 115000) && !cat.some(p => p.name === '-Shuttle Senggigi'));
});

test('activity delete: out of the list and of A..C, compacted inside those columns only; kept in A while another list has it', () => {
  const env = freshEnv();
  const t = login(env, 'ayu');
  const before = env.book['Data activities'].data.map(r => r.slice());
  const o = op('activity', { do: 'delete', category: 'Tour', name: '-Snorkeling Trip' });
  assert.strictEqual(push(env, t, o).results[0].status, 'applied');
  assert.deepStrictEqual(col(env, N_).slice(0, 6), ['-Horse Riding', '-Gili T Night Boat', '-Sunset Boat', '', '-Komodo', ''], 'moved up one, the gap kept');
  assert.deepStrictEqual(col(env, A).slice(0, 13), ['Snorkeling Mask', 'Towel', 'Laundry', '-Horse Riding', '-Shuttle Bangsal / Kuta', '-Shuttle Senggigi', '-Taxi Airport',
    '-Gili T Night Boat', '-Sunset Boat', '-Bike suma', 'Laundry', '-Komodo', '']);
  assert.deepStrictEqual(col(env, B).slice(5, 7), [115000, 500000], 'prices moved with their names');
  // Every other column is exactly as before.
  const d = env.book['Data activities'].data;
  before.forEach((row, i) => row.forEach((v, j) => { if (j > 2 && j !== N_ - 1) assert.deepStrictEqual(d[i][j] ?? '', v ?? '', `cell ${i + 1},${j + 1}`); }));
  assert.deepStrictEqual(JSON.parse(lastLog(env)[8]).audit.before, { category: 'Tour', name: '-Snorkeling Trip', price: 150000, cost: 100000 });
  assert.ok(!env.call({ action: 'pull', token: t }).catalog.some(p => p.name === '-Snorkeling Trip'));
  assert.strictEqual(push(env, t, o).results[0].status, 'duplicate');
  assert.strictEqual(one(env, t, 'activity', { do: 'delete', category: 'Tour', name: '-Snorkeling Trip' }).already, true);
  // -Bike suma is under Service too: deleting a Tour copy keeps A. Put it in N first.
  assert.strictEqual(one(env, t, 'activity', { do: 'add', category: 'Transport', name: '-Bike suma', price: 50000, cost: 35000 }).error, 'exists');
});

test('activity delete keeps A when the name is still in another list; refuses a list with formulas', () => {
  const da = DA.map(r => r.slice());
  da[5][N_ - 1] = '-Bike suma'; // N6 (the gap): also listed as a Tour
  const env = freshEnv({ da });
  const t = login(env, 'ayu');
  assert.strictEqual(one(env, t, 'activity', { do: 'delete', category: 'Tour', name: '-Bike suma' }).status, 'applied');
  assert.ok(!col(env, N_).includes('-Bike suma'));
  assert.ok(col(env, A).includes('-Bike suma') && col(env, 12).includes('-Bike suma'), 'still a Service: A keeps it');
  const db = DA.map(r => r.slice()); db[10][N_ - 1] = '=A1';
  const e2 = freshEnv({ da: db });
  const r = one(e2, login(e2, 'ayu'), 'activity', { do: 'delete', category: 'Tour', name: '-Horse Riding' });
  assert.strictEqual(r.error, 'bad_sheet');
  assert.strictEqual(col(e2, N_)[0], '-Horse Riding');
});
