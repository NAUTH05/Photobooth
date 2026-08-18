import assert from 'node:assert/strict';
import test from 'node:test';
import { containRect, coverCropRect, expandRect, normalizePhotoTransform, outputDimensions } from '../src/shared/image-layout.js';


test('cover crop uses original dimensions without distortion for 6000x4000 JPEG', () => {
  const crop = coverCropRect(6000, 4000, 500, 900);
  assert.equal(Math.round(crop.width / crop.height * 1000), Math.round(500 / 900 * 1000));
  assert.equal(Math.round(crop.left), 1889);
  assert.equal(crop.top, 0);
});

test('cover crop supports zoom and edge pan for 2K-class input', () => {
  const crop = coverCropRect(2048, 1536, 500, 900, { panX: 100, panY: 0, zoom: 2 });
  assert.ok(crop.left > 0);
  assert.equal(crop.top, 0);
  assert.ok(crop.width < 2048);
});

test('photo transform normalizes the mirror flag', () => {
  assert.equal(normalizePhotoTransform().mirrored, false);
  assert.equal(normalizePhotoTransform({ mirrored: true }).mirrored, true);
  assert.equal(normalizePhotoTransform({ mirrored: 'true' }).mirrored, false);
});

test('output dimensions preserve portrait print profile', () => {
  assert.deepEqual(outputDimensions(1200, 1800, 3600), { width: 2400, height: 3600, scale: 2 });
  assert.deepEqual(expandRect({ x: 2, y: 3, width: 10, height: 12 }, 3, { width: 20, height: 20 }), { x: 0, y: 0, width: 15, height: 18 });
});

test('wide webcam image is contained without cropping or aspect distortion', () => {
  const result = containRect(1920, 1080, 0, 0, 549, 381);
  assert.ok(result.width <= 549 && result.height <= 381);
  assert.equal(Math.round((result.width / result.height) * 1000), Math.round((1920 / 1080) * 1000));
  assert.equal(result.x, 0);
  assert.ok(result.y > 0);
});
