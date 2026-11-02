// End-to-end cash box (phantom cash, cash supply): Chrome + real server code on a fake sheet, with an Internet cut.
// Run: node tests/e2e-cash.js
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
  const cashRows = () => book['Cashouts&Cor'].data.slice(1).filter(r => r[8]);
  // A legacy phantom, written by the old dialog before the interface existed.
  book['Cashouts&Cor'].appendRow(['19/10/2026', '10:52:17', '', -25000, 0, '', 'r2@x', 'kembalian water refill', 'Phantom']);

  try {
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1000000'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);

    await tab('cash');
    assert.match(await page.textContent('.cashbox'), /kembalian water refill/);
    await page.click('#phForm button[type=submit]');
    assert.match(await page.textContent('#phForm .error'), /Choose cash not given or cash not received/);
    await page.click('[data-kind="given"]');
    await page.keyboard.type('20000');
    await page.click('#phForm button[type=submit]');
    assert.match(await page.textContent('#phForm .error'), /Say who it is for and why/);
    await page.fill('#phComment', 'change for Elias');
    await page.screenshot({ path: `${shots}/c01-phantom-form.png`, fullPage: true });
    await page.click('#phForm button[type=submit]');
    await waitNotice(/Phantom cash recorded: cash not given, Rp 20\.000/);
    await waitStrip(/Connected/);
    assert.strictEqual(await figure(3), 'Rp 1.020.000');
    const p1 = cashRows().pop();
    assert.deepStrictEqual([p1[3], p1[6], p1[8]], [20000, 'r1@x', 'Phantom']);
    assert.match(p1[7], /^change for Elias \[P/);
    step('phantom cash recorded like the old dialog; the box total includes it');

    srv.setDown(true);
    await page.click('[data-kind="received"]');
    await page.keyboard.type('5000');
    await page.fill('#phComment', 'room 3 pays tomorrow');
    await page.click('#phForm button[type=submit]');
    await waitNotice(/cash not received, Rp 5\.000/);
    await page.locator('.phantoms li').filter({ hasText: 'change for Elias' }).locator('[data-solve]').click();
    assert.match(await page.textContent('.phantoms li.open'), /Rp 20\.000 given back now\?/);
    await page.click('[data-solveok]');
    await waitNotice(/Phantom cash solved: change for Elias/);
    assert.strictEqual(await figure(3), 'Rp 995.000');
    assert.strictEqual(await page.locator('.phantoms li').filter({ hasText: 'change for Elias' }).locator('[data-solve]').count(), 0, 'a solved phantom leaves "Not solved yet" at once');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.shift');
    await tab('cash');
    assert.ok((await page.$$('.badge.wait')).length >= 2);
    assert.strictEqual(await page.locator('.phantoms li').filter({ hasText: 'change for Elias' }).locator('[data-solve]').count(), 0, 'still gone after a reload');
    assert.strictEqual(await figure(3), 'Rp 995.000');
    await page.screenshot({ path: `${shots}/c02-cash-offline.png`, fullPage: true });
    step('during the cut: a second phantom and solving the first, kept after a reload');

    await ctx.setOffline(false); srv.setDown(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitStrip(/Connected/, 40000);
    let rows = cashRows();
    assert.strictEqual(rows.find(r => /change for Elias \[/.test(r[7]) && r[8] !== 'Phantom Salvation')[8], 'Phantom Solved');
    const salv = rows.find(r => r[8] === 'Phantom Salvation');
    assert.strictEqual(salv[3], -20000);
    assert.strictEqual(rows.find(r => /room 3 pays tomorrow/.test(r[7]))[3], -5000);
    assert.ok(book['UI_Log'].data.slice(1).every(r => r[7] === 'applied'), JSON.stringify(book['UI_Log'].data.slice(1).map(r => [r[4], r[7], r[8]])));
    step('back online: phantom, salvation and "Phantom Solved" in Cashouts&Cor');

    await page.fill('#supAmount', '500000');
    await page.click('#supForm button[type=submit]');
    await page.waitForSelector('#supForm .inline.warn');
    await page.click('#supForm button[type=submit]');
    await waitNotice(/Cash supply recorded: Rp 500\.000/);
    await waitStrip(/Connected/);
    const ent = book['Entries'].data.slice(1).filter(r => r[3] === 'Cash Supply');
    assert.deepStrictEqual(ent.map(r => [r[1], r[13]]).sort(), [['Expense', 'Extern Cash'], ['Income', 'Cash']]);
    assert.strictEqual(await figure(3), 'Rp 1.495.000');
    await tab('shift');
    assert.strictEqual(await page.locator('li.line').filter({ hasText: 'Cash Supply' }).locator('[data-edit],[data-del],[data-refund]').count(), 0);
    step('cash supply: two lines like the old dialog, not editable by staff, counted in the box');

    await page.click('#logout');
    await page.click('[data-user="boss"]'); await page.fill('#p', 'boss123'); await page.click('button.primary');
    await page.waitForSelector('.shift');
    await tab('shift');
    const supplyIncome = page.locator('li.line').filter({ hasText: 'Put in the box' });
    assert.strictEqual(await supplyIncome.locator('[data-edit]').count(), 0, 'no Edit on a cash supply, even for a manager');
    await supplyIncome.locator('[data-del]').click();
    assert.match(await page.textContent('li.line .inline.warn'), /both of its lines/);
    await page.click('[data-delok]');
    await waitNotice(/Deleted/);
    await waitStrip(/Connected/);
    assert.strictEqual(book['Entries'].data.slice(1).filter(r => r[3] === 'Cash Supply').length, 0, 'both lines deleted');
    assert.strictEqual(await figure(3), 'Rp 995.000');
    step('a manager deletes a cash supply: both of its lines go');

    await tab('close');
    await page.fill('#cash', '995000');
    assert.match(await page.textContent('#diff'), /Exact/);
    await page.click('#closeForm button.primary');
    await page.click('#confirmClose');
    await waitNotice(/Shift closed/);
    await waitStrip(/Connected/);
    const closing = cashRows().pop();
    assert.deepStrictEqual([closing[3], closing[4], closing[8]], [0, 995000, 'Closing']);
    step('closing: the sheet agrees, difference 0');

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E CASH OK');
  } catch (e) {
    await page.screenshot({ path: `${shots}/czz-failure.png`, fullPage: true }).catch(() => {});
    console.error('E2E CASH FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
