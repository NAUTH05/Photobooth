import assert from 'node:assert/strict';
import test from 'node:test';

test('base64 photo payload can be decoded without a network fetch', () => {
  const dataUrl = 'data:image/jpeg;base64,aW1hZ2U=';
  const comma = dataUrl.indexOf(',');
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  assert.equal(bytes.toString('utf8'), 'image');
});
