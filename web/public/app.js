// Giao diện truy vấn LGSP: chọn danh mục + xã, chạy truy vấn qua máy chủ cục bộ, thống kê và xuất dữ liệu.

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString('vi-VN');
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const viDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const fmtDur = (ms) => (ms == null ? '–' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}p ${Math.round((ms % 60000) / 1000)}s`);
const fmtTime = (t) => (t ? new Date(t).toLocaleString('vi-VN', { hour12: false }) : '');
const taskKey = (xaId, itemKey) => `${xaId}|${itemKey}`;

const STATUS_LABEL = { ok: 'Thành công', error: 'Lỗi', running: 'Đang chạy', queued: 'Đang chờ', pending: 'Chưa chạy', skipped: 'Bỏ qua' };
const SOURCE_LABEL = { manual: 'Thủ công', auto: 'Tự động', runner: 'Chạy lặp' };

const S = {
  catalog: [],
  items: new Map(),
  config: { settings: {}, xa: [] },
  selItems: new Set(),
  selXa: new Set(),
  tasks: new Map(),
  running: false,
  stopRequested: false,
  controllers: new Set(),
  run: null,
  view: 'list',
  preset: '7',
  nextRunAt: null,
  history: [],
  viewer: null,
};

// ---------- Lưu lựa chọn của người dùng trên trình duyệt ----------
const PREF_KEY = 'lgsp-tool-prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      items: [...S.selItems], xa: [...S.selXa], from: $('#from').value, to: $('#to').value, preset: S.preset,
      autosave: $('#opt-autosave').checked, autoexcel: $('#opt-autoexcel').checked,
      interval: $('#opt-interval').value, concurrency: $('#opt-concurrency').value, view: S.view,
      iter: $('#opt-iter').value, delay: $('#opt-delay').value,
    }));
  } catch { /* trình duyệt chặn lưu trữ: bỏ qua */ }
}

// ---------- Gọi máy chủ ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) {
    location.reload(); // hết phiên đăng nhập → máy chủ trả trang đăng nhập
    throw new Error('Phiên đăng nhập đã hết hạn');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function log(msg, cls = '') {
  const el = $('#log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString('vi-VN', { hour12: false })}] ${msg}`;
  el.appendChild(line);
  while (el.childNodes.length > 1500) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ---------- Khởi tạo ----------
