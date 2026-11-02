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
    ],
    'Entries': [
      ['Date', 'Category', 'Sub-category', 'object', 'Qty', 'Auto price per unit', 'Auto price', 'Real price (if different)', 'Author', 'Theorical cost per unit', 'Theorical cost', 'Real cost (if different)', 'Guest', 'Payment Type', 'Time stamp', 'month correction', 'Comment'],
      [new Date(Date.now() - 3 * 86400000), 'Income', 'Service', 'Laundry', 2, 30000, 60000, 60000, 'r2@x', '', 0, 0, 'Alice Example', 'Unpaid',
        new Date(Date.now() - 3 * 86400000 + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17), '', ''],
    ],
    '24datafeed': [['Guest Name', 'First Name', 'Full'], ['E', 'A', 'Alice Example']],
    'New guest': [['', '', '', '', '', 'Bob Sample']],
  } });
  env.ctx.UI_setup();
  const u = env.book['UI_Users'];
  u.appendRow(['ayu', 'Ayu', 'staff', 'r1@x', 'ayu123', '', '', '']);
  u.appendRow(['dewa', 'Dewa', 'staff', 'r2@x', 'dewa123', '', '', '']);
  u.appendRow(['boss', 'Sebastien', 'manager', 'boss@x', 'boss123', '', '', '']);
  return env;
}

function start(port = 0) {
  const env = seedEnv();
  let down = false;
  const root = path.join(__dirname, '..', '..');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
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
