/**
 * 30.UI_api.gs — Back end of the offline reception interface.
 *
 * Deployed as a Web App that runs as the OWNER, so staff never need access
 * to the spreadsheet. Everything lives inside the UIAPI namespace to avoid
 * colliding with the ~600 global functions already in this project.
 * Only three globals are added: doPost, doGet, UI_setup.
 *
 * Protocol: POST, body = JSON text (Content-Type text/plain, no CORS preflight)
 *   {action:"login", username, password, deviceId, deviceSecret?, registerDevice?}
 *   {action:"pull",  token}
 *   {action:"push",  token, deviceId, ops:[{id, type, at, by, payload}]}
 * Response: JSON {ok:true, ...} or {ok:false, error:"code", message}
 *
 * Reliability rules
 *  - A business refusal (bad amount, shift already open...) is final: logged as "rejected".
 *  - Any other failure (Google timeout, quota...) fails the whole push WITHOUT marking
 *    the op as seen, so the device retries it later.
 *  - Handlers check everything before their first write, and are idempotent by shiftId,
 *    so a retry after a half-finished call never writes twice.
 */

var UIAPI = (function () {
  var SESSION_DAYS = 14;                   // device keeps working offline this long
  var MAX_OP_AGE_DAYS = 14;                // older device times are refused (clock reset)
  var HASH_ROUNDS = 2000;
  var SHEETS = {
    users: 'UI_Users',
    log: 'UI_Log',
    shifts: 'UI_Shifts',
    cash: 'Cashouts&Cor',
    manual: 'Entries Manual',
    catalog: 'Data activities',
    feed: '24datafeed',
    newGuest: 'New guest'
  };
  var USERS_HEADER = ['Username', 'Display name', 'Role (staff/manager/admin)', 'Author email',
    'Set new password here', 'Password hash', 'Salt', 'Active'];
  var LOG_HEADER = ['Received at', 'Op ID', 'Device', 'User', 'Type', 'Shift ID', 'Happened at', 'Result', 'Detail', 'Payload'];
  var SHIFTS_HEADER = ['Shift ID', 'User', 'Author email', 'Opened at', 'Opening cash counted', 'Opening difference',
    'Closed at', 'Closing cash counted', 'Cashout', 'Closing difference', 'Status', 'Closed by', 'Comment'];
  var COL = { id: 0, user: 1, author: 2, openedAt: 3, openCash: 4, openDiff: 5, closedAt: 6, closeCash: 7,
    cashout: 8, closeDiff: 9, status: 10, closedBy: 11, comment: 12 };

  // ---------- helpers ----------
  function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
  function sheet_(name) {
    var s = ss_().getSheetByName(name);
    if (!s) throw apiError_('missing_sheet', 'Sheet not found: ' + name);
    return s;
  }
  function apiError_(code, message) { var e = new Error(message || code); e.apiCode = code; return e; }
  function json_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  }
  function hex_(bytes) {
    return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  /** Same algorithm as the client (auth.js) so passwords can be checked offline. */
  function hashPassword_(password, salt) {
    var h = salt + ':' + password;
    for (var i = 0; i < HASH_ROUNDS; i++) {
      h = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
    }
    return h;
  }
  function num_(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || v === '') return 0;
    var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function amount_(v, field) {
    var n = Number(v);
    if (typeof v === 'string') n = Number(v.replace(/[\s.,](?=\d{3}(\D|$))/g, ''));
    if (v === '' || v === null || v === undefined || !isFinite(n) || n < 0 || n > 1e10) {
      throw apiError_('bad_amount', 'Invalid amount for ' + field);
    }
    return Math.round(n);
  }
  function parseAt_(at) {
    var d = new Date(at);
    if (isNaN(d.getTime())) throw apiError_('bad_time', 'Invalid time');
    if (d.getTime() - Date.now() > 2 * 86400000) throw apiError_('bad_time', 'Device clock is in the future');
    if (Date.now() - d.getTime() > MAX_OP_AGE_DAYS * 86400000) throw apiError_('bad_time', 'Device clock is too far in the past');
    return d;
  }
  // Cells are displayed in the SPREADSHEET's timezone, so dates and times use it too.
  var tzCache_;
  function tz_() { return tzCache_ || (tzCache_ = ss_().getSpreadsheetTimeZone()); }
  function fmt_(d, pattern) { return Utilities.formatDate(d, tz_(), pattern); }
  /** Midnight of that day in the spreadsheet's timezone: shows as dd/MM/yyyy like existing rows. */
  function dateOnly_(d) { return Utilities.parseDate(fmt_(d, 'yyyy-MM-dd'), tz_(), 'yyyy-MM-dd'); }
  function iso_(v) { var d = new Date(v); return isNaN(d.getTime()) ? '' : d.toISOString(); }
  function lastRowIn_(sheet, firstCol, nCols) {
    var max = sheet.getLastRow();
    if (max < 1) return 0;
    var vals = sheet.getRange(1, firstCol, max, nCols).getValues();
    for (var r = vals.length - 1; r >= 0; r--) {
      for (var c = 0; c < nCols; c++) if (vals[r][c] !== '' && vals[r][c] !== null) return r + 1;
    }
    return 0;
  }
  /** Writes one row right after the last row that has data in columns A..(row length). */
  function appendAfterData_(sheet, row, dateFormatCols) {
    var r = lastRowIn_(sheet, 1, row.length) + 1;
    sheet.getRange(r, 1, 1, row.length).setValues([row]);
    (dateFormatCols || []).forEach(function (c) { sheet.getRange(r, c).setNumberFormat('dd/MM/yyyy'); });
    return r;
  }
  function withLock_(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) throw apiError_('busy', 'Server busy, will retry');
    try { return fn(); } finally { lock.releaseLock(); }
  }

  // ---------- setup ----------
  function ensureSheet_(name, header) {
    var s = ss_().getSheetByName(name);
    if (!s) {
      s = ss_().insertSheet(name);
      s.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      s.setFrozenRows(1);
    }
    return s;
  }
  function setup() {
    var users = ensureSheet_(SHEETS.users, USERS_HEADER);
    users.getRange('F:G').setNumberFormat('@');
    var log = ensureSheet_(SHEETS.log, LOG_HEADER);
    log.getRange('B:B').setNumberFormat('@');
    var shifts = ensureSheet_(SHEETS.shifts, SHIFTS_HEADER);
    shifts.getRange('A:A').setNumberFormat('@');
    withLock_(hashPendingPasswords_);
    return 'UI sheets ready: ' + [SHEETS.users, SHEETS.log, SHEETS.shifts].join(', ');
  }

  // ---------- users, devices & sessions ----------
  /** Hashes any plain password typed in column E, then clears it. Call under the lock. */
  function hashPendingPasswords_() {
    var s = ss_().getSheetByName(SHEETS.users);
    if (!s || s.getLastRow() < 2) return;
    var n = s.getLastRow() - 1;
    var plain = s.getRange(2, 5, n, 1).getValues();
    plain.forEach(function (r, i) {
      if (String(r[0]) === '') return;
      var row = i + 2;
      var salt = Utilities.getUuid().replace(/-/g, '');
      var active = s.getRange(row, 8).getValue();
      s.getRange(row, 5, 1, 4).setValues([['', hashPassword_(String(r[0]), salt), salt, active === '' ? true : active]]);
    });
  }
  function readUsers_() {
    var s = sheet_(SHEETS.users);
    if (s.getLastRow() < 2) return [];
    return s.getRange(2, 1, s.getLastRow() - 1, USERS_HEADER.length).getValues()
      .filter(function (r) { return String(r[0]).trim() !== ''; })
      .map(function (r) {
        var role = String(r[2]).trim().toLowerCase();
        return {
          username: String(r[0]).trim().toLowerCase(),
          name: String(r[1]).trim() || String(r[0]).trim(),
          role: (role === 'manager' || role === 'admin') ? role : 'staff',
          author: String(r[3]).trim(),
          hash: String(r[5]), salt: String(r[6]),
          active: r[7] === true || String(r[7]).toUpperCase() === 'TRUE'
        };
      });
  }
  function findUser_(username) {
    var u = String(username || '').trim().toLowerCase();
    return readUsers_().filter(function (x) { return x.username === u; })[0] || null;
  }
  // Registered devices: only the reception computer(s) a manager registered get the
  // password hashes for offline login and may send operations signed by a colleague.
  function devices_() {
    try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('UI_DEVICES') || '{}'); } catch (e) { return {}; }
  }
  function login(body) {
    withLock_(hashPendingPasswords_);
    var user = findUser_(body.username);
    if (!user || !user.active || !user.hash || hashPassword_(String(body.password || ''), user.salt) !== user.hash) {
      Utilities.sleep(800); // slow down guessing
      throw apiError_('bad_login', 'Wrong username or password');
    }
    var props = PropertiesService.getScriptProperties();
    var deviceId = String(body.deviceId || '');
    var registered = false, newSecret = null;
    var devs = devices_();
    if (deviceId && body.deviceSecret && devs[deviceId] && devs[deviceId].secret === String(body.deviceSecret)) {
      registered = true;
    } else if (deviceId && body.registerDevice && user.role !== 'staff') {
      newSecret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
      withLock_(function () {
        var d = devices_();
        d[deviceId] = { secret: newSecret, by: user.username, at: new Date().toISOString() };
        props.setProperty('UI_DEVICES', JSON.stringify(d));
      });
      registered = true;
    }
    purgeSessions_(props);
    var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('UIS_' + token, JSON.stringify({
      u: user.username, exp: Date.now() + SESSION_DAYS * 86400000, dev: deviceId, reg: registered
    }));
    var out = { token: token, user: publicUser_(user), sessionDays: SESSION_DAYS, registered: registered };
    if (newSecret) out.deviceSecret = newSecret;
    return out;
  }
  function purgeSessions_(props) {
    var all = props.getProperties(), now = Date.now();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('UIS_') !== 0) return;
      try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
    });
  }
  function session_(token) {
    if (!token) throw apiError_('no_session', 'Not logged in');
    var raw = PropertiesService.getScriptProperties().getProperty('UIS_' + token);
    if (!raw) throw apiError_('no_session', 'Session expired, please log in again');
    var s = JSON.parse(raw);
    if (s.exp < Date.now()) throw apiError_('no_session', 'Session expired, please log in again');
    if (s.reg) { // device registration can be revoked by deleting it from UI_DEVICES
      var d = devices_()[s.dev];
      if (!d) s.reg = false;
    }
    return s;
  }
  function auth_(sess) {
    var user = findUser_(sess.u);
    if (!user || !user.active) throw apiError_('no_session', 'User disabled');
    return user;
  }
  /**
   * Who did this op. Normally the session's user. A colleague who logged in on the
   * registered reception computer during an outage is accepted by name (op.by), only
   * through a session of that registered computer; it is marked in UI_Log.
   */
  function actor_(op, sessionUser, sess, deviceId) {
    var by = String(op.by || '').trim().toLowerCase();
    if (!by || by === sessionUser.username) return { user: sessionUser, via: 'session' };
    if (!sess.reg || sess.dev !== String(deviceId || '')) {
      throw apiError_('forbidden', 'Only the registered reception computer can send operations for another user');
    }
    var u = findUser_(by);
    if (!u || !u.active) throw apiError_('forbidden', 'Unknown or disabled user ' + by);
    return { user: u, via: 'offline-login on device' };
  }
  function publicUser_(u) { return { username: u.username, name: u.name, role: u.role }; }

  // ---------- pull ----------
  function pull(body) {
    var sess = session_(body.token);
    var me = auth_(sess);
    var out = {
      me: publicUser_(me),
      registered: !!sess.reg,
      serverTime: new Date().toISOString(),
      catalog: readCatalog_(),
      guests: readGuests_(),
      shift: shiftState_()
    };
    if (sess.reg) {
      // Hashes let the registered reception computer check passwords during an outage.
      out.users = readUsers_().filter(function (u) { return u.active && u.hash; }).map(function (u) {
        return { username: u.username, name: u.name, role: u.role, hash: u.hash, salt: u.salt, rounds: HASH_ROUNDS };
      });
    }
    return out;
  }
  function readCatalog_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s || s.getLastRow() < 2) return [];
    return s.getRange(2, 1, s.getLastRow() - 1, 2).getValues()
      .filter(function (r) { return String(r[0]).trim() !== ''; })
      .map(function (r) { return { name: String(r[0]).trim(), price: num_(r[1]) }; });
  }
  function readGuests_() {
    var names = {};
    function add(sheetName, col) {
      var s = ss_().getSheetByName(sheetName);
      if (!s || s.getLastRow() < 2) return;
      s.getRange(2, col, s.getLastRow() - 1, 1).getValues().forEach(function (r) {
        var n = String(r[0]).trim(); if (n) names[n] = true;
      });
    }
    add(SHEETS.feed, 3);
    add(SHEETS.newGuest, 6);
    return Object.keys(names).sort();
  }
  function shiftRows_() {
    var s = sheet_(SHEETS.shifts);
    if (s.getLastRow() < 2) return [];
    return s.getRange(2, 1, s.getLastRow() - 1, SHIFTS_HEADER.length).getValues();
  }
  /**
   * Current shift as the spreadsheet sees it, plus the status of the last 20 shifts
   * (so a device can tell "closed elsewhere" from "not arrived yet"), and a version
   * number that only grows, so a device can ignore an older answer that arrives late.
   */
  function shiftState_() {
    var rows = shiftRows_();
    var recent = {};
    rows.slice(-20).forEach(function (r) { recent[String(r[COL.id])] = String(r[COL.status]); });
    var log = ss_().getSheetByName(SHEETS.log);
    var version = log ? log.getLastRow() : 0;
    var last = rows[rows.length - 1];
    if (last && last[COL.status] === 'Open') {
      return { v: version, recent: recent, open: true, id: String(last[COL.id]), user: String(last[COL.user]),
        openedAt: iso_(last[COL.openedAt]), openingCash: num_(last[COL.openCash]) };
    }
    return { v: version, recent: recent, open: false, lastCashInBox: lastCashInBox_() };
  }
  function lastCashInBox_() {
    var s = ss_().getSheetByName(SHEETS.cash);
    if (!s || s.getLastRow() < 2) return 0;
    var rows = s.getRange(2, 1, s.getLastRow() - 1, 9).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i][4] !== '' && rows[i][4] !== null) return num_(rows[i][4]);
    }
    return 0;
  }

  // ---------- push ----------
  // Each handler: validate everything first, then write. Re-running it for the same
  // shiftId after a partial failure must not write twice.
  var HANDLERS = {
    shift_open: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var counted = amount_(p.cashCounted, 'cashCounted');
      if (!p.shiftId) throw apiError_('bad_payload', 'shiftId missing');
      var rows = shiftRows_();
      if (rows.some(function (r) { return String(r[COL.id]) === String(p.shiftId); })) {
        return { shiftId: p.shiftId, already: true }; // a previous attempt got this far
      }
      var last = rows[rows.length - 1];
      if (last && last[COL.status] === 'Open') throw apiError_('shift_already_open', 'A shift is already open (' + last[COL.user] + ')');
      var shifts = sheet_(SHEETS.shifts), cash = sheet_(SHEETS.cash);
      var reference = lastCashInBox_();
      var diff = counted - reference;
      var author = me.author || me.username;
      // UI_Shifts is written LAST as the "done" marker. The Cashouts&Cor row carries the
      // shift id in its comment, so a retry after a failure in between does not add it twice.
      var tag = '[' + p.shiftId + ']';
      var cashRows = cash.getLastRow() >= 2 ? cash.getRange(2, 8, cash.getLastRow() - 1, 1).getValues() : [];
      var already = cashRows.some(function (r) { return String(r[0]).indexOf(tag) >= 0; });
      if (!already) {
        appendAfterData_(cash, [dateOnly_(at), fmt_(at, 'HH:mm:ss'), '', diff, counted, '', author,
          (String(p.comment || '') + ' ' + tag).trim(), 'Opening'], [1]);
      }
      shifts.appendRow([String(p.shiftId), me.username, author, at, counted, diff, '', '', '', '', 'Open', '', String(p.comment || '')]);
      return { shiftId: p.shiftId, difference: diff };
    },
    shift_close: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var counted = amount_(p.cashCounted, 'cashCounted');
      var cashout = amount_(p.cashout === undefined ? 0 : p.cashout, 'cashout');
      var expected = amount_(p.expectedCash, 'expectedCash');
      var rows = shiftRows_();
      var idx = -1;
      rows.forEach(function (r, i) { if (String(r[COL.id]) === String(p.shiftId)) idx = i; });
      if (idx < 0) throw apiError_('unknown_shift', 'Unknown shift ' + p.shiftId);
      var rec = rows[idx];
      if (rec[COL.status] === 'Closed') {
        if (String(rec[COL.comment]).indexOf('{' + op.id + '}') >= 0) return { shiftId: p.shiftId, already: true };
        throw apiError_('shift_not_open', 'Shift already closed by ' + rec[COL.closedBy]);
      }
      if (rec[COL.user] !== me.username && me.role === 'staff') throw apiError_('forbidden', 'Only the shift owner or a manager can close it');
      var shifts = sheet_(SHEETS.shifts), cash = sheet_(SHEETS.cash), manual = sheet_(SHEETS.manual);
      var diff = counted + cashout - expected;
      var author = rec[COL.author] || me.author || me.username;
      var tag = '[' + p.shiftId + ']';
      var stamp = fmt_(at, 'yyyyMMddHHmmssSSS');
      // Partial-failure safe: each write checks whether a previous attempt already made it.
      var cashRows = cash.getLastRow() >= 2 ? cash.getRange(2, 8, cash.getLastRow() - 1, 2).getValues() : [];
      if (!cashRows.some(function (r) { return String(r[0]).indexOf(tag) >= 0 && r[1] === 'Closing'; })) {
        appendAfterData_(cash, [dateOnly_(at), fmt_(at, 'HH:mm:ss'), cashout, diff, counted, '', author,
          (String(p.comment || '') + ' ' + tag).trim(), 'Closing'], [1]);
      }
      // Same Cash-out line as the old Close Shift dialog (A date, B type, L amount, O author, Q timestamp).
      var mLast = lastRowIn_(manual, 1, 3);
      var stamps = mLast >= 2 ? manual.getRange(2, 17, mLast - 1, 1).getValues() : [];
      if (!stamps.some(function (r) { return String(r[0]) === stamp; })) {
        var line = [];
        for (var i = 0; i < 17; i++) line.push('');
        line[0] = dateOnly_(at); line[1] = 'Cash-out'; line[11] = cashout; line[14] = author; line[16] = stamp;
        var r = mLast + 1;
        manual.getRange(r, 17).setNumberFormat('@');
        manual.getRange(r, 1, 1, 17).setValues([line]);
        manual.getRange(r, 1).setNumberFormat('dd/MM/yyyy');
      }
      // UI_Shifts last: it is the "done" marker. {opId} lets a retry recognise its own close.
      var comment = [rec[COL.comment], String(p.comment || ''), '{' + op.id + '}'].filter(String).join(' | ');
      shifts.getRange(idx + 2, COL.closedAt + 1, 1, 7).setValues([[at, counted, cashout, diff, 'Closed', me.username, comment]]);
      return { shiftId: p.shiftId, difference: diff };
    }
  };

  function push(body) {
    var sess = session_(body.token);
    var sessionUser = auth_(sess);
    var ops = Array.isArray(body.ops) ? body.ops.slice(0, 100) : [];
    return withLock_(function () {
      var log = sheet_(SHEETS.log);
      var seen = {};
      if (log.getLastRow() >= 2) {
        log.getRange(2, 2, log.getLastRow() - 1, 8).getValues().forEach(function (r) {
          seen[String(r[0])] = { status: String(r[6]), detail: String(r[7]) };
        });
      }
      var results = [];
      for (var k = 0; k < ops.length; k++) {
        var op = ops[k];
        var id = String(op && op.id || '');
        if (!id) { results.push({ id: id, status: 'rejected', error: 'bad_op', message: 'Operation without id' }); continue; }
        if (seen[id]) {
          // Same answer as the first time, so a lost response never hides a refusal.
          var first = seen[id];
          var again = { id: id, status: first.status === 'rejected' ? 'rejected' : 'duplicate' };
          if (first.status === 'rejected') { again.error = first.detail.split(':')[0]; again.message = first.detail.split(': ').slice(1).join(': '); }
          results.push(again);
          continue;
        }
        var res, status, detail = '', who = sessionUser.username;
        try {
          var a = actor_(op, sessionUser, sess, body.deviceId);
          who = a.user.username + (a.via === 'session' ? '' : ' (' + a.via + ')');
          var h = HANDLERS[op.type];
          if (!h) throw apiError_('unknown_type', 'Unknown operation ' + op.type);
          res = h(op, a.user);
          status = 'applied';
        } catch (e) {
          // Not a business refusal (Google timeout, quota...): stop here, do not mark
          // as seen, report what was done so far; the device retries the rest later.
          if (!e.apiCode || e.apiCode === 'missing_sheet') {
            console.error(e);
            SpreadsheetApp.flush();
            return { results: results, shift: shiftState_(), partial: true };
          }
          status = 'rejected';
          detail = e.apiCode + ': ' + e.message;
          res = { error: e.apiCode, message: e.message };
        }
        log.appendRow([new Date(), id, String(body.deviceId || ''), who, String(op.type),
          String(op.payload && op.payload.shiftId || ''), String(op.at || ''), status, detail,
          JSON.stringify(op.payload || {}).slice(0, 5000)]);
        seen[id] = { status: status, detail: detail };
        var out = { id: id, status: status };
        Object.keys(res || {}).forEach(function (key) { out[key] = res[key]; });
        results.push(out);
      }
      SpreadsheetApp.flush();
      return { results: results, shift: shiftState_() };
    });
  }

  function handle(e) {
    try {
      var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
      var fn = { login: login, pull: pull, push: push }[body.action];
      if (!fn) throw apiError_('unknown_action', 'Unknown action');
      var out = fn(body);
      out.ok = true;
      return json_(out);
    } catch (err) {
      if (!err.apiCode) console.error(err);
      return json_({ ok: false, error: err.apiCode || 'server_error', message: err.apiCode ? err.message : 'Server error' });
    }
  }

  return { handle: handle, setup: setup, _hash: hashPassword_ };
})();

function doPost(e) { return UIAPI.handle(e); }
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'reception-ui' }))
    .setMimeType(ContentService.MimeType.JSON);
}
/** Run once from the editor: creates UI_Users, UI_Log and UI_Shifts. */
function UI_setup() { Logger.log(UIAPI.setup()); }
