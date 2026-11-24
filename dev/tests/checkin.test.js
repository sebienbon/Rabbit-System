// Check-in on the guest's phone (32.Checkin.gs): desk session, phones joining with their key,
// passport photo in Drive, validation, companions' own bill, cleanup.
const test = require('node:test');
const assert = require('node:assert');
const { makeEnv } = require('./gas-shim');

function env0() {
  const env = makeEnv({ sheets: {
    'Entries': [['Date']], 'Entries Manual': [['Date']],
    'New guest': [['', '', '', '', '', 'Bob Sample']],
  } });
  env.ctx.UI_setup();
  const users = env.book['UI_Users'];
  users.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'pw', '', '', '']);
  users.appendRow(['dewa', 'Dewa', 'staff', 'r2@x', 'pw', '', '', '']);
  users.appendRow(['gear1', 'Gear', 'gear', 'g@x', 'pw', '', '', '']);
  env.ctx.CI_setup();
  return env;
}
const login = (env, u) => env.call({ action: 'login', username: u, password: 'pw', deviceId: 'dev-' + u }).token;
const key = c => c.repeat(64);
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('fake jpeg bytes').toString('base64');
const rows = env => env.book['CI_Guests'].data.slice(1).filter(r => r[16]);
const ymd = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

function openFor(env, token, extra = {}) {
  const r = env.call({ action: 'ci_open', token, bookId: '96026082', name: 'Giulia Varcasia', room: 'Twin Room',
    arrival: ymd(Date.now()), departure: ymd(Date.now() + 2 * 86400000), guests: 2, ...extra });
  assert.ok(r.ok, JSON.stringify(r));
  return r.session.sid;
}

test('no session at the desk: an unknown phone is told to ask the reception', () => {
  const env = env0();
  const r = env.call({ action: 'ci_hello', key: key('a') });
  assert.deepStrictEqual([r.ok, r.mode], [true, 'none']);
  assert.strictEqual(env.call({ action: 'ci_hello', key: 'short' }).error, 'bad_key');
});

