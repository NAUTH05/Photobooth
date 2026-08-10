import assert from 'node:assert/strict';
import test from 'node:test';
import { containRect } from '../src/shared/image-layout.js';

test('wide webcam image is contained without cropping or aspect distortion', () => {
  const result = containRect(1920, 1080, 0, 0, 549, 381);
  assert.ok(result.width <= 549 && result.height <= 381);
  assert.equal(Math.round((result.width / result.height) * 1000), Math.round((1920 / 1080) * 1000));
  assert.equal(result.x, 0);
  assert.ok(result.y > 0);
});
