import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FrameManager } from '../src/main/frame-manager.js';

test('loads all bundled print profiles with cover fitting', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const manager = new FrameManager(path.join(root, '.unused-frame-cache'), null, null, path.join(root, 'frames'));
  const frames = await manager.listBundledFrames();
  assert.equal(frames.length, 50);
  assert.ok(frames.every((frame) => frame.source === 'bundled' && frame.fit === 'cover' && frame.inferSlots));
  assert.ok(frames.some((frame) => frame.category === '4x6-portrait'));
  assert.ok(frames.some((frame) => frame.category === '4x6-landscape'));
  assert.ok(frames.some((frame) => frame.category === '2x6'));
});
