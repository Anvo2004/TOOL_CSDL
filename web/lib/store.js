// Lưu cấu hình, kết quả truy vấn gần nhất và lịch sử chạy.
// Có MONGODB_URI → lưu trên MongoDB (dùng khi triển khai lên Render, ổ đĩa không bền).
// Không có → lưu file trong thư mục config/, data/, exports/ (chạy trên máy cá nhân).

const fs = require('fs');
const path = require('path');
const { toCsv, slug, pad } = require('./util');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const QUOTA_FILE = path.join(DATA_DIR, 'quota.json');
const RUNS_FILE = path.join(DATA_DIR, 'sync_runs.jsonl');
const EXPORT_DIR = path.join(ROOT, 'exports');

const DEFAULT_SETTINGS = {
  token_url: 'https://apiv2.danang.gov.vn/oauth2/token',
  base_qlvbdh: 'https://apiv2.danang.gov.vn/LGSP/QLVBDH/1.0',
  base_gopy: 'https://apiv2.danang.gov.vn/lgsp/ttgopy/2.0',
  base_vpub: 'https://apiv2.danang.gov.vn/lgsp/dieuhanhvpub/1.0',
  base_ttdh: 'https://apiv2.danang.gov.vn/lgsp/apiportal/ttdh/1.0',
  base_csdlpx: 'https://apiv2.danang.gov.vn/LGSP/CSDLPX/1.0',
  callback_url: '',
  webhook_token: '',
  page_size: 50,
  qlvbdh_page_size: 1000,
  max_pages: 200,
  job_timeout_sec: 120,
  // Đồng bộ tự động (xem lib/sync.js)
  auto_enabled: false,
  auto_runs_per_day: 4,
  auto_start: '07:30',
  auto_end: '21:30',
  auto_days: 7,
  auto_items: ['qlvbdh.vbden', 'qlvbdh.vbdi', 'qlvbdh.lich', 'gopy.gopy', 'vpub.viecdonvi'],
  auto_xa: [],
  auto_concurrency: 2,
  auto_safety_pct: 80,
  auto_default_limit: 50,
  auto_daily_limit: 0,
};

const SECRET_FIELDS = ['secret', 'organKey', 'gopy_pass', 'csdlpx_password'];
const MASK = '••••••';
const CHUNK_CHARS = 4_000_000; // MongoDB giới hạn 16MB/document nên chia dữ liệu thành nhiều phần

const useMongo = !!process.env.MONGODB_URI;
let db = null;

async function init() {
  if (!useMongo) {
    for (const d of [path.dirname(CONFIG_FILE), RESULTS_DIR, EXPORT_DIR]) fs.mkdirSync(d, { recursive: true });
    return;
  }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || 'tool_csdl');
  await Promise.all([
    db.collection('history').createIndex({ startedAt: -1 }),
    db.collection('history').createIndex({ xaId: 1, itemKey: 1, startedAt: -1 }),
    db.collection('result_chunks').createIndex({ xaId: 1, itemKey: 1, runId: 1, seq: 1 }),
    db.collection('usage').createIndex({ day: 1 }),
    db.collection('sync_runs').createIndex({ startedAt: -1 }),
  ]);
}

const storageName = () => (useMongo ? 'mongo' : 'file');

// ---------- Cấu hình ----------
async function readRawConfig() {
  if (useMongo) return (await db.collection('config').findOne({ _id: 'main' })) || {};
  return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
}

async function loadConfig() {
  const raw = await readRawConfig();
  return { settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }, xa: raw.xa || [] };
}

async function saveConfig(cfg) {
  if (useMongo) {
    await db.collection('config').replaceOne({ _id: 'main' }, { settings: cfg.settings, xa: cfg.xa }, { upsert: true });
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  }
}

// Ẩn mật khẩu khi gửi ra giao diện.
async function maskedConfig() {
  const cfg = await loadConfig();
  return {
    settings: cfg.settings,
    xa: cfg.xa.map((x) => {
      const y = { ...x };
      for (const f of SECRET_FIELDS) if (y[f]) y[f] = MASK;
      return y;
    }),
  };
}

// Nhận cấu hình từ giao diện: trường còn MASK nghĩa là giữ nguyên giá trị cũ.
async function updateConfig(incoming) {
  const cur = await loadConfig();
  const byId = new Map(cur.xa.map((x) => [x.id, x]));
  const xa = (incoming.xa || []).map((x) => {
    const old = byId.get(x.id) || {};
    const y = { ...x };
    for (const f of SECRET_FIELDS) if (y[f] === MASK) y[f] = old[f] || '';
    if (!y.id) y.id = slug(y.name || 'xa').toLowerCase() || `xa_${Date.now()}`;
    return y;
  });
  const settings = { ...cur.settings, ...(incoming.settings || {}) };
  for (const k of ['page_size', 'qlvbdh_page_size', 'max_pages', 'job_timeout_sec']) settings[k] = Math.max(1, Number(settings[k]) || DEFAULT_SETTINGS[k]);
  await saveConfig({ settings, xa });
}

async function patchSettings(patch) {
  const cfg = await loadConfig();
  await saveConfig({ settings: { ...cfg.settings, ...patch }, xa: cfg.xa });
}

// ---------- Kết quả gần nhất của từng (xã, mục) ----------
const resultFile = (xaId, itemKey) => path.join(RESULTS_DIR, `${slug(xaId)}__${slug(itemKey)}.json`);

