// Client logic (js/gearcore.js, js/ledger.js, js/db.js, js/sync.js) without a browser.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const js = f => import(pathToFileURL(path.join(__dirname, '..', '..', 'js', f)).href);
const W = s => Date.parse(s + '+08:00'); // reception time (WITA)
const iso = s => new Date(W(s)).toISOString();
const op = (type, payload, at, pending = true) => ({ op: { id: 'D1-' + Math.random().toString(36).slice(2), type, at: iso(at), by: 'ayu', payload }, pending });
const item = (id, x = {}) => ({ id, kind: id.startsWith('B') ? 'bike' : 'mask', where: 'in', condition: 'OK', last: null, back: null, ...x });
const rental = (id, guest, from, back, saleTs = '20261101100000000') => item(id, { where: 'out', back: iso(back), last: { kind: 'rental', guest, from: iso(from), saleTs } });
const snap = (items, x = {}) => ({ items, diffs: [], damages: [], trips: [], product: { mask: 'Snorkeling Mask', bike: 'Rabbit bike' }, ...x });

test('extension: only evening checks after the return time, one per day', async () => {
  const { extensionDays } = await js('gearcore.js');
  const back = iso('2026-11-03T18:00:00');
  // Back at 20:00 before the check: nothing to charge, even if the check comes later that night.
  assert.strictEqual(extensionDays(back, [iso('2026-11-03T20:30:00')], W('2026-11-03T20:00:00')), 0);
  // Still out at the 20:30 check: one day.
  assert.strictEqual(extensionDays(back, [iso('2026-11-03T20:30:00')], W('2026-11-03T22:00:00')), 1);
  // Two checks the same evening count once; a check before `back` never counts.
  assert.strictEqual(extensionDays(back, [iso('2026-11-02T20:00:00'), iso('2026-11-03T20:05:00'), iso('2026-11-03T21:00:00'), iso('2026-11-04T20:00:00')], W('2026-11-05T09:00:00')), 2);
  // No check at all: overdue, but nothing billable.
  assert.strictEqual(extensionDays(back, [], W('2026-11-06T09:00:00')), 0);
  assert.strictEqual(extensionDays(null, [iso('2026-11-04T20:00:00')]), 0);
});

test('daysLate: sheet counts, sheet lateDays, or this device\'s own checks', async () => {
  const { daysLate, applyGearOps } = await js('gearcore.js');
  const it = rental('SG001', 'Ann', '2026-11-02T13:00:00', '2026-11-03T18:00:00');
  const now = W('2026-11-05T10:00:00');
  assert.strictEqual(daysLate(it, { counts: [iso('2026-11-03T20:00:00'), iso('2026-11-04T20:00:00')] }, now), 2);
  assert.strictEqual(daysLate({ ...it, lateDays: 1 }, { lastCount: { at: iso('2026-11-03T20:00:00') } }, now), 1);
  // A check done on this device, not yet in the copy, adds its day.
  const g = applyGearOps(snap([{ ...it, lateDays: 1 }], { lastCount: { at: iso('2026-11-03T20:00:00') } }), [op('gear_count', { cid: 'Kx', items: [] }, '2026-11-04T20:10:00')]);
  assert.strictEqual(daysLate(g.items[0], g, now), 2);
  // Without anything from the sheet: only the local checks.
  assert.strictEqual(daysLate(it, applyGearOps(snap([it]), [op('gear_count', { cid: 'Ky', items: [] }, '2026-11-03T20:10:00')]), now), 1);
  assert.strictEqual(daysLate(it, snap([it]), now), 0, 'overdue without a check is not late');
  // Volunteer and Sunset Boat are never charged.
  assert.strictEqual(daysLate({ ...it, last: { ...it.last, kind: 'volunteer' } }, { counts: [iso('2026-11-04T20:00:00')] }, now), 0);
});

test('sale of a number already out: returned first (resold), then out for the new guest', async () => {
  const { applyGearOps } = await js('gearcore.js');
  const s = snap([rental('SG001', 'Ann', '2026-11-02T13:00:00', '2026-11-03T18:00:00'), item('SG002', { where: 'sunset', last: { kind: 'sunset', guest: 'Sunset Boat', from: iso('2026-11-04T16:00:00') } })]);
  const g = applyGearOps(s, [op('sale', { payment: 'Cash', lines: [
    { ts: '20261104170000000', guest: 'Bob', object: 'Snorkeling Mask', qty: 2, unit: 30000, gear: 'SG001' },
    { ts: '20261104170000001', guest: 'Bob', object: 'Snorkeling Mask', qty: 1, unit: 30000, gear: 'sg002' }] }, '2026-11-04T17:00:00')]);
  const [a, b] = g.items;
  assert.strictEqual(a.where, 'out'); assert.strictEqual(a.last.guest, 'Bob'); assert.strictEqual(a.last.saleTs, '20261104170000000');
  assert.strictEqual(a.back, iso('2026-11-06T18:00:00'));
  assert.strictEqual(b.where, 'out'); assert.strictEqual(b.last.kind, 'rental');
  assert.strictEqual(g.diffs.length, 0);
});

