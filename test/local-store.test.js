import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStore } from '../src/main/local-store.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

test('recovers interrupted capture and only cleans checksum-verified uploads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-store-'));
  try {
    const first = new LocalStore(root);
    await first.init();
    const session = await first.createSession('photo');
    await first.saveArtifact({ sessionId: session.id, kind: 'photo', extension: 'jpg', bytes: jpeg });

    const recovered = new LocalStore(root);
    await recovered.init();
    assert.equal(recovered.queue.sessions[session.id].status, 'pending');
    await recovered.mutate(session.id, (value) => {
      value.status = 'uploaded';
      value.uploadedAt = new Date(Date.now() - 5000).toISOString();
      value.items[0].status = 'uploaded';
      value.items[0].checksumVerified = true;
    });
    assert.equal(await recovered.cleanup(0), 1);
    assert.ok(recovered.queue.sessions[session.id].items[0].deletedAt);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolves only original JPEG artifacts from the same session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-resolve-'));
  try {
    const store = new LocalStore(root); await store.init();
    const session = await store.createSession('photo');
    const item = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
    assert.equal(store.resolveArtifact(session.id, item.id, ['photo-original']).id, item.id);
    assert.throws(() => store.resolveArtifact(session.id, item.id, ['dslr-original']), /Loại ảnh/);
    assert.throws(() => store.resolveArtifact('missing', item.id, ['photo-original']), /Session not found/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects disguised images and removes an empty gallery instead of leaving an orphan', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-validation-'));
  try {
    const store = new LocalStore(root); await store.init();
    const session = await store.createSession('photo');
    await assert.rejects(
      store.saveArtifact({ sessionId: session.id, kind: 'photo', extension: 'jpg', bytes: Buffer.from('not-a-jpeg') }),
      /Nội dung tệp không hợp lệ/
    );
    await assert.rejects(store.finishSession(session.id), /gallery rỗng/i);
    assert.equal(store.queue.sessions[session.id], undefined);
    await assert.rejects(fs.access(store.sessionPath(session.id)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
