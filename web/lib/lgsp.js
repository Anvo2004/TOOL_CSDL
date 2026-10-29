// Gọi API LGSP: lấy token, chạy từng loại mục (QLVBDH bất đồng bộ, Góp ý, VPUB, Cổng TTĐT, CSDL PX).

const { parseIso, ddmmyyyy, mmddyyyy, splitRange, extractRows, findKey, maybeParse, sleep } = require('./util');
const store = require('./store');
const usage = require('./usage');

const tokens = new Map(); // consumerKey -> { token, exp }
const callbacks = []; // callback nhận trực tiếp tại /callback (khi server được public ra ngoài)

function recordCallback(body) {
  callbacks.unshift({ receivedAt: Date.now(), body: maybeParse(body) });
  callbacks.length = Math.min(callbacks.length, 500);
}

async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const reason = e.name === 'TimeoutError' ? `quá thời gian chờ ${timeoutMs / 1000}s` : (e.cause && e.cause.code) || e.message;
    throw new Error(`Không kết nối được ${new URL(url).host}: ${reason}`);
  }
  const text = await res.text();
  return { status: res.status, ok: res.ok, headers: res.headers, text, json: maybeParse(text) };
}

function httpError(label, r) {
  const j = r.json && typeof r.json === 'object' ? r.json : {};
  let msg;
  if (r.status === 429) {
    msg = `Đã vượt hạn mức (quota) gọi API của tài khoản${j.nextAccessTime ? `, gọi lại được sau ${j.nextAccessTime}` : ''}`;
  } else if (r.status === 403 && String(j.code) === '900908') {
    msg = 'Tài khoản LGSP của xã chưa được đăng ký (subscribe) API này, cần liên hệ Trung tâm CĐS cấp quyền';
  } else {
    msg = String((typeof r.json === 'object' ? JSON.stringify(r.json) : r.text) || '').slice(0, 300);
  }
  const err = new Error(`${label}: HTTP ${r.status} – ${msg}`);
  err.status = r.status;
  return err;
}

// Một số API trả HTTP 200 nhưng báo lỗi trong nội dung ({success:false} hoặc errorCode != 0).
function bodyError(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (j.success === false) return j.message || j.msg || JSON.stringify(j).slice(0, 300);
  if (j.errorCode != null && String(j.errorCode) !== '0') return `${j.errorCode} ${j.errorDesc || j.errorMessage || j.message || ''}`.trim();
  return null;
}

async function getToken(settings, xa, force = false) {
  if (!xa.key || !xa.secret) throw new Error(`Xã "${xa.name}" chưa cấu hình ConsumerKey/ConsumerSecret`);
  const cached = tokens.get(xa.key);
  if (!force && cached && cached.exp > Date.now()) return cached.token;
  const r = await http(settings.token_url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${xa.key}:${xa.secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok || !r.json || !r.json.access_token) throw httpError('Lấy token thất bại', r);
  const ttl = Math.max(60, Number(r.json.expires_in) || 3600) - 60;
  tokens.set(xa.key, { token: r.json.access_token, exp: Date.now() + ttl * 1000 });
  return r.json.access_token;
}

// Gọi API có Bearer token; nếu 401 thì lấy token mới và thử lại 1 lần.
// Mọi lượt gọi đều được đếm vào hạn mức của (xã, hệ thống) — xem lib/usage.js.
async function api(settings, xa, url, opts = {}) {
  const sys = usage.sysOf(settings, url);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(settings, xa, attempt > 0);
    usage.before(settings, xa, sys);
    let r;
    try {
      r = await http(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    } finally {
      usage.after(settings, xa, sys, r || null);
    }
    if (r.status === 401 && attempt === 0) continue;
    return r;
  }
}

async function apiJson(settings, xa, url, opts, label) {
  const r = await api(settings, xa, url, opts);
  if (!r.ok) throw httpError(label, r);
  const be = bodyError(r.json);
  if (be) throw new Error(`${label}: ${be}`);
  return r.json;
}

const postJson = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---------- Phân trang dùng chung ----------
// Dừng khi: trang rỗng, trang lặp lại trang trước (API không hỗ trợ phân trang),
// đã đủ tổng số bản ghi, hoặc trang ngắn hơn trang đầu tiên.
// trustPageSize: API tôn trọng pageSize nên trang đầu ngắn hơn pageSize là hết dữ liệu (không gọi thử trang 2).
async function paginate(fetchPage, pageSize, maxPages, log, { trustPageSize = false } = {}) {
  const all = [];
  let total = null;
  let prevSig = null;
  let firstLen = null;
  const warnings = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page);
    if (res.warning) warnings.push(res.warning);
    if (res.total != null) total = res.total;
    const rows = res.rows;
    if (!rows.length) break;
    const sig = JSON.stringify(rows[0]);
    if (sig === prevSig) break;
    prevSig = sig;
    all.push(...rows);
    log(`  trang ${page}: ${rows.length} bản ghi${total != null ? ` (tổng ${total})` : ''}`);
    if (total != null && all.length >= total) break;
    if (trustPageSize && rows.length < pageSize) break;
    if (firstLen == null) firstLen = rows.length;
    else if (rows.length < firstLen) break;
    if (page === maxPages) warnings.push(`Dừng ở giới hạn ${maxPages} trang`);
  }
  return { rows: all, warnings };
}

