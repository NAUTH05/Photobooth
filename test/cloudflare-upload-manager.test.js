import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudflareUploadManager } from '../src/main/cloudflare-upload-manager.js';
import { LocalStore } from '../src/main/local-store.js';
import { RequestError } from '../src/main/retry-policy.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test('uploads every session artifact to Cloudflare and publishes the QR manifest', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cloudflare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  await store.init();
  const session = await store.createSession('photo', 7);
  await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.saveArtifact({ sessionId: session.id, kind: 'photo-strip', extension: 'jpg', bytes: jpeg, profile: '4x6-portrait' });
  await store.finishSession(session.id);

  const uploaded = [];
  let published = null;
  let prepared = null;
  const client = {
    async prepareSession(value) { prepared = value.id; },
    async uploadItem(value, item) { uploaded.push(`${value.id}/${item.filename}`); },
    async publishSession(value) { published = structuredClone(value); },
    urlFor(value) { return `https://gallery.example/s/${value.id}?t=${value.galleryToken}`; }
  };
  const config = {
    cloudflare: { enabled: true, baseUrl: 'https://gallery.example', uploadSecret: 'a'.repeat(32) },
    storage: { maxRetryMinutes: 30, retentionHoursAfterUpload: 24 }
  };
  const manager = new CloudflareUploadManager(store, { get: () => structuredClone(config) }, () => client);
  await manager.process();

  assert.equal(uploaded.length, 2);
  assert.equal(prepared, session.id);
  assert.equal(published.items.filter((item) => item.cloudflareStatus === 'uploaded').length, 2);
  const saved = store.queue.sessions[session.id];
  assert.equal(saved.cloudflareStatus, 'uploaded');
  assert.equal(saved.status, 'uploaded');
  assert.match(saved.cloudflareGalleryUrl, /^https:\/\/gallery\.example\/s\//);
  assert.ok(saved.items.every((item) => item.cloudflareChecksumVerified && item.checksumVerified));
});

test('deletes an expired Cloudflare session from R2', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cloudflare-expired-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  await store.init();
  const session = await store.createSession('photo', 7);
  await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.finishSession(session.id);
  await store.mutate(session.id, (value) => {
    value.expiresAt = new Date(Date.now() - 1000).toISOString();
    value.cloudflareStatus = 'uploaded';
  });

  const deleted = [];
  const client = { async deleteSession(value) { deleted.push(value.id); } };
  const config = {
    cloudflare: { enabled: true, baseUrl: 'https://gallery.example', uploadSecret: 'a'.repeat(32) },
    storage: { maxRetryMinutes: 30, retentionHoursAfterUpload: 24 }
  };
  const manager = new CloudflareUploadManager(store, { get: () => structuredClone(config) }, () => client);
  await manager.process();

  assert.deepEqual(deleted, [session.id]);
  assert.equal(store.queue.sessions[session.id].cloudflareStatus, 'deleted');
  assert.ok(store.queue.sessions[session.id].cloudflareDeletedAt);
});

test('stops automatic retry for permanent Cloudflare authentication failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cloudflare-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  await store.init();
  const session = await store.createSession('photo', 7);
  await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.finishSession(session.id);
  let attempts = 0;
  const client = { async uploadItem() { attempts += 1; throw new RequestError('Unauthorized', { status: 401 }); } };
  const config = {
    cloudflare: { enabled: true, baseUrl: 'https://gallery.example', uploadSecret: 'a'.repeat(32) },
    storage: { maxRetryMinutes: 30, retryBaseSeconds: 5, retryJitterPercent: 20, retentionHoursAfterUpload: 24 }
  };
  const manager = new CloudflareUploadManager(store, { get: () => structuredClone(config) }, () => client);
  await manager.process();
  assert.equal(store.queue.sessions[session.id].cloudflareStatus, 'failed');
  assert.equal(store.queue.sessions[session.id].cloudflareNextAttemptAt, null);
  await manager.process();
  assert.equal(attempts, 1);
});

const managerConfig = (enabled = true) => ({
  cloudflare: { enabled, baseUrl: 'https://gallery.example', uploadSecret: 'a'.repeat(32) },
  storage: { maxRetryMinutes: 30, retryBaseSeconds: 5, retryJitterPercent: 0, retentionHoursAfterUpload: 24 }
});

