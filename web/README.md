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
- **Chạy lặp N vòng, nghỉ X giây giữa các request** (giống Runner của Postman): có bảng kết quả từng vòng, xuất Excel. Vẫn theo quy định kết nối bên dưới: tác vụ ngoài khung giờ hoặc khi đã dùng đủ lượt trong 60 phút thì bị bỏ qua, cả vòng bị bỏ qua thì tự dừng.
- **Tự động truy vấn lại mỗi N phút**: chạy lại theo chu kỳ trong lúc trang còn mở, khoảng ngày nhanh (7 ngày, tháng này...) sẽ được tính lại mỗi lần.
- Tab **Lịch sử** ghi lại các lần chạy (`data/history.jsonl`), mỗi xã giữ 200 dòng mới nhất.

## Quy định kết nối Trục LGSP (CV 7779/SKHCN-CNTT, từ 05/11/2026)

Web luôn áp dụng ở phía máy chủ (tài khoản xã không tắt được, truy vấn tay, chạy lặp và đồng bộ tự động đều phải theo):

- **Số lượt kết nối mỗi xã**: quy định 50 lần/giờ cho mỗi cơ quan. Web đếm theo từng xã (mỗi xã một khóa LGSP), cửa sổ trượt 60 phút, tính cả lượt lấy token, mặc định dừng ở **45 lượt** để chừa phần cho Postman / thử token (LGSP đếm chung mọi nơi dùng cùng khóa). Bộ đếm được lưu nên khởi động lại máy chủ không bị mất.
- **Khung giờ**: 07:00–18:00 dành cho dịch vụ ưu tiên (giải quyết TTHC, Myportal, Giao nhiệm vụ, Lịch cơ quan); các hệ thống còn lại kết nối 18:00–07:00. Mặc định: Lịch công tác và Việc VPUB chạy ban ngày, các mục còn lại (văn bản đến/đi, góp ý, Cổng TTĐT, CSDL Phường xã...) chạy ngoài giờ. Mỗi mục có nhãn <code>07–18h</code> / <code>18–07h</code> trên giao diện.
- Truy vấn tay ngoài khung giờ, hoặc khi không còn đủ lượt trong 60 phút, bị bỏ qua kèm giờ chạy lại được. Tác vụ cần nhiều lượt hơn cả giới hạn giờ (ví dụ QLVBDH khoảng ngày rất dài) phải chia nhỏ khoảng ngày.
- Quản trị chỉnh số lượt và khung giờ từng mục ở tab **Cấu hình**; chỉ nâng khi đã có văn bản chấp thuận của Sở KH&CN.

## Tài khoản

- **Quản trị**: `APP_USERNAME` / `APP_PASSWORD` (biến môi trường). Thấy mọi xã, sửa cấu hình chung, quy định kết nối, thêm/xóa xã, tạo tài khoản xã.
- **Tài khoản xã**: quản trị tạo ở tab **Tài khoản xã/phường** (tự đặt tên đăng nhập, mật khẩu và chọn xã được cấp quyền; đổi ô xã để chuyển quyền) (để trống mật khẩu thì web tự tạo, chỉ hiện một lần). Mỗi tài khoản gắn với một xã, chỉ thấy xã đó: truy vấn, tự đặt lịch đồng bộ tự động, sửa khóa / tài khoản kết nối của xã, xem lịch sử và lượt gọi. Xã tự đổi mật khẩu bằng nút **Đổi mật khẩu**.
- Mật khẩu lưu dạng băm scrypt. Khóa, đặt lại mật khẩu hoặc xóa tài khoản thì phiên đang đăng nhập bị thoát ngay. Sai mật khẩu 8 lần thì khóa đăng nhập 15 phút theo địa chỉ IP.

## Tự động & hạn mức

Tab **Tự động & hạn mức**:

- **Đồng bộ tự động riêng từng xã**: mỗi xã tự bật/tắt, đặt các mốc giờ trong ngày (giờ Việt Nam, ví dụ `08:00, 14:00, 19:00, 23:00`), số ngày dữ liệu cần lấy và các mục. Đến mốc nào thì chỉ chạy các mục được phép trong khung giờ đó, lần lượt từng mục; khi xã đã dùng đủ lượt trong 60 phút thì chờ có lượt trống rồi chạy tiếp (không quá lúc khung giờ của mục đóng lại). Web cảnh báo mục nào không có mốc giờ nằm trong khung được phép của nó. Quản trị xem được bảng lịch của mọi xã. Máy chủ phải đang chạy thì lịch mới chạy (Render gói Starter luôn chạy; gói Free bị ngủ).
- **Đếm lượt gọi**: mọi lượt gọi API LGSP được đếm theo ngày, xã và hệ thống: thành công, lỗi, bị chặn (429). Có tổng hôm nay / 7 ngày / 30 ngày, số lượt trong 60 phút qua, bảng theo ngày, theo xã, xuất Excel. Tài khoản xã chỉ thấy số của xã mình.
- **Hạn mức ngày**: LGSP đặt lại hạn mức ngày lúc 7:00 sáng (00:00 UTC), tính riêng cho từng API của mỗi khóa. Lần đầu bị 429, số lượt đã gọi trước đó được ghi làm hạn mức dò được; khi đang bị chặn, web không gửi yêu cầu nào cho đến giờ LGSP mở lại.

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
lib/policy.js      quy định kết nối LGSP: lượt / 60 phút mỗi xã, khung giờ từng mục
lib/users.js       tài khoản đăng nhập của các xã
lib/usage.js       đếm lượt gọi API, dò hạn mức ngày, chặn khi bị LGSP khóa
lib/sync.js        chạy tác vụ, lịch đồng bộ tự động riêng từng xã
lib/store.js       cấu hình, kết quả, lịch sử, lượt gọi, xuất file
lib/util.js        ngày tháng, bóc tách bản ghi, CSV
public/            giao diện web
```

Thêm mục mới: khai báo trong `lib/catalog.js` (nếu cùng kiểu với mục có sẵn thì không cần sửa gì thêm).
