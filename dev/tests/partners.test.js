// Partner bills (old "12." dialogs) against a fake sheet laid out like the real one.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

const tsAt = ms => new Date(ms + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);
const NOW = Date.now();
const T = i => tsAt(NOW - 3 * 86400000 + i * 1000);
const ENTRIES_HEAD = ['Date', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Time stamp', 'month correction', 'Comment', 'Pouchnation time', 'Status', 'Seller'];
const MANUAL_HEAD = ['', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Author', 'Comment', 'Time stamp', 'Seller'];
const DA = [
  ['Activity', 'Selling Price', 'Purchase prices', '', '', '', '', '', '', '', 'Staff', 'Service', 'Transport', 'Tour', 'Other', 'Paid', 'Payment type'],
  ['-Horse Riding', '400,000Rp', '350,000Rp', '', '', '', '', '', '', '', 'Boss', 'Towel', '-Shuttle Bangsal / Kuta', '-Horse Riding', 'Restaurant', '', 'Cash'],
  ['-Shuttle Bangsal / Kuta', '160,000Rp', '90,000Rp', '', '', '', '', '', '', '', '', '-Bike suma', '', '', 'other', '', 'Credit / Debit Card'],
  ['Towel', '50,000Rp', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Transfer/Others'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Unpaid'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Paid to Partner'],
];
const day = new Date(NOW - 3 * 86400000);
// [ts, object, qty, price, cost(K), realCost(L), guest, payment, S, comment, type]
const SALES = [
  [T(1), '-Horse Riding', 2, 800000, 700000, 700000, 'Ann', 'Cash', '', ''],
  [T(2), '-Horse Riding', 1, 400000, 350000, '', 'Ben', 'Paid to Partner', '', ''],
  [T(3), '-Shuttle Bangsal / Kuta', 1, 160000, 90000, 90000, 'Cy', 'Cash', 'B_01/10-10:00', ''],
  [T(4), '-Horse Riding', 1, 400000, 350000, 350000, 'Old', 'Cash', 'Paid', ''],
  [T(5), 'Towel', 1, 50000, 0, 0, 'Dee', 'Cash', '', ''],
];

function freshEnv(da = DA) {
  const entries = [ENTRIES_HEAD], manual = [MANUAL_HEAD];
  for (const [ts, obj, q, price, cost, real, guest, pay, st, comment] of SALES) {
    entries.push([day, 'Income', 'Tour', obj, q, price / q, price, price, 'r2@x', cost / q, cost, real, guest, pay, ts, '', comment, '', st]);
    manual.push([day, 'Income', 'Tour', obj, q, '=f', '=g', price, '', '=j', '=k', real, guest, pay, 'r2@x', comment, ts]);
  }
  entries.push([day, 'Expense', 'Tour', '-Horse Riding', 1, '', '', '', 'r2@x', '', '', 100000, 'Ann', 'Cash', T(6), '', 'Refunding', '', '']);
  for (let i = 0; i < 20; i++) manual.push(['', '', '', '', '', '=f', '=g', '', '', '=j', '=k']);
  const env = makeEnv({ sheets: {
    'Cashouts&Cor': [['Column 1', 'Time ', 'Cashout', 'Difference', 'Cash in box', 'Change suply', 'Author', 'Comment', 'Type'], ['01/11/2026', '15:00:08', 0, 0, 1000000, '', 'r1@x', '', 'Closing']],
    'Entries': entries, 'Entries Manual': manual, 'Data activities': da.map(r => r.slice()),
    '24datafeed': [['Guest Name', 'First Name', 'Full']], 'New guest': [['', '', '', '', '', 'Bob Sample']],
    'Settlements': [['Date', 'Time', 'Author', 'Time stamp', 'Difference', 'Total Settlement MIN 3%', 'Total Card Transaction', 'Total Local Card', 'Comment:', 'TOTAL SETTLEMENT', 'AFTER 3% SETTLEMENT 1', 'AFTER 3% SETTLEMENT 2', 'M', 'N'],
      [day, '14:57:56', 'r1@x', Number(T(0).slice(0, 14) + '000'), 0, 0, 0, '', 'Comment:', 0, 0, 0]],
    'Protect': [['Tabs Locked', 'Auth Base', 'Auth Level 2', 'Auth Level 1', 'Tabs unlock temporary', 'Email Alerts'],
      ['', '', '', '', '', 'script-writer@x.iam.gserviceaccount.com'], ['', '', '', '', '', 'alerts@x'], ['', '', '', '', '', 'manager@x']],
  } });
  env.ctx.UI_setup();
  const users = env.book['UI_Users'];
  users.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw', '', '', '']);
  users.appendRow(['boss', 'Boss', 'manager', 'boss@x', 'pw', '', '', '']);
  return env;
}
const login = (env, u) => env.call({ action: 'login', username: u, password: 'pw', deviceId: 'dev1' }).token;
let n = 0;
const op = (type, payload, at = new Date().toISOString()) => ({ id: 'op' + (++n) + '-' + Math.random(), type, at, payload });
const push = (env, token, ...ops) => env.call({ action: 'push', token, deviceId: 'dev1', ops });
let clock = NOW;
const newTs = () => tsAt(clock = Math.max(Date.now(), clock + 1));
const rowE = (env, ts) => env.book['Entries'].data.find(r => r[14] === ts);
const rowM = (env, ts) => env.book['Entries Manual'].data.find(r => r[16] === ts);
const openShift = (env, token) => assert.strictEqual(push(env, token, op('shift_open', { shiftId: 'S' + (++n), cashCounted: 1000000 })).results[0].status, 'applied');
const BILL = 'B_02/11-10:30';

test('pull lists partner products and their unsettled sales (not paid ones, refunds, or other products)', () => {
  const env = freshEnv();
  const p = env.call({ action: 'pull', token: login(env, 'ayu') }).partners;
  assert.deepStrictEqual(p.items.map(i => i.object).sort(), ['-Bike suma', '-Horse Riding', '-Shuttle Bangsal / Kuta']);
  assert.strictEqual(p.items.find(i => i.object === '-Horse Riding').group, 'Tour');
  assert.deepStrictEqual(p.lines.map(l => [l.guest, l.bill, l.cost]).sort(), [['Ann', '', 700000], ['Ben', '', 350000], ['Cy', 'B_01/10-10:00', 90000]]);
});

test('create a bill: costs and bill id written, emails like the old Create Bill, once even after a failure', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  const b = op('partner_bill', { bill: BILL, items: [{ ts: T(1), cost: 650000 }, { ts: T(2), cost: 350000 }] });
  assert.strictEqual(push(env, ayu, b).results[0].status, 'applied');
  assert.strictEqual(push(env, ayu, b).results[0].status, 'duplicate');
  assert.deepStrictEqual([rowE(env, T(1))[11], rowE(env, T(1))[18]], [650000, BILL]);
  assert.strictEqual(rowM(env, T(1))[11], 650000);
  assert.strictEqual(rowE(env, T(2))[18], BILL);
  assert.strictEqual(env.mails.length, 2);
  const [cost, bill] = env.mails;
  assert.strictEqual(cost.to, 'rabbittree.system.alerts.com@gmail.com');
  assert.match(cost.htmlBody, /700000 → 650000/);
  assert.strictEqual(bill.to, 'r1@x, therabbittreegilimeno@gmail.com');
  assert.match(bill.subject, /^Bill \(-Horse Riding\) - Created by r1@x on /);
  assert.match(bill.attachments[0].data, /Total Invoiced: 600000\.00/); // 650000 + (350000 − 400000)
  assert.strictEqual(push(env, ayu, op('partner_bill', { bill: 'B_02/11-10:31', items: [{ ts: T(1), cost: 1 }] })).results[0].error, 'already_billed');
  assert.strictEqual(push(env, ayu, op('partner_bill', { bill: 'B_01/10-10:00', items: [{ ts: T(5), cost: 1 }] })).results[0].error, 'bad_payload', 'Towel is not a partner product');
});

test('a bill id already used by another bill is refused', () => {
  const env = freshEnv();
  const r = push(env, login(env, 'ayu'), op('partner_bill', { bill: 'B_01/10-10:00', items: [{ ts: T(1), cost: 700000 }] }));
  assert.strictEqual(r.results[0].error, 'bill_exists');
  assert.strictEqual(rowE(env, T(1))[18], '');
});

test('settle: one payment row per partner with the net amount, lines Paid, settlement email; checked against the screen', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  push(env, ayu, op('partner_bill', { bill: BILL, items: [{ ts: T(1), cost: 650000 }, { ts: T(2), cost: 350000 }] }));
  const ts = newTs();
  assert.strictEqual(push(env, ayu, op('partner_settle', { bill: BILL, payment: 'Cash', rows: [{ object: '-Horse Riding', ts, net: 600000 }] })).results[0].error, 'forbidden', 'staff: open shift first');
  openShift(env, ayu);
  assert.strictEqual(push(env, ayu, op('partner_settle', { bill: BILL, payment: 'Cash', rows: [{ object: '-Horse Riding', ts, net: 650000 }] })).results[0].error, 'bill_changed');
  assert.strictEqual(push(env, ayu, op('partner_settle', { bill: BILL, payment: 'Paid to Partner', rows: [{ object: '-Horse Riding', ts, net: 600000 }] })).results[0].error, 'bad_payment');
  const s = op('partner_settle', { bill: BILL, payment: 'Cash', rows: [{ object: '-Horse Riding', ts, net: 600000 }] });
  env.book['Entries'].failNext = 'setValue';
  assert.ok(push(env, ayu, s).partial);
  assert.strictEqual(push(env, ayu, s).results[0].status, 'applied');
  const pay = env.book['Entries'].data.filter(r => r[12] === 'Payment to Partner');
  assert.strictEqual(pay.length, 1);
  assert.deepStrictEqual([pay[0][1], pay[0][2], pay[0][3], pay[0][7], pay[0][8], pay[0][11], pay[0][13], pay[0][14], pay[0][16], pay[0][18]],
    ['Expense', 'Tour', '-Horse Riding', '', 'r1@x', 600000, 'Cash', ts, BILL, 'Settled']);
  const m = rowM(env, ts);
  assert.deepStrictEqual([m[8], m[11], m[12], m[14], m[16]], ['To agent', 600000, 'Payment to Partner', 'r1@x', ts]);
  assert.deepStrictEqual([m[5], m[6], m[9], m[10]], ['=f', '=g', '=j', '=k'], 'formulas kept');
  assert.strictEqual(rowE(env, T(1))[18], 'Paid');
  assert.strictEqual(rowE(env, T(2))[18], 'Paid');
  assert.ok(env.book['New guest'].data.some(r => r[5] === 'Payment to Partner'));
  const settle = env.mails.filter(x => /^BillSettlement/.test(x.subject));
  assert.strictEqual(settle.length, 1);
  assert.strictEqual(settle[0].to, 'r1@x, therabbittreegilimeno@gmail.com, rabbittree.system.alerts.com@gmail.com');
  assert.strictEqual(push(env, ayu, op('partner_bill_delete', { bill: BILL })).results[0].already, true, 'a paid bill has nothing left to delete');
  assert.strictEqual(rowE(env, T(1))[18], 'Paid');
  assert.ok(!env.call({ action: 'pull', token: ayu }).partners.lines.some(l => l.bill === BILL));
});

test('settle: when the partner owes us (guest paid the partner), an Income "Payment From Partner"', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  push(env, boss, op('partner_bill', { bill: BILL, items: [{ ts: T(2), cost: 350000 }] }));
  const ts = newTs();
  assert.strictEqual(push(env, boss, op('partner_settle', { bill: BILL, payment: 'Transfer/Others', rows: [{ object: '-Horse Riding', ts, net: -50000 }] })).results[0].status, 'applied');
  const r = rowE(env, ts);
  assert.deepStrictEqual([r[1], r[7], r[11], r[12], r[13]], ['Income', 50000, '', 'Payment From Partner', 'Transfer/Others']);
  assert.strictEqual(rowM(env, ts)[8], 'From agent');
});

