# Triển khai TOOL_CSDL lên VPS

Ứng dụng chạy bằng tài khoản `tool-csdl`, lắng nghe `127.0.0.1:3010`; Nginx phục vụ `https://csdlapi.dxvtech.vn`.

## Bố trí

- `/opt/tool-csdl/releases/<release>/`: mã nguồn, không chứa khóa LGSP.
- `/opt/tool-csdl/current`: symlink đến bản đang chạy.
- `/etc/tool-csdl.env`: biến môi trường, quyền `0600`, do root quản lý; tham khảo `environment.example`.
- `/var/lib/tool-csdl/{config,data,exports}`: dữ liệu bền vững khi dùng file. `DATA_ROOT` tách dữ liệu khỏi mã nguồn để cập nhật không xóa kết quả.
- `/var/lib/tool-csdl/data/csdl.sqlite`: kho dữ liệu đã chuẩn hóa (tra cứu, dashboard). Lần đầu khởi động tự nạp các kết quả có sẵn trong `data/results`.
- `/var/lib/tool-csdl/backups/<ngày>/`: sao lưu tự động lúc 02:30 (kho SQLite + `config/*.json`), giữ `BACKUP_KEEP_DAYS` ngày.
- `/opt/tool-csdl/node`: Node.js 24 LTS riêng của ứng dụng (cần `node:sqlite`), không đụng tới Node hệ thống mà dịch vụ khác đang dùng.
- `/etc/systemd/system/tool-csdl.service`: tự khởi động cùng VPS, tự khởi động lại khi lỗi; heap Node 192 MiB, giới hạn RAM tiến trình 320 MiB.
- `/etc/nginx/sites-available/tool-csdl`: reverse proxy; `nginx-http.conf` chỉ dùng cho bước cấp chứng chỉ ban đầu. Không chép đè file này sau khi Certbot đã thêm TLS.

## Chuyển từ Render

1. Sao lưu dữ liệu, cấu hình, tài khoản và ghi lại biến môi trường của Render trước khi thay đổi.
2. Nếu Render dùng MongoDB, giữ đúng `MONGODB_URI` và `MONGODB_DB`; không chạy seed lên database đang có dữ liệu. Chỉ dùng bản cấu hình trên máy khi chấp nhận rằng bản đó không bao gồm thay đổi chỉ có trên Render.
3. Giữ `SCHEDULER_ENABLED=false` trên VPS trong khi Render còn chạy lịch tự động, để không gọi trùng và vượt hạn mức.
4. Đặt `PUBLIC_URL=https://csdlapi.dxvtech.vn`. Nếu cấu hình đã lưu một callback Render cụ thể, đổi `settings.callback_url` sang `https://csdlapi.dxvtech.vn/callback`, xóa `webhook_token` cũ.
5. Dừng lịch/ứng dụng Render sau khi kiểm tra VPS, chờ các yêu cầu đang chạy hoàn tất. Sau đó bật `SCHEDULER_ENABLED=true` và khởi động lại dịch vụ VPS. Không cho hai máy dùng cùng bộ đếm hạn mức kiểu file độc lập với cùng một khóa LGSP.

## Cài đặt trên VPS

Yêu cầu Node.js 22.13 trở lên (khuyên dùng 24 LTS, cài riêng vào `/opt/tool-csdl/node`), Nginx và Certbot. Node cũ hơn vẫn chạy nhưng tắt kho SQLite. Tạo tài khoản hệ thống `tool-csdl`, thư mục dữ liệu có chủ sở hữu tương ứng, và file môi trường theo mẫu. Cả `APP_USERNAME` và `APP_PASSWORD` đều bắt buộc khi chạy production, kể cả lắng nghe loopback phía sau Nginx.

```sh
cd /opt/tool-csdl/releases/<release>/web
npm ci --omit=dev
npm test
sudo systemctl daemon-reload
sudo systemctl enable --now tool-csdl
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d csdlapi.dxvtech.vn --redirect
```

Proxy chờ tối đa 900 giây để nhận kết quả QLVBDH bất đồng bộ. Luôn kiểm tra chứng chỉ HTTPS; không bỏ qua xác thực TLS trong kiểm thử.

## Kiểm tra và cập nhật

```sh
curl --fail https://csdlapi.dxvtech.vn/healthz
systemctl status tool-csdl --no-pager
systemctl show tool-csdl -p MemoryCurrent -p MemoryPeak -p NRestarts
journalctl -u tool-csdl --since '15 minutes ago' --no-pager
systemctl status certbot.timer --no-pager
```

`npm test` dùng thư mục tạm và API giả lập cục bộ; không đọc khóa thật hoặc gọi LGSP. Kiểm thử thật phải ghi rõ mục trả dữ liệu, trả rỗng, lỗi, thiếu tài khoản và bị chặn bởi khung giờ/hạn mức. HTTP 200 của `/api/query` không có nghĩa là tác vụ thành công: phải kiểm tra `ok`, `skipped`, `count`, `warnings` và `error`.

Trước mỗi cập nhật, sao lưu `/var/lib/tool-csdl` và `/etc/tool-csdl.env` vào thư mục root có quyền `0700`. Với MongoDB phải dùng bản sao lưu database tương ứng. Giữ bản release trước; trỏ lại symlink `current` và restart dịch vụ để rollback mã nguồn. Không ghi đè dữ liệu bằng backup cũ trừ khi đã xác định cần phục hồi dữ liệu.

VPS 2 GB đang chạy nhiều dịch vụ: theo dõi RAM/swap khi truy vấn lớn hoặc nhiều người dùng. Giới hạn systemd bảo vệ các dịch vụ khác nhưng ứng dụng có thể bị khởi động lại nếu vượt RAM; cần nâng tài nguyên khi tải thực tế vượt mức đã kiểm thử.

## Mã hóa cấu hình và sao lưu

- Đặt `CONFIG_KEY` (chuỗi ngẫu nhiên dài) trong `/etc/tool-csdl.env`. Lần khởi động đầu, khóa và mật khẩu LGSP trong `config.json` được mã hóa (`enc:v1:...`), file chuyển về quyền `0600`. Ghi `CONFIG_KEY` vào nơi an toàn: mất khóa thì phải nhập lại khóa các xã; sai khóa thì ứng dụng báo lỗi, không khởi động.
- Sao lưu ngay: quản trị gọi `POST /api/backups` (hoặc đợi 02:30). Phục hồi: dừng dịch vụ, chép `csdl.sqlite` về `data/` và các `*.json` về `config/`, khởi động lại. Bản sao lưu chứa cấu hình đã mã hóa nên cần đúng `CONFIG_KEY` lúc sao lưu.

## Mật khẩu quản trị

Chỉ tài khoản quản trị được đổi mật khẩu (nút "Đổi mật khẩu" trên thanh trên cùng); tài khoản xã do quản trị đặt lại trong tab "Tài khoản xã/phường". Mật khẩu quản trị đổi trên web được lưu băm trong `/var/lib/tool-csdl/config/admin-auth.json` và thay cho `APP_PASSWORD`. Quên mật khẩu: xóa file này rồi `systemctl restart tool-csdl` để quay về `APP_PASSWORD` trong `/etc/tool-csdl.env`.
