import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { envConfigPatch, parseEnv } from '../src/main/config.js';

test('legacy .env values configure printer, QR, resolution and non-mirrored output', () => {
  const values = parseEnv(`
    PRINTER_NAME="DS-RX1 4x6" # old provider
    PORT=6001
    COMPOSITE_TARGET_RESOLUTION=3600
    COMPOSITE_JPEG_QUALITY=100
    ENABLE_QR_ON_FRAME=on
    QR_SIZE_STRIP=140
    QR_SIZE_STANDARD=120
    QR_POS_X_FRACTION=0.04
    QR_POS_Y_FRACTION=0.985
    MIRROR_PREVIEW=true
    MIRROR_OUTPUT=false
    LOCAL_FRAMES_DIR=./frames
  `);
  const root = path.resolve('example-app');
  const config = envConfigPatch(values, root);
  assert.equal(config.print.deviceName, 'DS-RX1 4x6');
  assert.equal(config.gallery.port, 6001);
  assert.equal(config.composite.targetResolution, 3600);
  assert.equal(config.composite.jpegQuality, 100);
  assert.equal(config.composite.qrEnabled, true);
  assert.equal(config.composite.qrSizeStrip, 140);
  assert.equal(config.composite.qrSizeStandard, 120);
  assert.equal(config.camera.mirrorPreview, true);
  assert.equal(config.camera.mirrorOutput, false);
  assert.equal(config.frames.localDir, path.resolve(root, 'frames'));
});
