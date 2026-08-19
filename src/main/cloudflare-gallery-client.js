import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fetchWithTimeout, RequestError } from './retry-policy.js';

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) {
    throw new Error('Gallery server phải dùng HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}

function contentTypeFor(item) {
  const extension = path.extname(item.filename).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.mp4') return 'video/mp4';
  // An unsupported extension never becomes supported, so retrying is pointless.
  throw new RequestError(`Định dạng không hỗ trợ upload: ${extension}`, { retryable: false });
}

// The upload body is a file stream, and a stream whose `open` fails emits
// 'error' before undici has subscribed to it — an unhandled 'error' event that
// takes the whole Electron main process down. Stat the file first so a missing
// or truncated artifact becomes a normal, non-retryable upload failure.
async function statUploadSource(item) {
  let stats;
  try {
    stats = await fsp.stat(item.path);
  } catch (error) {
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    throw new RequestError(
      missing
        ? `Tệp không còn trên máy: ${item.filename}`
        : `Không đọc được tệp ${item.filename}: ${error.message}`,
      { retryable: !missing && error.code !== 'EACCES' && error.code !== 'EPERM', cause: error, stage: 'read-file' }
    );
  }
  if (!stats.isFile()) {
    throw new RequestError(`Đường dẫn không phải tệp: ${item.filename}`, { retryable: false, stage: 'read-file' });
  }
  if (Number(item.size) !== stats.size) {
    throw new RequestError(
      `Tệp ${item.filename} đã thay đổi trên máy (${stats.size} byte, hàng đợi ghi ${item.size} byte)`,
      { retryable: false, stage: 'read-file' }
    );
  }
  return stats;
}

// Owns the stream's 'error' event for the whole request so no fs failure can
// ever escape as an uncaught exception in the main process.
function openUploadStream(item) {
  const stream = fs.createReadStream(item.path);
  const failure = new Promise((_resolve, reject) => {
    stream.once('error', (error) => reject(new RequestError(
      `Không đọc được tệp ${item.filename}: ${error.message}`,
      { retryable: error.code !== 'ENOENT', cause: error, stage: 'read-file' }
    )));
  });
  // The fetch usually wins the race; swallow the loser so it is never reported
  // as an unhandled rejection.
  failure.catch(() => { });
  return { stream, failure };
}

function uploadMetadata(item) {
  return {
    id: item.id,
    kind: item.kind,
    filename: item.filename,
    contentType: contentTypeFor(item),
    size: item.size,
    md5: item.md5,
    createdAt: item.createdAt,
    ...(item.sourceItemId ? { sourceItemId: item.sourceItemId } : {})
  };
}

function validateUploadPlan(value, item) {
  const url = new URL(String(value?.url || ''));
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.r2.cloudflarestorage.com')) {
    throw new Error('Gallery server trả về địa chỉ upload R2 không an toàn');
  }
  const announced = value?.headers && typeof value.headers === 'object' ? value.headers : {};
  const headers = {
    'content-type': String(announced['content-type'] || contentTypeFor(item)),
    'content-length': String(item.size)
  };
  if (announced['content-md5']) headers['content-md5'] = String(announced['content-md5']);
  if (headers['content-type'] !== contentTypeFor(item)) throw new Error('Kiểu tệp upload không khớp');
  return { url: url.toString(), headers };
}

export class CloudflareGalleryClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    if (String(config.uploadSecret || '').length < 24) throw new Error('Gallery upload secret phải có ít nhất 24 ký tự');
  }

  async request(pathname, options, label) {
    const timeoutMs = Math.max(10, Number(this.config.requestTimeoutSeconds) || 180) * 1000;
    const response = await fetchWithTimeout(this.fetch, `${this.baseUrl}${pathname}`, options, timeoutMs);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let detail = body;
      try { detail = JSON.parse(body).error || body; } catch { /* body is not JSON — keep it verbatim */ }
      throw new RequestError(`${label}: ${detail || `HTTP ${response.status}`}`, {
        status: response.status,
        body,
        stage: label
      });
    }
    return response;
  }

  urlFor(session) {
    if (!session?.id || !session?.galleryToken) throw new Error('Session gallery không hợp lệ');
    return `${this.baseUrl}/s/${encodeURIComponent(session.id)}?t=${encodeURIComponent(session.galleryToken)}`;
  }

  async prepareSession(session) {
    const response = await this.request(`/api/v1/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.config.uploadSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: session.galleryToken, createdAt: session.createdAt, expiresAt: session.expiresAt })
    }, 'Không khởi tạo được gallery');
    return response.json();
  }

  async uploadItem(session, item) {
    const metadata = uploadMetadata(item);
    await statUploadSource(item);
    const planResponse = await this.request(`/api/v1/sessions/${encodeURIComponent(session.id)}/items/${encodeURIComponent(item.id)}/upload-url`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.uploadSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(metadata)
    }, 'Không tạo được địa chỉ upload R2');
    const plan = validateUploadPlan(await planResponse.json(), item);
    const timeoutMs = Math.max(10, Number(this.config.requestTimeoutSeconds) || 180) * 1000;
    const { stream, failure } = openUploadStream(item);
    let uploaded;
    try {
      uploaded = await Promise.race([
        fetchWithTimeout(this.fetch, plan.url, {
          method: 'PUT',
          headers: plan.headers,
          body: stream,
          duplex: 'half'
        }, timeoutMs),
        failure
      ]);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    if (!uploaded.ok) {
      stream.destroy();
      const body = await uploaded.text().catch(() => '');
      throw new RequestError(`Upload R2 thất bại: ${body || `HTTP ${uploaded.status}`}`, {
        status: uploaded.status,
        body,
        stage: 'Upload R2'
      });
    }
    const completed = await this.request(`/api/v1/sessions/${encodeURIComponent(session.id)}/items/${encodeURIComponent(item.id)}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.uploadSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify(metadata)
    }, 'Không xác nhận được tệp R2');
    return completed.json();
  }

  async publishSession(session) {
    const items = (session.items || []).filter((item) => !item.deletedAt && !item.galleryHidden && item.cloudflareStatus === 'uploaded').map((item) => ({
      id: item.id,
      kind: item.kind,
      filename: item.filename,
      contentType: contentTypeFor(item),
      size: item.size,
      md5: item.md5,
      createdAt: item.createdAt,
      ...(item.sourceItemId ? { sourceItemId: item.sourceItemId } : {})
    }));
    const response = await this.request(`/api/v1/sessions/${encodeURIComponent(session.id)}/manifest`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.config.uploadSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: session.galleryToken, createdAt: session.createdAt, expiresAt: session.expiresAt, items })
    }, 'Không xuất bản được gallery');
    return response.json();
  }

  async deleteSession(session) {
    const response = await this.request(`/api/v1/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.config.uploadSecret}` }
    }, 'Không xóa được gallery hết hạn');
    return response.json();
  }
}

export { contentTypeFor, normalizeBaseUrl, validateUploadPlan };
