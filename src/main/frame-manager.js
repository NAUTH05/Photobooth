import fs from 'node:fs/promises';
import path from 'node:path';

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
  }

  async init() {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    try { await fs.access(this.manifestPath); } catch {
      await fs.writeFile(this.manifestPath, JSON.stringify(defaultManifest, null, 2), 'utf8');
    }
  }

  async list() {
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8')); } catch { manifest = defaultManifest; }
    const bundledFrames = await this.listBundledFrames();
    const sourceFrames = bundledFrames.length ? bundledFrames : (manifest.frames ?? []);
    const frames = [];
    for (const frame of sourceFrames) {
      let dataUrl = '';
      if (frame.file) {
        const target = frame.source === 'bundled'
          ? path.join(this.bundledRoot, path.basename(frame.file))
          : path.join(this.cacheRoot, path.basename(frame.file));
        try {
          const data = await fs.readFile(target);
          const extension = path.extname(target).slice(1).replace('svg', 'svg+xml');
          dataUrl = `data:image/${extension};base64,${data.toString('base64')}`;
        } catch {}
      }
      let previewDataUrl = '';
      if (frame.previewFile) {
        if (path.basename(frame.previewFile) === path.basename(frame.file)) previewDataUrl = dataUrl;
        else {
          const target = frame.source === 'bundled'
            ? path.join(this.bundledRoot, path.basename(frame.previewFile))
            : path.join(this.cacheRoot, path.basename(frame.previewFile));
          try {
            const data = await fs.readFile(target);
            const extension = path.extname(target).slice(1).replace('svg', 'svg+xml');
            previewDataUrl = `data:image/${extension};base64,${data.toString('base64')}`;
          } catch {}
        }
      }
      frames.push({ ...frame, dataUrl, previewDataUrl });
    }
    return { version: manifest.version ?? 1, lastSync: this.lastSync, frames };
  }

  async listBundledFrames() {
    if (!this.bundledRoot) return [];
    try {
      const legacy = JSON.parse(await fs.readFile(path.join(this.bundledRoot, 'frames_manifest.json'), 'utf8'));
      if (!Array.isArray(legacy)) return [];
      const frames = [];
      for (const item of legacy) {
        if (item.layout !== '4x6' || item.category !== '4x6-portrait') continue;
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
          fit: 'contain',
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
        id: file.id, name: path.parse(file.name).name, file: file.name, accent: '#ff5d8f', slotCount: 4
      }));
      await fs.writeFile(this.manifestPath, JSON.stringify({ version: Date.now(), frames }, null, 2), 'utf8');
    }
    this.lastSync = new Date().toISOString();
    return this.list();
  }
}
