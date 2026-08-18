const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function finite(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
}

function galleryUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('URL gallery server không hợp lệ'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHosts.has(url.hostname))) {
    throw new Error('Gallery server phải dùng HTTPS; HTTP chỉ được dùng cho localhost');
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeConfig(input) {
  const value = structuredClone(input || {});
  value.storage ??= {};
  value.cloudflare ??= {};
  value.assets ??= {};
  value.gallery ??= {};
  value.print ??= {};
  value.timelapse ??= {};
  value.storage.retentionHoursAfterUpload = finite(value.storage.retentionHoursAfterUpload, 24, -1, 8760);
  value.storage.cleanupMinutes = finite(value.storage.cleanupMinutes, 10, 1, 1440);
  value.storage.maxRetryMinutes = finite(value.storage.maxRetryMinutes, 30, 1, 1440);
  value.storage.retryBaseSeconds = finite(value.storage.retryBaseSeconds, 5, 1, 300);
  value.storage.retryJitterPercent = finite(value.storage.retryJitterPercent, 20, 0, 100);
  value.cloudflare.uploadIntervalSeconds = finite(value.cloudflare.uploadIntervalSeconds, 5, 2, 3600);
  value.cloudflare.requestTimeoutSeconds = finite(value.cloudflare.requestTimeoutSeconds, 180, 10, 1800);
  value.cloudflare.baseUrl = galleryUrl(value.cloudflare.baseUrl);
  value.assets.syncMinutes = finite(value.assets.syncMinutes, 15, 1, 1440);
  value.assets.requestTimeoutSeconds = finite(value.assets.requestTimeoutSeconds, 30, 10, 300);
  value.assets.baseUrl = galleryUrl(value.assets.baseUrl);
  value.gallery.expirationDays = finite(value.gallery.expirationDays, 7, 1, 365);
  value.print.copies = Math.round(finite(value.print.copies, 1, 1, 10));
  value.timelapse.enabled = Boolean(value.timelapse.enabled ?? true);
  value.timelapse.speed = finite(value.timelapse.speed, 2, 1, 8);
  value.timelapse.crf = Math.round(finite(value.timelapse.crf, 28, 0, 51));
  value.timelapse.videoBitsPerSecond = Math.round(finite(value.timelapse.videoBitsPerSecond, 4000000, 500000, 20000000));
  if (value.cloudflare.enabled) {
    if (!value.cloudflare.baseUrl) throw new Error('Cần nhập URL website gallery khi bật album online');
    if (String(value.cloudflare.uploadSecret || '').length < 24) throw new Error('Gallery upload secret phải có ít nhất 24 ký tự');
  }
  return value;
}
