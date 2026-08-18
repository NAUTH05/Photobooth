# UI design brief — prompt-ready

## Sản phẩm và cảm xúc

Chạm Photobooth gồm kiosk toàn màn hình tại sự kiện và mobile web gallery mở từ QR trên ảnh in. Phong cách: pastel pink, mềm, dễ thương, thân thiện nhưng cao cấp; ưu tiên nút lớn, ít chữ, tương phản rõ và thao tác một tay.

## Luồng kiosk

1. Home: chọn chế độ photo/video, mở phiên cũ, trạng thái queue nhỏ gọn.
2. Capture: live camera, countdown, flash/shutter feedback, số ảnh đã chụp; ảnh lưu local ngay.
3. Selection: grid thumbnail, chọn đúng 4/6/8 ảnh, có thể khôi phục draft.
4. Frame editor: chọn frame tương thích số slot, kéo/zoom/rotate từng ảnh, preview nhanh.
5. Result: ảnh thành phẩm lớn, QR rõ, chọn copies và in; vẫn cho về home ngay cả khi upload nền chưa xong.
6. Sessions/Operator: recover session, xem upload/print status, lỗi cụ thể, retry thủ công, settings ẩn sau phím tắt.

Các state bắt buộc: camera unavailable, saving, recoverable, rendering, print queued/failed, upload pending/uploading/retrying/failed/uploaded, disk low, offline.

## Luồng website QR

1. Loading: skeleton/brand nhẹ.
2. Preparing (HTTP 202): QR đúng nhưng kiosk đang upload; CTA thử lại.
3. Ready: hero có ngày chụp/hạn link; carousel ảnh đã in; grid thumbnail ảnh raw; video timelapse nếu có.
4. Lightbox: prev/next, phím mũi tên, swipe, Esc/close, tải đúng file gốc.
5. Missing: QR/link sai, không dùng cùng nội dung với preparing.
6. Expired: giải thích link đã hết hạn.
7. Offline/error: giữ ngữ cảnh và nút thử lại.

## Visual tokens

- Background `#FFF7FA`, card `#FFFEFE`, line `#EFD7E1`.
- Primary pink `#E55286`, deep berry `#7B3652`, text `#482C38`, muted `#8F7180`.
- Card radius 20–34px, shadow hồng rất nhẹ, serif editorial cho tiêu đề và sans-serif rõ cho controls.
- Motion 200–550ms, hỗ trợ `prefers-reduced-motion`.
- Không tải full-res vào grid; thumbnail 640px dùng để duyệt, raw chỉ tải khi lightbox/download.
