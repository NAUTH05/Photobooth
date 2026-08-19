import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalStore, sessionFolderTime } from '../src/main/local-store.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

async function temporaryStore(prefix = 'photobooth-store-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = new LocalStore(root);
  await store.init();
  return { root, store };
}

test('formats Windows-safe session folders and keeps stable ids separate', async (t) => {
  assert.equal(sessionFolderTime(new Date(2026, 7, 11, 9, 37, 19)), '11-08-2026_09-37-19');
  const { root, store } = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  const record = store.queue.sessions[session.id];
  assert.match(record.folderName, /^\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}/);
  assert.notEqual(record.folderName, record.id);
  assert.equal((await fs.stat(store.sessionPath(record.id))).isDirectory(), true);
});

test('creates distinct directories for concurrent sessions in the same second', async (t) => {
  const { root, store } = await temporaryStore('photobooth-concurrent-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = await Promise.all([store.createSession('photo'), store.createSession('photo')]);
  const folders = sessions.map((session) => store.queue.sessions[session.id].folderName);
  assert.equal(new Set(folders).size, 2);
});

test('rejects a corrupted queue instead of silently replacing recoverable state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(root, 'upload-queue.json'), '{broken', 'utf8');
  await assert.rejects(new LocalStore(root).init(), /Không đọc được hàng đợi local/);
});

test('recovers interrupted capture without sending it to upload queue', async (t) => {
  const { root, store } = await temporaryStore();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  const recovered = new LocalStore(root);
  await recovered.init();
  assert.equal(recovered.queue.sessions[session.id].status, 'recoverable');
  assert.equal(recovered.pending().length, 0);
  assert.equal(recovered.listRecoverableSessions().length, 1);
});

test('resumes, reads originals and validates composition drafts', async (t) => {
  const { root, store } = await temporaryStore('photobooth-resume-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  const items = [];
  for (let index = 0; index < 4; index += 1) {
    items.push(await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg }));
  }
  store.queue.sessions[session.id].status = 'recoverable';
  await store.persist();
  await store.resumeSession(session.id);
  const originals = await store.readOriginals(session.id);
  assert.equal(originals.length, 4);
  assert.equal('path' in originals[0], false);
  const draft = await store.saveDraft({ sessionId: session.id, draft: {
    targetCount: 4,
    selectedArtifactIds: items.map((item) => item.id),
    slotAssignments: items.map((item) => item.id),
    frameId: 'frame-4',
    lutId: 'cinematic',
    transforms: { [items[0].id]: { panX: 200, panY: -1, zoom: 10, rotation: -90, mirrored: true } },
    step: 'frame'
  } });
  assert.equal(draft.lutId, 'cinematic');
  assert.deepEqual(draft.transforms[items[0].id], { panX: 100, panY: 0, zoom: 4, rotation: 270, mirrored: true });
  const normalizedDraft = await store.saveDraft({ sessionId: session.id, draft: {
    ...draft,
    lutId: 'unknown-lut'
  } });
  assert.equal(normalizedDraft.lutId, 'natural');
  const customDraft = await store.saveDraft({ sessionId: session.id, draft: {
    ...draft,
    lutId: 'cube-0123456789abcdefabcd'
  } });
  assert.equal(customDraft.lutId, 'cube-0123456789abcdefabcd');
  await assert.rejects(store.saveDraft({ sessionId: session.id, draft: { targetCount: 5 } }), /Số lượng ảnh/);
});

test('resolves originals, rejects disguised images and cleans verified uploads', async (t) => {
  const { root, store } = await temporaryStore('photobooth-validation-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  const item = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  assert.equal(store.resolveArtifact(session.id, item.id, ['photo-original']).id, item.id);
  assert.throws(() => store.resolveArtifact(session.id, item.id, ['dslr-original']), /Loại ảnh/);
  await assert.rejects(store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: Buffer.from('not-a-jpeg') }), /Nội dung tệp/);
  await store.mutate(session.id, (value) => {
    value.status = 'uploaded'; value.uploadedAt = new Date(Date.now() - 5000).toISOString();
    value.items[0].status = 'uploaded'; value.items[0].checksumVerified = true;
  });
  assert.equal(await store.cleanup(0), 1);
});

test('keeps local artifacts until an enabled Cloudflare upload is complete', async (t) => {
  const { root, store } = await temporaryStore('photobooth-multi-upload-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  const item = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.mutate(session.id, (value) => {
    value.status = 'uploaded';
    value.uploadedAt = new Date(Date.now() - 5000).toISOString();
    value.cloudflareStatus = 'uploading';
    value.items[0].status = 'uploaded';
    value.items[0].checksumVerified = true;
  });

  assert.equal(await store.cleanup(0, { requireCloudflare: true }), 0);
  assert.equal((await fs.stat(store.queue.sessions[session.id].items[0].path)).isFile(), true);

  await store.mutate(session.id, (value) => { value.cloudflareStatus = 'uploaded'; });
  assert.equal(await store.cleanup(0, { requireCloudflare: true }), 1);
  await assert.rejects(fs.stat(store.queue.sessions[session.id].items.find((candidate) => candidate.id === item.id).path), { code: 'ENOENT' });
});

