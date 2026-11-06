// Đếm lượt gọi API LGSP theo (ngày, xã, hệ thống) và theo dõi hạn mức (quota) ngày của từng khóa.
// LGSP (WSO2) đặt lại hạn mức ngày lúc 00:00 UTC = 7:00 sáng giờ Việt Nam, nên "ngày" ở đây là ngày UTC.
// Lỗi 900804 là hạn mức của từng API mà khóa đăng ký, nên mỗi hệ thống (QLVBDH, Góp ý, VPUB...) đếm riêng;
// 900803 là hạn mức chung của cả ứng dụng, khi đó khóa toàn bộ các hệ thống của xã.
// Trước mỗi lượt gọi còn kiểm tra quy định kết nối của thành phố (lượt/giờ, khung giờ) — xem lib/policy.js.

const { AsyncLocalStorage } = require('async_hooks');
const store = require('./store');
const policy = require('./policy');
const { fmtVN } = require('./util');

const SYSTEMS = {
  qlvbdh: { base: 'base_qlvbdh', name: 'QLVBDH' },
  gopy: { base: 'base_gopy', name: 'Góp ý' },
  vpub: { base: 'base_vpub', name: 'VPUB' },
  ttdh: { base: 'base_ttdh', name: 'Cổng TTĐT' },
  csdlpx: { base: 'base_csdlpx', name: 'CSDL PX' },
};
const sysName = (sys) => (SYSTEMS[sys] || {}).name || (sys === '*' ? 'tất cả hệ thống' : sys);

// Bộ đếm của một tác vụ đang chạy: { auto, item, wait, waitUntil, onWait, calls, ok, err }. Truyền ngầm qua các lời gọi async.
const meter = new AsyncLocalStorage();
const counters = new Map(); // 'ngày|xã|hệ thống' -> bộ đếm trong ngày
const quotas = new Map(); // 'xã|hệ thống' -> { quota, source, observed[], blockedUntil, code }

const quotaDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const EMPTY = { calls: 0, ok: 0, err: 0, throttled: 0, auto: 0, tasksOk: 0, tasksErr: 0 };

async function init() {
  for (const q of await store.loadQuotas()) quotas.set(q._id, q);
  for (const u of await store.readUsage(quotaDay())) counters.set(u._id, { ...EMPTY, ...u });
}

function sysOf(settings, url) {
  const u = url.toLowerCase();
  for (const [sys, s] of Object.entries(SYSTEMS)) if (settings[s.base] && u.startsWith(settings[s.base].toLowerCase())) return sys;
  return 'other';
}

const counts = (xaId, sys, day = quotaDay()) => counters.get(`${day}|${xaId}|${sys}`) || { ...EMPTY };
// Lượt bị 429 không bị trừ vào hạn mức.
const used = (c) => c.calls - c.throttled;

function bump(xaId, sys, inc) {
  const day = quotaDay();
  const _id = `${day}|${xaId}|${sys}`;
  const c = counters.get(_id) || { _id, day, xaId, sys, ...EMPTY };
  for (const [k, v] of Object.entries(inc)) c[k] += v;
  counters.set(_id, c);
  for (const k of counters.keys()) if (!k.startsWith(day)) counters.delete(k);
  store.incUsage(c, inc).catch((e) => console.error('Không lưu được bộ đếm lượt gọi:', e.message));
  return c;
}

function blockedUntil(xaId, sys) {
  const t = Math.max(...[`${xaId}|${sys}`, `${xaId}|*`].map((k) => Date.parse((quotas.get(k) || {}).blockedUntil || '') || 0));
  return t > Date.now() ? t : 0;
}

// Lý do không gửi yêu cầu vì LGSP đang khóa hạn mức ngày của (xã, hệ thống); null nếu không bị khóa.
function blockedReason(xa, sys) {
  const b = blockedUntil(xa.id, sys);
  return b ? `LGSP đang khóa ${sysName(sys)} của xã do hết hạn mức ngày, gọi lại được sau ${fmtVN(b)}` : null;
}

// Gọi ngay trước mỗi lượt gọi API: chặn khi LGSP đang khóa, khi mục đang ngoài khung giờ được phép,
// và giữ chỗ một lượt trong giới hạn lượt/giờ (đồng bộ tự động thì chờ đến khi có lượt trống).
async function before(settings, xa, sys) {
  const blocked = blockedReason(xa, sys);
  if (blocked) throw Object.assign(new Error(`${blocked} (không gửi yêu cầu để khỏi tốn lượt)`), { status: 429 });
  const m = meter.getStore();
  if (m && m.item) {
    const reason = policy.windowReason(settings, m.item);
    if (reason) throw Object.assign(new Error(reason), { policy: true });
  }
  await policy.reserve(settings, xa, waitOpts(m));
}

const waitOpts = (m) => (m && m.wait ? { wait: true, until: m.waitUntil, onWait: m.onWait } : {});

// Lấy token cũng là một lượt kết nối đến Trục LGSP.
const beforeToken = (settings, xa) => policy.reserve(settings, xa, waitOpts(meter.getStore()));

// Gọi sau mỗi lượt gọi API (r = null nếu không kết nối được).
function after(settings, xa, sys, r) {
  const ok = !!(r && r.ok);
  const m = meter.getStore();
  const c = bump(xa.id, sys, { calls: 1, ok: ok ? 1 : 0, err: ok ? 0 : 1, throttled: r && r.status === 429 ? 1 : 0, auto: m && m.auto ? 1 : 0 });
  if (m) { m.calls++; ok ? m.ok++ : m.err++; }
  if (!r) return;
  if (r.status === 429) onThrottled(xa, sys, r, c);
  else if (r.headers) readLimitHeader(xa, sys, r.headers);
}

