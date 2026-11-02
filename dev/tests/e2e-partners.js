// End-to-end partner bills: Chrome + real server code on a fake sheet, with an Internet cut.
// Run: node tests/e2e-partners.js
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
  const byGuest = g => book['Entries'].data.find(r => r[12] === g);
  const mails = srv.env.mails;

  try {
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1000000'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);

    await tab('partners');
    assert.match(await page.textContent('[data-pobj="-Horse Riding"]'), /2/);
    assert.match(await page.textContent('.billlist'), /Shuttle Bangsal \/ Kuta/);
    await page.click('[data-pobj="-Horse Riding"]');
    // 700000 owed for Ann; Ben paid the partner 400000 for a 350000 cost: the partner owes us 50000.
    assert.match(await page.textContent('.ctotal'), /we owe the partner\s*Rp 650\.000/);
    await page.fill('[data-pcost]:first-of-type >> nth=0', '650000');
    await page.locator('[data-pcost]').first().dispatchEvent('change');
    await page.waitForFunction(() => /Rp 600\.000/.test(document.querySelector('.ctotal')?.textContent || ''));
    await page.screenshot({ path: `${shots}/p01-partner-pending.png`, fullPage: true });
    await page.click('[data-preview]');
    await page.click('[data-pcreate]');
    await waitNotice(/Bill created for Horse Riding: We pay Rp 600\.000/);
    await waitStrip(/Connected/);
    const ann = byGuest('Ann'), ben = byGuest('Ben');
    const billId = ann[18];
    assert.match(billId, /^B_\d\d\/\d\d-\d\d:\d\d$/);
    assert.strictEqual(ann[11], 650000);
    assert.strictEqual(ben[18], ann[18]);
    assert.deepStrictEqual(mails.map(m => m.subject.split(' (')[0]), ['Modification data Partner in entries', 'Bill']);
    step('bill created like the old dialog: costs and bill id in Entries, cost change and PDF emailed');

    srv.setDown(true);
    const box = await figure(3);
    assert.strictEqual(box, 'Rp 1.000.000');
    // The new bill opens by itself.
    assert.strictEqual(await page.locator('.billlist li').filter({ hasText: 'Horse Riding' }).locator('[data-bopen]').getAttribute('aria-expanded'), 'true');
    await page.click('[data-bpay]');
    await page.click('[data-bptype="Cash"]');
    await page.click('[data-bpaid]');
    await waitNotice(/paid: We pay Rp 600\.000, Cash/);
    assert.strictEqual(await figure(3), 'Rp 400.000');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.shift');
    assert.strictEqual(await figure(3), 'Rp 400.000');
    await tab('partners');
    assert.doesNotMatch(await page.textContent('.billlist'), /Horse Riding/);
    await page.screenshot({ path: `${shots}/p02-partner-paid-offline.png`, fullPage: true });
    step('during the cut: the bill paid in cash, the box drops by 600.000, kept after a reload');

    await ctx.setOffline(false); srv.setDown(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitStrip(/Connected/, 40000);
    const pay = book['Entries'].data.filter(r => r[12] === 'Payment to Partner');
    assert.strictEqual(pay.length, 1);
    assert.deepStrictEqual([pay[0][1], pay[0][3], pay[0][11], pay[0][13], pay[0][16], pay[0][18]], ['Expense', '-Horse Riding', 600000, 'Cash', billId, 'Settled']);
    assert.strictEqual(byGuest('Ann')[18], 'Paid');
    assert.strictEqual(byGuest('Ben')[18], 'Paid');
    assert.ok(mails.some(m => /^BillSettlement/.test(m.subject)));
    assert.ok(book['UI_Log'].data.slice(1).every(r => r[7] === 'applied'));
    step('back online: payment row "Payment to Partner" Settled, lines Paid, settlement emailed');

    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.locator('.billlist li').filter({ hasText: 'Shuttle' }).locator('[data-bopen]').click();
    await page.click('[data-bprint]');
    assert.strictEqual(await page.evaluate(() => window.__printed), 1);
    assert.match(await page.textContent('#printArea'), /Total invoiced: Rp 90\.000/);
    await page.click('[data-bdel]');
    await page.click('[data-bdelok]');
    await waitNotice(/deleted/);
    await waitStrip(/Connected/);
    assert.strictEqual(byGuest('Cy')[18], '');
    assert.match(await page.textContent('[data-pobj="-Shuttle Bangsal / Kuta"]'), /1/);
    step('old bill printed, then deleted: its line is back in "not billed"');

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E PARTNERS OK');
  } catch (e) {
    await page.screenshot({ path: `${shots}/pzz-failure.png`, fullPage: true }).catch(() => {});
    console.error('E2E PARTNERS FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
