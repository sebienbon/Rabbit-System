// Serves the app and answers /api with the REAL 30.UI_api.gs running on a fake sheet.
// GET /__net?down=1 simulates an Internet outage for /api.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makeEnv } = require('./gas-shim');

function seedEnv() {
  const manual = [['', 'Category', 'Sub-category', 'object'], ['01/11/2026', 'Income', 'Service', 'Bar']];
  const env = makeEnv({ sheets: {
    'Cashouts&Cor': [['Column 1', 'Time ', 'Cashout', 'Difference', 'Cash in box', 'Change suply', 'Author', 'Comment', 'Type'],
      ['01/11/2026', '15:00:08', 0, 0, 1387750, '', 'r1@x', '', 'Closing']],
    'Entries Manual': manual,
    'Data activities': [
      ['Activity', 'Selling Price', 'Purchase prices', '', '', '', '', '', 'Category', 'Sub-category - Income', 'Staff', 'Service', 'Transport', 'Tour', 'Other', 'Paid', 'Payment type'],
      ['Towel', '50,000Rp', '', '', '', '', '', '', '', '', '', 'Towel', '-Shuttle Bangsal / Kuta', '-Horse Riding', 'Restaurant', '', 'Cash'],
      ['Laundry', '30,000Rp', '', '', '', '', '', '', '', '', '', 'Laundry', '', '-Snorkeling Trip', 'other', '', 'Credit / Debit Card'],
      ['Bar', '', '', '', '', '', '', '', '', '', '', 'Bar', '', '', '', '', 'Transfer/Others'],
      ['-Horse Riding', '400,000Rp', '350,000Rp', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Unpaid'],
      ['-Shuttle Bangsal / Kuta', '160,000Rp', '90,000Rp', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Paid to Partner'],
      ['-Snorkeling Trip', '150,000Rp', '100,000Rp'],
      ['Snorkeling Mask', '30,000Rp', '', '', '', '', '', '', '', '', '', 'Snorkeling Mask', '', '-Sunset Boat'],
      ['Rabbit bike', '50,000Rp', '', '', '', '', '', '', '', '', '', 'Rabbit bike'],
      ['-Sunset Boat', '200,000Rp', '100,000Rp'],
    ],
    'SG': [['Num', 'Status', 'Last guest ', 'Last Time ', 'Num Days', 'Back Before'],
      ...Array.from({ length: 12 }, (_, i) => ['SG' + String(i + 1).padStart(3, '0'), 'OK', '', '', '', '']),
      ['B1442', 'OK', '', '', '', ''], ['B1443', 'OK', '', '', '', '']],
    'Entries': [
      ['Date', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Time stamp', 'month correction', 'Comment'],
      [new Date(Date.now() - 3 * 86400000), 'Income', 'Service', 'Laundry', 2, 30000, 60000, 60000, 'r2@x', '', 0, 0, 'Alice Example', 'Unpaid',
        new Date(Date.now() - 3 * 86400000 + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17), '', ''],
      // Partner sales not settled: two horse rides (one paid by the guest to the partner) and a shuttle on an old bill.
      ...[['-Horse Riding', 'Tour', 2, 800000, 700000, 'Ann', 'Cash', ''], ['-Horse Riding', 'Tour', 1, 400000, 350000, 'Ben', 'Paid to Partner', ''],
        ['-Shuttle Bangsal / Kuta', 'Transport', 1, 160000, 90000, 'Cy', 'Cash', 'B_01/10-10:00']].map((x, i) => {
        const ms = Date.now() - 5 * 86400000 + i * 1000;
        return [new Date(ms), 'Income', x[1], x[0], x[2], x[3] / x[2], x[3], x[3], 'r2@x', x[4] / x[2], x[4], x[4], x[5], x[6],
          new Date(ms + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17), '', '', '', x[7]];
      }),
    ],
    '24datafeed': [['Guest Name', 'First Name', 'Full'], ['E', 'A', 'Alice Example']],
    'Settlements': [['Date', 'Time', 'Author', 'Time stamp', 'Difference', 'Total Settlement MIN 3%', 'Total Card Transaction (Spreadsheet)', 'Total Local Card', 'Comment:', 'TOTAL SETTLEMENT', 'AFTER 3% SETTLEMENT 1', 'AFTER 3% SETTLEMENT 2'],
      [new Date(Date.now() - 86400000), '20:00:00', 'r1@x', Number(new Date(Date.now() - 86400000 + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 14) + '000'), 0, 0, 0, '', 'Comment:', 0, 0, 0]],
    'Protect': [['Tabs Locked', 'Auth Base', 'Auth Level 2', 'Auth Level 1', 'Tabs unlock temporary', 'Email Alerts'], ['', '', '', '', '', 'alerts@x']],
    'New guest': [['', '', '', '', '', 'Bob Sample']],
  } });
  env.ctx.UI_setup();
  const u = env.book['UI_Users'];
  u.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'ayu123', '', '', '']);
  u.appendRow(['dewa', 'Dewa', 'staff', 'r2@x', 'dewa123', '', '', '']);
  u.appendRow(['boss', 'Sebastien', 'manager', 'boss@x', 'boss123', '', '', '']);
  u.appendRow(['made', 'Made', 'gear', 'made@x', 'made123', '', '', '']);
  env.book['Gear_Settings'].data.forEach(r => { if (r[0] === 'Snorkel') r[1] = 75000; if (r[0] === 'Manager WhatsApp') r[1] = '+62 812 0000 0000'; });
  return env;
}

function start(port = 0) {
  const env = seedEnv();
  let down = false;
  const root = path.join(__dirname, '..', '..');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__net') { down = url.searchParams.get('down') === '1'; res.end('ok'); return; }
    if (url.pathname === '/api') {
      if (down) { req.socket.destroy(); return; }
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const out = env.ctx.doPost({ postData: { contents: body } }).text;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(out);
      });
      return;
    }
    if (url.pathname === '/js/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`export const CONFIG = { API_URL: '/api', PUSH_EVERY_MS: 1500, PULL_EVERY_MS: 4000 };`);
      return;
    }
    let p = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => server.listen(port, () => r({ server, env, port: server.address().port, setDown: v => (down = v) })));
}

module.exports = { start };
if (require.main === module) start(8080).then(s => console.log('http://localhost:' + s.port));
