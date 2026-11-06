// Chạy một tác vụ (xã, mục) có đếm lượt gọi API, và đồng bộ tự động theo lịch riêng của từng xã.
// Mỗi xã tự đặt các mốc giờ (giờ Việt Nam), số ngày dữ liệu và các mục cần lấy. Đến mốc nào thì chỉ chạy
// các mục được phép trong khung giờ đó (lib/policy.js), lần lượt từng mục; khi đã dùng đủ số lượt kết nối
// trong giờ thì chờ đến khi có lượt trống chứ không gọi vượt.
// Chế độ "liên tục mỗi giờ" (mode = 'hourly'): mỗi giờ chạy lặp các mục được phép trong khung giờ đó, rải đều
// trong giờ cho đến khi dùng hết số lượt kết nối của giờ, rồi giờ sau chạy tiếp, suốt 24 giờ.

const { ITEMS } = require('./catalog');
const { runItem } = require('./lgsp');
const usage = require('./usage');
const policy = require('./policy');
const store = require('./store');
const { pad, fmtVN, sleep } = require('./util');

const VN_OFFSET = 7 * 3600000;
const CHECK_EVERY_MS = 30000;
const LATE_TOLERANCE_MIN = 30; // máy chủ khởi động muộn hơn mốc giờ quá 30 phút thì bỏ qua mốc đó
const MAX_WAIT_MS = 2 * 3600000; // đồng bộ tự động chờ lượt trống tối đa 2 giờ
const MAX_TIMES = 24;
const HOUR_MS = 3600000;
const MIN_GAP_MS = 5000; // chế độ mỗi giờ: nghỉ ít nhất 5 giây giữa hai tác vụ
const DEFAULT_AUTO = { enabled: false, mode: 'times', times: ['08:00', '14:00', '19:00', '23:00'], items: ['qlvbdh.vbden', 'qlvbdh.vbdi', 'qlvbdh.lich', 'gopy.gopy'], days: 7 };

async function executeTask({ settings, xa, item, from, to, autoSave = false, source = 'manual', log = () => {}, waitUntil = null, history = true }) {
  const started = Date.now();
  const base = {
    xaId: xa.id, xaName: xa.name, itemKey: item.key, itemName: item.name, categoryName: item.category.name,
    from: item.dated ? from : null, to: item.dated ? to : null, startedAt: new Date(started).toISOString(), source,
  };
  // Đồng bộ tự động chờ lượt trống trong giờ (không quá lúc khung giờ của mục đóng lại); truy vấn tay thì báo lỗi ngay.
  const m = { auto: source === 'auto', item, calls: 0, ok: 0, err: 0 };
  if (m.auto) {
    Object.assign(m, {
      wait: true,
      waitUntil: Math.min(policy.windowEnd(settings, item), waitUntil || started + MAX_WAIT_MS),
      onWait: (t) => log(`  đã dùng đủ lượt trong giờ, chờ đến ${fmtVN(t)}`),
    });
  }
  let entry;
  try {
    const { rows, warnings } = await usage.meter.run(m, () => runItem({ settings, xa, item, from, to, log }));
    const durationMs = Date.now() - started;
    const result = { ...base, ok: true, count: rows.length, durationMs, warnings, rows };
    await store.saveResult(result);
    const files = autoSave && rows.length ? store.exportFiles(result) : [];
    entry = { ...base, ok: true, count: rows.length, durationMs, warnings, files };
  } catch (e) {
    entry = { ...base, ok: false, count: 0, durationMs: Date.now() - started, error: e.message, warnings: [], files: [] };
  }
  Object.assign(entry, { calls: m.calls, callsOk: m.ok, callsErr: m.err });
  if (m.calls) usage.countTask(xa, item.category.id, entry.ok);
  if (history) await store.appendHistory(entry);
  return entry;
}

// Ước lượng số lượt gọi một tác vụ cần: QLVBDH = gửi yêu cầu + vài lần hỏi kết quả job cho mỗi đoạn 7 ngày.
function estimateCost(item, days) {
  if (item.kind !== 'qlvbdh') return 1;
  return 4 * (item.dated ? Math.ceil(days / (item.maxDays || days)) : 1);
}

// Lý do không bắt đầu tác vụ (null nếu chạy được). waitHourly: đồng bộ tự động sẽ tự chờ lượt trống nên
// không cần còn đủ lượt ngay lúc bắt đầu.
function taskReason(settings, xa, item, cost, { waitHourly = false } = {}) {
  const reason = policy.windowReason(settings, item) || usage.blockedReason(xa, item.category.id);
  if (reason) return reason;
  const h = policy.hourly(settings, xa.id);
  if (cost > h.limit) return `Tác vụ cần khoảng ${cost} lượt kết nối, nhiều hơn giới hạn ${h.limit} lượt/giờ: hãy chia nhỏ khoảng ngày`;
  if (!waitHourly && h.left < cost) {
    return `Còn ${h.left}/${h.limit} lượt kết nối trong 60 phút, tác vụ cần khoảng ${cost}; chạy lại được lúc ${fmtVN(policy.freeAt(settings, xa.id, cost))}`;
  }
  return null;
}