async function seedSession(root) {
  const store = new LocalStore(root);
  await store.init();
  const session = await store.createSession('photo', 7);
  await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.saveArtifact({ sessionId: session.id, kind: 'photo-strip', extension: 'jpg', bytes: jpeg, profile: '4x6-portrait' });
  await store.finishSession(session.id);
  return { store, sessionId: session.id };
}

test('records the raw server response for every failure so the manager can show it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cloudflare-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { store, sessionId } = await seedSession(root);
  const client = {
    async uploadItem(_session, item) {
      if (item.kind === 'photo-strip') return;
      throw new RequestError('Tệp không còn trên máy: photo.jpg', {
        retryable: false,
        stage: 'read-file',
        body: '{"error":"file gone"}',
        cause: Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      });
    },
    async publishSession() { },
    urlFor(value) { return `https://gallery.example/s/${value.id}`; }
  };
  const manager = new CloudflareUploadManager(store, { get: () => managerConfig() }, () => client);
  await manager.process();

  const detail = await store.uploadSessionDetail(sessionId);
  assert.equal(detail.uploadState, 'uploaded', 'one bad file must not block the whole gallery');
  assert.equal(detail.skippedCount, 1);
  assert.equal(detail.errors.length, 1);
  assert.equal(detail.errors[0].stage, 'read-file');
  assert.equal(detail.errors[0].retryable, false);
  assert.equal(detail.errors[0].code, 'ENOENT');
  assert.match(detail.errors[0].response, /file gone/);
  assert.match(detail.errors[0].filename, /\.jpg$/);
});

test('cancelling a session stops the uploader and keeps the local photos', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cloudflare-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { store, sessionId } = await seedSession(root);
  const manager = new CloudflareUploadManager(store, { get: () => managerConfig(false) }, () => ({}));

  const view = await manager.cancelSession(sessionId);
  assert.equal(view.uploadState, 'cancelled');
  assert.equal(manager.queuedSessions().length, 0, 'a cancelled session must not be picked up again');
  assert.throws(() => manager.assertNotCancelled(sessionId), /hủy upload/i);
  const detail = await store.uploadSessionDetail(sessionId);
  assert.equal(detail.items.length, 2);
  assert.equal(detail.missingCount, 0, 'cancelling never deletes a photo');
});

test('retrying a session re-queues the items an earlier pass skipped', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cloudflare-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { store, sessionId } = await seedSession(root);
  await store.mutate(sessionId, (value) => {
    value.cloudflareStatus = 'failed';
    value.cloudflareAttempts = 4;
    value.cloudflareLastError = 'Bỏ qua 1 tệp';
    value.items[0].cloudflareStatus = 'skipped';
    value.items[0].cloudflareSkipReason = 'Tệp không còn trên máy';
    value.items[1].cloudflareStatus = 'uploaded';
  });
  const manager = new CloudflareUploadManager(store, { get: () => managerConfig(false) }, () => ({}));

  const view = await manager.retrySession(sessionId);
  assert.equal(view.uploadState, 'pending');
  assert.equal(view.attempts, 0);
  assert.equal(view.lastError, null);
  const saved = store.queue.sessions[sessionId];
  assert.equal(saved.items[0].cloudflareStatus, 'pending');
  assert.equal(saved.items[0].cloudflareSkipReason, undefined);
  assert.equal(saved.items[1].cloudflareStatus, 'uploaded', 'already uploaded files are not sent twice');
  assert.equal(manager.queuedSessions().length, 1);
});

test('archiving a session parks it out of the upload queue', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cloudflare-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { store, sessionId } = await seedSession(root);
  const manager = new CloudflareUploadManager(store, { get: () => managerConfig(false) }, () => ({}));
  assert.equal(manager.queuedSessions().length, 1);

  const archived = await store.setArchived(sessionId, true);
  assert.equal(archived.archived, true);
  assert.equal(manager.queuedSessions().length, 0);
  assert.throws(() => manager.assertNotCancelled(sessionId), /lưu trữ/i);

  const restored = await store.setArchived(sessionId, false);
  assert.equal(restored.archived, false);
  assert.equal(manager.queuedSessions().length, 1);
});
