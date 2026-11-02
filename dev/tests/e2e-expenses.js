// End-to-end expenses: Chrome + real server code on a fake sheet, with an Internet cut.
// Run: node tests/e2e-expenses.js
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
  const expenses = () => book['Entries'].data.slice(1).filter(r => r[1] === 'Expense');

  try {
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1000000'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);

    await tab('expenses');
    await page.click('#expForm button[type=submit]');
    assert.match(await page.textContent('#expForm .error'), /Choose what the expense is for/);
    await page.click('[data-item="Restaurant"]');
    await page.keyboard.type('70000');
    await page.click('[data-epay="Cash"]');
    await page.fill('#expComment', 'telur 1 trai');
    await page.screenshot({ path: `${shots}/e01-expense-form.png`, fullPage: true });
    await page.click('#expForm button[type=submit]');
    await waitNotice(/Expense recorded: Restaurant, Rp 70\.000, Cash/);
    await waitStrip(/Connected/);
    const e = expenses()[0];
    assert.deepStrictEqual([e[2], e[3], e[8], e[11], e[12], e[13], e[16]], ['Other', 'Restaurant', 'r1@x', 70000, 'ExpenseRestaurant', 'Cash', 'telur 1 trai']);
    assert.strictEqual(await figure(2), '70.000');
    assert.strictEqual(await figure(3), 'Rp 930.000');
    step('cash expense recorded like the old dialog; the box total drops');

    srv.setDown(true);
    await page.click('[data-item="other"]');
    await page.keyboard.type('25000');
    await page.click('[data-epay="Credit / Debit Card"]');
    await page.click('#expForm button[type=submit]');
    await waitNotice(/Expense recorded: Others, Rp 25\.000, Card/);
    await waitStrip(/Offline|not reachable/);
    assert.strictEqual(await figure(3), 'Rp 930.000', 'card expense does not touch the box');
    // Fix the restaurant amount while offline.
    await page.locator('li.line').filter({ hasText: 'Restaurant' }).locator('[data-edit]').click();
    await page.fill('form[data-expform] input[name="amount"]', '75000');
    await page.click('form[data-expform] button[type=submit]');
    await waitNotice(/Expense updated/);
    assert.strictEqual(await figure(3), 'Rp 925.000');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.shift');
    await tab('expenses');
    assert.strictEqual((await page.$$('.badge.wait')).length, 2);
    await page.screenshot({ path: `${shots}/e02-expenses-offline.png`, fullPage: true });
    step('"Others" expense and a correction made during the cut, kept after a reload');

    await ctx.setOffline(false); srv.setDown(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitStrip(/Connected/, 40000);
    const ex = expenses();
    assert.strictEqual(ex.length, 2);
    assert.strictEqual(ex.find(r => r[3] === 'Restaurant')[11], 75000);
    const other = ex.find(r => r[3] === 'other');
    assert.deepStrictEqual([other[2], other[11], other[13]], ['Other', 25000, 'Credit / Debit Card']);
    assert.ok(book['UI_Log'].data.slice(1).every(r => r[7] === 'applied'));
    step('back online: both expenses in the sheet, the "Others" one included');

    await tab('close');
    assert.strictEqual(await figure(3), 'Rp 925.000');
    await page.click('#logout');
    await page.click('[data-user="dewa"]'); await page.fill('#p', 'dewa123'); await page.click('button.primary');
    await page.waitForSelector('.shift');
    await tab('expenses');
    assert.strictEqual((await page.$$('[data-edit], [data-del]')).length, 0);
    step('a colleague sees the expenses but cannot change them');

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E EXPENSES OK');
  } catch (e) {
    await page.screenshot({ path: `${shots}/ezz-failure.png`, fullPage: true }).catch(() => {});
    console.error('E2E EXPENSES FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
