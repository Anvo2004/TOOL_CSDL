const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { ITEMS } = require('../lib/catalog');

test('VPS deployment: authenticated API and all LGSP adapters with isolated mock data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-csdl-test-'));
  let app, base, cookie = '', upstreamCalls = 0, throttle = false, submits = 0;
  const expiredJobs = new Set();
  const mock = http.createServer(async (req, res) => {
    upstreamCalls++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? (raw[0] === '{' ? JSON.parse(raw) : {}) : {};
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/token') return reply(200, { access_token: 'fixture-token', expires_in: 3600 });
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    if (throttle) return reply(429, { code: '900804' });
    if (req.url.startsWith('/qlvbdh/api/jobs/artifact')) {
      const jobId = new URL(req.url, 'http://x').searchParams.get('jobId');
      if (expiredJobs.has(jobId)) return reply(404, { message: 'job not found' });
      return reply(200, { jobId, jobStatus: 'DONE', data: [{ id: 'fixture-1', name: 'Dữ liệu thử nghiệm', nested: { value: 'a,b' } }], total: 1 });
    }
    if (req.url === '/qlvbdh/api') {
      submits++;
      const requestId = `request-${upstreamCalls}`;
      const cb = await fetch(body.params.callbackUrl, { method: 'POST', body: JSON.stringify({ requestId, jobId: `job-${upstreamCalls}`, jobStatus: 'DONE' }) });
      assert.equal(cb.status, 200);
      return reply(202, { requestId, requestStatus: 'ACCEPTED' });
    }
    reply(200, { data: [{ id: 'fixture-1', name: 'Dữ liệu thử nghiệm', nested: { value: 'a,b' } }], total: 1 });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  const portProbe = http.createServer();
  await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
  const port = portProbe.address().port;
  await new Promise(r => portProbe.close(r));
  base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/config.json'), JSON.stringify({
    settings: { token_url: `${upstream}/token`, ...Object.fromEntries(['qlvbdh','gopy','vpub','ttdh','csdlpx'].map(k => [`base_${k}`, `${upstream}/${k}`])), policy_windows: Object.fromEntries([...ITEMS.keys()].map(k => [k, 'any'])), job_timeout_sec: 10 },
    xa: ['fixture', 'other'].map(id => ({ id, name: id, key: id, secret: 'fixture-secret', organId: 'fixture', organKey: 'fixture-organ', gopy_user: 'fixture', gopy_pass: 'fixture-pass', vpub_IDDonVi: '1', csdlpx_username: 'fixture', csdlpx_password: 'fixture-pass' })),
  }));
  app = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, MONGODB_URI: '', NODE_ENV: 'production', DATA_ROOT: root, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, APP_USERNAME: 'fixture-admin', APP_PASSWORD: 'fixture-admin-pass', SESSION_SECRET: 'fixture-session', SCHEDULER_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  app.stdout.on('data', b => { logs += b; });
  app.stderr.on('data', b => { logs += b; });
  t.after(async () => {
    app.kill();
    if (app.exitCode === null) await once(app, 'exit');
    mock.closeAllConnections();
    await new Promise(r => mock.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (n === 99) throw new Error(`App did not start: ${logs}`);
    await new Promise(r => setTimeout(r, 50));
  }
  const api = async (route, method = 'GET', data, auth = cookie) => {
    const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Cookie: auth, 'X-Forwarded-Proto': 'https' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  };
  await t.test('health, login, secure cookie, anonymous access', async () => {
    assert.equal((await api('/healthz')).status, 200);
    assert.equal((await api('/api/config')).status, 401);
    assert.match((await api('/')).body, /Đăng nhập/);
    assert.equal((await api('/api/login', 'POST', { username: 'bad', password: 'bad' })).status, 401);
    const login = await api('/api/login', 'POST', { username: 'fixture-admin', password: 'fixture-admin-pass' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly.*SameSite=Lax.*Secure/);
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await api('/api/info')).body.role, 'admin');
  });
  await t.test('configuration masks secrets and preserves them on save', async () => {
    const cfg = (await api('/api/config')).body;
    assert.equal(cfg.xa[0].secret, '••••••');
    assert.equal((await api('/api/config', 'PUT', cfg)).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config/config.json'))).xa[0].secret, 'fixture-secret');
  });
  for (const key of ITEMS.keys()) await t.test(`query ${key}: token, callback/artifact or synchronous data`, async () => {
    const r = await api('/api/query', 'POST', { xaId: 'fixture', itemKey: key, from: '2026-11-01', to: '2026-11-07', autoSave: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.count, 1);
    assert.equal(r.body.files.length, 2);
  });
  await t.test('search, pagination, JSON/CSV exports, history and usage', async () => {
    const r = await api('/api/result?xa=fixture&item=qlvbdh.vbden&q=th%E1%BB%AD&offset=0&limit=1');
    assert.equal(r.body.filtered, 1);
    assert.equal(r.body.rows[0]['nested.value'], 'a,b');
    assert.equal((await api('/api/result?xa=fixture&item=qlvbdh.vbden&offset=1&limit=1')).body.rows.length, 0);
    assert.equal((await api('/api/download?xa=fixture&item=qlvbdh.vbden&format=json')).body.length, 1);
    const csv = await api('/api/download?xa=fixture&item=qlvbdh.vbden&format=csv');
    assert.match(csv.body, /"a,b"/);
    assert.match(csv.headers.get('content-disposition'), /attachment/);
    assert.equal((await api('/api/history')).body.length, ITEMS.size);
    assert.equal((await api('/api/stats')).body.length, ITEMS.size);
    assert.ok((await api('/api/usage')).body.totals.today.calls > 0);
  });
  await t.test('QLVBDH reuses jobId until it expires', async () => {
    const q = () => api('/api/query', 'POST', { xaId: 'fixture', itemKey: 'qlvbdh.vbden', from: '2026-11-01', to: '2026-11-07', autoSave: false });
    const before = submits;
    let r = await q();
    assert.equal(r.body.count, 1);
    assert.equal(submits, before, 'same request must reuse the existing jobId');
    const reused = (r.body.logs || []).join('\n').match(/dùng lại jobId (\S+)/);
    assert.ok(reused, JSON.stringify(r.body.logs));
    expiredJobs.add(reused[1]);
    r = await q();
    assert.equal(r.body.count, 1);
    assert.equal(submits, before + 1, 'expired jobId must be replaced by a new request');
    r = await q();
    assert.equal(submits, before + 1, 'new jobId is reused again');
  });
  await t.test('commune account lifecycle, isolation and session invalidation', async () => {
    assert.equal((await api('/api/users', 'POST', { username: 'fixture-user', password: 'fixture-password', xaId: 'fixture' })).status, 200);
    const login = await api('/api/login', 'POST', { username: 'fixture-user', password: 'fixture-password' });
    const userCookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await api('/api/config', 'GET', undefined, userCookie)).body.xa.length, 1);
    assert.equal((await api('/api/users', 'GET', undefined, userCookie)).status, 403);
    assert.equal((await api('/api/query', 'POST', { xaId: 'other', itemKey: 'csdlpx.TonGiao' }, userCookie)).status, 403);
    assert.equal((await api('/api/result?xa=other&item=csdlpx.TonGiao', 'GET', undefined, userCookie)).status, 403);
    // Tài khoản xã không tự đổi mật khẩu được.
    assert.equal((await api('/api/password', 'POST', { current: 'fixture-password', next: 'fixture-next-pass' }, userCookie)).status, 403);
    assert.equal((await api('/api/login', 'POST', { username: 'fixture-user', password: 'fixture-password' })).status, 200);
    await api('/api/users/fixture-user', 'PUT', { disabled: true });
    assert.equal((await api('/api/info', 'GET', undefined, userCookie)).status, 401);
    await api('/api/users/fixture-user', 'PUT', { disabled: false, xaId: 'other' });
    assert.equal((await api('/api/users/fixture-user/password', 'POST', { password: 'fixture-reset-pass' })).status, 200);
    await api('/api/users/fixture-user', 'DELETE');
    assert.equal((await api('/api/users')).body.length, 0);
  });
  await t.test('admin changes own password; old admin sessions are logged out', async () => {
    assert.equal((await api('/api/password', 'POST', { current: 'wrong-pass', next: 'fixture-admin-new' })).status, 400);
    assert.equal((await api('/api/password', 'POST', { current: 'fixture-admin-pass', next: 'short' })).status, 400);
    const changed = await api('/api/password', 'POST', { current: 'fixture-admin-pass', next: 'fixture-admin-new' });
    assert.equal(changed.status, 200);
    assert.equal((await api('/api/info')).status, 401);
    cookie = changed.headers.get('set-cookie').split(';')[0];
    assert.equal((await api('/api/info')).body.role, 'admin');
    assert.equal((await api('/api/login', 'POST', { username: 'fixture-admin', password: 'fixture-admin-pass' })).status, 401);
    assert.equal((await api('/api/login', 'POST', { username: 'fixture-admin', password: 'fixture-admin-new' })).status, 200);
  });
  await t.test('automatic sync settings, execution and hourly mode', async () => {
    const auto = { xaId: 'other', enabled: false, mode: 'times', times: ['08:00', '19:00'], items: ['csdlpx.TonGiao'], days: 7 };
    assert.equal((await api('/api/auto', 'PUT', auto)).status, 200);
    assert.equal((await api('/api/auto/run', 'POST', { xaId: 'other' })).status, 202);
    let st;
    for (let n = 0; n < 50; n++) {
      st = (await api('/api/auto?xa=other')).body.selected;
      if (st.lastRun && !st.running) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(st.lastRun.ok, 1);
    assert.equal(st.lastRun.rows, 1);
    const hourly = await api('/api/auto', 'PUT', { ...auto, mode: 'hourly' });
    assert.equal(hourly.body.selected.slots.length, 24);
    assert.equal(hourly.body.schedulerEnabled, false);
    assert.equal(hourly.body.selected.auto.enabled, false);
  });
  await t.test('upstream 429 blocks retries without consuming more calls', async () => {
    throttle = true;
    const query = { xaId: 'other', itemKey: 'csdlpx.TonGiao' };
    assert.equal((await api('/api/query', 'POST', query)).body.ok, false);
    const before = upstreamCalls;
    assert.equal((await api('/api/query', 'POST', query)).body.skipped, true);
    assert.equal(upstreamCalls, before);
    throttle = false;
  });
  await t.test('hourly quota and time windows prevent upstream calls', async () => {
    const cfg = (await api('/api/config')).body;
    cfg.settings.policy_hourly_limit = 1;
    await api('/api/config', 'PUT', cfg);
    const before = upstreamCalls;
    const q = { xaId: 'fixture', itemKey: 'csdlpx.TonGiao' };
    assert.equal((await api('/api/query', 'POST', q)).body.skipped, true);
    cfg.settings.policy_hourly_limit = 50;
    const hour = new Date(Date.now() + 7 * 3600000).getUTCHours();
    cfg.settings.policy_windows['csdlpx.TonGiao'] = hour >= 7 && hour < 18 ? 'night' : 'day';
    await api('/api/config', 'PUT', cfg);
    assert.equal((await api('/api/query', 'POST', q)).body.skipped, true);
    assert.equal(upstreamCalls, before);
  });
  await t.test('state persists across restart in DATA_ROOT', async () => {
    app.kill(); await once(app, 'exit');
    app = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, MONGODB_URI: '', DATA_ROOT: root, PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, APP_USERNAME: 'fixture-admin', APP_PASSWORD: 'fixture-admin-pass', SESSION_SECRET: 'fixture-session', SCHEDULER_ENABLED: 'false' }, stdio: 'ignore' });
    for (let n = 0; n < 100; n++) { try { if ((await api('/healthz')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    assert.equal((await api('/api/stats')).body.length, ITEMS.size + 1);
    assert.equal((await api('/api/result?xa=fixture&item=csdlpx.TonGiao')).body.count, 1);
    assert.ok((await api('/api/info')).body.policy.hourly.find(x => x.xaId === 'fixture').used > 0);
  });
});

test('production with loopback proxy refuses to start without authentication', async () => {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, HOST: '127.0.0.1', PUBLIC_URL: 'https://csdlapi.example.test', APP_USERNAME: '', APP_PASSWORD: '' }, stdio: 'ignore' });
  assert.equal((await once(child, 'exit'))[0], 1);
});
