// Tiện ích: ngày tháng, bóc tách bản ghi từ JSON trả về, CSV.

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' -> Date (giờ địa phương, 00:00)
function parseIso(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`Ngày không hợp lệ: ${s}`);
  return new Date(y, m - 1, d);
}
const ddmmyyyy = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const mmddyyyy = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Chia [from, to] thành các đoạn liên tiếp, mỗi đoạn tối đa maxDays ngày (tính cả 2 đầu).
function splitRange(from, to, maxDays) {
  if (from > to) throw new Error('"Từ ngày" phải nhỏ hơn hoặc bằng "Đến ngày"');
  if (!maxDays) return [[from, to]];
  const out = [];
  let start = new Date(from);
  while (start <= to) {
    const end = new Date(start);
    end.setDate(end.getDate() + maxDays - 1);
    out.push([new Date(start), end > to ? new Date(to) : end]);
    start = new Date(end);
    start.setDate(start.getDate() + 1);
  }
  return out;
}

function maybeParse(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try { return JSON.parse(t); } catch { return v; }
}

const LIST_KEYS = /^(data|items|item|result|results|list|rows|records|content|danhsach|value|ds)$/i;
const TOTAL_KEYS = /^(total|totalrecord|totalrecords|totalcount|totalrow|totalrows|totalitems|totalitem|totalelements|tongso|recordstotal|count)$/i;
const ERROR_KEYS = /(message|error|msg|status|code|success|description)/i;

// Tìm danh sách bản ghi trong phản hồi có cấu trúc chưa biết trước.
// Ưu tiên mảng object dài nhất; nếu không có thì mảng nằm dưới khóa quen thuộc (data, items...).
function extractRows(payload) {
  const root = maybeParse(payload);
  if (Array.isArray(root)) return { rows: root.map(normalizeRow), total: null, warning: null };
  if (!root || typeof root !== 'object') {
    return { rows: [], total: null, warning: root == null || root === '' ? 'Phản hồi rỗng' : `Phản hồi không phải JSON: ${String(root).slice(0, 200)}` };
  }

  let best = null;
  let named = null;
  let total = null;
  const visit = (node, key, depth) => {
    node = maybeParse(node);
    if (depth > 6 || node == null || typeof node !== 'object') {
      if (total == null && depth <= 3 && TOTAL_KEYS.test(key || '') && Number.isFinite(Number(node)) && node !== '' && typeof node !== 'boolean') total = Number(node);
      return;
    }
    if (Array.isArray(node)) {
      if (node.some((x) => maybeParse(x) && typeof maybeParse(x) === 'object')) {
        if (!best || node.length > best.length) best = node;
      } else if (!named && LIST_KEYS.test(key || '')) {
        named = node;
      }
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, k, depth + 1);
  };
  visit(root, null, 0);

  const list = best || named;
  if (list) return { rows: list.map(normalizeRow), total, warning: null };

  const keys = Object.keys(root);
  if (keys.length <= 6 && keys.some((k) => ERROR_KEYS.test(k))) {
    return { rows: [], total, warning: `Không có danh sách dữ liệu. Phản hồi: ${JSON.stringify(root).slice(0, 300)}` };
  }
  return { rows: keys.length ? [root] : [], total, warning: null };
}

function normalizeRow(r) {
  r = maybeParse(r);
  return r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r };
}

// Làm phẳng 1 cấp: object con -> "cha.con", mảng -> chuỗi JSON.
function flattenRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2 && typeof v2 === 'object' ? JSON.stringify(v2) : v2;
    } else if (Array.isArray(v)) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function columnsOf(flatRows) {
  const seen = new Set();
  for (const r of flatRows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

function toCsv(rows) {
  const flat = rows.map(flattenRow);
  const cols = columnsOf(flat);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(esc).join(',')];
  for (const r of flat) lines.push(cols.map((c) => esc(r[c])).join(','));
  return '﻿' + lines.join('\r\n');
}

// Tên file an toàn, không dấu.
function slug(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function findKey(obj, re, depth = 0) {
  obj = maybeParse(obj);
  if (depth > 5 || !obj || typeof obj !== 'object') return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && v != null && typeof v !== 'object' && v !== '') return v;
  }
  for (const v of Object.values(obj)) {
    const found = findKey(v, re, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  pad, parseIso, ddmmyyyy, mmddyyyy, isoDate, splitRange,
  maybeParse, extractRows, flattenRow, columnsOf, toCsv, slug, findKey, sleep,
};
