// End-to-end TEMPORARY bar cash-out: Chrome + real server code on a fake sheet, with an Internet cut.
// Run: node tests/e2e-bar.js
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

    await tab('bar');
    await page.fill('#barAmount', '600000');
    await page.click('#barForm button[type=submit]');
    await page.waitForSelector('#barForm .inline.warn');
    await page.screenshot({ path: `${shots}/b01-bar.png`, fullPage: true });
    await page.click('#barForm button[type=submit]');
    await waitNotice(/Bar cash-out recorded: Rp 600\.000/);
    await waitStrip(/Connected/);
    const row = book['Entries Manual'].data.find(r => r[1] === 'BAR Cash-out');
    assert.deepStrictEqual([row[7], row[13], row[14]], [600000, 'Extern cash', 'r1@x']);
    assert.strictEqual(await figure(3), 'Rp 1.000.000');
    step('bar cash-out written in Entries Manual like the old sheet; reception box unchanged');
    assert.deepStrictEqual(errors, []);
    console.log('\nE2E BAR OK');
  } catch (e) {
    console.error('E2E BAR FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
