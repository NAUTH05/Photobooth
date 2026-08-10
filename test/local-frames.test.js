import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FrameManager } from '../src/main/frame-manager.js';

test('loads only portrait 4x6 frames from the bundled legacy frame folder', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const manager = new FrameManager(path.join(root, '.unused-frame-cache'), null, null, path.join(root, 'frames'));
  const frames = await manager.listBundledFrames();
  assert.equal(frames.length, 21);
  assert.ok(frames.every((frame) => frame.source === 'bundled' && frame.fit === 'contain' && frame.inferSlots));
  assert.ok(frames.some((frame) => frame.slotCount === 2));
  assert.ok(frames.some((frame) => frame.slotCount === 4));
});
