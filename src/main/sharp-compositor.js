import fs from 'node:fs/promises';
import sharp from 'sharp';
import { coverCropRect, expandRect, normalizePhotoTransform, scaleRect } from '../shared/image-layout.js';
import { DEFAULT_FOOTER_HEIGHT, outputProfile, PRINT_HEIGHT, PRINT_WIDTH, resolvePhotoSlots } from '../shared/photo-layout.js';
import { applyLutBuffer } from './lut-processor.js';

function integerRect(rect) {
  return {
    left: Math.max(0, Math.round(rect.left ?? rect.x)),
    top: Math.max(0, Math.round(rect.top ?? rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  };
}

function svgOverlay(frame, width, height, branding) {
  const scaleX = width / PRINT_WIDTH;
  const scaleY = height / PRINT_HEIGHT;
  const accent = frame.accent || branding.accent || '#ef765e';
  const footerHeight = DEFAULT_FOOTER_HEIGHT * scaleY;
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="none" stroke="${accent}" stroke-width="20"/>
    <rect x="0" y="${height - footerHeight}" width="${width}" height="${footerHeight}" fill="${frame.footerColor || accent}"/>
    <circle cx="${38 * scaleX}" cy="${38 * scaleY}" r="${22 * Math.min(scaleX, scaleY)}" fill="${accent}"/>
    <circle cx="${width - 38 * scaleX}" cy="${38 * scaleY}" r="${22 * Math.min(scaleX, scaleY)}" fill="${accent}"/>
  </svg>`);
}

export class SharpCompositor {
  constructor(localStore, frameManager, configStore, lutManager = null) {
    this.localStore = localStore;
    this.frameManager = frameManager;
    this.configStore = configStore;
    this.lutManager = lutManager;
    this.overlayCache = new Map();
  }

  async render({ sessionId, artifactIds, frameId, transforms = {}, lutId = 'natural', qrDataUrl = '', preview = false, save = false }) {
    if (!Array.isArray(artifactIds) || artifactIds.length < 1 || artifactIds.length > 8) throw new Error('Số ảnh ghép không hợp lệ');
    if (!preview) {
      if (artifactIds.some((artifactId) => typeof artifactId !== 'string' || !artifactId) || new Set(artifactIds).size !== artifactIds.length) {
        throw new Error('Danh sách ảnh ghép không hợp lệ hoặc bị trùng');
      }
    }
    const config = this.configStore.get();
    const selectedLut = this.lutManager?.resolve(lutId) || lutId;
    const frame = await this.frameManager.resolve(frameId);
    if (!preview && Number(frame.slotCount) !== artifactIds.length && frame.slotCount !== 'any') throw new Error('Số ảnh không khớp frame');
    const target = preview ? Number(config.composite.previewResolution) || 1200 : Number(config.composite.targetResolution) || 3600;
    const profile = outputProfile(frame, target);
    const isStrip = profile.kind === '2x6';
    const workingWidth = isStrip ? profile.stripWidth : profile.width;
    const workingHeight = profile.height;
    const coordinateWidth = Number(frame.width) || PRINT_WIDTH;
    const coordinateHeight = Number(frame.height) || PRINT_HEIGHT;
    const slots = resolvePhotoSlots(frame, artifactIds.length);
    const scaleX = workingWidth / coordinateWidth;
    const scaleY = workingHeight / coordinateHeight;
    const composites = [];

    for (let index = 0; index < artifactIds.length; index += 1) {
      if (!artifactIds[index]) continue;
      let item = null;
      try {
        item = this.localStore.resolveArtifact(sessionId, artifactIds[index], ['photo-original', 'dslr-original']);
      } catch (err) {
        if (preview) continue;
        throw err;
      }
      if (!item) continue;
      const transform = normalizePhotoTransform(transforms[item.id] || transforms[artifactIds[index]] || transforms[index] || slots[index]);
      const rotation = transform.rotation;
      const metadata = await sharp(item.path, { failOn: 'none' }).metadata();
      let sourceWidth = metadata.width;
      let sourceHeight = metadata.height;
      if (!sourceWidth || !sourceHeight) throw new Error('Không đọc được kích thước JPEG gốc');
      if ([5, 6, 7, 8].includes(metadata.orientation)) [sourceWidth, sourceHeight] = [sourceHeight, sourceWidth];
      const rotatedQuarter = rotation % 180 !== 0;
      const scaledSlot = scaleRect(slots[index], scaleX, scaleY);
      const outset = (Number(config.composite.holeOutsetPx) || 3) * Math.max(scaleX, scaleY);
      const placement = expandRect(scaledSlot, outset, { width: workingWidth, height: workingHeight });
      const placementWidth = Math.max(1, Math.round(placement.width));
      const placementHeight = Math.max(1, Math.round(placement.height));
      let input;
      if (slots[index].fit === 'contain') {
        let pipeline = sharp(item.path, { failOn: 'none' }).autoOrient();
        if (rotation) pipeline = pipeline.rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
        input = await pipeline
          .resize(placementWidth, placementHeight, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png()
          .toBuffer();
        if (transform.mirrored) input = await sharp(input).flop().png().toBuffer();
        input = await applyLutBuffer(input, selectedLut, { format: 'png' });
      } else {
        const targetWidth = rotatedQuarter ? placement.height : placement.width;
        const targetHeight = rotatedQuarter ? placement.width : placement.height;
        const crop = integerRect(coverCropRect(sourceWidth, sourceHeight, targetWidth, targetHeight, transform));
        let pipeline = sharp(item.path, { failOn: 'none' }).autoOrient().extract(crop).resize(Math.round(targetWidth), Math.round(targetHeight), { fit: 'fill' });
        if (rotation) pipeline = pipeline.rotate(rotation, { background: '#ffffff' });
        input = await pipeline.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
        if (rotation % 90 !== 0) {
          input = await sharp(input).resize(placementWidth, placementHeight, { fit: 'cover' }).toBuffer();
        }
        if (transform.mirrored) input = await sharp(input).flop().jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
        input = await applyLutBuffer(input, selectedLut, { format: 'jpeg' });
      }
      composites.push({ input, left: Math.round(placement.x), top: Math.round(placement.y) });
    }

    const background = await sharp({ create: { width: workingWidth, height: workingHeight, channels: 3, background: frame.backgroundColor || '#fffaf7' } })
      .composite(composites)
      .png()
      .toBuffer();

    let overlay;
    if (frame.filePath) {
      const stat = await fs.stat(frame.filePath).catch(() => null);
      const cacheKey = stat ? `${frame.filePath}:${stat.size}:${stat.mtimeMs}:${workingWidth}:${workingHeight}` : `${frame.filePath}:${workingWidth}:${workingHeight}`;
      if (this.overlayCache.has(cacheKey)) {
        overlay = this.overlayCache.get(cacheKey);
      } else {
        overlay = await sharp(frame.filePath).resize(workingWidth, workingHeight, { fit: 'fill' }).png().toBuffer();
        this.overlayCache.set(cacheKey, overlay);
        if (this.overlayCache.size > 40) this.overlayCache.delete(this.overlayCache.keys().next().value);
      }
    } else {
      overlay = svgOverlay(frame, workingWidth, workingHeight, config.branding);
    }
    const top = [{ input: overlay, left: 0, top: 0 }];
    if (qrDataUrl && config.composite.qrEnabled !== false) {
      const qrBytes = Buffer.from(qrDataUrl.slice(qrDataUrl.indexOf(',') + 1), 'base64');
      const logicalQrSize = isStrip ? Number(config.composite.qrSizeStrip) || 140 : Number(config.composite.qrSizeStandard) || 120;
      const qrSize = Math.max(40, Math.round(logicalQrSize * workingHeight / PRINT_HEIGHT));
      const x = Math.max(0, Math.min(workingWidth - qrSize, Math.round(workingWidth * (Number(config.composite.qrPosXFraction) || .79))));
      const y = Math.max(0, Math.min(workingHeight - qrSize, Math.round(workingHeight * (Number(config.composite.qrPosYFraction) || .975) - qrSize)));
      const qr = await sharp(qrBytes).resize(qrSize, qrSize).extend({ top: 6, bottom: 6, left: 6, right: 6, background: '#ffffff' }).png().toBuffer();
      top.push({ input: qr, left: Math.max(0, x - 6), top: Math.max(0, y - 6) });
    }
    const rendered = await sharp(background).composite(top).png().toBuffer();
    const quality = Math.max(1, Math.min(100, Number(config.composite.jpegQuality) || 95));
    const density = Math.max(72, Number(config.composite.density) || 600);
    const bytes = await sharp(rendered)
      .withMetadata({ density })
      .jpeg({ quality, chromaSubsampling: config.composite.chroma444 ? '4:4:4' : '4:2:0' })
      .toBuffer();
    const response = { bytes: Uint8Array.from(bytes), mimeType: 'image/jpeg', width: workingWidth, height: workingHeight, profile: profile.kind };
    if (save) response.item = await this.localStore.saveArtifact({ sessionId, kind: 'photo-strip', extension: 'jpg', bytes, profile: profile.kind });
    return response;
  }
}
