# Roti Photobooth

Ứng dụng photobooth lưu động cho Windows. Electron phụ trách giao diện cảm ứng và tích hợp hệ điều hành; backend gallery/API chạy bằng C++ độc lập. C++ camera bridge kích hoạt máy ảnh DSLR qua một Canon EDSDK helper.

## Chức năng hiện có

- Chụp webcam 4 kiểu, đếm ngược, xem trước, ghép ảnh 4×6 và khung PNG.
- Chụp manual từng ảnh hoặc auto theo cấu hình; sản phẩm hiện tập trung hoàn toàn vào ảnh tĩnh.
- Chế độ DSLR thông qua C++ bridge, có timeout và kiểm tra file đầu ra.
- In ảnh qua hệ thống in của Windows, hỗ trợ máy in mặc định hoặc tên máy in cấu hình.
- Mỗi phiên có timestamp, lưu local trước, tự retry upload Google Drive và tiếp tục sau khi app khởi động lại.
- Upload theo thư mục phiên, kiểm tra MD5 và tạo QR mở gallery web local/LAN để xem, tải ảnh digital.
- Backend gallery C++ đọc snapshot hàng đợi nguyên tử, xác thực token theo thời gian hằng, từ chối nội dung ảnh giả và chặn toàn bộ gallery hết hạn.
- Gallery web responsive có lightbox, tải ảnh gốc và trạng thái rõ ràng khi link hết hạn hoặc ảnh đang đồng bộ.
- Chỉ dọn file local đã upload và đã khớp checksum; thời gian giữ lại có thể cấu hình.
- Khung ảnh đồng bộ định kỳ từ một thư mục Google Drive bằng `manifest.json`.
- Màn hình quản trị mở bằng nút bánh răng hoặc `Ctrl+Shift+A`.

## Chạy bản phát triển

Yêu cầu Node.js 20+, CMake, Ninja hoặc MinGW Makefiles và GCC 10+.

```powershell
npm install
npm run build:native
npm run dev
```

Script build tự chọn bản GCC mới nhất có trên máy và liên kết runtime tĩnh vào hai executable, vì vậy bản đóng gói không phụ thuộc DLL MinGW bên ngoài.

Build và chạy bản production:

```powershell
npm run build
npm start
```

Tạo bộ cài Windows NSIS:

```powershell
npm run dist:win
```

## Kết nối Google Drive cá nhân

1. Tạo project trên Google Cloud Console và bật Google Drive API.
2. Cấu hình OAuth consent screen, tạo OAuth client loại **Desktop app**, tải file JSON về máy photobooth.
3. Trong Drive, tạo một thư mục lưu phiên và một thư mục chứa khung. Folder ID là đoạn sau `/folders/` trong URL.
4. Mở Quản trị → Google Drive, nhập hai Folder ID và đường dẫn OAuth JSON.
5. Chọn **Kết nối tài khoản Google**, đăng nhập account có gói dung lượng, rồi bật Google Drive.

Refresh token được mã hóa bằng Windows DPAPI trong thư mục dữ liệu của app. Nếu dùng Google Workspace/Shared Drive, có thể điền service-account JSON thay cho OAuth và chia sẻ cả hai thư mục cho `client_email` của service account.

Khi bật link công khai, ứng dụng đặt quyền `anyone with the link` cho thư mục của từng phiên. Không bật lựa chọn này nếu ảnh không được phép truy cập qua QR công khai.

## Cấu trúc thư mục khung

Upload `manifest.json` và các ảnh PNG trong cùng thư mục Drive. Mẫu nằm tại `frames/manifest.example.json`; hướng dẫn chi tiết nằm tại `frames/FRAME_GUIDE.md`.

- `file`: PNG RGBA trong suốt kích thước 1200×1800, dùng cho ảnh in 4×6.
- `previewFile`: thumbnail PNG/JPG khoảng 400×600 cho danh sách khung; có thể bỏ trống.
- `accent`: màu đại diện hiển thị trong bộ chọn khung.
- `slotCount`: số ảnh mà khung hỗ trợ; danh sách khung được lọc theo đúng số ảnh khách chọn.
- `slots`: tọa độ các ô ảnh. Số slot phải bằng `slotCount`; dùng `fit: "contain"` để không crop webcam.

Ứng dụng cũng đọc trực tiếp `frames/frames_manifest.json` theo định dạng của nhà cung cấp cũ. Hiện tại 21 frame thuộc nhóm `4x6-portrait` được nạp tự động; frame ngang và strip 2×6 được giữ trong thư mục nhưng không hiện trong luồng in dọc 4×6. Các vùng alpha trong suốt được dò thành slot ảnh và luôn dùng `contain`, vì vậy ảnh giữ nguyên tỉ lệ và không bị crop để lấp khung.