test('delete a bill: lines back to not billed, costs kept', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  assert.strictEqual(push(env, ayu, op('partner_bill_delete', { bill: 'B_01/10-10:00' })).results[0].status, 'applied');
  assert.deepStrictEqual([rowE(env, T(3))[18], rowE(env, T(3))[11]], ['', 90000]);
  assert.strictEqual(push(env, ayu, op('partner_bill_delete', { bill: 'B_01/10-10:00' })).results[0].already, true);
});

test('a settlement paid in cash counts in the shift; a staff member cannot edit her sale once billed', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  openShift(env, ayu); // 1000000 in the box
  const s1 = newTs();
  push(env, ayu, op('sale', { saleId: 'x' + n, payment: 'Cash', lines: [{ ts: s1, guest: 'Eve', object: '-Shuttle Bangsal / Kuta', category: 'Transport', qty: 1, unit: 160000, unitCost: 90000 }] }));
  push(env, ayu, op('partner_bill', { bill: BILL, items: [{ ts: s1, cost: 90000 }] }));
  assert.strictEqual(push(env, ayu, op('line_update', { ts: s1, qty: 2 })).results[0].error, 'forbidden');
  push(env, ayu, op('partner_settle', { bill: BILL, payment: 'Cash', rows: [{ object: '-Shuttle Bangsal / Kuta', ts: newTs(), net: 90000 }] }));
  const id = env.book['UI_Shifts'].data[1][0];
  const c = push(env, ayu, op('shift_close', { shiftId: id, cashCounted: 1070000, expectedCash: 1070000 }, new Date(Date.now() + 1000).toISOString())); // +160000 − 90000
  assert.strictEqual(c.results[0].difference, 0);
});