test('sale of an unknown, broken, lost or other-product number: sale kept, number not linked, difference', async () => {
  const { applyGearOps } = await js('gearcore.js');
  const s = snap([item('SG001', { condition: 'Broken' }), item('SG002', { where: 'lost', condition: 'Lost' }), item('SG003'), item('B1')]);
  const g = applyGearOps(s, [op('sale', { payment: 'Cash', lines: [
    { ts: 'T1', guest: 'Bob', object: 'Snorkeling Mask', qty: 1, unit: 1, gear: 'SG001' },
    { ts: 'T2', guest: 'Bob', object: 'Snorkeling Mask', qty: 1, unit: 1, gear: 'SG002' },
    { ts: 'T3', guest: 'Bob', object: 'Rabbit bike', qty: 1, unit: 1, gear: 'SG003' },
    { ts: 'T4', guest: 'Bob', object: 'Snorkeling Mask', qty: 1, unit: 1, gear: 'SG999' },
    { ts: 'T5', guest: 'Bob', object: 'Rabbit bike', qty: 1, unit: 1, gear: 'B1' }] }, '2026-11-04T10:00:00')]);
  assert.deepStrictEqual(g.items.map(i => i.where), ['in', 'lost', 'in', 'out']);
  assert.deepStrictEqual(g.diffs.map(d => [d.item, d.kind]).sort(), [['SG001', 'sale_unlinked'], ['SG002', 'sale_unlinked'], ['SG003', 'sale_unlinked'], ['SG999', 'sale_unlinked']]);
  const { applyOps } = await js('ledger.js');
  assert.strictEqual(applyOps([], [g && op('sale', { payment: 'Cash', lines: [{ ts: 'T4', guest: 'Bob', object: 'Snorkeling Mask', qty: 1, unit: 30000, gear: 'SG999' }] }, '2026-11-04T10:00:00')]).length, 1, 'the money line is there');
});

test('settle moves the rental to the new line id: later change and delete still reach the number', async () => {
  const { applyGearOps } = await js('gearcore.js');
  const sale = op('sale', { payment: 'Unpaid', lines: [{ ts: '20261104100000000', guest: 'G', object: 'Snorkeling Mask', qty: 1, unit: 30000, gear: 'SG001' }] }, '2026-11-04T10:00:00');
  const settle = op('settle', { payment: 'Cash', items: [{ oldTs: '20261104100000000', newTs: '20261104110000000' }] }, '2026-11-04T11:00:00');
  let g = applyGearOps(snap([item('SG001')]), [sale, settle, op('line_update', { ts: '20261104110000000', qty: 3 }, '2026-11-04T11:05:00')]);
  assert.strictEqual(g.items[0].last.saleTs, '20261104110000000');
  assert.strictEqual(g.items[0].back, iso('2026-11-07T12:00:00'));
  g = applyGearOps(snap([item('SG001')]), [sale, settle, op('line_delete', { ts: '20261104110000000' }, '2026-11-04T11:05:00')]);
  assert.strictEqual(g.items[0].where, 'in');
  // Already in the copy (the sheet wrote `relink`): a pending settle relinks the snapshot's rental.
  g = applyGearOps(snap([rental('SG001', 'G', '2026-11-04T10:00:00', '2026-11-05T12:00:00', '20261104100000000')]), [settle, op('line_delete', { ts: '20261104110000000' }, '2026-11-04T11:05:00')]);
  assert.strictEqual(g.items[0].where, 'in');
});

test('returns: numbers already in are skipped, the others returned; Lost stays out of service', async () => {
  const { applyGearOps } = await js('gearcore.js');
  const s = snap([item('SG001'), rental('SG002', 'Ann', '2026-11-02T13:00:00', '2026-11-03T18:00:00'), rental('SG003', 'Ann', '2026-11-02T13:00:00', '2026-11-03T18:00:00')]);
  const g = applyGearOps(s, [op('gear_return', { gid: 'Gabc1234', items: [{ item: 'SG001', condition: 'OK' }, { item: 'SG002', condition: 'OK' }, { item: 'SG003', condition: 'Lost' }] }, '2026-11-03T17:00:00')]);
  assert.deepStrictEqual(g.items.map(i => [i.where, i.condition]), [['in', 'OK'], ['in', 'OK'], ['lost', 'Lost']]);
  assert.deepStrictEqual(g.damages.map(d => [d.item, d.condition]), [['SG003', 'Lost']]);
});

