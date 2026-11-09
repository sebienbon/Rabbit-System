// Reception guides: every screen, English and Bahasa Indonesia; nothing recorded, no error.
// Prints the steps shown in the middle (element not on the screen) so a wrong selector is seen.
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const fs = require('fs');
const { start } = require('./dev-server');
const shots = __dirname + '/shots/desk'; fs.mkdirSync(shots, { recursive: true });
(async () => {
  const srv = await start();
  const base = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const centred = {};
  const guide = async (name, lang) => {
    await p.click('#who [data-help]');
    await p.waitForSelector('.tour-menu');
    await p.click(`.tour-menu [data-m="${lang === 'en' ? 0 : 1}"]`);
    let n = 0;
    for (;;) {
      await p.waitForSelector('.tour-card:not(.busy) .tour-n'); await p.waitForTimeout(120);
      n++;
      const title = await p.textContent('.tour-title');
      if (!(await p.$eval('.tour-spot', s => !s.hidden)) && n > 1) (centred[name] = centred[name] || new Set()).add(title);
      if (n === 2) await p.screenshot({ path: `${shots}/${name}-${lang}.png` });
      const last = /Finish|Selesai/.test(await p.textContent('[data-tour="next"]'));
      await p.click('[data-tour="next"]');
      if (last) break;
    }
    await p.waitForSelector('.tour', { state: 'detached' });
    await p.waitForTimeout(700); // the refresh after the guide
    return n;
  };
  const both = async name => { const a = await guide(name, 'en'), b = await guide(name, 'id'); assert.strictEqual(a, b); console.log(`  ✓ ${name}: ${a} steps`); };
  const tab = async k => { await p.click(`[data-tab="${k}"]`); await p.waitForSelector(`[data-tab="${k}"][aria-selected="true"]`); await p.waitForTimeout(400); };
  try {
    await p.goto(base);
    await p.fill('#u', 'boss'); await p.fill('#p', 'boss123'); await p.check('#reg'); await p.click('button.primary'); await p.click('button.primary');
    await p.waitForSelector('#openForm');
    await both('open');
    await p.fill('#cash', '1387750'); await p.click('#openForm button.primary');
    await p.waitForSelector('[data-tab="sell"]');
    // A sale and an expense so "This shift" has lines.
    await p.click('#guestIn'); await p.keyboard.type('ali'); await p.click('[data-sug="Alice Example"]');
    await p.click('button.prod:has-text("Towel")'); await p.click('[data-pay="Cash"]'); await p.click('#recordSale');
    await p.waitForTimeout(800);
    const before = srv.env.book['UI_Log'] ? srv.env.book['UI_Log'].data.length : 0;
    await p.click('#guestIn'); await p.keyboard.type('ali'); await p.click('[data-sug="Alice Example"]'); await p.click('button.prod:has-text("Laundry")');
    await both('sell');
    await p.click('[data-sellview="comm"]'); await p.waitForTimeout(400); await both('sellcomm');
    await p.click('[data-sellback]'); await p.waitForTimeout(300);
    await p.click('[data-sellview="acts"]'); await p.waitForTimeout(400); await both('sellacts');
    await p.click('[data-sellback]'); await p.waitForTimeout(300);
    assert.ok(await p.$('#cart [data-rm]'), 'the cart is still there after the guides');
    await tab('bills'); await both('bills');
    await p.click('[data-open="Alice Example"]'); await p.waitForTimeout(500); await both('bill');
    for (const t of ['expenses', 'cash', 'partners']) { await tab(t); await both(t); }
    await p.click('[data-pobj^="-Horse"]'); await p.waitForTimeout(400); await both('partners+picked');
    for (const t of ['card', 'bar', 'gear', 'shift']) { await tab(t); await both(t); }
    await tab('close');
    await p.fill('#cash', '1500000'); await p.fill('#comment', 'typed before the guide');
    await both('close');
    assert.strictEqual(await p.inputValue('#cash'), '1.500.000', 'what was typed stays after the guide');
    assert.strictEqual(await p.inputValue('#comment'), 'typed before the guide'); await p.click('#closeForm button.primary'); await p.waitForSelector('#confirmClose');
    await both('closing');
    const after = srv.env.book['UI_Log'] ? srv.env.book['UI_Log'].data.length : 0;
    assert.strictEqual(after, before, 'nothing recorded by the guides');
    assert.ok(await p.$('#confirmClose'), 'still on the closing screen, nothing closed');
    assert.deepStrictEqual(errors, []);
    console.log('\nshown in the middle (element not on screen):');
    for (const [k, v] of Object.entries(centred)) console.log(`  ${k}: ${[...v].join(' | ')}`);
    console.log('\nE2E DESK GUIDES OK');
  } catch (e) {
    console.error('E2E DESK GUIDES FAILED:', e.message, errors);
    await p.screenshot({ path: `${shots}/fail.png` }).catch(() => {});
    process.exitCode = 1;
  } finally { await browser.close(); srv.server.close(); }
})();
