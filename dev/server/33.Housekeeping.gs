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
 * Staff App (its own key, Script Property HK_FEED_KEY; read only, no personal data: no passport, email, phone, amounts):
 *   {action:"hk_moves", key, date, due:[bookId…]}  → {date, arrivals, departures, stays}; `due` = the stays whose room
 *                                                    is due for its every-3-days cleaning (the Staff App knows the cleanings)
 * Cleaning of a guest who stays (owner 24/11): the guest is asked first, by WhatsApp from the hostel's own WhatsApp
 * (a wa.me link, no paid API). The message carries a personal link to clean.html (two buttons Yes / No).
 *   {action:"hk_ask", token, bookId}               → {t, day}: the proof that goes in the guest's link (nothing written)
 *   {action:"hk_asked", token, bookId}             → the receptionist says the message left (line "ask" in CI_Moves)
 *   {action:"hk_clean", token, bookId, answer}     → the receptionist notes the answer himself: yes | no | none (undo)
 *   {action:"hk_answer", b, d, t, answer}          → the guest's own tap (no login: t proves the link; today only)
 * The answer goes to the Staff App in stays[].cleaning: yes | no | asked.
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
  /** Beds24 room id → room type name (Data activities, columns S and U). For a booking with no room charge (a monthly guest at price 0). */
  function roomNames_() {
    var names = {}, s = ss_().getSheetByName('Data activities');
    if (s && s.getLastRow() >= 2) s.getRange(2, 19, s.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (String(r[2]).trim() && String(r[0]).trim()) names[String(r[2]).trim()] = String(r[0]).trim();
    });
    return names;
  }
  /** room = what the Staff App should look for; unit = the bed number (dorms), for the people only. */
  function place_(b, map) {
    var staff = map[b.roomId + '|' + b.unitId] || map[b.roomId + '|'] || '';
    var room = b.room && b.room !== 'Room' ? b.room : ((map._names = map._names || roomNames_())[b.roomId] || b.room || 'Room');
    return staff ? { room: room, unit: staff } : { room: room, unit: b.unitId || '' };
  }

  // ---------- In / Out ----------
  // ---------- cleaning of a stay: ask the guest ----------
  function signed_(bookId, day) {
    var secret = props_().getProperty('HK_FEED_KEY') || '';
    if (!secret) throw err_('not_set_up', 'Run HK_setup first');
    return Utilities.computeHmacSha256Signature(String(bookId) + '|' + day, secret).slice(0, 12)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  function due_(day) {
    var c = typeof CacheService !== 'undefined' ? CacheService.getScriptCache().get('HK_DUE_' + day) : null;
    try { return c ? JSON.parse(c) : null; } catch (e) { return null; }
  }
  /** The WhatsApp numbers known for a booking: the people checked in on their phone first, then Beds24's. */
  function phones_(b, guests) {
    var out = [], seen = {};
    function add(label, raw) {
      var d = typeof CHECKIN !== 'undefined' && CHECKIN.phone ? CHECKIN.phone(raw) : String(raw || '').replace(/[^0-9]/g, '');
      if (d && !seen[d]) { seen[d] = true; out.push({ label: label, number: d }); }
    }
    var mine = guests.filter(function (r) { return String(r[2]) === b.bookId && String(r[12]) === 'checked in'; });
    mine.sort(function (x, y) { return (String(y[4]) === String(y[3])) - (String(x[4]) === String(x[3])); }); // the booking's own name first
    mine.forEach(function (r) { add(String(r[4]), '+' + String(r[17] || '').replace(/[^0-9]/g, '')); });
    add(b.name + ' (Beds24)', b.phone);
    return out;
  }

  /** Last tap per booking and type for a day: {"<bookId>|in": {at, by}}; an undo removes it. */
  function marks_(day) {
    var m = {};
    values_(MOVES, MOVES_HEAD.length).forEach(function (r) {
      if (String(r[7]) !== day && !(r[7] instanceof Date && ymd_(r[7]) === day)) return;
      var type = String(r[1]), id = String(r[2]);
      if (type === 'in' || type === 'out') m[id + '|' + type] = { at: r[0] instanceof Date ? r[0] : new Date(r[0]), by: String(r[6]) };
      else if (type === 'undo_in') delete m[id + '|in'];
      else if (type === 'undo_out') delete m[id + '|out'];
      else if (type === 'ask') m[id + '|ask'] = { at: r[0] instanceof Date ? r[0] : new Date(r[0]), by: String(r[6]) };
      else if (type === 'clean_yes' || type === 'clean_no') m[id + '|clean'] = { answer: type === 'clean_yes' ? 'yes' : 'no', at: r[0] instanceof Date ? r[0] : new Date(r[0]), by: String(r[6]) };
      else if (type === 'clean_undo') delete m[id + '|clean'];
    });
    // Checked in on the phone (32.Checkin.gs) = In.
    values_(GUESTS, 18).forEach(function (r) {
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
      return { bookId: b.bookId, name: b.name, room: p.room, unit: p.unit, guests: b.guests, arrival: b.arrival, departure: b.departure,
        at: k ? iso_(k.at) : null, by: k ? k.by : '' };
    }
    var byName = function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; };
    var due = due_(today), guests = values_(GUESTS, 18);
    var stays = list.filter(function (b) { return b.kind === 'stay'; }).map(function (b) {
      var p = place_(b, map), a = marks[b.bookId + '|ask'], c = marks[b.bookId + '|clean'];
      return { bookId: b.bookId, name: b.name, room: p.room, unit: p.unit, since: b.arrival, departure: b.departure,
        due: due ? due.indexOf(b.bookId) >= 0 : null, askedAt: a ? iso_(a.at) : null, answer: c ? c.answer : null,
        answerBy: c ? c.by : '', answerAt: c ? iso_(c.at) : null, phones: phones_(b, guests) };
    }).sort(function (a, b) { return (b.due === true) - (a.due === true) || byName(a, b); });
    return { today: today, checkoutHour: CHECKOUT_HOUR, late: hour_(now) >= CHECKOUT_HOUR, stays: stays, dueKnown: !!due,
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
        sheet_(MOVES, MOVES_HEAD).appendRow([now, (body.undo ? 'undo_' : '') + type, id, safe_(b.name), safe_(p.room), safe_(String(p.unit)), safe_(u.name || u.username), today]);
        SpreadsheetApp.flush();
      }
    } finally { l.releaseLock(); }
    push_(today);
    return day({ token: body.token }, ui);
  }

  function stay_(id, today) {
    function find(fresh) { return house_(today, fresh).filter(function (x) { return x.bookId === id && x.kind === 'stay'; })[0]; }
    return find(false) || find(true);
  }
  function note_(type, b, by, today) {
    var l = LockService.getScriptLock();
    if (!l.tryLock(15000)) throw err_('busy', 'The server is busy, try again');
    try {
      var p = place_(b, unitMap_());
      sheet_(MOVES, MOVES_HEAD).appendRow([new Date(), type, b.bookId, safe_(b.name), safe_(p.room), safe_(String(p.unit)), safe_(by), today]);
      SpreadsheetApp.flush();
    } finally { l.releaseLock(); }
    push_(today);
  }
  function ask(body, ui) {
    deskUser_(body, ui);
    var today = ymd_(new Date()), b = stay_(text_(body.bookId, 20), today);
    if (!b) throw err_('not_found', 'This guest is not staying today any more: refresh');
    return { t: signed_(b.bookId, today), day: today, bookId: b.bookId };
  }
  function asked(body, ui) {
    var u = deskUser_(body, ui), today = ymd_(new Date()), b = stay_(text_(body.bookId, 20), today);
    if (!b) throw err_('not_found', 'This guest is not staying today any more: refresh');
    note_('ask', b, u.name || u.username, today);
    return day({ token: body.token }, ui);
  }
  function clean(body, ui) {
    var u = deskUser_(body, ui), today = ymd_(new Date()), b = stay_(text_(body.bookId, 20), today);
    var a = String(body.answer);
    if (!b) throw err_('not_found', 'This guest is not staying today any more: refresh');
    if (a !== 'yes' && a !== 'no' && a !== 'none') throw err_('bad_payload', 'Yes or no');
    note_(a === 'none' ? 'clean_undo' : 'clean_' + a, b, u.name || u.username, today);
    return day({ token: body.token }, ui);
  }
  /** The guest's own page (clean.html): what the link is about, and the answer when one is tapped. */
  function answer(body) {
    var today = ymd_(new Date()), id = text_(body.b, 20), d = String(body.d || '');
    if (!id || !sameKey_(String(body.t || ''), signed_(id, d))) { Utilities.sleep(500); throw err_('bad_link', 'This link is not valid'); }
    if (d !== today) throw err_('expired', 'This link was for another day');
    var b = stay_(id, today);
    if (!b) throw err_('expired', 'This link is no longer valid');
    var a = String(body.answer || '');
    if (a === 'yes' || a === 'no') note_('clean_' + a, b, 'guest', today);
    var c = marks_(today)[id + '|clean'], p = place_(b, unitMap_());
    return { first: String(b.name).split(' ')[0], room: /[a-z]/i.test(String(p.unit)) ? String(p.unit) : p.room, answer: c ? c.answer : null };
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
      } else {
        var c = marks[b.bookId + '|clean'];
        x.since = b.arrival; x.cleaning = c ? c.answer : marks[b.bookId + '|ask'] ? 'asked' : null;
        out.stays.push(x);
      }
    });
    return out;
  }
  function moves(body) {
    var secret = props_().getProperty('HK_FEED_KEY');
    if (!secret || !sameKey_(body.key, secret)) { Utilities.sleep(500); throw err_('forbidden', 'Wrong key'); }
    var d = String(body.date || '').slice(0, 10);
    d = /^\d{4}-\d\d-\d\d$/.test(d) ? d : ymd_(new Date());
    // the Staff App says which stays are due for a cleaning: the desk shows them first (kept 6 h, renewed at each read)
    if (Array.isArray(body.due) && typeof CacheService !== 'undefined') {
      try { CacheService.getScriptCache().put('HK_DUE_' + d, JSON.stringify(body.due.slice(0, 200).map(function (x) { return String(x).slice(0, 20); })), 21600); } catch (e) { /* no cache: no badge */ }
    }
    return feed_(d);
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
    if (a === 'hk_ask') return ask(body, ui);
    if (a === 'hk_asked') return asked(body, ui);
    if (a === 'hk_clean') return clean(body, ui);
    if (a === 'hk_answer') return answer(body);
    throw err_('unknown_action', 'Unknown action');
  }
  /** From the editor: what the Staff App would get for today, without the guests' names (rooms and statuses only). */
  function check() {
    var f = feed_(ymd_(new Date()));
    function rooms(list) { return list.map(function (x) { return x.room + (x.unit ? ' / ' + x.unit : '') + (x.status ? ' [' + x.status + ']' : ''); }).join(' · ') || 'none'; }
    return 'Arrivals ' + f.arrivals.length + ': ' + rooms(f.arrivals) + '\nDepartures ' + f.departures.length + ': ' + rooms(f.departures) + '\nStays ' + f.stays.length + ': ' + rooms(f.stays);
  }
  return { handle: handle, setup: setup, check: check };
})();

/** Run once from the editor: tabs CI_Moves and Units, and the key the Staff App reads with (HK_FEED_KEY). */
function HK_setup() { var r = HK.setup(); Logger.log(r); return r; }
/** Run from the editor to see today's rooms as the Staff App gets them (no names). */
function HK_check() { var r = HK.check(); Logger.log(r); return r; }