// ---------- Mốc giờ trong ngày (giờ Việt Nam) ----------
const vnNow = (t = Date.now()) => {
  const d = new Date(t + VN_OFFSET);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? Math.min(1439, Math.max(0, h * 60 + (m || 0))) : 0;
};
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const clampInt = (v, lo, hi, def) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || def));

// "8:00, 19h30 ,23:00" hoặc ['08:00', ...] -> ['08:00', '19:30', '23:00'] (sắp xếp, bỏ trùng)
function normTimes(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/);
  const mins = [];
  for (const s of list) {
    const m = String(s).trim().match(/^(\d{1,2})(?:[:hH](\d{1,2})?)?$/);
    if (m && +m[1] < 24 && +(m[2] || 0) < 60) mins.push(+m[1] * 60 + +(m[2] || 0));
  }
  return [...new Set(mins)].sort((a, b) => a - b).slice(0, MAX_TIMES).map(hhmm);
}

// Bản trước đặt một lịch chung cho mọi xã (settings.auto_*): dùng làm lịch ban đầu cho đến khi xã lưu lịch riêng.
function legacyAuto(s, xa) {
  if (!('auto_enabled' in s)) return DEFAULT_AUTO;
  const n = Math.min(48, Math.max(1, Number(s.auto_runs_per_day) || 1));
  const start = toMin(s.auto_start || '07:30');
  const end = toMin(s.auto_end || '21:30');
  const times = end <= start || n === 1 ? [start] : Array.from({ length: n }, (_, i) => Math.round(start + (i * (end - start)) / (n - 1)));
  return {
    enabled: !!s.auto_enabled && (!(s.auto_xa || []).length || s.auto_xa.includes(xa.id)),
    times: times.map(hhmm), items: s.auto_items || DEFAULT_AUTO.items, days: s.auto_days || 7,
  };
}

function autoOf(settings, xa) {
  const a = xa.auto || legacyAuto(settings, xa);
  return {
    enabled: !!a.enabled,
    mode: a.mode === 'hourly' ? 'hourly' : 'times',
    times: normTimes(a.times),
    items: (a.items || []).filter((k) => ITEMS.has(k)),
    days: clampInt(a.days, 1, 31, 7),
  };
}

// ---------- Một lượt đồng bộ của một xã ----------
const state = { running: new Map(), doneSlots: new Set(), lastRun: new Map(), cancel: new Set() };

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function runSync({ xaId, trigger = 'auto', slot = null }) {
  if (state.running.has(xaId)) throw Object.assign(new Error('Xã này đang có một lượt đồng bộ chạy'), { status: 409 });
  const cfg = await store.loadConfig();
  const s = cfg.settings;
  const xa = cfg.xa.find((x) => x.id === xaId);
  if (!xa) throw Object.assign(new Error(`Không tìm thấy xã: ${xaId}`), { status: 404 });
  const a = autoOf(s, xa);
  const to = vnNow().day;
  const from = shiftDay(to, -(a.days - 1));
  const items = a.items.map((k) => ITEMS.get(k));
  const hourly = a.mode === 'hourly' && trigger === 'auto';

  const run = {
    xaId, xaName: xa.name, trigger, slot, mode: hourly ? 'hourly' : 'times', startedAt: new Date().toISOString(),
    from, to, total: items.length, done: 0, runs: 0, calls: 0, tasks: [],
  };
  state.running.set(xaId, run);
  state.cancel.delete(xaId);
  try {
    if (hourly) {
      await runHour(s, xa, a, items, run);
      return run;
    }
    // Lần lượt từng mục: cùng một khóa LGSP và tài khoản CSDL chỉ giữ một phiên.
    for (const item of items) {
      const t = { xaId, xaName: xa.name, itemKey: item.key, itemName: item.name };
      const reason = taskReason(s, xa, item, estimateCost(item, a.days), { waitHourly: true });
      if (reason) {
        run.tasks.push({ ...t, status: 'skipped', count: 0, calls: 0, error: reason });
      } else {
        const e = await executeTask({ settings: s, xa, item, from, to, source: 'auto' });
        run.tasks.push({ ...t, status: e.ok ? 'ok' : 'error', count: e.count, calls: e.calls, callsOk: e.callsOk, callsErr: e.callsErr, durationMs: e.durationMs, error: e.error });
        run.calls += e.calls;
      }
      run.done++;
      run.runs++;
    }
  } finally {
    const sum = (f) => run.tasks.reduce((n, t) => n + (t[f] || 0), 0);
    Object.assign(run, {
      finishedAt: new Date().toISOString(),
      ok: run.tasks.filter((t) => t.status === 'ok').length,
      error: run.tasks.filter((t) => t.status === 'error').length,
      skipped: run.tasks.filter((t) => t.status === 'skipped').length,
      rows: sum('count'), calls: sum('calls'), callsOk: sum('callsOk'), callsErr: sum('callsErr'),
    });
    await store.appendSyncRun(run).catch((e) => console.error('Không lưu được lượt đồng bộ:', e.message));
    state.lastRun.set(xaId, run);
    state.running.delete(xaId);
    state.cancel.delete(xaId);
    console.log(`[Đồng bộ ${xa.name} ${trigger}${slot ? ' ' + slot : ''}] ${run.runs} lần chạy, ${run.ok} thành công, ${run.error} lỗi, ${run.skipped} bỏ qua, ${run.calls} lượt gọi API`);
  }
  return run;
}