test('review: a mail failure never blocks the queue; it comes back as a warning', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  env.mailFail.next = true;
  const r = push(env, ayu, op('partner_bill', { bill: BILL, items: [{ ts: T(2), cost: 350000 }] }), op('shift_open', { shiftId: 'Sx', cashCounted: 1000000 }));
  assert.deepStrictEqual(r.results.map(x => x.status), ['applied', 'applied']);
  assert.match(r.results[0].warning, /not sent/);
  assert.strictEqual(Object.keys(env.props).filter(k => /^UI_MAIL_/.test(k)).length, 0, 'mail markers cleaned once logged');
});

test('review: a settle interrupted by Google finishes on retry, without a second payment', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  push(env, ayu, op('partner_bill', { bill: BILL, items: [{ ts: T(1), cost: 650000 }, { ts: T(2), cost: 350000 }] }));
  const s = op('partner_settle', { bill: BILL, payment: 'Cash', rows: [{ object: '-Horse Riding', ts: newTs(), net: 600000 }] });
  env.book['Entries'].failNext = 'setValues'; // Google fails on the first block write of the settlement
  let r = push(env, ayu, s);
  if (!r.partial) assert.fail('expected a partial result');
  r = push(env, ayu, s);
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.strictEqual(env.book['Entries'].data.filter(x => x[12] === 'Payment to Partner').length, 1);
  assert.strictEqual(rowE(env, T(1))[18], 'Paid');
  assert.strictEqual(rowE(env, T(2))[18], 'Paid');
});