function countTask(xa, sys, ok) {
  bump(xa.id, sys, ok ? { tasksOk: 1 } : { tasksErr: 1 });
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "2026-Oct-30 00:00:00+0000 UTC" -> mốc thời gian (ms)
function parseNextAccess(s) {
  const m = String(s || '').match(/(\d{4})-([A-Za-z]{3})-(\d{1,2})\D+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return Date.parse(s) || 0;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  return mon < 0 ? 0 : Date.UTC(+m[1], mon, +m[3], +m[4], +m[5], +m[6]);
}

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function saveQuota(q) {
  quotas.set(q._id, q);
  store.saveQuota(q).catch((e) => console.error('Không lưu được hạn mức:', e.message));
}

// Tự dò hạn mức ngày: lần đầu bị 429 trong ngày, số lượt đã gọi thành công trước đó chính là hạn mức
// (chỉ tính lượt gọi từ web; nếu Postman cũng gọi bằng khóa này thì hạn mức thật còn lớn hơn).
// Giữ giá trị lớn nhất trong 10 lần quan sát gần nhất.
function onThrottled(xa, sys, r, c) {
  const j = r.json && typeof r.json === 'object' ? r.json : {};
  const code = String(j.code || '');
  const scope = code === '900803' ? '*' : sys;
  const _id = `${xa.id}|${scope}`;
  const q = { _id, xaId: xa.id, sys: scope, observed: [], ...(quotas.get(_id) || {}) };
  const wasBlocked = Date.parse(q.blockedUntil || '') > Date.now();
  q.blockedUntil = new Date(parseNextAccess(j.nextAccessTime) || nextUtcMidnight()).toISOString();
  q.code = code;
  if (!wasBlocked) {
    const n = scope === '*' ? Object.keys(SYSTEMS).reduce((s, k) => s + used(counts(xa.id, k)), 0) : used(c);
    if (n > 0) {
      q.observed = [...q.observed, { day: c.day, used: n, at: new Date().toISOString() }].slice(-10);
      if (q.source !== 'header') {
        q.quota = Math.max(...q.observed.map((o) => o.used));
        q.source = '429';
      }
    }
  }
  saveQuota(q);
}

// Nếu cổng API trả header giới hạn (X-RateLimit-Limit...) thì lấy luôn hạn mức chính xác.
function readLimitHeader(xa, sys, headers) {
  const lim = Number(headers.get('x-ratelimit-limit') || headers.get('ratelimit-limit') || 0);
  if (!(lim > 0)) return;
  const _id = `${xa.id}|${sys}`;
  const q = quotas.get(_id) || { _id, xaId: xa.id, sys, observed: [] };
  if (q.quota === lim && q.source === 'header') return;
  saveQuota({ ...q, quota: lim, source: 'header' });
}

function unblock(xaId, sys) {
  for (const k of [`${xaId}|${sys}`, `${xaId}|*`]) {
    const q = quotas.get(k);
    if (q && q.blockedUntil) saveQuota({ ...q, blockedUntil: null });
  }
}

// Bảng lượt gọi và hạn mức ngày hôm nay cho giao diện.
function snapshot(xaList) {
  const rows = [];
  for (const xa of xaList) {
    for (const sys of Object.keys(SYSTEMS)) {
      const c = counts(xa.id, sys);
      const q = quotas.get(`${xa.id}|${sys}`) || {};
      rows.push({
        xaId: xa.id, xaName: xa.name, sys, sysName: sysName(sys),
        calls: c.calls, ok: c.ok, err: c.err, throttled: c.throttled, auto: c.auto, tasksOk: c.tasksOk, tasksErr: c.tasksErr,
        used: used(c), quota: q.quota || null, quotaSource: q.source || null,
        observed: q.observed || [], blockedUntil: blockedUntil(xa.id, sys) || null,
      });
    }
  }
  return rows;
}

// Tổng hợp theo ngày và theo xã trong `days` ngày gần nhất (xaIds = chỉ các xã này).
async function report(days = 30, xaIds = null) {
  const from = quotaDay(Date.now() - (days - 1) * 86400000);
  const docs = (await store.readUsage(from)).filter((u) => !xaIds || xaIds.includes(u.xaId));
  const add = (acc, u) => { for (const k of Object.keys(EMPTY)) acc[k] = (acc[k] || 0) + (u[k] || 0); return acc; };
  const byDay = new Map();
  const byXa = new Map();
  for (const u of docs) {
    add(byDay.get(u.day) || byDay.set(u.day, { day: u.day }).get(u.day), u);
    add(byXa.get(u.xaId) || byXa.set(u.xaId, { xaId: u.xaId }).get(u.xaId), u);
  }
  const daily = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const since = (n) => daily.filter((d) => d.day >= quotaDay(Date.now() - (n - 1) * 86400000)).reduce(add, {});
  return { daily, byXa: [...byXa.values()], totals: { today: since(1), week: since(7), month: since(30) } };
}

module.exports = {
  SYSTEMS, sysName, meter, init, sysOf, quotaDay, before, beforeToken, after, countTask, blockedReason, unblock, snapshot, report, nextUtcMidnight,
};
