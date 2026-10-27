// Đưa cấu hình xã từ config/config.json (trên máy) lên MongoDB, để bản triển khai trên Render dùng được
// mà không phải đưa khóa/mật khẩu lên GitHub.
// Cách dùng (PowerShell):  $env:MONGODB_URI="mongodb+srv://..."; node scripts/seed-mongo.js [--force]

const fs = require('fs');
const path = require('path');

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('Chưa đặt biến môi trường MONGODB_URI');
  const file = path.join(__dirname, '..', 'config', 'config.json');
  if (!fs.existsSync(file)) throw new Error(`Không thấy ${file}`);
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));

  const store = require('../lib/store');
  await store.init();
  const current = await store.loadConfig();
  if (current.xa.length && !process.argv.includes('--force')) {
    console.log(`MongoDB đã có ${current.xa.length} xã, không ghi đè. Thêm --force để ghi đè.`);
    process.exit(0);
  }
  // Callback webhook.site tạo khi chạy trên máy không dùng cho máy chủ: Render tự nhận callback tại /callback.
  const settings = { ...(local.settings || {}), callback_url: '', webhook_token: '' };
  await store.saveConfig({ settings: { ...current.settings, ...settings }, xa: local.xa || [] });
  console.log(`Đã đưa ${(local.xa || []).length} xã lên MongoDB: ${(local.xa || []).map((x) => x.name).join(', ')}`);
  process.exit(0);
})().catch((e) => {
  console.error('Lỗi:', e.message);
  process.exit(1);
});
