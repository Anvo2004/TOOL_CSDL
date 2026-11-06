// Tài khoản đăng nhập của từng xã: mỗi tài khoản gắn với đúng một xã, chỉ xem, truy vấn và thiết lập được
// xã đó. Tài khoản quản trị là APP_USERNAME / APP_PASSWORD (biến môi trường), quản lý được mọi xã.
// Mật khẩu lưu dạng băm scrypt có salt; `ver` tăng mỗi khi đổi mật khẩu / khóa để phiên cũ hết hiệu lực.

const crypto = require('crypto');
const store = require('./store');

const users = new Map(); // tên đăng nhập -> { _id, xaId, salt, hash, ver, disabled, ... }
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;
const MIN_PASSWORD = 8;

async function init() {
  for (const u of await store.loadUsers()) users.set(u._id, u);
}

const hash = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('hex');
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const get = (username) => users.get(String(username || '').trim().toLowerCase());

function publicUser(u) {
  return {
    username: u._id, xaId: u.xaId, disabled: !!u.disabled,
    createdAt: u.createdAt, passwordChangedAt: u.passwordChangedAt || null, lastLoginAt: u.lastLoginAt || null,
  };
}

const list = () => [...users.values()].map(publicUser).sort((a, b) => a.username.localeCompare(b.username));

// Trả về tài khoản nếu đúng mật khẩu và đang hoạt động.
function verify(username, password) {
  const u = get(username);
  const h = Buffer.from(hash(password, u ? u.salt : 'khong-co-tai-khoan'), 'hex');
  if (!u || u.disabled) return null;
  return crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex')) ? u : null;
}

// Phiên đăng nhập còn hợp lệ: tài khoản còn, chưa bị khóa, chưa đổi mật khẩu từ lúc đăng nhập.
function sessionUser(username, ver) {
  const u = get(username);
  return u && !u.disabled && (u.ver || 0) === ver ? u : null;
}

function checkPassword(p) {
  if (String(p || '').length < MIN_PASSWORD) throw bad(`Mật khẩu phải có ít nhất ${MIN_PASSWORD} ký tự`);
}

const randomPassword = () => crypto.randomBytes(9).toString('base64url');

async function save(u) {
  users.set(u._id, u);
  await store.saveUser(u);
}

function withPassword(u, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { ...u, salt, hash: hash(password, salt), ver: (u.ver || 0) + 1, passwordChangedAt: new Date().toISOString() };
}

// reserved: tên không được dùng (tên đăng nhập của quản trị).
async function create({ username, password, xaId }, reserved = []) {
  const id = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(id)) throw bad('Tên đăng nhập 3–40 ký tự, chỉ gồm chữ thường không dấu, số, dấu chấm, gạch ngang, gạch dưới');
  if (users.has(id) || reserved.map((r) => String(r).toLowerCase()).includes(id)) throw bad(`Tên đăng nhập "${id}" đã có`, 409);
  if (!xaId) throw bad('Chọn xã cho tài khoản');
  const plain = password || randomPassword();
  checkPassword(plain);
  await save(withPassword({ _id: id, xaId, createdAt: new Date().toISOString(), ver: 0 }, plain));
  return { user: publicUser(users.get(id)), password: password ? null : plain };
}

function mustGet(username) {
  const u = get(username);
  if (!u) throw bad(`Không có tài khoản ${username}`, 404);
  return u;
}

// Quản trị đặt lại mật khẩu (để trống = tạo ngẫu nhiên, trả về để gửi cho xã).
async function resetPassword(username, password) {
  const u = mustGet(username);
  const plain = password || randomPassword();
  checkPassword(plain);
  await save(withPassword(u, plain));
  return { password: password ? null : plain };
}

async function changePassword(username, current, next) {
  const u = mustGet(username);
  if (!verify(username, current)) throw bad('Mật khẩu hiện tại không đúng');
  checkPassword(next);
  await save(withPassword(u, next));
  return users.get(u._id);
}

async function update(username, { xaId, disabled }) {
  const u = { ...mustGet(username) };
  if (xaId != null) u.xaId = xaId;
  if (disabled != null && !!disabled !== !!u.disabled) {
    u.disabled = !!disabled;
    u.ver = (u.ver || 0) + 1; // khóa thì đăng xuất ngay
  }
  await save(u);
  return publicUser(u);
}

async function remove(username) {
  const u = mustGet(username);
  users.delete(u._id);
  await store.deleteUser(u._id);
}

async function touchLogin(u) {
  await save({ ...u, lastLoginAt: new Date().toISOString() });
}

module.exports = { init, list, get, verify, sessionUser, create, resetPassword, changePassword, update, remove, touchLogin };
