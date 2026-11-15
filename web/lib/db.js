// Kho dữ liệu SQLite (data/csdl.sqlite): bản ghi đã chuẩn hóa của mọi (xã, mục), lịch sử thay đổi
// và số liệu từng lần đồng bộ. Đây là nguồn cho tra cứu, dashboard và báo cáo.
// Mỗi bản ghi giữ: khóa nghiệp vụ, ngành, tiêu đề, ngày chính, chuỗi tìm kiếm không dấu và bản gốc (JSON).
// Dùng node:sqlite có sẵn trong Node ≥ 22.13; Node cũ hơn thì kho tắt, web vẫn chạy như trước.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isEnvelope } = require('./util');

let sqlite = null;
try {
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}

const CHANGE_KEEP_DAYS = 400;
const KEY_FIELDS = ['id', 'doituong_id', 'vayvon_id', 'madoituong', 'ma', 'idvanban', 'soVanBanId'];
const TITLE_FIELDS = ['trichYeu', 'trichyeu', 'noidungviec', 'tencuochop', 'tencoso', 'tenthietche', 'tencaulacbo', 'tentochuc',
  'tensanpham', 'tenbanchihuy', 'hoten', 'ten', 'tieuDe', 'tieude', 'title', 'name'];
const DATE_FIELDS = ['ngayDen', 'ngayBanHanh', 'ngayvanban', 'ngayhop', 'ngayvipham', 'ngaygiaingan', 'ngaycap', 'ngaybatdau',
  'thoidiembatdau', 'ngayquyetdinh', 'ngaythanhlap', 'ngayTaoVanBan', 'ngay', 'date'];

let db = null;
let file = null;
const st = {}; // câu lệnh đã chuẩn bị

const available = () => !!sqlite;
const ready = () => !!db;

