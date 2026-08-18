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
