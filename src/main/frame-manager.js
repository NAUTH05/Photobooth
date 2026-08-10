import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { detectTransparentSlots } from '../shared/frame-slots.js';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

const defaultManifest = {
  version: 1,
  frames: [
    { id: 'clean', name: 'Tối giản', file: '', accent: '#ff5d8f', slotCount: 'any' },
    { id: 'sunset', name: 'Hoàng hôn', file: '', accent: '#ff9f68', slotCount: 'any' },
    { id: 'mint', name: 'Bạc hà', file: '', accent: '#58c9b9', slotCount: 'any' }
  ]
};

export class FrameManager {
  constructor(cacheRoot, driveFactory, configStore, bundledRoot = null) {
    this.cacheRoot = cacheRoot;
    this.bundledRoot = bundledRoot;
    this.driveFactory = driveFactory;
    this.configStore = configStore;
    this.manifestPath = path.join(cacheRoot, 'manifest.json');
    this.lastSync = null;
    this.analysisCache = new Map();
  }

  async init() {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    try { await fs.access(this.manifestPath); } catch {
      await fs.writeFile(this.manifestPath, JSON.stringify(defaultManifest, null, 2), 'utf8');
    }
  }

  framePath(frame) {
    if (!frame?.file) return '';
    return frame.source === 'bundled'
      ? path.join(this.bundledRoot, path.basename(frame.file))
      : path.join(this.cacheRoot, path.basename(frame.file));
  }

  async sourceFrames() {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')); } catch { manifest = defaultManifest; }
    const bundledFrames = await this.listBundledFrames();
    return { version: manifest.version ?? 1, frames: bundledFrames.length ? bundledFrames : (manifest.frames ?? []) };
  }

  async list() {
    const source = await this.sourceFrames();
    const frames = [];
    for (const frame of source.frames) {
      let previewDataUrl = '';
      if (frame.file) {
        const target = frame.previewFile && path.basename(frame.previewFile) !== path.basename(frame.file)
          ? frame.source === 'bundled'
            ? path.join(this.bundledRoot, path.basename(frame.previewFile))
            : path.join(this.cacheRoot, path.basename(frame.previewFile))
          : this.framePath(frame);
        try {
          const preview = await sharp(target).resize({ width: 280, height: 280, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
          previewDataUrl = `data:image/png;base64,${preview.toString('base64')}`;
        } catch {}
      }
      frames.push({ ...frame, dataUrl: previewDataUrl, previewDataUrl });
    }
    return { version: source.version, lastSync: this.lastSync, frames };
  }

  automaticFrame(frameId) {
    const match = String(frameId).match(/^auto-(\d+)$/);
    if (!match) return null;
    const slotCount = Number(match[1]);
    if (!Number.isInteger(slotCount) || slotCount < 1 || slotCount > 8) return null;
    return { id: frameId, name: `Tự động · ${slotCount} ảnh`, file: '', accent: '#ef765e', slotCount, fit: 'cover', width: 1200, height: 1800, slots: [] };
  }

  async resolve(frameId) {
    const source = await this.sourceFrames();
    const frame = source.frames.find((candidate) => candidate.id === frameId) || this.automaticFrame(frameId);
    if (!frame) throw new Error('Frame not found');
    if (!frame.file) return { ...frame, width: Number(frame.width) || 1200, height: Number(frame.height) || 1800, slots: frame.slots ?? [] };
    const filePath = this.framePath(frame);
    const stat = await fs.stat(filePath);
    const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.analysisCache.get(key);
    if (cached) return { ...frame, ...cached, filePath };
    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Không đọc được kích thước frame ${frame.name}`);
    let slots = Array.isArray(frame.slots) ? frame.slots : [];
    if (frame.inferSlots) {
      if (!metadata.hasAlpha) throw new Error(`Frame ${frame.name} không có alpha trong suốt`);
      const sampleWidth = Math.min(600, metadata.width);
      const sample = await sharp(filePath).resize({ width: sampleWidth }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      slots = detectTransparentSlots(sample.data, sample.info.width, sample.info.height, Number(frame.slotCount), metadata.width, metadata.height, { alphaThreshold: 49, defaultFit: 'cover' });
      if (slots.length !== Number(frame.slotCount)) throw new Error(`Không dò được ${frame.slotCount} vùng ảnh trong frame ${frame.name}`);
    }
    const result = { width: metadata.width, height: metadata.height, slots };
    this.analysisCache.set(key, result);
    if (this.analysisCache.size > 100) this.analysisCache.delete(this.analysisCache.keys().next().value);
    return { ...frame, ...result, filePath };
  }

  async listBundledFrames() {
    if (!this.bundledRoot) return [];
    try {
      const legacy = JSON.parse(await fs.readFile(path.join(this.bundledRoot, 'frames_manifest.json'), 'utf8'));
      if (!Array.isArray(legacy)) return [];
      const frames = [];
      for (const item of legacy) {
        const filename = path.basename(String(item.local || '').replaceAll('\\', '/'));
        if (!filename || path.extname(filename).toLowerCase() !== '.png') continue;
        try { await fs.access(path.join(this.bundledRoot, filename)); } catch { continue; }
        frames.push({
          id: `local-${item.id}`,
          name: String(item.name || path.parse(filename).name).trim(),
          file: filename,
          previewFile: filename,
          accent: '#ef765e',
          slotCount: Math.max(1, Number(item.photo_count) || 4),
          layout: item.layout || '4x6',
          category: item.category || '4x6-portrait',
          fit: 'cover',
          inferSlots: true,
          source: 'bundled'
        });
      }
      return frames;
    } catch {
      return [];
    }
  }

  async sync() {
    const config = this.configStore.get();
    if (!config.drive.enabled || !config.drive.framesFolderId) return this.list();
    const client = this.driveFactory(config);
    const files = await client.listFrameFiles(config.drive.framesFolderId);
    for (const file of files) {
      const extension = path.extname(file.name).toLowerCase();
      if (file.name !== 'manifest.json' && !imageExtensions.has(extension)) continue;
      await client.download(file.id, path.join(this.cacheRoot, path.basename(file.name)));
    }
    const hasManifest = files.some((file) => file.name === 'manifest.json');
    if (!hasManifest) {
      const frames = files.filter((file) => imageExtensions.has(path.extname(file.name).toLowerCase())).map((file) => ({
        id: file.id, name: path.parse(file.name).name, file: file.name, accent: '#ff5d8f', slotCount: 4, inferSlots: path.extname(file.name).toLowerCase() === '.png', fit: 'cover'
      }));
      await fs.writeFile(this.manifestPath, JSON.stringify({ version: Date.now(), frames }, null, 2), 'utf8');
    }
    this.lastSync = new Date().toISOString();
    return this.list();
  }
}