test('review: an old bill with a refund copy and a doubled line settles at the amount shown', () => {
  const env = freshEnv();
  const ent = env.book['Entries'];
  const cy = ent.data.find(r => r[14] === T(3));
  ent.appendRow(cy.slice()); // the old sync copied the line twice
  ent.appendRow([day, 'Expense', 'Transport', '-Shuttle Bangsal / Kuta', 1, '', '', '', 'r2@x', '', '', 30000, 'Cy', 'Cash', T(7), '', 'Refund-ing', '', 'B_01/10-10:00']);
  const boss = login(env, 'boss');
  const shown = env.call({ action: 'pull', token: boss }).partners.lines.filter(l => l.bill === 'B_01/10-10:00');
  assert.strictEqual(shown.length, 1);
  const r = push(env, boss, op('partner_settle', { bill: 'B_01/10-10:00', payment: 'Cash', rows: [{ object: '-Shuttle Bangsal / Kuta', ts: newTs(), net: 90000 }] }));
  assert.strictEqual(r.results[0].status, 'applied', JSON.stringify(r));
  assert.ok(ent.data.slice(1).every(x => x[18] !== 'B_01/10-10:00'), 'every row of the old bill marked Paid');
});

test('review: quantity or price of a billed line cannot change', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  push(env, boss, op('partner_bill', { bill: BILL, items: [{ ts: T(1), cost: 650000 }] }));
  assert.strictEqual(push(env, boss, op('line_update', { ts: T(1), qty: 3 })).results[0].error, 'bad_payload');
  assert.strictEqual(push(env, boss, op('line_update', { ts: T(1), comment: 'ok' })).results[0].status, 'applied');
});

