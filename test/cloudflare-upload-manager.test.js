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
