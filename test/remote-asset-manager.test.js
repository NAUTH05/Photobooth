import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CubeLutManager } from '../src/main/cube-lut-manager.js';
import { RemoteAssetManager } from '../src/main/remote-asset-manager.js';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('downloads only missing remote frames and LUTs, then safely removes obsolete remote files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-assets-'));
  const framesRoot = path.join(root, 'frames');
  const lutsRoot = path.join(root, 'luts');
  await Promise.all([fs.mkdir(framesRoot), fs.mkdir(lutsRoot)]);
  const manualCube = Buffer.from('TITLE "Manual"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  const remoteCube = Buffer.from('TITLE "Remote title"\nLUT_3D_SIZE 2\n0 0 0\n.9 0 0\n0 .9 0\n.9 .9 0\n0 0 .9\n.9 0 .9\n0 .9 .9\n.9 .9 .9\n');
  const frameBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  await fs.writeFile(path.join(lutsRoot, 'my-manual.cube'), manualCube);
  const lutManager = new CubeLutManager(lutsRoot);
  await lutManager.init();
  await Promise.all([
    fs.writeFile(path.join(framesRoot, 'remote--orphan-frame--old.png'), frameBytes),
    fs.writeFile(path.join(framesRoot, 'my-manual-frame.png'), frameBytes),
    fs.writeFile(path.join(lutsRoot, 'remote--orphan-lut--old.cube'), Buffer.from('obsolete cache')),
  ]);
  const frameManager = { lastSync: null };
  const configStore = { get: () => ({ assets: { enabled: true, baseUrl: 'http://localhost:8788', requestTimeoutSeconds: 10 } }) };
  const manager = new RemoteAssetManager({ framesRoot, lutsRoot, configStore, frameManager, lutManager });
  let manifest = {
    schemaVersion: 1,
    version: 42,
    updatedAt: '2026-08-15T00:00:00.000Z',
    frames: [
      { id: `frame-${hash(frameBytes).slice(0, 20)}`, name: 'Hoa hồng', file: 'rose.png', downloadUrl: '/api/assets/files/frames/one', sha256: hash(frameBytes), size: frameBytes.length, slotCount: 4, layout: '4x6', category: '4x6-portrait', accent: '#ef765e' },
      { id: `frame-${'a'.repeat(20)}`, name: 'Đang lưu trữ', file: 'archived.png', downloadUrl: '/api/assets/files/frames/archived', sha256: 'b'.repeat(64), size: 999, slotCount: 4, layout: '4x6', category: '4x6-portrait', accent: '#ef765e', archived: true },
    ],
    luts: [
      { id: `lut-${hash(remoteCube).slice(0, 20)}`, label: 'Nắng mật ong', file: 'honey.cube', downloadUrl: '/api/assets/files/luts/one', sha256: hash(remoteCube), size: remoteCube.length },
      { id: `lut-${'c'.repeat(20)}`, label: 'Màu đang lưu trữ', file: 'archived.cube', downloadUrl: '/api/assets/files/luts/archived', sha256: 'd'.repeat(64), size: 999, archived: true },
    ],
  };
  const originalFetch = globalThis.fetch;
  let fileRequests = 0;
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/manifest.json')) return Response.json(manifest);
    fileRequests += 1;
    if (pathname.includes('/frames/')) return new Response(frameBytes, { headers: { 'content-length': String(frameBytes.length) } });
    return new Response(remoteCube, { headers: { 'content-length': String(remoteCube.length) } });
  };
  try {
    const first = await manager.sync();
    assert.equal(first.downloadedFrames, 1);
    assert.equal(first.frameCount, 1);
    assert.equal(first.downloadedLuts, 1);
    assert.equal(first.lutCount, 1);
    assert.equal(fileRequests, 2);
    assert.ok(lutManager.list().some((lut) => lut.label === 'Nắng mật ong' && lut.remote));
    assert.ok(!(await fs.readdir(framesRoot)).includes('remote--orphan-frame--old.png'));
    assert.ok((await fs.readdir(framesRoot)).includes('my-manual-frame.png'));
    assert.ok(!(await fs.readdir(lutsRoot)).includes('remote--orphan-lut--old.cube'));
    assert.ok((await fs.readdir(lutsRoot)).includes('my-manual.cube'));

    const second = await manager.sync();
    assert.equal(second.downloadedFrames, 0);
    assert.equal(second.downloadedLuts, 0);
    assert.equal(fileRequests, 2);

    manifest = { ...manifest, version: 43, frames: [], luts: [] };
    await manager.sync();
    const frameEntries = await fs.readdir(framesRoot);
    const lutEntries = await fs.readdir(lutsRoot);
    assert.ok(!frameEntries.some((entry) => entry.startsWith('remote--')));
    assert.ok(!lutEntries.some((entry) => entry.startsWith('remote--')));
    assert.ok(lutEntries.includes('my-manual.cube'));
    assert.ok(lutManager.list().some((lut) => lut.label === 'Manual'));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});