test('review: a bill being paid (payment written, lines not yet Paid) cannot be deleted', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  push(env, boss, op('partner_bill', { bill: BILL, items: [{ ts: T(1), cost: 650000 }] }));
  const ent = env.book['Entries'];
  ent.appendRow([day, 'Expense', 'Tour', '-Horse Riding', '', '', '', '', 'boss@x', '', '', 650000, 'Payment to Partner', 'Cash', newTs(), '', BILL, '', 'Settled']);
  assert.strictEqual(push(env, boss, op('partner_bill_delete', { bill: BILL })).results[0].error, 'bill_paid');
});

// ---------------------------------------------------------------- card terminal (step 3e)
const cid = () => 'C' + (++n) + 'abcdefg';
test('card settlement: compared with card payments since the last one, written like the old Settlements row', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu'); openShift(env, ayu);
  const pull = env.call({ action: 'pull', token: ayu });
  assert.strictEqual(pull.settlement.ts, T(0).slice(0, 14) + '000');
  // Card since then: a 300000 card sale and a 20000 card expense.
  push(env, ayu, op('sale', { saleId: 'c1', payment: 'Credit / Debit Card', lines: [{ ts: newTs(), guest: 'Zed', object: 'Towel', category: 'Service', qty: 1, unit: 300000, unitCost: 0 }] }));
  push(env, ayu, op('expense', { ts: newTs(), object: 'Restaurant', amount: 20000, payment: 'Credit / Debit Card', comment: '' }));
  const c = op('card_settlement', { cid: cid(), s1: 288000, s2: 0, local: 0, comment: 'TEST', cardTotal: 280000 });
  env.mailFail.next = true;
  const r = push(env, ayu, c).results[0];
  assert.strictEqual(r.status, 'applied', JSON.stringify(r));
  assert.match(r.warning, /not sent/);
  const row = env.book['Settlements'].data[2];
  assert.strictEqual(row[2], 'r1@x');
  assert.strictEqual(String(row[3]).length, 17);
  assert.strictEqual(row[6], 280000);                     // G card total of the sheet
  assert.strictEqual(Math.round(row[5]), Math.round(288000 * 0.970875)); // F settlement minus fee
  assert.strictEqual(Math.round(row[4]), Math.round(280000 - 288000 * 0.970875));
  assert.match(row[8], /^TEST \[C/);
  assert.deepStrictEqual([row[9], row[10], row[11], row[12], row[13]], [288000, 288000, 0, 288000 * 0.978, '']);
  assert.strictEqual(push(env, ayu, c).results[0].status, 'duplicate');
  assert.strictEqual(env.call({ action: 'pull', token: ayu }).settlement.ts.slice(0, 12), row[3].toFixed(0).slice(0, 12));
});

test('card settlement: a big difference is alerted to the Protect list; staff need their shift', () => {
  const env = freshEnv();
  const ayu = login(env, 'ayu');
  assert.strictEqual(push(env, ayu, op('card_settlement', { cid: cid(), s1: 100000 })).results[0].error, 'forbidden');
  openShift(env, ayu);
  const r = push(env, ayu, op('card_settlement', { cid: cid(), s1: 100000, comment: '', cardTotal: 0 })).results[0];
  assert.strictEqual(r.status, 'applied');
  const alert = env.mails.find(m => /^Attention! Settlement/.test(m.subject));
  assert.ok(alert);
  assert.strictEqual(alert.to, 'alerts@x, manager@x');
  assert.match(env.book['Settlements'].data[2][8], /^Comment: \(screen showed 0\)|^Comment: \[C/);
});

test('review: settlement window to the second; refused if out of order or without a previous one', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  const ent = env.book['Entries'];
  const prev = T(0).slice(0, 14);
  // A card sale in the very second of the previous settlement belongs to it, not to the next one.
  ent.appendRow([day, 'Income', 'Service', 'Towel', 1, 1000, 1000, 1000, 'r2@x', '', '', '', 'Q', 'Credit / Debit Card', prev + '500', '', '']);
  const r = push(env, boss, op('card_settlement', { cid: cid(), s1: 0 })).results[0];
  assert.strictEqual(r.cardTotal, 0);
  assert.strictEqual(push(env, boss, op('card_settlement', { cid: cid(), s1: 0 }, new Date(Date.now() - 3600000).toISOString())).results[0].error, 'settlement_order');
  env.book['Settlements'].data.push(['', '', '', 'notes']);
  assert.strictEqual(push(env, boss, op('card_settlement', { cid: cid(), s1: 0 })).results[0].error, 'no_settlement');
});

