// End-to-end: Sell → Commissions (give a line to a colleague) and Sell → Edit tours & transport
// (add, change, rename, delete), against the real server code on a fake sheet. Also checks that
// with a server that does not announce these features (the one deployed before) nothing shows.
// Run: node tests/e2e-commissions.js
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
  // Phase 1: the server deployed today answers pull without `features`.
  let oldServer = true;
  await page.route('**/api', async route => {
    const resp = await route.fetch();
    let body = await resp.text();
    if (oldServer && JSON.parse(route.request().postData() || '{}').action === 'pull') {
      const j = JSON.parse(body); delete j.features; delete j.commissions; delete j.activities; body = JSON.stringify(j);
    }
    await route.fulfill({ response: resp, body });
  });
  const strip = () => page.textContent('#sync');
  const waitStrip = async (re, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await strip())) return; await page.waitForTimeout(250); } throw new Error('strip: ' + await strip()); };
  const waitNotice = re => page.waitForFunction(r => new RegExp(r).test(document.querySelector('.notice')?.textContent || ''), re.source, { timeout: 15000 });
  const sheet = name => srv.env.book[name].data;
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await page.waitForTimeout(250); } throw new Error('timeout'); };
  try {
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1387750'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);
    assert.strictEqual(await page.$$eval('[data-sellview]', x => x.length), 0);
    step('server without the features: no Commissions / Edit tours links, Sell as before');

    // A sale of a tour: Seller (T) = Ayu's email.
    await page.fill('#guestIn', 'Alice'); await page.click('[data-sug="Alice Example"]');
    await page.click('.prod:has-text("Horse Riding")');
    await page.click('[data-pay="Cash"]'); await page.click('#recordSale');
    await waitNotice(/Sale recorded/);
    await waitStrip(/Connected/);
    const sold = sheet('Entries').find(r => r[3] === '-Horse Riding' && r[12] === 'Alice Example');
    assert.strictEqual(sold[19], 'r1@x');

    // Phase 2: the owner redeployed the server.
    oldServer = false;
    await page.click('#refreshBtn'); await waitNotice(/Refreshed/);
    await page.waitForSelector('[data-sellview="comm"]');
    await page.screenshot({ path: shots + '/comm-0-sell-links.png' });
    step('redeployed server: two discreet links next to Products');

    await page.click('[data-sellview="comm"]');
    await page.waitForSelector('.clines');
    assert.match(await page.textContent('.commtotal'), /Rp 10\.000/);
    await page.click(`[data-give="${sold[14]}"]`);
    await page.selectOption('[data-giveto]', 'r2@x');
    await page.screenshot({ path: shots + '/comm-1-give.png' });
    await page.click('[data-giveok]');
    await waitNotice(/now goes to Dewa/);
    assert.match(await page.textContent('.extra'), /No commission line/);
    await until(() => sheet('Entries').find(r => r[14] === sold[14])[19] === 'r2@x');
    assert.strictEqual(sheet('Entries Manual').find(r => r[16] === sold[14])[17], 'r2@x');
    assert.ok(sheet('UI_Log').some(r => r[4] === 'seller_change' && r[7] === 'applied'));
    step('commissions: line given to Dewa; Entries T and Entries Manual R changed, logged');

    // Activities editor.
    await page.click('[data-sellback]');
    await page.click('[data-sellview="acts"]');
    await page.waitForSelector('.alist');
    await page.click('[data-actadd="Tour"]');
    await page.fill('[data-actform] input[name=name]', 'Waterfall Trip');
    await page.fill('[data-actform] input[name=price]', '450000');
    await page.fill('[data-actform] input[name=cost]', '300000');
    await page.click('[data-actform] button[type=submit]');
    await waitNotice(/Waterfall Trip added to Tour/);
    await until(() => sheet('Data activities').some(r => r[0] === '-Waterfall Trip'));
    const da = sheet('Data activities');
    const aRow = da.find(r => r[0] === '-Waterfall Trip');
    assert.deepStrictEqual(aRow.slice(0, 3), ['-Waterfall Trip', 450000, 300000]);
    assert.ok(da.some(r => r[13] === '-Waterfall Trip'), 'in the Tour list (N)');
    step('add: written to A..C and to the Tour list');

    await page.click('[data-actedit="Tour|-Horse Riding"]');
    await page.fill('[data-actform] input[name=price]', '420000');
    await page.screenshot({ path: shots + '/acts-1-edit.png' });
    await page.click('[data-actform] button[type=submit]');
    await waitNotice(/Horse Riding saved/);
    await until(() => da.find(r => r[0] === '-Horse Riding')[1] === 420000);
    await page.click('[data-actedit="Transport|-Shuttle Bangsal / Kuta"]');
    await page.fill('[data-actform] input[name=name]', 'Shuttle Bangsal / Kuta Lombok');
    await page.click('[data-actform] button[type=submit]');
    await waitNotice(/saved/);
    await until(() => da.some(r => r[0] === '-Shuttle Bangsal / Kuta Lombok') && da.some(r => r[12] === '-Shuttle Bangsal / Kuta Lombok'));
    assert.ok(!da.some(r => r[0] === '-Shuttle Bangsal / Kuta' || r[12] === '-Shuttle Bangsal / Kuta'));
    step('price change and rename (A and M)');

    await page.click('[data-actedit="Tour|-Snorkeling Trip"]');
    await page.click('[data-actdel]');
    await page.click('[data-actdelok]');
    await waitNotice(/Snorkeling Trip deleted/);
    await until(() => !da.some(r => r[0] === '-Snorkeling Trip' || r[13] === '-Snorkeling Trip'));
    step('delete: gone from A..C and from N');
    await waitStrip(/Connected/);
    await page.waitForTimeout(4500); // next pull
    await page.screenshot({ path: shots + '/acts-2-list.png' });

    await page.click('[data-tab="sell"]');
    const prods = await page.textContent('#prods');
    assert.ok(prods.includes('Waterfall Trip') && prods.includes('420.000') && prods.includes('Kuta Lombok') && !prods.includes('Snorkeling Trip'), prods);
    step('Sell shows the new catalog');

    // A manager sees everybody's commissions.
    await page.click('#logout');
    await page.click('[data-act="typed"]');
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.click('button.primary');
    await page.waitForSelector('.sell');
    await page.click('[data-sellview="comm"]');
    await page.waitForSelector('.commwho');
    assert.match(await page.textContent('.commwho'), /Dewa/);
    await page.screenshot({ path: shots + '/comm-2-manager.png' });
    step('manager: every seller, with totals');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-sellback]'); await page.click('[data-sellview="acts"]');
    await page.screenshot({ path: shots + '/acts-3-phone.png', fullPage: true });
    assert.deepStrictEqual(errors, []);
    console.log('E2E COMMISSIONS OK');
  } catch (e) { await page.screenshot({ path: shots + '/comm-fail.png', fullPage: true }); console.error(e); process.exitCode = 1; }
  finally { await browser.close(); srv.server.close(); }
})();
