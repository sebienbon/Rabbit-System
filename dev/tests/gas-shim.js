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
  setValue(v) { this.sheet.set(this.r, this.c, v); return this; }
  getValue() { return this.getValues()[0][0]; }
  setNumberFormat(f) { this.sheet.formats.push([this.r, this.c, f]); return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name, rows) { this.name = name; this.data = (rows || []).map(r => r.slice()); this.formats = []; this.failNext = null; }
  /** Simulates a Google error ("Service timed out") on the next write of this kind. */
  maybeFail(kind) { if (this.failNext === kind) { this.failNext = null; throw new Error('Service Spreadsheets timed out (simulated)'); } }
  set(r, c, v) { while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some(v => v !== '' && v !== undefined && v !== null)) return i + 1;
    return 0;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = a.match(/^([A-Z]+):([A-Z]+)$/);
      if (m) return new Range(this, 1, colToNum(m[1]), 1000, colToNum(m[2]) - colToNum(m[1]) + 1);
      throw new Error('A1 notation not supported in shim: ' + a);
    }
    return new Range(this, a, b, c || 1, d || 1);
  }
  appendRow(row) { this.maybeFail('appendRow'); const r = this.getLastRow() + 1; row.forEach((v, j) => this.set(r, j + 1, v)); return this; }
  setFrozenRows() { return this; }
}

function makeEnv({ sheets = {}, tz = 'Asia/Singapore' } = {}) {
  const book = {};
  for (const [n, rows] of Object.entries(sheets)) book[n] = new Sheet(n, rows);
  const props = {};
  const ss = {
    getSpreadsheetTimeZone: () => tz,
    getSheetByName: n => book[n] || null,
    insertSheet: n => (book[n] = new Sheet(n, [])),
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
      // Only 'yyyy-MM-dd' is needed: midnight of that day in timezone _tz.
      parseDate: (s, _tz, pattern) => {
        if (pattern !== 'yyyy-MM-dd') throw new Error('shim parseDate pattern ' + pattern);
        const [y, m, d] = s.split('-').map(Number);
        const guess = new Date(Date.UTC(y, m - 1, d));
        const shown = fmt(guess, _tz, 'yyyy-MM-dd HH:mm').split(/[- :]/).map(Number);
        const offsetMin = (Date.UTC(shown[0], shown[1] - 1, shown[2], shown[3], shown[4]) - guess.getTime()) / 60000;
        return new Date(guess.getTime() - offsetMin * 60000);
      },
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; },
      deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../server/30.UI_api.gs', 'utf8'), ctx);
  const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { ctx, book, props, call };
}

module.exports = { makeEnv };
