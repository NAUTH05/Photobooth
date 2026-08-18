# Recovery và data safety

## App tắt trong lúc chụp

Ảnh đã được ghi vào thư mục session. Lần mở sau, session `capturing` có item chuyển thành `recoverable`; UI có thể mở lại originals và draft. Session rỗng được dọn vì không có dữ liệu người dùng.

## App tắt trong lúc upload

Queue atomic được đọc lại. Cloudflare tiếp tục theo `cloudflareStatus` và item đã đánh dấu uploaded. API/item idempotent nên retry không tạo object trùng.

## Mất mạng

Luồng capture, compose và print không phụ thuộc network. Upload chuyển `retrying`, lưu lỗi rút gọn và `nextAttemptAt`. UI báo ảnh vẫn an toàn trong hàng đợi local.

## Lỗi cấu hình hoặc quyền truy cập

Cloudflare HTTP 400/401/403 chuyển `failed` để tránh vòng retry vô hạn. Sửa URL/secret trong settings rồi bấm queue pill để reset và chạy lại. Config mới được normalize/validate trước khi thay config đang chạy.

## Lỗi in

Mỗi lần in có job `queued`, sau đó `printed` hoặc `failed`, kèm profile, copies, device và lỗi. Ảnh kết quả vẫn nằm local; lỗi máy in không xóa session và không chặn upload.

## Cleanup

- Không xóa file chưa checksum hoặc backend bắt buộc chưa uploaded.
- Không xóa result chưa được người dùng acknowledge khi gallery còn hạn.
- `-1`: không tự xóa; `0`: xóa ngay khi đủ điều kiện; số dương: giữ theo giờ.
- Cloud cleanup chỉ chạy sau `expiresAt` và giữ tombstone `deleted` trong D1 để tránh gallery sống lại ngoài ý muốn.