test('persists workflow events, print history and never-delete retention', async (t) => {
  const { root, store } = await temporaryStore('photobooth-history-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  const item = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  const queued = await store.recordPrintJob(session.id, { profile: '4x6-portrait', copies: 2, status: 'queued' });
  await store.recordPrintJob(session.id, { ...queued, status: 'printed' });
  await store.mutate(session.id, (value) => {
    value.status = 'uploaded';
    value.uploadedAt = new Date(0).toISOString();
    value.items[0].status = 'uploaded';
    value.items[0].checksumVerified = true;
  });
  assert.equal(await store.cleanup(-1), 0);
  assert.equal((await fs.stat(store.queue.sessions[session.id].items.find((candidate) => candidate.id === item.id).path)).isFile(), true);
  assert.equal(store.queue.sessions[session.id].printJobs[0].status, 'printed');
  assert.ok(store.queue.sessions[session.id].events.some((event) => event.type === 'print-printed'));
});

test('cleanupByAge removes local files older than the specified number of days', async (t) => {
  const { root, store } = await temporaryStore('photobooth-age-cleanup-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldSession = await store.createSession('photo');
  const oldItem = await store.saveArtifact({ sessionId: oldSession.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.mutate(oldSession.id, (value) => { value.createdAt = new Date(Date.now() - 8 * 86400000).toISOString(); value.status = 'cancelled'; });
  const freshSession = await store.createSession('photo');
  await store.saveArtifact({ sessionId: freshSession.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  assert.equal(await store.cleanupByAge(7), 1);
  await assert.rejects(fs.stat(store.queue.sessions[oldSession.id].items.find((candidate) => candidate.id === oldItem.id).path), { code: 'ENOENT' });
  assert.equal(await store.cleanupByAge(7), 0);
  assert.equal(await store.cleanupByAge(-1), 0);
});

test('uploadSessions lists every session newest first with its rolled-up upload state', async (t) => {
  const { root, store } = await temporaryStore('photobooth-upload-list-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const older = await store.createSession('photo');
  await store.saveArtifact({ sessionId: older.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.finishSession(older.id);
  const newer = await store.createSession('photo');
  await store.saveArtifact({ sessionId: newer.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.mutate(older.id, (value) => { value.createdAt = new Date(Date.now() - 60000).toISOString(); });

  const sessions = store.uploadSessions();
  assert.deepEqual(sessions.map((session) => session.id), [newer.id, older.id]);
  assert.equal(sessions[0].uploadState, 'capturing');
  assert.equal(sessions[1].uploadState, 'pending');
  assert.equal(sessions[1].itemCount, 1);
  assert.equal(sessions[1].uploadedCount, 0);
  assert.equal(sessions[1].progress, 0);

  await store.mutate(older.id, (value) => {
    value.cloudflareStatus = 'uploaded';
    value.items[0].cloudflareStatus = 'uploaded';
  });
  const uploaded = store.uploadSessions().find((session) => session.id === older.id);
  assert.equal(uploaded.uploadState, 'uploaded');
  assert.equal(uploaded.progress, 1);
});

test('uploadSessionDetail reports which files vanished from disk', async (t) => {
  const { root, store } = await temporaryStore('photobooth-upload-detail-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  const kept = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  const lost = await store.saveArtifact({ sessionId: session.id, kind: 'photo-strip', extension: 'jpg', bytes: jpeg, profile: '4x6-portrait' });
  await store.finishSession(session.id);
  await fs.rm(store.queue.sessions[session.id].items.find((item) => item.id === lost.id).path);

  const detail = await store.uploadSessionDetail(session.id);
  assert.equal(detail.directoryExists, true);
  assert.equal(detail.items.length, 2);
  assert.equal(detail.missingCount, 1);
  assert.equal(detail.items.find((item) => item.id === kept.id).missing, false);
  assert.equal(detail.items.find((item) => item.id === lost.id).missing, true);
  assert.deepEqual(detail.errors, []);
  assert.ok(detail.events.some((event) => event.type === 'session-finished'));
  await assert.rejects(store.uploadSessionDetail('missing-session'), /Không tìm thấy phiên/);
});

test('archived sessions are parked and never swept by the age cleanup', async (t) => {
  const { root, store } = await temporaryStore('photobooth-upload-archive-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = await store.createSession('photo');
  const item = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
  await store.mutate(session.id, (value) => {
    value.createdAt = new Date(Date.now() - 8 * 86400000).toISOString();
    value.status = 'cancelled';
  });

  const archived = await store.setArchived(session.id, true);
  assert.equal(archived.archived, true);
  assert.equal(store.uploadSessions({ includeArchived: false }).length, 0);
  assert.equal(store.uploadSessions().length, 1);
  assert.equal(await store.cleanupByAge(7), 0);
  assert.equal((await fs.stat(store.queue.sessions[session.id].items.find((candidate) => candidate.id === item.id).path)).isFile(), true);
  assert.ok(store.queue.sessions[session.id].events.some((event) => event.type === 'session-archived'));

  await store.setArchived(session.id, false);
  assert.equal(store.queue.sessions[session.id].archivedAt, null);
  assert.equal(await store.cleanupByAge(7), 1);
});
