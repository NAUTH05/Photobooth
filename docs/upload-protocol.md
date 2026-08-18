# Cloudflare upload protocol

## Xác thực và key

- Kiosk gửi `Authorization: Bearer <UPLOAD_SECRET>`; secret tối thiểu 24 ký tự và không bao giờ gửi xuống renderer/browser.
- Public dùng token ngẫu nhiên trong QR query `?t=...`; D1/R2 chỉ lưu SHA-256 của token.
- Object key do server tạo: `sessions/{sessionId}/items/{itemId}/{safeFilename}`. Client không được truyền key tùy ý.

## API

### `PUT /api/v1/sessions/:sessionId`

Body: `{ token, createdAt, expiresAt }`. Idempotent; cùng ID nhưng token khác trả 409.

### `PUT /api/v1/sessions/:sessionId/items/:itemId`

Headers bắt buộc: `content-type`, `content-length`, `x-file-name`, `x-item-kind`, `x-content-md5`, `x-created-at`. Thumbnail có thêm `x-source-item-id`.

MIME cho phép: JPEG, PNG, MP4. Kích thước tối đa 600 MB. Worker ghi private R2 object rồi upsert metadata D1.

### `PUT /api/v1/sessions/:sessionId/manifest`

Body chứa token, thời gian và danh sách item. Worker `HEAD` từng object để xác minh size/MD5 trước khi publish. D1 batch thay toàn bộ item metadata và chuyển session sang `ready`. Manifest R2 vẫn được giữ làm bản audit/khả năng tương thích, không phải nguồn query public.

### Public

- `GET /api/v1/public/sessions/:id?t=...`: 200 ready, 202 uploading, 404 token/link sai, 410 hết hạn.
- `GET /media/:sessionId/:itemId?t=...`: stream private object, hỗ trợ Range và `download=1`.
- `DELETE /api/v1/sessions/:id`: protected cleanup, idempotent theo session prefix.

## Retry

- Retry: timeout, lỗi mạng, 408, 425, 429, 5xx.
- Không auto-retry: 400, 401, 403 và lỗi validation khác.
- Delay mặc định 5 giây, nhân đôi tới trần 30 phút, jitter ±20%.
- Mỗi item có trạng thái riêng; restart chỉ upload phần chưa hoàn tất, không upload lại item đã xác minh.

