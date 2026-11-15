const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../lib/db');
const secret = require('../lib/secret');
const { extractRows } = require('../lib/util');
const { ITEMS } = require('../lib/catalog');

test('CSDL PX empty envelope is not counted as a record', () => {
  const env = { success: true, user: 'x', phuongxa: 'y', page: 1, per_page: 10, totalrecord: 0, totalpages: 0, ketqua: [] };
  assert.equal(extractRows(env).rows.length, 0);
  assert.equal(extractRows({ ...env, ketqua: null }).rows.length, 0);
  assert.deepEqual(extractRows({ ...env, totalrecord: 1, ketqua: [{ id: 1 }] }).rows, [{ id: 1 }]);
});

test('config secrets round-trip through AES-GCM', () => {
  secret.setKey('unit-key');
  const enc = secret.encrypt('mật khẩu');
  assert.match(enc, /^enc:v1:/);
  assert.equal(secret.decrypt(enc), 'mật khẩu');
  secret.setKey('other-key');
  assert.throws(() => secret.decrypt(enc), /CONFIG_KEY/);
  secret.setKey(null);
  assert.throws(() => secret.decrypt(enc), /CONFIG_KEY/);
  assert.equal(secret.encrypt('plain'), 'plain');
});

test('SQLite store tracks new, updated and removed records', { skip: !db.available() }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-csdl-db-'));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(db.init(root));
  const item = ITEMS.get('csdlpx.TonGiao');
  const run = (rows, at) => db.ingest({ ok: true, xaId: 'xa1', startedAt: at, source: 'auto', rows }, item);

  const a = { id: 1, tencoso: 'Chùa Thanh Phước', ngaycap: '05/03/2020' };
  const b = { id: 2, tencoso: 'Giáo xứ Trung Phước' };
  const c = { id: 3, tencoso: 'Hội thánh' };
  assert.deepEqual(run([a, b, c], '2026-11-01T00:00:00Z'), { total: 3, added: 3, updated: 0, removed: 0, unchanged: 0, note: null });
  // Bản ghi 2 đổi nội dung, bản ghi 3 biến mất, vỏ phân trang bị bỏ qua.
  const r = run([a, { ...b, tencoso: 'Giáo xứ Trung Phước 2' }, { page: 1, per_page: 10, totalrecord: 2, ketqua: [] }], '2026-11-02T00:00:00Z');
  assert.deepEqual(r, { total: 2, added: 0, updated: 1, removed: 1, unchanged: 1, note: null });
  // Phản hồi rỗng: không đánh dấu mất hàng loạt.
  assert.match(run([], '2026-11-03T00:00:00Z').note, /Bỏ qua đánh dấu mất 2/);

  const s = db.summary(['xa1'])[0];
  assert.equal(s.active, 2);
  assert.equal(s.removed, 1);
  assert.equal(s.sector, 'vanhoagd');
  assert.equal(db.stats().changes, 2); // lần đầu không ghi từng bản ghi "mới"
  const rec = db.normalize(a);
  assert.equal(rec.title, 'Chùa Thanh Phước');
  assert.equal(rec.date, '2020-03-05');
  assert.match(rec.search, /chua thanh phuoc/);

  const out = path.join(root, 'copy.sqlite');
  assert.ok(db.backupTo(out));
  assert.ok(fs.statSync(out).size > 0);
});