// ---------- QLVBDH (bất đồng bộ qua jobId) ----------
const PENDING = new Set(['RECEIVED', 'ACCEPTED', 'STORED', 'QUEUED', 'PROCESSING', 'PENDING', 'SCHEDULED', 'RUNNING', 'RETRY_WAIT']);
const FAILED = new Set(['REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED']);

// LGSP chỉ gửi jobId qua callback. Khi web có địa chỉ public (Render đặt sẵn RENDER_EXTERNAL_URL)
// thì nhận callback thẳng tại /callback; nếu không, tự tạo một URL webhook.site (giống Postman) và đọc từ đó.
const WEBHOOK_API = 'https://webhook.site';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
let webhookCreating = null;

async function ensureCallback(settings, log) {
  const webhookMatch = (settings.callback_url || '').match(/^https:\/\/webhook\.site\/([0-9a-f-]{36})/i);
  // Có địa chỉ public thì ưu tiên nhận callback trực tiếp, kể cả khi CSDL còn lưu URL webhook.site
  // do bản chạy trên máy tạo ra; chỉ giữ Callback URL khi người dùng tự đặt một địa chỉ khác.
  if (PUBLIC_URL && (!settings.callback_url || webhookMatch)) {
    settings.callback_url = `${PUBLIC_URL}/callback`;
    settings.webhook_token = '';
    return;
  }
  if (settings.callback_url) {
    if (webhookMatch && !settings.webhook_token) settings.webhook_token = webhookMatch[1];
    return;
  }
  if (!webhookCreating) {
    webhookCreating = (async () => {
      const r = await http(`${WEBHOOK_API}/token`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 20000 });
      if (!r.ok || !r.json || !r.json.uuid) throw new Error(`Không tạo được callback webhook.site (HTTP ${r.status}). Hãy tự điền Callback URL trong tab Cấu hình.`);
      const patch = { callback_url: `${WEBHOOK_API}/${r.json.uuid}`, webhook_token: r.json.uuid };
      await store.patchSettings(patch);
      return patch;
    })().finally(() => { webhookCreating = null; });
  }
  Object.assign(settings, await webhookCreating);
  log(`  đã tạo callback ${settings.callback_url}`);
}

