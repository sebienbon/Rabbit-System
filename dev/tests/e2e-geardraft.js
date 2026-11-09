// 09/11: a check half done was lost (connection lost, "back"). The picks now survive
// a reload offline, the menu and back, Android "back", and a new login; cleared once sent.
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const { start } = require('./dev-server');
const step = m => console.log('  ✓ ' + m);
(async () => {
  const srv = await start();
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const desk = await (await browser.newContext()).newPage();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  const errors = [];
  phone.on('pageerror', e => errors.push(e.message));
  const picked = () => phone.$$eval('.gacell.on', els => els.map(e => e.dataset.cell).sort());
  const log = () => srv.env.book['Gear_Log'].data.slice(1);
  try {
    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#openForm');
    await phone.goto(base + 'gear.html');
    await phone.fill('#u', 'made'); await phone.fill('#p', 'made123'); await phone.click('#lf button');
    await phone.waitForSelector('[data-go="count"]');
    await new Promise(r => setTimeout(r, 1500));

    await phone.click('[data-go="count"]');
    for (const id of ['SG001', 'SG002', 'SG003', 'B1442']) await phone.click(`[data-cell="${id}"]`);
    await ctx.setOffline(true);
    await phone.reload();
    await phone.waitForSelector('.gacell');
    assert.deepStrictEqual(await picked(), ['B1442', 'SG001', 'SG002', 'SG003']);
    assert.match(await phone.textContent('.notice'), /4 pilihan sebelumnya dipulihkan/);
    step('offline reload in the middle of Cek malam: back on Cek malam with the 4 picks');

    await phone.click('[data-cell="SG004"]');
    await phone.goBack(); // Android back
    await phone.waitForSelector('[data-go="count"]');
    assert.ok(phone.url().endsWith('gear.html'), phone.url());
    await phone.click('[data-go="count"]');
    await phone.waitForSelector('.gacell.on');
    assert.deepStrictEqual(await picked(), ['B1442', 'SG001', 'SG002', 'SG003', 'SG004']);
    step('"back" goes to the menu (the app stays open), Cek malam again: picks still there');

    await phone.click('[data-go="home"]'); await phone.waitForSelector('[data-go="ret"]');
    await phone.click('[data-go="ret"]');
    assert.deepStrictEqual(await picked(), [], 'Pengembalian has its own (empty) picks');
    await phone.click('[data-go="home"]'); await phone.click('[data-go="count"]');
    await phone.click('[data-next]');
    await phone.click('[data-problem="SG002"]'); await phone.click('[data-rc="SG002|Other"]');
    await phone.fill('[data-note="SG002"]', 'tali putus');
    await phone.reload();
    await phone.waitForSelector('.gacell');
    await phone.click('[data-next]');
    assert.strictEqual(await phone.inputValue('[data-note="SG002"]'), 'tali putus');
    step('the conditions and the comment survive too');

    await ctx.setOffline(false);
    await phone.click('[data-save="count"]'); await phone.click('[data-save="count"]');
    const until = async (f, w) => { const t = Date.now(); while (Date.now() - t < 30000) { if (await f()) return; await new Promise(r => setTimeout(r, 300)); } throw new Error('timeout ' + w); };
    await until(() => log().some(r => r[2] === 'count'), 'count sent');
    const cnt = JSON.parse(log().find(r => r[2] === 'count')[7]);
    assert.deepStrictEqual(cnt.items.map(x => x.item).sort(), ['B1442', 'SG001', 'SG002', 'SG003', 'SG004']);
    await phone.reload(); await phone.waitForSelector('[data-go="count"]');
    await phone.click('[data-go="count"]');
    await phone.click('[data-recount]').catch(() => {});
    assert.deepStrictEqual(await picked(), []);
    step('once sent, the draft is gone (the 5 numbers reached the sheet)');

    await phone.click('[data-go="home"]'); await phone.click('[data-go="ret"]'); await phone.click('[data-cell="SG009"]');
    await phone.click('[data-restart]');
    await phone.waitForSelector('[data-restart]', { state: 'detached' });
    assert.deepStrictEqual(await picked(), []);
    step('"Mulai dari awal" empties the picks');
    assert.deepStrictEqual(errors, []);
    console.log('\nE2E GEAR DRAFT OK');
  } catch (e) {
    console.error('E2E GEAR DRAFT FAILED:', e.message, errors);
    await phone.screenshot({ path: __dirname + '/shots/draft-fail.png' }).catch(() => {});
    process.exitCode = 1;
  } finally { await browser.close(); srv.server.close(); }
})();
