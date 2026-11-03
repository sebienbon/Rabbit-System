// End-to-end checks of the client fixes before going live: one local database per sheet,
// manager session not restored, no log out with operations waiting (desk and gear phone),
// refused / stuck operations with "Copy details", clock warning, late = evening checks,
// whole days on a rental, readable gear refusals at the desk.
// Run: node tests/e2e-fixes.js
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
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desk = await dctx.newPage();
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await pctx.newPage();
  const errors = [];
  for (const p of [desk, phone]) {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  }
  const book = srv.env.book;
  const until = async (fn, what, ms = 30000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await fn()) return; await new Promise(r => setTimeout(r, 300)); }
    throw new Error('timeout: ' + what);
  };
  const idle = p => until(async () => /Connected|Terhubung/.test(await p.textContent('#sync')) && !/Sending|Mengirim/.test(await p.textContent('#sync')), 'synced');
  const tab = async k => { await desk.click(`[data-tab="${k}"]`); await desk.waitForSelector(`[data-tab="${k}"][aria-selected="true"]`); };
  const call = (p, mod, fn, ...args) => p.evaluate(async ([m, f, a]) => (await import(m))[f](...a), [mod, fn, args]);
  const notice = (p, re) => p.waitForFunction(r => new RegExp(r).test(document.querySelector('.notice')?.textContent || ''), re.source, { timeout: 15000 });

  // Requests to the sheet can be rewritten here (stuck push, clock, gear state).
  let rewrite = null;
  await desk.route('**/api', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const r = rewrite && rewrite(body);
    if (!r) return route.continue();
    if (r.json) return route.fulfill({ json: r.json });
    try {
      const resp = await route.fetch();
      const j = await resp.json();
      r.patch(j);
      return await route.fulfill({ response: resp, json: j });
    } catch { return route.abort().catch(() => {}); } // a dropped connection: the app retries
  });

  try {
    // ---- C1: the local database carries the sheet address ----
    await desk.goto(base);
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#openForm');
    const name = await desk.evaluate(async () => (await import('./js/db.js')).DB_NAME);
    const hash = await desk.evaluate(async () => (await import('./js/db.js')).shortHash('/api'));
    assert.strictEqual(name, 'rabbit-reception-' + hash);
    const dbs = (await desk.evaluate(() => indexedDB.databases())).map(d => d.name);
    assert.ok(dbs.includes(name) && !dbs.includes('rabbit-reception'), dbs.join());
    step('reception database named after the sheet: ' + name);

    // ---- decision 2: a manager session is not restored when the app starts ----
    await desk.reload();
    await desk.waitForSelector('#loginForm');
    assert.match(await desk.textContent('#loginErr'), /password again/);
    assert.strictEqual(await desk.$('#openForm'), null);
    assert.strictEqual(await desk.evaluate(async () => (await import('./js/db.js')).db.get('currentUser')), undefined);
    // Only staff are kept for offline login (no manager tile, no manager hash).
    const users = await desk.evaluate(async () => (await import('./js/db.js')).db.get('users'));
    assert.deepStrictEqual(users.map(u => u.role).filter(r => r !== 'staff'), []);
    step('manager must type the password again after a restart; only staff hashes kept');

    await desk.click('[data-act="tiles"]');
    await desk.click('[data-user="ayu"]'); await desk.fill('#p', 'ayu123'); await desk.click('button.primary');
    await desk.fill('#cash', '1387750'); await desk.click('#openForm button.primary');
    await desk.waitForSelector('.sell');
    await idle(desk);

    // ---- C8: a mask rental counts whole days ----
    await desk.click('#guestIn'); await desk.keyboard.type('ali'); await desk.click('[data-sug="Alice Example"]');
    await desk.click('button.prod:has-text("Snorkeling Mask")');
    await desk.waitForSelector('[data-gearin="0"]');
    await desk.keyboard.type('sg001'); await desk.keyboard.press('Enter');
    await desk.waitForSelector('.chip:has-text("SG001")');
    await desk.click('[data-pay="Unpaid"]'); await desk.click('#recordSale');
    await idle(desk);
    await tab('shift');
    await desk.click('li.line:has-text("Snorkeling Mask") [data-edit]');
    await desk.fill('[data-editform] input[name=qty]', '1.5');
    await desk.click('[data-editform] button[type=submit]');
    await desk.waitForSelector('[data-editform] .error:has-text("whole number")');
    assert.match(await desk.textContent('[data-editform] label:has(input[name=qty])'), /Days/);
    await desk.click('[data-editform] [data-cancel]');
    step('rental line: days must be a whole number');

    // ---- decision 6: a number recorded out can still be sold (returned first, no extension) ----
    await tab('sell');
    await desk.click('#guestIn'); await desk.keyboard.type('Bob Sample'); await desk.click('[data-sug="Bob Sample"]');
    await desk.click('button.prod:has-text("Snorkeling Mask")');
    await desk.waitForSelector('[data-gearin="0"]');
    await desk.keyboard.type('sg001'); await desk.keyboard.press('Enter');
    await desk.waitForSelector('#saleErr:has-text("recorded out (Alice Example)")');
    await desk.waitForSelector('.chip:has-text("SG001")');
    await desk.click('[data-pay="Cash"]'); await desk.click('#recordSale');
    await tab('gear');
    await desk.waitForSelector('li.gout:has-text("SG001"):has-text("Bob Sample")');
    assert.strictEqual(await desk.$('li.gout:has-text("Alice Example")'), null);
    await idle(desk);
    step('SG001 recorded out to Alice, sold to Bob: it follows the new sale');

    // ---- decision 5: late = still out at an evening check after the return time ----
    const now = Date.now(), H = 3600000;
    rewrite = b => b.action === 'pull' && { patch: j => {
      const it = id => j.gear.items.find(i => i.id === id);
      Object.assign(it('SG005'), { where: 'out', back: new Date(now - 30 * H).toISOString(), last: { kind: 'rental', guest: 'Zed', from: new Date(now - 50 * H).toISOString(), saleTs: '1' } });
      Object.assign(it('SG006'), { where: 'out', back: new Date(now - 2 * H).toISOString(), last: { kind: 'rental', guest: 'Yan', from: new Date(now - 26 * H).toISOString(), saleTs: '2' } });
      j.gear.counts = [{ at: new Date(now - 26 * H).toISOString(), seen: ['SG002'] }]; // one check: after SG005's return time, before SG006's
    } };
    await call(desk, './js/sync.js', 'pullNow');
    await tab('gear');
    await desk.waitForSelector('li.gout:has-text("SG005")');
    assert.match(await desk.textContent('li.gout.late:has-text("SG005")'), /1 day extension/);
    assert.match(await desk.textContent('li.gout.overdue:has-text("SG006")'), /Overdue since .* no extension before the evening check/);
    assert.strictEqual(await desk.$('li.gout.late:has-text("SG006")'), null);
    await desk.click('[data-retin]'); await desk.keyboard.type('sg005'); await desk.keyboard.press('Enter');
    await desk.waitForSelector('.gearbox .chip:has-text("SG005")');
    await desk.click('[data-retin]'); await desk.keyboard.type('sg006'); await desk.keyboard.press('Enter');
    await desk.waitForSelector('.gearbox .chip:has-text("SG006")');
    await desk.waitForSelector('[data-retext="SG005"]:checked');
    assert.match(await desk.textContent('.gret:has-text("SG005")'), /late 1 day/);
    assert.strictEqual(await desk.$('[data-retext="SG006"]'), null, 'overdue without a check: no extension offered');
    await desk.screenshot({ path: `${shots}/f01-late-by-checks.png`, fullPage: true });
    await desk.click('[data-retrm="SG005"]'); await desk.click('[data-retrm="SG006"]');
    rewrite = null;
    await call(desk, './js/sync.js', 'pullNow');
    step('late only after an evening check (1 day), overdue shown without extension');

    // ---- C9 + C6: a gear refusal in words, with "Copy details" ----
    await dctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await call(desk, './js/sync.js', 'enqueue', 'sunset_out', { trip: 'Tdesk12345', items: ['SG004'] });
    await desk.waitForSelector('#attention li:has-text("Sunset Boat departure")', { timeout: 20000 });
    assert.match(await desk.textContent('#attention'), /Done by the gear staff/);
    await desk.click('#attention [data-copyop]');
    await until(async () => /Copied/.test(await desk.textContent('#attention [data-copyop]')) || !!(await desk.$('.copybox')), 'copied');
    const copied = await desk.evaluate(() => navigator.clipboard.readText().catch(() => document.querySelector('.copybox')?.value || ''));
    assert.match(copied, /Sunset Boat departure \(sunset_out\)/); assert.match(copied, /Refused: Done by the gear staff/);
    await desk.click('#attention [data-dismiss]');
    await until(async () => !(await desk.$('#attention')), 'dismissed');
    step('refused gear operation: readable label and reason, details copied, dismissed');

    // ---- C5: the sheet keeps failing on the same operation ----
    let partials = 0;
    rewrite = b => b.action === 'push' && (partials++, { json: { ok: true, results: [], partial: true, shift: { v: 0 } } });
    await call(desk, './js/sync.js', 'enqueue', 'expense', { ts: await desk.evaluate(async () => (await import('./js/ledger.js')).nextTs()), object: 'Restaurant', amount: 12000, payment: 'Cash', date: new Date(Date.now() + 8 * H).toISOString().slice(0, 10), comment: 'stuck test' });
    for (let i = 0; i < 6; i++) await call(desk, './js/sync.js', 'pushNow');
    await desk.evaluate(() => document.querySelector('[data-tab="sell"]').click());
    await desk.waitForSelector('#attention:has-text("Not going through")');
    assert.ok(partials >= 5);
    assert.match(await desk.textContent('#sync'), /1 needs attention/);
    rewrite = null;
    await call(desk, './js/sync.js', 'pushNow');
    await until(() => book['Entries'].data.some(r => r[16] === 'stuck test'), 'stuck op finally sent');
    await desk.evaluate(() => document.querySelector('[data-tab="sell"]').click());
    await until(async () => !(await desk.$('#attention')), 'attention cleared');
    step('5 temporary failures in a row: shown as "Not going through", kept and sent later');

    // ---- C6: clock warning ----
    rewrite = b => b.action === 'pull' && { patch: j => { j.serverTime = new Date(Date.now() + 30 * 60000).toISOString(); } };
    await call(desk, './js/sync.js', 'pullNow');
    await desk.reload(); // checked at start-up from the last pull
    await desk.waitForSelector('.sync .clockwarn');
    assert.match(await desk.textContent('.sync .clockwarn'), /30 min behind/);
    rewrite = null;
    await call(desk, './js/sync.js', 'pullNow');
    await until(async () => !(await desk.$('.sync .clockwarn')), 'clock warning gone');
    step('clock more than 10 min off the sheet: warned at start-up');

    // ---- C2 at the desk: no log out while something waits ----
    srv.setDown(true);
    await call(desk, './js/sync.js', 'enqueue', 'expense', { ts: await desk.evaluate(async () => (await import('./js/ledger.js')).nextTs()), object: 'Restaurant', amount: 13000, payment: 'Cash', date: new Date(Date.now() + 8 * H).toISOString().slice(0, 10), comment: 'wait test' });
    await desk.click('#logout');
    await notice(desk, /1 operation still waiting to be sent — connect to the internet first/);
    assert.ok(await desk.$('#logout'));
    srv.setDown(false);
    await desk.evaluate(() => window.dispatchEvent(new Event('online')));
    await idle(desk);
    await desk.click('#logout');
    await desk.waitForSelector('#loginForm');
    step('desk: log out refused while 1 operation waits, allowed once sent');

    // ---- gear phone: own database, refusals listed (C4), no log out while waiting (C2) ----
    await phone.goto(base + 'gear.html');
    await phone.fill('#u', 'made'); await phone.fill('#p', 'made123'); await phone.click('#lf button');
    await phone.waitForSelector('[data-go="sunset"]');
    assert.strictEqual(await phone.evaluate(async () => (await import('./js/db.js')).DB_NAME), 'rabbit-gear-' + hash);
    await call(phone, './js/sync.js', 'enqueue', 'gear_service', { sid: 'Rphone1234', item: 'SG001' });
    await phone.waitForSelector('#attention:has-text("Ditolak oleh sheet")', { timeout: 20000 });
    assert.match(await phone.textContent('#attention'), /tidak diizinkan|gear checks/);
    assert.ok(await phone.$('#attention [data-copyop]'));
    assert.match(await phone.textContent('#sync'), /1 perlu perhatian/);
    await phone.screenshot({ path: `${shots}/f02-phone-refused.png`, fullPage: true });
    await phone.click('#attention [data-dismiss]');
    await until(async () => !(await phone.$('#attention')), 'phone dismissed');
    step('gear phone: refused operation shown with its reason, then dismissed');

    srv.setDown(true);
    await call(phone, './js/sync.js', 'enqueue', 'gear_count', { cid: 'Kphone1234', items: [] });
    await phone.click('[data-logout]');
    await notice(phone, /1 catatan masih menunggu dikirim/);
    assert.ok(await phone.$('[data-logout]'));
    srv.setDown(false);
    await phone.evaluate(() => window.dispatchEvent(new Event('online')));
    await idle(phone);
    await phone.click('[data-logout]');
    await phone.waitForSelector('#lf');
    step('gear phone: log out refused while a check waits, allowed once sent');

    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E FIXES OK');
  } catch (e) {
    await desk.screenshot({ path: `${shots}/fz-failure-desk.png`, fullPage: true }).catch(() => {});
    await phone.screenshot({ path: `${shots}/fz-failure-phone.png`, fullPage: true }).catch(() => {});
    console.error('E2E FIXES FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