// Nhiều tác vụ chạy song song dùng chung một lần đọc webhook.site trong mỗi 3 giây.
let webhookCache = { token: null, at: 0, promise: null };
function readWebhook(token) {
  if (webhookCache.token === token && Date.now() - webhookCache.at < 3000) return webhookCache.promise;
  const promise = http(`${WEBHOOK_API}/token/${encodeURIComponent(token)}/requests?sorting=newest&per_page=100`, { headers: { Accept: 'application/json' }, timeoutMs: 20000 })
    .then((r) => {
      if (r.status === 404 || r.status === 410) {
        // URL webhook.site đã hết hạn: xóa để lần sau tự tạo mới.
        store.patchSettings({ callback_url: '', webhook_token: '' }).catch(() => {});
        throw new Error('URL callback webhook.site đã hết hạn, hãy chạy lại để tạo URL mới');
      }
      return r.ok && r.json && Array.isArray(r.json.data) ? r.json.data : [];
    })
    .catch((e) => { if (/hết hạn/.test(e.message)) throw e; return []; });
  webhookCache = { token, at: Date.now(), promise };
  return promise;
}

async function findJobIdFromCallbacks(settings, since, ids, deadline, log) {
  const matches = (c) => {
    if (!c || typeof c !== 'object' || !findKey(c, /^jobId$/i)) return false;
    if (!ids.length) return true;
    const blob = JSON.stringify(c);
    return ids.some((id) => blob.includes(String(id)));
  };
  const accept = (c) => {
    const st = String(findKey(c, /^jobStatus$/i) || '').toUpperCase();
    if (FAILED.has(st)) throw new Error(`Job ${st}: ${findKey(c, /^errorCode$/i) || ''} ${findKey(c, /^errorMessage$/i) || ''}`.trim());
    return findKey(c, /^jobId$/i);
  };
  while (Date.now() < deadline) {
    const local = callbacks.find((c) => c.receivedAt >= since - 2000 && matches(c.body));
    if (local) return accept(local.body);
    if (settings.webhook_token) {
      for (const req of await readWebhook(settings.webhook_token)) {
        const at = Date.parse(String(req.created_at || '').replace(' ', 'T') + 'Z');
        if (Number.isFinite(at) && at < since - 120000) continue;
        const c = maybeParse(req.content);
        if (matches(c)) return accept(c);
      }
    }
    await sleep(3000);
  }
  return null;
}

// Giãn dần khoảng chờ để không tốn hạn mức gọi API trong ngày.
const backoff = (n) => [2000, 3000, 5000, 8000][n] || 10000;

async function pollArtifact(settings, xa, base, jobId, deadline, log) {
  log(`  jobId ${jobId}, đang lấy kết quả...`);
  let last = null;
  for (let n = 0; Date.now() < deadline; n++) {
    const r = await api(settings, xa, `${base}/api/jobs/artifact?jobId=${encodeURIComponent(jobId)}`, { headers: { 'Content-Type': 'application/json' } });
    last = r;
    if (r.ok) {
      const st = String(findKey(r.json, /^(jobStatus|requestStatus)$/i) || '').toUpperCase();
      if (FAILED.has(st)) {
        throw new Error(`Job ${st}: ${findKey(r.json, /^errorCode$/i) || ''} ${findKey(r.json, /^(errorMessage|errorDesc|message)$/i) || ''}`.trim());
      }
      if (!PENDING.has(st)) {
        const be = bodyError(r.json);
        if (be) throw new Error(`Kết quả job: ${be}`);
        return r.json;
      }
    } else if (![202, 404, 409, 425].includes(r.status)) {
      throw httpError('Lấy kết quả job thất bại', r);
    }
    await sleep(backoff(n));
  }
  throw new Error(`Hết thời gian chờ kết quả job ${jobId}${last ? ` (HTTP ${last.status})` : ''}`);
}

