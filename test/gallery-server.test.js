import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CppGalleryBackend } from '../src/main/cpp-gallery-backend.js';
import { LocalStore } from '../src/main/local-store.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]);

const request = (url) => new Promise((resolve, reject) => {
  http.get(url, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('serves a token-protected session gallery and its image', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-gallery-'));
  const store = new LocalStore(root);
  const config = { get: () => ({ gallery: { host: '127.0.0.1', port: 0, publicBaseUrl: '' } }) };
  const server = new CppGalleryBackend(projectRoot, root, config);
  try {
    await store.init();
    const session = await store.createSession('photo');
    const item = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: jpeg });
    const videoItem = await store.saveArtifact({ sessionId: session.id, kind: 'video-timelapse', extension: 'mp4', bytes: mp4 });
    await store.finishSession(session.id);
    await server.start();
    const port = server.port;
    const token = encodeURIComponent(session.galleryToken);
    const gallery = await request(`http://127.0.0.1:${port}/s/${session.id}?t=${token}`);
    assert.equal(gallery.status, 200);
    assert.match(gallery.body.toString(), /Khoảnh khắc/);
    const api = await request(`http://127.0.0.1:${port}/api/public/sessions/${session.id}?t=${token}`);
    assert.equal(api.status, 200);
    const publicItems = JSON.parse(api.body).items;
    assert.equal(publicItems.length, 2);
    assert.equal(publicItems.find((value) => value.id === videoItem.id).mediaType, 'video');
    const media = await request(`http://127.0.0.1:${port}/media/${session.id}/${item.id}?t=${token}`);
    assert.equal(media.status, 200);
    assert.deepEqual(media.body, jpeg);
    const video = await request(`http://127.0.0.1:${port}/media/${session.id}/${videoItem.id}?t=${token}`);
    assert.equal(video.status, 200);
    assert.deepEqual(video.body, mp4);
    const denied = await request(`http://127.0.0.1:${port}/s/${session.id}?t=wrong`);
    assert.equal(denied.status, 404);
    await store.mutate(session.id, (value) => { value.expiresAt = new Date(Date.now() - 1000).toISOString(); });
    const expired = await request(`http://127.0.0.1:${port}/s/${session.id}?t=${token}`);
    assert.equal(expired.status, 410);
    assert.match(expired.body.toString(), /đã hết hạn/);
  } finally {
    server.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