// Lúc bắt đầu giờ tiếp theo (giờ Việt Nam).
const nextHourAt = (t = Date.now()) => Math.floor((t + VN_OFFSET) / HOUR_MS + 1) * HOUR_MS - VN_OFFSET;

// Ngủ đến lúc `until` nhưng dừng sớm nếu lịch của xã bị tắt / đổi chế độ.
async function nap(xaId, until) {
  while (Date.now() < until && !state.cancel.has(xaId)) await sleep(Math.min(30000, until - Date.now()));
}

// Chế độ mỗi giờ: chạy lặp vòng tròn các mục được phép, rải đều trong giờ cho đến khi hết lượt của giờ.
// Mục bị lỗi (chưa đăng ký API, sai tài khoản...) hoặc bị LGSP chặn hạn mức ngày thì bỏ khỏi vòng của giờ đó.
async function runHour(s, xa, a, items, run) {
  const hourEnd = nextHourAt();
  const stopAt = hourEnd - 60000;
  const agg = new Map();
  const rec = (item) => {
    if (!agg.has(item.key)) {
      const t = { xaId: xa.id, xaName: xa.name, itemKey: item.key, itemName: item.name, status: 'skipped', runs: 0, count: 0, calls: 0, callsOk: 0, callsErr: 0 };
      agg.set(item.key, t);
      run.tasks.push(t);
    }
    return agg.get(item.key);
  };
  let pool = items.filter((item) => {
    const reason = taskReason(s, xa, item, estimateCost(item, a.days), { waitHourly: true });
    if (reason) Object.assign(rec(item), { error: reason });
    return !reason;
  });
  pool.forEach(rec);
  run.total = pool.length;
  for (let i = 0; pool.length && Date.now() < stopAt && !state.cancel.has(xa.id);) {
    const item = pool[i % pool.length];
    const cost = estimateCost(item, a.days);
    const t = rec(item);
    const reason = policy.windowReason(s, item) || usage.blockedReason(xa, item.category.id);
    if (reason) {
      if (!t.runs) t.error = reason;
      pool = pool.filter((x) => x !== item);
      continue;
    }
    // Chờ có đủ lượt trống; không còn trong giờ này thì để giờ sau.
    const at = policy.freeAt(s, xa.id, cost);
    if (at > stopAt) break;
    if (at > Date.now()) {
      await nap(xa.id, at + 500);
      continue;
    }
    const to = vnNow().day;
    const e = await executeTask({
      settings: s, xa, item, from: shiftDay(to, -(a.days - 1)), to, source: 'auto', waitUntil: stopAt,
      history: t.runs === 0, // lịch sử chỉ ghi lần chạy đầu của mỗi mục trong giờ
    });
    Object.assign(t, {
      status: e.ok ? 'ok' : 'error', runs: t.runs + 1, count: e.count, calls: t.calls + e.calls,
      callsOk: t.callsOk + e.callsOk, callsErr: t.callsErr + e.callsErr, durationMs: e.durationMs, error: e.error,
    });
    run.runs++;
    run.calls += e.calls;
    if (!e.ok) pool = pool.filter((x) => x !== item);
    else i++;
    run.done = run.runs;
    // Rải đều: chia thời gian còn lại của giờ cho số lượt giờ này còn được dùng. Lượt của giờ trước hết hạn
    // dần trong cửa sổ 60 phút nên lúc chạy thật vẫn kiểm tra freeAt ở trên.
    const left = policy.hourly(s, xa.id).limit - run.calls;
    const rest = stopAt - Date.now();
    const gap = Math.max(MIN_GAP_MS, Math.min(rest, (rest * Math.max(1, e.calls)) / Math.max(1, left)));
    await nap(xa.id, Date.now() + gap);
  }
  for (const t of agg.values()) {
    if (!t.runs && !t.error) t.error = state.cancel.has(xa.id) ? 'Lịch đã tắt trước khi đến lượt mục này' : 'Đã dùng hết lượt kết nối của giờ trước khi đến lượt mục này';
  }
}

