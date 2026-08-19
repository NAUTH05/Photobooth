import { EventEmitter } from 'node:events';
import { CloudflareGalleryClient } from './cloudflare-gallery-client.js';
import { isRetryableError, retryDelayMs } from './retry-policy.js';

const expired = (session) => Boolean(session.expiresAt && Date.parse(session.expiresAt) <= Date.now());

const MAX_ERROR_LOG = 20;

// Snapshot of a failure the session manager screen can render verbatim:
// which step broke, the HTTP status, and the raw server response.
function errorDetail(error, context = {}) {
  return {
    at: new Date().toISOString(),
    stage: String(error?.stage || context.stage || 'upload'),
    status: error?.status ?? null,
    retryable: isRetryableError(error),
    message: String(error?.message || error).slice(0, 500),
    response: String(error?.body || '').slice(0, 2000),
    code: String(error?.cause?.code || error?.code || ''),
    ...(context.itemId ? { itemId: context.itemId, itemKind: context.itemKind || '', filename: context.filename || '' } : {})
  };
}

function pushErrorDetail(session, detail) {
  session.cloudflareErrors ??= [];
  session.cloudflareErrors.push(detail);
  if (session.cloudflareErrors.length > MAX_ERROR_LOG) {
    session.cloudflareErrors.splice(0, session.cloudflareErrors.length - MAX_ERROR_LOG);
  }
}

// Raised when the operator cancels or parks a session from the manager screen
// while its upload pass is between items.
class UploadCancelled extends Error {
  constructor(reason = 'Đã hủy upload theo yêu cầu') {
    super(reason);
    this.name = 'UploadCancelled';
    this.cancelled = true;
    this.retryable = false;
  }
}

export class CloudflareUploadManager extends EventEmitter {
  constructor(localStore, configStore, clientFactory = (config) => new CloudflareGalleryClient(config)) {
    super();
    this.localStore = localStore;
    this.configStore = configStore;
    this.clientFactory = clientFactory;
    this.running = false;
    this.timer = null;
  }

