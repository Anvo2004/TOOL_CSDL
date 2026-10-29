// Chạy một tác vụ (xã, mục) có đếm lượt gọi API, và tự động đồng bộ nhiều lần mỗi ngày
// theo các mốc giờ chia đều trong khung giờ đã đặt (giờ Việt Nam), không vượt giới hạn lượt gọi.

const { ITEMS } = require('./catalog');
const { runItem } = require('./lgsp');
const usage = require('./usage');
const store = require('./store');
const { pad } = require('./util');

const VN_OFFSET = 7 * 3600000;
const CHECK_EVERY_MS = 30000;
const LATE_TOLERANCE_MIN = 30; // máy chủ khởi động muộn hơn mốc giờ quá 30 phút thì bỏ qua mốc đó

async function executeTask({ settings, xa, item, from, to, autoSave = false, source = 'manual', log = () => {} }) {
  const started = Date.now();
  const base = {
    xaId: xa.id, xaName: xa.name, itemKey: item.key, itemName: item.name, categoryName: item.category.name,
    from: item.dated ? from : null, to: item.dated ? to : null, startedAt: new Date(started).toISOString(), source,
  };
  // limited: dừng khi chạm giới hạn lượt tự đặt (đồng bộ tự động và chạy lặp).
  const m = { auto: source === 'auto', limited: source !== 'manual', calls: 0, ok: 0, err: 0 };
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
  await store.appendHistory(entry);
  return entry;
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

function slotsOf(s) {
  const n = Math.min(48, Math.max(1, Number(s.auto_runs_per_day) || 1));
  const start = toMin(s.auto_start);
  const end = toMin(s.auto_end);
  if (end <= start || n === 1) return [start];
  return [...new Set(Array.from({ length: n }, (_, i) => Math.round(start + (i * (end - start)) / (n - 1))))];
}

// Ước lượng số lượt gọi một tác vụ cần: QLVBDH = gửi yêu cầu + vài lần lấy kết quả job cho mỗi đoạn 7 ngày.
function estimateCost(item, days) {
  if (item.kind !== 'qlvbdh') return 1;
  return 3 * (item.dated ? Math.ceil(days / (item.maxDays || days)) : 1);
}

// ---------- Một lượt đồng bộ ----------
const state = { running: false, current: null, doneSlots: new Set(), lastRun: null };

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function runSync({ trigger = 'auto', slot = null } = {}) {
  if (state.running) throw Object.assign(new Error('Đang có một lượt đồng bộ chạy'), { status: 409 });
  state.running = true;
  const cfg = await store.loadConfig();
  const s = cfg.settings;
  const days = Math.max(1, Number(s.auto_days) || 7);
  const to = vnNow().day;
  const from = shiftDay(to, -(days - 1));
  const xas = cfg.xa.filter((x) => !(s.auto_xa || []).length || s.auto_xa.includes(x.id));
  const items = (s.auto_items || []).map((k) => ITEMS.get(k)).filter(Boolean);
  const queue = [];
  for (const xa of xas) for (const item of items) queue.push({ xa, item });

  const run = { trigger, slot, startedAt: new Date().toISOString(), from, to, total: queue.length, done: 0, tasks: [] };
  state.current = run;
  const worker = async () => {
    while (queue.length) {
      const { xa, item } = queue.shift();
      const t = { xaId: xa.id, xaName: xa.name, itemKey: item.key, itemName: item.name };
      const reason = usage.skipReason(s, xa, item.category.id, estimateCost(item, days));
      if (reason) {
        run.tasks.push({ ...t, status: 'skipped', count: 0, calls: 0, error: reason });
      } else {
        const e = await executeTask({ settings: s, xa, item, from, to, source: 'auto' });
        run.tasks.push({ ...t, status: e.ok ? 'ok' : 'error', count: e.count, calls: e.calls, callsOk: e.callsOk, callsErr: e.callsErr, durationMs: e.durationMs, error: e.error });
      }
      run.done++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(s.auto_concurrency) || 2), queue.length || 1) }, worker));
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
    state.lastRun = run;
    state.current = null;
    state.running = false;
    console.log(`[Đồng bộ ${trigger}${slot ? ' ' + slot : ''}] ${run.ok} thành công, ${run.error} lỗi, ${run.skipped} bỏ qua, ${run.calls} lượt gọi API`);
  }
  return run;
}

// ---------- Lịch tự chạy ----------
async function tick() {
  if (state.running) return;
  const cfg = await store.loadConfig();
  if (!cfg.settings.auto_enabled) return;
  const now = vnNow();
  const due = slotsOf(cfg.settings).filter((m) => m <= now.min && now.min - m <= LATE_TOLERANCE_MIN).pop();
  if (due == null) return;
  const slot = `${now.day} ${hhmm(due)}`;
  if (state.doneSlots.has(slot)) return;
  state.doneSlots.add(slot);
  await runSync({ trigger: 'auto', slot });
}

async function startScheduler() {
  for (const r of await store.readSyncRuns(100)) if (r.slot) state.doneSlots.add(r.slot);
  state.lastRun = (await store.readSyncRuns(1))[0] || null;
  setInterval(() => tick().catch((e) => console.error('Lỗi lịch đồng bộ:', e.message)), CHECK_EVERY_MS);
}

function status(settings) {
  const now = vnNow();
  const slots = slotsOf(settings).map((m) => {
    const key = `${now.day} ${hhmm(m)}`;
    const st = state.doneSlots.has(key) ? 'done' : m < now.min - LATE_TOLERANCE_MIN ? 'missed' : 'pending';
    return { time: hhmm(m), status: state.current && state.current.slot === key ? 'running' : st };
  });
  const next = settings.auto_enabled ? slots.find((x) => x.status === 'pending') : null;
  return {
    enabled: !!settings.auto_enabled, today: now.day, slots, next: next ? next.time : null,
    running: state.running, current: state.current && { trigger: state.current.trigger, done: state.current.done, total: state.current.total },
    lastRun: state.lastRun,
  };
}

const AUTO_KEYS = ['auto_enabled', 'auto_runs_per_day', 'auto_start', 'auto_end', 'auto_days', 'auto_items', 'auto_xa',
  'auto_concurrency', 'auto_limit_enabled', 'auto_safety_pct', 'auto_default_limit', 'auto_daily_limit'];

async function saveAutoSettings(input) {
  const p = {};
  for (const k of AUTO_KEYS) if (k in input) p[k] = input[k];
  for (const k of ['auto_enabled', 'auto_limit_enabled']) if (k in p) p[k] = !!p[k];
  const num = (k, lo, hi) => { if (k in p) p[k] = Math.min(hi, Math.max(lo, Math.round(Number(p[k]) || 0))); };
  num('auto_runs_per_day', 1, 48);
  num('auto_days', 1, 31);
  num('auto_concurrency', 1, 4);
  num('auto_safety_pct', 10, 100);
  num('auto_default_limit', 1, 100000);
  num('auto_daily_limit', 0, 100000);
  for (const k of ['auto_start', 'auto_end']) if (k in p) p[k] = hhmm(toMin(p[k]));
  if ('auto_items' in p) p.auto_items = (p.auto_items || []).filter((k) => ITEMS.has(k));
  if ('auto_xa' in p) p.auto_xa = (p.auto_xa || []).map(String);
  await store.patchSettings(p);
}

module.exports = { executeTask, estimateCost, runSync, startScheduler, status, saveAutoSettings, AUTO_KEYS };
