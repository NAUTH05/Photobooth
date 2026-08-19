# Chạm Photobooth

Ứng dụng photobooth lưu động cho Windows. Electron phụ trách giao diện cảm ứng và tích hợp hệ điều hành; album ảnh cho khách do website online (Heroku + Firestore + Cloudflare R2) phục vụ. C++ camera bridge kích hoạt máy ảnh DSLR qua một Canon EDSDK helper.

## Chức năng hiện có

- Chụp webcam 4 kiểu, đếm ngược, xem trước, ghép ảnh 4×6 và khung PNG.
- Chụp manual từng ảnh hoặc auto theo cấu hình; sản phẩm hiện tập trung hoàn toàn vào ảnh tĩnh.
- Chế độ DSLR thông qua C++ bridge, có timeout và kiểm tra file đầu ra.
- In ảnh qua hệ thống in của Windows, hỗ trợ máy in mặc định hoặc tên máy in cấu hình.
- Mỗi phiên có timestamp, lưu local trước, tự retry upload Cloudflare R2 và tiếp tục sau khi app khởi động lại.
- Upload theo thư mục phiên, tạo QR mở album online để xem, tải ảnh digital.
- Website album xác thực token theo hash, chặn toàn bộ album hết hạn và chỉ trả link R2 có thời hạn ngắn.
- Album web responsive có lightbox, tải ảnh lẻ đã hậu kỳ và trạng thái rõ ràng khi link hết hạn hoặc ảnh đang đồng bộ.
- Tự dọn file local cũ hơn 7 ngày mỗi lần khởi động app; thời gian giữ lại sau upload có thể cấu hình thêm.
- Khung ảnh đồng bộ từ kho sáng tạo online (frame PNG/WebP + LUT `.cube`).
- Màn hình quản trị mở bằng nút bánh răng hoặc `Ctrl+Shift+A`.

## Chạy bản phát triển

Yêu cầu Node.js 20+, CMake, Ninja hoặc MinGW Makefiles và GCC 10+.

```powershell
npm install
npm run build:native
npm run dev
```

Script build tự chọn bản GCC mới nhất có trên máy và liên kết runtime tĩnh vào camera bridge, vì vậy bản đóng gói không phụ thuộc DLL MinGW bên ngoài.

Build và chạy bản production:

```powershell
npm run build
npm start
```

Tạo bộ cài Windows NSIS:

```powershell
npm run dist:win
```

## Cấu trúc thư mục khung

Khung ảnh được đặt trong thư mục `frames/` hoặc tải từ kho sáng tạo online. Mẫu nằm tại `frames/manifest.example.json`; hướng dẫn chi tiết nằm tại `frames/FRAME_GUIDE.md`.

- `file`: PNG RGBA trong suốt kích thước 1200×1800, dùng cho ảnh in 4×6.
- `previewFile`: thumbnail PNG/JPG khoảng 400×600 cho danh sách khung; có thể bỏ trống.
- `accent`: màu đại diện hiển thị trong bộ chọn khung.
- `slotCount`: số ảnh mà khung hỗ trợ; danh sách khung được lọc theo đúng số ảnh khách chọn.
- `slots`: tọa độ các ô ảnh. Số slot phải bằng `slotCount`; dùng `fit: "contain"` để không crop webcam.

Ứng dụng cũng đọc trực tiếp `frames/frames_manifest.json` theo định dạng của nhà cung cấp cũ. Hiện tại 21 frame thuộc nhóm `4x6-portrait` được nạp tự động; frame ngang và strip 2×6 được giữ trong thư mục nhưng không hiện trong luồng in dọc 4×6. Các vùng alpha trong suốt được dò thành slot ảnh và luôn dùng `contain`, vì vậy ảnh giữ nguyên tỉ lệ và không bị crop để lấp khung.

## Dùng cấu hình `.env` cũ

File `.env` ở thư mục gốc được nạp sau cấu hình mặc định và cấu hình người dùng. Các giá trị máy in, offset, QR, độ phân giải composite và chất lượng JPEG được dùng trực tiếp.

- `MIRROR_PREVIEW=true`: lật gương phần xem trước và ảnh chụp để khách dễ tạo dáng.
- `LOCAL_FRAMES_DIR=./frames`: dùng bộ frame local của nhà cung cấp cũ.
- `COMPOSITE_TARGET_RESOLUTION=3600`: xuất ảnh dọc 2400×3600.
- `PRINT_4X6_OFFSET_X/Y`: dịch ảnh in theo millimet.
- `ENABLE_QR_ON_FRAME`, `QR_SIZE_STANDARD`, `QR_POS_X_FRACTION`, `QR_POS_Y_FRACTION`: điều khiển QR trên ảnh thành phẩm.

Ứng dụng sync khung khi người vận hành bấm **Đồng bộ khung ngay** và sau đó theo chu kỳ cấu hình. Cache local cho phép tiếp tục chụp khi ở công viên mất mạng.

## Timelapse 2×