test('Sunset Boat with only numbers already out: no trip at the desk (the phone keeps it until the sheet answers)', async () => {
  const { applyGearOps } = await js('gearcore.js');
  const out = op('sunset_out', { trip: 'Tabc1234', items: ['SG002'] }, '2026-11-04T16:00:00');
  let g = applyGearOps(snap([item('SG001'), rental('SG002', 'Ann', '2026-11-03T13:00:00', '2026-11-04T18:00:00')]), [out]);
  assert.strictEqual(g.trips.length, 0);
  assert.strictEqual(g.items[1].where, 'out');
  g = applyGearOps(snap([item('SG001'), rental('SG002', 'Ann', '2026-11-03T13:00:00', '2026-11-04T18:00:00')]), [op('sunset_out', { trip: 'Tdef1234', items: ['SG001', 'SG002'] }, '2026-11-04T16:00:00')]);
  assert.deepStrictEqual(g.trips.map(t => t.items), [['SG001']]);
  g = applyGearOps({ items: [{ id: 'SG001', kind: 'mask' }], diffs: [], trips: [] }, [out], 'gear');
  assert.strictEqual(g.trips.length, 0, 'unknown number on the phone side');
});

test('refund, bill payment, expense: staff only during their own open shift, managers always', async () => {
  const { canRefund, cashRight } = await js('ledger.js');
  const l = { type: 'Income', object: 'Towel', payment: 'Cash', comment: '', ts: '20261104100000000' };
  const ayu = { username: 'ayu', role: 'staff' }, boss = { username: 'boss', role: 'manager' };
  const own = { user: 'ayu', status: 'open', openedAt: iso('2026-11-04T08:00:00') }, other = { ...own, user: 'dewa' };
  assert.strictEqual(canRefund(l, ayu, own), true);
  assert.strictEqual(canRefund({ ...l, payment: 'Credit / Debit Card' }, ayu, own), true, 'any payment type');
  assert.strictEqual(canRefund(l, ayu, other), false);
  assert.strictEqual(canRefund(l, ayu, null), false);
  assert.strictEqual(canRefund(l, boss, null), true);
  assert.strictEqual(canRefund({ ...l, payment: 'Unpaid' }, boss, null), false);
  assert.strictEqual(cashRight(ayu, { ...own, status: 'closed' }), false);
});

test('one local database per sheet address', async () => {
  const { shortHash, DB_NAME, localKey } = await js('db.js');
  const { CONFIG } = await js('config.js');
  assert.notStrictEqual(shortHash('https://script.google.com/macros/s/TEST/exec'), shortHash('https://script.google.com/macros/s/LIVE/exec'));
  assert.strictEqual(shortHash('x'), shortHash('x'));
  assert.strictEqual(DB_NAME, 'rabbit-reception-' + shortHash(CONFIG.API_URL));
  assert.match(localKey('notified:gearcheck'), new RegExp('^' + DB_NAME + ':'));
});

test('copy details: a refused operation as readable text', async () => {
  const { opDetails } = await js('sync.js');
  const t = opDetails({ id: 'D1-x', type: 'sale', at: '2026-11-04T02:00:00.000Z', by: 'ayu', error: 'bad_payload', message: 'Guest and product are required',
    payload: { payment: 'Cash', lines: [{ ts: 'T1', guest: 'Bob', object: 'Towel', qty: 1, unit: 50000 }] } }, 'Sale');
  assert.match(t, /^Sale \(sale\)/);
  assert.match(t, /Refused: Guest and product are required \[bad_payload\]/);
  assert.match(t, /1\. ts: T1, guest: Bob, object: Towel, qty: 1, unit: 50000/);
  assert.match(t, /10:00/); // Bali time
});

test('notifications go through the service worker and are marked only once shown', async () => {
  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  globalThis.Notification = function () { throw new Error('Illegal constructor'); }; // as on Android
  globalThis.Notification.permission = 'granted';
  let fail = true; const shown = [];
  Object.defineProperty(globalThis.navigator, 'serviceWorker', { configurable: true,
    value: { ready: Promise.resolve({ showNotification: async (t, o) => { if (fail) throw new Error('no'); shown.push([t, o.data.url]); } }) } });
  const { notifyOnce } = await js('gearcore.js');
  assert.strictEqual(await notifyOnce('gearcheck', 'Cek malam', 'x', './gear.html'), false);
  assert.strictEqual(Object.keys(store).length, 0, 'a failed notification is tried again later');
  fail = false;
  assert.strictEqual(await notifyOnce('gearcheck', 'Cek malam', 'x', './gear.html'), true);
  assert.strictEqual(await notifyOnce('gearcheck', 'Cek malam', 'x', './gear.html'), false, 'once a day');
  assert.deepStrictEqual(shown, [['Cek malam', './gear.html']]);
  delete globalThis.navigator.serviceWorker;
});

