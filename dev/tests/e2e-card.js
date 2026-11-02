// End-to-end card terminal settlement: Chrome + real server code on a fake sheet, with an Internet cut.
// Run: node tests/e2e-card.js
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: net::ERR_(EMPTY_RESPONSE|INTERNET_DISCONNECTED|CONNECTION_RESET)/.test(m.text())) errors.push(m.text()); });
  const book = srv.env.book;
  const strip = () => page.textContent('#sync');
  const waitStrip = async (re, ms = 30000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (re.test(await strip())) return; await page.waitForTimeout(250); }
    throw new Error('strip never matched ' + re + ', got: ' + (await strip()));
  };
  const waitNotice = re => page.waitForFunction(r => new RegExp(r).test(document.querySelector('.notice')?.textContent || ''), re.source, { timeout: 15000 });
  const figure = async i => (await page.$$eval('.figures.row4 dd', els => els.map(e => e.textContent)))[i];
  const tab = async k => { await page.click(`[data-tab="${k}"]`); await page.waitForSelector(`[data-tab="${k}"][aria-selected="true"]`); };
  const settlements = () => book['Settlements'].data.slice(1);

  try {
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1000000'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);

    // A card sale of 300.000 in this shift.
    await page.click('#guestIn'); await page.keyboard.type('Card Guest'); await page.keyboard.press('Enter');
    await page.click('button.prod:has-text("Bar")');
    await page.keyboard.type('300000');
    await page.click('[data-pay="Credit / Debit Card"]');
    await page.click('#recordSale');
    await waitNotice(/Sale recorded: Rp 300\.000/);
    await waitStrip(/Connected/);
    await tab('card');
    assert.match(await page.textContent('.ctotal'), /Rp 300\.000/);
    await page.fill('#cs1', '288000');
    assert.match(await page.textContent('#cardDiff'), /more than 5\.000/);
    await page.click('#cardForm button[type=submit]');
    assert.match(await page.textContent('#cardForm .error'), /Send anyway only if/);
    await page.fill('#cs1', '309000');
    assert.match(await page.textContent('#cardDiff'), /: OK/);
    await page.screenshot({ path: `${shots}/k01-card-form.png`, fullPage: true });
    srv.setDown(true);
    await page.click('#cardForm button[type=submit]');
    await waitNotice(/Card settlement sent/);
    assert.match(await page.textContent('.cashbox'), /waiting to be sent/);
    await page.waitForFunction(() => /Rp 0$/.test(document.querySelector('.ctotal')?.textContent.trim() || ''), null, { timeout: 5000 });
    step('settlement typed, difference checked, kept while the sheet is unreachable');

    srv.setDown(false);
    await waitStrip(/Connected/, 40000);
    const row = settlements().pop();
    assert.deepStrictEqual([row[2], row[6], row[9], row[10]], ['r1@x', 300000, 309000, 309000]);
    assert.ok(Math.abs(row[4]) < 1);
    assert.match(row[8], /^Comment: \[C/);
    assert.ok(srv.env.mails.some(m => m.subject === 'Settlement Data Transferred'));
    assert.ok(!srv.env.mails.some(m => /^Attention/.test(m.subject)));
    step('back online: Settlements row like the old one, confirmation email to the author');

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E CARD OK');
  } catch (e) {
    await page.screenshot({ path: `${shots}/kzz-failure.png`, fullPage: true }).catch(() => {});
    console.error('E2E CARD FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
