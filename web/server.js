// Máy chủ: phục vụ giao diện web và làm trung gian gọi API LGSP
// (trình duyệt không gọi thẳng được apiv2.danang.gov.vn vì CORS và để giữ kín khóa/mật khẩu).
// Chạy trên máy: node server.js → http://localhost:3000
// Triển khai (Render): đặt biến môi trường MONGODB_URI, APP_USERNAME, APP_PASSWORD.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CATEGORIES, ITEMS } = require('./lib/catalog');
const { getToken, recordCallback } = require('./lib/lgsp');
const store = require('./lib/store');
const usage = require('./lib/usage');
const sync = require('./lib/sync');
const { flattenRow, columnsOf, toCsv, slug } = require('./lib/util');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.RENDER || process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// ---------- Đăng nhập ----------
const AUTH_USER = process.env.APP_USERNAME || '';
const AUTH_PASS = process.env.APP_PASSWORD || '';
const AUTH_ON = !!(AUTH_USER && AUTH_PASS);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`tool-csdl|${AUTH_USER}|${AUTH_PASS}`).digest('hex');
const SESSION_HOURS = 12;
const failedLogins = new Map(); // ip -> { n, until }

if (HOST !== '127.0.0.1' && !AUTH_ON) {
  console.error('Web đang mở ra Internet nhưng chưa đặt APP_USERNAME / APP_PASSWORD. Dừng để bảo vệ tài khoản LGSP.');
  process.exit(1);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function readSession(req) {
  if (!AUTH_ON) return { u: 'local' };
  const raw = parseCookies(req.headers.cookie).sid;
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  const expect = sign(payload || '');
  if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function sessionCookie(req, value, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const f = failedLogins.get(ip);
  if (f && f.n >= 8 && f.until > Date.now()) return send(res, 429, { error: 'Sai quá nhiều lần, thử lại sau 15 phút' });
  const { username, password } = await readJson(req);
  const ok = crypto.timingSafeEqual(sha(username), sha(AUTH_USER)) & crypto.timingSafeEqual(sha(password), sha(AUTH_PASS));
  if (!ok) {
    const n = f && f.until > Date.now() ? f.n + 1 : 1;
    failedLogins.set(ip, { n, until: Date.now() + 15 * 60000 });
    return send(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  failedLogins.delete(ip);
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_HOURS * 3600000 })).toString('base64url');
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, `${payload}.${sign(payload)}`, SESSION_HOURS * 3600) });
}

// ---------- Tiện ích HTTP ----------
function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 5_000_000) { reject(new Error('Dữ liệu gửi lên quá lớn')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const readJson = async (req) => {
  const t = await readBody(req);
  return t ? JSON.parse(t) : {};
};

function findXa(cfg, xaId) {
  const xa = cfg.xa.find((x) => x.id === xaId);
  if (!xa) throw Object.assign(new Error(`Không tìm thấy xã: ${xaId}`), { status: 404 });
  return xa;
}

// ---------- Truy vấn ----------
async function handleQuery(req, res) {
  const { xaId, itemKey, from, to, autoSave } = await readJson(req);
  const cfg = await store.loadConfig();
  const xa = findXa(cfg, xaId);
  const item = ITEMS.get(itemKey);
  if (!item) return send(res, 404, { error: `Không có mục ${itemKey}` });

  const logs = [];
  const entry = await sync.executeTask({ settings: cfg.settings, xa, item, from, to, autoSave, log: (m) => logs.push(m) });
  send(res, 200, { ...entry, logs });
}

// ---------- Đồng bộ tự động & hạn mức ----------
async function handleAuto(res) {
  const { settings } = await store.loadConfig();
  const auto = Object.fromEntries(sync.AUTO_KEYS.map((k) => [k, settings[k]]));
  send(res, 200, { settings: auto, ...sync.status(settings) });
}

async function handleUsage(url, res) {
  const cfg = await store.loadConfig();
  const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 30));
  send(res, 200, {
    quotaDay: usage.quotaDay(),
    resetAt: new Date(usage.nextUtcMidnight()).toISOString(),
    today: usage.snapshot(cfg.settings, cfg.xa),
    ...(await usage.report(days)),
    runs: await store.readSyncRuns(Number(url.searchParams.get('runs')) || 30),
  });
}

