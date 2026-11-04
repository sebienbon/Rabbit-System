/**
 * Beds24 ↔ Entries — synchronisation of ROOM payments (runs every 5 minutes).
 *
 * Rules (see the "?" in Guest bills):
 *   - Nights and extensions are created in Beds24. A guest who pays right away is paid in Beds24.
 *   - Any later payment is recorded in the reception (Guest bills), never in Beds24.
 *   - Nobody changes a payment in Beds24.
 *
 * What one run does, for bookings that arrived on or after B24_START:
 *   1. Reception → Beds24: Entries rows Income / Room with a booking id in U, paid (not Unpaid,
 *      not Cancelled) and V empty are added to Beds24 as a payment line "[RT-<timestamp O>] <payment>".
 *      The Beds24 line id is written to V. A line already carrying the tag is never sent twice.
 *   2. Beds24 → Entries: payment lines typed in Beds24 (no [RT-] tag, id not in V) become paid
 *      Room rows, with U and V filled.
 *   3. From the check-in day, what is still owed (charges − Beds24 payments − open reception
 *      lines) becomes one Room row "Unpaid".
 *   4. Booking cancelled: its Unpaid rows become "Cancelled" (amount 0). Paid rows are never
 *      touched: they are reported in B24_Control.
 *   Differences (amount changed in Beds24, overpaid booking…) go to B24_Control.
 *
 * Payment modes = the list of Data activities, column Q (same list as the reception). In Beds24 the
 * mode is the status of the payment line. A payment whose mode is not in the list is NOT imported:
 * it waits in B24_Control until a manager picks the mode in column G (imported at the next run).
 * Payment lines marked "Unpaid" in Beds24 are not payments: ignored, the amount stays due.
 * Airbnb and Expedia Collect bookings are paid to the channel: what is due becomes a paid
 * Transfer/Others line instead of an Unpaid one.
 * A separate booking for a guest who is in the house (same email, or same name in any order) is an
 * extension: it shows in the reception right away, under the same guest name. A doubtful match
 * (one name in common, starting the day after) goes to B24_Control.
 *
 * Bar, laundry, tours… never go to Beds24: only category Room.
 *
 * SETUP (once, in the Apps Script editor):
 *   1. Project Settings > Script Properties: add B24_API_KEY and B24_PROP_KEY (same values as
 *      in fetchBeds24Data). Optional: B24_START (yyyy-MM-dd), first check-in day handled; default = today.
 *      Bookings that arrived before keep being handled the old way (no duplicates with old rows).
 *   Then run B24_setup(): it installs the 5-minute trigger and makes a first run.
 *   2. The sync starts in TEST mode: nothing is written; what it would do is listed in B24_DryRun.
 *   3. When the list looks right, run B24_goLive().  B24_pause() switches back to test mode.
 *
 * Keys never live in this file (the repository is public).
 */

