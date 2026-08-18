import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { CubeLutManager, parseCubeLut } from '../src/main/cube-lut-manager.js';
import { applyLutBuffer } from '../src/main/lut-processor.js';
import { applyLutToPixels } from '../src/shared/lut-presets.js';

function cube2(title = 'Đảo màu', transform = (red, green, blue) => [1 - red, 1 - green, 1 - blue]) {
  const rows = [`TITLE "${title}"`, 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let blue = 0; blue <= 1; blue += 1) {
    for (let green = 0; green <= 1; green += 1) {
      for (let red = 0; red <= 1; red += 1) rows.push(transform(red, green, blue).join(' '));
    }
  }
  return `${rows.join('\n')}\n`;
}

test('parses a standard 3D .cube and applies trilinear interpolation', () => {
  const parsed = parseCubeLut(cube2(), { filename: 'invert.cube' });
  assert.equal(parsed.title, 'Đảo màu');
  assert.equal(parsed.size, 2);
  assert.equal(parsed.table.length, 24);
  const pixel = new Uint8Array([64, 128, 192, 201]);
  applyLutToPixels(pixel, 4, { ...parsed, id: 'cube-test' });
  assert.deepEqual(Array.from(pixel), [191, 127, 63, 201]);
});

test('rejects 1D, incomplete and oversized 3D LUT declarations', () => {
  assert.throws(() => parseCubeLut('LUT_1D_SIZE 16\n0 0 0'), /LUT 1D/);
  assert.throws(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0'), /cần 8 dòng màu/);
  assert.throws(() => parseCubeLut('LUT_3D_SIZE 128'), /2–65/);
});

test('imports .cube files into persistent runtime storage and reloads them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-cube-lut-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'Wedding Pastel.cube');
  const storage = path.join(root, 'runtime-luts');
  await fs.writeFile(source, cube2('Wedding Pastel'), 'utf8');

  const manager = new CubeLutManager(storage);
  await manager.init();
  const imported = await manager.importFiles([source]);
  assert.equal(imported.length, 1);
  assert.match(imported[0].id, /^cube-[a-f0-9]{20}$/);
  assert.equal(imported[0].label, 'Wedding Pastel');
  assert.equal(imported[0].custom, true);
  assert.equal(manager.list().length, 7);

  const reloaded = new CubeLutManager(storage);
  await reloaded.init();
  const selected = reloaded.resolve(imported[0].id);
  assert.equal(selected.label, 'Wedding Pastel');
  assert.equal(selected.table.length, 24);
});

test('Sharp LUT processor accepts an imported cube preset and preserves alpha', async () => {
  const parsed = { ...parseCubeLut(cube2()), id: 'cube-test' };
  const input = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 64, g: 128, b: 192, alpha: .5 } } }).png().toBuffer();
  const output = await applyLutBuffer(input, parsed, { format: 'png' });
  const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  assert.deepEqual(Array.from(data.slice(0, 3)), [191, 127, 63]);
  assert.ok(data[3] >= 126 && data[3] <= 129);
});
