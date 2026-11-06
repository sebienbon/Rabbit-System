// A manager stays logged in after a reload on his own device; on the reception computer the password is asked again.
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
const assert = require('assert');
const { start } = require('./dev-server');
(async () => {
  const srv = await start();
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const base = `http://localhost:${srv.port}/`;
  try {
    // own phone: not registered
    const phone = await (await browser.newContext()).newPage();
    await phone.goto(base);
    await phone.fill('#u', 'boss'); await phone.fill('#p', 'boss123'); await phone.click('button.primary');
    await phone.waitForSelector('#logout');
    await phone.reload();
    await phone.waitForSelector('#logout', { timeout: 15000 });
    assert.ok(!(await phone.$('#loginForm')), 'still logged in on own device');
    console.log('  ✓ manager kept after reload on his own device');
    // reception computer: registered
    const desk = await (await browser.newContext()).newPage();
    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#logout');
    await desk.reload();
    await desk.waitForSelector('#loginForm', { timeout: 15000 });
    console.log('  ✓ password asked again on the reception computer');
    console.log('OK');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { await browser.close(); srv.server.close(); }
})();
