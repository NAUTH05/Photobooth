# Cài LUT màu `.cube`

1. Mở một phiên ảnh và đi đến **Bước 2 / 2 – Chọn khung**.
2. Nhấn **+ THÊM .CUBE** trong thanh **Hậu kỳ màu**.
3. Chọn một hoặc nhiều file `.cube`, rồi nhấn **Cài LUT**.
4. LUT vừa cài sẽ có nhãn **CUBE** và được chọn tự động. Bấm LUT khác để so sánh trên bản xem trước.

LUT được sao chép vào `runtime-data/luts`, vì vậy vẫn còn sau khi đóng hoặc cập nhật ứng dụng. Không cần giữ file tải về ở vị trí cũ.

## Định dạng hỗ trợ

- LUT 3D có khai báo `LUT_3D_SIZE` từ 2 đến 65; khuyến nghị dùng LUT 17³ hoặc 33³.
- Hỗ trợ `TITLE`, `DOMAIN_MIN` và `DOMAIN_MAX`.
- Dung lượng mỗi file tối đa 24 MB.
- LUT 1D (`LUT_1D_SIZE`) không được hỗ trợ.

App kiểm tra đủ số dòng màu trước khi cài. File lỗi không được lưu. LUT chỉ áp dụng lên ảnh trong các ô; frame và QR giữ nguyên màu. Preview và ảnh xuất/in dùng chung một bảng LUT.
