// End-to-end: Internet cut, computer restarted, Internet back: Chrome + real server code on a fake sheet, with an Internet cut.
// Run: node tests/e2e-restart.js
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
    await page.click('#logout'); // the manager leaves: his session is revoked
    await page.waitForSelector('.tiles');

    // The Internet is cut. Ayu logs in on the reception computer (offline login) and works.
    await ctx.setOffline(true); srv.setDown(true);
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1387750'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await tab('expenses');
    await page.click('[data-item="Restaurant"]'); await page.keyboard.type('15000'); await page.click('[data-epay="Cash"]');
    await page.click('#expForm button[type=submit]');
    await waitNotice(/Expense recorded/);
    step('offline login and work during the cut');

    // The computer is switched off and on again, still without Internet: a fresh page load.
    const page2 = await ctx.newPage();
    page2.on('pageerror', e => errors.push(e.message));
    await page.close();
    await page2.goto(base);
    await page2.waitForSelector('.shift');
    assert.match(await page2.textContent('#sync'), /Offline/);
    assert.match(await page2.textContent('#sync'), /2 operations kept/);
    step('after the restart: the app opens without Internet, still logged in, 2 operations kept');

    // Internet back: the password typed before the restart is gone, so the sheet asks for it.
    await ctx.setOffline(false); srv.setDown(false);
    await page2.evaluate(() => window.dispatchEvent(new Event('online')));
    await page2.waitForSelector('#relog', { timeout: 40000 });
    assert.match(await page2.textContent('#sync'), /Login needed to send/);
    await page2.click('#relog');
    await page2.fill('#p', 'ayu123'); await page2.click('button.primary');
    await page2.waitForFunction(() => /Connected/.test(document.querySelector('#sync').textContent), null, { timeout: 40000 });
    assert.ok(book['Entries'].data.some(r => r[3] === 'Restaurant' && r[11] === 15000));
    assert.ok(book['UI_Shifts'].data.slice(1).some(r => r[10] === 'Open'));
    step('Internet back: "Log in again to send", password, everything reaches the sheet');

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E RESTART OK');
  } catch (e) {
    console.error('E2E RESTART FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
