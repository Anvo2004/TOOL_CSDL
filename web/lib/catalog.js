// Danh mục các hệ thống và mục truy vấn trên LGSP Đà Nẵng.
// kind quyết định cách gọi API (xem lib/lgsp.js), dated = có lọc theo khoảng ngày,
// maxDays = độ dài tối đa của một lần gọi (khoảng dài hơn sẽ được tự chia nhỏ).

const CSDLPX_ITEMS = [
  ['TonGiao', 'Cơ sở tôn giáo'],
  ['Karaoke', 'Cơ sở Karaoke'],
  ['Massage', 'Cơ sở Massage'],
  ['ThietCheVanHoa', 'Thiết chế văn hóa'],
  ['CoSoLuuTru', 'Cơ sở lưu trú'],
  ['CoSoKhamChuaBenh', 'Cơ sở khám, chữa bệnh'],
  ['CoSoKinhDoanhDuoc', 'Cơ sở kinh doanh dược'],
  ['CoSoThamMyLamDep', 'Cơ sở thẩm mỹ, làm đẹp'],
  ['AnToanThucPham', 'An toàn thực phẩm'],
  ['HoSoOCop', 'Hồ sơ OCOP'],
  ['CauLacBo', 'Câu lạc bộ'],
  ['DanhSachViaHe', 'Vỉa hè'],
  ['CuocHopHoiNghi', 'Cuộc họp hội nghị'],
  ['PCCC', 'PCCC'],
  ['NhomTre', 'Nhóm trẻ'],
  ['TiemChungDongVat', 'Tiêm chủng động vật'],
  ['ViPhamHanhChinh', 'Vi phạm hành chính'],
  ['VanHoaTruyenThong', 'Văn hóa truyền thống'],
  ['NhanHoKhau', 'Nhân hộ khẩu'],
  ['DieuHanhToDanPho', 'Ban điều hành tổ dân phố'],
  ['BTXH', 'Đối tượng hưởng BTXH'],
  ['DanhSachLaoDong', 'Lao động'],
  ['VayVon', 'Vay vốn'],
  ['NguoiCoCong', 'Người có công'],
  ['DoanHoiVien', 'Đoàn viên / hội viên'],
  ['BienSoNha', 'Số nhà'],
  ['ThueDat', 'Nộp thuế sử dụng đất'],
  ['NVQS', 'Đăng ký NVQS'],
  ['QNDuBi', 'Quân nhân dự bị'],
  ['DQTV', 'Dân quân tự vệ'],
  ['DangKyTuoi17', 'Đăng ký tuổi 17'],
];

const CATEGORIES = [
  {
    id: 'qlvbdh',
    name: 'Quản lý văn bản điều hành',
    short: 'QLVBDH',
    note: 'Gọi bất đồng bộ: gửi yêu cầu → nhận jobId → lấy kết quả. Khoảng ngày tối đa 7 ngày/lần (tự chia nhỏ).',
    items: [
      { id: 'donvi', name: 'Danh sách đơn vị', kind: 'qlvbdh', action: 'getDanhSachDonVi', dated: false, paged: false },
      { id: 'vbden', name: 'Văn bản đến', kind: 'qlvbdh', action: 'getVanBanDen', dated: true, maxDays: 7, paged: true },
      { id: 'vbdi', name: 'Văn bản đi', kind: 'qlvbdh', action: 'getVanBanDi', dated: true, maxDays: 7, paged: true },
      { id: 'lich', name: 'Lịch công tác', kind: 'qlvbdh', action: 'LichCongTac', dated: true, maxDays: 7, paged: false },
    ],
  },
  {
    id: 'gopy',
    name: 'Góp ý, phản ánh kiến nghị',
    short: 'Góp ý',
    items: [{ id: 'gopy', name: 'Danh sách góp ý', kind: 'gopy', dated: true, paged: false }],
  },
  {
    id: 'vpub',
    name: 'Điều hành Văn phòng UBND',
    short: 'VPUB',
    items: [{ id: 'viecdonvi', name: 'Danh sách việc đơn vị', kind: 'vpub', path: '/APIViecListViews/ViecDonVi', dated: true, paged: true }],
  },
  {
    id: 'ttdh',
    name: 'Cổng TTĐT – Thông tin điều hành',
    short: 'Cổng TTĐT',
    items: [
      { id: 'vbdieuhanh', name: 'Văn bản điều hành', kind: 'ttdh', path: '/LayDanhSachVanBanDieuHanh', dated: false, paged: true },
      { id: 'tinchidao', name: 'Tin chỉ đạo điều hành', kind: 'ttdh', path: '/LayDanhSachTinChiDaoDieuHanh', dated: false, paged: true },
      { id: 'tinlanhdao', name: 'Tin hoạt động lãnh đạo', kind: 'ttdh', path: '/LayDanhSachTinHoatDongLanhDao', dated: false, paged: true },
    ],
  },
  {
    id: 'csdlpx',
    name: 'CSDL Phường xã',
    short: 'CSDL PX',
    items: CSDLPX_ITEMS.map(([path, name]) => ({ id: path, name, kind: 'csdlpx', path: '/' + path, dated: false, paged: false })),
  },
];

const ITEMS = new Map();
for (const cat of CATEGORIES) {
  for (const item of cat.items) ITEMS.set(`${cat.id}.${item.id}`, { ...item, key: `${cat.id}.${item.id}`, category: cat });
}

module.exports = { CATEGORIES, ITEMS };
