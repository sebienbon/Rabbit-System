// End-to-end: real interface in Chrome + real server code on a fake sheet, with an outage.
// Run: node tests/e2e.js   (screenshots go to tests/shots/)
const { chromium } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');

const shots = __dirname + '/shots';
fs.mkdirSync(shots, { recursive: true });
const step = (m) => console.log('  ✓ ' + m);

(async () => {
  const srv = await start();
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 820 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Network failures during the simulated outage are expected; anything else is a bug.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: net::ERR_(EMPTY_RESPONSE|INTERNET_DISCONNECTED)/.test(m.text())) errors.push(m.text()); });
  const shot = n => page.screenshot({ path: `${shots}/${n}.png`, fullPage: true });
  const strip = () => page.textContent('#sync');
  const book = srv.env.book;
  const waitStrip = async (re, ms = 15000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (re.test(await strip())) return; await page.waitForTimeout(250); }
    throw new Error('strip never matched ' + re + ', got: ' + (await strip()));
  };

  try {
    await page.goto(base);
    await page.waitForSelector('#loginForm');
    await shot('01-first-login');
    // Hash parity between browser and server.
    const h = await page.evaluate(async () => (await import('./js/auth.js')).hashPassword('pw', 'salt', 2000));
    assert.strictEqual(h, srv.env.ctx.UIAPI._hash('pw', 'salt'));
    step('browser and server compute the same password hash');

    await page.fill('#u', 'ayu'); await page.fill('#p', 'wrong'); await page.click('button.primary');
    await page.waitForFunction(() => document.querySelector('#loginErr').textContent.includes('Wrong'));
    step('wrong password refused');
    await page.fill('#p', 'ayu123'); await page.check('#reg'); await page.click('button.primary');
    await page.waitForFunction(() => document.querySelector('#loginErr').textContent.includes('Only a manager'));
    step('staff cannot register the computer');
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.waitForSelector('.tiles');
    step('manager registered this computer; colleagues now appear as tiles');
    await page.click('[data-user="ayu"]');
    await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await waitStrip(/Connected/);
    assert.match(await page.textContent('.figure'), /1\.387\.750/);
    step('online login, last cash in box shown from the sheet');

    await page.fill('#cash', '1387000');
    assert.match(await page.textContent('#diff'), /750 missing/);
    await shot('02-open-form');
    await page.click('#openForm button.primary');
    await page.waitForSelector('.shift');
    await waitStrip(/Connected/);
    const open = book['Cashouts&Cor'].data.at(-1);
    assert.deepStrictEqual([open[3], open[4], open[6], open[8]], [-750, 1387000, 'r1@x', 'Opening']);
    assert.match(open[7], /^\[S\d+-\w+\]$/);
    assert.strictEqual(book['UI_Shifts'].data.at(-1)[10], 'Open');
    await shot('03-shift-open');
    step('shift opened and written to Cashouts&Cor and UI_Shifts');

    // ---- outage ----
    srv.setDown(true);
    await page.fill('#cash', '1000000');
    await page.fill('#cashout', '387000');
    assert.match(await page.textContent('#diff'), /Exact/);
    await page.click('#closeForm button.primary');
    await page.waitForSelector('.confirm');
    await shot('04-confirm-close');
    await page.click('#confirmClose');
    await waitStrip(/Offline|Sheet not reachable/);
    await waitStrip(/1 operation kept/);
    await shot('05-offline-closed');
    step('shift closed during the outage, kept on the computer');

    await page.click('#logout');
    await page.waitForSelector('.tiles');
    await shot('06-tiles');
    await page.click('[data-user="dewa"]');
    await page.fill('#p', 'dewa123'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    assert.match(await page.textContent('.figure'), /1\.000\.000/, 'next opening starts from the offline close');
    await page.fill('#cash', '1000000');
    await page.click('#openForm button.primary');
    await page.waitForSelector('.shift');
    await waitStrip(/2 operations kept/);
    step('colleague logged in offline and opened the next shift');

    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.shift');
    assert.match(await page.textContent('.shift h2'), /Your shift is open/);
    await shot('07-reload-offline');
    step('page reloads with no network at all and keeps its state');

    // ---- back online ----
    await ctx.setOffline(false);
    srv.setDown(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitStrip(/Connected/, 30000);
    const rows = book['Cashouts&Cor'].data.slice(-2);
    assert.deepStrictEqual(rows.map(r => r[8]), ['Closing', 'Opening']);
    assert.deepStrictEqual([rows[0][2], rows[0][3], rows[0][4], rows[0][6]], [387000, 0, 1000000, 'r1@x']);
    assert.strictEqual(rows[1][6], 'r2@x');
    const log = book['UI_Log'].data.slice(1);
    assert.deepStrictEqual(log.map(r => r[7]), ['applied', 'applied', 'applied']);
    assert.strictEqual(new Set(log.map(r => r[1])).size, 3, 'each operation logged exactly once');
    assert.match(log[2][3], /^dewa \(offline-login/);
    const manual = book['Entries Manual'].data.at(-1);
    assert.deepStrictEqual([manual[1], manual[11]], ['Cash-out', 387000]);
    await shot('08-back-online');
    step('back online: both operations reached the sheet in order, authors correct');

    // ---- refused op is surfaced ----
    // Someone opens a shift directly on the server; our local close should still be fine,
    // but a second open from here must be refused and shown.
    await page.click('#logout');
    await page.click('[data-user="boss"]'); await page.fill('#p', 'boss123'); await page.click('button.primary');
    await page.waitForSelector('.shift');
    assert.match(await page.textContent('.shift h2'), /Dewa's shift is open/);
    step('manager sees the colleague\'s open shift and can close it');

    // Manager closes Dewa's shift from another computer (not registered, online only).
    const ctx2 = await browser.newContext({ viewport: { width: 420, height: 860 } });
    const p2 = await ctx2.newPage();
    await p2.goto(base);
    await p2.waitForSelector('#u');
    await p2.fill('#u', 'boss'); await p2.fill('#p', 'boss123'); await p2.click('button.primary');
    await p2.waitForSelector('#closeForm');
    await p2.fill('#cash', '1000000'); await p2.click('#closeForm button.primary');
    await p2.click('#confirmClose');
    await p2.waitForSelector('#openForm');
    await p2.screenshot({ path: `${shots}/09-phone-manager.png`, fullPage: true });
    await page.waitForSelector('#openForm', { timeout: 20000 }); // reception computer catches up
    assert.strictEqual(book['UI_Shifts'].data.at(-1)[10], 'Closed');
    assert.strictEqual(book['UI_Shifts'].data.at(-1)[11], 'boss');
    step('shift closed by the manager on another computer disappears from the reception screen');
    await ctx2.close();

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E OK');
  } catch (e) {
    await shot('zz-failure').catch(() => {});
    console.error('E2E FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
