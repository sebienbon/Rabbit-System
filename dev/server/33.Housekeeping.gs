/**
 * 33.Housekeeping.gs — Guests in and out, for the housekeeping (owner 24/11/2026).
 *
 * The reception is the only one talking to Beds24; the Staff App (housekeeping, on Railway) reads here who
 * arrives, who leaves and who stays today, so a freed room becomes work for the staff in the right order.
 *
 * Desk (a reception session token), Check-in tab:
 *   {action:"hk_day", token, fresh}                → {today, hour, arrivals:[…], departures:[…]} with who is In / Out
 *   {action:"hk_mark", token, bookId, type:"in"|"out", undo}  → the receptionist taps In (guest arrived) or Out
 *                                                    (guest left, bags out); one line in the tab CI_Moves, never changed
 * Staff App (its own key, Script Property HK_FEED_KEY; read only, no personal data: no passport, email, amounts):
 *   {action:"hk_moves", key, date}                 → {date, arrivals, departures, stays}
 *
 * A departure nobody tapped is given as "checked_out_auto" from 14:00 (check-out hour; nothing is written).
 * A guest checked in on the phone (32.Checkin.gs) counts as In. A booking that only extends a stay in the same
 * room (Beds24 makes a separate booking) is a stay, not an Out + In.
 * Beds24 is read once for everybody and kept 2 minutes (CacheService): no new trigger, few calls.
 * Tab Units (Room id | Unit id | Beds24 room | Beds24 unit | Staff App room): which bed / room of a Beds24 type is
 * which room of the Staff App. HK_setup creates it; only the rows with a Staff App room are used.
 * Optional: Script Properties HK_PUSH_URL (<Staff App>/api/hooks/moves) + HK_PUSH_KEY → each In / Out is sent
 * at once (else the Staff App reads every 2 minutes).
 */
