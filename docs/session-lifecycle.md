# Session lifecycle

Một session có ba trục trạng thái độc lập để UI không đánh đồng thao tác người dùng với đồng bộ mạng.

## Workflow kiosk

`capture → selection → frame → result`

- `workflowStep` và `updatedAt` được lưu cùng session.
- Mỗi ảnh chụp được ghi file trước khi renderer đưa vào danh sách chọn.
- Draft lưu ảnh đã chọn, slot, frame và transform; restart app sẽ đưa session đang chụp có file về `recoverable`.
- `finishSession` xóa draft, đặt `status=pending`, nhưng không chờ mạng.
- Hủy phiên chỉ hợp lệ khi đang capture/recoverable.

## Upload kiosk

Cloudflare dùng `cloudflareStatus`:

`pending → uploading → uploaded`

Lỗi tạm thời: `uploading → retrying → uploading`. Lỗi HTTP 400/401/403 là lỗi vĩnh viễn: `uploading → failed`; người vận hành bấm chạy lại hàng đợi để reset. HTTP 408/425/429/5xx, timeout và mất mạng được retry với exponential backoff + jitter.

Cleanup local tự động xóa file cũ hơn 7 ngày mỗi lần khởi động app. Ngoài ra, cleanup theo giờ (`retentionHoursAfterUpload`) chỉ chạy sau khi upload/checksum đã hoàn tất. `retentionHoursAfterUpload=-1` nghĩa là không tự xóa theo giờ.

## Gallery cloud

`uploading → ready → deleting → deleted`

1. Kiosk `PUT /api/v1/sessions/:id` với token và hạn dùng.
2. D1 tạo session `uploading`; QR hợp lệ nhận HTTP 202 “đang chuẩn bị”.
3. Kiosk upload item idempotent vào R2 và metadata D1.
4. Publish xác minh R2 head/size/MD5, rồi batch metadata D1 sang `ready`.
5. Gallery public chỉ đọc metadata D1; media vẫn stream từ R2 qua Worker.
6. Hết hạn trả HTTP 410. Cleanup cloud chuyển `deleting`, xóa prefix R2, rồi `deleted`.