async function init() {
  const prefs = loadPrefs();
  const [info, catalog, config, stats] = await Promise.all([api('/api/info'), api('/api/catalog'), api('/api/config'), api('/api/stats')]);
  if (info.auth) {
    $('#btn-logout').classList.remove('hidden');
    $('#btn-logout').title = `Đăng xuất (${info.user})`;
  }
  if (info.storage === 'mongo') {
    // Trên máy chủ, kết quả mới nhất nằm trong CSDL và tải lại được bất cứ lúc nào — không lưu file ra ổ đĩa.
    $('#opt-autosave').checked = false;
    $('#opt-autosave').closest('label').classList.add('hidden');
  }
  S.catalog = catalog;
  for (const cat of catalog) for (const it of cat.items) S.items.set(`${cat.id}.${it.id}`, { ...it, key: `${cat.id}.${it.id}`, cat });
  S.config = config;

  for (const h of stats) {
    S.tasks.set(taskKey(h.xaId, h.itemKey), {
      xaId: h.xaId, itemKey: h.itemKey, status: h.ok ? 'ok' : 'error', count: h.count, durationMs: h.durationMs,
      error: h.error, warnings: h.warnings || [], finishedAt: h.startedAt, from: h.from, to: h.to, files: h.files || [],
    });
  }

  (prefs.items || ['qlvbdh.vbden', 'qlvbdh.vbdi', 'qlvbdh.lich', 'qlvbdh.donvi', 'gopy.gopy']).forEach((k) => S.items.has(k) && S.selItems.add(k));
  (prefs.xa || S.config.xa.map((x) => x.id)).forEach((id) => S.config.xa.some((x) => x.id === id) && S.selXa.add(id));
  if (info.storage !== 'mongo') $('#opt-autosave').checked = prefs.autosave ?? true;
  $('#opt-autoexcel').checked = !!prefs.autoexcel;
  $('#opt-interval').value = prefs.interval || 60;
  $('#opt-concurrency').value = prefs.concurrency || 3;
  $('#opt-iter').value = prefs.iter || 1;
  $('#opt-delay').value = prefs.delay || 0;
  S.view = prefs.view || 'list';
  $$('#view-toggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  S.preset = prefs.preset ?? '7';
  if (S.preset) applyPreset(S.preset);
  else { $('#from').value = prefs.from; $('#to').value = prefs.to; }

  bindEvents();
  renderCatalog();
  renderXaList();
  renderStats();
  renderConfig();
  setInterval(tickSchedule, 1000);
  log('Sẵn sàng. Chọn danh mục, xã và bấm "Truy vấn".', 'l-info');
}

// ---------- Danh mục ----------
function renderCatalog() {
  const q = $('#cat-search').value.trim().toLowerCase();
  const openState = new Set($$('.cat.open').map((el) => el.dataset.cat));
  const html = S.catalog.map((cat) => {
    const items = cat.items.filter((it) => !q || it.name.toLowerCase().includes(q) || cat.name.toLowerCase().includes(q));
    if (!items.length) return '';
    const keys = cat.items.map((it) => `${cat.id}.${it.id}`);
    const nSel = keys.filter((k) => S.selItems.has(k)).length;
    const open = q || openState.has(cat.id) || (!openState.size && nSel > 0);
    return `<div class="cat ${open ? 'open' : ''}" data-cat="${cat.id}">
      <div class="cat-head">
        <input type="checkbox" class="cat-check" data-cat="${cat.id}" ${nSel === keys.length ? 'checked' : ''}>
        <span class="name">${esc(cat.name)}</span>
        <span class="badge">${nSel}/${keys.length}</span>
        <span class="caret">▶</span>
      </div>
      <div class="cat-items">
        ${cat.note ? `<p class="cat-note">${esc(cat.note)}</p>` : ''}
        ${items.map((it) => {
          const k = `${cat.id}.${it.id}`;
          return `<label class="check"><input type="checkbox" class="item-check" value="${k}" ${S.selItems.has(k) ? 'checked' : ''}>
            ${esc(it.name)} ${it.dated ? '<span class="tag">theo ngày</span>' : ''}</label>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
  $('#catalog').innerHTML = html || '<p class="hint">Không có mục phù hợp.</p>';
  $$('.cat-check').forEach((cb) => {
    const cat = S.catalog.find((c) => c.id === cb.dataset.cat);
    const n = cat.items.filter((it) => S.selItems.has(`${cat.id}.${it.id}`)).length;
    cb.indeterminate = n > 0 && n < cat.items.length;
  });
  updateRunButton();
}

function renderXaList() {
  $('#xa-list').innerHTML = S.config.xa.length
    ? S.config.xa.map((x) => `<label class="check"><input type="checkbox" class="xa-check" value="${esc(x.id)}" ${S.selXa.has(x.id) ? 'checked' : ''}>
        ${esc(x.name)}<span class="meta">${esc(x.organId || '')}</span></label>`).join('')
    : '<p class="hint">Chưa có xã nào. Vào tab "Cấu hình" để thêm.</p>';
  updateRunButton();
}

function selectedPairs() {
  const items = [...S.items.keys()].filter((k) => S.selItems.has(k));
  const xas = S.config.xa.map((x) => x.id).filter((id) => S.selXa.has(id));
  const out = [];
  for (const xaId of xas) for (const itemKey of items) out.push(taskKey(xaId, itemKey));
  return out;
}

function updateRunButton() {
  const n = selectedPairs().length;
  const iter = Math.max(1, Math.round(Number($('#opt-iter').value) || 1));
  $('#btn-run').textContent = S.running
    ? (S.run && S.run.iterations > 1 ? `⏳ Vòng ${S.run.iter}/${S.run.iterations}...` : '⏳ Đang truy vấn...')
    : `▶ Truy vấn (${n} tác vụ${iter > 1 ? ` × ${iter} vòng` : ''})`;
  $('#btn-run').disabled = S.running || n === 0;
  $('#btn-stop').disabled = !S.running;
}

// ---------- Khoảng ngày ----------
function applyPreset(p) {
  const today = new Date();
  let from = new Date(today);
  let to = new Date(today);
  if (p === '7' || p === '30') from.setDate(today.getDate() - Number(p) + 1);
  else if (p === 'month') from = new Date(today.getFullYear(), today.getMonth(), 1);
  else if (p === 'lastmonth') { from = new Date(today.getFullYear(), today.getMonth() - 1, 1); to = new Date(today.getFullYear(), today.getMonth(), 0); }
  else if (p === 'year') from = new Date(today.getFullYear(), 0, 1);
  $('#from').value = isoDate(from);
  $('#to').value = isoDate(to);
  S.preset = p;
  $$('#presets .chip').forEach((c) => c.style.borderColor = c.dataset.preset === p ? 'var(--primary)' : '');
}

// ---------- Chạy truy vấn ----------
async function runTasks(keys, { scheduled = false } = {}) {
  if (S.running || !keys.length) return;
  const from = $('#from').value;
  const to = $('#to').value;
  if (!from || !to || from > to) return toast('Khoảng thời gian không hợp lệ');
  const concurrency = Math.min(8, Math.max(1, Number($('#opt-concurrency').value) || 3));
  const autoSave = $('#opt-autosave').checked;
  // Chạy lặp giống Postman Runner: N vòng, nghỉ X giây sau mỗi request; khi đó máy chủ giữ giới hạn lượt gọi.
  const iterations = Math.min(1000, Math.max(1, Math.round(Number($('#opt-iter').value) || 1)));
  const delayMs = Math.min(3600, Math.max(0, Number($('#opt-delay').value) || 0)) * 1000;
  const guard = iterations > 1 || delayMs > 0;

  S.running = true;
  S.stopRequested = false;
  S.run = { start: Date.now(), end: null, total: keys.length * iterations, done: 0, iter: 0, iterations };
  const prev = new Map(keys.map((k) => [k, S.tasks.get(k)]));
  if (guard) {
    S.iters = [];
    $('#iter-card').classList.remove('hidden');
  }
  updateRunButton();
  log(`${scheduled ? '[Tự động] ' : ''}Bắt đầu ${keys.length} tác vụ${iterations > 1 ? ` × ${iterations} vòng` : ''}, ${concurrency} luồng${delayMs ? `, nghỉ ${delayMs / 1000}s mỗi request` : ''}, ${viDate(from)} – ${viDate(to)}`, 'l-info');

  const total = { ok: 0, error: 0, skipped: 0, rows: 0, calls: 0 };
  for (let it = 1; it <= iterations && !S.stopRequested; it++) {
    S.run.iter = it;
    for (const k of keys) {
      const [xaId, itemKey] = k.split('|');
      S.tasks.set(k, { ...(S.tasks.get(k) || {}), xaId, itemKey, status: 'queued' });
    }
    const sum = { it, start: Date.now(), end: null, ok: 0, error: 0, skipped: 0, rows: 0, calls: 0 };
    if (guard) S.iters.push(sum);
    renderStats();
    renderIters();

    const queue = [...keys];
    const worker = async () => {
      while (queue.length && !S.stopRequested) {
        const k = queue.shift();
        const t = await runOne(k, { from, to, autoSave, guard }, prev.get(k));
        S.run.done++;
        if (t) {
          sum[t.status] = (sum[t.status] || 0) + 1;
          sum.rows += t.status === 'ok' ? t.count || 0 : 0;
          sum.calls += t.calls || 0;
        }
        renderStats();
        renderIters();
        if (delayMs && (queue.length || it < iterations)) await pause(delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
    for (const k of queue) restore(k, prev.get(k));
    sum.end = Date.now();
    for (const f of Object.keys(total)) total[f] += sum[f];
    renderIters();
    if (iterations > 1) log(`Vòng ${it}/${iterations}: ${sum.ok} thành công, ${sum.error} lỗi, ${sum.skipped} bỏ qua, ${fmtNum(sum.rows)} bản ghi, ${sum.calls} lượt gọi API`, 'l-info');
    if (guard && sum.skipped === keys.length) {
      log('Mọi tác vụ đã chạm giới hạn lượt gọi hôm nay, dừng chạy lặp để không bị LGSP khóa.', 'l-err');
      break;
    }
  }

  S.run.end = Date.now();
  S.running = false;
  updateRunButton();
  renderStats();
  log(`${S.stopRequested ? 'Đã dừng' : 'Hoàn tất'}: ${total.ok} thành công, ${total.error} lỗi${total.skipped ? `, ${total.skipped} bỏ qua` : ''}, ${fmtNum(total.rows)} bản ghi, ${fmtNum(total.calls)} lượt gọi API, ${fmtDur(S.run.end - S.run.start)}`, 'l-info');
  if (!S.stopRequested && $('#opt-autoexcel').checked) exportExcelAll(keys);
  if ($('#opt-schedule').checked) scheduleNext();
}

// Chờ ms mili giây, thoát sớm khi bấm Dừng.
async function pause(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !S.stopRequested) await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
}

function restore(k, old) {
  if (old) S.tasks.set(k, old);
  else S.tasks.delete(k);
}

function renderIters() {
  if (!S.iters || !S.iters.length) return;
  const sum = (f) => S.iters.reduce((n, x) => n + (x[f] || 0), 0);
  $('#iter-sum').textContent = `${S.iters.length} vòng · ${fmtNum(sum('calls'))} lượt gọi API`;
  $('#iter-wrap').innerHTML = `<table>
    <thead><tr><th class="num">Vòng</th><th>Bắt đầu</th><th class="num">Thành công</th><th class="num">Lỗi</th><th class="num">Bỏ qua</th>
      <th class="num">Bản ghi</th><th class="num">Lượt gọi API</th><th class="num">Thời gian</th></tr></thead>
    <tbody>${S.iters.map((x) => `<tr>
      <td class="num">${x.it}</td><td>${fmtTime(x.start)}</td>
      <td class="num"><b class="ok-text">${fmtNum(x.ok)}</b></td><td class="num">${x.error ? `<b class="err-text">${fmtNum(x.error)}</b>` : 0}</td>
      <td class="num">${fmtNum(x.skipped)}</td><td class="num">${fmtNum(x.rows)}</td><td class="num">${fmtNum(x.calls)}</td>
      <td class="num">${x.end ? fmtDur(x.end - x.start) : '<span class="hint">đang chạy</span>'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="2">Tổng cộng</td><td class="num">${fmtNum(sum('ok'))}</td><td class="num">${fmtNum(sum('error'))}</td><td class="num">${fmtNum(sum('skipped'))}</td>
      <td class="num">${fmtNum(sum('rows'))}</td><td class="num">${fmtNum(sum('calls'))}</td><td></td></tr></tfoot>
  </table>`;
}

function exportIters() {
  if (!ensureXlsx() || !S.iters || !S.iters.length) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.iters.map((x) => ({
    'Vòng': x.it, 'Bắt đầu': fmtTime(x.start), 'Thành công': x.ok, 'Lỗi': x.error, 'Bỏ qua': x.skipped,
    'Bản ghi': x.rows, 'Lượt gọi API': x.calls, 'Thời gian (giây)': x.end ? +((x.end - x.start) / 1000).toFixed(1) : null,
  }))), 'Chay lap');
  XLSX.writeFile(wb, `ChayLap_${stamp()}.xlsx`);
}

async function runOne(k, { from, to, autoSave, guard }, old) {
  const [xaId, itemKey] = k.split('|');
  const xa = S.config.xa.find((x) => x.id === xaId);
  const item = S.items.get(itemKey);
  const label = `${xa ? xa.name : xaId} › ${item.name}`;
  S.tasks.set(k, { ...S.tasks.get(k), status: 'running', startedAt: Date.now() });
  renderStats();

  const ctrl = new AbortController();
  S.controllers.add(ctrl);
  try {
    const r = await api('/api/query', { method: 'POST', body: JSON.stringify({ xaId, itemKey, from, to, autoSave, guard }), signal: ctrl.signal });
    (r.logs || []).forEach((l) => log(`${label}:${l}`));
    if (r.skipped) {
      // Không đủ lượt trong giới hạn: giữ nguyên kết quả cũ trong bảng, chỉ đổi trạng thái.
      S.tasks.set(k, { ...(old || {}), xaId, itemKey, status: 'skipped', error: r.error, warnings: [], finishedAt: Date.now() });
      log(`⏭ ${label}: bỏ qua – ${r.error}`);
      return { status: 'skipped', count: 0, calls: 0 };
    }
    S.tasks.set(k, {
      xaId, itemKey, status: r.ok ? 'ok' : 'error', count: r.count, durationMs: r.durationMs, error: r.error,
      warnings: r.warnings || [], finishedAt: Date.now(), from: r.from, to: r.to, files: r.files || [],
    });
    if (r.ok) {
      log(`✔ ${label}: ${fmtNum(r.count)} bản ghi (${fmtDur(r.durationMs)}, ${r.calls} lượt gọi API)${r.files && r.files.length ? ' → đã lưu file' : ''}`, 'l-ok');
      (r.warnings || []).forEach((w) => log(`  ⚠ ${w}`));
    } else {
      log(`✘ ${label}: ${r.error} (${r.calls} lượt gọi API)`, 'l-err');
    }
    return { status: r.ok ? 'ok' : 'error', count: r.count, calls: r.calls };
  } catch (e) {
    if (e.name === 'AbortError') {
      restore(k, old);
      return null;
    }
    S.tasks.set(k, { xaId, itemKey, status: 'error', count: 0, error: e.message, warnings: [], finishedAt: Date.now() });
    log(`✘ ${label}: ${e.message}`, 'l-err');
    return { status: 'error', count: 0, calls: 0 };
  } finally {
    S.controllers.delete(ctrl);
  }
}

function stopRun() {
  S.stopRequested = true;
  S.controllers.forEach((c) => c.abort());
  log('Đang dừng...', 'l-info');
}

// ---------- Tự động chạy theo lịch ----------
function scheduleNext() {
  const min = Math.max(1, Number($('#opt-interval').value) || 60);
  S.nextRunAt = Date.now() + min * 60000;
}

function tickSchedule() {
  const info = $('#schedule-info');
  if (!$('#opt-schedule').checked) {
    S.nextRunAt = null;
    info.textContent = '';
    return;
  }
  if (!S.nextRunAt) scheduleNext();
  if (S.running) {
    info.textContent = 'Đang chạy...';
    return;
  }
  const left = S.nextRunAt - Date.now();
  if (left <= 0) {
    if (S.preset) applyPreset(S.preset);
    runTasks(selectedPairs(), { scheduled: true });
    return;
  }
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  info.textContent = `Lần chạy kế tiếp lúc ${new Date(S.nextRunAt).toLocaleTimeString('vi-VN', { hour12: false })} (còn ${m}:${pad(s)}). Giữ trang này mở để tự chạy.`;
}

// ---------- Bảng thống kê ----------
function visibleKeys() {
  const sel = selectedPairs();
  let keys = sel;
  if (!$('#only-selected').checked) {
    const set = new Set(sel);
    const order = (k) => {
      const [xaId, itemKey] = k.split('|');
      const xi = S.config.xa.findIndex((x) => x.id === xaId);
      const ii = [...S.items.keys()].indexOf(itemKey);
      return (xi < 0 ? 999 : xi) * 10000 + ii;
    };
    keys = [...sel, ...[...S.tasks.keys()].filter((k) => !set.has(k) && S.items.has(k.split('|')[1]))].sort((a, b) => order(a) - order(b));
  }
  const f = $('#status-filter').value;
  if (!f) return keys;
  return keys.filter((k) => {
    const st = (S.tasks.get(k) || {}).status || 'pending';
    return f === 'pending' ? ['pending', 'queued', 'running'].includes(st) : st === f;
  });
}

function rowInfo(k) {
  const [xaId, itemKey] = k.split('|');
  const t = S.tasks.get(k) || { status: 'pending' };
  const xa = S.config.xa.find((x) => x.id === xaId);
  const item = S.items.get(itemKey);
  return { k, xaId, itemKey, t, xaName: xa ? xa.name : xaId, item };
}

function renderStats() {
  const keys = visibleKeys();
  const infos = keys.map(rowInfo);
  const ok = infos.filter((i) => i.t.status === 'ok');
  const err = infos.filter((i) => i.t.status === 'error');
  const totalRows = ok.reduce((s, i) => s + (i.t.count || 0), 0);

  if (S.running) {
    $('#s-tasks').textContent = `${S.run.done}/${S.run.total}`;
    $('#s-tasks-sub').textContent = 'đang thực hiện';
  } else {
    $('#s-tasks').textContent = fmtNum(keys.length);
    $('#s-tasks-sub').textContent = 'trong bảng';
  }
  $('#s-ok').textContent = fmtNum(ok.length);
  $('#s-err').textContent = fmtNum(err.length);
  $('#s-rows').textContent = fmtNum(totalRows);
  if (S.run) {
    $('#s-time').textContent = fmtDur((S.run.end || Date.now()) - S.run.start);
    $('#s-time-sub').textContent = S.running ? 'đang chạy' : `xong lúc ${new Date(S.run.end).toLocaleTimeString('vi-VN', { hour12: false })}`;
  }
  const pct = S.run && S.run.total ? Math.round((S.run.done / S.run.total) * 100) : 0;
  $('#progress-bar').style.width = `${pct}%`;
  $('#progress-text').textContent = S.run
    ? `${S.run.iterations > 1 ? `Vòng ${S.run.iter}/${S.run.iterations} · ` : ''}${S.run.done}/${S.run.total} tác vụ (${pct}%)`
    : 'Chưa chạy';
  if (S.running) updateRunButton();

  $('#stats-wrap').innerHTML = !infos.length
    ? '<div class="empty">Chọn ít nhất một danh mục và một xã để bắt đầu.</div>'
    : S.view === 'matrix' ? matrixHtml(infos) : listHtml(infos, totalRows);
}

function statusBadge(st) {
  return `<span class="badge-st st-${st}">${STATUS_LABEL[st] || st}</span>`;
}

function listHtml(infos, totalRows) {
  const body = infos.map((i, n) => {
    const t = i.t;
    const range = t.from ? `${viDate(t.from)} – ${viDate(t.to)}` : (i.item.dated ? '' : '—');
    const note = t.status === 'error' || t.status === 'skipped' ? `<td class="err-text">${esc(t.error)}</td>`
      : `<td class="warn-text">${esc((t.warnings || []).join('; '))}</td>`;
    const hasData = t.status === 'ok' || (t.status === 'skipped' && t.count > 0);
    const q = `xa=${encodeURIComponent(i.xaId)}&item=${encodeURIComponent(i.itemKey)}`;
    return `<tr>
      <td class="num">${n + 1}</td>
      <td class="nw">${esc(i.xaName)}</td>
      <td class="nw">${esc(i.item.cat.short || i.item.cat.name)}</td>
      <td class="nw">${esc(i.item.name)}</td>
      <td class="nw">${range}</td>
      <td>${statusBadge(t.status)}</td>
      <td class="num"><b>${t.status === 'ok' ? fmtNum(t.count) : ''}</b></td>
      <td class="num">${t.status === 'running' ? fmtDur(Date.now() - t.startedAt) : t.durationMs != null ? fmtDur(t.durationMs) : ''}</td>
      <td>${t.finishedAt && ['ok', 'error'].includes(t.status) ? fmtTime(t.finishedAt) : ''}</td>
      ${note}
      <td class="actions">
        <button class="btn sm" data-act="view" data-key="${esc(i.k)}" ${hasData ? '' : 'disabled'}>Xem</button>
        <a class="btn sm" href="/api/download?${q}&format=csv" ${hasData ? '' : 'style="pointer-events:none;opacity:.45"'}>CSV</a>
        <button class="btn sm" data-act="rerun" data-key="${esc(i.k)}" ${S.running ? 'disabled' : ''} title="Truy vấn lại mục này">↻</button>
      </td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th class="num">#</th><th>Xã / phường</th><th>Hệ thống</th><th>Mục</th><th>Khoảng ngày</th><th>Trạng thái</th>
      <th class="num">Số bản ghi</th><th class="num">Thời gian</th><th>Cập nhật</th><th>Ghi chú</th><th>Thao tác</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td colspan="6">Tổng cộng</td><td class="num">${fmtNum(totalRows)}</td><td colspan="4"></td></tr></tfoot>
  </table>`;
}

function matrixHtml(infos) {
  const xaIds = [...new Set(infos.map((i) => i.xaId))];
  const itemKeys = [...new Set(infos.map((i) => i.itemKey))];
  const byKey = new Map(infos.map((i) => [i.k, i]));
  const colTotals = Object.fromEntries(xaIds.map((x) => [x, 0]));
  let grand = 0;
  const rows = itemKeys.map((ik) => {
    const item = S.items.get(ik);
    let rowTotal = 0;
    const cells = xaIds.map((x) => {
      const i = byKey.get(taskKey(x, ik));
      if (!i) return '<td class="cell"></td>';
      const t = i.t;
      if (t.status === 'ok') { rowTotal += t.count; colTotals[x] += t.count; }
      const text = t.status === 'ok' ? fmtNum(t.count) : t.status === 'error' ? 'Lỗi' : t.status === 'running' ? '…' : t.status === 'queued' ? '⋯' : '–';
      return `<td class="cell ${t.status}" title="${esc(t.error || STATUS_LABEL[t.status])}" data-act="${t.status === 'ok' ? 'view' : ''}" data-key="${esc(i.k)}">${text}</td>`;
    }).join('');
    grand += rowTotal;
    return `<tr><td>${esc(item.cat.short)}</td><td>${esc(item.name)}</td>${cells}<td class="num"><b>${fmtNum(rowTotal)}</b></td></tr>`;
  }).join('');
  const head = xaIds.map((x) => `<th class="num">${esc((S.config.xa.find((y) => y.id === x) || {}).name || x)}</th>`).join('');
  return `<table class="matrix">
    <thead><tr><th>Hệ thống</th><th>Mục</th>${head}<th class="num">Tổng</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2">Tổng cộng</td>${xaIds.map((x) => `<td class="num">${fmtNum(colTotals[x])}</td>`).join('')}<td class="num">${fmtNum(grand)}</td></tr></tfoot>
  </table>`;
}

// Cập nhật đồng hồ "Thời gian" của tác vụ đang chạy.
setInterval(() => { if (S.running) renderStats(); }, 1000);

// ---------- Xuất Excel ----------
function sheetName(name, used) {
  let base = name.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 28)}~${i}`;
  used.add(n.toLowerCase());
  return n;
}

const clip = (v) => (typeof v === 'string' && v.length > 32000 ? v.slice(0, 32000) + '…' : v);

function statsRows(keys) {
  return keys.map(rowInfo).map((i, n) => ({
    STT: n + 1,
    'Xã/phường': i.xaName,
    'Hệ thống': i.item.cat.name,
    'Mục': i.item.name,
    'Từ ngày': viDate(i.t.from),
    'Đến ngày': viDate(i.t.to),
    'Trạng thái': STATUS_LABEL[i.t.status] || i.t.status,
    'Số bản ghi': i.t.status === 'ok' ? i.t.count : null,
    'Thời gian (giây)': i.t.durationMs != null ? +(i.t.durationMs / 1000).toFixed(1) : null,
    'Cập nhật': fmtTime(i.t.finishedAt),
    'Ghi chú': i.t.status === 'error' ? i.t.error : (i.t.warnings || []).join('; '),
  }));
}

function stamp() {
  const d = new Date();
  return `${isoDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function ensureXlsx() {
  if (window.XLSX) return true;
  toast('Chưa tải được thư viện Excel (cần Internet). Hãy dùng nút CSV.');
  return false;
}

function exportExcelStats() {
  if (!ensureXlsx()) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(statsRows(visibleKeys())), 'Thong ke');
  XLSX.writeFile(wb, `ThongKe_TruyVan_${stamp()}.xlsx`);
}

async function exportExcelAll(keys = visibleKeys()) {
  if (!ensureXlsx()) return;
  const okKeys = keys.filter((k) => (S.tasks.get(k) || {}).status === 'ok' && S.tasks.get(k).count > 0);
  if (!okKeys.length) return toast('Chưa có dữ liệu thành công để xuất');
  toast(`Đang chuẩn bị Excel (${okKeys.length} mục)...`, 10000);
  const wb = XLSX.utils.book_new();
  const used = new Set(['thong ke']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(statsRows(keys)), 'Thong ke');
  for (const k of okKeys) {
    const i = rowInfo(k);
    try {
      const r = await api(`/api/result?xa=${encodeURIComponent(i.xaId)}&item=${encodeURIComponent(i.itemKey)}`);
      const rows = r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([c, v]) => [c, clip(v)])));
      const xaShort = i.xaName.replace(/^(Phường|Xã|Thị trấn)\s+/i, '');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: r.columns }), sheetName(`${xaShort} - ${i.item.name}`, used));
    } catch (e) {
      log(`Không xuất được ${i.xaName} › ${i.item.name}: ${e.message}`, 'l-err');
    }
  }
  XLSX.writeFile(wb, `DuLieu_LGSP_${stamp()}.xlsx`);
  log(`Đã xuất Excel ${okKeys.length} mục`, 'l-ok');
}

// ---------- Xem dữ liệu ----------
const PAGE = 200;
async function openViewer(k) {
  const i = rowInfo(k);
  S.viewer = { ...i, offset: 0, q: '', rows: [], columns: [] };
  $('#v-title').textContent = `${i.xaName} › ${i.item.name}`;
  const q = `xa=${encodeURIComponent(i.xaId)}&item=${encodeURIComponent(i.itemKey)}`;
  $('#v-csv').href = `/api/download?${q}&format=csv`;
  $('#v-json').href = `/api/download?${q}&format=json`;
  $('#v-search').value = '';
  $('#viewer').classList.remove('hidden');
  await loadViewer(true);
}

async function loadViewer(reset) {
  const v = S.viewer;
  if (reset) { v.offset = 0; v.rows = []; }
  const r = await api(`/api/result?xa=${encodeURIComponent(v.xaId)}&item=${encodeURIComponent(v.itemKey)}&offset=${v.offset}&limit=${PAGE}&q=${encodeURIComponent(v.q)}`);
  v.rows.push(...r.rows);
  if (reset) v.columns = r.columns;
  else for (const c of r.columns) if (!v.columns.includes(c)) v.columns.push(c);
  v.offset += r.rows.length;
  v.filtered = r.filtered;
  $('#v-sub').textContent = `${r.categoryName} · ${fmtNum(r.count)} bản ghi · truy vấn lúc ${fmtTime(r.startedAt)}${r.from ? ` · ${viDate(r.from)} – ${viDate(r.to)}` : ''}`;
  $('#v-wrap').innerHTML = v.rows.length
    ? `<table class="data-table"><thead><tr><th class="num">#</th>${v.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
       <tbody>${v.rows.map((row, n) => `<tr><td class="num">${n + 1}</td>${v.columns.map((c) => `<td title="${esc(row[c])}">${esc(row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<div class="empty">Không có bản ghi.</div>';
  $('#v-count').textContent = `Đang hiển thị ${fmtNum(v.rows.length)} / ${fmtNum(v.filtered)} bản ghi${v.q ? ' (đã lọc)' : ''}`;
  $('#v-more').classList.toggle('hidden', v.rows.length >= v.filtered);
}

async function exportViewerExcel() {
  if (!ensureXlsx()) return;
  const v = S.viewer;
  const r = await api(`/api/result?xa=${encodeURIComponent(v.xaId)}&item=${encodeURIComponent(v.itemKey)}&q=${encodeURIComponent(v.q)}`);
  const wb = XLSX.utils.book_new();
  const rows = r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([c, val]) => [c, clip(val)])));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header: r.columns }), sheetName(v.item.name, new Set()));
  XLSX.writeFile(wb, `${v.xaName}_${v.item.name}_${stamp()}.xlsx`);
}

// ---------- Lịch sử ----------
async function loadHistory() {
  S.history = await api('/api/history?limit=2000');
  renderHistory();
}

function historyRows() {
  const q = $('#hist-search').value.trim().toLowerCase();
  return S.history.filter((h) => !q || [h.xaName, h.itemName, h.categoryName, h.error].some((v) => v && v.toLowerCase().includes(q)));
}

function renderHistory() {
  const rows = historyRows();
  $('#hist-wrap').innerHTML = rows.length ? `<table>
    <thead><tr><th>Thời điểm</th><th>Nguồn</th><th>Xã / phường</th><th>Hệ thống</th><th>Mục</th><th>Khoảng ngày</th><th>Kết quả</th>
      <th class="num">Số bản ghi</th><th class="num">Lượt gọi API</th><th class="num">Thời gian</th><th>File đã lưu</th><th>Lỗi / cảnh báo</th></tr></thead>
    <tbody>${rows.map((h) => `<tr>
      <td>${fmtTime(h.startedAt)}</td><td>${SOURCE_LABEL[h.source] || 'Thủ công'}</td><td>${esc(h.xaName)}</td><td>${esc(h.categoryName)}</td><td>${esc(h.itemName)}</td>
      <td>${h.from ? `${viDate(h.from)} – ${viDate(h.to)}` : '—'}</td>
      <td>${statusBadge(h.ok ? 'ok' : 'error')}</td>
      <td class="num">${h.ok ? fmtNum(h.count) : ''}</td><td class="num">${h.calls != null ? fmtNum(h.calls) : ''}</td><td class="num">${fmtDur(h.durationMs)}</td>
      <td style="font-size:12px">${(h.files || []).map(esc).join('<br>')}</td>
      <td class="${h.ok ? 'warn-text' : 'err-text'}">${esc(h.ok ? (h.warnings || []).join('; ') : h.error)}</td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">Chưa có lịch sử.</div>';
}

function exportHistory() {
  if (!ensureXlsx()) return;
  const rows = historyRows().map((h) => ({
    'Thời điểm': fmtTime(h.startedAt), 'Nguồn': SOURCE_LABEL[h.source] || 'Thủ công', 'Xã/phường': h.xaName, 'Hệ thống': h.categoryName, 'Mục': h.itemName,
    'Từ ngày': viDate(h.from), 'Đến ngày': viDate(h.to), 'Kết quả': h.ok ? 'Thành công' : 'Lỗi',
    'Số bản ghi': h.ok ? h.count : null, 'Lượt gọi API': h.calls ?? null, 'Thời gian (giây)': +(h.durationMs / 1000).toFixed(1),
    'File đã lưu': (h.files || []).join('; '), 'Lỗi / cảnh báo': h.ok ? (h.warnings || []).join('; ') : h.error,
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Lich su');
  XLSX.writeFile(wb, `LichSu_TruyVan_${stamp()}.xlsx`);
}

// ---------- Tự động & hạn mức ----------
const LIMIT_SOURCE = { manual: 'cố định', '429': 'dò từ lỗi 429', header: 'theo header LGSP', default: 'mặc định (chưa dò được)' };

async function loadAutoTab() {
  const [auto, u] = await Promise.all([api('/api/auto'), api('/api/usage?days=30')]);
  S.auto = auto;
  S.usage = u;
  if (!S.autoFormDirty) fillAutoForm(auto.settings);
  renderAutoStatus();
  renderUsage();
}

function fillAutoForm(s) {
  $('#a-enabled').checked = !!s.auto_enabled;
  $('#a-runs').value = s.auto_runs_per_day;
  $('#a-start').value = s.auto_start;
  $('#a-end').value = s.auto_end;
  $('#a-days').value = s.auto_days;
  $('#a-conc').value = s.auto_concurrency;
  $('#a-pct').value = s.auto_safety_pct;
  $('#a-deflimit').value = s.auto_default_limit;
  $('#a-fixlimit').value = s.auto_daily_limit;
  const items = new Set(s.auto_items || []);
  $('#a-items').innerHTML = [...S.items.values()].map((it) =>
    `<label class="check"><input type="checkbox" value="${esc(it.key)}" ${items.has(it.key) ? 'checked' : ''}> ${esc(it.cat.short)} – ${esc(it.name)}</label>`).join('');
  const xa = new Set(s.auto_xa || []);
  $('#a-xa').innerHTML = S.config.xa.map((x) =>
    `<label class="check"><input type="checkbox" value="${esc(x.id)}" ${xa.has(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('') || '<p class="hint">Chưa có xã nào.</p>';
}

function renderAutoStatus() {
  const a = S.auto;
  $('#a-slots').innerHTML = a.slots.map((x) => `<span class="slot ${x.status}" title="${{ done: 'Đã chạy', running: 'Đang chạy', missed: 'Đã qua (máy chủ không chạy lúc đó)', pending: 'Chưa đến giờ' }[x.status]}">${x.time}</span>`).join('');
  let msg = !a.enabled ? 'Đang tắt. Các mốc giờ trên là dự kiến khi bật.'
    : a.next ? `Lượt kế tiếp lúc ${a.next} hôm nay.` : 'Đã chạy hết các mốc hôm nay, lượt kế tiếp vào ngày mai.';
  if (a.running && a.current) msg = `Đang đồng bộ: ${a.current.done}/${a.current.total} tác vụ...`;
  else if (a.lastRun) msg += ` Lượt gần nhất ${fmtTime(a.lastRun.finishedAt)}: ${a.lastRun.ok} thành công, ${a.lastRun.error} lỗi, ${a.lastRun.skipped} bỏ qua, ${fmtNum(a.lastRun.calls)} lượt gọi API.`;
  $('#a-status').textContent = msg;
  $('#auto-run').disabled = a.running;
}

function readAutoForm() {
  return {
    auto_enabled: $('#a-enabled').checked,
    auto_runs_per_day: Number($('#a-runs').value),
    auto_start: $('#a-start').value,
    auto_end: $('#a-end').value,
    auto_days: Number($('#a-days').value),
    auto_concurrency: Number($('#a-conc').value),
    auto_safety_pct: Number($('#a-pct').value),
    auto_default_limit: Number($('#a-deflimit').value),
    auto_daily_limit: Number($('#a-fixlimit').value),
    auto_items: $$('#a-items input:checked').map((el) => el.value),
    auto_xa: $$('#a-xa input:checked').map((el) => el.value),
  };
}

async function saveAuto() {
  const form = readAutoForm();
  if (!form.auto_items.length) return toast('Chọn ít nhất một mục để đồng bộ');
  await api('/api/auto', { method: 'PUT', body: JSON.stringify(form) });
  S.autoFormDirty = false;
  await loadAutoTab();
  toast('Đã lưu cấu hình đồng bộ tự động');
}

const callsSub = (t) => `${fmtNum(t.ok)} thành công · ${fmtNum(t.err)} lỗi${t.throttled ? ` (${fmtNum(t.throttled)} bị chặn)` : ''}`;

function renderUsage() {
  const u = S.usage;
  const t = u.totals;
  $('#u-today').textContent = fmtNum(t.today.calls);
  $('#u-today-sub').textContent = callsSub(t.today);
  $('#u-week').textContent = fmtNum(t.week.calls);
  $('#u-week-sub').textContent = callsSub(t.week);
  $('#u-month').textContent = fmtNum(t.month.calls);
  $('#u-month-sub').textContent = callsSub(t.month);
  $('#u-tok').textContent = fmtNum(t.today.tasksOk);
  $('#u-terr').textContent = fmtNum(t.today.tasksErr);
  $('#u-reset').textContent = `hạn mức đặt lại lúc ${fmtTime(u.resetAt)}`;

  const autoSys = new Set((S.auto.settings.auto_items || []).map((k) => k.split('.')[0]));
  const rows = u.today.filter((r) => $('#u-all-sys').checked || r.calls || r.quota || r.blockedUntil || autoSys.has(r.sys));
  $('#u-quota').innerHTML = rows.length ? `<table>
    <thead><tr><th>Xã / phường</th><th>Hệ thống</th><th class="num">Đã gọi</th><th class="num">Lỗi</th><th>Đã dùng / giới hạn tự đặt</th>
      <th class="num">Hạn mức dò được</th><th>Trạng thái</th></tr></thead>
    <tbody>${rows.map((r) => {
      const pct = Math.min(100, Math.round((r.used / r.limit) * 100));
      const cls = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
      const obs = r.observed.map((o) => `${o.day}: ${o.used}`).join(', ');
      return `<tr>
        <td class="nw">${esc(r.xaName)}</td><td class="nw">${esc(r.sysName)}</td>
        <td class="num">${fmtNum(r.calls)}</td><td class="num">${r.err ? `<span class="err-text">${fmtNum(r.err)}</span>` : 0}</td>
        <td><span class="nw">${fmtNum(r.used)} / ${fmtNum(r.limit)}</span> <span class="hint">(${LIMIT_SOURCE[r.limitSource] || r.limitSource})</span>
          <div class="meter ${cls}"><span style="width:${pct}%"></span></div></td>
        <td class="num" title="${esc(obs ? 'Các lần quan sát: ' + obs : '')}">${r.quota ? fmtNum(r.quota) : '<span class="hint">chưa biết</span>'}</td>
        <td>${r.blockedUntil
          ? `<span class="badge-st st-error">Bị LGSP chặn đến ${fmtTime(r.blockedUntil)}</span> <button class="btn sm" data-act="unblock" data-xa="${esc(r.xaId)}" data-sys="${esc(r.sys)}" title="Chỉ bấm khi chắc LGSP đã mở lại (ví dụ đã được nâng hạn mức)">Bỏ chặn</button>`
          : r.used >= r.limit ? '<span class="badge-st st-queued">Đủ giới hạn, tự động dừng</span>' : '<span class="badge-st st-ok">Còn lượt</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">Chưa có xã nào.</div>';

  $('#u-runs').innerHTML = u.runs.length ? `<table>
    <thead><tr><th>Bắt đầu</th><th>Kiểu</th><th>Khoảng ngày</th><th class="num">Thành công</th><th class="num">Lỗi</th><th class="num">Bỏ qua</th>
      <th class="num">Bản ghi</th><th class="num">Lượt gọi API</th><th class="num">Thời gian</th><th>Chi tiết</th></tr></thead>
    <tbody>${u.runs.map((r) => `<tr>
      <td class="nw">${fmtTime(r.startedAt)}</td>
      <td class="nw">${r.trigger === 'auto' ? `Theo lịch ${esc((r.slot || '').split(' ')[1] || '')}` : 'Chạy ngay'}</td>
      <td class="nw">${viDate(r.from)} – ${viDate(r.to)}</td>
      <td class="num"><b class="ok-text">${fmtNum(r.ok)}</b></td><td class="num">${r.error ? `<b class="err-text">${fmtNum(r.error)}</b>` : 0}</td><td class="num">${fmtNum(r.skipped)}</td>
      <td class="num">${fmtNum(r.rows)}</td><td class="num">${fmtNum(r.calls)} <span class="hint">(${fmtNum(r.callsOk)} ok)</span></td>
      <td class="num">${fmtDur(Date.parse(r.finishedAt) - Date.parse(r.startedAt))}</td>
      <td><details class="run-detail"><summary>${r.tasks.length} tác vụ</summary><table><tbody>${r.tasks.map((x) => `<tr>
        <td class="nw">${esc(x.xaName)}</td><td class="nw">${esc(x.itemName)}</td><td>${statusBadge(x.status)}</td>
        <td class="num">${x.status === 'ok' ? fmtNum(x.count) + ' bản ghi' : ''}</td><td class="num">${fmtNum(x.calls)} lượt</td>
        <td class="err-text">${esc(x.error || '')}</td></tr>`).join('')}</tbody></table></details></td>
    </tr>`).join('')}</tbody></table>` : '<div class="empty">Chưa có lượt đồng bộ nào.</div>';

  $('#u-daily').innerHTML = u.daily.length ? `<table>
    <thead><tr><th>Ngày (7h → 7h hôm sau)</th><th class="num">Truy vấn OK</th><th class="num">Truy vấn lỗi</th>
      <th class="num">Lượt gọi API</th><th class="num">Thành công</th><th class="num">Lỗi</th><th class="num">Bị chặn</th><th class="num">Tự động</th></tr></thead>
    <tbody>${u.daily.map((d) => `<tr><td>${viDate(d.day)}</td><td class="num">${fmtNum(d.tasksOk)}</td><td class="num">${fmtNum(d.tasksErr)}</td>
      <td class="num"><b>${fmtNum(d.calls)}</b></td><td class="num">${fmtNum(d.ok)}</td><td class="num">${fmtNum(d.err)}</td>
      <td class="num">${fmtNum(d.throttled)}</td><td class="num">${fmtNum(d.auto)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Tổng 30 ngày</td><td class="num">${fmtNum(t.month.tasksOk)}</td><td class="num">${fmtNum(t.month.tasksErr)}</td><td class="num">${fmtNum(t.month.calls)}</td>
      <td class="num">${fmtNum(t.month.ok)}</td><td class="num">${fmtNum(t.month.err)}</td><td class="num">${fmtNum(t.month.throttled)}</td><td class="num">${fmtNum(t.month.auto)}</td></tr></tfoot>
  </table>` : '<div class="empty">Chưa có lượt gọi nào được ghi nhận.</div>';

  const xaName = (id) => (S.config.xa.find((x) => x.id === id) || {}).name || id;
  $('#u-byxa').innerHTML = u.byXa.length ? `<table>
    <thead><tr><th>Xã / phường</th><th class="num">Truy vấn OK</th><th class="num">Truy vấn lỗi</th><th class="num">Lượt gọi API</th><th class="num">Thành công</th><th class="num">Lỗi</th></tr></thead>
    <tbody>${u.byXa.sort((a, b) => b.calls - a.calls).map((x) => `<tr><td>${esc(xaName(x.xaId))}</td><td class="num">${fmtNum(x.tasksOk)}</td><td class="num">${fmtNum(x.tasksErr)}</td>
      <td class="num"><b>${fmtNum(x.calls)}</b></td><td class="num">${fmtNum(x.ok)}</td><td class="num">${fmtNum(x.err)}</td></tr>`).join('')}</tbody>
  </table>` : '<div class="empty">Chưa có dữ liệu.</div>';
}

function exportUsage() {
  if (!ensureXlsx() || !S.usage) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.usage.daily.map((d) => ({
    'Ngày': viDate(d.day), 'Truy vấn thành công': d.tasksOk, 'Truy vấn lỗi': d.tasksErr, 'Lượt gọi API': d.calls,
    'Lượt thành công': d.ok, 'Lượt lỗi': d.err, 'Bị chặn (429)': d.throttled, 'Lượt tự động': d.auto,
  }))), 'Theo ngay');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.usage.runs.map((r) => ({
    'Bắt đầu': fmtTime(r.startedAt), 'Kiểu': r.trigger === 'auto' ? 'Theo lịch' : 'Chạy ngay', 'Từ ngày': viDate(r.from), 'Đến ngày': viDate(r.to),
    'Thành công': r.ok, 'Lỗi': r.error, 'Bỏ qua': r.skipped, 'Bản ghi': r.rows, 'Lượt gọi API': r.calls,
  }))), 'Luot dong bo');
  XLSX.writeFile(wb, `LuotGoi_LGSP_${stamp()}.xlsx`);
}

// ---------- Cấu hình ----------
const SETTING_FIELDS = [
  ['callback_url', 'Callback URL (QLVBDH)', 'text'],
  ['webhook_token', 'Webhook.site token (UUID)', 'text'],
  ['page_size', 'Số bản ghi mỗi trang', 'number'],
  ['qlvbdh_page_size', 'Số bản ghi mỗi trang (QLVBDH)', 'number'],
  ['max_pages', 'Số trang tối đa mỗi lần', 'number'],
  ['job_timeout_sec', 'Thời gian chờ job QLVBDH (giây)', 'number'],
  ['csdlpx_limit', 'Số bản ghi mỗi lần gọi (CSDL Phường xã)', 'number'],
];
const BASE_FIELDS = [
  ['token_url', 'Token URL'], ['base_qlvbdh', 'QLVBDH'], ['base_gopy', 'Góp ý'],
  ['base_vpub', 'Điều hành VPUB'], ['base_ttdh', 'Cổng TTĐT'], ['base_csdlpx', 'CSDL Phường xã'],
];
const XA_GROUPS = [
  ['Kết nối LGSP (bắt buộc)', [['key', 'ConsumerKey'], ['secret', 'ConsumerSecret', 'password'], ['organId', 'organId (mã định danh)'], ['organKey', 'organKey', 'password']]],
  ['QLVBDH – Lịch công tác', [['lct_username', 'Tài khoản lịch công tác (email)']]],
  ['Góp ý', [['gopy_user', 'Tên đăng nhập'], ['gopy_pass', 'Mật khẩu', 'password']]],
  ['Điều hành VPUB', [['vpub_IDNhanVienRequest', 'IDNhanVienRequest'], ['vpub_IDDonVi', 'IDDonVi']]],
  ['CSDL Phường xã', [['csdlpx_username', 'Username'], ['csdlpx_password', 'Password', 'password']]],
];

function renderConfig() {
  const s = S.config.settings;
  const field = ([k, label, type = 'text']) => `<label>${esc(label)}<input class="input" data-setting="${k}" type="${type}" value="${esc(s[k])}"></label>`;
  $('#cfg-settings').innerHTML = SETTING_FIELDS.map(field).join('');
  $('#cfg-bases').innerHTML = BASE_FIELDS.map(field).join('');
  $('#cfg-xa').innerHTML = S.config.xa.map((x, idx) => xaCardHtml(x, idx)).join('') || '<p class="hint">Chưa có xã nào.</p>';
}

function xaCardHtml(x, idx) {
  return `<div class="xa-card" data-idx="${idx}" data-id="${esc(x.id || '')}">
    <div class="xa-card-head">
      <input class="input" data-f="name" value="${esc(x.name)}" placeholder="Tên xã / phường">
      <div class="toolbar-right">
        <span class="hint" data-role="token-result"></span>
        <button class="btn sm" data-act="test-token" ${x.id ? '' : 'disabled title="Lưu cấu hình trước"'}>Thử lấy token</button>
        <button class="btn sm danger" data-act="remove-xa">Xóa</button>
      </div>
    </div>
    ${XA_GROUPS.map(([legend, fields]) => `<fieldset><legend>${esc(legend)}</legend><div class="form-grid">
      ${fields.map(([k, label, type = 'text']) => `<label>${esc(label)}<input class="input" data-f="${k}" type="${type}" value="${esc(x[k])}" autocomplete="off"></label>`).join('')}
    </div></fieldset>`).join('')}
  </div>`;
}

function readConfigForm() {
  const settings = {};
  $$('[data-setting]').forEach((el) => { settings[el.dataset.setting] = el.type === 'number' ? Number(el.value) : el.value.trim(); });
  const xa = $$('.xa-card').map((card) => {
    const o = { id: card.dataset.id || '' };
    $$('[data-f]', card).forEach((el) => { o[el.dataset.f] = el.value.trim(); });
    return o;
  });
  return { settings, xa };
}

async function saveConfig() {
  const form = readConfigForm();
  if (form.xa.some((x) => !x.name)) return toast('Tên xã không được để trống');
  S.config = await api('/api/config', { method: 'PUT', body: JSON.stringify(form) });
  for (const id of [...S.selXa]) if (!S.config.xa.some((x) => x.id === id)) S.selXa.delete(id);
  renderConfig();
  renderXaList();
  renderStats();
  savePrefs();
  toast('Đã lưu cấu hình');
}

// ---------- Sự kiện ----------
function bindEvents() {
  $('#btn-logout').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  };
  $$('.tab[data-tab]').forEach((b) => b.addEventListener('click', () => {
    $$('.tab[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab-page').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'history') loadHistory();
    if (b.dataset.tab === 'auto') loadAutoTab().catch((e) => toast(e.message));
  }));

  // Tab tự động: tải lại số liệu mỗi 15 giây khi đang mở.
  setInterval(() => {
    if (!$('#tab-auto').classList.contains('hidden')) loadAutoTab().catch(() => {});
  }, 15000);
  $('#tab-auto').addEventListener('input', (e) => { if (e.target.closest('.auto-grid > .card:first-child')) S.autoFormDirty = true; });
  $('#auto-save').onclick = () => saveAuto().catch((e) => toast(e.message));
  $('#auto-run').onclick = async () => {
    if (!confirm('Chạy ngay 1 lượt đồng bộ với các mục và xã đã lưu? (Lượt này cũng tính vào giới hạn trong ngày)')) return;
    await api('/api/auto/run', { method: 'POST' }).catch((e) => toast(e.message));
    toast('Đã bắt đầu đồng bộ');
    setTimeout(() => loadAutoTab().catch(() => {}), 1000);
  };
  $('#u-refresh').onclick = () => loadAutoTab().catch((e) => toast(e.message));
  $('#u-all-sys').addEventListener('change', renderUsage);
  $('#u-excel').onclick = exportUsage;
  $('#u-quota').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act=unblock]');
    if (!btn || !confirm('Bỏ chặn? Nếu LGSP vẫn đang khóa, lượt gọi tiếp theo sẽ lại bị 429.')) return;
    await api('/api/usage/unblock', { method: 'POST', body: JSON.stringify({ xaId: btn.dataset.xa, sys: btn.dataset.sys }) });
    loadAutoTab();
  });

  $('#catalog').addEventListener('click', (e) => {
    const head = e.target.closest('.cat-head');
    if (head && !e.target.matches('input')) head.parentElement.classList.toggle('open');
  });
  $('#catalog').addEventListener('change', (e) => {
    if (e.target.matches('.cat-check')) {
      const cat = S.catalog.find((c) => c.id === e.target.dataset.cat);
      cat.items.forEach((it) => (e.target.checked ? S.selItems.add(`${cat.id}.${it.id}`) : S.selItems.delete(`${cat.id}.${it.id}`)));
    } else if (e.target.matches('.item-check')) {
      e.target.checked ? S.selItems.add(e.target.value) : S.selItems.delete(e.target.value);
    }
    renderCatalog(); renderStats(); savePrefs();
  });
  $('#cat-search').addEventListener('input', renderCatalog);
  $('#cat-all').onclick = () => { S.items.forEach((_, k) => S.selItems.add(k)); renderCatalog(); renderStats(); savePrefs(); };
  $('#cat-none').onclick = () => { S.selItems.clear(); renderCatalog(); renderStats(); savePrefs(); };

  $('#xa-list').addEventListener('change', (e) => {
    if (!e.target.matches('.xa-check')) return;
    e.target.checked ? S.selXa.add(e.target.value) : S.selXa.delete(e.target.value);
    updateRunButton(); renderStats(); savePrefs();
  });
  $('#xa-all').onclick = () => { S.config.xa.forEach((x) => S.selXa.add(x.id)); renderXaList(); renderStats(); savePrefs(); };
  $('#xa-none').onclick = () => { S.selXa.clear(); renderXaList(); renderStats(); savePrefs(); };

  $('#presets').addEventListener('click', (e) => {
    if (e.target.dataset.preset) { applyPreset(e.target.dataset.preset); savePrefs(); }
  });
  ['#from', '#to'].forEach((s) => $(s).addEventListener('change', () => {
    S.preset = null;
    $$('#presets .chip').forEach((c) => (c.style.borderColor = ''));
    savePrefs();
  }));
  ['#opt-autosave', '#opt-autoexcel', '#opt-interval', '#opt-concurrency', '#opt-delay'].forEach((s) => $(s).addEventListener('change', savePrefs));
  $('#opt-iter').addEventListener('input', () => { updateRunButton(); savePrefs(); });
  $('#iter-excel').onclick = exportIters;
  $('#iter-hide').onclick = () => $('#iter-card').classList.add('hidden');
  $('#opt-schedule').addEventListener('change', () => { S.nextRunAt = null; tickSchedule(); });
  $('#opt-interval').addEventListener('change', () => { S.nextRunAt = null; });

  $('#btn-run').onclick = () => runTasks(selectedPairs());
  $('#btn-stop').onclick = stopRun;

  $('#view-toggle').addEventListener('click', (e) => {
    if (!e.target.dataset.view) return;
    S.view = e.target.dataset.view;
    $$('#view-toggle .seg-btn').forEach((b) => b.classList.toggle('active', b === e.target));
    renderStats(); savePrefs();
  });
  $('#status-filter').addEventListener('change', renderStats);
  $('#only-selected').addEventListener('change', renderStats);
  $('#btn-excel-stats').onclick = exportExcelStats;
  $('#btn-excel-all').onclick = () => exportExcelAll();
  $('#stats-wrap').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !el.dataset.act || el.disabled) return;
    if (el.dataset.act === 'view') openViewer(el.dataset.key);
    if (el.dataset.act === 'rerun') runTasks([el.dataset.key]);
  });
  $('#log-clear').onclick = () => { $('#log').innerHTML = ''; };

  $('#v-close').onclick = () => $('#viewer').classList.add('hidden');
  $('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') $('#viewer').classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#viewer').classList.add('hidden'); });
  let vt;
  $('#v-search').addEventListener('input', (e) => {
    clearTimeout(vt);
    vt = setTimeout(() => { S.viewer.q = e.target.value.trim(); loadViewer(true); }, 300);
  });
  $('#v-more').onclick = () => loadViewer(false);
  $('#v-excel').onclick = exportViewerExcel;

  $('#hist-refresh').onclick = loadHistory;
  $('#hist-search').addEventListener('input', renderHistory);
  $('#hist-excel').onclick = exportHistory;

  $('#cfg-save').onclick = () => saveConfig().catch((e) => toast(e.message));
  $('#cfg-add').onclick = () => {
    const form = readConfigForm();
    S.config = { ...S.config, settings: { ...S.config.settings, ...form.settings }, xa: [...form.xa, { name: '' }] };
    renderConfig();
    $$('.xa-card').at(-1).scrollIntoView({ behavior: 'smooth' });
  };
  $('#cfg-xa').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.xa-card');
    if (btn.dataset.act === 'remove-xa') {
      if (!confirm('Xóa xã này khỏi cấu hình? (Cần bấm "Lưu cấu hình" để áp dụng)')) return;
      card.remove();
    }
    if (btn.dataset.act === 'test-token') {
      const out = $('[data-role=token-result]', card);
      out.textContent = 'Đang thử...';
      const r = await api('/api/test-token', { method: 'POST', body: JSON.stringify({ xaId: card.dataset.id }) }).catch((err) => ({ ok: false, error: err.message }));
      out.textContent = r.ok ? '✔ Lấy token thành công' : `✘ ${r.error}`;
      out.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
    }
  });
}

init().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin', `<div style="background:#fdecea;color:#c0362c;padding:12px 24px">Không kết nối được máy chủ: ${esc(e.message)}. Hãy chạy "node server.js" rồi tải lại trang.</div>`);
});
