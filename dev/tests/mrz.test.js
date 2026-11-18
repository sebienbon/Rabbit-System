// Passport number read from the MRZ lines (js/mrz.js), with typical OCR mistakes.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const mrz = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'js', 'mrz.js')).href);

// ICAO 9303 specimens
const L1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const L2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

test('check digits (ICAO 9303)', async () => {
  const { checkDigit } = await mrz();
  assert.strictEqual(checkDigit('L898902C3'), 6);
  assert.strictEqual(checkDigit('740812'), 2);
  assert.strictEqual(checkDigit('120415'), 9);
});

test('passport: clean text, OCR noise, letters read as digits and back', async () => {
  const { parseMrz } = await mrz();
  assert.deepStrictEqual(parseMrz(L1 + '\n' + L2), { number: 'L898902C3', kind: 'passport', nationality: 'UTO' });
  // spaces, lower case, « for <, other lines around
  assert.strictEqual(parseMrz('PASSPORT\nsome text\n' + L1.replace(/</g, '« ') + '\n l898902c36 UTO 7408122F1204159ZE184226B<<<<<10 \n').number, 'L898902C3');
  // 0 read as O in the number and in the dates
  assert.strictEqual(parseMrz('L8989O2C36UTO74O8122F12O4159ZE184226B<<<<<10').number, 'L898902C3');
  // a stray character before the line
  assert.strictEqual(parseMrz('.L898902C36UTO7408122F1204159ZE184226B<<<<<10').number, 'L898902C3');
});

test('a misread number is not returned (its check digit fails)', async () => {
  const { parseMrz } = await mrz();
  assert.strictEqual(parseMrz('L898902C76UTO7408122F1204159ZE184226B<<<<<10'), null);
  assert.strictEqual(parseMrz('just some words\nno mrz here'), null);
  assert.strictEqual(parseMrz(''), null);
});

test('ID card (TD1)', async () => {
  const { parseMrz } = await mrz();
  const td1 = 'I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<';
  assert.deepStrictEqual(parseMrz(td1), { number: 'D23145890', kind: 'id', nationality: '' });
});