async function saveResult(result) {
  if (!useMongo) {
    fs.writeFileSync(resultFile(result.xaId, result.itemKey), JSON.stringify(result), 'utf8');
    return;
  }
  const { rows, ...meta } = result;
  const { xaId, itemKey } = result;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chunks = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    chunks.push({ xaId, itemKey, runId, seq: chunks.length, data: `[${buf.join(',')}]` });
    buf = [];
    size = 0;
  };
  for (const r of rows) {
    const s = JSON.stringify(r);
    if (buf.length && size + s.length > CHUNK_CHARS) flush();
    buf.push(s);
    size += s.length;
  }
  if (buf.length) flush();
  if (chunks.length) await db.collection('result_chunks').insertMany(chunks);
  await db.collection('results').replaceOne({ _id: `${xaId}|${itemKey}` }, { ...meta, runId }, { upsert: true });
  await db.collection('result_chunks').deleteMany({ xaId, itemKey, runId: { $ne: runId } });
}

async function loadResult(xaId, itemKey) {
  if (!useMongo) {
    const f = resultFile(xaId, itemKey);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  const meta = await db.collection('results').findOne({ _id: `${xaId}|${itemKey}` });
  if (!meta) return null;
  const chunks = await db.collection('result_chunks').find({ xaId, itemKey, runId: meta.runId }).sort({ seq: 1 }).toArray();
  const { _id, runId, ...rest } = meta;
  return { ...rest, rows: chunks.flatMap((c) => JSON.parse(c.data)) };
}

// ---------- Lịch sử ----------
async function appendHistory(entry) {
  if (useMongo) await db.collection('history').insertOne({ ...entry });
  else fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

async function readHistory(limit = 1000) {
  if (useMongo) return db.collection('history').find({}, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
}

// Trạng thái mới nhất của từng cặp (xã, mục) — dùng cho bảng thống kê.
async function latestStats() {
  if (useMongo) {
    return db.collection('history').aggregate([
      { $sort: { startedAt: -1 } },
      { $group: { _id: { x: '$xaId', i: '$itemKey' }, doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $project: { _id: 0 } },
    ]).toArray();
  }
  const seen = new Map();
  for (const h of await readHistory(20000)) {
    const k = `${h.xaId}|${h.itemKey}`;
    if (!seen.has(k)) seen.set(k, h);
  }
  return [...seen.values()];
}

// ---------- Đếm lượt gọi API, hạn mức, các lượt đồng bộ tự động ----------
const readJsonFile = (f, def) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : def);

// doc: { _id: 'ngày|xã|hệ thống', day, xaId, sys }; inc: các bộ đếm cần cộng thêm.
async function incUsage(doc, inc) {
  const { _id, day, xaId, sys } = doc;
  if (useMongo) {
    await db.collection('usage').updateOne({ _id }, { $inc: inc, $setOnInsert: { day, xaId, sys } }, { upsert: true });
    return;
  }
  const all = readJsonFile(USAGE_FILE, {});
  const cur = all[_id] || { _id, day, xaId, sys };
  for (const [k, v] of Object.entries(inc)) cur[k] = (cur[k] || 0) + v;
  all[_id] = cur;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(all), 'utf8');
}

async function readUsage(fromDay) {
  if (useMongo) return db.collection('usage').find({ day: { $gte: fromDay } }).toArray();
  return Object.values(readJsonFile(USAGE_FILE, {})).filter((u) => u.day >= fromDay);
}

async function loadQuotas() {
  if (useMongo) return db.collection('quota').find({}).toArray();
  return Object.values(readJsonFile(QUOTA_FILE, {}));
}

async function saveQuota(q) {
  if (useMongo) {
    await db.collection('quota').replaceOne({ _id: q._id }, q, { upsert: true });
    return;
  }
  const all = readJsonFile(QUOTA_FILE, {});
  all[q._id] = q;
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(all, null, 2), 'utf8');
}

async function appendSyncRun(run) {
  if (useMongo) await db.collection('sync_runs').insertOne({ ...run });
  else fs.appendFileSync(RUNS_FILE, JSON.stringify(run) + '\n', 'utf8');
}

async function readSyncRuns(limit = 50) {
  if (useMongo) return db.collection('sync_runs').find({}, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
  if (!fs.existsSync(RUNS_FILE)) return [];
  return fs.readFileSync(RUNS_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
}

// Lưu bản sao CSV/JSON ra ổ đĩa — chỉ ở chế độ chạy trên máy (trên Render ổ đĩa bị xóa khi deploy).
function exportFiles(result) {
  if (useMongo) return [];
  const now = new Date();
  const dir = path.join(EXPORT_DIR, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const base = `${slug(result.xaName)}_${slug(result.itemName)}_${stamp}`;
  fs.writeFileSync(path.join(dir, base + '.csv'), toCsv(result.rows), 'utf8');
  fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(result.rows, null, 2), 'utf8');
  return [base + '.csv', base + '.json'].map((f) => path.relative(ROOT, path.join(dir, f)));
}

module.exports = {
  ROOT, EXPORT_DIR, init, storageName, loadConfig, saveConfig, maskedConfig, updateConfig, patchSettings,
  saveResult, loadResult, appendHistory, readHistory, latestStats, exportFiles,
  incUsage, readUsage, loadQuotas, saveQuota, appendSyncRun, readSyncRuns,
};