test('full check-in: two phones join, booking name / another name, passport and photo, desk validates', () => {
  const env = env0();
  const ayu = login(env, 'ayu');
  const sid = openFor(env, ayu);
  // first phone: the booking name is already chosen
  let a = env.call({ action: 'ci_hello', key: key('a'), lang: 'fr' });
  assert.strictEqual(a.mode, 'session');
  assert.strictEqual(a.session.name, 'Giulia Varcasia');
  assert.deepStrictEqual([a.me.who, a.me.name, a.me.status, a.me.lang], ['booking', 'Giulia Varcasia', 'filling', 'fr']);
  // the same phone again: same person, no second row
  assert.strictEqual(env.call({ action: 'ci_hello', key: key('a') }).me.pid, a.me.pid);
  // a page left open on another phone does not join by itself
  assert.strictEqual(env.call({ action: 'ci_hello', key: key('d'), join: false }).mode, 'none');
  assert.strictEqual(env.call({ action: 'ci_hello', key: key('a'), join: false }).mode, 'session', 'a phone already in stays in');
  // second phone: a companion
  let b = env.call({ action: 'ci_hello', key: key('b') });
  assert.strictEqual(b.me.name, '');
  b = env.call({ action: 'ci_set', key: key('b'), sid, who: 'other', name: 'Jessica Rossi', passport: 'yb 12345-6' });
  assert.deepStrictEqual([b.me.who, b.me.name, b.me.passport, b.me.status], ['other', 'Jessica Rossi', 'YB123456', 'filling']);
  // the desk sees both, live
  let st = env.call({ action: 'ci_status', token: ayu, sid });
  assert.deepStrictEqual(st.people.map(p => p.name), ['Giulia Varcasia', 'Jessica Rossi']);
  // not everyone is finished: validate refuses
  assert.strictEqual(env.call({ action: 'ci_validate', token: ayu, sid }).error, 'nothing_ready');
  // photos
  a = env.call({ action: 'ci_set', key: key('a'), sid, passport: 'L898902C3' });
  a = env.call({ action: 'ci_photo', key: key('a'), sid, data: JPEG });
  assert.strictEqual(a.me.status, 'ready');
  const firstPhoto = a.me.photo;
  a = env.call({ action: 'ci_photo', key: key('a'), sid, data: JPEG }); // taken again: the old one goes
  assert.ok(env.drive.files[firstPhoto].trashed);
  assert.ok(!env.drive.files[a.me.photo].trashed);
  // the desk opens the photo
  const ph = env.call({ action: 'ci_photo_get', token: ayu, sid, pid: a.me.pid });
  assert.strictEqual(ph.data, JPEG);
  // the desk corrects a misread number (L read as 1: the check digit cannot see it)
  st = env.call({ action: 'ci_edit', token: ayu, sid, pid: a.me.pid, passport: '1898902C3' });
  assert.strictEqual(st.people[0].passport, '1898902C3');
  st = env.call({ action: 'ci_edit', token: ayu, sid, pid: a.me.pid, passport: 'l898902c3' });
  assert.strictEqual(st.people[0].passport, 'L898902C3');
  assert.strictEqual(env.call({ action: 'ci_edit', token: ayu, sid, pid: a.me.pid, name: ' ' }).error, 'bad_payload');
  // one ready, one not: refused unless the desk says so
  assert.strictEqual(env.call({ action: 'ci_validate', token: ayu, sid }).error, 'not_all_ready');
  b = env.call({ action: 'ci_photo', key: key('b'), sid, data: JPEG });
  assert.strictEqual(b.me.status, 'ready');
  const v = env.call({ action: 'ci_validate', token: ayu, sid });
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepStrictEqual(v.checkedIn, ['Giulia Varcasia', 'Jessica Rossi']);
  const r = rows(env);
  assert.deepStrictEqual(r.map(x => x[12]), ['checked in', 'checked in']);
  assert.deepStrictEqual(r.map(x => x[13]), ['r1@x', 'r1@x']);
  assert.ok(r.every(x => !String(x[8]).includes('a'.repeat(64)) && String(x[8]).length === 64), 'only the hash of the key is kept');
  const del = r[0][11];
  assert.strictEqual(ymd(del.getTime()), ymd(Date.parse(ymd(Date.now() + 2 * 86400000)) + 60 * 86400000), 'photo kept 60 days after departure');
  // the companion has her own bill: her name joins the guest list
  assert.ok(env.book['New guest'].data.some(x => x[5] === 'Jessica Rossi'));
  assert.ok(!env.book['New guest'].data.some(x => x[5] === 'Giulia Varcasia'));
  // the session is closed; the phones are now known
  assert.strictEqual(env.call({ action: 'ci_status', token: ayu, sid }).state, 'checked in');
  const k = env.call({ action: 'ci_hello', key: key('b') });
  assert.deepStrictEqual([k.mode, k.guest.name], ['known', 'Jessica Rossi']);
  assert.strictEqual(env.call({ action: 'ci_whoami', key: key('a') }).guest, 'Giulia Varcasia');
  assert.strictEqual(env.call({ action: 'ci_whoami', key: key('c') }).error, 'unknown_device');
  // a phone can no longer change a closed check-in
  assert.strictEqual(env.call({ action: 'ci_set', key: key('a'), sid, passport: 'X' }).error, 'session_closed');
});

test('the desk removes a stranger, cancels, and keeps nothing of a check-in that did not happen', () => {
  const env = env0();
  const ayu = login(env, 'ayu');
  const sid = openFor(env, ayu);
  const a = env.call({ action: 'ci_hello', key: key('a') });
  env.call({ action: 'ci_set', key: key('a'), sid, passport: 'AB1' });
  const ph = env.call({ action: 'ci_photo', key: key('a'), sid, data: JPEG }).me.photo;
  const x = env.call({ action: 'ci_hello', key: key('e') });
  let st = env.call({ action: 'ci_remove', token: ayu, sid, pid: x.me.pid });
  assert.deepStrictEqual(st.people.map(p => p.pid), [a.me.pid]);
  assert.strictEqual(env.call({ action: 'ci_set', key: key('e'), sid, passport: 'Z' }).error, 'not_joined');
  assert.strictEqual(env.call({ action: 'ci_hello', key: key('e') }).mode, 'removed', 'a removed phone does not join again');
  env.call({ action: 'ci_cancel', token: ayu, sid });
  assert.ok(env.drive.files[ph].trashed, 'photo deleted');
  const r = rows(env).find(z => z[16] === a.me.pid);
  assert.deepStrictEqual([r[12], r[9], r[10], r[8]], ['cancelled', '', '', '']);
  assert.strictEqual(env.call({ action: 'ci_hello', key: key('a') }).mode, 'none');
});

