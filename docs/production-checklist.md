# Production checklist

## Trước khi build

- Dùng Node.js tương thích với project và cài dependency từ lockfile bằng `npm ci`.
- Chạy `npm run check` ở root và `npm test && npm run lint && npx tsc --noEmit` trong `web/`.
- Xác nhận `npm audit --omit=dev` không còn lỗ hổng production mức high/critical.
- Không đóng gói `.env`, token gallery, `UPLOAD_SECRET`, `ADMIN_PASSWORD` hoặc `ADMIN_SESSION_SECRET` vào installer/repository.
- Thiết lập Cloudflare secrets bằng secret store của môi trường triển khai.
- Áp dụng D1 migrations trước khi chuyển traffic.
- Cấu hình Cloudflare WAF rate limit cho `/api/admin/login` và các endpoint `/api/v1/sessions/*`.

## Smoke test bắt buộc

1. Mở app, xác nhận camera preview và lật gương đúng.
2. Chụp đủ một phiên, chọn ảnh, ghép frame và in thử.
3. Xác nhận ảnh thành phẩm, ảnh thành phần và timelapse xuất hiện trong gallery.
4. Quét QR trên điện thoại thật; thử xem, trượt gallery và tải ảnh/video.
5. Ngắt mạng trong lúc upload, sau đó nối lại và xác nhận hàng đợi tự retry mà không mất file.
6. Khởi động lại app giữa phiên để kiểm tra recovery.
7. Xác nhận album hết hạn bị xóa khỏi R2 và file local trên 7 ngày bị dọn.

## Theo dõi sau deploy

- Theo dõi HTTP 4xx/5xx, thời gian upload, số phiên retry/failed và dung lượng R2.
- Kiểm tra `/api/health`, luồng đăng nhập admin và một gallery token thật.
- Rollback nếu xuất hiện mất ảnh/video, lỗi upload tăng đột biến, hoặc gallery token truy cập sai phiên.

## Rollback

- App Windows: giữ lại installer phiên bản ổn định gần nhất; gỡ bản mới và cài lại bản đó.
- Website: redeploy commit Worker/Vinext ổn định trước đó; không rollback/xóa D1 migration đã chứa dữ liệu nếu chưa có kế hoạch tương thích.
- Không xóa hàng đợi local trong lúc rollback; app cần tiếp tục retry các phiên chưa upload.
