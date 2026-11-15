// Sao lưu hằng ngày: kho SQLite (bản sao nhất quán) và thư mục config/ (cấu hình, tài khoản) vào
// backups/<ngày>/, giữ BACKUP_KEEP_DAYS bản mới nhất (mặc định 14). Chạy lúc 02:30 giờ Việt Nam.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 14);
const AT_MIN = 2 * 60 + 30;
const VN_OFFSET = 7 * 3600000;
let timer = null;
let root = null;

const vnDay = (t = Date.now()) => new Date(t + VN_OFFSET).toISOString().slice(0, 10);
const vnMin = (t = Date.now()) => {
  const d = new Date(t + VN_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const dir = () => path.join(root, 'backups');

function runBackup(day = vnDay()) {
  const out = path.join(dir(), day);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const files = [];
  if (db.backupTo(path.join(out, 'csdl.sqlite'))) files.push('csdl.sqlite');
  const cfgDir = path.join(root, 'config');
  if (fs.existsSync(cfgDir)) {
    for (const f of fs.readdirSync(cfgDir)) {
      if (!f.endsWith('.json')) continue;
      fs.copyFileSync(path.join(cfgDir, f), path.join(out, f));
      fs.chmodSync(path.join(out, f), 0o600);
      files.push(f);
    }
  }
  const days = fs.readdirSync(dir()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP))) fs.rmSync(path.join(dir(), old), { recursive: true, force: true });
  return { day, files };
}

function list() {
  if (!root || !fs.existsSync(dir())) return [];
  return fs.readdirSync(dir()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().map((d) => {
    const files = fs.readdirSync(path.join(dir(), d));
    const size = files.reduce((s, f) => s + fs.statSync(path.join(dir(), d, f)).size, 0);
    return { day: d, files: files.length, sizeBytes: size };
  });
}

// Kiểm tra mỗi 10 phút; sau 02:30 mà hôm nay chưa có bản sao thì sao lưu.
function start(dataRoot) {
  root = dataRoot;
  if (timer) return;
  const tick = () => {
    try {
      if (vnMin() < AT_MIN || fs.existsSync(path.join(dir(), vnDay()))) return;
      const r = runBackup();
      db.pruneChanges();
      console.log(`[Sao lưu ${r.day}] ${r.files.join(', ')}`);
    } catch (e) {
      console.error('Sao lưu lỗi:', e.message);
    }
  };
  timer = setInterval(tick, 10 * 60000);
  timer.unref();
  setTimeout(tick, 60000).unref();
}

module.exports = { start, runBackup, list, setRoot: (r) => { root = r; } };
