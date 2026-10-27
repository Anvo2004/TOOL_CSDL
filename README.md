# TOOL_CSDL – Truy vấn dữ liệu LGSP Đà Nẵng

Web truy vấn dữ liệu LGSP cho nhiều xã/phường: QLVBDH (văn bản đến/đi, lịch công tác, danh sách đơn vị), Góp ý, Điều hành VPUB, Cổng TTĐT, CSDL Phường xã. Có bảng thống kê số bản ghi và xuất CSV / JSON / Excel. Mã nguồn nằm trong [web/](web/), xem [web/README.md](web/README.md).

## Triển khai lên Render

1. **New → Web Service**, chọn repo này. Language: **Docker**. Branch `main`. Root Directory để trống.
2. Region: nên chọn **Singapore** (gần Việt Nam nhất).
3. Mục **Environment Variables**:

   | Biến | Giá trị |
   |---|---|
   | `MONGODB_URI` | chuỗi kết nối MongoDB Atlas, dạng `mongodb+srv://<user>:<password>@<cluster>/` |
   | `APP_USERNAME` | tên đăng nhập vào web |
   | `APP_PASSWORD` | mật khẩu đăng nhập vào web (đặt mật khẩu mạnh) |
   | `SESSION_SECRET` | chuỗi ngẫu nhiên bất kỳ (không bắt buộc) |

4. Health Check Path: `/healthz`. Bấm **Deploy**.
5. MongoDB Atlas → Network Access phải cho phép `0.0.0.0/0`, vì Render không có IP cố định.

Không có `APP_USERNAME` / `APP_PASSWORD` thì web từ chối khởi động, để không lộ tài khoản LGSP ra Internet.

## Đưa cấu hình xã lên MongoDB

Khóa LGSP **không** nằm trong repo. Có hai cách nhập:

- Đăng nhập web → tab **Cấu hình** → thêm xã và điền khóa → **Lưu cấu hình**.
- Hoặc đẩy cấu hình đang có trên máy (`web/config/config.json`) lên MongoDB:

  ```powershell
  cd web
  $env:MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/"
  node scripts/seed-mongo.js
  ```

## Callback QLVBDH

Trên Render, LGSP gửi callback thẳng về `https://<tên-app>.onrender.com/callback`. Địa chỉ này lấy từ biến `RENDER_EXTERNAL_URL` do Render tự đặt, không cần cấu hình hay dùng webhook.site.

## Chạy trên máy

```
cd web
npm install
node server.js      # http://localhost:3000, lưu bằng file, không cần đăng nhập
```