Mỗi phiên tự bắt đầu ghi video ngay khi webcam sẵn sàng và dừng sau ảnh cuối cùng. Video nguồn được FFmpeg tăng tốc thật 2×, xuất MP4 H.264 rồi lưu chung session để xem, tải hoặc upload lên Cloudflare R2 cùng bộ ảnh.

- `TIMELAPSE_ENABLED=true`: bật ghi timelapse tự động.
- `VIDEO_SPEED=0.5`: rút thời lượng còn một nửa, tương đương tốc độ 2×.
- `VIDEO_CRF`: chất lượng MP4 đầu ra, số càng nhỏ càng nét và dung lượng càng lớn.
- `TIMELAPSE_VIDEO_BITS_PER_SECOND`: bitrate của video WebM tạm trước khi xử lý.

## Kho sáng tạo frame/LUT

Website có khu quản trị riêng tại `/admin` để upload và gỡ frame PNG/WebP cùng LUT 3D `.cube`. App đọc manifest có SHA-256 khi khởi động, chỉ tải phần thiếu và luôn giữ cache cũ nếu mạng hoặc tệp mới gặp lỗi. Xem [hướng dẫn kho sáng tạo](docs/creative-library.md) để cấu hình local và production.

## Canon R100 / DSLR

Do Canon EDSDK có giấy phép phân phối riêng, repo cung cấp bridge C++ ổn định và contract để gắn helper đã build bằng EDSDK. Chi tiết ở `native/adapters/README.md`. Webcam hoạt động hoàn chỉnh mà không cần helper. Với DSLR, nhập đường dẫn helper và từng argument trong Quản trị → Camera; `{output}` sẽ được thay bằng đường dẫn JPEG của phiên.

## Dữ liệu local và khôi phục

Dữ liệu runtime nằm trong Electron `userData/runtime-data`, không nằm trong source repo. Queue dùng ghi file nguyên tử. Nếu mất điện giữa lúc chụp/upload, phiên có media sẽ được đưa lại về trạng thái chờ ở lần mở app sau. Mỗi lần app khởi động, các file local cũ hơn 7 ngày được tự động xóa bất kể trạng thái upload. File đã upload xong và khớp checksum cũng được dọn sớm hơn nếu vượt quá thời gian giữ lại cấu hình (`storage.retentionHoursAfterUpload`).

## Album QR cho khách

Mỗi phiên có session ID và token ngẫu nhiên riêng, ví dụ `https://photos.example.com/s/PB_...?t=...`. Vì vậy một domain phục vụ đồng thời nhiều khách nhưng mỗi người chỉ mở được URL của phiên mình. Album hiển thị timestamp, ảnh lẻ đã lên màu, ảnh ghép, video timelapse và nút tải ảnh.

Album chỉ có một nguồn duy nhất là website online, nên QR chỉ xuất hiện khi Quản trị → Hệ thống đã bật album online và điền URL Heroku. Nếu chưa bật, phiên vẫn chụp – ghép – in bình thường, chỉ là ảnh in không có QR và màn hình cuối thông báo album chưa được bật. Không còn chế độ phục vụ ảnh qua Wi‑Fi/LAN từ máy photobooth.

Thời hạn mặc định là 7 ngày và có thể đổi trong Quản trị → Hệ thống. Khi hết hạn, website trả HTTP 410 cùng trang thông báo hết hạn; khi phiên bị xóa thì trả 404.

## Heroku + Firestore + Cloudflare R2 Gallery

Website production nằm trong `web/` và chạy Node.js trên Heroku. Firestore lưu metadata/lifecycle; R2 private lưu ảnh, video, frame và LUT. App dùng upload secret để xin presigned URL ngắn hạn từ Heroku, upload file trực tiếp tới R2, rồi yêu cầu Heroku xác minh kích thước/checksum trước khi chuyển gallery sang `ready`.

Trong Quản trị → Hệ thống, nhập URL Heroku và upload secret tương ứng. Tên key cấu hình `cloudflare.*` được giữ để tương thích settings cũ; QR luôn dùng URL HTTPS công khai của gallery server.

Tài liệu chi tiết:

- [Kiến trúc](docs/architecture.md)
- [Session lifecycle](docs/session-lifecycle.md)
- [Upload protocol](docs/upload-protocol.md)
- [Recovery và data safety](docs/recovery.md)
- [UI design brief](docs/ui-design-brief.md)
- [Audit và roadmap](docs/implementation-roadmap.md)

## Kiến trúc native và dữ liệu local

- `native/camera_bridge.cpp`: executable C++ duy nhất, gọi Canon EDSDK helper để chụp DSLR và kiểm tra file đầu ra.
- `src/main/local-store.js`: ghi snapshot nguyên tử và chỉ nhận JPEG/PNG có chữ ký file hợp lệ.
- `src/main/cloudflare-upload-manager.js`: hàng đợi upload, retry và dọn phiên hết hạn trên R2.

Phiên rỗng bị loại bỏ thay vì lưu metadata rác. Phiên hết hạn không xuất hiện trong hàng đợi upload và được kiểm tra lại ngay trước từng file.