  start() {
    const seconds = Math.max(2, Number(this.configStore.get().cloudflare?.uploadIntervalSeconds) || 5);
    this.timer = setInterval(() => this.process().catch(() => {}), seconds * 1000);
    this.process().catch(() => {});
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  queuedSessions() {
    return Object.values(this.localStore.queue.sessions)
      .filter((session) => session.finishedAt
        && !expired(session)
        && !session.archived
        && !['cancelled', 'expired'].includes(session.status)
        && !['uploaded', 'failed', 'cancelled'].includes(session.cloudflareStatus))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async process() {
    const config = this.configStore.get();
    if (this.running || !config.cloudflare?.enabled) return;
    this.running = true;
    try {
      const client = this.clientFactory(config.cloudflare);
      await this.deleteExpiredSessions(client, config);
      for (const session of this.queuedSessions()) {
        const nextAttemptAt = session.cloudflareNextAttemptAt ? Date.parse(session.cloudflareNextAttemptAt) : 0;
        if (nextAttemptAt > Date.now()) continue;
        try {
          await this.uploadSession(client, session.id, config);
        } catch (error) {
          if (error?.cancelled) {
            this.emit('status', { sessionId: session.id, status: 'cancelled', source: 'cloudflare' });
            continue;
          }
          const retryable = isRetryableError(error);
          const detail = errorDetail(error, { stage: 'session' });
          await this.localStore.mutate(session.id, (value) => {
            value.cloudflareStatus = retryable ? 'retrying' : 'failed';
            value.cloudflareAttempts = (value.cloudflareAttempts || 0) + 1;
            value.cloudflareLastError = String(error.message || error).slice(0, 500);
            pushErrorDetail(value, detail);
            const ceiling = Math.max(1, Number(config.storage.maxRetryMinutes) || 30) * 60000;
            const wait = retryDelayMs(value.cloudflareAttempts, {
              baseMs: Math.max(1, Number(config.storage.retryBaseSeconds) || 5) * 1000,
              maxMs: ceiling,
              jitterRatio: Math.max(0, Number(config.storage.retryJitterPercent) || 0) / 100
            });
            value.cloudflareNextAttemptAt = retryable ? new Date(Date.now() + wait).toISOString() : null;
          });
          this.emit('status', { sessionId: session.id, status: retryable ? 'retrying' : 'failed', source: 'cloudflare', error: String(error.message || error) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  async deleteExpiredSessions(client, config) {
    const sessions = Object.values(this.localStore.queue.sessions)
      .filter((session) => expired(session) && session.cloudflareStatus === 'uploaded' && !session.cloudflareDeletedAt && session.cloudflareDeletionStatus !== 'failed');
    for (const session of sessions) {
      const nextAttemptAt = session.cloudflareNextAttemptAt ? Date.parse(session.cloudflareNextAttemptAt) : 0;
      if (nextAttemptAt > Date.now()) continue;
      try {
        await client.deleteSession(session);
        await this.localStore.mutate(session.id, (value) => {
          value.cloudflareStatus = 'deleted';
          value.cloudflareDeletedAt = new Date().toISOString();
          value.cloudflareNextAttemptAt = null;
          value.cloudflareLastError = null;
        });
        this.emit('status', { sessionId: session.id, status: 'expired', source: 'cloudflare' });
      } catch (error) {
        const retryable = isRetryableError(error);
        await this.localStore.mutate(session.id, (value) => {
          value.cloudflareAttempts = (value.cloudflareAttempts || 0) + 1;
          value.cloudflareLastError = String(error.message || error).slice(0, 500);
          const ceiling = Math.max(1, Number(config.storage.maxRetryMinutes) || 30) * 60000;
          const wait = retryDelayMs(value.cloudflareAttempts, {
            baseMs: Math.max(1, Number(config.storage.retryBaseSeconds) || 5) * 1000,
            maxMs: ceiling,
            jitterRatio: Math.max(0, Number(config.storage.retryJitterPercent) || 0) / 100
          });
          value.cloudflareDeletionStatus = retryable ? 'retrying' : 'failed';
          value.cloudflareNextAttemptAt = retryable ? new Date(Date.now() + wait).toISOString() : null;
        });
      }
    }
  }

  async uploadSession(client, sessionId, config) {
    await this.localStore.mutate(sessionId, (session) => { session.cloudflareStatus = 'uploading'; session.cloudflareLastError = null; });
    let session = this.localStore.queue.sessions[sessionId];
    if (typeof client.prepareSession === 'function') await client.prepareSession(session);
    let items = session.items.filter((item) => !item.deletedAt);
    let uploaded = items.filter((item) => item.cloudflareStatus === 'uploaded').length;
    const skippedItems = [];
    this.emit('status', { sessionId, status: 'uploading', source: 'cloudflare', progress: items.length ? uploaded / items.length : 0 });
    // Items (timelapse, graded photos, thumbnails) may be appended to the session while
    // this pass runs, so re-snapshot each round and keep going until nothing is pending.
    for (;;) {
      for (const item of items) {
        if (expired(session)) throw new Error('Gallery đã hết hạn');
        this.assertNotCancelled(sessionId);
        if (item.cloudflareStatus === 'uploaded' || item.cloudflareStatus === 'skipped') continue;
        try {
          await client.uploadItem(session, item);
          await this.localStore.mutate(sessionId, (value) => {
            const target = value.items.find((candidate) => candidate.id === item.id);
            if (target) Object.assign(target, { cloudflareStatus: 'uploaded', cloudflareUploadedAt: new Date().toISOString(), cloudflareChecksumVerified: true });
          });
          uploaded += 1;
        } catch (itemError) {
          const retryable = isRetryableError(itemError);
          if (retryable) throw itemError; // Retryable errors (network, 5xx) → bubble up to retry the whole session
          // Auth/permission errors (401, 403) are session-level → fail the whole session
          const status = itemError?.status ?? null;
          if (status === 401 || status === 403) throw itemError;
          // Non-retryable item error (e.g. file too large, missing on disk, rejected by server) → skip this item
          console.warn(`[upload] Skipping item ${item.id} (${item.kind}): ${itemError.message}`);
          skippedItems.push({ id: item.id, kind: item.kind, error: String(itemError.message).slice(0, 200) });
          const detail = errorDetail(itemError, { stage: itemError?.stage || 'item', itemId: item.id, itemKind: item.kind, filename: item.filename });
          await this.localStore.mutate(sessionId, (value) => {
            const target = value.items.find((candidate) => candidate.id === item.id);
            if (target) Object.assign(target, { cloudflareStatus: 'skipped', cloudflareSkipReason: String(itemError.message).slice(0, 200) });
            pushErrorDetail(value, detail);
          });
        }
        this.emit('status', { sessionId, status: 'uploading', source: 'cloudflare', progress: uploaded / Math.max(items.length, uploaded) });
        session = this.localStore.queue.sessions[sessionId];
      }
      const next = session.items.filter((item) => !item.deletedAt);
      if (!next.some((item) => item.cloudflareStatus !== 'uploaded' && item.cloudflareStatus !== 'skipped')) break;
      items = next;
    }
    // Publish if at least one item was uploaded successfully
    const anyUploaded = session.items.some((item) => item.cloudflareStatus === 'uploaded');
    if (!anyUploaded) throw new Error('Không có tệp nào upload thành công');
    await client.publishSession(session);
    const galleryUrl = client.urlFor(session);
    await this.localStore.mutate(sessionId, (value) => {
      value.cloudflareStatus = 'uploaded';
      value.cloudflareUploadedAt = new Date().toISOString();
      value.cloudflareNextAttemptAt = null;
      value.cloudflareGalleryUrl = galleryUrl;
      value.cloudflareLastError = skippedItems.length ? `Bỏ qua ${skippedItems.length} tệp: ${skippedItems.map((s) => s.kind).join(', ')}` : null;
      value.status = 'uploaded';
      value.uploadedAt = value.cloudflareUploadedAt;
      for (const item of value.items) {
        if (item.deletedAt || item.cloudflareStatus !== 'uploaded') continue;
        item.status = 'uploaded';
        item.checksumVerified = true;
        item.uploadedAt = item.cloudflareUploadedAt;
      }
    });
    this.emit('status', { sessionId, status: 'uploaded', source: 'cloudflare', progress: 1, publicLink: galleryUrl });
    await this.localStore.cleanup(config.storage.retentionHoursAfterUpload, { requireCloudflare: true });
  }

  assertNotCancelled(sessionId) {
    const live = this.localStore.queue.sessions[sessionId];
    if (!live) throw new UploadCancelled('Phiên đã bị xóa khỏi hàng đợi');
    if (live.cloudflareStatus === 'cancelled') throw new UploadCancelled();
    if (live.archived) throw new UploadCancelled('Phiên đã được lưu trữ, tạm dừng upload');
  }

  // Stops an upload without touching the local photos: the pass in flight bails
  // between items and the queue skips the session until it is retried.
  async cancelSession(sessionId) {
    const session = this.localStore.queue.sessions[sessionId];
    if (!session) throw new Error('Không tìm thấy phiên này');
    if (session.cloudflareStatus === 'uploaded') throw new Error('Phiên đã upload xong, không thể hủy');
    await this.localStore.mutate(sessionId, (value) => {
      value.cloudflareStatus = 'cancelled';
      value.cloudflareNextAttemptAt = null;
      value.cloudflareCancelledAt = new Date().toISOString();
      value.cloudflareLastError = 'Đã hủy upload theo yêu cầu';
    });
    this.emit('status', { sessionId, status: 'cancelled', source: 'cloudflare' });
    return this.localStore.uploadSessionView(sessionId);
  }

  // Puts a cancelled, failed or skipped session back in line, including items
  // that were skipped on an earlier pass.
  async retrySession(sessionId) {
    const session = this.localStore.queue.sessions[sessionId];
    if (!session) throw new Error('Không tìm thấy phiên này');
    if (!session.finishedAt) throw new Error('Phiên chưa hoàn tất, chưa thể upload');
    await this.localStore.mutate(sessionId, (value) => {
      value.cloudflareStatus = 'pending';
      value.cloudflareNextAttemptAt = null;
      value.cloudflareAttempts = 0;
      value.cloudflareLastError = null;
      delete value.cloudflareCancelledAt;
      value.cloudflareDeletionStatus = null;
      for (const item of value.items || []) {
        if (item.deletedAt || item.cloudflareStatus === 'uploaded') continue;
        item.cloudflareStatus = 'pending';
        delete item.cloudflareSkipReason;
      }
    });
    this.emit('status', { sessionId, status: 'pending', source: 'cloudflare' });
    this.process().catch(() => { });
    return this.localStore.uploadSessionView(sessionId);
  }

  async retryFailed() {
    for (const session of Object.values(this.localStore.queue.sessions)) {
      if (session.cloudflareStatus !== 'failed' && session.cloudflareDeletionStatus !== 'failed') continue;
      await this.localStore.mutate(session.id, (value) => {
        if (value.cloudflareStatus === 'failed') value.cloudflareStatus = 'pending';
        value.cloudflareDeletionStatus = null;
        value.cloudflareNextAttemptAt = null;
        value.cloudflareLastError = null;
      });
    }
  }
}
