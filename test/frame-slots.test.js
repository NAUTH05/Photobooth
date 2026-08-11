import assert from 'node:assert/strict';
import test from 'node:test';
import { detectTransparentSlots } from '../src/shared/frame-slots.js';

test('detects separate transparent photo windows and defaults to cover fit', () => {
  const width = 20, height = 30;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data[index * 4 + 3] = 255;
  const clear = (fromX, fromY, toX, toY) => {
    for (let y = fromY; y < toY; y += 1) {
      for (let x = fromX; x < toX; x += 1) data[(y * width + x) * 4 + 3] = 0;
    }
  };
  clear(2, 2, 9, 14);
  clear(11, 16, 18, 28);
  const slots = detectTransparentSlots(data, width, height, 2);
  assert.equal(slots.length, 2);
  assert.ok(slots.every((slot) => slot.fit === 'cover'));
  assert.ok(slots[0].y < slots[1].y);
  assert.ok(slots.every((slot) => slot.x >= 0 && slot.y >= 0 && slot.x + slot.width <= 1200 && slot.y + slot.height <= 1800));
});