// ---------- Lịch tự chạy: mỗi xã một lịch, các xã chạy song song (mỗi xã một khóa riêng) ----------
async function tick() {
  const cfg = await store.loadConfig();
  const now = vnNow();
  for (const xa of cfg.xa) {
    if (state.running.has(xa.id)) continue;
    const a = autoOf(cfg.settings, xa);
    if (!a.enabled || !a.items.length) continue;
    const due = a.mode === 'hourly'
      ? (now.min % 60 <= 55 ? now.min - (now.min % 60) : null)
      : a.times.map(toMin).filter((m) => m <= now.min && now.min - m <= LATE_TOLERANCE_MIN).pop();
    if (due == null) continue;
    const slot = `${now.day} ${hhmm(due)}`;
    const key = `${xa.id}|${slot}`;
    if (state.doneSlots.has(key)) continue;
    state.doneSlots.add(key);
    runSync({ xaId: xa.id, trigger: 'auto', slot }).catch((e) => console.error(`Lỗi đồng bộ ${xa.name}:`, e.message));
  }
}

async function startScheduler() {
  for (const r of await store.readSyncRuns(1000)) {
    if (!r.xaId) continue;
    if (r.slot) state.doneSlots.add(`${r.xaId}|${r.slot}`);
    if (!state.lastRun.has(r.xaId)) state.lastRun.set(r.xaId, r);
  }
  setInterval(() => tick().catch((e) => console.error('Lỗi lịch đồng bộ:', e.message)), CHECK_EVERY_MS);
}

function status(settings, xa) {
  const a = autoOf(settings, xa);
  const now = vnNow();
  const run = state.running.get(xa.id);
  const hourlyMode = a.mode === 'hourly';
  const times = hourlyMode ? Array.from({ length: 24 }, (_, h) => hhmm(h * 60)) : a.times;
  const limit = policy.hourly(settings, xa.id).limit;
  const slots = times.map((time) => {
    const m = toMin(time);
    const slot = `${now.day} ${time}`;
    const items = a.items.map((k) => ITEMS.get(k)).filter((it) => policy.allowedAt(settings, it, m));
    const late = hourlyMode ? m + 60 <= now.min : m < now.min - LATE_TOLERANCE_MIN;
    const st = run && run.slot === slot ? 'running' : state.doneSlots.has(`${xa.id}|${slot}`) ? 'done' : late ? 'missed' : 'pending';
    const cost = hourlyMode ? (items.length ? limit : 0) : items.reduce((n, it) => n + estimateCost(it, a.days), 0);
    return { time, status: st, items: items.length, cost };
  });
  const next = a.enabled ? slots.find((x) => x.status === 'pending') : null;
  // Mục đã chọn nhưng không có mốc giờ nào nằm trong khung được phép của nó.
  const unscheduled = a.items.filter((k) => !times.some((t) => policy.allowedAt(settings, ITEMS.get(k), toMin(t))));
  return {
    xaId: xa.id, xaName: xa.name, auto: a, today: now.day, slots, next: next ? next.time : null, unscheduled,
    running: !!run, current: run && { trigger: run.trigger, mode: run.mode, slot: run.slot, done: run.done, total: run.total, runs: run.runs, calls: run.calls },
    hourUsed: policy.hourly(settings, xa.id),
    lastRun: state.lastRun.get(xa.id) || null,
  };
}

async function saveAuto(xaId, input) {
  const mode = input.mode === 'hourly' ? 'hourly' : 'times';
  const run = state.running.get(xaId);
  // Tắt lịch hoặc đổi chế độ thì dừng vòng chạy mỗi giờ đang dở.
  if (run && run.mode === 'hourly' && (!input.enabled || mode !== 'hourly')) state.cancel.add(xaId);
  await store.setXaAuto(xaId, {
    enabled: !!input.enabled,
    mode,
    times: normTimes(input.times),
    items: (input.items || []).filter((k) => ITEMS.has(k)),
    days: clampInt(input.days, 1, 31, 7),
  });
}

module.exports = { executeTask, estimateCost, taskReason, runSync, startScheduler, status, saveAuto };
