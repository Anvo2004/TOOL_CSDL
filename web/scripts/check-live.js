// Explicit live check: consumes LGSP quota, always through the application's policy checks.
// node scripts/check-live.js <private-access.json> <report.json>
// access.json: { "url": "https://...", "username": "...", "password": "..." }
const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const [accessFile, reportFile] = process.argv.slice(2);
  if (!accessFile || !reportFile) throw new Error('Usage: node scripts/check-live.js <private-access.json> <report.json>');
  const access = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
  const base = access.url.replace(/\/+$/, '');
  if (!base.startsWith('https://')) throw new Error('Use the HTTPS domain for live checks');
  let cookie = '';
  const request = async (route, data) => {
    const res = await fetch(base + route, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(850000) });
    if (route === '/api/login' && res.ok) cookie = res.headers.get('set-cookie').split(';')[0];
    if (!res.ok) throw new Error(`${route.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  };
  await request('/api/login', { username: access.username, password: access.password });
  const [cfg, catalog, info] = await Promise.all(['/api/config', '/api/catalog', '/api/info'].map(p => request(p)));
  const now = new Date(Date.now() + 7 * 3600000);
  const to = now.toISOString().slice(0, 10);
  now.setUTCDate(now.getUTCDate() - 6);
  const from = now.toISOString().slice(0, 10);
  const items = catalog.flatMap(c => c.items.map(i => ({ key: `${c.id}.${i.id}`, name: i.name })));
  const report = { url: base, startedAt: new Date().toISOString(), from, to, storage: info.storage, results: [] };
  fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
  const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const summaries = () => {
    const counts = { data: 0, empty: 0, warning: 0, error: 0, skipped: 0 };
    for (const r of report.results) counts[r.state]++;
    return counts;
  };
  // One request per commune at a time; separate communes have separate LGSP keys.
  await Promise.all(cfg.xa.map(async xa => {
    for (const item of items) {
      let entry;
      try {
        const r = await request('/api/query', { xaId: xa.id, itemKey: item.key, from, to, autoSave: true });
        entry = { xaId: xa.id, item: item.key, state: r.skipped ? 'skipped' : !r.ok ? 'error' : r.warnings?.length ? 'warning' : r.count > 0 ? 'data' : 'empty', count: r.count || 0, calls: r.calls || 0, error: r.error || null, warnings: r.warnings || [], durationMs: r.durationMs || 0 };
        if (r.ok) {
          const saved = await request(`/api/result?xa=${encodeURIComponent(xa.id)}&item=${encodeURIComponent(item.key)}&limit=1`);
          if (saved.count !== r.count) throw new Error('Saved result count differs from query count');
        }
      } catch (e) { entry = { xaId: xa.id, item: item.key, state: 'error', count: 0, error: e.message }; }
      report.results.push(entry);
      save();
      console.log(JSON.stringify(entry));
    }
  }));
  report.finishedAt = new Date().toISOString();
  report.summary = summaries();
  save();
  console.log('SUMMARY', JSON.stringify(report.summary));
  process.exitCode = report.results.some(r => ['skipped','error','warning'].includes(r.state)) ? 2 : 0;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
