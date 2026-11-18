/**
 * 32.Checkin.gs — Check-in on the guest's own phone (owner 18/11/2026).
 *
 * One fixed QR code on the desk opens checkin.html on the guest's phone (camera app).
 * The receptionist opens a "check-in session" for a booking in the Check-in tab; every phone
 * that scans while it is open joins it, and both screens see the same form (each side asks the
 * server every 2 s). A phone keeps a random key in its browser: the server stores only its SHA-256.
 * That key is what will open the menu later (only a checked-in phone may order for its guest).
 *
 * Guest (no login, the device key is the proof):
 *   {action:"ci_hello", key, lang, join}       → {mode:"session"|"known"|"none"|"removed", ...}; joins the open session
 *                                               (join:false = a page polling: it does not join by itself)
 *   {action:"ci_set", key, sid, who, name, passport, lang}
 *   {action:"ci_photo", key, sid, data}        → JPEG as base64 (the page shrinks it to ~1000 px first)
 *   {action:"ci_whoami", key}                   → the checked-in guest of this phone (for the menu)
 * Desk (a reception session token):
 *   ci_arrivals, ci_open, ci_status, ci_photo_get, ci_edit, ci_remove, ci_validate, ci_cancel
 *
 * Kept: the passport photo 60 days after departure (Drive folder of the owner), the passport
 * number 12 months after departure (sheet CI_Guests). CI_cleanup (daily trigger) deletes them.
 * Run CI_setup once from the editor (creates the tab, the Drive folder and the trigger).
 */
