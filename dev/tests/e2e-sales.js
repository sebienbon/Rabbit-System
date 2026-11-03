// End-to-end sales: real interface in Chrome + real server code on a fake sheet,
// with an Internet cut in the middle. Run: node tests/e2e-sales.js
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: net::ERR_(EMPTY_RESPONSE|INTERNET_DISCONNECTED|CONNECTION_RESET)/.test(m.text())) errors.push(m.text()); });
  const shot = n => page.screenshot({ path: `${shots}/s${n}.png`, fullPage: true });
  const book = srv.env.book;
  const strip = () => page.textContent('#sync');
  const waitStrip = async (re, ms = 20000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (re.test(await strip())) return; await page.waitForTimeout(250); }
    throw new Error('strip never matched ' + re + ', got: ' + (await strip()));
  };
  const entries = () => book['Entries'].data.slice(1).filter(r => r[14] && !['Ann', 'Ben', 'Cy'].includes(r[12])); // without the seeded partner sales
  const figure = async i => (await page.$$eval('.figures.row4 dd', els => els.map(e => e.textContent)))[i];
  const waitNotice = re => page.waitForFunction(r => new RegExp(r).test(document.querySelector('.notice')?.textContent || ''), re.source, { timeout: 15000 });
  const lineOf = (guest, product) => page.locator('li.line').filter({ hasText: guest }).filter({ has: page.locator('b', { hasText: new RegExp('^' + product + '$') }) });
  const tab = async k => { await page.click(`[data-tab="${k}"]`); await page.waitForSelector(`[data-tab="${k}"][aria-selected="true"]`); };

  try {
    // Setup: manager registers the computer, Ayu opens her shift.
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1387750'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);
    step('shift open, sale screen shown');

    // ---- sale: two guests, Towel x2 and Bar with a typed price, Cash ----
    await page.click('#guestIn'); await page.keyboard.type('ali');
    await page.waitForSelector('#guestSug:not([hidden])');
    assert.match(await page.textContent('#guestSug'), /Alice Example.*owes Rp 60\.000/);
    await page.click('[data-sug="Alice Example"]');
    await page.keyboard.type('Charlie New'); await page.keyboard.press('Enter');
    assert.deepStrictEqual(await page.$$eval('.chip', c => c.map(x => x.firstChild.textContent)), ['Alice Example', 'Charlie New']);
    await page.click('button.prod:has-text("Towel")'); await page.click('button.prod:has-text("Towel")');
    await page.click('button.prod:has-text("Bar")');
    await page.keyboard.type('20000');
    await page.click('[data-pay="Cash"]');
    await page.click('#recordSale');
    await page.waitForFunction(() => /Bar/.test(document.querySelector('#saleErr')?.textContent || '') === false);
    await shot('01-sale-filled').catch(() => {});
    await waitNotice(/Sale recorded: Rp 240\.000, Cash/);
    await waitStrip(/Connected/);
    assert.strictEqual(entries().length, 5, '4 new lines + the old unpaid one');
    const bar = entries().find(r => r[3] === 'Bar' && r[12] === 'Charlie New');
    assert.deepStrictEqual([bar[4], bar[5], bar[7], bar[8], bar[13]], [1, 20000, 20000, 'r1@x', 'Cash']);
    assert.strictEqual(await figure(1), '240.000');
    step('sale for two guests recorded: one line per product and guest in the sheet');

    // ---- the empty-cart guards ----
    await page.click('[data-pay="Cash"]'); await page.click('#recordSale');
    assert.match(await page.textContent('#saleErr'), /Add the guest first/);
    step('cannot record a sale without guest or product');

    // ---- Internet cut ----
    srv.setDown(true);
    await page.click('#guestIn'); await page.keyboard.type('Charlie'); await page.click('[data-sug="Charlie New"]');
    await page.click('button.prod:has-text("Horse Riding")');
    await page.click('[data-pay="Unpaid"]'); await page.click('#recordSale');
    await waitNotice(/Rp 400\.000, Unpaid/);
    await waitStrip(/Offline|not reachable/);
    step('unpaid sale recorded during the cut');

    await tab('bills');
    const billsText = await page.textContent('#work');
    assert.match(billsText, /Alice Example[\s\S]*60\.000/); assert.match(billsText, /Charlie New[\s\S]*400\.000/);
    await page.click('[data-open="Alice Example"]');
    await page.click('[data-bpay="Credit / Debit Card"]');
    await page.click('#payForm button[type=submit]');
    await waitNotice(/Payment recorded: Rp 60\.000 from Alice Example, Card/);
    await shot('02-bill-paid-offline');
    step('Alice pays her open bill by card, offline');

    await tab('shift');
    // Alice's towel: quantity 2 -> 1. Charlie's Bar: deleted.
    await lineOf('Alice Example', 'Towel').locator('[data-edit]').click();
    await page.fill('form[data-editform] input[name="qty"]', '1');
    await page.click('form[data-editform] button[type=submit]');
    await waitNotice(/Line updated/);
    await lineOf('Charlie New', 'Bar').locator('[data-del]').click();
    await page.click('[data-delok]');
    await waitNotice(/Deleted: Bar for Charlie New/);
    assert.strictEqual(await figure(1), '170.000', 'cash in after the edit and the delete');
    assert.ok((await page.$$('.badge.wait')).length >= 3, 'changes marked as waiting');
    await shot('03-shift-offline');
    step('quantity changed and a line deleted, offline; cash figures follow');

    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.shift');
    await tab('shift');
    assert.strictEqual(await figure(1), '170.000');
    assert.match(await page.textContent('#work'), /Horse Riding/);
    step('everything survives a reload with no network');

    // ---- back online ----
    await ctx.setOffline(false); srv.setDown(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitStrip(/Connected/, 40000);
    const E = entries();
    const at = (g, o) => E.find(r => r[12] === g && r[3] === o);
    assert.strictEqual(at('Alice Example', 'Towel')[4], 1);
    assert.strictEqual(at('Alice Example', 'Towel')[7], 50000);
    assert.ok(!at('Charlie New', 'Bar'), 'deleted in the sheet');
    assert.strictEqual(at('Charlie New', '-Horse Riding')[13], 'Unpaid');
    const laundry = at('Alice Example', 'Laundry');
    assert.deepStrictEqual([laundry[8], laundry[13]], ['r1@x', 'Credit / Debit Card']);
    const log = book['UI_Log'].data.slice(1);
    assert.ok(log.every(r => r[7] === 'applied'), JSON.stringify(log.map(r => [r[4], r[7], r[8]])));
    assert.strictEqual(new Set(log.map(r => r[1])).size, log.length, 'each operation once');
    // The strip turns green before the screen redraws: give the redraw a moment.
    await page.waitForFunction(() => !document.querySelector('.badge.wait'), null, { timeout: 10000 }).catch(() => {});
    assert.strictEqual((await page.$$('.badge.wait')).length, 0, 'nothing waiting any more');
    step('back online: sheet matches the screen, every operation applied once');

    // ---- refund ----
    await lineOf('Alice Example', 'Towel').locator('[data-refund]').click();
    // Another payment type is allowed, but needs a reason.
    await page.selectOption('form[data-refform] select[name="payment"]', 'Transfer/Others');
    await page.click('form[data-refform] button[type=submit]');
    assert.match(await page.textContent('form[data-refform] .error'), /Say why it is not paid back by Cash/);
    await page.selectOption('form[data-refform] select[name="payment"]', 'Cash');
    await page.fill('form[data-refform] input[name="reason"]', 'wet towel');
    await page.click('form[data-refform] button[type=submit]');
    await waitNotice(/Refund recorded: Rp 50\.000 to Alice Example, Cash/);
    await waitStrip(/Connected/);
    assert.strictEqual(await figure(2), '50.000', 'cash paid out');
    const ref = entries().find(r => r[1] === 'Expense');
    assert.deepStrictEqual([ref[3], ref[11], ref[12], ref[13], ref[16]], ['Towel', 50000, 'Alice Example', 'Cash', 'Refunding']);
    assert.strictEqual(entries().find(r => r[12] === 'Alice Example' && r[3] === 'Towel' && r[1] === 'Income')[16], 'Refunded');
    await shot('04-after-refund');
    step('refund recorded as an expense, original marked Refunded');

    // ---- close: expected cash includes sales and refund ----
    await tab('close');
    assert.strictEqual(await figure(3), 'Rp 1.507.750', '1.387.750 + 170.000 − 50.000');
    step('close shift expects 1.507.750 in the box');

    // ---- another staff member cannot change Ayu's lines ----
    await page.click('#logout');
    await page.click('[data-user="dewa"]'); await page.fill('#p', 'dewa123'); await page.click('button.primary');
    await page.waitForSelector('.shift');
    await tab('shift');
    assert.strictEqual((await page.$$('[data-edit], [data-del]')).length, 0);
    assert.strictEqual((await page.$$('[data-refund]')).length, 0, 'a refund is done by the person on shift (or a manager)');
    step('a colleague sees the shift but cannot edit or delete its lines');

    // Phone width
    await page.setViewportSize({ width: 390, height: 844 });
    await tab('sell');
    await page.screenshot({ path: `${shots}/s05-phone-sell.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E SALES OK');
  } catch (e) {
    await shot('zz-failure').catch(() => {});
    console.error('E2E SALES FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
