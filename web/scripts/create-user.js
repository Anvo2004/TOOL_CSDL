// Tạo tài khoản đăng nhập cho một xã từ dòng lệnh (trên máy chủ, khi chưa vào được web bằng quản trị).
//   DATA_ROOT=/var/lib/tool-csdl node scripts/create-user.js <tên-đăng-nhập> <mã-xã> [mật-khẩu]
// Để trống mật khẩu thì tự tạo và in ra một lần. Máy chủ đang chạy phải khởi động lại để nhận tài khoản mới.

const store = require('../lib/store');
const users = require('../lib/users');

(async () => {
  const [username, xaId, password] = process.argv.slice(2);
  if (!username || !xaId) {
    console.error('Cách dùng: node scripts/create-user.js <tên-đăng-nhập> <mã-xã> [mật-khẩu]');
    process.exit(2);
  }
  await store.init();
  const cfg = await store.loadConfig();
  if (!cfg.xa.some((x) => x.id === xaId)) throw new Error(`Không có xã "${xaId}". Các mã xã: ${cfg.xa.map((x) => x.id).join(', ')}`);
  await users.init();
  const r = await users.create({ username, password, xaId }, [process.env.APP_USERNAME || '']);
  console.log(`Đã tạo tài khoản "${r.user.username}" cho xã ${xaId}.`);
  if (r.password) console.log(`Mật khẩu (chỉ hiện một lần): ${r.password}`);
  process.exit(0);
})().catch((e) => {
  console.error('Lỗi:', e.message);
  process.exit(1);
});