function init(root) {
  if (!sqlite || db) return ready();
  file = path.join(root, 'data', 'csdl.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new sqlite.DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS records (
      xa_id TEXT NOT NULL, item_key TEXT NOT NULL, rec_key TEXT NOT NULL,
      sector TEXT, title TEXT, rec_date TEXT, search TEXT,
      data TEXT NOT NULL, hash TEXT NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, updated_at TEXT NOT NULL, removed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS records_key ON records (xa_id, item_key, rec_key);
    CREATE INDEX IF NOT EXISTS records_item ON records (item_key, xa_id, removed_at);
    CREATE INDEX IF NOT EXISTS records_sector ON records (sector, xa_id);
    CREATE INDEX IF NOT EXISTS records_date ON records (xa_id, item_key, rec_date);
    CREATE TABLE IF NOT EXISTS syncs (
      id INTEGER PRIMARY KEY, xa_id TEXT NOT NULL, item_key TEXT NOT NULL, at TEXT NOT NULL, source TEXT,
      total INTEGER, added INTEGER, updated INTEGER, removed INTEGER, unchanged INTEGER, note TEXT
    );
    CREATE INDEX IF NOT EXISTS syncs_xa ON syncs (xa_id, item_key, at);
    CREATE TABLE IF NOT EXISTS record_changes (
      id INTEGER PRIMARY KEY, sync_id INTEGER, xa_id TEXT NOT NULL, item_key TEXT NOT NULL, rec_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('new', 'update', 'remove')), at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS changes_xa ON record_changes (xa_id, item_key, at);
  `);
  st.existing = db.prepare('SELECT rec_key, hash, removed_at FROM records WHERE xa_id = ? AND item_key = ?');
  st.insert = db.prepare(`INSERT INTO records (xa_id, item_key, rec_key, sector, title, rec_date, search, data, hash, first_seen, last_seen, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  st.update = db.prepare(`UPDATE records SET sector = ?, title = ?, rec_date = ?, search = ?, data = ?, hash = ?, last_seen = ?, updated_at = ?, removed_at = NULL
    WHERE xa_id = ? AND item_key = ? AND rec_key = ?`);
  st.touch = db.prepare('UPDATE records SET last_seen = ? WHERE xa_id = ? AND item_key = ? AND rec_key = ?');
  st.remove = db.prepare('UPDATE records SET removed_at = ? WHERE xa_id = ? AND item_key = ? AND rec_key = ?');
  st.sync = db.prepare('INSERT INTO syncs (xa_id, item_key, at, source, total, added, updated, removed, unchanged, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  st.change = db.prepare('INSERT INTO record_changes (sync_id, xa_id, item_key, rec_key, kind, at) VALUES (?, ?, ?, ?, ?, ?)');
  st.getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
  st.setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v');
  return true;
}

function close() {
  if (db) db.close();
  db = null;
}

const getMeta = (k) => (db ? (st.getMeta.get(k) || {}).v ?? null : null);
const setMeta = (k, v) => db && st.setMeta.run(k, String(v));

// ---------- Chuẩn hóa một bản ghi ----------
const pad = (n) => String(n).padStart(2, '0');
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

// Ngày ở nhiều dạng (dd/MM/yyyy, ISO, epoch) -> 'YYYY-MM-DD'; không đọc được thì null.
function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{12,13}$/.test(String(v))) {
    const d = new Date(Number(v) + 7 * 3600000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

const firstOf = (row, fields) => {
  for (const f of fields) if (row[f] != null && row[f] !== '') return row[f];
  return null;
};

function recKey(row, json) {
  const k = firstOf(row, KEY_FIELDS);
  return k != null && typeof k !== 'object' ? String(k) : 'h:' + crypto.createHash('sha1').update(json).digest('hex').slice(0, 20);
}

function searchText(row) {
  const parts = [];
  for (const v of Object.values(row)) {
    if (v == null || typeof v === 'object' || typeof v === 'boolean') continue;
    const s = String(v).trim();
    if (s && s.length < 500) parts.push(s);
  }
  return fold(parts.join(' ')).slice(0, 4000);
}

function normalize(row) {
  const json = JSON.stringify(row);
  const title = firstOf(row, TITLE_FIELDS);
  return {
    key: recKey(row, json),
    title: title == null ? null : String(title).slice(0, 500),
    date: normDate(firstOf(row, DATE_FIELDS)),
    search: searchText(row),
    json,
    hash: crypto.createHash('sha1').update(json).digest('hex'),
  };
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Ghi kết quả một lần truy vấn thành công vào kho. Mục không lọc ngày là ảnh chụp toàn bộ danh sách nên bản ghi
// không còn xuất hiện được đánh dấu đã mất; mục lọc theo ngày chỉ thêm/cập nhật.
// baseline = true (lần nhập đầu từ file cũ): không ghi từng bản ghi vào lịch sử thay đổi.
function ingest(result, item, { baseline = false } = {}) {
  if (!db || !result || !result.ok || !item) return null;
  const at = result.startedAt || new Date().toISOString();
  const xa = result.xaId;
  const ik = item.key;
  const rows = (result.rows || []).filter((r) => r && typeof r === 'object' && !isEnvelope(r));
  return tx(() => {
    const old = new Map(st.existing.all(xa, ik).map((r) => [r.rec_key, r]));
    const firstTime = !old.size;
    const seen = new Set();
    const changes = [];
    const n = { total: 0, added: 0, updated: 0, removed: 0, unchanged: 0 };
    for (const row of rows) {
      const r = normalize(row);
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      n.total++;
      const o = old.get(r.key);
      if (!o) {
        st.insert.run(xa, ik, r.key, item.sector || null, r.title, r.date, r.search, r.json, r.hash, at, at, at);
        n.added++;
        changes.push([r.key, 'new']);
      } else if (o.hash !== r.hash || o.removed_at) {
        st.update.run(item.sector || null, r.title, r.date, r.search, r.json, r.hash, at, at, xa, ik, r.key);
        n.updated++;
        changes.push([r.key, 'update']);
      } else {
        st.touch.run(at, xa, ik, r.key);
        n.unchanged++;
      }
    }
    let note = null;
    if (!item.dated) {
      const gone = [...old.values()].filter((o) => !o.removed_at && !seen.has(o.rec_key));
      const active = [...old.values()].filter((o) => !o.removed_at).length;
      // Phản hồi rỗng hoặc hụt quá nửa thường là lỗi tạm của API: không đánh dấu mất hàng loạt.
      if (gone.length && (n.total === 0 || n.total < active / 2)) {
        note = `Bỏ qua đánh dấu mất ${gone.length} bản ghi (phản hồi có ${n.total}/${active})`;
      } else {
        for (const o of gone) {
          st.remove.run(at, xa, ik, o.rec_key);
          changes.push([o.rec_key, 'remove']);
        }
        n.removed = gone.length;
      }
    }
    const syncId = Number(st.sync.run(xa, ik, at, baseline ? 'import' : result.source || null, n.total, n.added, n.updated, n.removed, n.unchanged, note).lastInsertRowid);
    if (!baseline && !firstTime) for (const [k, kind] of changes) st.change.run(syncId, xa, ik, k, kind, at);
    return { ...n, note };
  });
}

// Lần đầu bật kho: nạp kết quả gần nhất đã lưu dạng file/MongoDB của mọi (xã, mục).
async function importLegacy(loadResult, xaIds, items) {
  if (!db || getMeta('imported_v1')) return null;
  let n = 0;
  for (const xaId of xaIds) {
    for (const item of items) {
      const r = await loadResult(xaId, item.key).catch(() => null);
      if (r && r.ok && ingest(r, item, { baseline: true })) n++;
    }
  }
  setMeta('imported_v1', new Date().toISOString());
  return n;
}

function pruneChanges() {
  if (!db) return;
  const cut = new Date(Date.now() - CHANGE_KEEP_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM record_changes WHERE at < ?').run(cut);
}

const inList = (col, ids) => (ids ? ` AND ${col} IN (${ids.map(() => '?').join(',') || "''"})` : '');

// Số bản ghi hiện có của từng (xã, mục) và lần đồng bộ gần nhất.
function summary(xaIds = null) {
  if (!db) return [];
  return db.prepare(`
    SELECT xa_id, item_key, MAX(sector) AS sector,
      SUM(removed_at IS NULL) AS active, SUM(removed_at IS NOT NULL) AS removed,
      MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
    FROM records WHERE 1 = 1${inList('xa_id', xaIds)} GROUP BY xa_id, item_key ORDER BY xa_id, item_key
  `).all(...(xaIds || []));
}

function recentSyncs(xaIds = null, limit = 100) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM syncs WHERE 1 = 1${inList('xa_id', xaIds)} ORDER BY id DESC LIMIT ?`).all(...(xaIds || []), limit);
}

// Bản sao nhất quán của kho (chạy được khi đang ghi).
function backupTo(dest) {
  if (!db) return false;
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  db.prepare('VACUUM INTO ?').run(dest);
  return true;
}

function stats() {
  if (!db) return { enabled: false, reason: sqlite ? 'chưa khởi tạo' : 'Node.js chưa có node:sqlite (cần Node ≥ 22.13)' };
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  return {
    enabled: true,
    file: path.basename(file),
    sizeBytes: fs.statSync(file).size,
    records: one('SELECT COUNT(*) FROM records WHERE removed_at IS NULL'),
    syncs: one('SELECT COUNT(*) FROM syncs'),
    changes: one('SELECT COUNT(*) FROM record_changes'),
    importedAt: getMeta('imported_v1'),
  };
}

module.exports = {
  available, ready, init, close, ingest, importLegacy, pruneChanges, summary, recentSyncs, backupTo, stats,
  getMeta, setMeta, normDate, fold, normalize,
};