async function qlvbdhCall(ctx, action, params, extra = {}) {
  const { settings, xa, log } = ctx;
  if (!xa.organId || !xa.organKey) throw new Error(`Xã "${xa.name}" chưa cấu hình organId/organKey`);
  const base = settings.base_qlvbdh;
  await ensureCallback(settings, log);
  const body = {
    actionName: action,
    organId: xa.organId,
    organKey: xa.organKey,
    ...extra,
    params: { ...params, callbackUrl: settings.callback_url, responseMode: 'CALLBACK_AND_POLLING' },
    use_callback: true,
  };
  const since = Date.now();
  const r = await api(settings, xa, `${base}/api`, postJson(body));
  if (!r.ok) throw httpError('Gửi yêu cầu QLVBDH thất bại', r);
  const be = bodyError(r.json);
  if (be) throw new Error(`Gửi yêu cầu QLVBDH thất bại: ${be}`);
  const st = String(findKey(r.json, /^(requestStatus|jobStatus)$/i) || '').toUpperCase();
  if (FAILED.has(st)) throw new Error(`Yêu cầu bị ${st}: ${findKey(r.json, /^(errorMessage|message)$/i) || JSON.stringify(r.json).slice(0, 300)}`);

  const deadline = since + settings.job_timeout_sec * 1000;
  try {
    let jobId = findKey(r.json, /^jobId$/i);
    if (!jobId) {
      const ids = ['requestCode', 'jobCode', 'requestId'].map((k) => findKey(r.json, new RegExp(`^${k}$`, 'i'))).filter(Boolean);
      log(`  đã gửi yêu cầu ${ids[0] || ''}, chờ callback trả jobId...`);
      jobId = await findJobIdFromCallbacks(settings, since, ids, deadline, log);
      if (!jobId) throw new Error(`Không nhận được jobId. Phản hồi gửi yêu cầu: ${JSON.stringify(r.json).slice(0, 300)}`);
    }
    return await pollArtifact(settings, xa, base, jobId, deadline, log);
  } catch (e) {
    // Hệ thống báo lỗi khi khoảng ngày / trang không có bản ghi nào: coi là kết quả rỗng.
    if (/không tìm thấy dữ liệu/i.test(e.message)) return { data: [] };
    throw e;
  }
}

// Mỗi trang QLVBDH là một job (~10 giây) và thứ tự sắp xếp không ổn định giữa các trang
// (phân trang bị lặp và sót bản ghi), nên lấy 1 trang thật lớn. Nếu trang đầy thì chia đôi
// khoảng ngày; chỉ khi một ngày vẫn đầy mới phải lật trang.
async function qlvbdhWindow(call, d1, d2, size, maxPages, log) {
  const first = extractRows(await call(d1, d2, 1));
  log(`  ${ddmmyyyy(d1)} – ${ddmmyyyy(d2)}: ${first.rows.length} bản ghi`);
  if (first.rows.length < size) return first;
  if (d1 < d2) {
    const mid = new Date(d1);
    mid.setDate(mid.getDate() + Math.floor((d2 - d1) / 86400000 / 2));
    const next = new Date(mid);
    next.setDate(next.getDate() + 1);
    log('  trang đầy, chia nhỏ khoảng ngày...');
    const a = await qlvbdhWindow(call, d1, mid, size, maxPages, log);
    const b = await qlvbdhWindow(call, next, d2, size, maxPages, log);
    return { rows: [...a.rows, ...b.rows], warnings: [a.warning, b.warning, ...(a.warnings || []), ...(b.warnings || [])].filter(Boolean) };
  }
  const rest = await paginate(async (page) => extractRows(await call(d1, d2, page + 1)), size, maxPages - 1, log, { trustPageSize: true });
  return { rows: [...first.rows, ...rest.rows], warnings: rest.warnings };
}

