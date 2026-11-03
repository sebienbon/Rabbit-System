// Minimal in-memory imitation of the Apps Script services used by 30.UI_api.gs.
const crypto = require('crypto');
const vm = require('vm');
const fs = require('fs');

function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const v = (this.sheet.data[this.r - 1 + i] || [])[this.c - 1 + j];
        row.push(v === undefined ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    this.sheet.maybeFail('setValues');
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error(`setValues size mismatch ${vals.length}x${vals[0].length} vs ${this.nr}x${this.nc}`);
    vals.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v)));
    return this;
  }
  /** Dates shown as dd/MM/yyyy in the sheet timezone, like the Cashouts&Cor date column. */
  getDisplayValues() { return this.getValues().map(r => r.map(v => (v instanceof Date ? this.sheet.fmt(v, this.sheet.tz, 'dd/MM/yyyy') : String(v)))); }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  getFormulas() { return this.getValues().map(r => r.map(v => (typeof v === 'string' && v.startsWith('=') ? v : ''))); }
  setValue(v) { this.sheet.maybeFail('setValue'); this.sheet.set(this.r, this.c, v); return this; }
  getValue() { return this.getValues()[0][0]; }
  setNumberFormat(f) { this.sheet.formats.push([this.r, this.c, f]); return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name, rows) { this.name = name; this.data = (rows || []).map(r => r.slice()); this.formats = []; this.failNext = null; }
  /** Simulates a Google error ("Service timed out") on the next write of this kind. */
  maybeFail(kind) { if (this.failNext === kind) { this.failNext = null; throw new Error('Service Spreadsheets timed out (simulated)'); } }
  // Sheets keeps text typed after an apostrophe, without it; textCells remembers it was text, not a formula.
  set(r, c, v) {
    while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push('');
    const isText = typeof v === 'string' && v.startsWith("'");
    row[c - 1] = isText ? v.slice(1) : v;
    (this.textCells = this.textCells || new Set())[isText ? 'add' : 'delete'](r + ',' + c);
  }
  /** What the cell holds: 'text' (typed after an apostrophe), 'formula' (a string starting with =, + or @ written as is), or 'value'. */
  kind(r, c) {
    const v = (this.data[r - 1] || [])[c - 1];
    if (this.textCells && this.textCells.has(r + ',' + c)) return 'text';
    return typeof v === 'string' && /^[=+@]/.test(v) ? 'formula' : 'value';
  }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
    return 0;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = a.match(/^([A-Z]+):([A-Z]+)$/);
      if (m) return new Range(this, 1, colToNum(m[1]), 1000, colToNum(m[2]) - colToNum(m[1]) + 1);
      const m2 = a.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (m2) return new Range(this, +m2[2], colToNum(m2[1]), +m2[4] - +m2[2] + 1, colToNum(m2[3]) - colToNum(m2[1]) + 1);
      throw new Error('A1 notation not supported in shim: ' + a);
    }
    return new Range(this, a, b, c || 1, d || 1);
  }
  deleteRow(r) { this.maybeFail('deleteRow'); this.data.splice(r - 1, 1); }
  appendRow(row) { this.maybeFail('appendRow'); const r = this.getLastRow() + 1; row.forEach((v, j) => this.set(r, j + 1, v)); return this; }
  setFrozenRows() { return this; }
  clearContents() { this.data = []; if (this.textCells) this.textCells.clear(); return this; }
}

function makeEnv({ sheets = {}, tz = 'Asia/Singapore' } = {}) {
  const book = {};
  for (const [n, rows] of Object.entries(sheets)) book[n] = new Sheet(n, rows);
  const attach = sh => { sh.fmt = fmt; sh.tz = tz; return sh; };
  Object.values(book).forEach(attach);
  const props = {};
  const mails = [];
  const mailFail = { next: false };
  const triggers = [];
  const ss = {
    getSpreadsheetTimeZone: () => tz,
    getSheetByName: n => book[n] || null,
    insertSheet: n => (book[n] = attach(new Sheet(n, []))),
  };
  function fmt(d, _tz, pattern) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: _tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map(x => [x.type, x.value]));
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
      .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second).replace('SSS', ms);
  }
  const ctx = {
    console, Date, JSON, Math, Object, Array, String, Number, isNaN, isFinite, Error,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(), sleep() {}, formatDate: fmt,
      newBlob: (data, type, name) => ({ data, type, name, getAs(t) { return { data, type: t, name, setName(n) { this.name = n; return this; } }; } }),
      // Only 'yyyy-MM-dd' is needed: midnight of that day in timezone _tz.
      parseDate: (s, _tz, pattern) => {
        let y, m, d, H = 0, M = 0, S = 0;
        if (pattern === 'yyyy-MM-dd') [y, m, d] = s.split('-').map(Number);
        else if (pattern === 'dd/MM/yyyy HH:mm:ss') {
          const x = s.match(/^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)$/);
          if (!x) throw new Error('Unparseable date: ' + s);
          [d, m, y, H, M, S] = x.slice(1).map(Number);
        } else if (pattern === 'yyyy-MM-dd HH:mm:ss') {
          const x = s.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/);
          if (!x) throw new Error('Unparseable date: ' + s);
          [y, m, d, H, M, S] = x.slice(1).map(Number);
        } else throw new Error('shim parseDate pattern ' + pattern);
        const guess = new Date(Date.UTC(y, m - 1, d, H, M, S));
        const shown = fmt(guess, _tz, 'yyyy-MM-dd HH:mm:ss').split(/[- :]/).map(Number);
        const offsetMin = (Date.UTC(shown[0], shown[1] - 1, shown[2], shown[3], shown[4], shown[5]) - guess.getTime()) / 60000;
        return new Date(guess.getTime() - offsetMin * 60000);
      },
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
      deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Logger: { log() {} },
    ScriptApp: {
      getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.fn })),
      newTrigger: fn => { const t = { fn }; const b = { timeBased: () => b, atHour: h => (t.hour = h, b), nearMinute: m => (t.minute = m, b),
        everyDays: d => (t.every = d, b), inTimezone: z => (t.tz = z, b), create: () => { triggers.push(t); return t; } }; return b; },
    },
    MailApp: { sendEmail(m) { if (mailFail.next) { mailFail.next = false; throw new Error('Mail service failed (simulated)'); } mails.push(m); } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../server/30.UI_api.gs', 'utf8'), ctx);
  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, book, props, call, mails, mailFail, triggers };
}

module.exports = { makeEnv };
