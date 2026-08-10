import assert from 'node:assert/strict';
import test from 'node:test';
import { autoPhotoSlots, frameSupportsCount, resolvePhotoSlots } from '../src/shared/photo-layout.js';

test('auto layout creates exactly one slot for every selected photo', () => {
  for (let count = 1; count <= 8; count += 1) {
    const slots = autoPhotoSlots(count);
    assert.equal(slots.length, count);
    assert.ok(slots.every((slot) => slot.x >= 0 && slot.y >= 0 && slot.x + slot.width <= 1200 && slot.y + slot.height <= 1540));
  }
});

test('fixed frames only appear for their declared photo count', () => {
  assert.equal(frameSupportsCount({ slotCount: 6, file: 'six.png' }, 6), true);
  assert.equal(frameSupportsCount({ slotCount: 6, file: 'six.png' }, 4), false);
  assert.equal(frameSupportsCount({ slotCount: 'any' }, 7), true);
  assert.equal(frameSupportsCount({ slotCount: 1, slots: [{ x: -1, y: 0, width: 10, height: 10 }] }, 1), false);
  assert.equal(frameSupportsCount({ slotCount: 2, slots: [
    { x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }
  ] }, 2), false);
});

test('custom slot coordinates override the automatic layout', () => {
  const slots = [{ x: 10, y: 20, width: 300, height: 400 }];
  assert.deepEqual(resolvePhotoSlots({ slotCount: 1, slots }, 1), [{ ...slots[0], fit: 'contain' }]);
});
