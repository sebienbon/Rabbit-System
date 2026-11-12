// End-to-end (owner 12/11): Guest bills › Split on an unpaid line, then each part paid its own way.
// Run: node dev/tests/e2e-linesplit.js
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
  const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] } : {});
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const strip = () => page.textContent('#sync');
  const waitStrip = async (re, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await strip())) return; await page.waitForTimeout(250); } throw new Error('strip: ' + await strip()); };
  try {
    await page.goto(base);
    await page.fill('#u', 'boss'); await page.fill('#p', 'boss123'); await page.check('#reg'); await page.click('button.primary'); await page.click('button.primary');
    await page.waitForSelector('#openForm');
    await page.click('#logout');
    await page.click('[data-user="ayu"]'); await page.fill('#p', 'ayu123'); await page.click('button.primary');
    await page.fill('#cash', '1387750'); await page.click('#openForm button.primary');
    await page.waitForSelector('.sell');
    await waitStrip(/Connected/);
    await page.click('[data-tab="bills"]');
    await page.click('[data-open="Alice Example"]');
    page.once('dialog', d => d.accept('20000'));
    await page.click('[data-lsplit]');
    await page.waitForFunction(() => /Line split/.test(document.querySelector('.notice')?.textContent || ''));
    await page.screenshot({ path: shots + '/linesplit-1.png' });
    const amts = await page.$$eval('#payForm .lines .amt', e => e.map(x => x.textContent.trim()));
    assert.strictEqual(amts.length, 2, amts.join(','));
    step('the line is split in two on screen at once: ' + amts.join(' + '));
    await waitStrip(/Connected/);
    const rows = srv.env.book['Entries'].data.filter(r => r[12] === 'Alice Example' && r[13] === 'Unpaid');
    assert.deepStrictEqual(rows.map(r => r[7]).sort((a, b) => a - b), [20000, 40000]);
    step('two unpaid lines in Entries');
    assert.deepStrictEqual(errors, []);
    console.log('OK');
  } catch (e) { await page.screenshot({ path: shots + '/linesplit-fail.png', fullPage: true }); console.error(e); process.exitCode = 1; }
  finally { await browser.close(); srv.server.close(); }
})();
