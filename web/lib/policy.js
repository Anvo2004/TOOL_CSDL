// Quy định kết nối Trục LGSP thành phố (Công văn 7779/SKHCN-CNTT ngày 03/11/2026, áp dụng từ 05/11/2026):
// a) mỗi cơ quan, địa phương kết nối tối đa 50 lần / giờ;
// b) 07:00–18:00 dành cho dịch vụ ưu tiên (giải quyết TTHC, Myportal, Giao nhiệm vụ, Lịch cơ quan);
//    các hệ thống còn lại (thống kê, báo cáo...) kết nối từ 18:00 đến 07:00 sáng hôm sau.
// Mỗi xã là một khóa LGSP nên đếm riêng từng xã, theo cửa sổ trượt 60 phút (chặt hơn mọi cách chia giờ
// của LGSP), tính cả lượt lấy token. Bộ đếm được lưu lại để khởi động lại máy chủ không làm mất số đã dùng.

const store = require('./store');
const { fmtVN, sleep } = require('./util');

const DOC = 'CV 7779/SKHCN-CNTT';
const HOUR_MS = 3600000;
const VN_OFFSET = 7 * HOUR_MS;
const DEFAULT_HOURLY_LIMIT = 45; // quy định 50 lượt/giờ, chừa 5 lượt cho Postman / thử token

const WINDOWS = {
  day: { from: 7 * 60, to: 18 * 60, label: '07:00–18:00', name: 'Giờ hành chính (dịch vụ ưu tiên)' },
  night: { from: 18 * 60, to: 7 * 60, label: '18:00–07:00', name: 'Ngoài giờ (hệ thống còn lại)' },
  any: { label: 'Cả ngày', name: 'Cả ngày (khi được Sở KH&CN chấp thuận)' },
};
// Lịch cơ quan và Giao nhiệm vụ (việc đơn vị VPUB) thuộc nhóm ưu tiên ban ngày; các mục còn lại là
// khai thác dữ liệu để thống kê, báo cáo nên chạy ngoài giờ. Quản trị có thể đổi trong tab Cấu hình.
const DEFAULT_WINDOWS = { 'qlvbdh.lich': 'day', vpub: 'day' };

const vnMin = (t = Date.now()) => {
  const d = new Date(t + VN_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

// Thời điểm (ms) gần nhất sau t mà đồng hồ Việt Nam chỉ đúng `min` phút trong ngày.
function nextAt(min, t = Date.now()) {
  const d = new Date(t + VN_OFFSET);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - VN_OFFSET + min * 60000;
  if (at <= t) at += 86400000;
  return at;
}

function windowOf(settings, item) {
  const w = { ...DEFAULT_WINDOWS, ...(settings.policy_windows || {}) };
  const v = w[item.key] || w[item.category.id] || 'night';
  return WINDOWS[v] ? v : 'night';
}

function inWindow(win, min) {
  const w = WINDOWS[win];
  if (!w || w.from == null) return true;
  return w.from < w.to ? min >= w.from && min < w.to : min >= w.from || min < w.to;
}

const allowedAt = (settings, item, min) => inWindow(windowOf(settings, item), min);

// Lý do mục không được gọi lúc t (null nếu được phép).
function windowReason(settings, item, t = Date.now()) {
  const win = windowOf(settings, item);
  if (inWindow(win, vnMin(t))) return null;
  const w = WINDOWS[win];
  return `"${item.name}" chỉ được kết nối trong khung ${w.label} theo ${DOC}, mở lại lúc ${fmtVN(nextAt(w.from, t))}`;
}

// Lúc khung giờ của mục đóng lại (Infinity nếu mục được chạy cả ngày).
function windowEnd(settings, item, t = Date.now()) {
  const w = WINDOWS[windowOf(settings, item)];
  return w.to == null ? Infinity : nextAt(w.to, t);
}

// ---------- Số lượt kết nối trong 60 phút ----------
const recent = new Map(); // xaId -> [mốc thời gian các lượt kết nối, tăng dần]

async function init() {
  for (const r of await store.loadRates()) recent.set(r._id, (r.ts || []).filter((x) => x > Date.now() - HOUR_MS));
}

const limitOf = (settings) => Math.max(1, Number(settings.policy_hourly_limit) || DEFAULT_HOURLY_LIMIT);

function prune(xaId, t) {
  const a = (recent.get(xaId) || []).filter((x) => x > t - HOUR_MS);
  recent.set(xaId, a);
  return a;
}

// Lúc còn đủ `need` lượt trống (Infinity nếu need lớn hơn cả giới hạn).
function freeAt(settings, xaId, need = 1, t = Date.now()) {
  const a = prune(xaId, t);
  const limit = limitOf(settings);
  if (need > limit) return Infinity;
  const expire = a.length - (limit - need); // số lượt cũ nhất phải hết hạn
  return expire <= 0 ? t : a[expire - 1] + HOUR_MS;
}

function hourly(settings, xaId, t = Date.now()) {
  const used = prune(xaId, t).length;
  const limit = limitOf(settings);
  return { used, limit, left: Math.max(0, limit - used), freeAt: used >= limit ? freeAt(settings, xaId, 1, t) : null };
}

function take(xaId) {
  const a = prune(xaId, Date.now());
  a.push(Date.now());
  store.saveRate({ _id: xaId, ts: a }).catch((e) => console.error('Không lưu được bộ đếm lượt/giờ:', e.message));
}

// Giữ chỗ một lượt kết nối cho xã. Hết lượt thì báo lỗi ngay, hoặc (đồng bộ tự động) chờ đến khi có lượt
// trống nhưng không quá `until`.
async function reserve(settings, xa, { wait = false, until = 0, onWait } = {}) {
  for (let announced = false; ;) {
    const h = hourly(settings, xa.id);
    if (h.left > 0) return take(xa.id);
    if (!wait || h.freeAt > until) {
      throw Object.assign(new Error(`Đã dùng đủ ${h.limit} lượt kết nối LGSP trong 60 phút qua (${DOC}: tối đa 50 lượt/giờ), kết nối tiếp được lúc ${fmtVN(h.freeAt)}`), { status: 429, policy: true });
    }
    if (!announced && onWait) onWait(h.freeAt);
    announced = true;
    await sleep(Math.min(60000, Math.max(1000, h.freeAt - Date.now() + 500)));
  }
}

// Thông tin quy định cho giao diện.
function describe(settings, items, xaList) {
  const min = vnMin();
  return {
    doc: DOC,
    hourlyLimit: limitOf(settings),
    windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, { label: w.label, name: w.name, open: inWindow(k, min) }])),
    itemWindows: Object.fromEntries(items.map((it) => [it.key, windowOf(settings, it)])),
    hourly: xaList.map((x) => ({ xaId: x.id, xaName: x.name, ...hourly(settings, x.id) })),
  };
}

module.exports = {
  DOC, WINDOWS, DEFAULT_HOURLY_LIMIT, init, windowOf, inWindow, allowedAt, windowReason, windowEnd,
  hourly, freeAt, reserve, describe,
};
