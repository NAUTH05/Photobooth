# Audit và thứ tự triển khai

## Điểm mạnh hiện tại

- Capture ghi local trước, renderer sandbox, IPC kiểm tra main-frame.
- Compose bằng Sharp ở độ phân giải in, QR gắn với đúng session.
- Queue/background upload và recovery đã có nền tảng tốt.
- Worker R2 đã kiểm tra token, MIME, size, MD5, path và range video.

## Gap/rủi ro ưu tiên

1. Retry cũ không phân loại lỗi và không jitter; có thể retry vô hạn với secret sai.
2. Config chưa validate tập trung; retention không biểu diễn được “never delete”.
3. Không có print history và workflow timestamp đủ rõ cho support.
4. Website dùng R2 manifest làm metadata source và tải raw vào grid.
5. Public state 404 bị hiển thị như “đang chuẩn bị”, gây nhầm QR sai.
6. Remote lightbox thiếu prev/next/swipe; chỉ hiện một ảnh thành phẩm.
7. Toàn bộ migration React/TypeScript/SQLite kiosk trong một lần có blast radius quá lớn.

## Thứ tự đã chọn

1. Data safety: atomic store + fsync, workflow/print history, config validation.
2. Reliability: typed error, timeout, exponential backoff+jitter, manual retry failed.
3. Cloud lifecycle: prepare/upload/publish/delete trong D1 + private R2.
4. Performance: local thumbnail 640px và preview mapping.
5. UX: pastel-pink, state riêng biệt, multi-print carousel, lightbox navigation/swipe.
6. Verification: JS tests, site lint/build/integration, production smoke test.
7. Sau rollout: tách PrinterProvider; rồi migration IPC TypeScript và SQLite shadow adapter.