async function handleResult(url, res) {
  const r = await store.loadResult(url.searchParams.get('xa'), url.searchParams.get('item'));
  if (!r) return send(res, 404, { error: 'Chưa có dữ liệu, hãy truy vấn trước' });
  const q = (url.searchParams.get('q') || '').toLowerCase();
  let flat = r.rows.map(flattenRow);
  if (q) flat = flat.filter((row) => Object.values(row).some((v) => v != null && String(v).toLowerCase().includes(q)));
  const offset = Number(url.searchParams.get('offset')) || 0;
  const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : flat.length;
  const { rows, ...meta } = r;
  send(res, 200, { ...meta, filtered: flat.length, columns: columnsOf(flat), rows: flat.slice(offset, offset + limit) });
}

async function handleDownload(url, res) {
  const r = await store.loadResult(url.searchParams.get('xa'), url.searchParams.get('item'));
  if (!r) return send(res, 404, { error: 'Chưa có dữ liệu' });
  const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const name = `${slug(r.xaName)}_${slug(r.itemName)}.${fmt}`;
  const body = fmt === 'json' ? JSON.stringify(r.rows, null, 2) : toCsv(r.rows);
  send(res, 200, body, {
    'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
  });
}

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // LGSP gọi về đây để báo jobId — không cần đăng nhập.
    if (p === '/callback' || p.startsWith('/callback/')) {
      if (req.method === 'POST') recordCallback(await readBody(req));
      return send(res, 200, { received: true });
    }
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'POST' && p === '/api/login') return await handleLogin(req, res);
    if (req.method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });

    const session = readSession(req);
    if (!session) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Chưa đăng nhập' });
      if (p === '/' || p === '/index.html') return serveStatic('/login.html', res);
      return serveStatic(p, res);
    }

    if (req.method === 'GET' && p === '/api/info') return send(res, 200, { storage: store.storageName(), auth: AUTH_ON, user: session.u });
    if (req.method === 'GET' && p === '/api/catalog') return send(res, 200, CATEGORIES);
    if (req.method === 'GET' && p === '/api/config') return send(res, 200, await store.maskedConfig());
    if (req.method === 'PUT' && p === '/api/config') {
      await store.updateConfig(await readJson(req));
      return send(res, 200, await store.maskedConfig());
    }
    if (req.method === 'POST' && p === '/api/test-token') {
      const { xaId } = await readJson(req);
      const cfg = await store.loadConfig();
      try {
        await getToken(cfg.settings, findXa(cfg, xaId), true);
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && p === '/api/query') return await handleQuery(req, res);
    if (req.method === 'GET' && p === '/api/result') return await handleResult(url, res);
    if (req.method === 'GET' && p === '/api/download') return await handleDownload(url, res);
    if (req.method === 'GET' && p === '/api/history') return send(res, 200, await store.readHistory(Number(url.searchParams.get('limit')) || 500));
    if (req.method === 'GET' && p === '/api/stats') return send(res, 200, await store.latestStats());
    if (req.method === 'GET' && p === '/api/auto') return await handleAuto(res);
    if (req.method === 'PUT' && p === '/api/auto') {
      await sync.saveAutoSettings(await readJson(req));
      return await handleAuto(res);
    }
    if (req.method === 'POST' && p === '/api/auto/run') {
      sync.runSync({ trigger: 'manual' }).catch((e) => console.error('Lỗi đồng bộ:', e.message));
      return send(res, 202, { started: true });
    }
    if (req.method === 'GET' && p === '/api/usage') return await handleUsage(url, res);
    if (req.method === 'POST' && p === '/api/usage/unblock') {
      const { xaId, sys } = await readJson(req);
      usage.unblock(xaId, sys);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(p === '/login.html' ? '/' : p, res);
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

// Truy vấn QLVBDH có thể chờ job vài phút — tắt giới hạn thời gian request mặc định của Node.
server.requestTimeout = 0;

store.init().then(async () => {
  await usage.init();
  await sync.startScheduler();
  server.listen(PORT, HOST, () => {
    console.log(`Công cụ truy vấn LGSP đang chạy: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Lưu trữ: ${store.storageName() === 'mongo' ? 'MongoDB' : `file (${store.EXPORT_DIR})`} · Đăng nhập: ${AUTH_ON ? 'bật' : 'tắt'}`);
  });
}).catch((e) => {
  console.error('Không khởi động được:', e.message);
  process.exit(1);
});
