// Dashboard tổng hợp, dashboard chuyên ngành, tra cứu toàn kho và biểu đồ cho các tab vận hành.
// Dùng chung các tiện ích của app.js ($, $$, api, esc, fmtNum, S, ic, toast...). Biểu đồ: Chart.js (vendor/chart.umd.js).

const SECTOR_META = {
  vanphong: { color: '#2563eb', chip: 'c-blue', icon: 'briefcase', grad: 'g-blue' },
  laodongxh: { color: '#ea580c', chip: 'c-orange', icon: 'heart-handshake', grad: 'g-orange' },
  doanthe: { color: '#e11d48', chip: 'c-rose', icon: 'users-round', grad: 'g-rose' },
  vanhoagd: { color: '#7c3aed', chip: 'c-violet', icon: 'landmark', grad: 'g-violet' },
  kinhte: { color: '#059669', chip: 'c-green', icon: 'sprout', grad: 'g-green' },
  yte: { color: '#0891b2', chip: 'c-cyan', icon: 'stethoscope', grad: 'g-cyan' },
  trattu: { color: '#ca8a04', chip: 'c-amber', icon: 'shield-check', grad: 'g-amber' },
  quansu: { color: '#475569', chip: 'c-slate', icon: 'shield', grad: 'g-slate' },
};
const PALETTE = ['#2563eb', '#f97316', '#10b981', '#a855f7', '#ec4899', '#06b6d4', '#eab308', '#64748b', '#ef4444', '#84cc16', '#6366f1', '#14b8a6'];
const D = { sectors: [], overview: null, sector: null, search: { offset: 0, limit: 50, total: 0, rows: [] }, charts: {}, loaded: {} };

const xaNameOf = (id) => (S.config.xa.find((x) => x.id === id) || {}).name || id;
const itemNameOf = (k) => (S.items.get(k) || {}).name || k;
const sectorOf = (id) => D.sectors.find((s) => s.id === id) || { id, name: id };
const meta = (id) => SECTOR_META[id] || SECTOR_META.vanphong;
const xaColor = (id) => PALETTE[Math.max(0, S.config.xa.findIndex((x) => x.id === id)) % PALETTE.length];
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const ago = (t) => {
  if (!t) return '';
  const m = (Date.now() - Date.parse(t)) / 60000;
  return m < 60 ? `${Math.max(1, Math.round(m))} phút` : m < 1440 ? `${Math.round(m / 60)} giờ` : `${Math.round(m / 1440)} ngày`;
};
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

