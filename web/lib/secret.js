// Mã hóa các trường bí mật trong cấu hình (khóa LGSP, mật khẩu CSDL PX...) bằng AES-256-GCM.
// Khóa giải mã lấy từ biến môi trường CONFIG_KEY (chuỗi bất kỳ, nên dài ≥ 32 ký tự), không lưu cùng dữ liệu.
// Không đặt CONFIG_KEY thì cấu hình lưu dạng thường (chạy thử trên máy cá nhân).

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
let key = null;

function setKey(passphrase) {
  key = passphrase ? crypto.scryptSync(String(passphrase), 'tool-csdl/config/v1', 32) : null;
}
setKey(process.env.CONFIG_KEY);

const enabled = () => !!key;
const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

function encrypt(v) {
  if (!key || v == null || v === '' || isEncrypted(v)) return v;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(v), 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join(':');
}

function decrypt(v) {
  if (!isEncrypted(v)) return v;
  if (!key) throw new Error('Cấu hình đã được mã hóa nhưng máy chủ chưa đặt biến môi trường CONFIG_KEY');
  const [iv, tag, ct] = v.slice(PREFIX.length).split(':').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    throw new Error('Không giải mã được cấu hình: CONFIG_KEY không đúng');
  }
}

module.exports = { setKey, enabled, isEncrypted, encrypt, decrypt };
