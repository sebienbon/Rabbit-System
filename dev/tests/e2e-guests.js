// End-to-end: "+ New guest" in Guest bills and the Refresh button in the header.
// Run: node tests/e2e-guests.js
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
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
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const strip = () => page.textContent('#sync');
  const waitStrip = async (re, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await strip())) return; await page.waitForTimeout(250); } throw new Error('strip: ' + await strip()); };
  const waitNotice = re => page.waitForFunction(r => new RegExp(r).test(document.querySelector('.notice')?.textContent || ''), re.source, { timeout: 15000 });
  try {
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1387750'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);
    assert.ok(await page.isVisible('#refreshBtn'));
    step('Refresh button in the header');

    await page.click('[data-tab="bills"]');
    await page.click('[data-newguest]');
    await page.fill('#ngName', 'Maya Walkin');
    await page.screenshot({ path: shots + '/guests-1-form.png' });
    await page.click('#newGuestForm button[type=submit]');
    await waitNotice(/Guest added: Maya Walkin/);
    assert.ok((await page.textContent('#billList')).includes('Maya Walkin'));
    step('new guest shown in the list at once');
    await waitStrip(/Connected/);
    const ng = srv.env.book['New guest'].data.filter(r => r[2] === 'Maya Walkin');
    assert.strictEqual(ng.length, 1); assert.strictEqual(ng[0][5], 'Maya Walkin');
    step('new guest written to New guest (C and F)');

    await page.click('[data-tab="sell"]');
    await page.fill('#guestIn', 'maya');
    await page.waitForSelector('[data-sug="Maya Walkin"]');
    step('new guest suggested in Sell');

    await page.click('[data-tab="gear"]');
    await page.click('#refreshBtn');
    await waitNotice(/Refreshed/);
    await page.screenshot({ path: shots + '/guests-2-refresh.png' });
    step('Refresh works from any tab');
    assert.deepStrictEqual(errors, []);
    console.log('OK');
  } catch (e) { await page.screenshot({ path: shots + '/guests-fail.png', fullPage: true }); console.error(e); process.exitCode = 1; }
  finally { await browser.close(); srv.server.close(); }
})();
