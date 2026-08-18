import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { applyPhotoFilterBuffer } from '../src/main/photo-filter-processor.js';
import { PHOTO_FILTERS, normalizePhotoFilterId, photoFilter } from '../src/shared/photo-filters.js';

test('photo filter presets have stable unique ids and usable display values', () => {
  assert.deepEqual(PHOTO_FILTERS.map((item) => item.id), [
    'natural', 'warm-film', 'black-white', 'vintage', 'cinematic', 'peach'
  ]);
  assert.equal(new Set(PHOTO_FILTERS.map((item) => item.id)).size, PHOTO_FILTERS.length);
  for (const filter of PHOTO_FILTERS) {
    assert.ok(filter.label);
    assert.ok(filter.description);
    assert.ok(filter.css);
    assert.equal(filter.matrix.length, 3);
    assert.equal(filter.bias.length, 3);
  }
});

test('unknown photo filters safely fall back to natural', () => {
  assert.equal(normalizePhotoFilterId('not-a-filter'), 'natural');
  assert.equal(photoFilter(null).id, 'natural');
});

test('black and white processing preserves dimensions and removes colour', async () => {
  const input = await sharp({
    create: { width: 3, height: 2, channels: 3, background: { r: 225, g: 83, b: 46 } }
  }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  const output = await applyPhotoFilterBuffer(input, 'black-white');
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 3);
  assert.equal(info.height, 2);
  for (let index = 0; index < data.length; index += info.channels) {
    assert.ok(Math.abs(data[index] - data[index + 1]) <= 1);
    assert.ok(Math.abs(data[index + 1] - data[index + 2]) <= 1);
  }
});

test('natural processing keeps the original bytes untouched', async () => {
  const input = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const output = await applyPhotoFilterBuffer(input, 'natural');
  assert.deepEqual(output, input);
});
