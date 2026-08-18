import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FrameManager } from '../src/main/frame-manager.js';

test('loads all bundled print profiles with cover fitting', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const manager = new FrameManager(path.join(root, '.unused-frame-cache'), null, path.join(root, 'frames'));
  const frames = await manager.listBundledFrames();
  assert.equal(frames.length, 52);
  assert.ok(frames.every((frame) => frame.source === 'bundled' && frame.fit === 'cover' && frame.inferSlots));
  assert.ok(frames.some((frame) => frame.category === '4x6-portrait'));
  assert.ok(frames.some((frame) => frame.category === '4x6-landscape'));
  assert.ok(frames.some((frame) => frame.category === '2x6'));
});

test('uses a downloaded manifest as the authoritative frame list', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-frame-cache-'));
  const bundledRoot = path.resolve(import.meta.dirname, '..', 'frames');
  const remoteFrame = {
    id: 'frame-authoritative',
    name: 'Khung trên website',
    file: 'remote--frame-authoritative--frame.png',
    source: 'remote',
  };

  try {
    await fs.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: 42,
      frames: [remoteFrame],
    }));

    const manager = new FrameManager(cacheRoot, null, bundledRoot);
    const populated = await manager.sourceFrames();
    assert.deepEqual(populated.frames, [remoteFrame]);

    await fs.writeFile(path.join(cacheRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: 43,
      frames: [],
    }));
    const empty = await manager.sourceFrames();
    assert.deepEqual(empty.frames, []);
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});