test('one desk: a colleague cannot take over an open check-in without saying so; gear accounts are refused', () => {
  const env = env0();
  const ayu = login(env, 'ayu'), dewa = login(env, 'dewa');
  const sid = openFor(env, ayu);
  const r = env.call({ action: 'ci_open', token: dewa, name: 'Walk In' });
  assert.strictEqual(r.error, 'desk_busy');
  const r2 = env.call({ action: 'ci_open', token: dewa, name: 'Walk In', replace: true });
  assert.ok(r2.ok);
  assert.strictEqual(env.call({ action: 'ci_status', token: ayu, sid }).state, 'replaced');
  assert.strictEqual(env.call({ action: 'ci_hello', key: key('f') }).session.name, 'Walk In');
  assert.strictEqual(env.call({ action: 'ci_open', token: login(env, 'gear1'), name: 'X' }).error, 'forbidden');
  assert.strictEqual(env.call({ action: 'ci_status', token: 'nope', sid }).error, 'no_session');
});

test('a session nobody watches closes after 30 minutes; the daily cleanup deletes photos and numbers in time', () => {
  const env = env0();
  const ayu = login(env, 'ayu');
  const sid = openFor(env, ayu);
  env.call({ action: 'ci_hello', key: key('a') });
  env.call({ action: 'ci_set', key: key('a'), sid, passport: 'AB1' });
  const ph = env.call({ action: 'ci_photo', key: key('a'), sid, data: JPEG }).me.photo;
  // 31 minutes without the desk
  const s = JSON.parse(env.props['CI_S_' + sid]); s.seen -= 31 * 60000; env.props['CI_S_' + sid] = JSON.stringify(s);
  assert.strictEqual(env.call({ action: 'ci_hello', key: key('a') }).mode, 'none');
  let n = env.ctx.CI_cleanup();
  assert.strictEqual(n.expired, 1);
  assert.ok(env.drive.files[ph].trashed);
  // a finished check-in: photo after 60 days, number after 12 months
  const sid2 = openFor(env, ayu, { departure: ymd(Date.now() - 400 * 86400000) });
  env.call({ action: 'ci_hello', key: key('b') });
  env.call({ action: 'ci_set', key: key('b'), sid: sid2, passport: 'CD2' });
  const ph2 = env.call({ action: 'ci_photo', key: key('b'), sid: sid2, data: JPEG }).me.photo;
  assert.ok(env.call({ action: 'ci_validate', token: ayu, sid: sid2 }).ok);
  n = env.ctx.CI_cleanup();
  assert.deepStrictEqual([n.photos, n.numbers], [1, 1]);
  assert.ok(env.drive.files[ph2].trashed);
  const r = rows(env).find(z => z[1] === sid2);
  assert.deepStrictEqual([r[9], r[10], r[4]], ['', '', 'Giulia Varcasia']);
  assert.ok(env.triggers.some(t => t.fn === 'CI_cleanup'));
});

test('arrivals come from Beds24 with who is already checked in', () => {
  const env = env0();
  env.ctx.B24 = { arrivals: (from, to) => [{ bookId: '96026082', name: 'Giulia Varcasia', room: 'Twin Room', arrival: from, departure: to, guests: 2 },
    { bookId: '1', name: 'Other', room: 'Bola Bola', arrival: to, departure: to, guests: 1 }] };
  const ayu = login(env, 'ayu');
  const sid = openFor(env, ayu);
  env.call({ action: 'ci_hello', key: key('a') });
  env.call({ action: 'ci_set', key: key('a'), sid, passport: 'AB1' });
  env.call({ action: 'ci_photo', key: key('a'), sid, data: JPEG });
  env.call({ action: 'ci_validate', token: ayu, sid });
  const r = env.call({ action: 'ci_arrivals', token: ayu });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepStrictEqual(r.arrivals.map(x => x.checkedIn), [['Giulia Varcasia'], []]);
  assert.strictEqual(r.arrivals[0].arrival, ymd(Date.now() - 86400000));
});

