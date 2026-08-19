import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CloudflareGalleryClient } from '../src/main/cloudflare-gallery-client.js';

test('uploads media directly to an R2 presigned URL then confirms it with Heroku', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cham-direct-r2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'timelapse.mp4');
  const bytes = Buffer.from([0, 0, 0, 24]);
  await fs.writeFile(filePath, bytes);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers });
    if (String(url).endsWith('/upload-url')) {
      return Response.json({
        url: 'https://account.r2.cloudflarestorage.com/signed-upload',
        headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) },
      });
    }
    if (String(url).includes('r2.cloudflarestorage.com')) {
      const uploaded = Buffer.from(await new Response(options.body).arrayBuffer());
      assert.deepEqual(uploaded, bytes);
      return new Response(null, { status: 200 });
    }
    if (String(url).endsWith('/complete')) return Response.json({ ok: true });
    return Response.json({ error: 'unexpected request' }, { status: 500 });
  };
  const client = new CloudflareGalleryClient({
    baseUrl: 'https://gallery.example',
    uploadSecret: 'a'.repeat(32),
    requestTimeoutSeconds: 10,
  }, fetchImpl);
  await client.uploadItem({ id: 'session-12345678' }, {
    id: 'video-12345678',
    path: filePath,
    filename: 'timelapse.mp4',
    kind: 'video-timelapse',
    size: bytes.length,
    md5: 'd3b07384d113edec49eaa6238ad5ff00',
    createdAt: '2026-08-18T10:00:00.000Z',
  });
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'PUT', 'POST']);
  assert.match(calls[0].url, /\/upload-url$/);
  assert.match(calls[2].url, /\/complete$/);
});

test('a photo missing from disk fails the item instead of crashing the process', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cham-missing-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const client = new CloudflareGalleryClient({
    baseUrl: 'https://gallery.example',
    uploadSecret: 'a'.repeat(32),
    requestTimeoutSeconds: 10,
  }, async (url) => { calls.push(String(url)); return Response.json({ ok: true }); });

  // An uncaught 'error' from the read stream used to reach Electron as
  // "A JavaScript error occurred in the main process: ... no such file or directory".
  const error = await client.uploadItem({ id: 'session-12345678' }, {
    id: 'photo-12345678',
    path: path.join(root, 'gone.jpg'),
    filename: 'gone.jpg',
    kind: 'photo-original',
    size: 1024,
    createdAt: '2026-08-18T10:00:00.000Z',
  }).then(() => null, (value) => value);

  assert.ok(error, 'upload of a missing file must reject');
  assert.equal(error.name, 'RequestError');
  assert.equal(error.retryable, false);
  assert.equal(error.stage, 'read-file');
  assert.match(error.message, /không còn trên máy/i);
  assert.deepEqual(calls, [], 'the missing file is caught before any network call');
});

test('a photo that changed on disk is not uploaded with a stale length', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cham-size-drift-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'photo.jpg');
  await fs.writeFile(filePath, Buffer.alloc(64, 1));
  const client = new CloudflareGalleryClient({
    baseUrl: 'https://gallery.example',
    uploadSecret: 'a'.repeat(32),
    requestTimeoutSeconds: 10,
  }, async () => Response.json({ ok: true }));

  const error = await client.uploadItem({ id: 'session-12345678' }, {
    id: 'photo-12345678',
    path: filePath,
    filename: 'photo.jpg',
    kind: 'photo-original',
    size: 4096,
    createdAt: '2026-08-18T10:00:00.000Z',
  }).then(() => null, (value) => value);

  assert.ok(error);
  assert.equal(error.retryable, false);
  assert.match(error.message, /đã thay đổi trên máy/i);
});

test('keeps the raw server response on the error so the session manager can show it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cham-server-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'photo.jpg');
  const bytes = Buffer.alloc(8, 2);
  await fs.writeFile(filePath, bytes);
  const client = new CloudflareGalleryClient({
    baseUrl: 'https://gallery.example',
    uploadSecret: 'a'.repeat(32),
    requestTimeoutSeconds: 10,
  }, async () => Response.json({ error: 'session not found' }, { status: 404 }));

  const error = await client.uploadItem({ id: 'session-12345678' }, {
    id: 'photo-12345678',
    path: filePath,
    filename: 'photo.jpg',
    kind: 'photo-original',
    size: bytes.length,
    createdAt: '2026-08-18T10:00:00.000Z',
  }).then(() => null, (value) => value);

  assert.ok(error);
  assert.equal(error.status, 404);
  assert.match(error.message, /session not found/);
  assert.match(error.body, /session not found/);
  assert.equal(error.retryable, false);
});

test('rejects an unsupported extension without retrying it forever', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cham-bad-extension-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'notes.txt');
  await fs.writeFile(filePath, 'hello');
  const client = new CloudflareGalleryClient({
    baseUrl: 'https://gallery.example',
    uploadSecret: 'a'.repeat(32),
  }, async () => Response.json({ ok: true }));

  const error = await client.uploadItem({ id: 'session-12345678' }, {
    id: 'photo-12345678',
    path: filePath,
    filename: 'notes.txt',
    kind: 'photo-original',
    size: 5,
    createdAt: '2026-08-18T10:00:00.000Z',
  }).then(() => null, (value) => value);

  assert.ok(error);
  assert.equal(error.retryable, false);
  assert.match(error.message, /không hỗ trợ upload/i);
});
