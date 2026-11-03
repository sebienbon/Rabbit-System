// End-to-end: no session hand-over while operations wait (desk and gear phone), each person's
// operations sent with their own session (a session is never revoked while its owner still has
// some waiting), a manager session left behind revoked once sent, operations of a previous
// connection shown but never sent, the server's time budget retried at once.
// Run: node tests/e2e-handover.js
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
  const book = srv.env.book, props = srv.env.props;
  const log = () => book['UI_Log'].data.slice(1);
  const until = async (fn, what, ms = 30000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { if (await fn()) return; await new Promise(r => setTimeout(r, 200)); }
    throw new Error('timeout: ' + what);
  };
  const idle = p => until(async () => /Connected|Terhubung/.test(await p.textContent('#sync')) && !/Sending|Mengirim/.test(await p.textContent('#sync')), 'synced');
  const kv = (p, k) => p.evaluate(async key => (await import('./js/db.js')).db.get(key), k);
  const outbox = p => p.evaluate(async () => (await import('./js/db.js')).db.all('outbox'));
  const session = token => !!props['UIS_' + token];
  const tryLogin = (p, u, pw, gearApp = false) => p.evaluate(async ([u, pw, g]) => {
    try { await (await import('./js/auth.js')).login(u, pw, { gearApp: g }); return 'ok'; } catch (e) { return e.code + ': ' + e.message; }
  }, [u, pw, gearApp]);

  // Pushes can be held back (as if the Internet dropped just for them) or answered by hand.
  let holdPush = false, fakePush = null;
  const route = async r => {
    const body = JSON.parse(r.request().postData() || '{}');
    if (body.action === 'push' && holdPush) return r.abort().catch(() => {});
    if (body.action === 'push' && fakePush) { const j = fakePush(body); fakePush = null; return r.fulfill({ json: j }); }
    return r.continue();
  };
  await desk.route('**/api', route);
  await phone.route('**/api', route);

  try {
    // ---- C1: what waits in the database of a previous connection is shown, never sent ----
    await desk.goto(base + 'icon-192.png'); // same origin, without the app running
    await desk.evaluate(() => new Promise((res, rej) => {
      const req = indexedDB.open('rabbit-reception', 2); // the database from before it was tied to the sheet
      req.onupgradeneeded = () => { req.result.createObjectStore('kv'); req.result.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); };
      req.onsuccess = () => {
        const t = req.result.transaction('outbox', 'readwrite');
        t.objectStore('outbox').put({ id: 'OLD-op-1', type: 'expense', at: '2026-11-01T03:00:00.000Z', by: 'ayu', author: 'ayu', payload: { object: 'Restaurant', amount: 12000, payment: 'Cash' } });
        t.oncomplete = () => { req.result.close(); res(); }; t.onerror = () => rej(t.error);
      };
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('blocked'));
    }));
    await desk.goto(base);
    await desk.waitForSelector('.oldoutbox');
    assert.match(await desk.textContent('.oldoutbox h2'), /1 operation from a previous connection was not sent/);
    assert.match(await desk.textContent('.oldoutbox'), /Expense/);
    await desk.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__copied = t; } } }));
    await desk.click('[data-oldcopy]');
    await until(async () => /Copied/.test(await desk.textContent('[data-oldcopy]')), 'details copied');
    assert.match(await desk.evaluate(() => window.__copied), /Expense \(expense\)[\s\S]*amount: 12000[\s\S]*Id: OLD-op-1/);
    await desk.screenshot({ path: `${shots}/h01-old-outbox.png`, fullPage: true });
    await desk.click('[data-oldok]');
    await desk.waitForSelector('.oldoutbox', { state: 'detached', timeout: 5000 }); // removed once "seen" is saved
    await desk.reload();
    await desk.waitForSelector('#loginForm');
    await desk.waitForTimeout(500);
    assert.ok(!(await desk.$('.oldoutbox')), 'not shown again once acknowledged');
    step('operations of a previous connection: blocking message with "Copy details", never sent');

    // ---- the reception computer, Ayu's shift ----
    await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.check('#reg'); await desk.click('button.primary'); await desk.click('button.primary');
    await desk.waitForSelector('#openForm');
    await desk.click('#logout');
    await desk.click('[data-user="ayu"]'); await desk.fill('#p', 'ayu123'); await desk.click('button.primary');
    await desk.fill('#cash', '1387750'); await desk.click('#openForm button.primary');
    await desk.waitForSelector('.sell');
    await idle(desk);
    const ayuToken = await kv(desk, 'deviceToken');
    assert.ok(session(ayuToken));

    // ---- no hand-over: Ayu has an operation waiting, nobody else can log in ----
    holdPush = true;
    await desk.click('[data-tab="expenses"]');
    await desk.click('[data-item="Restaurant"]'); await desk.keyboard.type('15000'); await desk.click('[data-epay="Cash"]');
    await desk.click('#expForm button[type=submit]');
    await until(async () => (await outbox(desk)).length === 1, 'expense waiting');
    // Session ended (as after "Log in again"): the login screen is Ayu's only.
    await desk.evaluate(async () => (await import('./js/auth.js')).logout({ username: 'ayu', role: 'staff' }));
    await desk.reload();
    await desk.waitForSelector('#loginForm');
    assert.strictEqual(await desk.getAttribute('#u', 'value'), 'ayu');
    assert.match(await desk.textContent('.waitowner'), /1 operation of Ayu still waiting to be sent: only Ayu can log in/);
    assert.ok(!(await desk.$('[data-act="tiles"]')), 'no "Not Ayu?"');
    assert.ok(!(await desk.$('[data-act="typed"]')), 'no "Someone else"');
    assert.match(await tryLogin(desk, 'dewa', 'dewa123'), /^outbox_waiting: 1 operation of ayu still waiting/);
    assert.match(await tryLogin(desk, 'boss', 'boss123'), /^outbox_waiting/);
    assert.strictEqual(await kv(desk, 'deviceToken'), ayuToken, 'Ayu\'s session untouched');
    await desk.screenshot({ path: `${shots}/h02-only-owner.png`, fullPage: true });
    step('operations waiting: only their author can log in (desk), other names refused');

    // ---- an older queue with two people (from before the rule): each sent with their own session ----
    await desk.evaluate(async () => {
      const { db } = await import('./js/db.js');
      await db.put('outbox', { id: 'Dx-legacy-dewa', type: 'sale', at: new Date().toISOString(), by: 'dewa', author: 'r2@x',
        payload: { saleId: 'Lg1', payment: 'Cash', lines: [{ ts: '20261103120000123', guest: 'Bob Sample', category: 'Service', object: 'Towel', qty: 1, unit: 50000 }] } });
    });
    assert.strictEqual(await tryLogin(desk, 'dewa', 'dewa123'), 'ok', 'Dewa has operations waiting too: he may log in');
    const dewaToken = await kv(desk, 'deviceToken');
    assert.notStrictEqual(dewaToken, ayuToken);
    assert.deepStrictEqual(await kv(desk, 'heldTokens'), { ayu: ayuToken }, 'Ayu\'s session kept aside, not revoked');
    assert.ok(session(ayuToken), 'still valid on the sheet');
    holdPush = false;
    await desk.reload();
    await until(async () => !(await outbox(desk)).length, 'both sent');
    const mine = log().filter(r => r[4] === 'expense' || r[1] === 'Dx-legacy-dewa');
    assert.deepStrictEqual(mine.map(r => [r[4], r[3], r[7]]), [['expense', 'ayu', 'applied'], ['sale', 'dewa', 'applied']], 'in order, each with its own session');
    await until(async () => !session(ayuToken), 'Ayu\'s session revoked once her operations are in');
    assert.deepStrictEqual(await kv(desk, 'heldTokens'), {});
    assert.ok(session(dewaToken));
    step('a session is never replaced while its owner has operations waiting; revoked once they are sent');

    // ---- a manager's session left behind is revoked once what it waits for is sent ----
    await idle(desk);
    await desk.click('#logout');
    await desk.click('[data-act="typed"]'); await desk.fill('#u', 'boss'); await desk.fill('#p', 'boss123'); await desk.click('button.primary');
    await desk.waitForSelector('.shift');
    await idle(desk);
    const bossToken = await kv(desk, 'deviceToken');
    holdPush = true;
    await desk.click('[data-tab="expenses"]');
    await desk.click('[data-item="Restaurant"]'); await desk.keyboard.type('7000'); await desk.click('[data-epay="Cash"]');
    await desk.click('#expForm button[type=submit]');
    await until(async () => (await outbox(desk)).length === 1, 'manager expense waiting');
    await desk.reload(); // app restarted: a manager is never restored
    await desk.waitForSelector('#loginForm');
    assert.strictEqual(await kv(desk, 'currentUser'), undefined);
    assert.strictEqual(await kv(desk, 'deviceToken'), bossToken, 'kept to send what is waiting');
    assert.strictEqual(await desk.getAttribute('#u', 'value'), 'boss');
    assert.match(await tryLogin(desk, 'ayu', 'ayu123'), /^outbox_waiting/);
    holdPush = false;
    await until(() => log().some(r => r[4] === 'expense' && r[3] === 'boss' && r[7] === 'applied'), 'sent with the manager session');
    await until(async () => !session(bossToken) && !(await kv(desk, 'deviceToken')), 'manager session revoked');
    step('manager not restored; his waiting operation sent with his session, then the session revoked');

    // ---- a manager's session left on the computer (nobody logged in, nothing waiting): revoked at start ----
    const left = await desk.evaluate(async () => {
      const { api } = await import('./js/api.js'), { db } = await import('./js/db.js');
      const r = await api('login', { username: 'boss', password: 'boss123', deviceId: await db.get('deviceId'), deviceSecret: await db.get('deviceSecret') });
      await db.batch([['kv', 'put', r.token, 'deviceToken'], ['kv', 'put', 'boss', 'tokenUser'], ['kv', 'put', 'manager', 'tokenRole'], ['kv', 'delete', 'currentUser']]);
      return r.token;
    });
    assert.ok(session(left));
    await desk.reload();
    await desk.waitForSelector('#loginForm');
    await until(async () => !session(left) && !(await kv(desk, 'deviceToken')), 'left-behind manager session revoked at start');
    step('a manager session left behind with an empty outbox is revoked when the app starts');

    // ---- the sheet's 18 s budget: what is left goes at once, not counted as a failure ----
    await desk.reload();
    await desk.waitForSelector('.tiles');
    await desk.click('[data-user="ayu"]'); await desk.fill('#p', 'ayu123'); await desk.click('button.primary');
    await desk.waitForSelector('.shift');
    await idle(desk);
    let budgetSeen = 0;
    fakePush = () => { budgetSeen = Date.now(); return { ok: true, results: [], partial: true, budget: true }; };
    const states = [];
    await desk.exposeFunction('noteState', s => states.push(s));
    await desk.evaluate(async () => (await import('./js/sync.js')).onStatus(s => window.noteState(s.state)));
    await desk.click('[data-tab="expenses"]');
    await desk.click('[data-item="Restaurant"]'); await desk.keyboard.type('3000'); await desk.click('[data-epay="Cash"]');
    await desk.click('#expForm button[type=submit]');
    await until(() => log().some(r => r[4] === 'expense' && r[9].includes('3000')), 'sent after the budget answer', 15000);
    const took = Date.now() - budgetSeen;
    assert.ok(budgetSeen && took < 4000, 'sent again at once, took ' + took + ' ms');
    assert.ok(!states.includes('error') && !states.includes('offline'), states.join());
    assert.strictEqual(await kv(desk, 'stuck'), undefined);
    step('budget answer: the rest is sent at once, no failure, no delay');

    // ---- gear phone: no hand-over either ----
    await phone.goto(base + 'gear.html');
    await phone.fill('#u', 'made'); await phone.fill('#p', 'made123'); await phone.click('#lf button');
    await phone.waitForSelector('[data-go="sunset"]');
    await idle(phone);
    holdPush = true;
    await phone.evaluate(async () => (await import('./js/sync.js')).enqueue('gear_count', { cid: 'Khandover1', items: [] }));
    await phone.evaluate(async () => (await import('./js/auth.js')).logout({ username: 'made', role: 'gear' }));
    await phone.reload();
    await phone.waitForSelector('#lf');
    assert.strictEqual(await phone.getAttribute('#u', 'value'), 'made');
    assert.notStrictEqual(await phone.getAttribute('#u', 'readonly'), null);
    assert.match(await phone.textContent('.waitowner'), /1 catatan dari made masih menunggu/);
    assert.match(await tryLogin(phone, 'ayu', 'ayu123', true), /^outbox_waiting/);
    // A sync in the background redraws the login screen: the password being typed stays.
    await phone.fill('#p', 'made123');
    await phone.evaluate(() => { document.querySelector('#lf').dataset.old = '1'; });
    await phone.evaluate(async () => (await import('./js/sync.js')).pullNow());
    await until(async () => !(await phone.$('#lf[data-old]')), 'login screen redrawn after the pull');
    assert.strictEqual(await phone.inputValue('#p'), 'made123', 'typed password kept across the redraw');
    holdPush = false;
    await phone.click('#lf button');
    await phone.waitForSelector('[data-go="sunset"]');
    await until(() => log().some(r => r[4] === 'gear_count' && r[3] === 'made' && r[7] === 'applied'), 'check sent');
    step('gear phone: only the author of the waiting notes can log in ("Masuk lagi" included); a background redraw keeps the typed password');

    assert.ok(!log().some(r => r[1] === 'OLD-op-1'), 'the old connection\'s operation was never sent');
    assert.deepStrictEqual(errors, []);
    step('no errors in the browser console');
    console.log('\nE2E HANDOVER OK');
  } catch (e) {
    await desk.screenshot({ path: `${shots}/hz-failure.png`, fullPage: true }).catch(() => {});
    await phone.screenshot({ path: `${shots}/hz-failure-phone.png`, fullPage: true }).catch(() => {});
    console.error('phone:', (await phone.textContent('main').catch(() => '')).slice(0, 400), (await phone.textContent('#sync').catch(() => '')));
    console.error('E2E HANDOVER FAILED:', e.message, '\nconsole errors:', errors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    srv.server.close();
  }
})();
