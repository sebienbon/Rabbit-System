// End-to-end gear (masks & bikes): the reception rents a mask in Sell, the gear staff phone
// does the Sunset Boat and the blind evening check, both sides solve the differences.
// Run: node tests/e2e-gear.js
const { chromium } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');

const shots = __dirname + '/shots';
fs.mkdirSync(shots, { recursive: true });
const step = m => console.log('  ✓ ' + m);

(async () => {
  const srv = await start();
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const errors = [];
  for (const p of [desk, phone]) {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  }
  const book = srv.env.book;
  const until = async (fn, what, ms = 30000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await fn()) return; await new Promise(r => setTimeout(r, 300)); }
    throw new Error('timeout: ' + what);
  };
  const log = () => book['Gear_Log'].data.slice(1);
  const sg = id => book['SG'].data.find(r => r[0] === id);
  const idle = p => until(async () => /Connected|Terhubung/.test(await p.textContent('#sync')) && !/Sending|Mengirim/.test(await p.textContent('#sync')), 'synced');
  const tab = async k => { await desk.click(`[data-tab="${k}"]`); await desk.waitForSelector(`[data-tab="${k}"][aria-selected="true"]`); };

  try {
    // Reception: register, open a shift.
    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#openForm');
    await desk.click('#logout');
    // A gear account cannot use the reception.
    await desk.fill('#u', 'made').catch(() => {});
    if (await desk.$('#u')) {
      await desk.fill('#p', 'made123'); await desk.click('button.primary');
      await desk.waitForFunction(() => /gear app/.test(document.querySelector('#loginErr')?.textContent || ''));
      step('gear account refused at the reception');
    }
    await desk.click('[data-user="ayu"]'); await desk.fill('#p', 'ayu123'); await desk.click('button.primary');
    await desk.fill('#cash', '1387750'); await desk.click('#openForm button.primary');
    await desk.waitForSelector('.sell');
    await idle(desk);

    // Rent mask SG001 to Alice, 1 day, typed number.
    await desk.click('#guestIn'); await desk.keyboard.type('ali'); await desk.click('[data-sug="Alice Example"]');
    await desk.click('button.prod:has-text("Snorkeling Mask")');
    await desk.waitForSelector('[data-gearin="0"]');
    await desk.waitForSelector('[data-gearsug="0"]:not([hidden])');
    await desk.screenshot({ path: `${shots}/g01-sell-picker.png` });
    await desk.keyboard.type('sg001'); await desk.keyboard.press('Enter');
    await desk.waitForSelector('.chip:has-text("SG001")');
    await desk.click('[data-pay="Unpaid"]'); await desk.click('#recordSale');
    await until(() => sg('SG001')[1] === 'Out', 'SG001 out');
    const sale = book['Entries'].data.find(r => r[3] === 'Snorkeling Mask');
    assert.strictEqual(sale[12], 'Alice Example'); assert.match(String(sale[16]), /SG001/);
    assert.ok(log().some(r => r[2] === 'out' && r[3] === 'SG001'));
    step('mask rented in Sell: number picked, SG sheet Out, Gear_Log out event');

    // Phone: gear staff logs in, Sunset Boat out SG002 + SG003, back only SG002.
    await phone.goto(base + 'gear.html');
    await phone.fill('#u', 'made'); await phone.fill('#p', 'made123'); await phone.click('#lf button');
    await phone.waitForSelector('[data-go="sunset"]');
    await phone.click('[data-go="sunset"]');
    await phone.click('[data-cell="SG002"]'); await phone.click('[data-cell="SG003"]');
    await phone.screenshot({ path: `${shots}/g02-sunset-out.png` });
    await phone.click('[data-save="out"]');
    await until(() => log().some(r => r[2] === 'sunset_out'), 'sunset out logged');
    await phone.click('[data-go="sunset"]');
    await phone.waitForSelector('[data-save="back"]');
    await phone.click('[data-cell="SG002"]');
    await phone.click('[data-save="back"]'); // first click warns: SG003 missing
    await phone.waitForSelector('[data-save="back"]:has-text("selisih")');
    await phone.click('[data-save="back"]');
    await until(() => log().some(r => r[2] === 'diff' && r[3] === 'SG003'), 'sunset diff');
    step('Sunset Boat out/back from the phone; the mask not back becomes a difference');

    // Blind evening check: SG001 is in the box (recorded out), SG005 is missing, SG006 has no snorkel.
    await idle(phone);
    await phone.click('[data-go="count"]');
    await phone.waitForSelector('[data-cell="B1442"]');
    const cells = await phone.$$eval('[data-cell]', els => els.map(e => e.dataset.cell));
    assert.ok(cells.includes('SG001') && cells.includes('B1442'), cells.join());
    assert.strictEqual(await phone.$('.gacell.on'), null, 'nothing pre-marked: the check is blind');
    for (const id of cells) if (!['SG003', 'SG005'].includes(id)) await phone.click(`[data-cell="${id}"]`);
    await phone.click('[data-cell="SG006"]'); // second touch: condition
    await phone.click('[data-cond="Snorkel missing"]');
    await phone.waitForSelector('a.gawa[href*="wa.me/6281200000000"]');
    await phone.screenshot({ path: `${shots}/g03-count.png`, fullPage: true });
    await phone.click('[data-save="count"]'); await phone.click('[data-save="count"]');
    await until(() => log().some(r => r[2] === 'count'), 'count logged');
    const kinds = log().filter(r => r[2] === 'diff').map(r => r[3] + ':' + JSON.parse(r[7] || '{}').kind).sort();
    assert.deepStrictEqual(kinds, ['SG001:counted_but_out', 'SG003:sunset_missing', 'SG005:missing']);
    await phone.waitForSelector('[data-go="diffs"]:has-text("3 selisih")', { timeout: 20000 });
    step('blind check: 3 differences worked out by the sheet (in box but out, not back from boat, missing)');

    // Reception sees them, plus the damage.
    await tab('gear');
    await until(async () => (await desk.$$('.gdiff')).length >= 4, 'gear tab differences', 20000);
    await desk.screenshot({ path: `${shots}/g04-reception-gear.png`, fullPage: true });
    assert.ok(await desk.$('[data-tab="gear"] .count'));
    await desk.click('[data-dfsite]'); // SG001 found on site, no extension
    await desk.waitForSelector('.notice:has-text("found on site")');
    // Phone confirms SG001.
    await phone.click('[data-go="diffs"]');
    await phone.click('.gadiff:has-text("SG001") [data-confirm]');
    await until(() => log().filter(r => r[2] === 'confirm' && r[3] === 'SG001').length === 2, 'both confirmed');
    await until(() => sg('SG001')[1] === 'OK', 'SG001 back in');
    step('SG001 closed once both sides confirmed; back in stock without extension');

    // Damage SG006: charge Alice at the Gear_Settings price.
    await idle(desk);
    await tab('gear');
    await desk.waitForSelector('[data-dmgcharge]');
    await desk.fill('.gdiff:has-text("SG006") [data-dmgguest]', 'Alice Example');
    await desk.click('.gdiff:has-text("SG006") [data-dmgcharge]');
    await until(() => book['Entries'].data.some(r => r[3] === 'Gear damage' || (r[12] === 'Alice Example' && r[7] === 75000)), 'damage charged');
    const dmg = book['Entries'].data.find(r => r[12] === 'Alice Example' && r[7] === 75000);
    assert.strictEqual(dmg[13], 'Unpaid');
    step('damage charged to the guest as an Unpaid line at the set price');

    // "Not solved yet" keeps a difference open on the phone.
    await phone.click('[data-go="home"]'); await phone.click('[data-go="diffs"]');
    await phone.click('.gadiff:has-text("SG005") [data-later]');
    await phone.waitForSelector('.gadiff:has-text("SG005") [data-unlater]');
    step('“Belum selesai” keeps it open');

    assert.deepStrictEqual(errors, []);
    console.log('\nE2E GEAR OK');
  } catch (e) {
    console.error('E2E GEAR FAILED:', e.message, '\nconsole errors:', errors);
    await desk.screenshot({ path: `${shots}/g-fail-desk.png`, fullPage: true }).catch(() => {});
    await phone.screenshot({ path: `${shots}/g-fail-phone.png`, fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
