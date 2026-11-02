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
    entries: 'Entries',
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
  function logout(body) {
    if (body.token) PropertiesService.getScriptProperties().deleteProperty('UIS_' + body.token);
    return {};
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
    // Checked only by the computer itself: never more than staff rights.
    var asStaff = {}; Object.keys(u).forEach(function (k) { asStaff[k] = u[k]; }); asStaff.role = 'staff';
    return { user: asStaff, via: 'offline-login on device' };
  }
  function publicUser_(u) { return { username: u.username, name: u.name, role: u.role, author: u.author || u.username }; }

  // ---------- pull ----------
  function pull(body) {
    var sess = session_(body.token);
    var me = auth_(sess);
    var out = {
      me: publicUser_(me),
      registered: !!sess.reg,
      serverTime: new Date().toISOString(),
      catalog: readCatalog_(),
      payments: readPayments_(),
      guests: readGuests_(),
      shift: shiftState_(),
      lines: readLines_(),
      cashbox: readCashbox_()
    };
    if (sess.reg) {
      // Hashes let the registered reception computer check passwords during an outage.
      out.users = readUsers_().filter(function (u) { return u.active && u.hash; }).map(function (u) {
        return { username: u.username, name: u.name, role: u.role, author: u.author || u.username, hash: u.hash, salt: u.salt, rounds: HASH_ROUNDS };
      });
    }
    return out;
  }
  /**
   * Products sold at the desk, as in the old product dialog: the names listed under
   * Service (L), Transport (M) and Tour (N) in Data activities, with price (B) and
   * cost (C) looked up by name in column A. The column header is the sub-category.
   */
  function readCatalog_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s || s.getLastRow() < 2) return [];
    var n = s.getLastRow() - 1;
    var head = s.getRange(1, 1, 1, 14).getValues()[0];
    var rows = s.getRange(2, 1, n, 14).getValues();
    var byName = {};
    rows.forEach(function (r) {
      var name = String(r[0]).trim();
      if (name && !(name in byName)) byName[name] = { price: num_(r[1]), cost: num_(r[2]) };
    });
    var out = [], seen = {};
    [11, 12, 13].forEach(function (c) { // L, M, N
      var category = String(head[c]).trim();
      rows.forEach(function (r) {
        var name = String(r[c]).trim();
        if (!name || !byName[name] || seen[category + '|' + name]) return;
        seen[category + '|' + name] = true;
        out.push({ name: name, category: category, price: byName[name].price, cost: byName[name].cost });
      });
    });
    return out;
  }
  function readPayments_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    var list = s ? s.getRange('Q2:Q20').getValues().map(function (r) { return String(r[0]).trim(); }).filter(String) : [];
    if (list.indexOf('Unpaid') < 0) list.push('Unpaid');
    return list;
  }
  function readGuests_() {
    var names = {};
    function add(sheetName, col) {
      var s = ss_().getSheetByName(sheetName);
      if (!s || s.getLastRow() < 2) return;
      s.getRange(2, col, s.getLastRow() - 1, 1).getValues().forEach(function (r) {
        var n = String(r[0]).trim(); if (n && !/^Expense/.test(n) && n !== 'Cash Supply') names[n] = true;
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
    var version = version_();
    var last = rows[rows.length - 1];
    if (last && last[COL.status] === 'Open') {
      return { v: version, recent: recent, open: true, id: String(last[COL.id]), user: String(last[COL.user]),
        openedAt: iso_(last[COL.openedAt]), openingCash: num_(last[COL.openCash]) };
    }
    return { v: version, recent: recent, open: false, lastCashInBox: lastCashInBox_() };
  }
  function version_() {
    var log = ss_().getSheetByName(SHEETS.log);
    return Math.max(Number(PropertiesService.getScriptProperties().getProperty('UI_V') || 0), log ? log.getLastRow() : 0);
  }
  /** Who entered each line through the interface: line id -> username (from UI_Log sale entries). */
  function soldBy_() {
    var log = ss_().getSheetByName(SHEETS.log), out = {};
    if (!log || log.getLastRow() < 2) return out;
    log.getRange(2, 4, log.getLastRow() - 1, 7).getValues().forEach(function (r) {
      if (r[4] !== 'applied') return;
      try {
        if (r[1] === 'sale') {
          var user = String(r[0]).split(' ')[0];
          (JSON.parse(r[6]).lines || []).forEach(function (l) { out[String(l.ts)] = user; });
        } else if (r[1] === 'expense') {
          out[String(JSON.parse(r[6]).ts)] = String(r[0]).split(' ')[0];
        } else if (r[1] === 'settle') { // a paid bill keeps its seller under its new id
          (JSON.parse(r[6]).items || []).forEach(function (it) { if (out[String(it.oldTs)]) out[String(it.newTs)] = out[String(it.oldTs)]; });
        }
      } catch (e) { /* truncated payload */ }
    });
    return out;
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

  // ---------- ledger (Entries / Entries Manual) ----------
  // Same layout the old dialogs write. Entries: A date, B type, C sub-category, D object,
  // E qty, F unit price, G total, H real price, I author, J unit cost, K cost, L real cost,
  // M guest, N payment type, O timestamp (17 digits, text), P month correction, Q comment.
  // Entries Manual: A..E, H, L, M, N like Entries; O author, P comment, Q timestamp;
  // F, G, J, K hold formulas and are never written.
  var E = { date: 0, type: 1, sub: 2, obj: 3, qty: 4, unit: 5, total: 6, real: 7, author: 8, unitCost: 9,
    cost: 10, realCost: 11, guest: 12, pay: 13, ts: 14, past: 15, comment: 16 };
  var M = { date: 0, type: 1, sub: 2, obj: 3, qty: 4, real: 7, realCost: 11, guest: 12, pay: 13, author: 14, comment: 15, ts: 16 };
  var TS_TZ = 'Asia/Singapore'; // timestamps follow the script timezone of the old dialogs (UTC+8)
  var LINE_DAYS = 21;           // paid lines sent to the device; unpaid ones are always sent

  function tsOf_(d) { return Utilities.formatDate(d, TS_TZ, 'yyyyMMddHHmmssSSS'); }
  function isTs_(v) { return /^\d{17}$/.test(String(v)); }
  /** Text read back from the sheet loses its protecting apostrophe: add it again before writing. */
  function safe_(v) { return typeof v === 'string' && /^[=+@]/.test(v) ? "'" + v : v; }
  /** A sheet cell never starts a formula from typed text. */
  function text_(v, max, field) {
    var t = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
    if (max && t.length > max) throw apiError_('bad_payload', field + ' is too long');
    return /^[=+@]/.test(t) ? "'" + t : t;
  }
  function qty_(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0 || n > 1000) throw apiError_('bad_amount', 'Invalid quantity');
    return Math.round(n * 100) / 100;
  }
  /** Sub-category of an expense item: header of the first column (L..O) listing it, scanning row by row like the old dialog. */
  function expenseCategory_(obj) {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s || !obj) return '';
    var head = s.getRange(1, 12, 1, 4).getValues()[0];
    var rows = s.getRange(2, 12, 29, 4).getValues();
    for (var i = 0; i < rows.length; i++) for (var j = 0; j < 4; j++) if (String(rows[i][j]).trim() === obj) return String(head[j]).trim();
    return '';
  }
  function payment_(v, allowUnpaid) {
    var p = String(v || '').trim();
    var ok = readPayments_();
    if (ok.indexOf(p) < 0 || (!allowUnpaid && p === 'Unpaid')) throw apiError_('bad_payment', 'Unknown payment type ' + p);
    return p;
  }
  function entries_() {
    var s = sheet_(SHEETS.entries);
    var last = lastRowIn_(s, 1, 15);
    var rows = last >= 2 ? s.getRange(2, 1, last - 1, 17).getValues() : [];
    var byTs = {}, all = {};
    rows.forEach(function (r, i) { var t = String(r[E.ts]); if (isTs_(t)) { byTs[t] = i + 2; (all[t] = all[t] || []).push(i + 2); } });
    return { sheet: s, rows: rows, last: last, byTs: byTs, all: all, row: function (ts) { var n = byTs[ts]; return n ? rows[n - 2] : null; } };
  }
  function manual_() {
    var s = sheet_(SHEETS.manual);
    var last = lastRowIn_(s, 1, 3);
    var ts = last >= 2 ? s.getRange(2, M.ts + 1, last - 1, 1).getValues() : [];
    var byTs = {}, all = {};
    ts.forEach(function (r, i) { var t = String(r[0]); if (isTs_(t)) { byTs[t] = i + 2; (all[t] = all[t] || []).push(i + 2); } });
    return { sheet: s, last: last, byTs: byTs, all: all };
  }
  /** Appends Entries rows (17 columns) after the last data row; timestamps stay text. */
  function appendEntries_(ent, rows) {
    if (!rows.length) return;
    var r = ent.last + 1;
    ent.sheet.getRange(r, E.ts + 1, rows.length, 1).setNumberFormat('@');
    ent.sheet.getRange(r, 1, rows.length, 17).setValues(rows.map(function (row) { return row.map(safe_); }));
    ent.sheet.getRange(r, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    ent.last += rows.length;
  }
  /** Appends Entries Manual rows from Entries-shaped rows, leaving the formula columns alone. */
  function appendManual_(man, entryRows) {
    if (!entryRows.length) return;
    var r = man.last + 1, n = entryRows.length, s = man.sheet;
    var rng = s.getRange(r, 1, n, 17);
    var formulas = rng.getFormulas(), current = rng.getValues();
    var keep = function (i, c) { return formulas[i][c] || current[i][c]; }; // F, G, J, K stay as they are
    var rows = entryRows.map(function (e, i) {
      return [e[E.date], e[E.type], e[E.sub], e[E.obj], e[E.qty], keep(i, 5), keep(i, 6), e[E.real], '', keep(i, 9), keep(i, 10),
        e[E.realCost], e[E.guest], e[E.pay], e[E.author], e[E.comment], e[E.ts]].map(function (v, c) {
          return [5, 6, 9, 10].indexOf(c) >= 0 ? v : safe_(v);
        });
    });
    s.getRange(r, M.ts + 1, n, 1).setNumberFormat('@');
    rng.setValues(rows); // one write: a failure never leaves half a row
    s.getRange(r, 1, n, 1).setNumberFormat('dd/MM/yyyy');
    man.last += n;
  }
  /**
   * Row numbers come from a read made a moment ago; another script may have moved rows
   * since. Check the id is still on that row, otherwise fail without writing (retried later).
   */
  function verify_(sheet, rowNo, col, ts) {
    if (String(sheet.getRange(rowNo, col).getValue()) !== String(ts)) throw new Error('Rows moved in ' + sheet.getName() + '; will retry');
  }
  var same_ = function (a, b) { return String(a).replace(/^'/, '') === String(b).replace(/^'/, ''); };
  function lineOut_(r) {
    return { ts: String(r[E.ts]), date: iso_(r[E.date]), type: String(r[E.type]), category: String(r[E.sub]),
      object: String(r[E.obj]), qty: r[E.qty] === '' ? null : num_(r[E.qty]), unit: num_(r[E.unit]),
      total: num_(r[E.real] !== '' ? r[E.real] : r[E.total]), unitCost: num_(r[E.unitCost]), cost: num_(r[E.realCost]),
      author: String(r[E.author]), guest: String(r[E.guest]), payment: String(r[E.pay]),
      comment: String(r[E.comment]), past: String(r[E.past]) === 'Past' };
  }
  var REFUND_MARKS = ['Refunded', 'Refunding'];
  /** Lines the device keeps: everything unpaid, plus the last LINE_DAYS days. */
  function readLines_() {
    if (!ss_().getSheetByName(SHEETS.entries)) return [];
    var from = tsOf_(new Date(Date.now() - LINE_DAYS * 86400000));
    var sold = soldBy_();
    return entries_().rows.filter(function (r) {
      var t = String(r[E.ts]);
      return isTs_(t) && (t >= from || String(r[E.pay]) === 'Unpaid');
    }).map(function (r) { var l = lineOut_(r); if (sold[l.ts]) l.soldBy = sold[l.ts]; return l; });
  }
  /** The open shift of this user, if any (staff may only change lines of their own open shift). */
  function myOpenShift_(me) {
    var rows = shiftRows_(), last = rows[rows.length - 1];
    return last && last[COL.status] === 'Open' && String(last[COL.user]) === me.username ? last : null;
  }
  function assertCanChange_(me, row) {
    if (me.role !== 'staff') return;
    var sh = myOpenShift_(me);
    var ts = String(row[E.ts]);
    var ok = sh && ['Income', 'Expense'].indexOf(String(row[E.type])) >= 0 && REFUND_MARKS.indexOf(String(row[E.comment])) < 0 &&
      soldBy_()[ts] === me.username && ts >= tsOf_(new Date(sh[COL.openedAt]));
    if (!ok) throw apiError_('forbidden', 'Only sales and expenses you entered during your own open shift can be changed. Ask a manager.');
  }
  function lineTs_(v, at) {
    var t = String(v || '');
    if (!isTs_(t)) throw apiError_('bad_payload', 'Invalid line id');
    // Must be close to when the operation happened (device clock sanity).
    var near = tsOf_(new Date(at.getTime() - 86400000)), far = tsOf_(new Date(at.getTime() + 86400000));
    if (t < near || t > far) throw apiError_('bad_time', 'Line id does not match the operation time');
    return t;
  }

  // ---------- cash box (Cashouts&Cor) ----------
  // Phantom cash, as the old Phantom Cash dialogs wrote it: A date, B time, D difference
  // (+ change not given yet, − money not received yet), E cash in the box after it,
  // G author, H comment, I "Phantom". Solving it adds a "Phantom Salvation" row with the
  // opposite difference and marks the original "Phantom Solved".
  var PHANTOM_TYPES = ['Phantom', 'Phantom Solved', 'Phantom Salvation'];
  var TAG_RE = /\s*\[(P[\w-]+)\]\s*$/;
  /** Every row of Cashouts&Cor with its sheet row number, its time as a line id, and our tag if any. */
  function cashRows_() {
    var s = ss_().getSheetByName(SHEETS.cash);
    if (!s || s.getLastRow() < 2) return [];
    var n = s.getLastRow() - 1;
    var shown = s.getRange(2, 1, n, 2).getDisplayValues(), vals = s.getRange(2, 1, n, 9).getValues();
    return vals.map(function (r, i) {
      var ts = '';
      try {
        var d = Utilities.parseDate(shown[i][0] + ' ' + shown[i][1], tz_(), 'dd/MM/yyyy HH:mm:ss');
        if (d && !isNaN(d.getTime())) ts = tsOf_(d);
      } catch (e) { /* unreadable date: no time for this row */ }
      var comment = String(r[7]), m = comment.match(TAG_RE);
      return { row: i + 2, ts: ts, cashout: r[2], diff: num_(r[3]), box: r[4], author: String(r[6]),
        comment: m ? comment.replace(TAG_RE, '') : comment, pid: m ? m[1] : '', type: String(r[8]) };
    });
  }
  /** Identifies a phantom row written without our tag (old dialog): time, difference, author. */
  function phantomKey_(c) { return c.pid ? c.pid : c.ts ? 'K' + c.ts.slice(0, 14) + '|' + c.diff + '|' + c.author : 'R' + c.row; }
  /** Phantom rows the device needs: every unsolved one, and all of the last LINE_DAYS days. */
  function readCashbox_() {
    var from = tsOf_(new Date(Date.now() - LINE_DAYS * 86400000));
    return cashRows_().filter(function (c) {
      return PHANTOM_TYPES.indexOf(c.type) >= 0 && (c.type === 'Phantom' || c.ts >= from);
    }).map(function (c) {
      return { key: phantomKey_(c), pid: c.pid, ts: c.ts, diff: c.diff, comment: c.comment, author: c.author, type: c.type };
    });
  }
  /** Staff record cash-box events only during their own open shift; managers at any time. */
  function assertCashRight_(me) {
    if (me.role === 'staff' && !myOpenShift_(me)) throw apiError_('forbidden', 'Open your shift first.');
  }
  function pid_(v) {
    var s = String(v || '');
    if (!/^P[\w-]{6,40}$/.test(s)) throw apiError_('bad_payload', 'Invalid id');
    return s;
  }
  function appendCash_(at, diff, author, comment, type, pid) {
    var cash = sheet_(SHEETS.cash);
    var box = lastCashInBox_() + diff;
    appendAfterData_(cash, [dateOnly_(at), fmt_(at, 'HH:mm:ss'), '', diff, box, '', author,
      safe_((String(comment || '') + ' [' + pid + ']').trim()), type], [1]);
    return box;
  }

  // ---------- push ----------
  // Each handler: validate everything first, then write. Re-running it for the same
  // shiftId after a partial failure must not write twice.
  var HANDLERS = {
    /** One sale: one line per product and per guest, all with the same payment type. */
    sale: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var pay = payment_(p.payment, true);
      var lines = Array.isArray(p.lines) ? p.lines : [];
      if (!lines.length || lines.length > 200) throw apiError_('bad_payload', 'A sale needs 1 to 200 lines');
      var author = me.author || me.username;
      var day = dateOnly_(at);
      var rows = lines.map(function (l) {
        var ts = lineTs_(l.ts, at);
        var q = qty_(l.qty), unit = amount_(l.unit, 'price'), unitCost = amount_(l.unitCost || 0, 'cost');
        var total = Math.round(q * unit), cost = Math.round(q * unitCost);
        var guest = text_(l.guest, 120, 'Guest'), obj = text_(l.object, 200, 'Product');
        if (!guest || !obj) throw apiError_('bad_payload', 'Guest and product are required');
        return [day, 'Income', text_(l.category, 60, 'Category'), obj, q, unit, total, total, author,
          unitCost, cost, cost, guest, pay, ts, '', text_(l.comment, 300, 'Comment')];
      });
      var seen = {};
      rows.forEach(function (r) { if (seen[r[E.ts]]) throw apiError_('bad_payload', 'Duplicate line id'); seen[r[E.ts]] = 1; });
      var ent = entries_(), man = manual_();
      // A line id already in the sheet is either our own earlier attempt (same guest and
      // product: skip it) or a collision with another line (refuse, nothing written).
      rows.forEach(function (r) {
        var ex = ent.row(r[E.ts]);
        if (ex && (!same_(ex[E.guest], r[E.guest]) || !same_(ex[E.obj], r[E.obj]))) {
          throw apiError_('ts_collision', 'The sheet already has a different line with this id. Nothing was written; check with a manager before entering the sale again.');
        }
      });
      appendEntries_(ent, rows.filter(function (r) { return !ent.byTs[r[E.ts]]; }));
      appendManual_(man, rows.filter(function (r) { return !man.byTs[r[E.ts]]; }));
      var res = { lines: rows.length };
      if (!shiftRows_().some(function (r) { return r[COL.status] === 'Open'; })) res.warning = 'Recorded while no shift was open';
      return res;
    },
    /** Change quantity, unit price, payment type, guest or comment of one line (every copy of it). */
    line_update: function (op, me) {
      var p = op.payload || {};
      parseAt_(op.at);
      var ts = String(p.ts);
      var ent = entries_();
      var rowNo = ent.byTs[ts];
      if (!rowNo) throw apiError_('line_not_found', 'This line is no longer in the sheet');
      var row = ent.rows[rowNo - 2].slice();
      assertCanChange_(me, row);
      var before = lineOut_(row);
      var isExp = String(row[E.type]) === 'Expense';
      if (String(row[E.obj]) === 'Cash Supply') throw apiError_('bad_payload', 'A cash supply cannot be edited; a manager can delete it and enter it again');
      if (isExp && (p.qty !== undefined || p.unit !== undefined || p.guest !== undefined)) {
        throw apiError_('bad_payload', 'An expense only has an amount, a payment type and a comment');
      }
      if (isExp && p.payment === 'Paid to Partner') throw apiError_('bad_payment', 'Paid to Partner is not used for expenses');
      if (p.qty !== undefined || p.unit !== undefined) {
        var q = p.qty !== undefined ? qty_(p.qty) : (num_(row[E.qty]) || 1);
        var unit = p.unit !== undefined ? amount_(p.unit, 'price') : num_(row[E.unit]);
        var total = Math.round(q * unit);
        row[E.qty] = q; row[E.unit] = unit; row[E.total] = total; row[E.real] = total;
        if (row[E.unitCost] !== '') { var cost = Math.round(q * num_(row[E.unitCost])); row[E.cost] = cost; row[E.realCost] = cost; }
      }
      if (p.amount !== undefined) {
        if (String(row[E.type]) !== 'Expense') throw apiError_('bad_payload', 'Only an expense has an amount to change');
        row[E.realCost] = amount_(p.amount, 'amount');
        if (row[E.realCost] <= 0) throw apiError_('bad_amount', 'Invalid amount');
      }
      if (p.payment !== undefined) row[E.pay] = payment_(p.payment, true);
      if (p.guest !== undefined) { row[E.guest] = text_(p.guest, 120, 'Guest'); if (!row[E.guest]) throw apiError_('bad_payload', 'Guest is required'); }
      if (p.comment !== undefined && REFUND_MARKS.indexOf(String(row[E.comment])) < 0) row[E.comment] = text_(p.comment, 300, 'Comment');
      var man = manual_();
      (ent.all[ts] || []).forEach(function (n) {
        verify_(ent.sheet, n, E.ts + 1, ts);
        ent.sheet.getRange(n, E.qty + 1, 1, 4).setValues([[row[E.qty], row[E.unit], row[E.total], row[E.real]]]);
        ent.sheet.getRange(n, E.cost + 1, 1, 4).setValues([[row[E.cost], row[E.realCost], row[E.guest], row[E.pay]]]);
        ent.sheet.getRange(n, E.comment + 1).setValue(row[E.comment]);
      });
      (man.all[ts] || []).forEach(function (n) {
        verify_(man.sheet, n, M.ts + 1, ts);
        man.sheet.getRange(n, M.qty + 1).setValue(row[E.qty]);
        man.sheet.getRange(n, M.real + 1).setValue(row[E.real]);
        man.sheet.getRange(n, M.realCost + 1, 1, 3).setValues([[row[E.realCost], row[E.guest], row[E.pay]]]);
        man.sheet.getRange(n, M.comment + 1).setValue(row[E.comment]);
      });
      return { audit: { before: before } };
    },
    /** Remove a line, every copy of it in both sheets (bottom-up so row numbers stay valid). */
    line_delete: function (op, me) {
      var p = op.payload || {};
      parseAt_(op.at);
      var ts = String(p.ts);
      var ent = entries_(), man = manual_();
      var eRows = (ent.all[ts] || []).slice().sort(function (a, b) { return b - a; });
      var mRows = (man.all[ts] || []).slice().sort(function (a, b) { return b - a; });
      if (!eRows.length && !mRows.length) return { already: true };
      var before = null;
      if (eRows.length) { before = lineOut_(ent.rows[eRows[0] - 2]); assertCanChange_(me, ent.rows[eRows[0] - 2]); }
      else if (me.role === 'staff') throw apiError_('forbidden', 'Ask a manager to delete this line');
      mRows.forEach(function (n) { verify_(man.sheet, n, M.ts + 1, ts); man.sheet.deleteRow(n); });
      eRows.forEach(function (n) { verify_(ent.sheet, n, E.ts + 1, ts); ent.sheet.deleteRow(n); });
      return { audit: { before: before } };
    },
    /**
     * A guest pays lines left Unpaid: payment type, author and timestamp change, as in the
     * old billing dialog. Each item can be resumed if an earlier attempt stopped half-way.
     */
    settle: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var pay = payment_(p.payment, false);
      var items = Array.isArray(p.items) ? p.items : [];
      if (!items.length || items.length > 200) throw apiError_('bad_payload', 'Nothing to settle');
      var author = me.author || me.username;
      var ent = entries_(), man = manual_();
      var todo = [];
      items.forEach(function (it) {
        var oldTs = String(it.oldTs), newTs = lineTs_(it.newTs, at);
        var rowNo = ent.byTs[oldTs];
        if (!rowNo) {
          if (!ent.byTs[newTs]) throw apiError_('line_not_found', 'An unpaid line is no longer in the sheet');
          todo.push({ entries: false, mRow: man.byTs[oldTs], oldTs: oldTs, newTs: newTs }); // finish Manual if needed
          return;
        }
        var row = ent.rows[rowNo - 2];
        var ours = String(row[E.pay]) === pay && String(row[E.author]) === author; // stopped half-way before
        if (String(row[E.pay]) !== 'Unpaid' && !ours) {
          throw apiError_('already_paid', String(row[E.obj]) + ' for ' + row[E.guest] + ' is already paid (' + row[E.pay] + ')');
        }
        todo.push({ entries: true, rowNo: rowNo, mRow: man.byTs[oldTs], oldTs: oldTs, newTs: newTs, before: lineOut_(row) });
      });
      todo.forEach(function (t) {
        if (t.entries) {
          verify_(ent.sheet, t.rowNo, E.ts + 1, t.oldTs);
          ent.sheet.getRange(t.rowNo, E.author + 1).setValue(author);
          ent.sheet.getRange(t.rowNo, E.ts + 1).setNumberFormat('@');
          ent.sheet.getRange(t.rowNo, E.pay + 1, 1, 2).setValues([[pay, t.newTs]]); // payment and id together
        }
        if (t.mRow) {
          verify_(man.sheet, t.mRow, M.ts + 1, t.oldTs);
          man.sheet.getRange(t.mRow, M.ts + 1).setNumberFormat('@');
          man.sheet.getRange(t.mRow, M.pay + 1, 1, 4).setValues([[pay, author, man.sheet.getRange(t.mRow, M.comment + 1).getValue(), t.newTs]]);
        }
      });
      var done = todo.filter(function (t) { return t.entries; });
      return { settled: done.length, audit: { before: done.map(function (t) { return t.before; }) } };
    },
    /**
     * Refund (all or part) of a paid sale: one Expense line in the current shift, and the
     * sale marked Refunded, with the exact words the commission scripts look for.
     * A retry finishes whatever an interrupted attempt left undone.
     */
    refund: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var newTs = lineTs_(p.newTs, at);
      var pay = payment_(p.payment, false);
      var amount = amount_(p.amount, 'amount');
      var origTs = String(p.origTs);
      var ent = entries_(), man = manual_();
      var rowNo = ent.byTs[origTs];
      var orig = rowNo ? ent.rows[rowNo - 2] : null;
      var existing = ent.row(newTs);
      if (existing) {
        if (String(existing[E.type]) !== 'Expense' || String(existing[E.comment]) !== 'Refunding' ||
            (orig && (!same_(existing[E.guest], orig[E.guest]) || !same_(existing[E.obj], orig[E.obj])))) {
          throw apiError_('ts_collision', 'The sheet already has a different line with this id. Nothing was written.');
        }
      } else {
        if (!orig) throw apiError_('line_not_found', 'The sale is no longer in the sheet');
        if (String(orig[E.type]) !== 'Income' || String(orig[E.obj]) === 'Cash Supply') throw apiError_('bad_payload', 'Only a sale can be refunded');
        if (String(orig[E.pay]) === 'Unpaid') throw apiError_('bad_payload', 'This sale was never paid; delete or change it instead');
        if (String(orig[E.comment]) === 'Refunded') throw apiError_('already_refunded', 'This sale was already refunded');
        if (me.role === 'staff' && pay !== String(orig[E.pay])) throw apiError_('forbidden', 'Refund with the same payment type as the sale (' + orig[E.pay] + '), or ask a manager');
        var paid = num_(orig[E.real] !== '' ? orig[E.real] : orig[E.total]);
        if (amount <= 0 || amount > paid) throw apiError_('bad_amount', 'Refund must be between 1 and ' + paid);
      }
      var row = existing || [dateOnly_(at), 'Expense', orig[E.sub], orig[E.obj], orig[E.qty], '', '', '', me.author || me.username,
        '', '', amount, orig[E.guest], pay, newTs, '', 'Refunding'];
      if (!existing) appendEntries_(ent, [row]);
      if (rowNo && String(orig[E.comment]) !== 'Refunded') { verify_(ent.sheet, rowNo, E.ts + 1, origTs); ent.sheet.getRange(rowNo, E.comment + 1).setValue('Refunded'); }
      if (!man.byTs[newTs]) appendManual_(man, [row]);
      var mOrig = man.byTs[origTs];
      if (mOrig) { verify_(man.sheet, mOrig, M.ts + 1, origTs); man.sheet.getRange(mOrig, M.comment + 1).setValue('Refunded'); }
      return existing ? { already: true } : { audit: { before: lineOut_(orig), reason: String(p.reason || '').slice(0, 300) } };
    },
    /**
     * A daily expense, as the old Daily Expenses dialog wrote it: B Expense, C the header of
     * the Data activities column (L..O) where the item is listed, D the item, L the amount,
     * M "Expense"+item, N payment; and "Expense"+item added to New guest once.
     */
    expense: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var ts = lineTs_(p.ts, at);
      var pay = payment_(p.payment, true);
      if (pay === 'Paid to Partner') throw apiError_('bad_payment', 'Paid to Partner is not used for expenses');
      var amount = amount_(p.amount, 'amount');
      if (amount <= 0) throw apiError_('bad_amount', 'Invalid amount');
      var obj = String(p.object || '').trim();
      var category = expenseCategory_(obj);
      if (!category) throw apiError_('bad_payload', obj + ' is not in Data activities (columns L to O)');
      var day = dateOnly_(at);
      if (p.date) {
        var ds = String(p.date);
        var parsed = /^\d{4}-\d{2}-\d{2}$/.test(ds) ? Utilities.parseDate(ds, tz_(), 'yyyy-MM-dd') : null;
        if (!parsed || fmt_(parsed, 'yyyy-MM-dd') !== ds || ds > fmt_(at, 'yyyy-MM-dd') ||
            ds < fmt_(new Date(at.getTime() - 31 * 86400000), 'yyyy-MM-dd')) throw apiError_('bad_time', 'The date must be within the last month');
        day = parsed;
      }
      var guest = 'Expense' + obj;
      var row = [day, 'Expense', category, obj, '', '', '', '', me.author || me.username, '', '', amount, guest, pay, ts, '', text_(p.comment, 300, 'Comment')];
      var ent = entries_(), man = manual_();
      var ex = ent.row(ts);
      if (ex && (String(ex[E.type]) !== 'Expense' || !same_(ex[E.obj], obj) || num_(ex[E.realCost]) !== amount ||
          String(ex[E.pay]) !== pay || String(ex[E.author]) !== row[E.author])) {
        throw apiError_('ts_collision', 'The sheet already has a different line with this id. Nothing was written.');
      }
      if (!ex) appendEntries_(ent, [row]);
      if (!man.byTs[ts]) appendManual_(man, [row]);
      var ng = ss_().getSheetByName(SHEETS.newGuest);
      if (ng) {
        var last = lastRowIn_(ng, 1, 6);
        var known = last >= 1 && ng.getRange(1, 3, last, 1).getValues().some(function (r) { return String(r[0]) === guest; });
        if (!known) ng.getRange(last + 1, 3, 1, 4).setValues([[guest, new Date(), '', guest]]);
      }
      return ex ? { already: true } : {};
    },
    /** Phantom cash: change not given yet (+) or money not received yet (−), with a reason. */
    phantom: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var pid = pid_(p.pid);
      var given = p.notGiven ? amount_(p.notGiven, 'amount') : 0, received = p.notReceived ? amount_(p.notReceived, 'amount') : 0;
      if ((given > 0) === (received > 0)) throw apiError_('bad_amount', 'Enter either cash not given or cash not received');
      var comment = text_(p.comment, 300, 'Comment');
      if (!String(comment).trim()) throw apiError_('bad_payload', 'Say what the phantom cash is about');
      assertCashRight_(me);
      if (cashRows_().some(function (c) { return c.pid === pid; })) return { already: true };
      var diff = given > 0 ? given : -received;
      return { box: appendCash_(at, diff, me.author || me.username, comment, 'Phantom', pid), difference: diff };
    },
    /** Settles a phantom: opposite difference on a "Phantom Salvation" row, original marked "Phantom Solved". */
    phantom_solve: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var pid = pid_(p.pid);
      assertCashRight_(me);
      var rows = cashRows_();
      var orig = rows.filter(function (c) { return (c.type === 'Phantom' || c.type === 'Phantom Solved') && phantomKey_(c) === String(p.target); })[0];
      if (!orig) throw apiError_('line_not_found', 'This phantom cash is no longer in the sheet');
      if (rows.some(function (c) { return c.pid === pid && c.type !== 'Phantom Salvation'; })) throw apiError_('bad_payload', 'Invalid id');
      var done = rows.some(function (c) { return c.pid === pid && c.type === 'Phantom Salvation'; });
      if (!done && orig.type === 'Phantom Solved') throw apiError_('already_solved', 'This phantom cash was already solved');
      var cash = sheet_(SHEETS.cash);
      // The row to mark must still be this phantom (same difference, author and comment) before anything is written.
      var still = function () {
        var r = cash.getRange(orig.row, 1, 1, 9).getValues()[0];
        return num_(r[3]) === orig.diff && String(r[6]) === orig.author && String(r[7]).replace(TAG_RE, '') === orig.comment &&
          PHANTOM_TYPES.indexOf(String(r[8])) >= 0;
      };
      if (!still()) throw new Error('Rows moved in Cashouts&Cor; will retry');
      // Like the old Solved button: the Salvation row has no comment of its own.
      if (!done) appendCash_(at, -orig.diff, me.author || me.username, '', 'Phantom Salvation', pid);
      if (orig.type !== 'Phantom Solved') cash.getRange(orig.row, 9).setValue('Phantom Solved');
      return done ? { already: true } : { difference: -orig.diff };
    },
    /**
     * Cash brought to the desk from outside, as the old Cash Supply dialog wrote it: an Income
     * line "Cash Supply" paid Cash (H) and an Expense line paid "Extern Cash" (L), both
     * C "Other", M "Cash Supply"; "Cash Supply" added once to New guest column F.
     * The two lines get their own ids (the old dialog gave both the same timestamp).
     */
    cash_supply: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var ts = lineTs_(p.ts, at), ts2 = lineTs_(p.ts2, at);
      if (ts === ts2) throw apiError_('bad_payload', 'Duplicate line id');
      var amount = amount_(p.amount, 'amount');
      if (amount <= 0) throw apiError_('bad_amount', 'Invalid amount');
      assertCashRight_(me);
      var author = me.author || me.username, day = dateOnly_(at);
      var rows = [
        [day, 'Income', 'Other', 'Cash Supply', '', '', '', amount, author, '', '', '', 'Cash Supply', 'Cash', ts, '', ''],
        [day, 'Expense', 'Other', 'Cash Supply', '', '', '', '', author, '', '', amount, 'Cash Supply', 'Extern Cash', ts2, '', '']
      ];
      var ent = entries_(), man = manual_();
      rows.forEach(function (r) {
        var ex = ent.row(r[E.ts]);
        if (ex && (String(ex[E.type]) !== r[E.type] || !same_(ex[E.obj], 'Cash Supply') || String(ex[E.author]) !== author ||
            num_(r[E.type] === 'Income' ? ex[E.real] : ex[E.realCost]) !== amount)) {
          throw apiError_('ts_collision', 'The sheet already has a different line with this id. Nothing was written.');
        }
      });
      var already = !!(ent.byTs[ts] && ent.byTs[ts2]);
      appendEntries_(ent, rows.filter(function (r) { return !ent.byTs[r[E.ts]]; }));
      appendManual_(man, rows.filter(function (r) { return !man.byTs[r[E.ts]]; }));
      var ng = ss_().getSheetByName(SHEETS.newGuest);
      if (ng) {
        var last = lastRowIn_(ng, 6, 1);
        var known = last >= 1 && ng.getRange(1, 6, last, 1).getValues().some(function (r) { return String(r[0]) === 'Cash Supply'; });
        if (!known) ng.getRange(last + 1, 6).setValue('Cash Supply');
      }
      return already ? { already: true } : {};
    },
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
      // Expected cash from the sheet itself: opening + cash sales - cash paid out in the shift.
      var from = tsOf_(new Date(rec[COL.openedAt])), to = tsOf_(at);
      var sheetExpected = num_(rec[COL.openCash]);
      if (ss_().getSheetByName(SHEETS.entries)) entries_().rows.forEach(function (r) {
        var t = String(r[E.ts]);
        if (!isTs_(t) || t < from || t >= to || String(r[E.pay]) !== 'Cash') return;
        if (r[E.type] === 'Income') sheetExpected += num_(r[E.real] !== '' ? r[E.real] : r[E.total]);
        else if (r[E.type] === 'Expense') sheetExpected -= num_(r[E.realCost]);
      });
      // Phantom cash recorded during the shift is in the box too (the old dialog started from the last E).
      cashRows_().forEach(function (c) {
        // Whole seconds: the sheet keeps only HH:mm:ss for these rows.
        if (PHANTOM_TYPES.indexOf(c.type) >= 0 && c.ts && c.ts.slice(0, 14) >= from.slice(0, 14) && c.ts.slice(0, 14) <= to.slice(0, 14)) sheetExpected += c.diff;
      });
      var diff = counted + cashout - sheetExpected;
      var author = rec[COL.author] || me.author || me.username;
      var tag = '[' + p.shiftId + ']';
      var stamp = tsOf_(at);
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
      var note = expected !== sheetExpected ? 'screen expected ' + expected + ', sheet ' + sheetExpected : '';
      var comment = [rec[COL.comment], String(p.comment || ''), note, '{' + op.id + '}'].filter(String).join(' | ');
      shifts.getRange(idx + 2, COL.closedAt + 1, 1, 7).setValues([[at, counted, cashout, diff, 'Closed', me.username, comment]]);
      return { shiftId: p.shiftId, difference: diff, expected: sheetExpected };
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
          res = h(op, a.user) || {};
          status = 'applied';
          if (res.audit || res.warning) detail = JSON.stringify({ warning: res.warning, audit: res.audit }).slice(0, 20000);
          delete res.audit;
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
        var vBefore = version_();
        log.appendRow([new Date(), id, String(body.deviceId || ''), who, String(op.type),
          String(op.payload && (op.payload.shiftId || op.payload.saleId || op.payload.ts || op.payload.origTs || op.payload.pid) || ''), String(op.at || ''), status, detail,
          JSON.stringify(op.payload || {}).slice(0, 45000)]);
        PropertiesService.getScriptProperties().setProperty('UI_V', String(vBefore + 1));
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
      var fn = { login: login, pull: pull, push: push, logout: logout }[body.action];
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