var B24 = (function () {
  var API = 'https://api.beds24.com/json/';
  var ENTRIES = 'Entries', MANUAL = 'Entries Manual', CONTROL = 'B24_Control', DRY = 'B24_DryRun';
  var COL_U = 21, COL_V = 22;               // booking id, Beds24 payment line id
  var TS_TZ = 'Asia/Singapore';             // same as the reception timestamps (UTC+8)
  var AUTHOR = 'Beds24 sync';
  var TAG = /^\[RT-(\d{17})\]/;
  var PAY_UNPAID = 'Unpaid', PAY_CANCELLED = 'Cancelled';
  // Entries columns (0-based), as in 30.UI_api.gs
  var E = { date: 0, type: 1, sub: 2, obj: 3, qty: 4, unit: 5, total: 6, real: 7, author: 8, unitCost: 9,
    cost: 10, realCost: 11, guest: 12, pay: 13, ts: 14, past: 15, comment: 16 };
  var M = { ts: 16 };

  // ---------- settings ----------
  function props_() { return PropertiesService.getScriptProperties(); }
  function auth_() {
    var p = props_();
    var apiKey = p.getProperty('B24_API_KEY'), propKey = p.getProperty('B24_PROP_KEY');
    if (!apiKey || !propKey) throw new Error('Beds24 keys missing: run B24_setup() once');
    return { apiKey: apiKey, propKey: propKey };
  }
  function live_() { return props_().getProperty('B24_LIVE') === 'yes'; }
  function start_() { return props_().getProperty('B24_START') || '2999-01-01'; }

  // ---------- small helpers ----------
  function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
  function ymd_(d) { return Utilities.formatDate(d, TS_TZ, 'yyyy-MM-dd'); }
  function compact_(s) { return s.replace(/-/g, ''); }
  function addDays_(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  var lastTs_ = '';
  function newTs_() {
    var t = Utilities.formatDate(new Date(), TS_TZ, 'yyyyMMddHHmmssSSS');
    while (t <= lastTs_) { Utilities.sleep(2); t = Utilities.formatDate(new Date(), TS_TZ, 'yyyyMMddHHmmssSSS'); } // 17 digits: too long for Number + 1
    lastTs_ = t;
    return t;
  }
  function num_(v) { var n = Number(String(v).replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; }
  function round_(n) { return Math.round(n * 100) / 100; }
  function safe_(v) { return typeof v === 'string' && /^[=+@]/.test(v) ? "'" + v : v; }

  /** Payment modes of the reception: Data activities, column Q (Unpaid excluded). */
  var modesCache_ = null;
  function modes_() {
    if (modesCache_) return modesCache_;
    var s = ss_().getSheetByName('Data activities');
    var list = s ? s.getRange('Q2:Q20').getValues().map(function (r) { return String(r[0]).trim(); }).filter(String) : [];
    modesCache_ = list.filter(function (p) { return key_(p) !== key_(PAY_UNPAID); });
    return modesCache_;
  }
  function key_(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function validMode_(m) { return modes_().filter(function (p) { return key_(p) === key_(m); })[0] || null; }
  /** Mode of a payment line typed in Beds24: its status (picked from Beds24's list), else its description. null = unknown. */
  function method_(item) {
    var byStatus = validMode_(item.status);
    if (byStatus) return byStatus;
    var d = key_(String(item.description || '').replace(/^\[RT-[^\]]*\]/, ''));
    if (!d) return null;
    var hits = modes_().filter(function (p) { return d.indexOf(key_(p)) >= 0; });
    return hits.length === 1 ? hits[0] : null;
  }
  function transferMode_() { return modes_().filter(function (p) { return /transfer/i.test(p); })[0] || 'Transfer/Others'; }
  /** A payment line marked Unpaid in Beds24 is not a payment. */
  function fakeUnpaid_(i) { return key_(i.status) === key_(PAY_UNPAID); }
  /** Paid to the channel: Airbnb, Expedia Collect. */
  function prepaid_(b) {
    if (/airbnb/i.test(String(b.referer || ''))) return 'Airbnb';
    if (/expedia\s*collect/i.test(String(b.rateDescription || ''))) return 'Expedia Collect';
    return '';
  }
  /** Room name: start of the first room charge ("Tree House Wednesday, 4 November…"). */
  function roomName_(b) {
    var c = (b.invoice || []).filter(function (i) { return Number(i.type) < 200; })[0];
    var d = c ? String(c.description || '') : '';
    var m = d.match(/^(.*?)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/);
    return (m ? m[1] : d).trim() || 'Room';
  }
  function guestName_(b) {
    if (b._guest) return b._guest; // extension: same name as the stay it extends
    return guestName0_(b);
  }
  function guestName0_(b) { return (String(b.guestFirstName || '') + ' ' + String(b.guestName || '')).replace(/\s+/g, ' ').trim() || ('Booking ' + b.bookId);
  }
  function nameWords_(b) { return guestName0_(b).toLowerCase().split(/[^a-z\u00c0-\u024f]+/).filter(function (w) { return w.length >= 2; }).sort(); }
  /** Is b a separate booking extending the stay of a guest in the house? */
  function extensionOf_(b, inHouse) {
    var email = String(b.guestEmail || '').trim().toLowerCase(), words = nameWords_(b), sure = null, maybe = null;
    inHouse.forEach(function (h) {
      if (h.bookId === b.bookId || sure) return;
      var hEmail = String(h.guestEmail || '').trim().toLowerCase(), hw = nameWords_(h);
      if ((email && email === hEmail) || (words.length && words.join(' ') === hw.join(' '))) { sure = h; return; }
      var common = words.filter(function (w) { return w.length >= 3 && hw.indexOf(w) >= 0; }).length;
      if (common && String(b.firstNight) === ymd_(addDays_(Utilities.parseDate(String(h.lastNight), TS_TZ, 'yyyy-MM-dd'), 1))) maybe = h;
    });
    return sure ? { host: sure, sure: true } : maybe ? { host: maybe, sure: false } : null;
  }
  function charges_(b) { return round_((b.invoice || []).filter(function (i) { return Number(i.type) < 200; }).reduce(function (s, i) { return s + num_(i.qty) * num_(i.price); }, 0)); }
  function payments_(b) { return (b.invoice || []).filter(function (i) { return Number(i.type) >= 200 && !fakeUnpaid_(i); }); }
  function fakeUnpaids_(b) { return (b.invoice || []).filter(function (i) { return Number(i.type) >= 200 && fakeUnpaid_(i); }); }
  function payAmount_(i) { return round_(-num_(i.qty) * num_(i.price)); }
  function cancelled_(b) { return String(b.status) === '0'; }

  // ---------- Beds24 (JSON API, same keys as fetchBeds24Data) ----------
  function call_(fn, body) {
    body.authentication = auth_();
    var r = UrlFetchApp.fetch(API + fn, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(body) });
    var text = r.getContentText();
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Beds24 ' + fn + ': unreadable answer (' + r.getResponseCode() + ') ' + text.slice(0, 200)); }
    if (data && data.error) throw new Error('Beds24 ' + fn + ': ' + (data.error || '') + ' ' + (data.errorCode || ''));
    return data;
  }
  /** Bookings arriving from 60 days back to 30 days ahead that leave in the last 7 days or later. */
  function readBookings_(today) {
    var out = [], depFrom = compact_(ymd_(addDays_(today, -7))), end = addDays_(today, 30);
    for (var d = addDays_(today, -60); d <= end; d = addDays_(d, 7)) { // weekly slices: invoices come back only for < 100 bookings
      var to = addDays_(d, 6); if (to > end) to = end;
      var list = call_('getBookings', { arrivalFrom: compact_(ymd_(d)), arrivalTo: compact_(ymd_(to)), departureFrom: depFrom, includeInvoice: true });
      if (Array.isArray(list)) out = out.concat(list);
    }
    return out;
  }
  function readBooking_(bookId) {
    var list = call_('getBookings', { bookId: String(bookId), includeInvoice: true });
    return Array.isArray(list) && list[0] ? list[0] : null;
  }
  function addPayment_(bookId, amount, description, status) {
    var r = call_('setBooking', { bookId: String(bookId), invoice: [{ description: description, status: status || '', qty: '-1', price: String(amount), vatRate: '0', type: '200' }] });
    if (!r || !r.success) throw new Error('Beds24 refused the payment for booking ' + bookId + ': ' + JSON.stringify(r).slice(0, 200));
  }

  // ---------- sheet ----------
  function readEntries_() {
    var s = ss_().getSheetByName(ENTRIES);
    var last = s.getLastRow();
    var rows = last >= 2 ? s.getRange(2, 1, last - 1, COL_V).getValues() : [];
    var lines = [];
    rows.forEach(function (r, i) {
      var ts = String(r[E.ts]);
      if (!/^\d{17}$/.test(ts)) return;
      lines.push({ rowNo: i + 2, ts: ts, type: String(r[E.type]), sub: String(r[E.sub]), obj: String(r[E.obj]),
        guest: String(r[E.guest]), pay: String(r[E.pay]), amount: num_(r[E.real] !== '' ? r[E.real] : r[E.total]),
        bookId: String(r[COL_U - 1]).trim(), lineId: String(r[COL_V - 1]).trim() });
    });
    var dataLast = 1;
    for (var k = rows.length - 1; k >= 0; k--) if (String(rows[k][0]) !== '' || String(rows[k][E.ts]) !== '') { dataLast = k + 2; break; }
    return { sheet: s, lines: lines, last: dataLast };
  }
  function isRoom_(l) { return l.type === 'Income' && l.sub === 'Room'; }

  // ---------- one run ----------
  function run() {
    var lock = LockService.getScriptLock(); // same lock as the reception server: no row moves under us
    if (!lock.tryLock(30000)) return 'busy';
    try { return run_(); } finally { lock.releaseLock(); }
  }
  function run_() {
    var live = live_(), plan = [], issues = [];
    var today = Utilities.parseDate(ymd_(new Date()), TS_TZ, 'yyyy-MM-dd'), todayStr = ymd_(new Date());
    var all = readBookings_(today), books = {}, start = start_();
    var inHouse = all.filter(function (b) { return !cancelled_(b) && String(b.firstNight) <= todayStr && String(b.lastNight) >= todayStr; });
    all.forEach(function (b) {
      var id = String(b.bookId), first = String(b.firstNight);
      if (first < start) return;                       // before the start date: handled the old way
      if (first <= todayStr) { books[id] = b; return; } // checked in
      var ext = extensionOf_(b, inHouse);               // future booking: only an extension shows now
      if (ext && ext.sure) { b._linked = true; b._guest = guestName0_(ext.host); books[id] = b; }
      else if (ext) issues.push([id, guestName0_(b), 'Possible extension of ' + guestName0_(ext.host) + ' (' + ext.host.bookId + '): not shown yet', 'Starts ' + first + '. Same guest? Group the bookings in Beds24 or give the same email.', 'ext|' + id]);
    });
    var ctl = readControl_();
    var ent = readEntries_();
    var imported = [];
    var newRows = [];
    function act(kind, b, detail) { plan.push([new Date(), kind, b ? String(b.bookId || b) : '', detail]); }

    // 1. Reception → Beds24
    ent.lines.filter(function (l) { return isRoom_(l) && l.bookId && !l.lineId && l.pay !== PAY_UNPAID && l.pay !== PAY_CANCELLED && l.amount > 0; })
      .forEach(function (l) {
        var b = books[l.bookId] || readBooking_(l.bookId);
        if (!b) { issues.push([l.bookId, l.guest, 'Booking not found in Beds24', 'Row ' + l.rowNo + ', ' + l.amount]); return; }
        var tag = '[RT-' + l.ts + ']';
        var found = payments_(b).filter(function (i) { return String(i.description || '').indexOf(tag) === 0; })[0];
        if (!found) {
          act('Send payment to Beds24', b, l.guest + ' · ' + l.amount + ' · ' + l.pay + ' (row ' + l.rowNo + ')');
          if (!live) return;
          addPayment_(l.bookId, l.amount, tag + ' ' + l.pay, l.pay);
          b = readBooking_(l.bookId); books[l.bookId] = b;
          found = payments_(b).filter(function (i) { return String(i.description || '').indexOf(tag) === 0; })[0];
          if (!found) { issues.push([l.bookId, l.guest, 'Payment sent but not found back', tag]); return; }
        }
        if (live) ent.sheet.getRange(l.rowNo, COL_V).setNumberFormat('@').setValue(String(found.invoiceId));
        l.lineId = String(found.invoiceId);
      });

    var knownIds = {};
    ent.lines.forEach(function (l) { if (l.lineId) knownIds[l.lineId] = l; });
    var byTs = {};
    ent.lines.forEach(function (l) { byTs[l.ts] = l; });

    Object.keys(books).forEach(function (id) {
      var b = books[id], guest = guestName_(b), room = roomName_(b);
      var mine = ent.lines.filter(function (l) { return isRoom_(l) && l.bookId === id; });

      // 4. cancelled booking
      if (cancelled_(b)) {
        mine.forEach(function (l) {
          if (l.pay === PAY_UNPAID) {
            act('Mark Cancelled', b, guest + ' · ' + l.amount + ' (row ' + l.rowNo + ')');
            if (live) {
              ent.sheet.getRange(l.rowNo, E.real + 1).setValue(0);
              ent.sheet.getRange(l.rowNo, E.pay + 1).setValue(PAY_CANCELLED);
              ent.sheet.getRange(l.rowNo, E.comment + 1).setValue('Booking cancelled in Beds24 (was ' + l.amount + ')');
            }
          } else if (l.pay !== PAY_CANCELLED) {
            issues.push([id, guest, 'Cancelled booking with a paid line: refund?', l.pay + ' ' + l.amount + ' (row ' + l.rowNo + ')']);
          }
        });
        return;
      }

      // 2. Beds24 → Entries, and checks on lines sent from the reception
      payments_(b).forEach(function (i) {
        var lineId = String(i.invoiceId), amount = payAmount_(i), m = String(i.description || '').match(TAG);
        if (/^\[RT-/.test(String(i.description || ''))) { // written by the reception (or a test): never imported
          var src = m ? byTs[m[1]] : null;
          if (src && Math.abs(src.amount - amount) > 0.5) issues.push([id, guest, 'Amount changed in Beds24', 'Reception ' + src.amount + ' / Beds24 ' + amount + ' (line ' + lineId + ')']);
          return;
        }
        if (knownIds[lineId]) return;
        var k = 'mode|' + lineId, how = method_(i) || validMode_(ctl.chosen[k]);
        if (!how) {
          issues.push([id, guest, 'Payment mode missing: not imported. Pick the mode in column G', amount + ' on ' + String(i.createTime || '').slice(0, 10) + (i.status ? ' (status ' + i.status + ')' : ''), k, true]);
          return;
        }
        if (ctl.rows[k]) imported.push(ctl.rows[k]);
        act('Import payment from Beds24', b, guest + ' · ' + room + ' · ' + amount + ' · ' + how);
        newRows.push({ bookId: id, lineId: lineId, guest: guest, room: room, amount: amount, pay: how,
          date: i.createTime ? Utilities.parseDate(String(i.createTime), 'UTC', 'yyyy-MM-dd HH:mm:ss') : new Date(),
          comment: 'From Beds24' + (i.description ? ': ' + String(i.description).slice(0, 80) : '') });
        knownIds[lineId] = true;
      });

      fakeUnpaids_(b).forEach(function (i) {
        issues.push([id, guest, 'Payment line marked Unpaid in Beds24: ignored, still due. Remove the Unpaid option from Beds24.', String(payAmount_(i)) + ' (line ' + i.invoiceId + ')', 'fake|' + i.invoiceId]);
      });

      // 3. what is still owed, from the check-in day (or now for an extension)
      if (String(b.firstNight) > todayStr && !b._linked) return;
      var beds24Paid = payments_(b).reduce(function (s, i) { return s + payAmount_(i); }, 0);
      var notInBeds24 = mine.filter(function (l) { return l.pay !== PAY_CANCELLED && (l.pay === PAY_UNPAID || !l.lineId); })
        .reduce(function (s, l) { return s + l.amount; }, 0);
      var due = round_(charges_(b) - beds24Paid - notInBeds24);
      var channel = prepaid_(b);
      if (due > 0.5 && channel) {
        act('Record prepaid (' + channel + ')', b, guest + ' · ' + room + ' · ' + due + ' · ' + transferMode_());
        newRows.push({ bookId: id, lineId: '', guest: guest, room: room, amount: due, pay: transferMode_(), date: new Date(), comment: 'Paid to ' + channel });
      } else if (due > 0.5) {
        act('Create Unpaid line', b, guest + ' · ' + room + ' · ' + due + (b._linked ? ' (extension)' : ''));
        newRows.push({ bookId: id, lineId: '', guest: guest, room: room, amount: due, pay: PAY_UNPAID, date: new Date(), comment: 'From Beds24: still to pay' + (b._linked ? ' (extension, booking ' + id + ')' : '') });
      } else if (due < -0.5) {
        issues.push([id, guest, 'More paid than charged', String(-due)]);
      }
    });

    if (live) writeRows_(ent, newRows);
    report_(live, plan, issues, ctl, live ? imported : []);
    return { live: live, actions: plan.length, issues: issues.length };
  }

  /** New Room rows in Entries and Entries Manual, shaped like the reception's own rows. */
  function writeRows_(ent, rows) {
    if (!rows.length) return;
    var man = ss_().getSheetByName(MANUAL);
    rows.forEach(function (x) {
      var ts = newTs_();
      var dateOnly = Utilities.parseDate(ymd_(x.date), TS_TZ, 'yyyy-MM-dd');
      var row = [dateOnly, 'Income', 'Room', x.room, '', '', '', x.amount, AUTHOR, '', '', '', x.guest, x.pay, ts, '', x.comment];
      var r = ent.last + 1;
      ent.sheet.getRange(r, E.ts + 1).setNumberFormat('@');
      ent.sheet.getRange(r, 1, 1, 17).setValues([row.map(safe_)]);
      ent.sheet.getRange(r, 1).setNumberFormat('dd/MM/yyyy');
      ent.sheet.getRange(r, COL_U, 1, 2).setNumberFormat('@').setValues([[x.bookId, x.lineId]]);
      ent.last = r;
      if (man) { // A..E, H, L, M, N like Entries; O author, P comment, Q timestamp; F, G, J, K are formulas
        var mr = lastDataRow_(man) + 1;
        man.getRange(mr, M.ts + 1).setNumberFormat('@');
        man.getRange(mr, 1, 1, 5).setValues([[dateOnly, 'Income', 'Room', safe_(x.room), '']]);
        man.getRange(mr, 8).setValue(x.amount);
        man.getRange(mr, 12, 1, 6).setValues([['', safe_(x.guest), x.pay, AUTHOR, safe_(x.comment), ts]]);
        man.getRange(mr, 1).setNumberFormat('dd/MM/yyyy');
      }
    });
  }
  function lastDataRow_(s) {
    var last = s.getLastRow();
    if (last < 2) return 1;
    var a = s.getRange(2, 1, last - 1, 3).getValues();
    for (var i = a.length - 1; i >= 0; i--) if (String(a[i][0]) + String(a[i][1]) + String(a[i][2]) !== '') return i + 2;
    return 1;
  }

  var CONTROL_HEADER = ['Found at', 'Booking', 'Guest', 'Problem', 'Detail', 'Key', 'Mode to use', 'Done'];
  function control_() {
    var ss = ss_(), c = ss.getSheetByName(CONTROL);
    if (!c) { c = ss.insertSheet(CONTROL); c.getRange(1, 1, 1, CONTROL_HEADER.length).setValues([CONTROL_HEADER]); c.setFrozenRows(1); }
    else if (String(c.getRange(1, 7).getValue()) === '') c.getRange(1, 1, 1, CONTROL_HEADER.length).setValues([CONTROL_HEADER]);
    return c;
  }
  /** Problems already listed (by key), and the mode a manager picked for a payment. */
  function readControl_() {
    var c = control_(), rows = {}, chosen = {};
    if (c.getLastRow() >= 2) c.getRange(2, 6, c.getLastRow() - 1, 3).getValues().forEach(function (r, i) {
      var k = String(r[0]); if (!k) return;
      rows[k] = i + 2;
      if (String(r[1]).trim() && !String(r[2]).trim()) chosen[k] = String(r[1]).trim();
    });
    return { sheet: c, rows: rows, chosen: chosen };
  }
  /** B24_DryRun lists what the last run did (or would do); B24_Control keeps each problem once. */
  function report_(live, plan, issues, ctl, doneRows) {
    var ss = ss_();
    var dry = ss.getSheetByName(DRY) || ss.insertSheet(DRY);
    dry.clear();
    dry.getRange(1, 1, 1, 4).setValues([[live ? 'LIVE — last run' : 'TEST MODE — nothing written. Last run:', 'Action', 'Booking', 'Detail']]);
    if (plan.length) dry.getRange(2, 1, plan.length, 4).setValues(plan);
    else dry.getRange(2, 1, 1, 4).setValues([[new Date(), 'Nothing to do', '', '']]);
    var c = ctl.sheet, seen = {};
    var add = issues.map(function (x) { return { row: [new Date(), x[0], x[1], x[2], x[3], x[4] || (x[0] + '|' + x[2] + '|' + x[3]), '', ''], mode: !!x[5] }; })
      .filter(function (r) { var k = r.row[5]; if (ctl.rows[k] || seen[k]) return false; seen[k] = true; return true; });
    if (add.length) {
      var at = c.getLastRow() + 1;
      c.getRange(at, 1, add.length, CONTROL_HEADER.length).setValues(add.map(function (r) { return r.row; }));
      var rule = SpreadsheetApp.newDataValidation().requireValueInList(modes_(), true).setAllowInvalid(false).build();
      add.forEach(function (r, i) { if (r.mode) c.getRange(at + i, 7).setDataValidation(rule).setBackground('#FFF4CC'); });
    }
    (doneRows || []).forEach(function (n) { c.getRange(n, 8).setValue('Imported ' + ymd_(new Date())); c.getRange(n, 7).setBackground(null); });
  }

  // ---------- setup ----------
  function setup() {
    var p = props_();
    if (!p.getProperty('B24_API_KEY') || !p.getProperty('B24_PROP_KEY')) {
      var ui = null;
      try { ui = SpreadsheetApp.getUi(); } catch (e) { /* run from the editor: no dialog */ }
      if (!ui) throw new Error('Add B24_API_KEY and B24_PROP_KEY in Project Settings > Script Properties (same values as in fetchBeds24Data), then run B24_setup again.');
      var a = ui.prompt('Beds24 sync', 'API key (the apiKey of fetchBeds24Data):', ui.ButtonSet.OK_CANCEL);
      if (a.getSelectedButton() !== ui.Button.OK || !a.getResponseText().trim()) return 'cancelled';
      var b = ui.prompt('Beds24 sync', 'Property key (the propKey of fetchBeds24Data):', ui.ButtonSet.OK_CANCEL);
      if (b.getSelectedButton() !== ui.Button.OK || !b.getResponseText().trim()) return 'cancelled';
      p.setProperties({ B24_API_KEY: a.getResponseText().trim(), B24_PROP_KEY: b.getResponseText().trim() });
    }
    if (!p.getProperty('B24_START')) p.setProperty('B24_START', ymd_(new Date()));
    if (!p.getProperty('B24_LIVE')) p.setProperty('B24_LIVE', 'no');
    var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'B24_run'; });
    if (!has) ScriptApp.newTrigger('B24_run').timeBased().everyMinutes(5).create();
    var r = run();
    Logger.log('Beds24 sync installed, mode ' + (live_() ? 'LIVE' : 'TEST') + ', start date ' + p.getProperty('B24_START') + '. See the B24_DryRun tab.');
    return r;
  }

  return { run: run, setup: setup };
})();

function B24_run() { return B24.run(); }
function B24_setup() { return B24.setup(); }
function B24_goLive() { PropertiesService.getScriptProperties().setProperty('B24_LIVE', 'yes'); return B24.run(); }
function B24_pause() { PropertiesService.getScriptProperties().setProperty('B24_LIVE', 'no'); return 'test mode'; }
