import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { LocalStore } from '../src/main/local-store.js';
import { SharpCompositor } from '../src/main/sharp-compositor.js';

async function createFrame(root, {
  name = 'frame', width = 120, height = 180,
  slot = { x: 10, y: 10, width: 100, height: 160 }
} = {}) {
  const framePath = path.join(root, `${name}.png`);
  const border = Math.max(slot.x, slot.y, width - slot.x - slot.width, height - slot.y - slot.height);
  const frame = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  })
    .composite([{
      input: Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="${border / 2}" y="${border / 2}" width="${width - border}" height="${height - border}" fill="none" stroke="#000" stroke-width="${border}"/></svg>`),
      left: 0,
      top: 0
    }])
    .png()
    .toFile(framePath);
  assert.equal(frame.width, width);
  return { framePath, width, height, slot };
}

async function solidJpeg(width = 600, height = 400, color = '#ff0000') {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

async function splitJpeg() {
  return sharp({ create: { width: 600, height: 400, channels: 3, background: '#ff0000' } })
    .composite([{ input: Buffer.from('<svg width="300" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="400" fill="#0000ff"/></svg>'), left: 300, top: 0 }])
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function createCompositor(store, frameManager, composite = {}) {
  const configStore = {
    get: () => ({
      branding: { accent: '#ef765e' },
      composite: {
        previewResolution: 1200,
        targetResolution: 3600,
        jpegQuality: 90,
        chroma444: true,
        density: 600,
        holeOutsetPx: 3,
        qrEnabled: false,
        ...composite
      }
    })
  };
  return new SharpCompositor(store, frameManager, configStore);
}

function managerFor(frame, category, layout) {
  return {
    resolve: async () => ({
      id: 'frame', filePath: frame.framePath, width: frame.width, height: frame.height,
      slotCount: 1, category, layout, fit: 'cover', slots: [{ ...frame.slot, fit: 'cover' }]
    })
  };
}

async function createSessionWithPhoto(root, jpeg) {
  const store = new LocalStore(path.join(root, 'store'));
  await store.init();
  const session = await store.createSession('photo');
  const item = await store.saveArtifact({
    sessionId: session.id,
    kind: 'photo-original',
    extension: 'jpg',
    bytes: jpeg
  });
  return { store, session, item };
}

async function decodedPixel(bytes, xFraction, yFraction) {
  const { data, info } = await sharp(Buffer.from(bytes)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = Math.max(0, Math.min(info.width - 1, Math.round((info.width - 1) * xFraction)));
  const y = Math.max(0, Math.min(info.height - 1, Math.round((info.height - 1) * yFraction)));
  const offset = (y * info.width + x) * info.channels;
  return Array.from(data.subarray(offset, offset + 3));
}

async function previewFinalMeanDifference(preview, final) {
  const previewPixels = await sharp(Buffer.from(preview.bytes)).removeAlpha().raw().toBuffer();
  const finalPixels = await sharp(Buffer.from(final.bytes))
    .resize(preview.width, preview.height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.equal(previewPixels.length, finalPixels.length);
  let difference = 0;
  for (let index = 0; index < previewPixels.length; index += 1) {
    difference += Math.abs(previewPixels[index] - finalPixels[index]);
  }
  return difference / previewPixels.length;
}

test('Sharp compositor crops original JPEG with cover and writes portrait 600 DPI output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-compositor-'));
  try {
    const frame = await createFrame(root);
    const { store, session, item } = await createSessionWithPhoto(root, await solidJpeg());
    const compositor = createCompositor(store, managerFor(frame, '4x6-portrait'));
    const result = await compositor.render({ sessionId: session.id, artifactIds: [item.id], frameId: 'frame', save: true });
    const metadata = await sharp(Buffer.from(result.bytes)).metadata();
    assert.equal(result.profile, '4x6-portrait');
    assert.equal(result.width, 2400);
    assert.equal(result.height, 3600);
    assert.equal(metadata.width, 2400);
    assert.equal(metadata.height, 3600);
    assert.equal(metadata.density, 600);
    assert.equal(result.item.kind, 'photo-strip');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Sharp compositor writes landscape output at 3600x2400', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-landscape-'));
  try {
    const frame = await createFrame(root, {
      width: 180,
      height: 120,
      slot: { x: 10, y: 10, width: 160, height: 100 }
    });
    const { store, session, item } = await createSessionWithPhoto(root, await solidJpeg());
    const compositor = createCompositor(store, managerFor(frame, '4x6-landscape'));
    const result = await compositor.render({ sessionId: session.id, artifactIds: [item.id], frameId: 'frame' });
    const metadata = await sharp(Buffer.from(result.bytes)).metadata();
    assert.equal(result.profile, '4x6-landscape');
    assert.equal(result.width, 3600);
    assert.equal(result.height, 2400);
    assert.equal(metadata.width, 3600);
    assert.equal(metadata.height, 2400);
    assert.equal(metadata.density, 600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Sharp compositor renders a single 1200x3600 2x6 strip for digital output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-strip-'));
  try {
    const frame = await createFrame(root, {
      width: 120,
      height: 360,
      slot: { x: 10, y: 10, width: 100, height: 340 }
    });
    const { store, session, item } = await createSessionWithPhoto(root, await solidJpeg());
    const compositor = createCompositor(store, managerFor(frame, '2x6', '2x6'));
    const result = await compositor.render({ sessionId: session.id, artifactIds: [item.id], frameId: 'frame' });
    const metadata = await sharp(Buffer.from(result.bytes)).metadata();
    assert.equal(result.profile, '2x6');
    assert.equal(result.width, 1200);
    assert.equal(result.height, 3600);
    assert.equal(metadata.width, 1200);
    assert.equal(metadata.height, 3600);
    assert.equal(metadata.density, 600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Sharp preview and final share pan geometry, rotation, and topmost frame overlay', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-transforms-'));
  try {
    const frame = await createFrame(root);
    const framePixels = await sharp(frame.framePath).ensureAlpha().raw().toBuffer();
    assert.equal(framePixels[(90 * frame.width + 60) * 4 + 3], 0);
    const { store, session, item } = await createSessionWithPhoto(root, await splitJpeg());
    const compositor = createCompositor(store, managerFor(frame, '4x6-portrait'));
    const base = { sessionId: session.id, artifactIds: [item.id], frameId: 'frame' };
    const panLeft = { [item.id]: { panX: 0, panY: 50, zoom: 1, rotation: 0 } };
    const panRight = { [item.id]: { panX: 100, panY: 50, zoom: 1, rotation: 0 } };

    const leftPreview = await compositor.render({ ...base, transforms: panLeft, preview: true });
    const rightPreview = await compositor.render({ ...base, transforms: panRight, preview: true });
    const leftFinal = await compositor.render({ ...base, transforms: panLeft });
    const mirroredPreview = await compositor.render({
      ...base,
      transforms: { [item.id]: { panX: 50, panY: 50, zoom: 1, rotation: 0, mirrored: true } },
      preview: true
    });
    const mirroredFinal = await compositor.render({
      ...base,
      transforms: { [item.id]: { panX: 50, panY: 50, zoom: 1, rotation: 0, mirrored: true } }
    });
    const rotated = await compositor.render({
      ...base,
      transforms: { [item.id]: { panX: 50, panY: 50, zoom: 1, rotation: 90 } },
      preview: true
    });

    const leftPreviewCenter = await decodedPixel(leftPreview.bytes, .5, .5);
    const rightPreviewCenter = await decodedPixel(rightPreview.bytes, .5, .5);
    const leftFinalCenter = await decodedPixel(leftFinal.bytes, .5, .5);
    assert.ok(leftPreviewCenter[0] > 220 && leftPreviewCenter[2] < 35);
    assert.ok(rightPreviewCenter[2] > 220 && rightPreviewCenter[0] < 35);
    assert.ok(leftFinalCenter[0] > 220 && leftFinalCenter[2] < 35);

    for (const result of [mirroredPreview, mirroredFinal]) {
      const mirroredLeft = await decodedPixel(result.bytes, .25, .5);
      const mirroredRight = await decodedPixel(result.bytes, .75, .5);
      assert.ok(mirroredLeft[2] > 200 && mirroredLeft[0] < 55);
      assert.ok(mirroredRight[0] > 200 && mirroredRight[2] < 55);
    }

    const rotatedTop = await decodedPixel(rotated.bytes, .5, .2);
    const rotatedBottom = await decodedPixel(rotated.bytes, .5, .8);
    assert.ok(rotatedTop[0] > 200 && rotatedTop[2] < 55);
    assert.ok(rotatedBottom[2] > 200 && rotatedBottom[0] < 55);

    const overlayPixel = await decodedPixel(leftPreview.bytes, .02, .02);
    const holeEdgePixel = await decodedPixel(leftPreview.bytes, .09, .5);
    assert.ok(overlayPixel.every((channel) => channel < 35));
    assert.ok(holeEdgePixel[0] > 180, 'expanded photo should fill the transparent hole without a background seam');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Sharp preview stays visually aligned with the 600 DPI print render', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-preview-parity-'));
  try {
    const frame = await createFrame(root);
    const { store, session, item } = await createSessionWithPhoto(root, await splitJpeg());
    const compositor = createCompositor(store, managerFor(frame, '4x6-portrait'), { qrEnabled: true });
    const qrBytes = await sharp({ create: { width: 21, height: 21, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="21" height="21" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h9v9H0zM12 0h9v9h-9zM0 12h9v9H0zM12 12h3v3h-3zM18 18h3v3h-3z" fill="#000"/></svg>') }])
      .png()
      .toBuffer();
    const payload = {
      sessionId: session.id,
      artifactIds: [item.id],
      frameId: 'frame',
      qrDataUrl: `data:image/png;base64,${qrBytes.toString('base64')}`,
      transforms: { [item.id]: { panX: 82, panY: 18, zoom: 1.65, rotation: 90, mirrored: true } }
    };

    const preview = await compositor.render({ ...payload, preview: true });
    const final = await compositor.render(payload);
    assert.equal(final.width / preview.width, 3);
    assert.equal(final.height / preview.height, 3);
    assert.ok(await previewFinalMeanDifference(preview, final) < 8);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Sharp compositor applies LUT only to photos and keeps preview equal to final output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photobooth-lut-parity-'));
  try {
    const frame = await createFrame(root);
    const { store, session, item } = await createSessionWithPhoto(root, await solidJpeg(600, 400, '#d36b43'));
    const compositor = createCompositor(store, managerFor(frame, '4x6-portrait'), { previewResolution: 1200, targetResolution: 1200 });
    const base = { sessionId: session.id, artifactIds: [item.id], frameId: 'frame', lutId: 'cinematic' };
    const preview = await compositor.render({ ...base, preview: true });
    const final = await compositor.render(base);
    const graded = await decodedPixel(preview.bytes, .5, .5);
    const border = await decodedPixel(preview.bytes, .02, .02);
    assert.ok(Math.abs(graded[0] - 211) + Math.abs(graded[1] - 107) + Math.abs(graded[2] - 67) > 12);
    assert.ok(border.every((channel) => channel < 35), 'frame artwork must not receive the photo LUT');
    assert.ok(await previewFinalMeanDifference(preview, final) < 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
