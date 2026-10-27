# Công cụ truy vấn dữ liệu LGSP (Đà Nẵng)

Web chạy trên máy cá nhân để truy vấn dữ liệu từ LGSP cho nhiều xã/phường cùng lúc, thống kê số bản ghi và xuất file.

## Chạy

Cần Node.js 18 trở lên, không phải cài thêm thư viện nào.

```
cd web
node server.js
```

Sau đó mở http://localhost:3000. Trên Windows có thể bấm đúp `start.bat`.

## Sử dụng

1. **Danh mục truy vấn**: tick các mục cần lấy (Văn bản đến, Văn bản đi, Lịch công tác, Danh sách đơn vị, Góp ý, Việc VPUB, Cổng TTĐT, 31 mục CSDL Phường xã).
2. **Xã / phường**: tick các xã cần truy vấn.
3. **Khoảng thời gian**: áp dụng cho các mục có lọc ngày. QLVBDH giới hạn 7 ngày mỗi lần gọi nên công cụ tự chia khoảng dài thành nhiều đoạn 7 ngày.
4. Bấm **Truy vấn**. Mỗi cặp (xã, mục) là một tác vụ, chạy song song theo "Số luồng".

- **Bảng thông số truy vấn**: trạng thái, số bản ghi, thời gian của từng tác vụ, tổng cộng; chế độ **Ma trận** hiển thị xã × mục.
- **Xem**: mở dữ liệu chi tiết, tìm kiếm, tải CSV/JSON/Excel.
- **Excel toàn bộ dữ liệu**: một file gồm sheet "Thong ke" và mỗi mục một sheet.
- **Tự động lưu file**: sau mỗi truy vấn thành công, lưu CSV và JSON vào `exports/<ngày>/`.
- **Tự động truy vấn lại mỗi N phút**: chạy lại theo chu kỳ trong lúc trang còn mở, khoảng ngày nhanh (7 ngày, tháng này...) sẽ được tính lại mỗi lần.
- Tab **Lịch sử** ghi lại mọi lần chạy (`data/history.jsonl`).

## Cấu hình

Tab **Cấu hình** (lưu tại `config/config.json`), đã điền sẵn từ các environment Postman của Điện Bàn, Điện Bàn Bắc, Trà Liên:

- Mỗi xã: ConsumerKey/Secret, organId/organKey, tài khoản Lịch công tác, Góp ý, VPUB, CSDL Phường xã.
- **QLVBDH** chỉ trả `jobId` qua callback. Để trống **Callback URL** thì công cụ tự tạo một URL webhook.site, đọc jobId từ đó rồi lấy kết quả. URL hết hạn sẽ được tự tạo lại. Có thể tự điền URL webhook.site của mình, hoặc `https://<địa-chỉ-public>/callback` nếu máy chủ này được public.
- QLVBDH: mỗi đoạn 7 ngày lấy 1 trang 1000 bản ghi. Nếu trang đầy, công cụ chia đôi khoảng ngày thay vì lật trang, vì phân trang của hệ thống không ổn định (trả trùng và sót bản ghi). Bản ghi trùng `id` được tự loại.
- LGSP giới hạn số lần gọi API mỗi ngày (HTTP 429). Khi bị giới hạn, bảng sẽ ghi rõ thời điểm được gọi lại.
- Các mục thiếu tài khoản (ví dụ CSDL Phường xã chưa được cấp username/password) sẽ báo lỗi rõ ràng trong bảng.

`config/config.json` chứa khóa và mật khẩu, không gửi thư mục này cho người khác. Máy chủ chỉ lắng nghe trên `127.0.0.1`.

## Cấu trúc

```
server.js          máy chủ HTTP + proxy gọi LGSP
lib/catalog.js     danh mục hệ thống và mục truy vấn
lib/lgsp.js        token, gọi API, phân trang, xử lý job QLVBDH
lib/store.js       cấu hình, kết quả, lịch sử, xuất file
lib/util.js        ngày tháng, bóc tách bản ghi, CSV
public/            giao diện web
```

Thêm mục mới: khai báo trong `lib/catalog.js` (nếu cùng kiểu với mục có sẵn thì không cần sửa gì thêm).