var HK = (function () {
  var MOVES = 'CI_Moves', UNITS = 'Units', GUESTS = 'CI_Guests';
  var MOVES_HEAD = ['At', 'Type', 'Booking id', 'Guest', 'Room', 'Unit', 'By', 'Day'];
  var UNITS_HEAD = ['Room id', 'Unit id', 'Beds24 room', 'Beds24 unit', 'Staff App room', 'Note'];
  var CHECKOUT_HOUR = 14;
  var CACHE_S = 120;

  function err_(code, message) { var e = new Error(message || code); e.apiCode = code; return e; }
  function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
  function props_() { return PropertiesService.getScriptProperties(); }
  function tz_() { return ss_().getSpreadsheetTimeZone(); }
  function ymd_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }
  function hour_(d) { return Number(Utilities.formatDate(d, tz_(), 'HH')) + Number(Utilities.formatDate(d, tz_(), 'mm')) / 60; }
  function iso_(d) { return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null; }
  function text_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
  function safe_(v) { return typeof v === 'string' && /^[=+@-]/.test(v) ? "'" + v : v; }
  function sheet_(name, head) {
    var s = ss_().getSheetByName(name);
    if (!s) { s = ss_().insertSheet(name); s.getRange(1, 1, 1, head.length).setValues([head]); s.setFrozenRows(1); }
    return s;
  }
  function values_(name, width) {
    var s = ss_().getSheetByName(name);
    if (!s || s.getLastRow() < 2) return [];
    return s.getRange(2, 1, s.getLastRow() - 1, width).getValues();
  }
  /** Same time whatever the keys' lengths: a wrong key learns nothing from the answer's delay. */
  function sameKey_(a, b) {
    a = String(a || ''); b = String(b || '');
    var diff = a.length ^ b.length;
    for (var i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0 && a.length > 0;
  }

  // ---------- Beds24, once for everybody ----------
  function house_(day, fresh) {
    if (typeof B24 === 'undefined' || !B24.house) throw err_('no_beds24', 'Beds24 is not connected');
    var cache = typeof CacheService !== 'undefined' ? CacheService.getScriptCache() : null, key = 'HK_HOUSE_' + day;
    if (cache && !fresh) {
      var hit = cache.get(key);
      if (hit) { try { return JSON.parse(hit); } catch (e) { /* read again */ } }
    }
    var list = extensions_(B24.house(day));
    if (cache) { try { cache.put(key, JSON.stringify(list), CACHE_S); } catch (e) { /* too big: no cache */ } }
    return list;
  }
  function nameKey_(n) { return String(n || '').toLowerCase().replace(/[^a-zÀ-ɏ]+/g, ' ').trim().split(' ').sort().join(' '); }
  /** Leaves and arrives the same day, same name, same Beds24 room type: an extension = a stay. */
  function extensions_(list) {
    var out = [], used = {};
    list.forEach(function (d) {
      if (d.kind !== 'departure') return;
      var a = list.filter(function (x) { return x.kind === 'arrival' && !used[x.bookId] && x.roomId === d.roomId && nameKey_(x.name) && nameKey_(x.name) === nameKey_(d.name); })[0];
      if (!a) return;
      used[a.bookId] = used[d.bookId] = true;
      out.push({ bookId: d.bookId, name: d.name, room: d.room, roomId: d.roomId, unitId: a.unitId || d.unitId, kind: 'stay', arrival: d.arrival, departure: a.departure, guests: a.guests });
    });
    list.forEach(function (x) { if (!used[x.bookId]) out.push(x); });
    return out;
  }

  // ---------- Units: Beds24 bed / room → Staff App room ----------
  function unitMap_() {
    var map = {};
    values_(UNITS, UNITS_HEAD.length).forEach(function (r) {
      var staff = text_(r[4], 60) || (/[a-z]/i.test(String(r[3])) ? text_(r[3], 60) : ''); // no Staff App name typed: the Beds24 unit name when it is a name
      if (staff) map[String(r[0]).trim() + '|' + String(r[1]).trim()] = staff;
    });
    return map;
  }
  /** room = what the Staff App should look for; unit = the bed number (dorms), for the people only. */
  function place_(b, map) {
    var staff = map[b.roomId + '|' + b.unitId] || map[b.roomId + '|'] || '';
    return staff ? { room: b.room, unit: staff } : { room: b.room, unit: b.unitId || '' };
  }

  // ---------- In / Out ----------
  /** Last tap per booking and type for a day: {"<bookId>|in": {at, by}}; an undo removes it. */
  function marks_(day) {
    var m = {};
    values_(MOVES, MOVES_HEAD.length).forEach(function (r) {
      if (String(r[7]) !== day && !(r[7] instanceof Date && ymd_(r[7]) === day)) return;
      var type = String(r[1]), id = String(r[2]);
      if (type === 'in' || type === 'out') m[id + '|' + type] = { at: r[0] instanceof Date ? r[0] : new Date(r[0]), by: String(r[6]) };
      else if (type === 'undo_in') delete m[id + '|in'];
      else if (type === 'undo_out') delete m[id + '|out'];
    });
    // Checked in on the phone (32.Checkin.gs) = In.
    values_(GUESTS, 15).forEach(function (r) {
      var id = String(r[2]);
      if (!id || String(r[12]) !== 'checked in' || m[id + '|in']) return;
      var at = r[14] instanceof Date ? r[14] : null;
      if (at && ymd_(at) === day) m[id + '|in'] = { at: at, by: String(r[13]) };
    });
    return m;
  }
  function deskUser_(body, ui) {
    var u = ui.user(body.token);
    if (u.role === 'gear') throw err_('forbidden', 'The gear account does not check guests in or out');
    return u;
  }
  function day(body, ui) {
    deskUser_(body, ui);
    var now = new Date(), today = ymd_(now), list = house_(today, !!body.fresh), marks = marks_(today), map = unitMap_();
    function line(b, type) {
      var p = place_(b, map), k = marks[b.bookId + '|' + type];
      return { bookId: b.bookId, name: b.name, room: b.room, unit: p.unit, guests: b.guests, arrival: b.arrival, departure: b.departure,
        at: k ? iso_(k.at) : null, by: k ? k.by : '' };
    }
    var byName = function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; };
    return { today: today, checkoutHour: CHECKOUT_HOUR, late: hour_(now) >= CHECKOUT_HOUR,
      arrivals: list.filter(function (b) { return b.kind === 'arrival'; }).map(function (b) { return line(b, 'in'); }).sort(byName),
      departures: list.filter(function (b) { return b.kind === 'departure'; }).map(function (b) { return line(b, 'out'); }).sort(byName) };
  }
  function mark(body, ui) {
    var u = deskUser_(body, ui);
    var type = String(body.type), id = text_(body.bookId, 20);
    if ((type !== 'in' && type !== 'out') || !id) throw err_('bad_payload', 'Pick a guest');
    var now = new Date(), today = ymd_(now);
    var b = house_(today, false).filter(function (x) { return x.bookId === id && x.kind === (type === 'in' ? 'arrival' : 'departure'); })[0];
    if (!b) b = house_(today, true).filter(function (x) { return x.bookId === id && x.kind === (type === 'in' ? 'arrival' : 'departure'); })[0];
    if (!b) throw err_('not_found', 'This booking is not ' + (type === 'in' ? 'arriving' : 'leaving') + ' today any more: refresh');
    var l = LockService.getScriptLock();
    if (!l.tryLock(15000)) throw err_('busy', 'The server is busy, try again');
    try {
      var has = !!marks_(today)[id + '|' + type];
      if (!!body.undo === has) { // not already in the asked state
        var p = place_(b, unitMap_());
        sheet_(MOVES, MOVES_HEAD).appendRow([now, (body.undo ? 'undo_' : '') + type, id, safe_(b.name), safe_(b.room), safe_(String(p.unit)), safe_(u.name || u.username), today]);
        SpreadsheetApp.flush();
      }
    } finally { l.releaseLock(); }
    push_(today);
    return day({ token: body.token }, ui);
  }

  // ---------- Staff App ----------
  function feed_(dayStr) {
    var now = new Date(), today = ymd_(now), list = house_(dayStr, false), marks = marks_(dayStr), map = unitMap_();
    var late = dayStr < today || (dayStr === today && hour_(now) >= CHECKOUT_HOUR);
    var out = { date: dayStr, generatedAt: now.toISOString(), checkoutHour: CHECKOUT_HOUR, arrivals: [], departures: [], stays: [] };
    list.forEach(function (b) {
      var p = place_(b, map), x = { bookId: b.bookId, guest: b.name, room: p.room, unit: String(p.unit), guests: b.guests };
      if (b.kind === 'arrival') {
        var i = marks[b.bookId + '|in'];
        x.status = i ? 'checked_in' : 'expected'; x.checkedInAt = i ? iso_(i.at) : null;
        out.arrivals.push(x);
      } else if (b.kind === 'departure') {
        var o = marks[b.bookId + '|out'];
        x.status = o ? 'checked_out' : late ? 'checked_out_auto' : 'expected'; x.checkedOutAt = o ? iso_(o.at) : null;
        out.departures.push(x);
      } else { x.since = b.arrival; out.stays.push(x); }
    });
    return out;
  }
  function moves(body) {
    var secret = props_().getProperty('HK_FEED_KEY');
    if (!secret || !sameKey_(body.key, secret)) { Utilities.sleep(500); throw err_('forbidden', 'Wrong key'); }
    var d = String(body.date || '').slice(0, 10);
    return feed_(/^\d{4}-\d\d-\d\d$/.test(d) ? d : ymd_(new Date()));
  }
  /** After an In / Out: tell the Staff App at once (it also reads by itself every 2 minutes). Never blocks the desk. */
  function push_(dayStr) {
    var url = props_().getProperty('HK_PUSH_URL'), key = props_().getProperty('HK_PUSH_KEY');
    if (!url || !key || typeof UrlFetchApp === 'undefined') return;
    try {
      var body = feed_(dayStr); body.key = key;
      UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(body) });
    } catch (e) { console.error('HK push: ' + e); }
  }

  function setup() {
    sheet_(MOVES, MOVES_HEAD);
    var u = sheet_(UNITS, UNITS_HEAD), added = 0;
    if (u.getLastRow() < 2 && typeof B24 !== 'undefined' && B24.units) {
      var rows = B24.units().map(function (x) { return [x.roomId, x.unitId, safe_(x.room), safe_(x.unit), '', '']; });
      if (rows.length) { u.getRange(2, 1, rows.length, UNITS_HEAD.length).setValues(rows); added = rows.length; }
    }
    var p = props_();
    if (!p.getProperty('HK_FEED_KEY')) p.setProperty('HK_FEED_KEY', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
    return 'CI_Moves and Units ready (' + added + ' unit rows from Beds24). Key for the Staff App: Script Properties > HK_FEED_KEY.';
  }

  function handle(body, ui) {
    var a = String(body.action);
    if (a === 'hk_moves') return moves(body);
    if (a === 'hk_day') return day(body, ui);
    if (a === 'hk_mark') return mark(body, ui);
    throw err_('unknown_action', 'Unknown action');
  }
  return { handle: handle, setup: setup };
})();

/** Run once from the editor: tabs CI_Moves and Units, and the key the Staff App reads with (HK_FEED_KEY). */
function HK_setup() { var r = HK.setup(); Logger.log(r); return r; }