test('sw.js: a tap on a reminder focuses the open app, or opens it', () => {
  const vm = require('vm');
  const src = require('fs').readFileSync(path.join(__dirname, '..', '..', 'sw.js'), 'utf8');
  const handlers = {}, calls = [];
  const run = clients => {
    const self = { addEventListener: (t, f) => { handlers[t] = f; }, registration: { scope: 'https://x.test/Rabbit-System/' },
      clients: { matchAll: async () => clients, openWindow: async u => calls.push(['open', u]) } };
    vm.runInNewContext(src, { self, caches: {}, URL, Request: class {}, fetch: () => {} });
    let wait;
    handlers.notificationclick({ notification: { data: { url: './gear.html' }, close: () => calls.push(['close']) }, waitUntil: p => { wait = p; } });
    return wait;
  };
  return (async () => {
    await run([{ url: 'https://x.test/Rabbit-System/', focus: async () => calls.push(['focus', 'desk']) },
      { url: 'https://x.test/Rabbit-System/gear.html?x=1', focus: async () => calls.push(['focus', 'gear']) }]);
    assert.deepStrictEqual(calls.splice(0), [['close'], ['focus', 'gear']]);
    await run([{ url: 'https://x.test/Rabbit-System/index.html', focus: async () => calls.push(['focus', 'desk']) }]);
    assert.deepStrictEqual(calls.splice(0), [['close'], ['open', 'https://x.test/Rabbit-System/gear.html']]);
    assert.match(src, /const VERSION = 'reception-2026-11-03i-gear'/, 'VERSION unchanged (the coordinator bumps it)');
  })();
});

test('evening check reminder: due from 20:00 (Bali time) until a check is recorded', async () => {
  const { checkDue } = await js('gearcore.js');
  assert.strictEqual(checkDue({ countedToday: false }, W('2026-11-04T19:59:00')), false);
  assert.strictEqual(checkDue({ countedToday: false }, W('2026-11-04T20:00:00')), true);
  assert.strictEqual(checkDue({ countedToday: true }, W('2026-11-04T21:00:00')), false);
  assert.strictEqual(checkDue(null, W('2026-11-04T21:00:00')), false);
});

test('extension: a check that found the number in the box does not count (sheet `counts` with `seen`)', async () => {
  const { extensionDays, daysLate, applyGearOps } = await js('gearcore.js');
  const back = iso('2026-11-03T18:00:00'), now = W('2026-11-06T10:00:00');
  const counts = [{ at: iso('2026-11-03T20:00:00'), seen: [] }, { at: iso('2026-11-04T20:00:00'), seen: ['SG001'] }, { at: iso('2026-11-05T20:00:00'), seen: ['SG002'] }];
  assert.strictEqual(extensionDays(back, counts, now, 'SG001'), 2);
  assert.strictEqual(extensionDays(back, counts, now, 'SG002'), 2);
  assert.strictEqual(extensionDays(back, counts, now), 3, 'no number: every check');
  const it = rental('SG001', 'Ann', '2026-11-02T13:00:00', '2026-11-03T18:00:00');
  assert.strictEqual(daysLate(it, { counts }, now), 2);
  // A check waiting on this device that found it in the box adds nothing.
  const g = applyGearOps(snap([it], { counts: counts.slice(0, 1) }), [op('gear_count', { cid: 'Kz', items: [{ item: 'SG001', condition: 'OK' }] }, '2026-11-04T20:00:00')]);
  assert.strictEqual(daysLate(g.items[0], g, now), 1);
  // Same number twice in one sale: the second line is not linked (as the sheet does).
  const g2 = applyGearOps(snap([item('SG003')]), [op('sale', { payment: 'Cash', lines: [
    { ts: 'A1', guest: 'Bob', object: 'Snorkeling Mask', qty: 1, unit: 1, gear: 'SG003' }, { ts: 'A2', guest: 'Cy', object: 'Snorkeling Mask', qty: 1, unit: 1, gear: 'SG003' }] }, '2026-11-04T10:00:00')]);
  assert.strictEqual(g2.items[0].last.guest, 'Bob');
  assert.deepStrictEqual(g2.diffs.map(d => d.id), ['GA2-u']);
});

