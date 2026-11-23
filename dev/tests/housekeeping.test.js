// Guests in and out for the housekeeping (33.Housekeeping.gs, owner 24/11): In / Out at the desk, the feed
// the Staff App reads with its key, check-out taken as done from 14:00, extensions, unit names.
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

const ymd = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const TODAY = ymd(Date.now()), YEST = ymd(Date.now() - 86400000), TOMORROW = ymd(Date.now() + 86400000), AGO3 = ymd(Date.now() - 3 * 86400000);
const HOUR = Number(new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 13));

function env0(house) {
  const env = makeEnv({ sheets: { 'Entries': [['Date']], 'Entries Manual': [['Date']], 'New guest': [['']] } });
  env.ctx.UI_setup();
  env.book['UI_Users'].appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw', '', '', '']);
  env.book['UI_Users'].appendRow(['gear1', 'Gear', 'gear', 'g@x', 'pw', '', '', '']);
  env.calls = 0;
  env.ctx.B24 = { house: () => { env.calls++; return JSON.parse(JSON.stringify(house)); }, units: () => [
    { roomId: '353330', room: 'Double inside building', unitId: '1', unit: 'Passion' },
    { roomId: '353330', room: 'Double inside building', unitId: '2', unit: 'Bamboo 1' },
    { roomId: '460592', room: 'Bola Bola', unitId: '1', unit: '1' }] };
  env.ctx.CI_setup();
  env.ctx.HK_setup();
  return env;
}
const login = (env, u) => env.call({ action: 'login', username: u, password: 'pw', deviceId: 'dev-' + u }).token;
const HOUSE = [
  { bookId: '1', name: 'Anna Out', room: 'Double inside building', roomId: '353330', unitId: '1', kind: 'departure', arrival: AGO3, departure: TODAY, guests: 2 },
  { bookId: '2', name: 'Ben In', room: 'Bola Bola', roomId: '460592', unitId: '2', kind: 'arrival', arrival: TODAY, departure: TOMORROW, guests: 1 },
  { bookId: '3', name: 'Cleo Stay', room: 'Tree House', roomId: '460595', unitId: '3', kind: 'stay', arrival: YEST, departure: TOMORROW, guests: 1 },
];

test('HK_setup: tabs CI_Moves and Units (unit names from Beds24), a key for the Staff App', () => {
  const env = env0(HOUSE);
  assert.ok(env.book['CI_Moves'] && env.book['Units']);
  assert.strictEqual(env.book['Units'].data.length, 4);
  assert.match(env.props.HK_FEED_KEY, /^[a-f0-9]{64}$/);
  const key = env.props.HK_FEED_KEY;
  env.ctx.HK_setup();
  assert.strictEqual(env.props.HK_FEED_KEY, key, 'the key is not changed by a second setup');
  assert.strictEqual(env.book['Units'].data.length, 4, 'rows are not added twice');
});

test('the desk sees who arrives and who leaves today; gear account refused', () => {
  const env = env0(HOUSE);
  const r = env.call({ action: 'hk_day', token: login(env, 'ayu') });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual([r.today, r.arrivals.map(a => a.name), r.departures.map(a => a.name)], [TODAY, ['Ben In'], ['Anna Out']]);
  assert.strictEqual(r.departures[0].unit, 'Passion', 'a named room of a Beds24 type shows by its name');
  assert.strictEqual(r.arrivals[0].unit, '2', 'a dorm bed shows by its number');
  assert.strictEqual(env.call({ action: 'hk_day', token: login(env, 'gear1') }).error, 'forbidden');
  assert.strictEqual(env.call({ action: 'hk_day', token: 'nope' }).ok, false);
});