// ---------- Biểu đồ ----------
function chart(id, config) {
  if (!window.Chart) return null;
  const el = document.getElementById(id);
  if (!el) return null;
  if (D.charts[id]) D.charts[id].destroy();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  D.charts[id] = new Chart(el, { ...config, options: { responsive: true, maintainAspectRatio: false, ...(config.options || {}) } });
  return D.charts[id];
}
const gridOpts = (stacked = false, horizontal = false) => ({
  scales: {
    x: { stacked, grid: { display: horizontal, color: '#eef1f5' }, ticks: horizontal ? { callback: (v) => fmtNum(v) } : {} },
    y: { stacked, grid: { display: !horizontal, color: '#eef1f5' }, beginAtZero: true, ticks: horizontal ? {} : { callback: (v) => fmtNum(v) } },
  },
  plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label ? c.dataset.label + ': ' : ''}${fmtNum(c.parsed[horizontal ? 'x' : 'y'])}` } } },
});
const noData = (id, msg = 'Chưa có dữ liệu') => {
  if (D.charts[id]) { D.charts[id].destroy(); delete D.charts[id]; }
  const el = document.getElementById(id);
  if (!el) return;
  const box = el.parentElement;
  let p = box.querySelector('.empty');
  if (!p) { p = document.createElement('div'); p.className = 'empty'; box.appendChild(p); }
  p.textContent = msg;
  el.classList.add('hidden');
};
const hasData = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  const p = el.parentElement.querySelector('.empty');
  if (p) p.remove();
};

function kpi({ label, value, sub = '', icon, grad = 'g-blue' }) {
  return `<div class="kpi ${grad}"><div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="kpi-ic">${ic(icon)}</span></div>
    <div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div></div>`;
}

function fillXaSelect(sel, allLabel = 'Tất cả xã / phường') {
  const el = $(sel);
  if (!el) return;
  const cur = el.value;
  el.innerHTML = `<option value="">${allLabel}</option>` + S.config.xa.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  el.value = cur;
}

// ---------- Khởi tạo ----------
window.onReady = async () => {
  // Đợi font tải xong để biểu đồ đo đúng độ rộng chữ trên trục.
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
  if (S.me.role !== 'xa') ['#d-xa', '#s-xa', '#r-xa'].forEach((s) => fillXaSelect(s));
  // Tài khoản xã: giao diện mang tên xã, mọi số liệu chỉ của xã đó.
  if (S.me.role === 'xa' && S.me.xaName) {
    $('.brand h1').textContent = S.me.xaName;
    $('.brand p').textContent = 'Cổng dữ liệu LGSP · Đà Nẵng';
    document.title = `${S.me.xaName} · Dữ liệu LGSP`;
    $('#tab-dash .page-title').textContent = `Tổng quan dữ liệu ${S.me.xaName}`;
    $('#tab-sector .page-title').textContent = `Dashboard chuyên ngành · ${S.me.xaName}`;
  }
  $('#d-xa').addEventListener('change', () => loadDash().catch((e) => toast(e.message)));
  $('#d-refresh').onclick = () => loadDash().catch((e) => toast(e.message));
  $('#s-xa').addEventListener('change', () => loadSector().catch((e) => toast(e.message)));
  $('#s-sectors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sector]');
    if (!b) return;
    D.sectorId = b.dataset.sector;
    loadSector().catch((err) => toast(err.message));
  });
  bindSearch();
  $('#bk-run').onclick = async () => {
    $('#bk-run').disabled = true;
    try {
      const r = await api('/api/backups', { method: 'POST' });
      toast(`Đã sao lưu ${r.files.length} tệp (${r.day})`);
      loadBackups();
    } catch (e) { toast(e.message); }
    $('#bk-run').disabled = false;
  };
  setInterval(() => { if (!$('#tab-dash').classList.contains('hidden')) loadDash().catch(() => {}); }, 120000);
  const want = location.hash.slice(1);
  const btn = want && document.querySelector(`.tab[data-tab="${want}"]:not(.hidden)`);
  if (btn) btn.click();
  else await loadDash().catch((e) => toast(e.message));
};

window.onTabShow = (tab) => {
  history.replaceState(null, '', tab === 'dash' ? location.pathname : '#' + tab);
  if (tab === 'dash') loadDash().catch((e) => toast(e.message));
  if (tab === 'sector') loadSector().catch((e) => toast(e.message));
  if (tab === 'search' && !D.loaded.search) runSearch(0).catch((e) => toast(e.message));
  if (tab === 'config' && S.me.role !== 'xa') loadBackups();
};

// ---------- Tổng quan ----------
async function loadDash() {
  const xa = $('#d-xa').value;
  const [ov, u, auto] = await Promise.all([
    api('/api/dash/overview?' + qs({ xa })),
    api('/api/usage?days=30&runs=1'),
    api('/api/auto').catch(() => null),
  ]);
  D.overview = ov;
  D.sectors = ov.sectors || [];
  if (!ov.enabled) {
    $('#d-kpis').innerHTML = '<div class="card empty">Kho dữ liệu chưa bật trên máy chủ (cần Node.js ≥ 22.13).</div>';
    return;
  }
  const xaIds = xa ? [xa] : S.config.xa.map((x) => x.id);
  const items = ov.byItem || [];
  const total = items.reduce((s, r) => s + r.active, 0);
  const itemsWithData = new Set(items.filter((r) => r.active).map((r) => r.item_key));
  const t = u.totals.today;
  const rate = t.calls ? `${Math.round((t.ok / t.calls) * 100)}%` : '–';
  const autoRows = auto ? (auto.overview && auto.overview.length ? auto.overview : auto.selected ? [{ ...auto.selected, enabled: auto.selected.auto.enabled, mode: auto.selected.auto.mode, items: auto.selected.auto.items.length }] : []) : [];
  const autoOn = autoRows.filter((r) => r.enabled).length;
  const ch = (ov.syncsDaily || []).reduce((s, r) => s + (r.added || 0) + (r.updated || 0) + (r.removed || 0), 0);
  $('#d-kpis').innerHTML = [
    kpi({ label: 'Tổng bản ghi trong kho', value: fmtNum(total), sub: `${xaIds.length} xã / phường`, icon: 'database', grad: 'g-blue' }),
    kpi({ label: 'Mục có dữ liệu', value: `${itemsWithData.size}<small style="font-size:16px;opacity:.8">/${S.items.size}</small>`, sub: `${D.sectors.filter((s) => items.some((r) => r.sector === s.id && r.active)).length} ngành`, icon: 'layers', grad: 'g-violet' }),
    kpi({ label: 'Lượt gọi API hôm nay', value: fmtNum(t.calls), sub: `từ 07:00 · ${fmtNum(t.err)} lỗi`, icon: 'activity', grad: 'g-orange' }),
    kpi({ label: 'Tỷ lệ gọi thành công', value: rate, sub: `${fmtNum(t.tasksOk)} truy vấn thành công`, icon: 'circle-check', grad: 'g-green' }),
    kpi({ label: 'Đồng bộ tự động', value: `${autoOn}/${autoRows.length || xaIds.length}`, sub: 'xã đang bật', icon: 'zap', grad: 'g-cyan' }),
    kpi({ label: 'Biến động 30 ngày', value: fmtNum(ch), sub: 'bản ghi mới / sửa / mất', icon: 'trending-up', grad: 'g-rose' }),
  ].join('');

  // Bản ghi theo xã & ngành (cột chồng)
  const sectorsUsed = D.sectors.filter((s) => ov.bySectorXa.some((r) => r.sector === s.id));
  if (sectorsUsed.length) {
    hasData('c-xa');
    chart('c-xa', {
      type: 'bar',
      data: {
        labels: xaIds.map(xaNameOf),
        datasets: sectorsUsed.map((s) => ({
          label: s.name, backgroundColor: meta(s.id).color, borderRadius: 4, maxBarThickness: 56,
          data: xaIds.map((x) => (ov.bySectorXa.find((r) => r.xa_id === x && r.sector === s.id) || {}).n || 0),
        })),
      },
      options: { ...gridOpts(true), plugins: { ...gridOpts(true).plugins, legend: { position: 'bottom' } } },
    });
    hasData('c-sector');
    chart('c-sector', {
      type: 'doughnut',
      data: {
        labels: sectorsUsed.map((s) => s.name),
        datasets: [{ data: sectorsUsed.map((s) => ov.bySectorXa.filter((r) => r.sector === s.id).reduce((a, r) => a + r.n, 0)), backgroundColor: sectorsUsed.map((s) => meta(s.id).color), borderWidth: 2, borderColor: '#fff' }],
      },
      options: { cutout: '62%', plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtNum(c.parsed)}` } } } },
    });
  } else { noData('c-xa'); noData('c-sector'); }

  // Văn bản đến / đi theo tháng
  const months = [...new Set(ov.docsMonthly.map((r) => r.m))].sort();
  if (months.length) {
    hasData('c-docs');
    const sum = (k, m) => ov.docsMonthly.filter((r) => r.item_key === k && r.m === m).reduce((a, r) => a + r.n, 0);
    chart('c-docs', {
      type: 'bar',
      data: {
        labels: months.map((m) => `${m.slice(5)}/${m.slice(0, 4)}`),
        datasets: [
          { label: 'Văn bản đến', data: months.map((m) => sum('qlvbdh.vbden', m)), backgroundColor: '#06b6d4', borderRadius: 6, maxBarThickness: 36 },
          { label: 'Văn bản đi', data: months.map((m) => sum('qlvbdh.vbdi', m)), backgroundColor: '#6366f1', borderRadius: 6, maxBarThickness: 36 },
        ],
      },
      options: { ...gridOpts(), plugins: { ...gridOpts().plugins, legend: { position: 'bottom' } } },
    });
  } else noData('c-docs', 'Chưa có văn bản đến/đi trong kho');

  // Lượt gọi API 30 ngày
  const daily = [...u.daily].reverse();
  if (daily.length) {
    hasData('c-calls');
    chart('c-calls', {
      type: 'bar',
      data: {
        labels: daily.map((d) => ddmm(d.day)),
        datasets: [
          { label: 'Thành công', data: daily.map((d) => d.ok), backgroundColor: '#10b981', borderRadius: 4, maxBarThickness: 28 },
          { label: 'Lỗi', data: daily.map((d) => d.err), backgroundColor: '#f43f5e', borderRadius: 4, maxBarThickness: 28 },
        ],
      },
      options: { ...gridOpts(true), plugins: { ...gridOpts(true).plugins, legend: { position: 'bottom' } } },
    });
  } else noData('c-calls');

  // Biến động dữ liệu
  const days = [...new Set((ov.changesDaily || []).map((r) => r.d))].sort();
  if (days.length) {
    hasData('c-changes');
    const v = (d, k) => (ov.changesDaily.find((r) => r.d === d && r.kind === k) || {}).n || 0;
    chart('c-changes', {
      type: 'bar',
      data: {
        labels: days.map(ddmm),
        datasets: [
          { label: 'Mới', data: days.map((d) => v(d, 'new')), backgroundColor: '#10b981', borderRadius: 4 },
          { label: 'Thay đổi', data: days.map((d) => v(d, 'update')), backgroundColor: '#f59e0b', borderRadius: 4 },
          { label: 'Không còn', data: days.map((d) => v(d, 'remove')), backgroundColor: '#f43f5e', borderRadius: 4 },
        ],
      },
      options: { ...gridOpts(true), plugins: { ...gridOpts(true).plugins, legend: { position: 'bottom' } } },
    });
  } else noData('c-changes', 'Chưa ghi nhận thay đổi nào');

  // Đồng bộ tự động
  const hourly = (u.policy && u.policy.hourly) || [];
  $('#d-auto').innerHTML = autoRows.length ? autoRows.filter((r) => !xa || r.xaId === xa).map((r) => {
    const h = hourly.find((x) => x.xaId === r.xaId) || { used: 0, limit: 50 };
    const color = r.running ? '#7c3aed' : r.enabled ? '#10b981' : '#cbd5e1';
    const state = r.running ? 'Đang chạy' : r.enabled ? (r.mode === 'hourly' ? 'Liên tục mỗi giờ' : 'Theo mốc giờ') : 'Đang tắt';
    return `<div class="auto-row"><span class="dot" style="background:${color}"></span>
      <div><b>${esc(r.xaName)}</b><div class="sub">${state} · ${r.items} mục${r.lastRun ? ` · gần nhất ${fmtTime(r.lastRun.finishedAt)}` : ''}</div>
        <div class="mini-meter"><span style="width:${Math.min(100, (h.used / h.limit) * 100)}%"></span></div></div>
      <span class="hint" style="margin:0">${h.used}/${h.limit}<br>lượt/60p</span></div>`;
  }).join('') : '<div class="empty">Chưa có lịch.</div>';

  // Độ mới dữ liệu
  const keys = [...S.items.keys()].filter((k) => items.some((r) => r.item_key === k));
  const cell = (x, k) => {
    const r = items.find((y) => y.xa_id === x && y.item_key === k);
    if (!r || !r.active) return '<td class="cell fr-0">–</td>';
    const h = (Date.now() - Date.parse(r.last_seen)) / 3600000;
    const cls = h < 6 ? 'fr-1' : h < 24 ? 'fr-2' : h < 168 ? 'fr-3' : 'fr-4';
    return `<td class="cell ${cls}" title="${esc(fmtNum(r.active))} bản ghi · cập nhật ${esc(fmtTime(r.last_seen))}">${fmtNum(r.active)}<br><small>${ago(r.last_seen)}</small></td>`;
  };
  $('#d-fresh').innerHTML = keys.length ? `<table class="fresh"><thead><tr><th>Ngành</th><th>Mục</th>${xaIds.map((x) => `<th class="num">${esc(xaNameOf(x))}</th>`).join('')}</tr></thead>
    <tbody>${keys.map((k) => {
      const it = S.items.get(k);
      const sec = (items.find((r) => r.item_key === k) || {}).sector;
      return `<tr><td class="nw"><span class="pill ${meta(sec).chip}">${esc(sectorOf(sec).name)}</span></td><td class="nw">${esc(it.name)}</td>${xaIds.map((x) => cell(x, k)).join('')}</tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">Kho chưa có dữ liệu.</div>';
}

