# Kho sáng tạo: frame và LUT

Kho sáng tạo nằm trên cùng website Cloudflare với gallery, nhưng dùng thông tin đăng nhập quản trị riêng. Ảnh khung và file LUT được lưu trong R2; website tự duy trì manifest công khai tại `/api/assets/manifest.json`.

## Luồng hoạt động

1. Người vận hành mở `/admin`, đăng nhập và tải frame PNG/WebP hoặc LUT `.cube` lên. Với frame, có thể sửa tên/thông số; với LUT, có thể đổi tên màu. Cả hai loại đều hỗ trợ lưu trữ tạm, khôi phục và xóa vĩnh viễn.
2. Worker kiểm tra định dạng, tính SHA-256, ghi file vào R2 rồi cập nhật `assets/manifest.json`.
3. Khi app mở và theo chu kỳ cấu hình, app đọc manifest, so checksum với cache local và chỉ tải file thiếu hoặc đã thay đổi.
4. App xác minh kích thước, checksum và cú pháp `.cube` trước khi thay manifest local. Nếu mạng lỗi hoặc một file lỗi, app tiếp tục dùng nguyên cache trước đó.
5. Khung hoặc LUT được đưa vào **Lưu trữ** vẫn còn nguyên trên R2 nhưng bị loại khỏi manifest công khai. Sau một lần đồng bộ thành công, app dọn bản remote đó khỏi cache; khi khôi phục, app tự tải lại. Frame đóng gói sẵn và LUT người vận hành cài trực tiếp trên máy không bị xóa.

## Cấu hình website local

Tạo `web/.env` từ `web/.env.example` và thay cả bốn giá trị mẫu. Ba nhóm secret có vai trò độc lập:

- `UPLOAD_SECRET`: app dùng để gửi ảnh phiên chụp lên gallery.
- `ADMIN_USERNAME` và `ADMIN_PASSWORD`: chỉ dùng để mở `/admin`.
- `ADMIN_SESSION_SECRET`: ký cookie HttpOnly của phiên quản trị; dùng chuỗi ngẫu nhiên tối thiểu 32 ký tự.

Chạy website:

```powershell
cd web
npm.cmd install
npm.cmd run dev
```

Mở `http://localhost:3000/admin` (hoặc đúng địa chỉ Vite in ra). Manifest có thể kiểm tra tại `http://localhost:3000/api/assets/manifest.json`.

## Nối app local

Trong app, mở **Quản trị → Hệ thống → Kho sáng tạo cho mọi máy**:

- Bật **Tự đón khung ảnh và màu hậu kỳ mới**.
- Điền địa chỉ website local, ví dụ `http://localhost:3000`. Nếu website album đã dùng đúng địa chỉ này thì có thể để trống.
- Bấm **Ghé kho sáng tạo ngay**.

App không cần và không lưu mật khẩu quản trị. HTTP chỉ được chấp nhận với `localhost`; nếu website nằm trên máy khác trong LAN hoặc trên Internet thì phải dùng HTTPS.

## Chuẩn file

- Frame: PNG hoặc WebP, tối đa 50 MB, có alpha trong suốt tại từng ô ảnh. Chọn đúng số ô 4/6/8 và dáng giấy trong form upload.
- LUT: LUT 3D `.cube`, `LUT_3D_SIZE` từ 2 đến 65, tối đa 24 MB. LUT 1D không được hỗ trợ.
- ID tài nguyên được sinh từ SHA-256 của nội dung. Upload lại cùng nội dung sẽ cập nhật tên/metadata thay vì tạo bản trùng.

## Cấu hình production

Đặt `UPLOAD_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` và `ADMIN_SESSION_SECRET` bằng secret của môi trường hosting, không ghi giá trị thật vào source hoặc `hosting.json`. Sau khi deploy, mở `/admin` trên domain production và đặt URL đó trong app.