// ---------- Chạy một mục cho một xã ----------
async function runItem({ settings, xa, item, from, to, log }) {
  const ctx = { settings, xa, log };
  const pageSize = settings.page_size;
  const maxPages = settings.max_pages;
  const windows = item.dated ? splitRange(parseIso(from), parseIso(to), item.maxDays) : [[null, null]];
  const rows = [];
  const warnings = [];

  for (const [d1, d2] of windows) {
    if (d1 && windows.length > 1) log(` đoạn ${ddmmyyyy(d1)} – ${ddmmyyyy(d2)}`);
    let res;
    switch (item.kind) {
      case 'qlvbdh': {
        const dateParams = d1 ? { startDate: ddmmyyyy(d1), endDate: ddmmyyyy(d2) } : {};
        if (item.action === 'getDanhSachDonVi') {
          res = extractRows(await qlvbdhCall(ctx, item.action, { type: '001' }, { data: {} }));
        } else if (item.action === 'LichCongTac') {
          if (!xa.lct_username || xa.lct_username.startsWith('ten@')) throw new Error(`Xã "${xa.name}" chưa cấu hình tài khoản lịch công tác (lct_username)`);
          res = extractRows(await qlvbdhCall(ctx, item.action, { kieuLCT: 1, username: xa.lct_username, maPhongBan: '', ...dateParams }));
        } else {
          const numberKey = item.action === 'getVanBanDen' ? { soDen: '', vanBanDiId: '' } : { soDi: '' };
          const call = (a, b, page) => qlvbdhCall(ctx, item.action, {
            startDate: ddmmyyyy(a), endDate: ddmmyyyy(b), type: '001', soKyHieu: '', ...numberKey, id: '',
            page: String(page), pageSize: String(settings.qlvbdh_page_size),
          });
          res = await qlvbdhWindow(call, d1, d2, settings.qlvbdh_page_size, maxPages, log);
        }
        break;
      }
      case 'gopy': {
        if (!xa.gopy_user || !xa.gopy_pass) throw new Error(`Xã "${xa.name}" chưa cấu hình tài khoản Góp ý`);
        const q = new URLSearchParams({ tungay: ddmmyyyy(d1), denngay: ddmmyyyy(d2), tendangnhap: xa.gopy_user, matkhau: xa.gopy_pass });
        res = extractRows(await apiJson(settings, xa, `${settings.base_gopy}/gopy?${q}`, { headers: { 'Content-Type': 'application/json' } }, 'Góp ý'));
        break;
      }
      case 'vpub': {
        if (!xa.vpub_IDDonVi) throw new Error(`Xã "${xa.name}" chưa cấu hình IDDonVi (VPUB)`);
        res = await paginate(async (page) => extractRows(await apiJson(settings, xa, settings.base_vpub + item.path, postJson({
          IDNhanVienRequest: String(xa.vpub_IDNhanVienRequest || ''),
          IDDonVi: String(xa.vpub_IDDonVi),
          TuNgay: mmddyyyy(d1),
          DenNgay: mmddyyyy(d2),
          SoVanBan: '',
          NoiDungViec: '',
          Page: page,
          PageSize: pageSize,
          ListType: 10,
        }), 'VPUB')), pageSize, maxPages, log);
        break;
      }
      case 'ttdh': {
        res = await paginate(async (page) => extractRows(await apiJson(settings, xa, settings.base_ttdh + item.path,
          postJson({ Page: page, PageSize: pageSize }), 'Cổng TTĐT')), pageSize, maxPages, log);
        break;
      }
      case 'csdlpx': {
        if (!xa.csdlpx_username || !xa.csdlpx_password) throw new Error(`Xã "${xa.name}" chưa cấu hình tài khoản CSDL Phường xã`);
        const q = new URLSearchParams({ username: xa.csdlpx_username, password: xa.csdlpx_password });
        res = extractRows(await apiJson(settings, xa, `${settings.base_csdlpx}${item.path}?${q}`, {}, 'CSDL PX'));
        break;
      }
      default:
        throw new Error(`Loại mục không hỗ trợ: ${item.kind}`);
    }
    rows.push(...res.rows);
    if (res.warning) warnings.push(res.warning);
    if (res.warnings) warnings.push(...res.warnings);
  }
  const unique = dedupeById(rows);
  if (unique.length < rows.length) warnings.push(`Đã loại ${rows.length - unique.length} bản ghi trùng (cùng id)`);
  return { rows: unique, warnings: [...new Set(warnings)] };
}

// Phân trang của một số API trả trùng bản ghi giữa các trang: loại trùng theo id nếu mọi bản ghi đều có id.
function dedupeById(rows) {
  const key = ['id', 'ID', 'Id'].find((k) => rows.length && rows.every((r) => r[k] != null && r[k] !== ''));
  if (!key) return rows;
  const seen = new Set();
  return rows.filter((r) => (seen.has(r[key]) ? false : seen.add(r[key])));
}

module.exports = { runItem, getToken, recordCallback };