test('second review: "Lost" off the boat or at the check leaves the stock; Volunteer skips out-of-service numbers', async () => {
  const { applyGearOps } = await js('gearcore.js');
  const s = snap([item('SG001'), item('SG002'), item('SG003'), item('SG004', { condition: 'Broken' })]);
  const g = applyGearOps(s, [
    op('sunset_out', { trip: 'Ttrip1', items: ['SG001', 'SG002'] }, '2026-11-03T15:00:00'),
    op('sunset_back', { trip: 'Ttrip1', items: ['SG001', 'SG002'], conditions: { SG001: 'Lost', SG002: 'Ring missing' } }, '2026-11-03T19:00:00'),
    op('gear_count', { cid: 'Kc1', items: [{ item: 'SG003', condition: 'Lost' }] }, '2026-11-03T20:00:00'),
    op('gear_out', { gid: 'Gv1', items: ['SG001', 'SG004'], days: 1, guest: 'V' }, '2026-11-03T21:00:00'),
  ]);
  const by = id => g.items.find(i => i.id === id);
  assert.deepStrictEqual(['SG001', 'SG002', 'SG003', 'SG004'].map(id => [by(id).where, by(id).condition]),
    [['lost', 'Lost'], ['in', 'Ring missing'], ['lost', 'Lost'], ['in', 'Broken']], 'lost ones and the broken one do not go out with the Volunteer');
  assert.deepStrictEqual(g.damages.map(d => d.id).sort(), ['DKc1-SG003', 'DTtrip1-SG001', 'DTtrip1-SG002'], 'same ids as the sheet');
});

test('second review: product names compare without case or spaces, like the sheet', async () => {
  const { applyGearOps, sameName } = await js('gearcore.js');
  assert.ok(sameName(' snorkeling   MASK ', 'Snorkeling Mask'));
  assert.ok(sameName("'Rabbit bike", 'rabbit bike'));
  assert.ok(!sameName('Snorkeling Masks', 'Snorkeling Mask'));
  const g = applyGearOps(snap([item('SG001')]), [op('sale', { saleId: 'S', payment: 'Cash', lines: [{ ts: 'T1', guest: 'Ann', object: 'snorkeling  mask', qty: 1, gear: 'SG001' }] }, '2026-11-03T10:00:00')]);
  assert.strictEqual(g.items[0].where, 'out');
  assert.strictEqual(g.diffs.length, 0);
  // Same keys on the server side.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server', '30.UI_api.gs'), 'utf8');
  assert.match(src, /var nameKey_ = function \(v\) \{ return String\(v === null \|\| v === undefined \? '' : v\)\.replace\(\/\^'\/, ''\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\)\.toLowerCase\(\); \};/);
  // The sale and line screens of the desk use the same rule (no strict equality on the product name).
  const work = require('fs').readFileSync(path.join(__dirname, '..', '..', 'js', 'work.js'), 'utf8');
  assert.doesNotMatch(work, /=== d\.gear\.product\.(mask|bike)|\[d\.gear\.product\.mask, d\.gear\.product\.bike\]\.includes/);
  assert.match(work, /sameName\(name, d\.gear\.product\.mask\)/);
});

test('expense buttons: the sheet list when sent (known items keep label and colour), else the built-in list', async () => {
  const { expenseButtons, EXPENSE_ITEMS } = await js('work.js');
  assert.strictEqual(expenseButtons([]), EXPENSE_ITEMS);
  assert.strictEqual(expenseButtons(undefined), EXPENSE_ITEMS);
  assert.deepStrictEqual(expenseButtons([{ object: "Guest's services", category: 'Other' }, { object: 'Pajak', category: 'Other' }]),
    [{ label: "Guest's Amenities", object: "Guest's services", tone: 'house' }, { label: 'Pajak', object: 'Pajak', tone: 'other' }]);
});

test('partner settle shown before the next pull uses the partner words from the sheet', async () => {
  const { applyOps } = await js('ledger.js');
  const o = op('partner_settle', { bill: 'B_01/11-10:00', payment: 'Cash', rows: [{ object: '-Horse Riding', ts: 'P1', net: 100 }, { object: '-Snorkeling Trip', ts: 'P2', net: -50 }] }, '2026-11-04T10:00:00');
  assert.deepStrictEqual(applyOps([], [o]).map(l => l.guest).sort(), ['Payment From Partner', 'Payment to Partner']);
  assert.deepStrictEqual(applyOps([], [o], { to: 'X to', from: 'X from' }).map(l => l.guest).sort(), ['X from', 'X to']);
});
