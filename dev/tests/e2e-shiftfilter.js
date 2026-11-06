// End-to-end: This shift filter by payment type.  Run: node tests/e2e-shiftfilter.js
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');
const shots = __dirname + '/shots'; fs.mkdirSync(shots, { recursive: true });
const step = m => console.log('  ✓ ' + m);
(async () => {
  const srv = await start();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const waitNotice = re => page.waitForFunction(r => new RegExp(r).test(document.querySelector('.notice')?.textContent || ''), re.source, { timeout: 15000 });
  try {
    await page.goto(`http://localhost:${srv.port}/`);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm'); await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1387750'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    const sell = async (guest, pay, label) => {
      await page.click('#guestIn'); await page.keyboard.type(guest); await page.keyboard.press('Enter');
      await page.click('button.prod:has-text("Towel")');
      await page.click(`[data-pay="${pay}"]`); await page.click('#recordSale');
      await waitNotice(new RegExp('Sale recorded.*' + label));
    };
    await sell('Ann Cash', 'Cash', 'Cash');
    await sell('Ben Card', 'Credit / Debit Card', 'Card');
    await page.click('[data-tab="shift"]');
    await page.waitForSelector('.shiftfilter');
    const n = () => page.$$eval('.lines li', x => x.length);
    assert.strictEqual(await n(), 2);
    await page.click('[data-sfpay="Cash"]');
    assert.strictEqual(await n(), 1);
    assert.match(await page.textContent('.filtertotal'), /Cash: in Rp 50\.000/);
    await page.screenshot({ path: shots + '/shiftfilter.png' });
    await page.click('[data-sfpay=""]');
    assert.strictEqual(await n(), 2);
    assert.ok(await page.isDisabled('[data-sfpay="Transfer/Others"]'), 'empty type disabled');
    step('filter by payment type works');
    assert.deepStrictEqual(errors, []);
    console.log('OK');
  } catch (e) { await page.screenshot({ path: shots + '/shiftfilter-fail.png', fullPage: true }); console.error(e); process.exitCode = 1; }
  finally { await browser.close(); srv.server.close(); }
})();
