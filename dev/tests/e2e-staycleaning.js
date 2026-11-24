// End-to-end (owner 24/11): cleaning of a guest who stays. The desk sees the room due (said by the Staff App), opens
// WhatsApp with the message and the guest's personal link, says the message left; the guest taps Yes on his page;
// the desk and the Staff App feed show the answer. Also the WhatsApp field on the check-in phone page.
// Run: node dev/tests/e2e-staycleaning.js
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');

const shots = __dirname + '/shots';
fs.mkdirSync(shots, { recursive: true });
const step = m => console.log('  ✓ ' + m);
const ymd = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const T = ymd(Date.now()), AGO = ymd(Date.now() - 3 * 86400000), TM = ymd(Date.now() + 86400000);

(async () => {
  const srv = await start();
  srv.env.ctx.CI_setup();
  srv.env.ctx.B24 = { arrivals: () => [], units: () => [], house: () => [
    { bookId: '95817014', name: 'Sophie James', room: 'Double inside building', roomId: '353330', unitId: '1', kind: 'stay', arrival: AGO, departure: TM, guests: 2, phone: '+44 7700 900123' },
    { bookId: '95811650', name: 'Calum Hull', room: 'Tree House', roomId: '460595', unitId: '2', kind: 'stay', arrival: AGO, departure: TM, guests: 1, phone: '' },
  ] };
  srv.env.ctx.HK_setup();
  srv.env.book['Units'].appendRow(['353330', '1', 'Double inside building', 'Passion', '', '']);
  const key = srv.env.props.HK_FEED_KEY;
  srv.env.call({ action: 'hk_moves', key, date: T, due: ['95817014'] });
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] } : {});
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    // WhatsApp must not really open: keep the address the desk wanted
    await ctx.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    const desk = await ctx.newPage();
    desk.on('pageerror', e => errors.push('desk: ' + e.message));
    desk.on('dialog', d => d.accept());
    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#openForm');
    await desk.click('#logout');
    await desk.click('[data-user="ayu"]'); await desk.fill('#p', 'ayu123'); await desk.click('button.primary');
    await desk.fill('#cash', '1387750'); await desk.click('#openForm button.primary');
    await desk.waitForSelector('.sell');
    await desk.click('[data-tab="checkin"]');
    await desk.waitForSelector('text=Staying · room cleaning');
    await desk.waitForSelector('text=Cleaning day');
    assert.strictEqual(await desk.locator('[data-wa="95817014"]').count(), 1);
    assert.ok(await desk.locator('summary:has-text("Other guests staying · 1")').count(), 'the guest not due is folded away');
    step('the desk shows the room due today (Sophie, Passion) with a WhatsApp button; the other stay is folded');

    await desk.click('[data-wa="95817014"]');
    await desk.waitForSelector('text=Did the message leave?');
    const wa = (await desk.evaluate(() => window.__opened))[0];
    const u = new URL(wa);
    assert.strictEqual(u.origin + u.pathname, 'https://wa.me/447700900123');
    const text = u.searchParams.get('text');
    assert.match(text, /Hello Sophie!.*Passion.*clean\.html#b=95817014&d=\d{4}-\d\d-\d\d&t=[a-f0-9]{24}/);
    const link = text.match(/http\S+/)[0];
    step('WhatsApp opens on her number with the message and her personal link');
    await desk.screenshot({ path: shots + '/stay-desk-1.png' });

    await desk.click('[data-wafail]');
    await desk.waitForSelector('text=web.whatsapp.com');
    step('"No" explains to connect WhatsApp Web and try again; nothing is recorded');
    assert.strictEqual(srv.env.book['CI_Moves'].data.length, 1);
    await desk.click('[data-wa="95817014"]');
    await desk.click('[data-wasent]');
    await desk.waitForSelector('text=no answer yet');
    step('"Yes, sent" marks her as asked');

    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    phone.on('pageerror', e => errors.push('phone: ' + e.message));
    await phone.goto(link);
    await phone.waitForSelector('text=Hello Sophie!');
    await phone.waitForSelector('text=Passion');
    await phone.screenshot({ path: shots + '/stay-phone-1.png' });
    await phone.click('[data-a="yes"]');
    await phone.waitForSelector('text=We will clean your room today');
    await phone.screenshot({ path: shots + '/stay-phone-2.png' });
    step('the guest opens the link, sees her room and taps Yes');
    const f = srv.env.call({ action: 'hk_moves', key, date: T });
    assert.strictEqual(f.stays.find(s => s.bookId === '95817014').cleaning, 'yes');
    step('the Staff App feed says yes');

    await desk.click('#ciReload');
    await desk.waitForSelector('text=Yes, clean · the guest answered');
    await desk.screenshot({ path: shots + '/stay-desk-2.png' });
    step('the desk shows her answer');

    // the other guest answered "no" in WhatsApp: the receptionist notes it
    await desk.click('#ciStays summary');
    await desk.click('[data-clean="no"][data-id="95811650"]');
    await desk.waitForSelector('text=No cleaning');
    assert.strictEqual(srv.env.call({ action: 'hk_moves', key, date: T }).stays.find(s => s.bookId === '95811650').cleaning, 'no');
    step('the receptionist notes a "No" himself');

    await phone.goto(base + 'clean.html#b=95817014&d=' + T + '&t=' + '0'.repeat(24));
    await phone.reload();
    await phone.waitForSelector('text=This link is not valid');
    step('a made-up link is refused');
    assert.deepStrictEqual(errors, []);
    console.log('STAY CLEANING OK');
  } catch (e) { console.error('FAILED:', e.message, errors); process.exitCode = 1; }
  await browser.close();
  srv.server.close();
})();