test('bad photo data is refused before anything is written', () => {
  const env = env0();
  const ayu = login(env, 'ayu');
  const sid = openFor(env, ayu);
  env.call({ action: 'ci_hello', key: key('a') });
  assert.strictEqual(env.call({ action: 'ci_photo', key: key('a'), sid, data: 'not base64 !!' }).error, 'bad_photo');
  assert.strictEqual(env.call({ action: 'ci_photo', key: key('a'), sid, data: 'A'.repeat(1600000) }).error, 'bad_photo');
  assert.strictEqual(Object.keys(env.drive.files).length, 0);
});

test('menu pass: a checked-in phone gets a one-time pass, the POS account checks it once', () => {
  const env = env0();
  const ayu = login(env, 'ayu');
  env.book['UI_Users'].appendRow(['bar-pos', 'Bar POS', 'manager', 'pos@x', 'pw', '', '', '']);
  const pos = login(env, 'bar-pos');
  env.call({ action: 'pos_address', token: pos, url: 'http://192.168.1.131:8080' });
  // unknown phone: no pass
  assert.strictEqual(env.call({ action: 'ci_menu_pass', key: key('a'), table: '5' }).error, 'unknown_device');
  const sid = openFor(env, ayu);
  env.call({ action: 'ci_hello', key: key('a') });
  env.call({ action: 'ci_set', key: key('a'), sid, passport: 'AB1' });
  env.call({ action: 'ci_photo', key: key('a'), sid, data: JPEG });
  env.call({ action: 'ci_validate', token: ayu, sid });
  const p = env.call({ action: 'ci_menu_pass', key: key('a'), table: '5' });
  assert.ok(p.ok, JSON.stringify(p));
  assert.deepStrictEqual([p.guest, p.table, p.posUrl, p.validMs], ['Giulia Varcasia', '5', 'http://192.168.1.131:8080', 120000]);
  // a staff account may not check passes; the POS account can, once
  assert.strictEqual(env.call({ action: 'ci_menu_verify', token: ayu, pass: p.pass }).error, 'forbidden');
  const v = env.call({ action: 'ci_menu_verify', token: pos, pass: p.pass });
  assert.deepStrictEqual([v.guest, v.room, v.table, v.device.length], ['Giulia Varcasia', 'Twin Room', '5', 16]);
  assert.strictEqual(env.call({ action: 'ci_menu_verify', token: pos, pass: p.pass }).error, 'bad_pass');
  // the same phone always gives the same device id; an expired pass is refused
  const p2 = env.call({ action: 'ci_menu_pass', key: key('a'), table: '' });
  const k = Object.keys(env.props).find(x => x === 'CI_P_' + p2.pass);
  const x = JSON.parse(env.props[k]); x.exp = Date.now() - 1; env.props[k] = JSON.stringify(x);
  assert.strictEqual(env.call({ action: 'ci_menu_verify', token: pos, pass: p2.pass }).error, 'bad_pass');
  const p3 = env.call({ action: 'ci_menu_pass', key: key('a') });
  assert.strictEqual(env.call({ action: 'ci_menu_verify', token: pos, pass: p3.pass }).device, v.device);
});

test('WhatsApp number (owner 24/11): asked on the phone, kept with the country code, never needed to finish', () => {
  const env = env0(), token = login(env, 'ayu');
  const sid = openFor(env, token);
  const k = key('a');
  env.call({ action: 'ci_hello', key: k });
  let r = env.call({ action: 'ci_set', key: k, sid, who: 'booking', passport: 'AB123456', whatsapp: '+33 6 12 34 56 78' });
  assert.strictEqual(r.me.whatsapp, '33612345678');
  r = env.call({ action: 'ci_set', key: k, sid, whatsapp: '0812-3456-789' });
  assert.strictEqual(r.me.whatsapp, '628123456789', 'a number starting with 0 is an Indonesian one');
  r = env.call({ action: 'ci_set', key: k, sid, whatsapp: '0033 6 12 34 56 78' });
  assert.strictEqual(r.me.whatsapp, '33612345678');
  r = env.call({ action: 'ci_set', key: k, sid, whatsapp: 'no' });
  assert.strictEqual(r.me.whatsapp, '', 'not a number: nothing kept');
  assert.strictEqual(env.book['CI_Guests'].data[0][17], 'WhatsApp');
});
