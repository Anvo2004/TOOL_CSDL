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

## Tự động & hạn mức

Tab **Tự động & hạn mức**:

- **Đếm lượt gọi**: mọi lượt gọi API LGSP (thủ công lẫn tự động) được đếm theo ngày, xã và hệ thống: thành công, lỗi, bị chặn (429). Có tổng hôm nay / 7 ngày / 30 ngày, bảng theo ngày, theo xã, xuất Excel. Tab Lịch sử có thêm cột "Lượt gọi API" và "Nguồn".
- **Đồng bộ tự động**: bật lên thì máy chủ tự lấy các mục đã chọn (mặc định Văn bản đến/đi, Lịch công tác, Góp ý, Việc VPUB) cho các xã đã chọn, N lượt mỗi ngày, chia đều trong khung giờ (giờ Việt Nam), lấy dữ liệu N ngày gần nhất và lưu vào CSDL. Mỗi lượt ghi lại số tác vụ thành công / lỗi / bỏ qua và số lượt gọi API. Máy chủ phải đang chạy thì lịch mới chạy (Render gói Starter luôn chạy; gói Free bị ngủ).
- **Hạn mức**: LGSP đặt lại hạn mức lúc 7:00 sáng (00:00 UTC), tính riêng cho từng API của mỗi khóa. Lần đầu bị 429, số lượt đã gọi trước đó được ghi làm hạn mức dò được (lấy giá trị lớn nhất trong 10 lần gần nhất); nếu LGSP trả header `X-RateLimit-Limit` thì dùng luôn số đó. Đồng bộ tự động chỉ dùng tối đa % hạn mức đã đặt (mặc định 80%), khi chưa dò được thì dùng giới hạn mặc định (50 lượt/ngày/hệ thống), hoặc đặt giới hạn cố định. Khi đang bị chặn, web không gửi yêu cầu nào cho đến giờ LGSP mở lại.
- Hạn mức dò được chỉ tính lượt gọi từ web. Nếu cùng khóa còn được dùng ở Postman hoặc nơi khác thì hạn mức thật lớn hơn số dò được.

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
lib/usage.js       đếm lượt gọi API, dò hạn mức, chặn khi bị LGSP khóa
lib/sync.js        chạy tác vụ, lịch đồng bộ tự động trong ngày
lib/store.js       cấu hình, kết quả, lịch sử, lượt gọi, xuất file
lib/util.js        ngày tháng, bóc tách bản ghi, CSV
public/            giao diện web
```

Thêm mục mới: khai báo trong `lib/catalog.js` (nếu cùng kiểu với mục có sẵn thì không cần sửa gì thêm).
