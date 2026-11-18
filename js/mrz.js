// Passport / ID card number from the machine-readable lines (MRZ) at the bottom of the photo page.
// The text comes from an OCR pass on the phone; every field the MRZ protects has a check digit,
// so a misread is detected instead of being filled in silently.
//   Passport (TD3): 2 lines of 44 — line 2 starts with the number (9) + its check digit.
//   ID card (TD1):  3 lines of 30 — line 1 has the number at 5..13 + its check digit at 14.

const WEIGHTS = [7, 3, 1];
const value = c => (c === '<' ? 0 : c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55);
export function checkDigit(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) t += value(s[i]) * WEIGHTS[i % 3];
  return t % 10;
}
// What OCR typically confuses in this font.
const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', B: '8', G: '6', A: '4' };
const digits = s => s.split('').map(c => TO_DIGIT[c] || c).join('');
const isDigits = s => /^\d+$/.test(s);

export function cleanLine(l) {
  return String(l).toUpperCase()
    .replace(/[«‹(\[{]/g, '<').replace(/\s+/g, '')
    .replace(/[^A-Z0-9<]/g, '');
}

/**
 * The number whose check digit matches: the reading as OCR gave it, or else the same reading with
 * the letters that look like digits turned into digits after the leading letters ("YB12O4567" →
 * "YB1204567"). Only these two readings are tried, so a wrong number is very unlikely to pass;
 * the guest checks it anyway.
 */
function checkedNumber(field, cd) {
  const d = digits(cd);
  if (!isDigits(d)) return null;
  const lead = (field.match(/^[A-Z]{1,3}/) || [''])[0];
  for (const v of [field, lead + digits(field.slice(lead.length))]) if (checkDigit(v) === Number(d)) return v;
  return null;
}
const dateOk = (s, cd) => { const a = digits(s), b = digits(cd); return isDigits(a) && isDigits(b) && checkDigit(a) === Number(b); };

/** TD3 line 2 at offset i of a cleaned line: number + check, and one of the dates must check too. */
function td3(line) {
  for (let i = 0; i + 28 <= line.length; i++) {
    const l = line.slice(i);
    if (!'MF<'.includes(l[20])) continue;
    if (!dateOk(l.slice(13, 19), l[19]) && !dateOk(l.slice(21, 27), l[27])) continue;
    const n = checkedNumber(l.slice(0, 9), l[9]);
    if (n) return { number: n.replace(/<+$/, ''), kind: 'passport', nationality: l.slice(10, 13).replace(/</g, '') };
  }
  return null;
}
/** TD1 line 1: "I" or "A" or "C", issuer, number + check. */
function td1(line) {
  const m = line.match(/[IAC][A-Z0-9<][A-Z<]{3}([A-Z0-9<]{9})([0-9A-Z<])/);
  if (!m) return null;
  const n = checkedNumber(m[1], m[2]);
  return n ? { number: n.replace(/<+$/, ''), kind: 'id', nationality: '' } : null;
}

/** The document number found in OCR text, or null. */
export function parseMrz(text) {
  const lines = String(text || '').split(/\r?\n/).map(cleanLine).filter(l => l.length >= 28 && l.includes('<'));
  for (const l of lines) { const r = td3(l); if (r && r.number) return r; }
  for (const l of lines) { const r = td1(l); if (r && r.number) return r; }
  return null;
}
