// 12/11: "No bike in stock" while the bikes were in the box, marked broken at the evening check.
// Sell now says which ones and why, and the desk can put a repaired one back and rent it at once.
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const { start } = require('./dev-server');
const step = m => console.log('  ✓ ' + m);
(async () => {
  const srv = await start();
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  const errors = [];
  for (const p of [desk, phone]) p.on('pageerror', e => errors.push(e.message));
  const log = () => srv.env.book['Gear_Log'].data.slice(1);
  const until = async (f, w) => { const t = Date.now(); while (Date.now() - t < 30000) { if (await f()) return; await new Promise(r => setTimeout(r, 300)); } throw new Error('timeout ' + w); };
  try {
    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.fill('#cash', '1387750'); await desk.click('#openForm button.primary');
    await desk.waitForSelector('.sell');
    // Evening check: both bikes in the box, both broken.
    await phone.goto(base + 'gear.html');
    await phone.fill('#u', 'made'); await phone.fill('#p', 'made123'); await phone.click('#lf button');
    await phone.click('[data-go="count"]'); await phone.waitForSelector('[data-cell="B1442"]');
    for (const id of await phone.$$eval('[data-cell]', els => els.map(e => e.dataset.cell))) await phone.click(`[data-cell="${id}"]`);
    await phone.click('[data-next]');
    for (const [id, note] of [['B1442', 'rem bolong'], ['B1443', 'kurang angin']]) {
      await phone.click(`[data-problem="${id}"]`); await phone.click(`[data-rc="${id}|Broken"]`); await phone.fill(`[data-note="${id}"]`, note);
    }
    await phone.click('[data-save="count"]'); await phone.click('[data-save="count"]');
    await until(() => log().filter(r => r[2] === 'damage').length === 2, 'damages logged');
    step('evening check: B1442 and B1443 broken');

    await desk.click('#refreshBtn'); await desk.waitForTimeout(2500);
    await desk.click('#guestIn'); await desk.keyboard.type('ali'); await desk.click('[data-sug="Alice Example"]');
    const bikeBtn = await desk.$('button.prod:has-text("Rabbit bike")') || await desk.$('button.prod:has-text("Bike")');
    await bikeBtn.click();
    await desk.waitForSelector('.gbroken');
    const txt = await desk.textContent('[data-gearsug="0"]');
    assert.match(txt, /No bike ready to rent/); assert.match(txt, /2 bikes out of service/);
    assert.match(txt, /B1442\s*Broken “rem bolong”/); assert.match(txt, /B1443\s*Broken “kurang angin”/);
    await desk.screenshot({ path: __dirname + '/shots/gearfix-sell.png' });
    step('Sell says which bikes and why, instead of "No bike in stock"');

    await desk.click('[data-gearfix="0:B1442"]');
    await desk.waitForSelector('.chip:has-text("B1442")');
    await desk.click('[data-pay="Cash"]'); await desk.click('#recordSale');
    await until(() => log().some(r => r[2] === 'service' && r[3] === 'B1442') && log().some(r => r[2] === 'out' && r[3] === 'B1442'), 'service + out');
    assert.ok(log().findIndex(r => r[2] === 'service' && r[3] === 'B1442') < log().findIndex(r => r[2] === 'out' && r[3] === 'B1442'));
    step('"Repaired · rent it": back in stock, then rented in the same sale');

    // The other one is still out of service and still to decide in Gear, where it can be repaired too.
    await desk.click('[data-tab="gear"]'); await desk.waitForTimeout(800);
    assert.ok(await desk.$('.gdiff:has-text("B1443") [data-gservice="B1443"]'), 'Repaired button on a damage still to decide');
    step('Gear: "Repaired · back in stock" also on a damage still to decide');
    // 12/11 (2): "Kondisi barang" in the gear app — B1443 repaired by the gear staff, SG003 broken.
    await phone.click('[data-go="home"]').catch(() => {});
    await phone.waitForSelector('[data-go="status"]');
    await phone.click('[data-go="status"]');
    await phone.waitForSelector('[data-stfix="B1443"]');
    assert.match(await phone.textContent('.gabody'), /B1443\s*Rusak\s*“kurang angin”/);
    await phone.click('[data-stfix="B1443"]');
    await until(() => log().some(r => r[2] === 'service' && r[3] === 'B1443'), 'repaired from the gear app');
    await phone.click('[data-stcell="SG003"]'); await phone.click('[data-stc="Ring missing"]'); await phone.fill('[data-stnote]', 'ring hilang di pantai');
    await phone.screenshot({ path: __dirname + '/shots/gearfix-status-phone.png' });
    await phone.click('[data-stsave]');
    await until(() => log().some(r => r[2] === 'damage' && r[3] === 'SG003' && /status/.test(r[7])), 'SG003 broken from the gear app');
    assert.ok(!log().some(r => r[2] === 'diff' && (r[3] === 'B1443' || r[3] === 'SG003')), 'no difference created');
    step('gear app "Kondisi barang": repaired → back in stock, broken → out of service, no difference');

    // Reception: the Status card shows SG003 with its note; change SG004 by hand, then repair SG003.
    await desk.click('#refreshBtn'); await desk.waitForTimeout(2500);
    await desk.click('[data-tab="gear"]'); await desk.waitForSelector('[data-gst="SG004"]');
    assert.match(await desk.textContent('.gcard:has(h2:text-matches("Status of masks"))'), /SG003\s*Ring missing\s*“ring hilang di pantai”/);
    assert.ok(!(await desk.$('.gcard:has(h2:text("Damage to decide")) [data-gservice="SG003"]')), 'a status change is not a damage to decide');
    await desk.click('[data-gst="SG004"]'); await desk.click('[data-gstc="Broken"]'); await desk.fill('[data-gstnote]', 'kaca retak');
    await desk.screenshot({ path: __dirname + '/shots/gearfix-status-desk.png', fullPage: true });
    await desk.click('[data-gstsave]');
    await until(() => log().some(r => r[2] === 'damage' && r[3] === 'SG004'), 'SG004 from the desk');
    await desk.waitForSelector('.gcard [data-gservice="SG003"]');
    await desk.click('.gcard [data-gservice="SG003"]');
    await until(() => log().some(r => r[2] === 'service' && r[3] === 'SG003'), 'SG003 repaired at the desk');
    step('reception "Status of masks & bikes": broken by hand, repaired by hand');
    assert.deepStrictEqual(errors, []);
    console.log('\nE2E GEAR FIX OK');
  } catch (e) {
    console.error('E2E GEAR FIX FAILED:', e.message, errors);
    await desk.screenshot({ path: __dirname + '/shots/gearfix-fail.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally { await browser.close(); srv.server.close(); }
})();