var CHECKIN = (function () {
  var SHEET = 'CI_Guests';
  var HEAD = ['Created at', 'Session', 'Booking id', 'Booking name', 'Guest name', 'Room', 'Arrival', 'Departure',
    'Device key (SHA-256)', 'Passport number', 'Passport photo (Drive id)', 'Photo deleted after', 'Status',
    'Checked in by', 'Checked in at', 'Language', 'Person id'];
  var C = { created: 0, sid: 1, book: 2, bookName: 3, name: 4, room: 5, arr: 6, dep: 7, key: 8, pass: 9, photo: 10,
    photoDel: 11, status: 12, by: 13, at: 14, lang: 15, pid: 16 };
  var ST = { filling: 'filling', ready: 'ready', done: 'checked in', removed: 'removed', cancelled: 'cancelled', expired: 'expired' };
  var SESSION_MIN = 30;            // a session nobody looks at closes itself
  var PHOTO_DAYS = 60, NUMBER_DAYS = 365;
  var MAX_PHOTO_B64 = 1500000;     // ~1.1 MB of JPEG (the page sends ~100 KB)
  var LANGS = ['en', 'id', 'fr', 'es', 'zh'];
  var FOLDER_NAME = 'Rabbit Tree - passport photos (deleted automatically)';

  function err_(code, message) { var e = new Error(message || code); e.apiCode = code; return e; }
  function props_() { return PropertiesService.getScriptProperties(); }
  function tz_() { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); }
  function ymd_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }
  function lock_(fn) {
    var l = LockService.getScriptLock();
    if (!l.tryLock(15000)) throw err_('busy', 'The server is busy, try again');
    try { return fn(); } finally { l.releaseLock(); }
  }
  function sheet_() {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), s = ss.getSheetByName(SHEET);
    if (!s) { s = ss.insertSheet(SHEET); s.getRange(1, 1, 1, HEAD.length).setValues([HEAD]); s.setFrozenRows(1); }
    return s;
  }
  function rows_() {
    var s = sheet_(), n = s.getLastRow();
    if (n < 2) return [];
    return s.getRange(2, 1, n - 1, HEAD.length).getValues().map(function (r, i) { r.rowNo = i + 2; return r; });
  }
  function setCells_(rowNo, changes) { // {col: value}
    var s = sheet_();
    Object.keys(changes).forEach(function (c) { s.getRange(rowNo, Number(c) + 1).setValue(changes[c]); });
  }
  function text_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
  function safe_(v) { return typeof v === 'string' && /^[=+@-]/.test(v) ? "'" + v : v; }
  function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
  function keyHash_(key) {
    key = String(key || '');
    if (!/^[a-f0-9]{32,128}$/.test(key)) throw err_('bad_key', 'This page needs to be opened again');
    return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'ci:' + key, Utilities.Charset.UTF_8));
  }
  function lang_(v) { return LANGS.indexOf(String(v)) >= 0 ? String(v) : 'en'; }
  function passport_(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20); }
  function date_(v) { var s = String(v || '').slice(0, 10); return /^\d{4}-\d\d-\d\d$/.test(s) ? s : ''; }
  function addDays_(ymd, n) {
    var d = Utilities.parseDate(ymd, tz_(), 'yyyy-MM-dd');
    return new Date(d.getTime() + n * 86400000);
  }
  function cellYmd_(v) { return v instanceof Date ? ymd_(v) : date_(v); }

  // ---------- sessions (script properties: small, read every 2 s) ----------
  function getSession_(sid) {
    var raw = props_().getProperty('CI_S_' + sid);
    return raw ? JSON.parse(raw) : null;
  }
  function putSession_(s) { props_().setProperty('CI_S_' + s.id, JSON.stringify(s)); }
  function liveSession_(s) { return s && s.state === 'open' && s.seen + SESSION_MIN * 60000 > Date.now(); }
  /** The session the desk QR leads to right now (one desk: the newest open one). */
  function activeSession_() {
    var sid = props_().getProperty('CI_ACTIVE');
    var s = sid ? getSession_(sid) : null;
    return liveSession_(s) ? s : null;
  }
  function publicSession_(s) {
    return { sid: s.id, bookId: s.bookId, name: s.name, room: s.room, arrival: s.arrival, departure: s.departure, guests: s.guests };
  }
  function person_(r) {
    return { pid: String(r[C.pid]), who: String(r[C.name]) === String(r[C.bookName]) ? 'booking' : 'other', name: String(r[C.name]),
      passport: String(r[C.pass]), photo: String(r[C.photo]), status: String(r[C.status]), lang: String(r[C.lang]) };
  }
  function mine_(sid, hash) {
    return rows_().filter(function (r) { return String(r[C.sid]) === sid && String(r[C.key]) === hash && String(r[C.status]) !== ST.removed; })[0] || null;
  }

  // ---------- guest side ----------
  function hello(body) {
    var hash = keyHash_(body.key), lang = lang_(body.lang);
    return lock_(function () {
      var s = activeSession_();
      // A page left open joins only when the guest scans or taps "Try again" (join), never by itself.
      if (s && body.join === false && !mine_(s.id, hash)) s = null;
      if (s) {
        var r = mine_(s.id, hash);
        var out = !r && rows_().some(function (x) { return String(x[C.sid]) === s.id && String(x[C.key]) === hash; });
        if (out) return { mode: 'removed' }; // the desk took this phone out: it does not join again
        if (!r) { // joins: one row per phone, filled as the guest types
          var pid = 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          var first = !rows_().some(function (x) { return String(x[C.sid]) === s.id && String(x[C.status]) !== ST.removed; });
          sheet_().appendRow([new Date(), s.id, safe_(s.bookId || ''), safe_(s.name), first ? safe_(s.name) : '', safe_(s.room || ''),
            s.arrival || '', s.departure || '', hash, '', '', '', ST.filling, '', '', lang, pid]);
          r = mine_(s.id, hash);
        }
        return { mode: 'session', session: publicSession_(s), me: person_(r) };
      }
      // No session open at the desk: a phone already checked in is recognised (extension comes later).
      var today = ymd_(new Date());
      var known = rows_().filter(function (x) {
        return String(x[C.key]) === hash && String(x[C.status]) === ST.done && (!cellYmd_(x[C.dep]) || cellYmd_(x[C.dep]) >= today);
      }).pop();
      if (known) return { mode: 'known', guest: { name: String(known[C.name]), room: String(known[C.room]), departure: cellYmd_(known[C.dep]) } };
      return { mode: 'none' };
    });
  }
  function guestRow_(body) {
    var hash = keyHash_(body.key), sid = String(body.sid || '');
    var s = getSession_(sid);
    if (!liveSession_(s)) throw err_('session_closed', 'This check-in is closed');
    var r = mine_(sid, hash);
    if (!r) throw err_('not_joined', 'This phone is not part of this check-in');
    if (String(r[C.status]) === ST.done) throw err_('already_done', 'Already checked in');
    return { s: s, r: r };
  }
  function set(body) {
    return lock_(function () {
      var g = guestRow_(body), ch = {};
      if (body.who === 'booking') ch[C.name] = safe_(g.s.name);
      else if (body.who === 'other') ch[C.name] = safe_(text_(body.name, 60));
      if (body.passport !== undefined) ch[C.pass] = passport_(body.passport);
      if (body.lang) ch[C.lang] = lang_(body.lang);
      var name = ch[C.name] !== undefined ? ch[C.name] : g.r[C.name];
      var pass = ch[C.pass] !== undefined ? ch[C.pass] : g.r[C.pass];
      ch[C.status] = name && pass && g.r[C.photo] ? ST.ready : ST.filling;
      setCells_(g.r.rowNo, ch);
      g.r[C.name] = name; g.r[C.pass] = pass; g.r[C.status] = ch[C.status];
      return { me: person_(g.r) };
    });
  }
  function folder_() {
    var p = props_(), id = p.getProperty('CI_FOLDER');
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* deleted: make a new one */ } }
    var f = DriveApp.createFolder(FOLDER_NAME);
    p.setProperty('CI_FOLDER', f.getId());
    return f;
  }
  function trash_(id) { if (!id) return; try { DriveApp.getFileById(String(id)).setTrashed(true); } catch (e) { /* already gone */ } }
  function photo(body) {
    var data = String(body.data || '').replace(/^data:image\/jpeg;base64,/, '');
    if (!data || data.length > MAX_PHOTO_B64 || !/^[A-Za-z0-9+/=]+$/.test(data)) throw err_('bad_photo', 'The photo could not be sent, please take it again');
    var g = lock_(function () { return guestRow_(body); });
    var name = ymd_(new Date()) + ' ' + text_(g.r[C.name] || g.s.name, 40).replace(/[\\/:*?"<>|]/g, '') + ' ' + g.r[C.pid] + '.jpg';
    var file = folder_().createFile(Utilities.newBlob(Utilities.base64Decode(data), 'image/jpeg', name));
    return lock_(function () {
      var r = mine_(String(body.sid), keyHash_(body.key));
      if (!r) { trash_(file.getId()); throw err_('not_joined', 'This phone is not part of this check-in'); }
      var old = String(r[C.photo]);
      var ch = {}; ch[C.photo] = file.getId();
      ch[C.status] = r[C.name] && r[C.pass] ? ST.ready : ST.filling;
      setCells_(r.rowNo, ch);
      if (old && old !== file.getId()) trash_(old);
      r[C.photo] = file.getId(); r[C.status] = ch[C.status];
      return { me: person_(r) };
    });
  }
  /** For the menu (later): the guest this phone was checked in for, during the stay. */
  function whoami(body) {
    var hash = keyHash_(body.key), today = ymd_(new Date());
    var r = rows_().filter(function (x) {
      return String(x[C.key]) === hash && String(x[C.status]) === ST.done && (!cellYmd_(x[C.dep]) || cellYmd_(x[C.dep]) >= today);
    }).pop();
    if (!r) throw err_('unknown_device', 'Please check in at the reception');
    return { guest: String(r[C.name]), room: String(r[C.room]), departure: cellYmd_(r[C.dep]) };
  }

  // ---------- desk side ----------
  function deskUser_(body, ui) {
    var u = ui.user(body.token);
    if (u.role === 'gear') throw err_('forbidden', 'The gear account does not check guests in');
    return u;
  }
  function arrivals(body, ui) {
    deskUser_(body, ui);
    if (typeof B24 === 'undefined' || !B24.arrivals) throw err_('no_beds24', 'Beds24 is not connected');
    var today = new Date();
    var list = B24.arrivals(ymd_(new Date(today.getTime() - 86400000)), ymd_(new Date(today.getTime() + 86400000)));
    var done = {};
    rows_().forEach(function (r) {
      if (String(r[C.status]) !== ST.done || !r[C.book]) return;
      var b = String(r[C.book]); (done[b] = done[b] || []).push(String(r[C.name]));
    });
    return { today: ymd_(today), arrivals: list.map(function (b) { b.checkedIn = done[String(b.bookId)] || []; return b; }) };
  }
  function open(body, ui) {
    var u = deskUser_(body, ui);
    var name = text_(body.name, 60);
    if (!name) throw err_('bad_payload', 'Type the guest name');
    return lock_(function () {
      var prev = activeSession_();
      if (prev && prev.by !== u.username && !body.replace) throw err_('desk_busy', 'Another check-in is open (' + prev.name + ', by ' + prev.byName + ')');
      if (prev) closeSession_(prev, 'replaced');
      var s = { id: 'CI' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), state: 'open', bookId: text_(body.bookId, 20),
        name: name, room: text_(body.room, 60), arrival: date_(body.arrival), departure: date_(body.departure),
        guests: Math.max(1, Math.min(20, Number(body.guests) || 1)), by: u.username, byName: u.name || u.username,
        opened: Date.now(), seen: Date.now() };
      putSession_(s);
      props_().setProperty('CI_ACTIVE', s.id);
      return { session: publicSession_(s) };
    });
  }
  function deskSession_(body, ui) {
    deskUser_(body, ui);
    var s = getSession_(String(body.sid || ''));
    if (!s) throw err_('session_closed', 'This check-in is closed');
    return s;
  }
  function people_(sid) {
    return rows_().filter(function (r) { return String(r[C.sid]) === sid && String(r[C.status]) !== ST.removed; }).map(person_);
  }
  function status(body, ui) {
    var s = deskSession_(body, ui);
    if (s.state === 'open') { s.seen = Date.now(); putSession_(s); } // the desk is watching: keep it open
    return { session: publicSession_(s), state: liveSession_(s) ? 'open' : s.state === 'open' ? 'expired' : s.state,
      active: props_().getProperty('CI_ACTIVE') === s.id, people: people_(s.id) };
  }
  function photoGet(body, ui) {
    var s = deskSession_(body, ui);
    var r = rows_().filter(function (x) { return String(x[C.sid]) === s.id && String(x[C.pid]) === String(body.pid); })[0];
    if (!r || !r[C.photo]) throw err_('no_photo', 'No photo yet');
    var blob = DriveApp.getFileById(String(r[C.photo])).getBlob();
    return { data: 'data:image/jpeg;base64,' + Utilities.base64Encode(blob.getBytes()) };
  }
  function remove(body, ui) {
    var s = deskSession_(body, ui);
    return lock_(function () {
      var r = rows_().filter(function (x) { return String(x[C.sid]) === s.id && String(x[C.pid]) === String(body.pid); })[0];
      if (!r) throw err_('not_found', 'Already removed');
      if (String(r[C.status]) === ST.done) throw err_('already_done', 'Already checked in');
      trash_(r[C.photo]);
      var ch = {}; ch[C.status] = ST.removed; ch[C.photo] = ''; ch[C.pass] = ''; // key kept: this phone may not join again
      setCells_(r.rowNo, ch);
      return { people: people_(s.id) };
    });
  }
  /** The desk corrects what a guest typed (a misread passport number, a name). */
  function edit(body, ui) {
    var s = deskSession_(body, ui);
    if (s.state !== 'open') throw err_('session_closed', 'This check-in is closed');
    return lock_(function () {
      var r = rows_().filter(function (x) { return String(x[C.sid]) === s.id && String(x[C.pid]) === String(body.pid) && String(x[C.status]) !== ST.removed; })[0];
      if (!r) throw err_('not_found', 'This person left the check-in');
      var ch = {};
      if (body.passport !== undefined) ch[C.pass] = passport_(body.passport);
      if (body.name !== undefined) { var n = text_(body.name, 60); if (!n) throw err_('bad_payload', 'Type a name'); ch[C.name] = safe_(n); }
      var name = ch[C.name] !== undefined ? ch[C.name] : r[C.name], pass = ch[C.pass] !== undefined ? ch[C.pass] : r[C.pass];
      ch[C.status] = name && pass && r[C.photo] ? ST.ready : ST.filling;
      setCells_(r.rowNo, ch);
      return { people: people_(s.id) };
    });
  }
  function closeSession_(s, why) {
    s.state = why; s.closed = Date.now(); putSession_(s);
    if (props_().getProperty('CI_ACTIVE') === s.id) props_().deleteProperty('CI_ACTIVE');
    if (why === ST.done) return;
    rows_().forEach(function (r) { // nothing kept from a check-in that did not happen
      if (String(r[C.sid]) !== s.id || String(r[C.status]) === ST.done) return;
      if (String(r[C.status]) === ST.removed) { if (r[C.key]) setCells_(r.rowNo, (function () { var c = {}; c[C.key] = ''; return c; })()); return; }
      trash_(r[C.photo]);
      var ch = {}; ch[C.status] = ST.cancelled; ch[C.photo] = ''; ch[C.pass] = ''; ch[C.key] = '';
      setCells_(r.rowNo, ch);
    });
  }
  function cancel(body, ui) {
    var s = deskSession_(body, ui);
    return lock_(function () { if (s.state === 'open') closeSession_(s, ST.cancelled); return {}; });
  }
  function validate(body, ui) {
    var u = deskUser_(body, ui);
    var s = deskSession_(body, ui);
    if (s.state !== 'open') throw err_('session_closed', 'This check-in is closed');
    return lock_(function () {
      var people = rows_().filter(function (r) { return String(r[C.sid]) === s.id && String(r[C.status]) !== ST.removed; });
      var ok = people.filter(function (r) { return r[C.name] && r[C.pass] && r[C.photo]; });
      if (!ok.length) throw err_('nothing_ready', 'Nobody has a name, a passport number and a photo yet');
      if (ok.length < people.length && !body.partial) throw err_('not_all_ready', (people.length - ok.length) + ' person(s) not finished');
      var dep = s.departure || ymd_(new Date(Date.now() + 86400000));
      var photoDel = addDays_(dep, PHOTO_DAYS), now = new Date(), names = [];
      ok.forEach(function (r) {
        var ch = {}; ch[C.status] = ST.done; ch[C.by] = u.author || u.username; ch[C.at] = now; ch[C.photoDel] = photoDel;
        if (!r[C.dep]) ch[C.dep] = dep;
        setCells_(r.rowNo, ch);
        names.push(String(r[C.name]));
      });
      // A companion gets his own bill: his name joins the guest list (same place as "+ New guest").
      names.forEach(function (n) { if (n !== s.name) addGuest_(n); });
      closeSession_(s, ST.done);
      return { checkedIn: names };
    });
  }
  function addGuest_(name) {
    var ng = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('New guest');
    if (!ng) return;
    var last = ng.getLastRow();
    var key = function (v) { return String(v).replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase(); };
    if (last >= 1 && ng.getRange(1, 3, last, 4).getValues().some(function (r) { return key(r[0]) === key(name) || key(r[3]) === key(name); })) return;
    ng.getRange(last + 1, 3, 1, 4).setValues([[safe_(name), new Date(), '', safe_(name)]]);
  }

  // ---------- daily cleanup ----------
  function cleanup() {
    var today = ymd_(new Date()), n = { photos: 0, numbers: 0, expired: 0 };
    lock_(function () {
      rows_().forEach(function (r) {
        var st = String(r[C.status]), ch = {};
        if (st === ST.filling || st === ST.ready) { // a session left open and never finished
          var s = getSession_(String(r[C.sid]));
          if (!liveSession_(s)) { trash_(r[C.photo]); ch[C.status] = ST.expired; ch[C.photo] = ''; ch[C.pass] = ''; ch[C.key] = ''; n.expired++; }
        }
        if (st === ST.done) {
          var del = cellYmd_(r[C.photoDel]);
          if (r[C.photo] && del && del <= today) { trash_(r[C.photo]); ch[C.photo] = ''; n.photos++; }
          var dep = cellYmd_(r[C.dep]);
          if (r[C.pass] && dep && ymd_(addDays_(dep, NUMBER_DAYS)) <= today) { ch[C.pass] = ''; n.numbers++; }
        }
        if (Object.keys(ch).length) setCells_(r.rowNo, ch);
      });
      var all = props_().getProperties(), cut = Date.now() - 2 * 86400000; // closed sessions: 2 days are enough
      Object.keys(all).forEach(function (k) {
        if (k.indexOf('CI_S_') !== 0) return;
        try { var s = JSON.parse(all[k]); if ((s.closed || s.seen) < cut) props_().deleteProperty(k); } catch (e) { props_().deleteProperty(k); }
      });
    });
    return n;
  }
  function setup() {
    sheet_();
    folder_();
    var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'CI_cleanup'; });
    if (!has) ScriptApp.newTrigger('CI_cleanup').timeBased().atHour(3).everyDays(1).create();
    return 'CI_Guests ready, photo folder ' + props_().getProperty('CI_FOLDER') + (has ? ', trigger already there' : ', daily trigger installed');
  }

  var GUEST = { ci_hello: hello, ci_set: set, ci_photo: photo, ci_whoami: whoami };
  var DESK = { ci_arrivals: arrivals, ci_open: open, ci_status: status, ci_photo_get: photoGet, ci_remove: remove,
    ci_validate: validate, ci_cancel: cancel, ci_edit: edit };
  /** ui = {user(token) → the logged-in reception user} given by UIAPI. */
  function handle(body, ui) {
    var a = String(body.action);
    if (GUEST[a]) return GUEST[a](body);
    if (DESK[a]) return DESK[a](body, ui);
    throw err_('unknown_action', 'Unknown action');
  }
  return { handle: handle, cleanup: cleanup, setup: setup, actions: Object.keys(GUEST).concat(Object.keys(DESK)) };
})();

/** Run once from the editor: tab CI_Guests, the Drive folder for passport photos, the daily cleanup. */
function CI_setup() { var r = CHECKIN.setup(); Logger.log(r); return r; }
/** Daily trigger: deletes passport photos 60 days after departure, numbers after 12 months. */
function CI_cleanup() { var r = CHECKIN.cleanup(); Logger.log(JSON.stringify(r)); return r; }
