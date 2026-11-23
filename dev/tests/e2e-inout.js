// End-to-end (owner 24/11): In / Out in the Check-in tab. The desk sees who leaves and who arrives today,
// taps Out and In, undoes one; the lines land in CI_Moves and the Staff App feed follows.
// Run: node dev/tests/e2e-inout.js
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');

const shots = __dirname + '/shots';
fs.mkdirSync(shots, { recursive: true });
const step = m => console.log('  ✓ ' + m);
const ymd = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const T = ymd(Date.now()), Y = ymd(Date.now() - 86400000), TM = ymd(Date.now() + 86400000);

(async () => {
  const srv = await start();
  srv.env.ctx.CI_setup();
  const arr = [{ bookId: '96026082', name: 'Giulia Varcasia', room: 'Twin Room', arrival: T, departure: TM, guests: 2, channel: 'Booking.com' }];
  srv.env.ctx.B24 = { arrivals: () => arr, units: () => [], house: () => [
    { bookId: '96026082', name: 'Giulia Varcasia', room: 'Twin Room', roomId: '460594', unitId: '1', kind: 'arrival', arrival: T, departure: TM, guests: 2 },
    { bookId: '95817014', name: 'Sophie James', room: 'Tree House', roomId: '460595', unitId: '2', kind: 'departure', arrival: Y, departure: T, guests: 1 },
    { bookId: '95811650', name: 'Calum Hull-Flower', room: 'Double inside building', roomId: '353330', unitId: '1', kind: 'departure', arrival: Y, departure: T, guests: 2 },
  ] };
  srv.env.ctx.HK_setup();
  srv.env.book['Units'].appendRow(['353330', '1', 'Double inside building', '1', 'Passion', '']);
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] } : {});
  const errors = [];
  try {
    for (const [w, h, tag] of [[1280, 900, 'pc'], [390, 844, 'phone']]) {
      const desk = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
      desk.on('pageerror', e => errors.push(tag + ': ' + e.message));
      desk.on('dialog', d => d.accept());
      await desk.goto(base);
      if (tag === 'pc') {
        await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
        await desk.waitForSelector('#openForm');
        await desk.click('#logout');
        await desk.click('[data-user="ayu"]'); await desk.fill('#p', 'ayu123'); await desk.click('button.primary');
        await desk.fill('#cash', '1387750'); await desk.click('#openForm button.primary');
        await desk.waitForSelector('.sell');
        await desk.click('[data-tab="checkin"]');
        await desk.waitForSelector('text=Leaving today');
        assert.strictEqual(await desk.locator('[data-hk="out"]').count(), 2);
        assert.strictEqual(await desk.locator('[data-hk="in"]').count(), 1);
        await desk.waitForSelector('text=Passion');
        step('Check-in tab: 2 guests leaving (one in Passion), 1 arriving, each with its button');
        await desk.click('[data-hk="out"][data-id="95817014"]');
        await desk.waitForSelector('text=✓ Out');
        await desk.click('[data-hk="in"][data-id="96026082"]');
        await desk.waitForSelector('text=✓ In');
        await desk.screenshot({ path: shots + '/inout-pc.png' });
        assert.deepStrictEqual(srv.env.book['CI_Moves'].data.slice(1).map(r => [r[1], r[2], r[6]]), [['out', '95817014', 'Ayu'], ['in', '96026082', 'Ayu']]);
        step('Out and In written in CI_Moves with who tapped');
        const f = srv.env.call({ action: 'hk_moves', key: srv.env.props.HK_FEED_KEY, date: T });
        assert.deepStrictEqual(f.departures.map(d => [d.guest, d.status === 'checked_out']), [['Sophie James', true], ['Calum Hull-Flower', false]]);
        assert.strictEqual(f.arrivals[0].status, 'checked_in');
        step('the Staff App feed says Sophie is out and Giulia is in');
        await desk.click('[data-hk="out"][data-undo]');
        await desk.waitForFunction(() => document.querySelectorAll('[data-hk="out"]:not([data-undo])').length === 2);
        step('Undo puts the Out button back');
        assert.ok(await desk.locator('[data-book="96026082"]').count(), 'Start check-in still there');
      } else {
        await desk.screenshot({ path: shots + '/inout-phone.png' });
      }
      await desk.context().close();
    }
    assert.deepStrictEqual(errors, []);
    console.log('IN / OUT OK');
  } catch (e) { console.error('FAILED:', e.message, errors); process.exitCode = 1; }
  await browser.close();
  srv.server.close();
})();
