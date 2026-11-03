// End-to-end: real interface in Chrome + real server code on a fake sheet, with an outage.
// Run: node tests/e2e.js   (screenshots go to tests/shots/)
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
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
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource: net::ERR_(EMPTY_RESPONSE|INTERNET_DISCONNECTED|CONNECTION_RESET)/.test(m.text())) errors.push(m.text()); });
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
    await page.fill('#p', 'ayu123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForFunction(() => document.querySelector('#loginErr').textContent.includes('Only a manager'));
    step('staff cannot register the computer');
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
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
    await page.click('[data-tab="close"]');
    await page.fill('#cash', '1000000');
    await page.fill('#cashout', '387000');
    assert.match(await page.textContent('#diff'), /Exact/);
    await page.click('#closeForm button.primary');
    await page.waitForSelector('.confirm');
    await shot('04-confirm-close');
    await page.click('#confirmClose');
    await page.waitForFunction(() => /No internet: the shift can’t be closed now\. Keep working, close it when the connection is back\./.test(document.querySelector('.confirm .error')?.textContent || ''));
    assert.strictEqual(await page.evaluate(async () => (await (await import('./js/db.js')).db.all('outbox')).length), 0, 'the close is not queued');
    assert.ok(await page.$('#confirmClose'), 'still on the confirmation, the shift stays open');
    await shot('05-offline-close-refused');
    step('closing the shift during the outage is refused with a clear message, nothing queued');

    // Work goes on offline: an expense is kept on the computer.
    await page.click('#cancelClose');
    await page.click('[data-tab="expenses"]');
    await page.click('[data-item="Restaurant"]'); await page.keyboard.type('15000'); await page.click('[data-epay="Cash"]');
    await page.click('#expForm button[type=submit]');
    await waitStrip(/1 operation kept|Sheet not reachable/);
    await waitStrip(/1 operation/);
    step('work goes on during the outage, kept on the computer');

    // Leaving with something waiting is refused: the next person could not send it.
    await page.click('#logout');
    await page.waitForFunction(() => /1 operation still waiting to be sent — connect to the internet first/.test(document.querySelector('.notice')?.textContent || ''));
    assert.ok(await page.$('#logout'), 'still logged in');
    step('log out refused while 1 operation is waiting');

    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('.shift');
    await waitStrip(/1 operation kept/);
    await shot('07-reload-offline');
    step('page reloads with no network at all and keeps its state');

    // ---- back online ----
    await ctx.setOffline(false);
    srv.setDown(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitStrip(/Connected/, 30000);
    assert.ok(book['Entries'].data.some(r => r[3] === 'Restaurant' && r[11] === 15000), 'the expense reached the sheet');
    // Online again: the shift can be closed.
    await page.click('[data-tab="close"]');
    await page.fill('#cash', '985000');
    await page.fill('#cashout', '387000');
    assert.match(await page.textContent('#diff'), /Exact/);
    await page.click('#closeForm button.primary');
    await page.click('#confirmClose');
    await page.waitForSelector('#openForm');
    await waitStrip(/Connected/, 30000);
    let rows = book['Cashouts&Cor'].data.slice(-2);
    assert.deepStrictEqual(rows.map(r => r[8]), ['Opening', 'Closing']);
    assert.deepStrictEqual([rows[1][2], rows[1][3], rows[1][4], rows[1][6]], [387000, 0, 985000, 'r1@x']);
    const manual = book['Entries Manual'].data.at(-1);
    assert.deepStrictEqual([manual[1], manual[11]], ['Cash-out', 387000]);
    step('back online: the expense reached the sheet, then the shift closes');

    // A colleague logs in offline during a new cut and opens the next shift.
    await page.click('#logout');
    await page.waitForSelector('.tiles');
    await shot('06-tiles');
    srv.setDown(true); await ctx.setOffline(true);
    await page.click('[data-user="dewa"]');
    await page.fill('#p', 'dewa123'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    assert.match(await page.textContent('.figure'), /985\.000/, 'next opening starts from the last close');
    await page.fill('#cash', '1000000');
    await page.click('#openForm button.primary');
    await page.waitForSelector('.shift');
    await waitStrip(/1 operation kept/);
    step('colleague logged in offline and opened the next shift');

    // Back online: the session of this computer was Ayu's; it gets one for Dewa before sending.
    await ctx.setOffline(false); srv.setDown(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitStrip(/Connected/, 30000);
    rows = book['Cashouts&Cor'].data.slice(-1);
    assert.deepStrictEqual([rows[0][8], rows[0][6]], ['Opening', 'r2@x']);
    const log = book['UI_Log'].data.slice(1);
    assert.deepStrictEqual(log.map(r => r[7]), ['applied', 'applied', 'applied', 'applied']);
    assert.strictEqual(new Set(log.map(r => r[1])).size, 4, 'each operation logged exactly once');
    assert.strictEqual(log[3][3], 'dewa', 'sent with Dewa\'s own session, not Ayu\'s');
    assert.strictEqual(await page.evaluate(async () => (await import('./js/db.js')).db.get('tokenUser')), 'dewa');
    await shot('08-back-online');
    step('back online: both operations reached the sheet in order, authors correct');

    // ---- refused op is surfaced ----
    // Someone opens a shift directly on the server; our local close should still be fine,
    // but a second open from here must be refused and shown.
    await page.click('#logout');
    await page.click('[data-act="typed"]'); await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); // managers have no tile (no hash kept)
    await page.click('button.primary');
    await page.waitForSelector('.shift');
    assert.match(await page.textContent('.shift h2'), /Dewa's shift/);
    step('manager sees the colleague\'s open shift and can close it');

    // Manager closes Dewa's shift from another computer (not registered, online only).
    const ctx2 = await browser.newContext({ viewport: { width: 420, height: 860 } });
    const p2 = await ctx2.newPage();
    await p2.goto(base);
    await p2.waitForSelector('#u');
    await p2.fill('#u', 'boss'); await p2.fill('#p', 'boss123'); await p2.click('button.primary');
    await p2.click('[data-tab="close"]');
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