test('S15: settling a bill writes column S only on the rows of that bill', () => {
  const env = freshEnv();
  const boss = login(env, 'boss');
  push(env, boss, op('partner_bill', { bill: BILL, items: [{ ts: T(1), cost: 650000 }, { ts: T(2), cost: 350000 }] }));
  const E = env.book['Entries'], writes = [];
  const set = E.set.bind(E);
  E.set = (r, c, v) => { if (c === 19) writes.push(r); return set(r, c, v); };
  const ts = newTs();
  assert.strictEqual(push(env, boss, op('partner_settle', { bill: BILL, payment: 'Cash', rows: [{ object: '-Horse Riding', ts, net: 600000 }] })).results[0].status, 'applied');
  const rowNo = t => E.data.findIndex(r => r[14] === t) + 1;
  assert.deepStrictEqual(writes.sort((a, b) => a - b), [rowNo(T(1)), rowNo(T(2)), rowNo(ts)].sort((a, b) => a - b));
  assert.strictEqual(rowE(env, T(3))[18], 'B_01/10-10:00', 'other bill untouched');
});

test('settle: the words of Entries M come from Data activities "Partner lines" (W2 we pay, W3 they pay); old words still count as payment rows', () => {
  const da = DA.map(r => r.slice());
  const put = (row, col, v) => { const r = da[row - 1]; while (r.length < col) r.push(''); r[col - 1] = v; };
  put(1, 23, 'Partner lines'); put(2, 23, 'Paid to partner (bill)'); put(3, 23, 'Received from partner (bill)');
  const env = freshEnv(da);
  const boss = login(env, 'boss');
  assert.deepStrictEqual(env.call({ action: 'pull', token: boss }).partnerLabels, { to: 'Paid to partner (bill)', from: 'Received from partner (bill)' });
  push(env, boss, op('partner_bill', { bill: BILL, items: [{ ts: T(1), cost: 650000 }] }));
  const ts = newTs();
  assert.strictEqual(push(env, boss, op('partner_settle', { bill: BILL, payment: 'Cash', rows: [{ object: '-Horse Riding', ts, net: 650000 }] })).results[0].status, 'applied');
  assert.strictEqual(rowE(env, ts)[12], 'Paid to partner (bill)');
  assert.strictEqual(rowM(env, ts)[12], 'Paid to partner (bill)');
  assert.ok(env.book['New guest'].data.some(r => r[5] === 'Paid to partner (bill)'));
  // An Income row written with the old words before the rename is still not a sale to bill.
  env.book['Entries'].appendRow([day, 'Income', 'Tour', '-Horse Riding', '', '', '', 50000, 'boss@x', '', '', '', 'Payment From Partner', 'Cash', newTs(), '', 'B_02/10-10:00', '', 'Settled']);
  env.book['Entries'].appendRow([day, 'Income', 'Tour', '-Horse Riding', '', '', '', 50000, 'boss@x', '', '', '', 'Received from partner (bill)', 'Cash', newTs(), '', 'B_02/10-10:00', '', '']);
  const lines = env.call({ action: 'pull', token: boss }).partners.lines;
  assert.ok(!lines.some(l => l.guest === 'Payment From Partner' || l.guest === 'Received from partner (bill)'), JSON.stringify(lines));
});
