import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { CloudflareGalleryClient } from '../src/main/cloudflare-gallery-client.js';
import { CubeLutManager } from '../src/main/cube-lut-manager.js';
import { GradedPhotoService } from '../src/main/graded-photo-service.js';
import { LocalStore } from '../src/main/local-store.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-graded-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(path.join(root, 'store'));
  await store.init();
  const manager = new CubeLutManager(path.join(root, 'luts'));
  await manager.init();
  const service = new GradedPhotoService(store, manager);
  const session = await store.createSession('photo');
  const input = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#d36b43' } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const source = await store.saveArtifact({ sessionId: session.id, kind: 'photo-original', extension: 'jpg', bytes: input });
  return { root, store, manager, service, session, source, input };
}

test('renders exact LUT previews for an individual source photo', async (t) => {
  const { service, session, source } = await fixture(t);
  const preview = await service.renderPreview({ sessionId: session.id, artifactId: source.id, lutId: 'cinematic', maxWidth: 640 });
  const pixel = await sharp(preview.bytes).raw().toBuffer();
  assert.notDeepEqual(Array.from(pixel.slice(0, 3)), [211, 107, 67]);
});

test('creates one visible graded photo per source while preserving hidden originals', async (t) => {
  const { store, service, session, source } = await fixture(t);
  const first = await service.prepareSession({ sessionId: session.id, artifactIds: [source.id], lutId: 'cinematic' });
  assert.equal(first.items.length, 1);
  let items = store.queue.sessions[session.id].items;
  const original = items.find((item) => item.id === source.id);
  const processed = items.find((item) => item.id === first.items[0].id);
  assert.equal(original.galleryHidden, true);
  assert.equal(processed.kind, 'photo-processed');
  assert.equal(processed.sourceItemId, source.id);
  assert.equal(processed.lutId, 'cinematic');
  assert.equal(processed.galleryHidden, false);
  assert.equal(items.find((item) => item.kind === 'photo-thumbnail' && item.sourceItemId === source.id).galleryHidden, true);
  assert.equal(items.find((item) => item.kind === 'photo-thumbnail' && item.sourceItemId === processed.id).galleryHidden, false);

  await service.prepareSession({ sessionId: session.id, artifactIds: [source.id], lutId: 'cinematic' });
  items = store.queue.sessions[session.id].items;
  assert.equal(items.filter((item) => item.kind === 'photo-processed').length, 1, 'same LUT should reuse the derived JPEG');

  await store.finishSession(session.id);
  const second = await service.prepareSession({ sessionId: session.id, artifactIds: [source.id], lutId: 'warm-film' });
  items = store.queue.sessions[session.id].items;
  assert.equal(items.filter((item) => item.kind === 'photo-processed').length, 2);
  assert.equal(store.queue.sessions[session.id].cloudflareStatus, 'pending');
  assert.equal(items.find((item) => item.id === first.items[0].id).galleryHidden, true);
  assert.equal(items.find((item) => item.id === second.items[0].id).galleryHidden, false);

  await service.prepareSession({ sessionId: session.id, artifactIds: [source.id], lutId: 'natural' });
  items = store.queue.sessions[session.id].items;
  assert.equal(items.find((item) => item.id === source.id).galleryHidden, false);
  assert.ok(items.filter((item) => item.kind === 'photo-processed').every((item) => item.galleryHidden));
});

test('Cloudflare manifest publishes graded photos but omits gallery-hidden sources', async () => {
  let publishedBody = null;
  const fetchImpl = async (_url, options) => {
    publishedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new CloudflareGalleryClient({ baseUrl: 'https://gallery.example', uploadSecret: 'a'.repeat(32), requestTimeoutSeconds: 10 }, fetchImpl);
  const common = { size: 12, md5: 'a'.repeat(32), createdAt: new Date().toISOString(), cloudflareStatus: 'uploaded' };
  await client.publishSession({
    id: 'PB_session_123', galleryToken: 'token-value-long-enough-123', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
    items: [
      { ...common, id: 'source-item-123', kind: 'photo-original', filename: 'raw.jpg', galleryHidden: true },
      { ...common, id: 'graded-item-123', kind: 'photo-processed', filename: 'graded.jpg', sourceItemId: 'source-item-123' }
    ]
  });
  assert.deepEqual(publishedBody.items.map((item) => item.kind), ['photo-processed']);
  assert.equal(publishedBody.items[0].sourceItemId, 'source-item-123');
});