// ---------- Chuyên ngành ----------
async function loadSector() {
  if (!D.overview) await loadDash();
  const xa = $('#s-xa').value;
  const ov = D.overview;
  const totals = Object.fromEntries(D.sectors.map((s) => [s.id, ov.bySectorXa.filter((r) => r.sector === s.id && (!xa || r.xa_id === xa)).reduce((a, r) => a + r.n, 0)]));
  if (!D.sectorId) D.sectorId = (D.sectors.find((s) => s.id === 'laodongxh' && totals[s.id]) || D.sectors.find((s) => totals[s.id]) || D.sectors[0] || {}).id;
  $('#s-sectors').innerHTML = D.sectors.map((s) => {
    const m = meta(s.id);
    const on = s.id === D.sectorId;
    return `<button class="sector-btn ${on ? 'active' : ''}" data-sector="${s.id}" style="${on ? `background:${m.color}` : ''}">
      <span class="ic-chip ${m.chip}">${ic(m.icon)}</span>${esc(s.name)} <span class="n">${fmtNum(totals[s.id])}</span></button>`;
  }).join('');
  if (!D.sectorId) return;
  const r = await api('/api/dash/sector?' + qs({ sector: D.sectorId, xa }));
  const m = meta(D.sectorId);
  const sector = sectorOf(D.sectorId);
  const sectorItems = [...S.items.values()].filter((it) => r.counts.some((c) => c.item_key === it.key));
  const emptyItems = [...S.items.values()].filter((it) => it.sector === D.sectorId && !sectorItems.includes(it));
  const xaIds = xa ? [xa] : S.config.xa.map((x) => x.id);
  $('#s-kpis').innerHTML = sectorItems.map((it, i) => {
    const cs = r.counts.filter((c) => c.item_key === it.key);
    const n = cs.reduce((a, c) => a + c.n, 0);
    return kpi({ label: it.name, value: fmtNum(n), sub: `${cs.length} xã có dữ liệu`, icon: i ? 'database' : m.icon, grad: i % 2 ? 'g-slate' : m.grad });
  }).join('') + (emptyItems.length ? `<div class="kpi light"><div class="kpi-top"><span class="kpi-label">Chưa có dữ liệu</span><span class="ic-chip c-slate">${ic('inbox')}</span></div>
    <div class="kpi-sub">${emptyItems.map((it) => esc(it.name)).join(', ')}</div></div>` : '');
  $('#s-chart-title').textContent = `${sector.name}: số bản ghi theo mục và xã`;
  if (sectorItems.length) {
    hasData('c-sector-xa');
    chart('c-sector-xa', {
      type: 'bar',
      data: {
        labels: sectorItems.map((it) => it.name),
        datasets: xaIds.map((x) => ({
          label: xaNameOf(x), backgroundColor: xaColor(x), borderRadius: 5, maxBarThickness: 40,
          data: sectorItems.map((it) => (r.counts.find((c) => c.item_key === it.key && c.xa_id === x) || {}).n || 0),
        })),
      },
      options: { ...gridOpts(), plugins: { ...gridOpts().plugins, legend: { position: 'bottom' } } },
    });
  } else noData('c-sector-xa', 'Ngành này chưa có dữ liệu trong kho');

  // Phân bố theo thuộc tính
  Object.keys(D.charts).filter((id) => id.startsWith('bd-')).forEach((id) => { D.charts[id].destroy(); delete D.charts[id]; });
  const cards = [];
  for (const it of sectorItems) for (const b of (r.breakdowns[it.key] || [])) cards.push({ it, b, id: `bd-${cards.length}` });
  $('#s-breakdowns').innerHTML = cards.map(({ it, b, id }) => `<section class="card bd-card">
    <div class="card-title"><span class="ic-chip ${m.chip}">${ic(b.values.length <= 6 ? 'chart-pie' : 'chart-column')}</span>
      <div><h3>${esc(it.name)} · ${esc(b.label)}</h3><div class="bd-sub">${fmtNum(b.distinct)} giá trị khác nhau</div></div></div>
    <div class="chart-box ${b.values.length > 8 ? 'tall' : ''}"><canvas id="${id}"></canvas></div></section>`).join('')
    || (sectorItems.length ? '<section class="card empty">Dữ liệu ngành này không có thuộc tính phân loại phù hợp để thống kê.</section>' : '');
  for (const { b, id } of cards) {
    const labels = b.values.map((v) => (v.v === 'Khác' || v.v === '(trống)' ? v.v : String(v.v)).slice(0, 40));
    const data = b.values.map((v) => v.n);
    if (b.values.length <= 6) {
      chart(id, {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: PALETTE, borderColor: '#fff', borderWidth: 2 }] },
        options: { cutout: '58%', plugins: { legend: { position: 'right' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtNum(c.parsed)}` } } } },
      });
    } else {
      chart(id, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 5, maxBarThickness: 22 }] },
        options: { indexAxis: 'y', ...gridOpts(false, true), plugins: { ...gridOpts(false, true).plugins, legend: { display: false } } },
      });
    }
  }
}

// ---------- Tra cứu ----------
function bindSearch() {
  const sectorSel = $('#r-sector');
  const fillItems = () => {
    const sec = sectorSel.value;
    const cur = $('#r-item').value;
    $('#r-item').innerHTML = '<option value="">Tất cả mục</option>' + [...S.items.values()].filter((it) => !sec || it.sector === sec)
      .map((it) => `<option value="${esc(it.key)}">${esc(it.name)}</option>`).join('');
    $('#r-item').value = [...$('#r-item').options].some((o) => o.value === cur) ? cur : '';
  };
  const fillSectors = () => {
    sectorSel.innerHTML = '<option value="">Tất cả ngành</option>' + D.sectors.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    fillItems();
  };
  fillSectors();
  sectorSel.addEventListener('focus', () => { if (sectorSel.options.length <= 1) fillSectors(); });
  sectorSel.addEventListener('change', fillItems);
  $('#r-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(0).catch((err) => toast(err.message)); });
  $('#r-form').addEventListener('input', updateCsvLink);
  $('#r-form').addEventListener('change', updateCsvLink);
  $('#r-reset').onclick = () => { $('#r-form').reset(); fillItems(); runSearch(0).catch((err) => toast(err.message)); };
  $('#r-prev').onclick = () => runSearch(Math.max(0, D.search.offset - D.search.limit)).catch((err) => toast(err.message));
  $('#r-next').onclick = () => runSearch(D.search.offset + D.search.limit).catch((err) => toast(err.message));
  $('#r-excel').onclick = () => exportSearchExcel().catch((err) => toast(err.message));
  $('#r-wrap').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (tr) openRecord(D.search.rows[Number(tr.dataset.i)]);
  });
  $('#rec-close').onclick = () => $('#rec-modal').classList.add('hidden');
  $('#rec-modal').addEventListener('click', (e) => { if (e.target.id === 'rec-modal') $('#rec-modal').classList.add('hidden'); });
}

const searchParams = () => Object.fromEntries(new FormData($('#r-form')).entries());
function updateCsvLink() { $('#r-csv').href = '/api/records/export?' + qs(searchParams()); }

async function runSearch(offset) {
  if (!D.sectors.length) {
    const ov = await api('/api/dash/overview');
    D.sectors = ov.sectors || [];
  }
  if ($('#r-sector').options.length <= 1 && D.sectors.length) $('#r-sector').dispatchEvent(new Event('focus'));
  D.loaded.search = true;
  updateCsvLink();
  $('#r-wrap').innerHTML = '<div class="empty">Đang tìm...</div>';
  const r = await api('/api/records?' + qs({ ...searchParams(), offset, limit: D.search.limit }));
  Object.assign(D.search, { offset, total: r.total, rows: r.rows });
  const pages = Math.max(1, Math.ceil(r.total / D.search.limit));
  $('#r-count').innerHTML = `Tìm thấy <b>${fmtNum(r.total)}</b> bản ghi`;
  $('#r-page').textContent = `Trang ${Math.floor(offset / D.search.limit) + 1}/${fmtNum(pages)}`;
  $('#r-prev').disabled = offset <= 0;
  $('#r-next').disabled = offset + D.search.limit >= r.total;
  $('#r-wrap').innerHTML = r.rows.length ? `<table><thead><tr><th>Xã / phường</th><th>Ngành</th><th>Mục</th><th>Tiêu đề / tên</th><th>Ngày</th><th>Cập nhật</th></tr></thead>
    <tbody>${r.rows.map((x, i) => `<tr class="clickable" data-i="${i}">
      <td class="nw"><span class="pill" style="background:${xaColor(x.xa_id)}1a;color:${xaColor(x.xa_id)}">${esc(xaNameOf(x.xa_id))}</span></td>
      <td class="nw"><span class="pill ${meta(x.sector).chip}">${esc(sectorOf(x.sector).name)}</span></td>
      <td class="nw">${esc(itemNameOf(x.item_key))}</td>
      <td><div class="rec-title" title="${esc(x.title)}">${esc(x.title || '(không có tiêu đề)')}</div></td>
      <td class="nw">${x.rec_date ? viDate(x.rec_date) : ''}</td>
      <td class="nw hint" style="margin:0">${ago(x.updated_at)} trước</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">Không có bản ghi phù hợp.</div>';
}

function openRecord(x) {
  if (!x) return;
  $('#rec-title').textContent = x.title || itemNameOf(x.item_key);
  $('#rec-sub').textContent = `${xaNameOf(x.xa_id)} · ${itemNameOf(x.item_key)} · lần đầu thấy ${fmtTime(x.first_seen)}`;
  const flat = flattenObj(x.data);
  $('#rec-body').innerHTML = `<table class="kv"><tbody>${Object.entries(flat).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  $('#rec-modal').classList.remove('hidden');
}
function flattenObj(o, pre = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenObj(v, pre + k + '.', out);
    else out[pre + k] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

async function exportSearchExcel() {
  if (!ensureXlsx()) return;
  const p = searchParams();
  const rows = [];
  for (let off = 0; off < 5000; off += 200) {
    const r = await api('/api/records?' + qs({ ...p, offset: off, limit: 200 }));
    rows.push(...r.rows);
    if (off + 200 >= r.total) break;
  }
  const data = rows.map((x) => ({ 'Xã / phường': xaNameOf(x.xa_id), 'Ngành': sectorOf(x.sector).name, 'Mục': itemNameOf(x.item_key), 'Tiêu đề': x.title, 'Ngày': x.rec_date, ...flattenObj(x.data) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.length ? data : [{ 'Kết quả': 'Không có bản ghi' }]), 'Tra cuu');
  XLSX.writeFile(wb, `tra-cuu_${new Date().toISOString().slice(0, 10)}.xlsx`);
  if (D.search.total > rows.length) toast(`Excel chứa ${fmtNum(rows.length)} bản ghi đầu tiên; dùng "Xuất CSV" để lấy đủ ${fmtNum(D.search.total)}.`, 6000);
}

// ---------- Biểu đồ ở tab Tự động & hạn mức ----------
window.onUsage = (u) => {
  const daily = [...u.daily].reverse();
  if (daily.length) {
    hasData('c-usage');
    chart('c-usage', {
      type: 'bar',
      data: {
        labels: daily.map((d) => ddmm(d.day)),
        datasets: [
          { label: 'Thành công', data: daily.map((d) => d.ok), backgroundColor: '#3b82f6', borderRadius: 4, maxBarThickness: 26 },
          { label: 'Lỗi', data: daily.map((d) => d.err), backgroundColor: '#f43f5e', borderRadius: 4, maxBarThickness: 26 },
        ],
      },
      options: { ...gridOpts(true), plugins: { ...gridOpts(true).plugins, legend: { position: 'bottom' } } },
    });
  } else noData('c-usage');
  const byXa = (u.byXa || []).filter((x) => x.calls);
  if (byXa.length) {
    hasData('c-usage-xa');
    chart('c-usage-xa', {
      type: 'doughnut',
      data: { labels: byXa.map((x) => xaNameOf(x.xaId)), datasets: [{ data: byXa.map((x) => x.calls), backgroundColor: byXa.map((x) => xaColor(x.xaId)), borderColor: '#fff', borderWidth: 2 }] },
      options: { cutout: '60%', plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtNum(c.parsed)} lượt` } } } },
    });
  } else noData('c-usage-xa');
};

// ---------- Lịch sử: thẻ tổng hợp ----------
window.onHistory = (rows) => {
  const ok = rows.filter((h) => h.ok).length;
  const recs = rows.reduce((s, h) => s + (h.ok ? h.count || 0 : 0), 0);
  const calls = rows.reduce((s, h) => s + (h.calls || 0), 0);
  const auto = rows.filter((h) => h.source === 'auto').length;
  $('#h-kpis').innerHTML = [
    kpi({ label: 'Lần chạy', value: fmtNum(rows.length), sub: `${fmtNum(auto)} tự động`, icon: 'history', grad: 'g-blue' }),
    kpi({ label: 'Thành công', value: fmtNum(ok), sub: rows.length ? `${Math.round((ok / rows.length) * 100)}% số lần chạy` : '', icon: 'circle-check', grad: 'g-green' }),
    kpi({ label: 'Lỗi', value: fmtNum(rows.length - ok), sub: 'xem cột Lỗi / cảnh báo', icon: 'circle-x', grad: 'g-rose' }),
    kpi({ label: 'Bản ghi lấy về', value: fmtNum(recs), sub: `${fmtNum(calls)} lượt gọi API`, icon: 'database', grad: 'g-violet' }),
  ].join('');
};

// ---------- Cấu hình: kho dữ liệu & sao lưu ----------
async function loadBackups() {
  try {
    const [d, list] = await Promise.all([api('/api/data/summary'), api('/api/backups')]);
    const s = d.store || {};
    const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
    $('#bk-stats').innerHTML = s.enabled ? [
      kpi({ label: 'Bản ghi trong kho', value: fmtNum(s.records), sub: 'đang còn hiệu lực', icon: 'database', grad: 'g-blue' }),
      kpi({ label: 'Dung lượng kho', value: mb(s.sizeBytes), sub: esc(s.file), icon: 'hard-drive', grad: 'g-violet' }),
      kpi({ label: 'Lần đồng bộ ghi nhận', value: fmtNum(s.syncs), sub: `${fmtNum(s.changes)} thay đổi bản ghi`, icon: 'refresh-cw', grad: 'g-green' }),
      kpi({ label: 'Bản sao lưu', value: fmtNum(list.length), sub: list[0] ? `mới nhất ${viDate(list[0].day)}` : 'chưa có', icon: 'archive', grad: 'g-orange' }),
    ].join('') : `<div class="empty">Kho dữ liệu tắt: ${esc(s.reason || '')}</div>`;
    $('#bk-list').innerHTML = list.length ? `<table><thead><tr><th>Ngày</th><th class="num">Số tệp</th><th class="num">Dung lượng</th></tr></thead>
      <tbody>${list.map((b) => `<tr><td>${ic('archive')} ${viDate(b.day)}</td><td class="num">${b.files}</td><td class="num">${mb(b.sizeBytes)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Chưa có bản sao lưu.</div>';
  } catch (e) {
    $('#bk-stats').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