test('Out and In: one line each in CI_Moves, undo adds a line, twice the same tap writes once', () => {
  const env = env0(HOUSE), token = login(env, 'ayu');
  let r = env.call({ action: 'hk_mark', token, bookId: '1', type: 'out' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.departures[0].at && r.departures[0].by === 'Ayu');
  env.call({ action: 'hk_mark', token, bookId: '1', type: 'out' });
  assert.strictEqual(env.book['CI_Moves'].data.length, 2, 'header + one Out');
  r = env.call({ action: 'hk_mark', token, bookId: '2', type: 'in' });
  assert.ok(r.arrivals[0].at);
  r = env.call({ action: 'hk_mark', token, bookId: '1', type: 'out', undo: true });
  assert.strictEqual(r.departures[0].at, null);
  assert.deepStrictEqual(env.book['CI_Moves'].data.slice(1).map(x => x[1]), ['out', 'in', 'undo_out']);
  assert.strictEqual(env.call({ action: 'hk_mark', token, bookId: '2', type: 'out' }).error, 'not_found', 'an arrival cannot be marked Out');
  assert.strictEqual(env.call({ action: 'hk_mark', token, bookId: '9', type: 'in' }).error, 'not_found');
});

test('feed for the Staff App: needs the key, no personal data, statuses follow the taps', () => {
  const env = env0(HOUSE), token = login(env, 'ayu'), key = env.props.HK_FEED_KEY;
  assert.strictEqual(env.call({ action: 'hk_moves', key: 'wrong', date: TODAY }).error, 'forbidden');
  assert.strictEqual(env.call({ action: 'hk_moves', date: TODAY }).error, 'forbidden');
  let f = env.call({ action: 'hk_moves', key, date: TODAY });
  assert.ok(f.ok, JSON.stringify(f));
  assert.deepStrictEqual(f.arrivals.map(a => [a.guest, a.room, a.unit, a.status]), [['Ben In', 'Bola Bola', '2', 'expected']]);
  assert.deepStrictEqual(f.stays.map(a => [a.guest, a.room, a.since]), [['Cleo Stay', 'Tree House', YEST]]);
  assert.strictEqual(f.departures[0].unit, 'Passion');
  assert.strictEqual(f.departures[0].status, HOUR >= 14 ? 'checked_out_auto' : 'expected', 'not tapped: gone by itself from 14:00');
  env.call({ action: 'hk_mark', token, bookId: '1', type: 'out' });
  env.call({ action: 'hk_mark', token, bookId: '2', type: 'in' });
  f = env.call({ action: 'hk_moves', key, date: TODAY });
  assert.deepStrictEqual([f.departures[0].status, f.arrivals[0].status], ['checked_out', 'checked_in']);
  assert.ok(f.departures[0].checkedOutAt && f.arrivals[0].checkedInAt);
  assert.doesNotMatch(JSON.stringify(f), /passport|email|price|amount/i);
});

test('Beds24 is read once and kept: the desk and the Staff App share one reading', () => {
  const env = env0(HOUSE), token = login(env, 'ayu'), key = env.props.HK_FEED_KEY;
  env.call({ action: 'hk_day', token });
  env.call({ action: 'hk_moves', key, date: TODAY });
  env.call({ action: 'hk_mark', token, bookId: '1', type: 'out' });
  env.call({ action: 'hk_moves', key, date: TODAY });
  assert.strictEqual(env.calls, 1);
  env.call({ action: 'hk_day', token, fresh: true });
  assert.strictEqual(env.calls, 2, 'Refresh reads again');
});

test('a booking that extends a stay in the same room is a stay, not an Out and an In', () => {
  const env = env0([
    { bookId: '10', name: 'Dana  Long', room: 'Bird Nest', roomId: '460596', unitId: '1', kind: 'departure', arrival: AGO3, departure: TODAY, guests: 1 },
    { bookId: '11', name: 'dana long', room: 'Bird Nest', roomId: '460596', unitId: '1', kind: 'arrival', arrival: TODAY, departure: TOMORROW, guests: 1 },
    { bookId: '12', name: 'Dana Long', room: 'Twin Room', roomId: '460594', unitId: '1', kind: 'arrival', arrival: TODAY, departure: TOMORROW, guests: 1 },
  ]);
  const f = env.call({ action: 'hk_moves', key: env.props.HK_FEED_KEY, date: TODAY });
  assert.deepStrictEqual([f.departures.length, f.stays.map(s => [s.bookId, s.since]), f.arrivals.map(a => a.bookId)], [0, [['10', AGO3]], ['12']]);
});

test('a booking with no room charge (monthly guest) gets its room name from Data activities', () => {
  const env = env0([{ bookId: '20', name: 'Monthly Guest', room: 'Room', roomId: '460597', unitId: '2', kind: 'stay', arrival: AGO3, departure: TOMORROW, guests: 1 }]);
  const row = new Array(21).fill(''); row[18] = 'White House'; row[20] = '460597';
  env.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('Data activities').appendRow(['h']).appendRow(row);
  const f = env.call({ action: 'hk_moves', key: env.props.HK_FEED_KEY, date: TODAY });
  assert.deepStrictEqual(f.stays.map(x => [x.room, x.unit]), [['White House', '2']]);
});

test('checked in on the phone counts as In', () => {
  const env = env0(HOUSE);
  const row = new Array(17).fill('');
  row[2] = '2'; row[4] = 'Ben In'; row[12] = 'checked in'; row[13] = 'Ayu'; row[14] = new Date();
  env.book['CI_Guests'].appendRow(row);
  const f = env.call({ action: 'hk_moves', key: env.props.HK_FEED_KEY, date: TODAY });
  assert.strictEqual(f.arrivals[0].status, 'checked_in');
});

test('a Staff App room typed in Units wins; each In / Out is pushed when HK_PUSH_URL is set', () => {
  const env = env0(HOUSE), token = login(env, 'ayu');
  env.book['Units'].appendRow(['460592', '2', 'Bola Bola', '2', 'Bola-Bola', '']);
  env.cache.clear();
  env.props.HK_PUSH_URL = 'https://staff.example/api/hooks/moves'; env.props.HK_PUSH_KEY = 'k1';
  const r = env.call({ action: 'hk_mark', token, bookId: '2', type: 'in' });
  assert.strictEqual(r.arrivals[0].unit, 'Bola-Bola');
  assert.strictEqual(env.fetches.length, 1);
  const sent = JSON.parse(env.fetches[0].opt.payload);
  assert.deepStrictEqual([env.fetches[0].url, sent.key, sent.arrivals[0].status], ['https://staff.example/api/hooks/moves', 'k1', 'checked_in']);
});
