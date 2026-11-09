// The guided tour of the gear app: "?" → Mulai panduan → Lanjut to the end; nothing is recorded.
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');
const shots = __dirname + '/shots/tour'; fs.mkdirSync(shots, { recursive: true });
(async () => {
  const srv = await start();
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const desk = await (await browser.newContext()).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })).newPage();
  const errors = [];
  for (const p of [desk, phone]) { p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); }
  try {
    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#openForm');
    await phone.goto(base + 'gear.html');
    await phone.fill('#u', 'made'); await phone.fill('#p', 'made123'); await phone.click('#lf button');
    await phone.waitForSelector('[data-go="sunset"]');
    await new Promise(r => setTimeout(r, 1500));
    const before = srv.env.book['Gear_Log'].data.length;
    await phone.click('[data-help]');
    await phone.waitForSelector('.tour-menu');
    await phone.screenshot({ path: `${shots}/00-menu.png` });
    await phone.click('[data-m="start"]');
    let n = 0, total = 0;
    for (;;) {
      await phone.waitForSelector('.tour-card:not(.busy) .tour-n');
      await new Promise(r => setTimeout(r, 250));
      const t = await phone.textContent('.tour-n'); total = +t.split(' ').pop(); n++;
      const title = await phone.textContent('.tour-title');
      const spot = await phone.$eval('.tour-spot', s => !s.hidden);
      console.log(`  ${t}: ${title}${spot ? '' : '  (centre)'}`);
      await phone.screenshot({ path: `${shots}/${String(n).padStart(2, '0')}.png` });
      // a tap on the page under the tour does nothing
      if (n === 3) { await phone.mouse.click(8, 836); await new Promise(r => setTimeout(r, 300)); }
      const last = (await phone.textContent('[data-tour="next"]')) === 'Selesai';
      await phone.click('[data-tour="next"]');
      if (last) break;
    }
    assert.strictEqual(n, total);
    await phone.waitForSelector('.tour', { state: 'detached' });
    await phone.waitForSelector('[data-go="sunset"]');
    await new Promise(r => setTimeout(r, 1500));
    assert.strictEqual(srv.env.book['Gear_Log'].data.length, before, 'nothing recorded by the tour');
    assert.strictEqual(await phone.evaluate(async () => (await import('./js/sync.js')).waitingCount()), 0);
    assert.deepStrictEqual(errors, []);
    console.log(`\nE2E TOUR OK (${total} steps)`);
  } catch (e) {
    console.error('E2E TOUR FAILED:', e.message, errors);
    await phone.screenshot({ path: `${shots}/fail.png` }).catch(() => {});
    process.exitCode = 1;
  } finally { await browser.close(); srv.server.close(); }
})();
