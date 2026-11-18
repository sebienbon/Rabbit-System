// End-to-end (owner 18/11): check-in on the guest's phone, live on the desk.
// Desk opens a session from the Beds24 arrivals; two phones scan the desk QR (checkin.html), one is the
// booking name, the other a companion; passport photos (number read on the phone), desk validates.
// Run: node dev/tests/e2e-checkin.js
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');

const shots = __dirname + '/shots';
fs.mkdirSync(shots, { recursive: true });
const step = m => console.log('  ✓ ' + m);
const PHOTO = __dirname + '/fixtures/passport-specimen.jpg';
const ymd = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

(async () => {
  const srv = await start();
  srv.env.ctx.CI_setup();
  srv.env.ctx.B24 = { arrivals: () => [
    { bookId: '96026082', name: 'Giulia Varcasia', room: 'Twin Room', arrival: ymd(Date.now()), departure: ymd(Date.now() + 2 * 86400000), guests: 2, channel: 'Booking.com' },
    { bookId: '96071677', name: 'Annika Kirsch', room: 'Tree House', arrival: ymd(Date.now() + 86400000), departure: ymd(Date.now() + 3 * 86400000), guests: 1, channel: 'Hostelworld.com' },
  ] };
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] } : {});
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = (locale) => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }).then(c => c.newPage());
  const errors = [];
  desk.on('pageerror', e => errors.push('desk: ' + e.message));
  try {
    // a phone scanning with no check-in open
    const p0 = await phone('en-GB');
    p0.on('pageerror', e => errors.push('p0: ' + e.message));
    await p0.goto(base + 'checkin.html');
    await p0.waitForSelector('text=Please ask the reception');
    step('no check-in open: the phone is told to ask the reception');

    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#openForm');
    await desk.click('#logout');
    await desk.click('[data-user="ayu"]'); await desk.fill('#p', 'ayu123'); await desk.click('button.primary');
    await desk.fill('#cash', '1387750'); await desk.click('#openForm button.primary');
    await desk.waitForSelector('.sell');
    await desk.click('[data-tab="checkin"]');
    await desk.waitForSelector('[data-book="96026082"]');
    await desk.screenshot({ path: shots + '/checkin-desk-1.png' });
    step('Check-in tab lists the Beds24 arrivals');
    await desk.click('[data-book="96026082"]');
    await desk.waitForSelector('text=Waiting for the first phone');
    step('session opened for Giulia Varcasia');

    // phone 1, French: the booking name is already chosen
    const p1 = await phone('fr-FR');
    p1.on('pageerror', e => errors.push('p1: ' + e.message));
    p1.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') console.log('    p1 console:', m.text()); });
    await p1.goto(base + 'checkin.html');
    await p1.waitForSelector('#form');
    assert.ok(await p1.isChecked('input[value=booking]'));
    assert.match(await p1.textContent('h1'), /Check-in/);
    assert.match(await p1.textContent('body'), /Je suis Giulia Varcasia/);
    step('phone 1 (French) joins, "Je suis Giulia Varcasia" already chosen');
    await p1.setInputFiles('#file', PHOTO);
    const t0 = Date.now();
    await p1.waitForFunction(() => /Numéro lu|Impossible de lire/.test(document.querySelector('#ocr')?.textContent || ''), null, { timeout: 120000 });
    const num = await p1.inputValue('#passport');
    const ocrText = await p1.textContent('#ocr');
    console.log(`    OCR in ${Math.round((Date.now() - t0) / 1000)} s: ${ocrText.trim()} → "${num}"`);
    await p1.screenshot({ path: shots + '/checkin-phone-1.png', fullPage: true });
    // The check digit cannot tell L from 1 (same value modulo 10): the guest checks and corrects.
    assert.ok(!num || /^[L1]898902C3$/.test(num), num);
    if (num !== 'L898902C3') await p1.fill('#passport', 'L898902C3');
    step('passport photo sent; number ' + (num === 'L898902C3' ? 'read from the photo' : num ? `read as ${num}, corrected by the guest` : 'typed (OCR failed)'));
    await p1.waitForTimeout(1200);
    await p1.click('#done');
    await p1.waitForSelector('text=La réception vérifie vos informations');
    step('phone 1 finished: "Merci !"');

    // phone 2, Chinese: a companion
    const p2 = await phone('zh-CN');
    p2.on('pageerror', e => errors.push('p2: ' + e.message));
    await p2.goto(base + 'checkin.html');
    await p2.waitForSelector('#form');
    assert.ok(!(await p2.isChecked('input[value=booking]')) && !(await p2.isChecked('input[value=other]')));
    await p2.check('input[value=other]');
    await p2.fill('#name', 'Jessica Rossi');
    await p2.click('#done');
    await p2.waitForSelector('text=还缺少');
    step('phone 2 (Chinese) is told what is missing');
    await p2.setInputFiles('#file', PHOTO);
    await p2.waitForFunction(() => /已从照片读取号码|无法读取号码/.test(document.querySelector('#ocr')?.textContent || ''), null, { timeout: 120000 });
    await p2.fill('#passport', 'yb1234567');
    await p2.waitForTimeout(1200);
    await p2.click('#done');
    await p2.waitForSelector('text=前台正在核对您的信息');
    await p2.screenshot({ path: shots + '/checkin-phone-2.png', fullPage: true });
    step('phone 2: another name, photo, number typed');

    // the desk sees both, with photos
    await desk.waitForFunction(() => document.querySelectorAll('.cipeople img').length === 2 && /YB1234567/.test(document.querySelector('.cipeople').textContent), null, { timeout: 15000 });
    assert.match(await desk.textContent('.cipeople'), /L898902C3/);
    assert.match(await desk.textContent('.cipeople'), /YB1234567/);
    await desk.screenshot({ path: shots + '/checkin-desk-2.png', fullPage: true });
    step('desk sees both people live, numbers and photos');
    await desk.click('#ciValidate');
    await desk.waitForSelector('text=Checked in: Giulia Varcasia, Jessica Rossi');
    await desk.waitForSelector('.cidone');
    step('desk validates: both checked in');

    await p1.waitForSelector('text=Check-in terminé', { timeout: 10000 });
    await p2.waitForSelector('text=入住登记完成', { timeout: 10000 });
    await p1.screenshot({ path: shots + '/checkin-phone-3.png' });
    step('both phones show they are checked in');
    const rows = srv.env.book['CI_Guests'].data.slice(1).filter(r => r[12] === 'checked in');
    assert.deepStrictEqual(rows.map(r => [r[4], r[9]]), [['Giulia Varcasia', 'L898902C3'], ['Jessica Rossi', 'YB1234567']]);
    assert.ok(srv.env.book['New guest'].data.some(r => r[5] === 'Jessica Rossi'));
    const photo = Object.values(srv.env.drive.files)[0];
    assert.ok(photo.bytes.length > 30000 && photo.bytes.length < 250000, 'photo size ' + photo.bytes.length);
    step(`CI_Guests filled; the companion has her own bill; photo ${Math.round(photo.bytes.length / 1024)} KB`);
    // the menu (later) recognises the phone
    const key = await p1.evaluate(() => localStorage.getItem('rt_device_key'));
    assert.strictEqual(srv.env.call({ action: 'ci_whoami', key }).guest, 'Giulia Varcasia');
    step('the phone key identifies Giulia (for the menu)');
    // the QR page
    const q = await desk.context().newPage();
    await q.goto(base + 'checkin-qr.html');
    await q.screenshot({ path: shots + '/checkin-qr.png' });
    assert.deepStrictEqual(errors, []);
    console.log('OK');
  } catch (e) { await desk.screenshot({ path: shots + '/checkin-fail.png', fullPage: true }); console.error(e); console.error(errors); process.exitCode = 1; }
  finally { await browser.close(); srv.server.close(); }
})();
