---
name: Dữ liệu LGSP Đà Nẵng
description: Giao diện quản trị dữ liệu xã/phường: nền sáng, chữ đậm, màu theo ngành, thẻ KPI chuyển sắc, biểu đồ nhiều màu.
colors:
  canvas: "#f4f6fb"
  surface: "#ffffff"
  ink: "#111827"
  body: "#374151"
  muted: "#6b7280"
  line: "#e5e8ef"
  primary: "#2563eb"
  primary-ink: "#1e40af"
  nav: "#0b1736"
  nav-2: "#13224a"
  ok: "#059669"
  error: "#e11d48"
  warn: "#b45309"
  running: "#7c3aed"
  sector-vanphong: "#2563eb"
  sector-laodongxh: "#ea580c"
  sector-doanthe: "#e11d48"
  sector-vanhoagd: "#7c3aed"
  sector-kinhte: "#059669"
  sector-yte: "#0891b2"
  sector-trattu: "#ca8a04"
  sector-quansu: "#475569"
  series: ["#2563eb", "#f97316", "#10b981", "#a855f7", "#ec4899", "#06b6d4", "#eab308", "#64748b"]
typography:
  family: "Be Vietnam Pro, Segoe UI, Roboto, sans-serif"
  page-title: { fontSize: 24px, fontWeight: 800, letterSpacing: -0.01em }
  card-title: { fontSize: 15px, fontWeight: 600 }
  kpi-value: { fontSize: 28px, fontWeight: 800, letterSpacing: -0.02em, numeric: tabular }
  body: { fontSize: 14px, fontWeight: 400, lineHeight: 1.5 }
  label: { fontSize: 12px, fontWeight: 600 }
  table-head: { fontSize: 12px, fontWeight: 600, textTransform: uppercase, letterSpacing: 0.03em }
rounded:
  sm: 8px
  md: 10px
  lg: 12px
  modal: 16px
  pill: 9999px
spacing: [4px, 8px, 12px, 16px, 22px, 28px]
components:
  sidenav: { background: "linear-gradient({colors.nav}, {colors.nav-2})", width: 248px, activeItem: "gradient blue → violet" }
  kpi-card: { background: "gradient of one accent color", textColor: "#ffffff", rounded: "{rounded.lg}", minHeight: 112px }
  card: { background: "{colors.surface}", border: "1px {colors.line}", rounded: "{rounded.lg}", padding: "16px 18px" }
  icon-chip: { size: 34px, rounded: "{rounded.md}", background: "accent at ~8% opacity", color: accent }
  button-primary: { background: "gradient {colors.primary} → #4f46e5", textColor: "#ffffff", rounded: "{rounded.sm}" }
  status-badge: { rounded: "{rounded.pill}", dot: 6px, soft background of status color }
---

## Tổng quan

Giao diện dành cho **cán bộ xã/phường**: mở ra là thấy ngay số liệu (Tổng quan), đi sâu theo ngành (Chuyên ngành),
tìm một hồ sơ cụ thể (Tra cứu), rồi mới đến các tab vận hành (Truy vấn, Tự động, Lịch sử) và quản trị.

Lấy cảm hứng từ phong cách "structured data" của các bộ DESIGN.md trong *awesome-claude-design*: nền trắng sạch,
chữ đậm, khoảng trắng rộng, và **màu sắc chỉ dùng để mang thông tin**: mỗi ngành một màu cố định, mỗi xã một màu cố định,
trạng thái xanh/đỏ/tím/vàng nhất quán ở mọi bảng và biểu đồ.

## Quy tắc

- **Màu ngành là ngữ nghĩa**: Lao động – Xã hội luôn cam, Văn hóa – Giáo dục luôn tím... (bảng `colors.sector-*`). Không dùng màu ngành cho việc khác.
- **Màu xã** lấy theo thứ tự trong cấu hình từ `series`, giống nhau ở biểu đồ, nhãn tra cứu và chú thích.
- **Thẻ KPI chuyển sắc** chỉ dùng cho số liệu chính đầu trang (tối đa 6 thẻ một hàng). Thẻ phụ dùng nền trắng (`.stat`, `.kpi.light`).
- **Icon** Lucide (nét 2px, `icons.svg`), luôn đi kèm chữ trên nút; icon đứng riêng phải có `title`.
- **Biểu đồ** Chart.js: cột bo góc 4–6px, lưới nhạt `#eef1f5`, chú thích dạng chấm tròn ở dưới; ≤ 6 giá trị dùng vành khuyên, nhiều hơn dùng cột ngang.
- **Dữ liệu cá nhân** (CCCD, điện thoại, số tài khoản) luôn hiện dạng che `••••••789` ở Tra cứu và file xuất.
- **Bảng**: tiêu đề cột in hoa nhỏ màu xám, số căn phải dạng tabular, dòng xen kẽ rất nhạt, hover xanh nhạt.
- **Màn hình nhỏ** (< 860px): menu trái thành thanh ngang chỉ icon; lưới biểu đồ về 1 cột.