## Dùng cấu hình `.env` cũ

File `.env` ở thư mục gốc được nạp sau cấu hình mặc định và cấu hình người dùng. Các giá trị máy in, offset, cổng gallery, QR, độ phân giải composite và chất lượng JPEG được dùng trực tiếp.

- `MIRROR_PREVIEW=true`: lật gương riêng phần xem trước để khách dễ tạo dáng.
- `MIRROR_OUTPUT=false`: ảnh lưu, ảnh ghép và ảnh in giữ đúng chiều thực tế.
- `LOCAL_FRAMES_DIR=./frames`: dùng bộ frame local của nhà cung cấp cũ.
- `COMPOSITE_TARGET_RESOLUTION=3600`: xuất ảnh dọc 2400×3600.
- `PRINT_4X6_OFFSET_X/Y`: dịch ảnh in theo millimet.
- `ENABLE_QR_ON_FRAME`, `QR_SIZE_STANDARD`, `QR_POS_X_FRACTION`, `QR_POS_Y_FRACTION`: điều khiển QR trên ảnh thành phẩm.

Ứng dụng sync khung khi người vận hành bấm **Đồng bộ khung ngay** và sau đó theo chu kỳ cấu hình. Cache local cho phép tiếp tục chụp khi ở công viên mất mạng.

## Canon R100 / DSLR

Do Canon EDSDK có giấy phép phân phối riêng, repo cung cấp bridge C++ ổn định và contract để gắn helper đã build bằng EDSDK. Chi tiết ở `native/adapters/README.md`. Webcam hoạt động hoàn chỉnh mà không cần helper. Với DSLR, nhập đường dẫn helper và từng argument trong Quản trị → Camera; `{output}` sẽ được thay bằng đường dẫn JPEG của phiên.

## Dữ liệu local và khôi phục

Dữ liệu runtime nằm trong Electron `userData/runtime-data`, không nằm trong source repo. Queue dùng ghi file nguyên tử. Nếu mất điện giữa lúc chụp/upload, phiên có media sẽ được đưa lại về trạng thái chờ ở lần mở app sau. Việc xóa chỉ xảy ra sau khi Drive trả `md5Checksum` trùng với file local và hết thời gian giữ lại.

## Gallery QR local/LAN

Ứng dụng tự khởi động `photobooth-gallery-backend.exe` ở cổng `3847` và đưa IP LAN của máy vào QR, ví dụ `http://192.168.1.20:3847/s/...`. Nếu cổng bận, backend tự chọn cổng trống và QR dùng đúng cổng thực tế. Điện thoại phải kết nối cùng Wi‑Fi/LAN với máy photobooth. Windows có thể hỏi quyền Firewall ở lần chạy đầu; cần cho phép truy cập trên mạng Private.

Mỗi URL có session ID và token ngẫu nhiên riêng, ví dụ `https://photos.example.com/s/PB_...?...`. Vì vậy một domain có thể phục vụ đồng thời nhiều khách nhưng mỗi người chỉ có URL riêng của phiên mình. Gallery hiển thị timestamp, ảnh gốc, ảnh ghép và nút tải ảnh.

Thời hạn mặc định là 7 ngày và có thể đổi trong Quản trị → Hệ thống. Khi hết hạn, route gallery trả HTTP 410 cùng trang thông báo hết hạn; ứng dụng cũng thu hồi quyền `anyone` của thư mục Drive khi máy online. Nếu app tắt đúng thời điểm hết hạn, việc thu hồi Drive được thực hiện ở lần chạy online tiếp theo.

Sau khi file local được dọn, gallery chuyển sang bản đã xác minh trên Google Drive. Khi có domain/hosting, điền URL gốc vào `gallery.publicBaseUrl`. Backend giữ route `/s/:sessionId?t=...` và API `/api/public/sessions/:sessionId?t=...` để frontend gallery không phụ thuộc vào implementation cũ.

## Kiến trúc backend C++

- `native/gallery_backend.cpp`: HTTP/API server, kiểm tra token và thời hạn, phục vụ ảnh local hoặc chuyển hướng sang bản Drive đã xác minh.
- `src/main/cpp-gallery-backend.js`: lớp mỏng để Electron khởi động, giám sát và dừng executable C++.
- `src/gallery/`: frontend gallery công khai, không chứa logic truy cập file trực tiếp.
- `src/main/local-store.js`: ghi snapshot nguyên tử và chỉ nhận JPEG/PNG có chữ ký file hợp lệ.

Gallery rỗng bị loại bỏ thay vì lưu metadata rác. Phiên hết hạn không xuất hiện trong hàng đợi upload và được kiểm tra lại ngay trước từng file, tránh race condition với Google Drive.
