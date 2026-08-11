import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStore } from '../src/main/local-store.js';
import { UploadManager } from '../src/main/upload-manager.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

test('uploads a queued session and verifies its checksum', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-upload-'));
  try {
    const store = new LocalStore(root); await store.init();
    const session = await store.createSession('photo');
    const bytes = jpeg;
    await store.saveArtifact({ sessionId: session.id, kind: 'photo-strip', extension: 'jpg', bytes, profile: '4x6-portrait' });
    await store.finishSession(session.id);
    const drive = {
      createSessionFolder: async () => ({ id: 'folder-1', webViewLink: 'https://drive.example/folder-1' }),
      uploadFile: async (_folder, item) => ({ id: 'file-1', webViewLink: 'https://drive.example/file-1', md5Checksum: crypto.createHash('md5').update(bytes).digest('hex') })
    };
    const configStore = { get: () => ({ drive: { enabled: true }, storage: { maxRetryMinutes: 1, retentionHoursAfterUpload: 24 } }) };
    const manager = new UploadManager(store, () => drive, configStore);
    await manager.process();
    const uploaded = store.queue.sessions[session.id];
    assert.equal(uploaded.status, 'uploaded');
    assert.equal(uploaded.items[0].checksumVerified, true);
    assert.equal(uploaded.publicLink, 'https://drive.example/folder-1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('revokes the public Drive permission after gallery expiration', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-expire-'));
  try {
    const store = new LocalStore(root); await store.init();
    const session = await store.createSession('photo', 1);
    await store.mutate(session.id, (value) => {
      value.status = 'uploaded';
      value.expiresAt = new Date(Date.now() - 1000).toISOString();
      value.driveFolderId = 'folder-expired';
      value.drivePublicPermissionId = 'permission-anyone';
    });
    let revoked = null;
    const drive = { revokePermission: async (folderId, permissionId) => { revoked = { folderId, permissionId }; } };
    const configStore = { get: () => ({ drive: { enabled: true }, storage: { maxRetryMinutes: 1, retentionHoursAfterUpload: 24 } }) };
    const manager = new UploadManager(store, () => drive, configStore);
    await manager.process();
    assert.deepEqual(revoked, { folderId: 'folder-expired', permissionId: 'permission-anyone' });
    assert.ok(store.queue.sessions[session.id].permissionRevokedAt);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('never uploads a gallery after its expiration time', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-expired-queue-'));
  try {
    const store = new LocalStore(root); await store.init();
    const session = await store.createSession('photo');
    await store.saveArtifact({ sessionId: session.id, kind: 'photo-strip', extension: 'jpg', bytes: jpeg, profile: '4x6-portrait' });
    await store.finishSession(session.id);
    await store.mutate(session.id, (value) => { value.expiresAt = new Date(Date.now() - 1000).toISOString(); });
    let uploads = 0;
    const drive = {
      createSessionFolder: async () => { uploads += 1; return { id: 'forbidden' }; },
      uploadFile: async () => { uploads += 1; return {}; }
    };
    const configStore = { get: () => ({ drive: { enabled: true }, storage: { maxRetryMinutes: 1, retentionHoursAfterUpload: 24 } }) };
    const manager = new UploadManager(store, () => drive, configStore);
    await manager.process();
    assert.equal(uploads, 0);
    assert.equal(store.pending().length, 0);
    assert.equal(store.stats().pending, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
