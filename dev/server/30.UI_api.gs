/**
 * 30.UI_api.gs — Back end of the offline reception interface.
 *
 * Deployed as a Web App that runs as the OWNER, so staff never need access
 * to the spreadsheet. Everything lives inside the UIAPI namespace to avoid
 * colliding with the ~600 global functions already in this project.
 * Only four globals are added: doPost, doGet, UI_setup, UI_eveningCheck (daily trigger).
 *
 * Protocol: POST, body = JSON text (Content-Type text/plain, no CORS preflight)
 *   {action:"login", username, password, deviceId, deviceSecret?, registerDevice?}
 *   {action:"pull",  token}
 *   {action:"push",  token, deviceId, ops:[{id, type, at, by, payload}]}
 *   {action:"ping"}  (is the sheet reachable: closing a shift is refused offline)
 * Response: JSON {ok:true, ...} or {ok:false, error:"code", message}
 *
 * Reliability rules
 *  - A business refusal (bad amount, shift already open...) is final: logged as "rejected".
 *  - Bad data (a field of the wrong type) or a missing sheet: that op alone is "rejected"
 *    (but "partial" when part of it was already written, e.g. the money).
 *  - Any other failure (Google timeout, quota, lock...) or the 18 s time budget stops the push
 *    WITHOUT marking the op as seen (partial; budget:true for the time budget, the device
 *    sends the rest at once), so the device retries it later.
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
    newGuest: 'New guest',
    sg: 'SG',
    gearLog: 'Gear_Log',
    gearSettings: 'Gear_Settings',
    settlements: 'Settlements',
    protect: 'Protect'
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
  /** Every tab an operation writes to, checked before its first write (never half an operation). */
  function needSheets_(names) { names.forEach(sheet_); }
  // Writes done by the current operation: a missing tab found after one of them is not a refusal.
  var writes_ = 0;
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
    if (d.getTime() - Date.now() > 10 * 60000) throw apiError_('bad_time', 'Device clock is in the future');
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
    writes_++;
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
    log.getRange('C:J').setNumberFormat('@'); // device text never becomes a formula
    var shifts = ensureSheet_(SHEETS.shifts, SHIFTS_HEADER);
    shifts.getRange('A:A').setNumberFormat('@');
    // A new sheet must not look older than a test copy the devices already know.
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty('UI_V')) props.setProperty('UI_V', String(1000000));
    var g = gearSetup_();
    withLock_(hashPendingPasswords_);
    var trig = installCountTrigger_();
    return 'UI sheets ready: ' + [SHEETS.users, SHEETS.log, SHEETS.shifts, SHEETS.gearLog, SHEETS.gearSettings].join(', ') +
      (g.skipped.length ? '. SG numbers NOT imported (unexpected format, add them by hand): ' + g.skipped.join(', ') : '') +
      '. Evening check reminder: ' + trig;
  }
  /** Daily 21:30 (WITA) trigger that emails when the evening check is not done; installed once. */
  var COUNT_TRIGGER_FN = 'UI_eveningCheck';
  function installCountTrigger_() {
    try {
      var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === COUNT_TRIGGER_FN; });
      if (has) return 'already installed';
      ScriptApp.newTrigger(COUNT_TRIGGER_FN).timeBased().atHour(21).nearMinute(30).everyDays(1).inTimezone('Asia/Makassar').create();
      return 'installed';
    } catch (e) {
      console.error(e);
      return 'NOT installed (' + e.message + ')';
    }
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
          role: (role === 'manager' || role === 'admin' || role === 'gear') ? role : 'staff',
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
    } else if (deviceId && body.registerDevice && user.role !== 'staff' && user.role !== 'gear') {
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
    if (sessionUser.role === 'gear') throw apiError_('forbidden', 'The gear account only sends its own operations');
    if (!sess.reg || sess.dev !== String(deviceId || '')) {
      throw apiError_('forbidden', 'Only the registered reception computer can send operations for another user');
    }
    var u = findUser_(by);
    if (!u || !u.active) throw apiError_('forbidden', 'Unknown or disabled user ' + by);
    if (u.role === 'gear') throw apiError_('forbidden', 'Gear accounts do not use the reception');
    // Checked only by the computer itself: never more than staff rights.
    var asStaff = {}; Object.keys(u).forEach(function (k) { asStaff[k] = u[k]; }); asStaff.role = 'staff';
    return { user: asStaff, via: 'offline-login on device' };
  }
  // ---------- one login for the reception and the bar POS (owner 09/11) ----------
  // The reception app asks for a pass (its user's session); it opens the POS with it; the POS (its own session, account
  // bar-pos, manager) asks who it is. A pass works once, within 2 minutes; nothing else leaves the sheet.
  var POS_PASS_MS = 120000;
  function pos_pass(body) {
    var me = auth_(session_(body.token));
    if (me.role === 'gear') throw apiError_('forbidden', 'Gear accounts do not use the bar POS');
    var props = PropertiesService.getScriptProperties(), all = props.getProperties(), now = Date.now();
    Object.keys(all).forEach(function (k) { if (k.indexOf('UIPOS_') === 0) { try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); } } });
    var code = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('UIPOS_' + code, JSON.stringify({ u: me.username, exp: now + POS_PASS_MS }));
    return { pass: code, validMs: POS_PASS_MS };
  }
  function pos_verify(body) {
    var caller = auth_(session_(body.token));
    if (caller.role !== 'manager' && caller.role !== 'admin') throw apiError_('forbidden', 'Only the POS account can check a pass');
    var key = 'UIPOS_' + String(body.pass || '').replace(/[^a-z0-9]/gi, '').slice(0, 80), props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(key);
    if (raw) props.deleteProperty(key); // once
    var p = raw ? JSON.parse(raw) : null;
    if (!p || p.exp < Date.now()) throw apiError_('bad_pass', 'This link expired: open the POS again from the reception');
    var u = findUser_(p.u);
    if (!u || !u.active) throw apiError_('bad_pass', 'User disabled');
    return { user: publicUser_(u) };
  }
  // The other way (owner 09/11): the POS (its session, account bar-pos) asks a pass for the Rabbit-System user linked to
  // the person logged in on the POS (owner, manager or reception there); it opens this app in a new window with it, and
  // the app logs in with the pass (pass_login) like with a password. A pass works once, within 2 minutes.
  function rs_pass(body) {
    var caller = auth_(session_(body.token));
    if (caller.role !== 'manager' && caller.role !== 'admin') throw apiError_('forbidden', 'Only the POS account can ask a pass');
    var u = findUser_(body.username);
    if (!u || !u.active) throw apiError_('bad_user', 'Unknown or disabled Rabbit-System user ' + String(body.username || ''));
    if (u.role === 'gear') throw apiError_('forbidden', 'Gear accounts use the gear app');
    if (u.username === caller.username) throw apiError_('forbidden', 'The POS account itself does not use the reception');
    var props = PropertiesService.getScriptProperties(), all = props.getProperties(), now = Date.now();
    Object.keys(all).forEach(function (k) { if (k.indexOf('UIRS_') === 0) { try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); } } });
    var code = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('UIRS_' + code, JSON.stringify({ u: u.username, exp: now + POS_PASS_MS, by: caller.username }));
    return { pass: code, validMs: POS_PASS_MS };
  }
  function pass_login(body) {
    var key = 'UIRS_' + String(body.pass || '').replace(/[^a-z0-9]/gi, '').slice(0, 80), props = PropertiesService.getScriptProperties();
    var raw = props.getProperty(key);
    if (raw) props.deleteProperty(key); // once
    var p = raw ? JSON.parse(raw) : null;
    if (!p || p.exp < Date.now()) { Utilities.sleep(800); throw apiError_('bad_pass', 'This link expired: open the reception again from the POS, or log in with your password'); }
    var user = findUser_(p.u);
    if (!user || !user.active || user.role === 'gear') throw apiError_('bad_pass', 'User disabled');
    var deviceId = String(body.deviceId || ''), devs = devices_();
    var registered = !!(deviceId && body.deviceSecret && devs[deviceId] && devs[deviceId].secret === String(body.deviceSecret)); // never registers a device
    purgeSessions_(props);
    var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('UIS_' + token, JSON.stringify({ u: user.username, exp: Date.now() + SESSION_DAYS * 86400000, dev: deviceId, reg: registered }));
    return { token: token, user: publicUser_(user), sessionDays: SESSION_DAYS, registered: registered, via: 'pos' };
  }
  /**
   * Bar POS shared guest bill (owner 10/11): the POS sends the guest-bill lines of its open bills at once as Unpaid and
   * asks here, before it takes a payment and every minute, which of them the reception settled meanwhile.
   * { ts: [17-digit ids] } -> { v: 2, lines: { ts: 'unpaid' | 'paid' | 'gone' } } ('paid' = still under that id but
   * paid, or settled at the reception: a settle op of UI_Log moved it to a new id; 'gone' = not in Entries and never
   * settled: deleted by hand or by a sheet script. Owner 11/11: a line deleted in the sheet was taken by the POS as paid
   * at the reception; since v 2 the POS sends it again instead).
   */
  function pos_lines(body) {
    var caller = auth_(session_(body.token));
    if (caller.role !== 'manager' && caller.role !== 'admin') throw apiError_('forbidden', 'Only the POS account reads its lines');
    var ts = Array.isArray(body.ts) ? body.ts.slice(0, 500) : [];
    var ent = entries_(), out = {};
    ts.forEach(function (t) {
      t = String(t);
      if (!isTs_(t)) return;
      var r = ent.row(t);
      out[t] = !r ? 'gone' : String(r[E.pay]) === 'Unpaid' ? 'unpaid' : 'paid';
    });
    var missing = Object.keys(out).filter(function (t) { return out[t] === 'gone'; });
    if (missing.length) {
      var settled = settledTs_();
      missing.forEach(function (t) { if (settled[t]) out[t] = 'paid'; });
    }
    return { v: 2, lines: out };
  }
  /** Old ids of the lines settled at the reception (settle ops of UI_Log, newest 3000 rows): { oldTs: true }. */
  function settledTs_() {
    var log = ss_().getSheetByName(SHEETS.log), out = {};
    if (!log || log.getLastRow() < 2) return out;
    var n = Math.min(3000, log.getLastRow() - 1), first = log.getLastRow() - n + 1;
    log.getRange(first, 5, n, 6).getValues().forEach(function (r) {   // E type .. J payload
      if (String(r[0]) !== 'settle' || String(r[3]) !== 'applied') return;
      try { (JSON.parse(String(r[5])).items || []).forEach(function (it) { if (it && it.oldTs) out[String(it.oldTs)] = true; }); } catch (e) { /* cut payload */ }
    });
    return out;
  }
  /**
   * Where the bar POS runs (owner 11/11): its address on the wifi, set in the POS's own Options (owner) and sent here by
   * the POS account; every reception computer's "Bar POS" button opens it (pull: posUrl). Nothing written in the code.
   * { url: 'http://192.168.1.131:8080' | '' } -> { url }
   */
  function pos_address(body) {
    var caller = auth_(session_(body.token));
    if (caller.role !== 'manager' && caller.role !== 'admin') throw apiError_('forbidden', 'Only the POS account sets its address');
    var url = String(body.url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[\w.-]+(:\d{1,5})?$/i.test(url)) throw apiError_('bad_request', 'Address like http://192.168.1.131:8080');
    var props = PropertiesService.getScriptProperties();
    if (url) props.setProperty('UI_POS_URL', url); else props.deleteProperty('UI_POS_URL');
    return { url: url };
  }
  // The guest names only (owner 11/11): a light read the bar POS makes every 5 minutes and when a name is not found,
  // instead of the whole pull (every line of the reception) every 30 minutes.
  function pos_guests(body) {
    var caller = auth_(session_(body.token));
    if (caller.role !== 'manager' && caller.role !== 'admin') throw apiError_('forbidden', 'Only the POS account reads the guests');
    // owner 12/11: the BAR Cash-out rows written from the reception app count in the bar till too (the POS skips its own: `me`)
    return { guests: readGuests_(), bar: readBarCashouts_(), me: caller.author || caller.username };
  }
  // One staff list (owner 09/11): the POS (its session, account bar-pos) reads who works here; no passwords leave.
  function pos_staff(body) {
    var caller = auth_(session_(body.token));
    if (caller.role !== 'manager' && caller.role !== 'admin') throw apiError_('forbidden', 'Only the POS account can read the staff');
    return { staff: readUsers_().filter(function (u) { return u.username !== caller.username; }).map(function (u) {
      return { username: u.username, name: u.name, role: u.role, active: u.active };
    }) };
  }
  function publicUser_(u) { return { username: u.username, name: u.name, role: u.role, author: u.author || u.username }; }

  // ---------- pull ----------
  function pull(body) {
    var sess = session_(body.token);
    var me = auth_(sess);
    if (me.role === 'gear' || body.app === 'gear') { // the gear app sees only what the blind check allows (any account used in it)
      return { me: publicUser_(me), registered: !!sess.reg, serverTime: new Date().toISOString(), shift: { v: version_() },
        gear: ss_().getSheetByName(SHEETS.sg) ? gearForStaffApp_(gearState_(), null) : null };
    }
    // Refresh button: run the Beds24 sync first, so new nights and payments are in this answer.
    var beds24 = null;
    if (body.beds24 && typeof B24 !== 'undefined') {
      try { beds24 = B24.run(); } catch (e) { beds24 = { error: String(e && e.message || e).slice(0, 200) }; }
    }
    var ent = ss_().getSheetByName(SHEETS.entries) ? entries_() : null; // read once for the whole answer
    var out = {
      me: publicUser_(me),
      registered: !!sess.reg,
      serverTime: new Date().toISOString(),
      catalog: readCatalog_(),
      payments: readPayments_(),
      expenses: readExpenseItems_(),
      partnerLabels: partnerLabelsOut_(),
      guests: readGuests_(),
      shift: shiftState_(),
      lines: readLines_(ent),
      cashbox: readCashbox_(),
      partners: readPartners_(ent),
      settlement: lastSettlement_(),
      gear: ss_().getSheetByName(SHEETS.sg) ? gearForReception_(gearState_(), ent) : null,
      bar: readBarCashouts_(), // TEMPORARY (bar cash-out): remove with the BAR CASH-OUT block below
      commissions: readCommissions_(ent, me),
      activities: readActivities_(),
      features: FEATURES,
      posUrl: PropertiesService.getScriptProperties().getProperty('UI_POS_URL') || '', // where the bar POS runs (pos_address)
      beds24: beds24
    };
    if (sess.reg) {
      // Hashes let the registered reception computer check passwords during an outage: staff only.
      out.users = readUsers_().filter(function (u) { return u.active && u.hash && u.role === 'staff'; }).map(function (u) {
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
  // Data activities lists are read from row 2 to the sheet's last row, so rows added later count.
  // The newer lists are found by their header in row 1 (columns may be moved), with a fallback column.
  /** 1-based column of Data activities whose row-1 header is name, else fallback (0: none). */
  function daCol_(s, name, fallback) {
    var w = s.getLastColumn();
    var head = w > 0 ? s.getRange(1, 1, 1, w).getValues()[0] : [];
    for (var i = 0; i < head.length; i++) if (String(head[i]).trim().toLowerCase() === name.toLowerCase()) return i + 1;
    return fallback || 0;
  }
  /** The non-empty values of one column, row 2 to the last row, trimmed, in order. */
  function daList_(s, col) {
    var n = s.getLastRow() - 1;
    if (!col || n < 1) return [];
    return s.getRange(2, col, n, 1).getValues().map(function (r) { return String(r[0]).trim(); }).filter(String);
  }
  /** Payment types (column "Payment type", Q): the Sell screen's payment picker. */
  function readPayments_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    var list = s ? daList_(s, daCol_(s, 'Payment type', 17)) : [];
    if (list.indexOf('Unpaid') < 0) list.push('Unpaid');
    return list;
  }
  // ---------- commissions (tab "Commis." / old "Assign sellers" dialog) ----------
  // Commis. pays 20% of the margin (H or G, minus L or K) of each Entries line whose T (Seller)
  // is the staff email, P (month correction) not "Past", object not in Data activities
  // "Commission exceptions", guest not a partner payment row (words of "Partner lines").
  // The old dialog let the desk move a partner sale ("-" product, not refunded, not a settled
  // payment row, not Past, not the Sunset Boat / Bike Suma) to another seller (T in Entries,
  // R in Entries Manual) and emailed the change to the Protect "Auth Base" addresses.
  var COMMISSION_RATE = 0.2;
  var SELLER_SKIP = ['-sunset boat', '-bike suma']; // never reassigned by the old dialog
  var FEATURES = ['commissions', 'catalog_edit'];    // what this server supports (the app hides the rest)
  var lc_ = function (v) { return String(v === null || v === undefined ? '' : v).trim().toLowerCase(); };
  /** Active reception people with an author email (UI_Users D): who can be a seller. */
  function sellers_() {
    return readUsers_().filter(function (u) { return u.active && u.role !== 'gear' && /@/.test(u.author); })
      .map(function (u) { return { email: u.author, name: u.name, username: u.username }; });
  }
  /** Data activities "Commission exceptions" (V), the whole column, found by its header; created if missing. */
  function commissionExceptions_() {
    var s = ss_().getSheetByName(SHEETS.catalog), set = {};
    if (!s) return set;
    daList_(s, daCol_(s, 'Commission exceptions', 0)).forEach(function (o) { set[lc_(o)] = true; });
    return set;
  }
  function ensureExceptionsCol_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s || daCol_(s, 'Commission exceptions', 0)) return;
    writes_++;
    s.getRange(1, s.getLastColumn() + 1).setValue('Commission exceptions');
  }
  var isPast_ = function (r) { return /past/i.test(String(r[E.past])); }; // SEARCH("Past", P) in Commis.
  /** The line counts in Commis. (current period: not Past) for its Seller. */
  function isCommission_(r, exc, payLabels) {
    return /@/.test(String(r[E.seller] || '')) && !isPast_(r) && !exc[lc_(r[E.obj])] &&
      payLabels.indexOf(String(r[E.guest]).trim()) < 0 && isTs_(String(r[E.ts]));
  }
  /** The old dialog's rule for moving a line to another seller (plus: it must count in Commis.). */
  function canMoveSeller_(r, exc, payLabels) {
    var obj = String(r[E.obj]).trim();
    return isCommission_(r, exc, payLabels) && obj.charAt(0) === '-' && SELLER_SKIP.indexOf(obj.toLowerCase()) < 0 &&
      REFUND_ANY.indexOf(String(r[E.comment]).trim()) < 0 && String(r[E.status] || '').trim() !== 'Settled';
  }
  /** The commission lines of the current period: my own, or everybody's for a manager. */
  function readCommissions_(ent, me) {
    if (!ent) return null;
    var exc = commissionExceptions_(), pl = partnerLabels_().all, mine = lc_(me.author), all = me.role !== 'staff';
    var seen = {}, lines = [];
    ent.rows.forEach(function (r) {
      var t = String(r[E.ts]);
      if (seen[t] || !isCommission_(r, exc, pl)) return;
      var seller = String(r[E.seller]).trim();
      if (!all && lc_(seller) !== mine) return;
      seen[t] = true; // a line copied twice by the old sync counts once here
      var margin = priceOf_(r) - costOf_(r);
      lines.push({ ts: t, date: iso_(r[E.date]), object: String(r[E.obj]), guest: String(r[E.guest]), price: priceOf_(r), cost: costOf_(r),
        amount: Math.round(margin * COMMISSION_RATE), seller: seller, canMove: canMoveSeller_(r, exc, pl) });
    });
    return { rate: COMMISSION_RATE, all: all, staff: sellers_().map(function (u) { return { email: u.email, name: u.name }; }), lines: lines };
  }

  // ---------- activities editor (Data activities: Tour and Transport) ----------
  // Every activity is in column A ("Activity", price in B "Selling Price", cost in C "Purchase
  // prices") AND in the list of its sub-category (header "Tour" or "Transport", N / M today):
  // the old dialogs read the list, then look the price up by name in A.
  var ACT_CATS = ['Tour', 'Transport'];
  function actLayout_(s) {
    var L = { a: daCol_(s, 'Activity', 1), b: daCol_(s, 'Selling Price', 2), c: daCol_(s, 'Purchase prices', 3), lists: {} };
    ACT_CATS.forEach(function (c) { L.lists[c] = daCol_(s, c, c === 'Tour' ? 14 : 13); });
    ['Service', 'Transport', 'Tour', 'Other'].forEach(function (c, i) { L.lists[c] = L.lists[c] || daCol_(s, c, 12 + i); });
    if (L.b !== L.a + 1 || L.c !== L.a + 2) throw apiError_('bad_sheet', 'Data activities: Selling Price and Purchase prices must follow Activity');
    return L;
  }
  var priceCell_ = function (v) { return v === '' || v === null || v === undefined || isNaN(num_(v)) || !/\d/.test(String(v)) ? null : num_(v); };
  /** Tour and Transport lists with price and cost from A..C; inA false when the name is missing from A. */
  function readActivities_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s || s.getLastRow() < 2) return [];
    var L = actLayout_(s), n = s.getLastRow() - 1;
    var a = s.getRange(2, L.a, n, 3).getValues(), byName = {};
    a.forEach(function (r) { var k = String(r[0]).trim(); if (k && !(k in byName)) byName[k] = r; });
    var out = [];
    ACT_CATS.forEach(function (cat) {
      var seen = {};
      daList_(s, L.lists[cat]).forEach(function (name) {
        if (seen[name]) return;
        seen[name] = true;
        var r = byName[name];
        out.push({ category: cat, name: name, inA: !!r, price: r ? priceCell_(r[1]) : null, cost: r ? priceCell_(r[2]) : null,
          costText: r && priceCell_(r[2]) === null ? String(r[2]).trim() : '' });
      });
    });
    return out;
  }
  /** Row numbers (1-based) in column col, rows 2..last, whose trimmed value is name. */
  function rowsWith_(s, col, name) {
    var n = s.getLastRow() - 1, out = [];
    if (n < 1) return out;
    s.getRange(2, col, n, 1).getValues().forEach(function (r, i) { if (String(r[0]).trim() === name) out.push(i + 2); });
    return out;
  }
  /** First empty row below the last value of columns col..col+w-1; its format copied from the row above. */
  function appendInCols_(s, col, w, values) {
    writes_++;
    var r = Math.max(lastRowIn_(s, col, w), 1) + 1;
    if (s.getMaxRows && r > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
    if (r > 2) s.getRange(r - 1, col, 1, w).copyTo(s.getRange(r, col, 1, w), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    s.getRange(r, col, 1, w).setValues([values]);
    return r;
  }
  /**
   * Removes the cells of rows `rows` from columns col..col+w-1 only: what is below moves up one
   * row inside those columns, the other columns and every cell format stay where they are
   * (values rewritten in place, never a row or a cell range deleted). Refused if a formula is there.
   */
  function compactOut_(s, col, w, rows) {
    if (!rows.length) return;
    var last = lastRowIn_(s, col, w);
    var rng = s.getRange(2, col, last - 1, w);
    if (rng.getFormulas().some(function (r) { return r.some(String); })) throw apiError_('bad_sheet', 'Data activities has a formula in that list: change it in the sheet');
    var drop = {}; rows.forEach(function (r) { drop[r] = true; });
    var vals = rng.getValues().filter(function (r, i) { return !drop[i + 2]; }).map(function (r) { return r.map(safe_); });
    while (vals.length < last - 1) vals.push(new Array(w).fill(''));
    writes_++;
    rng.setValues(vals);
  }
  function actName_(v, keepPlain) {
    var t = text_(v, 100, 'Name');
    if (!t || t === "'") throw apiError_('bad_payload', 'Type the activity name');
    if (/^'/.test(t)) throw apiError_('bad_payload', 'A name cannot start with = + or @');
    // Partner products start with "-" (partner bills and the old seller dialog look for it).
    return keepPlain || t.charAt(0) === '-' ? t : '-' + t;
  }
  function actMoney_(v, field, optional) {
    if (optional && (v === '' || v === null || v === undefined)) return '';
    return amount_(v, field);
  }

  /**
   * Buttons of the Expenses screen: column "Expense buttons" of Data activities, in order, each
   * with its sub-category (only items listed under L..O can be written). Empty: the app keeps its own list.
   */
  function readExpenseItems_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s) return [];
    var cats = expenseCategories_(s), seen = {};
    return daList_(s, daCol_(s, 'Expense buttons', 0)).filter(function (o) {
      if (!cats[o] || seen[o]) return false;
      return (seen[o] = true);
    }).map(function (o) { return { object: o, category: cats[o] }; });
  }
  function readGuests_() {
    var names = {};
    function add(sheetName, col) {
      var s = ss_().getSheetByName(sheetName);
      if (!s || s.getLastRow() < 2) return;
      s.getRange(2, col, s.getLastRow() - 1, 1).getValues().forEach(function (r) {
        var n = String(r[0]).trim(); if (n && !/^Expense/.test(n) && n !== 'Cash Supply' && n !== 'Payment to Partner') names[n] = true;
      });
    }
    add(SHEETS.feed, 3);
    add(SHEETS.newGuest, 6);
    // owner 11/11: the Beds24 sync writes new guests straight into Entries (column M) and 24datafeed no longer
    // grows, so a guest who arrived lately (Maud…) was missing from the lists (reception and bar POS)
    add(SHEETS.entries, E.guest + 1);
    // owner 11/11: the staff are customers too (staff drinks / meals on their own bill): Data activities, column K
    // (Staff), K2 and K5:K30 (K1 is the title, K3 "Food" and K4 "Kos kosan" are not people)
    var da = ss_().getSheetByName(SHEETS.catalog);
    if (da) da.getRange(2, 11, 29, 1).getValues().forEach(function (r, i) {
      var n = String(r[0]).trim(); if (n && i !== 1 && i !== 2) names[n] = true;   // i 1, 2 = rows 3, 4
    });
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
  /**
   * Who entered each line through the interface: line id -> username (from UI_Log sale entries).
   * UI_Log only grows: within one request, later calls read only the rows added since.
   */
  var soldCache_ = null;
  function soldBy_() {
    var log = ss_().getSheetByName(SHEETS.log);
    if (!log || log.getLastRow() < 2) return {};
    var c = soldCache_ || (soldCache_ = { upTo: 1, map: {} }), out = c.map, last = log.getLastRow();
    if (last <= c.upTo) return out;
    var from = c.upTo + 1;
    c.upTo = last;
    log.getRange(from, 4, last - from + 1, 7).getValues().forEach(function (r) {
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
    cost: 10, realCost: 11, guest: 12, pay: 13, ts: 14, past: 15, comment: 16, status: 18, seller: 19 };
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
  /** Item -> sub-category: header of the first column (L..O) listing it, scanning row by row like the old dialog, to the last row. */
  function expenseCategories_(s) {
    var out = {}, n = s.getLastRow() - 1;
    if (n < 1) return out;
    var head = s.getRange(1, 12, 1, 4).getValues()[0];
    var rows = s.getRange(2, 12, n, 4).getValues();
    for (var i = 0; i < rows.length; i++) for (var j = 0; j < 4; j++) {
      var o = String(rows[i][j]).trim();
      if (o && !(o in out)) out[o] = String(head[j]).trim();
    }
    return out;
  }
  function expenseCategory_(obj) {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s || !obj) return '';
    return expenseCategories_(s)[obj] || '';
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
    var rows = last >= 2 ? s.getRange(2, 1, last - 1, 20).getValues() : []; // A..T (T Seller)
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
  /**
   * Appends Entries rows (17 columns) after the last data row; timestamps stay text.
   * withSeller: also writes column T (Seller) = the author's email, as the old dialogs did on
   * sales: the Commis. tab pays 20% of the margin of the lines whose Seller is the staff email.
   * Only for sales and gear charges (Income): an expense or a cash supply with a Seller would
   * change that staff's commission.
   */
  function appendEntries_(ent, rows, withSeller) {
    if (!rows.length) return;
    writes_++;
    var r = ent.last + 1;
    ent.sheet.getRange(r, E.ts + 1, rows.length, 1).setNumberFormat('@');
    ent.sheet.getRange(r, 1, rows.length, 17).setValues(rows.map(function (row) { return row.map(safe_); }));
    ent.sheet.getRange(r, 1, rows.length, 1).setNumberFormat('dd/MM/yyyy'); // like Entries Manual
    if (withSeller) ent.sheet.getRange(r, E.seller + 1, rows.length, 1).setValues(rows.map(function (row) {
      return [row[E.type] === 'Income' && /@/.test(String(row[E.author])) ? row[E.author] : (row.sellerName || '')];
    }));
    ent.last += rows.length;
  }
  /** Appends Entries Manual rows from Entries-shaped rows, leaving the formula columns alone. */
  function appendManual_(man, entryRows, colI) {
    if (!entryRows.length) return;
    writes_++;
    var r = man.last + 1, n = entryRows.length, s = man.sheet;
    var rng = s.getRange(r, 1, n, 17);
    var formulas = rng.getFormulas(), current = rng.getValues();
    var keep = function (i, c) { return formulas[i][c] || current[i][c]; }; // F, G, J, K stay as they are
    var rows = entryRows.map(function (e, i) {
      return [e[E.date], e[E.type], e[E.sub], e[E.obj], e[E.qty], keep(i, 5), keep(i, 6), e[E.real], (colI && colI[i]) || '', keep(i, 9), keep(i, 10),
        e[E.realCost], e[E.guest], e[E.pay], e[E.author], e[E.comment], e[E.ts]].map(function (v, c) {
          return [5, 6, 9, 10].indexOf(c) >= 0 ? v : safe_(v);
        });
    });
    s.getRange(r, M.ts + 1, n, 1).setNumberFormat('@');
    rng.setValues(rows); // one write: a failure never leaves half a row
    s.getRange(r, 1, n, 1).setNumberFormat('dd/MM/yyyy');
    // Seller of a Bar POS line (owner 11/11): column R, only where there is one (nothing else of R touched)
    entryRows.forEach(function (e, i) { if (e.sellerName) s.getRange(r + i, 18).setValue(safe_(e.sellerName)); });
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
  /** Product names (rental products of Gear_Settings): case and spaces do not matter (same rule as gearcore.js). */
  var nameKey_ = function (v) { return String(v === null || v === undefined ? '' : v).replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase(); };
  var sameName_ = function (a, b) { return nameKey_(a) === nameKey_(b); };
  function lineOut_(r) {
    return { ts: String(r[E.ts]), date: iso_(r[E.date]), type: String(r[E.type]), category: String(r[E.sub]),
      object: String(r[E.obj]), qty: r[E.qty] === '' ? null : num_(r[E.qty]), unit: num_(r[E.unit]),
      total: num_(r[E.real] !== '' ? r[E.real] : r[E.total]), unitCost: num_(r[E.unitCost]), cost: num_(r[E.realCost]),
      author: String(r[E.author]), guest: String(r[E.guest]), payment: String(r[E.pay]),
      comment: String(r[E.comment]), past: String(r[E.past]) === 'Past', bill: String(r[E.status] || '').trim() };
  }
  var REFUND_MARKS = ['Refunded', 'Refunding'];
  /** Lines the device keeps: everything unpaid, plus the last LINE_DAYS days. */
  function readLines_(ent) {
    if (!ent) return [];
    var from = tsOf_(new Date(Date.now() - LINE_DAYS * 86400000));
    var sold = soldBy_();
    return ent.rows.filter(function (r) {
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
      soldBy_()[ts] === me.username && ts >= tsOf_(new Date(sh[COL.openedAt])) && !String(row[E.status] || '').trim();
    if (!ok) throw apiError_('forbidden', 'Only sales and expenses you entered during your own open shift, not yet on a partner bill, can be changed. Ask a manager.');
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

  // ---------- partners (old "12." dialogs) ----------
  // A partner product is a name starting with "-" in Data activities (L, M, N, to the last row).
  // Entries S holds the billing status of a partner sale: "" not billed, "B_dd/MM-HH:mm" on that
  // bill, "Paid" once the bill is settled; the payment row itself has S "Settled".
  var BILL_RE = /^B_\d\d\/\d\d-\d\d:\d\d$/;
  // Entries M (Guest) of a settlement row. The words are read from the "Partner lines" column of
  // Data activities (row 2: we pay the partner, row 3: the partner pays us); these are the fallback.
  var PAY_TO_DEFAULT = 'Payment to Partner', PAY_FROM_DEFAULT = 'Payment From Partner', PAID_TO_PARTNER = 'Paid to Partner';
  function partnerLabels_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    var col = s ? daCol_(s, 'Partner lines', 0) : 0;
    var v = col && s.getLastRow() >= 2 ? s.getRange(2, col, 2, 1).getValues() : [[''], ['']];
    var to = String(v[0][0]).trim() || PAY_TO_DEFAULT, from = String(v[1][0]).trim() || PAY_FROM_DEFAULT;
    // Rows written with the default words before a rename are still payment rows.
    var all = [to, from, PAY_TO_DEFAULT, PAY_FROM_DEFAULT].filter(function (x, i, a) { return a.indexOf(x) === i; });
    return { to: to, from: from, all: all };
  }
  function partnerLabelsOut_() { var l = partnerLabels_(); return { to: l.to, from: l.from }; }
  var MAIL = { bills: 'therabbittreegilimeno@gmail.com', alerts: 'rabbittree.system.alerts.com@gmail.com' };
  function partnerItems_() {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s) return [];
    var out = [], seen = {};
    var add = function (name, group) {
      name = String(name).trim();
      if (name.charAt(0) === '-' && !seen[name]) { seen[name] = true; out.push({ object: name, group: group }); }
    };
    var last = s.getLastRow();
    if (last < 1) return out;
    var head = s.getRange(1, 12, 1, 3).getValues()[0];
    s.getRange(1, 12, last, 1).getValues().forEach(function (r) { add(r[0], String(head[0]).trim()); });
    if (last >= 2) s.getRange(2, 13, last - 1, 2).getValues().forEach(function (r) { add(r[0], String(head[1]).trim()); add(r[1], String(head[2]).trim()); });
    return out;
  }
  /** Header of the Data activities column (K..O, row 2 to the last row) listing the object: the sub-category of a payment row. */
  function partnerCategory_(obj) {
    var s = ss_().getSheetByName(SHEETS.catalog);
    if (!s || s.getLastRow() < 2) return '';
    var head = s.getRange(1, 11, 1, 5).getValues()[0], rows = s.getRange(2, 11, s.getLastRow() - 1, 5).getValues();
    for (var i = 0; i < rows.length; i++) for (var j = 0; j < 5; j++) if (String(rows[i][j]).trim() === obj) return String(head[j]).trim();
    return '';
  }
  var priceOf_ = function (r) { return num_(r[E.real] !== '' ? r[E.real] : r[E.total]); };
  var costOf_ = function (r) { return num_(r[E.realCost] !== '' ? r[E.realCost] : r[E.cost]); };
  /** A sale that can go on a partner bill: Income of a partner product, not a payment row nor a refund line. */
  var REFUND_ANY = ['Refunded', 'Refunding', 'Refund-ed', 'Refund-ing']; // the old dialog wrote the dashed forms
  /** set: partner objects; payLabels: partnerLabels_().all (read once by the caller). */
  function isPartnerSale_(r, set, payLabels) {
    return String(r[E.type]) === 'Income' && set[String(r[E.obj]).trim()] && payLabels.indexOf(String(r[E.guest])) < 0 &&
      REFUND_ANY.indexOf(String(r[E.comment]).trim()) < 0 && isTs_(String(r[E.ts]));
  }
  /** The sales of a bill that count, once per line id (a line copied twice by the old sync counts once). */
  function billLines_(ent, bill) {
    var set = {}, seen = {}, pl = partnerLabels_().all;
    partnerItems_().forEach(function (it) { set[it.object] = true; });
    return ent.rows.filter(function (r) {
      var t = String(r[E.ts]);
      if (String(r[E.status] || '').trim() !== bill || !isPartnerSale_(r, set, pl) || seen[t]) return false;
      return (seen[t] = true);
    });
  }
  /** What one line adds to the bill: its cost if the guest paid us, cost − price if the guest paid the partner. */
  function billNet_(r) { return Math.round(String(r[E.pay]) === PAID_TO_PARTNER ? costOf_(r) - priceOf_(r) : costOf_(r)); }
  /** Partner sales not settled yet (not billed, or on a bill), however old. */
  function readPartners_(ent) {
    var items = partnerItems_();
    var set = {};
    items.forEach(function (it) { set[it.object] = true; });
    var lines = [], seen = {}, pl = partnerLabels_().all;
    if (ent) ent.rows.forEach(function (r) {
      var st = String(r[E.status] || '').trim();
      if (!isPartnerSale_(r, set, pl) || !(st === '' || BILL_RE.test(st)) || seen[String(r[E.ts])]) return;
      seen[String(r[E.ts])] = true;
      lines.push({ ts: String(r[E.ts]), date: iso_(r[E.date]), object: String(r[E.obj]).trim(), qty: r[E.qty] === '' ? null : num_(r[E.qty]),
        price: priceOf_(r), cost: costOf_(r), guest: String(r[E.guest]), payment: String(r[E.pay]), comment: String(r[E.comment]), bill: st });
    });
    return { items: items, lines: lines };
  }
  /** The bill as the old dialogs printed it: per object, the lines paid at the Rabbit Tree, then those paid to the partner. */
  function billHtml_(title, by, when, rows) {
    var esc = function (v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var objects = [], by_ = {};
    rows.forEach(function (r) { var o = String(r[E.obj]).trim(); if (!by_[o]) { by_[o] = []; objects.push(o); } by_[o].push(r); });
    var html = '<html><head><style>body{font-family:Arial,sans-serif;margin:20px;text-align:center}table{width:100%;border-collapse:collapse}' +
      'th,td{padding:8px;text-align:center;border:1px solid #ddd}th{background:#91c5ed;color:#fff}.sub{font-weight:bold}.tot{font-weight:bold;font-size:18px}' +
      '.inv{font-weight:bold;font-size:24px;border-top:2px solid #000;border-bottom:2px solid #000}</style></head><body>' +
      '<h1>' + esc(title + ' (' + objects.join(', ') + ')') + '</h1><h2>Created by ' + esc(by) + '</h2><h3>' + esc(when) + '</h3><table>';
    var invoiced = 0;
    objects.forEach(function (o) {
      var sections = [['Paid at the rabbit tree', by_[o].filter(function (r) { return String(r[E.pay]) !== PAID_TO_PARTNER; })],
        ['Paid by the guest to the Partner', by_[o].filter(function (r) { return String(r[E.pay]) === PAID_TO_PARTNER; })]];
      var cat = 0;
      html += '<tr><th colspan="6">' + esc(o) + '</th></tr>';
      sections.forEach(function (sec) {
        if (!sec[1].length) return;
        html += '<tr><th colspan="6"><i>' + sec[0] + '</i></th></tr><tr><th>Date</th><th>Qty</th><th>Cost</th><th>Price Sold</th><th>Commission</th><th>Guest Name</th></tr>';
        var sub = 0;
        sec[1].forEach(function (r) {
          var net = billNet_(r);
          html += '<tr><td>' + esc(r[E.date] instanceof Date ? fmt_(r[E.date], 'dd/MM/yyyy') : r[E.date]) + '</td><td>' + esc(r[E.qty]) + '</td><td>' + costOf_(r) +
            '</td><td>' + priceOf_(r) + '</td><td>' + (String(r[E.pay]) === PAID_TO_PARTNER ? net : '') + '</td><td>' + esc(r[E.guest]) + '</td></tr>';
          sub += net;
        });
        html += '<tr class="sub"><td colspan="6">' + (sec[0] === 'Paid at the rabbit tree' ? 'Total Cost: ' : 'Total Commission: ') + sub.toFixed(2) + '</td></tr>';
        cat += sub;
      });
      html += '<tr class="tot"><td colspan="6">Total of Category: ' + cat.toFixed(2) + '</td></tr>';
      invoiced += cat;
    });
    return html + '<tr class="inv"><td colspan="6">Total Invoiced: ' + invoiced.toFixed(2) + '</td></tr>' +
      '<tr><td colspan="6"><b><i>Best Regards from The Rabbit Tree Team!</i></b></td></tr></table></body></html>';
  }
  /**
   * Sends one email once per operation (a retry after a later failure does not send it again).
   * A mail failure (quota, bad address) never blocks the operation: it comes back as a warning.
   */
  var MAIL_KINDS = ['cost', 'bill', 'settle', 'close', 'seller', 'mistake'];
  var ALERT_TO = ['therabbittreemanager@gmail.com', 'sebien.legoff@gmail.com']; // manager, owner
  function mailOnce_(op, kind, msg) {
    var props = PropertiesService.getScriptProperties(), key = 'UI_MAIL_' + op.id + '_' + kind;
    if (props.getProperty(key)) return '';
    var to = msg.to.filter(function (a) { return /^[^@\s,;]+@[^@\s,;]+$/.test(a); });
    if (!to.length) return '';
    try {
      var mail = { to: to.join(', '), subject: msg.subject, body: msg.body || '' };
      if (msg.html) mail.htmlBody = msg.html;
      if (msg.pdf) mail.attachments = [Utilities.newBlob(msg.pdf, 'text/html', 'bill.html').getAs('application/pdf').setName(msg.pdfName)];
      MailApp.sendEmail(mail);
    } catch (e) {
      console.error(e);
      return 'Email "' + msg.subject + '" not sent: ' + e.message;
    }
    props.setProperty(key, new Date().toISOString());
    return '';
  }
  function htmlEsc_(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- card terminal (old "18." Card Trans. / Settlements) ----------
  // At the end of the day the desk types the terminal's settlement totals; the sheet compares
  // them, minus the 2.9125 % fee (× 0.970875, as in Card Trans.), with the card payments
  // recorded since the previous settlement. One Settlements row per settlement:
  // A date, B time, C author, D time stamp (number yyyyMMddHHmmss000), E difference,
  // F settlement minus fee (+ local cards), G card total of the sheet, H local cards, I comment,
  // J total settlement, K settlement 1, L settlement 2, M/N the two settlements × 0.978.
  var FEE_KEEP = 0.970875, BIG_DIFF = 5000;
  function lastSettlement_() {
    var s = ss_().getSheetByName(SHEETS.settlements);
    var n = s ? lastRowIn_(s, 1, 4) : 0;
    if (n < 2) return null;
    var r = s.getRange(n, 1, 1, 4).getValues()[0], d = r[3];
    var ts = typeof d === 'number' ? d.toFixed(0) : String(d).replace(/\D/g, '');
    if (!/^\d{17}$/.test(ts)) return null;
    return { ts: ts, time: String(s.getRange(n, 2).getDisplayValue()), author: String(r[2]) };
  }
  var isCard_ = function (p) { return /credit|debit/i.test(String(p)); };
  /**
   * Card money recorded between two settlements: card sales in, card expenses (column L) out,
   * as the old Edcopen; compared to the second, like the time stamps of Settlements.
   */
  function cardTotal_(ent, from, to) {
    var total = 0, f = from.slice(0, 14), u = to.slice(0, 14);
    ent.rows.forEach(function (r) {
      var t = String(r[E.ts]).slice(0, 14);
      if (!isTs_(String(r[E.ts])) || t <= f || t > u || !isCard_(r[E.pay])) return;
      if (String(r[E.type]) === 'Income') total += priceOf_(r);
      else if (String(r[E.type]) === 'Expense') total -= Math.abs(num_(r[E.realCost]));
    });
    return Math.round(total);
  }

  // ====================== BAR CASH-OUT (TEMPORARY) ======================
  // The bar has its own cash. At the end of the day the desk records the bar cash-out as the
  // old sheet did, in Entries Manual only (never in Entries, never in the reception box):
  // A date, B "BAR Cash-out", H amount, N "Extern cash", O author, P comment, Q time stamp.
  // To remove later: delete this block, the bar_cashout handler, `bar:` in pull, js/bar.js
  // and its line in js/work.js.
  var BAR_TYPE = 'BAR Cash-out', BAR_DAYS = 14;
  function readBarCashouts_() {
    var s = ss_().getSheetByName(SHEETS.manual);
    if (!s) return [];
    var last = lastRowIn_(s, 1, 3);
    if (last < 2) return [];
    var from = tsOf_(new Date(Date.now() - BAR_DAYS * 86400000));
    return s.getRange(2, 1, last - 1, 17).getValues().filter(function (r) {
      return String(r[1]) === BAR_TYPE && String(r[16]) >= from;
    }).map(function (r) { return { ts: String(r[16]), amount: num_(r[7]), author: String(r[14]), comment: String(r[15]) }; });
  }
  // ======================================================================

  // ============================ GEAR (masks & bikes) ============================
  // Items are listed in the SG sheet (A number, B status, C last guest, D last time, E days,
  // F back before), kept up to date as the old dialogs did. Every movement is one row of
  // Gear_Log (A at, B event id, C type, D item, E ref, F back before, G by, H detail JSON);
  // the current state is the replay of that log over the SG sheet. Gear_Settings holds the
  // prices (part, price) and the manager's WhatsApp number.
  var GEAR_LOG_HEADER = ['At', 'Event id', 'Type', 'Item', 'Guest / trip', 'Back before', 'By', 'Detail'];
  var GEAR_SETTINGS_DEFAULT = [['Part / setting', 'Price (Rp)', 'Note'], ['Snorkel', 50000, ''], ['Mask (without snorkel)', 100000, ''],
    ['Ring', 15000, ''], ['Full snorkeling set (lost)', 150000, ''], ['Bike — repair', '', 'reception types the amount if empty'],
    ['Extension per day — mask', 30000, ''], ['Extension per day — bike', 50000, ''], ['Mask rental product', 'Snorkeling Mask', 'name in Data activities'],
    ['Bike rental product', 'Rabbit bike', 'name in Data activities'], ['Manager WhatsApp', '', 'number in column B, e.g. +62 812…']];
  var GEAR_CONDITIONS = ['OK', 'Snorkel missing', 'Ring missing', 'Mask missing', 'Part missing', 'Broken', 'Other', 'Lost'];
  var gnote_ = function (v) { return String(v || '').replace(/\s+/g, ' ').trim().slice(0, 300); }; // comment on a damage
  /** An operation made in the gear app: by a gear account, or by any account logged in there. */
  function gearSide_(me, p) { return me.role === 'gear' || !!(p && p.app === 'gear'); }
  var GEAR_OPS = { sunset_out: 1, sunset_back: 1, gear_count: 1, gear_confirm: 1, gear_return: 1, gear_condition: 1 }; // what the gear role may send
  /**
   * SG tab, our own layout: A number, B type (Mask / Bike), C in use (untick to retire a number)
   * are kept by hand; D–H are written by the interface from Gear_Log (do not edit); I is a free note.
   */
  var SG_HEADER = ['Number', 'Type', 'In use', 'Status (auto)', 'Guest / trip (auto)', 'Since (auto)', 'Back before (auto)', 'Condition (auto)', 'Note'];
  function gearSetup_() {
    var glog = ensureSheet_(SHEETS.gearLog, GEAR_LOG_HEADER);
    glog.getRange('B:E').setNumberFormat('@'); // ids, item and guest typed at the desk stay text
    glog.getRange('G:G').setNumberFormat('@'); // (F is the back-before date)
    var sg = ss_().getSheetByName(SHEETS.sg);
    if (!sg) sg = ss_().insertSheet(SHEETS.sg);
    var head = sg.getLastRow() >= 1 ? sg.getRange(1, 1, 1, 2).getValues()[0] : ['', ''];
    var skipped = [];
    if (String(head[0]) !== 'Number' || String(head[1]) !== 'Type') {
      // Old test layout: keep only the list of numbers, everything else comes from Gear_Log.
      // A number in another format is not imported but reported, never dropped silently.
      var ids = [], seen = {};
      if (sg.getLastRow() >= 2) sg.getRange(2, 1, sg.getLastRow() - 1, 1).getValues().forEach(function (r) {
        var raw = String(r[0]).trim(), id = raw.toUpperCase();
        if (!id || seen[id]) return;
        if (/^[A-Z]{1,3}\d+$/.test(id)) { seen[id] = 1; ids.push(id); } else if (skipped.indexOf(raw) < 0) skipped.push(raw);
      });
      sg.clearContents();
      var rows = [SG_HEADER].concat(ids.map(function (id) { return [id, gearKind_(id) === 'bike' ? 'Bike' : 'Mask', true, 'In', '', '', '', 'OK', '']; }));
      sg.getRange(1, 1, rows.length, SG_HEADER.length).setValues(rows);
      try { if (ids.length) sg.getRange(2, 3, ids.length, 1).insertCheckboxes(); } catch (e) { /* plain TRUE/FALSE is fine */ }
    }
    if (!ss_().getSheetByName(SHEETS.gearSettings)) {
      var s = ss_().insertSheet(SHEETS.gearSettings);
      s.getRange(1, 1, GEAR_SETTINGS_DEFAULT.length, 3).setValues(GEAR_SETTINGS_DEFAULT);
    }
    return { skipped: skipped };
  }
  function gearSettings_() {
    var s = ss_().getSheetByName(SHEETS.gearSettings), map = {};
    var rows = s && s.getLastRow() >= 2 ? s.getRange(2, 1, s.getLastRow() - 1, 3).getValues() : GEAR_SETTINGS_DEFAULT.slice(1);
    rows.forEach(function (r) { if (String(r[0]).trim()) map[String(r[0]).trim()] = r[1]; });
    // Manager number: column B, else the Note column; the first with 8 digits or more. 0812… is
    // 62812…; 812… is a 0812… the sheet turned into a number (lost its 0).
    var wa = '';
    rows.forEach(function (r) {
      if (wa || String(r[0]).trim() !== 'Manager WhatsApp') return;
      [r[1], r[2]].forEach(function (v) {
        var d = String(v === null || v === undefined ? '' : typeof v === 'number' ? v.toFixed(0) : v).replace(/\D/g, '');
        if (wa || d.length < 8) return;
        wa = '+' + (d.charAt(0) === '0' ? '62' + d.slice(1) : d.charAt(0) === '8' ? '62' + d : d);
      });
    });
    var price = function (k) { var v = map[k]; return v === '' || v === undefined || v === null ? null : num_(v); };
    return {
      prices: { 'Snorkel missing': price('Snorkel'), 'Ring missing': price('Ring'), 'Broken': price('Mask (without snorkel)'),
        'Lost': price('Full snorkeling set (lost)'), 'Mask missing': price('Mask (without snorkel)'), 'Bike': price('Bike — repair') },
      ext: { mask: price('Extension per day — mask'), bike: price('Extension per day — bike') },
      product: { mask: String(map['Mask rental product'] || 'Snorkeling Mask'), bike: String(map['Bike rental product'] || 'Rabbit bike') },
      managerWa: wa
    };
  }
  var gearKind_ = function (id) { return /^SG/i.test(id) ? 'mask' : 'bike'; };
  /**
   * When a rental must be back: 24 hours, rounded to the desk's times — out before noon:
   * next day 12:00; out from noon: next day 18:00 (plus one day per extra day).
   */
  function gfmt_(d, pattern) { return Utilities.formatDate(d, TS_TZ, pattern); }
  function gearBack_(from, days) {
    var h = Number(gfmt_(from, 'HH'));
    var day = Utilities.parseDate(gfmt_(from, 'yyyy-MM-dd'), TS_TZ, 'yyyy-MM-dd');
    var d = new Date(day.getTime() + Math.max(1, days || 1) * 86400000);
    return new Date(d.getTime() + (h < 12 ? 12 : 18) * 3600000);
  }
  /** Sunset Boat masks are due back the same evening at 21:30. */
  function sunsetBack_(at) {
    var day = Utilities.parseDate(gfmt_(at, 'yyyy-MM-dd'), TS_TZ, 'yyyy-MM-dd');
    return new Date(day.getTime() + 21.5 * 3600000);
  }
  function gearLogRows_() {
    var s = ss_().getSheetByName(SHEETS.gearLog);
    if (!s || s.getLastRow() < 2) return [];
    var out = [];
    s.getRange(2, 1, s.getLastRow() - 1, 8).getValues().forEach(function (r) {
      var at = r[0] instanceof Date ? r[0] : new Date(r[0]);
      if (r[0] === '' || isNaN(at.getTime())) return; // unreadable row (typed by hand): ignored, not fatal
      var det = {}; try { det = JSON.parse(r[7] || '{}'); } catch (e) { det = {}; }
      var back = r[5] ? new Date(r[5]) : null;
      if (back && isNaN(back.getTime())) back = null;
      out.push({ at: at, id: String(r[1]), type: String(r[2]), item: String(r[3]), ref: String(r[4]), back: back, by: String(r[6]), d: det || {} });
    });
    return out;
  }
  function gearLog_(rows) {
    if (!rows.length) return;
    var s = sheet_(SHEETS.gearLog);
    writes_++;
    var r = lastRowIn_(s, 1, 3) + 1;
    s.getRange(r, 2, rows.length, 4).setNumberFormat('@'); // B:E and G are text (a number typed at the desk is never a formula)
    s.getRange(r, 7, rows.length, 1).setNumberFormat('@');
    s.getRange(r, 1, rows.length, 8).setValues(rows.map(function (x) {
      return [x.at, safe_(String(x.id || '')), safe_(String(x.type || '')), safe_(String(x.item || '')), safe_(String(x.ref || '')), x.back || '',
        safe_(String(x.by || '')), safe_(JSON.stringify(x.d || {}))];
    }));
  }
  /** Keeps the SG sheet as the old dialogs did (B status, C guest, D time, E days, F back before). */
  var gearDirty_ = false;
  function sgUpdate_() { gearDirty_ = true; } // the SG mirror is rewritten once the operation is done
  /** Writes the automatic columns of SG (D–H) from the replayed state: same result on every retry. */
  function sgSync_() {
    var s = ss_().getSheetByName(SHEETS.sg);
    if (!s || s.getLastRow() < 2 || String(s.getRange(1, 1).getValue()) !== 'Number') return;
    var st = gearState_(), byId = {};
    st.items.forEach(function (i) { byId[i.id] = i; });
    var ids = s.getRange(2, 1, s.getLastRow() - 1, 1).getValues();
    var out = ids.map(function (r) {
      var it = byId[String(r[0]).trim().toUpperCase()];
      if (!it) return ['', '', '', '', ''];
      var away = it.where === 'out' || it.where === 'sunset';
      return [it.where === 'sunset' ? 'Sunset Boat' : it.where === 'out' ? 'Out' : it.where === 'lost' ? 'Lost' : 'In',
        away && it.last ? safe_(String(it.last.guest || '')) : '', away && it.last && it.last.from ? new Date(it.last.from) : '',
        away && it.back ? new Date(it.back) : '', it.condition];
    });
    s.getRange(2, 4, out.length, 5).setValues(out);
  }
  /**
   * The whole state, replayed: items (where, condition, last use, back before), open
   * differences, damages waiting for a decision, today's Sunset Boat trips and checks.
   */
  function gearState_() {
    var s = ss_().getSheetByName(SHEETS.sg);
    var items = {}, order = [];
    var lay = s && s.getLastRow() >= 1 && String(s.getRange(1, 1).getValue()) === 'Number';
    if (s && lay && s.getLastRow() >= 2) s.getRange(2, 1, s.getLastRow() - 1, 3).getValues().forEach(function (r) {
      var id = String(r[0]).trim().toUpperCase();
      if (!id || items[id]) return;
      if (r[2] === false || /^(false|no|non|tidak)$/i.test(String(r[2]).trim())) return; // retired
      var kind = /bike|sepeda|v[ée]lo/i.test(String(r[1])) ? 'bike' : /mask|masker|masque/i.test(String(r[1])) ? 'mask' : gearKind_(id);
      items[id] = { id: id, kind: kind, where: 'in', condition: 'OK', last: null, back: null }; order.push(id);
    });
    var diffs = {}, damages = {}, trips = {}, counts = [];
    gearLogRows_().forEach(function (e) {
      var it = items[e.item];
      if (e.type === 'out' && it) {
        it.where = 'out'; it.back = e.back ? e.back.toISOString() : null;
        it.last = { kind: e.d.kind || 'rental', guest: e.ref, from: e.d.from || e.at.toISOString(), saleTs: e.d.saleTs || '' };
      } else if (e.type === 'return' && it) {
        it.back = null; it.condition = e.d.condition || 'OK';
        it.where = it.condition === 'Lost' ? 'lost' : 'in'; // returned as lost: stays out of service
        if (it.last) it.last.returned = e.at.toISOString();
      } else if (e.type === 'relink') { // a paid bill gave the rental line a new id
        order.forEach(function (k) { var x = items[k]; if (x.last && x.last.saleTs && String(x.last.saleTs) === String(e.d.from)) x.last.saleTs = String(e.d.to); });
      } else if (e.type === 'sunset_out') {
        if (!(e.d.items || []).length) return; // every number touched was already out: only differences, no trip
        trips[e.ref] = trips[e.ref] || { trip: e.ref, at: e.at.toISOString(), by: e.by, items: [], back: [], closed: false };
        (e.d.items || []).forEach(function (id) {
          var x = items[id]; if (!x || trips[e.ref].items.indexOf(id) >= 0) return;
          trips[e.ref].items.push(id);
          x.where = 'sunset'; x.back = e.back ? e.back.toISOString() : null;
          x.last = { kind: 'sunset', guest: 'Sunset Boat', from: e.at.toISOString(), trip: e.ref };
        });
      } else if (e.type === 'sunset_back') {
        var t = trips[e.ref];
        (e.d.items || []).forEach(function (id) {
          var x = items[id]; if (!x) return;
          if (t) t.back.push(id);
          if (x.where !== 'sunset') return; // returned at the desk or rented again meanwhile
          x.where = 'in'; x.back = null; if (x.last) x.last.returned = e.at.toISOString();
        });
        if (t) t.closed = true;
      } else if (e.type === 'count') {
        counts.push({ id: e.id, at: e.at.toISOString(), by: e.by, n: (e.d.items || []).length,
          seen: (e.d.items || []).map(function (x) { return String(x && x.item || ''); }) });
      } else if (e.type === 'diff') {
        diffs[e.id] = { id: e.id, item: e.item, kind: e.d.kind, at: e.at.toISOString(), count: e.ref, last: e.d.last || null, late: e.d.late || 0, due: e.d.due || null, returned: e.d.returned || null,
          reception: false, gear: false, closed: false, note: '', by: e.by || '' };
        if (e.d.kind === 'sale_unlinked') { diffs[e.id].reason = e.d.reason || ''; diffs[e.id].saleTs = e.d.saleTs || ''; diffs[e.id].guest = e.d.guest || ''; diffs[e.id].object = e.d.object || ''; }
      } else if (e.type === 'confirm') {
        var df = diffs[e.ref];
        if (df) { df[e.d.side] = true; df[e.d.side + 'By'] = e.by; if (e.d.note) df.note = e.d.note; if (df.reception && df.gear) df.closed = true; }
      } else if (e.type === 'lost') {
        var dl = diffs[e.ref]; if (dl) dl.closed = true;
        if (it) { it.where = 'lost'; it.condition = 'Lost'; }
      } else if (e.type === 'damage') {
        damages[e.id] = { id: e.id, item: e.item, condition: e.d.condition, note: e.d.note || '', at: e.at.toISOString(), guest: e.ref, from: e.d.from || 'return',
          decision: e.d.from === 'status' ? 'nocharge' : 'pending', amount: null }; // a status change has no guest to charge
        if (it && e.d.condition !== 'OK') it.condition = e.d.condition;
        if (it && e.d.condition === 'Lost') { it.where = 'lost'; it.back = null; } // seen lost off the boat or at the check: out of service
      } else if (e.type === 'decide') {
        var dm = damages[e.ref]; if (dm) { dm.decision = e.d.decision; dm.amount = e.d.amount || null; }
      } else if (e.type === 'service' && it) {
        it.condition = 'OK'; if (it.where === 'lost') it.where = 'in';
        Object.keys(damages).forEach(function (k) { if (damages[k].item === it.id) damages[k].serviced = true; }); // a later damage is a new case
      }
    });
    // K2: masks of a trip all returned another way (at the desk, found): the trip is over.
    Object.keys(trips).forEach(function (k) {
      var t = trips[k];
      if (!t.closed && !t.items.some(function (id) { return items[id] && items[id].where === 'sunset'; })) { t.closed = true; t.back = t.items.slice(); }
    });
    var today = gfmt_(new Date(), 'yyyy-MM-dd'), nowMs = Date.now();
    order.forEach(function (id) { var x = items[id]; if (x.where === 'out') x.lateDays = lateDays_(x, counts, nowMs); });
    return {
      counts: counts,
      items: order.map(function (id) { return items[id]; }),
      diffs: Object.keys(diffs).map(function (k) { return diffs[k]; }).filter(function (d) { return !d.closed; }),
      damages: Object.keys(damages).map(function (k) { return damages[k]; }).filter(function (d) { return d.decision === 'pending' || (!d.serviced && (!items[d.item] || items[d.item].condition !== 'OK')); }),
      trips: Object.keys(trips).map(function (k) { return trips[k]; }).filter(function (t) { return !t.closed || gfmt_(new Date(t.at), 'yyyy-MM-dd') === today; }),
      lastCount: counts.length ? publicCount_(counts[counts.length - 1]) : null,
      countedToday: counts.some(function (c) { return gfmt_(new Date(c.at), 'yyyy-MM-dd') === today; })
    };
  }
  function publicCount_(c) { return { id: c.id, at: c.at, by: c.by, n: c.n }; }
  /**
   * Extension days owed: the 18:00 return time is only what the guest is told. A day is
   * charged only when an evening check (count) made after the return time did not find
   * the item, i.e. it was still out; at most one per day, up to untilMs (return time).
   */
  function lateDays_(it, counts, untilMs) {
    if (!it || !it.back) return 0;
    var b = Date.parse(it.back), days = {};
    (counts || []).forEach(function (c) {
      var t = Date.parse(c.at);
      if (t > b && t <= untilMs && (c.seen || []).indexOf(it.id) < 0) days[gfmt_(new Date(t), 'yyyy-MM-dd')] = 1;
    });
    return Object.keys(days).length;
  }
  var COUNTS_DAYS = 45; // evening checks sent to the reception (rentals last 30 days at most)
  /** Sunset Boat guests recorded in today's sales (quantity of "Sunset Boat" lines, Unpaid included). */
  function sunsetSalesToday_(ent) {
    if (!ent) return 0;
    var today = tsOf_(new Date()).slice(0, 8), n = 0;
    ent.rows.forEach(function (r) {
      if (String(r[E.type]) === 'Income' && /sunset boat/i.test(String(r[E.obj])) && String(r[E.ts]).slice(0, 8) === today &&
          REFUND_ANY.indexOf(String(r[E.comment]).trim()) < 0) n += num_(r[E.qty]) || 1;
    });
    return n;
  }
  /** What the gear app may see: the list of numbers only (the check is blind), trips, differences. */
  function gearForStaffApp_(st, ent) {
    var set = gearSettings_();
    if (ent === null && ss_().getSheetByName(SHEETS.entries)) ent = entries_();
    return { items: st.items.map(function (i) { return { id: i.id, kind: i.kind }; }), trips: st.trips,
      diffs: st.diffs.filter(function (d) { return d.kind !== 'returned_late' && d.kind !== 'returned_not_out'; }), // reception's business; would tell what was out
      countedToday: st.countedToday, lastCount: st.lastCount, sunsetSales: sunsetSalesToday_(ent), managerWa: set.managerWa,
      unavailable: st.items.filter(function (i) { return i.condition !== 'OK' || i.where === 'lost'; }).map(function (i) { return i.id; }),
      // Out of service in the box (what the staff reported): for "Kondisi barang", with the last note.
      broken: st.items.filter(function (i) { return i.where === 'in' && i.condition !== 'OK'; }).map(function (i) {
        var dm = st.damages.filter(function (d) { return d.item === i.id; }).pop();
        return { id: i.id, condition: i.condition, note: dm ? dm.note : '' };
      }) };
  }
  function gearForReception_(st, ent) {
    var set = gearSettings_(), from = Date.now() - COUNTS_DAYS * 86400000;
    return { items: st.items, diffs: st.diffs, damages: st.damages, trips: st.trips, countedToday: st.countedToday, lastCount: st.lastCount,
      counts: st.counts.filter(function (c) { return Date.parse(c.at) >= from; }).map(function (c) { return { at: c.at, seen: c.seen }; }),
      sunsetSales: sunsetSalesToday_(ent), prices: set.prices, ext: set.ext, product: set.product, managerWa: set.managerWa };
  }
  function findGear_(st, id) { return st.items.filter(function (i) { return i.id === String(id || '').trim().toUpperCase(); })[0] || null; }
  function gearItem_(st, id) {
    var it = findGear_(st, id);
    if (!it) throw apiError_('bad_payload', 'Unknown gear number ' + id);
    return it;
  }
  /** Extension charge for a rental, never more days than the evening checks show (see lateDays_). */
  function extCharge_(st, set, it, guest, ext, untilMs, warn) {
    if (!ext || !it.last || it.last.kind !== 'rental') return null;
    var unit = it.kind === 'mask' ? set.ext.mask : set.ext.bike;
    if (!unit) return null;
    var late = lateDays_(it, st.counts, untilMs);
    if (!late) { warn.push('No extension for ' + it.id + ': it was not out at an evening check after its return time.'); return null; }
    var asked = Math.round(Number(ext.days) || late);
    return { ts: ext.ts, object: it.kind === 'mask' ? set.product.mask : set.product.bike, qty: Math.max(1, Math.min(late, asked)), unit: unit,
      guest: guest, comment: 'Extension ' + it.id };
  }
  /** An operation of this type and id (UI_Log F) was accepted, e.g. a Sunset Boat departure with nothing to write. */
  function loggedOp_(type, ref) {
    var log = ss_().getSheetByName(SHEETS.log);
    if (!log || log.getLastRow() < 2) return false;
    return log.getRange(2, 5, log.getLastRow() - 1, 4).getValues().some(function (r) {
      return String(r[0]) === type && String(r[1]).replace(/^'/, '') === ref && String(r[3]) === 'applied';
    });
  }
  function gearEventDone_(id) { return gearLogRows_().some(function (e) { return e.id === id; }); }
  /** Unpaid sale lines for a guest (extension, damage), written like the sale handler writes them. */
  function gearCharge_(me, at, lines) {
    var author = me.author || me.username, day = dateOnly_(at);
    var rows = lines.map(function (l) {
      var q = qty_(l.qty || 1), unit = amount_(l.unit, 'price'), total = Math.round(q * unit);
      return [day, 'Income', 'Service', text_(l.object, 200, 'Product'), q, unit, total, total, author, 0, 0, 0,
        text_(l.guest, 120, 'Guest'), 'Unpaid', lineTs_(l.ts, at), '', text_(l.comment, 300, 'Comment')];
    });
    var ent = entries_(), man = manual_();
    appendEntries_(ent, rows.filter(function (r) { return !ent.byTs[r[E.ts]]; }), true); // gear charge: Seller
    appendManual_(man, rows.filter(function (r) { return !man.byTs[r[E.ts]]; }));
  }
  function isRentalObj_(obj) {
    if (!ss_().getSheetByName(SHEETS.sg)) return false;
    var set = gearSettings_();
    return sameName_(obj, set.product.mask) || sameName_(obj, set.product.bike);
  }
  /** A paid bill changes the line id: the number out on that rental follows ('relink' in Gear_Log). */
  function gearRelink_(me, at, todo) {
    if (!ss_().getSheetByName(SHEETS.gearLog) || !ss_().getSheetByName(SHEETS.sg)) return;
    var st = gearState_(), done = {}, rows = [];
    gearLogRows_().forEach(function (e) { done[e.id] = 1; });
    todo.forEach(function (t) {
      var id = 'G' + t.newTs + '-rl';
      if (done[id] || t.oldTs === t.newTs) return;
      if (!st.items.some(function (i) { return i.last && String(i.last.saleTs) === t.oldTs; })) return;
      rows.push({ at: at, id: id, type: 'relink', item: '', ref: t.oldTs, by: me.username, d: { from: t.oldTs, to: t.newTs } });
    });
    gearLog_(rows);
  }
  /**
   * A rental line was corrected (days = quantity, guest) or deleted: the number still out on
   * that rental follows — new return time / guest, or back in stock if the sale is gone.
   */
  function gearFollowLine_(op, me, ts, row, deleted) {
    if (!ss_().getSheetByName(SHEETS.gearLog)) return;
    var st = gearState_(), it = st.items.filter(function (i) { return i.where === 'out' && i.last && i.last.kind === 'rental' && String(i.last.saleTs) === String(ts); })[0];
    if (!it) return;
    var id = ('G' + ts + '-' + (deleted ? 'x' : 'u') + String(op.id).replace(/[^\w]/g, '')).slice(0, 60);
    if (gearEventDone_(id)) return;
    var at = parseAt_(op.at), from = new Date(it.last.from);
    if (deleted) {
      gearLog_([{ at: at, id: id, type: 'return', item: it.id, ref: it.last.guest, by: me.username, d: { condition: it.condition, via: 'sale deleted' } }]);
    } else {
      var days = Math.max(1, Math.round(num_(row[E.qty]) || 1)), guest = String(row[E.guest] || it.last.guest);
      gearLog_([{ at: at, id: id, type: 'out', item: it.id, ref: guest, back: gearBack_(from, days), by: me.username,
        d: { kind: 'rental', days: days, saleTs: String(ts), from: from.toISOString() } }]);
    }
    sgUpdate_();
  }
  /**
   * Gear staff: a guest hands numbers back to them. Blind like the check: nothing is refused
   * and nothing tells them what was out. Late rentals go to the reception, who charges the
   * extension or waives it (a 'returned_late' difference the gear side has already confirmed).
   */
  function gearStaffReturn_(op, me, p, at) {
    var gid = String(p.gid || ''); if (!/^G[\w-]{6,40}$/.test(gid)) throw apiError_('bad_payload', 'Invalid id');
    if (gearEventDone_(gid)) return { already: true };
    var st = gearState_(), rows = [{ at: at, id: gid, type: 'staff_return', item: '', ref: '', by: me.username, d: {} }], skipped = [], seen = {};
    (Array.isArray(p.items) ? p.items : []).forEach(function (x) {
      var it = findGear_(st, x && x.item);
      if (!it || seen[it.id]) { skipped.push(String(x && x.item || '').slice(0, 20)); return; } // unknown number: the others go on
      seen[it.id] = 1;
      var id = gid + '-' + it.id;
      var cond = GEAR_CONDITIONS.indexOf(x.condition) >= 0 ? x.condition : 'OK';
      var guest = it.last ? it.last.guest : '';
      if (it.where !== 'out' && it.where !== 'sunset') {
        // Not recorded as out: accepted without a word (blind), but the reception checks it (gone without a sale?).
        // Once per number while unchecked (09/11: an inventory done 4 times in "Pengembalian" made 60 of them).
        var already = st.diffs.some(function (d) { return d.item === it.id && d.kind === 'returned_not_out'; });
        if (!already) rows.push({ at: at, id: id + '-nout', type: 'diff', item: it.id, ref: gid, by: me.username, d: { kind: 'returned_not_out', last: it.last } });
        if (!already) rows.push({ at: at, id: id + '-nout-g', type: 'confirm', item: it.id, ref: id + '-nout', by: me.username, d: { side: 'gear', action: 'returned' } });
        if (it.where === 'lost') rows.push({ at: at, id: id, type: 'return', item: it.id, ref: guest, by: me.username, d: { condition: cond, via: 'gear staff' } }); // found again
      }
      if (it.where === 'out' || it.where === 'sunset') {
        rows.push({ at: at, id: id, type: 'return', item: it.id, ref: guest, by: me.username, d: { condition: cond, via: 'gear staff' } });
        var late = it.where === 'out' && it.last && it.last.kind === 'rental' ? lateDays_(it, st.counts, at.getTime()) : 0;
        if (late) {
          rows.push({ at: at, id: id + '-late', type: 'diff', item: it.id, ref: gid, by: me.username, d: { kind: 'returned_late', last: it.last, late: late, due: it.back, returned: at.toISOString() } });
          rows.push({ at: at, id: id + '-late-g', type: 'confirm', item: it.id, ref: id + '-late', by: me.username, d: { side: 'gear', action: 'returned' } });
        }
      }
      if (cond !== 'OK' && cond !== it.condition) rows.push({ at: at, id: 'D' + id, type: 'damage', item: it.id, ref: guest, by: me.username, d: { condition: cond, from: 'gear return', note: gnote_(x.note) } });
    });
    gearLog_(rows);
    sgUpdate_();
    return skipped.length ? { skipped: skipped } : {};
  }
  function assertGearDesk_(me) {
    if (me.role === 'gear') throw apiError_('forbidden', 'This is done at the reception');
    assertCashRight_(me);
  }
  // =============================================================================

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
        var row = [day, 'Income', text_(l.category, 60, 'Category'), obj, q, unit, total, total, author,
          unitCost, cost, cost, guest, pay, ts, '', text_(l.comment, 300, 'Comment')];
        // Bar POS (owner 11/11): who took the order, in Seller (T of Entries, R of Entries Manual). A name, never an
        // email: Commis. only pays the lines whose Seller is an email.
        if (l.seller) row.sellerName = text_(String(l.seller).replace(/@/g, ' '), 60, 'Seller');
        return row;
      });
      var seen = {};
      rows.forEach(function (r) { if (seen[r[E.ts]]) throw apiError_('bad_payload', 'Duplicate line id'); seen[r[E.ts]] = 1; });
      // Rental days are whole days.
      var hasGearSheet = !!ss_().getSheetByName(SHEETS.sg);
      var gset = hasGearSheet ? gearSettings_() : null;
      lines.forEach(function (l, i) {
        var rental = l.gear || (gset && (sameName_(rows[i][E.obj], gset.product.mask) || sameName_(rows[i][E.obj], gset.product.bike)));
        if (rental && (Math.round(rows[i][E.qty]) !== rows[i][E.qty] || rows[i][E.qty] < 1)) {
          throw apiError_('bad_amount', 'Rental of ' + rows[i][E.obj] + ': the quantity is the number of days, a whole number (1 or more)');
        }
      });
      // Gear rental: one line per mask or bike, its number in `gear`; it leaves the stock now.
      // The money is never refused for a gear reason: a number already out is first returned
      // (no extension for the previous guest); an unknown, unavailable or wrong-type number is
      // not linked and becomes a 'sale_unlinked' difference for the reception and the gear staff.
      var gearOut = [], gearSg = [];
      if (hasGearSheet && lines.some(function (l) { return l.gear; })) {
        var gst = gearState_(), gdone = {}, used = {};
        gearLogRows_().forEach(function (e) { gdone[e.id] = 1; });
        lines.forEach(function (l, i) {
          if (!l.gear) return;
          var ts = rows[i][E.ts], id = 'G' + ts, it = findGear_(gst, l.gear);
          var reason = !it ? 'unknown' : used[it.id] ? 'duplicate' :
            !sameName_(rows[i][E.obj], it.kind === 'mask' ? gset.product.mask : gset.product.bike) ? 'wrong_product' :
            gdone[id] ? '' : (it.where === 'lost' || it.condition !== 'OK') ? 'unavailable' : '';
          if (reason) {
            if (!gdone[id + '-u']) gearOut.push({ at: at, id: id + '-u', type: 'diff', item: it ? it.id : String(l.gear).trim().toUpperCase().slice(0, 20), ref: id, by: me.username,
              d: { kind: 'sale_unlinked', reason: reason, saleTs: ts, guest: rows[i][E.guest], object: rows[i][E.obj], last: it ? it.last : null } });
            return;
          }
          used[it.id] = true;
          var days = rows[i][E.qty];
          if (gdone[id]) { gearSg.push({ item: it.id }); return; }
          if ((it.where === 'out' || it.where === 'sunset') && !gdone[id + '-r']) {
            gearOut.push({ at: at, id: id + '-r', type: 'return', item: it.id, ref: it.last ? it.last.guest : '', by: me.username, d: { condition: it.condition, via: 'resold' } });
          }
          gearOut.push({ at: at, id: id, type: 'out', item: it.id, ref: rows[i][E.guest], back: gearBack_(at, days), by: me.username,
            d: { kind: 'rental', days: days, saleTs: ts } });
          gearSg.push({ item: it.id });
        });
      }
      if (gearOut.length) needSheets_([SHEETS.gearLog]); // before the money is written
      var ent = entries_(), man = manual_();
      // A line id already in the sheet is either our own earlier attempt (same guest and
      // product: skip it) or a collision with another line (refuse, nothing written).
      rows.forEach(function (r) {
        var ex = ent.row(r[E.ts]);
        if (ex && (!same_(ex[E.guest], r[E.guest]) || !same_(ex[E.obj], r[E.obj]))) {
          throw apiError_('ts_collision', 'The sheet already has a different line with this id. Nothing was written; check with a manager before entering the sale again.');
        }
      });
      appendEntries_(ent, rows.filter(function (r) { return !ent.byTs[r[E.ts]]; }), true); // sale: Seller
      appendManual_(man, rows.filter(function (r) { return !man.byTs[r[E.ts]]; }));
      if (gearOut.length || gearSg.length) {
        gearLog_(gearOut);
        sgUpdate_(); // also on a retry: the SG sheet is rewritten from what is logged (same values)
      }
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
      if (String(row[E.status] || '').trim() && (p.qty !== undefined || p.unit !== undefined)) {
        throw apiError_('bad_payload', 'This sale is on a partner bill (' + String(row[E.status]).trim() + '): its quantity and price cannot change');
      }
      if (String(row[E.obj]) === 'Cash Supply') throw apiError_('bad_payload', 'A cash supply cannot be edited; a manager can delete it and enter it again');
      if (isExp && (p.qty !== undefined || p.unit !== undefined || p.guest !== undefined)) {
        throw apiError_('bad_payload', 'An expense only has an amount, a payment type and a comment');
      }
      if (isExp && p.payment === 'Paid to Partner') throw apiError_('bad_payment', 'Paid to Partner is not used for expenses');
      if (p.qty !== undefined || p.unit !== undefined) {
        var q = p.qty !== undefined ? qty_(p.qty) : (num_(row[E.qty]) || 1);
        if (p.qty !== undefined && Math.round(q) !== q && isRentalObj_(row[E.obj])) throw apiError_('bad_amount', 'Rental of ' + row[E.obj] + ': the quantity is the number of days, a whole number (1 or more)');
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
      row = row.map(safe_); // values read back lost their protecting apostrophe
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
      gearFollowLine_(op, me, ts, row, false);
      return { audit: { before: before } };
    },
    /**
     * Owner 12/11: one Unpaid line paid two ways (a room of 800 000: 500 000 cash + 300 000 card). The line keeps
     * total - amount, a new Unpaid line (same guest, object, seller, comment + " · split") gets amount; then each is
     * paid in Guest bills with its own way. payload: { ts, newTs, amount }. Same rule as a payment: the person on shift
     * or a manager. Quantity kept, price per unit adjusted (a part of a night is not a night).
     */
    line_split: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      assertCashRight_(me);
      var ts = String(p.ts), newTs = lineTs_(p.newTs, at);
      var ent = entries_(), man = manual_();
      if (ent.byTs[newTs]) return { already: true }; // retry after a cut connection
      var rowNo = ent.byTs[ts];
      if (!rowNo) throw apiError_('line_not_found', 'This line is no longer in the sheet');
      var row = ent.rows[rowNo - 2].slice();
      if (String(row[E.type]) !== 'Income' || String(row[E.pay]) !== 'Unpaid') throw apiError_('bad_payload', 'Only an unpaid sale can be split');
      if (String(row[E.status] || '').trim()) throw apiError_('bad_payload', 'This sale is on a partner bill: it cannot be split');
      var total = num_(row[E.total]) || num_(row[E.real]);
      var a = amount_(p.amount, 'amount');
      if (!(a > 0 && a < total)) throw apiError_('bad_amount', 'The new line must be between 1 and ' + (total - 1));
      var before = lineOut_(row);
      var set = function (r, v) {
        var q = num_(r[E.qty]);
        if (q) r[E.unit] = Math.round(v / q * 100) / 100;
        if (r[E.total] !== '') r[E.total] = v;
        r[E.real] = v;
        if (r[E.cost] !== '' && total) { var c = Math.round(num_(r[E.cost]) * v / total); r[E.cost] = c; r[E.realCost] = c; }
      };
      var oldRow = row.map(safe_), newRow = row.slice(0, 17);
      set(oldRow, total - a);
      set(newRow, a);
      newRow[E.ts] = newTs; newRow[E.comment] = (String(row[E.comment] || '') + ' · split').replace(/^ · /, '').slice(0, 300);
      newRow.sellerName = /@/.test(String(row[E.author])) ? '' : String(row[E.seller] || '');
      (ent.all[ts] || []).forEach(function (n) {
        verify_(ent.sheet, n, E.ts + 1, ts);
        ent.sheet.getRange(n, E.qty + 1, 1, 4).setValues([[oldRow[E.qty], oldRow[E.unit], oldRow[E.total], oldRow[E.real]]]);
        ent.sheet.getRange(n, E.cost + 1, 1, 2).setValues([[oldRow[E.cost], oldRow[E.realCost]]]);
      });
      (man.all[ts] || []).forEach(function (n) {
        verify_(man.sheet, n, M.ts + 1, ts);
        man.sheet.getRange(n, M.real + 1).setValue(oldRow[E.real]);
        man.sheet.getRange(n, M.realCost + 1).setValue(oldRow[E.realCost]);
      });
      appendEntries_(ent, [newRow], true);
      // A room line from Beds24 keeps its booking id (U): the sync counts both halves and sends each payment.
      var bookId = String(ent.sheet.getRange(rowNo, 21).getValue() || '').trim();
      if (bookId) ent.sheet.getRange(ent.last, 21).setNumberFormat('@').setValue(bookId);
      appendManual_(man, [newRow]);
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
      if (!eRows.length && !mRows.length) { gearFollowLine_(op, me, ts, null, true); return { already: true }; } // retry: finish the gear part
      var before = null;
      if (eRows.length) { before = lineOut_(ent.rows[eRows[0] - 2]); assertCanChange_(me, ent.rows[eRows[0] - 2]); }
      else if (me.role === 'staff') throw apiError_('forbidden', 'Ask a manager to delete this line');
      mRows.forEach(function (n) { verify_(man.sheet, n, M.ts + 1, ts); man.sheet.deleteRow(n); });
      eRows.forEach(function (n) { verify_(ent.sheet, n, E.ts + 1, ts); ent.sheet.deleteRow(n); });
      gearFollowLine_(op, me, ts, null, true); // the rental is gone: its number is back in stock
      return { audit: { before: before } };
    },
    /**
     * A guest pays lines left Unpaid: payment type, author and timestamp change, as in the
     * old billing dialog. Each item can be resumed if an earlier attempt stopped half-way.
     */
    /**
     * Commissions: give a line to another seller (old "Assign sellers" dialog): Entries T and
     * Entries Manual R of every copy of the line. Staff move their own lines; managers any line.
     * payload: { ts, from (the seller the device saw), to (email of an active reception user) }.
     */
    seller_change: function (op, me) {
      var p = op.payload || {};
      parseAt_(op.at);
      var ts = String(p.ts || '');
      if (!isTs_(ts)) throw apiError_('bad_payload', 'Invalid line id');
      var to = sellers_().filter(function (u) { return lc_(u.email) === lc_(p.to); })[0];
      if (!to) throw apiError_('bad_payload', 'Choose an active reception staff member');
      var ent = entries_();
      var rows = ent.all[ts] || [];
      if (!rows.length) throw apiError_('line_not_found', 'This line is no longer in the sheet');
      var r = ent.rows[rows[0] - 2];
      var cur = String(r[E.seller] || '').trim();
      if (lc_(cur) === lc_(to.email)) return { already: true }; // a retry, or already done in the sheet
      if (lc_(cur) !== lc_(p.from)) throw apiError_('changed', 'The seller of this line changed meanwhile (now ' + (cur || 'nobody') + '). Look again.');
      if (me.role === 'staff' && lc_(cur) !== lc_(me.author)) throw apiError_('forbidden', 'You can only give away your own lines. Ask a manager.');
      ensureExceptionsCol_();
      if (!canMoveSeller_(r, commissionExceptions_(), partnerLabels_().all)) {
        throw apiError_('not_eligible', 'This line cannot change seller (only tours and transports of this period, not refunded, not a commission exception).');
      }
      var man = ss_().getSheetByName(SHEETS.manual) ? manual_() : null;
      rows.forEach(function (n) { verify_(ent.sheet, n, E.ts + 1, ts); });
      writes_++;
      rows.forEach(function (n) { ent.sheet.getRange(n, E.seller + 1).setValue(to.email); });
      if (man) (man.all[ts] || []).forEach(function (n) { verify_(man.sheet, n, M.ts + 1, ts); man.sheet.getRange(n, M.ts + 2).setValue(to.email); }); // R Seller
      // Emailed like the old dialog, to the Protect "Auth Base" addresses (B2:B10).
      var prot = ss_().getSheetByName(SHEETS.protect);
      var rcpt = prot ? prot.getRange(2, 2, 9, 1).getValues().map(function (x) { return String(x[0]).trim(); }).filter(String) : [];
      var warn = mailOnce_(op, 'seller', { to: rcpt.length ? rcpt : ALERT_TO, subject: 'Seller Modified',
        body: 'Line ' + ts + ' (' + String(r[E.obj]) + ', ' + String(r[E.guest]) + ', ' + priceOf_(r) + '): seller ' + (cur || '(none)') + ' → ' + to.email +
          ', changed by ' + me.username + ' from the reception app.' });
      var res = { audit: { before: cur, after: to.email, object: String(r[E.obj]), guest: String(r[E.guest]) } };
      if (warn) res.warning = warn;
      return res;
    },
    /**
     * Activities editor (Tour / Transport of Data activities), any reception user.
     * payload: { do: 'add' | 'update' | 'delete', category, name (current name; the new one for add),
     *   newName (update), price, cost }. Column A..C and the category list change together.
     */
    activity: function (op, me) {
      var p = op.payload || {};
      parseAt_(op.at);
      var cat = String(p.category || '');
      if (ACT_CATS.indexOf(cat) < 0) throw apiError_('bad_payload', 'Only Tour and Transport activities can be edited here');
      var s = sheet_(SHEETS.catalog), L = actLayout_(s), col = L.lists[cat];
      var name = String(p.name || '').replace(/\s+/g, ' ').trim();
      var aRows = function (n) { return rowsWith_(s, L.a, n); };
      var abc = function (rowNo) { var v = s.getRange(rowNo, L.a, 1, 3).getValues()[0]; return { name: String(v[0]), price: v[1], cost: v[2] }; };
      var listed = function (n, c) { return rowsWith_(s, c, n).length > 0; };
      if (p.do === 'add') {
        var nm = actName_(name), price = actMoney_(p.price, 'price'), cost = actMoney_(p.cost, 'cost', true);
        var inList = listed(nm, col), inA = aRows(nm);
        if (inList && inA.length) { // a retry of this add, or the same activity already there
          var ex = abc(inA[0]);
          if (num_(ex.price) === price && String(ex.cost === '' ? '' : num_(ex.cost)) === String(cost)) return { already: true };
          throw apiError_('exists', nm.replace(/^-/, '') + ' is already in ' + cat + '. Change it instead.');
        }
        var other = Object.keys(L.lists).filter(function (c) { return c !== cat && listed(nm, L.lists[c]); });
        if (other.length) throw apiError_('exists', nm.replace(/^-/, '') + ' is already listed under ' + other.join(', '));
        var before = inA.length ? abc(inA[0]) : null;
        if (inA.length) { writes_++; inA.forEach(function (n) { s.getRange(n, L.b, 1, 2).setValues([[price, cost]]); }); } // A had it alone: give it its list
        else appendInCols_(s, L.a, 3, [nm, price, cost]);
        if (!inList) appendInCols_(s, col, 1, [nm]);
        return { audit: { before: before, after: { category: cat, name: nm, price: price, cost: cost } } };
      }
      if (!name) throw apiError_('bad_payload', 'Which activity?');
      var lRows = rowsWith_(s, col, name), oldA = aRows(name);
      if (p.do === 'update') {
        var nn = p.newName === undefined || p.newName === '' ? name : actName_(p.newName, name.charAt(0) !== '-');
        var pr = actMoney_(p.price, 'price'), co = actMoney_(p.cost, 'cost', true);
        if (!lRows.length && !oldA.length) {
          // A retry after the rename went through: the new name is there with these values.
          var done = aRows(nn);
          if (nn !== name && done.length && listed(nn, col)) return { already: true };
          throw apiError_('not_found', name.replace(/^-/, '') + ' is no longer in ' + cat + ' (changed in the sheet?)');
        }
        if (!lRows.length) throw apiError_('not_found', name.replace(/^-/, '') + ' is no longer in ' + cat + ' (changed in the sheet?)');
        if (nn !== name && (aRows(nn).length || Object.keys(L.lists).some(function (c) { return listed(nn, L.lists[c]); }))) {
          throw apiError_('exists', 'Another activity is already called ' + nn.replace(/^-/, ''));
        }
        var b4 = oldA.length ? abc(oldA[0]) : null;
        writes_++;
        if (oldA.length) oldA.forEach(function (n) { s.getRange(n, L.a, 1, 3).setValues([[safe_(nn), pr, co]]); });
        else appendInCols_(s, L.a, 3, [nn, pr, co]); // listed without a price row: A gets one
        if (nn !== name) lRows.forEach(function (n) { s.getRange(n, col).setValue(safe_(nn)); });
        var res = { audit: { before: b4 && { name: b4.name, price: b4.price, cost: b4.cost }, after: { category: cat, name: nn, price: pr, cost: co },
          cells: { a: oldA, list: nn !== name ? lRows : [] } } };
        if (nn !== name && commissionExceptions_()[lc_(name)]) res.warning = name + ' is in Commission exceptions (V) under its old name: rename it there too.';
        return res;
      }
      if (p.do === 'delete') {
        if (!lRows.length) return { already: true };
        var gone = oldA.length ? abc(oldA[0]) : null;
        compactOut_(s, col, 1, lRows);
        // A keeps the name while another list (Service, the other category, Other) still shows it.
        var still = Object.keys(L.lists).some(function (c) { return listed(name, L.lists[c]); });
        if (!still && oldA.length) compactOut_(s, L.a, 3, aRows(name));
        return { audit: { before: gone && { category: cat, name: gone.name, price: gone.price, cost: gone.cost }, cells: { a: still ? [] : oldA, list: lRows } } };
      }
      throw apiError_('bad_payload', 'Unknown activity change');
    },
    /** A guest who is not in Beds24 (walk-in for food, a sunset boat…): added to New guest (C and F), like the old dialog. */
    guest_add: function (op, me) {
      var name = text_((op.payload || {}).name, 60, 'Name');
      if (!name) throw apiError_('bad_payload', 'Type the guest name');
      var ng = sheet_(SHEETS.newGuest);
      var last = lastRowIn_(ng, 1, 6);
      var key = function (v) { return String(v).replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase(); };
      var known = last >= 1 && ng.getRange(1, 3, last, 4).getValues().some(function (r) { return key(r[0]) === key(name) || key(r[3]) === key(name); });
      if (known) return { already: true };
      writes_++;
      ng.getRange(last + 1, 3, 1, 4).setValues([[name, new Date(), '', name]]);
      return {};
    },
    settle: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var pay = payment_(p.payment, false);
      var items = Array.isArray(p.items) ? p.items : [];
      if (!items.length || items.length > 200) throw apiError_('bad_payload', 'Nothing to settle');
      assertCashRight_(me);
      var author = me.author || me.username;
      var ent = entries_(), man = manual_();
      var todo = [];
      items.forEach(function (it) {
        if (!it || typeof it !== 'object') throw apiError_('bad_payload', 'Invalid line');
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
          man.sheet.getRange(t.mRow, M.pay + 1, 1, 4).setValues([[pay, author, safe_(man.sheet.getRange(t.mRow, M.comment + 1).getValue()), t.newTs]]);
        }
      });
      gearRelink_(me, at, todo);
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
      assertCashRight_(me); // staff refund only during their own open shift
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
        // Any payment type (a card refund is often impossible after a day), but a change needs a reason.
        if (pay !== String(orig[E.pay]) && !String(p.reason || '').trim()) throw apiError_('bad_payload', 'Say why the refund is not paid back by ' + orig[E.pay]);
        if (pay === 'Paid to Partner' && String(orig[E.pay]) !== 'Paid to Partner') throw apiError_('bad_payment', 'Paid to Partner is not a way to pay back a guest');
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
      assertCashRight_(me);
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
    /**
     * A partner bill, as the old Create Bill button: chosen lines get their cost (L) and the
     * bill id in S; cost changes are emailed to the alerts address, the bill PDF to the author
     * and the Gili Meno address.
     */
    partner_bill: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var bill = String(p.bill || '');
      if (!BILL_RE.test(bill)) throw apiError_('bad_payload', 'Invalid bill id');
      var items = Array.isArray(p.items) ? p.items : [];
      if (!items.length || items.length > 300) throw apiError_('bad_payload', 'A bill needs 1 to 300 lines');
      var set = {};
      partnerItems_().forEach(function (it) { set[it.object] = true; });
      var ent = entries_(), man = manual_(), pl = partnerLabels_().all;
      var mine = {}, changes = [], rows = [];
      items.forEach(function (it) {
        var ts = String(it.ts);
        if (mine[ts]) throw apiError_('bad_payload', 'Duplicate line');
        mine[ts] = true;
        var r = ent.row(ts);
        if (!r) throw apiError_('line_not_found', 'A line of this bill is no longer in the sheet');
        if (!isPartnerSale_(r, set, pl)) throw apiError_('bad_payload', String(r[E.obj]) + ' is not a partner sale');
        var st = String(r[E.status] || '').trim();
        if (st !== '' && st !== bill) throw apiError_('already_billed', String(r[E.obj]) + ' for ' + r[E.guest] + ' is already on ' + st);
        var cost = amount_(it.cost, 'cost');
        if (st === '' && cost !== costOf_(r)) changes.push({ ts: ts, object: String(r[E.obj]), guest: String(r[E.guest]), before: costOf_(r), after: cost, author: String(r[E.author]) });
        rows.push({ ts: ts, cost: cost });
      });
      ent.rows.forEach(function (r) {
        if (String(r[E.status] || '').trim() === bill && !mine[String(r[E.ts])]) throw apiError_('bill_exists', 'Another bill already has the id ' + bill + '; try again in a minute');
      });
      var already = rows.every(function (x) { return String(ent.row(x.ts)[E.status] || '').trim() === bill; });
      // The cost changes are mailed before anything is written: a retry still knows the old costs.
      var author = me.author || me.username, when = fmt_(at, 'dd/MM/yyyy HH:mm');
      var warn = [];
      if (changes.length) {
        warn.push(mailOnce_(op, 'cost', { to: [MAIL.alerts], subject: 'Modification data Partner in entries',
          html: '<p>Cost changed by ' + author + ' while making bill ' + bill + ':</p><ul>' + changes.map(function (c) {
            return '<li>' + htmlEsc_(c.object) + ' — ' + htmlEsc_(c.guest) + ' (' + c.ts + '): ' + c.before + ' → ' + c.after + ' (sold by ' + htmlEsc_(c.author) + ')</li>';
          }).join('') + '</ul>' }));
      }
      rows.forEach(function (x) {
        (ent.all[x.ts] || []).forEach(function (n) {
          verify_(ent.sheet, n, E.ts + 1, x.ts);
          ent.sheet.getRange(n, E.realCost + 1).setValue(x.cost);
          ent.sheet.getRange(n, E.status + 1).setValue(bill);
          ent.rows[n - 2][E.realCost] = x.cost; ent.rows[n - 2][E.status] = bill;
        });
        (man.all[x.ts] || []).forEach(function (n) { verify_(man.sheet, n, M.ts + 1, x.ts); man.sheet.getRange(n, M.realCost + 1).setValue(x.cost); });
      });
      var billRows = rows.map(function (x) { return ent.row(x.ts); });
      var objects = billRows.map(function (r) { return String(r[E.obj]).trim(); }).filter(function (o, i, a) { return a.indexOf(o) === i; });
      warn.push(mailOnce_(op, 'bill', { to: [author, MAIL.bills], subject: 'Bill (' + objects.join(', ') + ') - Created by ' + author + ' on ' + when,
        body: 'Please find the attached bill.', pdf: billHtml_('Bill', author, when, billRows), pdfName: 'Bill_' + bill.replace(/[\/:]/g, '-') + '.pdf' }));
      warn = warn.filter(String).join(' ');
      return { bill: bill, lines: rows.length, audit: { changes: changes }, already: already || undefined, warning: warn || undefined };
    },
    /** Delete a bill that is not paid: its lines go back to "not billed" (costs stay, like the old Delete). */
    partner_bill_delete: function (op, me) {
      var p = op.payload || {};
      parseAt_(op.at);
      var bill = String(p.bill || '');
      if (!BILL_RE.test(bill)) throw apiError_('bad_payload', 'Invalid bill id');
      var ent = entries_();
      var first = ent.rows.filter(function (r) { return String(r[E.status] || '').trim() === bill; }).map(function (r) { return String(r[E.ts]); }).sort()[0];
      if (first && ent.rows.some(function (r) { return String(r[E.comment]) === bill && String(r[E.status]) === 'Settled' && String(r[E.ts]) > first; })) {
        throw apiError_('bill_paid', 'This bill is already being paid; ask a manager');
      }
      var n = 0;
      ent.rows.forEach(function (r, i) {
        if (String(r[E.status] || '').trim() !== bill) return;
        verify_(ent.sheet, i + 2, E.ts + 1, String(r[E.ts]));
        ent.sheet.getRange(i + 2, E.status + 1).setValue('');
        n++;
      });
      return n ? { lines: n } : { already: true };
    },
    /**
     * "This Bill is Paid!": one payment row per partner object with the net amount (Expense
     * "Payment to Partner" when we pay, Income "Payment From Partner" when the partner pays us),
     * S "Settled", Q the bill id; then the bill's lines get S "Paid". The amounts are recomputed
     * here and must equal what the person confirmed on screen.
     */
    partner_settle: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var bill = String(p.bill || '');
      if (!BILL_RE.test(bill)) throw apiError_('bad_payload', 'Invalid bill id');
      var pay = payment_(p.payment, false);
      if (pay === PAID_TO_PARTNER) throw apiError_('bad_payment', 'Choose how the partner is paid');
      assertCashRight_(me);
      var want = {};
      (Array.isArray(p.rows) ? p.rows : []).forEach(function (r) { want[String(r.object).trim()] = { ts: lineTs_(r.ts, at), net: Math.round(Number(r.net)) }; });
      var ent = entries_(), man = manual_();
      var lines = billLines_(ent, bill);
      // Payment rows of this very operation already written: a previous attempt got that far.
      var resumed = Object.keys(want).length && Object.keys(want).every(function (o) {
        var x = ent.row(want[o].ts);
        return want[o].net === 0 || (x && String(x[E.comment]) === bill && String(x[E.status]) === 'Settled');
      }) && Object.keys(want).some(function (o) { return want[o].net !== 0; });
      if (!lines.length) {
        if (resumed || (Object.keys(want).length && Object.keys(want).every(function (o) { return want[o].net === 0; }) &&
            !ent.rows.some(function (r) { return String(r[E.status] || '').trim() === bill; }))) return { already: true };
        throw apiError_('line_not_found', 'This bill is no longer in the sheet');
      }
      var net = {};
      lines.forEach(function (r) { var o = String(r[E.obj]).trim(); net[o] = (net[o] || 0) + billNet_(r); });
      var objs = resumed ? Object.keys(want) : Object.keys(net);
      if (!resumed && (objs.length !== Object.keys(want).length || objs.some(function (o) { return !want[o] || want[o].net !== Math.round(net[o]); }))) {
        throw apiError_('bill_changed', 'The bill changed since it was shown (amounts: ' + objs.map(function (o) { return o + ' ' + Math.round(net[o]); }).join(', ') + '). Open it again.');
      }
      var author = me.author || me.username, day = dateOnly_(at), out = [], lab = partnerLabels_();
      var PAY_TO = lab.to, PAY_FROM = lab.from;
      objs.forEach(function (o) {
        var n = resumed ? want[o].net : Math.round(net[o]), ts = want[o].ts;
        if (n === 0) return;
        var toPartner = n > 0;
        var row = [day, toPartner ? 'Expense' : 'Income', partnerCategory_(o), o, '', '', '', toPartner ? '' : -n, author, '', '',
          toPartner ? n : '', toPartner ? PAY_TO : PAY_FROM, pay, ts, '', bill];
        var ex = ent.row(ts);
        if (ex && (String(ex[E.obj]).trim() !== o || String(ex[E.comment]) !== bill)) throw apiError_('ts_collision', 'The sheet already has a different line with this id. Nothing was written.');
        if (!ex) {
          appendEntries_(ent, [row]);
          ent.sheet.getRange(ent.last, E.status + 1).setValue('Settled');
          ent.byTs[ts] = ent.last; ent.all[ts] = [ent.last]; row[E.status] = 'Settled'; ent.rows.push(row);
        } else if (String(ex[E.status]) !== 'Settled') {
          ent.sheet.getRange(ent.byTs[ts], E.status + 1).setValue('Settled');
        }
        if (!man.byTs[ts]) appendManual_(man, [row], [toPartner ? 'To agent' : 'From agent']);
        out.push({ object: o, ts: ts, net: n });
      });
      var ng = ss_().getSheetByName(SHEETS.newGuest);
      if (ng) {
        var last = lastRowIn_(ng, 6, 1), have = last >= 1 ? ng.getRange(1, 6, last, 1).getValues().map(function (r) { return String(r[0]); }) : [];
        [PAY_TO, PAY_FROM].forEach(function (m) { if (have.indexOf(m) < 0 && out.some(function (x) { return (x.net > 0) === (m === PAY_TO); })) { ng.getRange(++last, 6).setValue(m); have.push(m); } });
      }
      var when = fmt_(at, 'dd/MM/yyyy HH:mm');
      var warn = mailOnce_(op, 'settle', { to: [author, MAIL.bills, MAIL.alerts], subject: 'BillSettlement (' + objs.join(', ') + ') - Created by ' + author + ' on ' + when,
        body: 'Bill ' + bill + ' paid: ' + out.map(function (x) { return x.object + ' ' + x.net; }).join(', ') + ' (' + pay + ').',
        pdf: billHtml_('BillSettlement', author, when, lines), pdfName: 'Billsettled_' + bill.replace(/[\/:]/g, '-') + '.pdf' });
      // Every row carrying the bill id becomes Paid (the old rows included); only those cells are written.
      ent.rows.forEach(function (r, i) {
        if (String(r[E.status] || '').trim() !== bill) return;
        var cell = ent.sheet.getRange(i + 2, E.status + 1);
        if (String(cell.getValue()).trim() === bill) cell.setValue('Paid');
      });
      return { rows: out, warning: warn || undefined };
    },
    /** End-of-day card terminal settlement, as the old Card Trans. → Settlements button. */
    card_settlement: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var cid = String(p.cid || '');
      if (!/^C[\w-]{6,40}$/.test(cid)) throw apiError_('bad_payload', 'Invalid id');
      var s1 = amount_(p.s1 || 0, 'settlement 1'), s2 = amount_(p.s2 || 0, 'settlement 2'), local = amount_(p.local || 0, 'local cards');
      var comment = text_(p.comment, 300, 'Comment');
      assertCashRight_(me);
      var sh = sheet_(SHEETS.settlements);
      var last = lastRowIn_(sh, 1, 4);
      var author = me.author || me.username;
      var mine = -1;
      if (last >= 2) sh.getRange(2, 9, last - 1, 1).getValues().forEach(function (r, i) { if (String(r[0]).indexOf('[' + cid + ']') >= 0) mine = i + 2; });
      var row, diff, card, net;
      if (mine > 0) { // a previous attempt wrote the row: only the emails may be missing
        row = sh.getRange(mine, 1, 1, 14).getValues()[0];
        diff = num_(row[4]); net = num_(row[5]); card = num_(row[6]);
      } else {
        var prev = lastSettlement_();
        if (!prev) throw apiError_('no_settlement', 'The last row of Settlements has no time stamp; ask a manager to check the Settlements sheet');
        var upTo = tsOf_(at);
        if (upTo.slice(0, 14) <= prev.ts.slice(0, 14)) throw apiError_('settlement_order', 'A later settlement is already in the sheet (' + prev.ts.slice(8, 10) + ':' + prev.ts.slice(10, 12) + '). Ask a manager.');
        card = cardTotal_(entries_(), prev.ts, upTo);
        var total = s1 + s2;
        net = total * FEE_KEEP + local; diff = card - net;
        var note = p.cardTotal !== undefined && Math.round(Number(p.cardTotal)) !== card ? ' (screen showed ' + Math.round(Number(p.cardTotal)) + ')' : '';
        row = [dateOnly_(at), fmt_(at, 'HH:mm:ss'), author, Number(upTo.slice(0, 14) + '000'), diff, net, card, local || '',
          safe_(((comment || 'Comment:') + note + ' [' + cid + ']').trim()), total, s1, s2, s1 ? s1 * 0.978 : '', s2 ? s2 * 0.978 : ''];
        var r = last + 1;
        sh.getRange(r, 1, 1, row.length).setValues([row]);
        sh.getRange(r, 1).setNumberFormat('ddd d mmm');
      }
      var warn = [];
      if (Math.abs(diff) > BIG_DIFF) {
        var prot = ss_().getSheetByName(SHEETS.protect);
        var to = prot ? prot.getRange('F2:F6').getValues().map(function (x) { return String(x[0]).trim(); }).filter(function (a) { return a && !/gserviceaccount\.com$/.test(a); }) : [];
        warn.push(mailOnce_(op, 'cost', { to: to.length ? to : [MAIL.alerts], subject: 'Attention! Settlement with outstanding difference',
          body: 'A settlement was submitted with a high discrepancy.\n\nAmount: ' + diff + '\nDifference exceeds ' + BIG_DIFF + ' Rp.\n\nBy ' + author + '. Comment: ' + (comment || '-') + '\n\nPlease review the submission.' }));
      }
      var head = sh.getRange(1, 1, 1, row.length).getValues()[0];
      warn.push(mailOnce_(op, 'bill', { to: [author], subject: 'Settlement Data Transferred',
        html: '<p>The following data has been successfully transferred to the Settlements sheet:</p><table border="1"><tr>' +
          head.map(function (h) { return '<th>' + htmlEsc_(h) + '</th>'; }).join('') + '</tr><tr>' +
          row.map(function (v, i) { return '<td>' + htmlEsc_(i === 0 ? fmt_(at, 'dd/MM/yyyy') : v) + '</td>'; }).join('') + '</tr></table><p>This is an automated email.</p>' }));
      warn = warn.filter(String).join(' ');
      return { difference: diff, cardTotal: card, net: net, warning: warn || undefined, already: mine > 0 || undefined };
    },
    // ---------------- gear (masks & bikes) ----------------
    /** Free outing (Volunteer): numbers out without a sale, back time as for a rental. */
    gear_out: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]);
      assertGearDesk_(me);
      var gid = String(p.gid || ''); if (!/^G[\w-]{6,40}$/.test(gid)) throw apiError_('bad_payload', 'Invalid id');
      var st = gearState_(), days = Math.max(1, Math.min(30, Math.round(Number(p.days) || 1)));
      var guest = text_(p.guest || 'Volunteer', 120, 'Guest');
      var list = Array.isArray(p.items) ? p.items : [];
      if (!list.length) throw apiError_('bad_payload', 'Pick at least one number');
      var back = gearBack_(at, days), done = {}, rows = [], skipped = [], seen = {};
      gearLogRows_().forEach(function (e) { done[e.id] = 1; });
      // An unknown, unavailable or already out number is skipped; the others go out.
      list.forEach(function (x) {
        var it = findGear_(st, x);
        if (!it || seen[it.id]) { skipped.push(String(x || '').slice(0, 20)); return; }
        seen[it.id] = 1;
        var id = gid + '-' + it.id;
        if (done[id]) return;
        if (it.where !== 'in' || it.condition !== 'OK') { skipped.push(it.id); return; }
        rows.push({ at: at, id: id, type: 'out', item: it.id, ref: guest, back: back, by: me.username, d: { kind: 'volunteer', days: days } });
      });
      gearLog_(rows);
      sgUpdate_();
      var res = { back: back.toISOString(), out: rows.length };
      if (skipped.length) res.skipped = skipped;
      return res;
    },
    /** Return at the desk: condition per number, optional late extension charged Unpaid to the guest. */
    gear_return: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]); // checked before any write (a charge is written before the log)
      if (gearSide_(me, p)) return gearStaffReturn_(op, me, p, at);
      assertGearDesk_(me);
      var gid = String(p.gid || ''); if (!/^G[\w-]{6,40}$/.test(gid)) throw apiError_('bad_payload', 'Invalid id');
      var st = gearState_(), done = {}, set = gearSettings_();
      gearLogRows_().forEach(function (e) { done[e.id] = 1; });
      var rows = [], charges = [], skipped = [], warn = [], seen = {}, already = false;
      (Array.isArray(p.items) ? p.items : []).forEach(function (x) {
        var it = findGear_(st, x && x.item);
        if (!it || seen[it.id]) { skipped.push(String(x && x.item || '').slice(0, 20)); return; }
        seen[it.id] = 1;
        var id = gid + '-' + it.id;
        var cond = GEAR_CONDITIONS.indexOf(x.condition) >= 0 ? x.condition : 'OK';
        if (done[id]) { already = true; return; }
        if (it.where !== 'out' && it.where !== 'sunset') { skipped.push(it.id); return; } // already back: ignored, the others go on
        var guest = it.last ? it.last.guest : '';
        rows.push({ at: at, id: id, type: 'return', item: it.id, ref: guest, by: me.username, d: { condition: cond } });
        if (cond !== 'OK') rows.push({ at: at, id: 'D' + id, type: 'damage', item: it.id, ref: guest, by: me.username, d: { condition: cond, from: 'return', note: gnote_(x.note) } });
        var ch = extCharge_(st, set, it, guest, x.ext, at.getTime(), warn);
        if (ch) charges.push(ch);
      });
      sgUpdate_();
      var res = skipped.length ? { skipped: skipped } : {};
      if (!rows.length) { res.returned = 0; if (already) res.already = true; return res; }
      gearCharge_(me, at, charges);
      gearLog_(rows);
      res.returned = rows.filter(function (r) { return r.type === 'return'; }).length; res.charged = charges.length;
      if (warn.length) res.warning = warn.join(' ');
      return res;
    },
    /** Gear staff: numbers that leave on the Sunset Boat (due back 21:30). */
    sunset_out: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]);
      var trip = String(p.trip || ''); if (!/^T[\w-]{6,40}$/.test(trip)) throw apiError_('bad_payload', 'Invalid trip');
      if (gearEventDone_(trip + '-out')) return { already: true };
      var st = gearState_();
      var picked = {}, items = [];
      (Array.isArray(p.items) ? p.items : []).forEach(function (id) { var it = findGear_(st, id); if (it && !picked[it.id]) { picked[it.id] = 1; items.push(it); } });
      if (!(Array.isArray(p.items) && p.items.length)) throw apiError_('bad_payload', 'Pick at least one number');
      var back = sunsetBack_(at), rows = [];
      // A number the desk still has as out was really in the box: a difference to clear up; it
      // keeps its rental (guest, late extension) and is not counted on the boat.
      var go = items.filter(function (it) {
        if (it.where === 'out' || it.where === 'sunset') { rows.push({ at: at, id: trip + '-d-' + it.id, type: 'diff', item: it.id, ref: trip, by: me.username, d: { kind: 'counted_but_out', last: it.last } }); return false; }
        return it.where === 'in';
      });
      // No number really leaves: nothing is written (no empty trip, no difference).
      if (!go.length) return { items: [], info: 'No number left on the boat: all were already recorded as out' };
      rows.unshift({ at: at, id: trip + '-out', type: 'sunset_out', item: '', ref: trip, back: back, by: me.username, d: { items: go.map(function (i) { return i.id; }) } });
      gearLog_(rows);
      sgUpdate_();
      return { back: back.toISOString(), items: go.map(function (i) { return i.id; }) };
    },
    /** Gear staff: numbers back from the Sunset Boat; the others become differences. */
    sunset_back: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]);
      var trip = String(p.trip || ''); if (!/^T[\w-]{6,40}$/.test(trip)) throw apiError_('bad_payload', 'Invalid trip');
      if (gearEventDone_(trip + '-back')) return { already: true };
      var st = gearState_(), t = st.trips.filter(function (x) { return x.trip === trip; })[0];
      if (!t && loggedOp_('sunset_out', trip)) return { already: true, info: 'No number had left on this trip: nothing to record' };
      if (!t) throw apiError_('line_not_found', 'Unknown Sunset Boat trip');
      var back = (Array.isArray(p.items) ? p.items : []).map(function (id) { return String(id).toUpperCase(); }).filter(function (id) { return t.items.indexOf(id) >= 0; });
      var where = {}; st.items.forEach(function (i) { where[i.id] = i.where; });
      var missing = t.items.filter(function (id) { return back.indexOf(id) < 0 && where[id] === 'sunset'; }); // returned at the desk meanwhile: not missing
      var rows = [{ at: at, id: trip + '-back', type: 'sunset_back', item: '', ref: trip, by: me.username, d: { items: back, missing: missing } }];
      missing.forEach(function (id) {
        var it = gearItem_(st, id);
        rows.push({ at: at, id: trip + '-m-' + id, type: 'diff', item: id, ref: trip, by: me.username, d: { kind: 'sunset_missing', last: it.last } });
      });
      // Damage seen when the masks come off the boat: to the reception's decisions.
      var cond = p.conditions && typeof p.conditions === 'object' ? p.conditions : {};
      back.forEach(function (id) {
        var c = GEAR_CONDITIONS.indexOf(cond[id]) >= 0 ? cond[id] : 'OK';
        if (c !== 'OK') rows.push({ at: at, id: 'D' + trip + '-' + id, type: 'damage', item: id, ref: 'Sunset Boat', by: me.username, d: { condition: c, from: 'sunset', note: gnote_((p.notes || {})[id]) } });
      });
      gearLog_(rows);
      back.forEach(function (id) { sgUpdate_(id, { status: 'OK' }); });
      return { back: back.length, missing: missing };
    },
    /** Evening check, blind: every number found and its condition; the sheet works out the differences. */
    gear_count: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]);
      var cid = String(p.cid || ''); if (!/^K[\w-]{6,40}$/.test(cid)) throw apiError_('bad_payload', 'Invalid id');
      if (gearEventDone_(cid)) return { already: true };
      var st = gearState_(), seen = {}, notes = {};
      (Array.isArray(p.items) ? p.items : []).forEach(function (x) {
        var it = findGear_(st, x && x.item);
        if (!it) return; // retired since the phone's last pull: the rest of the check counts
        seen[it.id] = GEAR_CONDITIONS.indexOf(x.condition) >= 0 ? x.condition : 'OK';
        notes[it.id] = gnote_(x.note);
      });
      var open = {};
      st.diffs.forEach(function (d) { open[d.item + '|' + d.kind] = true; });
      var rows = [{ at: at, id: cid, type: 'count', item: '', ref: '', by: me.username, d: { items: Object.keys(seen).map(function (k) { return { item: k, condition: seen[k] }; }) } }];
      var diff = function (it, kind) {
        if (open[it.id + '|' + kind]) return;
        rows.push({ at: at, id: cid + '-' + it.id, type: 'diff', item: it.id, ref: cid, by: me.username, d: { kind: kind, last: it.last } });
      };
      st.items.forEach(function (it) {
        var c = seen[it.id];
        if (c !== undefined) {
          if (it.where === 'out' || it.where === 'sunset') diff(it, 'counted_but_out');
          if (c !== 'OK' && c !== it.condition) rows.push({ at: at, id: 'D' + cid + '-' + it.id, type: 'damage', item: it.id, ref: it.last ? it.last.guest : '', by: me.username, d: { condition: c, from: 'check', note: notes[it.id] || '' } });
        } else if (it.where === 'in' && it.condition === 'OK') { // a broken one may be away for repair
          diff(it, it.last && it.last.returned ? 'returned_not_in_box' : 'missing');
        }
      });
      gearLog_(rows);
      if (rows.some(function (r) { return r.type === 'damage'; })) sgUpdate_(); // a number found Lost leaves the stock
      return { differences: rows.filter(function (r) { return r.type === 'diff'; }).length };
    },
    /**
     * One side confirms a difference (the side is the role: gear staff or reception). At the desk,
     * an item counted in the box but recorded out is also returned: by the guest (late extension
     * possible) or found on site (no extension).
     */
    gear_confirm: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]); // checked before any write (a charge is written before the log)
      var cfid = String(p.cfid || ''); if (!/^F[\w-]{6,40}$/.test(cfid)) throw apiError_('bad_payload', 'Invalid id');
      if (gearEventDone_(cfid)) return { already: true };
      var side = gearSide_(me, p) ? 'gear' : 'reception';
      if (side === 'reception') assertCashRight_(me);
      var st = gearState_(), df = st.diffs.filter(function (d) { return d.id === String(p.diff); })[0];
      if (!df) throw apiError_('line_not_found', 'This difference is already closed');
      // Both sides confirm: two different people (staff accounts work in both apps).
      var other = df[(side === 'gear' ? 'reception' : 'gear') + 'By'];
      if (other && other === me.username) throw apiError_('bad_payload', 'Someone else must confirm the other side');
      var rows = [], charges = [], warn = [];
      // 'mistake' (12/11): touched by mistake at the check, it is still with the guest: no return.
      if (side === 'reception' && df.kind === 'counted_but_out' && p.action !== 'mistake') {
        var it = gearItem_(st, df.item);
        if (it.where === 'out' || it.where === 'sunset') {
          rows.push({ at: at, id: cfid + '-r', type: 'return', item: it.id, ref: it.last ? it.last.guest : '', by: me.username, d: { condition: it.condition, via: p.action } });
          if (p.action === 'returned' && p.ext) {
            var ch = extCharge_(st, gearSettings_(), it, it.last ? it.last.guest : '', p.ext, at.getTime(), warn);
            if (ch) charges.push(ch);
          }
        }
      }
      if (df.kind === 'returned_late' && side === 'reception' && p.action === 'returned' && p.ext && df.last && df.late > 0) {
        var lset = gearSettings_(), lit = gearItem_(st, df.item), lunit = lit.kind === 'mask' ? lset.ext.mask : lset.ext.bike;
        if (lunit) charges.push({ ts: p.ext.ts, object: lit.kind === 'mask' ? lset.product.mask : lset.product.bike, qty: Math.max(1, Math.round(Number(df.late) || 1)), unit: lunit, guest: df.last.guest, comment: 'Extension ' + lit.id });
      }
      if (df.kind === 'sunset_missing' && p.action === 'found') { // came back late from the boat
        var sit = gearItem_(st, df.item);
        if (sit.where === 'sunset') rows.push({ at: at, id: cfid + '-r', type: 'return', item: sit.id, ref: 'Sunset Boat', by: me.username, d: { condition: sit.condition, via: 'found' } });
      }
      rows.push({ at: at, id: cfid, type: 'confirm', item: df.item, ref: df.id, by: me.username, d: { side: side, action: String(p.action || ''), note: String(p.note || '').slice(0, 300) } });
      gearCharge_(me, at, charges);
      gearLog_(rows);
      if (rows[0].type === 'return') sgUpdate_(df.item, { status: rows[0].d.condition });
      // A count mistake at the evening check: the managers are told (once per difference, 12/11).
      if (p.action === 'mistake') {
        var last = df.last || {};
        var w = mailOnce_({ id: df.id }, 'mistake', { to: ALERT_TO.concat([MAIL.alerts]),
          subject: 'Rabbit Tree gear: count mistake on ' + df.item + ' (' + gfmt_(at, 'dd/MM/yyyy HH:mm') + ')',
          body: 'At the evening check, ' + df.item + ' was counted in the box while it is out' + (last.guest ? ' with ' + last.guest : '') + '.\n' +
            'Marked as a count mistake by ' + (me.name || me.username) + ' (' + side + (side === 'gear' ? ', gear app' : ', reception') + ')' + (p.note ? ': ' + String(p.note).slice(0, 300) : '') + '.\n' +
            'It stays out' + (last.guest ? ' with ' + last.guest : '') + '. Counted by ' + (df.by || '?') + '.\n\nCheck it if this happens again: the staff may be touching numbers without looking.' });
        if (w) warn.push(w);
      }
      return warn.length ? { side: side, warning: warn.join(' ') } : { side: side };
    },
    /** Reception: a missing item is given up as lost; the loss goes to the damage decisions. */
    gear_lost: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]);
      assertGearDesk_(me);
      var lid = String(p.lid || ''); if (!/^L[\w-]{6,40}$/.test(lid)) throw apiError_('bad_payload', 'Invalid id');
      if (gearEventDone_(lid)) return { already: true };
      var st = gearState_(), df = st.diffs.filter(function (d) { return d.id === String(p.diff); })[0];
      if (!df) throw apiError_('line_not_found', 'This difference is already closed');
      if (df.kind === 'counted_but_out' || df.kind === 'rented_while_out' || df.kind === 'returned_late' || df.kind === 'returned_not_out') throw apiError_('bad_payload', df.item + ' was seen: it cannot be marked lost');
      if (df.kind === 'sale_unlinked') throw apiError_('bad_payload', 'A sale not linked to a number is checked, not marked lost');
      assertCashRight_(me);
      var guest = df.last ? df.last.guest : '';
      gearLog_([{ at: at, id: lid, type: 'lost', item: df.item, ref: df.id, by: me.username, d: {} },
        { at: at, id: 'D' + lid, type: 'damage', item: df.item, ref: guest, by: me.username, d: { condition: 'Lost', from: 'lost' } }]);
      sgUpdate_(df.item, { status: 'Lost' });
      return {};
    },
    /** Reception decides a damage: charge the guest (Unpaid line at the set price), don't, or keep pending. */
    gear_decide: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]); // checked before any write (a charge is written before the log)
      assertGearDesk_(me);
      var did = String(p.did || ''); if (!/^E[\w-]{6,40}$/.test(did)) throw apiError_('bad_payload', 'Invalid id');
      if (gearEventDone_(did)) return { already: true };
      var st = gearState_(), dm = st.damages.filter(function (d) { return d.id === String(p.damage); })[0];
      if (!dm) throw apiError_('line_not_found', 'Unknown damage');
      if (dm.decision !== 'pending') throw apiError_('bad_payload', 'Already decided');
      var decision = ['charge', 'nocharge', 'pending'].indexOf(p.decision) >= 0 ? p.decision : 'pending';
      var amount = null;
      if (decision === 'charge') {
        amount = amount_(p.amount, 'amount');
        if (amount <= 0) throw apiError_('bad_amount', 'Enter the amount to charge');
        var guest = text_(p.guest || dm.guest, 120, 'Guest');
        if (!guest || /^(sunset boat|volunteer)$/i.test(guest)) throw apiError_('bad_payload', 'Say which guest to charge');
        gearCharge_(me, at, [{ ts: p.ts, object: 'Gear damage', qty: 1, unit: amount, guest: guest, comment: dm.item + ' ' + dm.condition }]);
      }
      gearLog_([{ at: at, id: did, type: 'decide', item: dm.item, ref: dm.id, by: me.username, d: { decision: decision, amount: amount } }]);
      return {};
    },
    /**
     * Status of a mask or bike in the box, set by hand (12/11): gear staff in their app or the desk.
     * OK = repaired, back in stock (a "service" event). Anything else = out of service (a "damage"
     * from "status", nothing to charge: no guest). Only for what is in the box, not out or lost.
     */
    gear_condition: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]);
      if (!gearSide_(me, p)) assertCashRight_(me);
      var uid = String(p.uid || ''); if (!/^U[\w-]{6,40}$/.test(uid)) throw apiError_('bad_payload', 'Invalid id');
      var it = gearItem_(gearState_(), p.item);
      var did = 'D' + uid + '-' + it.id;
      if (gearEventDone_(uid) || gearEventDone_(did)) return { already: true };
      var cond = String(p.condition || '');
      var allowed = it.kind === 'bike' ? ['OK', 'Broken', 'Other'] : ['OK', 'Broken', 'Ring missing', 'Snorkel missing', 'Mask missing', 'Other'];
      if (allowed.indexOf(cond) < 0) throw apiError_('bad_payload', 'Unknown status ' + cond);
      if (it.where !== 'in') throw apiError_('bad_payload', it.id + ' is not in the box (' + it.where + '): its status changes when it comes back');
      var note = String(p.note || '').slice(0, 300);
      if (cond === 'Other' && !note.trim()) throw apiError_('bad_payload', 'Say what is wrong');
      if (cond === it.condition) return { same: true };
      if (cond === 'OK') gearLog_([{ at: at, id: uid, type: 'service', item: it.id, ref: '', by: me.username, d: { via: 'status', note: note } }]);
      else gearLog_([{ at: at, id: did, type: 'damage', item: it.id, ref: '', by: me.username, d: { condition: cond, from: 'status', note: note } }]);
      sgUpdate_();
      return {};
    },
    /** Repaired or replaced: the number is back in stock. */
    gear_service: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      needSheets_([SHEETS.gearLog]);
      assertGearDesk_(me);
      var sid = String(p.sid || ''); if (!/^R[\w-]{6,40}$/.test(sid)) throw apiError_('bad_payload', 'Invalid id');
      if (gearEventDone_(sid)) return { already: true };
      var it = gearItem_(gearState_(), p.item);
      gearLog_([{ at: at, id: sid, type: 'service', item: it.id, ref: '', by: me.username, d: {} }]);
      sgUpdate_(it.id, { status: 'OK' });
      return {};
    },
    /** TEMPORARY (bar cash-out): one Entries Manual row, like the old sheet. */
    bar_cashout: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var ts = lineTs_(p.ts, at);
      var amount = amount_(p.amount, 'amount');
      if (amount <= 0) throw apiError_('bad_amount', 'Invalid amount');
      var comment = text_(p.comment, 300, 'Comment');
      assertCashRight_(me);
      var man = manual_();
      if (man.byTs[ts]) return { already: true };
      var row = [dateOnly_(at), BAR_TYPE, '', '', '', '', '', amount, '', '', '', '', '', 'Extern cash', me.author || me.username, comment, ts];
      var r = man.last + 1;
      man.sheet.getRange(r, 17).setNumberFormat('@');
      man.sheet.getRange(r, 1, 1, 17).setValues([row]);
      man.sheet.getRange(r, 1).setNumberFormat('dd/MM/yyyy');
      return {};
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
          safe_((String(p.comment || '') + ' ' + tag).trim()), 'Opening'], [1]);
      }
      shifts.appendRow([text_(p.shiftId), me.username, author, at, counted, diff, '', '', '', '', 'Open', '', text_(p.comment, 300, 'Comment')]);
      return { shiftId: p.shiftId, difference: diff };
    },
    shift_close: function (op, me) {
      var p = op.payload || {};
      var at = parseAt_(op.at);
      var counted = amount_(p.cashCounted, 'cashCounted');
      var cashout = amount_(p.cashout === undefined ? 0 : p.cashout, 'cashout');
      // The screen's expected cash can be negative (more paid out than in): accepted, the email tells.
      var expected = Math.round(Number(p.expectedCash));
      if (!isFinite(expected)) throw apiError_('bad_amount', 'Invalid amount for expectedCash');
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
          safe_((String(p.comment || '') + ' ' + tag).trim()), 'Closing'], [1]);
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
      // Cash difference or phantom cash still open: the manager and the owner are told (never blocks the close).
      var open = cashRows_().filter(function (c) { return c.type === 'Phantom'; });
      var warn = '';
      if (diff !== 0 || open.length) {
        warn = mailOnce_(op, 'close', { to: ALERT_TO.concat([MAIL.alerts]), subject: 'Shift closed with ' + (diff !== 0 ? 'a cash difference of ' + diff : 'open phantom cash') + ' — ' + author,
          body: 'Shift ' + p.shiftId + ' of ' + rec[COL.user] + ' (' + author + ') closed by ' + me.username + ' at ' + fmt_(at, 'dd/MM/yyyy HH:mm') + '.\n\n' +
            'Expected cash (sheet): ' + sheetExpected + '\nExpected on the screen: ' + expected + '\nCounted: ' + counted + '\nCash-out: ' + cashout +
            '\nDifference (counted + cash-out - expected): ' + diff + '\n\nPhantom cash not solved: ' + (open.length ? '\n' + open.map(function (c) {
              return '- ' + (c.ts ? c.ts.slice(6, 8) + '/' + c.ts.slice(4, 6) + ' ' + c.ts.slice(8, 10) + ':' + c.ts.slice(10, 12) : '') + ' ' + c.diff + ' by ' + c.author + (c.comment ? ': ' + c.comment : '');
            }).join('\n') : 'none') + (p.comment ? '\n\nComment: ' + String(p.comment).slice(0, 300) : '') });
      }
      // UI_Shifts last: it is the "done" marker. {opId} lets a retry recognise its own close.
      var note = expected !== sheetExpected ? 'screen expected ' + expected + ', sheet ' + sheetExpected : '';
      var comment = [rec[COL.comment], String(p.comment || ''), note, '{' + op.id + '}'].filter(String).join(' | ');
      shifts.getRange(idx + 2, COL.closedAt + 1, 1, 7).setValues([[at, counted, cashout, diff, 'Closed', me.username, text_(comment)]]);
      var res = { shiftId: p.shiftId, difference: diff, expected: sheetExpected };
      if (warn) res.warning = warn;
      return res;
    }
  };

  var PUSH_BUDGET_MS = 18000; // stop cleanly well before the Apps Script / client timeouts
  // Bugs on bad data (a field of the wrong type): the op is refused, the queue goes on.
  var DATA_ERRORS = ['TypeError', 'RangeError', 'SyntaxError'];
  function push(body) {
    var t0 = Date.now();
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
        if (k > 0 && Date.now() - t0 > PUSH_BUDGET_MS) { // the rest is sent again by the device
          SpreadsheetApp.flush();
          return { results: results, shift: shiftState_(), partial: true, budget: true };
        }
        var op = ops[k];
        var id = String(op && op.id || '');
        if (!id) { results.push({ id: id, status: 'rejected', error: 'bad_op', message: 'Operation without id' }); continue; }
        if (/^[=+@]/.test(id)) { results.push({ id: id, status: 'rejected', error: 'bad_op', message: 'Invalid operation id' }); continue; }
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
          if (a.user.role === 'gear' && !GEAR_OPS[op.type]) throw apiError_('forbidden', 'The gear account only does the gear checks');
          if (!gearSide_(a.user, op.payload) && (op.type === 'sunset_out' || op.type === 'sunset_back' || op.type === 'gear_count')) throw apiError_('forbidden', 'Done by the gear staff in their app');
          var h = HANDLERS[op.type];
          if (!h) throw apiError_('unknown_type', 'Unknown operation ' + op.type);
          writes_ = 0;
          res = h(op, a.user) || {};
          if (gearDirty_) { gearDirty_ = false; try { sgSync_(); } catch (e) { /* only the mirror: redone by the next gear operation */ } }
          status = 'applied';
          if (res.audit || res.warning) detail = JSON.stringify({ warning: res.warning, audit: res.audit }).slice(0, 20000);
          delete res.audit;
        } catch (e) {
          gearDirty_ = false;
          var code = e.apiCode;
          // Part of it is already in the sheet (money written, then a tab missing): never refused,
          // retried until it goes through (shown as "not going through" on the device).
          if (writes_ > 0 && (code === 'missing_sheet' || (!code && DATA_ERRORS.indexOf(e.name) >= 0))) code = null;
          else if (!code && DATA_ERRORS.indexOf(e.name) >= 0) { console.error(e); code = 'bad_payload'; e = apiError_(code, 'Invalid operation data (' + e.message + ')'); }
          else if (code === 'missing_sheet') e = apiError_(code, e.message + ' — ask a manager to check the spreadsheet; enter this operation again afterwards');
          // Not a business refusal (Google timeout, quota, lock...): stop here, do not mark
          // as seen, report what was done so far; the device retries the rest later.
          if (!code) {
            console.error(e);
            SpreadsheetApp.flush();
            return { results: results, shift: shiftState_(), partial: true, message: e.apiCode === 'missing_sheet' ? e.message + ' — ask a manager to check the spreadsheet' : undefined };
          }
          status = 'rejected';
          detail = code + ': ' + e.message;
          res = { error: code, message: e.message };
        }
        var vBefore = version_();
        var pl = op.payload && typeof op.payload === 'object' ? op.payload : {};
        log.appendRow([new Date(), id, text_(body.deviceId, 0), text_(who, 0), text_(op.type, 0),
          text_(pl.shiftId || pl.saleId || pl.ts || pl.origTs || pl.pid || pl.bill || pl.cid || pl.gid || pl.trip || pl.cfid || pl.did || pl.lid || pl.sid || pl.name || '', 0), text_(op.at, 0), status, safe_(detail),
          safe_(JSON.stringify(op.payload || {}).slice(0, 45000))]);
        var props_ = PropertiesService.getScriptProperties();
        props_.setProperty('UI_V', String(vBefore + 1));
        MAIL_KINDS.forEach(function (k) { if (props_.getProperty('UI_MAIL_' + id + '_' + k)) props_.deleteProperty('UI_MAIL_' + id + '_' + k); });
        seen[id] = { status: status, detail: detail };
        var out = { id: id, status: status };
        Object.keys(res || {}).forEach(function (key) { out[key] = res[key]; });
        results.push(out);
      }
      SpreadsheetApp.flush();
      return { results: results, shift: shiftState_() };
    });
  }

  /** Is the sheet reachable right now (closing a shift needs the Internet)? No lock, no session. */
  function ping() { return { serverTime: new Date().toISOString() }; }

  function handle(e) {
    soldCache_ = null; gearDirty_ = false;
    try {
      var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
      var fn = { login: login, pull: pull, push: push, logout: logout, ping: ping, pos_pass: pos_pass, pos_verify: pos_verify, rs_pass: rs_pass, pass_login: pass_login, pos_staff: pos_staff, pos_lines: pos_lines, pos_address: pos_address, pos_guests: pos_guests }[body.action];
      if (!fn) throw apiError_('unknown_action', 'Unknown action');
      var out = fn(body);
      out.ok = true;
      return json_(out);
    } catch (err) {
      if (!err.apiCode) console.error(err);
      return json_({ ok: false, error: err.apiCode || 'server_error', message: err.apiCode ? err.message : 'Server error' });
    }
  }

  /**
   * Run daily at 21:30 (WITA) by the trigger UI_setup installs: if today's evening check is
   * not in Gear_Log, the manager, the owner and the alerts address get one email (once a day).
   */
  function eveningCheck() {
    if (!ss_().getSheetByName(SHEETS.sg) || !ss_().getSheetByName(SHEETS.gearLog)) return 'no gear sheets';
    var st = gearState_();
    if (st.countedToday) return 'done';
    var props = PropertiesService.getScriptProperties(), key = 'UI_COUNTMAIL_' + gfmt_(new Date(), 'yyyy-MM-dd');
    if (props.getProperty(key)) return 'already sent';
    var last = st.lastCount ? gfmt_(new Date(st.lastCount.at), 'dd/MM/yyyy HH:mm') + ' by ' + st.lastCount.by : 'never';
    var out = st.items.filter(function (i) { return i.where === 'out' || i.where === 'sunset'; }).length;
    MailApp.sendEmail({ to: ALERT_TO.concat([MAIL.alerts]).join(', '), subject: 'Rabbit Tree: gear evening check not done today (' + gfmt_(new Date(), 'dd/MM/yyyy') + ')',
      body: 'The gear staff did not send the evening check of masks and bikes today (checked at ' + gfmt_(new Date(), 'HH:mm') + ').\n\n' +
        'Last check: ' + last + '.\nNumbers recorded out now: ' + out + '.\n\nWithout the check no late extension can be charged for tonight. ' +
        'Please ask the gear staff to do it in their app (it can still be sent late).\n\nThis is an automated email.' });
    props.setProperty(key, new Date().toISOString());
    return 'sent';
  }

  return { handle: handle, setup: setup, eveningCheck: eveningCheck, _hash: hashPassword_ };
})();

function doPost(e) { return UIAPI.handle(e); }
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, service: 'reception-ui' }))
    .setMimeType(ContentService.MimeType.JSON);
}
/** Run once from the editor: creates UI_Users, UI_Log and UI_Shifts, installs the 21:30 check reminder. */
function UI_setup() { var r = UIAPI.setup(); Logger.log(r); return r; }
/** Daily trigger (21:30 WITA): emails if the gear evening check is not done. */
function UI_eveningCheck() { var r = UIAPI.eveningCheck(); Logger.log(r); return r; }
